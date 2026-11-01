import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { mapWithConcurrency } from '../../../src/panel/concurrency.js'
import { parsePagination, parseSearchLimit } from '../../../src/panel/pagination.js'
import { PanelService } from '../../../src/panel/service.js'
import {
  PANEL_SCAN_CONCURRENCY,
  PANEL_SEARCH_LIMIT_DEFAULT,
  PANEL_SEARCH_LIMIT_MAX,
} from '../../../src/panel/types.js'
import { createFixtureProject, writeIndex, type FixtureProject } from './fixtures.js'

const VIDEO = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

const fixtures: FixtureProject[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface Setup {
  readonly rootA: string
  readonly rootB: string
  readonly service: PanelService
}

async function setup(): Promise<Setup> {
  const projectA = await createFixtureProject([
    {
      recordingId: 'rec_alpha',
      title: 'Alpha 登录',
      urls: ['https://search.bilibili.com/all?keyword=alpha'],
      updatedAt: '2026-10-31T12:00:00.000Z',
      runs: [
        {
          runId: 'run_a_ok',
          status: 'completed',
          startedAt: '2026-10-31T11:00:00.000Z',
          finishedAt: '2026-10-31T11:00:01.000Z',
          video: VIDEO,
        },
        {
          runId: 'run_a_bad',
          status: 'failed',
          startedAt: '2026-10-31T11:30:00.000Z',
          finishedAt: '2026-10-31T11:30:00.500Z',
          errorCode: 'TARGET_NOT_FOUND',
        },
      ],
    },
    {
      recordingId: 'rec_alpha2',
      title: 'Alpha 排行榜',
      urls: ['https://search.bilibili.com/all?keyword=rank'],
      updatedAt: '2026-10-30T12:00:00.000Z',
    },
    {
      recordingId: 'rec_alpha3',
      title: 'Alpha 设置',
      urls: ['https://search.bilibili.com/all?keyword=settings'],
      updatedAt: '2026-10-29T12:00:00.000Z',
    },
  ])
  const projectB = await createFixtureProject([
    {
      recordingId: 'rec_beta',
      title: 'Beta 登录验收',
      intent: 'alpha 用例：登录后核对首屏',
      urls: ['https://www.saucedemo.com/'],
      updatedAt: '2026-10-28T12:00:00.000Z',
      runs: [
        {
          runId: 'run_b_bad',
          status: 'failed',
          startedAt: '2026-10-28T11:00:00.000Z',
          finishedAt: '2026-10-28T11:00:00.500Z',
          errorCode: 'ASSERTION_FAILED',
          video: VIDEO.slice(0, 4),
        },
      ],
    },
  ])
  fixtures.push(projectA, projectB)

  await writeIndex(projectA.root, {
    version: 1,
    categories: [{ id: 'bilibili', name: 'B站', site: 'bilibili' }],
    scenarios: [{ id: 'anniv', categoryId: 'bilibili', name: '周年庆' }],
    assignments: { rec_alpha: { scenarioId: 'anniv' } },
  })

  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-panel-m2-state-'))
  tempDirs.push(stateDir)
  const service = new PanelService({
    roots: [projectA.root, projectB.root],
    cwd: projectA.root,
    dshWorkspaces: false,
    statePath: path.join(stateDir, 'panel-state.json'),
    dshHome: path.join(stateDir, 'dsh-home'),
    home: path.join(stateDir, 'home'),
  })
  return {
    rootA: await realpath(projectA.root),
    rootB: await realpath(projectB.root),
    service,
  }
}

describe('bounded concurrency', () => {
  it('never runs more than the configured number of workers', async () => {
    let active = 0
    let peak = 0
    const items = Array.from({ length: 12 }, (_, index) => index)
    const results = await mapWithConcurrency(items, 4, async (item) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return item * 2
    })
    expect(peak).toBe(4)
    expect(results).toEqual(items.map((item) => item * 2))
    expect(PANEL_SCAN_CONCURRENCY).toBe(4)
  })

  it('preserves input order and handles empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
    const results = await mapWithConcurrency([3, 1, 2], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value))
      return value
    })
    expect(results).toEqual([3, 1, 2])
    await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toBeInstanceOf(RangeError)
  })
})

describe('cross-project search', () => {
  it('groups matching recordings by project, with category/scenario context', async () => {
    const { rootA, rootB, service } = await setup()
    const result = await service.searchAll('alpha')

    expect(result.total).toBe(4)
    expect(result.returned).toBe(4)
    expect(result.truncated).toBe(false)
    expect(result.limit).toBe(PANEL_SEARCH_LIMIT_DEFAULT)
    expect(result.groups).toHaveLength(2)

    const [first, second] = result.groups
    expect(first?.projectRoot).toBe(rootA)
    expect(first?.matches.map((match) => match.recording.recordingId)).toEqual([
      'rec_alpha',
      'rec_alpha2',
      'rec_alpha3',
    ])
    expect(first?.matches[0]?.matchKind).toBe('recording')
    expect(first?.matches[0]?.categoryName).toBe('B站')
    expect(first?.matches[0]?.scenarioName).toBe('周年庆')
    expect(first?.matches[0]?.matchedRuns.map((run) => run.runId)).toEqual(['run_a_bad', 'run_a_ok'])

    expect(second?.projectRoot).toBe(rootB)
    expect(second?.matches.map((match) => match.recording.recordingId)).toEqual(['rec_beta'])
    expect(second?.matches[0]?.recording.intent).toBe('alpha 用例：登录后核对首屏')
  })

  it('matches runs by status and reports the matched runs', async () => {
    const { service } = await setup()
    const result = await service.searchAll('failed')
    expect(result.groups).toHaveLength(2)
    const matches = result.groups.flatMap((group) => group.matches)
    expect(matches.every((match) => match.matchKind === 'run')).toBe(true)
    expect(matches.flatMap((match) => match.matchedRuns.map((run) => run.runId)).sort()).toEqual([
      'run_a_bad',
      'run_b_bad',
    ])
  })

  it('treats a missing root and the `*` sentinel as all projects', async () => {
    const { rootA, rootB, service } = await setup()
    const missing = await service.searchAll('alpha')
    const star = await service.searchAll('alpha', { root: '*' })
    expect(star).toEqual(missing)

    const one = await service.searchAll('alpha', { root: rootA })
    expect(one.groups).toHaveLength(1)
    expect(one.groups[0]?.projectRoot).toBe(rootA)
    expect(one.total).toBe(3)

    const other = await service.searchAll('alpha', { root: rootB })
    expect(other.groups.map((group) => group.projectRoot)).toEqual([rootB])
  })

  it('caps results across groups and reports truncation', async () => {
    const { service } = await setup()
    const limited = await service.searchAll('alpha', { limit: 2 })
    expect(limited.total).toBe(4)
    expect(limited.returned).toBe(2)
    expect(limited.truncated).toBe(true)
    expect(limited.limit).toBe(2)
    expect(limited.groups).toHaveLength(1)
    expect(limited.groups[0]?.matches).toHaveLength(2)

    const exact = await service.searchAll('alpha', { limit: 3 })
    expect(exact.returned).toBe(3)
    expect(exact.groups).toHaveLength(1)

    await expect(service.searchAll('alpha', { limit: 0 })).rejects.toMatchObject({
      code: 'PANEL_INVALID_LIMIT',
    })
    await expect(service.searchAll('alpha', { limit: PANEL_SEARCH_LIMIT_MAX + 1 })).rejects.toMatchObject({
      code: 'PANEL_INVALID_LIMIT',
    })
    await expect(service.searchAll('   ')).rejects.toMatchObject({ code: 'PANEL_SEARCH_REQUIRED' })
  })

  it('returns no groups when nothing matches', async () => {
    const { service } = await setup()
    const result = await service.searchAll('no-such-needle')
    expect(result.groups).toEqual([])
    expect(result.total).toBe(0)
    expect(result.returned).toBe(0)
    expect(result.truncated).toBe(false)
  })
})

describe('system statistics', () => {
  it('aggregates system totals and per-project stats from one scan each', async () => {
    const { rootA, rootB, service } = await setup()
    const report = await service.getStatsReport()

    expect(report.projects.map((project) => project.root)).toEqual([rootA, rootB])
    expect(report.projects[0]?.stats).toMatchObject({
      recordings: 3,
      runs: 2,
      failedRuns: 1,
      videoFiles: 1,
      videoBytes: VIDEO.byteLength,
    })
    expect(report.projects[1]?.stats).toMatchObject({
      recordings: 1,
      runs: 1,
      failedRuns: 1,
      videoFiles: 1,
      videoBytes: 4,
    })
    expect(report.system).toMatchObject({
      projects: 2,
      recordings: 4,
      runs: 3,
      failedRuns: 2,
      videoFiles: 2,
      videoBytes: VIDEO.byteLength + 4,
    })
    expect(report.system.failureRate).toBeCloseTo(2 / 3)
  })
})

describe('pagination', () => {
  it('parses defaults, explicit values and rejects out-of-range input', () => {
    expect(parsePagination(undefined, undefined)).toEqual({ limit: 50, offset: 0 })
    expect(parsePagination('12', '24')).toEqual({ limit: 12, offset: 24 })
    expect(() => parsePagination('0', '0')).toThrowError(/limit/)
    expect(() => parsePagination('201', '0')).toThrowError(/limit/)
    expect(() => parsePagination('10', '-1')).toThrowError(/offset/)
    expect(() => parsePagination('abc', '0')).toThrowError(/limit/)
    expect(parseSearchLimit(undefined)).toBe(PANEL_SEARCH_LIMIT_DEFAULT)
    expect(parseSearchLimit('500')).toBe(500)
    expect(() => parseSearchLimit('501')).toThrowError(/limit/)
  })

  it('pages the project list with a total and hasMore', async () => {
    const { rootA, rootB, service } = await setup()
    const first = await service.listProjectsPage({ limit: 1, offset: 0 })
    expect(first.projects).toHaveLength(1)
    expect(first.projects[0]?.root).toBe(rootA)
    expect(first.page).toEqual({ total: 2, limit: 1, offset: 0, hasMore: true })

    const second = await service.listProjectsPage({ limit: 1, offset: 1 })
    expect(second.projects.map((project) => project.root)).toEqual([rootB])
    expect(second.page).toEqual({ total: 2, limit: 1, offset: 1, hasMore: false })

    const past = await service.listProjectsPage({ limit: 50, offset: 99 })
    expect(past.projects).toEqual([])
    expect(past.page).toMatchObject({ total: 2, hasMore: false })
  })

  it('pages recordings while keeping whole-project stats and metadata', async () => {
    const { rootA, service } = await setup()
    const first = await service.getProject(rootA, { limit: 2, offset: 0 })
    expect(first.recordings).toHaveLength(2)
    expect(first.recordingsTotal).toBe(3)
    expect(first.recordingsPage).toEqual({ total: 3, limit: 2, offset: 0, hasMore: true })
    // Stats are computed over the whole project, not just this page.
    expect(first.stats).toMatchObject({ recordings: 3, runs: 2 })

    const second = await service.getProject(rootA, { limit: 2, offset: 2 })
    expect(second.recordings.map((recording) => recording.recordingId)).toEqual(['rec_alpha3'])
    expect(second.recordingsPage).toEqual({ total: 3, limit: 2, offset: 2, hasMore: false })

    const past = await service.getProject(rootA, { limit: 2, offset: 50 })
    expect(past.recordings).toEqual([])
    expect(past.recordingsTotal).toBe(3)
    expect(past.recordingsPage).toMatchObject({ total: 3, hasMore: false })
  })
})
