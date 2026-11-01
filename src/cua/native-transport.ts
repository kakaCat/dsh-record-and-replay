import type { JsonObject, OperationContext } from '../core/api.js'
import { mapCuaError } from './error-map.js'
import {
  CuaTransportError,
  normalizeToolResult,
  type CuaToolCatalog,
  type CuaToolResult,
  type CuaTransport,
} from './transport.js'

/** `SessionPermissionMode.Standard` in the generated uniffi enum. */
const STANDARD_PERMISSION_MODE = 0

/** `DriverAuthorizationAction.Allow` / `.Deny` in the generated uniffi enum. */
const AUTHORIZATION_ALLOW = 0
const AUTHORIZATION_DENY = 1

/** How long one bind may keep approving its own existing-profile boundary. */
const DEFAULT_GRANT_TTL_MS = 60_000

/** The narrow slice of `@trycua/cua-driver` this transport depends on. */
interface NativeDriverLike {
  listToolsJson(options: { signal: AbortSignal }): Promise<string>
  callTool(
    name: string,
    argumentsJson: string,
    options: { signal: AbortSignal },
  ): Promise<{ readonly rawJson: string }>
  shutdown(): Promise<void>
  uniffiDestroy(): void
}

interface NativeAuthorizationRequest {
  readonly requestDigest: string
  readonly resourceJson: string
}

interface NativeSdkModule {
  readonly CuaDriver: {
    createConfiguredWithAuthorizationHost(
      options: unknown,
      host: unknown,
    ): NativeDriverLike | Promise<NativeDriverLike>
  }
}

export interface NativeExistingProfileGrant {
  readonly pid: number
  readonly windowId: number
}

export interface NativeTransportOptions {
  /** Injected by tests so the native binary never loads there. */
  readonly loadSdk?: () => Promise<NativeSdkModule>
  /** Upper bound for any single Cua call made through the native runtime. */
  readonly callTimeoutMs?: number
  /** Lifetime of one armed existing-profile approval. */
  readonly grantTtlMs?: number
  /** Clock injection for deterministic grant-expiry tests. */
  readonly now?: () => number
}

interface ArmedGrant extends NativeExistingProfileGrant {
  readonly expiresAt: number
}

async function defaultLoadSdk(): Promise<NativeSdkModule> {
  return (await import('@trycua/cua-driver')) as unknown as NativeSdkModule
}

/** Look for numeric fields under any of `keys`, at any depth of `value`. */
function findNumberDeep(value: unknown, keys: readonly string[], depth = 0): number[] {
  if (depth > 6 || value === null || typeof value !== 'object') return []
  const found: number[] = []
  if (Array.isArray(value)) {
    for (const entry of value) found.push(...findNumberDeep(entry, keys, depth + 1))
    return found
  }
  for (const [key, entry] of Object.entries(value)) {
    if (keys.includes(key) && (typeof entry === 'number' || (typeof entry === 'string' && /^\d+$/u.test(entry)))) {
      found.push(Number(entry))
    }
    if (typeof entry === 'object') found.push(...findNumberDeep(entry, keys, depth + 1))
  }
  return found
}

/**
 * A grant matches only when the request names exactly this pid and window.
 * Unknown request shapes never match: denying is the safe default.
 */
export function authorizationRequestMatches(
  request: Pick<NativeAuthorizationRequest, 'resourceJson'>,
  grant: NativeExistingProfileGrant,
): boolean {
  let resource: unknown
  try {
    resource = JSON.parse(request.resourceJson)
  } catch {
    return false
  }
  const pids = findNumberDeep(resource, ['pid', 'owner_pid', 'process_id'])
  const windows = findNumberDeep(resource, ['window_id', 'windowId', 'window'])
  return pids.includes(grant.pid) && windows.includes(grant.windowId)
}

function authorizationOptions(): unknown {
  return {
    claudeCodeCompatibility: false,
    authorization: {
      allowedModes: [STANDARD_PERMISSION_MODE],
      compatibilityMode: STANDARD_PERMISSION_MODE,
      unrestrictedAcknowledged: false,
      maxSessionTtlSeconds: 8n * 60n * 60n,
      maxIdleTtlSeconds: 30n * 60n,
    },
  }
}

/**
 * In-process Cua Driver transport backed by the native npm SDK.
 *
 * The native runtime runs in standard permission mode, so attaching to an
 * existing browser profile is a host-granted boundary. The transport owns that
 * grant: it approves only the exact pid/window armed by the BrowserDriver bind
 * that is in flight, and denies everything else.
 */
export class NativeTransport implements CuaTransport {
  readonly kind = 'native' as const

  private readonly driver: NativeDriverLike
  private readonly callTimeoutMs: number
  private readonly grantTtlMs: number
  private readonly now: () => number
  private armed: ArmedGrant | null = null
  private closed = false

  private constructor(driver: NativeDriverLike, options: NativeTransportOptions) {
    this.driver = driver
    this.callTimeoutMs = options.callTimeoutMs ?? 0
    this.grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS
    this.now = options.now ?? Date.now
  }

  static async create(options: NativeTransportOptions = {}): Promise<NativeTransport> {
    let sdk: NativeSdkModule
    try {
      sdk = await (options.loadSdk ?? defaultLoadSdk)()
    } catch (error) {
      throw mapCuaError(error)
    }

    let transport: NativeTransport
    const host = {
      authorize: async (request: NativeAuthorizationRequest) => {
        const grant = transport.armed
        const allowed = grant !== null
          && grant.expiresAt > transport.now()
          && authorizationRequestMatches(request, grant)
        return {
          action: allowed ? AUTHORIZATION_ALLOW : AUTHORIZATION_DENY,
          requestDigest: request.requestDigest,
        }
      },
    }

    let driver: NativeDriverLike
    try {
      driver = await sdk.CuaDriver.createConfiguredWithAuthorizationHost(authorizationOptions(), host)
    } catch (error) {
      throw mapCuaError(error)
    }
    transport = new NativeTransport(driver, options)
    return transport
  }

  /** Arm one existing-profile approval for the bind that is about to run. */
  armExistingProfileGrant(grant: NativeExistingProfileGrant): void {
    this.armed = { ...grant, expiresAt: this.now() + this.grantTtlMs }
  }

  /** Drop a pending approval; called when the bind fails or finishes. */
  clearExistingProfileGrant(): void {
    this.armed = null
  }

  async listTools(signal: AbortSignal): Promise<CuaToolCatalog> {
    if (this.closed) throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', 'Native transport is closed')
    try {
      const raw = await this.driver.listToolsJson({ signal })
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { tools?: unknown }).tools)) {
        throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', 'Cua native driver returned a malformed tool catalog')
      }
      const tools = (parsed as { tools: unknown[] }).tools.flatMap(entry => {
        if (typeof entry !== 'object' || entry === null) return []
        const tool = entry as JsonObject
        const name = tool['name']
        if (typeof name !== 'string' || name.length === 0) return []
        return [{
          name,
          ...(typeof tool['description'] === 'string' ? { description: tool['description'] } : {}),
          ...(tool['inputSchema'] === undefined ? {} : { inputSchema: tool['inputSchema'] as never }),
        }]
      })
      return { tools }
    } catch (error) {
      throw mapCuaError(error)
    }
  }

  async callTool(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult> {
    if (this.closed) throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', 'Native transport is closed')
    if (context.signal.aborted) {
      throw new CuaTransportError('OPERATION_CANCELLED', `callTool(${name}) was cancelled before start`)
    }
    const signal = this.callTimeoutMs > 0
      ? AbortSignal.any([context.signal, AbortSignal.timeout(this.callTimeoutMs)])
      : context.signal
    try {
      const result = await this.driver.callTool(name, JSON.stringify(args), { signal })
      return normalizeToolResult(JSON.parse(result.rawJson))
    } catch (error) {
      if (context.signal.aborted) {
        throw new CuaTransportError('OPERATION_CANCELLED', `callTool(${name}) was cancelled`, { cause: error })
      }
      throw mapCuaError(error)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.armed = null
    try {
      await this.driver.shutdown()
    } catch {
      // Shutdown is best-effort; the handle still needs destroying.
    } finally {
      try {
        this.driver.uniffiDestroy()
      } catch {
        // Already destroyed.
      }
    }
  }
}
