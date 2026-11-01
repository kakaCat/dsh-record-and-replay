// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  PanelCrossProjectSearchResult,
  PanelProject,
  PanelProjectSummary,
  PanelRecordingDetail,
  PanelSearchResult,
  PanelStatsReport,
} from '../../../src/panel/types.js'
import { PANEL_ALL_PROJECTS_ROOT } from '../../../src/panel/types.js'
import { PanelApp } from '../../../src/client/panel/App.js'
import { PanelApiError, type PanelApi, type PanelWriteApi } from '../../../src/client/panel/api.js'
import { usePanelStore } from '../../../src/client/panel/store.js'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  // Zustand state (expanded rows, selection) is module-level: reset it so one
  // test's collapse cannot hide rows from the next.
  usePanelStore.setState({
    root: undefined,
    selectedRecordingId: undefined,
    selectedRunId: undefined,
    search: '',
    expanded: {},
  })
})

const ROOT = '/tmp/panel-view'

function projectFixture(): PanelProject {
  return {
    root: ROOT,
    name: 'Demo',
    indexSource: 'loaded',
    warnings: [],
    categories: [
      { id: 'bilibili', name: 'B站', site: 'bilibili' },
      { id: 'saucedemo', name: 'SauceDemo', site: 'saucedemo' },
    ],
    scenarios: [{ id: 'anniv', categoryId: 'bilibili', name: '周年庆' }],
    recordings: [
      {
        recordingId: 'rec_bili',
        title: 'B站搜索：明日方舟周年庆',
        intent: '在 B 站搜索「明日方舟周年庆」，确认结果页出现活动入口，并检查首屏前三条结果。',
        intentSource: 'manifest',
        site: 'bilibili',
        categoryId: 'bilibili',
        scenarioId: 'anniv',
        status: 'completed',
        stepCount: 4,
        createdAt: '2026-10-31T10:00:00.000Z',
        updatedAt: '2026-10-31T12:00:00.000Z',
        runCount: 2,
        failedRunCount: 1,
        lastRunStatus: 'failed',
        hasVideo: true,
      },
      {
        recordingId: 'rec_shop',
        title: 'SauceDemo：登录验收',
        site: 'saucedemo',
        categoryId: 'saucedemo',
        status: 'completed',
        stepCount: 3,
        createdAt: '2026-10-30T10:00:00.000Z',
        updatedAt: '2026-10-30T12:00:00.000Z',
        runCount: 0,
        failedRunCount: 0,
        hasVideo: false,
      },
    ],
    stats: {
      recordings: 2,
      runs: 2,
      failedRuns: 1,
      cancelledRuns: 0,
      failureRate: 0.5,
      videoFiles: 1,
      videoBytes: 1024,
      steps: 7,
    },
  }
}

function detailFixture(): PanelRecordingDetail {
  return {
    recording: projectFixture().recordings[0]!,
    runs: [
      {
        runId: 'run_bad',
        recordingId: 'rec_bili',
        status: 'failed',
        startedAt: '2026-10-31T12:00:00.000Z',
        finishedAt: '2026-10-31T12:00:00.500Z',
        durationMs: 500,
        errorCode: 'TARGET_NOT_FOUND',
        errorMessage: 'No visible element matched the semantic target',
        failedStepId: 'step_2',
        hasVideo: false,
      },
      {
        runId: 'run_ok',
        recordingId: 'rec_bili',
        status: 'completed',
        startedAt: '2026-10-31T11:00:00.000Z',
        finishedAt: '2026-10-31T11:00:01.000Z',
        durationMs: 1000,
        videoPath: 'runs/run_ok/video/replay.webm',
        videoBytes: 1024,
        hasVideo: true,
      },
    ],
  }
}

function createWriteApi(): PanelWriteApi {
  return {
    updateCategory: vi.fn(async (_root: string, id: string, name: string) => ({
      category: { id, name, site: id },
      indexSource: 'loaded' as const,
      warnings: [],
    })),
    updateScenario: vi.fn(async (_root: string, id: string, name: string) => ({
      scenario: { id, categoryId: 'bilibili', name },
      indexSource: 'loaded' as const,
      warnings: [],
    })),
    createScenario: vi.fn(async (
      _root: string,
      categoryId: string,
      name: string,
    ) => ({
      scenario: { id: 'scn_new', categoryId, name },
      assignedCount: 1,
      indexSource: 'loaded' as const,
      warnings: [],
    })),
    updateRecording: vi.fn(async (
      _root: string,
      recordingId: string,
      patch: { readonly title?: string },
    ) => ({
      recordingId,
      assignment: {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        scenarioId: 'anniv',
      },
      indexSource: 'loaded' as const,
      warnings: [],
    })),
  }
}

function createApi(overrides: Partial<PanelApi> = {}): PanelApi {
  const project = projectFixture()
  const detail = detailFixture()
  const api: PanelApi = {
    listProjects: vi.fn(async (): Promise<PanelProjectSummary[]> => [{
      root: ROOT,
      name: 'Demo',
      isCurrent: true,
      recordingCount: 2,
    }]),
    getProject: vi.fn(async () => project),
    getRecording: vi.fn(async () => detail),
    search: vi.fn(async (_root: string, query: string): Promise<PanelSearchResult> => {
      const recordings = query.toLowerCase().includes('failed') ? [project.recordings[0]!] : project.recordings
      return {
        query,
        recordings,
        runs: query.toLowerCase().includes('failed') ? [detail.runs[0]!] : [],
        matches: Object.fromEntries(recordings.map((recording) => [
          recording.recordingId,
          { kind: query.toLowerCase().includes('failed') ? 'run' as const : 'recording' as const },
        ])),
      }
    }),
    searchAll: vi.fn(async (query: string): Promise<PanelCrossProjectSearchResult> => ({
      query,
      groups: [{
        projectRoot: ROOT,
        projectName: 'Demo',
        matches: project.recordings.map((recording) => ({
          recording,
          matchKind: 'recording' as const,
          matchedRuns: [],
          categoryName: recording.categoryId === 'bilibili' ? 'B站' : 'SauceDemo',
        })),
      }],
      total: project.recordings.length,
      returned: project.recordings.length,
      limit: 100,
      truncated: false,
    })),
    stats: vi.fn(async (): Promise<PanelStatsReport> => ({
      system: {
        projects: 1,
        recordings: 2,
        runs: 2,
        failedRuns: 1,
        cancelledRuns: 0,
        failureRate: 0.5,
        videoFiles: 1,
        videoBytes: 1024,
        steps: 7,
      },
      projects: [{ root: ROOT, name: 'Demo', stats: project.stats }],
    })),
    videoUrl: (root, runId, options) => `/panel/video?root=${encodeURIComponent(root)}&runId=${runId}${options?.download === true ? '&download=1' : ''}`,
    write: createWriteApi(),
    ...overrides,
  }
  return api
}

function renderApp(
  api: PanelApi,
  variant: 'page' | 'sidebar' = 'page',
  writable = false,
  options: {
    readonly preferredRoot?: string
    readonly onPickDirectory?: () => Promise<string | undefined>
  } = {},
): { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  render(
    <PanelApp
      api={api}
      queryClient={queryClient}
      variant={variant}
      writable={writable}
      {...(options.preferredRoot === undefined ? {} : { preferredRoot: options.preferredRoot })}
      {...(options.onPickDirectory === undefined ? {} : { onPickDirectory: options.onPickDirectory })}
    />,
  )
  return { queryClient }
}

describe('panel tree and detail', () => {
  it('renders categories, scenarios, recordings and the empty selection state', async () => {
    renderApp(createApi())
    expect(await screen.findByText('分类 / 场景')).toBeInTheDocument()
    expect(await screen.findByText('B站')).toBeInTheDocument()
    expect(await screen.findByText('周年庆')).toBeInTheDocument()
    expect(await screen.findByTestId('recording-row-rec_bili')).toBeInTheDocument()
    expect(await screen.findByTestId('recording-row-rec_shop')).toBeInTheDocument()
    expect(await screen.findByTestId('detail-empty')).toBeInTheDocument()
    expect(screen.getByText('失败率')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
  })

  it('opens a recording, selects a run, shows errors and video', async () => {
    const user = userEvent.setup()
    renderApp(createApi())

    await user.click(await screen.findByTestId('recording-row-rec_bili'))
    expect(await screen.findByRole('heading', { name: 'B站搜索：明日方舟周年庆' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 2, name: /Runs/ })).toBeInTheDocument()
    expect(await screen.findByTestId('run-row-run_bad')).toBeInTheDocument()

    const breadcrumb = await screen.findByTestId('detail-breadcrumb')
    expect(breadcrumb).toHaveTextContent('B站')
    expect(breadcrumb).toHaveTextContent('周年庆')

    const meta = await screen.findByTestId('recording-meta')
    expect(meta).toHaveTextContent('rec_bili')
    expect(meta).toHaveTextContent('站点 bilibili')
    expect(meta).toHaveTextContent('4 步')
    expect(screen.getByTestId('copy-recording-id')).toBeInTheDocument()

    const intent = await screen.findByTestId('detail-intent')
    expect(intent).toHaveTextContent('在 B 站搜索「明日方舟周年庆」')
    expect(intent).toHaveTextContent('录制原文')
    expect(screen.queryByText('未填写用例')).toBeNull()
    // The intent is rendered once, in the overview; the video section no longer
    // repeats it above the player.
    expect(screen.queryByTestId('video-intent')).toBeNull()

    await user.click(screen.getByTestId('run-row-run_bad'))
    expect(await screen.findByText('Run 失败')).toBeInTheDocument()
    expect(screen.getAllByText('TARGET_NOT_FOUND').length).toBeGreaterThan(0)
    expect(screen.getByText('step_2')).toBeInTheDocument()
    expect(screen.getByTestId('run-row-run_bad')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('selected-run-bar-run_bad')).toBeInTheDocument()
    expect(await screen.findByTestId('video-empty')).toHaveTextContent('这个 Run 没有视频')

    await user.click(screen.getByTestId('run-row-run_ok'))
    expect(screen.getByTestId('run-row-run_ok')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('run-row-run_bad')).toHaveAttribute('aria-selected', 'false')
    const video = await screen.findByLabelText('Run run_ok 的回放视频')
    expect(video.getAttribute('src')).toContain('/panel/video')
    expect(video.getAttribute('src')).toContain('runId=run_ok')
    expect(screen.getByTestId('video-skeleton')).toBeInTheDocument()
    fireEvent.loadedData(video)
    await waitFor(() => {
      expect(screen.queryByTestId('video-skeleton')).toBeNull()
    })
    expect(screen.getByRole('link', { name: /下载视频/ })).toHaveAttribute('download')
  })

  it('returns to the still-mounted tree without losing expansion or scroll position', async () => {
    const user = userEvent.setup()
    renderApp(createApi())

    await user.click(await screen.findByTestId('recording-row-rec_bili'))
    await screen.findByTestId('detail-header')
    // The tree is not replaced by the detail: it stays mounted beside it.
    expect(screen.getByTestId('tree-root')).toBeInTheDocument()

    const treeList = screen.getByTestId('tree-list')
    treeList.scrollTop = 96
    await user.click(screen.getByTestId('scenario-row-anniv'))
    expect(screen.getByTestId('scenario-row-anniv')).toHaveAttribute('aria-expanded', 'false')

    await user.click(screen.getByTestId('detail-back'))
    expect(await screen.findByTestId('detail-empty')).toBeInTheDocument()
    expect(screen.getByTestId('tree-root')).toBeInTheDocument()
    expect(screen.getByTestId('category-row-bilibili')).toHaveAttribute('aria-expanded', 'true')
    // The collapsed scenario stayed collapsed: back does not reset tree state.
    expect(screen.getByTestId('scenario-row-anniv')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('recording-row-rec_bili')).toBeNull()
    expect(treeList.scrollTop).toBe(96)
    expect(usePanelStore.getState().selectedRecordingId).toBeUndefined()
  })

  it('filters the tree by server-side search results', async () => {
    const user = userEvent.setup()
    const api = createApi()
    renderApp(api)

    await screen.findByTestId('recording-row-rec_shop')
    await user.type(screen.getByLabelText('搜索录制'), 'failed')
    await waitFor(() => {
      expect(api.search).toHaveBeenCalledWith(ROOT, 'failed')
    })
    await waitFor(() => {
      expect(screen.queryByTestId('recording-row-rec_shop')).toBeNull()
    })
    expect(screen.getByTestId('recording-row-rec_bili')).toBeInTheDocument()
    expect(await screen.findByText('1 条匹配')).toBeInTheDocument()
  })

  it('shows only the missing-intent prompt instead of repeating the title', async () => {
    const user = userEvent.setup()
    const detail = detailFixture()
    const { intent: _intent, intentSource: _source, ...recording } = detail.recording
    const api = createApi({ getRecording: vi.fn(async () => ({ ...detail, recording })) })
    renderApp(api)

    await user.click(await screen.findByTestId('recording-row-rec_bili'))
    const intent = await screen.findByTestId('detail-intent')
    expect(intent).toHaveTextContent('未填写用例')
    expect(intent).not.toHaveTextContent('B站搜索：明日方舟周年庆')
    expect(within(intent).queryByText('B站搜索：明日方舟周年庆')).toBeNull()
    // The title still appears once in the detail header.
    expect(screen.getByRole('heading', { name: 'B站搜索：明日方舟周年庆' })).toBeInTheDocument()
  })

  it('expands a long intent above the video', async () => {
    const user = userEvent.setup()
    const detail = detailFixture()
    const longIntent = `逐步核对录制回放面板的用例意图。${'确认右侧栏展示、视频绑定与旧录制兼容。'.repeat(10)}`
    const api = createApi({
      getRecording: vi.fn(async () => ({
        ...detail,
        recording: { ...detail.recording, intent: longIntent },
      })),
    })
    renderApp(api)

    await user.click(await screen.findByTestId('recording-row-rec_bili'))
    const intent = await screen.findByTestId('detail-intent')
    expect(intent).toHaveTextContent(longIntent)

    await user.click(within(intent).getByRole('button', { name: /展开全文/ }))
    expect(within(intent).getByRole('button', { name: /收起/ })).toBeInTheDocument()
  })

  it('renders the narrow right-sidebar variant with intent and stats', async () => {
    const user = userEvent.setup()
    const detail = detailFixture()
    const api = createApi({
      getRecording: vi.fn(async () => ({
        ...detail,
        recording: { ...detail.recording, intentSource: 'index' as const },
      })),
    })
    renderApp(api, 'sidebar')

    const root = await screen.findByTestId('panel-root')
    expect(root).toHaveAttribute('data-variant', 'sidebar')
    expect(await screen.findByText('失败率')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()

    await user.click(await screen.findByTestId('recording-row-rec_bili'))
    const intent = await screen.findByTestId('detail-intent')
    expect(intent).toBeInTheDocument()
    expect(await screen.findByTestId('detail-header')).toBeInTheDocument()
    expect(screen.getAllByText('index 补注').length).toBeGreaterThan(0)
  })

  it('shows the project empty state when a project has no recordings', async () => {
    const api = createApi({
      getProject: vi.fn(async () => ({ ...projectFixture(), recordings: [], stats: {
        recordings: 0,
        runs: 0,
        failedRuns: 0,
        cancelledRuns: 0,
        failureRate: 0,
        videoFiles: 0,
        videoBytes: 0,
        steps: 0,
      } })),
    })
    renderApp(api)
    const emptyState = await screen.findByTestId('project-empty')
    expect(await screen.findByTestId('tree-empty')).toBeInTheDocument()
    // The active project is the only one with data (per the list), so there is
    // nothing to switch to from here.
    expect(within(emptyState).queryByTestId('switch-to-recorded')).toBeNull()
  })

  it('offers switching to a project with recordings from the empty state', async () => {
    const user = userEvent.setup()
    const emptyRoot = '/tmp/empty-project'
    usePanelStore.setState({ root: emptyRoot })
    const api = createApi({
      listProjects: vi.fn(async (): Promise<PanelProjectSummary[]> => [
        { root: emptyRoot, name: 'Empty', recordingCount: 0 },
        { root: ROOT, name: 'Demo', recordingCount: 2 },
        { root: '/tmp/another-empty', name: 'Another', recordingCount: 0 },
      ]),
      getProject: vi.fn(async (root: string) => {
        if (root !== emptyRoot) return projectFixture()
        return {
          ...projectFixture(),
          root: emptyRoot,
          name: 'Empty',
          categories: [],
          scenarios: [],
          recordings: [],
          stats: {
            recordings: 0,
            runs: 0,
            failedRuns: 0,
            cancelledRuns: 0,
            failureRate: 0,
            videoFiles: 0,
            videoBytes: 0,
            steps: 0,
          },
        }
      }),
    })
    renderApp(api, 'sidebar', true, { onPickDirectory: vi.fn(async () => undefined) })

    const emptyState = await screen.findByTestId('project-empty')
    expect(within(emptyState).getByTestId('switch-to-recorded')).toBeInTheDocument()
    // The folder picker stays available next to the switch.
    expect(within(emptyState).getByTestId('open-folder')).toBeInTheDocument()
    expect(screen.queryByTestId('recorded-project-list')).toBeNull()

    await user.click(within(emptyState).getByTestId('switch-to-recorded'))
    const list = await screen.findByTestId('recorded-project-list')
    expect(within(list).getAllByTestId('recorded-project-option')).toHaveLength(1)
    expect(within(list).getByText('Demo')).toBeInTheDocument()
    expect(within(list).queryByText('Another')).toBeNull()

    await user.click(within(list).getByTestId('recorded-project-option'))
    await waitFor(() => {
      expect(usePanelStore.getState().root).toBe(ROOT)
      expect(api.getProject).toHaveBeenCalledWith(ROOT, expect.anything())
    })
    expect(window.localStorage.getItem('dsh-record-replay:last-root')).toBe(ROOT)
  })

  it('shows the projects empty state when no project is available', async () => {
    const api = createApi({ listProjects: vi.fn(async () => []) })
    renderApp(api)
    expect(await screen.findByTestId('projects-empty')).toBeInTheDocument()
  })

  it('defaults to the first project with recordings instead of an empty desktop profile', async () => {
    const api = createApi({
      listProjects: vi.fn(async (): Promise<PanelProjectSummary[]> => [
        { root: '/Users/me/.dsh/profiles/desktop', name: 'desktop', recordingCount: 0 },
        { root: ROOT, name: 'Demo', recordingCount: 2 },
      ]),
    })
    renderApp(api)
    expect(await screen.findByTestId('category-row-bilibili')).toBeInTheDocument()
    expect(api.getProject).toHaveBeenCalledWith(ROOT, expect.anything())
    expect(screen.queryByTestId('project-empty')).toBeNull()
  })

  it('uses the workspace of the current session when it has recordings', async () => {
    const api = createApi({
      listProjects: vi.fn(async (): Promise<PanelProjectSummary[]> => [
        { root: '/tmp/other', name: 'other', recordingCount: 9 },
        { root: ROOT, name: 'Demo', recordingCount: 2 },
      ]),
    })
    renderApp(api, 'sidebar', false, { preferredRoot: ROOT })
    expect(await screen.findByTestId('category-row-bilibili')).toBeInTheDocument()
    expect(api.getProject).toHaveBeenCalledWith(ROOT, expect.anything())
  })

  it('ignores an empty session workspace and defaults to one with recordings', async () => {
    const api = createApi({
      listProjects: vi.fn(async (): Promise<PanelProjectSummary[]> => [
        { root: '/tmp/empty-session', name: 'empty', recordingCount: 0 },
        { root: ROOT, name: 'Demo', recordingCount: 2 },
      ]),
    })
    renderApp(api, 'sidebar', false, { preferredRoot: '/tmp/empty-session' })
    expect(await screen.findByTestId('category-row-bilibili')).toBeInTheDocument()
    expect(api.getProject).toHaveBeenCalledWith(ROOT, expect.anything())
  })

  it('restores the project the user selected last time from localStorage', async () => {
    window.localStorage.setItem('dsh-record-replay:last-root', '/tmp/last')
    const api = createApi({
      listProjects: vi.fn(async (): Promise<PanelProjectSummary[]> => [
        { root: ROOT, name: 'Demo', recordingCount: 2 },
        { root: '/tmp/last', name: 'Last', recordingCount: 3 },
      ]),
    })
    renderApp(api)
    await waitFor(() => {
      expect(api.getProject).toHaveBeenCalledWith('/tmp/last', expect.anything())
    })
  })

  it('ignores a remembered desktop root without recordings but keeps the stored value', async () => {
    const desktop = '/Users/me/.dsh/profiles/desktop'
    window.localStorage.setItem('dsh-record-replay:last-root', desktop)
    const api = createApi({
      listProjects: vi.fn(async (): Promise<PanelProjectSummary[]> => [
        { root: desktop, name: 'desktop', recordingCount: 0 },
        { root: ROOT, name: 'Demo', recordingCount: 2 },
      ]),
    })
    renderApp(api)

    expect(await screen.findByTestId('category-row-bilibili')).toBeInTheDocument()
    expect(api.getProject).toHaveBeenCalledWith(ROOT, expect.anything())
    expect(api.getProject).not.toHaveBeenCalledWith(desktop)
    // The stale preference is kept: it may be selected again in a later session.
    expect(window.localStorage.getItem('dsh-record-replay:last-root')).toBe(desktop)
  })

  it('distinguishes a missing project from a project without recordings', async () => {
    const api = createApi({
      getProject: vi.fn(async () => {
        throw new PanelApiError('PANEL_ROOT_NOT_FOUND', 'project root does not exist', 404)
      }),
    })
    renderApp(api)
    expect(await screen.findByTestId('project-missing')).toBeInTheDocument()
    expect(await screen.findByTestId('tree-project-missing')).toBeInTheDocument()
    expect(screen.getAllByText('项目不存在').length).toBeGreaterThan(0)
    expect(screen.queryByText('这个项目还没有录制')).toBeNull()
  })

  it('opens a folder through the picker, registers it and selects it', async () => {
    const user = userEvent.setup()
    const picked = '/tmp/picked-folder'
    let projects: PanelProjectSummary[] = [{ root: ROOT, name: 'Demo', recordingCount: 2 }]
    const api = createApi({
      listProjects: vi.fn(async () => projects),
      addRoot: vi.fn(async (root: string) => {
        projects = [{ root, name: 'picked-folder', recordingCount: 0 }, ...projects]
        return { root, name: 'picked-folder', recordingCount: 0 }
      }),
    })
    const onPickDirectory = vi.fn(async () => picked)
    renderApp(api, 'sidebar', true, { onPickDirectory })

    await user.click(await screen.findByTestId('project-open-folder'))
    await waitFor(() => {
      expect(onPickDirectory).toHaveBeenCalledTimes(1)
      expect(api.addRoot).toHaveBeenCalledWith(picked)
      expect(usePanelStore.getState().root).toBe(picked)
    })
  })
})

describe('panel narrow layout: list above, detail below', () => {
  it('keeps the tree visible above a bottom detail pane and binds the selected run video', async () => {
    const user = userEvent.setup()
    renderApp(createApi(), 'sidebar')

    const tree = await screen.findByTestId('tree-root')
    const row = await screen.findByTestId('recording-row-rec_bili')
    await user.click(row)

    const split = await screen.findByTestId('sidebar-split')
    expect(split).toHaveAttribute('data-detail-open', 'true')
    const list = screen.getByTestId('sidebar-split-list')
    const pane = screen.getByTestId('detail-pane')
    // The tree is not replaced: it is the top pane, the detail is the bottom one.
    expect(list.contains(tree)).toBe(true)
    expect(list.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row).toHaveAttribute('aria-selected', 'true')

    expect(within(pane).getByRole('heading', { name: 'B站搜索：明日方舟周年庆' })).toBeInTheDocument()
    expect(screen.getByTestId('detail-pane-title')).toHaveTextContent('B站搜索：明日方舟周年庆')
    expect(within(pane).getByTestId('detail-breadcrumb')).toHaveTextContent('B站')
    expect(within(pane).getByTestId('detail-breadcrumb')).toHaveTextContent('周年庆')
    expect(within(pane).getByTestId('recording-meta')).toHaveTextContent('rec_bili')
    expect(within(pane).getByTestId('detail-intent')).toHaveTextContent('在 B 站搜索「明日方舟周年庆」')

    // Runs still switch the video, inside the bottom pane.
    await user.click(within(pane).getByTestId('run-row-run_ok'))
    const video = within(pane).getByLabelText('Run run_ok 的回放视频')
    expect(video.getAttribute('src')).toContain('runId=run_ok')
    expect(within(pane).getByTestId('run-detail')).toHaveTextContent('Run 详情')

    // Selecting from the tree with the pane open only swaps its content.
    expect(screen.getByTestId('sidebar-split')).toHaveAttribute('data-detail-open', 'true')
  })

  it('switches recordings from the still-visible tree and updates the bottom detail', async () => {
    const user = userEvent.setup()
    const project = projectFixture()
    const shopRecording = project.recordings[1]!
    const api = createApi({
      getRecording: vi.fn(async (_root: string, recordingId: string): Promise<PanelRecordingDetail> => (
        recordingId === shopRecording.recordingId
          ? { recording: shopRecording, runs: [] }
          : detailFixture()
      )),
    })
    renderApp(api, 'sidebar')

    await user.click(await screen.findByTestId('recording-row-rec_bili'))
    expect(await screen.findByRole('heading', { name: 'B站搜索：明日方舟周年庆' })).toBeInTheDocument()

    await user.click(screen.getByTestId('recording-row-rec_shop'))
    expect(await screen.findByRole('heading', { name: 'SauceDemo：登录验收' })).toBeInTheDocument()
    expect(screen.getByTestId('runs-empty')).toBeInTheDocument()
    expect(screen.getByTestId('recording-row-rec_shop')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('recording-row-rec_bili')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('detail-pane')).toBeInTheDocument()
    expect(screen.getByTestId('tree-root')).toBeInTheDocument()
  })

  it('collapses the detail with the close control, keeps the selection and reopens from the bar', async () => {
    const user = userEvent.setup()
    renderApp(createApi(), 'sidebar')

    const row = await screen.findByTestId('recording-row-rec_bili')
    await user.click(row)
    await screen.findByTestId('detail-pane')
    expect(screen.getByTestId('sidebar-split')).toHaveAttribute('data-detail-open', 'true')

    await user.click(screen.getByTestId('detail-close'))
    expect(screen.queryByTestId('detail-pane')).toBeNull()
    expect(screen.queryByTestId('detail-splitter')).toBeNull()
    expect(screen.getByTestId('sidebar-split')).toHaveAttribute('data-detail-open', 'false')
    expect(screen.getByTestId('tree-root')).toBeInTheDocument()
    expect(row).toHaveAttribute('aria-selected', 'true')
    const reopen = screen.getByTestId('detail-reopen')
    expect(reopen).toHaveTextContent('详情已收起')
    expect(reopen).toHaveTextContent('B站搜索：明日方舟周年庆')

    await user.click(reopen)
    expect(await screen.findByTestId('detail-pane')).toBeInTheDocument()
    expect(screen.getByTestId('recording-row-rec_bili')).toHaveAttribute('aria-selected', 'true')
  })

  it('treats 返回 as close-detail while keeping the selection', async () => {
    const user = userEvent.setup()
    renderApp(createApi(), 'sidebar')

    await user.click(await screen.findByTestId('recording-row-rec_bili'))
    await user.click(await screen.findByTestId('detail-back'))

    expect(screen.queryByTestId('detail-pane')).toBeNull()
    expect(usePanelStore.getState().selectedRecordingId).toBe('rec_bili')
    expect(screen.getByTestId('detail-reopen')).toBeInTheDocument()
    expect(screen.getByTestId('category-row-bilibili')).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes the detail with Escape and restores focus to the selected tree row', async () => {
    const user = userEvent.setup()
    renderApp(createApi(), 'sidebar')

    const row = await screen.findByTestId('recording-row-rec_bili')
    await user.click(row)
    await screen.findByTestId('detail-pane')
    // Clicking the row leaves the focus on it; Escape must close the detail
    // first even though the tree's own Escape handler also runs.
    expect(row).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(screen.queryByTestId('detail-pane')).toBeNull()
    expect(screen.getByTestId('tree-root')).toBeInTheDocument()
    await waitFor(() => {
      expect(row).toHaveFocus()
    })
  })

  it('keeps the tree scroll position while the detail opens and closes', async () => {
    const user = userEvent.setup()
    renderApp(createApi(), 'sidebar')

    const treeList = await screen.findByTestId('tree-list')
    treeList.scrollTop = 48
    await user.click(await screen.findByTestId('recording-row-rec_bili'))
    await screen.findByTestId('detail-pane')
    expect(treeList.scrollTop).toBe(48)

    await user.click(screen.getByTestId('detail-close'))
    expect(screen.getByTestId('tree-list').scrollTop).toBe(48)
    expect(screen.getByTestId('scenario-row-anniv')).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps the wide page layout side by side, without the bottom split', async () => {
    const user = userEvent.setup()
    renderApp(createApi())

    await user.click(await screen.findByTestId('recording-row-rec_bili'))
    expect(await screen.findByTestId('recording-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-split')).toBeNull()
    expect(screen.queryByTestId('detail-pane')).toBeNull()
    expect(screen.queryByTestId('detail-splitter')).toBeNull()
    expect(screen.getByTestId('tree-root')).toBeInTheDocument()
  })
})

describe('panel M2: cross-project search, stats and pagination', () => {
  it('searches every project and opens the matching recording in its project', async () => {
    const user = userEvent.setup()
    const otherRoot = '/tmp/panel-other'
    const otherRecording = {
      ...projectFixture().recordings[1]!,
      recordingId: 'rec_other',
      title: 'Other 项目：登录验收',
      categoryId: 'saucedemo',
      site: 'saucedemo',
    }
    const otherProject: PanelProject = {
      ...projectFixture(),
      root: otherRoot,
      name: 'Other',
      recordings: [otherRecording],
      recordingsTotal: 1,
    }
    usePanelStore.setState({ root: PANEL_ALL_PROJECTS_ROOT })
    const api = createApi({
      // The result's project is deliberately absent from the loaded selector
      // pages: cross-project search can reach projects the picker has not
      // paged in yet.
      listProjects: vi.fn(async (): Promise<PanelProjectSummary[]> => [
        { root: ROOT, name: 'Demo', recordingCount: 2 },
      ]),
      searchAll: vi.fn(async (query: string): Promise<PanelCrossProjectSearchResult> => ({
        query,
        groups: [{
          projectRoot: otherRoot,
          projectName: 'Other',
          matches: [{
            recording: otherRecording,
            matchKind: 'recording',
            matchedRuns: [],
            categoryName: 'SauceDemo',
          }],
        }],
        total: 1,
        returned: 1,
        limit: 100,
        truncated: false,
      })),
      getProject: vi.fn(async (root: string) => root === otherRoot ? otherProject : projectFixture()),
      getRecording: vi.fn(async () => ({ ...detailFixture(), recording: otherRecording })),
    })
    renderApp(api)

    expect(await screen.findByTestId('all-projects-main')).toBeInTheDocument()
    await user.type(screen.getByLabelText('搜索录制'), 'other')
    await waitFor(() => {
      expect(api.searchAll).toHaveBeenCalledWith('other', { limit: 100 })
    })
    expect(await screen.findByTestId('cross-search-results')).toBeInTheDocument()
    expect(screen.getByTestId('cross-search-group')).toHaveTextContent('Other')
    const result = screen.getByTestId('cross-result-rec_other')
    expect(result).toHaveTextContent('Other 项目：登录验收')
    expect(result).toHaveTextContent('SauceDemo')

    await user.click(result)
    await waitFor(() => {
      expect(usePanelStore.getState().root).toBe(otherRoot)
      expect(usePanelStore.getState().selectedRecordingId).toBe('rec_other')
      expect(api.getProject).toHaveBeenCalledWith(otherRoot, expect.anything())
    })
    expect(window.localStorage.getItem('dsh-record-replay:last-root')).toBe(otherRoot)
  })

  it('renders system-level stats cards in all-projects mode', async () => {
    usePanelStore.setState({ root: PANEL_ALL_PROJECTS_ROOT })
    const api = createApi({
      listProjects: vi.fn(async (): Promise<PanelProjectSummary[]> => [
        { root: ROOT, name: 'Demo', recordingCount: 25 },
        { root: '/tmp/other', name: 'Other', recordingCount: 3 },
      ]),
      stats: vi.fn(async (): Promise<PanelStatsReport> => ({
        system: {
          projects: 2,
          recordings: 25,
          runs: 65,
          failedRuns: 14,
          cancelledRuns: 3,
          failureRate: 14 / 65,
          videoFiles: 35,
          videoBytes: 3_700_000,
          steps: 120,
        },
        projects: [
          { root: ROOT, name: 'Demo', stats: projectFixture().stats },
          { root: '/tmp/other', name: 'Other', stats: projectFixture().stats },
        ],
      })),
    })
    renderApp(api)

    const cards = await screen.findByTestId('stats-system')
    expect(within(cards).getByText('项目')).toBeInTheDocument()
    expect(within(cards).getByText('总录制')).toBeInTheDocument()
    expect(within(cards).getByText('总 Run')).toBeInTheDocument()
    expect(within(cards).getByText('25')).toBeInTheDocument()
    expect(within(cards).getByText('65')).toBeInTheDocument()
    expect(within(cards).getByText('22%')).toBeInTheDocument()
    expect(within(cards).getByText('3.5 MB')).toBeInTheDocument()
    const rows = await screen.findAllByTestId('project-stat-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Demo')
  })

  it('loads the next page of recordings with the tree footer control', async () => {
    const user = userEvent.setup()
    const third = {
      ...projectFixture().recordings[1]!,
      recordingId: 'rec_third',
      title: '第三条录制',
      updatedAt: '2026-10-29T10:00:00.000Z',
    }
    const firstPage: PanelProject = {
      ...projectFixture(),
      recordingsTotal: 3,
      recordingsPage: { total: 3, limit: 50, offset: 0, hasMore: true },
    }
    const secondPage: PanelProject = {
      ...projectFixture(),
      recordings: [third],
      recordingsTotal: 3,
      recordingsPage: { total: 3, limit: 50, offset: 50, hasMore: false },
    }
    const api = createApi({
      getProject: vi.fn(async (_root: string, page?: { readonly offset?: number }) => (
        (page?.offset ?? 0) >= 50 ? secondPage : firstPage
      )),
    })
    renderApp(api)

    expect(await screen.findByTestId('recording-row-rec_bili')).toBeInTheDocument()
    expect(screen.getByTestId('tree-count')).toHaveTextContent('2 / 3 条')
    const loadMore = await screen.findByTestId('tree-load-more')
    await user.click(loadMore)

    expect(await screen.findByTestId('recording-row-rec_third')).toBeInTheDocument()
    expect(api.getProject).toHaveBeenCalledWith(ROOT, { limit: 50, offset: 0 })
    expect(api.getProject).toHaveBeenCalledWith(ROOT, { limit: 50, offset: 50 })
    await waitFor(() => {
      expect(screen.queryByTestId('tree-load-more')).toBeNull()
    })
  })

  it('loads the next page of the project list in all-projects mode', async () => {
    const user = userEvent.setup()
    usePanelStore.setState({ root: PANEL_ALL_PROJECTS_ROOT })
    const api = createApi({
      listProjectsPage: vi.fn(async (query: { readonly offset?: number } = {}) => (
        (query.offset ?? 0) === 0
          ? {
              projects: [{ root: ROOT, name: 'Demo', recordingCount: 2 }],
              page: { total: 2, limit: 50, offset: 0, hasMore: true },
            }
          : {
              projects: [{ root: '/tmp/other', name: 'Other', recordingCount: 1 }],
              page: { total: 2, limit: 50, offset: 50, hasMore: false },
            }
      )),
    })
    renderApp(api)

    expect(await screen.findByTestId('all-projects-count')).toHaveTextContent('2 个项目')
    const loadMore = await screen.findByTestId('projects-load-more')
    await user.click(loadMore)

    await waitFor(() => {
      expect(api.listProjectsPage).toHaveBeenCalledWith({ limit: 50, offset: 50 })
    })
    expect(await screen.findByText('Other')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByTestId('projects-load-more')).toBeNull()
    })
  })
})

describe('panel inline edits (M3-lite)', () => {
  it('renames a category on double-click + Enter and refreshes the tree', async () => {
    const user = userEvent.setup()
    const api = createApi()
    renderApp(api, 'page', true)

    await user.dblClick(await screen.findByText('B站'))
    const input = await screen.findByTestId('edit-category-bilibili')
    await user.clear(input)
    await user.type(input, '哔哩哔哩')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(api.write?.updateCategory).toHaveBeenCalledWith(ROOT, 'bilibili', '哔哩哔哩')
    })
    await waitFor(() => {
      expect(api.getProject).toHaveBeenCalledTimes(2)
    })
  })

  it('cancels a scenario rename with Escape without calling the API', async () => {
    const user = userEvent.setup()
    const api = createApi()
    renderApp(api, 'page', true)

    await user.dblClick(await screen.findByText('周年庆'))
    const input = await screen.findByTestId('edit-scenario-anniv')
    await user.clear(input)
    await user.type(input, '不要保存')
    await user.keyboard('{Escape}')

    expect(screen.queryByTestId('edit-scenario-anniv')).toBeNull()
    expect(api.write?.updateScenario).not.toHaveBeenCalled()
  })

  it('renames a recording title with Enter and saves on blur', async () => {
    const user = userEvent.setup()
    const api = createApi()
    renderApp(api, 'page', true)

    await user.dblClick(await screen.findByTestId('recording-row-rec_bili'))
    const input = await screen.findByTestId('edit-recording-rec_bili')
    await user.clear(input)
    await user.type(input, '新的录制标题')
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(api.write?.updateRecording).toHaveBeenCalledWith(ROOT, 'rec_bili', { title: '新的录制标题' })
    })

    await user.dblClick(await screen.findByTestId('recording-row-rec_shop'))
    const second = await screen.findByTestId('edit-recording-rec_shop')
    await user.clear(second)
    await user.type(second, '失焦保存的标题')
    await user.click(screen.getByText('分类 / 场景'))
    await waitFor(() => {
      expect(api.write?.updateRecording).toHaveBeenCalledWith(ROOT, 'rec_shop', { title: '失焦保存的标题' })
    })
  })

  it('collects 未分组 recordings through the create-scenario dialog', async () => {
    const user = userEvent.setup()
    const api = createApi()
    renderApp(api, 'page', true)

    await user.dblClick(await screen.findByTestId('ungrouped-row-saucedemo'))
    expect(await screen.findByTestId('create-scenario-dialog')).toBeInTheDocument()
    expect(screen.getByText('新建场景并收纳当前 1 条录制')).toBeInTheDocument()

    await user.type(screen.getByTestId('create-scenario-input'), '登录流程')
    await user.click(screen.getByTestId('create-scenario-confirm'))

    await waitFor(() => {
      expect(api.write?.createScenario).toHaveBeenCalledWith(
        ROOT,
        'saucedemo',
        '登录流程',
        { includeUngrouped: true },
      )
    })
    await waitFor(() => {
      expect(screen.queryByTestId('create-scenario-dialog')).toBeNull()
    })
  })

  it('shows a toast with the host error code and keeps the editor open', async () => {
    const user = userEvent.setup()
    const write = createWriteApi()
    write.updateCategory = vi.fn(async () => {
      throw new PanelApiError('PANEL_INVALID_NAME', '分类名称不合法', 400)
    })
    const api = createApi({ write })
    renderApp(api, 'page', true)

    await user.dblClick(await screen.findByText('B站'))
    const input = await screen.findByTestId('edit-category-bilibili')
    await user.clear(input)
    await user.type(input, '新名字')
    await user.keyboard('{Enter}')

    const toast = await screen.findByTestId('panel-toast')
    expect(toast).toHaveTextContent('PANEL_INVALID_NAME')
    expect(toast).toHaveTextContent('分类名称不合法')
    expect(screen.getByTestId('edit-category-bilibili')).toBeInTheDocument()

    await user.click(screen.getByLabelText('关闭错误提示'))
    expect(screen.queryByTestId('panel-toast')).toBeNull()
  })

  it('keeps the read-only entry free of edit affordances', async () => {
    const user = userEvent.setup()
    const api = createApi()
    renderApp(api)

    expect(await screen.findByText('全局 · 只读')).toBeInTheDocument()
    await user.dblClick(await screen.findByText('B站'))
    expect(screen.queryByTestId('edit-category-bilibili')).toBeNull()

    await user.dblClick(await screen.findByTestId('ungrouped-row-saucedemo'))
    expect(screen.queryByTestId('create-scenario-dialog')).toBeNull()
    expect(api.write?.updateCategory).not.toHaveBeenCalled()
  })
})
