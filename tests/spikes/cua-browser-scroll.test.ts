/**
 * Live E2E for browser scrolling, using the production CuaBrowserDriver.
 *
 * Run: pnpm exec tsx tests/spikes/cua-browser-scroll.test.ts
 *
 * Proves, against a local long page in a driver-owned isolated Chromium:
 * 1. `scroll` with a target resolves the ref and sends `browser_pointer
 *    { action: "scroll", ref, delta_x, delta_y }`, bringing the offscreen
 *    bottom button into view;
 * 2. `scroll` without a target aims at the measured viewport centre: scrolling
 *    up returns to the top input, and scrolling down reaches the page bottom
 *    (asserted through the semantic `visibility` of the fixture controls);
 * 3. `key` is refused with ACTION_UNSUPPORTED because Cua 0.38 exposes no
 *    browser-scoped key tool (the catalog check is recorded as evidence), and
 *    `browser_type` keystrokes types literal text rather than pressing a key.
 *
 * The spike launches its own browser through `bind({ launch: "isolated" })`, so
 * it does not need an existing-profile grant and never steals the user's focus.
 * It owns its HTTP fixture and never touches `.dsh/` recordings.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { JsonObject, OperationContext } from '../../src/core/api.js'
import type { Observation } from '../../src/driver/api.js'
import { CuaBrowserDriver } from '../../src/cua/browser-driver.js'
import { CuaDriverClient } from '../../src/cua/client.js'
import { McpTransport } from '../../src/cua/mcp-transport.js'

/** `--direct` keeps the runtime inside this process; no existing-profile grant is needed. */
const MCP_ARGS = (process.env.CUA_MCP_ARGS ?? 'mcp --direct').split(/\s+/u)

interface ToolResult {
  readonly isError?: boolean
  readonly structuredContent?: unknown
  readonly content?: ReadonlyArray<{ type?: string; text?: string }>
}

function toolData(result: ToolResult): JsonObject {
  if (result.isError === true) {
    throw new Error(`Cua tool returned isError: ${JSON.stringify(result).slice(0, 1_200)}`)
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent as JsonObject
  }
  const text = result.content?.find(part => part.type === 'text')?.text
  if (text !== undefined) {
    try {
      return JSON.parse(text) as JsonObject
    } catch {
      return { text }
    }
  }
  return {}
}

async function startFixtureServer(html: string): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    if (request.url === '/' || request.url?.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
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
  if (address === null || typeof address === 'string') {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    throw new Error('fixture server has no TCP address')
  }
  return { server, url: `http://127.0.0.1:${String(address.port)}/` }
}

function findButton(observation: Observation, name: string) {
  return observation.elements.find(element => element.role === 'button' && element.name === name)
}

function findTextbox(observation: Observation, name: string) {
  return observation.elements.find(element => element.role === 'textbox' && element.name === name)
}

/** A scroll settles a beat after the Cua call returns; poll the semantic snapshot. */
async function observeUntil(
  driver: CuaBrowserDriver,
  binding: Parameters<CuaBrowserDriver['observe']>[0],
  context: OperationContext,
  predicate: (observation: Observation) => boolean,
  timeoutMs = 5_000,
): Promise<Observation> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const observation = await driver.observe(binding, context)
    if (predicate(observation)) return observation
    if (Date.now() >= deadline) return observation
    await sleep(200)
  }
}

async function main(): Promise<void> {
  const fixtureHtml = await readFile(join(process.cwd(), 'tests/fixtures/scroll-page/index.html'), 'utf8')
  const fixture = await startFixtureServer(fixtureHtml)
  let client: CuaDriverClient | undefined
  let driver: CuaBrowserDriver | undefined
  let binding: Awaited<ReturnType<CuaBrowserDriver['bind']>> | undefined

  const context: OperationContext = {
    principal: { sessionId: `scroll-live-${Date.now().toString(36)}`, agentId: 'spike' },
    callId: 'spike-scroll',
    origin: 'internal',
    signal: new AbortController().signal,
  }

  try {
    const transport = await McpTransport.create({ args: MCP_ARGS })
    client = await CuaDriverClient.connect(transport, { driverVersion: '0.38.0' })
    driver = new CuaBrowserDriver(client)

    binding = await driver.bind({ launch: 'isolated' }, context)
    await driver.execute(binding, { kind: 'navigate', url: fixture.url }, undefined, context)

    const before = await driver.observe(binding, context)
    const bottomBefore = findButton(before, 'Bottom action')
    assert.ok(bottomBefore !== undefined, 'the fixture bottom button is missing from the snapshot')
    assert.notEqual(bottomBefore.visibility, 'in_viewport', 'the bottom button should start offscreen')

    // 1. Targeted scroll: resolve the offscreen button, then scroll at its ref.
    const target = { role: 'button', name: 'Bottom action' } as const
    const resolved = await driver.resolve(binding, target, before)
    const targeted = await driver.execute(
      binding,
      { kind: 'scroll', target, deltaX: 0, deltaY: 900 },
      resolved,
      context,
    )
    assert.equal(targeted.status, 'ok')
    const afterTargeted = await observeUntil(
      driver,
      binding,
      context,
      observation => findButton(observation, 'Bottom action')?.visibility === 'in_viewport',
    )
    const bottomAfterTargeted = findButton(afterTargeted, 'Bottom action')
    assert.equal(bottomAfterTargeted?.visibility, 'in_viewport', 'targeted scroll did not bring the button into view')

    // 2a. No-target scroll back to the top: the top input must become visible.
    let upSteps = 0
    let topObservation = await driver.observe(binding, context)
    while (findTextbox(topObservation, 'Name')?.visibility !== 'in_viewport' && upSteps < 12) {
      await driver.execute(binding, { kind: 'scroll', deltaX: 0, deltaY: -700 }, undefined, context)
      upSteps += 1
      topObservation = await observeUntil(
        driver,
        binding,
        context,
        observation => findTextbox(observation, 'Name')?.visibility === 'in_viewport',
        1_000,
      )
    }
    assert.equal(findTextbox(topObservation, 'Name')?.visibility, 'in_viewport', 'no-target scroll could not return to the top')
    assert.notEqual(
      findButton(topObservation, 'Bottom action')?.visibility,
      'in_viewport',
      'the bottom button should be out of view at the top',
    )

    // 2b. No-target scroll down until the bottom marker is visible.
    let downSteps = 0
    let atBottomObservation = topObservation
    while (findButton(atBottomObservation, 'Bottom action')?.visibility !== 'in_viewport' && downSteps < 16) {
      await driver.execute(binding, { kind: 'scroll', deltaX: 0, deltaY: 700 }, undefined, context)
      downSteps += 1
      atBottomObservation = await observeUntil(
        driver,
        binding,
        context,
        observation => findButton(observation, 'Bottom action')?.visibility === 'in_viewport',
        1_000,
      )
    }
    const bottomAtEnd = findButton(atBottomObservation, 'Bottom action')
    const reachedBottom = bottomAtEnd?.visibility === 'in_viewport'
    assert.ok(reachedBottom, `no-target scroll did not reach the bottom after ${String(downSteps)} steps`)

    // 3. Key: no browser-scoped tool exists, so the action must stay unsupported.
    const keyTools = client.tools.filter(name => name.includes('key'))
    assert.equal(
      keyTools.filter(name => name.startsWith('browser_')).length,
      0,
      `Cua unexpectedly exposes a browser key tool: ${keyTools.join(', ')}`,
    )
    let keyErrorCode: string | undefined
    try {
      await driver.execute(binding, { kind: 'key', key: 'Enter' }, undefined, context)
    } catch (error) {
      keyErrorCode = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined
    }
    assert.equal(keyErrorCode, 'ACTION_UNSUPPORTED', 'browser key should stay ACTION_UNSUPPORTED')

    // Record what Cua's closest route actually does: it types the letters.
    // Return to the top and take a fresh snapshot before typing.
    let restoreSteps = 0
    topObservation = await driver.observe(binding, context)
    while (findTextbox(topObservation, 'Name')?.visibility !== 'in_viewport' && restoreSteps < 12) {
      await driver.execute(binding, { kind: 'scroll', deltaX: 0, deltaY: -700 }, undefined, context)
      restoreSteps += 1
      topObservation = await observeUntil(
        driver,
        binding,
        context,
        observation => findTextbox(observation, 'Name')?.visibility === 'in_viewport',
        1_000,
      )
    }
    const nameRef = findTextbox(topObservation, 'Name')?.ref
    assert.ok(nameRef !== undefined, 'the fixture name field is missing from the snapshot')
    const typed = toolData(await client.callTool('browser_type', {
      session: `dsh-record-replay-${context.principal.sessionId}`,
      target_id: binding.targetId,
      tab_id: binding.tabId,
      ref: nameRef,
      text: 'Enter',
      mode: 'keystrokes',
    }, context) as ToolResult)
    assert.notEqual(typed['status'], 'refused', `browser_type refused: ${JSON.stringify(typed).slice(0, 1_000)}`)
    const typedObservation = await driver.observe(binding, context)
    const typedValue = findTextbox(typedObservation, 'Name')?.value
    assert.equal(typedValue, 'Enter', 'browser_type keystrokes did not type literal text')

    const health = toolData(await client.callTool('health_report', {}, context) as ToolResult)
    const build = health['build'] as JsonObject | undefined
    const cuaVersion = typeof build?.['version'] === 'string' ? build['version'] : 'unknown'

    const evidence = {
      generatedAt: new Date().toISOString(),
      cuaVersion,
      mcpArgs: MCP_ARGS,
      fixtureUrl: fixture.url,
      session: context.principal.sessionId,
      launch: 'isolated',
      binding: {
        pid: binding.pid,
        windowId: binding.windowId,
        targetId: binding.targetId,
        tabId: binding.tabId,
        generation: binding.generation,
      },
      scroll: {
        targeted: {
          ref: resolved.ref,
          deltaY: 900,
          bottomVisibilityBefore: bottomBefore.visibility ?? 'unknown',
          bottomVisibilityAfter: bottomAfterTargeted?.visibility ?? 'unknown',
        },
        noTarget: {
          upSteps,
          downSteps,
          restoreSteps,
          bottomVisibilityAtEnd: bottomAtEnd?.visibility ?? 'unknown',
          reachedBottom,
        },
      },
      key: {
        browserKeyTools: keyTools,
        driverErrorCode: keyErrorCode,
        browserTypeKeystrokes: {
          typedValue,
          conclusion: 'browser_type keystrokes types literal text; it is not a key-press route',
        },
      },
    }
    const evidenceDir = join(process.cwd(), 'docs/spikes/2026-11-01-browser-scroll')
    await mkdir(evidenceDir, { recursive: true })
    const evidencePath = join(evidenceDir, 'evidence.json')
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

    console.log(JSON.stringify({
      status: 'pass',
      cuaVersion,
      scroll: evidence.scroll,
      key: evidence.key,
      evidencePath: relative(process.cwd(), evidencePath),
    }, null, 2))
  } finally {
    if (driver !== undefined && binding !== undefined) await driver.release(binding).catch(() => undefined)
    if (client !== undefined) await client.close().catch(() => undefined)
    await new Promise<void>(resolveClose => fixture.server.close(() => resolveClose()))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
