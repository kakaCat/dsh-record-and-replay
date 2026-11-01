/**
 * Proves the named profile kept its login: bind `dsh-demo`, open the
 * members-only inventory URL directly, and look for product content.
 *
 * Run: pnpm exec tsx tests/spikes/plugin-loggedin-demo.test.ts
 */
import assert from 'node:assert/strict'
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

async function main(): Promise<void> {
  const { byName, cleanups } = makeHarness()
  const exec = {
    callId: 'call_loggedin_demo',
    signal: new AbortController().signal,
    agent: { id: 'agent_loggedin_demo', session: { id: 'session_loggedin_demo', header: { cwd: process.cwd() } } },
    deferContext() {},
    concludeTurn() {},
  }
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const tool = byName.get(name)
    assert.ok(tool !== undefined, `missing tool ${name}`)
    return await tool.execute(args, exec)
  }
  try {
    const binding = await call('cua_record_bind_browser', { launch: 'isolated', profileName: 'dsh-demo' })
    console.log('BIND', JSON.stringify(binding))
    await call('cua_record_action', { action: { kind: 'navigate', url: 'https://www.saucedemo.com/inventory.html' } })
    await new Promise<void>(resolve => setTimeout(resolve, 2500))
    const observation = await call('cua_record_observe')
    console.log('TITLE', observation.title)
    const names = (observation.elements ?? []).map((element: any) => String(element.name ?? ''))
    const loggedIn = names.some((name: string) => name.includes('Sauce Labs Backpack'))
    console.log('URL', observation.url)
    console.log('LOGGED_IN', loggedIn, 'sample:', names.filter((name: string) => name.length > 0).slice(0, 6))
    assert.ok(loggedIn, 'named profile did not keep the login')
    console.log('OK named profile kept its session')
  } finally {
    await call('cua_record_release_browser').catch(() => undefined)
    for (const cleanup of cleanups) cleanup()
  }
}

await main().catch(error => {
  console.error(error)
  process.exit(1)
})
