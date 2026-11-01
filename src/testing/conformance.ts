import {
  SCHEMA_VERSION,
  newRecordingId,
  newStepId,
  type OperationContext,
  type Principal,
  type SemanticTarget,
} from '../core/api.js'
import { CUA_REQUIRED_BROWSER_TOOLS } from '../cua/capabilities.js'
import type { CuaTransport } from '../cua/transport.js'
import type { BrowserDriver } from '../driver/api.js'
import { REDACTED_VALUE, type Redactor } from '../recording/redaction.js'
import type { RecordingStore, StoreManifest } from '../store/api.js'

export interface ConformanceCheck {
  readonly name: string
  readonly ok: boolean
  readonly error?: string
}

export interface ConformanceResult {
  readonly ok: boolean
  readonly checks: readonly ConformanceCheck[]
}

function check(name: string, run: () => Promise<void> | void): ConformanceCheck {
  try {
    const result = run()
    if (result instanceof Promise) {
      throw new Error('async check used outside async runner')
    }
    return { name, ok: true }
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function asyncCheck(name: string, run: () => Promise<void>): Promise<ConformanceCheck> {
  try {
    await run()
    return { name, ok: true }
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function finish(checks: readonly ConformanceCheck[]): ConformanceResult {
  return { ok: checks.every((entry) => entry.ok), checks }
}

export function assertConformanceOk(result: ConformanceResult): void {
  if (!result.ok) {
    const failed = result.checks.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.error ?? 'failed'}`).join('; ')
    throw new Error(`conformance failed: ${failed}`)
  }
}

export async function runTransportContract(
  transport: CuaTransport,
  requiredTools: readonly string[] = CUA_REQUIRED_BROWSER_TOOLS,
): Promise<ConformanceResult> {
  const checks: ConformanceCheck[] = []
  checks.push(await asyncCheck('listTools returns required catalog', async () => {
    const catalog = await transport.listTools(new AbortController().signal)
    const names = new Set(catalog.tools.map(tool => tool.name))
    const missing = requiredTools.filter(name => !names.has(name))
    if (missing.length > 0) throw new Error(`missing required tools: ${missing.join(', ')}`)
  }))
  checks.push(check('callTool/close are functions', () => {
    if (typeof transport.callTool !== 'function' || typeof transport.close !== 'function') {
      throw new Error('transport must expose callTool and close')
    }
  }))
  return finish(checks)
}

export async function runDriverContract(driver: BrowserDriver): Promise<ConformanceResult> {
  const checks: ConformanceCheck[] = []
  const principal: Principal = { sessionId: 'session-conformance', agentId: 'agent-conformance' }
  const context: OperationContext = { principal, callId: 'call-conformance', origin: 'internal', signal: new AbortController().signal }

  checks.push(await asyncCheck('capabilities declares actions/locators/version', async () => {
    const capabilities = await driver.capabilities()
    if (capabilities.actions.length === 0) throw new Error('driver must declare at least one action')
    if (capabilities.locators.length === 0) throw new Error('driver must declare at least one locator')
    if (capabilities.driverVersion.length === 0) throw new Error('driver must declare a version')
  }))

  checks.push(await asyncCheck('bind rejects invalid pid/windowId', async () => {
    await driver.bind({ pid: 0, windowId: 1 }, context)
  }).then((result) => result.ok ? { name: result.name, ok: false, error: 'invalid bind unexpectedly succeeded' } : { name: result.name, ok: true }))

  let binding: Awaited<ReturnType<BrowserDriver['bind']>> | undefined
  checks.push(await asyncCheck('bind/observe/release valid target', async () => {
    binding = await driver.bind({ pid: 100, windowId: 10 }, context)
    const observation = await driver.observe(binding, context)
    if (observation.url.length === 0) throw new Error('observation must expose a URL')
    if (capabilitiesInclude(await driver.capabilities(), 'navigate')) {
      await driver.execute(binding, { kind: 'navigate', url: 'https://example.test/conformance' }, undefined, context)
    }
    const after = await driver.observe(binding, context)
    const first = after.elements[0]
    if (first !== undefined && capabilitiesInclude(await driver.capabilities(), 'click')) {
      const target: SemanticTarget = {
        role: first.role,
        ...(first.name === undefined ? {} : { name: first.name }),
      }
      const resolved = await driver.resolve(binding, target, after)
      await driver.execute(binding, { kind: 'click', target }, resolved, context)
    }
    await driver.release(binding)
  }))

  return finish(checks)
}

function capabilitiesInclude(capabilities: Awaited<ReturnType<BrowserDriver['capabilities']>>, action: string): boolean {
  return (capabilities.actions as readonly string[]).includes(action)
}

export async function runStoreContract(store: RecordingStore): Promise<ConformanceResult> {
  const checks: ConformanceCheck[] = []
  const recordingId = newRecordingId()
  const manifest: StoreManifest = {
    schemaVersion: SCHEMA_VERSION,
    recordingId,
    title: 'Conformance recording',
    status: 'recording',
    ownerSessionId: 'session-conformance',
    driver: { id: 'conformance-driver', version: '0.0.0', transport: 'memory' },
    browser: { app: 'ConformanceBrowser' },
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    lastSeq: 0,
    stepCount: 0,
  }

  checks.push(await asyncCheck('open/append/close/read manifest', async () => {
    const writer = await store.open({ manifest })
    const stepId = newStepId()
    await writer.append({
      type: 'step.started',
      schemaVersion: SCHEMA_VERSION,
      stepId,
      seq: 1,
      callId: 'call-conformance',
      origin: 'agent',
      action: { kind: 'navigate', url: 'https://example.test' },
      startedAt: 1_000,
    })
    await writer.append({
      type: 'step.finished',
      stepId,
      callId: 'call-conformance',
      status: 'success',
      finishedAt: 1_010,
      durationMs: 10,
    })
    await writer.append({
      type: 'step.finished',
      stepId,
      callId: 'call-conformance',
      status: 'success',
      finishedAt: 1_020,
      durationMs: 20,
    })
    const closed = await writer.close({ status: 'completed' })
    if (closed.status !== 'completed') throw new Error('close must return completed manifest')
    const read = await store.readManifest(recordingId)
    if (read.stepCount !== 1) throw new Error(`duplicate events must not create steps; saw ${read.stepCount}`)
  }))

  checks.push(await asyncCheck('readSteps and listRecordings expose persisted facts', async () => {
    let count = 0
    for await (const event of store.readSteps(recordingId)) {
      if (event.line <= 0) throw new Error('stored events must include line cursor')
      count += 1
    }
    if (count !== 2) throw new Error(`expected 2 events, saw ${count}`)
    const list = await store.listRecordings()
    if (!list.some((entry) => entry.recordingId === recordingId)) throw new Error('listRecordings must include recording')
  }))

  return finish(checks)
}

export async function runRedactorContract(redactor: Redactor): Promise<ConformanceResult> {
  const checks: ConformanceCheck[] = []
  checks.push(await asyncCheck('redacts setValue and is idempotent', async () => {
    const stepId = newStepId()
    const event = {
      type: 'step.started' as const,
      schemaVersion: SCHEMA_VERSION,
      stepId,
      seq: 1,
      callId: 'call-redactor',
      origin: 'agent' as const,
      action: { kind: 'setValue' as const, target: { role: 'textbox', name: 'Name' }, value: 'secret' },
      startedAt: 1_000,
    }
    const once = redactor.redactEvent(event)
    const twice = redactor.redactEvent(once)
    if (once.type !== 'step.started') throw new Error('redactor must preserve event type')
    if (once.action.kind !== 'setValue' || once.action.value !== REDACTED_VALUE) {
      throw new Error('setValue value must be redacted')
    }
    if (JSON.stringify(once) !== JSON.stringify(twice)) {
      throw new Error('redactor must be idempotent')
    }
  }))
  return finish(checks)
}
