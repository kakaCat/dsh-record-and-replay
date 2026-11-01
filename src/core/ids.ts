/**
 * Core 稳定 ID。
 *
 * 设计约束（design/data-model.md、plan/implementation-plan.md）：
 * - `RecordingId` 目录名必须等于 manifest.recordingId，只允许 `^rec_[A-Za-z0-9_]+$`；
 * - `RunId` / `StepId` 同构（`run_` / `step_` 前缀），每次回放、每个逻辑动作各分配一次；
 * - ID 一旦分配不得复用，是审计、错误定位与证据索引的最小锚点；
 * - 校验失败统一返回稳定错误码 `INVALID_ARGUMENT`，不做静默修补。
 */

import { randomUUID } from 'node:crypto';

import { createPublicError } from './errors.js';
import type { PublicError } from './errors.js';

export type RecordingId = `rec_${string}`;
export type RunId = `run_${string}`;
export type StepId = `step_${string}`;

export const RECORDING_ID_PATTERN = /^rec_[A-Za-z0-9_]+$/;
export const RUN_ID_PATTERN = /^run_[A-Za-z0-9_]+$/;
export const STEP_ID_PATTERN = /^step_[A-Za-z0-9_]+$/;

function randomSuffix(): string {
  return randomUUID().replaceAll('-', '');
}

/** 生成一个新的 RecordingId（随机、不可预测、满足目录名约束）。 */
export function newRecordingId(): RecordingId {
  return `rec_${randomSuffix()}`;
}

/** 生成一个新的 RunId。 */
export function newRunId(): RunId {
  return `run_${randomSuffix()}`;
}

/** 生成一个新的 StepId。 */
export function newStepId(): StepId {
  return `step_${randomSuffix()}`;
}

export function isRecordingId(value: unknown): value is RecordingId {
  return typeof value === 'string' && RECORDING_ID_PATTERN.test(value);
}

export function isRunId(value: unknown): value is RunId {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && STEP_ID_PATTERN.test(value);
}

/** 断言是合法 RecordingId，否则抛带 `INVALID_ARGUMENT` 的 PublicError。 */
export function assertRecordingId(value: unknown, field = 'recordingId'): RecordingId {
  if (!isRecordingId(value)) {
    throw invalidId('RecordingId', field, RECORDING_ID_PATTERN);
  }
  return value;
}

/** 断言是合法 RunId。 */
export function assertRunId(value: unknown, field = 'runId'): RunId {
  if (!isRunId(value)) {
    throw invalidId('RunId', field, RUN_ID_PATTERN);
  }
  return value;
}

/** 断言是合法 StepId。 */
export function assertStepId(value: unknown, field = 'stepId'): StepId {
  if (!isStepId(value)) {
    throw invalidId('StepId', field, STEP_ID_PATTERN);
  }
  return value;
}

function invalidId(kind: string, field: string, pattern: RegExp): PublicError {
  return createPublicError('INVALID_ARGUMENT', `Invalid ${kind} for field "${field}": expected ${pattern.source}`);
}
