import { describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, type BrowserAction, type OperationContext, type Principal, type RecordingId } from '../../../src/core/api.js'
import type { BrowserBinding, BrowserDriver } from '../../../src/driver/api.js'
import { createPluginReplayPort } from '../../../src/plugin/replay-port.js'
import { MemoryRunStore } from '../../../src/replay/index.js'
import type { StoreManifest } from '../../../src/store/api.js'

const principal: Principal = { sessionId: 'dispose-test', agentId: 'dispose-test' }
const recordingId = 'rec_dispose_test' as RecordingId

class BlockingDriver implements BrowserDriver {
  readonly id = 'blocking-driver'
  started = false

  async capabilities() {
    return { actions: ['navigate'] as const, locators: ['url'] as const, driverVersion: 'test' }
  }

  async bind(): Promise<BrowserBinding> {
    return {
      id: 'binding',
      driverId: this.id,
      sessionId: principal.sessionId,
      pid: 1,
      windowId: 2,
      targetId: 'target',
      tabId: 'tab',
      generation: 1,
    }
  }

  async observe(binding: BrowserBinding) {
    return {
      observationId: 'observation',
      bindingGeneration: binding.generation,
      url: 'https://example.test',
      elements: [],
    }
  }

  async resolve(): Promise<never> {
    throw new Error('not needed')
  }

  async execute(_binding: BrowserBinding, _action: BrowserAction, _resolved: undefined, context: OperationContext) {
    this.started = true
    return new Promise<never>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('cancelled for dispose')), { once: true })
    })
  }

  async release(): Promise<void> {}
}

describe('plugin replay disposal', () => {
  it('cancels an active replay and finalizes its recorder before resolving disposal', async () => {
    const manifest: StoreManifest = {
      schemaVersion: SCHEMA_VERSION,
      recordingId,
      title: 'Dispose fixture',
      status: 'completed',
      ownerSessionId: principal.sessionId,
      driver: { id: 'blocking-driver', version: 'test', transport: 'memory' },
      browser: { app: 'Chrome' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastSeq: 1,
      stepCount: 1,
      stepsSha256: 'a'.repeat(64),
    }
    const driver = new BlockingDriver()
    const recorder = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }
    const port = createPluginReplayPort({
      driver,
      recordings: {
        async *readSteps() {
          yield {
            stepId: 'step_dispose',
            seq: 1,
            callId: 'call-dispose',
            origin: 'agent',
            actionKind: 'navigate',
            action: { kind: 'navigate', url: 'https://example.test' },
            status: 'success',
            startedAt: 1,
            finishedAt: 2,
            durationMs: 1,
          }
        },
      } as never,
      store: { readManifest: async () => manifest } as never,
      runStore: new MemoryRunStore(),
      videoEnabled: true,
      videoDirFor: () => '/tmp/dsh-replay-dispose-video',
      videoRecorderFactory: () => recorder,
    })

    const running = port.startReplay({
      recordingId,
      target: { launch: 'existing', pid: 1, windowId: 2 },
    }, principal)
    for (let attempt = 0; attempt < 50 && !driver.started; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (!driver.started) {
      const early = await running.catch(error => error)
      throw early instanceof Error ? early : new Error('replay did not reach the blocking driver')
    }
    expect(driver.started).toBe(true)
    const disposing = port.dispose?.()
    await running.catch(() => undefined)
    await disposing
    expect(recorder.stop).toHaveBeenCalledOnce()
    await expect(port.startReplay({
      recordingId,
      target: { launch: 'existing', pid: 1, windowId: 2 },
    }, principal)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
  })
})
