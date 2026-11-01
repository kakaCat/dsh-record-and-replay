import { describe, expect, it } from 'vitest'
import {
  CUA_REQUIRED_BROWSER_TOOLS,
  CuaDriverClient,
  CuaTransportError,
  type CuaToolCatalog,
  type CuaToolResult,
  type CuaTransport,
} from '../../../src/cua/index.js'
import type { JsonObject, OperationContext } from '../../../src/core/api.js'

type CallHandler = (name: string, args: JsonObject, context: OperationContext) => Promise<CuaToolResult>

class FakeTransport implements CuaTransport {
  readonly kind = 'mcp' as const
  listCalls = 0
  callCalls: string[] = []
  closeCalls = 0
  readonly catalog: CuaToolCatalog
  handler: CallHandler

  constructor(handler?: CallHandler, toolNames: readonly string[] = CUA_REQUIRED_BROWSER_TOOLS) {
    this.catalog = {
      tools: toolNames.map(name => ({ name, description: `fake ${name}`, inputSchema: { type: 'object' } })),
    }
    this.handler = handler ?? (async () => ({ content: [] }))
  }

  async listTools(): Promise<CuaToolCatalog> {
    this.listCalls += 1
    return this.catalog
  }

  async callTool(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult> {
    this.callCalls.push(name)
    return this.handler(name, args, context)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

function operationContext(signal = new AbortController().signal): OperationContext {
  return {
    principal: { sessionId: 'session-test', agentId: 'agent-test' },
    callId: 'call-test',
    origin: 'agent',
    signal,
  }
}

const options = { driverVersion: '0.38.0', callTimeoutMs: 10, connectTimeoutMs: 20 }

function neverResolve(): Promise<CuaToolResult> {
  return new Promise(() => undefined)
}

describe('CuaDriverClient', () => {
  it('caches the catalog and exposes capabilities', async () => {
    const fake = new FakeTransport()
    const client = await CuaDriverClient.connect(fake, options)

    expect(fake.listCalls).toBe(1)
    expect(client.capability.browserAutomation).toBe(true)
    expect(client.capability.versionSupported).toBe(true)
    expect(client.hasTool('browser_type')).toBe(true)
    await client.close()
    expect(fake.closeCalls).toBe(1)
  })

  it('rejects a missing required browser tool and closes the transport', async () => {
    const fake = new FakeTransport(undefined, CUA_REQUIRED_BROWSER_TOOLS.filter(name => name !== 'browser_type'))

    await expect(CuaDriverClient.connect(fake, options)).rejects.toMatchObject({
      code: 'CUA_CAPABILITY_MISSING',
    })
    expect(fake.closeCalls).toBe(1)
  })

  it('rejects a driver below the verified minimum version', async () => {
    const fake = new FakeTransport()

    await expect(CuaDriverClient.connect(fake, { ...options, driverVersion: '0.19.3' })).rejects.toMatchObject({
      code: 'CUA_TRANSPORT_UNAVAILABLE',
    })
    expect(fake.closeCalls).toBe(1)
  })

  it('rejects an unknown tool before invoking the transport', async () => {
    const fake = new FakeTransport()
    const client = await CuaDriverClient.connect(fake, options)

    await expect(client.callTool('dsh_browser_open', {}, operationContext())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(fake.callCalls).toEqual([])
    await client.close()
  })

  it('times out a call once and never retries the write', async () => {
    const fake = new FakeTransport(async () => neverResolve())
    const client = await CuaDriverClient.connect(fake, options)

    await expect(client.callTool('browser_click', { ref: 'p1:0' }, operationContext())).rejects.toMatchObject({
      code: 'CUA_CALL_TIMEOUT',
    })
    expect(fake.callCalls).toEqual(['browser_click'])
    await client.close()
  })

  it('maps external cancellation to OPERATION_CANCELLED without retrying', async () => {
    const fake = new FakeTransport(async () => neverResolve())
    const client = await CuaDriverClient.connect(fake, { ...options, callTimeoutMs: 1_000 })
    const controller = new AbortController()
    const pending = client.callTool('browser_type', { ref: 'p1:0', text: 'secret' }, operationContext(controller.signal))
    setTimeout(() => controller.abort(), 10)

    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(fake.callCalls).toEqual(['browser_type'])
    await client.close()
  })

  it('passes through a mapped disconnect and does not retry', async () => {
    const fake = new FakeTransport(async () => {
      throw new CuaTransportError('CUA_TRANSPORT_DISCONNECTED', 'daemon closed connection without response')
    })
    const client = await CuaDriverClient.connect(fake, options)

    await expect(client.callTool('browser_navigate', { url: 'https://example.test' }, operationContext())).rejects.toMatchObject({
      code: 'CUA_TRANSPORT_DISCONNECTED',
    })
    expect(fake.callCalls).toHaveLength(1)
    await client.close()
  })

  it('maps a listTools disconnect during connect and closes the transport', async () => {
    const fake = new FakeTransport()
    fake.listTools = async () => {
      throw new Error('daemon closed connection without response')
    }

    await expect(CuaDriverClient.connect(fake, options)).rejects.toMatchObject({
      code: 'CUA_TRANSPORT_DISCONNECTED',
    })
    expect(fake.listCalls).toBe(0)
    expect(fake.closeCalls).toBe(1)
  })

  it('is idempotent on close and refuses calls after close', async () => {
    const fake = new FakeTransport()
    const client = await CuaDriverClient.connect(fake, options)

    await client.close()
    await client.close()
    expect(fake.closeCalls).toBe(1)
    await expect(client.callTool('browser_type', {}, operationContext())).rejects.toMatchObject({
      code: 'CUA_TRANSPORT_UNAVAILABLE',
    })
  })
})
