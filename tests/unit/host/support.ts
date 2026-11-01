/**
 * Host 单测共用的小工具：操作上下文、开关配置与步骤事件记录器。
 */
import type { OperationContext } from '../../../src/core/api.js'
import { resolveHostConfig, type HostConfig } from '../../../src/host/config.js'
import type { HostCallContext } from '../../../src/host/principal.js'
import type {
  OperationEventSink,
  OperationStepEvent,
  StepFinishedEvent,
  StepStartedEvent,
} from '../../../src/driver/operation-runner.js'

export interface ExecIdentity {
  readonly agentId?: string
  readonly sessionId?: string
}

/** 构造 Host 执行上下文（identity 缺省齐全；显式传 undefined 可模拟身份缺失）。 */
export function execFor(identity: { readonly agentId?: string | undefined; readonly sessionId?: string | undefined } = {}): HostCallContext {
  return {
    exec: {
      ...(identity.agentId === undefined ? {} : { agent: { id: identity.agentId } }),
      ...(identity.sessionId === undefined ? {} : { session: { id: identity.sessionId } }),
    },
  }
}

/** 默认身份齐全的调用上下文。 */
export function callFor(
  sessionId = 'session-a',
  extra: { readonly callId?: string; readonly signal?: AbortSignal } = {},
): HostCallContext {
  return {
    exec: { agent: { id: `agent-${sessionId}` }, session: { id: sessionId } },
    ...(extra.callId === undefined ? {} : { callId: extra.callId }),
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  }
}

export function operationContext(
  sessionId = 'session-a',
  options: {
    readonly callId?: string
    readonly origin?: OperationContext['origin']
    readonly signal?: AbortSignal
  } = {},
): OperationContext {
  return {
    principal: { sessionId, agentId: `agent-${sessionId}` },
    callId: options.callId ?? `call-${sessionId}`,
    origin: options.origin ?? 'agent',
    signal: options.signal ?? new AbortController().signal,
  }
}

/** 三项功能全部显式关闭的配置（默认值是开启的，所以这里不能靠空对象）。 */
export function disabledConfig(): HostConfig {
  return resolveHostConfig({
    recording: { enabled: false },
    replay: { enabled: false },
    skill: { enabled: false },
  })
}

/** 录制与回放都开启的配置。 */
export function enabledConfig(overrides: { readonly recording?: boolean; readonly replay?: boolean } = {}): HostConfig {
  return resolveHostConfig({
    recording: { enabled: overrides.recording ?? true },
    replay: { enabled: overrides.replay ?? true },
  })
}

/** 记录步骤事件；可按事件类型注入写入失败（模拟录制层停止执行）。 */
export class RecordingSink implements OperationEventSink {
  readonly events: OperationStepEvent[] = []
  failOn: 'step.started' | 'step.finished' | undefined

  async record(event: OperationStepEvent): Promise<void> {
    if (this.failOn === event.type) {
      const error = new Error('recording write failed') as Error & { code: string }
      error.code = 'RECORDING_LIMIT_EXCEEDED'
      throw error
    }
    this.events.push(event)
  }

  get started(): StepStartedEvent[] {
    return this.events.filter((event): event is StepStartedEvent => event.type === 'step.started')
  }

  get finished(): StepFinishedEvent[] {
    return this.events.filter((event): event is StepFinishedEvent => event.type === 'step.finished')
  }
}

/** 固定时钟：每次调用返回下一个刻度，便于断言 durationMs。 */
export function walkingClock(start = 1_000, step = 5): () => number {
  let current = start - step
  return () => {
    current += step
    return current
  }
}
