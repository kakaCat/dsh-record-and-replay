import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { scanProject } from '../../../src/panel/scanner.js'
import { panelIndexPath } from '../../../src/panel/paths.js'
import { createFixtureProject, writeIndex, type FixtureProject } from './fixtures.js'

const VIDEO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])

const roots: FixtureProject[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((project) => project.cleanup()))
})

async function project(): Promise<FixtureProject> {
  const created = await createFixtureProject([
    {
      recordingId: 'rec_bili',
      title: 'B站搜索：明日方舟周年庆',
      intent: '在 B 站搜索「明日方舟周年庆」，确认结果页出现活动入口。',
      urls: ['https://search.bilibili.com/all?keyword=x'],
      createdAt: '2026-10-31T10:00:00.000Z',
      updatedAt: '2026-10-31T10:10:00.000Z',
      runs: [
        {
          runId: 'run_ok',
          status: 'completed',
          startedAt: '2026-10-31T11:00:00.000Z',
          finishedAt: '2026-10-31T11:00:02.500Z',
          video: VIDEO,
        },
        {
          runId: 'run_bad',
          status: 'failed',
          startedAt: '2026-10-31T12:00:00.000Z',
          finishedAt: '2026-10-31T12:00:01.000Z',
          errorCode: 'TARGET_NOT_FOUND',
          errorMessage: 'No visible element matched the semantic target',
          failedStepId: 'step_bili_2',
        },
      ],
    },
    {
      recordingId: 'rec_shop',
      title: 'SauceDemo：登录验收',
      urls: ['https://www.saucedemo.com/'],
      createdAt: '2026-10-30T10:00:00.000Z',
      updatedAt: '2026-10-30T10:10:00.000Z',
      runs: [],
    },
  ])
  roots.push(created)
  return created
}

describe('panel scanner', () => {
  it('keeps a cancelled recording visible with its terminal status', async () => {
    const fixture = await createFixtureProject([
      {
        recordingId: 'rec_cancelled',
        title: '主动丢弃的录制',
        status: 'cancelled',
        endReason: 'cancelled',
        suppressedCount: 2,
        urls: ['https://example.test/'],
      },
    ])
    roots.push(fixture)
    const { project: scanned } = await scanProject(fixture.root, { name: 'Demo' })
    expect(scanned.recordings).toHaveLength(1)
    expect(scanned.recordings[0]?.status).toBe('cancelled')
    expect(scanned.recordings[0]?.endReason).toBe('cancelled')
    expect(scanned.recordings[0]?.suppressedCount).toBe(2)
  })

  it('scans recordings, runs, sites, video size and stats', async () => {
    const fixture = await project()
    const { project: scanned, runsByRecording } = await scanProject(fixture.root, { name: 'Demo' })

    expect(scanned.name).toBe('Demo')
    expect(scanned.indexSource).toBe('rebuilt')
    expect(scanned.recordings.map((recording) => recording.recordingId)).toEqual(['rec_bili', 'rec_shop'])
    expect(scanned.recordings[0]?.site).toBe('bilibili')
    expect(scanned.recordings[0]?.categoryId).toBe('bilibili')
    expect(scanned.recordings[1]?.site).toBe('saucedemo')
    expect(scanned.recordings[0]?.intent).toBe('在 B 站搜索「明日方舟周年庆」，确认结果页出现活动入口。')
    expect(scanned.recordings[0]?.intentSource).toBe('manifest')
    expect(scanned.recordings[1]?.intent).toBeUndefined()
    expect(scanned.recordings[1]?.intentSource).toBeUndefined()
    expect(scanned.categories.map((category) => category.name).sort()).toEqual(['B站', 'SauceDemo'])

    const runs = runsByRecording.get('rec_bili') ?? []
    expect(runs.map((run) => run.runId)).toEqual(['run_bad', 'run_ok'])
    expect(runs[0]?.errorCode).toBe('TARGET_NOT_FOUND')
    expect(runs[0]?.failedStepId).toBe('step_bili_2')
    expect(runs[0]?.durationMs).toBe(1000)
    expect(runs[1]?.videoPath).toBe('runs/run_ok/video/replay.webm')
    expect(runs[1]?.videoBytes).toBe(VIDEO.byteLength)
    expect(runs[1]?.hasVideo).toBe(true)

    expect(scanned.stats).toMatchObject({
      recordings: 2,
      runs: 2,
      failedRuns: 1,
      cancelledRuns: 0,
      failureRate: 0.5,
      videoFiles: 1,
      videoBytes: VIDEO.byteLength,
      steps: 2,
    })
    expect(scanned.warnings.filter((warning) => warning.includes('invalid'))).toEqual([])
    expect(scanned.warnings.some((warning) => warning.includes('index.json is missing'))).toBe(true)
  })

  it('skips corrupt recordings and runs with warnings', async () => {
    const fixture = await project()
    const corruptDir = path.join(fixture.root, '.dsh', 'record-replay', 'recordings', 'rec_corrupt')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(path.join(corruptDir, 'manifest.json'), '{not json', 'utf8')

    const badRunDir = path.join(fixture.root, '.dsh', 'record-replay', 'recordings', 'rec_shop', 'runs', 'run_broken')
    await mkdir(badRunDir, { recursive: true })
    await writeFile(path.join(badRunDir, 'run.json'), '{"runId":"other"}', 'utf8')

    const { project: scanned } = await scanProject(fixture.root)
    expect(scanned.recordings).toHaveLength(2)
    expect(scanned.warnings.some((warning) => warning.includes('rec_corrupt'))).toBe(true)
    expect(scanned.warnings.some((warning) => warning.includes('run_broken'))).toBe(true)
  })

  it('rebuilds a missing index in memory and does not create index.json', async () => {
    const fixture = await project()
    const indexPath = panelIndexPath(fixture.root)
    const { project: scanned } = await scanProject(fixture.root)
    expect(scanned.indexSource).toBe('rebuilt')
    expect(scanned.scenarios).toEqual([])
    expect(scanned.warnings.some((warning) => warning.includes('index.json is missing'))).toBe(true)
    await expect(stat(indexPath)).rejects.toThrow()
  })

  it('uses a valid index for category names, scenarios and assignments', async () => {
    const fixture = await project()
    await writeIndex(fixture.root, {
      version: 1,
      categories: [
        { id: 'video', name: '视频站', site: 'bilibili' },
        { id: 'shop', name: '商店', site: 'saucedemo' },
      ],
      scenarios: [{ id: 'anniv', categoryId: 'video', name: '周年庆' }],
      assignments: { rec_bili: { scenarioId: 'anniv' } },
    })
    const { project: scanned } = await scanProject(fixture.root)
    expect(scanned.indexSource).toBe('loaded')
    expect(scanned.categories.find((category) => category.site === 'bilibili')?.name).toBe('视频站')
    expect(scanned.scenarios).toEqual([{ id: 'anniv', categoryId: 'video', name: '周年庆' }])
    expect(scanned.recordings.find((recording) => recording.recordingId === 'rec_bili')?.scenarioId).toBe('anniv')
    expect(scanned.recordings.find((recording) => recording.recordingId === 'rec_shop')?.scenarioId).toBeUndefined()
  })

  it('reads an index-annotated intent without rewriting recording files', async () => {
    const fixture = await project()
    const manifestPath = path.join(
      fixture.root,
      '.dsh',
      'record-replay',
      'recordings',
      'rec_bili',
      'manifest.json',
    )
    const before = await readFile(manifestPath, 'utf8')
    await writeIndex(fixture.root, {
      version: 1,
      categories: [],
      scenarios: [],
      assignments: {
        rec_bili: { intent: 'index 补注：用周年庆关键词搜索并核对首屏。' },
        rec_shop: { intent: 'index 补注：登录后确认商品列表可见。' },
      },
    })

    const { project: scanned } = await scanProject(fixture.root)
    expect(scanned.indexSource).toBe('loaded')
    const bili = scanned.recordings.find((recording) => recording.recordingId === 'rec_bili')
    const shop = scanned.recordings.find((recording) => recording.recordingId === 'rec_shop')
    expect(bili?.intent).toBe('index 补注：用周年庆关键词搜索并核对首屏。')
    expect(bili?.intentSource).toBe('index')
    expect(shop?.intent).toBe('index 补注：登录后确认商品列表可见。')
    expect(shop?.intentSource).toBe('index')
    // Annotations live in index.json: the recording manifest stays byte-identical.
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
  })

  it('reads an index-annotated title without rewriting recording files', async () => {
    const fixture = await project()
    const manifestPath = path.join(
      fixture.root,
      '.dsh',
      'record-replay',
      'recordings',
      'rec_bili',
      'manifest.json',
    )
    const before = await readFile(manifestPath, 'utf8')
    await writeIndex(fixture.root, {
      version: 1,
      categories: [],
      scenarios: [],
      assignments: { rec_bili: { title: 'index 覆盖标题' } },
    })

    const { project: scanned } = await scanProject(fixture.root)
    const bili = scanned.recordings.find((recording) => recording.recordingId === 'rec_bili')
    const shop = scanned.recordings.find((recording) => recording.recordingId === 'rec_shop')
    expect(bili?.title).toBe('index 覆盖标题')
    expect(bili?.titleSource).toBe('index')
    expect(shop?.title).toBe('SauceDemo：登录验收')
    expect(shop?.titleSource).toBe('manifest')
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
  })

  it('keeps an intent annotation whose scenario no longer exists', async () => {
    const fixture = await project()
    await writeIndex(fixture.root, {
      version: 1,
      categories: [{ id: 'video', name: '视频站', site: 'bilibili' }],
      scenarios: [],
      assignments: { rec_bili: { scenarioId: 'gone', intent: '场景已删，但用例意图要保留。' } },
    })
    const { project: scanned } = await scanProject(fixture.root)
    const bili = scanned.recordings.find((recording) => recording.recordingId === 'rec_bili')
    expect(bili?.scenarioId).toBeUndefined()
    expect(bili?.intent).toBe('场景已删，但用例意图要保留。')
    expect(bili?.intentSource).toBe('index')
    expect(scanned.warnings.some((warning) => warning.includes('missing scenarios'))).toBe(true)
  })

  it('rebuilds a corrupt index without rewriting the file', async () => {
    const fixture = await project()
    const indexPath = panelIndexPath(fixture.root)
    await writeIndex(fixture.root, { version: 99, categories: 'nope' })
    const before = await readFile(indexPath, 'utf8')
    const { project: scanned } = await scanProject(fixture.root)
    const after = await readFile(indexPath, 'utf8')
    expect(scanned.indexSource).toBe('rebuilt')
    expect(scanned.warnings.some((warning) => warning.includes('does not match version 1'))).toBe(true)
    expect(after).toBe(before)
  })

  it('adds categories for sites missing from a valid index', async () => {
    const fixture = await project()
    await writeIndex(fixture.root, {
      version: 1,
      categories: [{ id: 'video', name: '视频站', site: 'bilibili' }],
      scenarios: [],
      assignments: {},
    })
    const { project: scanned } = await scanProject(fixture.root)
    expect(scanned.indexSource).toBe('loaded')
    expect(scanned.categories.some((category) => category.site === 'saucedemo')).toBe(true)
    expect(scanned.warnings.some((warning) => warning.includes('missing categories'))).toBe(true)
  })
})
