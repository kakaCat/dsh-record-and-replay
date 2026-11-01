import type { JsonObject, OperationContext } from '../core/api.js'
import { mapCuaError } from '../cua/error-map.js'
import type { CuaToolCatalog, CuaToolResult, CuaTransport } from '../cua/transport.js'

export type FakeTransportHandler = (name: string, args: JsonObject, context: OperationContext) => Promise<CuaToolResult>

/** 可编程 CuaTransport：单测、conformance 与第三方 Driver 样例使用，不启动 MCP 进程。 */
export class FakeTransport implements CuaTransport {
  readonly kind = 'mcp' as const
  listCalls = 0
  callCalls: string[] = []
  closeCalls = 0
  readonly catalog: CuaToolCatalog
  handler: FakeTransportHandler

  constructor(
    toolNames: readonly string[],
    handler: FakeTransportHandler = async () => ({ content: [] }),
  ) {
    this.catalog = { tools: toolNames.map(name => ({ name, description: `fake ${name}` })) }
    this.handler = handler
  }

  async listTools(): Promise<CuaToolCatalog> {
    this.listCalls += 1
    return this.catalog
  }

  async callTool(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult> {
    this.callCalls.push(name)
    try {
      return await this.handler(name, args, context)
    } catch (error) {
      throw mapCuaError(error)
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

export function neverResolve(): Promise<CuaToolResult> {
  return new Promise(() => undefined)
}
