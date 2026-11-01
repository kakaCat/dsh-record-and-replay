/**
 * Panel service: the port the HTTP/fetch layers and tests call.
 *
 * It owns the project whitelist (DSH workspaces + explicit roots + cwd),
 * delegates scanning to `scanner`, and enforces id/path validation before any
 * file is opened. Reading is side-effect free. M3 adds exactly two actions:
 * `startReplay` (delegated to an injected replay port; no driver lives here)
 * and `trashRecording` (a safe move into `.dsh/record-replay/trash/`, never a
 * delete). The index-only writes from M3-lite remain the only index changes.
 */
import { lstat, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'

import { mapWithConcurrency } from './concurrency.js'
import { PanelError, panelBadRequest, panelForbidden, panelNotFound } from './errors.js'
import { panelIndexWriter } from './index-writer.js'
import { paginate, type PanelPagination } from './pagination.js'
import {
  assertContained,
  assertSafeRecordingId,
  assertSafeRunId,
  canonicalDirectory,
  canonicalFile,
  recordingDir,
  recordingsDir,
  runDir,
  storeRoot,
  trashDir,
  trashEntryName,
} from './paths.js'
import { findRunVideo, listDirectories, scanActiveRecordings, scanProject, type ScannedProject } from './scanner.js'
import {
  PANEL_ALL_PROJECTS_ROOT,
  PANEL_PAGE_LIMIT_DEFAULT,
  PANEL_SCAN_CONCURRENCY,
  PANEL_SEARCH_LIMIT_DEFAULT,
  PANEL_SEARCH_LIMIT_MAX,
  type PanelActiveRecording,
  type PanelCapabilities,
  type PanelCategoryWriteResult,
  type PanelCrossProjectGroup,
  type PanelCrossProjectMatch,
  type PanelCrossProjectSearchResult,
  type PanelProject,
  type PanelProjectsPage,
  type PanelProjectStats,
  type PanelProjectSummary,
  type PanelRecordingControlResult,
  type PanelRecordingDetail,
  type PanelRecordingSummary,
  type PanelRecordingWriteResult,
  type PanelReplayStartResult,
  type PanelRunSummary,
  type PanelScenarioCreateResult,
  type PanelScenarioWriteResult,
  type PanelSearchResult,
  type PanelStats,
  type PanelStatsReport,
  type PanelSystemStats,
  type PanelTrashResult,
  type PanelVideoResult,
} from './types.js'
import {
  defaultPanelStatePath,
  defaultWorkspaceStorePath,
  dshHomeDirectory,
  explicitPanelRoots,
  isProjectCandidatePath,
  readDshWorkspaces,
  readPanelRecentRoots,
  writePanelRecentRoots,
  type PanelRecentRoot,
} from './workspaces.js'

export interface PanelServiceOptions {
  /** Extra whitelisted project roots (`--root`). */
  readonly roots?: readonly string[]
  /**
   * Directory treated as the current project. Defaults to `process.cwd()`;
   * `null` disables the current-directory candidate entirely (the DSH mount
   * does this: its process cwd is the app/profile directory, not a project).
   */
  readonly cwd?: string | null
  /** DSH workspace store. Defaults to `~/.dsh/storages/workspace.json`. */
  readonly workspaceStorePath?: string
  /** Panel-owned recent-root store. Defaults to `~/.dsh/record-replay-panel.json`. */
  readonly statePath?: string
  /** Set false in tests that must not read the real user store. */
  readonly dshWorkspaces?: boolean
  /** DSH home used to reject profile/config directories. Defaults to `$DSH_HOME` or `~/.dsh`. */
  readonly dshHome?: string
  /** User home used to reject the home directory as a project. Defaults to `os.homedir()`. */
  readonly home?: string
  /** Seed the recent-root list (tests); skips the state file until a write happens. */
  readonly recentRoots?: readonly PanelRecentRoot[]
  /**
   * Replay service. Present only when the panel host can drive a browser (the
   * DSH mount with `replay.enabled`); absent in the standalone `panel` command,
   * which answers `PANEL_REPLAY_UNAVAILABLE`.
   */
  readonly replay?: PanelReplayPort
  /**
   * Expose the trash action. Default false: the standalone `/panel/` command
   * stays read-only; only the DSH mount turns this on.
   */
  readonly trash?: boolean
  /**
   * Stop/discard port for active recordings. Present only on the DSH mount;
   * the standalone `panel` command stays read-only.
   */
  readonly control?: PanelRecordingControlPort
  /** Clock for trash entry names (tests). Defaults to `Date.now`. */
  readonly now?: () => number
}

/** What the panel asks the replay host to do. Root is already canonical. */
export interface PanelReplayRequest {
  readonly root: string
  readonly recordingId: string
  /** Replay input values keyed by stepId/secretRef; process-only, never persisted by the panel. */
  readonly values?: Readonly<Record<string, string>>
}

/**
 * Port implemented by the DSH plugin: start a background Run through the
 * workspace's ReplayPort and resolve as soon as the run record exists.
 */
export interface PanelReplayPort {
  startReplay(input: PanelReplayRequest): Promise<PanelReplayStartResult>
}

/** What the panel asks the host to do with an active recording. Root is canonical. */
export interface PanelRecordingControlRequest {
  readonly root: string
  readonly recordingId: string
}

/** Implemented by the DSH plugin: resolve the workspace runtime and close/cancel the writer. */
export interface PanelRecordingControlPort {
  stop(input: PanelRecordingControlRequest): Promise<PanelRecordingControlResult>
  discard(input: PanelRecordingControlRequest): Promise<PanelRecordingControlResult>
}

interface ProjectCandidate {
  root: string
  name: string
  lastOpenedAt?: string
  isCurrent: boolean
  source: number
  recordingCount: number
}

const MAX_RECENT_ROOTS = 20

const VIDEO_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
}

export function videoContentType(fileName: string): string {
  return VIDEO_CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream'
}

function projectNameFromRoot(root: string): string {
  const base = path.basename(root)
  return base.length > 0 ? base : root
}

function isoOrUndefined(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString()
}

/**
 * Match one project against a lower-cased search needle.
 *
 * The same rules back the single-project and cross-project search, so a term
 * behaves identically in either mode: recording title/id/intent, category and
 * scenario names, then Run status/code/message. When the recording itself
 * matches, all of its runs are attached; when only runs match, just those.
 */
function matchProjectRecordings(scanned: ScannedProject, needle: string): PanelCrossProjectMatch[] {
  const categories = new Map(scanned.project.categories.map((category) => [category.id, category.name]))
  const scenarios = new Map(scanned.project.scenarios.map((scenario) => [scenario.id, scenario.name]))
  const matches: PanelCrossProjectMatch[] = []

  for (const recording of scanned.project.recordings) {
    const allRuns = scanned.runsByRecording.get(recording.recordingId) ?? []
    const categoryName = categories.get(recording.categoryId)
    const scenarioName = recording.scenarioId === undefined
      ? undefined
      : scenarios.get(recording.scenarioId)
    const recordingMatches = recording.title.toLowerCase().includes(needle)
      || recording.recordingId.toLowerCase().includes(needle)
      || (recording.intent?.toLowerCase().includes(needle) ?? false)
      || (categoryName?.toLowerCase().includes(needle) ?? false)
      || (scenarioName?.toLowerCase().includes(needle) ?? false)
    const matchingRuns = allRuns.filter((run) =>
      run.status.toLowerCase().includes(needle)
      || (run.errorCode?.toLowerCase().includes(needle) ?? false)
      || (run.errorMessage?.toLowerCase().includes(needle) ?? false))
    if (!recordingMatches && matchingRuns.length === 0) continue

    const matchedRuns = recordingMatches ? allRuns : matchingRuns
    matches.push({
      recording,
      matchKind: recordingMatches ? 'recording' : 'run',
      matchedRuns,
      ...(categoryName === undefined ? {} : { categoryName }),
      ...(scenarioName === undefined ? {} : { scenarioName }),
    })
  }
  return matches
}

function addStats(target: PanelSystemStats, stats: PanelStats): PanelSystemStats {
  return {
    projects: target.projects,
    recordings: target.recordings + stats.recordings,
    runs: target.runs + stats.runs,
    failedRuns: target.failedRuns + stats.failedRuns,
    cancelledRuns: target.cancelledRuns + stats.cancelledRuns,
    failureRate: 0,
    videoFiles: target.videoFiles + stats.videoFiles,
    videoBytes: target.videoBytes + stats.videoBytes,
    steps: target.steps + stats.steps,
  }
}

function emptySystemStats(projects: number): PanelSystemStats {
  return {
    projects,
    recordings: 0,
    runs: 0,
    failedRuns: 0,
    cancelledRuns: 0,
    failureRate: 0,
    videoFiles: 0,
    videoBytes: 0,
    steps: 0,
  }
}

const MAX_REPLAY_VALUES = 100
const MAX_REPLAY_VALUE_LENGTH = 10_000

/** Validate the untrusted `values` map; strings only, bounded in count and size. */
export function parseReplayValues(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw panelBadRequest('PANEL_INVALID_BODY', 'values must be an object mapping stepId/secretRef to a string')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_REPLAY_VALUES) {
    throw panelBadRequest('PANEL_INVALID_BODY', `values must contain at most ${String(MAX_REPLAY_VALUES)} entries`)
  }
  const parsed: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > 200) {
      throw panelBadRequest('PANEL_INVALID_BODY', 'values keys must be 1-200 characters')
    }
    if (typeof item !== 'string') {
      throw panelBadRequest('PANEL_INVALID_BODY', 'values must map to strings')
    }
    if (item.length > MAX_REPLAY_VALUE_LENGTH) {
      throw panelBadRequest('PANEL_INVALID_BODY', `values entries must be at most ${String(MAX_REPLAY_VALUE_LENGTH)} characters`)
    }
    parsed[key] = item
  }
  return parsed
}

/** Map an upstream replay failure to a stable panel error that keeps its code. */
function replayFailure(error: unknown): PanelError {
  if (error instanceof PanelError) return error
  const upstream = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  const detail = typeof upstream === 'string' ? `${upstream}: ${message}` : message
  return new PanelError('PANEL_REPLAY_FAILED', `replay could not start: ${detail}`, 409, { cause: error })
}

function bodyRecord(body: unknown): Readonly<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw panelBadRequest('PANEL_INVALID_BODY', 'request body must be a JSON object')
  }
  return body as Readonly<Record<string, unknown>>
}

export class PanelService {
  private readonly explicitRoots: readonly string[]
  private readonly cwd: string | undefined
  private readonly workspaceStorePath: string
  private readonly statePath: string
  private readonly dshHome: string
  private readonly home: string
  private readonly readDshStore: boolean
  private readonly recentRootsSeed: readonly PanelRecentRoot[] | undefined
  private readonly replayPort: PanelReplayPort | undefined
  private readonly controlPort: PanelRecordingControlPort | undefined
  private readonly trashEnabled: boolean
  private readonly now: () => number
  /** Loaded lazily so a read-only panel never creates the state file. */
  private recentRoots: PanelRecentRoot[] | undefined

  constructor(options: PanelServiceOptions = {}) {
    this.explicitRoots = [...(options.roots ?? []), ...explicitPanelRoots()]
    this.cwd = options.cwd === null ? undefined : options.cwd ?? process.cwd()
    this.workspaceStorePath = options.workspaceStorePath ?? defaultWorkspaceStorePath()
    this.statePath = options.statePath ?? defaultPanelStatePath()
    this.dshHome = options.dshHome ?? dshHomeDirectory()
    this.home = options.home ?? homedir()
    this.readDshStore = options.dshWorkspaces ?? true
    this.recentRootsSeed = options.recentRoots
    this.replayPort = options.replay
    this.controlPort = options.control
    this.trashEnabled = options.trash ?? false
    this.now = options.now ?? (() => Date.now())
    if (this.recentRootsSeed !== undefined) this.recentRoots = [...this.recentRootsSeed]
  }

  private async directoryMtime(root: string): Promise<string | undefined> {
    try {
      return isoOrUndefined((await stat(root)).mtimeMs)
    } catch {
      return undefined
    }
  }

  private async knownRecentRoots(): Promise<PanelRecentRoot[]> {
    if (this.recentRoots === undefined) {
      this.recentRoots = await readPanelRecentRoots(this.statePath)
    }
    return this.recentRoots
  }

  /** Count recording directories only; never parses manifests. */
  private async countRecordingDirs(root: string): Promise<number> {
    return (await listDirectories(recordingsDir(root))).length
  }

  /**
   * Collect every whitelist candidate once.
   *
   * `withCounts` adds one cheap `readdir` per project for the selector; the
   * request-path whitelist check deliberately skips it.
   */
  private async collectCandidates(withCounts: boolean): Promise<ProjectCandidate[]> {
    const candidates = new Map<string, ProjectCandidate>()

    const remember = async (
      input: string,
      name: string,
      lastOpenedAt: string | undefined,
      isCurrent: boolean,
      source: number,
    ): Promise<void> => {
      const canonical = await canonicalDirectory(input)
      if (canonical === undefined) return
      const existing = candidates.get(canonical)
      if (existing === undefined) {
        candidates.set(canonical, {
          root: canonical,
          name,
          ...(lastOpenedAt === undefined ? {} : { lastOpenedAt }),
          isCurrent,
          source,
          recordingCount: 0,
        })
        return
      }
      if (existing.name === projectNameFromRoot(canonical) && name.length > 0) existing.name = name
      // Source precedence decides which timestamp is the better "last opened"
      // signal: explicit `--root` mtime < DSH workspace updatedAt < picker
      // openedAt (the user just acted on it).
      if (lastOpenedAt !== undefined && (existing.lastOpenedAt === undefined || source > existing.source)) {
        existing.lastOpenedAt = lastOpenedAt
      }
      if (isCurrent) existing.isCurrent = true
      existing.source = Math.min(existing.source, source)
    }

    if (this.cwd !== undefined && isProjectCandidatePath(this.cwd, this.dshHome, this.home)) {
      await remember(this.cwd, projectNameFromRoot(path.resolve(this.cwd)), undefined, true, 0)
    }

    let source = 1
    for (const root of this.explicitRoots) {
      const resolved = path.resolve(root)
      const mtime = await this.directoryMtime(resolved)
      await remember(resolved, projectNameFromRoot(resolved), mtime, false, source)
      source += 1
    }

    // Directories the user opened through the picker; newest first.
    let recentSource = 2000
    for (const recent of await this.knownRecentRoots()) {
      const name = projectNameFromRoot(path.resolve(recent.path))
      await remember(recent.path, name, recent.openedAt, false, recentSource)
      recentSource += 1
    }

    if (this.readDshStore) {
      let workspaceSource = 1000
      for (const workspace of await readDshWorkspaces(this.workspaceStorePath)) {
        await remember(workspace.path, workspace.title, workspace.updatedAt, false, workspaceSource)
        workspaceSource += 1
      }
    }

    const entries = [...candidates.values()]
    if (withCounts) {
      await Promise.all(entries.map(async (candidate) => {
        candidate.recordingCount = await this.countRecordingDirs(candidate.root)
      }))
    }
    return entries.sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1
      const leftTime = left.lastOpenedAt ?? ''
      const rightTime = right.lastOpenedAt ?? ''
      if (leftTime !== rightTime) return rightTime.localeCompare(leftTime)
      if (left.source !== right.source) return left.source - right.source
      return left.name.localeCompare(right.name)
    })
  }

  /** All whitelisted projects, current directory first, then most recent. */
  async listProjects(): Promise<PanelProjectSummary[]> {
    return (await this.collectCandidates(true)).map((candidate) => ({
      root: candidate.root,
      name: candidate.name,
      ...(candidate.lastOpenedAt === undefined ? {} : { lastOpenedAt: candidate.lastOpenedAt }),
      ...(candidate.isCurrent ? { isCurrent: true } : {}),
      recordingCount: candidate.recordingCount,
    }))
  }

  /** One page of the project selector list (M2). */
  async listProjectsPage(pagination: PanelPagination): Promise<PanelProjectsPage> {
    const { items, page } = paginate(await this.listProjects(), pagination)
    return { projects: items, page }
  }

  /**
   * Register a directory the user picked explicitly.
   *
   * This only widens the panel whitelist and remembers the root; it never
   * creates or modifies anything inside the directory. The state file write is
   * best-effort: the root still works for this process when it fails.
   */
  async registerRoot(requested: string | undefined | null): Promise<PanelProjectSummary> {
    if (requested === undefined || requested === null || requested.trim().length === 0) {
      throw panelBadRequest('PANEL_ROOT_REQUIRED', 'root must be a directory path')
    }
    const canonical = await canonicalDirectory(requested)
    if (canonical === undefined) {
      throw panelNotFound('PANEL_ROOT_NOT_FOUND', 'folder does not exist or is not a directory')
    }
    const openedAt = new Date().toISOString()
    const roots = await this.knownRecentRoots()
    const next = [{ path: canonical, openedAt }, ...roots.filter((entry) => entry.path !== canonical)]
      .slice(0, MAX_RECENT_ROOTS)
    this.recentRoots = next
    try {
      await writePanelRecentRoots(next, this.statePath)
    } catch {
      // Keep the in-memory list; the picker still works for this process.
    }
    const name = (await this.collectCandidates(false))
      .find((candidate) => candidate.root === canonical)?.name ?? projectNameFromRoot(canonical)
    return {
      root: canonical,
      name,
      lastOpenedAt: openedAt,
      recordingCount: await this.countRecordingDirs(canonical),
    }
  }

  /** Resolve a request root against the whitelist (symlink-resolved, exact match). */
  async resolveRoot(requested: string | undefined | null): Promise<string> {
    if (requested === undefined || requested === null || requested.trim().length === 0) {
      throw panelBadRequest('PANEL_ROOT_REQUIRED', 'root query parameter is required')
    }
    const canonical = await canonicalDirectory(requested)
    if (canonical === undefined) {
      throw panelNotFound('PANEL_ROOT_NOT_FOUND', 'project root does not exist or is not a directory')
    }
    const projects = await this.collectCandidates(false)
    if (!projects.some((project) => project.root === canonical)) {
      throw panelForbidden(
        'PANEL_ROOT_DENIED',
        'project root is not a DSH workspace or an explicitly allowed directory',
      )
    }
    return canonical
  }

  private async projectName(root: string): Promise<string> {
    const projects = await this.collectCandidates(false)
    return projects.find((project) => project.root === root)?.name ?? projectNameFromRoot(root)
  }

  /**
   * Scan one project. Categories, scenarios and stats always cover the whole
   * project; only the recording list is paginated (`limit`/`offset`).
   */
  async getProject(
    requestedRoot: string | undefined | null,
    pagination: PanelPagination = { limit: PANEL_PAGE_LIMIT_DEFAULT, offset: 0 },
  ): Promise<PanelProject> {
    const root = await this.resolveRoot(requestedRoot)
    const name = await this.projectName(root)
    const scanned = await scanProject(root, { name })
    const { items, page } = paginate(scanned.project.recordings, pagination)
    return {
      ...scanned.project,
      recordings: items,
      recordingsTotal: scanned.project.recordings.length,
      recordingsPage: page,
    }
  }

  private async scanFor(root: string): Promise<{ root: string; name: string; scanned: ScannedProject }> {
    const name = await this.projectName(root)
    return { root, name, scanned: await scanProject(root, { name }) }
  }

  async getRecording(
    requestedRoot: string | undefined | null,
    recordingId: string | undefined | null,
  ): Promise<PanelRecordingDetail> {
    const safeId = assertSafeRecordingId(recordingId)
    const root = await this.resolveRoot(requestedRoot)
    const { scanned } = await this.scanFor(root)
    const recording = scanned.project.recordings.find((item) => item.recordingId === safeId)
    if (recording === undefined) {
      throw panelNotFound('PANEL_RECORDING_NOT_FOUND', `recording ${safeId} was not found in this project`)
    }
    return {
      recording,
      runs: scanned.runsByRecording.get(safeId) ?? [],
    }
  }

  async search(requestedRoot: string | undefined | null, query: string | undefined | null): Promise<PanelSearchResult> {
    if (query === undefined || query === null || query.trim().length === 0) {
      throw panelBadRequest('PANEL_SEARCH_REQUIRED', 'q query parameter must not be empty')
    }
    const root = await this.resolveRoot(requestedRoot)
    const { scanned } = await this.scanFor(root)
    const needle = query.trim().toLowerCase()
    const projectMatches = matchProjectRecordings(scanned, needle)
    const recordings: PanelRecordingSummary[] = projectMatches.map((match) => match.recording)
    const runs: PanelRunSummary[] = projectMatches.flatMap((match) => [...match.matchedRuns])
    const matches: Record<string, { readonly kind: 'recording' | 'run' }> = {}
    for (const match of projectMatches) {
      matches[match.recording.recordingId] = { kind: match.matchKind }
    }
    return { query, recordings, runs, matches }
  }

  /**
   * Cross-project search (M2).
   *
   * `root` may be omitted/empty or the `*` sentinel to search every
   * whitelisted project. Projects are scanned with a bounded concurrency
   * (`PANEL_SCAN_CONCURRENCY`) so a large workspace list cannot open an
   * unbounded number of files. Results are grouped by project in selector
   * order and capped at `limit` recordings overall (default 100, max 500).
   */
  async searchAll(
    query: string | undefined | null,
    options: { readonly root?: string | undefined | null; readonly limit?: number } = {},
  ): Promise<PanelCrossProjectSearchResult> {
    const trimmed = query?.trim() ?? ''
    if (trimmed.length === 0) {
      throw panelBadRequest('PANEL_SEARCH_REQUIRED', 'q query parameter must not be empty')
    }
    const limit = options.limit ?? PANEL_SEARCH_LIMIT_DEFAULT
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PANEL_SEARCH_LIMIT_MAX) {
      throw panelBadRequest(
        'PANEL_INVALID_LIMIT',
        `limit must be an integer between 1 and ${String(PANEL_SEARCH_LIMIT_MAX)}`,
      )
    }

    const requestedRoot = options.root
    const searchAllProjects = requestedRoot === undefined
      || requestedRoot === null
      || requestedRoot.trim().length === 0
      || requestedRoot === PANEL_ALL_PROJECTS_ROOT
    let targets: { root: string; name: string }[]
    if (searchAllProjects) {
      targets = (await this.collectCandidates(false)).map((candidate) => ({
        root: candidate.root,
        name: candidate.name,
      }))
    } else {
      const root = await this.resolveRoot(requestedRoot)
      targets = [{ root, name: await this.projectName(root) }]
    }

    const needle = trimmed.toLowerCase()
    const scans = await mapWithConcurrency(targets, PANEL_SCAN_CONCURRENCY, async (target) => ({
      target,
      scanned: await scanProject(target.root, { name: target.name }),
    }))

    const groups: PanelCrossProjectGroup[] = []
    let total = 0
    for (const { target, scanned } of scans) {
      const matches = matchProjectRecordings(scanned, needle)
      if (matches.length === 0) continue
      total += matches.length
      groups.push({
        projectRoot: target.root,
        projectName: target.name,
        matches,
      })
    }

    let remaining = limit
    const limitedGroups: PanelCrossProjectGroup[] = []
    let returned = 0
    for (const group of groups) {
      if (remaining <= 0) break
      const slice = group.matches.slice(0, remaining)
      limitedGroups.push({ ...group, matches: slice })
      returned += slice.length
      remaining -= slice.length
    }

    return {
      query: trimmed,
      groups: limitedGroups,
      total,
      returned,
      limit,
      truncated: total > returned,
    }
  }

  /**
   * System-wide statistics (M2): one scan per project, bounded concurrency,
   * aggregated from the same scan output the panel already renders. No extra
   * file walks and no video probing beyond the normal scanner.
   */
  async getStatsReport(): Promise<PanelStatsReport> {
    const candidates = await this.collectCandidates(false)
    const scans = await mapWithConcurrency(candidates, PANEL_SCAN_CONCURRENCY, async (candidate) => ({
      candidate,
      project: (await scanProject(candidate.root, { name: candidate.name })).project,
    }))

    const projects: PanelProjectStats[] = scans.map(({ candidate, project }) => ({
      root: candidate.root,
      name: candidate.name,
      stats: project.stats,
    }))
    let system = emptySystemStats(projects.length)
    for (const project of projects) system = addStats(system, project.stats)
    if (system.runs > 0) system = { ...system, failureRate: system.failedRuns / system.runs }
    return { system, projects }
  }

  /** Resolve a run's video inside its run directory, with symlink containment. */
  async getVideo(
    runId: string | undefined | null,
    requestedRoot?: string | undefined | null,
  ): Promise<PanelVideoResult> {
    const safeRunId = assertSafeRunId(runId)
    const roots = requestedRoot === undefined || requestedRoot === null || requestedRoot === ''
      ? (await this.collectCandidates(false)).map((project) => project.root)
      : [await this.resolveRoot(requestedRoot)]

    for (const root of roots) {
      const lookup = await findRunVideo(root, safeRunId)
      if (lookup === undefined) continue
      const canonicalRunDir = await canonicalDirectory(
        runDir(root, lookup.recordingId, safeRunId),
      )
      if (canonicalRunDir === undefined) {
        throw panelNotFound('PANEL_VIDEO_NOT_FOUND', `run ${safeRunId} has no readable video directory`)
      }
      const canonicalRecordingsDir = await canonicalDirectory(recordingsDir(root))
      if (canonicalRecordingsDir === undefined) {
        throw panelNotFound('PANEL_VIDEO_NOT_FOUND', `project ${root} has no readable recordings directory`)
      }
      assertContained(canonicalRecordingsDir, canonicalRunDir, 'run directory')
      const canonical = await canonicalFile(lookup.video.filePath)
      if (canonical === undefined) {
        throw panelNotFound('PANEL_VIDEO_NOT_FOUND', `run ${safeRunId} has no readable video file`)
      }
      assertContained(canonicalRunDir, canonical, 'video file')
      const extension = path.extname(lookup.video.fileName).toLowerCase()
      return {
        runId: safeRunId,
        recordingId: lookup.recordingId,
        filePath: canonical,
        contentType: videoContentType(lookup.video.fileName),
        size: lookup.video.bytes,
        fileName: lookup.video.fileName,
        downloadName: `${lookup.recordingId}-${safeRunId}${extension}`,
      }
    }
    throw panelNotFound('PANEL_VIDEO_NOT_FOUND', `no video was found for run ${safeRunId}`)
  }

  // -------------------------------------------------------------------------
  // M3 actions: replay + safe delete (move to trash)
  // -------------------------------------------------------------------------

  /** What this panel process can do; the client uses it to enable/disable actions. */
  capabilities(): PanelCapabilities {
    return {
      replay: this.replayPort !== undefined,
      trash: this.trashEnabled,
      ...(this.controlPort === undefined ? {} : { control: true }),
    }
  }

  /**
   * Every recording currently in `recording` status. With a root (the live HUD
   * passes the mounted session's workspace) only that project is scanned, so a
   * one-second poll does not walk every whitelisted project.
   */
  async listActiveRecordings(requestedRoot?: string | null): Promise<readonly PanelActiveRecording[]> {
    if (requestedRoot !== undefined && requestedRoot !== null && requestedRoot.trim().length > 0) {
      const root = await this.resolveRoot(requestedRoot)
      const projectName = projectNameFromRoot(root)
      const active = await scanActiveRecordings(root)
      return active.map(recording => ({ root, projectName, ...recording }))
    }
    const projects = await this.collectCandidates(false)
    const active: PanelActiveRecording[] = []
    for (const project of projects) {
      for (const recording of await scanActiveRecordings(project.root)) {
        active.push({
          root: project.root,
          projectName: project.name,
          ...recording,
        })
      }
    }
    return active.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** Stop one active recording; the port derives the owner session from the manifest. */
  async stopRecording(
    requestedRoot: string | undefined | null,
    body: unknown,
  ): Promise<PanelRecordingControlResult> {
    return await this.controlRecording('stop', requestedRoot, body)
  }

  /** Discard one active recording (kept on disk as `cancelled`). */
  async discardRecording(
    requestedRoot: string | undefined | null,
    body: unknown,
  ): Promise<PanelRecordingControlResult> {
    return await this.controlRecording('discard', requestedRoot, body)
  }

  private async controlRecording(
    action: 'stop' | 'discard',
    requestedRoot: string | undefined | null,
    body: unknown,
  ): Promise<PanelRecordingControlResult> {
    if (this.controlPort === undefined) {
      throw new PanelError(
        'PANEL_CONTROL_UNAVAILABLE',
        'this panel process has no recording control service; open the panel inside DSH to stop or discard a recording',
        503,
      )
    }
    const input = bodyRecord(body)
    const recordingId = assertSafeRecordingId(input['recordingId'])
    const root = await this.resolveRoot(requestedRoot)

    const target = recordingDir(root, recordingId)
    const info = await lstat(target).catch(() => undefined)
    if (info === undefined) {
      throw panelNotFound('PANEL_RECORDING_NOT_FOUND', `recording ${recordingId} was not found in this project`)
    }
    if (info.isSymbolicLink()) {
      throw panelForbidden('PANEL_ROOT_DENIED', 'recording directory must be a real directory, not a symlink')
    }
    if (!info.isDirectory()) {
      throw panelNotFound('PANEL_RECORDING_NOT_FOUND', `recording ${recordingId} is not a directory`)
    }
    const canonicalRecordings = await canonicalDirectory(recordingsDir(root))
    const canonicalRecording = await canonicalDirectory(target)
    if (canonicalRecordings === undefined || canonicalRecording === undefined) {
      throw panelNotFound('PANEL_RECORDING_NOT_FOUND', `recording ${recordingId} was not found in this project`)
    }
    assertContained(canonicalRecordings, canonicalRecording, 'recording directory')

    try {
      return action === 'stop'
        ? await this.controlPort.stop({ root, recordingId })
        : await this.controlPort.discard({ root, recordingId })
    } catch (error) {
      throw new PanelError(
        'PANEL_CONTROL_FAILED',
        `recording ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
        409,
        { cause: error },
      )
    }
  }

  /**
   * Start a replay of one recording through the injected replay port.
   *
   * The port starts the Run through the same `SemanticReplayRunner` the CLI
   * and `cua_replay_start` use, so the new `run.json`, `steps.jsonl` and
   * `video/` land under the recording's own `runs/<runId>/` (exactly like a
   * CLI replay). The service resolves as soon as the run record exists; the
   * client polls `GET /recording` for progress and the final video.
   *
   * `launch: isolated` is the plugin port's fixed default: the panel never
   * takes over the user's current browser window.
   */
  async startReplay(
    requestedRoot: string | undefined | null,
    body: unknown,
  ): Promise<PanelReplayStartResult> {
    if (this.replayPort === undefined) {
      throw new PanelError(
        'PANEL_REPLAY_UNAVAILABLE',
        'this panel process has no replay service; open the panel inside DSH to replay recordings',
        503,
      )
    }
    const input = bodyRecord(body)
    const recordingId = assertSafeRecordingId(input['recordingId'])
    const values = parseReplayValues(input['values'])
    const root = await this.resolveRoot(requestedRoot)

    const canonicalRecordings = await canonicalDirectory(recordingsDir(root))
    const canonicalRecording = await canonicalDirectory(recordingDir(root, recordingId))
    if (canonicalRecordings === undefined || canonicalRecording === undefined) {
      throw panelNotFound('PANEL_RECORDING_NOT_FOUND', `recording ${recordingId} was not found in this project`)
    }
    assertContained(canonicalRecordings, canonicalRecording, 'recording directory')

    let started: PanelReplayStartResult
    try {
      started = await this.replayPort.startReplay({
        root,
        recordingId,
        ...(values === undefined ? {} : { values }),
      })
    } catch (error) {
      throw replayFailure(error)
    }
    const runId = started.runId
    if (typeof runId !== 'string' || runId.trim().length === 0) {
      throw new PanelError('PANEL_REPLAY_FAILED', 'the replay service returned no runId', 500)
    }
    return { runId }
  }

  /**
   * Move one recording directory into `<root>/.dsh/record-replay/trash/`.
   *
   * Safety properties:
   *   - never deletes: one atomic `rename` moves the whole directory, so the
   *     manifest, steps, runs and assets stay byte-identical;
   *   - refuses symlinked recording directories (`PANEL_ROOT_DENIED`) and any
   *     target that realpath-resolves outside `recordings/`;
   *   - the trash entry is `<recordingId>-<compact UTC stamp>`, with numeric
   *     suffixes on collision, so two requests can never overwrite each other;
   *   - the recording's index assignment is removed in the same request. If
   *     that index write fails, the directory is moved back so the request
   *     leaves no half-applied state.
   */
  async trashRecording(
    requestedRoot: string | undefined | null,
    body: unknown,
  ): Promise<PanelTrashResult> {
    const input = bodyRecord(body)
    const recordingId = assertSafeRecordingId(input['recordingId'])
    const root = await this.resolveRoot(requestedRoot)

    const target = recordingDir(root, recordingId)
    const info = await lstat(target).catch(() => undefined)
    if (info === undefined) {
      throw panelNotFound('PANEL_RECORDING_NOT_FOUND', `recording ${recordingId} was not found in this project`)
    }
    if (info.isSymbolicLink()) {
      throw panelForbidden('PANEL_ROOT_DENIED', 'recording directory must be a real directory, not a symlink')
    }
    if (!info.isDirectory()) {
      throw panelNotFound('PANEL_RECORDING_NOT_FOUND', `recording ${recordingId} is not a directory`)
    }

    const canonicalRecordings = await canonicalDirectory(recordingsDir(root))
    const canonicalRecording = await canonicalDirectory(target)
    if (canonicalRecordings === undefined || canonicalRecording === undefined) {
      throw panelNotFound('PANEL_RECORDING_NOT_FOUND', `recording ${recordingId} was not found in this project`)
    }
    assertContained(canonicalRecordings, canonicalRecording, 'recording directory')

    const now = this.now()
    const movedAt = new Date(now).toISOString()
    const { entry, destination } = await this.moveRecordingToTrash(root, target, recordingId, now)

    let indexCleaned = false
    try {
      const result = await panelIndexWriter.removeRecordingAssignment(root, recordingId)
      indexCleaned = result.removed
    } catch (error) {
      let rolledBack = false
      try {
        await rename(destination, target)
        rolledBack = true
      } catch {
        rolledBack = false
      }
      if (!rolledBack) {
        throw new PanelError(
          'PANEL_TRASH_FAILED',
          'recording was moved to trash but index.json could not be updated and the move could not be rolled back',
          500,
          { cause: error },
        )
      }
      throw error instanceof PanelError
        ? error
        : new PanelError(
            'PANEL_WRITE_FAILED',
            `index.json could not be cleaned up: ${error instanceof Error ? error.message : String(error)}`,
            500,
            { cause: error },
          )
    }

    return {
      recordingId,
      trashPath: `trash/${entry}`,
      movedAt,
      indexCleaned,
    }
  }

  /** Create `trash/` and atomically move one recording directory into it. */
  private async moveRecordingToTrash(
    root: string,
    target: string,
    recordingId: string,
    now: number,
  ): Promise<{ readonly entry: string; readonly destination: string }> {
    const trashRoot = trashDir(root)
    try {
      await mkdir(trashRoot, { recursive: true, mode: 0o700 })
      const canonicalStore = await canonicalDirectory(storeRoot(root))
      const canonicalTrash = await canonicalDirectory(trashRoot)
      if (canonicalStore === undefined || canonicalTrash === undefined) {
        throw new Error('trash directory is not accessible')
      }
      assertContained(canonicalStore, canonicalTrash, 'trash directory')
      const picked = await this.uniqueTrashEntry(trashRoot, recordingId, now)
      await rename(target, picked.path)
      return { entry: picked.entry, destination: picked.path }
    } catch (error) {
      if (error instanceof PanelError) throw error
      throw new PanelError(
        'PANEL_TRASH_FAILED',
        `recording could not be moved to the trash: ${error instanceof Error ? error.message : String(error)}`,
        500,
        { cause: error },
      )
    }
  }

  /** First free `<recordingId>-<stamp>[-n]` entry under the trash directory. */
  private async uniqueTrashEntry(
    root: string,
    recordingId: string,
    now: number,
  ): Promise<{ readonly entry: string; readonly path: string }> {
    const base = trashEntryName(recordingId, now)
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const entry = attempt === 0 ? base : `${base}-${String(attempt + 1)}`
      const candidate = path.join(root, entry)
      const exists = await lstat(candidate).then(() => true, () => false)
      if (!exists) return { entry, path: candidate }
    }
    throw new PanelError('PANEL_TRASH_FAILED', 'no free trash entry name could be allocated', 500)
  }

  // -------------------------------------------------------------------------
  // M3-lite writes: rename and 未分组收纳. Only index.json is written.
  // -------------------------------------------------------------------------

  /** Rename a category. `body` is the untrusted JSON payload. */
  async updateCategory(
    requestedRoot: string | undefined | null,
    body: unknown,
  ): Promise<PanelCategoryWriteResult> {
    const root = await this.resolveRoot(requestedRoot)
    return await panelIndexWriter.updateCategory(root, body)
  }

  /** Rename a scenario. */
  async updateScenario(
    requestedRoot: string | undefined | null,
    body: unknown,
  ): Promise<PanelScenarioWriteResult> {
    const root = await this.resolveRoot(requestedRoot)
    return await panelIndexWriter.updateScenario(root, body)
  }

  /** Create a scenario, optionally collecting the category's 未分组 recordings. */
  async createScenario(
    requestedRoot: string | undefined | null,
    body: unknown,
  ): Promise<PanelScenarioCreateResult> {
    const root = await this.resolveRoot(requestedRoot)
    return await panelIndexWriter.createScenario(root, body)
  }

  /** Rename a recording in the index and/or move it between scenarios. */
  async updateRecording(
    requestedRoot: string | undefined | null,
    body: unknown,
  ): Promise<PanelRecordingWriteResult> {
    const root = await this.resolveRoot(requestedRoot)
    return await panelIndexWriter.updateRecording(root, body)
  }

  /** Number of recording directories in a project; used by the CLI banner and tests. */
  async countRecordings(root: string): Promise<number> {
    const canonical = await this.resolveRoot(root)
    return (await listDirectories(recordingsDir(canonical))).length
  }
}

export { PanelError }
