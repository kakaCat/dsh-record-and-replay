/**
 * Recording 步骤事件 Schema 入口（design/data-model.md 模块表 `recording/schema`、
 * design/interfaces.md IF-3、IF-4）。
 *
 * 职责边界：
 * - 定义 RecordingService 看见的步骤事件形状（StepStarted / StepFinished，逐字段对齐
 *   design/data-model.md「核心类型」）；本模块不依赖 driver（与 store/api 同款做法：
 *   driver/operation-runner 的事件与本类型**结构一致**，靠结构兼容性对接）；
 * - 提供「写入入口」与「读盘入口」两套校验：调用方入参非法是参数错（INVALID_ARGUMENT），
 *   读盘内容非法是坏文件（STORE_CORRUPT_JSONL），绝不静默跳过；
 * - 版本判定与迁移入口：V1 只有 schemaVersion 1，迁移是内存中的恒等函数；未知版本返回
 *   STORE_UNSUPPORTED_VERSION（对外由上层收敛成 Core 的 UNSUPPORTED_VERSION），不猜测、不降级。
 *
 * 错误码纪律：Recording 层的错误码沿用 Core 稳定码 + Store SPI 码（RECORDING_NOT_FOUND /
 * RECORDING_ALREADY_COMPLETED 等），与 store/api 的 STORE_ERROR_CODES 同一份契约，不另造同义码。
 */
import { SCHEMA_VERSION, isSupportedSchemaVersion } from '../core/api.js'
import {
  StoreError,
  assertStepEvent,
  type StepCursor,
  type StoreStepEvent,
  type StoreStepFinished,
  type StoreStepStarted,
} from '../store/api.js'

export { SCHEMA_VERSION, isSupportedSchemaVersion }
export type { StepCursor }

/** design/data-model.md 的 StepStarted（schemaVersion 取自 Core 持久 schema 版本）。 */
export type RecordingStepStarted = StoreStepStarted

/** design/data-model.md 的 StepFinished（finished 行不带 schemaVersion，data-model 固定形状）。 */
export type RecordingStepFinished = StoreStepFinished

/** Recording 步骤事件：判别联合，type 是唯一判别子。 */
export type RecordingStepEvent = StoreStepEvent

export const RECORDING_EVENT_TYPES = ['step.started', 'step.finished'] as const

/** 逻辑步骤的去重键（与 store/api.stepEventKey 同义：同 stepId+callId+type 不产生第二逻辑步骤）。 */
export { stepEventKey } from '../store/api.js'

/**
 * 写入入口校验：OperationRunner / Replay 产生的入站事件。
 * 非法一律 INVALID_ARGUMENT（上游修正输入，不做静默修补）。
 */
export function assertInputStepEvent(value: unknown): RecordingStepEvent {
  return assertStepEvent(value)
}

/**
 * 读盘入口校验：从 Store 流式读回的事件。
 * 形状非法按坏文件报（StoreError STORE_CORRUPT_JSONL），保留现场交由恢复流程处理。
 */
export function parseStoredStepEvent(value: unknown): RecordingStepEvent {
  return assertStepEvent(value, { invalidCode: 'STORE_CORRUPT_JSONL' })
}

/**
 * 内存迁移入口（design/data-model.md「迁移与回填」第 1 条）：
 * 按版本选择纯函数迁移器，在内存中迁移到当前版本；旧文件不改写。
 * V1 只有 schemaVersion 1，迁移是恒等函数；未知版本抛 StoreError STORE_UNSUPPORTED_VERSION
 * （assertStepEvent 内部统一判定，这里不重复实现版本检查）。
 */
export function migrateStepEventToCurrent(value: unknown): RecordingStepEvent {
  const record = typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : {}
  const version = record['schemaVersion']
  // finished 事件不带 schemaVersion：视为当前版本（data-model 固定形状），由 parse 统一校验。
  if (version !== undefined && (typeof version !== 'number' || !isSupportedSchemaVersion(version))) {
    throw new StoreError(
      'STORE_UNSUPPORTED_VERSION',
      `step event schemaVersion ${String(version)} is not supported`,
    )
  }
  return parseStoredStepEvent(value)
}
