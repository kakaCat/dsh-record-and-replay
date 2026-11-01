/**
 * Verifies the replay settle window: a recording made slowly (human pace) is
 * replayed at machine pace, where the login form is not rendered yet when the
 * first target step resolves.
 *
 * Run: pnpm exec tsx tests/spikes/plugin-settle-demo.test.ts
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
    callId: 'call_settle_demo',
    signal: new AbortController().signal,
    agent: { id: 'agent_settle_demo', session: { id: 'session_settle_demo', header: { cwd: process.cwd() } } },
    deferContext() {},
    concludeTurn() {},
  }
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const tool = byName.get(name)
    assert.ok(tool !== undefined, `missing tool ${name}`)
    return await tool.execute(args, exec)
  }
  try {
    await call('cua_record_bind_browser', { launch: 'isolated' })
    const started = await call('cua_record_start', { title: 'settle window demo' })

    await call('cua_record_action', { action: { kind: 'navigate', url: 'https://www.saucedemo.com/' } })
    // Human pace: the page has time to render before the next step.
    await new Promise<void>(resolve => setTimeout(resolve, 2_000))
    const user = await call('cua_record_action', {
      action: { kind: 'setValue', target: { role: 'textbox', name: 'Username' }, value: 'standard_user' },
    })
    const pass = await call('cua_record_action', {
      action: { kind: 'setValue', target: { role: 'textbox', name: 'Password' }, value: 'secret_sauce' },
    })
    await call('cua_record_action', { action: { kind: 'click', target: { role: 'button', name: 'Login' } } })
    await call('cua_record_stop', { recordingId: started.recordingId })
    await call('cua_record_release_browser')

    // Machine pace: replay resolves immediately after navigate.
    const replayed = await call('cua_replay_start', {
      recordingId: started.recordingId,
      launch: 'isolated',
      values: { [user.stepId]: 'standard_user', [pass.stepId]: 'secret_sauce' },
    })
    console.log('REPLAY', JSON.stringify({ status: replayed.status, stepCount: replayed.stepCount, failed: replayed.failedStepId }))
    assert.equal(replayed.status, 'completed', 'replay should wait out the render delay')
    console.log('OK settle window handled')
  } finally {
    await call('cua_record_release_browser').catch(() => undefined)
    for (const cleanup of cleanups) cleanup()
  }
}

await main().catch(error => {
  console.error(error)
  process.exit(1)
})
