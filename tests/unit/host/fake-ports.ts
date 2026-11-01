/**
 * t6（RecordingService 只读侧）与 t8（ReplayService）的测试端口实现。
 * Host 测试只验证 Host 的开关、所有权与 DTO 边界，不重复实现生命周期。
 */
import type { Principal, RecordingId, RunId } from '../../../src/core/api.js'
import type {
  Page,
  RecordingListQuery,
  RecordingReadPort,
  RecordingStep,
  RecordingSummary,
  ReplayPort,
  RunListQuery,
  RunSummary,
  StartReplayInput,
  StepListQuery,
} from '../../../src/host/service.js'

export const rec = (suffix: string): RecordingId => `rec_${suffix}` as RecordingId
export const run = (suffix: string): RunId => `run_${suffix}` as RunId

export function recordingSummary(recordingId: RecordingId, ownerSessionId: string): RecordingSummary {
  return {
    recordingId,
    title: `title-${recordingId}`,
    status: 'completed',
    ownerSessionId,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:01.000Z',
    stepCount: 1,
    lastSeq: 1,
  }
}

export function runSummary(
  runId: RunId,
  recordingId: RecordingId,
  status: RunSummary['status'],
  ownerSessionId: string,
): RunSummary {
  return { runId, recordingId, status, ownerSessionId }
}

export class FakeRecordingPort implements RecordingReadPort {
  recordings: RecordingSummary[] = []
  steps: RecordingStep[] = []
  listCalls = 0

  async listRecordings(_principal: Principal, _query: RecordingListQuery): Promise<Page<RecordingSummary>> {
    this.listCalls += 1
    return { items: this.recordings }
  }

  async getRecording(recordingId: RecordingId, _principal: Principal): Promise<RecordingSummary | undefined> {
    return this.recordings.find(recording => recording.recordingId === recordingId)
  }

  async listSteps(_recordingId: RecordingId, _principal: Principal, _query: StepListQuery): Promise<Page<RecordingStep>> {
    return { items: this.steps }
  }
}

export class FakeReplayPort implements ReplayPort {
  runs: RunSummary[] = []
  startCalls: StartReplayInput[] = []
  cancelCalls: RunId[] = []

  async listRuns(_principal: Principal, _query: RunListQuery): Promise<Page<RunSummary>> {
    return { items: this.runs }
  }

  async getRun(runId: RunId, _principal: Principal): Promise<RunSummary | undefined> {
    return this.runs.find(entry => entry.runId === runId)
  }

  async startReplay(input: StartReplayInput, _principal: Principal): Promise<RunSummary> {
    this.startCalls.push(input)
    return runSummary(run('started'), input.recordingId, 'running', 'session-a')
  }

  async cancelRun(runId: RunId, _principal: Principal): Promise<RunSummary> {
    this.cancelCalls.push(runId)
    const existing = this.runs.find(entry => entry.runId === runId)
    return existing === undefined
      ? runSummary(runId, rec('unknown'), 'cancelled', 'session-a')
      : { ...existing, status: 'cancelled' }
  }
}
