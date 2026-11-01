import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  CUA_REQUIRED_BROWSER_TOOLS,
  evaluateCuaCapabilities,
} from '../../src/cua/capabilities.js'

type JsonObject = Record<string, unknown>
type WaitOptions = { timeoutMs?: number; intervalMs?: number }

const CHROME_PATH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  '--window-size=1200,800',
  '--window-position=40,40',
]

interface ChromeHandle {
  child: ChildProcess
  pid: number
  debugPort: number
  profileDir: string
  stderr: string[]
}

interface ToolResult {
  isError?: boolean
  structuredContent?: unknown
  content?: Array<{ type?: string; text?: string }>
}

function toolData(result: unknown): JsonObject {
  const r = result as ToolResult
  if (r.isError === true) {
    throw new Error(`Cua tool returned isError: ${JSON.stringify(result).slice(0, 1200)}`)
  }
  if (r.structuredContent !== undefined && r.structuredContent !== null) {
    return r.structuredContent as JsonObject
  }
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

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, options: WaitOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const intervalMs = options.intervalMs ?? 250
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

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('failed to allocate a free port'))
        return
      }
      const port = address.port
      server.close(error => (error === undefined ? resolvePort(port) : reject(error)))
    })
  })
}

async function startFixtureServer(html: string): Promise<{ server: Server; url: string }> {
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
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

async function waitForCdp(debugPort: number): Promise<JsonObject> {
  return await waitFor(`Chrome CDP on ${debugPort}`, async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
    if (!response.ok) return undefined
    return (await response.json()) as JsonObject
  })
}

async function launchChrome(): Promise<ChromeHandle> {
  const debugPort = await freePort()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-cua-spike-chrome-'))
  const stderr: string[] = []
  const child = spawn(
    CHROME_PATH,
    [...CHROME_ARGS, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' },
  )
  child.stderr?.on('data', chunk => {
    stderr.push(String(chunk))
    if (stderr.length > 100) stderr.shift()
  })
  if (child.pid === undefined) throw new Error('Chrome did not expose a pid')
  try {
    await waitForCdp(debugPort)
  } catch (error) {
    child.kill('SIGTERM')
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return { child, pid: child.pid, debugPort, profileDir, stderr }
}

function chromeWindow(windows: unknown, pid: number): JsonObject {
  const rows = Array.isArray((windows as JsonObject).windows) ? ((windows as JsonObject).windows as JsonObject[]) : []
  const candidates = rows
    .filter(window => window.pid === pid && window.layer === 0 && Number((window.bounds as JsonObject | undefined)?.width ?? 0) >= 500)
    .sort((a, b) => {
      const area = (window: JsonObject): number => {
        const bounds = window.bounds as JsonObject | undefined
        return Number(bounds?.width ?? 0) * Number(bounds?.height ?? 0)
      }
      return area(b) - area(a)
    })
  const exact = candidates.find(window => window.is_on_screen === true) ?? candidates[0]
  if (exact === undefined) {
    throw new Error(`no layer-0 Chrome window found for pid ${pid}: ${JSON.stringify(rows.filter(w => w.pid === pid))}`)
  }
  return exact
}

function findBase64Image(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || typeof value !== 'object') return undefined
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /screenshot|image|png|data/i.test(key) && child.length > 200) {
      return child
    }
    if (typeof child === 'object') {
      const found = findBase64Image(child, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function imageFromToolResult(result: unknown): string | undefined {
  const r = result as ToolResult & { content?: Array<{ type?: string; data?: string; mimeType?: string; text?: string }> }
  for (const part of r.content ?? []) {
    if (part.type === 'image' && typeof part.data === 'string' && part.data.length > 200) return part.data
    if (part.type === 'text' && part.text?.startsWith('data:image/')) {
      const comma = part.text.indexOf(',')
      if (comma > 0) return part.text.slice(comma + 1)
    }
  }
  return findBase64Image(toolData(result))
}

function pngInfo(buffer: Buffer): { width: number; height: number; sha256: string } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.ok(buffer.subarray(0, 8).equals(signature), 'screenshot is not a PNG')
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  assert.ok(width > 0 && height > 0, `invalid PNG dimensions ${width}x${height}`)
  return { width, height, sha256: createHash('sha256').update(buffer).digest('hex') }
}

async function connectCua(): Promise<Client> {
  const transport = new StdioClientTransport({ command: 'cua-driver', args: ['mcp'], stderr: 'ignore' })
  const client = new Client({ name: 'dsh-record-replay-m0', version: '0.1.0' })
  await client.connect(transport)
  return client
}

async function openNewTab(debugPort: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })
  if (!response.ok) throw new Error(`failed to create Chrome tab: HTTP ${response.status}`)
  const json = (await response.json()) as JsonObject
  const tabId = json.id
  if (typeof tabId !== 'string' || tabId.length === 0) throw new Error('new Chrome tab response has no id')
  await fetch(`http://127.0.0.1:${debugPort}/json/activate/${tabId}`)
  return tabId
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd())
  const evidenceDir = join(workspace, 'test-results/cua-evidence')
  await mkdir(evidenceDir, { recursive: true })
  const html = await readFile(join(workspace, 'tests/fixtures/browser-app/index.html'), 'utf8')
  const fixture = await startFixtureServer(html)
  let chrome: ChromeHandle | undefined
  let cua: Client | undefined
  const calls: string[] = []
  const session = `dsh-m0-${Date.now().toString(36)}`

  try {
    chrome = await launchChrome()
    cua = await connectCua()
    const invoke = async (name: string, args: JsonObject): Promise<JsonObject> => {
      calls.push(name)
      return toolData(await cua!.callTool({ name, arguments: args }))
    }

    const listed = await cua.listTools()
    const toolNames = listed.tools.map(tool => tool.name)
    const health = await invoke('health_report', {})
    const build = health.build as JsonObject | undefined
    const version = typeof build?.version === 'string'
      ? build.version
      : /cua-driver\s+([0-9]+\.[0-9]+\.[0-9]+)/.exec(JSON.stringify(health))?.[1]
    const healthOverall = typeof health.overall === 'string' ? health.overall : 'unknown'
    const capability = evaluateCuaCapabilities({
      toolNames,
      ...(version === undefined ? {} : { driverVersion: version }),
    })
    assert.equal(capability.browserAutomation, true, `missing required Cua tools: ${capability.missingRequiredTools.join(', ')}`)
    assert.equal(capability.versionSupported, true, `unsupported Cua version: ${String(version)}`)
    for (const tool of CUA_REQUIRED_BROWSER_TOOLS) assert.ok(toolNames.includes(tool), `missing tool ${tool}`)

    await invoke('start_session', { session, capture_scope: 'window' })
    const windows = await invoke('list_windows', {})
    const window = chromeWindow(windows, chrome.pid)
    const windowId = Number(window.window_id)
    assert.ok(Number.isInteger(windowId) && windowId > 0, `invalid window_id: ${String(window.window_id)}`)

    let binding = await invoke('get_browser_state', {
      pid: chrome.pid,
      window_id: windowId,
      session,
      snapshot_format: 'semantic_v2',
    })
    let bindingPrepared = false
    let prepareTrace: JsonObject | null = null
    if (binding.status === 'refused') {
      const nextCall = binding.next_call as JsonObject | undefined
      if (nextCall?.tool === 'browser_prepare' && nextCall.arguments !== undefined) {
        const args = nextCall.arguments as JsonObject
        const strategy = args.strategy as JsonObject | undefined
        assert.equal(Number(args.pid), chrome.pid, 'browser_prepare pid does not match the isolated Chrome')
        assert.equal(Number(args.window_id), windowId, 'browser_prepare window_id does not match the bound window')
        assert.equal(args.session, session, 'browser_prepare session does not match')
        assert.equal(strategy?.kind, 'existing_profile', 'unexpected browser_prepare strategy')
        assert.notEqual(args.allow_launch, true, 'refusing browser_prepare that may launch another browser')
        assert.equal(args.approval_token, undefined, 'refusing token-bearing browser_prepare')
        const prepared = await invoke('browser_prepare', args)
        assert.equal(prepared.status, 'ok', `browser_prepare refused: ${JSON.stringify(prepared).slice(0, 2_000)}`)
        bindingPrepared = true
        prepareTrace = { invoked: true, args, resultStatus: prepared.status }
        binding = await invoke('get_browser_state', {
          pid: chrome.pid,
          window_id: windowId,
          session,
          snapshot_format: 'semantic_v2',
        })
      }
    }
    if (binding.binding_quality !== 'exact') {
      console.error('BINDING_RESULT', JSON.stringify(binding).slice(0, 4_000))
      console.error('CHROME_WINDOW', JSON.stringify(window).slice(0, 1_000))
    }
    assert.equal(binding.binding_quality, 'exact', `binding_quality=${String(binding.binding_quality)}`)
    assert.equal(binding.status, 'ok')
    const targetId = String(binding.target_id)
    const tabs = Array.isArray(binding.tabs) ? (binding.tabs as JsonObject[]) : []
    assert.ok(tabs.length > 0, 'binding returned no tabs')
    const firstTabId = String(tabs[0]?.tab_id)
    const priorTabIds = new Set(tabs.map(tab => String(tab.tab_id)))
    assert.ok(targetId.startsWith('bt-'), `unexpected target id: ${targetId}`)
    assert.ok(firstTabId.startsWith('tab-'), `unexpected tab id: ${firstTabId}`)

    const navResult = await invoke('browser_navigate', { session, target_id: targetId, tab_id: firstTabId, url: fixture.url })
    assert.equal(navResult.status, 'ok', `first navigation failed: ${JSON.stringify(navResult).slice(0, 1_000)}`)
    assert.equal(navResult.url, fixture.url)
    const navigationStatus = String(navResult.status)
    const firstSnapshot = await invoke('get_browser_state', {
      session,
      target_id: targetId,
      tab_id: firstTabId,
      snapshot_format: 'semantic_v2',
    })
    const refs = Array.isArray(firstSnapshot.refs) ? (firstSnapshot.refs as JsonObject[]) : []
    const inputRef = refs.find(ref => ref.role === 'textbox')?.ref
    const buttonRef = refs.find(ref => ref.role === 'button')?.ref
    assert.equal(typeof inputRef, 'string', 'fixture input textbox not found')
    assert.equal(typeof buttonRef, 'string', 'fixture submit button not found')

    const typeResult = await invoke('browser_type', {
      session,
      target_id: targetId,
      tab_id: firstTabId,
      ref: inputRef,
      text: 'Cua M0',
      replace: true,
    })
    const typeDelivery = typeResult.delivery as JsonObject | undefined
    assert.equal(typeResult.route, 'trusted_input', `browser_type used unexpected route: ${JSON.stringify(typeResult).slice(0, 1_000)}`)
    assert.equal(Number(typeDelivery?.delivered_count), 'Cua M0'.length, `unexpected delivered_count: ${JSON.stringify(typeResult).slice(0, 1_000)}`)
    const clickResult = await invoke('browser_click', {
      session,
      target_id: targetId,
      tab_id: firstTabId,
      ref: buttonRef,
      input_route: 'trusted',
    })
    assert.notEqual(clickResult.status, 'refused', `browser_click refused: ${JSON.stringify(clickResult).slice(0, 1_000)}`)
    const verified = await invoke('get_browser_state', {
      session,
      target_id: targetId,
      tab_id: firstTabId,
      snapshot_format: 'semantic_v2',
      query: 'Submitted',
    })
    const verifiedOutline = typeof verified.outline === 'string' ? verified.outline : JSON.stringify(verified)
    assert.match(verifiedOutline, /Submitted:/, 'click did not update the fixture result')
    assert.match(verifiedOutline, /Cua M0/, 'typed text was not reflected in fixture result')
    const inputClickVerified = verifiedOutline.includes('Submitted:') && verifiedOutline.includes('Cua M0')

    calls.push('get_browser_state')
    const firstShotRaw = await cua.callTool({
      name: 'get_browser_state',
      arguments: {
        session,
        target_id: targetId,
        tab_id: firstTabId,
        snapshot_format: 'semantic_v2',
        include_screenshot: true,
      },
    })
    const firstShot = toolData(firstShotRaw)
    const firstPng = imageFromToolResult(firstShotRaw)
    if (firstPng === undefined) console.error('SCREENSHOT_RESULT', JSON.stringify(firstShotRaw).slice(0, 5_000))
    assert.ok(firstPng !== undefined && firstPng.length > 512, 'Cua did not return a usable tab screenshot')
    const firstBuffer = Buffer.from(firstPng, 'base64')
    const firstPngInfo = pngInfo(firstBuffer)
    const firstMeta = firstShot.screenshot as JsonObject | undefined
    assert.equal(firstPngInfo.width, 1200, `unexpected first screenshot width ${firstPngInfo.width}`)
    assert.ok(firstPngInfo.height >= 600, `unexpected first screenshot height ${firstPngInfo.height}`)
    assert.equal(Number(firstMeta?.width), firstPngInfo.width)
    assert.equal(Number(firstMeta?.height), firstPngInfo.height)

    const newChromeTab = await openNewTab(chrome.debugPort)
    const rebound = await invoke('get_browser_state', {
      pid: chrome.pid,
      window_id: windowId,
      session,
      snapshot_format: 'semantic_v2',
    })
    assert.equal(rebound.binding_quality, 'exact', 'tab rebind lost exact binding')
    const reboundTabs = Array.isArray(rebound.tabs) ? (rebound.tabs as JsonObject[]) : []
    assert.ok(reboundTabs.length >= 2, `expected at least two tabs after opening one, saw ${reboundTabs.length}`)
    const secondTab = reboundTabs.find(tab => !priorTabIds.has(String(tab.tab_id)))
    assert.ok(secondTab !== undefined, 'new tab was not exposed by Cua')
    const secondTabId = String(secondTab.tab_id)
    assert.notEqual(secondTabId, firstTabId)
    assert.ok(newChromeTab.length > 0, 'CDP did not return a new tab target id')

    await invoke('browser_navigate', { session, target_id: rebound.target_id, tab_id: secondTabId, url: `${fixture.url}?tab=2` })
    const secondSnapshot = await invoke('get_browser_state', {
      session,
      target_id: rebound.target_id,
      tab_id: secondTabId,
      snapshot_format: 'semantic_v2',
    })
    const secondTabVerified = JSON.stringify(secondSnapshot.page ?? '').includes('tab=2')
    assert.ok(secondTabVerified, 'second tab URL was not observed')
    calls.push('get_browser_state')
    const secondShotRaw = await cua.callTool({
      name: 'get_browser_state',
      arguments: {
        session,
        target_id: rebound.target_id,
        tab_id: secondTabId,
        snapshot_format: 'semantic_v2',
        include_screenshot: true,
      },
    })
    const secondPng = imageFromToolResult(secondShotRaw)
    if (secondPng === undefined) console.error('SECOND_SCREENSHOT_RESULT', JSON.stringify(secondShotRaw).slice(0, 5_000))
    assert.ok(secondPng !== undefined && secondPng.length > 512, 'second tab has no screenshot')
    const screenshotBuffer = Buffer.from(secondPng, 'base64')
    const secondPngInfo = pngInfo(screenshotBuffer)
    const secondShot = toolData(secondShotRaw)
    const secondMeta = secondShot.screenshot as JsonObject | undefined
    assert.equal(secondPngInfo.width, 1200, `unexpected second screenshot width ${secondPngInfo.width}`)
    assert.ok(secondPngInfo.height >= 600, `unexpected second screenshot height ${secondPngInfo.height}`)
    assert.equal(Number(secondMeta?.width), secondPngInfo.width)
    assert.equal(Number(secondMeta?.height), secondPngInfo.height)
    assert.equal(secondMeta?.mime_type, 'image/png')

    const firstScreenshotPath = join(evidenceDir, 'm0-cua-first-tab.png')
    await writeFile(firstScreenshotPath, firstBuffer)
    const screenshotPath = join(evidenceDir, 'm0-cua-second-tab.png')
    await writeFile(screenshotPath, screenshotBuffer)
    const toolsPath = join(evidenceDir, 'm0-cua-tools.json')
    await writeFile(toolsPath, `${JSON.stringify(toolNames, null, 2)}\n`)
    const callsPath = join(evidenceDir, 'm0-cua-calls.json')
    await writeFile(callsPath, `${JSON.stringify(calls, null, 2)}\n`)
    const screenshotRelative = relative(workspace, screenshotPath)
    const firstScreenshotRelative = relative(workspace, firstScreenshotPath)
    const toolsRelative = relative(workspace, toolsPath)
    const callsRelative = relative(workspace, callsPath)
    const evidenceRelative = relative(workspace, join(evidenceDir, 'm0-cua-binding.json'))
    const summaryRelative = relative(workspace, join(workspace, 'test-results/cua-evidence/m0-evidence.md'))
    const runLogRelative = relative(workspace, join(evidenceDir, 'm0-cua-run.log'))
    const exitCodeRelative = relative(workspace, join(evidenceDir, 'm0-cua-exit.txt'))
    const dshBrowserCalls = calls.filter(name => name.startsWith('dsh_browser_')).length
    assert.equal(dshBrowserCalls, 0, 'spike unexpectedly invoked dsh_browser tools')

    const evidence = {
      generatedAt: new Date().toISOString(),
      transport: capability.transport,
      transportLifetime: 'persistent-mcp-connection',
      driverVersion: capability.driverVersion,
      healthOverall,
      toolCount: capability.toolCount,
      toolsPath: toolsRelative,
      callsPath: callsRelative,
      requiredTools: [...CUA_REQUIRED_BROWSER_TOOLS],
      capability,
      session,
      chromePid: chrome.pid,
      chromeVersion: (await waitForCdp(chrome.debugPort)).Browser,
      windowId,
      bindingQuality: binding.binding_quality,
      bindingRoute: binding.binding_route,
      bindingPreparation: bindingPrepared ? 'browser_prepare:existing_profile' : 'endpoint_already_prepared',
      prepareTrace,
      targetId,
      firstTabId,
      secondTabId,
      tabCountBefore: tabs.length,
      tabCountAfter: reboundTabs.length,
      navigation: navigationStatus,
      inputClickVerified,
      tabRebindVerified: secondTabVerified,
      versionSupported: capability.versionSupported,
      screenshots: [
        {
          path: firstScreenshotRelative,
          width: firstPngInfo.width,
          height: firstPngInfo.height,
          sha256: firstPngInfo.sha256,
          cuaMetadata: firstMeta ?? null,
        },
        {
          path: screenshotRelative,
          width: secondPngInfo.width,
          height: secondPngInfo.height,
          sha256: secondPngInfo.sha256,
          cuaMetadata: secondMeta ?? null,
        },
      ],
      dshBrowserCalls,
      observedFindings: {
        transportLifetime: 'persistent-mcp-connection',
        bindingWasRefusedBeforePrepare: bindingPrepared,
        tabsAdded: reboundTabs.length - tabs.length,
        versionSupported: capability.versionSupported,
      },
      runLogPath: runLogRelative,
      exitCodePath: exitCodeRelative,
    }
    const evidencePath = join(evidenceDir, 'm0-cua-binding.json')
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    const summaryPath = join(workspace, 'test-results/cua-evidence/m0-evidence.md')
    await writeFile(summaryPath, [
      '# M0 Cua 浏览器绑定验证证据',
      '',
      `- 验证时间：${evidence.generatedAt}`,
      `- Cua Driver：${capability.driverVersion ?? 'unknown'}（MCP 持久连接）`,
      `- 健康状态：${healthOverall}`,
      `- 工具数：${capability.toolCount}；缺失必需工具：${capability.missingRequiredTools.length}`,
      `- 工具目录：${toolsRelative}`,
      `- 调用记录：${callsRelative}`,
      `- Chrome：${String(evidence.chromeVersion)}；PID ${chrome.pid}`,
      `- Binding：${String(binding.binding_quality)} / ${String(binding.binding_route)}`,
      `- 绑定前置：${String(evidence.bindingPreparation)}`,
      `- Target：${targetId}`,
      `- Tabs：${firstTabId} → ${secondTabId}（${tabs.length} → ${reboundTabs.length}）`,
      '- 已通过：导航、语义快照、输入、点击、结果读回、截图、Tab 重绑',
      `- dsh_browser_ 调用：${dshBrowserCalls}`,
      `- 第一 Tab 截图：${firstScreenshotRelative}（${firstPngInfo.width}x${firstPngInfo.height}，sha256 ${firstPngInfo.sha256}）`,
      `- 第二 Tab 截图：${screenshotRelative}（${secondPngInfo.width}x${secondPngInfo.height}，sha256 ${secondPngInfo.sha256}）`,
      `- JSON 证据：${evidenceRelative}`,
      `- 运行日志：${runLogRelative}`,
      `- 退出码：${exitCodeRelative}`,
      `- 摘要：${summaryRelative}`,
      '',
      '## 版本与 Transport 观察',
      '',
      '- 0.19.3 的一次手工探针在 browser_type 调用时出现 MCP 转发连接断开；未做受控 A/B，因此只作为不选该版本的运行证据。',
      '- 0.38.0 在本次持久 MCP 连接下通过完整动作链。',
      '- 单次 CLI 调用无法跨进程保持 session 级 target；本次验证使用持久 MCP 连接。',
      '- 本次 0.38 流程需要 browser_prepare existing_profile；prepare 参数已校验 pid/window/session 和策略。',
      '',
      '## 结论',
      '',
      'Cua MCP 能在隔离 Chrome 上完成 V1 所需的浏览器语义动作链，且未调用 dsh_browser。',
      '',
    ].join('\n'))

    const summary = {
      status: 'pass',
      driverVersion: capability.driverVersion,
      toolCount: capability.toolCount,
      bindingQuality: binding.binding_quality,
      bindingRoute: binding.binding_route,
      targetId,
      firstTabId,
      secondTabId,
      tabCountBefore: tabs.length,
      tabCountAfter: reboundTabs.length,
      bindingPreparation: evidence.bindingPreparation,
      prepareTrace,
      versionSupported: capability.versionSupported,
      navigation: navigationStatus,
      inputClickVerified,
      tabRebindVerified: secondTabVerified,
      screenshots: evidence.screenshots,
      dshBrowserCalls,
      evidencePath,
      summaryPath,
    }
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    if (cua !== undefined) {
      await cua.callTool({ name: 'end_session', arguments: { session } }).catch(() => undefined)
      await cua.close().catch(() => undefined)
    }
    if (chrome !== undefined) {
      const signalTree = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform !== 'win32') process.kill(-chrome!.pid, signal)
          else chrome!.child.kill(signal)
        } catch {
          chrome!.child.kill(signal)
        }
      }
      signalTree('SIGTERM')
      await sleep(1_000)
      if (chrome.child.exitCode === null) signalTree('SIGKILL')
      await sleep(300)
      await rm(chrome.profileDir, { recursive: true, force: true }).catch(() => undefined)
    }
    await new Promise<void>(resolveClose => fixture.server.close(() => resolveClose()))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
