import * as path from 'node:path'
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { assertRecordingId, type RecordingId } from '../core/api.js'
import {
  assertNoCallerSuppliedPrincipal,
  assertFeatureEnabled,
  resolveHostConfig,
  resolveToolAllowlist,
  createHostTools,
  createSkillTools,
  selectToolsForFamily,
  isFeatureEnabled,
  HostError,
  SKILL_HOST_TOOL_NAMES,
  type HostCallContext,
  type HostFeature,
  type HostToolDefinition,
  type SkillToolPorts,
} from '../host/index.js'
import { writeSessionExport } from '../recording/session-export.js'
import { createPanelFetchRoutes, type PanelFetchRoute } from '../panel/fetch-api.js'
import { PanelService } from '../panel/service.js'
import { createRecordCommands, type CommandInvocationLike, type RecordCommandPorts } from './commands.js'
import { createPanelReplayPort } from './panel-replay.js'
import { createPanelRecordingControlPort } from './panel-control.js'
import { createDshSkillModelPort } from './skill-model.js'
import {
  debugLog,
  disposeAllRuntimes,
  execOfCall,
  getRuntime,
  hostCallOf,
  outputSchemaFor,
  principalOf,
  registerSharedConfig,
  renderJson,
  runtimeForWorkspace,
  toParameterSpec,
  type ExecLike,
  type PluginLogger,
  type WorkspaceRuntime,
} from './shared.js'

// 包根的既有公开面保持不变：外部调用方继续从 `dsh-record-replay` 拿这些符号，
// 实现已搬到 `plugin/shared.ts` 供两个插件行共用。
export { toParameterSpec } from './shared.js'
export type { CuaTransportState } from './shared.js'
export { cuaNativeIdentityIssue, cuaVersionOf } from '../cua/health.js'

export const name = 'dsh-record-replay'

/**
 * 功能关闭后只能返回 FEATURE_DISABLED 的工具 → 它依赖的开关。
 *
 * 这些名字不进 `tools.allow`（那份名单只列可配置的宿主工具），只在注册与状态
 * 报告时用来裁剪常驻工具面：开关默认全开，所以默认配置下这张表不隐藏任何工具。
 */
const FEATURE_GATED_TOOLS = {
  cua_record_start: 'recording',
  cua_record_bind_browser: 'recording',
  cua_record_observe: 'recording',
  cua_record_action: 'recording',
  cua_replay_start: 'replay',
  cua_skill_generate: 'skill',
  cua_skill_install: 'skill',
  cua_skill_feedback: 'skill',
} as const satisfies Readonly<Record<string, HostFeature>>

/** DSH connection route registry (`ctx.connection.fetch`). */
interface PanelConnectionRouter {
  register(route: PanelFetchRoute): () => void
}

interface PanelConnectionContext {
  readonly connection?: { readonly fetch?: PanelConnectionRouter }
  effect?(fn: () => (() => void) | void, label?: string): void
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
  const config = resolveHostConfig(rawConfig)
  // 功能关闭时这些工具必然返回 FEATURE_DISABLED，注册它们只是白占常驻上下文。
  // 读族（query / skill review·search·load）与收尾类（release / cancel / stop /
  // discard / export）不在此表：功能关掉后它们仍然可用。
  const toolEnabled = (toolName: string): boolean => {
    const feature = (FEATURE_GATED_TOOLS as Readonly<Record<string, HostFeature | undefined>>)[toolName]
    return feature === undefined || isFeatureEnabled(config, feature)
  }
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
  // 工作区运行时表在 plugin/shared.ts：桌面行（dsh-record-replay/desktop）与主线
  // 共用同一份实例；配置以先登记的主线为准。
  registerSharedConfig(config)
  const getRuntimeForExec = (exec: ExecLike): Promise<WorkspaceRuntime> => getRuntime(exec, logger)
  const runtimeForRoot = (workspaceRoot: string): Promise<WorkspaceRuntime> =>
    runtimeForWorkspace(workspaceRoot, logger)

  // Panel replay port (M3): resolves the workspace runtime by project root and
  // starts an isolated replay through the same ReplayPort as the CLI.
  const panelReplayPort = createPanelReplayPort({
    enabled: config.replay.enabled,
    runtimeForRoot,
  })
  const panelControlPort = createPanelRecordingControlPort({
    runtimeForRoot,
  })

  const register = (definition: unknown): void => {
    // 单一裁剪点：内联工具、宿主族、桌面族、Skill 族都从这里过一遍，
    // 功能关闭的工具不会被挂到宿主上。
    const toolName = (definition as { name?: unknown }).name
    if (typeof toolName === 'string' && !toolEnabled(toolName)) return
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
          description: 'Query dsh-record-replay plugin status: workspace, store root, feature switches, registered tools, and tools skipped because their feature switch is off. Desktop tools (cua_desktop_*) come from the separate record-replay-desktop plugin line, which is disabled by default and toggled on the plugin page.',
          parameters: {},
          output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
          execute: async (_args: unknown, exec: ExecLike) => {
            const runtime = await getRuntimeForExec(exec)
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
              tools: selectToolsForFamily(createHostTools(createLazyService(getRuntimeForExec) as never), config.tools.allow)
                .map(tool => tool.name)
                .filter(toolEnabled),
              skillTools: (config.tools.allow.length === 0
                ? [...SKILL_HOST_TOOL_NAMES]
                : SKILL_HOST_TOOL_NAMES.filter(tool => config.tools.allow.includes(tool))).filter(toolEnabled),
              // 开关关闭而不注册的工具：说明「没有这个工具」不是故障。
              disabledTools: Object.keys(FEATURE_GATED_TOOLS).filter(tool => !toolEnabled(tool)),
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
            const runtime = await getRuntimeForExec(exec)
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
            const runtime = await getRuntimeForExec(exec)
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
            const runtime = await getRuntimeForExec(exec)
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
            const runtime = await getRuntimeForExec(exec)
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
        const lazyService = createLazyService(getRuntimeForExec)
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
        // 套件回归（cua_test_run）不在模型工具面上：`dsh-record-replay test` 已提供同一份
        // 顺序回放/超时/重试逻辑，模型侧再挂一个只会占常驻上下文。

        // Skill 工具（IF-7）：端口按调用的 session cwd 解析工作区 Skill runtime；
        // 业务错误码由 skill/ 应用服务原样抛出，这里不包装。
        const skillPorts: SkillToolPorts = {
          config,
          generate: async (input, call) => {
            const runtime = await getRuntimeForExec(execOfCall(call))
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
          review: async (draftId, call) => (await getRuntimeForExec(execOfCall(call))).skill.review(draftId),
          install: async (request, call) => (await getRuntimeForExec(execOfCall(call))).skill.install(request),
          search: async (query, call) => (await getRuntimeForExec(execOfCall(call))).skill.catalog.searchDetailed(query),
          load: async (name, version, call) => (await getRuntimeForExec(execOfCall(call))).skill.catalog.load(name, version),
          feedback: async (feedback, call) => (await getRuntimeForExec(execOfCall(call))).skill.feedback(feedback),
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
      const runtime = await getRuntimeForExec(commandExec(invocation))
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
      const runtime = await getRuntimeForExec(commandExec(invocation))
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
      const runtime = await getRuntimeForExec(commandExec(invocation))
      const principal = principalOf(commandExec(invocation))
      const active = await runtime.recordings.list({ status: 'recording' })
      const target = active.items.find(item => item.ownerSessionId === principal.sessionId)?.recordingId
      if (target === undefined) return 'no active recording owned by this session'
      const descriptor = await runtime.recordings.stop(target, principal)
      return `recording ${descriptor.recordingId} stopped (${descriptor.status}, ${descriptor.endReason ?? 'unknown'}, ${String(descriptor.stepCount)} steps)`
    },
    discard: async (invocation) => {
      const runtime = await getRuntimeForExec(commandExec(invocation))
      const principal = principalOf(commandExec(invocation))
      const active = await runtime.recordings.list({ status: 'recording' })
      const target = active.items.find(item => item.ownerSessionId === principal.sessionId)?.recordingId
      if (target === undefined) return 'no active recording owned by this session'
      const descriptor = await runtime.recordings.discard(target, principal)
      return `recording ${descriptor.recordingId} discarded (${descriptor.status})`
    },
    launch: async (profileName, invocation) => {
      const runtime = await getRuntimeForExec(commandExec(invocation))
      const summary = await runtime.host.service.bindBrowser({
        launch: 'isolated',
        ...(profileName === undefined ? {} : { profileName }),
      }, commandCall(invocation))
      return `launched pid ${String(summary.pid)} window ${String(summary.windowId)}${profileName === undefined ? '' : ` (profile ${profileName})`}`
    },
    bind: async (pid, windowId, invocation) => {
      const runtime = await getRuntimeForExec(commandExec(invocation))
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
      void disposeAllRuntimes()
    }
  }, name + ': dispose')
}
