import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createPanelFetchRoutes, type PanelFetchRoute } from '../../../src/panel/fetch-api.js'
import { PanelService } from '../../../src/panel/service.js'
import { createFixtureProject, writeIndex, writeRecording, type FixtureProject } from './fixtures.js'

const VIDEO = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((value) => value + 65))

const fixtures: FixtureProject[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(): Promise<{ root: string; routes: Map<string, PanelFetchRoute> }> {
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
          video: VIDEO,
        },
        {
          runId: 'run_bad',
          status: 'failed',
          startedAt: '2026-10-31T12:00:00.000Z',
          finishedAt: '2026-10-31T12:00:01.000Z',
          errorCode: 'ASSERTION_FAILED',
          errorMessage: 'URL did not contain the expected fragment',
        },
      ],
    },
  ])
  fixtures.push(fixture)
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-panel-fetch-state-'))
  tempDirs.push(stateDir)
  const service = new PanelService({
    roots: [fixture.root],
    cwd: fixture.root,
    dshWorkspaces: false,
    statePath: path.join(stateDir, 'panel-state.json'),
  })
  const routes = new Map(createPanelFetchRoutes(service).map((route) => [route.path, route]))
  return { root: fixture.root, routes }
}

function request(pathname: string, params: Readonly<Record<string, string>> = {}, init?: RequestInit): Request {
  const url = new URL(`http://127.0.0.1${pathname}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return new Request(url, init)
}

function writeRequest(
  pathname: string,
  root: string,
  method: 'PATCH' | 'POST',
  body: unknown,
): Request {
  return request(pathname, { root }, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('panel fetch routes', () => {
  it('exposes the read endpoints and M3-lite write routes under the DSH API prefix', async () => {
    const { routes } = await setup()
    expect([...routes.keys()]).toEqual([
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
    expect(routes.get('/api/record-replay/recording')?.methods).toEqual(['GET', 'HEAD', 'PATCH'])
    expect(routes.get('/api/record-replay/category')?.methods).toEqual(['PATCH'])
    expect(routes.get('/api/record-replay/scenario')?.methods).toEqual(['PATCH', 'POST'])
    expect(routes.get('/api/record-replay/capabilities')?.methods).toEqual(['GET', 'HEAD'])
    expect(routes.get('/api/record-replay/replay')?.methods).toEqual(['POST'])
    expect(routes.get('/api/record-replay/trash')?.methods).toEqual(['POST'])
    for (const path of ['/projects', '/project', '/search', '/video']) {
      expect(routes.get(`/api/record-replay${path}`)?.methods).toEqual(['GET', 'HEAD'])
    }
    for (const route of routes.values()) {
      expect(route.requestBody).toBe('buffered')
    }
  })

  it('serves projects, project, recording and search as JSON', async () => {
    const { root, routes } = await setup()
    const projects = await routes.get('/api/record-replay/projects')?.fetch(request('/api/record-replay/projects'))
    expect(projects?.status).toBe(200)
    const projectPayload = await projects?.json() as { projects: { root: string; isCurrent: boolean }[] }
    expect(projectPayload.projects).toHaveLength(1)
    expect(projectPayload.projects[0]?.isCurrent).toBe(true)

    const project = await routes.get('/api/record-replay/project')?.fetch(
      request('/api/record-replay/project', { root }),
    )
    const projectBody = await project?.json() as {
      project: { recordings: { recordingId: string }[]; stats: { runs: number } }
    }
    expect(projectBody.project.recordings.map((recording) => recording.recordingId)).toEqual(['rec_bili'])
    expect(projectBody.project.stats.runs).toBe(2)

    const detail = await routes.get('/api/record-replay/recording')?.fetch(
      request('/api/record-replay/recording', { root, id: 'rec_bili' }),
    )
    const detailBody = await detail?.json() as { runs: { runId: string; status: string }[] }
    expect(detailBody.runs.map((run) => run.status)).toEqual(['failed', 'completed'])

    const search = await routes.get('/api/record-replay/search')?.fetch(
      request('/api/record-replay/search', { root, q: 'failed' }),
    )
    const searchBody = await search?.json() as { recordings: { recordingId: string }[] }
    expect(searchBody.recordings.map((recording) => recording.recordingId)).toEqual(['rec_bili'])
  })

  it('serves cross-project search, stats and limit/offset pagination (M2)', async () => {
    const { root, routes } = await setup()
    await writeRecording(root, {
      recordingId: 'rec_shop',
      title: 'SauceDemo：登录验收',
      urls: ['https://www.saucedemo.com/'],
      updatedAt: '2026-10-30T10:00:00.000Z',
    })
    const canonical = await realpath(root)

    const all = await routes.get('/api/record-replay/search')?.fetch(
      request('/api/record-replay/search', { q: 'failed' }),
    )
    expect(all?.status).toBe(200)
    const allBody = await all?.json() as {
      groups: { projectRoot: string; projectName: string; matches: { recording: { recordingId: string }; matchKind: string; matchedRuns: { runId: string; status: string }[] }[] }[]
      total: number
      returned: number
      limit: number
      truncated: boolean
    }
    expect(allBody.groups).toHaveLength(1)
    expect(allBody.groups[0]?.projectRoot).toBe(canonical)
    expect(allBody.groups[0]?.matches[0]?.recording.recordingId).toBe('rec_bili')
    expect(allBody.groups[0]?.matches[0]?.matchKind).toBe('run')
    expect(allBody.groups[0]?.matches[0]?.matchedRuns).toEqual([
      expect.objectContaining({ runId: 'run_bad', status: 'failed' }),
    ])
    expect(allBody).toMatchObject({ total: 1, returned: 1, limit: 100, truncated: false })

    const star = await routes.get('/api/record-replay/search')?.fetch(
      request('/api/record-replay/search', { q: 'failed', root: '*' }),
    )
    expect(await star?.json()).toMatchObject({ returned: 1 })

    const stats = await routes.get('/api/record-replay/stats')?.fetch(
      request('/api/record-replay/stats'),
    )
    expect(stats?.status).toBe(200)
    const statsBody = await stats?.json() as {
      system: { projects: number; recordings: number; runs: number; failedRuns: number }
      projects: { root: string; stats: { recordings: number } }[]
    }
    expect(statsBody.system).toMatchObject({ projects: 1, recordings: 2, runs: 2, failedRuns: 1 })
    expect(statsBody.projects[0]?.root).toBe(canonical)

    const projects = await routes.get('/api/record-replay/projects')?.fetch(
      request('/api/record-replay/projects', { limit: '1', offset: '0' }),
    )
    expect(await projects?.json()).toMatchObject({
      projects: [{ root: canonical }],
      page: { total: 1, limit: 1, offset: 0, hasMore: false },
    })

    const firstPage = await routes.get('/api/record-replay/project')?.fetch(
      request('/api/record-replay/project', { root, limit: '1', offset: '0' }),
    )
    const firstBody = await firstPage?.json() as {
      project: {
        recordings: { recordingId: string }[]
        recordingsTotal: number
        recordingsPage: { total: number; hasMore: boolean }
      }
    }
    expect(firstBody.project.recordings).toHaveLength(1)
    expect(firstBody.project.recordingsTotal).toBe(2)
    expect(firstBody.project.recordingsPage).toMatchObject({ total: 2, hasMore: true })

    const secondPage = await routes.get('/api/record-replay/project')?.fetch(
      request('/api/record-replay/project', { root, limit: '1', offset: '1' }),
    )
    const secondBody = await secondPage?.json() as {
      project: { recordings: { recordingId: string }[]; recordingsPage: { hasMore: boolean } }
    }
    expect(secondBody.project.recordings).toHaveLength(1)
    expect(secondBody.project.recordingsPage.hasMore).toBe(false)

    const badPage = await routes.get('/api/record-replay/project')?.fetch(
      request('/api/record-replay/project', { root, limit: '0' }),
    )
    expect(badPage?.status).toBe(400)
    expect(await badPage?.json()).toMatchObject({ error: { code: 'PANEL_INVALID_PAGINATION' } })

    const badLimit = await routes.get('/api/record-replay/search')?.fetch(
      request('/api/record-replay/search', { q: 'failed', limit: '501' }),
    )
    expect(badLimit?.status).toBe(400)
    expect(await badLimit?.json()).toMatchObject({ error: { code: 'PANEL_INVALID_LIMIT' } })
  })

  it('streams video with Range and answers HEAD without a body', async () => {
    const { root, routes } = await setup()
    const videoRoute = routes.get('/api/record-replay/video')
    expect(videoRoute).toBeDefined()

    const full = await videoRoute?.fetch(request('/api/record-replay/video', { root, runId: 'run_ok' }))
    expect(full?.status).toBe(200)
    expect(full?.headers.get('content-type')).toBe('video/webm')
    expect(full?.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await full!.arrayBuffer())).toEqual(VIDEO)

    const partial = await videoRoute?.fetch(request('/api/record-replay/video', { root, runId: 'run_ok' }, {
      headers: { range: 'bytes=0-3' },
    }))
    expect(partial?.status).toBe(206)
    expect(partial?.headers.get('content-range')).toBe(`bytes 0-3/${String(VIDEO.byteLength)}`)
    expect(new Uint8Array(await partial!.arrayBuffer())).toEqual(VIDEO.slice(0, 4))

    const head = await videoRoute?.fetch(request('/api/record-replay/video', { root, runId: 'run_ok' }, {
      method: 'HEAD',
    }))
    expect(head?.status).toBe(200)
    expect(head?.headers.get('content-length')).toBe(String(VIDEO.byteLength))
    expect(await head!.text()).toBe('')

    const invalid = await videoRoute?.fetch(request('/api/record-replay/video', { root, runId: 'run_ok' }, {
      headers: { range: 'bytes=999-1000' },
    }))
    expect(invalid?.status).toBe(416)
    expect(invalid?.headers.get('content-range')).toBe(`bytes */${String(VIDEO.byteLength)}`)
  })

  it('returns JSON errors for missing videos, bad ids and denied roots', async () => {
    const { root, routes } = await setup()
    const videoRoute = routes.get('/api/record-replay/video')
    expect(videoRoute).toBeDefined()

    const noVideo = await videoRoute?.fetch(request('/api/record-replay/video', { root, runId: 'run_bad' }))
    expect(noVideo?.status).toBe(404)
    expect(await noVideo?.json()).toMatchObject({ error: { code: 'PANEL_VIDEO_NOT_FOUND' } })

    const badId = await videoRoute?.fetch(request('/api/record-replay/video', { runId: 'run_../../x' }))
    expect(badId?.status).toBe(400)
    expect(await badId?.json()).toMatchObject({ error: { code: 'PANEL_INVALID_ID' } })

    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-panel-rr-outside-'))
    tempDirs.push(outside)
    const denied = await routes.get('/api/record-replay/project')?.fetch(
      request('/api/record-replay/project', { root: outside }),
    )
    expect(denied?.status).toBe(403)
    expect(await denied?.json()).toMatchObject({ error: { code: 'PANEL_ROOT_DENIED' } })
  })

  it('renames categories/scenarios, collects 未分组 and overrides a recording title', async () => {
    const { root, routes } = await setup()
    await writeRecording(root, {
      recordingId: 'rec_shop',
      title: 'SauceDemo：登录验收',
      urls: ['https://www.saucedemo.com/'],
    })
    await writeIndex(root, {
      version: 1,
      categories: [
        { id: 'bilibili', name: 'B站', site: 'bilibili' },
        { id: 'saucedemo', name: 'SauceDemo', site: 'saucedemo' },
      ],
      scenarios: [{ id: 'anniv', categoryId: 'bilibili', name: '周年庆' }],
      assignments: { rec_bili: { scenarioId: 'anniv' } },
    })

    const category = await routes.get('/api/record-replay/category')?.fetch(
      writeRequest('/api/record-replay/category', root, 'PATCH', { id: 'bilibili', name: '  视频站  ' }),
    )
    expect(category?.status).toBe(200)
    expect(await category?.json()).toMatchObject({ category: { id: 'bilibili', name: '视频站' } })

    const scenario = await routes.get('/api/record-replay/scenario')?.fetch(
      writeRequest('/api/record-replay/scenario', root, 'PATCH', { id: 'anniv', name: '周年庆 2026' }),
    )
    expect(scenario?.status).toBe(200)
    expect(await scenario?.json()).toMatchObject({ scenario: { id: 'anniv', name: '周年庆 2026' } })

    const created = await routes.get('/api/record-replay/scenario')?.fetch(
      writeRequest('/api/record-replay/scenario', root, 'POST', {
        categoryId: 'saucedemo',
        name: '登录流程',
        includeUngrouped: true,
      }),
    )
    expect(created?.status).toBe(200)
    const createdBody = await created?.json() as {
      scenario: { id: string; categoryId: string; name: string }
      assignedCount: number
    }
    expect(createdBody.scenario).toMatchObject({ categoryId: 'saucedemo', name: '登录流程' })
    expect(createdBody.assignedCount).toBe(1)

    const manifestPath = path.join(
      root,
      '.dsh',
      'record-replay',
      'recordings',
      'rec_shop',
      'manifest.json',
    )
    const before = await readFile(manifestPath, 'utf8')
    const renamed = await routes.get('/api/record-replay/recording')?.fetch(
      writeRequest('/api/record-replay/recording', root, 'PATCH', {
        id: 'rec_shop',
        title: '登录验收（改名）',
      }),
    )
    expect(renamed?.status).toBe(200)
    expect(await readFile(manifestPath, 'utf8')).toBe(before)

    const project = await routes.get('/api/record-replay/project')?.fetch(
      request('/api/record-replay/project', { root }),
    )
    const projectBody = await project?.json() as {
      project: {
        categories: { id: string; name: string }[]
        scenarios: { id: string; name: string }[]
        recordings: { recordingId: string; title: string; titleSource?: string; scenarioId?: string }[]
      }
    }
    expect(projectBody.project.categories).toContainEqual(
      expect.objectContaining({ id: 'bilibili', name: '视频站' }),
    )
    expect(projectBody.project.scenarios).toContainEqual(
      expect.objectContaining({ id: 'anniv', name: '周年庆 2026' }),
    )
    expect(projectBody.project.scenarios).toContainEqual(createdBody.scenario)
    const shop = projectBody.project.recordings.find((recording) => recording.recordingId === 'rec_shop')
    expect(shop?.title).toBe('登录验收（改名）')
    expect(shop?.titleSource).toBe('index')
    expect(shop?.scenarioId).toBe(createdBody.scenario.id)
  })

  it('returns stable error codes for invalid writes and never persists them', async () => {
    const { root, routes } = await setup()
    await writeIndex(root, {
      version: 1,
      categories: [{ id: 'bilibili', name: 'B站', site: 'bilibili' }],
      scenarios: [],
      assignments: {},
    })
    const indexPath = path.join(root, '.dsh', 'record-replay', 'index.json')
    const before = await readFile(indexPath, 'utf8')

    const emptyName = await routes.get('/api/record-replay/category')?.fetch(
      writeRequest('/api/record-replay/category', root, 'PATCH', { id: 'bilibili', name: '   ' }),
    )
    expect(emptyName?.status).toBe(400)
    expect(await emptyName?.json()).toMatchObject({ error: { code: 'PANEL_INVALID_NAME' } })

    const tooLong = await routes.get('/api/record-replay/scenario')?.fetch(
      writeRequest('/api/record-replay/scenario', root, 'PATCH', { id: 'anniv', name: 'x'.repeat(81) }),
    )
    expect(tooLong?.status).toBe(400)
    expect(await tooLong?.json()).toMatchObject({ error: { code: 'PANEL_INVALID_NAME' } })

    const unknown = await routes.get('/api/record-replay/category')?.fetch(
      writeRequest('/api/record-replay/category', root, 'PATCH', { id: 'nope', name: 'x' }),
    )
    expect(unknown?.status).toBe(404)
    expect(await unknown?.json()).toMatchObject({ error: { code: 'PANEL_CATEGORY_NOT_FOUND' } })

    const badJson = await routes.get('/api/record-replay/category')?.fetch(
      request('/api/record-replay/category', { root }, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    )
    expect(badJson?.status).toBe(400)
    expect(await badJson?.json()).toMatchObject({ error: { code: 'PANEL_INVALID_BODY' } })

    const wrongMethod = await routes.get('/api/record-replay/category')?.fetch(
      writeRequest('/api/record-replay/category', root, 'POST', { id: 'bilibili', name: 'x' }),
    )
    expect(wrongMethod?.status).toBe(405)
    expect(await wrongMethod?.json()).toMatchObject({ error: { code: 'PANEL_METHOD_NOT_ALLOWED' } })

    expect(await readFile(indexPath, 'utf8')).toBe(before)

    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-panel-write-outside-'))
    tempDirs.push(outside)
    const denied = await routes.get('/api/record-replay/category')?.fetch(
      writeRequest('/api/record-replay/category', outside, 'PATCH', { id: 'bilibili', name: 'x' }),
    )
    expect(denied?.status).toBe(403)
    expect(await denied?.json()).toMatchObject({ error: { code: 'PANEL_ROOT_DENIED' } })

    await writeFile(indexPath, '{broken', 'utf8')
    const corrupt = await routes.get('/api/record-replay/category')?.fetch(
      writeRequest('/api/record-replay/category', root, 'PATCH', { id: 'bilibili', name: 'x' }),
    )
    expect(corrupt?.status).toBe(409)
    expect(await corrupt?.json()).toMatchObject({ error: { code: 'PANEL_INDEX_CORRUPT' } })
    expect(await readFile(indexPath, 'utf8')).toBe('{broken')
  })
})

  it('registers a picked folder through POST /root and serves it afterwards', async () => {
    const { routes } = await setup()
    const picked = await mkdtemp(path.join(tmpdir(), 'dsh-panel-picked-'))
    tempDirs.push(picked)

    const response = await routes.get('/api/record-replay/root')?.fetch(request('/api/record-replay/root', {}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: picked }),
    }))
    expect(response?.status).toBe(200)
    const body = await response?.json() as { project: { root: string; recordingCount: number } }
    expect(body.project.recordingCount).toBe(0)
    expect(body.project.root).toBe(await realpath(picked))

    const project = await routes.get('/api/record-replay/project')?.fetch(
      request('/api/record-replay/project', { root: picked }),
    )
    expect(project?.status).toBe(200)

    const bad = await routes.get('/api/record-replay/root')?.fetch(request('/api/record-replay/root', {}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    expect(bad?.status).toBe(400)
    expect(await bad?.json()).toMatchObject({ error: { code: 'PANEL_ROOT_REQUIRED' } })
  })
