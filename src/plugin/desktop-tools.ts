/**
 * 桌面（macOS AX）最小工具集。
 *
 * 不参与 Recording/Replay 管线：每个调用显式带 pid/windowId，动作前重新快照并按
 * role/label 解析元素。目标解析与断言语义由 `CuaDesktopDriver` 负责。
 */
import type { JsonObject, JsonValue, OperationContext } from '../core/api.js'
import { BrowserDriverError } from '../driver/api.js'
import { HostError, type HostCallContext } from '../host/index.js'
import { CuaDesktopDriver, type DesktopAssertion, type DesktopTarget, type DesktopWindowRef } from '../cua/desktop-driver.js'
import type { CuaToolCaller } from '../cua/bindings.js'

export interface DesktopToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
  handle(args: unknown, call: HostCallContext): Promise<JsonObject>
}

function contextOf(call: HostCallContext): OperationContext {
  const exec = call.exec as { agent?: { id?: string; session?: { id?: string } } }
  return {
    principal: {
      sessionId: exec.agent?.session?.id ?? 'desktop-tool',
      agentId: exec.agent?.id ?? 'desktop-tool',
    },
    callId: 'desktop-tool',
    origin: 'agent',
    signal: call.signal ?? new AbortController().signal,
  }
}

function record(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new HostError('INVALID_ARGUMENT', 'arguments must be an object')
  }
  return args as Record<string, unknown>
}

function windowOf(args: unknown): DesktopWindowRef {
  const value = record(args)
  const pid = value['pid']
  const windowId = value['windowId']
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new HostError('INVALID_ARGUMENT', 'pid must be a positive integer')
  }
  if (typeof windowId !== 'number' || !Number.isInteger(windowId) || windowId <= 0) {
    throw new HostError('INVALID_ARGUMENT', 'windowId must be a positive integer')
  }
  return { pid, windowId }
}

function targetOf(args: unknown): DesktopTarget {
  const value = record(args)
  const target: { role?: string; name?: string; labelContains?: string; index?: number } = {}
  for (const field of ['role', 'name', 'labelContains'] as const) {
    const candidate = value[field]
    if (candidate === undefined) continue
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new HostError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
    }
    target[field] = candidate
  }
  if (value['index'] !== undefined) {
    if (typeof value['index'] !== 'number' || !Number.isInteger(value['index']) || value['index'] < 0) {
      throw new HostError('INVALID_ARGUMENT', 'index must be a non-negative integer')
    }
    target.index = value['index']
  }
  if (target.role === undefined && target.name === undefined && target.labelContains === undefined) {
    throw new HostError('INVALID_ARGUMENT', 'target needs role, name or labelContains')
  }
  return target
}

function rethrow(error: unknown): never {
  if (error instanceof BrowserDriverError) throw new HostError(error.code, error.message)
  throw error
}

const WINDOW_PROPERTIES = {
  pid: { type: 'integer', minimum: 1, description: 'OS process id of the target app.' },
  windowId: { type: 'integer', minimum: 1, description: 'Native window id from list_windows.' },
} as const

const TARGET_PROPERTIES = {
  role: { type: 'string', minLength: 1, description: 'AX role, e.g. AXButton / AXTextField.' },
  name: { type: 'string', minLength: 1, description: 'Exact AX label.' },
  labelContains: { type: 'string', minLength: 1, description: 'Substring of the AX label.' },
  index: { type: 'integer', minimum: 0, description: '0-based pick among matching enabled elements.' },
} as const

export function createDesktopTools(callerOf: (call: HostCallContext) => Promise<CuaToolCaller>): readonly DesktopToolDefinition[] {
  return [
    {
      name: 'cua_desktop_state',
      description: 'Snapshot one macOS window: AX elements (role/label/value/enabled). Read-only.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'windowId'],
        properties: { ...WINDOW_PROPERTIES, maxElements: { type: 'integer', minimum: 1, maximum: 500 } },
      },
      handle: async (args, call) => {
        const window = windowOf(args)
        const driver = new CuaDesktopDriver(await callerOf(call))
        const value = record(args)
        const max = typeof value['maxElements'] === 'number' ? value['maxElements'] : 50
        try {
          const observation = await driver.observe(window, contextOf(call))
          return {
            title: observation.title,
            snapshotId: observation.snapshotId,
            count: observation.elements.length,
            elements: observation.elements.slice(0, max).map(element => ({
              token: element.token,
              role: element.role,
              ...(element.name === undefined ? {} : { name: element.name }),
              ...(element.value === undefined ? {} : { value: element.value }),
              enabled: element.enabled,
            })),
          }
        } catch (error) {
          rethrow(error)
        }
      },
    },
    {
      name: 'cua_desktop_click',
      description: 'Click one AX element in a macOS window (re-snapshots first, then targets by role/label).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'windowId'],
        properties: { ...WINDOW_PROPERTIES, ...TARGET_PROPERTIES },
      },
      handle: async (args, call) => {
        const window = windowOf(args)
        const driver = new CuaDesktopDriver(await callerOf(call))
        try {
          const raw = record(args)
          const button = raw['button'] === 'right' ? 'right' as const : raw['button'] === 'left' ? 'left' as const : undefined
          const count = typeof raw['count'] === 'number' ? raw['count'] : undefined
          await driver.click(window, targetOf(args), contextOf(call), {
            ...(button === undefined ? {} : { button }),
            ...(count === undefined ? {} : { count }),
          })
          return { ok: true }
        } catch (error) {
          rethrow(error)
        }
      },
    },
    {
      name: 'cua_desktop_set_value',
      description: 'Write a value into one AX element (set_value; use this instead of type_text in Electron).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'windowId', 'value'],
        properties: { ...WINDOW_PROPERTIES, ...TARGET_PROPERTIES, value: { type: 'string' } },
      },
      handle: async (args, call) => {
        const window = windowOf(args)
        const driver = new CuaDesktopDriver(await callerOf(call))
        const value = record(args)['value']
        if (typeof value !== 'string') throw new HostError('INVALID_ARGUMENT', 'value must be a string')
        try {
          await driver.setValue(window, targetOf(args), value, contextOf(call))
          return { ok: true }
        } catch (error) {
          rethrow(error)
        }
      },
    },
    {
      name: 'cua_desktop_press_key',
      description: 'Press one key in a macOS window (Escape, Return, Tab, ...).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'windowId', 'key'],
        properties: { ...WINDOW_PROPERTIES, key: { type: 'string', minLength: 1 } },
      },
      handle: async (args, call) => {
        const window = windowOf(args)
        const driver = new CuaDesktopDriver(await callerOf(call))
        const key = record(args)['key']
        if (typeof key !== 'string' || key.length === 0) throw new HostError('INVALID_ARGUMENT', 'key must be a non-empty string')
        try {
          await driver.pressKey(window, key, contextOf(call))
          return { ok: true }
        } catch (error) {
          rethrow(error)
        }
      },
    },
    {
      name: 'cua_desktop_scroll',
      description: 'Scroll a macOS window (wheel); optional target scrolls on that element.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'windowId', 'direction', 'amount'],
        properties: {
          ...WINDOW_PROPERTIES,
          direction: { enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number', minimum: 1 },
          delivery_mode: { enum: ['background', 'foreground'], description: 'Electron web content often needs foreground.' },
          ...TARGET_PROPERTIES,
        },
      },
      handle: async (args, call) => {
        const window = windowOf(args)
        const raw = record(args)
        const direction = raw['direction']
        if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
          throw new HostError('INVALID_ARGUMENT', 'direction must be up/down/left/right')
        }
        const amount = raw['amount']
        if (typeof amount !== 'number' || amount <= 0) throw new HostError('INVALID_ARGUMENT', 'amount must be positive')
        const hasTarget = raw['role'] !== undefined || raw['name'] !== undefined || raw['labelContains'] !== undefined
        const deliveryMode = raw['delivery_mode'] === 'foreground' ? 'foreground' as const : raw['delivery_mode'] === 'background' ? 'background' as const : undefined
        const driver = new CuaDesktopDriver(await callerOf(call))
        try {
          await driver.scroll(window, {
            direction,
            amount,
            ...(hasTarget ? { target: targetOf(args) } : {}),
            ...(deliveryMode === undefined ? {} : { deliveryMode }),
          }, contextOf(call))
          return { ok: true }
        } catch (error) {
          rethrow(error)
        }
      },
    },
    {
      name: 'cua_desktop_drag',
      description: 'Drag from one AX element to another (window-local screenshot pixels; HTML5 DnD may front the window).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'windowId', 'fromRole', 'toRole'],
        properties: {
          ...WINDOW_PROPERTIES,
          fromRole: { type: 'string', minLength: 1 },
          fromName: { type: 'string', minLength: 1 },
          fromLabelContains: { type: 'string', minLength: 1 },
          toRole: { type: 'string', minLength: 1 },
          toName: { type: 'string', minLength: 1 },
          toLabelContains: { type: 'string', minLength: 1 },
        },
      },
      handle: async (args, call) => {
        const window = windowOf(args)
        const raw = record(args)
        const targetFrom = (prefix: 'from' | 'to'): DesktopTarget => {
          const role = raw[`${prefix}Role`]
          const name = raw[`${prefix}Name`]
          const labelContains = raw[`${prefix}LabelContains`]
          if (typeof role !== 'string') throw new HostError('INVALID_ARGUMENT', `${prefix}Role is required`)
          return {
            role,
            ...(typeof name === 'string' ? { name } : {}),
            ...(typeof labelContains === 'string' ? { labelContains } : {}),
          }
        }
        const driver = new CuaDesktopDriver(await callerOf(call))
        try {
          await driver.drag(window, targetFrom('from'), targetFrom('to'), contextOf(call))
          return { ok: true }
        } catch (error) {
          rethrow(error)
        }
      },
    },
    {
      name: 'cua_desktop_assert',
      description: 'Assert AX element existence/enabled state in a macOS window (observation-based; works in Electron web content).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'windowId'],
        properties: {
          ...WINDOW_PROPERTIES,
          role: { type: 'string', minLength: 1 },
          labelContains: { type: 'string', minLength: 1 },
          exists: { type: 'boolean' },
          enabled: { type: 'boolean' },
        },
      },
      handle: async (args, call) => {
        const window = windowOf(args)
        const driver = new CuaDesktopDriver(await callerOf(call))
        const value = record(args)
        const assertion: { role?: string; labelContains?: string; exists?: boolean; enabled?: boolean } = {}
        if (typeof value['role'] === 'string') assertion.role = value['role']
        if (typeof value['labelContains'] === 'string') assertion.labelContains = value['labelContains']
        if (typeof value['exists'] === 'boolean') assertion.exists = value['exists']
        if (typeof value['enabled'] === 'boolean') assertion.enabled = value['enabled']
        try {
          await driver.assert(window, assertion as DesktopAssertion, contextOf(call))
          return { ok: true }
        } catch (error) {
          rethrow(error)
        }
      },
    },
    {
      name: 'cua_desktop_screenshot',
      description: 'Capture one window to an absolute PNG path (failure evidence).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pid', 'windowId', 'path'],
        properties: { ...WINDOW_PROPERTIES, path: { type: 'string', minLength: 1 } },
      },
      handle: async (args, call) => {
        const window = windowOf(args)
        const driver = new CuaDesktopDriver(await callerOf(call))
        const path = record(args)['path']
        if (typeof path !== 'string' || !path.startsWith('/')) throw new HostError('INVALID_ARGUMENT', 'path must be absolute')
        try {
          return { path: await driver.screenshot(window, path, contextOf(call)) }
        } catch (error) {
          rethrow(error)
        }
      },
    },
  ]
}
