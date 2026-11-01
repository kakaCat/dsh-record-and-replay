import {
  isNavigableUrl,
  type AssertCheck,
  type BrowserAction,
  type JsonObject,
  type OperationContext,
  type SemanticTarget,
} from '../core/api.js'
import type { LaunchMode } from '../core/contracts.js'
import { CUA_BROWSER_ACTION_KINDS, CUA_DESKTOP_ACTION_KINDS, CUA_LOCATOR_FIELDS } from '../core/contracts.js'
import {
  BrowserDriverError,
  type ActionResult,
  type BindBrowserInput,
  type BrowserBinding,
  type BrowserDriver,
  type DriverCapabilities,
  type Observation,
  type ObservationElement,
  type ResolvedTarget,
} from '../driver/api.js'
import { ReferenceTable } from '../driver/references.js'
import { suppressSessionRestore } from './profile-hygiene.js'
import { ensureOk } from './response.js'
import { CuaSessionRegistry, type CuaBindingRecord, type CuaToolCaller } from './bindings.js'
import { CuaDesktopDriver, type DesktopTarget, type DesktopWindowRef } from './desktop-driver.js'
import type { CuaToolResult } from './transport.js'

export interface CuaBrowserDriverOptions {
  readonly sessionPrefix?: string
  /** 正向断言等待页面渲染的上限；测试里可以调小。 */
  readonly assertSettleTimeoutMs?: number
  readonly assertSettleIntervalMs?: number
  /** 点击后等待新激活标签的上限（默认 2 秒）。 */
  readonly tabFollowTimeoutMs?: number
  /** 点击后刷新 active tab 的轮询间隔（默认 250ms）。 */
  readonly tabFollowIntervalMs?: number
  /** 没有新标签出现时提前结束轮询的静默次数（默认 3 次 ≈ 500ms）。 */
  readonly tabFollowQuietPolls?: number
  /**
   * 点击后等待「页面确实发生变化」的上限（默认 1500ms）。超过仍无变化时，
   * 驱动会用合成 DOM 点击重投一次；两次都无变化则抛 ACTION_UNCONFIRMED。
   */
  readonly clickConfirmTimeoutMs?: number
  /** 点击效果确认的轮询间隔（默认 250ms）。 */
  readonly clickConfirmIntervalMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function describeTarget(target: SemanticTarget): string {
  const parts: string[] = []
  if (target.role !== undefined) parts.push(`role=${target.role}`)
  if (target.name !== undefined) parts.push(`name=${JSON.stringify(target.name)}`)
  else if (target.text !== undefined) parts.push(`text=${JSON.stringify(target.text)}`)
  return parts.length === 0 ? 'the target' : parts.join(' ')
}

function objectOfResult(result: CuaToolResult): JsonObject {
  if (result.structuredContent !== undefined && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
    return result.structuredContent as JsonObject
  }
  const text = result.content.find(part => part.type === 'text')?.text
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as JsonObject
    } catch {
      return {}
    }
  }
  return {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Cua refusals that mean "this trusted-input route is unavailable", not "the ref is wrong". */
const TRUST_ROUTE_UNAVAILABLE = /input_trust_unavailable|background_unavailable/i

/** A click that opened a tab has an observable effect even while it stays in the background. */
function tabCountGrew(before: number | undefined, after: number): boolean {
  return before !== undefined && after > before
}

/**
 * Semantic fingerprint of an observation. Refs are excluded on purpose: every
 * snapshot mints new refs, so including them would report a change on every
 * poll. URL, role/name/value/visibility and the element-state signature are
 * what a click can actually change.
 */
function observationFingerprint(observation: Observation): string {
  return [
    observation.url,
    ...observation.elements.map(element => [
      element.role,
      element.name ?? '',
      element.value ?? '',
      element.visibility ?? '',
      element.stateSignature ?? '',
    ].join('\u0001')),
  ].join('\u0002')
}

function cuaSessionName(prefix: string, sessionId: string): string {
  return `${prefix}-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

/**
 * Cua reports the captured tab viewport in `screenshot` metadata, in CSS
 * pixels. A no-target scroll needs a point inside that viewport, so the driver
 * measures it once per binding instead of guessing at window pixels.
 */
function viewportFrom(data: JsonObject): { readonly width: number; readonly height: number } | undefined {
  const screenshot = data['screenshot']
  if (typeof screenshot !== 'object' || screenshot === null || Array.isArray(screenshot)) return undefined
  const meta = screenshot as JsonObject
  const width = meta['viewport_css_width']
  const height = meta['viewport_css_height']
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return undefined
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined
  return { width, height }
}

function validatePrepareArgs(raw: unknown, pid: number, windowId: number, session: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BrowserDriverError('BROWSER_PERMISSION_DENIED', 'browser_prepare has no argument object')
  }
  const args = raw as Record<string, unknown>
  const strategy = args['strategy']
  if (Number(args['pid']) !== pid || Number(args['window_id']) !== windowId || args['session'] !== session) {
    throw new BrowserDriverError('BROWSER_PERMISSION_DENIED', 'browser_prepare arguments do not match the requested binding')
  }
  if (typeof strategy !== 'object' || strategy === null || (strategy as Record<string, unknown>)['kind'] !== 'existing_profile') {
    throw new BrowserDriverError('BROWSER_PERMISSION_DENIED', 'Only existing_profile browser_prepare is allowed')
  }
  if (args['allow_launch'] === true || args['approval_token'] !== undefined) {
    throw new BrowserDriverError('BROWSER_PERMISSION_DENIED', 'Launch or token-bearing browser_prepare is not allowed here')
  }
  return args
}

/** What a post-click tab refresh proved. */
interface TabFollowOutcome {
  /** Step summary to surface, when the follow had something to report. */
  readonly summary?: string
  /** A new tab appeared (active or not): the click had a visible effect. */
  readonly changed: boolean
  /**
   * The follow completed cleanly. When false the window could not be verified
   * (refresh failed, different target, pre-click tab gone), so a "no change"
   * reading must not be used to retry the click.
   */
  readonly verified: boolean
}

/**
 * Cua implementation of the semantic browser driver.
 * It maps only the actions verified by M0; unsupported actions fail loudly.
 */
export class CuaBrowserDriver implements BrowserDriver {
  readonly id = 'cua-driver'
  private readonly caller: CuaToolCaller
  private readonly registry: CuaSessionRegistry
  private readonly references = new ReferenceTable()
  private readonly sessionPrefix: string
  private readonly assertSettleTimeoutMs: number
  private readonly assertSettleIntervalMs: number
  private readonly tabFollowTimeoutMs: number
  private readonly tabFollowIntervalMs: number
  private readonly tabFollowQuietPolls: number
  private readonly clickConfirmTimeoutMs: number
  private readonly clickConfirmIntervalMs: number
  private readonly desktopBindings = new Map<string, BrowserBinding>()
  private desktopGeneration = 0

  constructor(
    caller: CuaToolCaller,
    registry = new CuaSessionRegistry(),
    options: CuaBrowserDriverOptions = {},
  ) {
    this.caller = caller
    this.registry = registry
    this.sessionPrefix = options.sessionPrefix ?? 'dsh-record-replay'
    this.assertSettleTimeoutMs = options.assertSettleTimeoutMs ?? 5_000
    this.assertSettleIntervalMs = options.assertSettleIntervalMs ?? 250
    this.tabFollowTimeoutMs = options.tabFollowTimeoutMs ?? 2_000
    this.tabFollowIntervalMs = options.tabFollowIntervalMs ?? 250
    this.tabFollowQuietPolls = options.tabFollowQuietPolls ?? 3
    this.clickConfirmTimeoutMs = options.clickConfirmTimeoutMs ?? 1_500
    this.clickConfirmIntervalMs = options.clickConfirmIntervalMs ?? 250
  }

  private async invoke(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult> {
    try {
      return await this.caller.callTool(name, args, context)
    } catch (error) {
      if (error instanceof BrowserDriverError) throw error
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
      if (typeof code === 'string') throw new BrowserDriverError(code as never, error instanceof Error ? error.message : String(error))
      throw new BrowserDriverError('BROWSER_BINDING_STALE', error instanceof Error ? error.message : String(error))
    }
  }

  async capabilities(launch?: LaunchMode): Promise<DriverCapabilities> {
    return {
      actions: launch === 'desktop' ? CUA_DESKTOP_ACTION_KINDS : CUA_BROWSER_ACTION_KINDS,
      locators: CUA_LOCATOR_FIELDS,
      driverVersion: '0.38.0',
    }
  }

  async bind(input: BindBrowserInput, context: OperationContext): Promise<BrowserBinding> {
    if (input.launch === 'desktop') return await this.bindDesktop(input, context)
    if (input.launch === 'isolated') return await this.bindIsolated(context, input.profileName)
    const { pid, windowId } = input
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(windowId) || windowId <= 0) {
      throw new BrowserDriverError('INVALID_ARGUMENT', 'pid and windowId must be positive integers')
    }
    const sessionId = context.principal.sessionId
    const existing = this.registry.get(sessionId)
    if (existing !== undefined) await this.release(existing.binding)

    this.registry.reserve(sessionId, pid, windowId)
    const cuaSession = cuaSessionName(this.sessionPrefix, sessionId)
    try {
      await this.endStaleSession(cuaSession, context)
      await this.invoke('start_session', { session: cuaSession, capture_scope: 'window' }, context)
      let raw = await this.invoke('get_browser_state', {
        pid: pid,
        window_id: windowId,
        session: cuaSession,
        snapshot_format: 'semantic_v2',
      }, context)
      let data = objectOfResult(raw)
      if (raw.isError === true || data['status'] === 'refused') {
        const refusal = data['refusal'] as JsonObject | undefined
        const detail = refusal?.['detail'] as JsonObject | undefined
        const nextCall = data['next_call'] as JsonObject | undefined
        const refusalCode = stringValue(refusal?.['code'])
        // 0.38 CLI returns a top-level `next_call`; 0.28 native returns
        // `refusal.detail.next_action`. Accept either hint plus the setup codes.
        const hint = stringValue(nextCall?.['tool']) ?? stringValue(detail?.['next_action'])
        const needsPrepare = hint === 'browser_prepare'
          || refusalCode === 'browser_requires_setup'
          || refusalCode === 'browser_consent_required'
        if (!needsPrepare) {
          ensureOk(raw, 'get_browser_state')
        }
        const prepareArgs = nextCall?.['arguments'] ?? {
          pid: pid,
          window_id: windowId,
          session: cuaSession,
          strategy: { kind: 'existing_profile' },
        }
        const prepare = validatePrepareArgs(prepareArgs, pid, windowId, cuaSession)
        // Arm the narrow native approval only around this exact attach.
        await this.caller.armExistingProfileGrant?.({ pid: pid, windowId: windowId })
        ensureOk(await this.invoke('browser_prepare', prepare as JsonObject, context), 'browser_prepare')
        raw = await this.invoke('get_browser_state', {
          pid: pid,
          window_id: windowId,
          session: cuaSession,
          snapshot_format: 'semantic_v2',
        }, context)
        data = ensureOk(raw, 'get_browser_state')
      }

      const quality = stringValue(data['binding_quality'])
      if (quality !== 'exact') {
        throw new BrowserDriverError('BROWSER_BINDING_STALE', `Cua binding quality is ${quality ?? 'unknown'}`)
      }
      const targetId = stringValue(data['target_id'])
      if (targetId === undefined) throw new BrowserDriverError('BROWSER_BINDING_STALE', 'Cua binding returned no target id')
      const tabs = Array.isArray(data['tabs']) ? (data['tabs'] as JsonObject[]) : []
      const tab = tabs.find(candidate => candidate['active'] === true) ?? tabs[0]
      const tabId = stringValue(tab?.['tab_id'])
      if (tabId === undefined) throw new BrowserDriverError('BROWSER_BINDING_STALE', 'Cua binding returned no tab id')

      const page = data['page'] as JsonObject | undefined
      const nativeTitle = stringValue(data['native_title'])
      const tabTitle = stringValue(tab?.['title'])
      // 私密窗口标记通常出现在原生窗口标题里；tab title 是页面标题，作为兜底。
      const title = nativeTitle !== undefined && nativeTitle.trim().length > 0
        ? nativeTitle
        : tabTitle !== undefined && tabTitle.trim().length > 0
          ? tabTitle
          : stringValue(page?.['title'])
      const binding: BrowserBinding = {
        id: this.registry.bindingId(sessionId),
        driverId: this.id,
        sessionId,
        pid: pid,
        windowId: windowId,
        ...(title === undefined ? {} : { title }),
        targetId,
        tabId,
        generation: this.registry.nextGeneration(),
      }
      const route = stringValue(data['binding_route'])
      this.registry.commit({
        binding,
        cuaSession,
        tabCount: tabs.length,
        ...(route === undefined ? {} : { bindingRoute: route }),
      })
      await this.caller.clearExistingProfileGrant?.()
      return binding
    } catch (error) {
      await this.caller.clearExistingProfileGrant?.()
      this.registry.releaseReservation(sessionId, pid, windowId)
      await this.invoke('end_session', { session: cuaSession }, context).catch(() => undefined)
      throw error
    }
  }

  /**
   * A previous bind can leave a revived session with a pending browser setup;
   * starting a new one then fails with `tool_invocation_failed`. Drop the label
   * first; an absent session is harmless.
   */
  private async endStaleSession(cuaSession: string, context: OperationContext): Promise<void> {
    await this.invoke('end_session', { session: cuaSession }, context).catch(() => undefined)
  }

  /**
   * Launch a driver-owned disposable Chromium and bind to its window.
   * Used when attaching to the user's profile is refused (focus proof, TCC)
   * or when the caller explicitly wants an isolated run.
   */
  private isDesktop(binding: BrowserBinding): boolean {
    return binding.driverId === 'cua-desktop'
  }

  private desktopWindow(binding: BrowserBinding): DesktopWindowRef {
    return { pid: binding.pid, windowId: binding.windowId }
  }

  private async bindDesktop(
    input: Extract<BindBrowserInput, { launch: 'desktop' }>,
    context: OperationContext,
  ): Promise<BrowserBinding> {
    const { pid, windowId } = input
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(windowId) || windowId <= 0) {
      throw new BrowserDriverError('INVALID_ARGUMENT', 'pid and windowId must be positive integers')
    }
    const sessionId = context.principal.sessionId
    const existing = this.registry.get(sessionId)
    if (existing !== undefined) await this.release(existing.binding)
    this.desktopBindings.delete(sessionId)
    // 绑定前先证明窗口可达，失败直接暴露（不会留下半个绑定）。
    await new CuaDesktopDriver(this.caller).observe({ pid, windowId }, context)
    this.desktopGeneration += 1
    const binding: BrowserBinding = {
      id: `desktop-${sessionId}-${String(this.desktopGeneration)}`,
      driverId: 'cua-desktop',
      sessionId,
      pid,
      windowId,
      targetId: `desktop:${String(pid)}:${String(windowId)}`,
      tabId: 'desktop',
      generation: this.desktopGeneration,
    }
    this.desktopBindings.set(sessionId, binding)
    return binding
  }

  private async observeDesktop(binding: BrowserBinding, context: OperationContext): Promise<Observation> {
    const observation = await new CuaDesktopDriver(this.caller).observe(this.desktopWindow(binding), context)
    const mapped: Observation = {
      observationId: observation.snapshotId.length > 0 ? observation.snapshotId : `desktop-${String(Date.now())}`,
      bindingGeneration: binding.generation,
      url: `ax://${String(binding.pid)}/${String(binding.windowId)}`,
      elements: observation.elements.map(element => ({
        ref: element.token,
        role: element.role,
        ...(element.name === undefined ? {} : { name: element.name }),
        ...(element.value === undefined ? {} : { value: element.value }),
        ...(element.actions.length === 0 ? {} : { actions: element.actions }),
      })),
    }
    this.references.remember(binding, mapped)
    return mapped
  }

  private async executeDesktop(
    binding: BrowserBinding,
    action: BrowserAction,
    context: OperationContext,
  ): Promise<ActionResult> {
    const driver = new CuaDesktopDriver(this.caller)
    const window = this.desktopWindow(binding)
    const targetOf = (target: SemanticTarget | undefined): DesktopTarget => {
      if (target === undefined) throw new BrowserDriverError('INVALID_ARGUMENT', `${action.kind} requires a semantic target`)
      return {
        ...(target.role === undefined ? {} : { role: target.role }),
        ...(target.name === undefined ? {} : { name: target.name }),
        ...(target.text === undefined ? {} : { labelContains: target.text }),
        ...(target.index === undefined ? {} : { index: target.index }),
      }
    }
    switch (action.kind) {
      case 'click':
        await driver.click(window, targetOf(action.target), context, {
          ...(action.button === undefined ? {} : { button: action.button }),
          ...(action.count === undefined ? {} : { count: action.count }),
        })
        return { status: 'ok' }
      case 'setValue':
        await driver.setValue(window, targetOf(action.target), action.value, context)
        return { status: 'ok' }
      case 'key':
        await driver.pressKey(window, action.key, context)
        return { status: 'ok' }
      case 'scroll': {
        const dx = action.deltaX
        const dy = action.deltaY
        if (dx === 0 && dy === 0) throw new BrowserDriverError('INVALID_ARGUMENT', 'scroll needs deltaX or deltaY')
        const direction = Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? 'down' : 'up') : (dx > 0 ? 'right' : 'left')
        await driver.scroll(window, {
          direction,
          amount: Math.max(Math.abs(dx), Math.abs(dy)),
          ...(action.target === undefined ? {} : { target: targetOf(action.target) }),
          // Electron 的 Web 内容没有后台滚轮通道，回放统一走 foreground。
          deliveryMode: 'foreground',
        }, context)
        return { status: 'ok' }
      }
      case 'drag':
        await driver.drag(window, targetOf(action.from), targetOf(action.to), context)
        return { status: 'ok' }
      case 'assert':
        return await this.assertDesktop(driver, window, action.check, context)
      case 'navigate':
      case 'wait':
        throw new BrowserDriverError('ACTION_UNSUPPORTED', `${action.kind} is not supported on a desktop binding`)
    }
  }

  private async assertDesktop(
    driver: CuaDesktopDriver,
    window: DesktopWindowRef,
    check: AssertCheck,
    context: OperationContext,
  ): Promise<ActionResult> {
    if (check.kind === 'url') {
      throw new BrowserDriverError('ACTION_UNSUPPORTED', 'URL assertions are not supported on a desktop binding')
    }
    const observation = await driver.observe(window, context)
    const matches = observation.elements.filter(element => {
      if (check.kind === 'text') {
        return (element.name ?? '').includes(check.contains) || (element.value ?? '').includes(check.contains)
      }
      const target = check.target
      if (target.role !== undefined && element.role !== target.role) return false
      if (target.name !== undefined && element.name !== target.name) return false
      if (target.text !== undefined && !(element.name ?? '').includes(target.text)) return false
      return true
    })
    if (check.kind === 'text') {
      if (matches.length === 0) throw new BrowserDriverError('ASSERTION_FAILED', `desktop assertion failed: no element shows text ${JSON.stringify(check.contains)}`)
      return { status: 'ok' }
    }
    if (check.kind === 'element') {
      const exists = matches.length > 0
      if (exists !== check.exists) {
        throw new BrowserDriverError('ASSERTION_FAILED', `desktop assertion failed: expected ${check.exists ? 'an element' : 'no element'}, found ${String(matches.length)}`)
      }
      return { status: 'ok' }
    }
    const [match] = matches
    if (match === undefined) throw new BrowserDriverError('ASSERTION_FAILED', 'desktop assertion failed: element not found')
    if ((match.value ?? '') !== check.equals) {
      throw new BrowserDriverError('ASSERTION_FAILED', `desktop assertion failed: expected value ${JSON.stringify(check.equals)}, got ${JSON.stringify(match.value ?? '')}`)
    }
    return { status: 'ok' }
  }

  private async bindIsolated(context: OperationContext, profileName?: string): Promise<BrowserBinding> {
    const sessionId = context.principal.sessionId
    const existing = this.registry.get(sessionId)
    if (existing !== undefined) await this.release(existing.binding)

    const cuaSession = cuaSessionName(this.sessionPrefix, sessionId)
    let reserved: { readonly pid: number; readonly windowId: number } | undefined
    try {
      await this.endStaleSession(cuaSession, context)
      await this.invoke('start_session', { session: cuaSession, capture_scope: 'window' }, context)
      const profile = profileName === undefined
        ? { mode: 'isolated_new' }
        : { mode: 'isolated_named', name: profileName }
      if (profileName !== undefined) await suppressSessionRestore(profileName)
      const prepared = ensureOk(await this.invoke('browser_prepare', {
        session: cuaSession,
        profile,
        allow_launch: true,
      }, context), 'browser_prepare')
      const pid = Number(prepared['prepared_pid'])
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new BrowserDriverError('BROWSER_BINDING_STALE', 'Cua isolated launch returned no pid')
      }

      let windowId: number | undefined
      let fallbackWindowId: number | undefined
      // 刚 launch 时可能先出现 1x1/隐藏的辅助窗口，等真正的浏览器窗口再绑。
      for (let attempt = 0; attempt < 25 && windowId === undefined; attempt += 1) {
        const listing = objectOfResult(await this.invoke('list_windows', {}, context))
        const rows = Array.isArray(listing['windows']) ? listing['windows'] as JsonObject[] : []
        const candidates = rows.filter(row => Number(row['pid']) === pid && row['layer'] === 0)
          .filter(row => Number((row['bounds'] as JsonObject | undefined)?.['width'] ?? 0) >= 500)
        const chosen = candidates.find(row => row['is_on_screen'] === true) ?? candidates[0]
        const value = Number(chosen?.['window_id'])
        if (Number.isInteger(value) && value > 0) {
          windowId = value
          break
        }
        if (fallbackWindowId === undefined) {
          const any = rows.find(row => Number(row['pid']) === pid && row['layer'] === 0)
          const fallback = Number(any?.['window_id'])
          if (Number.isInteger(fallback) && fallback > 0) fallbackWindowId = fallback
        }
        await new Promise<void>(resolve => setTimeout(resolve, 200))
      }
      windowId ??= fallbackWindowId
      if (windowId === undefined) {
        throw new BrowserDriverError('BROWSER_BINDING_STALE', 'Cua isolated launch produced no bindable window')
      }

      this.registry.reserve(sessionId, pid, windowId)
      reserved = { pid, windowId }

      const data = ensureOk(await this.invoke('get_browser_state', {
        pid,
        window_id: windowId,
        session: cuaSession,
        snapshot_format: 'semantic_v2',
      }, context), 'get_browser_state')

      const quality = stringValue(data['binding_quality'])
      if (quality !== 'exact') {
        throw new BrowserDriverError('BROWSER_BINDING_STALE', `Cua binding quality is ${quality ?? 'unknown'}`)
      }
      const targetId = stringValue(data['target_id'])
      if (targetId === undefined) throw new BrowserDriverError('BROWSER_BINDING_STALE', 'Cua binding returned no target id')
      const tabs = Array.isArray(data['tabs']) ? data['tabs'] as JsonObject[] : []
      const tab = tabs.find(candidate => candidate['active'] === true) ?? tabs[0]
      const tabId = stringValue(tab?.['tab_id'])
      if (tabId === undefined) throw new BrowserDriverError('BROWSER_BINDING_STALE', 'Cua binding returned no tab id')

      const binding: BrowserBinding = {
        id: this.registry.bindingId(sessionId),
        driverId: this.id,
        sessionId,
        pid,
        windowId,
        targetId,
        tabId,
        generation: this.registry.nextGeneration(),
      }
      const route = stringValue(data['binding_route'])
      this.registry.commit({
        binding,
        cuaSession,
        tabCount: tabs.length,
        ...(route === undefined ? {} : { bindingRoute: route }),
      })
      reserved = undefined
      return binding
    } catch (error) {
      if (reserved !== undefined) {
        this.registry.releaseReservation(sessionId, reserved.pid, reserved.windowId)
      }
      await this.invoke('end_session', { session: cuaSession }, context).catch(() => undefined)
      throw error
    }
  }

  async observe(binding: BrowserBinding, context: OperationContext): Promise<Observation> {
    if (this.isDesktop(binding)) return await this.observeDesktop(binding, context)
    this.registry.assertCurrent(binding)
    let data: JsonObject | undefined
    const deadline = Date.now() + this.tabFollowTimeoutMs
    for (;;) {
      const record = this.registry.assertCurrent(binding)
      try {
        data = ensureOk(
          await this.invoke('get_browser_state', {
            session: record.cuaSession,
            target_id: record.binding.targetId,
            tab_id: record.binding.tabId,
            snapshot_format: 'semantic_v2',
          }, context),
          'get_browser_state',
        )
        break
      } catch (error) {
        // A followed tab can still be on its provisional frame for a moment:
        // Cua reports `browser_route_unavailable` / "Frame ... not found".
        // Re-mint the active pair for the same window and retry the snapshot;
        // the handles, not the binding, were stale.
        if (!this.isTransientTabRouteError(error) || context.signal.aborted || Date.now() >= deadline) throw error
        await sleep(this.tabFollowIntervalMs)
        const refreshed = await this.refreshActivePair(binding, context).catch(() => false)
        if (!refreshed) throw error
      }
    }

    const page = data['page'] as JsonObject | undefined
    const snapshot = data['snapshot'] as JsonObject | undefined
    const rawRefs = Array.isArray(data['refs']) ? (data['refs'] as JsonObject[]) : []
    const elements: ObservationElement[] = rawRefs.flatMap(raw => {
      const ref = stringValue(raw['ref'])
      const role = stringValue(raw['role'])
      if (ref === undefined || role === undefined) return []
      const name = stringValue(raw['name'])
      const value = stringValue(raw['value'])
      const visibility = stringValue(raw['visibility'])
      const states = raw['states']
      const stateSignature = typeof states === 'object' && states !== null && !Array.isArray(states)
        ? Object.entries(states as JsonObject)
          .filter(([, entry]) => typeof entry === 'boolean' || typeof entry === 'string')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => `${key}=${String(entry)}`)
          .join(',')
        : undefined
      return [{
        ref,
        role,
        ...(name === undefined ? {} : { name }),
        ...(value === undefined ? {} : { value }),
        ...(Array.isArray(raw['actions']) ? { actions: (raw['actions'] as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
        ...(visibility === undefined ? {} : { visibility }),
        ...(stateSignature === undefined || stateSignature.length === 0 ? {} : { stateSignature }),
      }]
    })
    const title = stringValue(page?.['title'])
    const observation: Observation = {
      observationId: stringValue(snapshot?.['id']) ?? `${binding.id}:${String(binding.generation)}:${String(Date.now())}`,
      bindingGeneration: binding.generation,
      url: stringValue(page?.['url']) ?? '',
      ...(title === undefined ? {} : { title }),
      elements,
    }
    this.references.remember(binding, observation)
    if (!this.isDesktop(binding)) this.registry.updateObservation(binding, observation)
    return observation
  }

  async resolve(binding: BrowserBinding, target: SemanticTarget, observation: Observation): Promise<ResolvedTarget> {
    if (!this.isDesktop(binding)) this.registry.assertCurrent(binding)
    return this.references.resolve(binding, target, observation)
  }

  async execute(
    binding: BrowserBinding,
    action: BrowserAction,
    resolved: ResolvedTarget | undefined,
    context: OperationContext,
  ): Promise<ActionResult> {
    if (this.isDesktop(binding)) return await this.executeDesktop(binding, action, context)
    const record = this.registry.assertCurrent(binding)
    if (resolved !== undefined && record.observation?.observationId !== resolved.observationId) {
      throw new BrowserDriverError('TARGET_STALE', 'Resolved target is stale; observe again before acting')
    }

    if (action.kind === 'assert') {
      await this.assertCheck(binding, action.check, context)
      return { status: 'ok' }
    }

    let result: CuaToolResult
    switch (action.kind) {
      case 'navigate':
        if (!isNavigableUrl(action.url)) throw new BrowserDriverError('INVALID_ARGUMENT', 'Only http/https/about URLs are allowed')
        result = await this.invoke('browser_navigate', {
          session: record.cuaSession,
          target_id: record.binding.targetId,
          tab_id: record.binding.tabId,
          url: action.url,
        }, context)
        break
      case 'click': {
        if (resolved === undefined) throw new BrowserDriverError('INVALID_ARGUMENT', 'Click requires a resolved semantic target')
        const button = action.button ?? 'left'
        const count = action.count ?? 1
        if (count > 2) {
          throw new BrowserDriverError('ACTION_UNSUPPORTED', 'browser click supports count 1 (single) or 2 (double)')
        }
        if (button === 'right' && count > 1) {
          throw new BrowserDriverError('ACTION_UNSUPPORTED', 'browser right-click supports count 1 only')
        }
        // Left single click is verified end-to-end (and may fall back to a
        // synthetic DOM click); right/double go straight through
        // browser_pointer — a double click must never be retried.
        if (button === 'left' && count === 1) {
          return await this.singleClick(binding, record, action, resolved, context)
        }
        result = await this.invoke('browser_pointer', {
          session: record.cuaSession,
          target_id: record.binding.targetId,
          tab_id: record.binding.tabId,
          action: button === 'right' ? 'right_click' : 'double_click',
          ref: resolved.ref,
          input_route: 'trusted',
        }, context)
        break
      }
      case 'setValue':
        if (resolved === undefined) throw new BrowserDriverError('INVALID_ARGUMENT', 'setValue requires a resolved semantic target')
        result = await this.invoke('browser_type', {
          session: record.cuaSession,
          target_id: record.binding.targetId,
          tab_id: record.binding.tabId,
          ref: resolved.ref,
          text: action.value,
          replace: true,
        }, context)
        break
      case 'drag': {
        // Browser drags stay semantic: both endpoint refs come from one fresh
        // snapshot and Cua's browser_pointer carries the gesture (CDP input).
        const observation = await this.observe(binding, context)
        const from = await this.resolve(binding, action.from, observation)
        const to = await this.resolve(binding, action.to, observation)
        result = await this.invoke('browser_pointer', {
          session: record.cuaSession,
          target_id: record.binding.targetId,
          tab_id: record.binding.tabId,
          action: 'drag',
          ref: from.ref,
          destination_ref: to.ref,
          input_route: 'trusted',
        }, context)
        break
      }
      case 'scroll': {
        const dx = action.deltaX
        const dy = action.deltaY
        if (dx === 0 && dy === 0) {
          throw new BrowserDriverError('INVALID_ARGUMENT', 'scroll needs deltaX or deltaY')
        }
        if (action.target !== undefined && resolved === undefined) {
          throw new BrowserDriverError('INVALID_ARGUMENT', 'scroll with a target requires a resolved semantic target')
        }
        if (resolved !== undefined) {
          // Scroll at the target ref; Cua first brings the ref into view, then
          // applies the pixel delta.
          result = await this.invoke('browser_pointer', {
            session: record.cuaSession,
            target_id: record.binding.targetId,
            tab_id: record.binding.tabId,
            action: 'scroll',
            delta_x: dx,
            delta_y: dy,
            ref: resolved.ref,
            input_route: 'trusted',
          }, context)
        } else {
          // No ref: Cua's wheel needs a point, so aim at the viewport centre.
          const centre = await this.viewportCentre(binding, context)
          result = await this.invoke('browser_pointer', {
            session: record.cuaSession,
            target_id: record.binding.targetId,
            tab_id: record.binding.tabId,
            action: 'scroll',
            delta_x: dx,
            delta_y: dy,
            x: centre.x,
            y: centre.y,
            input_route: 'trusted',
          }, context)
        }
        break
      }
      case 'key':
        // Cua 0.38 has no browser-scoped key tool: browser_pointer only carries
        // pointer gestures and browser_type's `keystrokes` mode types text
        // (a "\n"/"\t" character becomes Enter/Tab, but ordinary key names are
        // typed literally and no modifiers exist). A desktop binding is the
        // route that can press a real key.
        throw new BrowserDriverError(
          'ACTION_UNSUPPORTED',
          'key is not supported on a browser binding: Cua 0.38 exposes no browser-scoped key injection. Use a desktop binding (cua_desktop_press_key) or replace the step with click/assert.',
        )
      case 'wait':
        throw new BrowserDriverError('ACTION_UNSUPPORTED', `${action.kind} is not mapped by the Cua V1 browser driver`)
      default: {
        const exhaustive: never = action
        throw new BrowserDriverError('ACTION_UNSUPPORTED', `Unsupported action: ${JSON.stringify(exhaustive)}`)
      }
    }

    ensureOk(result, action.kind)
    const followSummary = action.kind === 'click'
      ? (await this.followActiveTab(binding, record, context)).summary
      : undefined
    this.references.invalidate(binding)
    this.registry.clearObservation(binding)
    return {
      status: 'ok',
      ...(followSummary === undefined ? {} : { summary: followSummary }),
    }
  }

  /**
   * Left single click, verified.
   *
   * Cua's trusted route is CDP `Input.dispatchMouseEvent`. A native browser
   * overlay can swallow that input: Chrome's password-manager bubble (for
   * example "change your password" after a breached credential) floats over
   * the page, the ref still resolves to the button, and Cua answers
   * `clicked (x, y)` while the page receives no pointer events at all. The
   * driver therefore checks that the page actually changed and, when it did
   * not, re-dispatches as a synthetic DOM click — that path runs inside the
   * page and is not blocked by native overlays.
   *
   * Two dispatches with no observable change are reported as
   * ACTION_UNCONFIRMED instead of a success that did nothing.
   */
  private async singleClick(
    binding: BrowserBinding,
    record: CuaBindingRecord,
    action: Extract<BrowserAction, { kind: 'click' }>,
    resolved: ResolvedTarget,
    context: OperationContext,
  ): Promise<ActionResult> {
    const before = record.observation
    let follow: TabFollowOutcome = { changed: false, verified: false }
    let changed = false
    let last: Observation | undefined
    let trustedRefused = false

    try {
      await this.dispatchClick(binding, 'trusted', resolved.ref, context)
    } catch (error) {
      // Some configurations refuse trusted input outright (no background
      // hardware-like route). That is exactly what the synthetic route is for;
      // every other refusal (stale ref, unknown target) must stay an error.
      if (!(error instanceof BrowserDriverError) || !TRUST_ROUTE_UNAVAILABLE.test(error.message)) throw error
      trustedRefused = true
    }

    if (!trustedRefused) {
      follow = await this.followActiveTab(binding, this.registry.assertCurrent(binding), context)
      changed = follow.changed
      // Only a clean follow with no new tab is worth an effect check.
      if (!changed && follow.verified && before !== undefined) {
        const effect = await this.awaitClickEffect(binding, before, context)
        changed = effect.changed
        last = effect.observation
      }
    }

    let fallback = trustedRefused
    if (!changed && (trustedRefused || (follow.verified && before !== undefined))) {
      // Re-resolve from the observation the effect check just took: that
      // snapshot superseded the ref we clicked with. A refused trusted click
      // did not supersede anything, so its ref is still current.
      const retryRef = trustedRefused
        ? resolved.ref
        : last === undefined
          ? undefined
          : (await this.resolve(binding, action.target, last).catch(() => undefined))?.ref
      if (retryRef === undefined) {
        throw new BrowserDriverError(
          'ACTION_UNCONFIRMED',
          `click on ${describeTarget(action.target)} could not be delivered: trusted input was refused and the target no longer resolves for a synthetic DOM click`,
        )
      }
      fallback = true
      await this.dispatchClick(binding, 'dom_event', retryRef, context)
      follow = await this.followActiveTab(binding, this.registry.assertCurrent(binding), context)
      changed = follow.changed
      if (!changed && follow.verified) {
        const effect = await this.awaitClickEffect(binding, before, context)
        changed = effect.changed
      }
      if (!changed && follow.verified) {
        this.references.invalidate(binding)
        this.registry.clearObservation(binding)
        throw new BrowserDriverError(
          'ACTION_UNCONFIRMED',
          `click on ${describeTarget(action.target)} was dispatched twice (trusted input, then a synthetic DOM click) but the page did not change; the control did not activate (a native browser overlay such as Chrome's password-manager bubble can block trusted mouse input)`,
        )
      }
    }

    this.references.invalidate(binding)
    this.registry.clearObservation(binding)
    const summary = [
      ...(trustedRefused
        ? ['trusted input was unavailable, dispatched a synthetic DOM click']
        : fallback
          ? ['trusted input had no observable effect, re-dispatched as a synthetic DOM click']
          : []),
      ...(follow.summary === undefined ? [] : [follow.summary]),
    ].join('; ')
    return { status: 'ok', ...(summary.length === 0 ? {} : { summary }) }
  }

  /** Dispatch one `browser_click` on the requested route and return its summary. */
  private async dispatchClick(
    binding: BrowserBinding,
    route: 'trusted' | 'dom_event',
    ref: string,
    context: OperationContext,
  ): Promise<string> {
    const record = this.registry.assertCurrent(binding)
    const result = await this.invoke('browser_click', {
      session: record.cuaSession,
      target_id: record.binding.targetId,
      tab_id: record.binding.tabId,
      ref,
      input_route: route,
    }, context)
    const data = ensureOk(result, 'browser_click')
    return stringValue(data['summary']) ?? `clicked via ${route}`
  }

  /**
   * Poll the bound page until its URL, elements or element states differ from
   * the observation the click was resolved against. A snapshot that cannot be
   * read while the page navigates counts as a change: never retry a click that
   * may have landed.
   */
  private async awaitClickEffect(
    binding: BrowserBinding,
    before: Observation | undefined,
    context: OperationContext,
  ): Promise<{ changed: boolean; observation?: Observation }> {
    if (before === undefined) return { changed: true }
    const deadline = Date.now() + this.clickConfirmTimeoutMs
    let last: Observation | undefined
    for (;;) {
      try {
        const observation = await this.observe(binding, context)
        last = observation
        if (observationFingerprint(before) !== observationFingerprint(observation)) {
          return { changed: true, observation }
        }
      } catch {
        return { changed: true }
      }
      if (context.signal.aborted || Date.now() >= deadline) {
        return { changed: false, ...(last === undefined ? {} : { observation: last }) }
      }
      await sleep(this.clickConfirmIntervalMs)
    }
  }

  /**
   * After a click, re-read the active tab of the *same native window* and move
   * the binding onto it when a `target="_blank"` tab has become active.
   *
   * Cua mints a fresh session-scoped target id and fresh tab ids on every
   * bind-mode (`pid` + `window_id`) query — the 2026-11-01 spike saw the target
   * id change on all 14 polls while the underlying window and tabs stayed the
   * same. Therefore the originally planned guard
   * `active.target_id === binding.targetId` can never hold; the target identity
   * we can actually verify is the native window (pid/window) plus the exact
   * binding route/quality. A response that changes route/quality, or whose
   * active tab is not accompanied by the pre-click tab, is treated as a
   * different target/window: the old tab is kept and the reason is reported in
   * the step summary.
   */
  private async followActiveTab(
    binding: BrowserBinding,
    record: CuaBindingRecord,
    context: OperationContext,
  ): Promise<TabFollowOutcome> {
    const beforeUrl = record.observation?.url
    const beforeCount = record.tabCount
    if (beforeUrl === undefined || beforeUrl.length === 0) return { changed: false, verified: false }
    const deadline = Date.now() + this.tabFollowTimeoutMs
    let quietPolls = 0

    for (;;) {
      if (context.signal.aborted) return { changed: false, verified: false }
      let data: JsonObject
      try {
        data = ensureOk(await this.invoke('get_browser_state', {
          session: record.cuaSession,
          pid: binding.pid,
          window_id: binding.windowId,
          snapshot_format: 'semantic_v2',
        }, context), 'get_browser_state')
      } catch {
        // A click already happened; a follow hiccup must not turn it into a
        // failed action. Keep the old tab and say so in the summary.
        return { summary: 'kept current tab: tab refresh failed', changed: false, verified: false }
      }

      const quality = stringValue(data['binding_quality'])
      const route = stringValue(data['binding_route'])
      const mode = stringValue(data['mode'])
      if (quality !== 'exact'
        || (record.bindingRoute !== undefined && route !== record.bindingRoute)
        || (mode !== undefined && mode !== 'bind')) {
        return { summary: 'kept current tab: refresh bound a different target', changed: false, verified: false }
      }

      const tabs = Array.isArray(data['tabs']) ? data['tabs'] as JsonObject[] : []
      const active = tabs.find(tab => tab['active'] === true)
      const activeUrl = active === undefined ? undefined : stringValue(active['url'])
      const activeTabId = active === undefined ? undefined : stringValue(active['tab_id'])
      const targetId = stringValue(data['target_id'])
      if (active === undefined || activeUrl === undefined || activeTabId === undefined || targetId === undefined) {
        if (Date.now() >= deadline) {
          if (tabs.length > 0) this.registry.setTabCount(binding, tabs.length)
          return { changed: tabCountGrew(beforeCount, tabs.length), verified: true }
        }
        await sleep(this.tabFollowIntervalMs)
        continue
      }

      const countIncreased = beforeCount !== undefined && tabs.length > beforeCount
      const activeChanged = activeUrl !== beforeUrl
      if (activeChanged && countIncreased) {
        // A new tab is open and active. The pre-click tab must still be in the
        // same tab list, otherwise this is a different target/window.
        const oldTabPresent = tabs.some(tab => stringValue(tab['url']) === beforeUrl)
        if (!oldTabPresent) {
          return { summary: 'kept current tab: active tab belongs to a different target/window', changed: false, verified: false }
        }
        this.registry.retarget(binding, targetId, activeTabId, tabs.length)
        return { summary: 'followed active tab in the same window', changed: true, verified: true }
      }
      if (activeChanged) {
        // Same tab navigated (target=_self) or the target was replaced. The
        // current handles still address the tab, so keep them.
        this.registry.setTabCount(binding, tabs.length)
        return { changed: true, verified: true }
      }
      if (countIncreased) {
        // The new tab exists but has not activated yet; wait for it.
        quietPolls = 0
      } else {
        quietPolls += 1
        if (quietPolls >= this.tabFollowQuietPolls) {
          this.registry.setTabCount(binding, tabs.length)
          return { changed: false, verified: true }
        }
      }
      if (Date.now() >= deadline) {
        this.registry.setTabCount(binding, tabs.length)
        return { changed: tabCountGrew(beforeCount, tabs.length), verified: true }
      }
      await sleep(this.tabFollowIntervalMs)
    }
  }

  /**
   * The viewport centre in CSS pixels, for scrolls without a target.
   *
   * Cua's `browser_pointer` scroll accepts `ref` or `x`/`y`; without either it
   * fails with `tool_invocation_failed`. The viewport size is read once from
   * `get_browser_state { include_screenshot: true }` metadata and cached on the
   * binding, so the (image-bearing) response is paid at most once per bind.
   */
  private async viewportCentre(binding: BrowserBinding, context: OperationContext): Promise<{ readonly x: number; readonly y: number }> {
    const record = this.registry.assertCurrent(binding)
    let viewport = record.viewport
    if (viewport === undefined) {
      const data = ensureOk(await this.invoke('get_browser_state', {
        session: record.cuaSession,
        target_id: record.binding.targetId,
        tab_id: record.binding.tabId,
        snapshot_format: 'semantic_v2',
        include_screenshot: true,
      }, context), 'get_browser_state')
      const measured = viewportFrom(data)
      if (measured === undefined) {
        throw new BrowserDriverError(
          'BROWSER_BINDING_STALE',
          'Cua did not report the tab viewport in its screenshot metadata; pass a target for scroll or bind again',
        )
      }
      viewport = this.registry.setViewport(binding, measured).viewport ?? measured
    }
    return { x: Math.floor(viewport.width / 2), y: Math.floor(viewport.height / 2) }
  }

  /**
   * A freshly followed tab may still be attaching its frame; Cua then answers
   * the snapshot with `browser_route_unavailable` until the frame is ready.
   * These errors are safe to recover from by minting a fresh pair.
   */
  private isTransientTabRouteError(error: unknown): boolean {
    return error instanceof BrowserDriverError
      && error.code === 'BROWSER_BINDING_STALE'
      && /browser_route_unavailable|Frame with the given frameId is not found/i.test(error.message)
  }

  /**
   * Re-mint `(target_id, tab_id)` for the active tab of the bound native
   * window. Used only to recover a snapshot from a provisional/dead frame;
   * the route/quality guards still apply, so a different target is refused.
   */
  private async refreshActivePair(binding: BrowserBinding, context: OperationContext): Promise<boolean> {
    const record = this.registry.assertCurrent(binding)
    const data = ensureOk(await this.invoke('get_browser_state', {
      session: record.cuaSession,
      pid: binding.pid,
      window_id: binding.windowId,
      snapshot_format: 'semantic_v2',
    }, context), 'get_browser_state')

    const quality = stringValue(data['binding_quality'])
    const route = stringValue(data['binding_route'])
    const mode = stringValue(data['mode'])
    if (quality !== 'exact'
      || (record.bindingRoute !== undefined && route !== record.bindingRoute)
      || (mode !== undefined && mode !== 'bind')) return false

    const tabs = Array.isArray(data['tabs']) ? data['tabs'] as JsonObject[] : []
    const active = tabs.find(tab => tab['active'] === true)
    const targetId = stringValue(data['target_id'])
    const tabId = active === undefined ? undefined : stringValue(active['tab_id'])
    if (targetId === undefined || tabId === undefined) return false
    this.registry.retarget(binding, targetId, tabId, tabs.length)
    return true
  }

  /**
   * 只读校验：assert 不产生副作用，失败抛 ASSERTION_FAILED。
   * 正向断言（期待出现）带 5 秒 settle 重试，避免「导航刚返回、页面还没渲染」的假失败；
   * 负向断言（期待不存在）只判定一次——空页面不应让「不存在」假通过得太早，也不应反复等。
   */
  private async assertCheck(
    binding: BrowserBinding,
    check: AssertCheck,
    context: OperationContext,
  ): Promise<void> {
    const retryable = check.kind === 'element' ? check.exists : true
    const deadline = Date.now() + this.assertSettleTimeoutMs
    for (;;) {
      const observation = await this.observe(binding, context)
      const failure = this.evaluateAssert(observation, check)
      if (failure === undefined) return
      if (!retryable || context.signal.aborted || Date.now() >= deadline) {
        throw new BrowserDriverError('ASSERTION_FAILED', failure)
      }
      await sleep(this.assertSettleIntervalMs)
    }
  }

  private evaluateAssert(observation: Observation, check: AssertCheck): string | undefined {
    switch (check.kind) {
      case 'url':
        return observation.url.includes(check.contains)
          ? undefined
          : `assertion failed: URL ${JSON.stringify(observation.url)} does not contain ${JSON.stringify(check.contains)}`
      case 'text': {
        const found = observation.elements.some(element =>
          (element.name ?? '').includes(check.contains) || (element.value ?? '').includes(check.contains))
        return found ? undefined : `assertion failed: page does not show text ${JSON.stringify(check.contains)}`
      }
      case 'element': {
        const matches = this.visibleMatches(observation.elements, check.target)
        const exists = matches.length > 0
        return exists === check.exists
          ? undefined
          : `assertion failed: expected ${check.exists ? 'an element' : 'no element'} matching ${describeTarget(check.target)}, found ${String(matches.length)}`
      }
      case 'value': {
        const [match] = this.visibleMatches(observation.elements, check.target)
        if (match === undefined) {
          return `assertion failed: no element matching ${describeTarget(check.target)}`
        }
        const actual = match.value ?? ''
        return actual === check.equals
          ? undefined
          : `assertion failed: expected value ${JSON.stringify(check.equals)}, got ${JSON.stringify(actual)}`
      }
    }
  }

  private visibleMatches(elements: readonly ObservationElement[], target: SemanticTarget): ObservationElement[] {
    const matches = elements.filter(element => {
      if (target.role !== undefined && element.role !== target.role) return false
      if (target.name !== undefined && element.name !== target.name) return false
      if (target.text !== undefined
        && !(element.name ?? '').includes(target.text)
        && !(element.value ?? '').includes(target.text)) return false
      return true
    })
    const visible = matches.filter(element => element.visibility === undefined || element.visibility === 'in_viewport')
    return visible.length > 0 ? visible : matches
  }

  async release(binding: BrowserBinding): Promise<void> {
    if (this.isDesktop(binding)) {
      this.desktopBindings.delete(binding.sessionId)
      return
    }
    const record = this.registry.get(binding.sessionId)
    if (record === undefined) return
    this.references.forget(binding)
    this.registry.detach(binding)
    const controller = new AbortController()
    await this.caller.callTool('end_session', { session: record.cuaSession }, {
      principal: { sessionId: binding.sessionId, agentId: 'driver' },
      callId: 'release',
      origin: 'internal',
      signal: controller.signal,
    }).catch(() => undefined)
  }
}
