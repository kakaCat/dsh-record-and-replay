import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createNativeHostServer, type NativeHostRuntime } from '../../src/cua/native-host-server.js'
import type { CuaToolResult } from '../../src/cua/transport.js'
import type { JsonObject, OperationContext } from '../../src/core/api.js'

function fakeRuntime() {
  const armed: Array<{ pid: number; windowId: number }> = []
  let cleared = 0
  const calls: Array<{ name: string; args: JsonObject }> = []
  const runtime: NativeHostRuntime = {
    listTools: vi.fn(async () => ({
      tools: [
        { name: 'start_session', description: 'Declare a session' },
        { name: 'browser_prepare', inputSchema: { type: 'object', properties: {} } },
        { name: 'broken_tool' },
      ],
    })),
    callTool: vi.fn(async (name: string, args: JsonObject, _context: OperationContext): Promise<CuaToolResult> => {
      calls.push({ name, args })
      if (name === 'broken_tool') throw new Error('native exploded')
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { status: 'ok', echoed: args['pid'] ?? null },
      }
    }),
    armExistingProfileGrant: (grant) => { armed.push({ pid: grant.pid, windowId: grant.windowId }) },
    clearExistingProfileGrant: () => { cleared += 1 },
  }
  return { runtime, armed, calls, cleared: () => cleared }
}

async function connect() {
  const fake = fakeRuntime()
  const server = createNativeHostServer(fake.runtime)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { ...fake, client, close: async () => { await client.close() } }
}

describe('native host MCP server', () => {
  it('publishes the Cua catalog plus the internal grant controls', async () => {
    const host = await connect()
    try {
      const { tools } = await host.client.listTools()
      const names = tools.map(tool => tool.name)
      expect(names).toContain('start_session')
      expect(names).toContain('browser_prepare')
      expect(names).toContain('__dsh_arm_existing_profile_grant')
      expect(names).toContain('__dsh_clear_existing_profile_grant')
      // Missing input schemas are filled in so MCP clients always see an object.
      const broken = tools.find(tool => tool.name === 'broken_tool')
      expect(broken?.inputSchema).toMatchObject({ type: 'object' })
    } finally {
      await host.close()
    }
  })

  it('forwards normal tools and their structured results', async () => {
    const host = await connect()
    try {
      const result = await host.client.callTool({ name: 'browser_prepare', arguments: { pid: 7 } })
      expect(result.structuredContent).toEqual({ status: 'ok', echoed: 7 })
      expect(host.calls).toEqual([{ name: 'browser_prepare', args: { pid: 7 } }])
    } finally {
      await host.close()
    }
  })

  it('arms and clears the existing-profile grant through the control tools', async () => {
    const host = await connect()
    try {
      await host.client.callTool({
        name: '__dsh_arm_existing_profile_grant',
        arguments: { pid: 42, window_id: 77 },
      })
      await host.client.callTool({ name: '__dsh_clear_existing_profile_grant', arguments: {} })

      expect(host.armed).toEqual([{ pid: 42, windowId: 77 }])
      expect(host.cleared()).toBe(1)
    } finally {
      await host.close()
    }
  })

  it('rejects malformed grant arguments', async () => {
    const host = await connect()
    try {
      const result = await host.client.callTool({
        name: '__dsh_arm_existing_profile_grant',
        arguments: { pid: 0, window_id: -1 },
      })
      expect(result.isError).toBe(true)
      expect(host.armed).toEqual([])
    } finally {
      await host.close()
    }
  })

  it('turns a runtime failure into a tool error without killing the server', async () => {
    const host = await connect()
    try {
      const failed = await host.client.callTool({ name: 'broken_tool', arguments: {} })
      expect(failed.isError).toBe(true)
      const ok = await host.client.callTool({ name: 'browser_prepare', arguments: { pid: 9 } })
      expect(ok.isError).toBeFalsy()
    } finally {
      await host.close()
    }
  })
})
