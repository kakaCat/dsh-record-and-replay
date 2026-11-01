import { describe, expect, it, vi } from 'vitest'
import type { BrowserAction, OperationContext, SemanticTarget } from '../../../src/core/api.js'
import { BrowserDriverError } from '../../../src/driver/api.js'
import { OperationRunner, type StepFinishedEvent, type StepStartedEvent } from '../../../src/driver/operation-runner.js'
import { FakeBrowserDriver } from './fake-driver.js'
import { RecordingSink, operationContext, walkingClock } from './support.js'

const SUBMIT: SemanticTarget = { role: 'button', name: 'Submit' }

function setup(options: { readonly clock?: () => number } = {}): {
  readonly driver: FakeBrowserDriver
  readonly sink: RecordingSink
  readonly runner: OperationRunner
} {
  const driver = new FakeBrowserDriver()
  const sink = new RecordingSink()
  const runner = new OperationRunner({
    driver,
    events: sink,
    clock: options.clock ?? walkingClock(),
  })
  return { driver, sink, runner }
}

describe('OperationRunner', () => {
  it('records exactly one started/finished pair per logical action', async () => {
    const { driver, sink, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())

    const outcome = await runner.run({
      binding,
      action: { kind: 'navigate', url: 'https://example.test/next' },
      context: operationContext('session-a', { callId: 'call-1' }),
    })

    expect(outcome.status).toBe('success')
    expect(outcome.seq).toBe(1)
    expect(outcome.durationMs).toBe(5)
    expect(sink.events).toHaveLength(2)

    const started = sink.events[0] as StepStartedEvent
    const finished = sink.events[1] as StepFinishedEvent
    expect(started.type).toBe('step.started')
    expect(started.schemaVersion).toBe(1)
    expect(started.stepId).toMatch(/^step_/)
    expect(started.stepId).toBe(outcome.stepId)
    expect(started.callId).toBe('call-1')
    expect(started.origin).toBe('agent')
    expect(started.action).toEqual({ kind: 'navigate', url: 'https://example.test/next' })
    expect(started.startedAt).toBe(1_000)

    expect(finished.type).toBe('step.finished')
    expect(finished.stepId).toBe(started.stepId)
    expect(finished.callId).toBe('call-1')
    expect(finished.status).toBe('success')
    expect(finished.finishedAt).toBe(1_005)
    expect(finished.durationMs).toBe(5)
    expect(finished.resultSummary).toBe('navigate ok')
  })

  it('observes and resolves only for actions with a semantic target', async () => {
    const { driver, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())

    await runner.run({
      binding,
      action: { kind: 'navigate', url: 'https://example.test/next' },
      context: operationContext(),
    })
    expect(driver.observeCalls).toBe(0)
    expect(driver.resolveCalls).toBe(0)

    const outcome = await runner.run({
      binding,
      action: { kind: 'click', target: SUBMIT },
      context: operationContext(),
    })
    expect(outcome.status).toBe('success')
    expect(driver.observeCalls).toBe(1)
    expect(driver.resolveCalls).toBe(1)
    expect(driver.executeCalls.map(action => action.kind)).toEqual(['navigate', 'click'])
  })

  it('finishes with the stable error code and a sanitized message when a step fails', async () => {
    const { driver, sink, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())
    driver.executeFailure = new BrowserDriverError('TARGET_NOT_FOUND', 'missing element in /Volumes/work/secret.txt')

    const outcome = await runner.run({ binding, action: { kind: 'click', target: SUBMIT }, context: operationContext() })

    expect(outcome.status).toBe('error')
    expect(outcome.error?.code).toBe('TARGET_NOT_FOUND')
    expect(outcome.error?.message).not.toContain('Volumes')
    expect(outcome.error?.stepId).toBe(outcome.stepId)

    const finished = sink.finished[0] as StepFinishedEvent
    expect(finished.status).toBe('error')
    expect(finished.error?.code).toBe('TARGET_NOT_FOUND')
    expect(sink.events).toHaveLength(2)
  })

  it('never retries a write action whose result is unknown', async () => {
    const { driver, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())
    driver.executeFailure = new BrowserDriverError('CUA_CALL_TIMEOUT', 'browser_click timed out after 30000ms')

    const outcome = await runner.run({ binding, action: { kind: 'click', target: SUBMIT }, context: operationContext() })

    expect(outcome.status).toBe('error')
    expect(outcome.error?.code).toBe('CUA_CALL_TIMEOUT')
    expect(driver.executeCalls).toHaveLength(1)
    expect(driver.observeCalls).toBe(1)
  })

  it('refreshes a stale observation once before sending the action', async () => {
    const { driver, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())
    driver.staleObserveTimes = 1

    const outcome = await runner.run({ binding, action: { kind: 'click', target: SUBMIT }, context: operationContext() })

    expect(outcome.status).toBe('success')
    expect(driver.observeCalls).toBe(2)
    expect(driver.executeCalls).toHaveLength(1)
  })

  it('stops when the observation is still stale after one refresh', async () => {
    const { driver, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())
    driver.staleObserveTimes = 2

    const outcome = await runner.run({ binding, action: { kind: 'click', target: SUBMIT }, context: operationContext() })

    expect(outcome.status).toBe('error')
    expect(outcome.error?.code).toBe('TARGET_STALE')
    expect(driver.executeCalls).toHaveLength(0)
  })

  it('records a cancelled step without sending any browser action when already aborted', async () => {
    const { driver, sink, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())
    const controller = new AbortController()
    controller.abort()

    const outcome = await runner.run({
      binding,
      action: { kind: 'click', target: SUBMIT },
      context: operationContext('session-a', { signal: controller.signal }),
    })

    expect(outcome.status).toBe('cancelled')
    expect(outcome.error?.code).toBe('OPERATION_CANCELLED')
    expect(driver.observeCalls).toBe(0)
    expect(driver.executeCalls).toHaveLength(0)
    const finished = sink.finished[0] as StepFinishedEvent
    expect(finished.status).toBe('cancelled')
  })

  it('does not send the action when the recording sink rejects the started event', async () => {
    const { driver, sink, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())
    sink.failOn = 'step.started'

    await expect(runner.run({
      binding,
      action: { kind: 'navigate', url: 'https://example.test/next' },
      context: operationContext(),
    })).rejects.toMatchObject({ code: 'RECORDING_LIMIT_EXCEEDED' })

    expect(driver.executeCalls).toHaveLength(0)
    expect(sink.events).toHaveLength(0)
  })

  it('refuses new actions after stop() without emitting events', async () => {
    const { driver, sink, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())
    runner.stop()

    await expect(runner.run({
      binding,
      action: { kind: 'navigate', url: 'https://example.test/next' },
      context: operationContext(),
    })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })

    expect(sink.events).toHaveLength(0)
    expect(driver.executeCalls).toHaveLength(0)
  })

  it('rejects a malformed action before emitting any step event', async () => {
    const { driver, sink, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())

    await expect(runner.run({
      binding,
      action: { kind: 'click' } as unknown as BrowserAction,
      context: operationContext(),
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    expect(sink.events).toHaveLength(0)
    expect(driver.executeCalls).toHaveLength(0)
  })

  it('tracks in-flight operations and drain() waits for them', async () => {
    const { driver, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())
    driver.holdExecute = true

    const task = runner.run({ binding, action: { kind: 'click', target: SUBMIT }, context: operationContext() })
    await vi.waitFor(() => expect(driver.executeCalls).toHaveLength(1))
    expect(runner.activeCount).toBe(1)

    let drained = false
    const drain = runner.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    driver.finishHold()
    const outcome = await task
    expect(outcome.status).toBe('success')
    await drain
    expect(drained).toBe(true)
    expect(runner.activeCount).toBe(0)
  })

  it('sanitizes credentials and absolute paths in normalized errors', async () => {
    const { driver, runner } = setup()
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())
    driver.executeFailure = new Error('failed at /Volumes/work/secret.txt Authorization: Bearer abc.def')

    const outcome = await runner.run({
      binding,
      action: { kind: 'navigate', url: 'https://example.test/next' },
      context: operationContext(),
    })

    expect(outcome.error?.code).toBe('INVALID_ARGUMENT')
    expect(outcome.error?.message).toContain('<path>')
    expect(outcome.error?.message).not.toContain('Volumes')
    expect(outcome.error?.message).not.toContain('abc.def')
  })

  it('uses an injected seq allocator so the recording layer owns per-recording seq', async () => {
    const driver = new FakeBrowserDriver()
    const sink = new RecordingSink()
    const runner = new OperationRunner({ driver, events: sink, nextSeq: () => 42 })
    const binding = await driver.bind({ pid: 10, windowId: 20 }, operationContext())

    const outcome = await runner.run({
      binding,
      action: { kind: 'navigate', url: 'https://example.test/next' },
      context: operationContext(),
    })

    expect(outcome.seq).toBe(42)
    expect((sink.started[0] as StepStartedEvent).seq).toBe(42)
  })
})
