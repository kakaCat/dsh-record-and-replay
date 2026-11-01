import {
  CUA_MINIMUM_DRIVER_VERSION,
  CUA_REQUIRED_BROWSER_TOOLS,
  evaluateCuaCapabilities,
  type CuaCapabilityReport,
} from './capabilities.js'
import { mapCuaError } from './error-map.js'
import {
  CuaTransportError,
  type CuaToolCatalog,
  type CuaToolResult,
  type CuaTransport,
} from './transport.js'
import type { JsonObject, OperationContext } from '../core/api.js'

export interface CuaDriverClientOptions {
  /** Required tools checked at connect time. Defaults to the M0 browser tool set. */
  readonly requiredTools?: readonly string[]
  /** Per-call timeout, including browser actions. */
  readonly callTimeoutMs?: number
  /** Catalog discovery timeout. */
  readonly connectTimeoutMs?: number
  /** Driver version for the capability report; health probing is owned by Host. */
  readonly driverVersion?: string
  /**
   * Transport-specific version floor. The MCP CLI needs 0.38.0; the native
   * SDK line used by the DSH experimental provider is 0.28.0.
   */
  readonly minimumDriverVersion?: string
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

function cancelledError(message: string, cause?: unknown): CuaTransportError {
  return new CuaTransportError('OPERATION_CANCELLED', message, cause === undefined ? undefined : { cause })
}

function timeoutError(operation: string, timeoutMs: number): CuaTransportError {
  return new CuaTransportError('CUA_CALL_TIMEOUT', `${operation} timed out after ${timeoutMs}ms`)
}

async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  external: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (external.aborted) throw cancelledError(`${operation} was cancelled before start`, external.reason)

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()

  const onAbort = (): void => controller.abort(external.reason)
  external.addEventListener('abort', onAbort, { once: true })

  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(timedOut ? timeoutError(operation, timeoutMs) : cancelledError(`${operation} was cancelled`, external.reason))
    }, { once: true })
  })

  try {
    return await Promise.race([run(controller.signal), aborted])
  } catch (error) {
    if (timedOut) throw timeoutError(operation, timeoutMs)
    if (external.aborted) throw cancelledError(`${operation} was cancelled`, external.reason)
    throw error
  } finally {
    clearTimeout(timer)
    external.removeEventListener('abort', onAbort)
  }
}

/**
 * The only entry point for raw Cua tool calls.
 *
 * It validates the cached catalog, applies one timeout, forwards cancellation,
 * maps transport errors to stable codes, and never retries automatically.
 * Browser semantics, recording and replay live above this class.
 */
export class CuaDriverClient {
  readonly transport: CuaTransport
  readonly tools: readonly string[]
  readonly capability: CuaCapabilityReport
  readonly callTimeoutMs: number

  private readonly toolNames: ReadonlySet<string>
  private closed = false

  private constructor(
    transport: CuaTransport,
    catalog: CuaToolCatalog,
    capability: CuaCapabilityReport,
    options: CuaDriverClientOptions,
  ) {
    this.transport = transport
    this.tools = catalog.tools.map(tool => tool.name).sort()
    this.toolNames = new Set(this.tools)
    this.capability = capability
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  }

  static async connect(
    transport: CuaTransport,
    options: CuaDriverClientOptions = {},
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CuaDriverClient> {
    const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    try {
      const catalog = await withTimeout('listTools', timeoutMs, signal, innerSignal => transport.listTools(innerSignal))
      const names = catalog.tools.map(tool => tool.name)
      const required = options.requiredTools ?? CUA_REQUIRED_BROWSER_TOOLS
      const missing = required.filter(name => !names.includes(name))
      if (missing.length > 0) {
        throw new CuaTransportError(
          'CUA_CAPABILITY_MISSING',
          `Cua driver is missing required browser tools: ${missing.join(', ')}`,
        )
      }
      const capability = evaluateCuaCapabilities({
        toolNames: names,
        transport: transport.kind,
        ...(options.driverVersion === undefined ? {} : { driverVersion: options.driverVersion }),
        ...(options.minimumDriverVersion === undefined
          ? {}
          : { minimumDriverVersion: options.minimumDriverVersion }),
      })
      if (!capability.versionSupported) {
        const minimum = options.minimumDriverVersion ?? CUA_MINIMUM_DRIVER_VERSION
        throw new CuaTransportError(
          'CUA_TRANSPORT_UNAVAILABLE',
          `Cua driver version ${String(options.driverVersion)} is not supported; minimum is ${minimum}`,
        )
      }
      return new CuaDriverClient(transport, catalog, capability, options)
    } catch (error) {
      await transport.close().catch(() => undefined)
      throw mapCuaError(error)
    }
  }

  hasTool(name: string): boolean {
    return this.toolNames.has(name)
  }

  /**
   * Native transports run in standard permission mode, where attaching to an
   * existing browser profile is a host-granted boundary. The driver arms only
   * the pid/window it is binding; MCP transports ignore this.
   */
  armExistingProfileGrant(grant: { readonly pid: number; readonly windowId: number }): void | Promise<void> {
    const transport = this.transport as CuaTransport & {
      armExistingProfileGrant?: (grant: { readonly pid: number; readonly windowId: number }) => void | Promise<void>
    }
    return transport.armExistingProfileGrant?.(grant)
  }

  clearExistingProfileGrant(): void | Promise<void> {
    const transport = this.transport as CuaTransport & {
      clearExistingProfileGrant?: () => void | Promise<void>
    }
    return transport.clearExistingProfileGrant?.()
  }

  async callTool(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult> {
    if (this.closed) {
      throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', 'CuaDriverClient is closed')
    }
    if (!this.toolNames.has(name)) {
      throw new CuaTransportError('INVALID_ARGUMENT', `Unknown Cua tool: ${name}`)
    }

    try {
      return await withTimeout(`callTool(${name})`, this.callTimeoutMs, context.signal, signal =>
        this.transport.callTool(name, args, { ...context, signal }),
      )
    } catch (error) {
      throw mapCuaError(error)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.transport.close()
  }
}
