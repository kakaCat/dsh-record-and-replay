/**
 * Live E2E for new-tab following, using the production CuaBrowserDriver.
 *
 * Run: pnpm exec tsx tests/spikes/cua-tab-follow-live.test.ts
 *
 * 1. Fixture: click <a target="_blank">, then assert the next observe lands on
 *    second.html and its refs are drivable.
 * 2. Bilibili: click "热门" on the homepage, then assert the next observe is
 *    the popular page (the exact flow that motivated the change).
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Observation } from '../../src/driver/api.js'
import type { SemanticTarget } from '../../src/core/api.js'
import { CuaBrowserDriver } from '../../src/cua/browser-driver.js'
import { McpTransport } from '../../src/cua/mcp-transport.js'
import { CuaDriverClient } from '../../src/cua/client.js'
import type { OperationContext } from '../../src/core/api.js'

function context(): OperationContext {
  return {
    principal: { sessionId: `tab-follow-live-${Date.now().toString(36)}`, agentId: 'spike' },
    callId: 'spike',
    origin: 'internal',
    signal: new AbortController().signal,
  }
}

function visibleText(observation: Observation): string {
  return observation.elements
    .flatMap(element => [element.name ?? '', element.value ?? ''])
    .join('\n')
}

async function observeUntil(
  driver: CuaBrowserDriver,
  binding: Parameters<CuaBrowserDriver['observe']>[0],
  ctx: OperationContext,
  predicate: (observation: Observation) => boolean,
  timeoutMs: number,
): Promise<Observation> {
  const deadline = Date.now() + timeoutMs
  let last: Observation | undefined
  while (Date.now() < deadline) {
    last = await driver.observe(binding, ctx)
    if (predicate(last)) return last
    await sleep(250)
  }
  return last ?? await driver.observe(binding, ctx)
}

function findTarget(observation: Observation, target: SemanticTarget): SemanticTarget | undefined {
  const found = observation.elements.find(element => {
    if (target.role !== undefined && element.role !== target.role) return false
    if (target.name !== undefined && element.name !== target.name) return false
    if (target.text !== undefined && !(element.name ?? '').includes(target.text)) return false
    return true
  })
  return found === undefined ? undefined : target
}

async function main(): Promise<void> {
  const fixtureDir = join(process.cwd(), 'tests/fixtures/tab-follow')
  const homeHtml = await readFile(join(fixtureDir, 'index.html'), 'utf8')
  const secondHtml = await readFile(join(fixtureDir, 'second.html'), 'utf8')
  const server = createServer((request, response) => {
    if (request.url === '/' || request.url?.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(homeHtml)
      return
    }
    if (request.url === '/second.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(secondHtml)
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
  if (address === null || typeof address === 'string') throw new Error('fixture server has no address')
  const fixtureUrl = `http://127.0.0.1:${address.port}/`

  const transport = await McpTransport.create()
  const client = await CuaDriverClient.connect(transport, { driverVersion: '0.38.0' })
  const driver = new CuaBrowserDriver(client)
  const ctx = context()
  const evidence: Record<string, unknown> = { generatedAt: new Date().toISOString(), fixtureUrl, driver: 'CuaBrowserDriver' }
  let binding: Awaited<ReturnType<CuaBrowserDriver['bind']>> | undefined
  try {
    binding = await driver.bind({ launch: 'isolated' }, ctx)
    evidence['bind'] = {
      pid: binding.pid,
      windowId: binding.windowId,
      targetId: binding.targetId,
      tabId: binding.tabId,
    }

    // --- Fixture: target=_blank must be followed ---------------------------
    await driver.execute(binding, { kind: 'navigate', url: fixtureUrl }, undefined, ctx)
    const home = await driver.observe(binding, ctx)
    const link: SemanticTarget = { role: 'link', name: 'open' }
    assert.ok(findTarget(home, link) !== undefined, `fixture link not found: ${visibleText(home)}`)
    const linkResolved = await driver.resolve(binding, link, home)
    const click = await driver.execute(binding, { kind: 'click', target: link }, linkResolved, ctx)
    evidence['fixture'] = { home: home.url, click }
    assert.match(click.summary ?? '', /followed active tab/, `fixture click did not follow: ${JSON.stringify(click)}`)

    const second = await driver.observe(binding, ctx)
    evidence['fixtureSecond'] = { url: second.url, title: second.title, text: visibleText(second) }
    assert.ok(second.url.endsWith('/second.html'), `fixture did not follow the new tab: ${second.url}`)
    assert.match(visibleText(second), /Second Action/, 'second page action is missing')

    // The followed tab's refs must drive actions, not just read.
    const button: SemanticTarget = { role: 'button', name: 'Second Action' }
    const buttonResolved = await driver.resolve(binding, button, second)
    await expectClick(driver, binding, button, buttonResolved, ctx)
    evidence['fixtureSecondAction'] = 'clicked'

    // --- Bilibili: the real "热门" flow -----------------------------------
    await driver.execute(binding, { kind: 'navigate', url: 'https://www.bilibili.com/' }, undefined, ctx)
    const biliHome = await observeUntil(
      driver,
      binding,
      ctx,
      observation => observation.elements.some(element => element.name?.includes('热门') === true),
      20_000,
    )
    const hot: SemanticTarget = { role: 'link', name: '热门' }
    assert.ok(findTarget(biliHome, hot) !== undefined, `bilibili 热门 link not found: ${visibleText(biliHome).slice(0, 1500)}`)
    const hotResolved = await driver.resolve(binding, hot, biliHome)
    const hotClick = await driver.execute(binding, { kind: 'click', target: hot }, hotResolved, ctx)
    evidence['bilibiliHome'] = { url: biliHome.url, title: biliHome.title }
    evidence['bilibiliClick'] = hotClick
    assert.match(hotClick.summary ?? '', /followed active tab/, `bilibili 热门 click did not follow: ${JSON.stringify(hotClick)}`)

    const popular = await observeUntil(
      driver,
      binding,
      ctx,
      observation => observation.url.includes('/v/popular') && /热门/.test(observation.title ?? ''),
      15_000,
    )
    evidence['bilibiliPopular'] = { url: popular.url, title: popular.title }
    assert.match(popular.url, /\/v\/popular/, `bilibili did not reach 热门: ${popular.url}`)
    assert.match(popular.title ?? '', /热门|popular/i, `bilibili 热门 title is missing: ${popular.title ?? ''}`)

    const evidencePath = join(process.cwd(), 'docs/spikes/2026-11-01-tab-follow/live-evidence.json')
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(JSON.stringify({ ok: true, evidencePath, ...evidence }, null, 2))
  } finally {
    if (binding !== undefined) await driver.release(binding).catch(() => undefined)
    await client.close().catch(() => undefined)
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
}

async function expectClick(
  driver: CuaBrowserDriver,
  binding: Parameters<CuaBrowserDriver['observe']>[0],
  target: SemanticTarget,
  resolved: Awaited<ReturnType<CuaBrowserDriver['resolve']>>,
  ctx: OperationContext,
): Promise<void> {
  await driver.execute(binding, { kind: 'click', target }, resolved, ctx)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
