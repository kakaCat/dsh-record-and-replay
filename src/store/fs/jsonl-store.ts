/**
 * 工作区 JSONL Store（design/interfaces.md IF-4、design/data-model.md、plan §4.3~4.5）。
 *
 * 布局（每个 Recording 一个目录）：
 * ```text
 * <root>/
 *   .gitignore                  # 忽略本目录全部运行数据
 *   recordings/<recordingId>/
 *     manifest.json             # 原子替换（tmp → fsync → rename）
 *     steps.jsonl               # 只追加完整 JSON 行
 *     recording.lock            # 写租约（心跳过期可回收）
 *     assets/                   # 相对路径证据
 *     runs/<runId>/             # 回放 Run（本卡只做路径/导出，不写 Run）
 *   exports/                    # .dshreplay
 *   tmp/                        # 创建/修复/导出的临时目录
 * ```
 *
 * 关键承诺：
 * - append 先落 steps.jsonl 再原子更新 manifest；崩溃时以 JSONL 为准，恢复负责对账；
 * - 同一 stepId+callId+type 重复 append 不产生第二逻辑步骤（幂等）；
 * - 读接口流式返回，不把整文件载入内存；
 * - 锁丢失后禁止继续写；坏尾/半行在读取时显式报 STORE_CORRUPT_JSONL，不静默跳过。
 */
import * as fs from 'node:fs/promises'
import { createReadStream, type Dirent } from 'node:fs'
import * as path from 'node:path'
import { createInterface } from 'node:readline'
import { SCHEMA_VERSION, type RecordingId, type StepId } from '../../core/api.js'
import {
  DEFAULT_STORE_MAX_BYTES,
  DEFAULT_STORE_MAX_STEPS,
  StoreError,
  assertStepEvent,
  parseManifest,
  stepEventKey,
  type CloseRecordingInput,
  type EndReason,
  type OpenRecordingInput,
  type RecordingStore,
  type RecordingWriter,
  type StepCursor,
  type StoredStepEvent,
  type StoreErrorCode,
  type StoreManifest,
  type StoreStepEvent,
  type SuppressedStepRecord,
  type WriteAssetInput,
} from '../api.js'
import { DEFAULT_LOCK_TTL_MS, RecordingLock } from './lock.js'
import {
  STORE_LAYOUT,
  assertSafeRecordingId,
  ensureStoreRoot,
  isErrno,
  lockPath,
  manifestPath,
  mapFsError,
  normalizeRelativeRecordingPath,
  pathExists,
  readJsonFile,
  recordingDir,
  recordingsDir,
  resolveRecordingPath,
  sha256File,
  stepsPath,
  suppressedPath,
  tmpDir,
  tmpNameFor,
  writeFileAtomic,
  writeJsonFileAtomic,
} from './paths.js'

// ---------------------------------------------------------------------------
// 纯扫描：写入口续写、读入口与恢复共用同一套行校验
// ---------------------------------------------------------------------------

export interface StepScanIssue {
  /** 第一个非法行的错误码（未知版本保留 STORE_UNSUPPORTED_VERSION，其余按坏文件）。 */
  readonly code: StoreErrorCode
  /** 1-based 行号。 */
  readonly line: number
  /** 非法行的起始字节偏移。 */
  readonly offset: number
  /** 最后一个完整合法行之后的字节偏移；截断续写/坏尾截断都以此为准。 */
  readonly lastGoodOffset: number
  /** 非法行是否是文件最后一个不完整行（没有结尾换行 = 崩溃写入的坏尾）。 */
  readonly incompleteTail: boolean
  readonly message: string
}

export interface StepScanResult {
  readonly events: readonly StoreStepEvent[]
  readonly lastSeq: number
  readonly stepCount: number
  readonly seenKeys: ReadonlySet<string>
  readonly bytes: number
  readonly lastGoodOffset: number
  readonly issue?: StepScanIssue
}

/**
 * 扫描 steps.jsonl 全内容。
 *
 * - 合法行按顺序收集；`lastSeq` 取 started 事件最大 seq，`stepCount` = started 事件数；
 * - 遇到第一个非法行即停止，并把 `lastGoodOffset`（扫描到那里为止的完整行边界）交回调用方；
 * - `incompleteTail` 只表示「文件最后一行没有换行」，即进程写到一半被杀的坏尾。
 */
export function scanStepsBuffer(buffer: Buffer): StepScanResult {
  const events: StoreStepEvent[] = []
  const seenKeys = new Set<string>()
  let lastSeq = 0
  let stepCount = 0
  let lastGoodOffset = 0
  let issue: StepScanIssue | undefined
  let lineNo = 0
  let cursor = 0

  while (cursor < buffer.length) {
    const newlineIndex = buffer.indexOf(0x0a, cursor)
    const lineEnd = newlineIndex === -1 ? buffer.length : newlineIndex
    const lineBuffer = buffer.subarray(cursor, lineEnd)
    const incompleteTail = newlineIndex === -1
    lineNo += 1

    if (lineBuffer.length === 0) {
      issue = {
        code: 'STORE_CORRUPT_JSONL',
        line: lineNo,
        offset: cursor,
        lastGoodOffset,
        incompleteTail,
        message: 'steps.jsonl contains a blank line',
      }
      break
    }

    let event: StoreStepEvent
    try {
      event = assertStepEvent(JSON.parse(lineBuffer.toString('utf8')), { invalidCode: 'STORE_CORRUPT_JSONL' })
    } catch (error) {
      const code = error instanceof StoreError ? error.code : 'STORE_CORRUPT_JSONL'
      issue = {
        code,
        line: lineNo,
        offset: cursor,
        lastGoodOffset,
        incompleteTail,
        message: error instanceof Error ? error.message : String(error),
      }
      break
    }

    events.push(event)
    seenKeys.add(stepEventKey(event))
    if (event.type === 'step.started') {
      lastSeq = Math.max(lastSeq, event.seq)
      stepCount += 1
    }
    cursor = lineEnd + 1
    lastGoodOffset = cursor
  }

  const scan: StepScanResult = {
    events,
    lastSeq,
    stepCount,
    seenKeys,
    bytes: buffer.length,
    lastGoodOffset,
    ...(issue === undefined ? {} : { issue }),
  }
  return scan
}

/** 未配对的 started stepId（已开始但崩溃/中断，恢复时标 interrupted，绝不伪造成功）。 */
export function findUnfinishedSteps(events: readonly StoreStepEvent[]): readonly StepId[] {
  const started = new Set<StepId>()
  const finished = new Set<StepId>()
  for (const event of events) {
    if (event.type === 'step.started') started.add(event.stepId)
    else finished.add(event.stepId)
  }
  return [...started].filter((stepId) => !finished.has(stepId))
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface FsRecordingStoreOptions {
  /** Store 根（通常是 `<workspace>/.dsh/record-and-replay`）。 */
  readonly root: string
  readonly clock?: () => number
  readonly lockTtlMs?: number
  readonly heartbeatIntervalMs?: number
  readonly maxSteps?: number
  readonly maxBytes?: number
}

/** 建立根目录（含 recordings/exports/tmp 与 .gitignore）后返回 Store。 */
export async function createFsRecordingStore(options: FsRecordingStoreOptions): Promise<FsRecordingStore> {
  const root = await ensureStoreRoot(options.root)
  return new FsRecordingStore({ ...options, root })
}

export class FsRecordingStore implements RecordingStore {
  readonly root: string
  private readonly clock: () => number
  private readonly lockTtlMs: number
  private readonly heartbeatIntervalMs: number | undefined
  private readonly maxSteps: number
  private readonly maxBytes: number
  private readonly writers = new Map<RecordingId, FsRecordingWriter>()
  private closed = false

  constructor(options: FsRecordingStoreOptions) {
    if (typeof options.root !== 'string' || options.root.length === 0) {
      throw new StoreError('INVALID_ARGUMENT', 'store root must be a non-empty path')
    }
    this.root = path.resolve(options.root)
    this.clock = options.clock ?? Date.now
    this.lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS
    this.maxSteps = options.maxSteps ?? DEFAULT_STORE_MAX_STEPS
    this.maxBytes = options.maxBytes ?? DEFAULT_STORE_MAX_BYTES
    this.heartbeatIntervalMs = options.heartbeatIntervalMs
  }

  async open(input: OpenRecordingInput): Promise<RecordingWriter> {
    this.assertOpen()
    await ensureStoreRoot(this.root)
    const requested = parseManifest(input.manifest, { invalidCode: 'INVALID_ARGUMENT' })
    if (requested.status !== 'recording') {
      throw new StoreError('RECORDING_ALREADY_COMPLETED', 'a new recording must start in status "recording"', {
        recordingId: requested.recordingId,
      })
    }
    const recordingId = requested.recordingId
    if (this.writers.has(recordingId)) {
      throw new StoreError('STORE_LOCKED', 'recording already has an open writer in this store', { recordingId })
    }

    const dir = recordingDir(this.root, recordingId)
    if (!(await pathExists(dir))) {
      await this.stageNewRecording(requested)
    }

    const lock = await RecordingLock.acquire({
      lockFile: lockPath(this.root, recordingId),
      recordingId,
      ownerSessionId: requested.ownerSessionId,
      ttlMs: this.lockTtlMs,
      ...(this.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: this.heartbeatIntervalMs }),
      clock: this.clock,
    })

    try {
      const manifest = await this.readManifest(recordingId)
      if (manifest.status !== 'recording') {
        throw new StoreError('RECORDING_ALREADY_COMPLETED', 'recording is already in a terminal status', {
          recordingId,
        })
      }

      const stepsFile = stepsPath(this.root, recordingId)
      let buffer: Buffer
      try {
        buffer = await fs.readFile(stepsFile)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
        buffer = Buffer.alloc(0)
      }
      const scan = scanStepsBuffer(buffer)
      if (scan.issue !== undefined) {
        throw new StoreError(
          scan.issue.code,
          `steps.jsonl line ${String(scan.issue.line)} is invalid; run recovery before appending again`,
          { recordingId },
        )
      }

      const repaired = this.reconcileManifest(manifest, scan)
      if (repaired !== manifest) {
        await writeJsonFileAtomic(manifestPath(this.root, recordingId), repaired)
      }

      const handle = await fs.open(stepsFile, 'a', 0o600)
      const writer = new FsRecordingWriter({
        root: this.root,
        lock,
        handle,
        manifest: repaired,
        clock: this.clock,
        maxSteps: this.maxSteps,
        maxBytes: this.maxBytes,
        lastSeq: scan.lastSeq,
        stepCount: scan.stepCount,
        stepsBytes: scan.bytes,
        seenKeys: scan.seenKeys,
        onClosed: (closedWriter) => {
          if (this.writers.get(recordingId) === closedWriter) this.writers.delete(recordingId)
        },
      })
      this.writers.set(recordingId, writer)
      return writer
    } catch (error) {
      await lock.release().catch(() => undefined)
      throw error
    }
  }

  async readManifest(recordingId: RecordingId): Promise<StoreManifest> {
    const id = assertSafeRecordingId(recordingId)
    const raw = await readJsonFile(manifestPath(this.root, id), { what: 'manifest', recordingId: id })
    return parseManifest(raw, { expectedRecordingId: id })
  }

  async *readSteps(recordingId: RecordingId, cursor?: StepCursor): AsyncIterable<StoredStepEvent> {
    const id = assertSafeRecordingId(recordingId)
    const afterLine = cursor?.afterLine
    const afterSeq = cursor?.afterSeq
    if (afterLine !== undefined && (!Number.isInteger(afterLine) || afterLine < 0)) {
      throw new StoreError('INVALID_ARGUMENT', 'cursor.afterLine must be a non-negative integer', {
        recordingId: id,
      })
    }
    if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
      throw new StoreError('INVALID_ARGUMENT', 'cursor.afterSeq must be a non-negative integer', {
        recordingId: id,
      })
    }

    const file = stepsPath(this.root, id)
    const reader = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    let line = 0
    const seqByStep = new Map<string, number>()

    try {
      for await (const raw of reader) {
        line += 1
        if (raw.trim().length === 0) {
          throw new StoreError('STORE_CORRUPT_JSONL', `steps.jsonl line ${String(line)} is blank`, {
            recordingId: id,
          })
        }
        let event: StoreStepEvent
        try {
          event = assertStepEvent(JSON.parse(raw), { invalidCode: 'STORE_CORRUPT_JSONL' })
        } catch (error) {
          if (error instanceof StoreError && error.code === 'STORE_UNSUPPORTED_VERSION') {
            throw new StoreError('STORE_UNSUPPORTED_VERSION', error.message, { recordingId: id })
          }
          throw new StoreError('STORE_CORRUPT_JSONL', `steps.jsonl line ${String(line)} is not a valid step event`, {
            recordingId: id,
            ...(error instanceof Error ? { cause: error } : {}),
          })
        }

        if (event.type === 'step.started') seqByStep.set(event.stepId, event.seq)
        if (afterLine !== undefined && line <= afterLine) continue
        if (afterSeq !== undefined) {
          const seq = event.type === 'step.started' ? event.seq : seqByStep.get(event.stepId)
          if (seq === undefined || seq <= afterSeq) continue
        }
        yield Object.assign({}, event, { line }) as StoredStepEvent
      }
    } catch (error) {
      if (error instanceof StoreError) throw error
      throw new StoreError('RECORDING_NOT_FOUND', 'could not stream steps.jsonl', {
        recordingId: id,
        cause: error,
      })
    } finally {
      reader.close()
    }
  }

  async listRecordings(): Promise<readonly StoreManifest[]> {
    const entries: readonly Dirent[] = await listDirents(recordingsDir(this.root))
    const manifests: StoreManifest[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        manifests.push(await this.readManifest(assertSafeRecordingId(entry.name)))
      } catch {
        // 列表是只读导航：单个坏目录不阻断其它记录；详细问题由 recoverStore 报告。
      }
    }
    return manifests.sort((left, right) => {
      if (left.createdAt === right.createdAt) return left.recordingId < right.recordingId ? -1 : 1
      return left.createdAt < right.createdAt ? 1 : -1
    })
  }

  /** 关闭 Store：所有仍开着的 writer 以 interrupted 收口（绝不伪报 completed），并释放锁。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const writers = [...this.writers.values()]
    await Promise.allSettled(writers.map((writer) => writer.close({ status: 'interrupted' })))
    this.writers.clear()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StoreError('STORE_INIT_FAILED', 'store is already closed')
    }
  }

  /** 创建 Recording：先写 tmp 暂存目录，初始化完成后原子 rename 到 recordings/<id>。 */
  private async stageNewRecording(manifest: StoreManifest): Promise<void> {
    const finalDir = recordingDir(this.root, manifest.recordingId)
    const staging = tmpNameFor(path.join(tmpDir(this.root), manifest.recordingId))
    try {
      await fs.mkdir(staging, { recursive: true, mode: 0o700 })
      await fs.mkdir(path.join(staging, STORE_LAYOUT.assets), { recursive: true, mode: 0o700 })
      await fs.mkdir(path.join(staging, STORE_LAYOUT.runs), { recursive: true, mode: 0o700 })
      await writeJsonFileAtomic(path.join(staging, STORE_LAYOUT.manifest), manifest)
      await writeFileAtomic(path.join(staging, STORE_LAYOUT.steps), '', { mode: 0o600 })
      try {
        await fs.rename(staging, finalDir)
      } catch (error) {
        // 并发创建：另一实例已完成 rename，回退到「已存在目录」路径。
        if (isErrno(error, 'EEXIST') || isErrno(error, 'ENOTEMPTY')) {
          await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
          return
        }
        throw error
      }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error instanceof StoreError
        ? error
        : new StoreError('STORE_INIT_FAILED', 'could not create the recording directory', {
            recordingId: manifest.recordingId,
            cause: error,
          })
    }
  }

  /** manifest 摘要与 JSONL 对账：冲突以事件流为准（design §4.4）。 */
  private reconcileManifest(manifest: StoreManifest, scan: StepScanResult): StoreManifest {
    if (manifest.lastSeq === scan.lastSeq && manifest.stepCount === scan.stepCount) {
      return manifest
    }
    return {
      ...manifest,
      lastSeq: scan.lastSeq,
      stepCount: scan.stepCount,
      updatedAt: new Date(this.clock()).toISOString(),
    }
  }
}

async function listDirents(directory: string): Promise<readonly Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return []
    throw error
  }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

interface FsRecordingWriterOptions {
  readonly root: string
  readonly lock: RecordingLock
  readonly handle: fs.FileHandle
  readonly manifest: StoreManifest
  readonly clock: () => number
  readonly maxSteps: number
  readonly maxBytes: number
  readonly lastSeq: number
  readonly stepCount: number
  readonly stepsBytes: number
  readonly seenKeys: ReadonlySet<string>
  readonly onClosed: (writer: FsRecordingWriter) => void
}

export class FsRecordingWriter implements RecordingWriter {
  readonly recordingId: RecordingId
  private readonly root: string
  private readonly lock: RecordingLock
  private readonly handle: fs.FileHandle
  private readonly clock: () => number
  private readonly maxSteps: number
  private readonly maxBytes: number
  private readonly onClosed: (writer: FsRecordingWriter) => void
  private readonly seen: Set<string>
  private readonly pendingKeys = new Set<string>()
  private readonly stepsFile: string
  private readonly suppressedFile: string
  private current: StoreManifest
  private sequence: number
  private steps: number
  private stepsBytes: number
  private suppressed: number
  private assetBytes = 0
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private frozen: StoreError | undefined

  constructor(options: FsRecordingWriterOptions) {
    this.root = options.root
    this.lock = options.lock
    this.handle = options.handle
    this.current = options.manifest
    this.recordingId = options.manifest.recordingId
    this.clock = options.clock
    this.maxSteps = options.maxSteps
    this.maxBytes = options.maxBytes
    this.sequence = options.lastSeq
    this.steps = options.stepCount
    this.stepsBytes = options.stepsBytes
    this.seen = new Set(options.seenKeys)
    this.onClosed = options.onClosed
    this.stepsFile = stepsPath(this.root, this.recordingId)
    this.suppressedFile = suppressedPath(this.root, this.recordingId)
    this.suppressed = options.manifest.suppressedCount ?? 0
  }

  get manifest(): StoreManifest {
    return this.current
  }

  async append(event: StoreStepEvent): Promise<void> {
    this.assertWritable()
    const validated = assertStepEvent(event, { invalidCode: 'INVALID_ARGUMENT' })

    // 去重先于单调性校验：重试同一事件是幂等 no-op，不是「新步骤用了旧 seq」。
    const key = stepEventKey(validated)
    if (this.seen.has(key) || this.pendingKeys.has(key)) return
    if (validated.type === 'step.started' && validated.seq <= this.sequence) {
      throw new StoreError('INVALID_ARGUMENT', 'step.started seq must increase monotonically', {
        recordingId: this.recordingId,
        stepId: validated.stepId,
      })
    }

    if (validated.type === 'step.started' && this.steps + 1 > this.maxSteps) {
      throw new StoreError('STORE_LIMIT_EXCEEDED', `recording reached the step limit (${String(this.maxSteps)})`, {
        recordingId: this.recordingId,
      })
    }
    if (validated.type === 'step.finished' && validated.evidence !== undefined) {
      for (const evidence of validated.evidence) {
        normalizeRelativeRecordingPath(evidence)
      }
    }

    const line = `${JSON.stringify(validated)}\n`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (this.stepsBytes + this.assetBytes + lineBytes > this.maxBytes) {
      throw new StoreError('STORE_LIMIT_EXCEEDED', `recording reached the byte limit (${String(this.maxBytes)})`, {
        recordingId: this.recordingId,
      })
    }

    this.pendingKeys.add(key)
    const task = this.queue.then(async () => {
      await this.lock.assertHeld()
      try {
        await this.writeLine(line)
        this.stepsBytes += lineBytes
        if (validated.type === 'step.started') {
          this.sequence = validated.seq
          this.steps += 1
        }
        // 先记去重键再写 manifest：manifest 失败时重试同一事件不会产生第二个逻辑步骤，
        // 盘上摘要由恢复扫描对账（事件流为准）。
        this.seen.add(key)
        this.pendingKeys.delete(key)
        const next: StoreManifest = {
          ...this.current,
          lastSeq: this.sequence,
          stepCount: this.steps,
          updatedAt: new Date(this.clock()).toISOString(),
        }
        await writeJsonFileAtomic(manifestPath(this.root, this.recordingId), next)
        this.current = next
      } catch (error) {
        throw mapFsError(error, 'append steps.jsonl', this.recordingId)
      }
    })
    this.queue = task.catch(() => undefined)
    try {
      await task
    } catch (error) {
      this.pendingKeys.delete(key)
      const storeError = error instanceof StoreError
        ? error
        : new StoreError('STORE_INIT_FAILED', 'could not append a step event', {
            recordingId: this.recordingId,
            cause: error,
          })
      if (storeError.code === 'STORE_DISK_FULL' || storeError.code === 'STORE_LIMIT_EXCEEDED') {
        this.frozen = storeError
      }
      throw storeError
    }
  }

  async appendSuppressed(record: SuppressedStepRecord): Promise<void> {
    this.assertWritable()
    const line = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...record })}\n`
    const task = this.queue.then(async () => {
      await this.lock.assertHeld()
      await fs.appendFile(this.suppressedFile, line, { mode: 0o600 })
      this.suppressed += 1
      const next: StoreManifest = {
        ...this.current,
        suppressedCount: this.suppressed,
        updatedAt: new Date(this.clock()).toISOString(),
      }
      await writeJsonFileAtomic(manifestPath(this.root, this.recordingId), next)
      this.current = next
    })
    this.queue = task.catch(() => undefined)
    try {
      await task
    } catch (error) {
      throw error instanceof StoreError
        ? error
        : new StoreError('STORE_INIT_FAILED', 'could not append a suppressed step', {
            recordingId: this.recordingId,
            cause: error,
          })
    }
  }

  async writeAsset(input: WriteAssetInput): Promise<string> {
    this.assertWritable()
    const relative = normalizeRelativeRecordingPath(input.path)
    const bytes = typeof input.data === 'string' ? Buffer.byteLength(input.data, 'utf8') : input.data.byteLength
    if (this.stepsBytes + this.assetBytes + bytes > this.maxBytes) {
      throw new StoreError('STORE_LIMIT_EXCEEDED', `recording reached the asset byte limit (${String(this.maxBytes)})`, {
        recordingId: this.recordingId,
      })
    }
    await this.lock.assertHeld()
    const target = resolveRecordingPath(this.root, this.recordingId, relative)
    await writeFileAtomic(target, input.data, { mode: 0o600 })
    this.assetBytes += bytes
    return relative
  }

  async close(input: CloseRecordingInput = {}): Promise<StoreManifest> {
    if (this.closed) return this.current
    const status = input.status ?? 'completed'
    if (status !== 'completed' && status !== 'failed' && status !== 'interrupted' && status !== 'cancelled') {
      throw new StoreError('INVALID_ARGUMENT', 'close status must be completed|failed|interrupted|cancelled', {
        recordingId: this.recordingId,
      })
    }
    const endReason = input.endReason ?? defaultEndReason(status)
    this.closed = true

    try {
      await this.queue
      await this.handle.sync()
      await this.handle.close()
      const stepsSha256 = await sha256File(this.stepsFile)
      const nowIso = new Date(this.clock()).toISOString()
      const next: StoreManifest = {
        ...this.current,
        status,
        endReason,
        updatedAt: nowIso,
        completedAt: nowIso,
        stepsSha256,
        lastSeq: this.sequence,
        stepCount: this.steps,
      }
      await writeJsonFileAtomic(manifestPath(this.root, this.recordingId), next)
      this.current = next
      await this.lock.release()
      this.onClosed(this)
      return this.current
    } catch (error) {
      await this.handle.close().catch(() => undefined)
      await this.lock.release().catch(() => undefined)
      this.onClosed(this)
      throw error instanceof StoreError
        ? error
        : new StoreError('STORE_INIT_FAILED', 'could not close the recording', {
            recordingId: this.recordingId,
            cause: error,
          })
    }
  }

  private assertWritable(): void {
    if (this.closed) {
      throw new StoreError('RECORDING_ALREADY_COMPLETED', 'recording writer is already closed', {
        recordingId: this.recordingId,
      })
    }
    if (this.current.status !== 'recording') {
      throw new StoreError('RECORDING_ALREADY_COMPLETED', 'recording is not in status "recording"', {
        recordingId: this.recordingId,
      })
    }
    if (this.frozen !== undefined) {
      throw this.frozen
    }
  }

  /** 写完整一行：O_APPEND 句柄 + 循环写满，避免半行（半行会被恢复当坏尾备份）。 */
  private async writeLine(line: string): Promise<void> {
    const buffer = Buffer.from(line, 'utf8')
    let written = 0
    while (written < buffer.length) {
      const { bytesWritten } = await this.handle.write(buffer, written, buffer.length - written, null)
      if (bytesWritten <= 0) {
        throw new StoreError('STORE_DISK_FULL', 'steps.jsonl write made no progress', {
          recordingId: this.recordingId,
        })
      }
      written += bytesWritten
    }
  }
}

/** 未显式传 endReason 时按终态推导，保证每个关闭的 Recording 都有结束原因。 */
function defaultEndReason(status: 'completed' | 'failed' | 'interrupted' | 'cancelled'): EndReason {
  switch (status) {
    case 'completed':
      return 'tool_stopped'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    case 'cancelled':
      return 'cancelled'
  }
}
