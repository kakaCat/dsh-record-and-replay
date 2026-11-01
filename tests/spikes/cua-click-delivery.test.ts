/**
 * Spike: which Cua click delivery actually activates a page control?
 *
 * Flow per run (identical to the DSH browser driver):
 *   navigate -> snapshot -> [type username/password] -> click -> poll outcome
 *
 * Mode `login` (default) judges success by the URL reaching `inventory`.
 * Mode `activation` submits the empty form and judges success by the
 * "Epic sadface: Username is required" error (a click that activates React).
 *
 * Usage:
 *   tsx tests/spikes/cua-click-delivery.test.ts --runs=10
 *   tsx tests/spikes/cua-click-delivery.test.ts --runs=10 --mode=activation
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

type JsonObject = Record<string, unknown>
type VariantId =
  | 'click_trusted_bg'
  | 'click_trusted_fg'
  | 'click_dom_event'
  | 'pointer_hover_then_click'
  | 'click_xy_bg'
  | 'pointer_click'

const SAUCEDEMO = 'https://www.saucedemo.com/'
const OUTCOME_TIMEOUT_MS = 8_000

interface ToolResult {
  isError?: boolean
  structuredContent?: unknown
  content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>
}

function argValue(name: string, fallback: number): number {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`))
  if (hit === undefined) return fallback
  const parsed = Number(hit.slice(name.length + 3))
  return Number.isFinite(parsed) ? parsed : fallback
}

function argString(name: string, fallback: string): string {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

function toolData(result: unknown): JsonObject {
  const r = result as ToolResult
  if (r.isError === true) throw new Error(`Cua tool returned isError: ${JSON.stringify(result).slice(0, 1200)}`)
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

function imageOf(result: unknown): string | undefined {
  const r = result as ToolResult
  for (const part of r.content ?? []) {
    if (part.type === 'image' && typeof part.data === 'string') return part.data
    if (part.type === 'text' && part.text?.startsWith('data:image/')) return part.text.slice(part.text.indexOf(',') + 1)
  }
  return undefined
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 20_000, intervalMs = 200): Promise<T> {
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

function chromeWindow(windows: JsonObject, pid: number): JsonObject | undefined {
  const rows = Array.isArray(windows['windows']) ? (windows['windows'] as JsonObject[]) : []
  return rows
    .filter(window => window['pid'] === pid && window['layer'] === 0 && Number((window['bounds'] as JsonObject | undefined)?.['width'] ?? 0) >= 500)
    .sort((a, b) => {
      const area = (w: JsonObject): number => Number((w['bounds'] as JsonObject | undefined)?.['width'] ?? 0) * Number((w['bounds'] as JsonObject | undefined)?.['height'] ?? 0)
      return area(b) - area(a)
    })[0]
}

interface Refs {
  username?: string | undefined
  password?: string | undefined
  login?: string | undefined
}

interface Variant {
  id: VariantId
  measured: boolean
  send: (invoke: (name: string, args: JsonObject) => Promise<JsonObject>, base: JsonObject, refs: Refs) => Promise<JsonObject>
}

const VARIANTS: Variant[] = [
  {
    id: 'click_trusted_bg',
    measured: true,
    send: (invoke, base, refs) => invoke('browser_click', { ...base, ref: refs.login, input_route: 'trusted' }),
  },
  {
    id: 'click_trusted_fg',
    measured: true,
    send: (invoke, base, refs) => invoke('browser_click', { ...base, ref: refs.login, input_route: 'trusted', delivery_mode: 'foreground' }),
  },
  {
    id: 'click_dom_event',
    measured: true,
    send: (invoke, base, refs) => invoke('browser_click', { ...base, ref: refs.login, input_route: 'dom_event' }),
  },
  {
    id: 'pointer_hover_then_click',
    measured: true,
    send: async (invoke, base, refs) => {
      const hover = await invoke('browser_pointer', { ...base, action: 'hover', ref: refs.login, input_route: 'trusted' })
      const click = await invoke('browser_click', { ...base, ref: refs.login, input_route: 'trusted' })
      return { hover, click }
    },
  },
  {
    id: 'click_xy_bg',
    measured: true,
    // Control: the same point Cua reports for the Login ref center, as x/y.
    send: (invoke, base) => invoke('browser_click', { ...base, x: 600, y: 326, input_route: 'trusted' }),
  },
  {
    id: 'pointer_click',
    measured: false,
    send: (invoke, base, refs) => invoke('browser_pointer', { ...base, action: 'click', ref: refs.login, input_route: 'trusted' }),
  },
]

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

async function main(): Promise<void> {
  const runs = argValue('runs', 10)
  const mode = argString('mode', 'login')
  const workspace = resolve(process.cwd())
  const evidenceDir = join(workspace, 'test-results/cua-evidence')
  await mkdir(evidenceDir, { recursive: true })

  const client = new Client({ name: 'dsh-click-delivery-spike', version: '0.1.0' })
  await client.connect(new StdioClientTransport({ command: 'cua-driver', args: ['mcp'], stderr: 'ignore' }))
  const session = `click-delivery-${Date.now().toString(36)}`
  const invoke = async (name: string, args: JsonObject): Promise<JsonObject> =>
    toolData(await client.callTool({ name, arguments: args }))

  interface Row {
    variant: VariantId
    iteration: number
    activated: boolean
    clickStatus: string
    effect?: string
    route?: string
    escalation?: string
    deliveryMode?: string
    urlAfter: string
    errorText?: string
    clickResponse: JsonObject
  }
  const results: Row[] = []
  const notes: string[] = []
  let base: JsonObject = {}

  const snapshotRefs = async (): Promise<{ refs: Refs; state: JsonObject }> => {
    const state = await invoke('get_browser_state', { ...base, snapshot_format: 'semantic_v2' })
    const raw = Array.isArray(state['refs']) ? (state['refs'] as JsonObject[]) : []
    const find = (role: string, name: string): string | undefined => {
      const hit = raw.find(ref => ref['role'] === role && String(ref['name'] ?? '') === name)
      return typeof hit?.['ref'] === 'string' ? (hit['ref'] as string) : undefined
    }
    return { refs: { username: find('textbox', 'Username'), password: find('textbox', 'Password'), login: find('button', 'Login') }, state }
  }

  /** Navigate and return refs from the *same* snapshot the click will use. */
  const prepareLoginPage = async (): Promise<Refs> => {
    await invoke('browser_navigate', { ...base, url: SAUCEDEMO })
    return await waitFor('login page ready', async () => {
      const { refs, state } = await snapshotRefs()
      if (refs.login === undefined || refs.username === undefined || refs.password === undefined) return undefined
      const url = String((state['page'] as JsonObject | undefined)?.['url'] ?? '')
      return url.includes('saucedemo.com') ? refs : undefined
    }, 30_000, 250)
  }

  try {
    await invoke('start_session', { session, capture_scope: 'window' })
    const prepared = await invoke('browser_prepare', { session, profile: { mode: 'isolated_new' }, allow_launch: true })
    const pid = Number(prepared['prepared_pid'])
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`isolated launch returned no pid: ${JSON.stringify(prepared).slice(0, 800)}`)
    let windowId = 0
    await waitFor('isolated browser window', async () => {
      const window = chromeWindow(await invoke('list_windows', {}), pid)
      const value = Number(window?.['window_id'])
      if (!Number.isInteger(value) || value <= 0) return undefined
      windowId = value
      return true
    })
    const binding = await invoke('get_browser_state', { pid, window_id: windowId, session, snapshot_format: 'semantic_v2' })
    if (binding['binding_quality'] !== 'exact') throw new Error(`binding not exact: ${JSON.stringify(binding).slice(0, 1200)}`)
    const tabs = Array.isArray(binding['tabs']) ? (binding['tabs'] as JsonObject[]) : []
    base = {
      session,
      target_id: String(binding['target_id']),
      tab_id: String(tabs.find(tab => tab['active'] === true)?.['tab_id'] ?? tabs[0]?.['tab_id']),
    }

    // One unmeasured probe: is a pointer click even a supported Cua action?
    try {
      const refs = await prepareLoginPage()
      await VARIANTS.find(variant => variant.id === 'pointer_click')!.send(invoke, base, refs)
      notes.push('pointer_click: supported')
    } catch (error) {
      notes.push(`pointer_click unsupported: ${error instanceof Error ? error.message : String(error)}`)
    }

    const measured = VARIANTS.filter(variant => variant.measured)
    const judge = async (): Promise<{ activated: boolean; urlAfter: string; errorText?: string }> => {
      let urlAfter = ''
      let errorText: string | undefined
      const state = await waitFor('outcome', async () => {
        const next = await invoke('get_browser_state', { ...base, snapshot_format: 'semantic_v2' })
        urlAfter = String((next['page'] as JsonObject | undefined)?.['url'] ?? '')
        const outline = typeof next['outline'] === 'string' ? next['outline'] : JSON.stringify(next)
        const match = /(Epic sadface: [^\n"]+)/.exec(outline)
        if (match !== null) errorText = match[1]
        if (mode === 'activation') return errorText === undefined ? undefined : next
        return urlAfter.includes('inventory') ? next : undefined
      }, OUTCOME_TIMEOUT_MS, 250).catch(() => undefined)
      return { activated: state !== undefined, urlAfter, ...(errorText === undefined ? {} : { errorText }) }
    }

    for (let iteration = 1; iteration <= runs; iteration += 1) {
      // Rotate variant order so warmth does not systematically favour one.
      const order: Variant[] = measured.map((_, index) => measured[(index + iteration - 1) % measured.length] as Variant)
      for (const variant of order) {
        const refs = await prepareLoginPage()
        if (mode === 'login') {
          await invoke('browser_type', { ...base, ref: refs.username, text: 'standard_user', replace: true })
          await invoke('browser_type', { ...base, ref: refs.password, text: 'secret_sauce', replace: true })
        }
        let click: JsonObject = {}
        let clickError: string | undefined
        try {
          click = await variant.send(invoke, base, refs)
        } catch (error) {
          clickError = error instanceof Error ? error.message : String(error)
        }
        const clickStatus = String(click['status'] ?? (clickError === undefined ? (click['effect'] ?? 'unknown') : 'error'))
        const outcome = await judge()
        if (!outcome.activated) {
          const raw = await client.callTool({
            name: 'get_browser_state',
            arguments: { ...base, snapshot_format: 'semantic_v2', include_screenshot: true },
          }).catch(() => undefined)
          const png = raw === undefined ? undefined : imageOf(raw)
          if (png !== undefined) {
            await writeFile(join(evidenceDir, `click-fail-${variant.id}-${String(iteration)}.png`), Buffer.from(png, 'base64'))
          }
        }
        results.push({
          variant: variant.id,
          iteration,
          activated: outcome.activated,
          clickStatus,
          ...(typeof click['effect'] === 'string' ? { effect: click['effect'] as string } : {}),
          ...(typeof click['route'] === 'string' ? { route: click['route'] as string } : {}),
          ...(typeof (click['escalation'] as JsonObject | undefined)?.['reason'] === 'string'
            ? { escalation: (click['escalation'] as JsonObject)['reason'] as string }
            : {}),
          ...(typeof (click['delivery'] as JsonObject | undefined)?.['mode'] === 'string'
            ? { deliveryMode: (click['delivery'] as JsonObject)['mode'] as string }
            : {}),
          urlAfter: outcome.urlAfter,
          ...(outcome.errorText === undefined ? {} : { errorText: outcome.errorText }),
          clickResponse: click,
        })
        if (clickError !== undefined) notes.push(`${variant.id} iteration ${iteration} click error: ${clickError}`)
      }
    }
  } finally {
    await client.callTool({ name: 'end_session', arguments: { session } }).catch(() => undefined)
    await client.close().catch(() => undefined)
  }

  const summary = VARIANTS.filter(variant => variant.measured).map(variant => {
    const rows = results.filter(row => row.variant === variant.id)
    return {
      variant: variant.id,
      runs: rows.length,
      activated: rows.filter(row => row.activated).length,
      clickStatus: countBy(rows.map(row => row.clickStatus)),
      effect: countBy(rows.map(row => row.effect ?? '<none>')),
      escalation: countBy(rows.map(row => row.escalation ?? '<none>')),
      deliveryMode: countBy(rows.map(row => row.deliveryMode ?? '<none>')),
      failures: rows.filter(row => !row.activated).map(row => ({
        iteration: row.iteration,
        clickStatus: row.clickStatus,
        effect: row.effect,
        url: row.urlAfter,
        error: row.errorText,
        response: row.clickResponse,
      })),
    }
  })

  const evidence = {
    generatedAt: new Date().toISOString(),
    url: SAUCEDEMO,
    mode,
    runsPerVariant: runs,
    summary,
    results,
    notes,
  }
  const path = join(evidenceDir, `click-delivery-${mode}.json`)
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ mode, summary, notes, path }, null, 2))
}

await main()
