/**
 * Host 组合根（design/backend.md IF-1 `createRecordReplayRuntime`、
 * design/interfaces.md IF-7：`ctx.cuaRecordReplay` 与 Host Remote）。
 *
 * 装配顺序（design/backend.md IF-1 语义）：
 *   校验配置与工具白名单 → 取得 Store/Replay 端口（注入）→ 取得 Driver →
 *   创建 OperationRunner → 创建 Host Service → 注册 Agent 工具 → 构造 Remote 边界。
 *
 * 任何一步失败都按逆序释放已建资源：配置/白名单失败时**一个资源都不创建**；
 * Driver 创建失败时只关闭调用方注入的资源；dispose 幂等（停止新动作、等待在途动作、
 * 释放 Binding，最后才释放 Transport 等外部资源）。
 */
import { toPublicError } from '../core/api.js'
import type { BrowserDriver } from '../driver/api.js'
import { OperationRunner, type OperationEventSink } from '../driver/operation-runner.js'
import { HostError, resolveHostConfig, type HostConfig } from './config.js'
import { createRemoteApi, type RemoteApi, type RemoteAuthenticator } from './remote.js'
import { CuaRecordReplayService, type RecordingReadPort, type ReplayPort } from './service.js'
import { createHostTools, resolveToolAllowlist, selectToolsForFamily, type HostToolDefinition } from './tools.js'

export interface RecordReplayRuntimeOptions {
  /** 宿主配置（未信任输入）；缺省 = 默认配置（录制/回放均关闭）。 */
  readonly config?: unknown
  /** 已创建的 Driver（与 driverFactory 二选一）。 */
  readonly driver?: BrowserDriver
  /** Driver 工厂：仅在配置校验通过后调用。 */
  readonly driverFactory?: (config: HostConfig) => Promise<BrowserDriver>
  /** 步骤事件接收方（生产环境是 RecordingService 的写入队列）。 */
  readonly events?: OperationEventSink
  /** RecordingService 的只读侧（t6 注入；缺省时查询返回空页）。 */
  readonly recordings?: RecordingReadPort
  /** ReplayService 的宿主侧（t8 注入；缺省时回放控制返回 FEATURE_DISABLED）。 */
  readonly replay?: ReplayPort
  /** 时钟（毫秒），用于步骤耗时与 DTO。 */
  readonly clock?: () => number
  /** callId 生成器（缺省 call_<uuid>）。 */
  readonly newCallId?: () => string
  /** Remote 认证器（缺少时所有 Remote 请求 REMOTE_UNAUTHORIZED）。 */
  readonly authenticateRemote?: RemoteAuthenticator
  /** Remote 操作者开关（默认关闭：控制命令 FEATURE_DISABLED）。 */
  readonly operatorControlsEnabled?: () => boolean
  /** 逆序释放外部资源（如 CuaDriverClient / Transport.close）；在 Host 自身收尾之后调用。 */
  readonly disposeResources?: () => Promise<void>
}

export interface RecordReplayRuntime {
  readonly config: HostConfig
  /** ctx.cuaRecordReplay 的实现。 */
  readonly service: CuaRecordReplayService
  /** 已注册的 Agent 工具（按 HOST_TOOL_NAMES 顺序、按 tools.allow 过滤）。 */
  readonly tools: readonly HostToolDefinition[]
  readonly remote: RemoteApi
  /** 注册到 DSH Context 的载荷；插件用 `ctx.cuaRecordReplay = extension.cuaRecordReplay`。 */
  readonly contextExtension: { readonly cuaRecordReplay: CuaRecordReplayService }
  /** 录制开关是否开启（组合根可据此决定是否对外宣告执行类工具）。 */
  readonly executionEnabled: boolean
  /** 幂等收尾：停止新动作 → 取消在途 → 释放 Binding → 释放外部资源。 */
  dispose(): Promise<void>
}

export async function createRecordReplayRuntime(
  options: RecordReplayRuntimeOptions = {},
): Promise<RecordReplayRuntime> {
  // 1) 配置与工具白名单：在任何资源创建之前拒绝非法输入。
  const config = resolveHostConfig(options.config)
  // 校验未知/内部工具名（跨族 allow 合法；下面按族各取所需）。
  resolveToolAllowlist(config.tools.allow)
  const allow = config.tools.allow

  if (options.driver === undefined && options.driverFactory === undefined) {
    throw new HostError(
      'CUA_TRANSPORT_UNAVAILABLE',
      'No BrowserDriver was supplied; the composition root must inject the Cua driver',
    )
  }

  // 2) Driver：工厂失败映射成 CUA_TRANSPORT_UNAVAILABLE，并逆序释放已建资源。
  let driver: BrowserDriver
  if (options.driver !== undefined) {
    driver = options.driver
  } else {
    const factory = options.driverFactory
    if (factory === undefined) {
      throw new HostError('CUA_TRANSPORT_UNAVAILABLE', 'No BrowserDriver factory was supplied')
    }
    try {
      driver = await factory(config)
    } catch (error) {
      await disposeQuietly(options.disposeResources)
      const normalized = toPublicError(error, { fallbackCode: 'CUA_TRANSPORT_UNAVAILABLE' })
      throw new HostError(normalized.code, normalized.message)
    }
  }

  try {
    // 3) OperationRunner：步骤开始/结束、取消与错误归一的唯一入口。
    const runner = new OperationRunner({
      driver,
      ...(options.events === undefined ? {} : { events: options.events }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    })

    // 4) Host Service：同一批用例服务 Agent 工具与 Remote。
    const service = new CuaRecordReplayService({
      config,
      driver,
      runner,
      ...(options.recordings === undefined ? {} : { recordings: options.recordings }),
      ...(options.replay === undefined ? {} : { replay: options.replay }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.newCallId === undefined ? {} : { newCallId: options.newCallId }),
    })

    // 5) Agent 工具与 Remote 边界。
    // 跨族白名单：allow 里可能只有 Skill 工具名，此时本族注册 0 个（不得退化为「全部」）。
    const tools = selectToolsForFamily(createHostTools(service), allow)
    const remote = createRemoteApi(service, {
      authenticate: options.authenticateRemote ?? ((): undefined => undefined),
      ...(options.operatorControlsEnabled === undefined
        ? {}
        : { controlsEnabled: options.operatorControlsEnabled }),
    })

    const contextExtension = { cuaRecordReplay: service } as const
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await service.dispose()
      await disposeQuietly(options.disposeResources)
    }

    return {
      config,
      service,
      tools,
      remote,
      contextExtension,
      executionEnabled: config.recording.enabled,
      dispose,
    }
  } catch (error) {
    // 装配后段失败：逆序释放外部资源，不覆盖原始错误。
    await disposeQuietly(options.disposeResources)
    throw error
  }
}

async function disposeQuietly(disposeResources: (() => Promise<void>) | undefined): Promise<void> {
  if (disposeResources === undefined) return
  try {
    await disposeResources()
  } catch {
    // 逆序释放“尽力而为”：不能覆盖导致装配/收尾失败的那个错误。
  }
}

export {
  DEFAULT_HOST_CONFIG,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_RUNS,
  DEFAULT_MAX_STEPS,
  DEFAULT_RECORDING_ROOT,
  DEFAULT_SKILL_ROOT,
  HostError,
  assertFeatureEnabled,
  isFeatureEnabled,
  resolveHostConfig,
  type HostConfig,
  type HostFeature,
  type RecordingConfig,
  type ReplayConfig,
  type SkillConfig,
  type ToolsConfig,
  type TransportChoice,
} from './config.js'
export {
  assertNoCallerSuppliedPrincipal,
  assertSessionOwnership,
  derivePrincipal,
  type AgentExecutionContext,
  type HostCallContext,
} from './principal.js'
export {
  CuaRecordReplayService,
  type ActionReceipt,
  type BindingSummary,
  type CuaRecordReplayServiceOptions,
  type ObservationDto,
  type ObservationElementDto,
  type Page,
  type PageQuery,
  type RecordingListQuery,
  type RecordingReadPort,
  type RecordingStatus,
  type RecordingStep,
  type RecordingSummary,
  type ReplayPort,
  type RunListQuery,
  type RunStatus,
  type RunSummary,
  type StartReplayInput,
  type StepListQuery,
  type StepViewStatus,
} from './service.js'
export {
  ALL_HOST_TOOL_NAMES,
  HOST_TOOL_NAMES,
  INTERNAL_CUA_TOOL_NAMES,
  SKILL_HOST_TOOL_NAMES,
  createHostTools,
  createSkillTools,
  resolveSkillToolAllowlist,
  resolveToolAllowlist,
  selectToolsForFamily,
  type AnyHostToolName,
  type HostToolDefinition,
  type HostToolName,
  type SkillHostToolName,
  type SkillToolPorts,
} from './tools.js'
export {
  REMOTE_API_VERSION,
  createRemoteApi,
  sanitizeRemoteError,
  type RemoteApi,
  type RemoteApiOptions,
  type RemoteAuthenticator,
  type RemoteCancelRunInput,
  type RemoteCredential,
  type RemoteEnvelope,
  type RemoteStartReplayInput,
} from './remote.js'
