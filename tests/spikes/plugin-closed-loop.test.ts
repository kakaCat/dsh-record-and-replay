import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import * as plugin from '../../src/plugin/index.js'

const execFileAsync = promisify(execFile)
const CHROME_PATH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_ARGS = ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--window-size=1200,800', '--window-position=40,40']

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('no port')); return }
      const port = address.port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value !== undefined) return value } catch (error) { last = error }
    await sleep(200)
  }
  throw new Error(`${label} timed out${last === undefined ? '' : `: ${String(last)}`}`)
}

async function startFixture(): Promise<{ server: Server; url: string }> {
  const html = await readFile('tests/fixtures/browser-app/index.html', 'utf8')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address missing')
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

interface ChromeHandle { child: ChildProcess; pid: number; profileDir: string; debugPort: number }

async function launchChrome(): Promise<ChromeHandle> {
  const debugPort = await freePort()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-closedloop-chrome-'))
  const child = spawn(CHROME_PATH, [...CHROME_ARGS, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' })
  if (child.pid === undefined) throw new Error('Chrome pid missing')
  await waitFor('Chrome CDP', async () => {
    try { const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`); return response.ok ? true : undefined } catch { return undefined }
  })
  return { child, pid: child.pid, profileDir, debugPort }
}

async function windowIdFor(pid: number): Promise<number> {
  const { stdout } = await execFileAsync('cua-driver', ['call', 'list_windows', '{}'], { maxBuffer: 4 * 1024 * 1024 })
  const start = stdout.indexOf('{')
  const parsed = JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as { windows?: Array<Record<string, unknown>> }
  const rows = (parsed.windows ?? []).filter(w => w['pid'] === pid && w['layer'] === 0)
  const chosen = rows.find(w => w['is_on_screen'] === true) ?? rows[0]
  assert.ok(chosen !== undefined, `no Chrome window for pid ${pid}`)
  const id = Number(chosen['window_id'])
  assert.ok(Number.isInteger(id) && id > 0, 'invalid window id')
  return id
}

async function evaluateInPage(debugPort: number, expression: string): Promise<unknown> {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>
  const target = targets.find(entry => entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string')
  assert.ok(target?.webSocketDebuggerUrl !== undefined, 'no CDP page target')
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => any }).WebSocket
  assert.ok(WebSocketCtor !== undefined, 'WebSocket global unavailable')
  const socket = new WebSocketCtor(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('CDP websocket failed'))
  })
  try {
    const response = await new Promise<any>((resolve) => {
      socket.onmessage = (event: { data: string }) => {
        const message = JSON.parse(event.data)
        if (message.id === 1) resolve(message)
      }
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    })
    return response.result?.result?.value
  } finally {
    socket.close()
  }
}

function makeHarness() {
  const defs: Array<{ name: string; execute(args: unknown, exec: any): Promise<unknown> }> = []
  const cleanups: Array<() => void> = []
  const toolsCtx = { tools: { register(d: any) { defs.push(d); return () => {} } }, effect(fn: () => any) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d } }
  plugin.apply({
    logger: () => ({ info: () => {}, warn: (...args: unknown[]) => console.warn('[warn]', ...args) }),
    inject(_s: string[], cb: (ctx: any) => void) { cb(toolsCtx) },
    effect(fn: () => any) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d },
  }, { recording: { enabled: true }, replay: { enabled: true } })
  const byName = new Map(defs.map(d => [d.name, d]))
  return { byName, cleanups }
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-closedloop-workspace-'))
  const fixture = await startFixture()
  let chrome: ChromeHandle | undefined
  const { byName, cleanups } = makeHarness()
  const exec = {
    callId: 'call_closed_loop',
    signal: new AbortController().signal,
    agent: { id: 'agent_closed_loop', session: { id: 'session_closed_loop', header: { cwd: workspace } } },
    deferContext() {}, concludeTurn() {},
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = byName.get(name)
    assert.ok(tool !== undefined, `missing tool ${name}`)
    return await tool.execute(args, exec) as any
  }
  try {
    chrome = await launchChrome()
    const windowId = await windowIdFor(chrome.pid)
    console.log('TARGET', { pid: chrome.pid, windowId })

    const started = await call('cua_record_start', { title: 'closed loop record' })
    await call('cua_record_bind_browser', { pid: chrome.pid, windowId })
    await call('cua_record_action', { action: { kind: 'navigate', url: fixture.url } })
    const typed = await call('cua_record_action', {
      action: { kind: 'setValue', target: { role: 'textbox', name: 'Name' }, value: 'Alice' },
    })
    await call('cua_record_action', { action: { kind: 'click', target: { role: 'button', name: 'Submit' } } })
    const steps = await call('cua_record_query', { kind: 'steps', recordingId: started.recordingId })
    console.log('RECORDED_STEPS', steps.items.length, steps.items.map((s: any) => `${s.seq}:${s.actionKind}:${s.status}`))
    assert.equal(steps.items.length, 3)
    assert.ok(steps.items.every((s: any) => s.status === 'success'))
    const setValueStep = steps.items.find((s: any) => s.actionKind === 'setValue')
    assert.ok(setValueStep !== undefined)
    assert.equal(setValueStep.stepId, typed.stepId)

    const stopped = await call('cua_record_stop', { recordingId: started.recordingId })
    assert.equal(stopped.descriptor.status, 'completed')
    await call('cua_record_release_browser')

    const replayed = await call('cua_replay_start', {
      recordingId: started.recordingId,
      pid: chrome.pid,
      windowId,
      values: { [typed.stepId]: 'Alice' },
    })
    console.log('REPLAY', JSON.stringify(replayed))
    assert.equal(replayed.status, 'completed')
    assert.equal(replayed.stepCount, 3)

    const runFile = join(workspace, '.dsh/record-replay/recordings', started.recordingId, 'runs', replayed.runId, 'run.json')
    const persisted = JSON.parse(await readFile(runFile, 'utf8')) as { status?: string }
    console.log('PERSISTED_RUN', runFile, persisted.status)
    assert.equal(persisted.status, 'completed')

    const runs = await call('cua_record_query', { kind: 'runs', recordingId: started.recordingId })
    assert.ok(runs.items.some((r: any) => r.runId === replayed.runId && r.status === 'completed'))

    await call('cua_record_bind_browser', { pid: chrome.pid, windowId })
    const observed = await call('cua_record_observe')
    console.log('OBSERVED', JSON.stringify(observed).slice(0, 1000))
    const resultText = await evaluateInPage(chrome.debugPort, "document.getElementById('result')?.textContent ?? ''")
    console.log('PAGE_RESULT', resultText)
    assert.equal(String(resultText).trim(), 'Submitted: Alice', 'replay setValue+click side effect not observed')
    await call('cua_record_release_browser')
  } finally {
    for (const cleanup of cleanups) cleanup()
    chrome?.child.kill('SIGTERM')
    if (chrome !== undefined) await rm(chrome.profileDir, { recursive: true, force: true }).catch(() => undefined)
    await new Promise<void>(resolve => fixture.server.close(() => resolve()))
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

await main()
