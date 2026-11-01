import { describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue } from '../../../src/core/api.js'
import { createDesktopTools } from '../../../src/plugin/desktop-tools.js'
import type { HostCallContext } from '../../../src/host/index.js'
import type { CuaToolResult } from '../../../src/cua/transport.js'

function result(data: JsonObject): CuaToolResult {
  return { content: [], structuredContent: data as unknown as JsonValue }
}

const call = {
  exec: { agent: { id: 'agent-test', session: { id: 'session-desktop' } } },
} as unknown as HostCallContext

function fakeToolkit() {
  const calls: Array<{ name: string; args: JsonObject }> = []
  const caller = {
    callTool: async (name: string, args: JsonObject): Promise<CuaToolResult> => {
      calls.push({ name, args })
      if (name === 'get_window_state') {
        return result({
          window_title: 'DeepSeek Harness',
          snapshot_id: 's1',
          elements: [
            { element_token: 's1:0', role: 'AXButton', label: '插件', enabled: true },
            { element_token: 's1:1', role: 'AXTextField', label: '搜索', enabled: true },
          ],
        })
      }
      return result({ status: 'ok' })
    },
  }
  return { calls, tools: createDesktopTools(async () => caller) }
}

function toolOf(tools: ReturnType<typeof createDesktopTools>, name: string) {
  const found = tools.find(tool => tool.name === name)
  if (found === undefined) throw new Error(`missing tool ${name}`)
  return found
}

describe('plugin/desktop-tools', () => {
  it('snapshots a window and lists AX elements', async () => {
    const { tools } = fakeToolkit()
    const state = await toolOf(tools, 'cua_desktop_state').handle({ pid: 42, windowId: 7 }, call) as {
      readonly title: string
      readonly count: number
      readonly elements: readonly { readonly role: string }[]
    }
    expect(state.title).toBe('DeepSeek Harness')
    expect(state.count).toBe(2)
    expect(state.elements.map(element => element.role)).toEqual(['AXButton', 'AXTextField'])
  })

  it('clicks and asserts through the AX snapshot', async () => {
    const { calls, tools } = fakeToolkit()
    await expect(toolOf(tools, 'cua_desktop_click').handle(
      { pid: 42, windowId: 7, role: 'AXButton', name: '插件' }, call,
    )).resolves.toEqual({ ok: true })
    expect(calls.find(entry => entry.name === 'click')?.args).toMatchObject({ element_token: 's1:0' })

    await expect(toolOf(tools, 'cua_desktop_assert').handle(
      { pid: 42, windowId: 7, role: 'AXButton', labelContains: '插件', exists: true }, call,
    )).resolves.toEqual({ ok: true })
    await expect(toolOf(tools, 'cua_desktop_assert').handle(
      { pid: 42, windowId: 7, role: 'AXButton', labelContains: '插件', exists: false }, call,
    )).rejects.toMatchObject({ code: 'ASSERTION_FAILED' })
  })

  it('validates window and target arguments', async () => {
    const { tools } = fakeToolkit()
    await expect(toolOf(tools, 'cua_desktop_state').handle({ pid: 0, windowId: 7 }, call))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(toolOf(tools, 'cua_desktop_click').handle({ pid: 42, windowId: 7 }, call))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})
