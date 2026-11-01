import { describe, expect, it, vi } from 'vitest'
import { NativeTransport, authorizationRequestMatches } from '../../../src/cua/native-transport.js'
import type { OperationContext } from '../../../src/core/api.js'

function context(): OperationContext {
  return {
    principal: { sessionId: 'session-native', agentId: 'agent-native' },
    callId: 'call-native',
    origin: 'internal',
    signal: new AbortController().signal,
  }
}

interface FakeDriver {
  listToolsJson: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  uniffiDestroy: ReturnType<typeof vi.fn>
}

interface FakeSdkOptions {
  catalog?: string
  toolResult?: string
  throwOnImport?: boolean
  driver?: FakeDriver
}

function fakeSdk(options: FakeSdkOptions = {}) {
  const driver: FakeDriver = options.driver ?? {
    listToolsJson: vi.fn(async () => options.catalog ?? JSON.stringify({ tools: [] })),
    callTool: vi.fn(async () => ({ rawJson: options.toolResult ?? JSON.stringify({ content: [] }) })),
    shutdown: vi.fn(async () => undefined),
    uniffiDestroy: vi.fn(),
  }
  let host: { authorize: (request: unknown) => Promise<{ action: number; requestDigest: string }> } | undefined
  const sdk = {
    CuaDriver: {
      createConfiguredWithAuthorizationHost: vi.fn(async (_options: unknown, given: unknown) => {
        host = given as typeof host
        return driver
      }),
    },
  }
  return {
    driver,
    sdk,
    loadSdk: async () => {
      if (options.throwOnImport === true) throw new Error('Cannot find module @trycua/cua-driver')
      return sdk as never
    },
    authorize: async (resource: unknown, digest = 'digest-1') => {
      if (host === undefined) throw new Error('authorization host was not registered')
      return host.authorize({ requestDigest: digest, resourceJson: JSON.stringify(resource) })
    },
  }
}

describe('cua/native-transport', () => {
  it('exposes the native catalog through the transport contract', async () => {
    const fake = fakeSdk({
      catalog: JSON.stringify({
        tools: [
          { name: 'start_session', description: 'Declare a session' },
          { name: 'browser_prepare', inputSchema: { type: 'object' } },
          { description: 'nameless tools are ignored' },
        ],
      }),
    })
    const transport = await NativeTransport.create({ loadSdk: fake.loadSdk })

    expect(transport.kind).toBe('native')
    await expect(transport.listTools(new AbortController().signal)).resolves.toEqual({
      tools: [
        { name: 'start_session', description: 'Declare a session' },
        { name: 'browser_prepare', inputSchema: { type: 'object' } },
      ],
    })
    await transport.close()
  })

  it('forwards tool calls as JSON and normalizes the MCP-shaped result', async () => {
    const fake = fakeSdk({
      toolResult: JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { status: 'ok' },
      }),
    })
    const transport = await NativeTransport.create({ loadSdk: fake.loadSdk })

    const result = await transport.callTool('browser_prepare', { pid: 7 }, context())

    expect(result.structuredContent).toEqual({ status: 'ok' })
    expect(fake.driver.callTool).toHaveBeenCalledWith(
      'browser_prepare',
      JSON.stringify({ pid: 7 }),
      expect.objectContaining({ signal: expect.anything() }),
    )
    await transport.close()
  })

  it('approves only the exact pid/window armed by the in-flight bind', async () => {
    const fake = fakeSdk()
    const transport = await NativeTransport.create({ loadSdk: fake.loadSdk, grantTtlMs: 1_000, now: () => 100 })

    await expect(fake.authorize({ pid: 42, window_id: 77 })).resolves.toEqual({
      action: 1,
      requestDigest: 'digest-1',
    })

    transport.armExistingProfileGrant({ pid: 42, windowId: 77 })
    await expect(fake.authorize({ browser: { pid: 42, window_id: 77 } })).resolves.toEqual({
      action: 0,
      requestDigest: 'digest-1',
    })
    // A different window on the same browser process is still denied.
    await expect(fake.authorize({ pid: 42, window_id: 78 })).resolves.toEqual({
      action: 1,
      requestDigest: 'digest-1',
    })
    // A different process is denied.
    await expect(fake.authorize({ pid: 43, window_id: 77 })).resolves.toEqual({
      action: 1,
      requestDigest: 'digest-1',
    })

    transport.clearExistingProfileGrant()
    await expect(fake.authorize({ pid: 42, window_id: 77 })).resolves.toEqual({
      action: 1,
      requestDigest: 'digest-1',
    })
    await transport.close()
  })

  it('stops approving once the grant expires', async () => {
    let now = 1_000
    const fake = fakeSdk()
    const transport = await NativeTransport.create({ loadSdk: fake.loadSdk, grantTtlMs: 50, now: () => now })

    transport.armExistingProfileGrant({ pid: 5, windowId: 6 })
    now = 1_049
    await expect(fake.authorize({ pid: 5, window_id: 6 })).resolves.toMatchObject({ action: 0 })

    now = 1_051
    await expect(fake.authorize({ pid: 5, window_id: 6 })).resolves.toMatchObject({ action: 1 })
    await transport.close()
  })

  it('denies requests whose resource shape cannot be parsed', () => {
    expect(authorizationRequestMatches({ resourceJson: 'not json' }, { pid: 1, windowId: 2 })).toBe(false)
    expect(authorizationRequestMatches({ resourceJson: '{"pid":1}' }, { pid: 1, windowId: 2 })).toBe(false)
    expect(authorizationRequestMatches({ resourceJson: '{"pid":"1","window_id":"2"}' }, { pid: 1, windowId: 2 })).toBe(true)
  })

  it('fails loudly on a malformed catalog and a missing SDK', async () => {
    const malformed = fakeSdk({ catalog: JSON.stringify({ nope: true }) })
    const transport = await NativeTransport.create({ loadSdk: malformed.loadSdk })
    await expect(transport.listTools(new AbortController().signal)).rejects.toMatchObject({
      code: 'CUA_TRANSPORT_UNAVAILABLE',
    })
    await transport.close()

    const missing = fakeSdk({ throwOnImport: true })
    await expect(NativeTransport.create({ loadSdk: missing.loadSdk })).rejects.toMatchObject({
      code: 'CUA_CAPABILITY_MISSING',
    })
  })

  it('shuts the native handle down exactly once', async () => {
    const fake = fakeSdk()
    const transport = await NativeTransport.create({ loadSdk: fake.loadSdk })

    await transport.close()
    await transport.close()

    expect(fake.driver.shutdown).toHaveBeenCalledTimes(1)
    expect(fake.driver.uniffiDestroy).toHaveBeenCalledTimes(1)
  })
})
