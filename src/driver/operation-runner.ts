/**
 * OperationRunner：所有语义浏览器动作的唯一执行入口（design/interfaces.md IF-2 / IF-7、
 * design/backend.md「driver/operation-runner：步骤开始/结束、审计、取消和错误归一」）。
 *
 * 责任边界：
 * - 每个逻辑动作分配一个 stepId，并且**恰好**产出一对 `step.started` / `step.finished`
 *   （design/data-model.md 的不变量；只留 finished 无法区分“尚未开始”和“已开始但崩溃”）；
 * - 发动作前先落 `step.started`：录制写入失败时停止执行，不把半成品当成功；
 * - 观察/解析属于同一逻辑动作的一部分：只有 click / setValue / scroll / key 的语义目标才
 *   触发 observe + resolve，这些读取不单独成为步骤；
 * - 取消只表示“不再发送新动作”，不表示已发送动作被回滚（IF-1 的 OPERATION_CANCELLED 语义）；
 * - 错误统一收敛成 Core 的稳定错误码与脱敏后的 PublicError；
 * - 写动作结果未知时绝不自动重发：唯一允许的重试是**发动作前**观测失效（TARGET_STALE）时的
 *   一次刷新，动作一旦发出就不再重试（IF-1 元数据：动作未发送前允许一次重绑，结果未知则停止）。
 *
 * 事件形状与 design/data-model.md 的 StepStarted / StepFinished 逐字段一致；`seq` 由注入的
 * 分配器给出（RecordingService 在持久化时拥有 Recording 内的 seq 分配，见 backend.md 模块表），
 * 未注入时 Runner 自增，便于在没有 Store 的单元测试里断言配对与顺序。
 */
import {
  SCHEMA_VERSION,
  createPublicError,
  isBrowserAction,
  newStepId as createStepId,
  toPublicError,
  type BrowserAction,
  type JsonValue,
  type OperationContext,
  type Origin,
  type PublicError,
  type SemanticTarget,
  type StepId,
} from '../core/api.js'
import type {
  ActionResult,
  BrowserBinding,
  BrowserDriver,
  Observation,
  ResolvedTarget,
} from './api.js'

/** 逻辑步骤的终态（design/data-model.md StepFinished.status）。 */
export type StepStatus = 'success' | 'error' | 'cancelled'

/** design/data-model.md 的 StepStarted（schemaVersion 取自 core 的持久 schema 版本）。 */
export interface StepStartedEvent {
  readonly type: 'step.started'
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly stepId: StepId
  readonly seq: number
  readonly callId: string
  readonly origin: Origin
  readonly action: BrowserAction
  readonly startedAt: number
}

/** design/data-model.md 的 StepFinished。 */
export interface StepFinishedEvent {
  readonly type: 'step.finished'
  readonly stepId: StepId
  readonly callId: string
  readonly status: StepStatus
  readonly finishedAt: number
  readonly durationMs: number
  readonly resultSummary?: JsonValue
  readonly error?: PublicError
  readonly evidence?: readonly string[]
}

export type OperationStepEvent = StepStartedEvent | StepFinishedEvent

/**
 * 步骤事件接收方（生产环境是 RecordingService 的写入队列）。
 *
 * `record` 可以返回 Promise：Runner 在发动作前等待 `step.started` 落盘。抛出或拒绝表示
 * 录制写入失败——此时不发送浏览器动作；错误码由写入方保证（RECORDING_* / STORE_*）。
 */
export interface OperationEventSink {
  record(event: OperationStepEvent): void | Promise<void>
}

export interface OperationRunnerOptions {
  /** 语义浏览器驱动（IF-2）；Runner 只在观察/解析/执行时调用它。 */
  readonly driver: BrowserDriver
  /** 步骤事件接收方；缺省表示不记录（仅用于不落盘的诊断/测试场景）。 */
  readonly events?: OperationEventSink
  /** 时钟（毫秒），用于 startedAt/finishedAt/durationMs；缺省 Date.now。 */
  readonly clock?: () => number
  /** stepId 生成器；缺省 core 的 newStepId。 */
  readonly newStepId?: () => StepId
  /** seq 分配器；缺省 Runner 自增（RecordingService 注入时按 Recording 分配）。 */
  readonly nextSeq?: () => number
}

export interface OperationRequest {
  readonly binding: BrowserBinding
  readonly action: BrowserAction
  readonly context: OperationContext
}

/** 一次逻辑动作的结果；失败不抛出，由 status/error 表达（生命周期错误才抛出）。 */
export interface OperationOutcome {
  readonly stepId: StepId
  readonly seq: number
  readonly action: BrowserAction
  readonly status: StepStatus
  readonly durationMs: number
  readonly result?: ActionResult
  readonly error?: PublicError
}

interface FinishInput {
  readonly stepId: StepId
  readonly seq: number
  readonly action: BrowserAction
  readonly callId: string
  readonly startedAt: number
  readonly status: StepStatus
  readonly result?: ActionResult
  readonly error?: PublicError
}

const DEFAULT_CLOCK = (): number => Date.now()

/** 取消类错误：Runner 已停止时拒绝新动作（不产生虚假步骤）。 */
function stoppedError(): PublicError {
  return createPublicError('OPERATION_CANCELLED', 'OperationRunner is stopped; no new browser action is sent')
}

/** 调用方给的动作形状非法：在产生任何步骤事件前拒绝。 */
function invalidActionError(): PublicError {
  return createPublicError('INVALID_ARGUMENT', 'action is not one of the six BrowserAction kinds')
}

/** 取动作的语义目标；没有目标的动作（navigate / wait / 无目标 scroll/key）不观察页面。 */
function targetOf(action: BrowserAction): SemanticTarget | undefined {
  switch (action.kind) {
    case 'click':
    case 'setValue':
      return action.target
    case 'scroll':
    case 'key':
      return action.target
    default:
      return undefined
  }
}

/** 动作发出前唯一可恢复的失效：观测过期，可刷新一次快照重新解析。 */
function isRecoverableStale(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'TARGET_STALE'
}

/** 未编码的错误收敛成 PublicError；已带稳定码的保留原码，message 一律清洗。 */
function operationError(error: unknown, stepId: StepId): PublicError {
  return toPublicError(error, { ids: { stepId } })
}

export class OperationRunner {
  private readonly driver: BrowserDriver
  private readonly events: OperationEventSink | undefined
  private readonly clock: () => number
  private readonly createStepId: () => StepId
  private readonly allocateSeq: () => number
  private readonly inFlight = new Set<Promise<void>>()
  private stopped = false

  constructor(options: OperationRunnerOptions) {
    this.driver = options.driver
    this.events = options.events
    this.clock = options.clock ?? DEFAULT_CLOCK
    this.createStepId = options.newStepId ?? createStepId
    let sequence = 0
    this.allocateSeq = options.nextSeq ?? (() => {
      sequence += 1
      return sequence
    })
  }

  /** 在途动作数量（dispose 前用来确认已经收尾）。 */
  get activeCount(): number {
    return this.inFlight.size
  }

  get isStopped(): boolean {
    return this.stopped
  }

  /** 停止接受新动作；在途动作仍由各自的 AbortSignal 取消，再用 drain() 等待收尾。 */
  stop(): void {
    this.stopped = true
  }

  /** 等待全部在途动作落定（不抛出；单个动作的失败已进入其结果）。 */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
  }

  /**
   * 执行一个逻辑动作：分配 stepId/seq，落 started，观察与解析（需要时），执行，落 finished。
   *
   * 生命周期/调用形状错误（Runner 已停止、动作形状非法）直接抛出 PublicError；
   * 动作本身的失败通过返回值的 status/error 表达，保证 started/finished 成对。
   */
  async run(request: OperationRequest): Promise<OperationOutcome> {
    if (this.stopped) throw stoppedError()
    if (!isBrowserAction(request.action)) throw invalidActionError()

    const task = this.runOperation(request)
    const tracked: Promise<void> = task.then(
      () => undefined,
      () => undefined,
    )
    this.inFlight.add(tracked)
    void tracked.finally(() => {
      this.inFlight.delete(tracked)
    })
    return task
  }

  private async runOperation(request: OperationRequest): Promise<OperationOutcome> {
    const { binding, action, context } = request
    const stepId = this.createStepId()
    const seq = this.allocateSeq()
    const startedAt = this.clock()

    // 先落 started 再发动作：录制写入失败时停止执行（design/backend.md 目标）。
    await this.emit({
      type: 'step.started',
      schemaVersion: SCHEMA_VERSION,
      stepId,
      seq,
      callId: context.callId,
      origin: context.origin,
      action,
      startedAt,
    })

    if (context.signal.aborted) {
      return this.finish({
        stepId,
        seq,
        action,
        callId: context.callId,
        startedAt,
        status: 'cancelled',
        error: createPublicError('OPERATION_CANCELLED', 'Operation was cancelled before any browser action was sent'),
      })
    }

    try {
      const result = await this.perform(binding, action, context)
      return await this.finish({
        stepId,
        seq,
        action,
        callId: context.callId,
        startedAt,
        status: 'success',
        result,
      })
    } catch (error) {
      const publicError = operationError(error, stepId)
      return await this.finish({
        stepId,
        seq,
        action,
        callId: context.callId,
        startedAt,
        status: publicError.code === 'OPERATION_CANCELLED' ? 'cancelled' : 'error',
        error: publicError,
      })
    }
  }

  /**
   * 观察 → 解析 → 执行。目标解析阶段允许一次观测刷新（TARGET_STALE，动作尚未发送）；
   * 一旦进入 execute 就不再重试，写动作结果未知时绝不自动重发。
   */
  private async perform(
    binding: BrowserBinding,
    action: BrowserAction,
    context: OperationContext,
  ): Promise<ActionResult> {
    const target = targetOf(action)
    if (target === undefined) {
      return this.driver.execute(binding, action, undefined, context)
    }

    let resolved: ResolvedTarget | undefined
    let attempt = 0
    for (;;) {
      try {
        const observation: Observation = await this.driver.observe(binding, context)
        resolved = await this.driver.resolve(binding, target, observation)
        break
      } catch (error) {
        if (attempt === 0 && isRecoverableStale(error) && !context.signal.aborted) {
          attempt += 1
          continue
        }
        throw error
      }
    }
    return this.driver.execute(binding, action, resolved, context)
  }

  private async finish(input: FinishInput): Promise<OperationOutcome> {
    const finishedAt = this.clock()
    const durationMs = Math.max(0, finishedAt - input.startedAt)
    const event: StepFinishedEvent = {
      type: 'step.finished',
      stepId: input.stepId,
      callId: input.callId,
      status: input.status,
      finishedAt,
      durationMs,
      ...(input.result?.summary === undefined ? {} : { resultSummary: input.result.summary }),
      ...(input.error === undefined ? {} : { error: input.error }),
    }
    await this.emit(event)
    return {
      stepId: input.stepId,
      seq: input.seq,
      action: input.action,
      status: input.status,
      durationMs,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.error === undefined ? {} : { error: input.error }),
    }
  }

  private async emit(event: OperationStepEvent): Promise<void> {
    if (this.events === undefined) return
    await this.events.record(event)
  }
}
