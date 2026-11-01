// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PanelApp } from '../../../src/client/panel/App.js'
import { createPanelApi, type PanelApi } from '../../../src/client/panel/api.js'
import { usePanelStore } from '../../../src/client/panel/store.js'
import { createPanelFetchRoutes, type PanelFetchRoute } from '../../../src/panel/fetch-api.js'
import { panelIndexPath, storeRoot } from '../../../src/panel/paths.js'
import { PanelService } from '../../../src/panel/service.js'
import { createFixtureProject, writeIndex, type FixtureProject } from './fixtures.js'

const fixtures: FixtureProject[] = []

afterEach(async () => {
  cleanup()
  await cleanupFixtures()
  usePanelStore.setState({
    root: undefined,
    selectedRecordingId: undefined,
    selectedRunId: undefined,
    search: '',
    expanded: {},
  })
})

async function cleanupFixtures(): Promise<void> {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
}

async function setup(): Promise<{ root: string; api: PanelApi }> {
  const fixture = await createFixtureProject([
    {
      recordingId: 'rec_bili',
      title: 'B站搜索：明日方舟周年庆',
      urls: ['https://search.bilibili.com/all?keyword=x'],
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
    assignments: { rec_bili: { scenarioId: 'anniv' } },
  })

  const service = new PanelService({ roots: [fixture.root], cwd: fixture.root, dshWorkspaces: false })
  const routes = createPanelFetchRoutes(service)
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request
      ? input
      : new Request(new URL(String(input), 'http://127.0.0.1'), init)
    const pathname = new URL(request.url).pathname
    const route: PanelFetchRoute | undefined = routes.find((entry) => entry.path === pathname)
    if (route === undefined) {
      return new Response(JSON.stringify({ error: { code: 'PANEL_NOT_FOUND', message: 'no route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    return await route.fetch(request)
  }) as unknown as typeof fetch

  return {
    root: fixture.root,
    api: createPanelApi('/api/record-replay', fetchImpl),
  }
}

function renderPanel(api: PanelApi): void {
  render(<PanelApp api={api} writable variant="page" />)
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

describe('panel writes end to end (real index + fetch routes)', () => {
  it('renames a scenario and refreshes the tree from index.json', async () => {
    const user = userEvent.setup()
    const { root, api } = await setup()
    renderPanel(api)

    await user.dblClick(await screen.findByText('周年庆'))
    const input = await screen.findByTestId('edit-scenario-anniv')
    await user.clear(input)
    await user.type(input, '周年庆 2026')
    await user.keyboard('{Enter}')

    expect(await screen.findByText('周年庆 2026')).toBeInTheDocument()
    expect(screen.queryByText('周年庆')).toBeNull()
    const index = await readIndex(root)
    expect(index['scenarios']).toEqual([{ id: 'anniv', categoryId: 'bilibili', name: '周年庆 2026' }])
    await cleanupFixtures()
  })

  it('renames a recording title in the tree and the detail, leaving the manifest untouched', async () => {
    const user = userEvent.setup()
    const { root, api } = await setup()
    const before = await manifestBytes(root, 'rec_bili')
    renderPanel(api)

    await user.click(await screen.findByTestId('recording-row-rec_bili'))
    expect(await screen.findByRole('heading', { level: 1, name: 'B站搜索：明日方舟周年庆' })).toBeInTheDocument()

    await user.dblClick(screen.getByTestId('recording-row-rec_bili'))
    const input = await screen.findByTestId('edit-recording-rec_bili')
    await user.clear(input)
    await user.type(input, '改名后的录制')
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('heading', { level: 1, name: '改名后的录制' })).toBeInTheDocument()
    const row = screen.getByTestId('recording-row-rec_bili')
    expect(within(row).getByText('改名后的录制')).toBeInTheDocument()

    const index = await readIndex(root)
    expect((index['assignments'] as Record<string, unknown>)['rec_bili']).toEqual({
      scenarioId: 'anniv',
      title: '改名后的录制',
    })
    expect(await manifestBytes(root, 'rec_bili')).toBe(before)
    await cleanupFixtures()
  })

  it('collects 未分组 recordings into a new scenario and removes the virtual group', async () => {
    const user = userEvent.setup()
    const { root, api } = await setup()
    renderPanel(api)

    expect(await screen.findByTestId('ungrouped-row-saucedemo')).toBeInTheDocument()
    await user.dblClick(screen.getByTestId('ungrouped-row-saucedemo'))
    expect(await screen.findByTestId('create-scenario-dialog')).toBeInTheDocument()
    await user.type(screen.getByTestId('create-scenario-input'), '登录流程')
    await user.click(screen.getByTestId('create-scenario-confirm'))

    expect(await screen.findByText('登录流程')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByTestId('ungrouped-row-saucedemo')).toBeNull()
    })

    const index = await readIndex(root)
    const scenarios = index['scenarios'] as { id: string; categoryId: string; name: string }[]
    const created = scenarios.find((scenario) => scenario.name === '登录流程')
    expect(created).toMatchObject({ categoryId: 'saucedemo' })
    expect((index['assignments'] as Record<string, unknown>)['rec_shop']).toEqual({
      scenarioId: created?.id,
    })
    await cleanupFixtures()
  })
})
