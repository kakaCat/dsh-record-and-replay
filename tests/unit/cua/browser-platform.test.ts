import { describe, expect, it, vi } from 'vitest'
import { CuaBrowserDriver } from '../../../src/cua/browser-driver.js'
import type { OperationContext } from '../../../src/core/api.js'

const context: OperationContext = {
  principal: { sessionId: 'session-platform', agentId: 'agent-platform' },
  callId: 'bind-desktop',
  origin: 'internal',
  signal: AbortSignal.timeout(5_000),
}

describe('cua/browser-driver platform boundary', () => {
  it('refuses desktop bindings before calling Cua on non-macOS platforms', async () => {
    const callTool = vi.fn()
    const driver = new CuaBrowserDriver({ callTool }, undefined, { platform: 'win32' })

    await expect(driver.bind({ launch: 'desktop', pid: 42, windowId: 7 }, context)).rejects.toMatchObject({
      code: 'ACTION_UNSUPPORTED',
    })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('keeps desktop bindings available on macOS', async () => {
    const driver = new CuaBrowserDriver({
      callTool: async () => ({
        content: [{ type: 'text', text: '{"snapshot_id":"s1","elements":[]}' }],
      }),
    }, undefined, { platform: 'darwin' })

    const binding = await driver.bind({ launch: 'desktop', pid: 42, windowId: 7 }, context)
    expect(binding.driverId).toBe('cua-desktop')
  })
})
