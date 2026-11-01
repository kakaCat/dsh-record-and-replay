import { describe, expect, it, vi } from 'vitest'
import { WorkerTransport } from '../../../src/cua/worker-transport.js'
import { ARM_EXISTING_PROFILE_GRANT, CLEAR_EXISTING_PROFILE_GRANT } from '../../../src/cua/native-host-protocol.js'
import type { JsonObject, OperationContext } from '../../../src/core/api.js'
import type { CuaToolCatalog, CuaToolResult, CuaTransport } from '../../../src/cua/transport.js'

function context(): OperationContext {
  return {
    principal: { sessionId: 'session-worker', agentId: 'agent-worker' },
    callId: 'call-worker',
    origin: 'internal',
    signal: new AbortController().signal,
  }
}

function fakeMcp() {
  const calls: Array<{ name: string; args: JsonObject }> = []
  const catalog: CuaToolCatalog = {
    tools: [
      { name: 'start_session' },
      { name: 'browser_prepare' },
      { name: ARM_EXISTING_PROFILE_GRANT },
      { name: CLEAR_EXISTING_PROFILE_GRANT },
    ],
  }
  const transport: CuaTransport & { pid?: number } = {
    kind: 'native',
    listTools: vi.fn(async () => catalog),
    callTool: vi.fn(async (name: string, args: JsonObject): Promise<CuaToolResult> => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } }
    }),
    close: vi.fn(async () => undefined),
  }
  return { transport, calls }
}

describe('cua/worker-transport', () => {
  it('hides the internal grant tools from the public catalog', async () => {
    const { transport } = fakeMcp()
    const worker = await WorkerTransport.create({ createMcp: async () => transport })

    const catalog = await worker.listTools(new AbortController().signal)

    expect(catalog.tools.map(tool => tool.name)).toEqual(['start_session', 'browser_prepare'])
    expect(worker.kind).toBe('native')
  })

  it('refuses to forward an internal control tool as a normal call', async () => {
    const { transport, calls } = fakeMcp()
    const worker = await WorkerTransport.create({ createMcp: async () => transport })

    await expect(worker.callTool(ARM_EXISTING_PROFILE_GRANT, {}, context())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toEqual([])
  })

  it('arms the grant over the control channel before prepare can run', async () => {
    const { transport, calls } = fakeMcp()
    const worker = await WorkerTransport.create({ createMcp: async () => transport })

    await worker.armExistingProfileGrant({ pid: 42, windowId: 77 })

    expect(calls).toEqual([
      { name: ARM_EXISTING_PROFILE_GRANT, args: { pid: 42, window_id: 77 } },
    ])
  })

  it('clears the grant even when the child is already gone', async () => {
    const { transport } = fakeMcp()
    transport.callTool = vi.fn(async () => { throw new Error('Not connected') })
    const worker = await WorkerTransport.create({ createMcp: async () => transport })

    await expect(worker.clearExistingProfileGrant()).resolves.toBeUndefined()
  })

  it('delegates tool calls and close to the MCP transport', async () => {
    const { transport, calls } = fakeMcp()
    const worker = await WorkerTransport.create({ createMcp: async () => transport })

    const result = await worker.callTool('browser_prepare', { pid: 1 }, context())
    expect(result.structuredContent).toEqual({ ok: true })
    expect(calls).toEqual([{ name: 'browser_prepare', args: { pid: 1 } }])

    await worker.close()
    expect(transport.close).toHaveBeenCalledTimes(1)
  })
})
