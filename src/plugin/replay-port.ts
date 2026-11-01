import * as path from 'node:path'
import { newRunId, type OperationContext, type Principal, type RecordingId, type RunId } from '../core/api.js'
import { ScreenRecorder } from '../cua/screen-recorder.js'
import { pruneRecordingVideos } from '../cua/video-retention.js'
import type { BrowserDriver } from '../driver/api.js'
import type {
  Page,
  ReplayPort,
  RunListQuery,
  RunSummary,
  StartReplayInput,
} from '../host/index.js'
import { HostError } from '../host/index.js'
import type { RecordingSource, ReplayRun, RunRecord, RunStore } from '../replay/index.js'
import { MemoryRunStore, SemanticReplayRunner } from '../replay/index.js'
import type { RecordingService } from '../recording/index.js'
import type { RecordingStore, StoreManifest } from '../store/api.js'

export interface PluginReplayPortOptions {
  readonly driver: BrowserDriver
  readonly recordings: RecordingService
  readonly store: RecordingStore
  readonly runStore?: RunStore
  /** Called after a replay reaches a terminal state; failures must not fail the run. */
  readonly onRunTerminal?: (run: RunSummary) => void | Promise<void>
  /** 回放时录 WebM；目录由 videoDirFor 决定。 */
  readonly videoEnabled?: boolean
  readonly videoDirFor?: (recordingId: RecordingId, runId: RunId) => string
  readonly videoFormat?: 'webm' | 'mp4'
  readonly videoMaxRuns?: number
}

interface RunStoreWithScan extends RunStore {
  listAllRuns?(): Promise<readonly RunRecord[]>
  stepCountOf?(recordingId: RecordingId, runId: RunId): Promise<number>
}

function summaryOfRecord(record: RunRecord, ownerSessionId: string, stepCount: number): RunSummary {
  return {
    runId: record.runId,
    recordingId: record.recordingId,
    status: record.status,
    ownerSessionId,
    driverId: record.driver.id,
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.currentStepId === undefined ? {} : { failedStepId: record.currentStepId }),
    recordingSha256: record.recordingSha256,
    stepCount,
    ...(record.error === undefined ? {} : { errorCode: record.error.code, errorMessage: record.error.message }),
  }
}

function summaryOf(
  run: ReplayRun,
  principal: Principal,
  stepCount: number,
): RunSummary {
  return {
    runId: run.runId,
    recordingId: run.recordingId,
    status: run.status,
    ownerSessionId: principal.sessionId,
    driverId: run.driverId,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    stepCount,
    ...(run.currentStepId === undefined ? {} : { failedStepId: run.currentStepId }),
    recordingSha256: run.recordingSha256,
    ...(run.error === undefined ? {} : { errorCode: run.error.code, errorMessage: run.error.message }),
  }
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const value = Number.parseInt(cursor, 10)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

export function createPluginReplayPort(options: PluginReplayPortOptions): ReplayPort {
  const runStore = (options.runStore ?? new MemoryRunStore()) as RunStoreWithScan
  const runners = new Map<RunId, SemanticReplayRunner>()
  const summaries = new Map<RunId, RunSummary>()
  const controllers = new Map<RunId, AbortController>()

  const ownerOf = async (recordingId: RecordingId): Promise<string | undefined> => {
    try {
      return (await options.store.readManifest(recordingId)).ownerSessionId
    } catch {
      return undefined
    }
  }
  const stepCountOf = async (recordingId: RecordingId, runId: RunId): Promise<number> => {
    return runStore.stepCountOf === undefined ? 0 : runStore.stepCountOf(recordingId, runId)
  }

  const source: RecordingSource = {
    async readManifest(recordingId: RecordingId): Promise<StoreManifest> {
      return options.store.readManifest(recordingId)
    },
    readSteps(recordingId: RecordingId) {
      return options.recordings.readSteps(recordingId)
    },
    async verifyRecordingUnchanged(recordingId: RecordingId, sha256: string): Promise<boolean> {
      const manifest = await options.store.readManifest(recordingId)
      return manifest.stepsSha256 === sha256
    },
  }

  return {
    async startReplay(input: StartReplayInput, principal: Principal): Promise<RunSummary> {
      const target = input.target
      if (target === undefined) {
        throw new HostError('INVALID_ARGUMENT', 'replay target pid/windowId is required')
      }
      const runId = newRunId()
      const controller = new AbortController()
      const replayPrincipal: Principal = {
        sessionId: `${principal.sessionId}:replay:${runId}`,
        agentId: principal.agentId,
      }
      const runner = new SemanticReplayRunner({
        recordings: source,
        runStore,
        driver: options.driver,
        newRunId: () => runId,
        binding: () => options.driver.bind(target.launch === 'isolated'
          ? { launch: 'isolated', ...(target.profileName === undefined ? {} : { profileName: target.profileName }) }
          : target.launch === 'desktop'
            ? { launch: 'desktop', pid: target.pid, windowId: target.windowId }
            : { launch: 'existing', pid: target.pid, windowId: target.windowId }, {
          principal: replayPrincipal,
          callId: `replay:${runId}`,
          origin: 'replay',
          signal: controller.signal,
        } as OperationContext),
      })
      const plan = await runner.plan(input.recordingId, {
        ...(target.launch === undefined ? {} : { launch: target.launch }),
        ...(input.values === undefined ? {} : { values: input.values }),
      })
      const recorder = options.videoEnabled === true && options.videoDirFor !== undefined ? new ScreenRecorder() : undefined
      if (recorder !== undefined && options.videoDirFor !== undefined) {
        await recorder.start({ outputDir: options.videoDirFor(input.recordingId, runId), ...(options.videoFormat === undefined ? {} : { format: options.videoFormat }) }).catch(() => undefined)
      }
      let videoPath: string | undefined
      runners.set(runId, runner)
      controllers.set(runId, controller)
      summaries.set(runId, {
        runId,
        recordingId: input.recordingId,
        status: 'preparing',
        ownerSessionId: principal.sessionId,
        driverId: options.driver.id,
        stepCount: plan.stepCount,
        recordingSha256: plan.recordingSha256,
      })

      try {
        await runner.execute(input.recordingId, {
          ...(target.launch === undefined ? {} : { launch: target.launch }),
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
          ...(input.values === undefined ? {} : { values: input.values }),
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
          ...(input.onRunStarted === undefined ? {} : { onRunStarted: input.onRunStarted }),
          signal: controller.signal,
        }, principal)
        const run = await runner.getRun(runId)
        videoPath = await recorder?.stop()
        const base = summaryOf(run, principal, plan.stepCount)
        const summary = videoPath === undefined ? base : { ...base, videoPath }
        summaries.set(runId, summary)
        try {
          await options.onRunTerminal?.(summary)
        } catch {
          // Auto-feedback is advisory; a skill-ledger failure must not fail the replay.
        }
        return summary
      } catch (error) {
        summaries.delete(runId)
        throw error
      } finally {
        if (recorder !== undefined) {
          videoPath = videoPath ?? await recorder.stop().catch(() => undefined)
        }
        if (options.videoMaxRuns !== undefined && options.videoDirFor !== undefined) {
          const runsDir = path.dirname(path.dirname(options.videoDirFor(input.recordingId, runId)))
          await pruneRecordingVideos({ runsDir, keep: options.videoMaxRuns }).catch(() => undefined)
        }
        runners.delete(runId)
        controllers.delete(runId)
      }
    },

    async getRun(runId: RunId, principal: Principal): Promise<RunSummary | undefined> {
      const summary = summaries.get(runId)
      if (summary !== undefined) {
        return summary.ownerSessionId === principal.sessionId ? summary : undefined
      }
      const record = await runStore.findRun(runId)
      if (record === undefined) return undefined
      const owner = await ownerOf(record.recordingId)
      if (owner !== principal.sessionId) return undefined
      return summaryOfRecord(record, owner, await stepCountOf(record.recordingId, record.runId))
    },

    async listRuns(principal: Principal, query: RunListQuery): Promise<Page<RunSummary>> {
      let records: readonly RunRecord[]
      if (query.recordingId !== undefined) {
        records = await runStore.listRuns(query.recordingId)
      } else if (runStore.listAllRuns !== undefined) {
        records = await runStore.listAllRuns()
      } else {
        records = [...summaries.values()].map((summary) => ({
          schemaVersion: 1 as RunRecord['schemaVersion'],
          runId: summary.runId,
          recordingId: summary.recordingId,
          recordingSha256: summary.recordingSha256 ?? '',
          driver: { id: summary.driverId ?? 'unknown', version: 'unknown', transport: 'mcp' },
          status: summary.status,
          ...(summary.failedStepId === undefined ? {} : { currentStepId: summary.failedStepId }),
          startedAt: summary.startedAt ?? new Date(0).toISOString(),
          ...(summary.finishedAt === undefined ? {} : { finishedAt: summary.finishedAt }),
          ...(summary.errorCode === undefined ? {} : { error: { code: summary.errorCode, message: summary.errorMessage ?? '' } }),
        }))
      }
      const items = (await Promise.all(records.map(async (record) => {
        const owner = await ownerOf(record.recordingId)
        if (owner !== principal.sessionId) return undefined
        return summaryOfRecord(record, owner, await stepCountOf(record.recordingId, record.runId))
      }))).filter((run): run is RunSummary => run !== undefined)
      let filtered = items
      if (query.status !== undefined) filtered = filtered.filter((run) => run.status === query.status)
      const offset = decodeCursor(query.cursor)
      const limit = query.limit ?? 50
      const page = filtered.slice(offset, offset + limit)
      const nextOffset = offset + page.length
      return { items: page, ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}) }
    },

    async cancelRun(runId: RunId, principal: Principal): Promise<RunSummary> {
      const runner = runners.get(runId)
      if (runner === undefined) {
        const record = await runStore.findRun(runId)
        if (record === undefined) throw new HostError('FORBIDDEN', 'The authenticated session does not own this run')
        const owner = await ownerOf(record.recordingId)
        if (owner !== principal.sessionId) throw new HostError('FORBIDDEN', 'The authenticated session does not own this run')
        return summaryOfRecord(record, owner, await stepCountOf(record.recordingId, record.runId))
      }
      controllers.get(runId)?.abort()
      const run = await runner.cancel(runId, principal)
      const next = summaryOf(run, principal, summaries.get(runId)?.stepCount ?? 0)
      summaries.set(runId, next)
      return next
    },
  }
}
