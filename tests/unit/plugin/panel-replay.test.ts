import { describe, expect, it, vi } from 'vitest'

import type { Principal, RunId } from '../../../src/core/api.js'
import type { ReplayPort, RunSummary } from '../../../src/host/index.js'
import type { StartReplayInput } from '../../../src/host/service.js'
import { createPanelReplayPort, type PanelReplayRuntime } from '../../../src/plugin/panel-replay.js'

const ROOT = '/workspace/demo'
const RECORDING = 'rec_abc'

function runtimeWith(startReplay: ReplayPort['startReplay']): PanelReplayRuntime {
  return { replay: { startReplay } }
}

function summary(runId: string): RunSummary {
  return { runId: runId as RunId } as RunSummary
}

describe('panel replay port (plugin host bridge, M3)', () => {
  it('is undefined when the replay feature is disabled', () => {
    expect(createPanelReplayPort({
      enabled: false,
      runtimeForRoot: async () => runtimeWith(async () => summary('run_x')),
    })).toBeUndefined()
  })

  it('resolves the runId as soon as onRunStarted fires, before the replay finishes', async () => {
    let finish: (() => void) | undefined
    const background = new Promise<void>((resolve) => {
      finish = resolve
    })
    const calls: { input: StartReplayInput; principal: Principal }[] = []
    const startReplay: ReplayPort['startReplay'] = async (input, principal) => {
      calls.push({ input, principal })
      input.onRunStarted?.('run_live' as RunId)
      await background
      return summary('run_live')
    }
    const runtimeForRoot = vi.fn(async () => runtimeWith(startReplay))
    const port = createPanelReplayPort({ enabled: true, runtimeForRoot })
    expect(port).toBeDefined()

    await expect(port?.startReplay({
      root: ROOT,
      recordingId: RECORDING,
      values: { step_1: 'hello' },
    })).resolves.toEqual({ runId: 'run_live' })

    expect(runtimeForRoot).toHaveBeenCalledWith(ROOT)
    expect(calls[0]?.input.recordingId).toBe(RECORDING)
    expect(calls[0]?.input.target).toEqual({ launch: 'isolated' })
    expect(calls[0]?.input.values).toEqual({ step_1: 'hello' })
    expect(calls[0]?.principal).toEqual({ sessionId: 'panel', agentId: 'panel' })
    finish?.()
  })

  it('omits values when the panel request has none', async () => {
    const calls: StartReplayInput[] = []
    const port = createPanelReplayPort({
      enabled: true,
      runtimeForRoot: async () => runtimeWith(async (input) => {
        calls.push(input)
        input.onRunStarted?.('run_v' as RunId)
        return summary('run_v')
      }),
    })
    await port?.startReplay({ root: ROOT, recordingId: RECORDING })
    expect(calls[0]).not.toHaveProperty('values')
  })

  it('rejects when the run never starts', async () => {
    const port = createPanelReplayPort({
      enabled: true,
      runtimeForRoot: async () => runtimeWith(async () => summary('run_none')),
    })
    await expect(port?.startReplay({ root: ROOT, recordingId: RECORDING }))
      .rejects.toThrow('replay finished without creating a run')
  })

  it('rejects pre-run failures and swallows failures after the run exists', async () => {
    const preRun = createPanelReplayPort({
      enabled: true,
      runtimeForRoot: async () => runtimeWith(async () => {
        throw Object.assign(new Error('recording is incomplete'), { code: 'RECORDING_INCOMPLETE' })
      }),
    })
    await expect(preRun?.startReplay({ root: ROOT, recordingId: RECORDING }))
      .rejects.toThrow('recording is incomplete')

    const postRun = createPanelReplayPort({
      enabled: true,
      runtimeForRoot: async () => runtimeWith(async (input) => {
        input.onRunStarted?.('run_failed_binding' as RunId)
        throw new Error('browser binding failed')
      }),
    })
    // The failed Run is already persisted, so the panel request still succeeds;
    // the client polls and shows the failed status.
    await expect(postRun?.startReplay({ root: ROOT, recordingId: RECORDING }))
      .resolves.toEqual({ runId: 'run_failed_binding' })
  })
})
