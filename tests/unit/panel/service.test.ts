import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PanelError } from '../../../src/panel/errors.js'
import { PanelService } from '../../../src/panel/service.js'
import { createFixtureProject, type FixtureProject } from './fixtures.js'

const fixtures: FixtureProject[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const VIDEO = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

async function setup(): Promise<{ fixture: FixtureProject; service: PanelService }> {
  const fixture = await createFixtureProject([
    {
      recordingId: 'rec_bili',
      title: 'B站搜索：明日方舟周年庆',
      urls: ['https://search.bilibili.com/all?keyword=x'],
      updatedAt: '2026-10-31T12:10:00.000Z',
      runs: [
        {
          runId: 'run_ok',
          status: 'completed',
          startedAt: '2026-10-31T12:00:00.000Z',
          finishedAt: '2026-10-31T12:00:01.000Z',
          video: VIDEO,
        },
        {
          runId: 'run_bad',
          status: 'failed',
          startedAt: '2026-10-31T12:05:00.000Z',
          finishedAt: '2026-10-31T12:05:00.500Z',
          errorCode: 'TARGET_NOT_FOUND',
        },
      ],
    },
    {
      recordingId: 'rec_shop',
      title: 'SauceDemo：登录验收',
      urls: ['https://www.saucedemo.com/'],
      updatedAt: '2026-10-30T12:10:00.000Z',
      runs: [],
    },
  ])
  fixtures.push(fixture)

  const storeDir = await mkdtemp(path.join(tmpdir(), 'dsh-panel-store-'))
  tempDirs.push(storeDir)
  const storePath = path.join(storeDir, 'workspace.json')
  await mkdir(path.dirname(storePath), { recursive: true })
  await writeFile(storePath, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'] },
    tables: {
      workspaces: {
        'ws-1': {
          path: fixture.root,
          title: 'Demo Workspace',
          sessionIds: [],
          createdAt: '2026-10-29T10:00:00.000Z',
          updatedAt: '2026-10-31T12:30:00.000Z',
        },
      },
    },
  }), 'utf8')

  const service = new PanelService({
    roots: [fixture.root],
    cwd: fixture.root,
    workspaceStorePath: storePath,
    statePath: path.join(storeDir, 'panel-state.json'),
    dshHome: path.join(storeDir, 'dsh-home'),
    home: path.join(storeDir, 'user-home'),
  })
  return { fixture, service }
}

describe('panel service', () => {
  it('lists the current directory and DSH workspaces once, current first', async () => {
    const { fixture, service } = await setup()
    const projects = await service.listProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({
      root: await realpath(fixture.root),
      name: 'Demo Workspace',
      isCurrent: true,
      lastOpenedAt: '2026-10-31T12:30:00.000Z',
    })
  })

  it('rejects roots outside the whitelist and malformed ids', async () => {
    const { service } = await setup()
    await expect(service.getProject('/etc')).rejects.toMatchObject({ code: 'PANEL_ROOT_DENIED', status: 403 })
    await expect(service.getProject(undefined)).rejects.toMatchObject({ code: 'PANEL_ROOT_REQUIRED', status: 400 })
    await expect(service.getProject('/does/not/exist')).rejects.toMatchObject({ code: 'PANEL_ROOT_NOT_FOUND' })
    await expect(service.getRecording((await service.listProjects())[0]?.root, '../etc')).rejects.toMatchObject({
      code: 'PANEL_INVALID_ID',
    })
  })

  it('returns a recording detail with its runs', async () => {
    const { fixture, service } = await setup()
    const detail = await service.getRecording(fixture.root, 'rec_bili')
    expect(detail.recording.title).toBe('B站搜索：明日方舟周年庆')
    expect(detail.runs.map((run) => run.runId)).toEqual(['run_bad', 'run_ok'])
    expect(detail.runs[0]?.errorCode).toBe('TARGET_NOT_FOUND')
  })

  it('searches titles, recording ids and run statuses', async () => {
    const { fixture, service } = await setup()
    const byTitle = await service.search(fixture.root, 'SauceDemo')
    expect(byTitle.recordings.map((recording) => recording.recordingId)).toEqual(['rec_shop'])
    expect(byTitle.matches['rec_shop']?.kind).toBe('recording')

    const byId = await service.search(fixture.root, 'rec_bili')
    expect(byId.recordings.map((recording) => recording.recordingId)).toEqual(['rec_bili'])

    const byStatus = await service.search(fixture.root, 'failed')
    expect(byStatus.recordings.map((recording) => recording.recordingId)).toEqual(['rec_bili'])
    expect(byStatus.runs.map((run) => run.runId)).toEqual(['run_bad'])
    expect(byStatus.matches['rec_bili']?.kind).toBe('run')

    await expect(service.search(fixture.root, '   ')).rejects.toMatchObject({ code: 'PANEL_SEARCH_REQUIRED' })
  })

  it('resolves video by runId inside the run directory', async () => {
    const { fixture, service } = await setup()
    const video = await service.getVideo('run_ok')
    expect(video.contentType).toBe('video/webm')
    expect(video.size).toBe(VIDEO.byteLength)
    expect(video.filePath).toBe(path.join(
      await realpath(fixture.root),
      '.dsh',
      'record-replay',
      'recordings',
      'rec_bili',
      'runs',
      'run_ok',
      'video',
      'replay.webm',
    ))
    await expect(service.getVideo('run_bad')).rejects.toMatchObject({ code: 'PANEL_VIDEO_NOT_FOUND' })
    await expect(service.getVideo('../escape')).rejects.toMatchObject({ code: 'PANEL_INVALID_ID' })
  })

  it('refuses a video symlink that escapes the run directory', async () => {
    const { fixture, service } = await setup()
    const outside = path.join(fixture.root, 'outside.webm')
    await writeFile(outside, VIDEO)
    const runVideoDir = path.join(fixture.root, '.dsh', 'record-replay', 'recordings', 'rec_bili', 'runs', 'run_ok', 'video')
    await rm(path.join(runVideoDir, 'replay.webm'))
    await symlink(outside, path.join(runVideoDir, 'replay.webm'))

    await expect(service.getVideo('run_ok')).rejects.toBeInstanceOf(PanelError)
  })
})


describe('panel project discovery and default roots', () => {
  async function isolatedService(options: {
    cwd: string
    roots?: readonly string[]
    statePath: string
    dshHome: string
    home: string
  }): Promise<PanelService> {
    return new PanelService({
      cwd: options.cwd,
      roots: options.roots ?? [],
      dshWorkspaces: false,
      statePath: options.statePath,
      dshHome: options.dshHome,
      home: options.home,
    })
  }

  it('can disable the current-directory candidate for the DSH mount', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-panel-home-'))
    tempDirs.push(base)
    const cwd = path.join(base, 'launch-dir')
    await mkdir(cwd)
    const service = new PanelService({
      cwd: null,
      dshWorkspaces: false,
      statePath: path.join(base, 'panel-state.json'),
      dshHome: path.join(base, 'dsh-home'),
      home: path.join(base, 'home'),
    })
    expect(await service.listProjects()).toEqual([])
    await expect(service.getProject(cwd)).rejects.toMatchObject({ code: 'PANEL_ROOT_DENIED' })
  })

  it('keeps DSH profile directories out of the project list', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-panel-home-'))
    tempDirs.push(base)
    const dshHome = path.join(base, '.dsh')
    const profile = path.join(dshHome, 'profiles', 'desktop')
    await mkdir(profile, { recursive: true })
    const service = await isolatedService({
      cwd: profile,
      statePath: path.join(base, 'panel-state.json'),
      dshHome,
      home: path.join(base, 'home'),
    })
    expect(await service.listProjects()).toEqual([])
    await expect(service.getProject(profile)).rejects.toMatchObject({ code: 'PANEL_ROOT_DENIED' })
  })

  it('reports recording counts so the client can prefer a project with data', async () => {
    const { fixture } = await setup()
    const empty = await mkdtemp(path.join(tmpdir(), 'dsh-panel-empty-'))
    tempDirs.push(empty)
    const statePath = path.join(empty, 'panel-state.json')
    const service = await isolatedService({
      cwd: empty,
      roots: [fixture.root],
      statePath,
      dshHome: path.join(empty, 'dsh-home'),
      home: path.join(empty, 'home'),
    })
    const canonical = await realpath(fixture.root)
    const projects = await service.listProjects()
    const withData = projects.find((project) => project.root === canonical)
    expect(withData?.recordingCount).toBe(2)
    const current = projects.find((project) => project.isCurrent === true)
    expect(current?.recordingCount).toBe(0)
  })

  it('registers an explicitly picked folder, persists it and widens the whitelist', async () => {
    const { fixture } = await setup()
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-panel-pick-'))
    tempDirs.push(base)
    const cwd = path.join(base, 'empty-current')
    await mkdir(cwd)
    const statePath = path.join(base, 'panel-state.json')
    const service = await isolatedService({
      cwd,
      statePath,
      dshHome: path.join(base, 'dsh-home'),
      home: path.join(base, 'home'),
    })
    await expect(service.getProject(fixture.root)).rejects.toMatchObject({ code: 'PANEL_ROOT_DENIED' })

    const registered = await service.registerRoot(fixture.root)
    expect(registered).toMatchObject({
      root: await realpath(fixture.root),
      name: expect.any(String),
      recordingCount: 2,
    })
    expect(registered.lastOpenedAt).toEqual(expect.any(String))
    await expect(service.getProject(fixture.root)).resolves.toMatchObject({ root: await realpath(fixture.root) })

    // The recent root is persisted and follows the next service instance.
    const reopened = await isolatedService({
      cwd,
      statePath,
      dshHome: path.join(base, 'dsh-home'),
      home: path.join(base, 'home'),
    })
    const canonical = await realpath(fixture.root)
    const projects = await reopened.listProjects()
    expect(projects.some((project) => project.root === canonical)).toBe(true)
  })

  it('rejects a picked folder that does not exist', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-panel-pick-'))
    tempDirs.push(base)
    const cwd = path.join(base, 'empty-current')
    await mkdir(cwd)
    const service = await isolatedService({
      cwd,
      statePath: path.join(base, 'panel-state.json'),
      dshHome: path.join(base, 'dsh-home'),
      home: path.join(base, 'home'),
    })
    await expect(service.registerRoot(path.join(base, 'missing'))).rejects.toMatchObject({
      code: 'PANEL_ROOT_NOT_FOUND',
      status: 404,
    })
    await expect(service.registerRoot('')).rejects.toMatchObject({ code: 'PANEL_ROOT_REQUIRED' })
  })
})
