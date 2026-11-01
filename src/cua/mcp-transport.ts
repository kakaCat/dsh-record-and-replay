import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { JsonObject, OperationContext } from '../core/api.js'
import { mapCuaError } from './error-map.js'
import {
  CuaTransportError,
  normalizeToolResult,
  type CuaToolCatalog,
  type CuaToolResult,
  type CuaTransport,
} from './transport.js'

export interface McpTransportOptions {
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  /** Maximum MCP message size. Browser DOM snapshots can be large. */
  readonly maxBufferSize?: number
  /** Captured stderr lines retained for Host diagnostics; never exposed to UI. */
  readonly stderrLines?: number
  /** Bounds the MCP initialize handshake so a stuck child cannot hang the plugin. */
  readonly connectTimeoutMs?: number
}

/**
 * Persistent stdio MCP client for Cua Driver.
 *
 * M0 proved that one-shot CLI calls cannot preserve session-scoped target ids.
 * This transport owns one connection for the client's lifetime and is the
 * only production transport selected for V1.
 */
export class McpTransport implements CuaTransport {
  readonly kind = 'mcp' as const
  private readonly client: Client
  private readonly stdio: StdioClientTransport
  private readonly stderr: string[] = []
  private readonly maxStderrLines: number
  private closed = false

  private constructor(client: Client, stdio: StdioClientTransport, maxStderrLines: number) {
    this.client = client
    this.stdio = stdio
    this.maxStderrLines = maxStderrLines
  }

  static async create(options: McpTransportOptions = {}): Promise<McpTransport> {
    const stdio = new StdioClientTransport({
      command: options.command ?? 'cua-driver',
      args: [...(options.args ?? ['mcp'])],
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.maxBufferSize === undefined ? {} : { maxBufferSize: options.maxBufferSize }),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'dsh-record-replay', version: '0.1.0' })
    const transport = new McpTransport(client, stdio, options.stderrLines ?? 40)

    stdio.stderr?.on('data', (chunk: unknown) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim().length === 0) continue
        transport.stderr.push(line.slice(0, 500))
        if (transport.stderr.length > transport.maxStderrLines) transport.stderr.shift()
      }
    })

    try {
      await client.connect(stdio, { timeout: options.connectTimeoutMs ?? 15_000 })
      return transport
    } catch (error) {
      await transport.close().catch(() => undefined)
      throw mapCuaError(error)
    }
  }

  /** Child process pid, when the transport actually spawned one. */
  get pid(): number | undefined {
    return this.stdio.pid ?? undefined
  }

  /** Content-free stderr tail for diagnostics; only available to Host. */
  stderrTail(): readonly string[] {
    return [...this.stderr]
  }

  async listTools(signal: AbortSignal): Promise<CuaToolCatalog> {
    if (this.closed) throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', 'MCP transport is closed')
    try {
      const response = await this.client.listTools(undefined, { signal })
      return {
        tools: response.tools.map(tool => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema as never }),
        })),
      }
    } catch (error) {
      throw mapCuaError(error)
    }
  }

  async callTool(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult> {
    if (this.closed) throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', 'MCP transport is closed')
    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { signal: context.signal },
      )
      return normalizeToolResult(result)
    } catch (error) {
      throw mapCuaError(error)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.client.close()
    } finally {
      await this.stdio.close().catch(() => undefined)
    }
  }
}
