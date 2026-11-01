import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PanelService, type PanelRecordingControlPort } from '../../../src/panel/service.js'
import { createFixtureProject, type FixtureProject } from './fixtures.js'

const fixtures: FixtureProject[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function project(status: 'recording' | 'completed' = 'recording'): Promise<FixtureProject> {
  const fixture = await createFixtureProject([
    {
      recordingId: 'rec_live',
      title: 'Live recording',
      status,
      urls: ['https://example.test/'],
    },
  ])
  fixtures.push(fixture)
  return fixture
}

async function serviceFor(
  fixture: FixtureProject,
  control?: PanelRecordingControlPort,
): Promise<PanelService> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-panel-control-'))
  tempDirs.push(dir)
  return new PanelService({
    roots: [fixture.root],
    cwd: null,
    dshWorkspaces: false,
    workspaceStorePath: path.join(dir, 'workspace.json'),
    statePath: path.join(dir, 'panel-state.json'),
    dshHome: path.join(dir, 'dsh-home'),
    home: path.join(dir, 'user-home'),
    ...(control === undefined ? {} : { control }),
  })
}

describe('panel active recording control', () => {
  it('lists only recordings in recording status with their project', async () => {
    const fixture = await project('recording')
    const completed = await createFixtureProject([
      { recordingId: 'rec_done', title: 'Done', status: 'completed', urls: ['https://example.test/'] },
    ])
    fixtures.push(completed)
    const service = await serviceFor(fixture)

    const active = await service.listActiveRecordings()
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({
      root: await realpath(fixture.root),
      recordingId: 'rec_live',
      title: 'Live recording',
    })
    expect(active.some(item => item.recordingId === 'rec_done')).toBe(false)
  })

  it('delegates stop/discard to the control port and reports capabilities', async () => {
    const fixture = await project()
    const calls: Array<{ action: string; root: string; recordingId: string }> = []
    const control: PanelRecordingControlPort = {
      stop: vi.fn(async (request) => {
        calls.push({ action: 'stop', ...request })
        return { recordingId: request.recordingId, status: 'completed' as const, endReason: 'tool_stopped' as const }
      }),
      discard: vi.fn(async (request) => {
        calls.push({ action: 'discard', ...request })
        return { recordingId: request.recordingId, status: 'cancelled' as const, endReason: 'cancelled' as const }
      }),
    }
    const service = await serviceFor(fixture, control)
    const canonicalRoot = await realpath(fixture.root)

    expect(service.capabilities().control).toBe(true)
    await expect(service.stopRecording(fixture.root, { recordingId: 'rec_live' }))
      .resolves.toEqual({ recordingId: 'rec_live', status: 'completed', endReason: 'tool_stopped' })
    await expect(service.discardRecording(fixture.root, { recordingId: 'rec_live' }))
      .resolves.toEqual({ recordingId: 'rec_live', status: 'cancelled', endReason: 'cancelled' })

    expect(calls).toEqual([
      { action: 'stop', root: canonicalRoot, recordingId: 'rec_live' },
      { action: 'discard', root: canonicalRoot, recordingId: 'rec_live' },
    ])
  })

  it('answers PANEL_CONTROL_UNAVAILABLE when no control port is wired', async () => {
    const fixture = await project()
    const service = await serviceFor(fixture)

    expect(service.capabilities().control).toBeUndefined()
    await expect(service.stopRecording(fixture.root, { recordingId: 'rec_live' }))
      .rejects.toMatchObject({ code: 'PANEL_CONTROL_UNAVAILABLE', status: 503 })
    await expect(service.discardRecording(fixture.root, { recordingId: 'rec_live' }))
      .rejects.toMatchObject({ code: 'PANEL_CONTROL_UNAVAILABLE', status: 503 })
  })
})
