import { describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue, OperationContext } from '../../../src/core/api.js'
import { CuaDesktopDriver } from '../../../src/cua/desktop-driver.js'
import type { CuaToolCaller } from '../../../src/cua/bindings.js'
import type { CuaToolResult } from '../../../src/cua/transport.js'

function result(data: JsonObject): CuaToolResult {
  return { content: [], structuredContent: data as unknown as JsonValue }
}

function context(): OperationContext {
  return {
    principal: { sessionId: 'session-desktop', agentId: 'agent-test' },
    callId: 'call-desktop',
    origin: 'agent',
    signal: new AbortController().signal,
  }
}

class FakeDesktop implements CuaToolCaller {
  readonly calls: Array<{ name: string; args: JsonObject }> = []
  private seq = 0
  verifyStatus = 'satisfied'

  async callTool(name: string, args: JsonObject): Promise<CuaToolResult> {
    this.calls.push({ name, args })
    if (name === 'get_window_state') {
      this.seq += 1
      return result({
        window_title: 'DeepSeek Harness',
        snapshot_id: `s${String(this.seq)}`,
        elements: [
          { element_token: `s${String(this.seq)}:0`, role: 'AXButton', label: '插件', enabled: true, actions: ['press'] },
          { element_token: `s${String(this.seq)}:1`, role: 'AXTextField', label: '搜索会话名称', value: 'old', enabled: true },
        ],
      })
    }
    if (name === 'verify_state') {
      return result({ predicates: [{ status: this.verifyStatus }] })
    }
    return result({ status: 'ok' })
  }
}

const window = { pid: 42, windowId: 7 }

class FakeDrag implements CuaToolCaller {
  readonly calls: Array<{ name: string; args: JsonObject }> = []
  readonly replies: CuaToolResult[] = []

  constructor(
    private readonly elements: JsonObject[],
    private readonly extra: JsonObject = {},
  ) {}

  async callTool(name: string, args: JsonObject): Promise<CuaToolResult> {
    this.calls.push({ name, args })
    if (name === 'get_window_state') {
      return result({ window_title: 'Fixture', snapshot_id: 's1', elements: this.elements, ...this.extra })
    }
    if (name === 'drag') return this.replies.shift() ?? result({ status: 'ok' })
    return result({ status: 'ok' })
  }
}

const card = (frame: JsonObject, screenshotFrame?: JsonObject): JsonObject => ({
  element_token: 's1:0',
  role: 'AXButton',
  label: 'CARD',
  enabled: true,
  frame,
  ...(screenshotFrame === undefined ? {} : { screenshot_frame: screenshotFrame }),
})

const slot = (frame: JsonObject, screenshotFrame?: JsonObject): JsonObject => ({
  element_token: 's1:1',
  role: 'AXButton',
  label: 'SLOT',
  enabled: true,
  frame,
  ...(screenshotFrame === undefined ? {} : { screenshot_frame: screenshotFrame }),
})

describe('cua/desktop-driver', () => {
  it('maps AX elements and clicks the fresh element token', async () => {
    const caller = new FakeDesktop()
    const driver = new CuaDesktopDriver(caller)
    const observation = await driver.observe(window, context())
    expect(observation.title).toBe('DeepSeek Harness')
    expect(observation.elements.map(element => element.role)).toEqual(['AXButton', 'AXTextField'])

    await driver.click(window, { role: 'AXButton', name: '插件' }, context())
    const click = caller.calls.find(call => call.name === 'click')
    expect(click?.args).toMatchObject({ pid: 42, window_id: 7, element_token: 's2:0' })
  })

  it('writes values and presses keys through element tokens', async () => {
    const caller = new FakeDesktop()
    const driver = new CuaDesktopDriver(caller)
    await driver.setValue(window, { role: 'AXTextField', name: '搜索会话名称' }, 'zz-spike', context())
    await driver.pressKey(window, 'Escape', context())
    expect(caller.calls.find(call => call.name === 'set_value')?.args)
      .toMatchObject({ element_token: 's1:1', value: 'zz-spike' })
    expect(caller.calls.find(call => call.name === 'press_key')?.args).toMatchObject({ key: 'Escape' })
  })

  it('rejects ambiguous targets without an index', async () => {
    const caller = new FakeDesktop()
    const driver = new CuaDesktopDriver(caller)
    await expect(driver.click(window, { role: 'AXButton', name: 'missing' }, context()))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
  })

  it('asserts existence and enabled state from the AX observation', async () => {
    const caller = new FakeDesktop()
    const driver = new CuaDesktopDriver(caller)
    await expect(driver.assert(window, { role: 'AXButton', labelContains: '插件', exists: true }, context()))
      .resolves.toBeUndefined()
    await expect(driver.assert(window, { role: 'AXButton', labelContains: '插件', exists: false }, context()))
      .rejects.toMatchObject({ code: 'ASSERTION_FAILED' })
    await expect(driver.assert(window, { role: 'AXButton', labelContains: '插件', enabled: false }, context()))
      .rejects.toMatchObject({ code: 'ASSERTION_FAILED' })
    await expect(driver.assert(window, { role: 'AXButton', labelContains: '不存在' }, context()))
      .rejects.toMatchObject({ code: 'ASSERTION_FAILED' })
  })
})

describe('cua/desktop-driver drag pixels', () => {
  it('drags at screenshot-frame centers, not raw AX (screen) frames', async () => {
    const caller = new FakeDrag(
      [
        card({ x: 200, y: 140, w: 120, h: 80 }, { x: 100, y: 100, w: 120, h: 80 }),
        slot({ x: 700, y: 140, w: 120, h: 80 }, { x: 600, y: 100, w: 120, h: 80 }),
      ],
      { window_bounds: { x: 100, y: 40, w: 1000, h: 700 }, screenshot_scale: 1 },
    )
    const driver = new CuaDesktopDriver(caller)
    await driver.drag(window, { role: 'AXButton', name: 'CARD' }, { role: 'AXButton', name: 'SLOT' }, context())

    const snapshot = caller.calls.find(call => call.name === 'get_window_state')
    expect(snapshot?.args).toMatchObject({ include_screenshot: true, tree_format: 'elements' })
    expect(typeof snapshot?.args['screenshot_out_file']).toBe('string')
    expect(caller.calls.find(call => call.name === 'drag')?.args).toMatchObject({
      from_x: 160,
      from_y: 140,
      to_x: 660,
      to_y: 140,
      delivery_mode: 'background',
    })
  })

  it('falls back to window bounds and screenshot scale when screenshot frames are absent', async () => {
    const caller = new FakeDrag(
      [
        card({ x: 200, y: 140, w: 120, h: 80 }),
        slot({ x: 700, y: 140, w: 120, h: 80 }),
      ],
      { window_bounds: { x: 100, y: 40, w: 1000, h: 700 }, screenshot_scale: 2 },
    )
    const driver = new CuaDesktopDriver(caller)
    await driver.drag(window, { role: 'AXButton', name: 'CARD' }, { role: 'AXButton', name: 'SLOT' }, context())

    expect(caller.calls.find(call => call.name === 'drag')?.args).toMatchObject({
      from_x: 320,
      from_y: 280,
      to_x: 1320,
      to_y: 280,
    })
  })

  it('retries the gesture in the foreground when background drag cannot hold a DnD session', async () => {
    const caller = new FakeDrag(
      [
        card({ x: 200, y: 140, w: 120, h: 80 }, { x: 100, y: 100, w: 120, h: 80 }),
        slot({ x: 700, y: 140, w: 120, h: 80 }, { x: 600, y: 100, w: 120, h: 80 }),
      ],
      { window_bounds: { x: 100, y: 40, w: 1000, h: 700 }, screenshot_scale: 1 },
    )
    caller.replies.push({
      isError: true,
      content: [],
      structuredContent: { code: 'background_unavailable', reason: 'drag_and_drop_session' } as unknown as JsonValue,
    })
    const driver = new CuaDesktopDriver(caller)
    await expect(driver.drag(window, { role: 'AXButton', name: 'CARD' }, { role: 'AXButton', name: 'SLOT' }, context()))
      .resolves.toBeUndefined()

    const drags = caller.calls.filter(call => call.name === 'drag')
    expect(drags.map(call => call.args['delivery_mode'])).toEqual(['background', 'foreground'])
  })

  it('does not retry unrelated drag refusals', async () => {
    const caller = new FakeDrag(
      [
        card({ x: 200, y: 140, w: 120, h: 80 }, { x: 100, y: 100, w: 120, h: 80 }),
        slot({ x: 700, y: 140, w: 120, h: 80 }, { x: 600, y: 100, w: 120, h: 80 }),
      ],
      { window_bounds: { x: 100, y: 40, w: 1000, h: 700 }, screenshot_scale: 1 },
    )
    caller.replies.push({
      isError: true,
      content: [],
      structuredContent: { code: 'target_missing' } as unknown as JsonValue,
    })
    const driver = new CuaDesktopDriver(caller)
    await expect(driver.drag(window, { role: 'AXButton', name: 'CARD' }, { role: 'AXButton', name: 'SLOT' }, context()))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    expect(caller.calls.filter(call => call.name === 'drag')).toHaveLength(1)
  })

  it('rejects a drag target without any frame', async () => {
    const caller = new FakeDrag([
      card({ x: 200, y: 140, w: 120, h: 80 }, { x: 100, y: 100, w: 120, h: 80 }),
      { element_token: 's1:1', role: 'AXButton', label: 'SLOT', enabled: true },
    ])
    const driver = new CuaDesktopDriver(caller)
    await expect(driver.drag(window, { role: 'AXButton', name: 'CARD' }, { role: 'AXButton', name: 'SLOT' }, context()))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
  })
})
