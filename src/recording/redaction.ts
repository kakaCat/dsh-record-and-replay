/**
 * Recording 脱敏管线（design/data-model.md 模块表 `recording/redaction`、interfaces.md IF-3、
 * 需求 FR-3「持久化前脱敏」、跨关注点「先脱敏再 append，截图按需」）。
 *
 * 铁律：
 * - 任何事件进入 Store 之前必须经过 Redactor：setValue 的明文 value 一律改写为固定掩码，
 *   带 secretRef 时保留引用、值仍不落盘（data-model：value 改写为掩码或 secretRef）；
 * - resultSummary / error.message 递归扫描：键名命中秘密词（password/token/cookie/…）的值替换
 *   为 `***`，字符串值再过一遍 Core 的 `sanitizePublicMessage`（Bearer/Basic、秘密赋值、绝对路径）；
 * - Redactor 是纯函数：输入事件不被修改，返回新对象；同一输入必须产出同一输出（可测试、可缓存）；
 * - 本模块不知道 Cookie jar / 凭证存储在哪，只做「落盘前最后一道」的内容级脱敏。
 *
 * 扩展点（IF-6 ExtensionRegistry 的 Redactor 契约）：第三方 Redactor 实现同一接口，
 * 由 Host 组合根注入；默认实现 `defaultRedactor` 即本文件的 `redactStepEvent`。
 */
import {
  createPublicError,
  sanitizePublicMessage,
  type BrowserAction,
  type JsonValue,
  type PublicError,
  type SetValueAction,
} from '../core/api.js'
import type { RecordingStepEvent, RecordingStepFinished, RecordingStepStarted } from './schema.js'

/** 落盘掩码：固定 8 个 `*`，不保留原文长度特征（长度也会泄露信息）。 */
export const REDACTED_VALUE = '********'

/** 字符串里的通用秘密形态：信用卡、AWS Access Key、`sk-`/`api-` 前缀 key。 */
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]*?){13,19}\b/gu
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/gu
const API_KEY_PATTERN = /\b(?:sk|api)[-_][A-Za-z0-9_-]{16,}\b/giu

/** 秘密键名：键命中即整值替换，不区分大小写、允许 `-`/`_` 变体。 */
export const SECRET_KEY_PATTERN =
  /password|passwd|pwd|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key|authorization|proxy-authorization|cookie|set-cookie|session|credential/i

/** Redactor 扩展契约（IF-6）：id 用反向域名风格，redactEvent 必须纯函数、幂等。 */
export interface Redactor {
  readonly id: string
  redactEvent(event: RecordingStepEvent): RecordingStepEvent
}

/**
 * 默认 Redactor（`redaction.default`）。幂等：对同一事件重复 redact 产出相同结果
 * （value 已被掩码后再次 redact 不会变化）。
 */
export const defaultRedactor: Redactor = {
  id: 'dsh.recording.redaction.default',
  redactEvent: redactStepEvent,
}

/** 脱敏一条步骤事件；返回新对象，输入不被修改。 */
export function redactStepEvent(event: RecordingStepEvent): RecordingStepEvent {
  switch (event.type) {
    case 'step.started':
      return redactStarted(event)
    case 'step.finished':
      return redactFinished(event)
  }
}

function redactStarted(event: RecordingStepStarted): RecordingStepStarted {
  const action = event.action
  if (action.kind !== 'setValue') {
    return event
  }
  // 明文只存在于进程内；落盘版本一律掩码，secretRef（若有）保留为引用。
  const redacted: SetValueAction = {
    ...action,
    value: REDACTED_VALUE,
  }
  return { ...event, action: redacted }
}

function redactFinished(event: RecordingStepFinished): RecordingStepFinished {
  const redacted: {
    type: 'step.finished'
    stepId: RecordingStepFinished['stepId']
    callId: string
    status: RecordingStepFinished['status']
    finishedAt: number
    durationMs: number
    resultSummary?: JsonValue
    error?: PublicError
    evidence?: readonly string[]
  } = { ...event }

  if (event.resultSummary !== undefined) {
    redacted.resultSummary = redactJsonValue(undefined, event.resultSummary)
  }
  if (event.error !== undefined) {
    // createPublicError 内部走 sanitizePublicMessage；定位 ID（recordingId/runId/stepId）保留。
    redacted.error = createPublicError(event.error.code, event.error.message, {
      ...(event.error.recordingId === undefined ? {} : { recordingId: event.error.recordingId }),
      ...(event.error.runId === undefined ? {} : { runId: event.error.runId }),
      ...(event.error.stepId === undefined ? {} : { stepId: event.error.stepId }),
    })
  }
  return redacted
}

/** 递归脱敏 JSON 值：键名命中秘密词 → 整值替换；字符串 → 显示安全清洗。 */
export function redactJsonValue(key: string | undefined, value: JsonValue): JsonValue {
  if (key !== undefined && SECRET_KEY_PATTERN.test(key)) {
    return '***'
  }
  if (typeof value === 'string') {
    return sanitizePublicMessage(value)
      .replace(CREDIT_CARD_PATTERN, '[REDACTED_CREDIT_CARD]')
      .replace(AWS_ACCESS_KEY_PATTERN, '[REDACTED_AWS_ACCESS_KEY]')
      .replace(API_KEY_PATTERN, '[REDACTED_API_KEY]')
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(undefined, entry))
  }
  if (typeof value === 'object' && value !== null) {
    const out: { [k: string]: JsonValue } = {}
    for (const [entryKey, entryValue] of Object.entries(value)) {
      out[entryKey] = redactJsonValue(entryKey, entryValue)
    }
    return out
  }
  return value
}

/** 便捷断言（测试与上游用）：动作里是否还可能残留明文 value。 */
export function actionMayContainSecret(action: BrowserAction): boolean {
  return action.kind === 'setValue' && action.value !== REDACTED_VALUE
}
