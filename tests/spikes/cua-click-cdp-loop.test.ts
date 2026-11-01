/**
 * Loop probe: run the SauceDemo login click repeatedly with CDP event capture
 * so a failing run can be explained instead of guessed.
 *
 * Per iteration: navigate -> install listeners -> type -> click -> inspect.
 * Prints one JSON line per iteration and writes the full log to evidence.
 *
 * Usage: tsx tests/spikes/cua-click-cdp-loop.test.ts [--runs=10] [--settle=0]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium, type Page } from '@playwright/test'

type JsonObject = Record<string, unknown>
interface ToolResult {
  isError?: boolean
  structuredContent?: unknown
  content?: Array<{ type?: string; text?: string }>
}

function toolData(result: unknown): JsonObject {
  const r = result as ToolResult
  if (r.isError === true) throw new Error(`isError: ${JSON.stringify(result).slice(0, 1200)}`)
  if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent as JsonObject
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

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 20_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== undefined) return value
    await sleep(intervalMs)
  }
  throw new Error(`${label} timed out`)
}

function chromeWindow(windows: JsonObject, pid: number): JsonObject | undefined {
  const rows = Array.isArray(windows['windows']) ? (windows['windows'] as JsonObject[]) : []
  return rows
    .filter(window => window['pid'] === pid && window['layer'] === 0 && Number((window['bounds'] as JsonObject | undefined)?.['width'] ?? 0) >= 500)
    .sort((a, b) => {
      const area = (w: JsonObject): number => Number((w['bounds'] as JsonObject | undefined)?.['width'] ?? 0) * Number((w['bounds'] as JsonObject | undefined)?.['height'] ?? 0)
      return area(b) - area(a)
    })[0]
}

const INSTALL = `(() => {
  window.__clicks = [];
  const describe = (node) => {
    if (!node || node.nodeType !== 1) return String(node && node.nodeName);
    const id = node.id ? '#' + node.id : '';
    return node.tagName.toLowerCase() + id + ' "' + String(node.textContent || '').trim().slice(0, 20) + '"';
  };
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click','submit','focusin']) {
    document.addEventListener(type, (event) => {
      window.__clicks.push({ type, target: describe(event.target), x: event.clientX, y: event.clientY, trusted: event.isTrusted, prevented: event.defaultPrevented, t: Math.round(performance.now()) });
    }, true);
  }
  window.__rects = () => [...document.querySelectorAll('input, button')].map(el => ({ id: el.id, type: el.type, rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })() }));
  return true;
})()`

async function main(): Promise<void> {
  const runsArg = process.argv.find(arg => arg.startsWith('--runs='))
  const runs = runsArg === undefined ? 10 : Number(runsArg.slice(7))
  const settleArg = process.argv.find(arg => arg.startsWith('--settle='))
  const settle = settleArg === undefined ? 0 : Number(settleArg.slice(9))
  const modeArg = process.argv.find(arg => arg.startsWith('--route='))
  const route = modeArg === undefined ? 'trusted' : modeArg.slice(8)

  const workspace = resolve(process.cwd())
  const outDir = join(workspace, 'test-results/cua-evidence')
  await mkdir(outDir, { recursive: true })
  const client = new Client({ name: 'dsh-click-cdp-loop', version: '0.1.0' })
  await client.connect(new StdioClientTransport({ command: 'cua-driver', args: ['mcp'], stderr: 'ignore' }))
  const session = `click-loop-${Date.now().toString(36)}`
  const invoke = async (name: string, args: JsonObject): Promise<JsonObject> =>
    toolData(await client.callTool({ name, arguments: args }))

  const iterations: JsonObject[] = []
  let page: Page | undefined
  let base: JsonObject = {}
  try {
    await invoke('start_session', { session, capture_scope: 'window' })
    const prepared = await invoke('browser_prepare', { session, profile: { mode: 'isolated_new' }, allow_launch: true })
    const pid = Number(prepared['prepared_pid'])
    const port = await waitFor('CDP port', async () => {
      try {
        const listing = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN']).toString()
        const match = /:(\d+) \(LISTEN\)/.exec(listing)
        return match === null ? undefined : Number(match[1])
      } catch {
        return undefined
      }
    }, 20_000, 200)
    let windowId = 0
    await waitFor('window', async () => {
      const window = chromeWindow(await invoke('list_windows', {}), pid)
      const value = Number(window?.['window_id'])
      if (!Number.isInteger(value) || value <= 0) return undefined
      windowId = value
      return true
    })
    const binding = await invoke('get_browser_state', { pid, window_id: windowId, session, snapshot_format: 'semantic_v2' })
    const tabs = Array.isArray(binding['tabs']) ? (binding['tabs'] as JsonObject[]) : []
    base = {
      session,
      target_id: String(binding['target_id']),
      tab_id: String(tabs.find(tab => tab['active'] === true)?.['tab_id'] ?? tabs[0]?.['tab_id']),
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`)
    const context = browser.contexts()[0]
    if (context === undefined) throw new Error('no CDP context')
    page = context.pages()[0] ?? await context.newPage()

    const loginRefs = async (): Promise<{ username?: string | undefined; password?: string | undefined; login?: string | undefined }> => {
      const state = await invoke('get_browser_state', { ...base, snapshot_format: 'semantic_v2' })
      const refs = Array.isArray(state['refs']) ? (state['refs'] as JsonObject[]) : []
      const find = (role: string, name: string): string | undefined => {
        const hit = refs.find(ref => ref['role'] === role && String(ref['name'] ?? '') === name)
        return typeof hit?.['ref'] === 'string' ? (hit['ref'] as string) : undefined
      }
      return { username: find('textbox', 'Username'), password: find('textbox', 'Password'), login: find('button', 'Login') }
    }

    for (let iteration = 1; iteration <= runs; iteration += 1) {
      await invoke('browser_navigate', { ...base, url: 'https://www.saucedemo.com/' })
      const refs = await waitFor('login refs', async () => {
        const found = await loginRefs()
        return found.login === undefined ? undefined : found
      }, 30_000, 250)
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined)
      await page.evaluate(INSTALL)
      await invoke('browser_type', { ...base, ref: refs.username, text: 'standard_user', replace: true })
      await invoke('browser_type', { ...base, ref: refs.password, text: 'secret_sauce', replace: true })
      if (settle > 0) await sleep(settle)
      let click: JsonObject = {}
      let clickError: string | undefined
      try {
        click = await invoke('browser_click', {
          ...base,
          ref: refs.login,
          input_route: route,
        })
      } catch (error) {
        clickError = error instanceof Error ? error.message : String(error)
      }
      await sleep(2_000)
      const observed = await page.evaluate(() => ({
        url: location.href,
        clicks: (window as unknown as { __clicks: unknown[] }).__clicks,
        rects: (window as unknown as { __rects: () => unknown }).__rects(),
        values: [...document.querySelectorAll('input')].map(input => ({ name: input.name, value: input.value, type: input.type })),
        error: /(Epic sadface: [^\n"]+)/.exec(document.body.innerText)?.[1] ?? null,
      }))
      const activated = String(observed.url).includes('inventory')
        || (observed.error !== null && String(observed.error).length > 0)
      const entry = {
        iteration,
        route,
        settle,
        clickRef: refs.login,
        clickResponse: click,
        ...(clickError === undefined ? {} : { clickError }),
        activated,
        ...observed,
      }
      iterations.push(entry)
      const events = (observed.clicks as JsonObject[]).map(event => String(event['type']))
      console.log(JSON.stringify({
        iteration,
        activated,
        url: observed.url,
        error: observed.error,
        values: observed.values,
        events,
        clickEffect: click['effect'],
      }))
    }
    await browser.close().catch(() => undefined)
  } finally {
    await client.callTool({ name: 'end_session', arguments: { session } }).catch(() => undefined)
    await client.close().catch(() => undefined)
  }

  const summary = {
    route,
    settle,
    runs,
    activated: iterations.filter(row => row['activated'] === true).length,
  }
  const path = join(outDir, `click-cdp-loop-${route}-settle${String(settle)}.json`)
  await writeFile(path, `${JSON.stringify({ summary, iterations }, null, 2)}\n`)
  console.log(JSON.stringify({ summary, path }, null, 2))
}

await main()
