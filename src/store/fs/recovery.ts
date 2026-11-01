/**
 * 崩溃恢复 / 坏尾修复（design/data-model.md「最后一行损坏 / 锁被遗留」、plan §4.5 第 5/6 条）。
 *
 * 恢复原则（不可静默丢数据）：
 * 1. 心跳新鲜的 `recording.lock` 说明还有写者：只报告，不改盘；
 * 2. 心跳过期的锁 / 损坏的锁内容 → 回收并报告（协作锁，不是安全边界）；
 * 3. 坏尾（最后一行没有结尾换行 = 写到一半被杀）：先把原文件整份备份到
 *    `steps.jsonl.corrupt-<ts>.bak`，再截断到最后一个完整行；
 * 4. 文件中间出现完整但不合法的行 → 不截断（会丢之后的数据），只报告 STORE_CORRUPT_JSONL；
 * 5. 以事件流为准修复 manifest 的 lastSeq/stepCount/stepsSha256；仍在 recording 状态且崩溃时
 *    标 `interrupted`，已开始未 finished 的步骤列入报告（绝不伪造成 success）；
 * 6. 遗留临时文件/临时目录只清理超龄的，绝不自动删除 Recording 或 Run。
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { RecordingId, StepId } from '../../core/api.js'
import {
  StoreError,
  parseManifest,
  type RecordingStatus,
  type StoreManifest,
  type StoreStepEvent,
} from '../api.js'
import { findUnfinishedSteps, scanStepsBuffer, type StepScanResult } from './jsonl-store.js'
import { DEFAULT_LOCK_TTL_MS, isLockExpired, readLockRecord } from './lock.js'
import {
  STORE_LAYOUT,
  assertSafeRecordingId,
  ensureStoreRoot,
  listEntries,
  lockPath,
  manifestPath,
  recordingDir,
  recordingsDir,
  sha256Hex,
  stepsPath,
  tmpDir,
  writeFileAtomic,
  writeJsonFileAtomic,
} from './paths.js'

export type RecoveryIssueKind =
  | 'corrupt-tail'
  | 'corrupt-jsonl'
  | 'missing-manifest'
  | 'invalid-manifest'
  | 'unsupported-version'
  | 'missing-steps'
  | 'stale-lock'
  | 'orphan-tmp'
  | 'manifest-repair'
  | 'unfinished-step'
  | 'recovery-failed'
  | 'invalid-recording-dir'

export interface RecoveryIssue {
  readonly kind: RecoveryIssueKind
  readonly message: string
  readonly recordingId?: RecordingId
  readonly line?: number
  /** 相对 Recording 目录的 POSIX 路径（备份文件等）。 */
  readonly path?: string
}

export interface RecordingRecoveryReport {
  readonly recordingId: RecordingId
  readonly issues: readonly RecoveryIssue[]
  /** 是否真的改过盘（备份/截断/重写 manifest/删锁）。 */
  readonly repaired: boolean
  /** 仍有新鲜锁，说明有写者在线：本次未改盘。 */
  readonly activeWriter: boolean
  readonly unfinishedStepIds: readonly StepId[]
  readonly backupPath?: string
  readonly truncatedBytes: number
}

export interface StoreRecoveryReport {
  readonly scannedRecordings: number
  readonly recordings: readonly RecordingRecoveryReport[]
  /** 清理的 root/tmp 超龄条目数。 */
  readonly removedTmpEntries: number
  readonly issues: readonly RecoveryIssue[]
}

export interface RecoverStoreOptions {
  readonly clock?: () => number
  readonly lockTtlMs?: number
  /** root/tmp 里超过该时长的暂存目录视为遗留；缺省 24h。 */
  readonly tmpRetentionMs?: number
}

const DEFAULT_TMP_RETENTION_MS = 24 * 60 * 60 * 1000

export async function recoverStore(root: string, options: RecoverStoreOptions = {}): Promise<StoreRecoveryReport> {
  const resolvedRoot = await ensureStoreRoot(root)
  const clock = options.clock ?? Date.now
  const lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS
  const tmpRetentionMs = options.tmpRetentionMs ?? DEFAULT_TMP_RETENTION_MS
  const now = clock()

  const removedTmpEntries = await cleanStaleTmp(resolvedRoot, now, tmpRetentionMs)
  const dirs = await listEntries(recordingsDir(resolvedRoot))
  const reports: RecordingRecoveryReport[] = []

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    let recordingId: RecordingId
    try {
      recordingId = assertSafeRecordingId(entry.name)
    } catch {
      continue
    }
    try {
      reports.push(await recoverRecording(resolvedRoot, recordingId, { clock, lockTtlMs, now }))
    } catch (error) {
      reports.push({
        recordingId,
        issues: [
          {
            kind: 'recovery-failed',
            recordingId,
            message: `recovery aborted: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        repaired: false,
        activeWriter: false,
        unfinishedStepIds: [],
        truncatedBytes: 0,
      })
    }
  }

  return {
    scannedRecordings: reports.length,
    recordings: reports,
    removedTmpEntries,
    issues: reports.flatMap((report) => report.issues),
  }
}

interface RecoverRecordingOptions {
  readonly clock: () => number
  readonly lockTtlMs: number
  readonly now: number
}

async function recoverRecording(
  root: string,
  recordingId: RecordingId,
  options: RecoverRecordingOptions,
): Promise<RecordingRecoveryReport> {
  const dir = recordingDir(root, recordingId)
  const issues: RecoveryIssue[] = []
  let repaired = false

  // 1) 锁：新鲜锁 = 有写者在线，只报告不改盘；过期/损坏 = 遗留锁，回收。
  const lock = lockPath(root, recordingId)
  if (await exists(lock)) {
    const record = await readLockRecord(lock)
    if (record === undefined) {
      await fs.rm(lock, { force: true }).catch(() => undefined)
      issues.push({
        kind: 'stale-lock',
        recordingId,
        path: STORE_LAYOUT.lock,
        message: 'recording.lock had no readable owner and was reclaimed',
      })
      repaired = true
    } else if (isLockExpired(record, options.now, options.lockTtlMs)) {
      await fs.rm(lock, { force: true }).catch(() => undefined)
      issues.push({
        kind: 'stale-lock',
        recordingId,
        path: STORE_LAYOUT.lock,
        message: `recording.lock heartbeat expired (pid ${String(record.pid)}) and was reclaimed`,
      })
      repaired = true
    } else {
      return {
        recordingId,
        issues,
        repaired: false,
        activeWriter: true,
        unfinishedStepIds: [],
        truncatedBytes: 0,
      }
    }
  }

  // 2) 遗留临时文件（manifest/steps 的 tmp 兄弟文件）。
  for (const entry of await listEntries(dir)) {
    if (!entry.isFile() || !entry.name.includes(STORE_LAYOUT.tmpMarker)) continue
    await fs.rm(entry.fullPath, { force: true }).catch(() => undefined)
    issues.push({
      kind: 'orphan-tmp',
      recordingId,
      path: entry.name,
      message: `orphan temporary file ${entry.name} was removed`,
    })
    repaired = true
  }

  // 3) manifest。
  let manifest: StoreManifest
  try {
    const raw = await fs.readFile(manifestPath(root, recordingId), 'utf8').catch((error: unknown) => {
      if (isEnoent(error)) return undefined
      throw error
    })
    if (raw === undefined) {
      issues.push({
        kind: 'missing-manifest',
        recordingId,
        path: STORE_LAYOUT.manifest,
        message: 'recording directory has no manifest.json',
      })
      return report(recordingId, issues, repaired)
    }
    manifest = parseManifest(JSON.parse(raw) as unknown, { expectedRecordingId: recordingId })
  } catch (error) {
    if (error instanceof StoreError && error.code === 'STORE_UNSUPPORTED_VERSION') {
      issues.push({
        kind: 'unsupported-version',
        recordingId,
        path: STORE_LAYOUT.manifest,
        message: error.message,
      })
    } else {
      issues.push({
        kind: 'invalid-manifest',
        recordingId,
        path: STORE_LAYOUT.manifest,
        message: `manifest.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return report(recordingId, issues, repaired)
  }

  // 4) steps.jsonl：读到完整行的边界；坏尾先备份再截断。
  const stepsFile = stepsPath(root, recordingId)
  let buffer: Buffer
  try {
    buffer = await fs.readFile(stepsFile)
  } catch (error) {
    if (!isEnoent(error)) throw error
    await writeFileAtomic(stepsFile, '', { mode: 0o600 })
    issues.push({
      kind: 'missing-steps',
      recordingId,
      path: STORE_LAYOUT.steps,
      message: 'steps.jsonl was missing and has been initialized empty',
    })
    buffer = Buffer.alloc(0)
    repaired = true
  }

  let scan: StepScanResult = scanStepsBuffer(buffer)
  let backupPath: string | undefined
  let truncatedBytes = 0
  let events: readonly StoreStepEvent[] = scan.events

  if (scan.issue !== undefined) {
    if (scan.issue.incompleteTail) {
      const backupName = `steps.jsonl.corrupt-${compactTimestamp(options.now)}-${randomUUID().slice(0, 8)}.bak`
      await writeFileAtomic(path.join(dir, backupName), buffer, { mode: 0o600 })
      await fs.truncate(stepsFile, scan.lastGoodOffset)
      backupPath = backupName
      truncatedBytes = buffer.length - scan.lastGoodOffset
      issues.push({
        kind: 'corrupt-tail',
        recordingId,
        path: backupName,
        line: scan.issue.line,
        message: `incomplete tail (${String(truncatedBytes)} bytes) backed up and truncated at the last complete line`,
      })
      repaired = true
      scan = scanStepsBuffer(buffer.subarray(0, scan.lastGoodOffset))
      events = scan.events
    } else {
      // 中间完整行非法：截断会丢后续数据，只能报告并保留现场。
      issues.push({
        kind: 'corrupt-jsonl',
        recordingId,
        path: STORE_LAYOUT.steps,
        line: scan.issue.line,
        message: 'steps.jsonl contains an invalid line before the end of file; file left untouched',
      })
    }
  }

  // 中间完整行非法时，后续数据仍可能存在：绝不据此回写更小的 lastSeq/stepCount。
  const canRepairManifest = scan.issue === undefined
  const unfinishedStepIds = findUnfinishedSteps(events)
  for (const stepId of unfinishedStepIds) {
    issues.push({
      kind: 'unfinished-step',
      recordingId,
      message: `step ${stepId} started but never finished; recording is interrupted`,
    })
  }

  // 5) 以事件流为准对账 manifest。
  const stepsSha256 = sha256Hex(buffer.subarray(0, scan.lastGoodOffset))
  const status: RecordingStatus = manifest.status === 'recording' ? 'interrupted' : manifest.status
  const nowIso = new Date(options.now).toISOString()
  const next: StoreManifest = {
    ...manifest,
    status,
    ...(status === 'interrupted' ? { endReason: 'interrupted' as const } : {}),
    lastSeq: scan.lastSeq,
    stepCount: scan.stepCount,
    stepsSha256,
    updatedAt: nowIso,
    ...(manifest.completedAt !== undefined
      ? { completedAt: manifest.completedAt }
      : status === 'interrupted'
        ? { completedAt: nowIso }
        : {}),
  }

  const changed = canRepairManifest && (
    next.status !== manifest.status ||
    next.lastSeq !== manifest.lastSeq ||
    next.stepCount !== manifest.stepCount ||
    next.stepsSha256 !== manifest.stepsSha256 ||
    next.updatedAt !== manifest.updatedAt ||
    next.completedAt !== manifest.completedAt ||
    next.endReason !== manifest.endReason
  )

  if (changed) {
    await writeJsonFileAtomic(manifestPath(root, recordingId), next)
    issues.push({
      kind: 'manifest-repair',
      recordingId,
      path: STORE_LAYOUT.manifest,
      message: 'manifest summary reconciled with steps.jsonl',
    })
    repaired = true
  }

  return report(recordingId, issues, repaired, {
    unfinishedStepIds,
    ...(backupPath === undefined ? {} : { backupPath }),
    truncatedBytes,
  })
}

function report(
  recordingId: RecordingId,
  issues: RecoveryIssue[],
  repaired: boolean,
  extras: {
    readonly unfinishedStepIds?: readonly StepId[]
    readonly backupPath?: string
    readonly truncatedBytes?: number
  } = {},
): RecordingRecoveryReport {
  return {
    recordingId,
    issues,
    repaired,
    activeWriter: false,
    unfinishedStepIds: extras.unfinishedStepIds ?? [],
    ...(extras.backupPath === undefined ? {} : { backupPath: extras.backupPath }),
    truncatedBytes: extras.truncatedBytes ?? 0,
  }
}

async function cleanStaleTmp(root: string, now: number, retentionMs: number): Promise<number> {
  let removed = 0
  for (const entry of await listEntries(tmpDir(root))) {
    const stat = await fs.stat(entry.fullPath).catch(() => undefined)
    if (stat === undefined) continue
    if (now - stat.mtimeMs <= retentionMs) continue
    await fs.rm(entry.fullPath, { recursive: true, force: true }).catch(() => undefined)
    removed += 1
  }
  return removed
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate)
    return true
  } catch {
    return false
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function compactTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[^0-9A-Za-z]/g, '').slice(0, 17)
}
