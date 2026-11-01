import { describe, expect, it } from 'vitest'

import { apply, assertRecordingConsent } from '../../../src/plugin/index.js'

interface RegisteredTool {
  readonly name: string
  readonly parameters?: {
    readonly properties?: Readonly<Record<string, unknown>>
    readonly required?: readonly string[]
  }
}

interface RegisteredRoute {
  readonly path: string
}

function applyWithFakeContext(): { tools: RegisteredTool[]; routes: RegisteredRoute[] } {
  const tools: RegisteredTool[] = []
  const routes: RegisteredRoute[] = []
  const ctx = {
    logger: () => ({ info: () => undefined, warn: () => undefined }),
    inject: (services: string[], callback: (scope: unknown) => void) => {
      if (services.includes('tools')) {
        callback({
          effect: (run: () => void) => run(),
          tools: {
            register: (tool: RegisteredTool) => {
              tools.push(tool)
              return () => undefined
            },
          },
        })
      }
      if (services.includes('connection')) {
        callback({
          effect: (run: () => void) => run(),
          connection: {
            fetch: {
              register: (route: RegisteredRoute) => {
                routes.push(route)
                return () => undefined
              },
            },
          },
        })
      }
      if (services.includes('commands')) {
        callback({
          effect: (run: () => unknown) => {
            run()
          },
          commands: { register: () => () => undefined },
        })
      }
    },
    effect: (run: () => unknown) => {
      run()
    },
  }
  apply(ctx, {})
  return { tools, routes }
}

describe('plugin apply registry', () => {
  it('registers 28 uniquely named tools with a fake context', () => {
    const { tools } = applyWithFakeContext()
    expect(tools).toHaveLength(28)
    const names = tools.map(tool => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('declares the optional intent on cua_record_start', () => {
    const { tools } = applyWithFakeContext()
    const start = tools.find(tool => tool.name === 'cua_record_start')
    expect(start?.parameters?.properties?.['intent']).toMatchObject({ type: 'string' })
    expect(start?.parameters?.properties?.['title']).toMatchObject({ type: 'string' })
    expect(start?.parameters?.required ?? []).toContain('title')
    expect(start?.parameters?.required ?? []).not.toContain('intent')
    expect(start?.parameters?.properties?.['consent']).toMatchObject({ type: 'boolean' })
  })

  it('exposes cua_record_export with an optional workspace-relative destination', () => {
    const { tools } = applyWithFakeContext()
    const exported = tools.find(tool => tool.name === 'cua_record_export')
    expect(exported?.parameters?.properties?.['recordingId']).toMatchObject({ type: 'string' })
    expect(exported?.parameters?.properties?.['destination']).toMatchObject({ type: 'string' })
    expect(exported?.parameters?.required ?? []).toEqual(['recordingId'])
  })

  it('exposes the optional model mode on cua_skill_generate', () => {
    const { tools } = applyWithFakeContext()
    const generate = tools.find(tool => tool.name === 'cua_skill_generate')
    expect(generate?.parameters?.properties?.['mode']).toMatchObject({
      type: 'string',
      enum: ['template', 'model'],
    })
    expect(generate?.parameters?.required ?? []).not.toContain('mode')
  })

  it('enforces the recording consent policy', () => {
    expect(() => assertRecordingConsent('explicit', undefined)).toThrow(/consent/)
    expect(() => assertRecordingConsent('explicit', false)).toThrow(/declined/)
    expect(() => assertRecordingConsent('explicit', true)).not.toThrow()
    expect(() => assertRecordingConsent('implicit', undefined)).not.toThrow()
    expect(() => assertRecordingConsent('implicit', false)).toThrow(/declined/)
    expect(() => assertRecordingConsent('off', undefined)).not.toThrow()
    expect(() => assertRecordingConsent('off', false)).toThrow(/declined/)
  })

  it('registers cua_record_discard next to start/stop', () => {
    const { tools } = applyWithFakeContext()
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'cua_record_start',
      'cua_record_stop',
      'cua_record_discard',
    ]))
    const discard = tools.find(tool => tool.name === 'cua_record_discard')
    expect(discard?.parameters?.properties?.['recordingId']).toMatchObject({ type: 'string' })
  })

  it('registers the panel read and M3-lite write routes without adding tools', () => {
    const { tools, routes } = applyWithFakeContext()
    expect(tools).toHaveLength(28)
    expect(routes.map(route => route.path)).toEqual([
      '/api/record-replay/projects',
      '/api/record-replay/project',
      '/api/record-replay/recording',
      '/api/record-replay/search',
      '/api/record-replay/stats',
      '/api/record-replay/capabilities',
      '/api/record-replay/active',
      '/api/record-replay/stop',
      '/api/record-replay/discard',
      '/api/record-replay/replay',
      '/api/record-replay/trash',
      '/api/record-replay/root',
      '/api/record-replay/video',
      '/api/record-replay/category',
      '/api/record-replay/scenario',
    ])
    const names = tools.map(tool => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
