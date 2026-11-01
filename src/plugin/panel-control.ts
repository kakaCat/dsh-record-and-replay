/**
 * Panel → RecordingService control port (P1-1 live HUD).
 *
 * The panel is same-origin authenticated UI, but it has no agent principal.
 * It therefore cannot invent one: the port reads the recording manifest and
 * reuses its `ownerSessionId`, which is exactly the principal the recording
 * was started under. If the recording is not active in this process (another
 * DSH instance owns the writer), RecordingService rejects with
 * `RECORDING_LOCKED` and the panel surfaces that error instead of guessing.
 */
import { assertRecordingId, type Principal, type RecordingId } from '../core/api.js'
import type { RecordingService } from '../recording/index.js'
import type { RecordingStore, StoreManifest } from '../store/api.js'
import type {
  PanelRecordingControlPort,
  PanelRecordingControlRequest,
} from '../panel/service.js'
import type { PanelRecordingControlResult } from '../panel/types.js'

/** The slice of a workspace runtime the port needs; kept structural for tests. */
export interface PanelControlRuntime {
  readonly store: Pick<RecordingStore, 'readManifest'>
  readonly recordings: Pick<RecordingService, 'stop' | 'discard'>
}

export interface PanelRecordingControlPortOptions {
  readonly runtimeForRoot: (root: string) => Promise<PanelControlRuntime>
}

function toResult(descriptor: {
  readonly recordingId: RecordingId
  readonly status: PanelRecordingControlResult['status']
  readonly endReason?: PanelRecordingControlResult['endReason']
}): PanelRecordingControlResult {
  return {
    recordingId: descriptor.recordingId,
    status: descriptor.status,
    ...(descriptor.endReason === undefined ? {} : { endReason: descriptor.endReason }),
  }
}

export function createPanelRecordingControlPort(
  options: PanelRecordingControlPortOptions,
): PanelRecordingControlPort {
  const control = async (
    action: 'stop' | 'discard',
    request: PanelRecordingControlRequest,
  ): Promise<PanelRecordingControlResult> => {
    const recordingId = assertRecordingId(request.recordingId)
    const runtime = await options.runtimeForRoot(request.root)
    const manifest: StoreManifest = await runtime.store.readManifest(recordingId)
    const principal: Principal = {
      sessionId: manifest.ownerSessionId,
      agentId: 'panel-operator',
    }
    const descriptor = action === 'stop'
      ? await runtime.recordings.stop(recordingId, principal)
      : await runtime.recordings.discard(recordingId, principal)
    return toResult(descriptor)
  }

  return {
    stop: async (request) => await control('stop', request),
    discard: async (request) => await control('discard', request),
  }
}
