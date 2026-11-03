/**
 * 两个插件行（`dsh-record-replay` 与 `dsh-record-replay/desktop`）共用的装配模块。
 *
 * 为什么独立成模块：两行是同一 bundle 的两个入口，各自 `apply` 一次；只有经
 * 构建器共享 chunk 加载的模块才能保证同进程一份实例。工作区运行时表必须全局
 * 唯一——否则同一工作区被两行各建一份 WorkspaceRuntime，Cua 驱动连接与
 * Skill runtime 全部翻倍。本模块因此只依赖 `src/` 内的稳定模块，绝不回引
 * `plugin/index.ts`。
 *
 * 配置来源：主线在 `apply` 时调 {@link registerSharedConfig} 登记解析后的配置，
 * 之后无论哪一行先碰到某工作区，都用这份配置建运行时。主线被禁用时桌面行以
 * 默认配置创建（桌面工具只用 `runtime.driver`，与功能开关无关）。
 */
import * as path from 'node:path'
import { appendFileSync } from 'node:fs'

import type { BrowserDriver } from '../driver/api.js'
import {
  assertRecordingId,
  type JsonObject,
  type OperationContext,
  type Principal,
  type RecordingId,
} from '../core/api.js'
import {
  CUA_BROWSER_ACTION_KINDS,
  CUA_DESKTOP_ACTION_KINDS,
  CUA_LOCATOR_FIELDS,
  type LaunchMode,
} from '../core/contracts.js'
import {
  CuaBrowserDriver,
  CuaDriverClient,
  CuaTransportError,
  McpTransport,
  WorkerTransport,
  CUA_MINIMUM_DRIVER_VERSION,
  CUA_NATIVE_MINIMUM_DRIVER_VERSION,
} from '../cua/index.js'
import type { CuaToolResult } from '../cua/transport.js'
import { cuaNativeIdentityIssue, cuaVersionOf } from '../cua/health.js'
import { stopCuaDaemon } from '../cua/daemon-recovery.js'
import {
  createRecordReplayRuntime,
  derivePrincipal,
  resolveHostConfig,
  type HostCallContext,
  type HostConfig,
  type RecordingReadPort,
  type RecordingStep,
  type RecordingSummary,
  type ReplayPort,
  type StepListQuery,
  type TransportChoice,
} from '../host/index.js'
import type { RecordingService } from '../recording/index.js'
import type { RecordingStore } from '../store/api.js'
import { createWorkspaceReplayRuntime, createWorkspaceStoreRuntime } from '../bootstrap/runtime.js'
import { applyAutoFeedback } from './auto-feedback.js'
import { createSkillRuntime, type SkillRuntime } from './skill-runtime.js'

/** 插件日志的最小面。 */
export interface PluginLogger {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

/** 插件侧执行上下文（两个插件行共用）。 */
export interface ExecLike {
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

/** 状态工具回报的传输画像：请求值、实际值、回退原因。 */
export interface CuaTransportState {
  readonly requested: TransportChoice
  readonly active: TransportChoice | null
  readonly fallbackReason: string | null
}

export interface WorkspaceRuntime {
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

// ---------------------------------------------------------------------------
// 惰性 Cua 驱动：两个插件行共用同一条传输与回退逻辑
// ---------------------------------------------------------------------------

interface LazyCuaDriverOptions {
  readonly transport: TransportChoice
  readonly allowFallback: boolean
  readonly onFallback?: (reason: string) => void
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

export class LazyCuaDriver implements BrowserDriver {
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

// ---------------------------------------------------------------------------
// Recording 只读端口适配（createWorkspaceRuntime 的依赖）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 工作区运行时表：两行共享的唯一实例
// ---------------------------------------------------------------------------

let sharedConfig: HostConfig | undefined

/** 主线在 apply 时登记解析后的配置；重复登记以第一次为准（行重复挂载不抢配置）。 */
export function registerSharedConfig(config: HostConfig): void {
  if (sharedConfig === undefined) sharedConfig = config
}

const runtimeByWorkspace = new Map<string, Promise<WorkspaceRuntime>>()

async function createWorkspaceRuntime(
  workspaceRoot: string,
  config: HostConfig,
  logger?: PluginLogger,
): Promise<WorkspaceRuntime> {
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

export function runtimeForWorkspace(workspaceRoot: string, logger?: PluginLogger): Promise<WorkspaceRuntime> {
  const resolved = path.resolve(workspaceRoot)
  let runtime = runtimeByWorkspace.get(resolved)
  if (runtime === undefined) {
    runtime = createWorkspaceRuntime(resolved, sharedConfig ?? resolveHostConfig(undefined), logger)
    runtimeByWorkspace.set(resolved, runtime)
    void runtime.catch(() => {
      runtimeByWorkspace.delete(resolved)
    })
  }
  return runtime
}

export function sessionCwdOf(exec: ExecLike): string | undefined {
  const cwd = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** 按调用方 session cwd 解析工作区运行时；两行都从这里取，保证同区同实例。 */
export function getRuntime(exec: ExecLike, logger?: PluginLogger): Promise<WorkspaceRuntime> {
  return runtimeForWorkspace(sessionCwdOf(exec) ?? process.cwd(), logger)
}

/** 卸载时释放全部工作区运行时（幂等；只有主线登记这个清理）。 */
export async function disposeAllRuntimes(): Promise<void> {
  const runtimes = [...runtimeByWorkspace.values()]
  runtimeByWorkspace.clear()
  await Promise.all(runtimes.map(async (runtime) => {
    try {
      await (await runtime).host.dispose()
    } catch {
      // 收尾失败不覆盖主流程。
    }
  }))
}

// ---------------------------------------------------------------------------
// 调用上下文与工具参数换算
// ---------------------------------------------------------------------------

export function principalOf(exec: ExecLike): Principal {
  return derivePrincipal({ agent: exec.agent, session: exec.agent?.session })
}

export function hostCallOf(exec: ExecLike): HostCallContext {
  return {
    exec: { agent: exec.agent, session: exec.agent?.session },
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  }
}

/** Skill 端口按 `exec` 的 session cwd 解析工作区；HostCallContext 只带身份字段，这里收窄成插件执行上下文。 */
export function execOfCall(call: HostCallContext): ExecLike {
  return call.exec as unknown as ExecLike
}

export function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

export function debugLog(message: string): void {
  try {
    const dir = path.join(process.env['HOME'] ?? '/tmp', '.dsh')
    appendFileSync(path.join(dir, 'record-replay-apply.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 诊断写入失败不影响插件加载。
  }
}

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

export function outputSchemaFor(toolName: string): ParameterProperty {
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
