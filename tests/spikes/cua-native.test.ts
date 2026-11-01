/**
 * Native Cua transport smoke/spike.
 *
 * Default run: loads the in-process SDK, lists the tool catalog and reads
 * `health_report`; it never touches a browser.
 *
 * `CUA_NATIVE_E2E=1`: also launches its own Chrome with a throwaway profile,
 * binds through `browser_prepare existing_profile`, navigates to a local
 * fixture and types into a textbox.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { NativeTransport, CUA_REQUIRED_BROWSER_TOOLS } from '../../src/cua/index.js'
import type { OperationContext, JsonObject } from '../../src/core/api.js'

const CHROME_PATH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const E2E = process.env.CUA_NATIVE_E2E === '1'

interface ChromeHandle {
  child: ChildProcess
  pid: number
  debugPort: number
  profileDir: string
}

function context(callId: string): OperationContext {
  return {
    principal: { sessionId: 'cua-native-spike', agentId: 'cua-native-spike' },
    callId,
    origin: 'internal',
    signal: new AbortController().signal,
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no TCP address')))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

async function waitForCdp(debugPort: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      if (response.ok) return
    } catch {
      // Chrome is still starting.
    }
    await sleep(250)
  }
  throw new Error(`Chrome CDP did not come up on ${debugPort}`)
}

async function launchChrome(startUrl: string): Promise<ChromeHandle> {
  const debugPort = await freePort()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-cua-native-'))
  const child = spawn(
    CHROME_PATH,
    [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--window-size=1200,800',
      '--window-position=40,40',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      startUrl,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
  )
  child.stderr?.on('data', () => undefined)
  if (child.pid === undefined) throw new Error('Chrome did not expose a pid')
  await waitForCdp(debugPort)
  return { child, pid: child.pid, debugPort, profileDir }
}

async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const html = await readFile(resolve('tests/fixtures/browser-app/index.html'), 'utf8')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no address')
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

function dataOf(result: { structuredContent?: unknown; content: readonly { type: string; text?: string }[] }): JsonObject {
  if (result.structuredContent !== undefined && typeof result.structuredContent === 'object') {
    return result.structuredContent as JsonObject
  }
  const text = result.content.find(part => part.type === 'text')?.text
  if (text === undefined) return {}
  try {
    return JSON.parse(text) as JsonObject
  } catch {
    return {}
  }
}

async function main(): Promise<void> {
  const transport = await NativeTransport.create()
  let chrome: ChromeHandle | undefined
  let fixture: { server: Server; url: string } | undefined
  const session = `dsh-native-spike-${Date.now().toString(36)}`
  try {
    const catalog = await transport.listTools(new AbortController().signal)
    const names = catalog.tools.map(tool => tool.name)
    const missing = CUA_REQUIRED_BROWSER_TOOLS.filter(name => !names.includes(name))
    assert.deepEqual(missing, [], `missing required browser tools: ${missing.join(', ')}`)

    const health = dataOf(await transport.callTool('health_report', {}, context('health')))
    console.log(JSON.stringify({ stage: 'catalog', toolCount: names.length, driverVersion: health['driver_version'] }))

    if (!E2E) {
      console.log(JSON.stringify({ status: 'pass', mode: 'catalog-only' }))
      return
    }

    fixture = await startFixtureServer()
    chrome = await launchChrome('about:blank')

    await transport.callTool('start_session', { session, capture_scope: 'window' }, context('start'))
    let windowId: number | undefined
    let browserPid: number | undefined
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const windows = dataOf(await transport.callTool('list_windows', {}, context('windows')))['windows']
      const rows = Array.isArray(windows) ? windows as JsonObject[] : []
      const mine = rows.filter(row => row['pid'] === chrome?.pid && row['layer'] === 0
        && Number((row['bounds'] as JsonObject | undefined)?.['width'] ?? 0) >= 500)
      const chosen = mine.find(row => row['is_on_screen'] === true) ?? mine[0]
      if (chosen !== undefined) {
        windowId = Number(chosen['window_id'])
        browserPid = Number(chosen['pid'])
        break
      }
      await sleep(500)
    }
    assert.ok(windowId !== undefined && browserPid !== undefined, 'no browser window found')

    const before = dataOf(await transport.callTool('get_browser_state', {
      pid: browserPid,
      window_id: windowId,
      session,
      snapshot_format: 'semantic_v2',
    }, context('state-1')))
    assert.equal(before['status'], 'refused', 'an unprepared profile must refuse')

    transport.armExistingProfileGrant({ pid: browserPid, windowId })
    const prepared = dataOf(await transport.callTool('browser_prepare', {
      pid: browserPid,
      window_id: windowId,
      session,
      strategy: { kind: 'existing_profile' },
    }, context('prepare')))
    assert.notEqual(prepared['status'], 'refused', `browser_prepare refused: ${JSON.stringify(prepared)}`)

    const bound = dataOf(await transport.callTool('get_browser_state', {
      pid: browserPid,
      window_id: windowId,
      session,
      snapshot_format: 'semantic_v2',
    }, context('state-2')))
    assert.equal(bound['binding_quality'], 'exact', `binding quality: ${String(bound['binding_quality'])}`)
    const targetId = String(bound['target_id'])
    const tabs = Array.isArray(bound['tabs']) ? bound['tabs'] as JsonObject[] : []
    const tab = tabs.find(entry => entry['active'] === true) ?? tabs[0]
    assert.ok(tab !== undefined, 'no tab')
    const tabId = String(tab['tab_id'])

    await transport.callTool('browser_navigate', {
      session,
      target_id: targetId,
      tab_id: tabId,
      url: fixture.url,
    }, context('navigate'))

    const page = dataOf(await transport.callTool('get_browser_state', {
      session,
      target_id: targetId,
      tab_id: tabId,
      snapshot_format: 'semantic_v2',
    }, context('state-3')))
    const refs = Array.isArray(page['refs']) ? page['refs'] as JsonObject[] : []
    const input = refs.find(ref => ref['role'] === 'textbox')
    assert.ok(input !== undefined, 'no textbox in the fixture')
    await transport.callTool('browser_type', {
      session,
      target_id: targetId,
      tab_id: tabId,
      ref: String(input['ref']),
      text: 'native-ok',
      replace: true,
    }, context('type'))

    console.log(JSON.stringify({ status: 'pass', mode: 'e2e', refs: refs.length }))
  } finally {
    await transport.callTool('end_session', { session }, context('end')).catch(() => undefined)
    await transport.close()
    if (fixture !== undefined) await new Promise<void>(resolveClose => fixture?.server.close(() => resolveClose()))
    if (chrome !== undefined) {
      try {
        process.kill(-chrome.pid, 'SIGTERM')
      } catch {
        chrome.child.kill('SIGTERM')
      }
      await sleep(400)
      await rm(chrome.profileDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

await main().catch(error => {
  console.error(error)
  process.exit(1)
})
