/**
 * RecordingService（design/interfaces.md IF-3、design/backend.md 模块表 `recording/service`）。
 *
 * 职责边界：
 * - 录制生命周期：start 创建 writer 与幂等键、stop 等待写入队列落盘后完成、get/list 只读、
 *   readSteps 流式只读投影、subscribe 只读事件订阅；
 * - seq 分配：Recording 内 seq 从 1 单调递增，由本服务在持久化时分配（backend.md：
 *   recording/service 负责「录制生命周期、脱敏、seq 分配」）；取消/失败/重复都不复用序号；
 * - 脱敏：任何事件 append 前经过 Redactor（defaultRedactor，可注入替换）；
 * - 幂等：start 按 Principal.sessionId + idempotencyKey；重复事件按 stepId+callId+type 去重
 *   （Store 层同样有最后一道去重）；stop 幂等；
 * - read/list/subscribe 永不调用 BrowserDriver（FR-4 查询零动作）；
 * - V1 工作区粒度：同一时刻只允许一个活跃（recording 态）Recording；start 撞活跃 writer
 *   返回 RECORDING_LOCKED，事件接收方按「当前活跃 Recording」路由。
 *
 * 错误码：IF-3 命名 RECORDING_NOT_FOUND / RECORDING_LOCKED 不在 Core 的 ERROR_CODES 联合里，
 * 与 store/api 同款做法——本模块固定自己的服务级码表并收敛 StoreError；跨模块对外时由
 * Host 端口映射成其 DTO 语义（Host 的 getRecording 用 undefined 表达 NOT_FOUND）。
 */
import {
  SCHEMA_VERSION,
  assertRecordingId,
  newRecordingId as createRecordingId,
  type BrowserAction,
  type ErrorCode,
  type Principal,
  type RecordingId,
} from '../core/api.js'
import {
  DEFAULT_STORE_MAX_STEPS,
  StoreError,
  isTerminalRecordingStatus,
  type EndReason,
  type RecordingConsent,
  type RecordingStore,
  type RecordingStatus,
  type RecordingWriter,
  type StepCursor,
  type StoreManifest,
  type StoreStepEvent,
  type StoreStepFinished,
  type StoreStepStarted,
  type SuppressedReason,
  type SuppressedStepRecord,
} from '../store/api.js'
import { actionUrlCandidates, matchesDeniedUrl } from '../privacy/policy.js'
import { defaultRedactor, type Redactor } from './redaction.js'
import { projectStepStream, type ProjectedStep } from './projector.js'
import { assertInputStepEvent, stepEventKey, type RecordingStepEvent } from './schema.js'

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** IF-3 命名、但不在 Core/Store 码表里的服务级错误码（与 store/api 的 STORE_ERROR_CODES 同款做法）。 */
export const RECORDING_SERVICE_ONLY_CODES = ['RECORDING_NOT_FOUND', 'RECORDING_LOCKED'] as const
export type RecordingServiceOnlyCode = (typeof RECORDING_SERVICE_ONLY_CODES)[number]

/** RecordingService 错误码全集：Core 稳定码 + Store SPI 码 + 本服务级码。 */
export type RecordingServiceErrorCode = ErrorCode | StoreError['code'] | RecordingServiceOnlyCode

export class RecordingServiceError extends Error {
  readonly code: RecordingServiceErrorCode
  readonly recordingId?: RecordingId

  constructor(code: RecordingServiceErrorCode, message: string, options: { cause?: unknown; recordingId?: RecordingId } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RecordingServiceError'
    this.code = code
    if (options.recordingId !== undefined) this.recordingId = options.recordingId
  }
}

export function isRecordingServiceError(value: unknown): value is RecordingServiceError {
  return value instanceof RecordingServiceError
}

function fromStoreError(error: StoreError): RecordingServiceError {
  const code: RecordingServiceErrorCode =
    error.code === 'STORE_LOCKED' ? 'RECORDING_LOCKED' : error.code
  return new RecordingServiceError(code, error.message, {
    ...(error.recordingId === undefined ? {} : { recordingId: error.recordingId }),
    cause: error,
  })
}

function forbidden(recordingId: RecordingId): RecordingServiceError {
  return new RecordingServiceError('FORBIDDEN', 'principal does not own this recording', { recordingId })
}

function notFound(recordingId: RecordingId): RecordingServiceError {
  return new RecordingServiceError('RECORDING_NOT_FOUND', 'recording not found', { recordingId })
}

// ---------------------------------------------------------------------------
// DTO（interfaces.md：RecordingDescriptor = ID、标题、状态、步骤数、创建/更新时间）
// ---------------------------------------------------------------------------

export interface RecordingDescriptor {
  readonly recordingId: RecordingId
  readonly title: string
  /** User requirement / use-case text supplied at start; absent on older recordings. */
  readonly intent?: string
  readonly status: RecordingStatus
  readonly ownerSessionId: string
  readonly stepCount: number
  readonly lastSeq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt?: string
  /** 结束原因；录制中的 Recording 没有该字段。 */
  readonly endReason?: EndReason
  /** 录制同意记录；`recording.consent: off` 时不写。 */
  readonly consent?: RecordingConsent
  /** 因 URL 隐私策略被抑制、未写入 steps.jsonl 的步骤数。 */
  readonly suppressedCount?: number
  readonly driverId: string
  readonly browserApp: string
}

export interface RecordingQuery {
  /** 新增查询参数必须 optional（IF-3 兼容性承诺）。 */
  readonly status?: RecordingStatus
  /** 游标 = list 返回的 nextCursor（偏移编码）。 */
  readonly cursor?: string
  readonly limit?: number
}

export interface RecordingPage {
  readonly items: readonly RecordingDescriptor[]
  readonly nextCursor?: string
}

/** 只读订阅事件：Recording 生命周期 + 步骤投影更新。 */
export type RecordingViewEvent =
  | { readonly type: 'recording.started'; readonly recordingId: RecordingId; readonly descriptor: RecordingDescriptor }
  | { readonly type: 'step.started'; readonly recordingId: RecordingId; readonly step: ProjectedStep }
  | { readonly type: 'step.finished'; readonly recordingId: RecordingId; readonly step: ProjectedStep }
  | { readonly type: 'recording.completed'; readonly recordingId: RecordingId; readonly descriptor: RecordingDescriptor }

export interface StartRecordingInput {
  readonly title: string
  /** User requirement / use-case text persisted in the manifest; optional. */
  readonly intent?: string
  readonly driver: { readonly id: string; readonly version: string; readonly transport: string }
  readonly browser: { readonly app: string; readonly startUrl?: string }
  /**
   * 录制同意：`mode` 由 Host 配置决定（implicit/explicit），scope 是给人看的范围说明。
   * 服务负责补 grantedAt/grantedBy；缺省 = 旧调用方，不写 consent。
   */
  readonly consent?: { readonly mode: 'implicit' | 'explicit'; readonly scope: string }
  /** 幂等键：同 Principal + 同键的重复 start 返回同一个 Recording。 */
  readonly idempotencyKey?: string
}

export interface RecordingServiceOptions {
  /** IF-4 Store SPI（唯一持久化边界）。 */
  readonly store: RecordingStore
  /** 可注入 Redactor（IF-6 扩展点）；缺省 defaultRedactor。 */
  readonly redactor?: Redactor
  /** 步数硬上限（design：10,000）；超限停止新增并返回 RECORDING_LIMIT_EXCEEDED。 */
  readonly maxSteps?: number
  /** RecordingId 生成器（测试可注入）。 */
  readonly newRecordingId?: () => RecordingId
  /** 时钟（毫秒）；缺省 Date.now()。 */
  readonly clock?: () => number
  /**
   * 单个 Recording 的最长时长（秒），到点自动以 `max_duration` 收口。
   * 0 / 负数关闭；缺省 1800 秒（与参考实现的 30 分钟上限一致）。
   */
  readonly maxDurationSeconds?: number
  /** URL 排除规则（大小写不敏感子串）；命中后该步骤及其后步骤进入 suppressed.jsonl。 */
  readonly deniedUrlPatterns?: readonly string[]
}

const DEFAULT_LIST_LIMIT = 50
const DEFAULT_MAX_DURATION_SECONDS = 1800

// ---------------------------------------------------------------------------
// 活跃 Recording（进程内写侧状态）
// ---------------------------------------------------------------------------

interface ActiveRecording {
  readonly recordingId: RecordingId
  readonly ownerSessionId: string
  /** 自动停止回调要用的完整 Principal（stop 的所有权校验同源）。 */
  readonly principal: Principal
  readonly writer: RecordingWriter
  /** 到达 maxDurationSeconds 时触发；stop/discard 时清理。 */
  timer?: ReturnType<typeof setTimeout> | undefined
  /** 命中 URL 策略后保持 true，直到导航到未排除的 URL。 */
  urlBlocked: boolean
  /** 已抑制但尚未收到 finished 的 stepId+callId；finished 到达时丢弃。 */
  readonly suppressedPairs: Set<string>
  /** 已分配的最大 seq（下一个 started 用 lastSeq + 1）。 */
  lastSeq: number
  /** 已受理的事件去重键（stepId+callId+type）。 */
  readonly seen: Set<string>
  /** started 事件缓存（供 finished 投影取 seq/动作；大小 = 在途步骤数）。 */
  readonly pendingStarted: Map<string, StoreStepStarted>
  /** 写入串行链：stop 在此队列排空后才 close。 */
  tail: Promise<void>
  stopped: boolean
}

function activePairKey(stepId: string, callId: string): string {
  return `${stepId}${callId}`
}

// ---------------------------------------------------------------------------
// RecordingService
// ---------------------------------------------------------------------------

export class RecordingService {
  private readonly store: RecordingStore
  private readonly redactor: Redactor
  private readonly maxSteps: number
  private readonly newId: () => RecordingId
  private readonly clock: () => number
  private readonly maxDurationSeconds: number
  private readonly deniedUrlPatterns: readonly string[]
  /** V1 工作区粒度：同刻只允许一个活跃 Recording。 */
  private readonly active = new Map<RecordingId, ActiveRecording>()
  /** start 幂等表：principal.sessionId + idempotencyKey → recordingId。 */
  private readonly startedByKey = new Map<string, RecordingId>()
  private readonly listeners = new Map<RecordingId, Set<(event: RecordingViewEvent) => void>>()

  constructor(options: RecordingServiceOptions) {
    this.store = options.store
    this.redactor = options.redactor ?? defaultRedactor
    this.maxSteps = options.maxSteps ?? DEFAULT_STORE_MAX_STEPS
    this.newId = options.newRecordingId ?? createRecordingId
    this.clock = options.clock ?? (() => Date.now())
    this.maxDurationSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS
    if (!Number.isFinite(this.maxDurationSeconds) || this.maxDurationSeconds < 0) {
      throw new RecordingServiceError('INVALID_ARGUMENT', 'maxDurationSeconds must be a non-negative number')
    }
    const patterns = options.deniedUrlPatterns ?? []
    if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string')) {
      throw new RecordingServiceError('INVALID_ARGUMENT', 'deniedUrlPatterns must be an array of strings')
    }
    this.deniedUrlPatterns = patterns
  }

  // -- 生命周期 -----------------------------------------------------------

  /**
   * 开始录制：创建 writer 与幂等键。
   * 同 Principal.sessionId + 同 idempotencyKey 的重复调用返回已创建的 Recording（幂等）。
   */
  async start(input: StartRecordingInput, principal: Principal): Promise<RecordingDescriptor> {
    const title = input.title
    if (typeof title !== 'string' || title.length === 0) {
      throw new RecordingServiceError('INVALID_ARGUMENT', 'title must be a non-empty string')
    }
    const intent = input.intent === undefined ? undefined : input.intent.trim()
    if (intent !== undefined && intent.length === 0) {
      throw new RecordingServiceError('INVALID_ARGUMENT', 'intent must be a non-empty string when provided')
    }
    if (typeof input.driver?.id !== 'string' || input.driver.id.length === 0) {
      throw new RecordingServiceError('INVALID_ARGUMENT', 'driver.id must be a non-empty string')
    }
    if (typeof input.driver.version !== 'string' || input.driver.version.length === 0) {
      throw new RecordingServiceError('INVALID_ARGUMENT', 'driver.version must be a non-empty string')
    }
    if (typeof input.driver.transport !== 'string' || input.driver.transport.length === 0) {
      throw new RecordingServiceError('INVALID_ARGUMENT', 'driver.transport must be a non-empty string')
    }
    if (typeof input.browser?.app !== 'string' || input.browser.app.length === 0) {
      throw new RecordingServiceError('INVALID_ARGUMENT', 'browser.app must be a non-empty string')
    }
    const consent = normalizeConsent(input.consent)

    if (input.idempotencyKey !== undefined) {
      const existingId = this.startedByKey.get(`${principal.sessionId}${input.idempotencyKey}`)
      if (existingId !== undefined) {
        return this.get(existingId)
      }
    }

    const alive = [...this.active.values()].find((entry) => !entry.stopped)
    if (alive !== undefined) {
      throw new RecordingServiceError('RECORDING_LOCKED', 'another recording has an active writer', {
        recordingId: alive.recordingId,
      })
    }

    const now = new Date(this.clock()).toISOString()
    const manifest: StoreManifest = {
      schemaVersion: SCHEMA_VERSION,
      recordingId: this.newId(),
      title,
      ...(intent === undefined ? {} : { intent }),
      status: 'recording',
      ownerSessionId: principal.sessionId,
      driver: {
        id: input.driver.id,
        version: input.driver.version,
        transport: input.driver.transport,
      },
      browser: {
        app: input.browser.app,
        ...(input.browser.startUrl === undefined ? {} : { startUrl: input.browser.startUrl }),
      },
      createdAt: now,
      updatedAt: now,
      ...(consent === undefined
        ? {}
        : {
            consent: {
              mode: consent.mode,
              scope: consent.scope,
              grantedAt: now,
              grantedBy: principal.sessionId,
            },
          }),
      lastSeq: 0,
      stepCount: 0,
    }

    let writer: RecordingWriter
    try {
      writer = await this.store.open({ manifest })
    } catch (error) {
      throw error instanceof StoreError ? fromStoreError(error) : error
    }

    const entry: ActiveRecording = {
      recordingId: manifest.recordingId,
      ownerSessionId: principal.sessionId,
      principal,
      writer,
      lastSeq: 0,
      seen: new Set(),
      pendingStarted: new Map(),
      tail: Promise.resolve(),
      stopped: false,
      urlBlocked: false,
      suppressedPairs: new Set(),
    }
    this.active.set(manifest.recordingId, entry)
    this.scheduleAutoStop(entry)
    if (input.idempotencyKey !== undefined) {
      this.startedByKey.set(`${principal.sessionId}${input.idempotencyKey}`, manifest.recordingId)
    }

    const descriptor = descriptorFromManifest(writer.manifest)
    this.emit(manifest.recordingId, { type: 'recording.started', recordingId: manifest.recordingId, descriptor })
    return descriptor
  }

  /**
   * 停止录制：等待写入队列落盘后 close 为 completed（IF-3：stop 等待队列落盘后完成）。
   * 幂等：已终态的 Recording 重复 stop 返回当前描述；FORBIDDEN = 所有权不符。
   */
  async stop(
    id: RecordingId,
    principal: Principal,
    reason: 'tool_stopped' | 'max_duration' = 'tool_stopped',
  ): Promise<RecordingDescriptor> {
    assertRecordingId(id)
    const entry = this.active.get(id)
    if (entry !== undefined) {
      if (entry.ownerSessionId !== principal.sessionId) {
        throw forbidden(id)
      }
      if (!entry.stopped) {
        entry.stopped = true
        this.clearAutoStop(entry)
        await entry.tail
        let manifest: StoreManifest
        try {
          manifest = await entry.writer.close({ status: 'completed', endReason: reason })
        } catch (error) {
          throw error instanceof StoreError ? fromStoreError(error) : error
        } finally {
          this.active.delete(id)
        }
        const descriptor = descriptorFromManifest(manifest)
        this.emit(id, { type: 'recording.completed', recordingId: id, descriptor })
        return descriptor
      }
      this.active.delete(id)
    }

    // 非本进程活跃 writer：读盘判断幂等返回还是锁冲突。
    const manifest = await this.readManifestOrThrow(id)
    if (manifest.status === 'recording') {
      throw new RecordingServiceError('RECORDING_LOCKED', 'recording has an active writer owned elsewhere', {
        recordingId: id,
      })
    }
    return descriptorFromManifest(manifest)
  }

  /**
   * 主动丢弃当前 Recording：保留目录与步骤做审计，但状态置 `cancelled`，
   * 因此不可回放、不可生成 Skill；真正删除仍走面板回收站。
   */
  async discard(id: RecordingId, principal: Principal): Promise<RecordingDescriptor> {
    assertRecordingId(id)
    const entry = this.active.get(id)
    if (entry !== undefined) {
      if (entry.ownerSessionId !== principal.sessionId) {
        throw forbidden(id)
      }
      if (!entry.stopped) {
        entry.stopped = true
        this.clearAutoStop(entry)
        await entry.tail
        let manifest: StoreManifest
        try {
          manifest = await entry.writer.close({ status: 'cancelled', endReason: 'cancelled' })
        } catch (error) {
          throw error instanceof StoreError ? fromStoreError(error) : error
        } finally {
          this.active.delete(id)
        }
        const descriptor = descriptorFromManifest(manifest)
        this.emit(id, { type: 'recording.completed', recordingId: id, descriptor })
        return descriptor
      }
      this.active.delete(id)
    }

    const manifest = await this.readManifestOrThrow(id)
    if (manifest.status === 'recording') {
      throw new RecordingServiceError('RECORDING_LOCKED', 'recording has an active writer owned elsewhere', {
        recordingId: id,
      })
    }
    return descriptorFromManifest(manifest)
  }

  /** 到 maxDurationSeconds 自动收口；timer.unref() 不阻止进程退出。 */
  private scheduleAutoStop(entry: ActiveRecording): void {
    if (this.maxDurationSeconds <= 0) return
    const timer = setTimeout(() => {
      void this.stop(entry.recordingId, entry.principal, 'max_duration').catch(() => undefined)
    }, this.maxDurationSeconds * 1000)
    ;(timer as { unref?: () => void }).unref?.()
    entry.timer = timer
  }

  private clearAutoStop(entry: ActiveRecording): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  // -- 只读 ---------------------------------------------------------------

  async get(id: RecordingId): Promise<RecordingDescriptor> {
    assertRecordingId(id)
    return descriptorFromManifest(await this.readManifestOrThrow(id))
  }

  async list(query?: RecordingQuery): Promise<RecordingPage> {
    const all = await this.store.listRecordings()
    let items = all.map(descriptorFromManifest)
    if (query?.status !== undefined) {
      items = items.filter((item) => item.status === query.status)
    }
    const offset = decodeCursor(query?.cursor)
    const limit = normalizeLimit(query?.limit)
    const pageItems = items.slice(offset, offset + limit)
    const nextOffset = offset + pageItems.length
    const nextCursor = nextOffset < items.length ? String(nextOffset) : undefined
    return {
      items: pageItems,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
  }

  /** 流式只读投影：按游标续读，永不调用 BrowserDriver。 */
  async *readSteps(id: RecordingId, cursor?: StepCursor): AsyncIterable<ProjectedStep> {
    assertRecordingId(id)
    const manifest = await this.readManifestOrThrow(id)
    yield* projectStepStream(this.store.readSteps(id, cursor), {
      terminal: isTerminalRecordingStatus(manifest.status),
    })
  }

  /** 只读事件订阅；返回取消订阅函数。 */
  subscribe(id: RecordingId, listener: (event: RecordingViewEvent) => void): () => void {
    assertRecordingId(id)
    let set = this.listeners.get(id)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(id, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(id)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(id)
    }
  }

  // -- 写侧：OperationRunner 步骤事件接收方 --------------------------------

  /**
   * 步骤事件接收方（生产环境由 Host 把它接到 OperationRunner 的 OperationEventSink）。
   * 与 driver 事件结构兼容（schema.ts）：started 在此分配 seq，finished 原样配对。
   *
   * - 无活跃 Recording（录制未开启）时丢弃事件——录制是尽力而为的旁路，不阻塞执行；
   * - 重复事件（stepId+callId+type）不产生第二逻辑步骤，也不消耗 seq；
   * - 超限（RECORDING_LIMIT_EXCEEDED）在发送浏览器动作**之前**拒绝，调用方据此停止新增；
   * - 落盘失败（如 RECORDING_ALREADY_COMPLETED）原样上抛：Runner 不把半成品当成功。
   */
  record(event: RecordingStepEvent): Promise<void> {
    const entry = [...this.active.values()].find((candidate) => !candidate.stopped)
    if (entry === undefined) {
      return Promise.resolve()
    }

    const key = stepEventKey(event)
    if (entry.seen.has(key)) {
      return entry.tail
    }
    entry.seen.add(key)

    let inbound: RecordingStepEvent = event
    let candidateSeq: number | undefined
    if (event.type === 'step.started') {
      candidateSeq = entry.lastSeq + 1
      inbound = { ...event, seq: candidateSeq }
    }

    let validated: StoreStepEvent
    try {
      validated = assertInputStepEvent(inbound)
    } catch (error) {
      entry.seen.delete(key)
      return Promise.reject(error instanceof StoreError ? fromStoreError(error) : error)
    }

    if (validated.type === 'step.finished') {
      const pair = activePairKey(validated.stepId, validated.callId)
      // 被抑制的 started 已经写过 suppressed.jsonl；finished 只做配对清理，绝不落 steps.jsonl。
      if (entry.suppressedPairs.delete(pair)) {
        return entry.tail
      }
    }

    if (validated.type === 'step.started') {
      const decision = this.privacyDecision(entry, validated.action)
      if (decision.suppressed) {
        entry.suppressedPairs.add(activePairKey(validated.stepId, validated.callId))
        entry.urlBlocked = decision.blockedAfter
        const record: SuppressedStepRecord = {
          stepId: validated.stepId,
          callId: validated.callId,
          actionKind: validated.action.kind,
          reason: decision.reason,
          at: this.clock(),
        }
        entry.tail = entry.tail.then(async () => {
          await entry.writer.appendSuppressed(record)
        })
        return entry.tail
      }
      entry.urlBlocked = decision.blockedAfter
      if (candidateSeq === undefined || candidateSeq > this.maxSteps) {
        entry.seen.delete(key)
        return Promise.reject(
          new RecordingServiceError('RECORDING_LIMIT_EXCEEDED', 'recording step limit reached; stop adding new steps', {
            recordingId: entry.recordingId,
          }),
        )
      }
      entry.lastSeq = candidateSeq
    }

    const redacted = this.redactor.redactEvent(validated)
    if (redacted.type === 'step.started') {
      entry.pendingStarted.set(activePairKey(redacted.stepId, redacted.callId), redacted)
    }

    entry.tail = entry.tail.then(async () => {
      await entry.writer.append(redacted)
      if (redacted.type === 'step.started') {
        this.emit(entry.recordingId, {
          type: 'step.started',
          recordingId: entry.recordingId,
          step: openStepProjection(redacted),
        })
      } else {
        const started = entry.pendingStarted.get(activePairKey(redacted.stepId, redacted.callId))
        entry.pendingStarted.delete(activePairKey(redacted.stepId, redacted.callId))
        this.emit(entry.recordingId, {
          type: 'step.finished',
          recordingId: entry.recordingId,
          step: finishedStepProjection(started, redacted),
        })
      }
    })
    return entry.tail
  }

  // -- 内部 ---------------------------------------------------------------

  /**
   * 隐私判定：navigate 到排除 URL → 抑制并进入 blocked；blocked 期间所有步骤持续抑制，
   * 直到下一次 navigate 到未排除的 URL。目标带 URL 的步骤命中排除项时同样进入 blocked。
   */
  private privacyDecision(
    entry: ActiveRecording,
    action: BrowserAction,
  ): { readonly suppressed: boolean; readonly blockedAfter: boolean; readonly reason: SuppressedReason } {
    if (this.deniedUrlPatterns.length === 0) {
      return { suppressed: false, blockedAfter: false, reason: 'url_excluded' }
    }
    const denied = actionUrlCandidates(action).some(url => matchesDeniedUrl(url, this.deniedUrlPatterns))
    if (action.kind === 'navigate') {
      return denied
        ? { suppressed: true, blockedAfter: true, reason: 'url_excluded' }
        : { suppressed: false, blockedAfter: false, reason: 'url_excluded' }
    }
    if (denied) {
      return { suppressed: true, blockedAfter: true, reason: 'url_excluded' }
    }
    if (entry.urlBlocked) {
      return { suppressed: true, blockedAfter: true, reason: 'url_blocked' }
    }
    return { suppressed: false, blockedAfter: false, reason: 'url_excluded' }
  }

  private async readManifestOrThrow(id: RecordingId): Promise<StoreManifest> {
    try {
      return await this.store.readManifest(id)
    } catch (error) {
      if (error instanceof StoreError && error.code === 'RECORDING_NOT_FOUND') {
        throw notFound(id)
      }
      throw error instanceof StoreError ? fromStoreError(error) : error
    }
  }

  private emit(recordingId: RecordingId, event: RecordingViewEvent): void {
    const set = this.listeners.get(recordingId)
    if (set === undefined) return
    for (const listener of set) {
      try {
        listener(event)
      } catch {
        // 订阅方异常不影响录制主流程。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 投影小工具（订阅事件用：与 projector 的 running/finished 视图保持一致）
// ---------------------------------------------------------------------------

function openStepProjection(started: StoreStepStarted): ProjectedStep {
  return {
    stepId: started.stepId,
    seq: started.seq,
    callId: started.callId,
    origin: started.origin,
    actionKind: started.action.kind,
    action: started.action,
    status: 'running',
    startedAt: started.startedAt,
  }
}

function finishedStepProjection(started: StoreStepStarted | undefined, finished: StoreStepFinished): ProjectedStep {
  if (started === undefined) {
    // finished 没有匹配的 started：按事件原样投影（seq 未知，排尾）。
    return {
      stepId: finished.stepId,
      seq: Number.MAX_SAFE_INTEGER,
      callId: finished.callId,
      origin: 'internal',
      actionKind: 'wait',
      action: { kind: 'wait', condition: { kind: 'idle', quietMs: 1 }, timeoutMs: 1 },
      status: finished.status,
      startedAt: finished.finishedAt - finished.durationMs,
      finishedAt: finished.finishedAt,
      durationMs: finished.durationMs,
      ...(finished.resultSummary === undefined ? {} : { resultSummary: finished.resultSummary }),
      ...(finished.error === undefined ? {} : { error: finished.error }),
      ...(finished.evidence === undefined ? {} : { evidence: finished.evidence }),
    }
  }
  return {
    stepId: started.stepId,
    seq: started.seq,
    callId: started.callId,
    origin: started.origin,
    actionKind: started.action.kind,
    action: started.action,
    status: finished.status,
    startedAt: started.startedAt,
    finishedAt: finished.finishedAt,
    durationMs: finished.durationMs,
    ...(finished.resultSummary === undefined ? {} : { resultSummary: finished.resultSummary }),
    ...(finished.error === undefined ? {} : { error: finished.error }),
    ...(finished.evidence === undefined ? {} : { evidence: finished.evidence }),
  }
}

function descriptorFromManifest(manifest: StoreManifest): RecordingDescriptor {
  return {
    recordingId: manifest.recordingId,
    title: manifest.title,
    ...(manifest.intent === undefined ? {} : { intent: manifest.intent }),
    status: manifest.status,
    ownerSessionId: manifest.ownerSessionId,
    stepCount: manifest.stepCount,
    lastSeq: manifest.lastSeq,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    ...(manifest.completedAt === undefined ? {} : { completedAt: manifest.completedAt }),
    ...(manifest.endReason === undefined ? {} : { endReason: manifest.endReason }),
    ...(manifest.consent === undefined ? {} : { consent: manifest.consent }),
    ...(manifest.suppressedCount === undefined ? {} : { suppressedCount: manifest.suppressedCount }),
    driverId: manifest.driver.id,
    browserApp: manifest.browser.app,
  }
}

/** 校验 start 的同意入参；缺省 = 旧调用方不写 consent。 */
function normalizeConsent(
  input: { readonly mode: 'implicit' | 'explicit'; readonly scope: string } | undefined,
): { readonly mode: 'implicit' | 'explicit'; readonly scope: string } | undefined {
  if (input === undefined) return undefined
  if (input.mode !== 'implicit' && input.mode !== 'explicit') {
    throw new RecordingServiceError('INVALID_ARGUMENT', 'consent.mode must be "implicit" or "explicit"')
  }
  const scope = input.scope.trim()
  if (scope.length === 0 || scope.length > 200) {
    throw new RecordingServiceError('INVALID_ARGUMENT', 'consent.scope must be 1-200 characters')
  }
  return { mode: input.mode, scope }
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const value = Number.parseInt(cursor, 10)
  if (!Number.isInteger(value) || value < 0) {
    throw new RecordingServiceError('INVALID_ARGUMENT', 'cursor must be a non-negative integer encoded as string')
  }
  return value
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RecordingServiceError('INVALID_ARGUMENT', 'limit must be a positive integer')
  }
  return limit
}
