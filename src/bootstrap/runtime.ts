/**
 * Workspace runtime assembly shared by the DSH plugin and the standalone CLI.
 *
 * The plugin and `dsh-record-replay test` need exactly the same Store,
 * RecordingService, RunStore and ReplayPort wiring; keeping it here avoids two
 * assemblies drifting apart. Host-only concerns (tools, commands, skills) stay
 * in the plugin.
 */
import * as path from 'node:path'

import type { BrowserDriver } from '../driver/api.js'
import type { HostConfig } from '../host/config.js'
import type { ReplayPort, RunSummary } from '../host/index.js'
import { RecordingService } from '../recording/index.js'
import { createFsRecordingStore } from '../store/fs/jsonl-store.js'
import { recoverStore } from '../store/fs/recovery.js'
import type { RecordingStore } from '../store/api.js'
import { FsRunStore } from '../plugin/fs-run-store.js'
import { createPluginReplayPort } from '../plugin/replay-port.js'

/** Store + recording + run handles rooted at one workspace. */
export interface WorkspaceStoreRuntime {
  readonly workspaceRoot: string
  /** Absolute `.dsh/record-replay` root. */
  readonly storeRoot: string
  readonly store: RecordingStore
  readonly recordings: RecordingService
  readonly runStore: FsRunStore
  /** 启动恢复摘要；没有可读报告时为 undefined（恢复失败不阻断装配）。 */
  readonly recovery?: {
    readonly scannedRecordings: number
    readonly repairedRecordings: readonly string[]
    readonly issueCount: number
  }
}

export interface WorkspaceStoreRuntimeOptions {
  readonly workspaceRoot: string
  readonly config: HostConfig
}

export async function createWorkspaceStoreRuntime(
  options: WorkspaceStoreRuntimeOptions,
): Promise<WorkspaceStoreRuntime> {
  const { workspaceRoot, config } = options
  const storeRoot = path.resolve(workspaceRoot, config.recording.rootDir)
  const store = await createFsRecordingStore({
    root: storeRoot,
    maxSteps: config.recording.maxSteps,
    maxBytes: config.recording.maxBytes,
  })
  // 启动恢复：把崩溃遗留的 recording 收口为 interrupted、回收过期锁并修复坏尾。
  // 恢复失败不阻断装配（只读浏览与后续录制仍可用），但下一次启动会再次尝试。
  const recoveryReport = await recoverStore(storeRoot).catch(() => undefined)
  const recovery = recoveryReport === undefined
    ? undefined
    : {
        scannedRecordings: recoveryReport.scannedRecordings,
        repairedRecordings: recoveryReport.recordings
          .filter((report) => report.repaired)
          .map((report) => report.recordingId),
        issueCount: recoveryReport.issues.length,
      }
  const recordings = new RecordingService({
    store,
    maxSteps: config.recording.maxSteps,
    maxDurationSeconds: config.recording.maxDurationSeconds,
    deniedUrlPatterns: config.recording.privacy.deniedUrlPatterns,
  })
  const runStore = new FsRunStore({ root: storeRoot })
  return {
    workspaceRoot,
    storeRoot,
    store,
    recordings,
    runStore,
    ...(recovery === undefined ? {} : { recovery }),
  }
}

export interface WorkspaceReplayRuntimeOptions {
  readonly config: HostConfig
  readonly driver: BrowserDriver
  readonly store: RecordingStore
  readonly recordings: RecordingService
  readonly runStore: FsRunStore
  /** Called after a replay reaches a terminal state; failures are advisory. */
  readonly onRunTerminal?: (run: RunSummary) => void | Promise<void>
}

/**
 * Replay port with the workspace's video policy: `runs/<runId>/video/` under
 * the recording directory, format and retention from `config.replay`.
 */
export function createWorkspaceReplayRuntime(options: WorkspaceReplayRuntimeOptions): ReplayPort {
  const { config, driver, store, recordings, runStore } = options
  return createPluginReplayPort({
    driver,
    recordings,
    store,
    runStore,
    videoEnabled: config.replay.video,
    videoFormat: config.replay.videoFormat,
    videoMaxRuns: config.replay.videoMaxRuns,
    videoDirFor: (recordingId, runId) =>
      path.join(
        store.root,
        'recordings',
        String(recordingId),
        'runs',
        String(runId),
        'video',
      ),
    ...(options.onRunTerminal === undefined ? {} : { onRunTerminal: options.onRunTerminal }),
  })
}

export interface WorkspaceRuntime extends WorkspaceStoreRuntime {
  readonly replay: ReplayPort
}

export interface WorkspaceRuntimeOptions extends WorkspaceStoreRuntimeOptions {
  readonly driver: BrowserDriver
  readonly onRunTerminal?: (run: RunSummary) => void | Promise<void>
}

/** Store + replay assembly for callers that do not need the Host service. */
export async function createWorkspaceRuntime(
  options: WorkspaceRuntimeOptions,
): Promise<WorkspaceRuntime> {
  const core = await createWorkspaceStoreRuntime(options)
  const replay = createWorkspaceReplayRuntime({
    config: options.config,
    driver: options.driver,
    store: core.store,
    recordings: core.recordings,
    runStore: core.runStore,
    ...(options.onRunTerminal === undefined ? {} : { onRunTerminal: options.onRunTerminal }),
  })
  return { ...core, replay }
}
