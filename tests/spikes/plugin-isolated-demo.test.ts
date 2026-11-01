/**
 * End-to-end demo through the real plugin tools with a driver-owned browser.
 *
 * `launch: "isolated"` asks Cua to start a disposable Chromium, so the demo
 * needs no existing window, no Chrome login state and no TCC-granted browser.
 *
 * Run: pnpm exec tsx tests/spikes/plugin-isolated-demo.test.ts
 * (expects the fixture server on http://127.0.0.1:41777/)
 */
import assert from 'node:assert/strict'
import * as plugin from '../../src/plugin/index.js'

const DEMO_URL = process.env.DEMO_URL ?? 'http://127.0.0.1:41777/'

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
    callId: 'call_isolated_demo',
    signal: new AbortController().signal,
    agent: { id: 'agent_isolated_demo', session: { id: 'session_isolated_demo', header: { cwd: process.cwd() } } },
    deferContext() {},
    concludeTurn() {},
  }
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const tool = byName.get(name)
    assert.ok(tool !== undefined, `missing tool ${name}`)
    return await tool.execute(args, exec)
  }
  try {
    const binding = await call('cua_record_bind_browser', { launch: 'isolated' })
    console.log('BIND', JSON.stringify(binding))
    const { pid, windowId } = binding
    assert.ok(Number.isInteger(pid) && Number.isInteger(windowId), 'isolated bind returned no window')

    const started = await call('cua_record_start', { title: 'isolated demo' })
    await call('cua_record_action', { action: { kind: 'navigate', url: DEMO_URL } })
    const observed = await call('cua_record_observe')
    console.log('OBSERVE', JSON.stringify({ url: observed.url, elements: observed.elements?.length }))
    const typed = await call('cua_record_action', {
      action: { kind: 'setValue', target: { role: 'textbox', name: 'Name' }, value: 'Alice' },
    })
    assert.equal(typed.status, 'success')
    await call('cua_record_action', { action: { kind: 'click', target: { role: 'button', name: 'Submit' } } })

    const steps = await call('cua_record_query', { kind: 'steps', recordingId: started.recordingId })
    console.log('STEPS', steps.items.length, steps.items.map((step: any) => `${step.seq}:${step.actionKind}:${step.status}`))
    const stopped = await call('cua_record_stop', { recordingId: started.recordingId })
    console.log('STOPPED', stopped.descriptor.status)

    // 释放会结束这个 driver-owned 浏览器；回放再起一个新的隔离浏览器。
    await call('cua_record_release_browser')
    const replayed = await call('cua_replay_start', {
      recordingId: started.recordingId,
      launch: 'isolated',
      values: { [typed.stepId]: 'Alice' },
    })
    console.log('REPLAY', JSON.stringify({ status: replayed.status, stepCount: replayed.stepCount, runId: replayed.runId }))
    assert.equal(replayed.status, 'completed')

    const runs = await call('cua_record_query', { kind: 'runs', recordingId: started.recordingId })
    console.log('RUNS', runs.items.map((run: any) => `${run.runId}:${run.status}`))
    console.log('OK')
  } finally {
    await call('cua_record_release_browser').catch(() => undefined)
    for (const cleanup of cleanups) cleanup()
  }
}

await main().catch(error => {
  console.error(error)
  process.exit(1)
})
