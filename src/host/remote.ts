/**
 * Remote（只读 DTO + 受保护控制）边界（design/interfaces.md IF-7、
 * design/frontend.md IF-1：Activity Remote DTO）。
 *
 * 纪律：
 * - 认证凭据来自连接握手（`credential` 参数），绝不从 URL/query 读取；
 *   认证失败统一 `REMOTE_UNAUTHORIZED`，不区分“凭证无效/不存在”，避免探测；
 * - 查询只能缩小已认证 Session 的范围：query 里出现 ownerSessionId 之类身份键直接 `FORBIDDEN`；
 * - 所有查询返回公开 DTO 包（带独立 `apiVersion`），不返回 Store/BrowserDriver/Cua 对象；
 * - 写动作（开始回放/取消）走独立控制接口，要求操作者开关 + Session 所有权；
 * - 内部错误经 `toPublicError` 清洗，绝不把本机绝对路径、Cookie 或上游 payload 带给 UI。
 */
import {
  createPublicError,
  toPublicError,
  type Principal,
  type PublicError,
  type RecordingId,
  type RunId,
} from '../core/api.js'
import { assertSessionOwnership, type HostCallContext } from './principal.js'
import type {
  CuaRecordReplayService,
  Page,
  RecordingListQuery,
  RecordingStep,
  RecordingSummary,
  RunListQuery,
  RunSummary,
  StepListQuery,
} from './service.js'

/** Remote DTO 的独立版本（design/interfaces.md IF-7：Remote 单独 apiVersion）。 */
export const REMOTE_API_VERSION = '1' as const

/** 每个 Remote 响应都带 `apiVersion`：旧 UI 忽略未知字段，不因 Host 升级崩溃。 */
export interface RemoteEnvelope<T> {
  readonly apiVersion: typeof REMOTE_API_VERSION
  readonly data: T
}

/** 连接握手提供的凭证（不是 URL/query 参数）。 */
export interface RemoteCredential {
  readonly token: string
}

/** 把握手凭证换成 Principal；返回 undefined 表示认证失败。 */
export type RemoteAuthenticator = (
  credential: RemoteCredential | undefined,
) => Principal | undefined | Promise<Principal | undefined>

export interface RemoteApiOptions {
  readonly authenticate: RemoteAuthenticator
  /** 操作者开关：关闭时所有控制命令返回 `FEATURE_DISABLED`（默认关闭）。 */
  readonly controlsEnabled?: () => boolean
}

export interface RemoteStartReplayInput {
  readonly recordingId: RecordingId
  readonly ownerSessionId: string
  readonly idempotencyKey?: string
}

export interface RemoteCancelRunInput {
  readonly runId: RunId
  readonly ownerSessionId: string
}

export interface RemoteApi {
  listRecordings(
    query: RecordingListQuery,
    credential: RemoteCredential | undefined,
  ): Promise<RemoteEnvelope<Page<RecordingSummary>>>
  getRecording(
    recordingId: RecordingId,
    credential: RemoteCredential | undefined,
  ): Promise<RemoteEnvelope<RecordingSummary | null>>
  listSteps(
    recordingId: RecordingId,
    query: StepListQuery,
    credential: RemoteCredential | undefined,
  ): Promise<RemoteEnvelope<Page<RecordingStep>>>
  listRuns(
    query: RunListQuery,
    credential: RemoteCredential | undefined,
  ): Promise<RemoteEnvelope<Page<RunSummary>>>
  getRun(
    runId: RunId,
    credential: RemoteCredential | undefined,
  ): Promise<RemoteEnvelope<RunSummary | null>>
  startReplay(
    input: RemoteStartReplayInput,
    credential: RemoteCredential | undefined,
  ): Promise<RemoteEnvelope<RunSummary>>
  cancelRun(
    input: RemoteCancelRunInput,
    credential: RemoteCredential | undefined,
  ): Promise<RemoteEnvelope<RunSummary>>
}

/** 查询里禁止出现的身份键：查询参数只能缩小范围，不能指定别的 ownerSessionId。 */
const QUERY_IDENTITY_KEYS = ['ownerSessionId', 'owner', 'sessionId', 'principal', 'agentId'] as const

/**
 * 内部错误对外清洗：保留稳定码与定位 ID，抹掉路径/凭证。
 *
 * 未编码的内部异常落到 core 的兜底码 `INVALID_ARGUMENT`（Core 的错误码注册表里没有
 * 通用 INTERNAL/REMOTE_UNAVAILABLE 码；后者是连接层语义，不在本卡契约内，故不发明新码）。
 */
export function sanitizeRemoteError(error: unknown): PublicError {
  return toPublicError(error)
}

export function createRemoteApi(
  service: CuaRecordReplayService,
  options: RemoteApiOptions,
): RemoteApi {
  const authenticate = options.authenticate
  const controlsEnabled = options.controlsEnabled ?? ((): boolean => false)

  async function authenticated(credential: RemoteCredential | undefined): Promise<Principal> {
    let principal: Principal | undefined
    try {
      principal = await authenticate(credential)
    } catch {
      principal = undefined
    }
    if (
      principal === undefined
      || typeof principal.sessionId !== 'string'
      || principal.sessionId.length === 0
      || typeof principal.agentId !== 'string'
      || principal.agentId.length === 0
    ) {
      throw createPublicError('REMOTE_UNAUTHORIZED', 'Remote request is not authenticated')
    }
    return principal
  }

  const contextFor = (principal: Principal): HostCallContext => ({
    exec: { agent: { id: principal.agentId }, session: { id: principal.sessionId } },
  })

  async function read<T>(
    credential: RemoteCredential | undefined,
    work: (principal: Principal) => Promise<T>,
  ): Promise<RemoteEnvelope<T>> {
    try {
      const principal = await authenticated(credential)
      return { apiVersion: REMOTE_API_VERSION, data: await work(principal) }
    } catch (error) {
      throw sanitizeRemoteError(error)
    }
  }

  async function control<T>(
    credential: RemoteCredential | undefined,
    ownerSessionId: string,
    work: (principal: Principal) => Promise<T>,
  ): Promise<RemoteEnvelope<T>> {
    try {
      const principal = await authenticated(credential)
      // 操作者开关先于所有权判断：关闭时不泄露资源是否存在。
      if (!controlsEnabled()) {
        throw createPublicError('FEATURE_DISABLED', 'Operator controls are disabled; enable them before changing runs')
      }
      assertSessionOwnership(principal, ownerSessionId)
      return { apiVersion: REMOTE_API_VERSION, data: await work(principal) }
    } catch (error) {
      throw sanitizeRemoteError(error)
    }
  }

  return {
    listRecordings: async (query, credential) => {
      rejectIdentityQuery(query, 'listRecordings')
      return read(credential, principal => service.listRecordings(query, contextFor(principal)))
    },

    getRecording: (recordingId, credential) => {
      return read(credential, async principal => {
        const summary = await service.getRecording(recordingId, contextFor(principal))
        return summary ?? null
      })
    },

    listSteps: async (recordingId, query, credential) => {
      rejectIdentityQuery(query, 'listSteps')
      return read(credential, principal => service.listSteps(recordingId, query, contextFor(principal)))
    },

    listRuns: async (query, credential) => {
      rejectIdentityQuery(query, 'listRuns')
      return read(credential, principal => service.listRuns(query, contextFor(principal)))
    },

    getRun: (runId, credential) => {
      return read(credential, async principal => {
        const run = await service.getRun(runId, contextFor(principal))
        return run ?? null
      })
    },

    startReplay: (input, credential) => {
      return control(credential, input.ownerSessionId, principal => service.startReplay({
        recordingId: input.recordingId,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      }, contextFor(principal)))
    },

    cancelRun: (input, credential) => {
      return control(credential, input.ownerSessionId, principal => service.cancelRun(input.runId, contextFor(principal)))
    },
  }
}

function rejectIdentityQuery(query: unknown, operation: string): void {
  if (typeof query !== 'object' || query === null) return
  for (const key of QUERY_IDENTITY_KEYS) {
    if ((query as Readonly<Record<string, unknown>>)[key] !== undefined) {
      throw createPublicError(
        'FORBIDDEN',
        `${operation} cannot select another ownerSessionId; a query may only narrow the authenticated session's data`,
      )
    }
  }
}
