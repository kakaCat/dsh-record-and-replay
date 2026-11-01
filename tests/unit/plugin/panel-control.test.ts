import { describe, expect, it, vi } from 'vitest'

import { createPanelRecordingControlPort } from '../../../src/plugin/panel-control.js'

const manifest = {
  recordingId: 'rec_live',
  ownerSessionId: 'session-owner',
  title: 'Live',
  status: 'recording',
} as const

describe('panel recording control port', () => {
  it('uses the manifest owner session as the principal for stop and discard', async () => {
    const stop = vi.fn(async () => ({
      recordingId: 'rec_live',
      status: 'completed' as const,
      endReason: 'tool_stopped' as const,
    }))
    const discard = vi.fn(async () => ({
      recordingId: 'rec_live',
      status: 'cancelled' as const,
      endReason: 'cancelled' as const,
    }))
    const port = createPanelRecordingControlPort({
      runtimeForRoot: async () => ({
        store: { readManifest: async () => manifest as never },
        recordings: { stop: stop as never, discard: discard as never },
      }),
    })

    await expect(port.stop({ root: '/tmp/project', recordingId: 'rec_live' }))
      .resolves.toEqual({ recordingId: 'rec_live', status: 'completed', endReason: 'tool_stopped' })
    await expect(port.discard({ root: '/tmp/project', recordingId: 'rec_live' }))
      .resolves.toEqual({ recordingId: 'rec_live', status: 'cancelled', endReason: 'cancelled' })

    expect(stop).toHaveBeenCalledWith('rec_live', { sessionId: 'session-owner', agentId: 'panel-operator' })
    expect(discard).toHaveBeenCalledWith('rec_live', { sessionId: 'session-owner', agentId: 'panel-operator' })
  })
})
