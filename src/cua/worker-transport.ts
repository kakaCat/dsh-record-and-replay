import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { JsonObject, OperationContext } from '../core/api.js'
import { McpTransport, type McpTransportOptions } from './mcp-transport.js'
import { ARM_EXISTING_PROFILE_GRANT, CLEAR_EXISTING_PROFILE_GRANT, isNativeHostInternalTool } from './native-host-protocol.js'
import {
  CuaTransportError,
  type CuaToolCatalog,
  type CuaToolResult,
  type CuaTransport,
} from './transport.js'

export interface WorkerTransportOptions {
  /** Host entry; defaults to the built `native-host.mjs` next to this module. */
  readonly hostPath?: string | URL
  /** Node-compatible executable; defaults to `process.execPath`. */
  readonly execPath?: string
  /** Extra node flags, e.g. `['--import', 'tsx']` when pointing at TypeScript. */
  readonly nodeArgs?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly maxBufferSize?: number
  /** Tests inject a transport without spawning a process. */
  readonly createMcp?: (options: McpTransportOptions) => Promise<CuaTransport>
}

/** Built host next to the entry; when running from src via tsx, use the dist build. */
function defaultHostPath(): URL {
  const sibling = new URL('./native-host.mjs', import.meta.url)
  if (existsSync(fileURLToPath(sibling))) return sibling
  return new URL('../../dist/native-host.mjs', import.meta.url)
}

function hostEnvironment(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  // DSH runs on Electron: without this the app binary starts a GUI instead of node.
  env['ELECTRON_RUN_AS_NODE'] = '1'
  return { ...env, ...extra }
}

function grantContext(callId: string): OperationContext {
  return {
    principal: { sessionId: 'dsh-record-replay-native-host', agentId: 'dsh-record-replay-native-host' },
    callId,
    origin: 'internal',
    signal: AbortSignal.timeout(5_000),
  }
}

/**
 * Crash-isolated native transport: the Cua SDK runs in a child process that
 * speaks MCP over stdio, so a native crash cannot take the DSH host down.
 */
export class WorkerTransport implements CuaTransport {
  readonly kind = 'native' as const

  private constructor(private readonly mcp: CuaTransport) {}

  static async create(options: WorkerTransportOptions = {}): Promise<WorkerTransport> {
    const host = options.hostPath ?? defaultHostPath()
    const hostPath = typeof host === 'string' ? host : fileURLToPath(host)
    const create = options.createMcp ?? ((mcpOptions: McpTransportOptions) => McpTransport.create(mcpOptions))
    const mcp = await create({
      command: options.execPath ?? process.execPath,
      args: [...(options.nodeArgs ?? []), hostPath],
      env: hostEnvironment(options.env),
      stderrLines: 60,
      ...(options.maxBufferSize === undefined ? {} : { maxBufferSize: options.maxBufferSize }),
    })
    return new WorkerTransport(mcp)
  }

  /** Child pid for diagnostics and crash-isolation tests. */
  get pid(): number | undefined {
    const candidate = this.mcp as CuaTransport & { pid?: number }
    return typeof candidate.pid === 'number' ? candidate.pid : undefined
  }

  async listTools(signal: AbortSignal): Promise<CuaToolCatalog> {
    const catalog = await this.mcp.listTools(signal)
    return { tools: catalog.tools.filter(tool => !isNativeHostInternalTool(tool.name)) }
  }

  async callTool(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult> {
    if (isNativeHostInternalTool(name)) {
      throw new CuaTransportError('INVALID_ARGUMENT', `${name} is an internal native host control tool`)
    }
    return await this.mcp.callTool(name, args, context)
  }

  /** Blocking on purpose: the native host must hold the grant before prepare. */
  async armExistingProfileGrant(grant: { readonly pid: number; readonly windowId: number }): Promise<void> {
    await this.mcp.callTool(
      ARM_EXISTING_PROFILE_GRANT,
      { pid: grant.pid, window_id: grant.windowId },
      grantContext('arm-existing-profile'),
    )
  }

  async clearExistingProfileGrant(): Promise<void> {
    await this.mcp.callTool(
      CLEAR_EXISTING_PROFILE_GRANT,
      {},
      grantContext('clear-existing-profile'),
    ).catch(() => undefined)
  }

  async close(): Promise<void> {
    await this.mcp.close()
  }
}
