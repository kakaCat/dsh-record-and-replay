import { describe, expect, it, vi } from 'vitest'
import type { Principal } from '../../../src/core/api.js'
import { HostError } from '../../../src/host/config.js'
import { createRecordReplayRuntime } from '../../../src/host/index.js'
import { HOST_TOOL_NAMES } from '../../../src/host/tools.js'
import { FakeBrowserDriver } from './fake-driver.js'
import { FakeReplayPort, rec, run } from './fake-ports.js'
import { RecordingSink, callFor, enabledConfig, walkingClock } from './support.js'

describe('createRecordReplayRuntime', () => {
  it('composes the default (enabled) runtime', async () => {
    const driver = new FakeBrowserDriver()
    const runtime = await createRecordReplayRuntime({ driver })

    expect(runtime.config.recording.enabled).toBe(true)
    expect(runtime.config.replay.enabled).toBe(true)
    expect(runtime.config.skill.enabled).toBe(true)
    expect(runtime.executionEnabled).toBe(true)
    expect(runtime.tools.map(tool => tool.name)).toEqual([...HOST_TOOL_NAMES])
    expect(runtime.contextExtension.cuaRecordReplay).toBe(runtime.service)

    await expect(runtime.remote.listRecordings({}, { token: 'anything' }))
      .rejects.toMatchObject({ code: 'REMOTE_UNAUTHORIZED' })
    await runtime.dispose()
  })

  it('rejects invalid configuration before any resource is created', async () => {
    let factoryCalls = 0
    const disposeResources = vi.fn(async () => undefined)

    await expect(createRecordReplayRuntime({
      config: { recording: { enabled: 'yes' } },
      driverFactory: async () => {
        factoryCalls += 1
        return new FakeBrowserDriver()
      },
      disposeResources,
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })

    expect(factoryCalls).toBe(0)
    expect(disposeResources).not.toHaveBeenCalled()
  })

  it('keeps the host family narrow under a cross-family tools.allow', async () => {
    const skillOnly = await createRecordReplayRuntime({
      config: { tools: { allow: ['cua_skill_load'] } },
      driver: new FakeBrowserDriver(),
    })
    expect(skillOnly.tools).toEqual([])
    await skillOnly.dispose()

    const hostOnly = await createRecordReplayRuntime({
      config: { tools: { allow: ['cua_record_query'] } },
      driver: new FakeBrowserDriver(),
    })
    expect(hostOnly.tools.map(tool => tool.name)).toEqual(['cua_record_query'])
    await hostOnly.dispose()
  })

  it('rejects unknown tool names before any resource is created', async () => {
    let factoryCalls = 0
    await expect(createRecordReplayRuntime({
      config: { tools: { allow: ['browser_click'] } },
      driverFactory: async () => {
        factoryCalls += 1
        return new FakeBrowserDriver()
      },
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    expect(factoryCalls).toBe(0)
  })

  it('requires an injected driver or driver factory', async () => {
    await expect(createRecordReplayRuntime({})).rejects.toMatchObject({ code: 'CUA_TRANSPORT_UNAVAILABLE' })
  })

  it('maps driver factory failures to CUA_TRANSPORT_UNAVAILABLE and releases resources', async () => {
    const disposeResources = vi.fn(async () => undefined)
    await expect(createRecordReplayRuntime({
      config: enabledConfig(),
      driverFactory: async () => {
        throw new Error('cua transport is unavailable')
      },
      disposeResources,
    })).rejects.toMatchObject({ code: 'CUA_TRANSPORT_UNAVAILABLE' })
    expect(disposeResources).toHaveBeenCalledTimes(1)

    const stable = vi.fn(async () => undefined)
    await expect(createRecordReplayRuntime({
      config: enabledConfig(),
      driverFactory: async () => {
        throw new HostError('CUA_CAPABILITY_MISSING', 'tool catalog is missing browser_click')
      },
      disposeResources: stable,
    })).rejects.toMatchObject({ code: 'CUA_CAPABILITY_MISSING' })
    expect(stable).toHaveBeenCalledTimes(1)
  })

  it('wires events, bindings and tools through the runtime', async () => {
    const driver = new FakeBrowserDriver()
    const sink = new RecordingSink()
    const runtime = await createRecordReplayRuntime({
      config: enabledConfig(),
      driver,
      events: sink,
      clock: walkingClock(),
    })

    const bound = await runtime.service.bindBrowser({ pid: 10, windowId: 20 }, callFor('session-a'))
    expect(bound).toMatchObject({ bound: true, driverId: 'fake-driver', sessionId: 'session-a' })

    const actionTool = runtime.tools.find(tool => tool.name === 'cua_record_action')
    expect(actionTool).toBeDefined()
    const receipt = await actionTool!.handle({
      action: { kind: 'click', target: { role: 'button', name: 'Submit' } },
    }, callFor('session-a', { callId: 'call-runtime' })) as unknown as { readonly stepId: string }

    expect(sink.started).toHaveLength(1)
    expect(sink.finished).toHaveLength(1)
    expect(sink.started[0]?.stepId).toBe(receipt.stepId)
    expect(sink.started[0]?.callId).toBe('call-runtime')

    await runtime.dispose()
  })

  it('disposes once, releases bindings and releases external resources last', async () => {
    const driver = new FakeBrowserDriver()
    const order: string[] = []
    const disposeResources = vi.fn(async () => {
      order.push(`external:${String(driver.releaseCalls)}`)
    })
    const runtime = await createRecordReplayRuntime({
      config: enabledConfig(),
      driver,
      disposeResources,
    })

    await runtime.service.bindBrowser({ pid: 10, windowId: 20 }, callFor('session-a'))
    await runtime.dispose()
    expect(order).toEqual(['external:1'])
    expect(driver.releaseCalls).toBe(1)
    expect(runtime.service.isDisposed).toBe(true)

    await runtime.dispose()
    expect(disposeResources).toHaveBeenCalledTimes(1)
    expect(driver.releaseCalls).toBe(1)
  })

  it('exposes the remote boundary with authentication and operator controls', async () => {
    const replay = new FakeReplayPort()
    replay.runs = [{ runId: run('1'), recordingId: rec('a'), status: 'running', ownerSessionId: 'session-a' }]
    const runtime = await createRecordReplayRuntime({
      config: enabledConfig(),
      driver: new FakeBrowserDriver(),
      replay,
      authenticateRemote: (credential): Principal | undefined => (
        credential?.token === 'token-a' ? { agentId: 'agent-a', sessionId: 'session-a' } : undefined
      ),
      operatorControlsEnabled: () => true,
    })

    const cancelled = await runtime.remote.cancelRun(
      { runId: run('1'), ownerSessionId: 'session-a' },
      { token: 'token-a' },
    )
    expect(cancelled.data.status).toBe('cancelled')

    await expect(runtime.remote.cancelRun(
      { runId: run('1'), ownerSessionId: 'session-b' },
      { token: 'token-a' },
    )).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await runtime.dispose()
  })
})
