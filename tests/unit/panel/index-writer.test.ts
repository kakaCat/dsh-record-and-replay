import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  PanelIndexWriteQueue,
  PanelIndexWriter,
} from '../../../src/panel/index-writer.js'
import { panelIndexPath, storeRoot } from '../../../src/panel/paths.js'
import { scanProject } from '../../../src/panel/scanner.js'
import { createFixtureProject, writeIndex, type FixtureProject } from './fixtures.js'

const fixtures: FixtureProject[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const BILI_RUNS = [{
  runId: 'run_ok',
  status: 'completed' as const,
  startedAt: '2026-10-31T11:00:00.000Z',
  finishedAt: '2026-10-31T11:00:01.000Z',
}]

interface Setup {
  readonly root: string
  readonly writer: PanelIndexWriter
}

async function setup(index?: unknown): Promise<Setup> {
  const fixture = await createFixtureProject([
    {
      recordingId: 'rec_bili',
      title: 'B站搜索：明日方舟周年庆',
      intent: 'manifest 原文',
      urls: ['https://search.bilibili.com/all?keyword=x'],
      runs: BILI_RUNS,
    },
    {
      recordingId: 'rec_bili2',
      title: 'B站搜索：终末地',
      urls: ['https://search.bilibili.com/all?keyword=y'],
    },
    {
      recordingId: 'rec_shop',
      title: 'SauceDemo：登录验收',
      urls: ['https://www.saucedemo.com/'],
    },
  ])
  fixtures.push(fixture)
  if (index !== undefined) await writeIndex(fixture.root, index)
  return {
    root: fixture.root,
    writer: new PanelIndexWriter({ queue: new PanelIndexWriteQueue() }),
  }
}

const BASE_INDEX = {
  version: 1,
  categories: [
    { id: 'bilibili', name: 'B站', site: 'bilibili' },
    { id: 'saucedemo', name: 'SauceDemo', site: 'saucedemo' },
  ],
  scenarios: [{ id: 'anniv', categoryId: 'bilibili', name: '周年庆' }],
  assignments: {
    rec_bili: { scenarioId: 'anniv', intent: 'index 补注' },
    rec_bili2: { scenarioId: 'anniv' },
  },
}

async function readIndex(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(panelIndexPath(root), 'utf8')) as Record<string, unknown>
}

async function manifestBytes(root: string, recordingId: string): Promise<string> {
  return await readFile(
    path.join(storeRoot(root), 'recordings', recordingId, 'manifest.json'),
    'utf8',
  )
}

describe('panel index writer', () => {
  it('renames a category and persists a sorted, complete index', async () => {
    const { root, writer } = await setup(BASE_INDEX)
    const result = await writer.updateCategory(root, { id: 'bilibili', name: '  视频站  ' })
    expect(result.category).toMatchObject({ id: 'bilibili', name: '视频站' })
    expect(result.indexSource).toBe('loaded')

    const index = await readIndex(root)
    expect(index['categories']).toContainEqual({ id: 'bilibili', name: '视频站', site: 'bilibili' })
    expect(index['assignments']).toMatchObject({
      rec_bili: { scenarioId: 'anniv', intent: 'index 补注' },
      rec_bili2: { scenarioId: 'anniv' },
    })
    // No temp files survive the atomic rename.
    const entries = await readdir(storeRoot(root))
    expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('renames a scenario', async () => {
    const { root, writer } = await setup(BASE_INDEX)
    const result = await writer.updateScenario(root, { id: 'anniv', name: '周年庆 2026' })
    expect(result.scenario).toEqual({ id: 'anniv', categoryId: 'bilibili', name: '周年庆 2026' })
    const index = await readIndex(root)
    expect(index['scenarios']).toEqual([{ id: 'anniv', categoryId: 'bilibili', name: '周年庆 2026' }])
  })

  it('creates a scenario and collects every 未分组 recording of the category', async () => {
    const { root, writer } = await setup({
      ...BASE_INDEX,
      assignments: {
        rec_bili: { intent: 'index 补注' },
        rec_bili2: { scenarioId: 'anniv' },
      },
    })
    const result = await writer.createScenario(root, {
      categoryId: 'bilibili',
      name: '  终末地  ',
      includeUngrouped: true,
    })
    expect(result.scenario.name).toBe('终末地')
    expect(result.scenario.id).toMatch(/^scn_/u)
    expect(result.assignedCount).toBe(1)

    const index = await readIndex(root)
    expect(index['scenarios']).toContainEqual(result.scenario)
    expect(index['assignments']).toMatchObject({
      rec_bili: { scenarioId: result.scenario.id, intent: 'index 补注' },
      // Already grouped: untouched.
      rec_bili2: { scenarioId: 'anniv' },
    })
    // Another category's 未分组 recording is not collected.
    expect((index['assignments'] as Record<string, unknown>)['rec_shop']).toBeUndefined()

    const { project } = await scanProject(root)
    expect(project.recordings.find((recording) => recording.recordingId === 'rec_bili')?.scenarioId)
      .toBe(result.scenario.id)
    expect(project.scenarios.map((scenario) => scenario.name)).toContain('终末地')
  })

  it('writes a recording title override to the index without touching the manifest', async () => {
    const { root, writer } = await setup(BASE_INDEX)
    const before = await manifestBytes(root, 'rec_bili')

    const result = await writer.updateRecording(root, { id: 'rec_bili', title: '  改过的标题  ' })
    expect(result.assignment).toEqual({
      scenarioId: 'anniv',
      intent: 'index 补注',
      title: '改过的标题',
    })
    expect(await manifestBytes(root, 'rec_bili')).toBe(before)

    const index = await readIndex(root)
    expect((index['assignments'] as Record<string, unknown>)['rec_bili']).toEqual(result.assignment)

    const { project } = await scanProject(root)
    const recording = project.recordings.find((entry) => entry.recordingId === 'rec_bili')
    expect(recording?.title).toBe('改过的标题')
    expect(recording?.titleSource).toBe('index')
    // The manifest title stays visible through the raw file.
    expect(JSON.parse(before)).toMatchObject({ title: 'B站搜索：明日方舟周年庆' })
  })

  it('moves a recording back to 未分组 while keeping intent/title annotations', async () => {
    const { root, writer } = await setup(BASE_INDEX)
    await writer.updateRecording(root, { id: 'rec_bili', title: '改过的标题' })
    const result = await writer.updateRecording(root, { id: 'rec_bili', scenarioId: null })
    expect(result.assignment).toEqual({ intent: 'index 补注', title: '改过的标题' })

    const { project } = await scanProject(root)
    const recording = project.recordings.find((entry) => entry.recordingId === 'rec_bili')
    expect(recording?.scenarioId).toBeUndefined()
    expect(recording?.title).toBe('改过的标题')
    expect(recording?.intent).toBe('index 补注')
  })

  it('rejects unknown ids, cross-category moves and invalid names without writing', async () => {
    const { root, writer } = await setup(BASE_INDEX)
    const before = await readFile(panelIndexPath(root), 'utf8')

    await expect(writer.updateCategory(root, { id: 'nope', name: 'x' }))
      .rejects.toMatchObject({ code: 'PANEL_CATEGORY_NOT_FOUND' })
    await expect(writer.updateScenario(root, { id: 'nope', name: 'x' }))
      .rejects.toMatchObject({ code: 'PANEL_SCENARIO_NOT_FOUND' })
    await expect(writer.updateRecording(root, { id: 'rec_nope', title: 'x' }))
      .rejects.toMatchObject({ code: 'PANEL_RECORDING_NOT_FOUND' })
    await expect(writer.updateRecording(root, { id: 'rec_bili', scenarioId: 'missing' }))
      .rejects.toMatchObject({ code: 'PANEL_SCENARIO_NOT_FOUND' })
    // anniv belongs to bilibili, not saucedemo.
    await expect(writer.updateRecording(root, { id: 'rec_shop', scenarioId: 'anniv' }))
      .rejects.toMatchObject({ code: 'PANEL_SCENARIO_MISMATCH' })

    await expect(writer.updateCategory(root, { id: 'bilibili', name: '   ' }))
      .rejects.toMatchObject({ code: 'PANEL_INVALID_NAME' })
    await expect(writer.updateScenario(root, { id: 'anniv', name: 'x'.repeat(81) }))
      .rejects.toMatchObject({ code: 'PANEL_INVALID_NAME' })
    await expect(writer.updateRecording(root, { id: 'rec_bili' }))
      .rejects.toMatchObject({ code: 'PANEL_INVALID_BODY' })
    await expect(writer.updateCategory(root, { id: 'bad id', name: 'x' }))
      .rejects.toMatchObject({ code: 'PANEL_INVALID_ID' })
    await expect(writer.createScenario(root, { categoryId: 'bilibili', name: 'x', includeUngrouped: 'yes' }))
      .rejects.toMatchObject({ code: 'PANEL_INVALID_BODY' })

    expect(await readFile(panelIndexPath(root), 'utf8')).toBe(before)
  })

  it('rejects an unparseable index and leaves the file untouched', async () => {
    const { root, writer } = await setup()
    const indexPath = panelIndexPath(root)
    await writeFile(indexPath, '{not json', 'utf8')
    const before = await readFile(indexPath, 'utf8')

    await expect(writer.updateCategory(root, { id: 'bilibili', name: 'x' }))
      .rejects.toMatchObject({ code: 'PANEL_INDEX_CORRUPT' })
    expect(await readFile(indexPath, 'utf8')).toBe(before)
  })

  it('rebuilds a missing index from recording sites before writing', async () => {
    const { root, writer } = await setup()
    const result = await writer.updateCategory(root, { id: 'bilibili', name: '视频站' })
    expect(result.indexSource).toBe('rebuilt')
    expect(result.warnings.some((warning) => warning.includes('rebuilt'))).toBe(true)

    const index = await readIndex(root)
    expect(index['categories']).toContainEqual({ id: 'bilibili', name: '视频站', site: 'bilibili' })
    expect(index['categories']).toContainEqual({ id: 'saucedemo', name: 'SauceDemo', site: 'saucedemo' })
    expect(index['assignments']).toEqual({})
  })

  it('salvages a partially corrupt index without dropping readable assignments', async () => {
    const { root, writer } = await setup({
      version: 1,
      categories: [{ id: 'bilibili', name: 'B站', site: 'bilibili' }],
      scenarios: 'not-an-array',
      assignments: {
        rec_bili: { intent: '保留我' },
        rec_shop: { title: '覆盖标题' },
      },
    })
    const result = await writer.updateCategory(root, { id: 'bilibili', name: '视频站' })
    expect(result.indexSource).toBe('rebuilt')
    expect(result.warnings.some((warning) => warning.includes('partially unreadable'))).toBe(true)

    const index = await readIndex(root)
    expect(index['categories']).toContainEqual({ id: 'bilibili', name: '视频站', site: 'bilibili' })
    // The missing site category is rebuilt while assignments survive.
    expect(index['categories']).toContainEqual({ id: 'saucedemo', name: 'SauceDemo', site: 'saucedemo' })
    expect(index['assignments']).toMatchObject({
      rec_bili: { intent: '保留我' },
      rec_shop: { title: '覆盖标题' },
    })
  })

  it('serializes concurrent read-modify-write operations', async () => {
    const { root, writer } = await setup(BASE_INDEX)
    await Promise.all([
      writer.updateCategory(root, { id: 'bilibili', name: '视频站' }),
      writer.updateScenario(root, { id: 'anniv', name: '周年庆 2026' }),
      writer.updateRecording(root, { id: 'rec_bili', title: '并发改标题' }),
      writer.updateRecording(root, { id: 'rec_bili2', title: '并发改标题 2' }),
    ])

    const index = await readIndex(root)
    expect(index['categories']).toContainEqual({ id: 'bilibili', name: '视频站', site: 'bilibili' })
    expect(index['scenarios']).toEqual([{ id: 'anniv', categoryId: 'bilibili', name: '周年庆 2026' }])
    expect(index['assignments']).toMatchObject({
      rec_bili: { scenarioId: 'anniv', intent: 'index 补注', title: '并发改标题' },
      rec_bili2: { scenarioId: 'anniv', title: '并发改标题 2' },
    })
  })

  it('never exposes a half-written index to readers', async () => {
    const { root, writer } = await setup(BASE_INDEX)
    const reads: Promise<void>[] = []
    for (let index = 0; index < 20; index += 1) {
      const write = writer.updateRecording(root, { id: 'rec_bili2', title: `标题 ${String(index)}` })
      const read = readFile(panelIndexPath(root), 'utf8').then((text) => {
        expect(() => JSON.parse(text)).not.toThrow()
      })
      reads.push(read)
      await write
    }
    await Promise.all(reads)
  })

  it('supports an isolated writer queue in another temp store', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-panel-writer-empty-'))
    tempDirs.push(root)
    const writer = new PanelIndexWriter()
    await expect(writer.updateCategory(root, { id: 'bilibili', name: 'x' }))
      .rejects.toMatchObject({ code: 'PANEL_CATEGORY_NOT_FOUND' })
    await expect(readFile(panelIndexPath(root), 'utf8')).rejects.toThrow()
  })
})
