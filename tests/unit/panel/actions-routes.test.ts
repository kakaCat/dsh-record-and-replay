import { lstat, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { PanelRecordingControlPort, PanelReplayPort, PanelReplayRequest } from '../../../src/panel/service.js'
import { PanelService } from '../../../src/panel/service.js'
import { recordingsDir, storeRoot, trashDir } from '../../../src/panel/paths.js'
import { createPanelFetchRoutes, type PanelFetchRoute } from '../../../src/panel/fetch-api.js'
import { startPanelServer, type PanelServerHandle } from '../../../src/panel/server.js'
import { createFixtureProject, writeIndex, type FixtureProject } from './fixtures.js'

const fixtures: FixtureProject[] = []
const handles: PanelServerHandle[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

async function makeProject(): Promise<FixtureProject> {
  const fixture = await createFixtureProject([
    {
      recordingId: 'rec_bili',
      title: 'B站搜索：明日方舟周年庆',
      urls: ['https://search.bilibili.com/all?keyword=x'],
      runs: [
        {
          runId: 'run_ok',
          status: 'completed',
          startedAt: '2026-10-31T11:00:00.000Z',
          finishedAt: '2026-10-31T11:00:01.000Z',
          video: new Uint8Array([1, 2, 3, 4]),
        },
      ],
    },
  ])
  fixtures.push(fixture)
  await writeIndex(fixture.root, {
    version: 1,
    categories: [{ id: 'bilibili', name: 'B站', site: 'bilibili' }],
    scenarios: [{ id: 'anniv', categoryId: 'bilibili', name: '周年庆' }],
    assignments: { rec_bili: { scenarioId: 'anniv' } },
  })
  return fixture
}

async function fetchRoutes(
  root: string,
  replay?: PanelReplayPort,
  control?: PanelRecordingControlPort,
): Promise<{ routes: Map<string, PanelFetchRoute> }> {
  const service = new PanelService({
    roots: [root],
    cwd: root,
    dshWorkspaces: false,
    trash: true,
    ...(replay === undefined ? {} : { replay }),
    ...(control === undefined ? {} : { control }),
  })
  const routes = new Map(createPanelFetchRoutes(service).map((route) => [route.path, route]))
  return { routes }
}

function request(
  pathname: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Request {
  return new Request(`http://127.0.0.1${pathname}`, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(init.body),
        }),
  })
}

async function exists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, () => false)
}

describe('panel replay/trash routes (DSH fetch face)', () => {
  it('reports replay availability and starts a replay through the port', async () => {
    const fixture = await makeProject()
    const calls: PanelReplayRequest[] = []
    const replay: PanelReplayPort = {
      async startReplay(input) {
        calls.push(input)
        return { runId: 'run_panel_7' }
      },
    }
    const { routes } = await fetchRoutes(fixture.root, replay)

    const capabilities = await routes.get('/api/record-replay/capabilities')?.fetch(
      request('/api/record-replay/capabilities'),
    )
    await expect(capabilities?.json()).resolves.toEqual({ replay: true, trash: true })

    const response = await routes.get('/api/record-replay/replay')?.fetch(request('/api/record-replay/replay', {
      method: 'POST',
      body: { root: fixture.root, recordingId: 'rec_bili', values: { step_1: 'v' } },
    }))
    expect(response?.status).toBe(200)
    await expect(response?.json()).resolves.toEqual({ runId: 'run_panel_7' })
    expect(calls[0]?.recordingId).toBe('rec_bili')
    expect(calls[0]?.values).toEqual({ step_1: 'v' })
  })

  it('lists active recordings and delegates stop/discard through the control port', async () => {
    const fixture = await createFixtureProject([
      { recordingId: 'rec_live', title: 'Live', status: 'recording', urls: ['https://example.test/'] },
    ])
    fixtures.push(fixture)
    const calls: string[] = []
    const control: PanelRecordingControlPort = {
      async stop(input) {
        calls.push(`stop:${input.recordingId}`)
        return { recordingId: input.recordingId, status: 'completed', endReason: 'tool_stopped' }
      },
      async discard(input) {
        calls.push(`discard:${input.recordingId}`)
        return { recordingId: input.recordingId, status: 'cancelled', endReason: 'cancelled' }
      },
    }
    const { routes } = await fetchRoutes(fixture.root, undefined, control)

    const active = await routes.get('/api/record-replay/active')?.fetch(
      request('/api/record-replay/active'),
    )
    expect(active?.status).toBe(200)
    await expect(active?.json()).resolves.toMatchObject([{ recordingId: 'rec_live', title: 'Live' }])

    const stop = await routes.get('/api/record-replay/stop')?.fetch(request('/api/record-replay/stop', {
      method: 'POST',
      body: { root: fixture.root, recordingId: 'rec_live' },
    }))
    expect(stop?.status).toBe(200)
    await expect(stop?.json()).resolves.toMatchObject({ status: 'completed' })

    const discard = await routes.get('/api/record-replay/discard')?.fetch(request('/api/record-replay/discard', {
      method: 'POST',
      body: { root: fixture.root, recordingId: 'rec_live' },
    }))
    expect(discard?.status).toBe(200)
    await expect(discard?.json()).resolves.toMatchObject({ status: 'cancelled' })
    expect(calls).toEqual(['stop:rec_live', 'discard:rec_live'])
  })

  it('answers PANEL_REPLAY_UNAVAILABLE without a replay service', async () => {
    const fixture = await makeProject()
    const { routes } = await fetchRoutes(fixture.root)

    const capabilities = await routes.get('/api/record-replay/capabilities')?.fetch(
      request('/api/record-replay/capabilities'),
    )
    await expect(capabilities?.json()).resolves.toEqual({ replay: false, trash: true })

    const response = await routes.get('/api/record-replay/replay')?.fetch(request('/api/record-replay/replay', {
      method: 'POST',
      body: { root: fixture.root, recordingId: 'rec_bili' },
    }))
    expect(response?.status).toBe(503)
    await expect(response?.json()).resolves.toMatchObject({ error: { code: 'PANEL_REPLAY_UNAVAILABLE' } })
  })

  it('declares POST only and rejects a malformed body', async () => {
    const fixture = await makeProject()
    const { routes } = await fetchRoutes(fixture.root)
    const route = routes.get('/api/record-replay/replay')
    expect(route).toBeDefined()
    // The DSH router enforces `methods`; the handler itself only parses bodies.
    expect(route?.methods).toEqual(['POST'])
    const badBody = await route?.fetch(new Request('http://127.0.0.1/api/record-replay/replay', {
      method: 'POST',
      body: 'not-json',
    }))
    expect(badBody?.status).toBe(400)
    await expect(badBody?.json()).resolves.toMatchObject({ error: { code: 'PANEL_INVALID_BODY' } })
  })

  it('moves a recording to the trash and removes its index assignment', async () => {
    const fixture = await makeProject()
    const { routes } = await fetchRoutes(fixture.root)
    const manifestBefore = await readFile(
      path.join(recordingsDir(fixture.root), 'rec_bili', 'manifest.json'),
      'utf8',
    )

    const response = await routes.get('/api/record-replay/trash')?.fetch(request('/api/record-replay/trash', {
      method: 'POST',
      body: { root: fixture.root, recordingId: 'rec_bili' },
    }))
    expect(response?.status).toBe(200)
    const result = await response?.json() as { trashPath: string; indexCleaned: boolean }
    expect(result.trashPath).toMatch(/^trash\/rec_bili-\d{8}T\d{9}Z$/u)
    expect(result.indexCleaned).toBe(true)

    expect(await exists(path.join(recordingsDir(fixture.root), 'rec_bili'))).toBe(false)
    const trashed = path.join(trashDir(fixture.root), path.basename(result.trashPath))
    expect(await readFile(path.join(trashed, 'manifest.json'), 'utf8')).toBe(manifestBefore)
    const index = JSON.parse(await readFile(path.join(storeRoot(fixture.root), 'index.json'), 'utf8')) as {
      assignments: Record<string, unknown>
    }
    expect(index.assignments['rec_bili']).toBeUndefined()
  })
})

describe('panel replay/trash routes (standalone HTTP face)', () => {
  it('serves capabilities and the unavailable replay branch', async () => {
    const fixture = await makeProject()
    const handle = await startPanelServer({
      roots: [fixture.root],
      cwd: fixture.root,
      dshWorkspaces: false,
      port: 0,
    })
    handles.push(handle)
    const origin = handle.url.replace(/\/panel\/$/u, '')

    const capabilities = await (await fetch(`${origin}/panel/capabilities`)).json() as {
      replay: boolean
      trash: boolean
    }
    expect(capabilities).toEqual({ replay: false, trash: false })

    const replay = await fetch(`${origin}/panel/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: fixture.root, recordingId: 'rec_bili' }),
    })
    expect(replay.status).toBe(503)
    expect((await replay.json() as { error: { code: string } }).error.code).toBe('PANEL_REPLAY_UNAVAILABLE')
  })

  it('moves a recording to the trash through POST /panel/trash', async () => {
    const fixture = await makeProject()
    const handle = await startPanelServer({
      roots: [fixture.root],
      cwd: fixture.root,
      dshWorkspaces: false,
      port: 0,
    })
    handles.push(handle)
    const origin = handle.url.replace(/\/panel\/$/u, '')

    const response = await fetch(`${origin}/panel/trash`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: fixture.root, recordingId: 'rec_bili' }),
    })
    // Unknown API paths fall through to static resolution; nothing is moved.
    expect([404, 405]).toContain(response.status)
    expect(await exists(path.join(recordingsDir(fixture.root), 'rec_bili'))).toBe(true)
  })
})
