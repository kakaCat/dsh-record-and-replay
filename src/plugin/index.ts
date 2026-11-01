import * as path from 'node:path'
import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { assertRecordingId, type JsonObject, type OperationContext, type Principal, type RecordingId, type RunId } from '../core/api.js'
import {
  CUA_BROWSER_ACTION_KINDS,
  CUA_DESKTOP_ACTION_KINDS,
  CUA_LOCATOR_FIELDS,
  windowTargetSchema,
  type LaunchMode,
} from '../core/contracts.js'
import type { BrowserDriver } from '../driver/api.js'
import { CuaBrowserDriver, CuaDriverClient, CuaTransportError, McpTransport, WorkerTransport, CUA_MINIMUM_DRIVER_VERSION, CUA_NATIVE_MINIMUM_DRIVER_VERSION } from '../cua/index.js'
import type { CuaToolResult } from '../cua/transport.js'
import { cuaNativeIdentityIssue, cuaVersionOf } from '../cua/health.js'
import {
  createRecordReplayRuntime,
  derivePrincipal,
  assertNoCallerSuppliedPrincipal,
  assertFeatureEnabled,
  resolveHostConfig,
  resolveToolAllowlist,
  resolveSkillToolAllowlist,
  createHostTools,
  createSkillTools,
  selectToolsForFamily,
  HostError,
  SKILL_HOST_TOOL_NAMES,
  type HostCallContext,
  type HostConfig,
  type HostToolDefinition,
  type SkillToolPorts,
  type TransportChoice,
} from '../host/index.js'
import type { RecordingService } from '../recording/index.js'
import { writeSessionExport } from '../recording/session-export.js'
import type { RecordingStore } from '../store/api.js'
import { createWorkspaceReplayRuntime, createWorkspaceStoreRuntime } from '../bootstrap/runtime.js'
import { stopCuaDaemon } from '../cua/daemon-recovery.js'
import { createPanelFetchRoutes, type PanelFetchRoute } from '../panel/fetch-api.js'
import { PanelService } from '../panel/service.js'
import { createRecordCommands, type CommandInvocationLike, type RecordCommandPorts } from './commands.js'
import { createDesktopTools } from './desktop-tools.js'
import { parseSuiteTarget, parseTestSuite } from './suite.js'
import { executeSuite, writeSuiteJUnit } from './suite-runner.js'
import { applyAutoFeedback } from './auto-feedback.js'
import { createPanelReplayPort } from './panel-replay.js'
import { createPanelRecordingControlPort } from './panel-control.js'
import { createDshSkillModelPort } from './skill-model.js'
import { createSkillRuntime, type SkillRuntime } from './skill-runtime.js'
import type {
  RecordingReadPort,
  RecordingStep,
  RecordingSummary,
  ReplayPort,
  RunSummary,
  StartReplayInput,
  StepListQuery,
} from '../host/index.js'

export const name = 'dsh-record-replay'

interface ExecLike {
  readonly agent?: {
    readonly id?: string
    readonly session?: {
      readonly id?: string
      readonly header?: { readonly cwd?: string }
      readonly requestHeader?: () => {
        readonly config?: {
          readonly provider?: unknown
          readonly model?: unknown
          readonly reasoningEffort?: unknown
        }
      } | undefined
    }
  }
  readonly signal?: AbortSignal
}

/** DSH connection route registry (`ctx.connection.fetch`). */
interface PanelConnectionRouter {
  register(route: PanelFetchRoute): () => void
}

interface PanelConnectionContext {
  readonly connection?: { readonly fetch?: PanelConnectionRouter }
  effect?(fn: () => (() => void) | void, label?: string): void
}

interface WorkspaceRuntime {
  readonly workspaceRoot: string
  readonly storeRoot: string
  readonly skillRoot: string
  readonly config: HostConfig
  readonly store: RecordingStore
  readonly recordings: RecordingService
  readonly host: Awaited<ReturnType<typeof createRecordReplayRuntime>>
  /** 工作区 ReplayPort；面板重跑直接用它与 CLI 完全一致的落盘路径。 */
  readonly replay: ReplayPort
  readonly skill: SkillRuntime
  /** 启动恢复摘要（状态工具用）；恢复失败时为 undefined。 */
  readonly recovery?: {
    readonly scannedRecordings: number
    readonly repairedRecordings: readonly string[]
    readonly issueCount: number
  }
  /** 实际生效的传输与回退原因（状态工具用）。 */
  readonly transportState: () => CuaTransportState
  /** 桌面工具复用的惰性 Cua 传输。 */
  readonly driver: LazyCuaDriver
}

/** 状态工具回报的传输画像：请求值、实际值、回退原因。 */
export interface CuaTransportState {
  readonly requested: TransportChoice
  readonly active: TransportChoice | null
  readonly fallbackReason: string | null
}

interface LazyCuaDriverOptions {
  readonly transport: TransportChoice
  readonly allowFallback: boolean
  readonly onFallback?: (reason: string) => void
}

class LazyCuaDriver implements BrowserDriver {
  readonly id = 'cua-driver-lazy'
  private readonly choice: TransportChoice
  private readonly allowFallback: boolean
  private readonly onFallback: ((reason: string) => void) | undefined
  private readonly recoverStuckDaemon: boolean
  private preferred: TransportChoice
  private clientPromise: Promise<CuaDriverClient> | undefined
  private driver: CuaBrowserDriver | undefined
  private active: TransportChoice | null = null
  private fallbackReason: string | null = null
  private retriedAfterNativeFailure = false

  constructor(options: LazyCuaDriverOptions) {
    this.choice = options.transport
    this.preferred = options.transport
    this.allowFallback = options.allowFallback
    this.onFallback = options.onFallback
    this.recoverStuckDaemon = process.env['DSH_CUA_DAEMON_RECOVERY'] !== '0'
  }

  state(): CuaTransportState {
    return { requested: this.choice, active: this.active, fallbackReason: this.fallbackReason }
  }

  private async connect(kind: TransportChoice): Promise<CuaDriverClient> {
    // native 走独立子进程：SDK 崩了只死子进程，DSH 主进程不受影响。
    const transport = kind === 'native'
      ? await WorkerTransport.create()
      : await McpTransport.create()
    try {
      const context: OperationContext = {
        principal: { sessionId: 'dsh-record-replay-probe', agentId: 'dsh-record-replay-probe' },
        callId: 'cua-health-probe',
        origin: 'internal',
        // 探活必须有界：原生 SDK 起宿主失败时可能一直不返回。
        signal: AbortSignal.timeout(15_000),
      }
      const health = await transport.callTool('health_report', {}, context)
      const version = cuaVersionOf(health)
      if (version === undefined) {
        throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', 'Cua health_report returned no driver version')
      }
      if (kind === 'native') {
        // 进程内原生宿主没有 app bundle 身份时，macOS TCC 会拒绝它检查浏览器进程；
        // 与其等 bind 时才失败，不如在这里直接判定并回退。
        const identityIssue = cuaNativeIdentityIssue(health)
        if (identityIssue !== undefined) {
          throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', identityIssue)
        }
      }
      const client = await CuaDriverClient.connect(transport, {
        driverVersion: version,
        minimumDriverVersion: kind === 'native'
          ? CUA_NATIVE_MINIMUM_DRIVER_VERSION
          : CUA_MINIMUM_DRIVER_VERSION,
      })
      this.active = kind
      return client
    } catch (error) {
      await transport.close().catch(() => undefined)
      throw error
    }
  }

  private async connectPreferred(): Promise<CuaDriverClient> {
    try {
      return await this.connect(this.preferred)
    } catch (error) {
      if (this.preferred !== 'native' || !this.allowFallback) throw error
      this.fallbackTo('mcp', `${this.preferred} transport unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return await this.connect('mcp')
    }
  }

  /** 桌面工具共用同一条传输；仍走 LazyCuaDriver 的重连/回退逻辑。 */
  async callTool(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult> {
    return (await this.ensureClient()).callTool(name, args, context)
  }

  private ensureClient(): Promise<CuaDriverClient> {
    if (this.clientPromise === undefined) {
      const pending = this.connectPreferred()
      this.clientPromise = pending
      void pending.catch(() => {
        if (this.clientPromise === pending) this.clientPromise = undefined
      })
    }
    return this.clientPromise
  }

  private async ensureDriver(): Promise<CuaBrowserDriver> {
    if (this.driver === undefined) {
      this.driver = new CuaBrowserDriver(await this.ensureClient())
    }
    return this.driver
  }

  /** 记下回退原因并把首选传输切到 `next`；之后的重连不再先试 native。 */
  private fallbackTo(next: TransportChoice, reason: string): void {
    this.preferred = next
    if (this.fallbackReason === null) this.fallbackReason = reason
    this.onFallback?.(reason)
  }

  /** 关掉当前连接，下一次调用按当前首选传输重新握手。 */
  private async reset(): Promise<void> {
    const client = await this.clientPromise?.catch(() => undefined)
    await client?.close().catch(() => undefined)
    this.clientPromise = undefined
    this.driver = undefined
    this.retriedAfterNativeFailure = false
  }

  async capabilities(launch?: LaunchMode) {
    // Same tables as `CuaBrowserDriver`: both derive from `core/contracts.ts`.
    // Stay lazy: planning must not force a Cua handshake just to read the table.
    return {
      actions: launch === 'desktop' ? CUA_DESKTOP_ACTION_KINDS : CUA_BROWSER_ACTION_KINDS,
      locators: CUA_LOCATOR_FIELDS,
      driverVersion: `${this.active ?? this.preferred}-lazy`,
    }
  }

  /** 传输层断开（daemon 重启等）后丢掉缓存客户端，下一次调用重新握手。 */
  private async onDriverFailure(error: unknown): Promise<void> {
    if (!isTransportFailure(error)) return
    await this.reset()
  }

  async bind(input: Parameters<BrowserDriver['bind']>[0], context: Parameters<BrowserDriver['bind']>[1]) {
    const driver = await this.ensureDriver()
    try {
      return await driver.bind(input, context)
    } catch (error) {
      // 已知的 daemon 卡死形态：重启一次 daemon 再试，避免用户每次重启 DSH 都要手动 stop。
      if (this.recoverStuckDaemon && isStuckDaemonFailure(error)) {
        const stopped = await stopCuaDaemon()
        if (stopped) {
          this.onFallback?.('Cua daemon was stuck (tool_invocation_failed); restarted it once')
          await this.reset()
          return await (await this.ensureDriver()).bind(input, context)
        }
      }
      await this.onDriverFailure(error)
      // 原生在标准权限模式下可能被授权边界拒绝；回退 MCP 重试一次，
      // 但绝不重放已经成功的动作。
      const canRetry = !isTransportFailure(error)
        && this.active === 'native'
        && this.allowFallback
        && !this.retriedAfterNativeFailure
      if (!canRetry) throw error
      this.retriedAfterNativeFailure = true
      const reason = `native bind failed: ${error instanceof Error ? error.message : String(error)}`
      this.fallbackTo('mcp', reason)
      await this.reset()
      return (await this.ensureDriver()).bind(input, context)
    }
  }

  async observe(binding: Parameters<BrowserDriver['observe']>[0], context: Parameters<BrowserDriver['observe']>[1]) {
    try {
      return await (await this.ensureDriver()).observe(binding, context)
    } catch (error) {
      await this.onDriverFailure(error)
      throw error
    }
  }

  async resolve(binding: Parameters<BrowserDriver['resolve']>[0], target: Parameters<BrowserDriver['resolve']>[1], observation: Parameters<BrowserDriver['resolve']>[2]) {
    return (await this.ensureDriver()).resolve(binding, target, observation)
  }

  async execute(binding: Parameters<BrowserDriver['execute']>[0], action: Parameters<BrowserDriver['execute']>[1], resolved: Parameters<BrowserDriver['execute']>[2], context: Parameters<BrowserDriver['execute']>[3]) {
    try {
      return await (await this.ensureDriver()).execute(binding, action, resolved, context)
    } catch (error) {
      await this.onDriverFailure(error)
      throw error
    }
  }

  async release(binding: Parameters<BrowserDriver['release']>[0]) {
    if (this.driver === undefined) return
    await this.driver.release(binding)
  }

  async dispose(): Promise<void> {
    if (this.clientPromise === undefined) return
    const client = await this.clientPromise.catch(() => undefined)
    if (client !== undefined) await client.close().catch(() => undefined)
  }
}

class RecordingReadPortAdapter implements RecordingReadPort {
  constructor(private readonly recordings: RecordingService) {}

  async listRecordings(principal: Principal, query: { status?: any; cursor?: string; limit?: number }): Promise<{ items: readonly RecordingSummary[]; nextCursor?: string }> {
    const page = await this.recordings.list(query)
    const items = page.items
      .filter((item) => item.ownerSessionId === principal.sessionId)
      .map((item) => ({
        recordingId: item.recordingId,
        title: item.title,
        ...(item.intent === undefined ? {} : { intent: item.intent }),
        status: item.status,
        ...(item.endReason === undefined ? {} : { endReason: item.endReason }),
        ownerSessionId: item.ownerSessionId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        stepCount: item.stepCount,
        ...(item.suppressedCount === undefined ? {} : { suppressedCount: item.suppressedCount }),
        lastSeq: item.lastSeq,
        driverId: item.driverId,
        browserApp: item.browserApp,
      }))
    return { items, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
  }

  async getRecording(recordingId: RecordingId, principal: Principal): Promise<RecordingSummary | undefined> {
    try {
      const item = await this.recordings.get(recordingId)
      if (item.ownerSessionId !== principal.sessionId) return undefined
      return {
        recordingId: item.recordingId,
        title: item.title,
        ...(item.intent === undefined ? {} : { intent: item.intent }),
        status: item.status,
        ...(item.endReason === undefined ? {} : { endReason: item.endReason }),
        ownerSessionId: item.ownerSessionId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        stepCount: item.stepCount,
        ...(item.suppressedCount === undefined ? {} : { suppressedCount: item.suppressedCount }),
        lastSeq: item.lastSeq,
        driverId: item.driverId,
        browserApp: item.browserApp,
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'RECORDING_NOT_FOUND') {
        return undefined
      }
      throw error
    }
  }

  async listSteps(recordingId: RecordingId, principal: Principal, query: StepListQuery): Promise<{ items: readonly RecordingStep[]; nextCursor?: string }> {
    const owned = await this.getRecording(recordingId, principal)
    if (owned === undefined) return { items: [] }
    const steps: RecordingStep[] = []
    for await (const step of this.recordings.readSteps(recordingId)) {
      steps.push({
        stepId: step.stepId,
        seq: step.seq,
        status: step.status,
        actionKind: step.actionKind,
        startedAt: step.startedAt,
        ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt }),
        ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
        ...urlOfAction(step.action),
        ...targetSummaryOfAction(step.action),
        ...(step.error === undefined ? {} : { errorCode: step.error.code, errorMessage: step.error.message }),
      })
    }
    const filtered = query.status === undefined ? steps : steps.filter((step) => step.status === query.status)
    const offset = decodeCursor(query.cursor)
    const limit = query.limit ?? 50
    const items = filtered.slice(offset, offset + limit)
    const nextOffset = offset + items.length
    return { items, ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}) }
  }
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const value = Number.parseInt(cursor, 10)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function urlOfAction(action: { kind: string; url?: string; target?: { url?: { origin?: string; path?: string } } }): { url?: string } {
  if (action.kind === 'navigate' && typeof action.url === 'string') return { url: action.url }
  const url = action.target?.url
  if (url?.origin !== undefined) return { url: url.origin + (url.path ?? '') }
  return {}
}

function targetSummaryOfAction(action: { kind: string; target?: { role?: string; name?: string; text?: string; css?: string } }): { targetSummary?: string } {
  const target = action.target
  if (target === undefined) return {}
  const parts = [target.role, target.name, target.text, target.css].filter((part): part is string => typeof part === 'string' && part.length > 0)
  return parts.length === 0 ? {} : { targetSummary: parts.join(' ') }
}

function sessionCwdOf(exec: ExecLike): string | undefined {
  const cwd = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

function principalOf(exec: ExecLike): Principal {
  return derivePrincipal({ agent: exec.agent, session: exec.agent?.session })
}

function hostCallOf(exec: ExecLike): HostCallContext {
  return {
    exec: { agent: exec.agent, session: exec.agent?.session },
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  }
}

/** Skill 端口按 `exec` 的 session cwd 解析工作区；HostCallContext 只带身份字段，这里收窄成插件执行上下文。 */
function execOfCall(call: HostCallContext): ExecLike {
  return call.exec as unknown as ExecLike
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

function isStuckDaemonFailure(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  return code === 'BROWSER_BINDING_STALE' && message.includes('tool_invocation_failed')
}

function isTransportFailure(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return code === 'CUA_TRANSPORT_DISCONNECTED' || code === 'CUA_TRANSPORT_UNAVAILABLE'
}

// Re-exported from `cua/health.ts` so the health-report regression test and
// external callers keep their existing import path.
export { cuaNativeIdentityIssue, cuaVersionOf }

type ParameterProperty = Record<string, unknown>
type ParameterSpec = Record<string, ParameterProperty>

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function convertValueSchema(input: unknown): ParameterProperty {
  const schema = asRecord(input)
  const description = typeof schema['description'] === 'string'
    ? { description: schema['description'] }
    : {}

  if (Array.isArray(schema['oneOf']) && schema['oneOf'].length >= 2) {
    return { oneOf: schema['oneOf'].map(convertValueSchema), ...description }
  }
  if (Array.isArray(schema['enum']) && schema['enum'].length > 0) {
    const first = schema['enum'][0]
    const type = typeof first === 'number' ? (Number.isInteger(first) ? 'integer' : 'number') : typeof first
    return { type, enum: schema['enum'], ...description }
  }
  if (Object.hasOwn(schema, 'const')) {
    const value = schema['const']
    const type = value === null ? 'null' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value
    return { type, const: value, ...description }
  }

  switch (schema['type']) {
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean':
      return { type: schema['type'], ...description }
    case 'array':
      return {
        type: 'array',
        ...(schema['items'] === undefined ? {} : { items: convertValueSchema(schema['items']) }),
        ...description,
      }
    case 'object': {
      const properties = asRecord(schema['properties'])
      const additional = schema['additionalProperties']
      // dsh-tools cannot express an object with a typed additionalProperties schema;
      // expose it as unconstrained JSON and let the Host tool validate values.
      if (typeof additional === 'object' && additional !== null) {
        return { type: 'json', ...description }
      }
      // Never turn an open object (`{type:'object'}` / `additionalProperties:true`)
      // into a closed object with no properties: that rejects every key at the
      // parameter boundary before the Host handler can validate it.
      if (Object.keys(properties).length === 0 && additional !== false) {
        return { type: 'json', ...description }
      }
      const required = new Set(Array.isArray(schema['required']) ? schema['required'].filter((item): item is string => typeof item === 'string') : [])
      return {
        type: 'object',
        additionalProperties: additional === true,
        ...(Object.keys(properties).length === 0 ? {} : { properties: convertProperties(properties, required) }),
        ...description,
      }
    }
    default:
      return { type: 'json', ...description }
  }
}

function convertProperties(input: Record<string, unknown>, required: ReadonlySet<string>): ParameterSpec {
  const out: ParameterSpec = {}
  for (const [key, value] of Object.entries(input)) {
    out[key] = {
      ...convertValueSchema(value),
      ...(required.has(key) ? { required: true } : {}),
    }
  }
  return out
}

/**
 * Host tools carry raw JSON Schema; dsh-tools wants an implicit parameter
 * property map. Exported for the schema-conversion regression test.
 */
export function toParameterSpec(inputSchema: unknown): Record<string, Record<string, unknown>> {
  const schema = asRecord(inputSchema)
  const properties = asRecord(schema['properties'])
  const required = new Set(Array.isArray(schema['required']) ? schema['required'].filter((item): item is string => typeof item === 'string') : [])
  return convertProperties(properties, required)
}

function outputSchemaFor(toolName: string): ParameterProperty {
  if (toolName === 'cua_record_query') {
    return {
      oneOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' },
      ],
    }
  }
  return { type: 'object', additionalProperties: true }
}


/** Destination must stay inside the workspace; default under the store's exports/. */
function resolveExportDestination(
  workspaceRoot: string,
  storeRoot: string,
  recordingId: string,
  raw: unknown,
): string {
  if (raw === undefined) return path.join(storeRoot, 'exports', recordingId, 'session')
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new HostError('INVALID_ARGUMENT', 'destination must be a non-empty workspace-relative path')
  }
  if (path.isAbsolute(raw)) {
    throw new HostError('INVALID_ARGUMENT', 'destination must be workspace-relative, not absolute')
  }
  const resolved = path.resolve(workspaceRoot, raw)
  const relative = path.relative(workspaceRoot, resolved)
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HostError('INVALID_ARGUMENT', 'destination must stay inside the workspace')
  }
  return resolved
}

interface PluginLogger {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

/**
 * 录制同意门：`off` 不检查；`implicit` 只拒绝显式拒绝；`explicit` 要求 consent === true。
 * 导出供回归测试直接覆盖策略分支，避免经完整 runtime 写盘。
 */
export function assertRecordingConsent(
  policy: 'off' | 'implicit' | 'explicit',
  granted: unknown,
): void {
  if (granted === false) {
    throw new HostError('FORBIDDEN', 'recording consent was declined by the caller')
  }
  if (policy === 'explicit' && granted !== true) {
    throw new HostError(
      'FORBIDDEN',
      'recording consent is required: retry with consent: true, or start from the human /record-start command',
    )
  }
}

async function createWorkspaceRuntime(
  workspaceRoot: string,
  rawConfig: unknown,
  logger?: PluginLogger,
): Promise<WorkspaceRuntime> {
  const config = resolveHostConfig(rawConfig)
  const core = await createWorkspaceStoreRuntime({ workspaceRoot, config })
  const { storeRoot, store, recordings, runStore } = core
  const lazyDriver = new LazyCuaDriver({
    transport: config.transport,
    allowFallback: config.transportFallback,
    onFallback: (reason: string) => logger?.warn(`dsh-record-replay: ${reason}`),
  })
  // Skill 库与录制库共用工作区粒度：开关、根目录都来自同一份已校验配置。
  const skillRoot = path.resolve(workspaceRoot, config.skill.rootDir)
  const skill = createSkillRuntime({ root: skillRoot, workspaceRoot, recordings, recordingStore: store, runs: runStore })
  const replay = createWorkspaceReplayRuntime({
    config,
    driver: lazyDriver,
    store,
    recordings,
    runStore,
    onRunTerminal: async (run) => {
      await applyAutoFeedback({
        run,
        enabled: config.skill.enabled && config.skill.autoFeedback,
        listSkills: async () => (await skill.catalog.searchDetailed({})).entries,
        feedback: value => skill.feedback(value),
      })
    },
  })
  const host = await createRecordReplayRuntime({
    config,
    driver: lazyDriver,
    events: recordings,
    recordings: new RecordingReadPortAdapter(recordings),
    replay,
    disposeResources: () => lazyDriver.dispose(),
  })
  return {
    workspaceRoot,
    storeRoot,
    skillRoot,
    config,
    store,
    recordings,
    host,
    replay,
    skill,
    ...(core.recovery === undefined ? {} : { recovery: core.recovery }),
    transportState: () => lazyDriver.state(),
    driver: lazyDriver,
  }
}

function createLazyService(getRuntime: (exec: ExecLike) => Promise<WorkspaceRuntime>): unknown {
  return new Proxy({}, {
    get(_target, property: string | symbol) {
      if (typeof property !== 'string') return undefined
      return async (...args: unknown[]) => {
        const call = args.find((arg): arg is HostCallContext =>
          typeof arg === 'object' && arg !== null && 'exec' in arg,
        )
        const runtime = await getRuntime(call?.exec as ExecLike | undefined ?? {})
        const service = runtime.host.service as unknown as Record<string, (...inner: unknown[]) => Promise<unknown>>
        const method = service[property]
        if (typeof method !== 'function') {
          throw new Error(`dsh-record-replay service method not found: ${property}`)
        }
        return method.apply(runtime.host.service, args)
      }
    },
  })
}

function debugLog(message: string): void {
  try {
    const dir = path.join(process.env['HOME'] ?? '/tmp', '.dsh')
    appendFileSync(path.join(dir, 'record-replay-apply.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 诊断写入失败不影响插件加载。
  }
}

export function apply(ctx: unknown, rawConfig?: unknown): void {
  debugLog('apply start')
  try {
    applyPlugin(ctx, rawConfig)
    debugLog('apply ok')
  } catch (error) {
    debugLog(`apply failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    throw error
  }
}

function applyPlugin(ctx: unknown, rawConfig?: unknown): void {
  const logger = (ctx as { logger?: (name: string) => { info: (m: string) => void; warn: (m: string, err?: unknown) => void } }).logger?.(name) ?? console
  const disposers: Array<() => void> = []
  const runtimeByWorkspace = new Map<string, Promise<WorkspaceRuntime>>()
  const config = resolveHostConfig(rawConfig)
  // Model drafting is opt-in per call; the service is read structurally because
  // this package does not depend on @deepseek-ai/dsh-llm.
  const serviceContext = ctx as { get?: (name: string) => unknown }
  // Capture the mounted model service if this host has one. Declaring the
  // injection keeps service resolution out of the tool hot path; when it is
  // absent, model mode simply falls back to the template.
  let llmService: unknown
  ;(ctx as {
    inject?: (services: string[], callback: (scope: { get?: (name: string) => unknown }) => (() => void) | void) => void
  }).inject?.(['llm'], (scope) => {
    llmService = scope.get?.('llm')
    return () => {
      llmService = undefined
    }
  })
  const modelContext = {
    get: (name: string) => (name === 'llm' ? llmService : serviceContext.get?.(name)),
  }
  // 工具白名单在任何资源创建之前校验（未知/内部 Cua 工具名 → CONFIG_INVALID）。
  resolveToolAllowlist(config.tools.allow)

  const runtimeForWorkspace = (workspaceRoot: string): Promise<WorkspaceRuntime> => {
    const resolved = path.resolve(workspaceRoot)
    let runtime = runtimeByWorkspace.get(resolved)
    if (runtime === undefined) {
      runtime = createWorkspaceRuntime(resolved, config, logger)
      runtimeByWorkspace.set(resolved, runtime)
      void runtime.catch(() => {
        runtimeByWorkspace.delete(resolved)
      })
    }
    return runtime
  }

  const getRuntime = (exec: ExecLike): Promise<WorkspaceRuntime> =>
    runtimeForWorkspace(sessionCwdOf(exec) ?? process.cwd())

  // Panel replay port (M3): resolves the workspace runtime by project root and
  // starts an isolated replay through the same ReplayPort as the CLI.
  const panelReplayPort = createPanelReplayPort({
    enabled: config.replay.enabled,
    runtimeForRoot: runtimeForWorkspace,
  })
  const panelControlPort = createPanelRecordingControlPort({
    runtimeForRoot: runtimeForWorkspace,
  })

  const register = (definition: unknown): void => {
    const tools = registeredTools as { register(tool: unknown): () => void }
    disposers.push(tools.register(definition))
  }

  let registeredTools: { register(tool: unknown): () => void } | undefined
  ;(ctx as { inject?: (services: string[], cb: (toolsCtx: any) => void) => void }).inject?.(
    ['tools'],
    (toolsCtx: { effect?: (fn: () => void, label?: string) => void; tools?: { register(tool: unknown): () => void } }) => {
      toolsCtx.effect?.(() => {
        if (toolsCtx.tools === undefined) {
          logger.warn('dsh-record-replay: tools service unavailable; host tools not registered')
          return
        }
        registeredTools = toolsCtx.tools

        register(defineTool({
          name: 'cua_record_replay_status',
          description: '查询 dsh-record-replay 插件状态：工作区、Store 根、功能开关与已注册工具。',
          parameters: {},
          output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
          execute: async (_args: unknown, exec: ExecLike) => {
            const runtime = await getRuntime(exec)
            const transport = runtime.transportState()
            return {
              plugin: name,
              workspaceRoot: runtime.workspaceRoot,
              storeRoot: runtime.storeRoot,
              recordingEnabled: runtime.config.recording.enabled,
              recordingMaxDurationSeconds: runtime.config.recording.maxDurationSeconds,
              recordingConsent: runtime.config.recording.consent,
              recordingPrivacy: {
                deniedUrlPatternCount: runtime.config.recording.privacy.deniedUrlPatterns.length,
                blockPrivateBrowsing: runtime.config.recording.privacy.blockPrivateBrowsing,
              },
              ...(runtime.recovery === undefined ? {} : { recovery: runtime.recovery }),
              replayEnabled: runtime.config.replay.enabled,
              transport: runtime.config.transport,
              transportActive: transport.active,
              transportFallbackReason: transport.fallbackReason,
              tools: selectToolsForFamily(createHostTools(createLazyService(getRuntime) as never), config.tools.allow).map(tool => tool.name),
              skillTools: config.tools.allow.length === 0
                ? [...SKILL_HOST_TOOL_NAMES]
                : SKILL_HOST_TOOL_NAMES.filter(tool => config.tools.allow.includes(tool)),
            }
          },
        } as any))

        register(defineTool({
          name: 'cua_record_start',
          description: 'Start a Cua browser recording for this workspace. Recording stays local-first and redacts secrets before persistence. Pass intent to record the user requirement or use case; it is stored in the manifest and shown beside the replay video.',
          parameters: {
            title: { type: 'string', required: true, description: 'Recording title.' },
            intent: { type: 'string', description: 'User requirement or use-case text this recording demonstrates; shown beside the replay video.' },
            browserApp: { type: 'string', description: 'Browser application label; defaults to Chrome.' },
            idempotencyKey: { type: 'string', description: 'Idempotency key for duplicate starts.' },
            consent: { type: 'boolean', description: 'Explicit recording consent. Required when recording.consent is "explicit"; the grant (scope, time, session) is stored in the manifest.' },
          },
          output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
          execute: async (args: unknown, exec: ExecLike) => {
            assertNoCallerSuppliedPrincipal(args)
            const input = args as { title?: unknown; intent?: unknown; browserApp?: unknown; idempotencyKey?: unknown; consent?: unknown }
            const runtime = await getRuntime(exec)
            assertFeatureEnabled(runtime.config, 'recording')
            const consentPolicy = runtime.config.recording.consent
            assertRecordingConsent(consentPolicy, input.consent)
            const intent = typeof input.intent === 'string' ? input.intent.trim() : undefined
            const consent = consentPolicy === 'off'
              ? undefined
              : {
                  mode: input.consent === true ? 'explicit' as const : 'implicit' as const,
                  scope: 'Record Cua browser and desktop actions in this workspace until stop',
                }
            const descriptor = await runtime.recordings.start({
              title: String(input.title ?? ''),
              ...(intent === undefined || intent.length === 0 ? {} : { intent }),
              driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
              browser: { app: typeof input.browserApp === 'string' && input.browserApp.length > 0 ? input.browserApp : 'Chrome' },
              ...(consent === undefined ? {} : { consent }),
              ...(typeof input.idempotencyKey === 'string' ? { idempotencyKey: input.idempotencyKey } : {}),
            }, principalOf(exec))
            return descriptor
          },
        } as any))

        register(defineTool({
          name: 'cua_record_stop',
          description: 'Stop the active Cua recording owned by this session. If recordingId is omitted, stop the session-owned active recording.',
          parameters: {
            recordingId: { type: 'string', description: 'Recording id; omitted = session-owned active recording.' },
          },
          output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
          execute: async (args: unknown, exec: ExecLike) => {
            assertNoCallerSuppliedPrincipal(args)
            const runtime = await getRuntime(exec)
            const principal = principalOf(exec)
            const input = args as { recordingId?: unknown }
            let target: RecordingId | undefined
            if (typeof input.recordingId === 'string') {
              target = input.recordingId as RecordingId
            } else {
              const active = await runtime.recordings.list({ status: 'recording' })
              target = active.items.find((item) => item.ownerSessionId === principal.sessionId)?.recordingId
            }
            if (target === undefined) {
              return { stopped: false as const, reason: 'no active recording owned by this session' }
            }
            const descriptor = await runtime.recordings.stop(target, principal)
            return { stopped: true as const, descriptor }
          },
        } as any))

        register(defineTool({
          name: 'cua_record_discard',
          description: 'Discard the active recording owned by this session. The directory stays on disk for audit, but the recording becomes status "cancelled": it cannot be replayed or turned into a Skill. Use the panel trash to delete it.',
          parameters: {
            recordingId: { type: 'string', description: 'Recording id; omitted = session-owned active recording.' },
          },
          output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
          execute: async (args: unknown, exec: ExecLike) => {
            assertNoCallerSuppliedPrincipal(args)
            const runtime = await getRuntime(exec)
            const principal = principalOf(exec)
            const input = args as { recordingId?: unknown }
            let target: RecordingId | undefined
            if (typeof input.recordingId === 'string') {
              target = input.recordingId as RecordingId
            } else {
              const active = await runtime.recordings.list({ status: 'recording' })
              target = active.items.find((item) => item.ownerSessionId === principal.sessionId)?.recordingId
            }
            if (target === undefined) {
              return { discarded: false as const, reason: 'no active recording owned by this session' }
            }
            const descriptor = await runtime.recordings.discard(target, principal)
            return descriptor.status === 'cancelled'
              ? { discarded: true as const, descriptor }
              : { discarded: false as const, reason: 'recording is already terminal', descriptor }
          },
        } as any))

        register(defineTool({
          name: 'cua_record_export',
          description: 'Export a terminal recording as a portable session directory: session.json, events.jsonl (session.started / agent.action / session.ended) and suppressed.jsonl when applicable. Read-only; the destination must not exist.',
          parameters: {
            recordingId: { type: 'string', required: true, description: 'Terminal recording id owned by this session.' },
            destination: { type: 'string', description: 'Workspace-relative directory; defaults to .dsh/record-replay/exports/<recordingId>/session.' },
          },
          output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
          execute: async (args: unknown, exec: ExecLike) => {
            assertNoCallerSuppliedPrincipal(args)
            const input = args as { recordingId?: unknown; destination?: unknown }
            if (typeof input.recordingId !== 'string' || input.recordingId.length === 0) {
              throw new HostError('INVALID_ARGUMENT', 'recordingId must be a non-empty string')
            }
            const recordingId = assertRecordingId(input.recordingId)
            const runtime = await getRuntime(exec)
            const principal = principalOf(exec)
            const descriptor = await runtime.recordings.get(recordingId)
            if (descriptor.ownerSessionId !== principal.sessionId) {
              throw new HostError('FORBIDDEN', 'recording is owned by another session')
            }
            if (descriptor.status === 'recording') {
              throw new HostError('INVALID_ARGUMENT', 'only a terminal recording can be exported; stop or discard it first')
            }
            const manifest = await runtime.store.readManifest(recordingId)
            const steps = []
            for await (const step of runtime.recordings.readSteps(recordingId)) steps.push(step)
            const destination = resolveExportDestination(
              runtime.workspaceRoot,
              runtime.storeRoot,
              recordingId,
              input.destination,
            )
            const suppressedText = await readFile(
              path.join(runtime.storeRoot, 'recordings', recordingId, 'suppressed.jsonl'),
              'utf8',
            ).catch(() => undefined)
            const result = await writeSessionExport({
              recordingId,
              destination,
              manifest,
              steps,
              ...(suppressedText === undefined ? {} : { suppressedText }),
            })
            return { recordingId, ...result }
          },
        } as any))

        debugLog('tools callback start')
        const lazyService = createLazyService(getRuntime)
        // 跨族 allow：只注册被点名的工具；空 allow = 本族全部（不得把「本族 0 个」放大成全部）。
        const hostTools = selectToolsForFamily(createHostTools(lazyService as never), config.tools.allow)
        for (const tool of hostTools as readonly HostToolDefinition[]) {
          register(defineTool({
            name: tool.name,
            description: tool.description,
            parameters: toParameterSpec(tool.inputSchema),
            output: { schema: outputSchemaFor(tool.name), render: renderJson },
            execute: async (args: unknown, exec: ExecLike) => tool.handle(args, hostCallOf(exec)) as Promise<unknown>,
          } as any))
        }

        debugLog('host tools registered')
        // 桌面最小集：不参与 allowlist（名字不在 HostToolName 联合里），只在 allow 为空时注册。
        if (config.tools.allow.length === 0) {
          for (const tool of createDesktopTools(async call => (await getRuntime(execOfCall(call))).driver)) {
            register(defineTool({
              name: tool.name,
              description: tool.description,
              parameters: toParameterSpec(tool.inputSchema),
              output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
              execute: async (args: unknown, exec: ExecLike) => tool.handle(args, hostCallOf(exec)) as Promise<unknown>,
            } as any))
          }
        }

        if (config.tools.allow.length === 0) {
          register(defineTool({
            name: 'cua_test_run',
            description: 'Run a JSON test suite: sequential replays with per-case target/values/baseUrl, returns a pass/fail report.',
            parameters: toParameterSpec({
              type: 'object',
              additionalProperties: false,
              required: ['suite'],
              properties: {
                suite: { type: 'string', minLength: 1, description: 'Workspace-relative path to the suite JSON.' },
                baseUrl: { type: 'string', minLength: 1, description: 'Override the suite baseUrl.' },
                target: windowTargetSchema('Override the suite target (launch/pid/windowId/profileName).'),
              },
            }),
            output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
            execute: async (args: unknown, exec: ExecLike) => {
              const call = hostCallOf(exec)
              const runtime = await getRuntime(execOfCall(call))
              const suiteArg = (args as { suite?: unknown }).suite
              if (typeof suiteArg !== 'string' || suiteArg.length === 0) {
                throw new Error('suite must be a non-empty string')
              }
              const suitePath = path.resolve(runtime.workspaceRoot, suiteArg)
              const suite = parseTestSuite(JSON.parse(await readFile(suitePath, 'utf8')))
              const argsValue = args as { baseUrl?: unknown; target?: unknown }
              const overrideTarget = argsValue.target === undefined ? undefined : parseSuiteTarget(argsValue.target, 'target')
              const overrideBaseUrl = argsValue.baseUrl === undefined ? undefined : String(argsValue.baseUrl)
              const service = lazyService as unknown as {
                startReplay(input: StartReplayInput, call: HostCallContext): Promise<RunSummary>
                cancelRun(runId: RunId, call: HostCallContext): Promise<RunSummary>
              }
              // Host 工具与 CLI 共用同一份顺序回放/超时/重试逻辑；principal 由 call 派生。
              const replay: Pick<ReplayPort, 'startReplay' | 'cancelRun'> = {
                startReplay: input => service.startReplay(input, call),
                cancelRun: runId => service.cancelRun(runId, call),
              }
              const report = await executeSuite({
                suite,
                replay,
                ...(overrideTarget === undefined ? {} : { target: overrideTarget }),
                ...(overrideBaseUrl === undefined ? {} : { baseUrl: overrideBaseUrl }),
              })
              const cases = report.cases.map(item => ({
                name: item.name,
                status: item.status,
                ...(item.runId === undefined ? {} : { runId: item.runId }),
                ...(item.errorCode === undefined ? {} : { errorCode: item.errorCode }),
                ...(item.errorMessage === undefined ? {} : { error: item.errorMessage }),
                ...(item.timedOut === true ? { timedOut: true } : {}),
              }))
              const junitPath = suitePath.replace(/\.json$/u, '') + '.junit.xml'
              await writeSuiteJUnit(junitPath, suite.name ?? suiteArg, report.cases)
              return {
                name: suite.name ?? suiteArg,
                total: report.cases.length,
                passed: report.passed,
                failed: report.failed,
                junitPath,
                cases,
              }
            },
          } as any))
        }

        // Skill 工具（IF-7）：端口按调用的 session cwd 解析工作区 Skill runtime；
        // 业务错误码由 skill/ 应用服务原样抛出，这里不包装。
        const skillPorts: SkillToolPorts = {
          config,
          generate: async (input, call) => {
            const runtime = await getRuntime(execOfCall(call))
            const exec = execOfCall(call)
            const model = input.mode === 'model'
              ? createDshSkillModelPort({
                  ctx: modelContext,
                  exec,
                  ...(call.signal === undefined ? {} : { signal: call.signal }),
                })
              : undefined
            return await runtime.skill.generate(input, model)
          },
          review: async (draftId, call) => (await getRuntime(execOfCall(call))).skill.review(draftId),
          install: async (request, call) => (await getRuntime(execOfCall(call))).skill.install(request),
          search: async (query, call) => (await getRuntime(execOfCall(call))).skill.catalog.searchDetailed(query),
          load: async (name, version, call) => (await getRuntime(execOfCall(call))).skill.catalog.load(name, version),
          feedback: async (feedback, call) => (await getRuntime(execOfCall(call))).skill.feedback(feedback),
        }
        const skillTools = selectToolsForFamily(createSkillTools(skillPorts), config.tools.allow)
        for (const tool of skillTools as readonly HostToolDefinition[]) {
          register(defineTool({
            name: tool.name,
            description: tool.description,
            parameters: toParameterSpec(tool.inputSchema),
            output: { schema: outputSchemaFor(tool.name), render: renderJson },
            execute: async (args: unknown, exec: ExecLike) => tool.handle(args, hostCallOf(exec)) as Promise<unknown>,
          } as any))
        }

        logger.info(`dsh-record-replay tools registered: cua_record_replay_status / cua_record_start / cua_record_stop / cua_record_discard / cua_record_export / ${hostTools.map(tool => tool.name).join(' / ')} / ${skillTools.map(tool => tool.name).join(' / ')}`)
      }, name + ': tools')
    },
  )

  /** Slash commands share the host service; they never go through the model. */
  const commandCall = (invocation: CommandInvocationLike): HostCallContext => ({
    exec: { agent: invocation.agent as never, session: (invocation.agent as { session?: never } | undefined)?.session },
    signal: invocation.signal,
  })
  const commandExec = (invocation: CommandInvocationLike): ExecLike => ({
    agent: invocation.agent as never,
    signal: invocation.signal,
  })

  const commandPorts: RecordCommandPorts = {
    status: async (invocation) => {
      const runtime = await getRuntime(commandExec(invocation))
      const transport = runtime.transportState()
      const principal = principalOf(commandExec(invocation))
      const active = await runtime.recordings.list({ status: 'recording' })
      const own = active.items.find(item => item.ownerSessionId === principal.sessionId)
      return JSON.stringify({
        workspaceRoot: runtime.workspaceRoot,
        recordingEnabled: runtime.config.recording.enabled,
        replayEnabled: runtime.config.replay.enabled,
        transport: runtime.config.transport,
        transportActive: transport.active,
        transportFallbackReason: transport.fallbackReason,
        activeRecording: own?.recordingId ?? null,
      }, null, 2)
    },
    start: async (title, invocation) => {
      const runtime = await getRuntime(commandExec(invocation))
      assertFeatureEnabled(runtime.config, 'recording')
      const descriptor = await runtime.recordings.start({
        title,
        driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
        browser: { app: 'Chrome' },
        ...(runtime.config.recording.consent === 'off'
          ? {}
          : { consent: { mode: 'explicit' as const, scope: 'Started from the human /record-start command' } }),
      }, principalOf(commandExec(invocation)))
      return `recording ${descriptor.recordingId} started`
    },
    stop: async (invocation) => {
      const runtime = await getRuntime(commandExec(invocation))
      const principal = principalOf(commandExec(invocation))
      const active = await runtime.recordings.list({ status: 'recording' })
      const target = active.items.find(item => item.ownerSessionId === principal.sessionId)?.recordingId
      if (target === undefined) return 'no active recording owned by this session'
      const descriptor = await runtime.recordings.stop(target, principal)
      return `recording ${descriptor.recordingId} stopped (${descriptor.status}, ${descriptor.endReason ?? 'unknown'}, ${String(descriptor.stepCount)} steps)`
    },
    discard: async (invocation) => {
      const runtime = await getRuntime(commandExec(invocation))
      const principal = principalOf(commandExec(invocation))
      const active = await runtime.recordings.list({ status: 'recording' })
      const target = active.items.find(item => item.ownerSessionId === principal.sessionId)?.recordingId
      if (target === undefined) return 'no active recording owned by this session'
      const descriptor = await runtime.recordings.discard(target, principal)
      return `recording ${descriptor.recordingId} discarded (${descriptor.status})`
    },
    launch: async (profileName, invocation) => {
      const runtime = await getRuntime(commandExec(invocation))
      const summary = await runtime.host.service.bindBrowser({
        launch: 'isolated',
        ...(profileName === undefined ? {} : { profileName }),
      }, commandCall(invocation))
      return `launched pid ${String(summary.pid)} window ${String(summary.windowId)}${profileName === undefined ? '' : ` (profile ${profileName})`}`
    },
    bind: async (pid, windowId, invocation) => {
      const runtime = await getRuntime(commandExec(invocation))
      const summary = await runtime.host.service.bindBrowser({ launch: 'existing', pid, windowId }, commandCall(invocation))
      return `bound pid ${String(summary.pid)} window ${String(summary.windowId)}`
    },
  }

  ;(ctx as { inject?: (services: string[], cb: (connectionCtx: any) => void) => void }).inject?.(
    ['connection'],
    (connectionCtx: PanelConnectionContext) => {
      connectionCtx.effect?.(() => {
        const router = connectionCtx.connection?.fetch
        if (router === undefined) {
          logger.warn('dsh-record-replay: connection.fetch unavailable; panel routes not registered')
          return
        }
        // The global panel reads the same service as the standalone `panel`
        // command, but serves it from DSH's authenticated connection so no
        // second port is needed. Only this mount also gets the replay port
        // (backed by the host driver); the standalone command reports
        // PANEL_REPLAY_UNAVAILABLE.
        // `cwd: null`: the host process runs from the app/profile directory
        // (often `~/.dsh/profiles/desktop` or `/tmp`), which is not a project.
        // Workspaces and explicitly picked folders still appear.
        const routes = createPanelFetchRoutes(new PanelService({
          cwd: null,
          trash: true,
          control: panelControlPort,
          ...(panelReplayPort === undefined ? {} : { replay: panelReplayPort }),
        }))
        const offs = routes.map(route => router.register(route))
        return () => {
          for (const off of offs) off?.()
        }
      }, name + ': panel routes')
    },
  )

  ;(ctx as { inject?: (services: string[], cb: (commandCtx: any) => void) => void }).inject?.(
    ['commands'],
    (commandCtx: { effect?: (fn: () => (() => void) | void, label?: string) => void; commands?: { register(definition: unknown): () => void } }) => {
      commandCtx.effect?.(() => {
        if (commandCtx.commands === undefined) {
          logger.warn('dsh-record-replay: commands service unavailable; slash commands not registered')
          return
        }
        const offs = createRecordCommands(commandPorts).map(definition => commandCtx.commands?.register(definition))
        return () => {
          for (const off of offs) off?.()
        }
      }, name + ': commands')
    },
  )

  ;(ctx as { effect?: (fn: () => void, label?: string) => void }).effect?.(() => {
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
      void Promise.all([...runtimeByWorkspace.values()].map(async (runtime) => {
        try {
          await (await runtime).host.dispose()
        } catch {
          // 收尾失败不覆盖主流程。
        }
      }))
    }
  }, name + ': dispose')
}
