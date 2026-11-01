import { describe, expect, it } from 'vitest'
import { OperationRunner } from '../../../src/driver/operation-runner.js'
import type { HostConfig } from '../../../src/host/config.js'
import { CuaRecordReplayService, type RecordingReadPort, type ReplayPort } from '../../../src/host/service.js'
import {
  HOST_TOOL_NAMES,
  INTERNAL_CUA_TOOL_NAMES,
  createHostTools,
  resolveToolAllowlist,
  type HostToolDefinition,
  type HostToolName,
} from '../../../src/host/tools.js'
import { FakeBrowserDriver } from './fake-driver.js'
import { FakeRecordingPort, FakeReplayPort, rec, recordingSummary, run } from './fake-ports.js'
import { RecordingSink, callFor, disabledConfig, enabledConfig, walkingClock } from './support.js'

function setup(options: {
  readonly config?: HostConfig
  readonly recordings?: RecordingReadPort
  readonly replay?: ReplayPort
  readonly allow?: readonly string[]
} = {}): {
  readonly driver: FakeBrowserDriver
  readonly sink: RecordingSink
  readonly service: CuaRecordReplayService
  readonly tools: readonly HostToolDefinition[]
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
  const tools = createHostTools(service, options.allow === undefined ? {} : { allow: options.allow })
  return { driver, sink, service, tools }
}

function tool(tools: readonly HostToolDefinition[], name: HostToolName): HostToolDefinition {
  const found = tools.find(candidate => candidate.name === name)
  if (found === undefined) throw new Error(`tool ${name} is not registered`)
  return found
}

describe('host/tools', () => {
  it('exposes only stable public tool names and never the internal Cua tools', () => {
    const { tools } = setup()
    expect(tools.map(candidate => candidate.name)).toEqual([...HOST_TOOL_NAMES])
    for (const internal of INTERNAL_CUA_TOOL_NAMES) {
      expect(HOST_TOOL_NAMES as readonly string[]).not.toContain(internal)
    }
  })

  it('selects tools by allowlist and rejects unknown or internal names', () => {
    const { service } = setup()
    expect(resolveToolAllowlist([])).toEqual([...HOST_TOOL_NAMES])
    expect(resolveToolAllowlist(['cua_record_query', 'cua_record_action']))
      .toEqual(['cua_record_action', 'cua_record_query'])
    expect(createHostTools(service, { allow: ['cua_record_query'] }).map(candidate => candidate.name))
      .toEqual(['cua_record_query'])

    expect(() => resolveToolAllowlist(['cua_record_unknown'])).toThrowError()
    try {
      resolveToolAllowlist(['cua_record_unknown'])
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CONFIG_INVALID')
    }
    try {
      resolveToolAllowlist(['browser_click'])
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CONFIG_INVALID')
    }
  })

  it('returns FEATURE_DISABLED from execution tools while the switch is off', async () => {
    const { driver, tools } = setup({ config: disabledConfig() })
    const call = callFor()

    await expect(tool(tools, 'cua_record_bind_browser').handle({ pid: 1, windowId: 2 }, call))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    await expect(tool(tools, 'cua_record_observe').handle({}, call))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    await expect(tool(tools, 'cua_record_action').handle({ action: { kind: 'navigate', url: 'https://example.test' } }, call))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    await expect(tool(tools, 'cua_replay_start').handle({ recordingId: rec('a') }, call))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })

    // 只读查询与清理动作在关闭时仍可用（历史可读、资源可释放）。
    expect(await tool(tools, 'cua_record_query').handle({ kind: 'recordings' }, call)).toEqual({ items: [] })
    expect(await tool(tools, 'cua_record_cancel').handle({}, call)).toEqual({ cancelled: 0 })
    expect(await tool(tools, 'cua_record_release_browser').handle({}, call)).toEqual({ released: false })
    expect(driver.bindCalls).toBe(0)
  })

  it('rejects a forged ownerSessionId with FORBIDDEN before touching the driver', async () => {
    const { driver, tools } = setup()
    await expect(tool(tools, 'cua_record_bind_browser').handle(
      { pid: 1, windowId: 2, ownerSessionId: 'session-b' },
      callFor('session-a'),
    )).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(tool(tools, 'cua_record_action').handle({
      action: {
        kind: 'click',
        target: { role: 'button', name: 'Submit', extensions: { ownerSessionId: 'session-b' } },
      },
    }, callFor('session-a'))).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(driver.bindCalls).toBe(0)
    expect(driver.executeCalls).toHaveLength(0)
  })

  it('validates arguments strictly: object shape, unknown keys and action variants', async () => {
    const { tools } = setup()
    const call = callFor()

    await expect(tool(tools, 'cua_record_bind_browser').handle('not-an-object', call))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_record_bind_browser').handle({ pid: 1, windowId: 2, extra: true }, call))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_record_bind_browser').handle({ pid: 0, windowId: 2 }, call))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_record_action').handle({ action: { kind: 'click' } }, call))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_record_action').handle({ action: { kind: 'navigate', url: 'ftp://example.test' } }, call))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_record_action').handle({
      action: { kind: 'navigate', url: 'https://example.test', surprise: 1 },
    }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    // assert 分支合法且被严格校验；css 目标不允许用于断言。
    await tool(tools, 'cua_record_bind_browser').handle({ pid: 10, windowId: 20 }, call)
    expect(await tool(tools, 'cua_record_action').handle({
      action: { kind: 'assert', check: { kind: 'url', contains: 'example.test' } },
    }, call)).toMatchObject({ status: 'success' })
    await expect(tool(tools, 'cua_record_action').handle({
      action: { kind: 'assert', check: { kind: 'url', contains: 'x', surprise: 1 } },
    }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_record_action').handle({
      action: { kind: 'assert', check: { kind: 'element', target: { css: '#x' }, exists: true } },
    }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_record_query').handle({ kind: 'nothing' }, call))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_replay_cancel').handle({}, call))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('rejects tools calls without a Host identity', async () => {
    const { tools } = setup()
    await expect(tool(tools, 'cua_record_bind_browser').handle(
      { pid: 1, windowId: 2 },
      { exec: {} },
    )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('runs bind → observe → action and records one started/finished pair', async () => {
    const { driver, sink, tools } = setup()
    const call = callFor('session-a', { callId: 'call-7' })

    expect(await tool(tools, 'cua_record_bind_browser').handle({ pid: 10, windowId: 20 }, call))
      .toMatchObject({ bound: true, driverId: 'fake-driver', sessionId: 'session-a' })

    const observation = await tool(tools, 'cua_record_observe').handle({}, call) as unknown as {
      readonly elements: readonly { readonly role: string; readonly name?: string }[]
    }
    expect(observation.elements[0]).toEqual({ role: 'button', name: 'Submit' })

    const receipt = await tool(tools, 'cua_record_action').handle({
      action: { kind: 'click', target: { role: 'button', name: 'Submit' } },
    }, call) as unknown as { readonly stepId: string; readonly status: string }

    expect(receipt.status).toBe('success')
    expect(sink.started).toHaveLength(1)
    expect(sink.finished).toHaveLength(1)
    expect(sink.started[0]?.stepId).toBe(receipt.stepId)
    expect(sink.started[0]?.callId).toBe('call-7')
    expect(driver.executeCalls.map(action => action.kind)).toEqual(['click'])
  })

  it('answers read-only queries from the session scope without any browser action', async () => {
    const recordings = new FakeRecordingPort()
    recordings.recordings = [
      { ...recordingSummary(rec('a'), 'session-a'), intent: '核对搜索首屏结果' },
      recordingSummary(rec('b'), 'session-b'),
    ]
    const replay = new FakeReplayPort()
    replay.runs = [{ runId: run('1'), recordingId: rec('a'), status: 'running', ownerSessionId: 'session-a' }]
    const { driver, tools } = setup({ recordings, replay })
    const call = callFor('session-a')

    const page = await tool(tools, 'cua_record_query').handle({ kind: 'recordings' }, call) as unknown as {
      readonly items: readonly { readonly recordingId: string; readonly intent?: string }[]
    }
    expect(page.items.map(item => item.recordingId)).toEqual([rec('a')])
    expect(page.items[0]?.intent).toBe('核对搜索首屏结果')

    const single = await tool(tools, 'cua_record_query').handle({ kind: 'recording', recordingId: rec('a') }, call) as {
      readonly intent?: string
    }
    expect(single.intent).toBe('核对搜索首屏结果')

    const other = await tool(tools, 'cua_record_query').handle({ kind: 'recording', recordingId: rec('b') }, call)
    expect(other).toBeNull()

    const runs = await tool(tools, 'cua_record_query').handle({ kind: 'runs' }, call) as unknown as {
      readonly items: readonly { readonly runId: string }[]
    }
    expect(runs.items.map(item => item.runId)).toEqual([run('1')])

    expect(await tool(tools, 'cua_record_query').handle({ kind: 'run', runId: run('1') }, call))
      .toMatchObject({ runId: run('1') })

    expect(driver.bindCalls).toBe(0)
    expect(driver.executeCalls).toHaveLength(0)
  })
})
