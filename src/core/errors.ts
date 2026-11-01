/**
 * Core 稳定错误码与公共错误形状。
 *
 * 稳定性承诺（design/interfaces.md IF-1~IF-7）：
 * - 错误码是跨 Host/Driver/Store/UI 的稳定契约：只增不改名，弃用需保留一个主版本；
 * - `PublicError` 只含 code/message 与可定位 ID，绝不含 Cookie/Authorization/绝对路径；
 * - 调用方按错误码决定「修正输入 / 不绕过 / 检查连接 / 停止重放」，而不是按 message 文本。
 *
 * 设计文档「F. 稳定错误码分类」有且仅有七类，Core 为每类固定一个代表码
 * （`STABLE_ERROR_CODES`，这是本卡交付的七个稳定错误码）；其余在设计文档里已命名的
 * 错误码登记在 `DOCUMENTED_ERROR_CODES`，供后续 Transport/Driver/Store/Replay 卡直接引用，
 * 避免它们各自发明同义码。
 */

import type { RecordingId, RunId, StepId } from './ids.js';

export const ERROR_CATEGORIES = [
  'input',
  'authorization',
  'cua',
  'browser',
  'locator',
  'store',
  'lifecycle',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * Core 的七个稳定错误码：每个对应设计文档 F 节的一类默认处理，七类各一个。
 */
export const STABLE_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'FORBIDDEN',
  'CUA_TRANSPORT_UNAVAILABLE',
  'BROWSER_BINDING_STALE',
  'TARGET_NOT_FOUND',
  'STORE_CORRUPT_JSONL',
  'OPERATION_CANCELLED',
] as const;

export type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

/**
 * 设计文档中已命名、但不由 Core 卡固定的稳定码；后续卡片直接引用，不要另造同义码。
 * 这些名字同样属于稳定契约（只增改名）。
 */
export const DOCUMENTED_ERROR_CODES = [
  'UNSUPPORTED_VERSION',
  'REMOTE_UNAUTHORIZED',
  'FEATURE_DISABLED',
  'REPLAY_DISABLED',
  'CONFIG_INVALID',
  'BROWSER_TARGET_BUSY',
  'BROWSER_PERMISSION_DENIED',
  'TARGET_AMBIGUOUS',
  'TARGET_STALE',
  'ACTION_UNSUPPORTED',
  /**
   * Every supported click route dispatched, but the page showed no observable
   * change: the control never activated. Distinct from ACTION_UNSUPPORTED
   * (no route exists) and ASSERTION_FAILED (the action may have happened; the
   * expectation did not hold).
   */
  'ACTION_UNCONFIRMED',
  'ASSERTION_FAILED',
  'CUA_CAPABILITY_MISSING',
  'CUA_CALL_TIMEOUT',
  'CUA_TRANSPORT_DISCONNECTED',
  'STORE_INIT_FAILED',
  'STORE_LOCK_LOST',
  'STORE_DISK_FULL',
  'STORE_PATH_ESCAPE',
  'RECORDING_ALREADY_COMPLETED',
  'RECORDING_LIMIT_EXCEEDED',
  'RUN_ALREADY_TERMINAL',
  /**
   * 套件单 case 超过 timeoutMs：Run 已被 cancelRun 中止。
   * 与 ASSERTION_FAILED 区分——期望没被证伪，预算被耗尽。
   */
  'RUN_TIMEOUT',
] as const;

export type DocumentedErrorCode = (typeof DOCUMENTED_ERROR_CODES)[number];

/** 全部已声明错误码（七个稳定码 + 已命名扩展码）。 */
export const ERROR_CODES = [...STABLE_ERROR_CODES, ...DOCUMENTED_ERROR_CODES] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export interface ErrorCodeMetadata {
  /** 设计文档 F 节的分类。 */
  readonly category: ErrorCategory;
  /** 调用方在同样输入下是否可以重试（仅表示「允许考虑重试」，写动作仍不自动重发）。 */
  readonly retryable: boolean;
  /** 默认处理提示，给 UI 展示「下一步」用。 */
  readonly description: string;
}

/** 七个稳定错误码的元数据：分类互不相同，正好覆盖七类默认处理。 */
export const STABLE_ERROR_METADATA: { readonly [K in StableErrorCode]: ErrorCodeMetadata } = {
  INVALID_ARGUMENT: { category: 'input', retryable: false, description: '修正调用参数后重试，不要重放已发送的写动作' },
  FORBIDDEN: { category: 'authorization', retryable: false, description: '不绕过授权，由操作者调整 Session/配置' },
  CUA_TRANSPORT_UNAVAILABLE: { category: 'cua', retryable: true, description: '检查 Cua 安装/版本/连接后再试' },
  BROWSER_BINDING_STALE: { category: 'browser', retryable: false, description: '动作未发送前允许一次重绑；结果未知则停止' },
  TARGET_NOT_FOUND: { category: 'locator', retryable: false, description: '保存证据并终止，不要盲点第一个候选项' },
  STORE_CORRUPT_JSONL: { category: 'store', retryable: false, description: '停止写入并保留现场，进入坏尾恢复' },
  OPERATION_CANCELLED: { category: 'lifecycle', retryable: false, description: '停止发送新动作，幂等查询终态' },
};

export interface PublicErrorIds {
  readonly recordingId?: RecordingId;
  readonly runId?: RunId;
  readonly stepId?: StepId;
}

/**
 * 公共错误：可跨进程/跨模块传递。
 * message 由 `sanitizePublicMessage` 清洗过，绝不含秘密与绝对路径。
 */
export interface PublicError extends PublicErrorIds {
  readonly code: ErrorCode;
  readonly message: string;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

export function isStableErrorCode(value: unknown): value is StableErrorCode {
  return typeof value === 'string' && (STABLE_ERROR_CODES as readonly string[]).includes(value);
}

/** 判定「像 PublicError 的对象」：稳定的 code + 字符串 message。 */
export function isPublicError(value: unknown): value is PublicError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly code?: unknown; readonly message?: unknown };
  return isErrorCode(candidate.code) && typeof candidate.message === 'string';
}

/** 创建 PublicError；message 先清洗成可对外展示的形态。 */
export function createPublicError(code: ErrorCode, message: string, ids: PublicErrorIds = {}): PublicError {
  const error: {
    code: ErrorCode;
    message: string;
    recordingId?: RecordingId;
    runId?: RunId;
    stepId?: StepId;
  } = {
    code,
    message: sanitizePublicMessage(message),
  };
  if (ids.recordingId !== undefined) {
    error.recordingId = ids.recordingId;
  }
  if (ids.runId !== undefined) {
    error.runId = ids.runId;
  }
  if (ids.stepId !== undefined) {
    error.stepId = ids.stepId;
  }
  return error;
}

export interface ToPublicErrorOptions {
  /** 已知的定位 ID（优先于 error 自带的值）。 */
  readonly ids?: PublicErrorIds;
  /** 非 PublicError 的兜底码，默认 `INVALID_ARGUMENT`。 */
  readonly fallbackCode?: ErrorCode;
}

/** 把任意抛出物收敛成 PublicError：保留稳定码与定位 ID，message 清洗后对外。 */
export function toPublicError(error: unknown, options: ToPublicErrorOptions = {}): PublicError {
  const ids: { recordingId?: RecordingId; runId?: RunId; stepId?: StepId } = {};
  if (isPublicError(error)) {
    if (error.recordingId !== undefined) {
      ids.recordingId = error.recordingId;
    }
    if (error.runId !== undefined) {
      ids.runId = error.runId;
    }
    if (error.stepId !== undefined) {
      ids.stepId = error.stepId;
    }
  }
  if (options.ids?.recordingId !== undefined) {
    ids.recordingId = options.ids.recordingId;
  }
  if (options.ids?.runId !== undefined) {
    ids.runId = options.ids.runId;
  }
  if (options.ids?.stepId !== undefined) {
    ids.stepId = options.ids.stepId;
  }

  if (isPublicError(error)) {
    return createPublicError(error.code, error.message, ids);
  }
  const message = error instanceof Error ? error.message : String(error);
  return createPublicError(options.fallbackCode ?? 'INVALID_ARGUMENT', message, ids);
}

const SECRET_ASSIGNMENT =
  /(authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi;

const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/** 绝对路径（POSIX 常见根 + Windows 盘符 + file://）一律替换为 `<path>`。 */
const ABSOLUTE_PATH =
  /(?:file:\/\/[^\s"'<>;,)]+)|(?:\/(?:Volumes|Users|home|private|var|tmp|etc|opt|Applications)\/[^\s"'<>;,)]*)|(?:[A-Za-z]:\\[^\s"'<>;,)]*)/g;

/**
 * 清洗对外 message：屏蔽秘密赋值、Bearer/Basic 凭证与绝对路径。
 * 只做「显示安全」清洗，不改变错误码与定位 ID。
 */
export function sanitizePublicMessage(message: string): string {
  return message
    .replace(AUTH_SCHEME, '<redacted-credentials>')
    .replace(SECRET_ASSIGNMENT, '$1: ***')
    .replace(ABSOLUTE_PATH, '<path>');
}
