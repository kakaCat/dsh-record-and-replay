import { describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue, OperationContext, SemanticTarget } from '../../src/core/api.js'
import { CuaBrowserDriver } from '../../src/cua/browser-driver.js'
import type { CuaToolCaller } from '../../src/cua/bindings.js'
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

interface PhysicalTab {
  url: string
  title: string
}

interface FakeOptions {
  /** Click opens this tab. */
  readonly newTab?: PhysicalTab
  /** Leave the new tab in the background. */
  readonly backgroundTab?: boolean
  /** Activate the new tab only after this many bind-mode polls. */
  readonly activateAfterPolls?: number
  /** Click navigates the current tab instead of opening one. */
  readonly navigateOnClick?: PhysicalTab
  /** Refresh answers from a different binding route. */
  readonly foreignRoute?: boolean
  /** Refresh answers with only foreign tabs (old tab gone). */
  readonly foreignTabs?: boolean
  /** Refresh throws. */
  readonly failRefresh?: boolean
  /** First snapshot after following fails with Cua's provisional-frame error. */
  readonly frameErrorAfterFollow?: number
}

/**
 * Models Cua 0.38's tab/target semantics observed by the 2026-11-01 spike:
 * every bind-mode (`pid` + `window_id`) query mints a *new* target id and new
 * tab ids; pairs from one response remain usable, but mixing a target and a
 * tab from different responses is refused with `browser_tab_not_found`.
 */
class TabFakeCua implements CuaToolCaller {
  readonly calls: Array<{ name: string; args: JsonObject }> = []
  private readonly tabs: PhysicalTab[] = [{ url: 'about:blank', title: 'about:blank' }]
  private active = 0
  private readonly targets = new Map<string, Set<string>>()
  private readonly owners = new Map<string, { targetId: string; index: number }>()
  private targetSequence = 0
  private tabSequence = 0
  private snapshotSequence = 0
  private bindPolls = 0
  private pendingActivation: number | undefined
  private frameErrors = 0
  private opened = false

  constructor(private readonly options: FakeOptions = {}) {}

  async callTool(name: string, args: JsonObject): Promise<CuaToolResult> {
    this.calls.push({ name, args })
    if (name === 'start_session' || name === 'end_session' || name === 'browser_prepare') {
      return result({ status: 'ok' })
    }
    if (name === 'browser_navigate') {
      const index = this.indexFor(String(args['tab_id']))
      const tab = this.tabs[index]
      if (tab !== undefined) {
        tab.url = String(args['url'])
        tab.title = String(args['url'])
      }
      return result({ status: 'ok', url: String(args['url']) })
    }
    if (name === 'browser_click') {
      if (!this.opened) {
        this.opened = true
        if (this.options.newTab !== undefined) {
          this.tabs.push({ ...this.options.newTab })
          this.frameErrors = this.options.frameErrorAfterFollow ?? 0
          if (this.options.backgroundTab !== true) {
            if (this.options.activateAfterPolls === undefined) this.active = this.tabs.length - 1
            else this.pendingActivation = this.options.activateAfterPolls
          }
        } else if (this.options.navigateOnClick !== undefined) {
          const tab = this.tabs[this.active]
          if (tab !== undefined) {
            tab.url = this.options.navigateOnClick.url
            tab.title = this.options.navigateOnClick.title
          }
        }
      }
      return result({ status: 'ok', summary: 'clicked' })
    }
    if (name === 'browser_type' || name === 'browser_pointer') return result({ status: 'ok' })

    if (name !== 'get_browser_state') return result({ status: 'refused', refusal: { code: 'unknown_tool' } })

    const isBind = args['pid'] !== undefined && args['tab_id'] === undefined
    if (isBind) {
      this.bindPolls += 1
      if (this.options.failRefresh === true && this.bindPolls > 1) throw new Error('refresh transport down')
      if (this.options.foreignRoute === true && this.bindPolls > 1) {
        return result({
          status: 'ok',
          binding_quality: 'exact',
          binding_route: 'cdp_port',
          mode: 'bind',
          target_id: 'bt-foreign',
          tabs: [{ tab_id: 'tab-foreign', active: true, url: 'https://foreign.test/', title: 'foreign' }],
        })
      }
      this.tickActivation()
      const rows = this.options.foreignTabs === true && this.bindPolls > 1
        ? this.mintTabs(
          { targetId: 'bt-foreign', tabs: [{ url: 'https://foreign.test/', title: 'foreign' }, { url: 'https://foreign.test/2', title: 'foreign2' }], active: 0 },
        )
        : this.mintTabs()
      return result({
        status: 'ok',
        binding_quality: 'exact',
        binding_route: 'native_cdp_window',
        mode: 'bind',
        target_id: rows.targetId,
        tabs: rows.tabs,
      })
    }

    const targetId = String(args['target_id'])
    const tabId = String(args['tab_id'])
    if (this.frameErrors > 0) {
      this.frameErrors -= 1
      return result({
        status: 'refused',
        refusal: {
          code: 'browser_route_unavailable',
          message: 'CDP Accessibility.getFullAXTree failed: Frame with the given frameId is not found.',
        },
      })
    }
    const owned = this.targets.get(targetId)?.has(tabId) === true && this.owners.get(tabId)?.targetId === targetId
    if (!owned) return result({ status: 'refused', refusal: { code: 'browser_tab_not_found' } })
    const tab = this.tabs[this.indexFor(tabId)]
    this.snapshotSequence += 1
    const snap = `p${String(this.snapshotSequence)}`
    return result({
      status: 'ok',
      snapshot: { id: snap },
      page: { url: tab?.url ?? '', title: tab?.title ?? '' },
      refs: [
        { ref: `${snap}:0`, role: 'link', name: 'open', actions: ['click'] },
        { ref: `${snap}:1`, role: 'button', name: 'Submit', actions: ['click'] },
        { ref: `${snap}:2`, role: 'textbox', name: 'Name', value: 'Ada' },
      ],
    })
  }

  private tickActivation(): void {
    if (this.pendingActivation === undefined) return
    if (this.pendingActivation <= 0) {
      this.active = this.tabs.length - 1
      this.pendingActivation = undefined
      return
    }
    this.pendingActivation -= 1
  }

  private mintTabs(): { targetId: string; tabs: JsonObject[] }
  private mintTabs(override: { targetId: string; tabs: PhysicalTab[]; active: number }): { targetId: string; tabs: JsonObject[] }
  private mintTabs(override?: { targetId: string; tabs: PhysicalTab[]; active: number }): { targetId: string; tabs: JsonObject[] } {
    const targetId = override?.targetId ?? `bt-${String(++this.targetSequence)}`
    const tabs = override?.tabs ?? this.tabs
    const active = override?.active ?? this.active
    const ids = new Set<string>()
    const rows = tabs.map((tab, index) => {
      const tabId = `tab-${String(++this.tabSequence)}`
      ids.add(tabId)
      this.owners.set(tabId, { targetId, index })
      return { tab_id: tabId, active: index === active, url: tab.url, title: tab.title }
    })
    this.targets.set(targetId, ids)
    return { targetId, tabs: rows }
  }

  private indexFor(tabId: string): number {
    return this.owners.get(tabId)?.index ?? -1
  }

  /** Newest snapshot request the driver made. */
  lastSnapshotCall(): JsonObject | undefined {
    return this.calls.filter(call => call.name === 'get_browser_state' && call.args['tab_id'] !== undefined).at(-1)?.args
  }

  bindPollCount(): number {
    return this.bindPolls
  }
}

const FAST = { tabFollowTimeoutMs: 200, tabFollowIntervalMs: 1, tabFollowQuietPolls: 2 }
const LINK: SemanticTarget = { role: 'link', name: 'open' }

async function clickLink(driver: CuaBrowserDriver, binding: Awaited<ReturnType<CuaBrowserDriver['bind']>>, ctx: OperationContext) {
  const observation = await driver.observe(binding, ctx)
  const resolved = await driver.resolve(binding, LINK, observation)
  return await driver.execute(binding, { kind: 'click', target: LINK }, resolved, ctx)
}

describe('CuaBrowserDriver / new-tab following', () => {
  it('follows a target=_blank tab and the next observe uses the new target/tab pair', async () => {
    const caller = new TabFakeCua({ newTab: { url: 'https://example.test/second', title: 'Second' } })
    const driver = new CuaBrowserDriver(caller, undefined, FAST)
    const ctx = context('follow')
    const binding = await driver.bind({ pid: 700, windowId: 70 }, ctx)
    try {
      const action = await clickLink(driver, binding, ctx)
      expect(action.summary).toContain('followed active tab')

      const observation = await driver.observe(binding, ctx)
      expect(observation.url).toBe('https://example.test/second')
      const snapshotArgs = caller.lastSnapshotCall()
      expect(String(snapshotArgs?.['tab_id'])).not.toBe(binding.tabId)
      expect(String(snapshotArgs?.['target_id'])).not.toBe(binding.targetId)
    } finally {
      await driver.release(binding)
    }
  })

  it('recovers a provisional frame after following by minting a fresh pair', async () => {
    const caller = new TabFakeCua({
      newTab: { url: 'https://example.test/second', title: 'Second' },
      frameErrorAfterFollow: 1,
    })
    const driver = new CuaBrowserDriver(caller, undefined, FAST)
    const ctx = context('follow-frame')
    const binding = await driver.bind({ pid: 705, windowId: 70 }, ctx)
    try {
      const action = await clickLink(driver, binding, ctx)
      expect(action.summary).toContain('followed active tab')
      const pollsAfterClick = caller.bindPollCount()
      const observation = await driver.observe(binding, ctx)
      expect(observation.url).toBe('https://example.test/second')
      expect(caller.bindPollCount()).toBeGreaterThan(pollsAfterClick)
    } finally {
      await driver.release(binding)
    }
  })

  it('retries while the new tab exists but has not activated yet', async () => {
    const caller = new TabFakeCua({
      newTab: { url: 'https://example.test/second', title: 'Second' },
      activateAfterPolls: 2,
    })
    const driver = new CuaBrowserDriver(caller, undefined, FAST)
    const ctx = context('follow-race')
    const binding = await driver.bind({ pid: 710, windowId: 71 }, ctx)
    try {
      const action = await clickLink(driver, binding, ctx)
      expect(action.summary).toContain('followed active tab')
      expect(caller.bindPollCount()).toBeGreaterThanOrEqual(3)
      const observation = await driver.observe(binding, ctx)
      expect(observation.url).toBe('https://example.test/second')
    } finally {
      await driver.release(binding)
    }
  })

  it('keeps the current tab when the new tab stays in the background', async () => {
    const caller = new TabFakeCua({
      newTab: { url: 'https://example.test/background', title: 'Background' },
      backgroundTab: true,
    })
    const driver = new CuaBrowserDriver(caller, undefined, { ...FAST, tabFollowTimeoutMs: 20 })
    const ctx = context('follow-background')
    const binding = await driver.bind({ pid: 720, windowId: 72 }, ctx)
    try {
      const action = await clickLink(driver, binding, ctx)
      expect(action.summary).toBeUndefined()
      const observation = await driver.observe(binding, ctx)
      expect(observation.url).toBe('about:blank')
    } finally {
      await driver.release(binding)
    }
  })

  it('keeps the current tab when the refresh binds a different target', async () => {
    const caller = new TabFakeCua({ foreignRoute: true })
    const driver = new CuaBrowserDriver(caller, undefined, FAST)
    const ctx = context('follow-target')
    const binding = await driver.bind({ pid: 730, windowId: 73 }, ctx)
    try {
      const action = await clickLink(driver, binding, ctx)
      expect(action.summary).toContain('different target')
      const observation = await driver.observe(binding, ctx)
      expect(observation.url).toBe('about:blank')
      const snapshotArgs = caller.lastSnapshotCall()
      expect(snapshotArgs?.['target_id']).toBe(binding.targetId)
      expect(snapshotArgs?.['tab_id']).toBe(binding.tabId)
    } finally {
      await driver.release(binding)
    }
  })

  it('keeps the current tab when the pre-click tab is gone from the refreshed tab list', async () => {
    const caller = new TabFakeCua({
      newTab: { url: 'https://example.test/second', title: 'Second' },
      foreignTabs: true,
    })
    const driver = new CuaBrowserDriver(caller, undefined, FAST)
    const ctx = context('follow-window')
    const binding = await driver.bind({ pid: 740, windowId: 74 }, ctx)
    try {
      const action = await clickLink(driver, binding, ctx)
      expect(action.summary).toContain('different target/window')
      await expect(driver.observe(binding, ctx)).resolves.toMatchObject({ url: 'about:blank' })
    } finally {
      await driver.release(binding)
    }
  })

  it('does not fail the click when the tab refresh throws', async () => {
    const caller = new TabFakeCua({ newTab: { url: 'https://example.test/second', title: 'Second' }, failRefresh: true })
    const driver = new CuaBrowserDriver(caller, undefined, FAST)
    const ctx = context('follow-error')
    const binding = await driver.bind({ pid: 750, windowId: 75 }, ctx)
    try {
      const action = await clickLink(driver, binding, ctx)
      expect(action.summary).toContain('tab refresh failed')
      const observation = await driver.observe(binding, ctx)
      expect(observation.url).toBe('about:blank')
    } finally {
      await driver.release(binding)
    }
  })

  it('does not retarget when a click navigates the same tab', async () => {
    const caller = new TabFakeCua({ navigateOnClick: { url: 'https://example.test/next', title: 'Next' } })
    const driver = new CuaBrowserDriver(caller, undefined, FAST)
    const ctx = context('follow-same-tab')
    const binding = await driver.bind({ pid: 760, windowId: 76 }, ctx)
    try {
      const action = await clickLink(driver, binding, ctx)
      expect(action.summary).toBeUndefined()
      const observation = await driver.observe(binding, ctx)
      expect(observation.url).toBe('https://example.test/next')
      const snapshotArgs = caller.lastSnapshotCall()
      expect(snapshotArgs?.['target_id']).toBe(binding.targetId)
      expect(snapshotArgs?.['tab_id']).toBe(binding.tabId)
    } finally {
      await driver.release(binding)
    }
  })
})
