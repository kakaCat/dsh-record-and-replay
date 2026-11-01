/**
 * DSH model port for `cua_skill_generate mode: "model"`.
 *
 * The plugin does not depend on `@deepseek-ai/dsh-llm`; it consumes the mounted
 * `llm` service structurally. The route comes from the calling session's latest
 * request header (the same provider/model the user is already talking to), so a
 * one-shot drafting call does not invent a route or read credentials.
 */
import type { SkillModelPort, SkillModelRequest } from '../skill/drafting.js'

interface LlmStreamChunkLike {
  readonly type?: unknown
  readonly text?: unknown
  readonly block?: { readonly type?: unknown; readonly text?: unknown } | undefined
  readonly reason?: { readonly kind?: unknown } | undefined
}

interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<LlmStreamChunkLike>
}

interface ServiceContextLike {
  readonly llm?: unknown
  get?(name: string): unknown
}

interface SessionHeaderLike {
  readonly config?: {
    readonly provider?: unknown
    readonly model?: unknown
    readonly reasoningEffort?: unknown
  }
}

export interface SkillModelExecLike {
  readonly agent?: {
    readonly session?: {
      requestHeader?: () => SessionHeaderLike | undefined
    }
  }
}

export interface SkillModelPortOptions {
  readonly ctx: ServiceContextLike
  readonly exec: SkillModelExecLike
  readonly signal?: AbortSignal
}

function llmOf(ctx: ServiceContextLike): LlmLike | undefined {
  let service: unknown = ctx.llm
  if (service === undefined) {
    try {
      service = ctx.get?.('llm')
    } catch {
      return undefined
    }
  }
  if (typeof service !== 'object' || service === null) return undefined
  const stream = (service as { stream?: unknown }).stream
  return typeof stream === 'function' ? service as LlmLike : undefined
}

function routeOf(exec: SkillModelExecLike): { provider: string; model: string; reasoningEffort?: unknown } | undefined {
  const config = exec.agent?.session?.requestHeader?.()?.config
  const provider = config?.provider
  const model = config?.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return {
    provider,
    model,
    ...(config?.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  }
}

function combineSignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}

/** Returns undefined when no model service or no resolved route is available. */
export function createDshSkillModelPort(options: SkillModelPortOptions): SkillModelPort | undefined {
  const llm = llmOf(options.ctx)
  if (llm === undefined) return undefined
  const route = routeOf(options.exec)
  if (route === undefined) return undefined

  return {
    id: `dsh:${route.provider}/${route.model}`,
    async complete(request: SkillModelRequest): Promise<string> {
      const signal = combineSignal([options.signal, request.signal, AbortSignal.timeout(120_000)])
      const chunks = llm.stream({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(signal === undefined ? {} : { signal }),
      })
      let text = ''
      for await (const chunk of chunks) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
          continue
        }
        if (chunk.type === 'block-end' && text.length === 0
          && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
          text = chunk.block.text
          continue
        }
        if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            throw new Error(`model stream finished with ${String(kind)}`)
          }
        }
      }
      if (text.trim().length === 0) throw new Error('model returned no text')
      return text
    },
  }
}
