/**
 * Host 应用服务（design/interfaces.md IF-7：`ctx.cuaRecordReplay` 的服务侧用例）。
 *
 * 职责：
 * - 把 Agent 工具与 Remote 收敛到同一批用例：绑定/观察/执行/取消/只读查询/回放控制；
 * - Principal 一律从 Host 执行上下文派生，工具参数里的身份键直接被拒绝；
 * - 开关默认关闭：执行类用例未开启时返回 `FEATURE_DISABLED`，回放启动同样受开关约束；
 * - 每个逻辑动作经 OperationRunner 产出 started/finished（取消、错误归一、审计都在那里）；
 * - 只读查询返回 Public DTO：不含 Cua 句柄、绝对路径、Cookie 或上游 payload，并再次按
 *   Principal 过滤（Host 负责权限过滤，UI 不做所有权判断）；
 * - Recording/Replay 的生命周期实现属于 t6/t8，本服务通过端口注入，不在此重复实现。
 */
import { randomUUID } from 'node:crypto'

import {
  assertRecordingId,
  assertRunId,
  createPublicError,
  isBrowserAction,
  type BrowserAction,
  type BrowserActionKind,
  type ErrorCode,
  type OperationContext,
  type Origin,
  type Principal,
  type RecordingId,
  type RunId,
  type StepId,
} from '../core/api.js'
import {
  DEFAULT_LAUNCH_MODE,
  isProfileName,
  type DesktopLaunchMode,
  type ExistingLaunchMode,
  type IsolatedLaunchMode,
  type LaunchMode,
  type WindowTarget,
} from '../core/contracts.js'
import type { BindBrowserInput, BrowserBinding, BrowserDriver, Observation } from '../driver/api.js'
import { OperationRunner, type OperationOutcome } from '../driver/operation-runner.js'
import { HostError, assertFeatureEnabled, type HostConfig } from './config.js'
import { isPrivateBrowserTitle } from '../privacy/policy.js'
import { assertNoCallerSuppliedPrincipal, derivePrincipal, type HostCallContext } from './principal.js'

// ---------------------------------------------------------------------------
// 只读 DTO（Public DTO：ID / 状态 / 摘要 / 相对证据路径，不含运行期对象）
// ---------------------------------------------------------------------------

export type RecordingStatus = 'recording' | 'completed' | 'failed' | 'interrupted' | 'cancelled'

export type StepViewStatus = 'running' | 'success' | 'error' | 'cancelled' | 'interrupted'

export type RunStatus = 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface RecordingSummary {
  readonly recordingId: RecordingId
  readonly title: string
  /** User requirement / use-case text; absent on recordings started without one. */
  readonly intent?: string
  readonly status: RecordingStatus
  /** 结束原因；录制中的 Recording 没有该字段。 */
  readonly endReason?: 'tool_stopped' | 'max_duration' | 'cancelled' | 'failed' | 'interrupted'
  readonly ownerSessionId: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly stepCount: number
  /** Steps suppressed by the URL privacy policy; absent on older recordings. */
  readonly suppressedCount?: number
  readonly lastSeq: number
  readonly driverId?: string
  readonly browserApp?: string
}

/** 一个逻辑步骤的只读投影（started/finished 已配对，running 表示尚未收到 finished）。 */
export interface RecordingStep {
  readonly stepId: StepId
  readonly seq: number
  readonly status: StepViewStatus
  readonly actionKind: BrowserActionKind
  readonly startedAt: number
  readonly finishedAt?: number
  readonly durationMs?: number
  readonly url?: string
  readonly targetSummary?: string
  /** 已由投影层脱敏的稳定错误码与建议文本。 */
  readonly errorCode?: ErrorCode
  readonly errorMessage?: string
  /** 本次回放的 WebM 录屏路径（开启 replay.video 时）。 */
  readonly videoPath?: string
}

export interface RunSummary {
  readonly runId: RunId
  readonly recordingId: RecordingId
  readonly status: RunStatus
  readonly ownerSessionId: string
  readonly driverId?: string
  readonly driverVersion?: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly stepCount?: number
  readonly failedStepId?: StepId
  readonly recordingSha256?: string
  readonly errorCode?: ErrorCode
  readonly errorMessage?: string
}

export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor?: string
}

export interface PageQuery {
  readonly cursor?: string
  readonly limit?: number
}

export interface RecordingListQuery extends PageQuery {
  readonly status?: RecordingStatus
}

export interface StepListQuery extends PageQuery {
  readonly status?: StepViewStatus
}

export interface RunListQuery extends PageQuery {
  readonly recordingId?: RecordingId
  readonly status?: RunStatus
}

export type ReplayTarget =
  | { readonly launch?: ExistingLaunchMode; readonly pid: number; readonly windowId: number }
  | { readonly launch: IsolatedLaunchMode; readonly profileName?: string }
  | { readonly launch: DesktopLaunchMode; readonly pid: number; readonly windowId: number }

export interface StartReplayInput {
  readonly recordingId: RecordingId
  readonly idempotencyKey?: string
  /** Replay 的新浏览器目标；缺省时由 ReplayPort 决定（插件实现要求显式提供）。 */
  readonly target?: ReplayTarget
  /** 回放输入值：stepId 或 secretRef → 明文；只存在于进程内，不落盘。 */
  readonly values?: Readonly<Record<string, string>>
  /** 覆盖录制里 navigate 的源站（保留 path），例如每次启动都变的 DSH GUI 端口。 */
  readonly baseUrl?: string
  /**
   * Run 创建后回调（在步骤执行前、同步调用）：调用方拿到 runId 才能 `cancelRun`。
   * 套件超时依赖它中止在途 Run。
   */
  readonly onRunStarted?: (runId: RunId) => void
}

/** 执行类用例的稳定结果（Agent 工具直接返回它）。 */
export type BindBrowserRequest = WindowTarget

export interface BindingSummary {
  readonly bound: true
  readonly driverId: string
  readonly sessionId: string
  readonly pid: number
  readonly windowId: number
  readonly launch: LaunchMode
}

export interface ObservationElementDto {
  readonly role: string
  readonly name?: string
  readonly value?: string
}

/** 观察结果只暴露语义信息：ref/observationId 是 Driver 私有句柄，不进 DTO。 */
export interface ObservationDto {
  readonly url: string
  readonly title?: string
  readonly elements: readonly ObservationElementDto[]
}

export interface ActionReceipt {
  readonly stepId: StepId
  readonly status: 'success'
  readonly durationMs: number
  readonly summary?: string
}

// ---------------------------------------------------------------------------
// t6/t8 提供的端口（Host 是组合根，不重复实现生命周期）
// ---------------------------------------------------------------------------

/** RecordingService 的只读侧（t6 实现；Host 只消费公开投影）。 */
export interface RecordingReadPort {
  listRecordings(principal: Principal, query: RecordingListQuery): Promise<Page<RecordingSummary>>
  getRecording(recordingId: RecordingId, principal: Principal): Promise<RecordingSummary | undefined>
  listSteps(recordingId: RecordingId, principal: Principal, query: StepListQuery): Promise<Page<RecordingStep>>
}

/** ReplayService 的宿主侧（t8 实现；Host 负责开关、所有权与 DTO）。 */
export interface ReplayPort {
  listRuns(principal: Principal, query: RunListQuery): Promise<Page<RunSummary>>
  getRun(runId: RunId, principal: Principal): Promise<RunSummary | undefined>
  startReplay(input: StartReplayInput, principal: Principal): Promise<RunSummary>
  cancelRun(runId: RunId, principal: Principal): Promise<RunSummary>
}

export interface CuaRecordReplayServiceOptions {
  readonly config: HostConfig
  readonly driver: BrowserDriver
  readonly runner: OperationRunner
  readonly recordings?: RecordingReadPort
  readonly replay?: ReplayPort
  readonly clock?: () => number
  readonly newCallId?: () => string
}

const MAX_QUERY_LIMIT = 200

const RECORDING_STATUSES: readonly RecordingStatus[] = ['recording', 'completed', 'failed', 'interrupted', 'cancelled']
const STEP_STATUSES: readonly StepViewStatus[] = ['running', 'success', 'error', 'cancelled', 'interrupted']
const RUN_STATUSES: readonly RunStatus[] = ['preparing', 'running', 'completed', 'failed', 'cancelled']
const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

export class CuaRecordReplayService {
  private readonly config: HostConfig
  private readonly driver: BrowserDriver
  private readonly runner: OperationRunner
  private readonly recordings: RecordingReadPort | undefined
  private readonly replay: ReplayPort | undefined
  private readonly clock: () => number
  private readonly newCallId: () => string
  private readonly bindings = new Map<string, BrowserBinding>()
  private readonly controllers = new Map<string, Set<AbortController>>()
  private disposed = false

  constructor(options: CuaRecordReplayServiceOptions) {
    this.config = options.config
    this.driver = options.driver
    this.runner = options.runner
    this.recordings = options.recordings
    this.replay = options.replay
    this.clock = options.clock ?? (() => Date.now())
    this.newCallId = options.newCallId ?? (() => `call_${randomUUID().replaceAll('-', '')}`)
  }

  /** 当前有两个 Session 持有绑定的数量（诊断用，不暴露绑定句柄）。 */
  get boundSessionCount(): number {
    return this.bindings.size
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  // -------------------------------------------------------------------------
  // 执行类用例
  // -------------------------------------------------------------------------

  /** 绑定本 Session 的浏览器窗口；同一 Session 重复绑定会先释放旧绑定。 */
  async bindBrowser(input: BindBrowserRequest, call: HostCallContext): Promise<BindingSummary> {
    assertFeatureEnabled(this.config, 'recording')
    this.assertNotDisposed()
    const principal = derivePrincipal(call.exec)
    assertNoCallerSuppliedPrincipal(input, 'input')
    const launch = input.launch ?? DEFAULT_LAUNCH_MODE
    if (launch === 'desktop') {
      assertPositiveInteger(input.pid, 'pid')
      assertPositiveInteger(input.windowId, 'windowId')
    } else if (launch === 'existing') {
      assertPositiveInteger(input.pid, 'pid')
      assertPositiveInteger(input.windowId, 'windowId')
    } else {
      if (input.pid !== undefined || input.windowId !== undefined) {
        throw new HostError('INVALID_ARGUMENT', 'pid and windowId must be omitted when launch is "isolated"')
      }
      if (input.profileName !== undefined) {
        if (launch !== 'isolated') {
          throw new HostError('INVALID_ARGUMENT', 'profileName requires launch "isolated"')
        }
        if (!isProfileName(input.profileName)) {
          throw new HostError('INVALID_ARGUMENT', 'profileName must be 1-64 path-safe ASCII characters [A-Za-z0-9._-]')
        }
      }
    }

    const previous = this.bindings.get(principal.sessionId)
    if (previous !== undefined) {
      // 重新绑定前先释放旧绑定；释放失败说明旧资源已不可用，不能让新绑定被它拖住
      // （Driver 自己的 bind 也会清掉同一 Session 的旧记录，这里只负责本地映射）。
      this.bindings.delete(principal.sessionId)
      await this.driver.release(previous).catch(() => undefined)
    }

    const bindInput = launch === 'isolated'
      ? {
          launch: 'isolated' as const,
          ...(input.profileName === undefined ? {} : { profileName: input.profileName }),
        }
      : launch === 'desktop'
        ? { launch: 'desktop' as const, pid: input.pid as number, windowId: input.windowId as number }
        : { launch: 'existing' as const, pid: input.pid as number, windowId: input.windowId as number }
    const binding = await this.withController(principal, call, controller =>
      this.driver.bind(bindInput, this.createContext(principal, call, 'agent', controller)),
    )
    if (this.config.recording.privacy.blockPrivateBrowsing && isPrivateBrowserTitle(binding.title)) {
      await this.driver.release(binding).catch(() => undefined)
      throw new HostError(
        'FORBIDDEN',
        'private browsing windows are excluded from recording; use a normal window or launch: "isolated"',
      )
    }
    this.bindings.set(principal.sessionId, binding)
    return {
      bound: true,
      driverId: binding.driverId,
      sessionId: principal.sessionId,
      pid: binding.pid,
      windowId: binding.windowId,
      launch,
    }
  }

  /** 观察当前页面（只读，不产生步骤事件；ref 等句柄不出 Driver 边界）。 */
  async observe(call: HostCallContext): Promise<ObservationDto> {
    assertFeatureEnabled(this.config, 'recording')
    this.assertNotDisposed()
    const principal = derivePrincipal(call.exec)
    const binding = this.requireBinding(principal)
    const observation = await this.withController(principal, call, controller =>
      this.driver.observe(binding, this.createContext(principal, call, 'agent', controller)),
    )
    return toObservationDto(observation)
  }

  /**
   * 执行一个语义动作：经 OperationRunner 产出 started/finished，动作失败以稳定错误码抛出。
   * 动作参数里的身份键一律拒绝（Principal 只能来自 exec）。
   */
  async performAction(action: BrowserAction, call: HostCallContext): Promise<ActionReceipt> {
    assertFeatureEnabled(this.config, 'recording')
    this.assertNotDisposed()
    const principal = derivePrincipal(call.exec)
    assertNoCallerSuppliedPrincipal(action, 'action')
    if (!isBrowserAction(action)) {
      throw new HostError('INVALID_ARGUMENT', 'action is not one of the six BrowserAction kinds')
    }
    const binding = this.requireBinding(principal)

    const outcome = await this.withController(principal, call, controller =>
      this.runner.run({
        binding,
        action,
        context: this.createContext(principal, call, 'agent', controller),
      }),
    )
    return toReceipt(outcome)
  }

  /** 释放本 Session 的绑定；幂等，且不受开关影响（关闭功能也要能清理资源）。 */
  async releaseBrowser(call: HostCallContext): Promise<{ readonly released: boolean }> {
    const principal = derivePrincipal(call.exec)
    const binding = this.bindings.get(principal.sessionId)
    if (binding === undefined) return { released: false }
    this.bindings.delete(principal.sessionId)
    await this.driver.release(binding)
    return { released: true }
  }

  /** 取消本 Session 的在途动作（幂等；只停新动作，不承诺回滚已发送写动作）。 */
  async cancelOperations(call: HostCallContext): Promise<{ readonly cancelled: number }> {
    const principal = derivePrincipal(call.exec)
    const controllers = this.controllers.get(principal.sessionId)
    if (controllers === undefined) return { cancelled: 0 }

    let cancelled = 0
    for (const controller of [...controllers]) {
      if (controller.signal.aborted) continue
      cancelled += 1
      controller.abort(createPublicError('OPERATION_CANCELLED', 'Operation was cancelled by the session owner'))
    }
    return { cancelled }
  }

  // -------------------------------------------------------------------------
  // 只读查询（不依赖开关：Cua/执行不可用时历史仍可读）
  // -------------------------------------------------------------------------

  async listRecordings(
    query: RecordingListQuery | undefined,
    call: HostCallContext,
  ): Promise<Page<RecordingSummary>> {
    const principal = derivePrincipal(call.exec)
    const normalized: RecordingListQuery = {
      ...normalizePageQuery(query ?? {}),
      ...(query?.status === undefined ? {} : { status: normalizeEnum(query.status, RECORDING_STATUSES, 'status') }),
    }
    if (this.recordings === undefined) return { items: [] }
    return filterOwned(principal, await this.recordings.listRecordings(principal, normalized))
  }

  async getRecording(
    recordingId: RecordingId,
    call: HostCallContext,
  ): Promise<RecordingSummary | undefined> {
    const principal = derivePrincipal(call.exec)
    assertRecordingId(recordingId)
    if (this.recordings === undefined) return undefined
    return ownedBy(principal, await this.recordings.getRecording(recordingId, principal))
  }

  async listSteps(
    recordingId: RecordingId,
    query: StepListQuery | undefined,
    call: HostCallContext,
  ): Promise<Page<RecordingStep>> {
    const principal = derivePrincipal(call.exec)
    assertRecordingId(recordingId)
    const normalized: StepListQuery = {
      ...normalizePageQuery(query ?? {}),
      ...(query?.status === undefined ? {} : { status: normalizeEnum(query.status, STEP_STATUSES, 'status') }),
    }
    if (this.recordings === undefined) return { items: [] }
    // 权限过滤由 Host 负责：先确认 Recording 属于本 Session，再读取步骤（前端不做所有权判断）。
    const recording = await this.recordings.getRecording(recordingId, principal)
    if (recording === undefined || recording.ownerSessionId !== principal.sessionId) {
      return { items: [] }
    }
    return await this.recordings.listSteps(recordingId, principal, normalized)
  }

  async listRuns(query: RunListQuery | undefined, call: HostCallContext): Promise<Page<RunSummary>> {
    const principal = derivePrincipal(call.exec)
    const normalized: RunListQuery = {
      ...normalizePageQuery(query ?? {}),
      ...(query?.recordingId === undefined ? {} : { recordingId: assertRecordingId(query.recordingId) }),
      ...(query?.status === undefined ? {} : { status: normalizeEnum(query.status, RUN_STATUSES, 'status') }),
    }
    if (this.replay === undefined) return { items: [] }
    return filterOwned(principal, await this.replay.listRuns(principal, normalized))
  }

  async getRun(runId: RunId, call: HostCallContext): Promise<RunSummary | undefined> {
    const principal = derivePrincipal(call.exec)
    assertRunId(runId)
    if (this.replay === undefined) return undefined
    return ownedBy(principal, await this.replay.getRun(runId, principal))
  }

  // -------------------------------------------------------------------------
  // 回放控制（IF-5 的实现由 t8 提供；Host 负责开关、所有权与 DTO 边界）
  // -------------------------------------------------------------------------

  /** 启动一次真实回放；回放开关关闭时返回 `FEATURE_DISABLED`。 */
  async startReplay(input: StartReplayInput, call: HostCallContext): Promise<RunSummary> {
    assertFeatureEnabled(this.config, 'replay')
    this.assertNotDisposed()
    const principal = derivePrincipal(call.exec)
    const recordingId = assertRecordingId(input.recordingId)
    const port = this.requireReplayPort()

    const run = await port.startReplay({
      recordingId,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.values === undefined ? {} : { values: input.values }),
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      ...(input.onRunStarted === undefined ? {} : { onRunStarted: input.onRunStarted }),
    }, principal)
    if (run.ownerSessionId !== principal.sessionId) {
      throw new HostError('FORBIDDEN', 'The replay port returned a run owned by another session')
    }
    return run
  }

  /**
   * 取消一次回放；终态 Run 原样返回（幂等），不属于本 Session 的 Run 一律 `FORBIDDEN`。
   * 取消是收敛动作，不受 replay 开关拦截（避免关闭开关后无法停止在途 Run）。
   */
  async cancelRun(runId: RunId, call: HostCallContext): Promise<RunSummary> {
    const principal = derivePrincipal(call.exec)
    const id = assertRunId(runId)
    const port = this.requireReplayPort()

    const run = await port.getRun(id, principal)
    if (run === undefined || run.ownerSessionId !== principal.sessionId) {
      throw new HostError('FORBIDDEN', 'The authenticated session does not own this run')
    }
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return run
    return port.cancelRun(id, principal)
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 停止新动作、取消在途动作、等待收尾并释放全部 Binding；幂等。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.runner.stop()

    for (const controllers of [...this.controllers.values()]) {
      for (const controller of [...controllers]) {
        if (!controller.signal.aborted) {
          controller.abort(createPublicError('OPERATION_CANCELLED', 'Host service is being disposed'))
        }
      }
    }
    this.controllers.clear()
    await this.runner.drain()

    const bindings = [...this.bindings.values()]
    this.bindings.clear()
    await Promise.allSettled(bindings.map(binding => this.driver.release(binding)))
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new HostError('OPERATION_CANCELLED', 'Host service is disposed; no new browser action is sent')
    }
  }

  private requireBinding(principal: Principal): BrowserBinding {
    const binding = this.bindings.get(principal.sessionId)
    if (binding === undefined) {
      throw new HostError('BROWSER_BINDING_STALE', 'No browser binding for this session; bind a browser window first')
    }
    return binding
  }

  private requireReplayPort(): ReplayPort {
    if (this.replay === undefined) {
      throw new HostError('FEATURE_DISABLED', 'The replay service is not composed in this runtime')
    }
    return this.replay
  }

  private createContext(
    principal: Principal,
    call: HostCallContext,
    origin: Origin,
    controller: AbortController,
  ): OperationContext {
    return {
      principal,
      callId: call.callId ?? this.newCallId(),
      origin,
      signal: controller.signal,
    }
  }

  /**
   * 为一次调用创建可取消上下文：链接 Host 提供的 AbortSignal，并登记到 Session 的活跃集合，
   * 使 `cancelOperations` 只能取消**本 Session** 的动作（多 Session 隔离，FR-2）。
   */
  private async withController<T>(
    principal: Principal,
    call: HostCallContext,
    run: (controller: AbortController) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const external = call.signal
    let removeAbortListener: (() => void) | undefined
    if (external !== undefined) {
      if (external.aborted) {
        controller.abort(external.reason)
      } else {
        const onAbort = (): void => controller.abort(external.reason)
        external.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => external.removeEventListener('abort', onAbort)
      }
    }

    const sessionId = principal.sessionId
    const active = this.controllers.get(sessionId) ?? new Set<AbortController>()
    active.add(controller)
    this.controllers.set(sessionId, active)

    try {
      return await run(controller)
    } finally {
      removeAbortListener?.()
      active.delete(controller)
      if (active.size === 0) this.controllers.delete(sessionId)
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

function toObservationDto(observation: Observation): ObservationDto {
  return {
    url: observation.url,
    ...(observation.title === undefined ? {} : { title: observation.title }),
    elements: observation.elements.map(element => ({
      role: element.role,
      ...(element.name === undefined ? {} : { name: element.name }),
      ...(element.value === undefined ? {} : { value: element.value }),
    })),
  }
}

function toReceipt(outcome: OperationOutcome): ActionReceipt {
  if (outcome.status !== 'success') {
    // 失败与取消都以稳定错误码抛出；动作结果未知绝不自动重试。
    throw outcome.error ?? createPublicError('INVALID_ARGUMENT', 'Operation failed without a stable error code', {
      stepId: outcome.stepId,
    })
  }
  return {
    stepId: outcome.stepId,
    status: 'success',
    durationMs: outcome.durationMs,
    ...(outcome.result?.summary === undefined ? {} : { summary: outcome.result.summary }),
  }
}

function filterOwned<T extends { readonly ownerSessionId: string }>(
  principal: Principal,
  page: Page<T>,
): Page<T> {
  return {
    items: page.items.filter(item => item.ownerSessionId === principal.sessionId),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  }
}

function ownedBy<T extends { readonly ownerSessionId: string }>(
  principal: Principal,
  value: T | undefined,
): T | undefined {
  return value !== undefined && value.ownerSessionId === principal.sessionId ? value : undefined
}

function normalizePageQuery(query: PageQuery): PageQuery {
  const limit = query.limit
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
      throw new HostError('INVALID_ARGUMENT', `limit must be an integer in 1..${String(MAX_QUERY_LIMIT)}`)
    }
  }
  const cursor = query.cursor
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0)) {
    throw new HostError('INVALID_ARGUMENT', 'cursor must be a non-empty string')
  }
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  }
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new HostError('INVALID_ARGUMENT', `${field} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HostError('INVALID_ARGUMENT', `${field} must be a positive integer`)
  }
}
