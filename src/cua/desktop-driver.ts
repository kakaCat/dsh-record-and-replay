/**
 * Cua 桌面（macOS AX）最小的驱动层。
 *
 * 与浏览器驱动的区别：没有 tab/target，目标是一个原生窗口；元素用快照内的
 * `element_token` 寻址，回放/重试时必须重新快照并按 role/label 解析。
 * 文本输入优先 `set_value`（Electron 的 Web 内容不允许背景 `type_text`）。
 */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject, JsonValue, OperationContext } from '../core/api.js'
import { BrowserDriverError } from '../driver/api.js'
import type { CuaToolCaller } from './bindings.js'
import { ensureOk } from './response.js'
import type { CuaToolResult } from './transport.js'

export interface DesktopWindowRef {
  readonly pid: number
  readonly windowId: number
}

export interface DesktopFrame {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface DesktopElement {
  readonly token: string
  readonly role: string
  readonly name?: string
  readonly value?: string
  readonly enabled: boolean
  readonly actions: readonly string[]
  /** AX frame in screen coordinates (points). */
  readonly frame?: DesktopFrame
  /**
   * Same element in window-local screenshot pixels. Only Cua's window capture
   * emits it; pixel actions (`drag`) are addressed in this space, not `frame`.
   */
  readonly screenshotFrame?: DesktopFrame
}

export interface DesktopObservation {
  readonly window: DesktopWindowRef
  readonly title: string
  readonly snapshotId: string
  readonly elements: readonly DesktopElement[]
  /** Window origin/size on screen, present when the read included a capture. */
  readonly windowBounds?: DesktopFrame
  /** Screenshot pixels per AX point; 1 on non-Retina captures. */
  readonly screenshotScale?: number
}

export interface DesktopTarget {
  readonly role?: string
  readonly name?: string
  readonly labelContains?: string
  /** 0-based pick among matching enabled elements. */
  readonly index?: number
}

export interface DesktopAssertion {
  readonly role?: string
  readonly labelContains?: string
  readonly exists?: boolean
  readonly enabled?: boolean
}

export interface DesktopDriver {
  observe(window: DesktopWindowRef, context: OperationContext): Promise<DesktopObservation>
  click(window: DesktopWindowRef, target: DesktopTarget, context: OperationContext, options?: { readonly button?: 'left' | 'right'; readonly count?: number }): Promise<void>
  setValue(window: DesktopWindowRef, target: DesktopTarget, value: string, context: OperationContext): Promise<void>
  pressKey(window: DesktopWindowRef, key: string, context: OperationContext): Promise<void>
  assert(window: DesktopWindowRef, assertion: DesktopAssertion, context: OperationContext): Promise<void>
  screenshot(window: DesktopWindowRef, outFile: string, context: OperationContext): Promise<string>
}

type JsonRecord = Readonly<Record<string, JsonValue>>

function stringOf(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function frameFieldOf(raw: JsonRecord, key: string): DesktopFrame | undefined {
  const frame = raw[key]
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return undefined
  const { x, y, w, h } = frame as Record<string, unknown>
  if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return undefined
  return { x, y, w, h }
}

function frameOf(raw: JsonRecord): DesktopFrame | undefined {
  return frameFieldOf(raw, 'frame')
}

function elementOf(raw: JsonRecord): DesktopElement {
  const label = stringOf(raw['label'])
  const value = stringOf(raw['value'])
  const frame = frameOf(raw)
  const screenshotFrame = frameFieldOf(raw, 'screenshot_frame')
  return {
    token: stringOf(raw['element_token']) ?? '',
    role: stringOf(raw['role']) ?? 'AXUnknown',
    ...(label === undefined ? {} : { name: label }),
    ...(value === undefined ? {} : { value }),
    enabled: raw['enabled'] === true,
    actions: Array.isArray(raw['actions'])
      ? (raw['actions'] as readonly JsonValue[]).filter((action): action is string => typeof action === 'string')
      : [],
    ...(frame === undefined ? {} : { frame }),
    ...(screenshotFrame === undefined ? {} : { screenshotFrame }),
  }
}

/**
 * Cua refuses a background drag when the gesture opens a native drag-and-drop
 * session (HTML5 DnD follows the hardware pointer on macOS) and asks for
 * `delivery_mode: "foreground"`. Only that refusal escalates; every other
 * failure keeps its normal error.
 */
function wantsForegroundRetry(result: CuaToolResult): boolean {
  if (result.isError !== true) return false
  const raw = result.structuredContent
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const data = raw as JsonObject
  const refusal = typeof data['refusal'] === 'object' && data['refusal'] !== null && !Array.isArray(data['refusal'])
    ? data['refusal'] as JsonObject
    : undefined
  const code = stringOf(data['code']) ?? stringOf(refusal?.['code'])
  if (code !== 'background_unavailable' && code !== 'foreground_required') return false
  const reason = stringOf(data['reason']) ?? stringOf(refusal?.['reason'])
  const requires = data['requires']
  const asksForeground = Array.isArray(requires) && requires.includes('delivery_mode:foreground')
  return reason === 'drag_and_drop_session' || asksForeground || reason === undefined
}

export class CuaDesktopDriver implements DesktopDriver {
  constructor(private readonly caller: CuaToolCaller) {}

  private async invoke(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult> {
    try {
      return await this.caller.callTool(name, args, context)
    } catch (error) {
      if (error instanceof BrowserDriverError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new BrowserDriverError('CUA_TRANSPORT_UNAVAILABLE', message, { cause: error })
    }
  }

  private observationOf(window: DesktopWindowRef, data: JsonObject): DesktopObservation {
    const rawElements = Array.isArray(data['elements']) ? data['elements'] as JsonRecord[] : []
    const elements = rawElements.map(elementOf)
    const title = stringOf(data['window_title']) ?? elements.find(element => element.role === 'AXWindow')?.name ?? ''
    const bounds = frameFieldOf(data, 'window_bounds')
    const scale = data['screenshot_scale']
    return {
      window,
      title,
      snapshotId: stringOf(data['snapshot_id']) ?? '',
      elements,
      ...(bounds === undefined ? {} : { windowBounds: bounds }),
      ...(typeof scale === 'number' && scale > 0 ? { screenshotScale: scale } : {}),
    }
  }

  async observe(window: DesktopWindowRef, context: OperationContext): Promise<DesktopObservation> {
    const data = ensureOk(await this.invoke('get_window_state', {
      pid: window.pid,
      window_id: window.windowId,
      full_output: true,
      include_screenshot: false,
    }, context), 'get_window_state')
    return this.observationOf(window, data)
  }

  async click(
    window: DesktopWindowRef,
    target: DesktopTarget,
    context: OperationContext,
    options: { readonly button?: 'left' | 'right'; readonly count?: number } = {},
  ): Promise<void> {
    const element = await this.resolve(window, target, context)
    ensureOk(await this.invoke('click', {
      pid: window.pid,
      window_id: window.windowId,
      element_token: element.token,
      ...(options.button === undefined ? {} : { button: options.button }),
      ...(options.count === undefined ? {} : { count: options.count }),
    }, context), 'click')
  }

  /**
   * 从一个元素中心拖到另一个元素中心。
   *
   * 坐标基准（2026-11-01 实测）：Cua 的 `drag` 收「窗口局部截图像素」（左上
   * 原点），而 AX `frame` 是**屏幕坐标**——AXWindow.frame 的原点就是窗口在
   * 屏幕上的 (x,y)。直接把 frame 中心传给 drag 会整体偏移标题栏/窗口原点：
   * 大目标可能仍落在框内，小目标则按下落空（页面收不到 mousedown）。
   * 因此这里重新取一次带截图的快照，优先用 `screenshot_frame`；没有该字段时
   * 用 `window_bounds` + `screenshot_scale` 折算。
   *
   * HTML5 drag-and-drop 跟随真实指针：Cua 会以 `background_unavailable` 拒绝
   * 后台投递（`drag_and_drop_session`），这里按它的建议用 foreground 重试一次
   * ——该重试会短暂前置窗口并移动物理指针。
   */
  async drag(
    window: DesktopWindowRef,
    from: DesktopTarget,
    to: DesktopTarget,
    context: OperationContext,
  ): Promise<void> {
    const observation = await this.snapshotWithPixels(window, context)
    const source = this.matchIn(observation, from)
    const destination = this.matchIn(observation, to)
    const start = this.dragPointOf(observation, source, 'from')
    const end = this.dragPointOf(observation, destination, 'to')
    const args: JsonObject = {
      pid: window.pid,
      window_id: window.windowId,
      from_x: start.x,
      from_y: start.y,
      to_x: end.x,
      to_y: end.y,
    }
    const first = await this.invoke('drag', { ...args, delivery_mode: 'background' }, context)
    if (!wantsForegroundRetry(first)) {
      ensureOk(first, 'drag')
      return
    }
    ensureOk(await this.invoke('drag', { ...args, delivery_mode: 'foreground' }, context), 'drag')
  }

  /** 带窗口截图的快照：drag 的像素坐标只在这个快照的空间里有效。 */
  private async snapshotWithPixels(window: DesktopWindowRef, context: OperationContext): Promise<DesktopObservation> {
    const outFile = join(tmpdir(), `dsh-cua-drag-${randomUUID()}.png`)
    try {
      const data = ensureOk(await this.invoke('get_window_state', {
        pid: window.pid,
        window_id: window.windowId,
        full_output: true,
        include_accessibility_tree: true,
        include_screenshot: true,
        screenshot_out_file: outFile,
        max_image_dimension: 0,
        tree_format: 'elements',
        timeout_ms: 5000,
      }, context), 'get_window_state')
      return this.observationOf(window, data)
    } finally {
      await rm(outFile, { force: true }).catch(() => undefined)
    }
  }

  private dragPointOf(
    observation: DesktopObservation,
    element: DesktopElement,
    side: 'from' | 'to',
  ): { readonly x: number; readonly y: number } {
    const pixels = element.screenshotFrame
    if (pixels !== undefined) {
      return { x: Math.round(pixels.x + pixels.w / 2), y: Math.round(pixels.y + pixels.h / 2) }
    }
    const ax = element.frame
    const bounds = observation.windowBounds
    if (ax === undefined) {
      throw new BrowserDriverError('TARGET_NOT_FOUND', `drag ${side} element has no AX frame`)
    }
    if (bounds === undefined) {
      throw new BrowserDriverError('ACTION_UNSUPPORTED', 'drag needs window pixel coordinates but Cua returned no screenshot metadata')
    }
    const scale = observation.screenshotScale ?? 1
    return {
      x: Math.round((ax.x - bounds.x + ax.w / 2) * scale),
      y: Math.round((ax.y - bounds.y + ax.h / 2) * scale),
    }
  }

  private matchIn(observation: DesktopObservation, target: DesktopTarget): DesktopElement {
    const matches = observation.elements.filter(element => {
      if (target.role !== undefined && element.role !== target.role) return false
      if (target.name !== undefined && element.name !== target.name) return false
      if (target.labelContains !== undefined && !(element.name ?? '').includes(target.labelContains)) return false
      return true
    })
    const enabled = matches.filter(element => element.enabled)
    const pool = enabled.length > 0 ? enabled : matches
    const picked = target.index === undefined ? pool[0] : pool[target.index]
    if (picked === undefined) throw new BrowserDriverError('TARGET_NOT_FOUND', 'no desktop element matched the drag target')
    return picked
  }

  /** 滚轮滚动；给了 target 就滚到那个元素上。 */
  async scroll(
    window: DesktopWindowRef,
    options: {
      readonly direction: 'up' | 'down' | 'left' | 'right'
      readonly amount: number
      readonly target?: DesktopTarget
      readonly deliveryMode?: 'background' | 'foreground'
    },
    context: OperationContext,
  ): Promise<void> {
    const element = options.target === undefined ? undefined : await this.resolve(window, options.target, context)
    ensureOk(await this.invoke('scroll', {
      pid: window.pid,
      window_id: window.windowId,
      direction: options.direction,
      amount: options.amount,
      ...(options.deliveryMode === undefined ? {} : { delivery_mode: options.deliveryMode }),
      ...(element === undefined ? {} : { element_token: element.token }),
    }, context), 'scroll')
  }

  async setValue(window: DesktopWindowRef, target: DesktopTarget, value: string, context: OperationContext): Promise<void> {
    const element = await this.resolve(window, target, context)
    ensureOk(await this.invoke('set_value', {
      pid: window.pid,
      window_id: window.windowId,
      element_token: element.token,
      value,
    }, context), 'set_value')
  }

  async pressKey(window: DesktopWindowRef, key: string, context: OperationContext): Promise<void> {
    ensureOk(await this.invoke('press_key', {
      pid: window.pid,
      window_id: window.windowId,
      key,
    }, context), 'press_key')
  }

  /**
   * 断言走 AX 观察，而不是 verify_state：Electron 的 Web 内容在 verify_state 里是
   * `untrusted_source`（返回 unknown），但同一棵 AX 树里元素存在与否是稳定可读的。
   */
  async assert(window: DesktopWindowRef, assertion: DesktopAssertion, context: OperationContext): Promise<void> {
    if (assertion.role === undefined && assertion.labelContains === undefined) {
      throw new BrowserDriverError('INVALID_ARGUMENT', 'desktop assertion needs role or labelContains')
    }
    const observation = await this.observe(window, context)
    const matches = observation.elements.filter(element => {
      if (assertion.role !== undefined && element.role !== assertion.role) return false
      if (assertion.labelContains !== undefined && !(element.name ?? '').includes(assertion.labelContains)) return false
      if (assertion.enabled !== undefined && element.enabled !== assertion.enabled) return false
      return true
    })
    const exists = matches.length > 0
    if ((assertion.exists ?? true) !== exists) {
      throw new BrowserDriverError('ASSERTION_FAILED', `desktop assertion failed: expected ${assertion.exists === false ? 'no element' : 'an element'} matching ${JSON.stringify({ role: assertion.role, labelContains: assertion.labelContains })}, found ${String(matches.length)}`)
    }
  }

  async screenshot(window: DesktopWindowRef, outFile: string, context: OperationContext): Promise<string> {
    ensureOk(await this.invoke('get_window_state', {
      pid: window.pid,
      window_id: window.windowId,
      include_accessibility_tree: false,
      include_screenshot: true,
      screenshot_out_file: outFile,
    }, context), 'get_window_state')
    return outFile
  }

  /** 每次动作都重新快照：element_token 只在它自己的快照里有效。 */
  private async resolve(window: DesktopWindowRef, target: DesktopTarget, context: OperationContext): Promise<DesktopElement> {
    const observation = await this.observe(window, context)
    const matches = observation.elements.filter(element => {
      if (target.role !== undefined && element.role !== target.role) return false
      if (target.name !== undefined && element.name !== target.name) return false
      if (target.labelContains !== undefined && !(element.name ?? '').includes(target.labelContains)) return false
      return true
    })
    const enabled = matches.filter(element => element.enabled)
    const pool = enabled.length > 0 ? enabled : matches
    if (target.index !== undefined) {
      const picked = pool[target.index]
      if (picked === undefined) {
        throw new BrowserDriverError('TARGET_NOT_FOUND', `desktop index ${String(target.index)} is out of range for ${String(pool.length)} matches`)
      }
      return picked
    }
    if (pool.length === 0) {
      throw new BrowserDriverError('TARGET_NOT_FOUND', 'no desktop element matched the target')
    }
    if (pool.length > 1) {
      throw new BrowserDriverError('TARGET_AMBIGUOUS', `desktop target matched ${String(pool.length)} elements; add index`)
    }
    return pool[0] as DesktopElement
  }
}
