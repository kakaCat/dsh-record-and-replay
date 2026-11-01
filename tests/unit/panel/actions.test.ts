import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PanelError } from '../../../src/panel/errors.js'
import { recordingsDir, storeRoot, trashDir } from '../../../src/panel/paths.js'
import type {
  PanelReplayPort,
  PanelReplayRequest,
} from '../../../src/panel/service.js'
import { PanelService } from '../../../src/panel/service.js'
import { createFixtureProject, writeIndex, type FixtureProject } from './fixtures.js'

const fixtures: FixtureProject[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FIXED_NOW = Date.parse('2026-11-01T10:23:50.123Z')

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
          video: new Uint8Array([65, 66, 67]),
        },
      ],
    },
    {
      recordingId: 'rec_shop',
      title: 'SauceDemo：登录验收',
      urls: ['https://www.saucedemo.com/'],
    },
  ])
  fixtures.push(fixture)
  await writeIndex(fixture.root, {
    version: 1,
    categories: [
      { id: 'bilibili', name: 'B站', site: 'bilibili' },
      { id: 'saucedemo', name: 'SauceDemo', site: 'saucedemo' },
    ],
    scenarios: [{ id: 'anniv', categoryId: 'bilibili', name: '周年庆' }],
    assignments: {
      rec_bili: { scenarioId: 'anniv', title: '周年庆录制' },
      rec_shop: { scenarioId: 'scn_shop' },
    },
  })
  return fixture
}

function makeService(
  root: string,
  options: { readonly replay?: PanelReplayPort; readonly now?: () => number; readonly trash?: boolean } = {},
): PanelService {
  return new PanelService({
    roots: [root],
    cwd: root,
    dshWorkspaces: false,
    trash: options.trash ?? true,
    ...(options.replay === undefined ? {} : { replay: options.replay }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}

async function errorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof PanelError) return error.code
    throw error
  }
  throw new Error('expected the call to reject')
}

async function readIndex(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(storeRoot(root), 'index.json'), 'utf8')) as Record<string, unknown>
}

async function exists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, () => false)
}

describe('panel replay service (M3)', () => {
  it('reports replay availability from the injected port', async () => {
    const fixture = await makeProject()
    // Default: read-only standalone panel (no replay, no trash).
    expect(makeService(fixture.root, { trash: false }).capabilities())
      .toEqual({ replay: false, trash: false })
    // DSH mount: trash route + no replay port (replay.enabled=false).
    expect(makeService(fixture.root).capabilities()).toEqual({ replay: false, trash: true })

    const replay: PanelReplayPort = { startReplay: async () => ({ runId: 'run_panel' }) }
    expect(makeService(fixture.root, { replay }).capabilities()).toEqual({ replay: true, trash: true })
  })

  it('delegates a replay with the canonical root, id and values', async () => {
    const fixture = await makeProject()
    const calls: PanelReplayRequest[] = []
    const replay: PanelReplayPort = {
      async startReplay(input) {
        calls.push(input)
        return { runId: 'run_panel_1' }
      },
    }
    const service = makeService(fixture.root, { replay })

    await expect(service.startReplay(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_bili',
      values: { step_1: 'hello' },
    })).resolves.toEqual({ runId: 'run_panel_1' })

    const canonicalRoot = await realpath(fixture.root)
    expect(calls).toEqual([{
      root: canonicalRoot,
      recordingId: 'rec_bili',
      values: { step_1: 'hello' },
    }])
  })

  it('omits values when the request has none', async () => {
    const fixture = await makeProject()
    const calls: PanelReplayRequest[] = []
    const replay: PanelReplayPort = {
      async startReplay(input) {
        calls.push(input)
        return { runId: 'run_panel_2' }
      },
    }
    const service = makeService(fixture.root, { replay })
    await service.startReplay(fixture.root, { root: fixture.root, recordingId: 'rec_bili' })
    expect(calls[0]).toEqual({ root: await realpath(fixture.root), recordingId: 'rec_bili' })
  })

  it('answers PANEL_REPLAY_UNAVAILABLE without a replay service', async () => {
    const fixture = await makeProject()
    const service = makeService(fixture.root)
    expect(await errorCode(() => service.startReplay(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_bili',
    }))).toBe('PANEL_REPLAY_UNAVAILABLE')
  })

  it('rejects bad ids, unknown recordings, bad values and denied roots', async () => {
    const fixture = await makeProject()
    const replay: PanelReplayPort = { startReplay: async () => ({ runId: 'run_x' }) }
    const service = makeService(fixture.root, { replay })

    expect(await errorCode(() => service.startReplay(fixture.root, {
      root: fixture.root,
      recordingId: '../../etc/passwd',
    }))).toBe('PANEL_INVALID_ID')

    expect(await errorCode(() => service.startReplay(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_missing',
    }))).toBe('PANEL_RECORDING_NOT_FOUND')

    expect(await errorCode(() => service.startReplay(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_bili',
      values: { step_1: 42 },
    }))).toBe('PANEL_INVALID_BODY')

    expect(await errorCode(() => service.startReplay('/etc', {
      root: '/etc',
      recordingId: 'rec_bili',
    }))).toBe('PANEL_ROOT_DENIED')
  })

  it('maps an upstream replay failure to PANEL_REPLAY_FAILED with its code', async () => {
    const fixture = await makeProject()
    const replay: PanelReplayPort = {
      async startReplay() {
        throw Object.assign(new Error('recording is incomplete; only completed recordings can be replayed'), {
          code: 'RECORDING_INCOMPLETE',
        })
      },
    }
    const service = makeService(fixture.root, { replay })
    try {
      await service.startReplay(fixture.root, { root: fixture.root, recordingId: 'rec_bili' })
      throw new Error('expected the call to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(PanelError)
      const panelError = error as PanelError
      expect(panelError.code).toBe('PANEL_REPLAY_FAILED')
      expect(panelError.status).toBe(409)
      expect(panelError.message).toContain('RECORDING_INCOMPLETE')
    }
  })

  it('rejects a port that resolves without a runId', async () => {
    const fixture = await makeProject()
    const replay: PanelReplayPort = { startReplay: async () => ({ runId: '' }) }
    const service = makeService(fixture.root, { replay })
    expect(await errorCode(() => service.startReplay(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_bili',
    }))).toBe('PANEL_REPLAY_FAILED')
  })
})

describe('panel trash service (M3)', () => {
  it('moves the whole recording to trash, cleans the index and keeps files byte-identical', async () => {
    const fixture = await makeProject()
    const service = makeService(fixture.root, { now: () => FIXED_NOW })
    const recordingPath = path.join(recordingsDir(fixture.root), 'rec_bili')
    const manifestBefore = await readFile(path.join(recordingPath, 'manifest.json'), 'utf8')
    const stepsBefore = await readFile(path.join(recordingPath, 'steps.jsonl'), 'utf8')
    const videoBefore = await readFile(path.join(recordingPath, 'runs', 'run_ok', 'video', 'replay.webm'))

    const result = await service.trashRecording(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_bili',
    })

    expect(result.recordingId).toBe('rec_bili')
    expect(result.trashPath).toBe('trash/rec_bili-20261101T102350123Z')
    expect(result.movedAt).toBe('2026-11-01T10:23:50.123Z')
    expect(result.indexCleaned).toBe(true)

    // Original directory is gone; the trash copy is complete and unchanged.
    expect(await exists(recordingPath)).toBe(false)
    const trashed = path.join(trashDir(fixture.root), 'rec_bili-20261101T102350123Z')
    expect(await readFile(path.join(trashed, 'manifest.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(path.join(trashed, 'steps.jsonl'), 'utf8')).toBe(stepsBefore)
    expect(Array.from(await readFile(path.join(trashed, 'runs', 'run_ok', 'video', 'replay.webm'))))
      .toEqual(Array.from(videoBefore))
    expect(await exists(path.join(trashed, 'runs', 'run_ok', 'run.json'))).toBe(true)

    // index.json drops only the trashed recording's assignment.
    const index = await readIndex(fixture.root)
    expect((index['assignments'] as Record<string, unknown>)['rec_bili']).toBeUndefined()
    expect((index['assignments'] as Record<string, unknown>)['rec_shop']).toEqual({ scenarioId: 'scn_shop' })

    const project = await service.getProject(fixture.root)
    expect(project.recordings.map((recording) => recording.recordingId)).toEqual(['rec_shop'])
  })

  it('still succeeds when the recording had no index assignment', async () => {
    const fixture = await makeProject()
    await writeIndex(fixture.root, {
      version: 1,
      categories: [{ id: 'saucedemo', name: 'SauceDemo', site: 'saucedemo' }],
      scenarios: [],
      assignments: {},
    })
    const service = makeService(fixture.root)
    const result = await service.trashRecording(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_shop',
    })
    expect(result.indexCleaned).toBe(false)
    const index = await readIndex(fixture.root)
    expect(index['assignments']).toEqual({})
  })

  it('never overwrites an existing trash entry (numeric suffix)', async () => {
    const fixture = await makeProject()
    const service = makeService(fixture.root, { now: () => FIXED_NOW })
    const first = path.join(trashDir(fixture.root), 'rec_bili-20261101T102350123Z')
    await mkdir(first, { recursive: true })
    await writeFile(path.join(first, 'keep.txt'), 'older trash entry', 'utf8')

    const result = await service.trashRecording(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_bili',
    })
    expect(result.trashPath).toBe('trash/rec_bili-20261101T102350123Z-2')
    expect(await readFile(path.join(first, 'keep.txt'), 'utf8')).toBe('older trash entry')
  })

  it('rejects unknown, malformed and denied targets without moving anything', async () => {
    const fixture = await makeProject()
    const service = makeService(fixture.root)

    expect(await errorCode(() => service.trashRecording(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_missing',
    }))).toBe('PANEL_RECORDING_NOT_FOUND')

    expect(await errorCode(() => service.trashRecording(fixture.root, {
      root: fixture.root,
      recordingId: '../rec_bili',
    }))).toBe('PANEL_INVALID_ID')

    expect(await errorCode(() => service.trashRecording('/etc', {
      root: '/etc',
      recordingId: 'rec_bili',
    }))).toBe('PANEL_ROOT_DENIED')

    expect(await exists(path.join(recordingsDir(fixture.root), 'rec_bili'))).toBe(true)
  })

  it('refuses a symlinked recording directory', async () => {
    const fixture = await makeProject()
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-panel-outside-'))
    tempDirs.push(outside)
    const service = makeService(fixture.root)
    const linkPath = path.join(recordingsDir(fixture.root), 'rec_link')
    await symlink(outside, linkPath)

    expect(await errorCode(() => service.trashRecording(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_link',
    }))).toBe('PANEL_ROOT_DENIED')
    expect(await lstat(linkPath).then((info) => info.isSymbolicLink(), () => false)).toBe(true)
  })

  it('refuses a trash directory that resolves outside the store', async () => {
    const fixture = await makeProject()
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-panel-outside-trash-'))
    tempDirs.push(outside)
    const service = makeService(fixture.root)
    const store = storeRoot(fixture.root)
    await mkdir(store, { recursive: true })
    await symlink(outside, path.join(store, 'trash'))

    expect(await errorCode(() => service.trashRecording(fixture.root, {
      root: fixture.root,
      recordingId: 'rec_bili',
    }))).toBe('PANEL_ROOT_DENIED')
    expect(await exists(path.join(recordingsDir(fixture.root), 'rec_bili'))).toBe(true)
  })
})
