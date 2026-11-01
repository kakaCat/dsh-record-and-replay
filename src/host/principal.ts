/**
 * Principal 派生与 Session 所有权校验（design/interfaces.md IF-7、
 * design/backend.md `host/principal`：从执行上下文生成 Principal，禁止网页伪造）。
 *
 * 安全不变量：
 * - Principal **只能**从 Host 的执行上下文（`exec.agent.id` + Session 绑定）派生；
 * - 工具参数里出现 `ownerSessionId` / `sessionId` / `principal` / `agentId` 等身份键，
 *   一律视为伪造尝试并返回 `FORBIDDEN`——不静默忽略，也不把它们当作“提示”；
 * - Remote 控制命令要求显式 Session 所有权，并且必须与已认证的 Principal 一致。
 */
import type { Principal } from '../core/api.js'
import { HostError } from './config.js'

/**
 * DSH Host 的执行上下文（本包只需要其中的身份字段，不绑定具体插件框架）。
 * `agent.id` 与 `session.id` 都由 Host 注入，不是网页或工具参数能控制的值。
 */
export interface AgentExecutionContext {
  readonly agent?: { readonly id?: string } | undefined
  readonly session?: { readonly id?: string } | undefined
}

/** Host 工具/服务的一次调用上下文：身份来自 exec，callId/signal 由 Host 适配层给出。 */
export interface HostCallContext {
  readonly exec: AgentExecutionContext
  readonly callId?: string
  readonly signal?: AbortSignal
}

/** 调用方不得自行提供的身份键（顶层或嵌套出现都拒绝）。 */
const PRINCIPAL_KEYS: ReadonlySet<string> = new Set([
  'ownerSessionId',
  'owner',
  'sessionId',
  'session',
  'principal',
  'agentId',
  'agentID',
  'ownerAgentId',
])

/** 递归扫描参数里的身份键；深度有界，避免对深层结构做无意义的遍历。 */
const MAX_SCAN_DEPTH = 5

/** 从 Host 执行上下文派生 Principal；身份缺失是形状错误（`INVALID_ARGUMENT`）。 */
export function derivePrincipal(exec: AgentExecutionContext | undefined): Principal {
  const agentId = nonEmpty(exec?.agent?.id)
  const sessionId = nonEmpty(exec?.session?.id)
  if (agentId === undefined || sessionId === undefined) {
    throw new HostError(
      'INVALID_ARGUMENT',
      'Host execution context is missing agent.id or session.id; the Principal is derived from the execution context only',
    )
  }
  return { sessionId, agentId }
}

/**
 * 拒绝调用方自带的身份参数（design/interfaces.md 跨关注点：“不接受 ownerSessionId 参数”）。
 *
 * 只拒绝**有值**的身份键：`ownerSessionId: undefined` 不构成伪造，也不携带信息。
 */
export function assertNoCallerSuppliedPrincipal(value: unknown, path = 'arguments'): void {
  scanForPrincipalKeys(value, path, 0)
}

/** Session 所有权：控制命令必须显式声明所有者，且与已认证 Principal 完全一致。 */
export function assertSessionOwnership(principal: Principal, ownerSessionId: unknown): void {
  const owner = nonEmpty(ownerSessionId)
  if (owner === undefined) {
    throw new HostError('FORBIDDEN', 'Control commands require an explicit ownerSessionId')
  }
  if (owner !== principal.sessionId) {
    throw new HostError('FORBIDDEN', 'The authenticated session does not own this resource')
  }
}

function scanForPrincipalKeys(value: unknown, path: string, depth: number): void {
  if (depth > MAX_SCAN_DEPTH || typeof value !== 'object' || value === null) return

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      scanForPrincipalKeys(entry, `${path}[${String(index)}]`, depth + 1)
    })
    return
  }

  for (const [key, child] of Object.entries(value)) {
    if (PRINCIPAL_KEYS.has(key) && child !== undefined) {
      throw new HostError(
        'FORBIDDEN',
        `"${path}.${key}" must not be supplied by the caller; the Principal comes from the Host execution context`,
      )
    }
    scanForPrincipalKeys(child, `${path}.${key}`, depth + 1)
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
