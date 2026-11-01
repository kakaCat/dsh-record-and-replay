import { describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue, OperationContext, SemanticTarget } from '../../src/core/api.js'
import { CuaBrowserDriver } from '../../src/cua/browser-driver.js'
import { CuaSessionRegistry, type CuaToolCaller } from '../../src/cua/bindings.js'
import type { CuaToolResult } from '../../src/cua/transport.js'

function result(data: JsonObject): CuaToolResult {
  return { content: [], structuredContent: data as unknown as JsonValue }
}

function context(sessionId: string): OperationContext {
  return {
    principal: { sessionId, agentId: 'agent-test' },
    callId: `call-${sessionId}`,
    origin: 'agent',
    signal: new AbortController().signal,
  }
}

class FakeCua implements CuaToolCaller {
  readonly calls: string[] = []
  readonly pointerCalls: JsonObject[] = []
  private sequence = 0
  private readonly pages = new Map<string, string>()

  async callTool(name: string, args: JsonObject, ctx: OperationContext): Promise<CuaToolResult> {
    this.calls.push(name)
    const session = String(args['session'] ?? '')
    if (name === 'start_session') return result({ status: 'ok', active: true })
    if (name === 'end_session') return result({ status: 'ok' })
    if (name === 'browser_prepare') return result({ status: 'ok' })
    if (name === 'get_browser_state' && args['pid'] !== undefined) {
      const windowId = Number(args['window_id'])
      const targetId = `bt-${session}-${String(windowId)}`
      const tabId = `tab-${session}-${String(windowId)}`
      return result({
        status: 'ok',
        binding_quality: 'exact',
        target_id: targetId,
        tabs: [{ tab_id: tabId, active: true, title: 'Cua Binding Fixture', url: 'about:blank' }],
      })
    }
    if (name === 'get_browser_state') {
      const tabId = String(args['tab_id'])
      const key = `${session}:${tabId}`
      const url = this.pages.get(key) ?? `https://example.test/${tabId}`
      this.sequence += 1
      return result({
        status: 'ok',
        snapshot: { id: `p${String(this.sequence)}` },
        page: { url, title: 'fixture' },
        refs: [
          { ref: `p${String(this.sequence)}:0`, role: 'button', name: 'Submit', actions: ['click'] },
          { ref: `p${String(this.sequence)}:1`, role: 'textbox', name: 'Name', value: 'Ada', actions: ['type'] },
        ],
      })
    }
    if (name === 'browser_navigate') {
      this.pages.set(`${session}:${String(args['tab_id'])}`, String(args['url']))
      return result({ status: 'ok', url: String(args['url']) })
    }
    if (name === 'browser_click' || name === 'browser_type') return result({ status: 'ok' })
    if (name === 'browser_pointer') {
      this.pointerCalls.push(args)
      return result({ status: 'ok' })
    }
    return result({ status: 'refused', refusal: { code: 'unknown_tool' } })
  }
}

describe('CuaBrowserDriver / Session Binding', () => {
  it('keeps two sessions on separate targets and releases them independently', async () => {
    const driver = new CuaBrowserDriver(new FakeCua())
    const bindingA = await driver.bind({ pid: 100, windowId: 10 }, context('session-a'))
    expect(bindingA.title).toBe('Cua Binding Fixture')
    const bindingB = await driver.bind({ pid: 100, windowId: 11 }, context('session-b'))

    expect(bindingA.targetId).not.toBe(bindingB.targetId)
    expect(bindingA.tabId).not.toBe(bindingB.tabId)
    expect(bindingA.sessionId).toBe('session-a')
    expect(bindingB.sessionId).toBe('session-b')

    await driver.release(bindingA)
    await expect(driver.observe(bindingA, context('session-a'))).rejects.toMatchObject({
      code: 'BROWSER_BINDING_STALE',
    })
    await driver.release(bindingB)
  })

  it('rejects a second session that targets the same native window', async () => {
    const driver = new CuaBrowserDriver(new FakeCua())
    await driver.bind({ pid: 200, windowId: 20 }, context('session-a'))

    await expect(driver.bind({ pid: 200, windowId: 20 }, context('session-b'))).rejects.toMatchObject({
      code: 'BROWSER_TARGET_BUSY',
    })
  })

  it('invalidates an observation after navigation and allows a fresh observe', async () => {
    const driver = new CuaBrowserDriver(new FakeCua())
    const binding = await driver.bind({ pid: 300, windowId: 30 }, context('session-a'))
    const oldObservation = await driver.observe(binding, context('session-a'))
    const target: SemanticTarget = { role: 'button', name: 'Submit' }
    const resolved = await driver.resolve(binding, target, oldObservation)

    await driver.execute(binding, { kind: 'navigate', url: 'https://example.test/next' }, undefined, context('session-a'))
    await expect(driver.resolve(binding, target, oldObservation)).rejects.toMatchObject({
      code: 'TARGET_STALE',
    })
    await expect(driver.execute(binding, {
      kind: 'click',
      target,
    }, resolved, context('session-a'))).rejects.toMatchObject({
      code: 'TARGET_STALE',
    })

    const fresh = await driver.observe(binding, context('session-a'))
    const freshResolved = await driver.resolve(binding, target, fresh)
    expect(freshResolved.observationId).not.toBe(oldObservation.observationId)
    await driver.release(binding)

    const rebound = await driver.bind({ pid: 300, windowId: 30 }, context('session-a'))
    const reboundObservation = await driver.observe(rebound, context('session-a'))
    await expect(driver.resolve(rebound, target, reboundObservation)).resolves.toMatchObject({ role: 'button' })
    await driver.release(rebound)
  })

  it('rejects ambiguous and missing semantic targets', async () => {
    const driver = new CuaBrowserDriver(new FakeCua())
    const binding = await driver.bind({ pid: 400, windowId: 40 }, context('session-a'))
    const observation = await driver.observe(binding, context('session-a'))

    await expect(driver.resolve(binding, { role: 'button', name: 'Missing' }, observation)).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    })
    await expect(driver.resolve(binding, { role: 'missing-role' }, observation)).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    })
  })

  it('maps browser right-click and double-click to browser_pointer, keeping single left click on browser_click', async () => {
    const caller = new FakeCua()
    const driver = new CuaBrowserDriver(caller)
    const ctx = context('session-pointer')
    const binding = await driver.bind({ pid: 500, windowId: 50 }, ctx)
    const target: SemanticTarget = { role: 'button', name: 'Submit' }
    const act = async (click: { button?: 'left' | 'right'; count?: number }) => {
      const observation = await driver.observe(binding, ctx)
      const resolved = await driver.resolve(binding, target, observation)
      return await driver.execute(binding, { kind: 'click', target, ...click }, resolved, ctx)
    }

    const lastActionCall = (): string | undefined =>
      [...caller.calls].reverse().find(name => name !== 'get_browser_state')

    await act({ button: 'right' })
    expect(lastActionCall()).toBe('browser_pointer')
    expect(caller.pointerCalls.at(-1)).toMatchObject({ action: 'right_click', input_route: 'trusted' })

    await act({ count: 2 })
    expect(caller.pointerCalls.at(-1)).toMatchObject({ action: 'double_click' })

    const pointerCalls = caller.pointerCalls.length
    await act({})
    expect(lastActionCall()).toBe('browser_click')
    expect(caller.pointerCalls).toHaveLength(pointerCalls)

    await expect(act({ count: 3 })).rejects.toMatchObject({ code: 'ACTION_UNSUPPORTED' })
    await expect(act({ button: 'right', count: 2 })).rejects.toMatchObject({ code: 'ACTION_UNSUPPORTED' })
    await driver.release(binding)
  })

  it('drags between two resolved refs with browser_pointer', async () => {
    const caller = new FakeCua()
    const driver = new CuaBrowserDriver(caller)
    const ctx = context('session-drag')
    const binding = await driver.bind({ pid: 600, windowId: 60 }, ctx)
    await expect(driver.execute(binding, {
      kind: 'drag',
      from: { role: 'button', name: 'Submit' },
      to: { role: 'textbox', name: 'Name' },
    }, undefined, ctx)).resolves.toEqual({ status: 'ok' })

    const call = caller.pointerCalls.at(-1)
    expect(call).toMatchObject({ action: 'drag', input_route: 'trusted' })
    expect(String(call?.['ref'])).toMatch(/^p\d+:0$/)
    expect(String(call?.['destination_ref'])).toMatch(/^p\d+:1$/)
    await driver.release(binding)
  })

  it('prepares an existing profile when the native refusal carries next_action', async () => {
    class NativeFlavouredCua implements CuaToolCaller {
      readonly calls: string[] = []
      readonly grants: Array<{ pid: number; windowId: number }> = []
      prepareArgs: JsonObject | undefined
      cleared = 0
      private prepared = false

      armExistingProfileGrant(grant: { readonly pid: number; readonly windowId: number }): void {
        this.grants.push({ pid: grant.pid, windowId: grant.windowId })
      }

      clearExistingProfileGrant(): void {
        this.cleared += 1
      }

      async callTool(name: string, args: JsonObject): Promise<CuaToolResult> {
        this.calls.push(name)
        if (name === 'start_session') return result({ status: 'ok' })
        if (name === 'end_session') return result({ status: 'ok' })
        if (name === 'browser_prepare') {
          this.prepareArgs = args
          this.prepared = true
          return result({ status: 'ok' })
        }
        if (name === 'get_browser_state' && args['pid'] !== undefined) {
          if (!this.prepared) {
            return result({
              status: 'refused',
              refusal: {
                code: 'browser_consent_required',
                message: 'existing-profile approval required',
                detail: { next_action: 'browser_prepare', supported_strategies: ['existing_profile'] },
              },
            })
          }
          return result({
            status: 'ok',
            binding_quality: 'exact',
            target_id: 'bt-1',
            tabs: [{ tab_id: 'tab-1', active: true }],
          })
        }
        return result({ status: 'refused', refusal: { code: 'unknown_tool' } })
      }
    }

    const caller = new NativeFlavouredCua()
    const driver = new CuaBrowserDriver(caller)
    const binding = await driver.bind({ pid: 500, windowId: 50 }, context('session-a'))

    expect(caller.grants).toEqual([{ pid: 500, windowId: 50 }])
    expect(caller.prepareArgs).toMatchObject({
      pid: 500,
      window_id: 50,
      strategy: { kind: 'existing_profile' },
      session: 'dsh-record-replay-session-a',
    })
    expect(caller.calls).toEqual(['end_session', 'start_session', 'get_browser_state', 'browser_prepare', 'get_browser_state'])
    expect(caller.cleared).toBe(1)
    expect(binding.targetId).toBe('bt-1')
    expect(binding.tabId).toBe('tab-1')
    await driver.release(binding)
  })

  it('launches and binds a driver-owned isolated browser when asked', async () => {
    class IsolatedCua implements CuaToolCaller {
      readonly calls: string[] = []
      prepareArgs: JsonObject | undefined

      async callTool(name: string, args: JsonObject): Promise<CuaToolResult> {
        this.calls.push(name)
        if (name === 'start_session') return result({ status: 'ok' })
        if (name === 'end_session') return result({ status: 'ok' })
        if (name === 'browser_prepare') {
          this.prepareArgs = args
          return result({ status: 'ok', prepared_pid: 900, action: 'launched_isolated_browser' })
        }
        if (name === 'list_windows') {
          return result({
            windows: [
              { pid: 111, window_id: 1, layer: 0, bounds: { width: 1200, height: 800 } },
              { pid: 900, window_id: 91, layer: 0, is_on_screen: true, bounds: { width: 1200, height: 800 } },
            ],
          })
        }
        if (name === 'get_browser_state' && args['pid'] !== undefined) {
          return result({
            status: 'ok',
            binding_quality: 'exact',
            target_id: 'bt-iso',
            tabs: [{ tab_id: 'tab-iso', active: true }],
          })
        }
        return result({ status: 'refused', refusal: { code: 'unknown_tool' } })
      }
    }

    const caller = new IsolatedCua()
    const driver = new CuaBrowserDriver(caller)
    const binding = await driver.bind({ launch: 'isolated', profileName: 'demo-profile' }, context('session-a'))

    expect(caller.prepareArgs).toMatchObject({
      allow_launch: true,
      profile: { mode: 'isolated_named', name: 'demo-profile' },
      session: 'dsh-record-replay-session-a',
    })
    expect(caller.calls).toEqual(['end_session', 'start_session', 'browser_prepare', 'list_windows', 'get_browser_state'])
    expect(binding.pid).toBe(900)
    expect(binding.windowId).toBe(91)
    expect(binding.targetId).toBe('bt-iso')
    expect(binding.tabId).toBe('tab-iso')
    await driver.release(binding)
  })


  it('surfaces a refusal that is not a prepare hint instead of silently preparing', async () => {
    class RefusingCua implements CuaToolCaller {
      async callTool(name: string): Promise<CuaToolResult> {
        if (name === 'start_session') return result({ status: 'ok' })
        if (name === 'end_session') return result({ status: 'ok' })
        return result({
          status: 'refused',
          refusal: { code: 'browser_wrong_target_refused', message: 'not the top-level browser' },
        })
      }
    }

    const driver = new CuaBrowserDriver(new RefusingCua())
    await expect(driver.bind({ pid: 600, windowId: 60 }, context('session-a'))).rejects.toMatchObject({
      code: 'BROWSER_BINDING_STALE',
    })
  })
})

describe('CuaBrowserDriver assert', () => {
  async function boundDriver() {
    const caller = new FakeCua()
    const driver = new CuaBrowserDriver(caller, undefined, { assertSettleTimeoutMs: 20, assertSettleIntervalMs: 5 })
    const binding = await driver.bind({ pid: 910, windowId: 91 }, context('assert'))
    return { driver, binding, ctx: context('assert') }
  }

  it('passes url/text/element/value checks and fails with ASSERTION_FAILED', async () => {
    const { driver, binding, ctx } = await boundDriver()
    try {
      await expect(driver.execute(binding, { kind: 'assert', check: { kind: 'url', contains: 'example.test' } }, undefined, ctx))
        .resolves.toEqual({ status: 'ok' })
      await expect(driver.execute(binding, { kind: 'assert', check: { kind: 'url', contains: 'checkout' } }, undefined, ctx))
        .rejects.toMatchObject({ code: 'ASSERTION_FAILED' })

      await expect(driver.execute(binding, { kind: 'assert', check: { kind: 'text', contains: 'Submit' } }, undefined, ctx))
        .resolves.toEqual({ status: 'ok' })
      await expect(driver.execute(binding, { kind: 'assert', check: { kind: 'text', contains: 'NotOnPage' } }, undefined, ctx))
        .rejects.toMatchObject({ code: 'ASSERTION_FAILED' })

      await expect(driver.execute(binding, { kind: 'assert', check: { kind: 'element', target: { role: 'button', name: 'Submit' }, exists: true } }, undefined, ctx))
        .resolves.toEqual({ status: 'ok' })
      await expect(driver.execute(binding, { kind: 'assert', check: { kind: 'element', target: { role: 'button', name: 'Submit' }, exists: false } }, undefined, ctx))
        .rejects.toMatchObject({ code: 'ASSERTION_FAILED' })

      await expect(driver.execute(binding, { kind: 'assert', check: { kind: 'value', target: { role: 'textbox', name: 'Name' }, equals: 'Ada' } }, undefined, ctx))
        .resolves.toEqual({ status: 'ok' })
      await expect(driver.execute(binding, { kind: 'assert', check: { kind: 'value', target: { role: 'textbox', name: 'Name' }, equals: 'Bob' } }, undefined, ctx))
        .rejects.toMatchObject({ code: 'ASSERTION_FAILED' })
    } finally {
      await driver.release(binding)
    }
  })
})

describe('CuaBrowserDriver desktop binding', () => {
  class FakeDesktop implements CuaToolCaller {
    readonly calls: Array<{ name: string; args: JsonObject }> = []
    async callTool(name: string, args: JsonObject): Promise<CuaToolResult> {
      this.calls.push({ name, args })
      if (name === 'get_window_state') {
        return result({
          window_title: 'DeepSeek Harness',
          snapshot_id: 's1',
          elements: [
            { element_token: 's1:0', role: 'AXButton', label: '插件', enabled: true, actions: ['press'] },
            { element_token: 's1:1', role: 'AXTextField', label: '搜索会话名称', value: 'old', enabled: true },
          ],
        })
      }
      return result({ status: 'ok' })
    }
  }

  it('binds a window, observes AX elements, clicks and asserts', async () => {
    const caller = new FakeDesktop()
    const driver = new CuaBrowserDriver(caller)
    const ctx = context('desktop')
    const binding = await driver.bind({ launch: 'desktop', pid: 42, windowId: 7 }, ctx)
    try {
      expect(binding.driverId).toBe('cua-desktop')
      const observation = await driver.observe(binding, ctx)
      expect(observation.elements.map(element => element.role)).toEqual(['AXButton', 'AXTextField'])

      const resolved = await driver.resolve(binding, { role: 'AXButton', name: '插件' }, observation)
      await driver.execute(binding, { kind: 'click', target: { role: 'AXButton', name: '插件' } }, resolved, ctx)
      expect(caller.calls.find(call => call.name === 'click')?.args).toMatchObject({ element_token: 's1:0' })

      await driver.execute(binding, {
        kind: 'click', target: { role: 'AXButton', name: '插件' }, button: 'right', count: 2,
      }, resolved, ctx)
      expect(caller.calls.filter(call => call.name === 'click').at(-1)?.args)
        .toMatchObject({ button: 'right', count: 2 })

      await expect(driver.execute(binding, {
        kind: 'assert', check: { kind: 'element', target: { role: 'AXButton', name: '插件' }, exists: true },
      }, undefined, ctx)).resolves.toEqual({ status: 'ok' })
      await expect(driver.execute(binding, {
        kind: 'assert', check: { kind: 'value', target: { role: 'AXTextField', name: '搜索会话名称' }, equals: 'old' },
      }, undefined, ctx)).resolves.toEqual({ status: 'ok' })
      await expect(driver.execute(binding, {
        kind: 'assert', check: { kind: 'element', target: { role: 'AXButton', name: '插件' }, exists: false },
      }, undefined, ctx)).rejects.toMatchObject({ code: 'ASSERTION_FAILED' })
      await expect(driver.execute(binding, { kind: 'navigate', url: 'https://example.test' }, undefined, ctx))
        .rejects.toMatchObject({ code: 'ACTION_UNSUPPORTED' })
    } finally {
      await driver.release(binding)
    }
  })
})
