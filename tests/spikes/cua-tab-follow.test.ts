/**
 * Spike: does Cua 0.38 expose a stable "active tab" after a target=_blank click?
 *
 * Run: pnpm exec tsx tests/spikes/cua-tab-follow.test.ts
 *
 * It launches a driver-owned isolated Chromium (the same `isolated_new` route
 * `CuaBrowserDriver.bindIsolated` uses), binds it over one persistent MCP
 * session, clicks a `target="_blank"` link, then repeatedly queries
 * `get_browser_state {pid, window_id}` *without* tab_id and records the active
 * tab / target id over time. Finally it repeats the same probe on Bilibili's
 * "热门" link.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

type JsonObject = Record<string, unknown>
type WaitOptions = { timeoutMs?: number; intervalMs?: number }

interface ToolResult {
  isError?: boolean
  structuredContent?: unknown
  content?: Array<{ type?: string; text?: string }>
}

function toolData(result: unknown): JsonObject {
  const r = result as ToolResult
  if (r.isError === true) {
    throw new Error(`Cua tool returned isError: ${JSON.stringify(result).slice(0, 1200)}`)
  }
  if (r.structuredContent !== undefined && r.structuredContent !== null) {
    return r.structuredContent as JsonObject
  }
  const text = r.content?.find(part => part.type === 'text')?.text
  if (text !== undefined) {
    try {
      return JSON.parse(text) as JsonObject
    } catch {
      return { text }
    }
  }
  return {}
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, options: WaitOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const intervalMs = options.intervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`${label} timed out${lastError === undefined ? '' : `: ${String(lastError)}`}`)
}

function browserWindow(windows: unknown, pid: number): JsonObject {
  const rows = Array.isArray((windows as JsonObject).windows) ? ((windows as JsonObject).windows as JsonObject[]) : []
  const candidates = rows
    .filter(window => Number(window['pid']) === pid && window['layer'] === 0 && Number((window['bounds'] as JsonObject | undefined)?.['width'] ?? 0) >= 500)
    .sort((a, b) => {
      const area = (window: JsonObject): number => {
        const bounds = window['bounds'] as JsonObject | undefined
        return Number(bounds?.['width'] ?? 0) * Number(bounds?.['height'] ?? 0)
      }
      return area(b) - area(a)
    })
  const exact = candidates.find(window => window['is_on_screen'] === true) ?? candidates[0]
  if (exact === undefined) throw new Error(`no layer-0 browser window found for pid ${pid}: ${JSON.stringify(rows.filter(w => w['pid'] === pid))}`)
  return exact
}

async function connectCua(): Promise<Client> {
  const transport = new StdioClientTransport({ command: 'cua-driver', args: ['mcp'], stderr: 'ignore' })
  const client = new Client({ name: 'dsh-tab-follow-spike', version: '0.1.0' })
  await client.connect(transport)
  return client
}

interface TabRow {
  tab_id?: unknown
  active?: unknown
  url?: unknown
  title?: unknown
  [key: string]: unknown
}

interface PollRow {
  at: number
  elapsedMs: number
  status: unknown
  targetId: unknown
  page: unknown
  tabs: TabRow[]
}

function tabRows(data: JsonObject): TabRow[] {
  return Array.isArray(data['tabs'])
    ? (data['tabs'] as TabRow[]).map(tab => ({ ...tab }))
    : []
}

async function main(): Promise<void> {
  const fixtureDir = join(process.cwd(), 'tests/fixtures/tab-follow')
  const homeHtml = await readFile(join(fixtureDir, 'index.html'), 'utf8')
  const secondHtml = await readFile(join(fixtureDir, 'second.html'), 'utf8')
  const server = createServer((request, response) => {
    if (request.url === '/' || request.url?.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(homeHtml)
      return
    }
    if (request.url === '/second.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(secondHtml)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise<void>((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveServer())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no address')
  const fixtureUrl = `http://127.0.0.1:${address.port}/`

  let cua: Client | undefined
  const session = `dsh-tab-follow-${Date.now().toString(36)}`
  const calls: string[] = []
  const evidence: JsonObject = {
    generatedAt: new Date().toISOString(),
    cuaVersion: '0.38.0',
    fixtureUrl,
    session,
    launch: 'isolated_new',
  }
  try {
    cua = await connectCua()
    const invoke = async (name: string, args: JsonObject): Promise<JsonObject> => {
      calls.push(name)
      return toolData(await cua!.callTool({ name, arguments: args }))
    }

    const health = await invoke('health_report', {})
    const build = health['build'] as JsonObject | undefined
    evidence['cuaVersion'] = build?.['version'] ?? '0.38.0'

    await invoke('start_session', { session, capture_scope: 'window' })
    const prepared = await invoke('browser_prepare', {
      session,
      profile: { mode: 'isolated_new' },
      allow_launch: true,
    })
    evidence['prepare'] = { status: prepared['status'], action: prepared['action'] }
    assert.equal(prepared['status'], 'ok', `isolated browser_prepare failed: ${JSON.stringify(prepared).slice(0, 1500)}`)
    const pid = Number(prepared['prepared_pid'])
    assert.ok(Number.isInteger(pid) && pid > 0, 'isolated launch returned no pid')

    const window = await waitFor('isolated browser window', async () => {
      const listing = await invoke('list_windows', {})
      try {
        return browserWindow(listing, pid)
      } catch {
        return undefined
      }
    })
    const windowId = Number(window['window_id'])
    assert.ok(Number.isInteger(windowId) && windowId > 0, 'isolated launch produced no window id')
    evidence['browserPid'] = pid
    evidence['windowId'] = windowId
    evidence['window'] = window

    const bound = await invoke('get_browser_state', {
      pid,
      window_id: windowId,
      session,
      snapshot_format: 'semantic_v2',
    })
    assert.equal(bound['status'], 'ok', `bind failed: ${JSON.stringify(bound).slice(0, 1500)}`)
    assert.equal(bound['binding_quality'], 'exact', `binding quality ${String(bound['binding_quality'])}`)
    const targetId = String(bound['target_id'])
    const initialTabs = tabRows(bound)
    const initialTab = initialTabs.find(tab => tab['active'] === true) ?? initialTabs[0]
    const initialTabId = String(initialTab?.['tab_id'])
    assert.ok(initialTabId.length > 0, 'binding returned no tab id')
    evidence['bind'] = {
      targetId,
      tabId: initialTabId,
      tabs: initialTabs,
      bindingQuality: bound['binding_quality'],
      route: bound['binding_route'],
    }

    const navResult = await invoke('browser_navigate', { session, target_id: targetId, tab_id: initialTabId, url: fixtureUrl })
    assert.equal(navResult['status'], 'ok', `navigation failed: ${JSON.stringify(navResult).slice(0, 1000)}`)
    const homeState = await invoke('get_browser_state', {
      session, target_id: targetId, tab_id: initialTabId, snapshot_format: 'semantic_v2',
    })
    const homeRefs = Array.isArray(homeState['refs']) ? (homeState['refs'] as JsonObject[]) : []
    evidence['home'] = { page: homeState['page'], refs: homeRefs.slice(0, 20) }
    const linkRef = homeRefs.find(ref => ref['role'] === 'link' && String(ref['name'] ?? '').includes('open'))?.['ref']
      ?? homeRefs.find(ref => String(ref['name'] ?? '').includes('open'))?.['ref']
    assert.equal(typeof linkRef, 'string', `fixture link not found: ${JSON.stringify(homeRefs).slice(0, 1500)}`)

    const clickStarted = Date.now()
    const clickResult = await invoke('browser_click', {
      session,
      target_id: targetId,
      tab_id: initialTabId,
      ref: linkRef,
      input_route: 'trusted',
    })
    evidence['click'] = { ref: linkRef, targetId, tabId: initialTabId, result: clickResult, waitedMs: Date.now() - clickStarted }

    const polls: PollRow[] = []
    let firstActiveNewTab: { elapsedMs: number; tabId: string } | undefined
    let firstDifferentTarget: { elapsedMs: number; targetId: string } | undefined
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const started = Date.now()
      const state = await invoke('get_browser_state', {
        pid,
        window_id: windowId,
        session,
        snapshot_format: 'semantic_v2',
      })
      const poll: PollRow = {
        at: Date.now(),
        elapsedMs: Date.now() - clickStarted,
        status: state['status'],
        targetId: state['target_id'],
        page: state['page'],
        tabs: tabRows(state),
      }
      polls.push(poll)
      const active = poll.tabs.find(tab => tab['active'] === true)
      if (firstActiveNewTab === undefined && active !== undefined && String(active['tab_id']) !== initialTabId) {
        firstActiveNewTab = { elapsedMs: poll.elapsedMs, tabId: String(active['tab_id']) }
      }
      if (firstDifferentTarget === undefined && String(poll.targetId) !== targetId) {
        firstDifferentTarget = { elapsedMs: poll.elapsedMs, targetId: String(poll.targetId) }
      }
      const wait = 250 - (Date.now() - started)
      if (wait > 0) await sleep(wait)
    }
    evidence['polls'] = polls
    evidence['firstActiveNewTab'] = firstActiveNewTab ?? null
    evidence['firstDifferentTarget'] = firstDifferentTarget ?? null

    const settled = polls.at(-1)
    const activeTab = settled?.tabs.find(tab => tab['active'] === true)
    const newTabId = activeTab === undefined ? undefined : String(activeTab['tab_id'])
    evidence['settled'] = { targetId: settled?.targetId, activeTabId: newTabId, tabs: settled?.tabs ?? [] }

    const after: JsonObject = {}
    // 1) target_id only (the previously failed attempt): does it expose tabs?
    const targetOnly = await invoke('get_browser_state', {
      session, target_id: targetId, snapshot_format: 'semantic_v2',
    })
    after['targetOnly'] = {
      status: targetOnly['status'],
      targetId: targetOnly['target_id'],
      tabs: targetOnly['tabs'] ?? null,
      page: targetOnly['page'] ?? null,
    }
    // 2) pid/window again: stable target_id? stable tab ids?
    const byPidWindow = await invoke('get_browser_state', {
      pid, window_id: windowId, session, snapshot_format: 'semantic_v2',
    })
    after['byPidWindow'] = {
      status: byPidWindow['status'],
      targetId: byPidWindow['target_id'],
      tabs: byPidWindow['tabs'] ?? null,
      page: byPidWindow['page'] ?? null,
    }
    // 3) can the new tab be driven through the *original* target id?
    if (newTabId !== undefined) {
      const newTabState = await invoke('get_browser_state', {
        session, target_id: targetId, tab_id: newTabId, snapshot_format: 'semantic_v2',
      })
      const newRefs = Array.isArray(newTabState['refs']) ? (newTabState['refs'] as JsonObject[]) : []
      after['newTabViaBoundTarget'] = {
        status: newTabState['status'],
        page: newTabState['page'] ?? null,
        markerFound: JSON.stringify(newTabState).includes('SECOND_PAGE_MARKER'),
        refs: newRefs.slice(0, 20),
        error: newTabState['error'] ?? null,
      }
    }
    // 4) old tab still addressable?
    const oldTabState = await invoke('get_browser_state', {
      session, target_id: targetId, tab_id: initialTabId, snapshot_format: 'semantic_v2',
    })
    after['oldTabViaBoundTarget'] = {
      status: oldTabState['status'],
      page: oldTabState['page'] ?? null,
      markerFound: JSON.stringify(oldTabState).includes('HOME_PAGE_MARKER'),
      error: oldTabState['error'] ?? null,
    }
    evidence['after'] = after

    // A usable pair must come from ONE bind-mode response: target ids and tab
    // ids are re-minted on every query, so mixing two responses is refused.
    const freshPair = async (): Promise<{ targetId: string; tabId: string; tabs: TabRow[] }> => {
      const state = await invoke('get_browser_state', {
        pid, window_id: windowId, session, snapshot_format: 'semantic_v2',
      })
      const tabs = tabRows(state)
      const active = tabs.find(tab => tab['active'] === true)
      const freshTargetId = String(state['target_id'])
      const freshTabId = String(active?.['tab_id'])
      assert.ok(freshTargetId.length > 0 && freshTabId.length > 0, 'fresh bind response had no usable pair')
      return { targetId: freshTargetId, tabId: freshTabId, tabs }
    }

    // 5) Repeat: click another _blank link from a fresh atomic pair.
    {
      const firstPair = await freshPair()
      await invoke('browser_navigate', { session, target_id: firstPair.targetId, tab_id: firstPair.tabId, url: fixtureUrl })
      const again = await invoke('get_browser_state', {
        session, target_id: firstPair.targetId, tab_id: firstPair.tabId, snapshot_format: 'semantic_v2',
      })
      const againRefs = Array.isArray(again['refs']) ? (again['refs'] as JsonObject[]) : []
      const againLink = againRefs.find(ref => String(ref['name'] ?? '').includes('open'))?.['ref']
      if (typeof againLink === 'string') {
        const repeatClickAt = Date.now()
        await invoke('browser_click', {
          session, target_id: firstPair.targetId, tab_id: firstPair.tabId, ref: againLink, input_route: 'trusted',
        })
        const repeatPolls: JsonObject[] = []
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const started = Date.now()
          const state = await invoke('get_browser_state', {
            pid, window_id: windowId, session, snapshot_format: 'semantic_v2',
          })
          repeatPolls.push({
            elapsedMs: Date.now() - repeatClickAt,
            targetId: state['target_id'],
            tabs: state['tabs'] ?? null,
            page: state['page'] ?? null,
          })
          const wait = 250 - (Date.now() - started)
          if (wait > 0) await sleep(wait)
        }
        evidence['repeatClick'] = { ref: againLink, pair: firstPair, polls: repeatPolls }
      }
    }

    // 6) Bilibili: does the real "热门" link behave the same way?
    const bilibili: JsonObject = { attempted: true }
    try {
      const homePair = await freshPair()
      await invoke('browser_navigate', {
        session, target_id: homePair.targetId, tab_id: homePair.tabId, url: 'https://www.bilibili.com/',
      })
      await sleep(3_000)
      const biliHome = await invoke('get_browser_state', {
        session, target_id: homePair.targetId, tab_id: homePair.tabId, snapshot_format: 'semantic_v2',
      })
      const biliRefs = Array.isArray(biliHome['refs']) ? (biliHome['refs'] as JsonObject[]) : []
      bilibili['home'] = { page: biliHome['page'] ?? null }
      const hotRef = biliRefs.find(ref => String(ref['name'] ?? '').trim() === '热门')?.['ref']
        ?? biliRefs.find(ref => String(ref['name'] ?? '').includes('热门'))?.['ref']
      bilibili['hotCandidates'] = biliRefs.filter(ref => String(ref['name'] ?? '').includes('热门')).slice(0, 5)
      bilibili['hotRef'] = hotRef ?? null
      if (typeof hotRef === 'string') {
        const hotClickAt = Date.now()
        const hotClick = await invoke('browser_click', {
          session, target_id: homePair.targetId, tab_id: homePair.tabId, ref: hotRef, input_route: 'trusted',
        })
        bilibili['click'] = { ref: hotRef, result: hotClick }
        const hotPolls: JsonObject[] = []
        for (let attempt = 0; attempt < 14; attempt += 1) {
          const started = Date.now()
          const state = await invoke('get_browser_state', {
            pid, window_id: windowId, session, snapshot_format: 'semantic_v2',
          })
          hotPolls.push({
            elapsedMs: Date.now() - hotClickAt,
            targetId: state['target_id'],
            page: state['page'] ?? null,
            tabs: tabRows(state),
          })
          const wait = 250 - (Date.now() - started)
          if (wait > 0) await sleep(wait)
        }
        bilibili['polls'] = hotPolls
        const popularPair = await freshPair()
        bilibili['popularPair'] = { targetId: popularPair.targetId, tabId: popularPair.tabId }
        const popular = await invoke('get_browser_state', {
          session, target_id: popularPair.targetId, tab_id: popularPair.tabId, snapshot_format: 'semantic_v2',
        })
        bilibili['popular'] = {
          status: popular['status'],
          page: popular['page'] ?? null,
          hasPopularMarker: /热门|popular/i.test(JSON.stringify(popular)),
        }
      }
    } catch (error) {
      bilibili['error'] = error instanceof Error ? error.message : String(error)
    }
    evidence['bilibili'] = bilibili
    evidence['calls'] = calls

    const evidencePath = join(process.cwd(), 'docs/spikes/2026-11-01-tab-follow/evidence.json')
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(JSON.stringify({
      ok: true,
      evidencePath,
      targetId,
      initialTabId,
      firstActiveNewTab,
      firstDifferentTarget,
      settled: evidence['settled'],
      targetOnly: after['targetOnly'],
      newTabViaBoundTarget: after['newTabViaBoundTarget'],
      bilibili: {
        home: bilibili['home'],
        hotRef: bilibili['hotRef'],
        popular: bilibili['popular'],
        polls: bilibili['polls'],
      },
    }, null, 2))
  } finally {
    if (cua !== undefined) {
      await cua.callTool({ name: 'end_session', arguments: { session } }).catch(() => undefined)
      await cua.close().catch(() => undefined)
    }
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
