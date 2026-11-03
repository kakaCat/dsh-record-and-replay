import { describe, expect, it } from 'vitest'

import { apply, name } from '../../../src/plugin/desktop.js'

interface RegisteredTool {
  readonly name: string
}

function applyWithFakeContext(): RegisteredTool[] {
  const tools: RegisteredTool[] = []
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
    },
    effect: (run: () => unknown) => {
      run()
    },
  }
  apply(ctx)
  return tools
}

describe('plugin/desktop entry (record-replay-desktop line)', () => {
  it('mounts under its own plugin name', () => {
    expect(name).toBe('dsh-record-replay/desktop')
  })

  it('registers exactly the 8 desktop tools and nothing else', () => {
    const tools = applyWithFakeContext()
    expect(tools.map(tool => tool.name)).toEqual([
      'cua_desktop_state',
      'cua_desktop_click',
      'cua_desktop_set_value',
      'cua_desktop_press_key',
      'cua_desktop_scroll',
      'cua_desktop_drag',
      'cua_desktop_assert',
      'cua_desktop_screenshot',
    ])
  })
})
