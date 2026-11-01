import { describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue, OperationContext } from '../../../src/core/api.js'
import { CuaBrowserDriver } from '../../../src/cua/browser-driver.js'
import type { CuaToolCaller } from '../../../src/cua/bindings.js'
import type { CuaToolResult } from '../../../src/cua/transport.js'

function result(data: JsonObject): CuaToolResult {
  return { content: [], structuredContent: data as unknown as JsonValue }
}

function refused(code: string): CuaToolResult {
  return result({ status: 'refused', refusal: { code, message: `refused: ${code}` } })
}

function context(): OperationContext {
  return {
    principal: { sessionId: 'click-verify', agentId: 'agent-test' },
    callId: 'call-click-verify',
    origin: 'agent',
    signal: new AbortController().signal,
  }
}

type RouteBehavior = 'apply' | 'ignore' | 'refuse-trust' | 'refuse-stale'
type Effect = 'url' | 'focus'

interface FakeOptions {
  readonly trusted?: RouteBehavior
  readonly dom?: RouteBehavior
  readonly trustedEffect?: Effect
  readonly domEffect?: Effect
}

/**
 * Models the SauceDemo condition: the page exposes a Login button, trusted
 * input can be silently dropped (a native Chrome bubble steals the mouse) or
 * refused, and the synthetic DOM route still activates the control.
 */
class ClickFake implements CuaToolCaller {
  readonly calls: Array<{ name: string; args: JsonObject }> = []
  private sequence = 0
  private url = 'https://shop.test/login'
  private focused: string | undefined
  private loggedIn = false

  constructor(private readonly options: FakeOptions = {}) {}

  private apply(effect: Effect): void {
    if (effect === 'url') {
      this.url = 'https://shop.test/inventory'
      this.loggedIn = true
    } else {
      this.focused = 'Login'
    }
  }

  async callTool(name: string, args: JsonObject): Promise<CuaToolResult> {
    this.calls.push({ name, args })
    if (name === 'start_session' || name === 'end_session' || name === 'browser_prepare') return result({ status: 'ok' })

    if (name === 'browser_click') {
      const route = String(args['input_route'] ?? 'trusted')
      if (route === 'dom_event') {
        const behavior = this.options.dom ?? 'apply'
        if (behavior === 'refuse-stale') return refused('browser_ref_stale')
        if (behavior === 'refuse-trust') return refused('browser_input_trust_unavailable')
        if (behavior === 'apply') this.apply(this.options.domEffect ?? 'url')
        return result({ status: 'ok', effect: 'unverifiable' })
      }
      const behavior = this.options.trusted ?? 'apply'
      if (behavior === 'refuse-trust') return refused('browser_input_trust_unavailable')
      if (behavior === 'refuse-stale') return refused('browser_ref_stale')
      if (behavior === 'apply') this.apply(this.options.trustedEffect ?? 'url')
      return result({ status: 'ok', effect: 'unverifiable' })
    }

    if (name === 'browser_type' || name === 'browser_pointer' || name === 'browser_navigate') return result({ status: 'ok' })

    if (name !== 'get_browser_state') return refused('unknown_tool')

    if (args['pid'] !== undefined && args['tab_id'] === undefined) {
      return result({
        status: 'ok',
        binding_quality: 'exact',
        binding_route: 'native_cdp_window',
        mode: 'bind',
        target_id: 'bt-click',
        tabs: [{ tab_id: 'tab-click', active: true, url: this.url }],
      })
    }

    this.sequence += 1
    const snapshot = `p${String(this.sequence)}`
    return result({
      status: 'ok',
      snapshot: { id: snapshot },
      page: { url: this.url, title: 'Shop' },
      refs: [
        {
          ref: `${snapshot}:0`,
          role: 'button',
          name: 'Login',
          actions: ['click'],
          visibility: 'in_viewport',
          states: { focusable: true, ...(this.focused === 'Login' ? { focused: true } : {}) },
        },
        { ref: `${snapshot}:1`, role: 'textbox', name: 'Username', value: 'standard_user', visibility: 'in_viewport' },
        ...(this.loggedIn ? [{ ref: `${snapshot}:2`, role: 'button', name: 'Logout', actions: ['click'] }] : []),
      ],
    })
  }
}

const FAST = { tabFollowTimeoutMs: 20, tabFollowIntervalMs: 1, tabFollowQuietPolls: 2, clickConfirmTimeoutMs: 40, clickConfirmIntervalMs: 5 }

async function clickLogin(caller: ClickFake): Promise<{ summary?: string }> {
  const driver = new CuaBrowserDriver(caller, undefined, FAST)
  const ctx = context()
  const binding = await driver.bind({ pid: 900, windowId: 90 }, ctx)
  try {
    const observation = await driver.observe(binding, ctx)
    const resolved = await driver.resolve(binding, { role: 'button', name: 'Login' }, observation)
    const action = await driver.execute(binding, { kind: 'click', target: { role: 'button', name: 'Login' } }, resolved, ctx)
    return { ...(action.summary === undefined ? {} : { summary: action.summary }) }
  } finally {
    await driver.release(binding)
  }
}

function clickRoutes(caller: ClickFake): string[] {
  return caller.calls.filter(call => call.name === 'browser_click').map(call => String(call.args['input_route']))
}

describe('CuaBrowserDriver / verified click delivery', () => {
  it('accepts a trusted click that changed the page without touching the fallback route', async () => {
    const caller = new ClickFake({ trusted: 'apply' })
    const action = await clickLogin(caller)
    expect(action.summary).toBeUndefined()
    expect(clickRoutes(caller)).toEqual(['trusted'])
  })

  it('re-dispatches as a synthetic DOM click when trusted input produced no page change', async () => {
    const caller = new ClickFake({ trusted: 'ignore', dom: 'apply' })
    const action = await clickLogin(caller)
    expect(action.summary).toContain('re-dispatched as a synthetic DOM click')
    const routes = clickRoutes(caller)
    expect(routes).toEqual(['trusted', 'dom_event'])
    const [trusted, dom] = caller.calls.filter(call => call.name === 'browser_click')
    // The retry must use a ref from a snapshot newer than the clicked one.
    expect(String(dom?.args['ref'])).not.toBe(String(trusted?.args['ref']))
  })

  it('does not retry when the click only moved focus (state signature changed)', async () => {
    const caller = new ClickFake({ trusted: 'apply', trustedEffect: 'focus' })
    const action = await clickLogin(caller)
    expect(action.summary).toBeUndefined()
    expect(clickRoutes(caller)).toEqual(['trusted'])
  })

  it('reports ACTION_UNCONFIRMED when neither route changes the page', async () => {
    const caller = new ClickFake({ trusted: 'ignore', dom: 'ignore' })
    await expect(clickLogin(caller)).rejects.toMatchObject({ code: 'ACTION_UNCONFIRMED' })
    expect(clickRoutes(caller)).toEqual(['trusted', 'dom_event'])
  })

  it('falls back when trusted input is refused as unavailable', async () => {
    const caller = new ClickFake({ trusted: 'refuse-trust', dom: 'apply' })
    const action = await clickLogin(caller)
    expect(action.summary).toContain('trusted input was unavailable')
    expect(clickRoutes(caller)).toEqual(['trusted', 'dom_event'])
  })

  it('surfaces a stale ref from the trusted route instead of retrying blindly', async () => {
    const caller = new ClickFake({ trusted: 'refuse-stale' })
    await expect(clickLogin(caller)).rejects.toMatchObject({ code: 'TARGET_STALE' })
    expect(clickRoutes(caller)).toEqual(['trusted'])
  })

  it('surfaces the refusal code of the fallback dispatch', async () => {
    const caller = new ClickFake({ trusted: 'ignore', dom: 'refuse-stale' })
    await expect(clickLogin(caller)).rejects.toMatchObject({ code: 'TARGET_STALE' })
    expect(clickRoutes(caller)).toEqual(['trusted', 'dom_event'])
  })

  it('never retries right or double clicks', async () => {
    const caller = new ClickFake({ trusted: 'ignore' })
    const driver = new CuaBrowserDriver(caller, undefined, FAST)
    const ctx = context()
    const binding = await driver.bind({ pid: 901, windowId: 91 }, ctx)
    try {
      const observation = await driver.observe(binding, ctx)
      const resolved = await driver.resolve(binding, { role: 'button', name: 'Login' }, observation)
      await driver.execute(binding, { kind: 'click', target: { role: 'button', name: 'Login' }, button: 'right' }, resolved, ctx)
      expect(caller.calls.filter(call => call.name === 'browser_pointer')).toHaveLength(1)
      expect(clickRoutes(caller)).toEqual([])
    } finally {
      await driver.release(binding)
    }
  })
})
