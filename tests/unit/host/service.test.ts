import { describe, expect, it, vi } from 'vitest'
import type { RecordingId, RunId, SemanticTarget } from '../../../src/core/api.js'
import { resolveHostConfig, type HostConfig } from '../../../src/host/config.js'
import { OperationRunner } from '../../../src/driver/operation-runner.js'
import {
  CuaRecordReplayService,
  type RecordingReadPort,
  type RecordingStep,
  type ReplayPort,
} from '../../../src/host/service.js'
import { FakeBrowserDriver } from './fake-driver.js'
import {
  FakeRecordingPort,
  FakeReplayPort,
  rec,
  recordingSummary,
  run,
  runSummary,
} from './fake-ports.js'
import {
  RecordingSink,
  callFor,
  disabledConfig,
  enabledConfig,
  walkingClock,
} from './support.js'

const SUBMIT: SemanticTarget = { role: 'button', name: 'Submit' }

function setup(options: {
  readonly config?: HostConfig
  readonly recordings?: RecordingReadPort
  readonly replay?: ReplayPort
} = {}): {
  readonly driver: FakeBrowserDriver
  readonly sink: RecordingSink
  readonly service: CuaRecordReplayService
} {
  const driver = new FakeBrowserDriver()
  const sink = new RecordingSink()
  const runner = new OperationRunner({ driver, events: sink, clock: walkingClock() })
  const service = new CuaRecordReplayService({
    config: options.config ?? enabledConfig(),
    driver,
    runner,
    ...(options.recordings === undefined ? {} : { recordings: options.recordings }),
    ...(options.replay === undefined ? {} : { replay: options.replay }),
  })
  return { driver, sink, service }
}

describe('CuaRecordReplayService', () => {
  it('returns FEATURE_DISABLED for every execution use case while the switch is off', async () => {
    const { driver, service } = setup({ config: disabledConfig() })

    await expect(service.bindBrowser({ pid: 1, windowId: 2 }, callFor()))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    await expect(service.observe(callFor())).rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    await expect(service.performAction({ kind: 'navigate', url: 'https://example.test' }, callFor()))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    await expect(service.startReplay({ recordingId: rec('a') }, callFor()))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })

    expect(driver.bindCalls).toBe(0)
    expect(driver.observeCalls).toBe(0)
    expect(driver.executeCalls).toHaveLength(0)
  })

  it('refuses to bind a private browsing window when the policy is on', async () => {
    const { driver, service } = setup()
    driver.bindingTitle = 'New Tab - Incognito'

    await expect(service.bindBrowser({ pid: 10, windowId: 20 }, callFor()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(service.boundSessionCount).toBe(0)
  })

  it('allows a private browsing window when the policy is disabled', async () => {
    const { driver, service } = setup({
      config: resolveHostConfig({ recording: { privacy: { blockPrivateBrowsing: false } } }),
    })
    driver.bindingTitle = 'New Tab - Incognito'

    const summary = await service.bindBrowser({ pid: 10, windowId: 20 }, callFor())
    expect(summary.bound).toBe(true)
    expect(service.boundSessionCount).toBe(1)
  })

  it('binds, observes and executes one action with a started/finished pair', async () => {
    const { driver, sink, service } = setup()

    const summary = await service.bindBrowser({ pid: 10, windowId: 20 }, callFor('session-a', { callId: 'call-bind' }))
    expect(summary).toMatchObject({ bound: true, driverId: 'fake-driver', sessionId: 'session-a' })
    expect(service.boundSessionCount).toBe(1)

    const observation = await service.observe(callFor())
    expect(observation.url).toBe('https://example.test/form')
    expect(observation.elements[0]).toEqual({ role: 'button', name: 'Submit' })
    // Driver 私有句柄（ref/observationId）不得进入 DTO。
    expect(JSON.stringify(observation)).not.toContain('"ref"')
    expect(JSON.stringify(observation)).not.toContain('observationId')

    const receipt = await service.performAction({ kind: 'click', target: SUBMIT }, callFor('session-a', { callId: 'call-act' }))
    expect(receipt.status).toBe('success')
    expect(receipt.stepId).toMatch(/^step_/)
    expect(sink.started[0]?.callId).toBe('call-act')
    expect(sink.finished).toHaveLength(1)
    expect(sink.finished[0]?.status).toBe('success')
    expect(driver.executeCalls.map(action => action.kind)).toEqual(['click'])
  })

  it('refuses an action without a browser binding as BROWSER_BINDING_STALE', async () => {
    const { driver, service } = setup()
    await expect(service.performAction({ kind: 'navigate', url: 'https://example.test' }, callFor()))
      .rejects.toMatchObject({ code: 'BROWSER_BINDING_STALE' })
    expect(driver.executeCalls).toHaveLength(0)
  })

  it('rejects a forged ownerSessionId in the bind input with FORBIDDEN', async () => {
    const { driver, service } = setup()
    const forged = { pid: 10, windowId: 20, ownerSessionId: 'session-b' } as unknown as Parameters<typeof service.bindBrowser>[0]
    await expect(service.bindBrowser(forged, callFor('session-a'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(driver.bindCalls).toBe(0)
  })

  it('rejects a missing Host identity as INVALID_ARGUMENT', async () => {
    const { driver, service } = setup()
    await expect(service.bindBrowser({ pid: 10, windowId: 20 }, { exec: { session: { id: 'session-a' } } }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.bindBrowser({ pid: 10, windowId: 20 }, { exec: { agent: { id: 'agent-a' } } }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(driver.bindCalls).toBe(0)
  })

  it('cancels only the calling session in-flight actions', async () => {
    const { driver, service } = setup()
    await service.bindBrowser({ pid: 10, windowId: 20 }, callFor('session-a'))
    await service.bindBrowser({ pid: 11, windowId: 21 }, callFor('session-b'))
    driver.holdExecute = true

    const pending = service.performAction({ kind: 'click', target: SUBMIT }, callFor('session-a'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    await vi.waitFor(() => expect(driver.executeCalls).toHaveLength(1))

    expect(await service.cancelOperations(callFor('session-b'))).toEqual({ cancelled: 0 })
    expect(await service.cancelOperations(callFor('session-a'))).toEqual({ cancelled: 1 })
    await rejected

    // 取消幂等：已无在途动作。
    expect(await service.cancelOperations(callFor('session-a'))).toEqual({ cancelled: 0 })
  })

  it('releases bindings idempotently and even while the feature is off', async () => {
    const enabled = setup()
    await enabled.service.bindBrowser({ pid: 10, windowId: 20 }, callFor())
    expect(await enabled.service.releaseBrowser(callFor())).toEqual({ released: true })
    expect(await enabled.service.releaseBrowser(callFor())).toEqual({ released: false })
    expect(enabled.driver.releaseCalls).toBe(1)

    const disabled = setup({ config: disabledConfig() })
    expect(await disabled.service.releaseBrowser(callFor())).toEqual({ released: false })
  })

  it('filters read models by the authenticated Principal and returns empty pages without a store', async () => {
    const recordings = new FakeRecordingPort()
    recordings.recordings = [
      recordingSummary(rec('a'), 'session-a'),
      recordingSummary(rec('b'), 'session-b'),
    ]
    recordings.steps = [{
      stepId: 'step_1' as RecordingStep['stepId'],
      seq: 1,
      status: 'success',
      actionKind: 'click',
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
    }]
    const { service } = setup({ recordings })

    const page = await service.listRecordings(undefined, callFor('session-a'))
    expect(page.items.map(item => item.recordingId)).toEqual([rec('a')])
    expect(await service.getRecording(rec('a'), callFor('session-a'))).toMatchObject({ recordingId: rec('a') })
    expect(await service.getRecording(rec('b'), callFor('session-a'))).toBeUndefined()
    expect((await service.listSteps(rec('a'), undefined, callFor('session-a'))).items).toHaveLength(1)
    // 其他 Session 的 Recording 即使知道 ID 也读不到步骤（Host 负责权限过滤）。
    expect(await service.listSteps(rec('b'), undefined, callFor('session-a'))).toEqual({ items: [] })

    const noStore = setup()
    expect(await noStore.service.listRecordings(undefined, callFor())).toEqual({ items: [] })
    expect(await noStore.service.getRecording(rec('a'), callFor())).toBeUndefined()
  })

  it('validates query arguments with stable codes', async () => {
    const { service } = setup()
    await expect(service.listRecordings({ limit: 0 }, callFor())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.listRecordings({ limit: 201 }, callFor())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.listRecordings({ status: 'bogus' as never }, callFor()))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.getRecording('not-a-recording' as RecordingId, callFor()))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.getRun('not-a-run' as RunId, callFor())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('forwards replay control with ownership checks and idempotent cancellation', async () => {
    const replay = new FakeReplayPort()
    replay.runs = [
      runSummary(run('1'), rec('a'), 'running', 'session-a'),
      runSummary(run('2'), rec('a'), 'completed', 'session-a'),
      runSummary(run('3'), rec('b'), 'running', 'session-b'),
    ]
    const { service } = setup({ replay })

    const onRunStarted = vi.fn()
    const started = await service.startReplay(
      { recordingId: rec('a'), idempotencyKey: 'idem-1', onRunStarted },
      callFor('session-a'),
    )
    expect(started.status).toBe('running')
    // 超时中止依赖宿主把 onRunStarted 原样转给 ReplayPort。
    expect(replay.startCalls).toEqual([{ recordingId: rec('a'), idempotencyKey: 'idem-1', onRunStarted }])

    expect((await service.listRuns(undefined, callFor('session-a'))).items.map(item => item.runId))
      .toEqual([run('1'), run('2')])

    expect((await service.cancelRun(run('1'), callFor('session-a'))).status).toBe('cancelled')
    expect(replay.cancelCalls).toEqual([run('1')])

    // 终态 Run 原样返回，不重复下发控制命令。
    expect((await service.cancelRun(run('2'), callFor('session-a'))).status).toBe('completed')
    expect(replay.cancelCalls).toEqual([run('1')])

    await expect(service.cancelRun(run('3'), callFor('session-a'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('returns FEATURE_DISABLED for replay use cases without a replay port', async () => {
    const { service } = setup()
    await expect(service.startReplay({ recordingId: rec('a') }, callFor()))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    expect(await service.listRuns(undefined, callFor())).toEqual({ items: [] })
  })

  it('disposes once, releases bindings and refuses new actions afterwards', async () => {
    const { driver, service } = setup()
    await service.bindBrowser({ pid: 10, windowId: 20 }, callFor())

    await service.dispose()
    expect(service.isDisposed).toBe(true)
    expect(driver.releaseCalls).toBe(1)

    await service.dispose()
    expect(driver.releaseCalls).toBe(1)

    await expect(service.performAction({ kind: 'navigate', url: 'https://example.test' }, callFor()))
      .rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    await expect(service.observe(callFor())).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
  })
})
