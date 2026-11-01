import { describe, expect, it, vi } from 'vitest'

import { createDshSkillModelPort, type SkillModelExecLike } from '../../../src/plugin/skill-model.js'

function context(service: unknown): { get(name: string): unknown } {
  return { get: (name: string) => (name === 'llm' ? service : undefined) }
}

function exec(route: { provider: string; model: string } | undefined): SkillModelExecLike {
  return {
    agent: {
      session: {
        requestHeader: () => (route === undefined
          ? undefined
          : { config: { provider: route.provider, model: route.model } }),
      },
    },
  }
}

function streamOf(chunks: readonly unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

describe('DSH skill model port', () => {
  it('collects text deltas from the session route', async () => {
    const llm = {
      stream: vi.fn(() => streamOf([
        { type: 'text-delta', index: 0, text: '{"summary":' },
        { type: 'text-delta', index: 0, text: '"ok"}' },
        { type: 'finish', reason: { kind: 'stop' } },
      ])),
    }
    const port = createDshSkillModelPort({
      ctx: context(llm),
      exec: exec({ provider: 'deepseek', model: 'deepseek-chat' }),
    })
    expect(port?.id).toBe('dsh:deepseek/deepseek-chat')
    await expect(port?.complete({ prompt: 'draft' })).resolves.toBe('{"summary":"ok"}')
    expect(llm.stream).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'draft' }] }],
    }))
  })

  it('returns undefined without a model service or a session route', () => {
    expect(createDshSkillModelPort({ ctx: context(undefined), exec: exec({ provider: 'p', model: 'm' }) }))
      .toBeUndefined()
    expect(createDshSkillModelPort({ ctx: context({ stream: () => streamOf([]) }), exec: exec(undefined) }))
      .toBeUndefined()
  })

  it('rejects an errored or empty stream', async () => {
    const errored = createDshSkillModelPort({
      ctx: context({ stream: () => streamOf([{ type: 'finish', reason: { kind: 'error' } }]) }),
      exec: exec({ provider: 'p', model: 'm' }),
    })
    await expect(errored?.complete({ prompt: 'x' })).rejects.toThrow(/finished with error/)

    const empty = createDshSkillModelPort({
      ctx: context({ stream: () => streamOf([{ type: 'finish', reason: { kind: 'stop' } }]) }),
      exec: exec({ provider: 'p', model: 'm' }),
    })
    await expect(empty?.complete({ prompt: 'x' })).rejects.toThrow(/no text/)
  })
})
