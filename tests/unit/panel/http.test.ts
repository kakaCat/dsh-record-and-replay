import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { startPanelServer, type PanelServerHandle } from '../../../src/panel/server.js'
import { createFixtureProject, type FixtureProject } from './fixtures.js'

const VIDEO = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((value) => value + 65))

const fixtures: FixtureProject[] = []
const tempDirs: string[] = []
const handles: PanelServerHandle[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(): Promise<{ root: string; origin: string }> {
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

  const publicDir = await mkdtemp(path.join(tmpdir(), 'dsh-panel-public-'))
  tempDirs.push(publicDir)
  await mkdir(path.join(publicDir, 'assets'), { recursive: true })
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>panel test</title>', 'utf8')
  await writeFile(path.join(publicDir, 'assets', 'app.js'), 'console.log("panel")', 'utf8')

  const handle = await startPanelServer({
    roots: [fixture.root],
    cwd: fixture.root,
    dshWorkspaces: false,
    port: 0,
    publicDir,
    cors: true,
  })
  handles.push(handle)
  return { root: fixture.root, origin: handle.url.replace(/\/panel\/$/u, '') }
}

describe('panel HTTP interface', () => {
  it('serves projects, project, recording and search JSON', async () => {
    const { root, origin } = await setup()
    const projects = await (await fetch(`${origin}/panel/projects`)).json() as {
      projects: { root: string; isCurrent: boolean }[]
    }
    expect(projects.projects).toHaveLength(1)
    expect(projects.projects[0]?.root).toBe(await realpath(root))
    expect(projects.projects[0]?.isCurrent).toBe(true)

    const project = await (await fetch(`${origin}/panel/project?root=${encodeURIComponent(root)}`)).json() as {
      project: { recordings: { recordingId: string }[]; stats: { runs: number } }
    }
    expect(project.project.recordings.map((recording) => recording.recordingId)).toEqual(['rec_bili'])
    expect(project.project.stats.runs).toBe(2)

    const detail = await (await fetch(
      `${origin}/panel/recording?root=${encodeURIComponent(root)}&id=rec_bili`,
    )).json() as { recording: { title: string }; runs: { runId: string; errorCode?: string }[] }
    expect(detail.recording.title).toBe('B站搜索：明日方舟周年庆')
    expect(detail.runs.map((run) => run.runId)).toEqual(['run_bad', 'run_ok'])
    expect(detail.runs[0]?.errorCode).toBe('ASSERTION_FAILED')

    const search = await (await fetch(
      `${origin}/panel/search?root=${encodeURIComponent(root)}&q=failed`,
    )).json() as { recordings: { recordingId: string }[]; runs: { runId: string }[] }
    expect(search.recordings.map((recording) => recording.recordingId)).toEqual(['rec_bili'])
    expect(search.runs.map((run) => run.runId)).toEqual(['run_bad'])

    // No root (or `*`) searches every project and groups the hits.
    const all = await (await fetch(`${origin}/panel/search?q=failed`)).json() as {
      groups: { projectName: string; matches: { recording: { recordingId: string } }[] }[]
      total: number
    }
    expect(all.groups).toHaveLength(1)
    expect(all.groups[0]?.matches[0]?.recording.recordingId).toBe('rec_bili')
    expect(all.total).toBe(1)

    const stats = await (await fetch(`${origin}/panel/stats`)).json() as {
      system: { projects: number; recordings: number; runs: number }
    }
    expect(stats.system).toMatchObject({ projects: 1, recordings: 1, runs: 2 })

    const page = await (await fetch(
      `${origin}/panel/project?root=${encodeURIComponent(root)}&limit=1&offset=0`,
    )).json() as {
      project: { recordings: unknown[]; recordingsTotal: number; recordingsPage: { hasMore: boolean } }
    }
    expect(page.project.recordings).toHaveLength(1)
    expect(page.project.recordingsTotal).toBe(1)
    expect(page.project.recordingsPage.hasMore).toBe(false)

    const badLimit = await fetch(`${origin}/panel/search?q=failed&limit=0`)
    expect(badLimit.status).toBe(400)
    expect((await badLimit.json() as { error: { code: string } }).error.code).toBe('PANEL_INVALID_LIMIT')
  })

  it('serves video with range requests, HEAD and download headers', async () => {
    const { root, origin } = await setup()
    const videoUrl = `${origin}/panel/video?root=${encodeURIComponent(root)}&runId=run_ok`

    const full = await fetch(videoUrl)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('video/webm')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(VIDEO)

    const partial = await fetch(videoUrl, { headers: { range: 'bytes=2-5' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe(`bytes 2-5/${String(VIDEO.byteLength)}`)
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(VIDEO.slice(2, 6))

    const suffix = await fetch(videoUrl, { headers: { range: 'bytes=-3' } })
    expect(suffix.status).toBe(206)
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(VIDEO.slice(-3))

    const invalid = await fetch(videoUrl, { headers: { range: 'bytes=999-' } })
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe(`bytes */${String(VIDEO.byteLength)}`)

    const head = await fetch(videoUrl, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(VIDEO.byteLength))
    expect((await head.arrayBuffer()).byteLength).toBe(0)

    const download = await fetch(`${videoUrl}&download=1`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toBe(
      'attachment; filename="rec_bili-run_ok.webm"',
    )
  })

  it('rejects path traversal, unknown roots and malformed ids', async () => {
    const { root, origin } = await setup()
    const denied = await fetch(`${origin}/panel/project?root=${encodeURIComponent('/etc')}`)
    expect(denied.status).toBe(403)
    expect((await denied.json() as { error: { code: string } }).error.code).toBe('PANEL_ROOT_DENIED')

    const missing = await fetch(`${origin}/panel/project`)
    expect(missing.status).toBe(400)
    expect((await missing.json() as { error: { code: string } }).error.code).toBe('PANEL_ROOT_REQUIRED')

    const badId = await fetch(
      `${origin}/panel/recording?root=${encodeURIComponent(root)}&id=${encodeURIComponent('../../etc/passwd')}`,
    )
    expect(badId.status).toBe(400)
    expect((await badId.json() as { error: { code: string } }).error.code).toBe('PANEL_INVALID_ID')

    const badRun = await fetch(`${origin}/panel/video?runId=${encodeURIComponent('run_../../x')}`)
    expect(badRun.status).toBe(400)

    const noVideo = await fetch(`${origin}/panel/video?root=${encodeURIComponent(root)}&runId=run_bad`)
    expect(noVideo.status).toBe(404)
    expect((await noVideo.json() as { error: { code: string } }).error.code).toBe('PANEL_VIDEO_NOT_FOUND')
  })

  it('serves the built panel and static assets, with CORS preflight', async () => {
    const { origin } = await setup()
    const page = await fetch(`${origin}/panel/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('panel test')

    const asset = await fetch(`${origin}/panel/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')

    const redirect = await fetch(`${origin}/`, { redirect: 'manual' })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe('/panel/')

    const preflight = await fetch(`${origin}/panel/projects`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:58805' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
  })
})
