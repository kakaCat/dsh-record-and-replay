/** Cua 工具回执的统一成功/拒绝判定；两个驱动共用，避免循环依赖。 */
import type { JsonObject } from '../core/api.js'
import { BrowserDriverError } from '../driver/api.js'
import type { CuaToolResult } from './transport.js'

function objectOf(result: CuaToolResult): JsonObject {
  if (result.structuredContent !== undefined && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
    return result.structuredContent as JsonObject
  }
  const text = result.content.find(part => part.type === 'text')?.text
  if (text === undefined) throw new BrowserDriverError('CUA_TRANSPORT_UNAVAILABLE', 'Cua tool returned no structured content')
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as JsonObject
  } catch {
    // 落到下面的统一错误。
  }
  throw new BrowserDriverError('CUA_TRANSPORT_UNAVAILABLE', 'Cua tool returned unparseable content')
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function mapRefusalCode(code: string | undefined): 'BROWSER_PERMISSION_DENIED' | 'TARGET_NOT_FOUND' | 'TARGET_STALE' | 'BROWSER_BINDING_STALE' {
  if (code === undefined) return 'BROWSER_BINDING_STALE'
  if (/permission|consent|authori[sz]/i.test(code)) return 'BROWSER_PERMISSION_DENIED'
  if (/target.*(?:missing|not_found)|element.*(?:missing|not_found)/i.test(code)) return 'TARGET_NOT_FOUND'
  if (/target.*(?:stale|invalid)|ref.*(?:stale|invalid)/i.test(code)) return 'TARGET_STALE'
  return 'BROWSER_BINDING_STALE'
}

export function ensureOk(result: CuaToolResult, operation: string): JsonObject {
  const data = objectOf(result)
  if (result.isError === true || data['status'] === 'refused' || data['isError'] === true) {
    const refusal = data['refusal'] as JsonObject | undefined
    const code = stringOf(refusal?.['code']) ?? stringOf(data['code'])
    const message = stringOf(refusal?.['message']) ?? stringOf(data['message'])
    throw new BrowserDriverError(
      mapRefusalCode(code),
      `Cua ${operation} refused${code === undefined ? '' : `: ${code}`}${message === undefined ? '' : ` (${message})`}`,
    )
  }
  return data
}
