/**
 * Recording 事件投影（design/data-model.md 模块表 `recording/projector`、interfaces.md IF-3）。
 *
 * 把 append-only 的 JSONL 事件流（step.started / step.finished）投影成只读步骤视图：
 * - 一个逻辑动作 = 一个 ProjectedStep = 一对 started/finished（data-model 不变量）；
 * - 同 stepId+callId+type 的重复事件只投影一次（幂等，重复 callId 不增加步骤）；
 * - started 之后尚未收到 finished：录制仍在进行时投影为 `running`；录制已到终态
 *   （completed/failed/interrupted）仍未配对，说明崩溃发生在动作中途，投影为 `interrupted`
 *   ——绝不把未完成洗成成功（TC-04：interrupted 可见）；
 * - 纯函数、流式：事件边读边投影，10,000 步不要求全量载入内存（data-model 目标）；
 * - 本模块只读事件，绝不调用 BrowserDriver（FR-4：查询零动作）。
 */
import type {
  BrowserAction,
  BrowserActionKind,
  JsonValue,
  Origin,
  PublicError,
  StepId,
} from '../core/api.js'
import { stepEventKey, type RecordingStepEvent, type RecordingStepStarted } from './schema.js'

/** 投影步骤状态（TC-04 时间线）：running = 进行中；interrupted = 录制已终态但未收到 finished。 */
export type ProjectedStepStatus = 'running' | 'success' | 'error' | 'cancelled' | 'interrupted'

export const PROJECTED_STEP_STATUSES: readonly ProjectedStepStatus[] = [
  'running',
  'success',
  'error',
  'cancelled',
  'interrupted',
]

/** 只读步骤视图（interfaces.md：`ProjectedStep`：stepId、seq、动作摘要、目标、状态、耗时、错误和证据引用）。 */
export interface ProjectedStep {
  readonly stepId: StepId
  /** 1-based，Recording 内单调递增（finished 事件不带 seq，取自已配对的 started）。 */
  readonly seq: number
  readonly callId: string
  readonly origin: Origin
  readonly actionKind: BrowserActionKind
  /** 已脱敏的持久化动作（setValue.value 已是掩码）。 */
  readonly action: BrowserAction
  readonly status: ProjectedStepStatus
  readonly startedAt: number
  readonly finishedAt?: number
  readonly durationMs?: number
  readonly resultSummary?: JsonValue
  readonly error?: PublicError
  readonly evidence?: readonly string[]
}

export interface ProjectorOptions {
  /**
   * Recording 是否已到终态：false（仍在录制）时未配对 started 投影为 running；
   * true 时投影为 interrupted。
   */
  readonly terminal: boolean
}

interface StepPair {
  readonly started: RecordingStepStarted
  finished?: Extract<RecordingStepEvent, { type: 'step.finished' }>
}

function pairKeyOf(stepId: StepId, callId: string): string {
  return `${stepId}${callId}`
}

class StepProjector {
  private readonly seen = new Set<string>()
  private readonly pairs = new Map<string, StepPair>()
  private readonly orphanFinished: Extract<RecordingStepEvent, { type: 'step.finished' }>[] = []

  /** 喂入一条事件；返回因本条事件而「达到稳定视图」的步骤（finished 使 started 成对）。 */
  feed(event: RecordingStepEvent): ProjectedStep | undefined {
    const key = stepEventKey(event)
    if (this.seen.has(key)) {
      return undefined
    }
    this.seen.add(key)

    if (event.type === 'step.started') {
      this.pairs.set(pairKeyOf(event.stepId, event.callId), { started: event })
      return undefined
    }

    const pair = this.pairs.get(pairKeyOf(event.stepId, event.callId))
    if (pair === undefined) {
      // finished 没有匹配的 started：事件流损坏/截断的残留，保留并在收尾时投影（seq 未知）。
      this.orphanFinished.push(event)
      return undefined
    }
    pair.finished = event
    this.pairs.delete(pairKeyOf(event.stepId, event.callId))
    return composeFinished(pair)
  }

  /** 收尾：未配对 started + 孤儿 finished。terminal=true 时 running → interrupted。 */
  flush(options: ProjectorOptions): ProjectedStep[] {
    const open: ProjectedStep[] = []
    for (const pair of this.pairs.values()) {
      open.push(composeOpen(pair.started, options.terminal))
    }
    open.sort((a, b) => a.seq - b.seq)

    const orphans: ProjectedStep[] = this.orphanFinished.map((event) => composeOrphan(event))
    return [...open, ...orphans]
  }
}

function composeFinished(pair: StepPair): ProjectedStep {
  const { started } = pair
  const finished = pair.finished
  const base: {
    stepId: StepId
    seq: number
    callId: string
    origin: Origin
    actionKind: BrowserActionKind
    action: BrowserAction
    status: ProjectedStepStatus
    startedAt: number
    finishedAt?: number
    durationMs?: number
    resultSummary?: JsonValue
    error?: PublicError
    evidence?: readonly string[]
  } = {
    stepId: started.stepId,
    seq: started.seq,
    callId: started.callId,
    origin: started.origin,
    actionKind: started.action.kind,
    action: started.action,
    status: finished === undefined ? 'interrupted' : finished.status,
    startedAt: started.startedAt,
  }
  if (finished !== undefined) {
    base.finishedAt = finished.finishedAt
    base.durationMs = finished.durationMs
    if (finished.resultSummary !== undefined) base.resultSummary = finished.resultSummary
    if (finished.error !== undefined) base.error = finished.error
    if (finished.evidence !== undefined) base.evidence = finished.evidence
  }
  return base
}

function composeOpen(started: RecordingStepStarted, terminal: boolean): ProjectedStep {
  return {
    stepId: started.stepId,
    seq: started.seq,
    callId: started.callId,
    origin: started.origin,
    actionKind: started.action.kind,
    action: started.action,
    status: terminal ? 'interrupted' : 'running',
    startedAt: started.startedAt,
  }
}

/** 孤儿 finished：seq 未知，排到队尾（MAX_SAFE_INTEGER），状态按事件原样投影。 */
function composeOrphan(event: Extract<RecordingStepEvent, { type: 'step.finished' }>): ProjectedStep {
  return {
    stepId: event.stepId,
    seq: Number.MAX_SAFE_INTEGER,
    callId: event.callId,
    origin: 'internal',
    actionKind: 'wait',
    action: { kind: 'wait', condition: { kind: 'idle', quietMs: 1 }, timeoutMs: 1 },
    status: event.status,
    startedAt: event.finishedAt - event.durationMs,
    finishedAt: event.finishedAt,
    durationMs: event.durationMs,
    ...(event.resultSummary === undefined ? {} : { resultSummary: event.resultSummary }),
    ...(event.error === undefined ? {} : { error: event.error }),
    ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
  }
}

/** 同步批量投影（小数据量、测试用）；需要全量数组时一次性给出按 seq 排序的结果。 */
export function projectSteps(events: Iterable<RecordingStepEvent>, options: ProjectorOptions): ProjectedStep[] {
  const projector = new StepProjector()
  const done: ProjectedStep[] = []
  for (const event of events) {
    const stable = projector.feed(event)
    if (stable !== undefined) done.push(stable)
  }
  const flushed = projector.flush(options)
  return [...done, ...flushed].sort((a, b) => a.seq - b.seq)
}

/**
 * 流式投影：finished 到达即成对产出；未配对 started 与孤儿 finished 在事件流结束时按
 * terminal 选项收尾。读多少产多少，不缓存全量。
 */
export async function* projectStepStream(
  events: AsyncIterable<RecordingStepEvent>,
  options: ProjectorOptions,
): AsyncIterable<ProjectedStep> {
  const projector = new StepProjector()
  for await (const event of events) {
    const stable = projector.feed(event)
    if (stable !== undefined) {
      yield stable
    }
  }
  for (const step of projector.flush(options)) {
    yield step
  }
}
