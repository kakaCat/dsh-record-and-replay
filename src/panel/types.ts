/**
 * Global record/replay panel DTOs (design: docs/design/record-replay-panel.md).
 *
 * These types are shared by the host-side read-only service and the React
 * client. They describe persisted files only — no runtime driver objects,
 * no absolute paths (the panel always talks in project-relative terms).
 */

export const PANEL_INDEX_VERSION = 1 as const

/** Sentinel accepted by `GET /search` and the project selector: search every project. */
export const PANEL_ALL_PROJECTS_ROOT = '*' as const

/** Default and maximum page sizes for project/recording lists (M2). */
export const PANEL_PAGE_LIMIT_DEFAULT = 50
export const PANEL_PAGE_LIMIT_MAX = 200

/** Default and maximum number of recordings a cross-project search returns. */
export const PANEL_SEARCH_LIMIT_DEFAULT = 100
export const PANEL_SEARCH_LIMIT_MAX = 500

/** Maximum number of projects scanned in parallel by stats/cross-project search. */
export const PANEL_SCAN_CONCURRENCY = 4

/** One category of the project index. Categories are auto-derived from the recording site. */
export interface PanelIndexCategory {
  readonly id: string
  readonly name: string
  readonly site: string
}

/** One scenario (a named group of recordings inside a category). */
export interface PanelIndexScenario {
  readonly id: string
  readonly categoryId: string
  readonly name: string
}

export interface PanelIndexAssignment {
  /** Scenario the recording belongs to; optional when only an intent is annotated. */
  readonly scenarioId?: string
  /**
   * User requirement / use-case text, annotated without touching the recording.
   * Overrides the manifest's `intent` when both exist.
   */
  readonly intent?: string
  /**
   * Display title override, written by the panel's rename action.
   * Overrides the manifest's `title` when both exist; the manifest is never rewritten.
   */
  readonly title?: string
}

/** `.dsh/record-replay/index.json` model. */
export interface PanelIndex {
  readonly version: typeof PANEL_INDEX_VERSION
  readonly categories: readonly PanelIndexCategory[]
  readonly scenarios: readonly PanelIndexScenario[]
  readonly assignments: Readonly<Record<string, PanelIndexAssignment>>
}

/** Where the index used by this response came from. */
export type PanelIndexSource = 'loaded' | 'rebuilt'

export interface PanelIndexState {
  readonly index: PanelIndex
  readonly source: PanelIndexSource
  readonly warnings: readonly string[]
}

/** Common result of an index write (M3-lite). */
export interface PanelIndexWriteResult {
  /** `rebuilt` when the write first rebuilt a missing/salvaged index from recording sites. */
  readonly indexSource: PanelIndexSource
  readonly warnings: readonly string[]
}

export interface PanelCategoryWriteResult extends PanelIndexWriteResult {
  readonly category: PanelIndexCategory
}

export interface PanelScenarioWriteResult extends PanelIndexWriteResult {
  readonly scenario: PanelIndexScenario
}

export interface PanelScenarioCreateResult extends PanelScenarioWriteResult {
  /** Recordings moved out of 未分组 by `includeUngrouped`. */
  readonly assignedCount: number
}

export interface PanelRecordingWriteResult extends PanelIndexWriteResult {
  readonly recordingId: string
  /** Resulting index annotation; `{}` when the recording was moved back to 未分组. */
  readonly assignment: PanelIndexAssignment
}

export type PanelRecordingStatus = 'recording' | 'completed' | 'failed' | 'interrupted' | 'cancelled'

export type PanelRecordingEndReason = 'tool_stopped' | 'max_duration' | 'cancelled' | 'failed' | 'interrupted'

export type PanelRunStatus = 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled'

/** One project (workspace root) as shown in the top project selector. */
export interface PanelProjectSummary {
  readonly root: string
  readonly name: string
  readonly lastOpenedAt?: string
  /** True for the directory the panel server was started in. */
  readonly isCurrent?: boolean
  /**
   * Number of recording directories found under `.dsh/record-replay/recordings`.
   * Used by the client to prefer a project that actually has data; `0` is a
   * valid answer and absent means "not measured" (older callers).
   */
  readonly recordingCount?: number
}

export interface PanelRecordingSummary {
  readonly recordingId: string
  readonly title: string
  /** Where `title` came from: an index override or the recording manifest. */
  readonly titleSource?: 'manifest' | 'index'
  /** User requirement / use-case text (index annotation wins over the manifest). */
  readonly intent?: string
  /** Where `intent` came from; absent when no intent exists. */
  readonly intentSource?: 'manifest' | 'index'
  /** Site derived from the first navigate step (or manifest.site when present). */
  readonly site: string
  readonly categoryId: string
  /** Present only when the index assigns the recording to a scenario. */
  readonly scenarioId?: string
  readonly status: PanelRecordingStatus
  /** Why the recording ended; absent on older manifests. */
  readonly endReason?: PanelRecordingEndReason
  /** Steps suppressed by the recording URL policy; absent/0 when none. */
  readonly suppressedCount?: number
  readonly stepCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly runCount: number
  readonly failedRunCount: number
  readonly lastRunStatus?: PanelRunStatus
  readonly hasVideo: boolean
}

export interface PanelRunSummary {
  readonly runId: string
  readonly recordingId: string
  readonly status: PanelRunStatus
  readonly startedAt: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly failedStepId?: string
  /** Recording-relative POSIX path, for example `runs/<runId>/video/replay.webm`. */
  readonly videoPath?: string
  readonly videoBytes?: number
  readonly hasVideo: boolean
}

export interface PanelRecordingDetail {
  readonly recording: PanelRecordingSummary
  readonly runs: readonly PanelRunSummary[]
}

export interface PanelStats {
  readonly recordings: number
  readonly runs: number
  readonly failedRuns: number
  readonly cancelledRuns: number
  /** failedRuns / runs, 0 when there are no runs. */
  readonly failureRate: number
  readonly videoFiles: number
  readonly videoBytes: number
  readonly steps: number
}

/** Cursor-free page bookkeeping shared by the project and recording lists. */
export interface PanelPageMeta {
  readonly total: number
  readonly limit: number
  readonly offset: number
  readonly hasMore: boolean
}

export interface PanelProject {
  readonly root: string
  readonly name: string
  readonly indexSource: PanelIndexSource
  readonly warnings: readonly string[]
  readonly categories: readonly PanelIndexCategory[]
  readonly scenarios: readonly PanelIndexScenario[]
  /**
   * One page of recordings (default 50, `limit`/`offset` from the request).
   * Categories, scenarios and stats always describe the whole project.
   */
  readonly recordings: readonly PanelRecordingSummary[]
  /** Number of recordings in the project, independent of the current page. */
  readonly recordingsTotal?: number
  /** Present when the response was produced by a paginated request. */
  readonly recordingsPage?: PanelPageMeta
  readonly stats: PanelStats
}

export interface PanelProjectsPage {
  readonly projects: readonly PanelProjectSummary[]
  readonly page: PanelPageMeta
}

/** System-wide totals for the "全部项目" mode (M2). */
export interface PanelSystemStats {
  readonly projects: number
  readonly recordings: number
  readonly runs: number
  readonly failedRuns: number
  readonly cancelledRuns: number
  readonly failureRate: number
  readonly videoFiles: number
  readonly videoBytes: number
  readonly steps: number
}

export interface PanelProjectStats {
  readonly root: string
  readonly name: string
  readonly stats: PanelStats
}

/** Payload of `GET /stats`: system totals plus one row per project. */
export interface PanelStatsReport {
  readonly system: PanelSystemStats
  readonly projects: readonly PanelProjectStats[]
}

export interface PanelSearchMatch {
  /** Why the recording matched: its title/recordingId, or one of its runs. */
  readonly kind: 'recording' | 'run'
}

export interface PanelSearchResult {
  readonly query: string
  readonly recordings: readonly PanelRecordingSummary[]
  readonly runs: readonly PanelRunSummary[]
  readonly matches: Readonly<Record<string, PanelSearchMatch>>
}

/** One recording matched by a cross-project search, with its matching runs. */
export interface PanelCrossProjectMatch {
  readonly recording: PanelRecordingSummary
  /** The recording itself matched (title/id/intent/category/scenario), or only a run did. */
  readonly matchKind: 'recording' | 'run'
  /** Runs that contribute to the match; all runs when the recording itself matched. */
  readonly matchedRuns: readonly PanelRunSummary[]
  readonly categoryName?: string
  readonly scenarioName?: string
}

/** Search hits for one project; only groups with at least one match are returned. */
export interface PanelCrossProjectGroup {
  readonly projectRoot: string
  readonly projectName: string
  readonly matches: readonly PanelCrossProjectMatch[]
}

export interface PanelCrossProjectSearchResult {
  readonly query: string
  readonly groups: readonly PanelCrossProjectGroup[]
  /** Matches found before the limit was applied. */
  readonly total: number
  /** Matches actually returned (never above `limit`). */
  readonly returned: number
  readonly limit: number
  /** True when `total > returned`. */
  readonly truncated: boolean
}

export interface PanelVideoResult {
  readonly runId: string
  readonly recordingId: string
  readonly filePath: string
  readonly contentType: string
  readonly size: number
  readonly fileName: string
  readonly downloadName: string
}

/**
 * What the panel process can do beyond browsing (M3).
 *
 * The DSH mount wires a replay service backed by the host's Cua driver; the
 * standalone `panel` command has no driver connection, so it reports
 * `replay: false` and its client disables the button with an explanation.
 */
export interface PanelCapabilities {
  /** A replay service is wired into this panel process. */
  readonly replay: boolean
  /** The trash action is available (it only needs filesystem access). */
  readonly trash: boolean
  /** Stop/discard of an active recording is wired into this panel process. */
  readonly control?: boolean
}

/** One recording currently in `recording` status, as shown by the live HUD. */
export interface PanelActiveRecording {
  readonly root: string
  readonly projectName: string
  readonly recordingId: string
  readonly title: string
  readonly stepCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly suppressedCount?: number
}

/** Result of stopping or discarding an active recording through the panel. */
export interface PanelRecordingControlResult {
  readonly recordingId: string
  readonly status: PanelRecordingStatus
  readonly endReason?: PanelRecordingEndReason
}

/** Result of `POST /replay`: the run is already persisted; poll the recording for status. */
export interface PanelReplayStartResult {
  readonly runId: string
}

/**
 * Result of `POST /trash`.
 *
 * The recording directory is moved as a whole; its manifest, steps, runs and
 * assets are untouched. `trashPath` is project-relative (`trash/<name>`), so
 * the DTO never leaks an absolute host path.
 */
export interface PanelTrashResult {
  readonly recordingId: string
  /** POSIX path, relative to `.dsh/record-replay`, of the complete moved directory. */
  readonly trashPath: string
  readonly movedAt: string
  /** True when a stale index assignment was removed in the same request. */
  readonly indexCleaned: boolean
}

export type PanelErrorCode =
  | 'PANEL_ROOT_REQUIRED'
  | 'PANEL_ROOT_DENIED'
  | 'PANEL_ROOT_NOT_FOUND'
  | 'PANEL_INVALID_ID'
  | 'PANEL_INVALID_NAME'
  | 'PANEL_INVALID_BODY'
  | 'PANEL_RECORDING_NOT_FOUND'
  | 'PANEL_CATEGORY_NOT_FOUND'
  | 'PANEL_SCENARIO_NOT_FOUND'
  | 'PANEL_SCENARIO_MISMATCH'
  | 'PANEL_RUN_NOT_FOUND'
  | 'PANEL_VIDEO_NOT_FOUND'
  | 'PANEL_SEARCH_REQUIRED'
  | 'PANEL_INVALID_PAGINATION'
  | 'PANEL_INVALID_LIMIT'
  | 'PANEL_INDEX_CORRUPT'
  | 'PANEL_INDEX_UNREADABLE'
  | 'PANEL_WRITE_FAILED'
  | 'PANEL_TRASH_FAILED'
  | 'PANEL_REPLAY_UNAVAILABLE'
  | 'PANEL_REPLAY_FAILED'
  | 'PANEL_CONTROL_UNAVAILABLE'
  | 'PANEL_CONTROL_FAILED'
  | 'PANEL_METHOD_NOT_ALLOWED'
  | 'PANEL_NOT_FOUND'
  | 'PANEL_INTERNAL'
