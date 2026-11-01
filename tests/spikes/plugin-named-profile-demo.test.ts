/**
 * Named-profile persistence demo.
 *
 * Binds a driver-owned Chromium with `profileName`, sets a cookie on the first
 * session, releases the browser, then binds the same name again and proves the
 * cookie survived. This is the "log in once, reuse later" path.
 *
 * Run: pnpm exec tsx tests/spikes/plugin-named-profile-demo.test.ts
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import * as plugin from '../../src/plugin/index.js'

interface Tool {
  name: string
  execute(args: unknown, exec: any): Promise<unknown>
}

function makeHarness() {
  const defs: Tool[] = []
  const cleanups: Array<() => void> = []
  const toolsCtx = {
    tools: { register(definition: Tool) { defs.push(definition); return () => {} } },
    effect(fn: () => any) { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose); return dispose },
  }
  plugin.apply({
    logger: () => ({ info: () => {}, warn: (...args: unknown[]) => console.warn('[warn]', ...args) }),
    inject(_services: string[], cb: (ctx: any) => void) { cb(toolsCtx) },
    effect(fn: () => any) { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose); return dispose },
  }, { recording: { enabled: true }, replay: { enabled: true } })
  return { byName: new Map(defs.map(definition => [definition.name, definition])), cleanups }
}

function startCookieServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const cookie = String(request.headers.cookie ?? '')
    const match = /(?:^|;\s*)demo=([^;]+)/u.exec(cookie)
    const value = match?.[1]
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      ...(value === undefined ? { 'set-cookie': 'demo=persisted; Path=/; Max-Age=3600' } : {}),
    })
    response.end(`<!doctype html><html><body><input id="state" aria-label="state" value="cookie: ${value ?? 'none'}"></body></html>`)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no server address'))
        return
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}/` })
    })
  })
}

async function main(): Promise<void> {
  const { byName, cleanups } = makeHarness()
  const exec = {
    callId: 'call_profile_demo',
    signal: new AbortController().signal,
    agent: { id: 'agent_profile_demo', session: { id: 'session_profile_demo', header: { cwd: process.cwd() } } },
    deferContext() {},
    concludeTurn() {},
  }
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const tool = byName.get(name)
    assert.ok(tool !== undefined, `missing tool ${name}`)
    return await tool.execute(args, exec)
  }
  const cookieState = async (): Promise<string | undefined> => {
    const observation = await call('cua_record_observe')
    const values = (observation.elements ?? [])
      .map((element: any) => String(element.value ?? element.name ?? ''))
      .filter((value: string) => value.startsWith('cookie:'))
    if (values.length === 0) console.log('OBSERVE', JSON.stringify(observation))
    return values[0]
  }

  const fixture = await startCookieServer()
  const profileName = `dsh-demo-${Date.now().toString(36)}`
  try {
    const first = await call('cua_record_bind_browser', { launch: 'isolated', profileName })
    console.log('BIND#1', JSON.stringify(first))
    await call('cua_record_action', { action: { kind: 'navigate', url: fixture.url } })
    const before = await cookieState()
    console.log('COOKIE#1', before)
    // Same-session reload: proves the browser accepted the Set-Cookie.
    await call('cua_record_action', { action: { kind: 'navigate', url: fixture.url } })
    const sameSession = await cookieState()
    console.log('COOKIE#1b', sameSession)
    // Give Chrome a moment to flush the cookie jar before the session ends.
    await new Promise<void>(resolve => setTimeout(resolve, 3000))
    await call('cua_record_release_browser')

    const second = await call('cua_record_bind_browser', { launch: 'isolated', profileName })
    console.log('BIND#2', JSON.stringify(second))
    await call('cua_record_action', { action: { kind: 'navigate', url: fixture.url } })
    const after = await cookieState()
    console.log('COOKIE#2', after)

    assert.equal(before, 'cookie: none', 'first visit should have no cookie')
    assert.equal(after, 'cookie: persisted', 'second visit should reuse the named profile cookie')
    console.log('OK named profile persisted across sessions')
  } finally {
    await call('cua_record_release_browser').catch(() => undefined)
    for (const cleanup of cleanups) cleanup()
    await new Promise<void>(resolve => fixture.server.close(() => resolve()))
  }
}

await main().catch(error => {
  console.error(error)
  process.exit(1)
})
