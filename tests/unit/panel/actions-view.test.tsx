// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PanelApp } from '../../../src/client/panel/App.js'
import { createPanelApi, type PanelApi } from '../../../src/client/panel/api.js'
import { usePanelStore } from '../../../src/client/panel/store.js'
import { createPanelFetchRoutes, type PanelFetchRoute } from '../../../src/panel/fetch-api.js'
import { recordingsDir, storeRoot, trashDir } from '../../../src/panel/paths.js'
import { PanelService, type PanelReplayPort, type PanelReplayRequest } from '../../../src/panel/service.js'
import { createFixtureProject, writeIndex, type FixtureProject } from './fixtures.js'

const fixtures: FixtureProject[] = []

afterEach(async () => {
  cleanup()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
  usePanelStore.setState({
    root: undefined,
    selectedRecordingId: undefined,
    selectedRunId: undefined,
    search: '',
    expanded: {},
  })
})

interface SetupResult {
  readonly root: string
  readonly api: PanelApi
}

async function setup(replay?: PanelReplayPort): Promise<SetupResult> {
  const fixture = await createFixtureProject([
    {
      recordingId: 'rec_bili',
      title: 'B站搜索：明日方舟周年庆',
      urls: ['https://search.bilibili.com/all?keyword=x'],
      runs: [{
        runId: 'run_ok',
        status: 'completed',
        startedAt: '2026-10-31T11:00:00.000Z',
        finishedAt: '2026-10-31T11:00:01.000Z',
        video: new Uint8Array([1, 2, 3]),
      }],
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

  const service = new PanelService({
    roots: [fixture.root],
    cwd: fixture.root,
    dshWorkspaces: false,
    trash: true,
    ...(replay === undefined ? {} : { replay }),
  })
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

  return { root: fixture.root, api: createPanelApi('/api/record-replay', fetchImpl) }
}

async function writeRun(
  root: string,
  recordingId: string,
  runId: string,
  status: 'running' | 'completed' | 'failed',
  options: { readonly video?: boolean; readonly errorCode?: string } = {},
): Promise<void> {
  const dir = path.join(recordingsDir(root), recordingId, 'runs', runId)
  await mkdir(path.join(dir, 'evidence'), { recursive: true })
  await writeFile(path.join(dir, 'steps.jsonl'), '', 'utf8')
  await writeFile(path.join(dir, 'run.json'), `${JSON.stringify({
    schemaVersion: 1,
    runId,
    recordingId,
    recordingSha256: '0'.repeat(64),
    driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
    status,
    startedAt: '2026-11-01T12:00:00.000Z',
    ...(status === 'running' ? {} : { finishedAt: '2026-11-01T12:00:02.000Z' }),
    ...(options.errorCode === undefined ? {} : { error: { code: options.errorCode, message: 'boom' } }),
  }, null, 2)}\n`, 'utf8')
  if (options.video === true) {
    await mkdir(path.join(dir, 'video'), { recursive: true })
    await writeFile(path.join(dir, 'video', 'replay.webm'), new Uint8Array([9, 8, 7, 6]))
  }
}

function createFakeReplay(delayMs = 60): { port: PanelReplayPort; calls: PanelReplayRequest[] } {
  const calls: PanelReplayRequest[] = []
  const port: PanelReplayPort = {
    async startReplay(input) {
      calls.push(input)
      await writeRun(input.root, input.recordingId, 'run_panel', 'running')
      setTimeout(() => {
        void writeRun(input.root, input.recordingId, 'run_panel', 'completed', { video: true })
      }, delayMs)
      return { runId: 'run_panel' }
    },
  }
  return { port, calls }
}

function renderPanel(api: PanelApi, writable = true): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  render(
    <PanelApp
      api={api}
      queryClient={queryClient}
      variant="page"
      writable={writable}
      replayPollIntervalMs={25}
    />,
  )
}

async function openRecording(recordingId = 'rec_bili'): Promise<void> {
  const user = userEvent.setup()
  const row = await screen.findByTestId(`recording-row-${recordingId}`)
  await user.click(row)
  await screen.findByTestId('recording-actions')
}

describe('panel replay action (M3)', () => {
  it('disables replay with an explanation when the panel has no replay service', async () => {
    const { api } = await setup()
    renderPanel(api)

    await openRecording()
    const button = screen.getByTestId('replay-recording')
    expect(button).toBeDisabled()
    expect(screen.getByTestId('replay-unavailable')).toHaveTextContent('没有可用的回放服务')
  })

  it('confirms, starts the replay and polls the new run until its video is available', async () => {
    const user = userEvent.setup()
    const fake = createFakeReplay(60)
    const { api } = await setup(fake.port)
    renderPanel(api)

    await openRecording()
    await user.click(screen.getByTestId('replay-recording'))
    expect(await screen.findByTestId('replay-confirm')).toBeInTheDocument()
    expect(screen.getByText(/隔离的 Chromium 窗口/)).toBeInTheDocument()

    await user.click(screen.getByTestId('replay-confirm-confirm'))
    expect(await screen.findByTestId('replay-status')).toBeInTheDocument()
    await waitFor(() => {
      expect(fake.calls).toHaveLength(1)
    })
    expect(fake.calls[0]?.recordingId).toBe('rec_bili')

    // The polled run first shows as running, then completed with its video.
    expect(await screen.findByTestId('run-row-run_panel')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('run-row-run_panel')).toHaveTextContent('完成')
    }, { timeout: 4000 })

    const video = await screen.findByLabelText('Run run_panel 的回放视频')
    expect(video.getAttribute('src')).toContain('runId=run_panel')
    expect(await screen.findByTestId('panel-toast-code')).toHaveTextContent('PANEL_REPLAY_COMPLETED')

    // Tree counts refresh after the terminal status: 1 existing + 1 new run.
    await waitFor(() => {
      expect(screen.getByTestId('recording-row-rec_bili')).toHaveTextContent('2 Run')
    })
  })

  it('turns a late PANEL_REPLAY_UNAVAILABLE into a disabled button and a toast', async () => {
    const user = userEvent.setup()
    const { api } = await setup()
    // Advertise replay as available, then let the real route answer 503.
    const misleading: PanelApi = {
      ...api,
      capabilities: async () => ({ replay: true, trash: true }),
    }
    renderPanel(misleading)

    await openRecording()
    await user.click(screen.getByTestId('replay-recording'))
    await user.click(await screen.findByTestId('replay-confirm-confirm'))

    expect(await screen.findByTestId('panel-toast-code')).toHaveTextContent('PANEL_REPLAY_UNAVAILABLE')
    await waitFor(() => {
      expect(screen.getByTestId('replay-recording')).toBeDisabled()
    })
    expect(screen.getByTestId('replay-unavailable')).toBeInTheDocument()
  })
})

describe('panel trash action (M3)', () => {
  it('confirms, moves the recording to trash and removes it from the tree', async () => {
    const user = userEvent.setup()
    const { root, api } = await setup()
    renderPanel(api)

    await openRecording()
    await user.click(screen.getByTestId('trash-recording'))
    expect(await screen.findByTestId('trash-confirm')).toBeInTheDocument()
    expect(screen.getByText(/不会直接删除/)).toBeInTheDocument()

    await user.click(screen.getByTestId('trash-confirm-confirm'))

    await waitFor(() => {
      expect(screen.queryByTestId('recording-row-rec_bili')).toBeNull()
    })
    expect(await screen.findByTestId('detail-empty')).toBeInTheDocument()
    const toast = await screen.findByTestId('panel-toast')
    expect(toast).toHaveAttribute('data-variant', 'success')
    expect(toast).toHaveTextContent('trash/rec_bili-')

    const indexRaw = await readFile(path.join(storeRoot(root), 'index.json'), 'utf8')
    const index = JSON.parse(indexRaw) as { assignments: Record<string, unknown> }
    expect(index.assignments['rec_bili']).toBeUndefined()

    // The complete original directory exists under trash/.
    const stamp = manifestStamp(toast.textContent ?? '')
    const manifest = await readFile(
      path.join(trashDir(root), `rec_bili-${stamp}`, 'manifest.json'),
      'utf8',
    )
    expect(manifest).toContain('rec_bili')
    expect(await readFile(
      path.join(trashDir(root), `rec_bili-${stamp}`, 'runs', 'run_ok', 'video', 'replay.webm'),
    )).toEqual(Buffer.from([1, 2, 3]))
  })
})

/** Extract the compact stamp from the success toast path. */
function manifestStamp(text: string): string {
  const match = /trash\/rec_bili-(\d{8}T\d{9}Z)/u.exec(text)
  if (match?.[1] === undefined) throw new Error(`trash path not found in toast: ${text}`)
  return match[1]
}

describe('panel keyboard navigation (M3)', () => {
  it('moves with arrows, opens with Enter, renames with F2 and cancels with Escape', async () => {
    const user = userEvent.setup()
    const { api } = await setup()
    renderPanel(api)

    const category = await screen.findByTestId('category-row-bilibili')
    const scenario = screen.getByTestId('scenario-row-anniv')
    const recording = screen.getByTestId('recording-row-rec_bili')

    category.focus()
    expect(document.activeElement).toBe(category)

    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(scenario)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(recording)

    // Enter is native button activation → selects the recording.
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { level: 1, name: 'B站搜索：明日方舟周年庆' })).toBeInTheDocument()

    // F2 opens the inline rename; the editor owns the focus.
    await user.keyboard('{F2}')
    const editor = await screen.findByTestId('edit-recording-rec_bili')
    expect(document.activeElement).toBe(editor)
    // Arrows inside the editor must not move the tree focus.
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(editor)

    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('edit-recording-rec_bili')).toBeNull()
    // Escape outside an editor leaves the row focus.
    recording.focus()
    await user.keyboard('{Escape}')
    expect(document.activeElement).not.toBe(recording)
  })

  it('moves focus between cross-project search results with the arrow keys', async () => {
    const user = userEvent.setup()
    const { api } = await setup()
    usePanelStore.setState({ root: '*' })
    renderPanel(api)

    await user.type(await screen.findByLabelText('搜索录制'), 'rec')
    const results = await screen.findAllByTestId(/^cross-result-/)
    expect(results.length).toBeGreaterThan(0)
    const rows = results.filter((element): element is HTMLElement => element instanceof HTMLElement)
    rows[0]?.focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).not.toBe(rows[0])
  })
})
