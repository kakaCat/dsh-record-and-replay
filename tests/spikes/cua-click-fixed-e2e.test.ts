/**
 * End-to-end acceptance for the verified click: drive SauceDemo's login through
 * the real CuaBrowserDriver (not the raw Cua tools) ten times in a row.
 *
 * The Chrome password-leak bubble appears after the first successful sign-in
 * and blocks trusted mouse input for the rest of the session; the driver's
 * effect check + synthetic DOM fallback is what keeps the flow working.
 *
 * Usage: tsx tests/spikes/cua-click-fixed-e2e.test.ts [--runs=10]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { JsonObject, OperationContext, SemanticTarget } from '../../src/core/api.js'
import { CuaBrowserDriver } from '../../src/cua/browser-driver.js'
import type { CuaToolCaller } from '../../src/cua/bindings.js'
import { normalizeToolResult } from '../../src/cua/transport.js'

const SAUCEDEMO = 'https://www.saucedemo.com/'
const USERNAME: SemanticTarget = { role: 'textbox', name: 'Username' }
const PASSWORD: SemanticTarget = { role: 'textbox', name: 'Password' }
const LOGIN: SemanticTarget = { role: 'button', name: 'Login' }

function context(): OperationContext {
  return {
    principal: { sessionId: `click-e2e-${Date.now().toString(36)}`, agentId: 'spike' },
    callId: 'click-e2e',
    origin: 'agent',
    signal: new AbortController().signal,
  }
}

/** Poll like the replay runner does: a freshly navigated page renders late. */
async function waitForTarget(
  driver: CuaBrowserDriver,
  binding: Awaited<ReturnType<CuaBrowserDriver['bind']>>,
  target: SemanticTarget,
  ctx: OperationContext,
) {
  const deadline = Date.now() + 20_000
  for (;;) {
    const observation = await driver.observe(binding, ctx)
    try {
      return await driver.resolve(binding, target, observation)
    } catch (error) {
      if (Date.now() >= deadline) throw error
    }
    await sleep(250)
  }
}

async function main(): Promise<void> {
  const runsArg = process.argv.find(arg => arg.startsWith('--runs='))
  const runs = runsArg === undefined ? 10 : Number(runsArg.slice(7))
  const workspace = resolve(process.cwd())
  const outDir = join(workspace, 'test-results/cua-evidence')
  await mkdir(outDir, { recursive: true })

  const client = new Client({ name: 'dsh-click-fixed-e2e', version: '0.1.0' })
  await client.connect(new StdioClientTransport({ command: 'cua-driver', args: ['mcp'], stderr: 'ignore' }))
  const caller: CuaToolCaller = {
    async callTool(name: string, args: JsonObject, ctx: OperationContext) {
      void ctx
      return normalizeToolResult(await client.callTool({ name, arguments: args }))
    },
  }
  const driver = new CuaBrowserDriver(caller, undefined, {
    clickConfirmTimeoutMs: 1_200,
    clickConfirmIntervalMs: 250,
  })
  const ctx = context()
  const results: JsonObject[] = []
  try {
    const binding = await driver.bind({ launch: 'isolated' }, ctx)
    console.log('bound isolated browser', binding.pid, binding.windowId)
    for (let iteration = 1; iteration <= runs; iteration += 1) {
      const started = Date.now()
      const steps: string[] = []
      try {
        await driver.execute(binding, { kind: 'navigate', url: SAUCEDEMO }, undefined, ctx)
        for (const [target, value] of [[USERNAME, 'standard_user'], [PASSWORD, 'secret_sauce']] as const) {
          const resolved = await waitForTarget(driver, binding, target, ctx)
          await driver.execute(binding, { kind: 'setValue', target, value }, resolved, ctx)
        }
        const resolved = await waitForTarget(driver, binding, LOGIN, ctx)
        const action = await driver.execute(binding, { kind: 'click', target: LOGIN }, resolved, ctx)
        if (action.summary !== undefined) steps.push(action.summary)
        const after = await driver.observe(binding, ctx)
        const landed = after.url.includes('inventory')
        results.push({ iteration, landed, url: after.url, ms: Date.now() - started, steps })
        console.log(JSON.stringify({ iteration, landed, url: after.url, ms: Date.now() - started, summary: action.summary ?? null }))
      } catch (error) {
        results.push({
          iteration,
          landed: false,
          error: error instanceof Error ? `${String((error as { code?: unknown }).code ?? '')} ${error.message}` : String(error),
          ms: Date.now() - started,
        })
        console.log(JSON.stringify({ iteration, landed: false, error: error instanceof Error ? error.message : String(error) }))
      }
    }
    await driver.release(binding)
  } finally {
    await client.close().catch(() => undefined)
  }

  const summary = {
    runs,
    landed: results.filter(row => row['landed'] === true).length,
    fallbacks: results.filter(row => Array.isArray(row['steps']) && (row['steps'] as string[]).some(step => step.includes('synthetic DOM click'))).length,
    failures: results.filter(row => row['landed'] !== true),
  }
  const path = join(outDir, 'click-fixed-e2e.json')
  await writeFile(path, `${JSON.stringify({ summary, results }, null, 2)}\n`)
  console.log(JSON.stringify({ summary, path }, null, 2))
}

await main()
