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

function applyWithFakeContext(config: Record<string, unknown> = {}): { tools: RegisteredTool[]; routes: RegisteredRoute[] } {
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
  apply(ctx, config)
  return { tools, routes }
}

describe('plugin apply registry', () => {
  it('registers 19 uniquely named tools by default', () => {
    const { tools } = applyWithFakeContext()
    expect(tools).toHaveLength(19)
    const names = tools.map(tool => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('leaves suite regression off the model surface', () => {
    const { tools } = applyWithFakeContext()
    expect(tools.map(tool => tool.name)).not.toContain('cua_test_run')
  })

  it('keeps the desktop tool family out of the main line entirely', () => {
    // 桌面工具由独立插件行 record-replay-desktop 注册（cordis.patch.yml 缺省关闭），
    // 主线任何配置下都不该出现 cua_desktop_*。
    const { tools } = applyWithFakeContext()
    const names = tools.map(tool => tool.name)
    expect(names.some(name => name.startsWith('cua_desktop_'))).toBe(false)
  })

  it('skips tools that can only answer FEATURE_DISABLED', () => {
    const recordingOff = applyWithFakeContext({ recording: { enabled: false } }).tools.map(tool => tool.name)
    expect(recordingOff).toHaveLength(15)
    expect(recordingOff).not.toContain('cua_record_start')
    expect(recordingOff).not.toContain('cua_record_bind_browser')
    expect(recordingOff).not.toContain('cua_record_observe')
    expect(recordingOff).not.toContain('cua_record_action')
    // 收尾与只读工具在开关关闭后仍然可用。
    expect(recordingOff).toEqual(expect.arrayContaining([
      'cua_record_stop',
      'cua_record_discard',
      'cua_record_export',
      'cua_record_query',
    ]))

    const replayOff = applyWithFakeContext({ replay: { enabled: false } }).tools.map(tool => tool.name)
    expect(replayOff).toHaveLength(18)
    expect(replayOff).not.toContain('cua_replay_start')
    expect(replayOff).toContain('cua_replay_cancel')

    const skillOff = applyWithFakeContext({ skill: { enabled: false } }).tools.map(tool => tool.name)
    expect(skillOff).toHaveLength(16)
    expect(skillOff).not.toContain('cua_skill_generate')
    expect(skillOff).not.toContain('cua_skill_install')
    expect(skillOff).not.toContain('cua_skill_feedback')
    expect(skillOff).toEqual(expect.arrayContaining([
      'cua_skill_review',
      'cua_skill_search',
      'cua_skill_load',
    ]))
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
    expect(tools).toHaveLength(19)
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
