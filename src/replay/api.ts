/**
 * ReplayService 公共 API（design/interfaces.md IF-5、design/backend.md 模块表 `replay/*`、
 * design/data-model.md「Run 布局与状态机」、plan/implementation-plan.md §4.3/§5 R2）。
 *
 * 职责边界：
 * - 只放跨模块公共的纯类型、错误码、Run 持久化模型与 SPI 接口；不含任何 fs / 浏览器实现；
 * - `ReplayService` 只对 completed 且哈希匹配的 Recording 创建新 Run，逐步观察、语义重绑、
 *   断言、失败即停和证据落盘（backend.md `replay/runner`）；View/Plan 不创建 Run；
 * - Run 是独立事实：run.json + steps.jsonl + evidence/ 写在 `runs/<runId>/` 下，
 *   **绝不改写来源 Recording**（data-model 约束不变量）；
 * - Execute 非幂等（同参数重复调用就是新 Run）；`idempotencyKey` 只能避免重复创建 Run；
 *   Cancel 幂等（终态 Run 原样返回）。
 *
 * 错误码纪律（与 recording/service 同款做法）：IF-5 命名但不在 Core `ERROR_CODES`
 * 联合里的码，固定在本模块的 `REPLAY_SERVICE_ONLY_CODES`；跨模块对外时调用方按
 * Host 端口映射，不另造同义码。落进步骤事件的 error 只会是 Core 稳定码
 * （REPLAY_UNSUPPORTED_STEP / RECORDING_HASH_MISMATCH 只在 Plan/Execute 入口抛出，
 * 永不持久化）。
 */

import type { ErrorCode, Principal, PublicError, RecordingId, RunId, StepId } from '../core/api.js'
import { SCHEMA_VERSION } from '../core/api.js'
import type { LaunchMode } from '../core/contracts.js'
import type { BrowserDriver } from '../driver/api.js'
import type { ProjectedStep } from '../recording/index.js'
import type { StepCursor, StoreDriverInfo, StoreManifest, StoreStepEvent, StoredStepEvent } from '../store/api.js'

// ---------------------------------------------------------------------------
// 策略与错误码
// ---------------------------------------------------------------------------

/** V1 只有 semantic-v1 一个默认策略（IF-5 兼容性：新增策略只增联合值，不改默认语义）。 */
export const REPLAY_STRATEGIES = ['semantic-v1'] as const
export type ReplayStrategy = (typeof REPLAY_STRATEGIES)[number]

/** IF-5 命名、但不在 Core ERROR_CODES 联合里的服务级错误码（RECORDING_* / RUN_NOT_FOUND 同 recording 服务级码做法）。 */
export const REPLAY_SERVICE_ONLY_CODES = [
  'RECORDING_NOT_FOUND',
  'RECORDING_INCOMPLETE',
  'RUN_NOT_FOUND',
  'REPLAY_UNSUPPORTED_STEP',
  'RECORDING_HASH_MISMATCH',
] as const

export type ReplayServiceOnlyCode = (typeof REPLAY_SERVICE_ONLY_CODES)[number]

/** ReplayService 错误码全集：Core 稳定码 + 已命名扩展码 + 本服务级码。 */
export type ReplayServiceErrorCode = ErrorCode | ReplayServiceOnlyCode

export class ReplayServiceError extends Error {
  readonly code: ReplayServiceErrorCode
  readonly recordingId?: RecordingId
  readonly runId?: RunId
  readonly stepId?: StepId

  constructor(
    code: ReplayServiceErrorCode,
    message: string,
    options: { cause?: unknown; recordingId?: RecordingId; runId?: RunId; stepId?: StepId } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ReplayServiceError'
    this.code = code
    if (options.recordingId !== undefined) this.recordingId = options.recordingId
    if (options.runId !== undefined) this.runId = options.runId
    if (options.stepId !== undefined) this.stepId = options.stepId
  }
}

export function isReplayServiceError(value: unknown): value is ReplayServiceError {
  return value instanceof ReplayServiceError
}

// ---------------------------------------------------------------------------
// Run 状态机（data-model：preparing -> running -> completed | failed | cancelled）
// ---------------------------------------------------------------------------

export type RunStatus = 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled'

export const RUN_STATUSES: readonly RunStatus[] = ['preparing', 'running', 'completed', 'failed', 'cancelled']

/** Run 终态；`preparing/running` 仍可被 cancel 收敛为 cancelled。 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value)
}

export function isTerminalRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (TERMINAL_RUN_STATUSES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// DTO（interfaces.md 数据模型节：ReplayPlan / ReplayRun / ProjectedRunStep）
// ---------------------------------------------------------------------------

/** Plan 阶段被判为不可执行的步骤（IF-5：REPLAY_UNSUPPORTED_STEP 带具体 stepId）。 */
export interface UnsupportedStep {
  /** 来源 Recording 的 stepId（调用方据此定位时间线）。 */
  readonly stepId: StepId
  readonly seq: number
  /** 不可执行原因（能力缺失 / 无语义定位字段 / secretRef 不可解析…）。 */
  readonly reason: string
}

/** IF-5 Execute 选项；新增字段必须 optional（兼容性承诺）。 */
export interface ReplayOptions {
  /** 回放策略；缺省 'semantic-v1'（IF-5：新增策略通过 strategy 联合值）。 */
  readonly strategy?: ReplayStrategy
  /**
   * 绑定目标种类。能力表按它取：浏览器绑定没有 key，桌面绑定没有
   * navigate/wait。缺省按浏览器处理。
   */
  readonly launch?: LaunchMode
  /** 只能避免「重复创建 Run」；Execute 本身非幂等。 */
  readonly idempotencyKey?: string
  /** 调用方取消通道；与本服务 cancel(runId) 等价（OPERATION_CANCELLED 幂等收敛）。 */
  readonly signal?: AbortSignal
  /** secretRef → 明文；只存在于进程内，绝不落盘。 */
  readonly secretResolver?: (secretRef: string) => string | undefined
  /** 回放时按 stepId 或 secretRef 提供的输入值；只存在于进程内，绝不落盘。 */
  readonly values?: Readonly<Record<string, string>>
  /** 覆盖录制里的 navigate 源站（保留 path/search/hash），用于端口每次变化的被测系统。 */
  readonly baseUrl?: string
  /** Run 创建后回调（Host/UI 拿到 runId 才能 cancel；同步在 execute 返回前调用）。 */
  readonly onRunStarted?: (runId: RunId) => void
}

/** ReplayPlan：来源 Recording、可执行性、unsupported stepId 列表、写动作数量。 */
export interface ReplayPlan {
  readonly recordingId: RecordingId
  /** 来源 Recording 的输入版本证明（data-model：manifest.stepsSha256）。 */
  readonly recordingSha256: string
  readonly strategy: ReplayStrategy
  readonly executable: boolean
  readonly stepCount: number
  /** 不可逆写动作数量（click / setValue / key，actions.ts 同款口径）。 */
  readonly writeActionCount: number
  readonly unsupportedSteps: readonly UnsupportedStep[]
}

/**
 * ReplayRun：runId、状态、当前 stepId、时间、错误（interfaces.md 数据模型节）。
 * `currentStepId` 是**来源 Recording** 的 stepId——失败定位与证据都按 Recording 时间线对齐。
 */
export interface ReplayRun {
  readonly runId: RunId
  readonly recordingId: RecordingId
  readonly status: RunStatus
  readonly currentStepId?: StepId
  readonly startedAt: string
  readonly finishedAt?: string
  readonly error?: PublicError
  readonly recordingSha256: string
  readonly driverId: string
}

/**
 * Run 步骤投影：复用 Recording 的 ProjectedStep 形状；Run 步骤的 `callId` 记录
 * 来源 Recording 的 stepId（Run 步骤自身的新 stepId 在 `stepId` 字段），调用方按
 * callId 把 Run 结果对齐回 Recording 时间线。
 */
export type ProjectedRunStep = ProjectedStep

// ---------------------------------------------------------------------------
// Run 持久化模型（plan §4.3 run.json：元数据、输入哈希与终态）
// ---------------------------------------------------------------------------

/**
 * run.json 的权威形状。`recordingSha256` 必须等于加载时来源 manifest 的
 * stepsSha256（data-model 约束不变量）；不匹配拒绝执行。
 */
export interface RunRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly runId: RunId
  readonly recordingId: RecordingId
  readonly recordingSha256: string
  readonly driver: StoreDriverInfo
  readonly status: RunStatus
  /** 正在执行（或失败时）的来源 Recording stepId。 */
  readonly currentStepId?: StepId
  readonly startedAt: string
  readonly finishedAt?: string
  readonly error?: PublicError
}

/** 单个 Run 的写句柄；steps.jsonl 只追加，run.json 原子重写。 */
export interface RunWriter {
  readonly runId: RunId
  readonly recordingId: RecordingId
  append(event: StoreStepEvent): Promise<void>
  /**
   * 写证据文件到本 Run 的 evidence/ 下；name 是相对 evidence/ 的 POSIX 路径
   * （如 `step-3/after.json`），不允许 `..` / 绝对路径 / 空段。
   * 返回**相对 Recording 目录**的 POSIX 路径（`runs/<runId>/evidence/...`）。
   */
  writeEvidence(name: string, data: Uint8Array | string): Promise<string>
  /** 原子更新 run.json（状态推进 / currentStepId / 终态）。 */
  update(record: RunRecord): Promise<void>
  /** 终态收口：写最终 run.json 并移除活跃锁。 */
  finish(record: RunRecord): Promise<void>
}

/**
 * Run 读/写 SPI。Replay 模块只依赖本接口读写 Run 目录；第三方可按契约测试接入。
 * 所有读接口不触发浏览器动作（FR-4 查询零动作同款纪律）。
 */
export interface RunStore {
  create(record: RunRecord): Promise<RunWriter>
  read(recordingId: RecordingId, runId: RunId): Promise<RunRecord>
  /** 只按 runId 定位（getRun/cancel 的入口）；找不到返回 undefined。 */
  findRun(runId: RunId): Promise<RunRecord | undefined>
  listRuns(recordingId: RecordingId): Promise<readonly RunRecord[]>
  readSteps(recordingId: RecordingId, runId: RunId, cursor?: StepCursor): AsyncIterable<StoredStepEvent>
}

/** Replay 的 Recording 读模型：只读来源事实，绝不写回来源 Recording。 */
export interface RecordingSource {
  readManifest(recordingId: RecordingId): Promise<StoreManifest>
  readSteps(recordingId: RecordingId): AsyncIterable<ProjectedStep>
  verifyRecordingUnchanged(recordingId: RecordingId, sha256: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// ReplayService 接口（IF-5）
// ---------------------------------------------------------------------------

/**
 * ReplayService（IF-5）。实现在 runner.ts；组合方式见 runner.ts 的选项。
 *
 * 语义契约（interfaces.md IF-5 原文）：
 * - plan 只读并检查 Schema、能力、SecretResolver 和语义目标，不创建 Run；
 * - execute 只接受 completed 且哈希匹配的 Recording；创建新 Binding/Run，
 *   每步前检查取消，失败立即停；
 * - View/Plan 不创建 Run；Run 永久可查；Execute 非幂等；Cancel 幂等。
 */
export interface ReplayService {
  plan(recordingId: RecordingId, options?: ReplayOptions): Promise<ReplayPlan>
  execute(recordingId: RecordingId, options: ReplayOptions, principal: Principal): Promise<RunId>
  getRun(runId: RunId): Promise<ReplayRun>
  readRunSteps(runId: RunId, cursor?: StepCursor): AsyncIterable<ProjectedRunStep>
  cancel(runId: RunId, principal: Principal): Promise<ReplayRun>
}

/** execute 需要的浏览器绑定来源（Host 注入真实 pid/windowId；测试注入假值）。 */
export interface ReplayDriverBinding {
  readonly driver: BrowserDriver
}
