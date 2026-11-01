import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { JsonObject, OperationContext } from '../core/api.js'
import type { CuaToolContent, CuaToolResult } from './transport.js'
import {
  ARM_EXISTING_PROFILE_GRANT,
  CLEAR_EXISTING_PROFILE_GRANT,
} from './native-host-protocol.js'

/** The child-side capability surface the host server forwards to. */
export interface NativeHostRuntime {
  listTools(signal: AbortSignal): Promise<{
    readonly tools: readonly { name: string; description?: string; inputSchema?: unknown }[]
  }>
  callTool(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult>
  armExistingProfileGrant(grant: { readonly pid: number; readonly windowId: number }): void | Promise<void>
  clearExistingProfileGrant(): void | Promise<void>
}

function hostContext(callId: string, signal: AbortSignal): OperationContext {
  return {
    principal: { sessionId: 'dsh-record-replay-native-host', agentId: 'dsh-record-replay-native-host' },
    callId,
    origin: 'internal',
    signal,
  }
}

function textContent(value: unknown): CuaToolContent[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const GRANT_TOOLS = [
  {
    name: ARM_EXISTING_PROFILE_GRANT,
    description: 'Internal: approve one existing-profile attach for an exact pid + window.',
    inputSchema: {
      type: 'object',
      properties: { pid: { type: 'integer' }, window_id: { type: 'integer' } },
      required: ['pid', 'window_id'],
      additionalProperties: false,
    },
  },
  {
    name: CLEAR_EXISTING_PROFILE_GRANT,
    description: 'Internal: drop any pending existing-profile approval.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const

/**
 * MCP server hosted in the native child process. It exposes the Cua catalog
 * plus two internal grant controls; the plugin hides the internals from the
 * public catalog.
 */
export function createNativeHostServer(runtime: NativeHostRuntime): Server {
  const server = new Server(
    { name: 'dsh-record-replay-native-host', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const catalog = await runtime.listTools(extra.signal)
    const tools = catalog.tools.map(tool => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
    }))
    return { tools: [...tools, ...GRANT_TOOLS] }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as JsonObject

    if (name === ARM_EXISTING_PROFILE_GRANT) {
      const pid = positiveInteger(args['pid'])
      const windowId = positiveInteger(args['window_id'])
      if (pid === undefined || windowId === undefined) {
        return { content: textContent({ error: 'pid and window_id must be positive integers' }) as never, isError: true }
      }
      await runtime.armExistingProfileGrant({ pid, windowId })
      return { content: textContent({ armed: true, pid, window_id: windowId }) as never }
    }

    if (name === CLEAR_EXISTING_PROFILE_GRANT) {
      await runtime.clearExistingProfileGrant()
      return { content: textContent({ cleared: true }) as never }
    }

    try {
      const result = await runtime.callTool(name, args, hostContext(name, extra.signal))
      return {
        content: result.content as never,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      }
    } catch (error) {
      return {
        content: textContent(error instanceof Error ? error.message : String(error)) as never,
        isError: true,
      }
    }
  })

  return server
}
