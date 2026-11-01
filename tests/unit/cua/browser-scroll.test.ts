import { describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue, OperationContext } from '../../../src/core/api.js'
import { CuaBrowserDriver } from '../../../src/cua/browser-driver.js'
import type { CuaToolCaller } from '../../../src/cua/bindings.js'
import type { CuaToolResult } from '../../../src/cua/transport.js'

function result(data: JsonObject): CuaToolResult {
  return { content: [], structuredContent: data as unknown as JsonValue }
}

function context(): OperationContext {
  return {
    principal: { sessionId: 'scroll-test', agentId: 'agent-test' },
    callId: 'call-scroll-test',
    origin: 'agent',
    signal: new AbortController().signal,
  }
}

interface FakeOptions {
  readonly viewport?: { readonly width: number; readonly height: number }
  readonly hideViewport?: boolean
}

/**
 * Fake Cua that exposes one offscreen bottom button and one visible textbox.
 * `browser_pointer` scrolls are recorded verbatim so tests can assert the
 * exact arguments the driver sent.
 */
class ScrollFake implements CuaToolCaller {
  readonly calls: Array<{ name: string; args: JsonObject }> = []
  private sequence = 0

  constructor(private readonly options: FakeOptions = {}) {}

  async callTool(name: string, args: JsonObject): Promise<CuaToolResult> {
    this.calls.push({ name, args })

    if (name === 'start_session' || name === 'end_session' || name === 'browser_prepare') {
      return result({ status: 'ok' })
    }

    if (name === 'get_browser_state') {
      // Bind mode: pid + window_id, no tab_id.
      if (args['pid'] !== undefined && args['tab_id'] === undefined) {
        return result({
          status: 'ok',
          binding_quality: 'exact',
          binding_route: 'native_cdp_window',
          mode: 'bind',
          target_id: 'bt-scroll',
          tabs: [{ tab_id: 'tab-scroll', active: true, url: 'http://long.test/' }],
        })
      }
      this.sequence += 1
      const snapshot = `p${String(this.sequence)}`
      const page = {
        status: 'ok',
        snapshot: { id: snapshot },
        page: { url: 'http://long.test/', title: 'Long page' },
        refs: [
          { ref: `${snapshot}:0`, role: 'textbox', name: 'Search', visibility: 'in_viewport' },
          { ref: `${snapshot}:1`, role: 'button', name: 'Bottom action', visibility: 'offscreen' },
        ],
      }
      if (args['include_screenshot'] !== true || this.options.hideViewport === true) return result(page)
      const viewport = this.options.viewport ?? { width: 1185, height: 713 }
      return result({
        ...page,
        screenshot: {
          viewport_css_width: viewport.width,
          viewport_css_height: viewport.height,
        },
      })
    }

    if (name === 'browser_pointer') return result({ status: 'ok' })
    return result({ status: 'refused', refusal: { code: 'unknown_tool', message: `unexpected ${name}` } })
  }

  pointerCalls(): Array<{ name: string; args: JsonObject }> {
    return this.calls.filter(call => call.name === 'browser_pointer')
  }
}

async function bound(fake: ScrollFake): Promise<{
  driver: CuaBrowserDriver
  binding: Awaited<ReturnType<CuaBrowserDriver['bind']>>
  context: OperationContext
}> {
  const driver = new CuaBrowserDriver(fake)
  const ctx = context()
  const binding = await driver.bind({ pid: 700, windowId: 70 }, ctx)
  return { driver, binding, context: ctx }
}

describe('CuaBrowserDriver / scroll', () => {
  it('scrolls at a resolved target ref with the pixel delta', async () => {
    const fake = new ScrollFake()
    const { driver, binding, context: ctx } = await bound(fake)
    try {
      const observation = await driver.observe(binding, ctx)
      const resolved = await driver.resolve(binding, { role: 'button', name: 'Bottom action' }, observation)
      const action = await driver.execute(
        binding,
        { kind: 'scroll', target: { role: 'button', name: 'Bottom action' }, deltaX: 0, deltaY: 900 },
        resolved,
        ctx,
      )
      expect(action).toEqual({ status: 'ok' })
      const [pointer] = fake.pointerCalls()
      expect(pointer?.args).toMatchObject({
        action: 'scroll',
        delta_x: 0,
        delta_y: 900,
        ref: resolved.ref,
        input_route: 'trusted',
        target_id: 'bt-scroll',
        tab_id: 'tab-scroll',
      })
      expect(pointer?.args['x']).toBeUndefined()
      expect(pointer?.args['y']).toBeUndefined()
    } finally {
      await driver.release(binding)
    }
  })

  it('scrolls at the viewport centre when no target is given and measures the viewport once', async () => {
    const fake = new ScrollFake({ viewport: { width: 1185, height: 713 } })
    const { driver, binding, context: ctx } = await bound(fake)
    try {
      await driver.execute(binding, { kind: 'scroll', deltaX: 0, deltaY: 600 }, undefined, ctx)
      await driver.execute(binding, { kind: 'scroll', deltaX: 0, deltaY: 600 }, undefined, ctx)

      const pointers = fake.pointerCalls()
      expect(pointers).toHaveLength(2)
      for (const pointer of pointers) {
        expect(pointer.args).toMatchObject({ action: 'scroll', delta_x: 0, delta_y: 600, x: 592, y: 356 })
        expect(pointer.args['ref']).toBeUndefined()
      }
      const measurements = fake.calls.filter(
        call => call.name === 'get_browser_state' && call.args['include_screenshot'] === true,
      )
      expect(measurements).toHaveLength(1)
    } finally {
      await driver.release(binding)
    }
  })

  it('maps horizontal-only deltas without inventing a vertical one', async () => {
    const fake = new ScrollFake()
    const { driver, binding, context: ctx } = await bound(fake)
    try {
      await driver.execute(binding, { kind: 'scroll', deltaX: -120, deltaY: 0 }, undefined, ctx)
      expect(fake.pointerCalls()[0]?.args).toMatchObject({ delta_x: -120, delta_y: 0 })
    } finally {
      await driver.release(binding)
    }
  })

  it('rejects a zero delta before sending any Cua call', async () => {
    const fake = new ScrollFake()
    const { driver, binding, context: ctx } = await bound(fake)
    try {
      await expect(driver.execute(binding, { kind: 'scroll', deltaX: 0, deltaY: 0 }, undefined, ctx))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(fake.pointerCalls()).toHaveLength(0)
    } finally {
      await driver.release(binding)
    }
  })

  it('rejects a targeted scroll that was not resolved', async () => {
    const fake = new ScrollFake()
    const { driver, binding, context: ctx } = await bound(fake)
    try {
      await expect(driver.execute(
        binding,
        { kind: 'scroll', target: { role: 'button', name: 'Bottom action' }, deltaX: 0, deltaY: 300 },
        undefined,
        ctx,
      )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(fake.pointerCalls()).toHaveLength(0)
    } finally {
      await driver.release(binding)
    }
  })

  it('fails clearly when Cua reports no viewport for a no-target scroll', async () => {
    const fake = new ScrollFake({ hideViewport: true })
    const { driver, binding, context: ctx } = await bound(fake)
    try {
      await expect(driver.execute(binding, { kind: 'scroll', deltaX: 0, deltaY: 600 }, undefined, ctx))
        .rejects.toMatchObject({ code: 'BROWSER_BINDING_STALE' })
      expect(fake.pointerCalls()).toHaveLength(0)
    } finally {
      await driver.release(binding)
    }
  })

  it('keeps key unsupported on browser bindings and sends nothing', async () => {
    const fake = new ScrollFake()
    const { driver, binding, context: ctx } = await bound(fake)
    try {
      await expect(driver.execute(binding, { kind: 'key', key: 'Enter' }, undefined, ctx))
        .rejects.toMatchObject({ code: 'ACTION_UNSUPPORTED' })
      const actionCalls = fake.calls.filter(call =>
        call.name === 'browser_pointer' || call.name === 'browser_type' || call.name === 'browser_click')
      expect(actionCalls).toHaveLength(0)
    } finally {
      await driver.release(binding)
    }
  })
})
