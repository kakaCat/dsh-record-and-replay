/**
 * Panel → host replay bridge (M3).
 *
 * The panel is served from DSH's fetch routes and therefore has no session
 * execution context. It talks about a *project root*, so this adapter finds
 * the workspace runtime for that root and drives the same workspace
 * `ReplayPort` the CLI and `cua_replay_start` use. That shared port is what
 * makes the new run land in the original recording's own
 * `runs/<runId>/` (run.json, steps.jsonl, video/) instead of a panel-owned
 * store.
 *
 * `ReplayPort.startReplay` resolves only after the run finishes. The panel
 * contract is "return a runId immediately, let the client poll", so this
 * adapter resolves on `onRunStarted` (the run record already exists) and lets
 * the replay continue in the background. A failure *after* the run exists is
 * already visible as a failed Run on disk, so it is swallowed here; failures
 * before the run exists (bad recording, unsupported step, no binding) reject
 * and become PANEL_REPLAY_FAILED.
 */
import type { Principal, RecordingId } from '../core/api.js'
import type { ReplayPort } from '../host/index.js'
import type {
  PanelReplayPort,
  PanelReplayRequest,
} from '../panel/service.js'
import type { PanelReplayStartResult } from '../panel/types.js'

export interface PanelReplayRuntime {
  /** The workspace replay port; only the start side is needed. */
  readonly replay: Pick<ReplayPort, 'startReplay'>
}

export interface CreatePanelReplayPortOptions {
  /** `config.replay.enabled`; when false the panel reports the action unavailable. */
  readonly enabled: boolean
  /** Resolve the workspace runtime for a canonical project root. */
  readonly runtimeForRoot: (root: string) => Promise<PanelReplayRuntime>
  /** Principal stamped on the run (the panel has no agent session). */
  readonly principal?: Principal
}

const PANEL_PRINCIPAL: Principal = { sessionId: 'panel', agentId: 'panel' }

/** Build the panel replay port, or `undefined` when replay is disabled. */
export function createPanelReplayPort(
  options: CreatePanelReplayPortOptions,
): PanelReplayPort | undefined {
  if (!options.enabled) return undefined
  const principal = options.principal ?? PANEL_PRINCIPAL

  return {
    async startReplay(input: PanelReplayRequest): Promise<PanelReplayStartResult> {
      const runtime = await options.runtimeForRoot(input.root)
      const runId = await new Promise<string>((resolve, reject) => {
        let started = false
        void runtime.replay.startReplay({
          recordingId: input.recordingId as RecordingId,
          target: { launch: 'isolated' },
          ...(input.values === undefined ? {} : { values: input.values }),
          onRunStarted: (id) => {
            started = true
            resolve(id)
          },
        }, principal).then(
          () => {
            if (!started) reject(new Error('replay finished without creating a run'))
          },
          (error: unknown) => {
            if (!started) reject(error)
          },
        )
      })
      return { runId }
    },
  }
}
