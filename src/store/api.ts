/**
 * Store 公共 SPI（design/interfaces.md IF-4 RecordingStore、design/data-model.md）。
 *
 * 责任边界：
 * - Store 只负责事实持久化：写接口只接收**已校验、已脱敏**的步骤事件，不解释 BrowserAction、
 *   不做 Session 授权、不改变事件顺序；
 * - 读接口流式返回（seq / 行游标），不得把 10,000 步整文件载入内存；
 * - 恢复接口报告坏尾、锁与版本问题；坏尾必须保留原文件备份后截断，绝不静默丢弃；
 * - 文件布局见 docs/projects/PRJ-0001/plan/implementation-plan.md §4.3：
 *   `recordings/<recordingId>/{manifest.json,steps.jsonl,recording.lock,assets/,runs/}`。
 *
 * 错误码说明：IF-4 与 data-model.md 命名的 `STORE_*` / `RECORDING_*` 码有若干不在 Core
 * 的 `ERROR_CODES` 联合里（Core 卡只登记了它那一批）。Store 是进程内 SPI，这里按设计文档
 * 原文固定一组 `STORE_ERROR_CODES`；跨模块对外时由上层（RecordingService/Host）收敛成
 * Core 的 PublicError，不在 Store 层另造同义码。
 */
import {
  SCHEMA_VERSION,
  isBrowserAction,
  isPublicError,
  isRecordingId,
  isRunId,
  isStepId,
  isSupportedSchemaVersion,
  type BrowserAction,
  type JsonValue,
  type Origin,
  type PublicError,
  type RecordingId,
  type RunId,
  type StepId,
} from '../core/api.js'

/** IF-4 错误码全集（design/interfaces.md IF-4、design/data-model.md「错误码」节）。 */
export const STORE_ERROR_CODES = [
  'STORE_INVALID_ID',
  'STORE_PATH_ESCAPE',
  'STORE_LOCKED',
  'STORE_LOCK_LOST',
  'STORE_CORRUPT_JSONL',
  'STORE_DISK_FULL',
  'STORE_LIMIT_EXCEEDED',
  'STORE_UNSUPPORTED_VERSION',
  'STORE_INIT_FAILED',
  'RECORDING_NOT_FOUND',
  'RECORDING_ALREADY_COMPLETED',
  'INVALID_ARGUMENT',
] as const

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number]

const STORE_ERROR_CODE_SET: ReadonlySet<string> = new Set(STORE_ERROR_CODES)

export function isStoreErrorCode(value: unknown): value is StoreErrorCode {
  return typeof value === 'string' && STORE_ERROR_CODE_SET.has(value)
}

export interface StoreErrorOptions {
  readonly cause?: unknown
  readonly recordingId?: RecordingId
  readonly runId?: RunId
  readonly stepId?: StepId
}

/**
 * Store 稳定错误。`code` 是 IF-4 的稳定契约；message 只描述字段/相对路径，不含本机绝对路径。
 */
export class StoreError extends Error {
  readonly code: StoreErrorCode
  readonly recordingId?: RecordingId
  readonly runId?: RunId
  readonly stepId?: StepId

  constructor(code: StoreErrorCode, message: string, options: StoreErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'StoreError'
    this.code = code
    if (options.recordingId !== undefined) this.recordingId = options.recordingId
    if (options.runId !== undefined) this.runId = options.runId
    if (options.stepId !== undefined) this.stepId = options.stepId
  }
}

export function isStoreError(value: unknown): value is StoreError {
  return value instanceof StoreError
}

// ---------------------------------------------------------------------------
// Manifest（design/data-model.md「核心类型」；字段与 RecordingManifest 一致）
// ---------------------------------------------------------------------------

/** `cancelled` = 录制方主动丢弃，保留现场但不可回放、不可生成 Skill。 */
export type RecordingStatus = 'recording' | 'completed' | 'failed' | 'interrupted' | 'cancelled'

/** Recording 终态；`recording` 仍可追加，其余不可。 */
export const TERMINAL_RECORDING_STATUSES: readonly RecordingStatus[] = ['completed', 'failed', 'interrupted', 'cancelled']

export const RECORDING_STATUSES: readonly RecordingStatus[] = ['recording', ...TERMINAL_RECORDING_STATUSES]

export function isRecordingStatus(value: unknown): value is RecordingStatus {
  return typeof value === 'string' && (RECORDING_STATUSES as readonly string[]).includes(value)
}

export function isTerminalRecordingStatus(value: unknown): value is RecordingStatus {
  return typeof value === 'string' && (TERMINAL_RECORDING_STATUSES as readonly string[]).includes(value)
}

/**
 * 录制结束原因（只增不改）：`tool_stopped` 与 `max_duration` 都是正常完成的 Recording，
 * `cancelled` 是主动丢弃，`failed` / `interrupted` 对应失败与崩溃恢复。
 */
export type EndReason = 'tool_stopped' | 'max_duration' | 'cancelled' | 'failed' | 'interrupted'

export const END_REASONS: readonly EndReason[] = ['tool_stopped', 'max_duration', 'cancelled', 'failed', 'interrupted']

export function isEndReason(value: unknown): value is EndReason {
  return typeof value === 'string' && (END_REASONS as readonly string[]).includes(value)
}

/** 录制同意记录：mode=implicit 表示由调用方在 start 时声明，explicit 表示显式同意开关。 */
export interface RecordingConsent {
  readonly mode: 'implicit' | 'explicit'
  /** 人可读的录制范围说明。 */
  readonly scope: string
  readonly grantedAt: string
  /** 授权会话（Principal.sessionId），用于审计。 */
  readonly grantedBy: string
}

export function isRecordingConsentMode(value: unknown): value is RecordingConsent['mode'] {
  return value === 'implicit' || value === 'explicit'
}

export interface StoreDriverInfo {
  readonly id: string
  readonly version: string
  readonly transport: string
}

export interface StoreBrowserInfo {
  readonly app: string
  readonly startUrl?: string
}

/**
 * Recording 清单。`lastSeq/stepCount` 是加速读取的摘要，加载时必须与 JSONL 对账；
 * 冲突以事件流为准并修复 manifest（design 4.4）。
 */
export interface StoreManifest {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly recordingId: RecordingId
  readonly title: string
  /**
   * The user requirement or use case this recording demonstrates.
   *
   * Optional and additive: recordings written before this field existed stay
   * valid, and the panel falls back to the title plus an "intent missing" mark.
   */
  readonly intent?: string
  readonly status: RecordingStatus
  readonly ownerSessionId: string
  readonly driver: StoreDriverInfo
  readonly browser: StoreBrowserInfo
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt?: string
  /** 结束原因；旧 Recording 没有该字段，读取时保持缺省。 */
  readonly endReason?: EndReason
  /** 录制同意记录；`recording.consent: off` 时不写。 */
  readonly consent?: RecordingConsent
  /** 因 URL 隐私策略被抑制、未写入 steps.jsonl 的步骤数；旧 Recording 缺省 0。 */
  readonly suppressedCount?: number
  readonly lastSeq: number
  readonly stepCount: number
  readonly stepsSha256?: string
  readonly assetRoot?: string
}

// ---------------------------------------------------------------------------
// Step 事件（design/data-model.md StepStarted / StepFinished 的逐字段形状）
// ---------------------------------------------------------------------------

/** 与 driver/operation-runner 的 StepStartedEvent 结构一致（Store 不依赖 driver）。 */
export interface StoreStepStarted {
  readonly type: 'step.started'
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly stepId: StepId
  readonly seq: number
  readonly callId: string
  readonly origin: Origin
  readonly action: BrowserAction
  readonly startedAt: number
}

/**
 * 与 driver/operation-runner 的 StepFinishedEvent、design/data-model.md 结构一致。
 * finished 事件不携带 schemaVersion（data-model 固定形状）；若上游写入该字段，读取时校验后忽略。
 */
export interface StoreStepFinished {
  readonly type: 'step.finished'
  readonly stepId: StepId
  readonly callId: string
  readonly status: 'success' | 'error' | 'cancelled'
  readonly finishedAt: number
  readonly durationMs: number
  readonly resultSummary?: JsonValue
  readonly error?: PublicError
  readonly evidence?: readonly string[]
}

export type StoreStepEvent = StoreStepStarted | StoreStepFinished

/** 读流中的事件：带上它在 steps.jsonl 里的 1-based 行号，供游标续读。 */
export type StoredStepEvent = StoreStepEvent & { readonly line: number }

/** 读取游标：`afterLine` 按行号续读；`afterSeq` 按逻辑步骤 seq 续读（含其 finished 对）。 */
export interface StepCursor {
  readonly afterLine?: number
  readonly afterSeq?: number
}

// ---------------------------------------------------------------------------
// SPI
// ---------------------------------------------------------------------------

/** 被隐私策略抑制的步骤：只保留配对与统计所需的最小字段，绝不含 URL/文本/值。 */
export type SuppressedReason = 'url_excluded' | 'url_blocked'

export interface SuppressedStepRecord {
  readonly stepId: StepId
  readonly callId: string
  /** 动作类型，用于统计与审计；不含目标或参数。 */
  readonly actionKind: BrowserAction['kind']
  readonly reason: SuppressedReason
  /** epoch 毫秒。 */
  readonly at: number
}

export interface OpenRecordingInput {
  /** 新 Recording 的清单；status 必须是 `recording`。已存在且状态可续写时以盘上清单为准。 */
  readonly manifest: StoreManifest
}

export interface WriteAssetInput {
  /** Recording 内相对 POSIX 路径，只允许 `assets/…` 或 `runs/<runId>/…`。 */
  readonly path: string
  readonly data: Uint8Array | string
}

export type CloseRecordingInput = {
  /** 缺省 `completed`；崩溃恢复路径用 `interrupted`，主动丢弃用 `cancelled`。 */
  readonly status?: 'completed' | 'failed' | 'interrupted' | 'cancelled'
  /** 缺省按 status 推导（completed→tool_stopped，其余同名）。 */
  readonly endReason?: EndReason
}

/**
 * 单个 Recording 的写句柄。append 幂等（同 stepId+callId+type 不产生第二逻辑步骤）；
 * close 幂等；锁失效后禁止继续写（STORE_LOCK_LOST）。
 */
export interface RecordingWriter {
  readonly recordingId: RecordingId
  /** 当前清单快照（含已落盘的 lastSeq/stepCount）。 */
  readonly manifest: StoreManifest
  append(event: StoreStepEvent): Promise<void>
  /** 把被抑制的步骤写入独立的 suppressed.jsonl；不进入 steps.jsonl / stepCount。 */
  appendSuppressed(record: SuppressedStepRecord): Promise<void>
  writeAsset(input: WriteAssetInput): Promise<string>
  close(input?: CloseRecordingInput): Promise<StoreManifest>
}

/** 读侧 SPI：读接口不触发浏览器动作（FR-4）。 */
export interface RecordingStore {
  readonly root: string
  open(input: OpenRecordingInput): Promise<RecordingWriter>
  readManifest(recordingId: RecordingId): Promise<StoreManifest>
  readSteps(recordingId: RecordingId, cursor?: StepCursor): AsyncIterable<StoredStepEvent>
  listRecordings(): Promise<readonly StoreManifest[]>
  close(): Promise<void>
}

export interface ExportRecordingInput {
  readonly recordingId: RecordingId
  /** 目标文件；缺省 `exports/<recordingId>.dshreplay`（相对 root）。 */
  readonly destination?: string
  /** Run 默认不导出（plan §4.5 第 7 条），用户显式选择时才附加。 */
  readonly includeRuns?: boolean
}

export interface ExportResult {
  readonly recordingId: RecordingId
  /** 实际写入的绝对路径。 */
  readonly filePath: string
  readonly fileCount: number
  readonly bytes: number
  readonly sha256: string
}

export interface DshReplayFileEntry {
  /** 相对 Recording 目录的 POSIX 路径。 */
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly contentBase64: string
}

/** `.dshreplay` 归档头；文件体是它的 gzip 压缩 JSON（也接受未压缩 JSON）。 */
export interface DshReplayArchive {
  readonly format: 'dshreplay'
  readonly formatVersion: 1
  readonly recordingId: RecordingId
  readonly exportedAt: string
  readonly files: readonly DshReplayFileEntry[]
}

/** 导出 SPI；只读 Recording 事实，不写回原目录。 */
export interface RecordingExporter {
  exportRecording(input: ExportRecordingInput): Promise<ExportResult>
  readArchive(filePath: string): Promise<DshReplayArchive>
}

// ---------------------------------------------------------------------------
// 默认限额（plan §4.5：10,000 步 / 500 MiB / 50 Run；Store 只固定前两项）
// ---------------------------------------------------------------------------

export const DEFAULT_STORE_MAX_STEPS = 10_000
export const DEFAULT_STORE_MAX_BYTES = 500 * 1024 * 1024

// ---------------------------------------------------------------------------
// 纯校验函数（写入口与读入口共用，保证同一套字段约束）
// ---------------------------------------------------------------------------

export interface ParseManifestOptions {
  /** 期望的 RecordingId（目录名/请求 ID）；不一致即 STORE_INVALID_ID。 */
  readonly expectedRecordingId?: RecordingId
  /** 非 schemaVersion 类字段非法时使用的错误码；读盘缺省 STORE_CORRUPT_JSONL，入参缺省 INVALID_ARGUMENT。 */
  readonly invalidCode?: StoreErrorCode
}

/**
 * 校验并归一化 manifest。
 *
 * 只读盘时非法内容是「坏文件」（STORE_CORRUPT_JSONL）；调用方入参非法是「参数错”
 * （INVALID_ARGUMENT）。未知 schemaVersion 永远是 STORE_UNSUPPORTED_VERSION，不做猜测。
 */
export function parseManifest(value: unknown, options: ParseManifestOptions = {}): StoreManifest {
  const invalidCode = options.invalidCode ?? 'STORE_CORRUPT_JSONL'
  const record = requireRecord(value, 'manifest', invalidCode)

  const rawVersion = record['schemaVersion']
  if (typeof rawVersion !== 'number') {
    throw invalid('manifest.schemaVersion must be a number', invalidCode, options.expectedRecordingId)
  }
  if (!isSupportedSchemaVersion(rawVersion)) {
    throw new StoreError(
      'STORE_UNSUPPORTED_VERSION',
      `manifest.schemaVersion ${String(rawVersion)} is not supported`,
      options.expectedRecordingId === undefined ? {} : { recordingId: options.expectedRecordingId },
    )
  }

  const recordingId = record['recordingId']
  if (!isRecordingId(recordingId)) {
    throw invalid('manifest.recordingId is not a valid RecordingId', 'STORE_INVALID_ID')
  }
  if (options.expectedRecordingId !== undefined && recordingId !== options.expectedRecordingId) {
    throw new StoreError('STORE_INVALID_ID', 'manifest.recordingId does not match the recording directory', {
      recordingId: options.expectedRecordingId,
    })
  }

  const status = record['status']
  if (!isRecordingStatus(status)) {
    throw invalid(`manifest.status must be one of ${RECORDING_STATUSES.join(', ')}`, invalidCode, recordingId)
  }

  const driver = requireRecord(record['driver'], 'manifest.driver', invalidCode, recordingId)
  const browser = requireRecord(record['browser'], 'manifest.browser', invalidCode, recordingId)

  const manifest: {
    schemaVersion: typeof SCHEMA_VERSION
    recordingId: RecordingId
    title: string
    intent?: string
    status: RecordingStatus
    ownerSessionId: string
    driver: StoreDriverInfo
    browser: StoreBrowserInfo
    createdAt: string
    updatedAt: string
    completedAt?: string
    endReason?: EndReason
    consent?: RecordingConsent
    suppressedCount?: number
    lastSeq: number
    stepCount: number
    stepsSha256?: string
    assetRoot?: string
  } = {
    schemaVersion: SCHEMA_VERSION,
    recordingId,
    title: requireString(record['title'], 'manifest.title', invalidCode, recordingId),
    status,
    ownerSessionId: requireString(record['ownerSessionId'], 'manifest.ownerSessionId', invalidCode, recordingId),
    driver: {
      id: requireString(driver['id'], 'manifest.driver.id', invalidCode, recordingId),
      version: requireString(driver['version'], 'manifest.driver.version', invalidCode, recordingId),
      transport: requireString(driver['transport'], 'manifest.driver.transport', invalidCode, recordingId),
    },
    browser: {
      app: requireString(browser['app'], 'manifest.browser.app', invalidCode, recordingId),
      ...(browser['startUrl'] === undefined
        ? {}
        : { startUrl: requireString(browser['startUrl'], 'manifest.browser.startUrl', invalidCode, recordingId) }),
    },
    createdAt: requireString(record['createdAt'], 'manifest.createdAt', invalidCode, recordingId),
    updatedAt: requireString(record['updatedAt'], 'manifest.updatedAt', invalidCode, recordingId),
    lastSeq: requireNonNegativeInteger(record['lastSeq'], 'manifest.lastSeq', invalidCode, recordingId),
    stepCount: requireNonNegativeInteger(record['stepCount'], 'manifest.stepCount', invalidCode, recordingId),
  }
  if (record['intent'] !== undefined) {
    manifest.intent = requireString(record['intent'], 'manifest.intent', invalidCode, recordingId)
  }
  if (record['completedAt'] !== undefined) {
    manifest.completedAt = requireString(record['completedAt'], 'manifest.completedAt', invalidCode, recordingId)
  }
  if (record['endReason'] !== undefined) {
    const endReason = record['endReason']
    if (!isEndReason(endReason)) {
      throw invalid(`manifest.endReason must be one of ${END_REASONS.join(', ')}`, invalidCode, recordingId)
    }
    manifest.endReason = endReason
  }
  if (record['consent'] !== undefined) {
    manifest.consent = parseConsent(record['consent'], invalidCode, recordingId)
  }
  if (record['suppressedCount'] !== undefined) {
    manifest.suppressedCount = requireNonNegativeInteger(
      record['suppressedCount'],
      'manifest.suppressedCount',
      invalidCode,
      recordingId,
    )
  }
  if (record['stepsSha256'] !== undefined) {
    manifest.stepsSha256 = requireString(record['stepsSha256'], 'manifest.stepsSha256', invalidCode, recordingId)
  }
  if (record['assetRoot'] !== undefined) {
    manifest.assetRoot = requireString(record['assetRoot'], 'manifest.assetRoot', invalidCode, recordingId)
  }
  return manifest
}

export interface AssertStepEventOptions {
  /** 缺省 INVALID_ARGUMENT（写入口）；读盘/恢复时传 STORE_CORRUPT_JSONL。 */
  readonly invalidCode?: StoreErrorCode
}

/**
 * 校验并归一化一条步骤事件。
 *
 * 写入口（append）与读入口（readSteps / 恢复扫描）共用：读盘时形状非法按坏文件报，
 * 但不静默跳过；未知 schemaVersion 永远是 STORE_UNSUPPORTED_VERSION。
 */
export function assertStepEvent(value: unknown, options: AssertStepEventOptions = {}): StoreStepEvent {
  const invalidCode = options.invalidCode ?? 'INVALID_ARGUMENT'
  const record = requireRecord(value, 'step event', invalidCode)

  const rawVersion = record['schemaVersion']
  if (record['type'] === 'step.started') {
    if (typeof rawVersion !== 'number') {
      throw invalid('step.started schemaVersion must be a number', invalidCode)
    }
    if (!isSupportedSchemaVersion(rawVersion)) {
      throw new StoreError(
        'STORE_UNSUPPORTED_VERSION',
        `step event schemaVersion ${String(rawVersion)} is not supported`,
      )
    }
  } else if (rawVersion !== undefined) {
    // 兼容 plan 示例里带 schemaVersion 的 finished 行：校验后忽略，不改变 data-model 形状。
    if (typeof rawVersion !== 'number' || !isSupportedSchemaVersion(rawVersion)) {
      throw new StoreError(
        'STORE_UNSUPPORTED_VERSION',
        `step event schemaVersion ${String(rawVersion)} is not supported`,
      )
    }
  }

  const stepId = record['stepId']
  if (!isStepId(stepId)) {
    throw new StoreError('STORE_INVALID_ID', 'step event stepId is not a valid StepId')
  }
  const callId = requireString(record['callId'], 'step event callId', invalidCode, undefined, stepId)

  switch (record['type']) {
    case 'step.started': {
      const seq = record['seq']
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) {
        throw invalid('step.started seq must be a positive integer', invalidCode, undefined, stepId)
      }
      const origin = record['origin']
      if (origin !== 'agent' && origin !== 'replay' && origin !== 'internal') {
        throw invalid('step.started origin must be agent|replay|internal', invalidCode, undefined, stepId)
      }
      const action = record['action']
      if (!isBrowserAction(action)) {
        throw invalid('step.started action is not one of the six BrowserAction kinds', invalidCode, undefined, stepId)
      }
      const startedAt = record['startedAt']
      if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
        throw invalid('step.started startedAt must be a finite number', invalidCode, undefined, stepId)
      }
      return {
        type: 'step.started',
        schemaVersion: SCHEMA_VERSION,
        stepId,
        seq,
        callId,
        origin,
        action,
        startedAt,
      }
    }
    case 'step.finished': {
      const status = record['status']
      if (status !== 'success' && status !== 'error' && status !== 'cancelled') {
        throw invalid('step.finished status must be success|error|cancelled', invalidCode, undefined, stepId)
      }
      const finishedAt = record['finishedAt']
      const durationMs = record['durationMs']
      if (typeof finishedAt !== 'number' || !Number.isFinite(finishedAt)) {
        throw invalid('step.finished finishedAt must be a finite number', invalidCode, undefined, stepId)
      }
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
        throw invalid('step.finished durationMs must be a finite non-negative number', invalidCode, undefined, stepId)
      }
      const errorValue = record['error']
      if (errorValue !== undefined && !isPublicError(errorValue)) {
        throw invalid('step.finished error must be a PublicError', invalidCode, undefined, stepId)
      }
      const evidenceValue = record['evidence']
      let evidence: readonly string[] | undefined
      if (evidenceValue !== undefined) {
        if (!Array.isArray(evidenceValue)) {
          throw invalid('step.finished evidence must be an array of relative paths', invalidCode, undefined, stepId)
        }
        evidence = evidenceValue.map((entry, index) => {
          if (typeof entry !== 'string' || entry.length === 0) {
            throw invalid(
              `step.finished evidence[${String(index)}] must be a non-empty string`,
              invalidCode,
              undefined,
              stepId,
            )
          }
          return entry
        })
      }
      const finished: {
        type: 'step.finished'
        stepId: StepId
        callId: string
        status: 'success' | 'error' | 'cancelled'
        finishedAt: number
        durationMs: number
        resultSummary?: JsonValue
        error?: PublicError
        evidence?: readonly string[]
      } = {
        type: 'step.finished',
        stepId,
        callId,
        status,
        finishedAt,
        durationMs,
      }
      if (record['resultSummary'] !== undefined) {
        finished.resultSummary = record['resultSummary'] as JsonValue
      }
      if (errorValue !== undefined) {
        finished.error = errorValue
      }
      if (evidence !== undefined) {
        finished.evidence = evidence
      }
      return finished
    }
    default:
      throw invalid('step event type must be step.started or step.finished', invalidCode, undefined, stepId)
  }
}

/** 逻辑步骤的去重键：同 stepId + callId + type 不产生第二逻辑步骤（IF-4 幂等承诺）。 */
export function stepEventKey(event: StoreStepEvent): string {
  return `${event.stepId}\u0000${event.callId}\u0000${event.type}`
}

/** 判断 RunId 是否合法（导出/恢复里的 run 目录校验用）。 */
export function isSafeRunId(value: unknown): value is RunId {
  return isRunId(value)
}

// ---------------------------------------------------------------------------
// 内部校验小工具
// ---------------------------------------------------------------------------

function invalid(
  message: string,
  code: StoreErrorCode,
  recordingId?: RecordingId,
  stepId?: StepId,
): StoreError {
  return new StoreError(code, message, {
    ...(recordingId === undefined ? {} : { recordingId }),
    ...(stepId === undefined ? {} : { stepId }),
  })
}

function requireRecord(
  value: unknown,
  what: string,
  code: StoreErrorCode,
  recordingId?: RecordingId,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${what} must be an object`, code, recordingId)
  }
  return value as Readonly<Record<string, unknown>>
}

function requireString(
  value: unknown,
  what: string,
  code: StoreErrorCode,
  recordingId?: RecordingId,
  stepId?: StepId,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${what} must be a non-empty string`, code, recordingId, stepId)
  }
  return value
}

function requireNonNegativeInteger(
  value: unknown,
  what: string,
  code: StoreErrorCode,
  recordingId?: RecordingId,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`${what} must be a non-negative integer`, code, recordingId)
  }
  return value
}

/** 校验可选的录制同意记录；旧 Recording 没有该字段。 */
function parseConsent(
  value: unknown,
  invalidCode: StoreErrorCode,
  recordingId: RecordingId,
): RecordingConsent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('manifest.consent must be an object', invalidCode, recordingId)
  }
  const raw = value as Record<string, unknown>
  const mode = raw['mode']
  if (!isRecordingConsentMode(mode)) {
    throw invalid('manifest.consent.mode must be "implicit" or "explicit"', invalidCode, recordingId)
  }
  return {
    mode,
    scope: requireString(raw['scope'], 'manifest.consent.scope', invalidCode, recordingId),
    grantedAt: requireString(raw['grantedAt'], 'manifest.consent.grantedAt', invalidCode, recordingId),
    grantedBy: requireString(raw['grantedBy'], 'manifest.consent.grantedBy', invalidCode, recordingId),
  }
}
