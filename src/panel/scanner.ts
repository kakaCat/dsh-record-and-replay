/**
 * Read-only project scanner for the global record/replay panel.
 *
 * Source of truth is the on-disk layout shared with the plugin and the CLI:
 *   <root>/.dsh/record-replay/recordings/<recordingId>/manifest.json
 *   <root>/.dsh/record-replay/recordings/<recordingId>/runs/<runId>/run.json
 *   <root>/.dsh/record-replay/recordings/<recordingId>/runs/<runId>/video/*.webm|mp4
 *
 * A corrupt recording/run is skipped with a warning; it never blocks the rest
 * of the project. The scanner never writes to `.dsh/`.
 */
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { createInterface } from 'node:readline'

import type {
  PanelIndexCategory,
  PanelIndexScenario,
  PanelIndexSource,
  PanelProject,
  PanelRecordingEndReason,
  PanelRecordingStatus,
  PanelRecordingSummary,
  PanelRunStatus,
  PanelRunSummary,
  PanelStats,
} from './types.js'
import { assignmentFor, loadPanelIndex, type IndexedRecordingRef } from './index-store.js'
import { DEFAULT_LOCK_TTL_MS, isLockExpired, readLockRecord } from '../store/fs/lock.js'
import { lockPath } from '../store/fs/paths.js'
import {
  isRecordingId,
  isRunId,
  isSafeVideoFile,
  recordingsDir,
  runDir,
  siteFromTitle,
  siteFromUrl,
  storeRoot,
} from './paths.js'

const RECORDING_STATUSES: ReadonlySet<string> = new Set<PanelRecordingStatus>([
  'recording',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
])

const RECORDING_END_REASONS: ReadonlySet<string> = new Set<PanelRecordingEndReason>([
  'tool_stopped',
  'max_duration',
  'cancelled',
  'failed',
  'interrupted',
])

const RUN_STATUSES: ReadonlySet<string> = new Set<PanelRunStatus>([
  'preparing',
  'running',
  'completed',
  'failed',
  'cancelled',
])

export interface ScannedProject {
  readonly project: PanelProject
  readonly runsByRecording: ReadonlyMap<string, readonly PanelRunSummary[]>
}

interface ScannedRecording {
  readonly recordingId: string
  readonly title: string
  readonly intent?: string
  readonly site: string
  readonly status: PanelRecordingStatus
  readonly endReason?: PanelRecordingEndReason
  readonly suppressedCount?: number
  readonly stepCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly runCount: number
  readonly failedRunCount: number
  readonly lastRunStatus?: PanelRunStatus
  readonly hasVideo: boolean
}

interface ManifestShape {
  readonly recordingId: string
  readonly title: string
  readonly intent?: string
  readonly status: PanelRecordingStatus
  readonly endReason?: PanelRecordingEndReason
  readonly suppressedCount?: number
  readonly stepCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly site?: string
}

/** Lightweight active-recording shape: no runs, no videos, no index. */
export interface ActiveRecordingShape {
  readonly recordingId: string
  readonly title: string
  readonly stepCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly suppressedCount?: number
}

interface RunShape {
  readonly runId: string
  readonly recordingId: string
  readonly status: PanelRunStatus
  readonly startedAt: string
  readonly finishedAt?: string
  readonly currentStepId?: string
  readonly errorCode?: string
  readonly errorMessage?: string
}

export interface VideoFileInfo {
  readonly fileName: string
  readonly filePath: string
  readonly bytes: number
}

export interface RunVideoLookup {
  readonly recordingId: string
  readonly run: PanelRunSummary
  readonly video: VideoFileInfo
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

export async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function parseManifest(value: unknown, expectedId: string): ManifestShape | undefined {
  if (!isRecord(value)) return undefined
  if (value['recordingId'] !== expectedId) return undefined
  const title = stringField(value['title'])
  const status = stringField(value['status'])
  const stepCount = value['stepCount']
  const createdAt = stringField(value['createdAt'])
  const updatedAt = stringField(value['updatedAt'])
  if (
    title === undefined
    || status === undefined
    || !RECORDING_STATUSES.has(status)
    || typeof stepCount !== 'number'
    || !Number.isFinite(stepCount)
    || stepCount < 0
    || createdAt === undefined
    || updatedAt === undefined
  ) {
    return undefined
  }
  const site = stringField(value['site'])
  const intent = stringField(value['intent'])
  const endReason = stringField(value['endReason'])
  const suppressedCount = value['suppressedCount']
  return {
    recordingId: expectedId,
    title,
    ...(intent === undefined ? {} : { intent }),
    status: status as PanelRecordingStatus,
    ...(endReason === undefined || !RECORDING_END_REASONS.has(endReason)
      ? {}
      : { endReason: endReason as PanelRecordingEndReason }),
    ...(typeof suppressedCount === 'number' && Number.isInteger(suppressedCount) && suppressedCount > 0
      ? { suppressedCount }
      : {}),
    stepCount,
    createdAt,
    updatedAt,
    ...(site === undefined ? {} : { site }),
  }
}

function parseRun(value: unknown, recordingId: string, expectedId: string): RunShape | undefined {
  if (!isRecord(value)) return undefined
  if (value['runId'] !== expectedId || value['recordingId'] !== recordingId) return undefined
  const status = stringField(value['status'])
  const startedAt = stringField(value['startedAt'])
  if (status === undefined || !RUN_STATUSES.has(status) || startedAt === undefined) return undefined
  const finishedAt = stringField(value['finishedAt'])
  const currentStepId = stringField(value['currentStepId'])
  const error = isRecord(value['error']) ? value['error'] : undefined
  const errorCode = error === undefined ? undefined : stringField(error['code'])
  const errorMessage = error === undefined ? undefined : stringField(error['message'])
  return {
    runId: expectedId,
    recordingId,
    status: status as PanelRunStatus,
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(currentStepId === undefined ? {} : { currentStepId }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  }
}

/**
 * First URL the recording navigated to (or asserted), used to derive the site.
 * Only the head of steps.jsonl is read: recordings can have thousands of steps.
 */
export async function firstRecordingUrl(recordingPath: string): Promise<string | undefined> {
  const filePath = path.join(recordingPath, 'steps.jsonl')
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  let inspected = 0
  try {
    for await (const line of reader) {
      inspected += 1
      if (inspected > 200) break
      if (line.trim().length === 0) continue
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(event)) continue
      const action = isRecord(event['action']) ? event['action'] : undefined
      if (action === undefined) continue
      const directUrl = stringField(action['url'])
      if (directUrl !== undefined && siteFromUrl(directUrl) !== undefined) return directUrl
      const check = isRecord(action['check']) ? action['check'] : undefined
      if (check !== undefined && check['kind'] === 'url') {
        const contains = stringField(check['contains'])
        if (contains !== undefined && siteFromUrl(contains) !== undefined) return contains
      }
    }
  } catch {
    // Missing/unreadable steps.jsonl only means the site falls back to the title.
  } finally {
    reader.close()
    stream.destroy()
  }
  return undefined
}

function videoCandidates(names: readonly string[]): string[] {
  const preferred = (name: string): number =>
    name === 'replay.webm' ? 0 : name === 'replay.mp4' ? 1 : 2
  return names
    .filter((name) => isSafeVideoFile(name))
    .sort((left, right) => preferred(left) - preferred(right) || left.localeCompare(right))
}

/** Preferred video file inside `<runDir>/video`, if any. */
export async function findVideoFile(runPath: string): Promise<VideoFileInfo | undefined> {
  const videoDir = path.join(runPath, 'video')
  let names: string[]
  try {
    names = await readdir(videoDir)
  } catch {
    return undefined
  }
  for (const fileName of videoCandidates(names)) {
    const filePath = path.join(videoDir, fileName)
    try {
      const info = await stat(filePath)
      if (info.isFile()) return { fileName, filePath, bytes: info.size }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

async function scanRun(
  recordingId: string,
  runPath: string,
  runId: string,
): Promise<PanelRunSummary | undefined> {
  const parsed = parseRun(await readJson(path.join(runPath, 'run.json')), recordingId, runId)
  if (parsed === undefined) return undefined
  const video = await findVideoFile(runPath)
  const start = Date.parse(parsed.startedAt)
  const end = parsed.finishedAt === undefined ? Number.NaN : Date.parse(parsed.finishedAt)
  const durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined
  return {
    runId: parsed.runId,
    recordingId: parsed.recordingId,
    status: parsed.status,
    startedAt: parsed.startedAt,
    ...(parsed.finishedAt === undefined ? {} : { finishedAt: parsed.finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(parsed.errorCode === undefined ? {} : { errorCode: parsed.errorCode }),
    ...(parsed.errorMessage === undefined ? {} : { errorMessage: parsed.errorMessage }),
    ...(parsed.status === 'failed' && parsed.currentStepId !== undefined
      ? { failedStepId: parsed.currentStepId }
      : {}),
    ...(video === undefined
      ? {}
      : {
          videoPath: `runs/${parsed.runId}/video/${video.fileName}`,
          videoBytes: video.bytes,
        }),
    hasVideo: video !== undefined,
  }
}

async function scanRuns(
  projectRoot: string,
  recordingId: string,
): Promise<{ runs: PanelRunSummary[]; warnings: string[] }> {
  const runsDir = path.join(recordingsDir(projectRoot), recordingId, 'runs')
  const entries = await listDirectories(runsDir)
  const runs: PanelRunSummary[] = []
  const warnings: string[] = []
  for (const runId of entries) {
    if (!isRunId(runId)) continue
    const run = await scanRun(recordingId, runDir(projectRoot, recordingId, runId), runId)
    if (run === undefined) {
      warnings.push(`run ${runId} of ${recordingId} has an invalid run.json and was skipped`)
      continue
    }
    runs.push(run)
  }
  runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || left.runId.localeCompare(right.runId))
  return { runs, warnings }
}

function buildStats(
  recordings: readonly PanelRecordingSummary[],
  runsByRecording: ReadonlyMap<string, readonly PanelRunSummary[]>,
): PanelStats {
  let runs = 0
  let failedRuns = 0
  let cancelledRuns = 0
  let videoFiles = 0
  let videoBytes = 0
  for (const runList of runsByRecording.values()) {
    for (const run of runList) {
      runs += 1
      if (run.status === 'failed') failedRuns += 1
      if (run.status === 'cancelled') cancelledRuns += 1
      if (run.hasVideo) {
        videoFiles += 1
        videoBytes += run.videoBytes ?? 0
      }
    }
  }
  return {
    recordings: recordings.length,
    runs,
    failedRuns,
    cancelledRuns,
    failureRate: runs === 0 ? 0 : failedRuns / runs,
    videoFiles,
    videoBytes,
    steps: recordings.reduce((sum, recording) => sum + recording.stepCount, 0),
  }
}

export interface ScanProjectOptions {
  /** Display name; defaults to the directory name. */
  readonly name?: string
}

/** Scan one project root. Never writes. */
/** Read only the manifests of recordings whose status is `recording`; used by the live HUD. */
export async function scanActiveRecordings(projectRoot: string): Promise<readonly ActiveRecordingShape[]> {
  const entries = await listDirectories(recordingsDir(projectRoot))
  const active: ActiveRecordingShape[] = []
  for (const recordingId of entries) {
    if (!isRecordingId(recordingId)) continue
    // Only a fresh writer lock can make a recording active; completed/cancelled
    // recordings release it, and a crashed session leaves an expired lock that
    // recovery will turn into `interrupted`.
    let lock
    try {
      lock = await readLockRecord(lockPath(storeRoot(projectRoot), recordingId as `rec_${string}`))
    } catch {
      continue
    }
    if (lock === undefined || isLockExpired(lock, Date.now(), DEFAULT_LOCK_TTL_MS)) continue
    let manifest
    try {
      manifest = parseManifest(
        await readJson(path.join(recordingsDir(projectRoot), recordingId, 'manifest.json')),
        recordingId,
      )
    } catch {
      continue
    }
    if (manifest === undefined || manifest.status !== 'recording') continue
    active.push({
      recordingId,
      title: manifest.title,
      stepCount: manifest.stepCount,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      ...(manifest.suppressedCount === undefined ? {} : { suppressedCount: manifest.suppressedCount }),
    })
  }
  return active.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function scanProject(projectRoot: string, options: ScanProjectOptions = {}): Promise<ScannedProject> {
  const rootRecordings = recordingsDir(projectRoot)
  const entries = await listDirectories(rootRecordings)
  const runsByRecording = new Map<string, readonly PanelRunSummary[]>()
  const scanned: ScannedRecording[] = []
  const warnings: string[] = []

  for (const recordingId of entries) {
    if (!isRecordingId(recordingId)) continue
    const recordingPath = path.join(rootRecordings, recordingId)
    const manifest = parseManifest(await readJson(path.join(recordingPath, 'manifest.json')), recordingId)
    if (manifest === undefined) {
      warnings.push(`recording ${recordingId} has an invalid manifest.json and was skipped`)
      continue
    }
    const url = manifest.site === undefined ? await firstRecordingUrl(recordingPath) : undefined
    const site = manifest.site
      ?? (url === undefined ? undefined : siteFromUrl(url))
      ?? siteFromTitle(manifest.title)
    const runResult = await scanRuns(projectRoot, recordingId)
    warnings.push(...runResult.warnings)
    runsByRecording.set(recordingId, runResult.runs)
    const hasVideo = runResult.runs.some((run) => run.hasVideo)
    scanned.push({
      recordingId,
      title: manifest.title,
      ...(manifest.intent === undefined ? {} : { intent: manifest.intent }),
      site,
      status: manifest.status,
      ...(manifest.endReason === undefined ? {} : { endReason: manifest.endReason }),
      ...(manifest.suppressedCount === undefined ? {} : { suppressedCount: manifest.suppressedCount }),
      stepCount: manifest.stepCount,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      runCount: runResult.runs.length,
      failedRunCount: runResult.runs.filter((run) => run.status === 'failed').length,
      ...(runResult.runs[0] === undefined ? {} : { lastRunStatus: runResult.runs[0].status }),
      hasVideo,
    })
  }

  const indexState = await loadPanelIndex(
    projectRoot,
    scanned.map((recording) => ({ recordingId: recording.recordingId, site: recording.site })),
  )
  warnings.push(...indexState.warnings)

  const recordings: PanelRecordingSummary[] = scanned.map((recording) => {
    const assignment = assignmentFor(indexState.index, {
      recordingId: recording.recordingId,
      site: recording.site,
    })
    const intent = assignment.intent ?? recording.intent
    const intentSource = assignment.intent !== undefined
      ? 'index'
      : recording.intent === undefined ? undefined : 'manifest'
    const title = assignment.title ?? recording.title
    const titleSource = assignment.title !== undefined ? 'index' : 'manifest'
    return {
      recordingId: recording.recordingId,
      title,
      titleSource,
      ...(intent === undefined || intentSource === undefined ? {} : { intent, intentSource }),
      site: recording.site,
      categoryId: assignment.categoryId,
      ...(assignment.scenarioId === undefined ? {} : { scenarioId: assignment.scenarioId }),
      status: recording.status,
      ...(recording.endReason === undefined ? {} : { endReason: recording.endReason }),
      ...(recording.suppressedCount === undefined ? {} : { suppressedCount: recording.suppressedCount }),
      stepCount: recording.stepCount,
      createdAt: recording.createdAt,
      updatedAt: recording.updatedAt,
      runCount: recording.runCount,
      failedRunCount: recording.failedRunCount,
      ...(recording.lastRunStatus === undefined ? {} : { lastRunStatus: recording.lastRunStatus }),
      hasVideo: recording.hasVideo,
    }
  })
  recordings.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.recordingId.localeCompare(right.recordingId))

  const categories: readonly PanelIndexCategory[] = indexState.index.categories
  const scenarios: readonly PanelIndexScenario[] = indexState.index.scenarios
  const indexSource: PanelIndexSource = indexState.source

  return {
    project: {
      root: projectRoot,
      name: options.name ?? path.basename(projectRoot),
      indexSource,
      warnings,
      categories,
      scenarios,
      recordings,
      stats: buildStats(recordings, runsByRecording),
    },
    runsByRecording,
  }
}

/**
 * Recording ids and sites for index writes.
 *
 * Lightweight on purpose: the write path only needs to know which site a
 * recording belongs to (to rebuild categories and collect 未分组 recordings),
 * so runs are not scanned. Uses exactly the same site derivation as
 * `scanProject` to keep categories in sync with the read path.
 */
export async function scanRecordingRefs(projectRoot: string): Promise<IndexedRecordingRef[]> {
  const rootRecordings = recordingsDir(projectRoot)
  const entries = await listDirectories(rootRecordings)
  const refs: IndexedRecordingRef[] = []
  for (const recordingId of entries) {
    if (!isRecordingId(recordingId)) continue
    const recordingPath = path.join(rootRecordings, recordingId)
    const manifest = parseManifest(await readJson(path.join(recordingPath, 'manifest.json')), recordingId)
    if (manifest === undefined) continue
    const url = manifest.site === undefined ? await firstRecordingUrl(recordingPath) : undefined
    const site = manifest.site
      ?? (url === undefined ? undefined : siteFromUrl(url))
      ?? siteFromTitle(manifest.title)
    refs.push({ recordingId, site })
  }
  return refs
}

/** Locate a run by id and return its preferred video file. */
export async function findRunVideo(projectRoot: string, runId: string): Promise<RunVideoLookup | undefined> {
  if (!isRunId(runId)) return undefined
  const entries = await listDirectories(recordingsDir(projectRoot))
  for (const recordingId of entries) {
    if (!isRecordingId(recordingId)) continue
    const runPath = runDir(projectRoot, recordingId, runId)
    const run = await scanRun(recordingId, runPath, runId)
    if (run === undefined) continue
    const video = await findVideoFile(runPath)
    if (video === undefined) return undefined
    return { recordingId, run, video }
  }
  return undefined
}

/** True when the project has a readable record/replay store (any recordings directory). */
export async function hasRecordReplayStore(projectRoot: string): Promise<boolean> {
  try {
    const info = await stat(storeRoot(projectRoot))
    return info.isDirectory()
  } catch {
    return false
  }
}
