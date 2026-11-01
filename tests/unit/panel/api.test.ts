import { describe, expect, it, vi } from 'vitest'

import { createPanelApi } from '../../../src/client/panel/api.js'

function jsonFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify({ projects: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
}

describe('panel api prefixes', () => {
  it('builds DSH same-origin URLs under /api/record-replay', async () => {
    const fetchImpl = jsonFetch()
    const api = createPanelApi('/api/record-replay', fetchImpl as unknown as typeof fetch)

    await api.listProjects()

    expect(fetchImpl).toHaveBeenCalledWith('/api/record-replay/projects', expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
    }))
    expect(api.videoUrl('/tmp/demo', 'run_abc')).toBe(
      '/api/record-replay/video?root=%2Ftmp%2Fdemo&runId=run_abc',
    )
  })

  it('builds M2 search/stats/pagination URLs', async () => {
    const fetchImpl = jsonFetch()
    const api = createPanelApi('/api/record-replay', fetchImpl as unknown as typeof fetch)

    await api.searchAll('alpha', { limit: 25 })
    expect(fetchImpl).toHaveBeenLastCalledWith(
      '/api/record-replay/search?q=alpha&limit=25',
      expect.anything(),
    )

    await api.stats()
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/record-replay/stats', expect.anything())

    await api.getProject('/tmp/demo', { limit: 50, offset: 100 })
    expect(fetchImpl).toHaveBeenLastCalledWith(
      '/api/record-replay/project?root=%2Ftmp%2Fdemo&limit=50&offset=100',
      expect.anything(),
    )

    await api.listProjectsPage?.({ limit: 50, offset: 0 })
    expect(fetchImpl).toHaveBeenLastCalledWith(
      '/api/record-replay/projects?limit=50&offset=0',
      expect.anything(),
    )
  })

  it('builds live HUD active/stop/discard URLs', async () => {
    const fetchImpl = jsonFetch()
    const api = createPanelApi('/api/record-replay', fetchImpl as unknown as typeof fetch)

    await api.listActive?.('/tmp/demo')
    expect(fetchImpl).toHaveBeenLastCalledWith(
      '/api/record-replay/active?root=%2Ftmp%2Fdemo',
      expect.objectContaining({ method: 'GET' }),
    )

    await api.actions?.stop('/tmp/demo', 'rec_live')
    expect(fetchImpl).toHaveBeenLastCalledWith(
      '/api/record-replay/stop',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ root: '/tmp/demo', recordingId: 'rec_live' }) }),
    )

    await api.actions?.discard('/tmp/demo', 'rec_live')
    expect(fetchImpl).toHaveBeenLastCalledWith(
      '/api/record-replay/discard',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ root: '/tmp/demo', recordingId: 'rec_live' }) }),
    )
  })

  it('keeps the standalone /panel prefix working and trims a trailing slash', async () => {
    const fetchImpl = jsonFetch()
    const api = createPanelApi('/panel/', fetchImpl as unknown as typeof fetch)

    await api.listProjects()

    expect(fetchImpl).toHaveBeenCalledWith('/panel/projects', expect.anything())
    expect(api.videoUrl('/tmp/demo', 'run_abc', { download: true })).toBe(
      '/panel/video?root=%2Ftmp%2Fdemo&runId=run_abc&download=1',
    )
  })
})
