/**
 * Standalone Cua browser-driver assembly for the CLI.
 *
 * This is the MCP path only: no DSH host, no plugin context and no native
 * worker. The driver is created after a bounded `health_report` probe so a
 * missing or too-old daemon fails before any replay starts.
 */
import {
  CuaBrowserDriver,
  CuaDriverClient,
  CuaTransportError,
  McpTransport,
  CUA_MINIMUM_DRIVER_VERSION,
} from '../cua/index.js'
import { cuaVersionOf } from '../cua/health.js'
import type { OperationContext } from '../core/api.js'

const HEALTH_TIMEOUT_MS = 15_000

export interface CuaDriverConnection {
  readonly client: CuaDriverClient
  readonly driver: CuaBrowserDriver
  close(): Promise<void>
}

export interface ConnectCuaDriverOptions {
  /** MCP command (defaults to `cua-driver` on PATH). */
  readonly command?: string
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Connect to the installed Cua daemon over MCP and return a ready browser
 * driver. On any failure the transport/client is closed before rethrowing, so
 * callers only need to close a successfully returned connection.
 */
export async function connectCuaBrowserDriver(
  options: ConnectCuaDriverOptions = {},
): Promise<CuaDriverConnection> {
  const transport = await McpTransport.create({
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })

  let client: CuaDriverClient | undefined
  try {
    const context: OperationContext = {
      principal: { sessionId: 'dsh-record-replay-cli', agentId: 'dsh-record-replay-cli' },
      callId: 'cua-health-probe',
      origin: 'internal',
      // A hung native daemon must not keep a nightly job alive forever.
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    }
    const health = await transport.callTool('health_report', {}, context)
    const driverVersion = cuaVersionOf(health)
    if (driverVersion === undefined) {
      throw new CuaTransportError(
        'CUA_TRANSPORT_UNAVAILABLE',
        'Cua health_report returned no driver version',
      )
    }
    client = await CuaDriverClient.connect(transport, {
      driverVersion,
      minimumDriverVersion: CUA_MINIMUM_DRIVER_VERSION,
    })
    const driver = new CuaBrowserDriver(client)
    const connected = client
    return {
      client: connected,
      driver,
      close: async () => {
        await connected.close().catch(() => undefined)
      },
    }
  } catch (error) {
    if (client !== undefined) await client.close().catch(() => undefined)
    else await transport.close().catch(() => undefined)
    throw error
  }
}
