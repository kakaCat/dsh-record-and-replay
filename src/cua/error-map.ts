import { CuaTransportError } from './transport.js'

const DISCONNECT_PATTERNS = [
  /daemon (?:closed|not running|disconnected)/i,
  /transport (?:closed|disconnected)/i,
  /connection (?:closed|refused|reset)/i,
  /not connected/i,
  /socket/i,
]

const PERMISSION_PATTERNS = [
  /permission denied/i,
  /not (?:authorized|permitted)/i,
  /accessibility.*(?:missing|denied)/i,
  /screen recording.*(?:missing|denied)/i,
]

const MISSING_PATTERNS = [
  /unknown tool/i,
  /tool .*not found/i,
  /capability.*(?:missing|unavailable)/i,
  /cannot find (?:module|package)/i,
  /failed to load (?:the )?(?:native|addon)/i,
]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Map transport failures to the frozen Core error vocabulary.
 * Tool-level refusals in a successful MCP response are not thrown here;
 * they remain in `structuredContent.refusal` for the BrowserDriver to map.
 */
export function mapCuaError(error: unknown): CuaTransportError {
  if (error instanceof CuaTransportError) return error

  const message = messageOf(error)
  const codeFromCause = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''

  if (codeFromCause === 'ABORT_ERR') {
    return new CuaTransportError('OPERATION_CANCELLED', message, { cause: error })
  }
  if (codeFromCause === 'ETIMEDOUT' || /timed? ?out/i.test(message)) {
    return new CuaTransportError('CUA_CALL_TIMEOUT', message, { cause: error })
  }
  if (PERMISSION_PATTERNS.some(pattern => pattern.test(message))) {
    return new CuaTransportError('BROWSER_PERMISSION_DENIED', message, { cause: error })
  }
  if (MISSING_PATTERNS.some(pattern => pattern.test(message)) || codeFromCause === 'ENOENT' || codeFromCause === 'ERR_MODULE_NOT_FOUND') {
    return new CuaTransportError('CUA_CAPABILITY_MISSING', message, { cause: error })
  }
  if (DISCONNECT_PATTERNS.some(pattern => pattern.test(message))) {
    return new CuaTransportError('CUA_TRANSPORT_DISCONNECTED', message, { cause: error })
  }

  return new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', message, { cause: error })
}
