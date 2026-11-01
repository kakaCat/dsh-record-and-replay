import type { ErrorCode, JsonObject, JsonValue, OperationContext } from '../core/api.js'

export type CuaTransportKind = 'mcp' | 'native'

/** Transport-neutral tool metadata. */
export interface CuaToolInfo {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: JsonValue
}

export interface CuaToolCatalog {
  readonly tools: readonly CuaToolInfo[]
}

export interface CuaToolContent {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

/** Raw Cua tool response before any semantic interpretation. */
export interface CuaToolResult {
  readonly content: readonly CuaToolContent[]
  readonly structuredContent?: JsonValue
  readonly isError?: boolean
}

/**
 * Transport is intentionally small: protocol, cancellation and close only.
 * It does not record, authorize, or interpret BrowserAction.
 */
export interface CuaTransport {
  readonly kind: CuaTransportKind
  listTools(signal: AbortSignal): Promise<CuaToolCatalog>
  callTool(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult>
  close(): Promise<void>
}

/** Stable error envelope carried over the Transport/Client boundary. */
export class CuaTransportError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CuaTransportError'
    this.code = code
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeToolResult(raw: unknown): CuaToolResult {
  if (!isJsonObject(raw)) {
    return { content: [], structuredContent: raw as JsonValue }
  }

  const rawContent = Array.isArray(raw.content) ? raw.content : []
  const content: CuaToolContent[] = rawContent.flatMap(entry => {
    if (!isJsonObject(entry) || typeof entry.type !== 'string') return []
    return [{
      type: entry.type,
      ...(typeof entry.text === 'string' ? { text: entry.text } : {}),
      ...(typeof entry.data === 'string' ? { data: entry.data } : {}),
      ...(typeof entry.mimeType === 'string' ? { mimeType: entry.mimeType } : {}),
    }]
  })

  return {
    content,
    ...(raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent as JsonValue } : {}),
    ...(typeof raw.isError === 'boolean' ? { isError: raw.isError } : {}),
  }
}
