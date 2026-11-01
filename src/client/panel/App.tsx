import * as React from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import {
  ChevronUp,
  Clapperboard,
  FolderGit2,
  FolderPlus,
  FolderSearch,
  FolderX,
  SearchX,
} from 'lucide-react'

import {
  PANEL_ALL_PROJECTS_ROOT,
  PANEL_PAGE_LIMIT_DEFAULT,
  type PanelCapabilities,
  type PanelCrossProjectSearchResult,
  type PanelProject,
  type PanelProjectSummary,
  type PanelRecordingDetail,
  type PanelSearchResult,
  type PanelStats,
  type PanelSystemStats,
} from '../../panel/types.js'
import { PanelApiError, panelApi, type PanelApi } from './api.js'
import { AllProjectsAside, AllProjectsMain } from './components/AllProjectsPanel.js'
import { EmptyState } from './components/EmptyState.js'
import { ErrorState } from './components/ErrorState.js'
import { DetailSkeleton, TreeSkeleton } from './components/LoadingSkeleton.js'
import { ProjectPicker } from './components/ProjectPicker.js'
import { RecordingDetail, type RecordingActionsView } from './components/RecordingDetail.js'
import { SearchBox } from './components/SearchBox.js'
import { SidebarLayout } from './components/SidebarLayout.js'
import { StatsCards } from './components/StatsCards.js'
import { Toast } from './components/Toast.js'
import { Tree } from './components/Tree.js'
import { pickDefaultRoot, readRememberedRoot, rememberRoot } from './lib/project-defaults.js'
import { cn } from './lib/utils.js'
import { usePanelRecordingActions } from './recording-actions.js'
import { usePanelStore } from './store.js'
import { usePanelWriteActions, type PanelToast } from './write-actions.js'

const EMPTY_STATS: PanelStats = {
  recordings: 0,
  runs: 0,
  failedRuns: 0,
  cancelledRuns: 0,
  failureRate: 0,
  videoFiles: 0,
  videoBytes: 0,
  steps: 0,
}

const PAGE_SIZE = PANEL_PAGE_LIMIT_DEFAULT
/** How often the detail query polls while a panel-started replay is running. */
const REPLAY_POLL_INTERVAL_MS = 1_200
/** Give up polling a replay that never reaches a terminal status (e.g. host crash). */
const REPLAY_POLL_MAX_MS = 5 * 60_000

const NO_CAPABILITIES: PanelCapabilities = { replay: false, trash: false }

/** Merge the loaded recording pages of one project; later pages only add recordings. */
export function mergeProjectPages(pages: readonly PanelProject[]): PanelProject | undefined {
  const first = pages[0]
  if (first === undefined) return undefined
  if (pages.length === 1) return first
  return {
    ...first,
    recordings: pages.flatMap((page) => [...page.recordings]),
  }
}

/**
 * `page` is the full-width standalone `/panel/` surface; `sidebar` is the
 * narrow DSH right-column layout that puts the tree above a collapsible detail.
 * Narrow viewports (< 768px) use the same stacked layout for the page variant,
 * so the standalone entry can be inspected at the sidebar's real width.
 */
export type PanelVariant = 'page' | 'sidebar'

/** Mirrors Tailwind's `md` breakpoint used by the wide two-column page. */
const NARROW_VIEWPORT_QUERY = '(max-width: 767px)'

/** True below the page variant's `md` breakpoint (false without matchMedia). */
function readNarrowViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(NARROW_VIEWPORT_QUERY).matches
}

function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = React.useState(readNarrowViewport)
  React.useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(NARROW_VIEWPORT_QUERY)
    const update = (): void => setNarrow(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  return narrow
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toastFromError(error: unknown): PanelToast {
  const code = error instanceof PanelApiError ? error.code : 'PANEL_REQUEST_FAILED'
  return { id: Date.now() + Math.random(), code, message: errorMessage(error) }
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

export interface PanelAppProps {
  /** Injectable API for tests; defaults to same-origin HTTP. */
  readonly api?: PanelApi
  /** Injectable query client for tests. */
  readonly queryClient?: QueryClient
  /** Layout variant; `sidebar` stacks everything vertically. Defaults to `page`. */
  readonly variant?: PanelVariant
  /**
   * Enables M3-lite editing (double-click rename / collect 未分组).
   * Only the DSH mount passes true; the standalone `/panel/` stays read-only.
   */
  readonly writable?: boolean
  /**
   * Root of the workspace the current session belongs to. Used by the default
   * project rule before falling back to "first project with recordings".
   */
  readonly preferredRoot?: string
  /**
   * Opens the host directory picker (DSH's composed picker). Present only on
   * the DSH mount; the standalone page has no OS chooser.
   */
  readonly onPickDirectory?: () => Promise<string | undefined> | string | undefined
  /** Replay status poll cadence in ms (tests shorten it). Defaults to 1200. */
  readonly replayPollIntervalMs?: number
}

export function PanelApp({
  api = panelApi,
  queryClient,
  variant = 'page',
  writable = false,
  preferredRoot,
  onPickDirectory,
  replayPollIntervalMs = REPLAY_POLL_INTERVAL_MS,
}: PanelAppProps): React.JSX.Element {
  const [client] = React.useState(() => queryClient ?? new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 5_000,
      },
    },
  }))

  return (
    <QueryClientProvider client={client}>
      <PanelShell
        api={api}
        variant={variant}
        writable={writable}
        replayPollIntervalMs={replayPollIntervalMs}
        {...(preferredRoot === undefined ? {} : { preferredRoot })}
        {...(onPickDirectory === undefined ? {} : { onPickDirectory })}
      />
    </QueryClientProvider>
  )
}

function PanelShell({
  api,
  variant,
  writable,
  preferredRoot,
  onPickDirectory,
  replayPollIntervalMs,
}: {
  readonly api: PanelApi
  readonly variant: PanelVariant
  readonly writable: boolean
  readonly preferredRoot?: string
  readonly onPickDirectory?: () => Promise<string | undefined> | string | undefined
  readonly replayPollIntervalMs: number
}): React.JSX.Element {
  const narrowViewport = useNarrowViewport()
  const compact = variant === 'sidebar' || narrowViewport
  const root = usePanelStore((state) => state.root)
  const setRoot = usePanelStore((state) => state.setRoot)
  const openRecording = usePanelStore((state) => state.openRecording)
  const search = usePanelStore((state) => state.search)
  const setSearch = usePanelStore((state) => state.setSearch)
  const selectedRecordingId = usePanelStore((state) => state.selectedRecordingId)
  const selectRecording = usePanelStore((state) => state.selectRecording)
  const selectedRunId = usePanelStore((state) => state.selectedRunId)
  const selectRun = usePanelStore((state) => state.selectRun)
  /**
   * Narrow layout only: the selected Recording's detail pane is collapsed and
   * the list keeps the full height. The selection (and its tree highlight)
   * stays, so Esc/back only closes the pane and does not lose the position.
   */
  const [detailCollapsed, setDetailCollapsed] = React.useState(false)

  const projectsQuery = useInfiniteQuery({
    queryKey: ['panel', 'projects'],
    queryFn: async ({ pageParam }) => {
      if (api.listProjectsPage !== undefined) {
        return await api.listProjectsPage({ limit: PAGE_SIZE, offset: pageParam })
      }
      // Older/in-test API implementations only expose the flat list.
      const list = await api.listProjects()
      return {
        projects: list,
        page: { total: list.length, limit: PAGE_SIZE, offset: 0, hasMore: false },
      }
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.page.hasMore ? last.page.offset + last.page.limit : undefined,
  })
  // Projects opened from a cross-project result may live beyond the loaded
  // selector pages; pin them so the active root, picker and detail all agree.
  const [pinnedProjects, setPinnedProjects] = React.useState<readonly PanelProjectSummary[]>([])
  const projects = React.useMemo(() => {
    const loaded = projectsQuery.data?.pages.flatMap((page) => [...page.projects]) ?? []
    const known = new Set(loaded.map((project) => project.root))
    const pinned = pinnedProjects.filter((project) => !known.has(project.root))
    return [...loaded, ...pinned]
  }, [projectsQuery.data, pinnedProjects])
  const projectsTotal = projectsQuery.data?.pages[0]?.page.total
  // Read once per mount: "last selected" must not follow every automatic
  // default adoption, otherwise the default becomes indistinguishable from a
  // user choice.
  const [lastSelectedRoot] = React.useState<string | undefined>(() => readRememberedRoot())
  const activeRoot = React.useMemo(() => {
    // An explicit pick is authoritative: it may be the "全部项目" sentinel or a
    // project reached through cross-project search beyond the loaded pages.
    // Only the *default* rule validates its candidate against the project list.
    if (root !== undefined) return root
    return pickDefaultRoot({
      projects,
      ...(lastSelectedRoot === undefined ? {} : { lastRoot: lastSelectedRoot }),
      ...(preferredRoot === undefined ? {} : { preferredRoot }),
    })
  }, [root, projects, lastSelectedRoot, preferredRoot])
  const allProjects = activeRoot === PANEL_ALL_PROJECTS_ROOT

  // Adopting the default does not persist it; only an explicit user pick does.
  React.useEffect(() => {
    if (activeRoot !== undefined && activeRoot !== root) setRoot(activeRoot)
  }, [activeRoot, root, setRoot])

  const queryRoot = allProjects ? '' : activeRoot ?? ''
  const [toast, setToast] = React.useState<PanelToast | undefined>(undefined)
  const [pickingFolder, setPickingFolder] = React.useState(false)
  /** Replay started from this panel: the detail query polls until it is terminal. */
  const [activeReplay, setActiveReplay] = React.useState<
    { readonly recordingId: string; readonly runId: string } | undefined
  >(undefined)
  const [replayStartedAt, setReplayStartedAt] = React.useState(0)
  /** Set when the host reports PANEL_REPLAY_UNAVAILABLE (feature off / no driver). */
  const [replayUnavailableHint, setReplayUnavailableHint] = React.useState<string | undefined>(undefined)
  const queryClient = useQueryClient()

  const selectRoot = React.useCallback((nextRoot: string) => {
    // Persisting `*` would make the next startup ignore the remembered project.
    if (nextRoot !== PANEL_ALL_PROJECTS_ROOT) rememberRoot(nextRoot)
    setRoot(nextRoot)
  }, [setRoot])

  const openCrossRecording = React.useCallback((
    nextRoot: string,
    projectName: string,
    recordingId: string,
  ) => {
    rememberRoot(nextRoot)
    setPinnedProjects((current) => current.some((project) => project.root === nextRoot)
      ? current
      : [...current, { root: nextRoot, name: projectName }])
    openRecording(nextRoot, recordingId)
  }, [openRecording])

  /**
   * Close (collapse) the narrow layout's detail pane. The selection is kept so
   * the tree highlight and scroll position survive, and focus moves back to the
   * selected row so keyboard navigation can continue without a click.
   */
  const closeDetailPane = React.useCallback((): void => {
    setDetailCollapsed(true)
    const selectedRow = document.querySelector<HTMLElement>(
      '[data-row-kind="recording"][data-selected="true"]',
    )
    selectedRow?.focus()
  }, [])

  /** Selecting a row always (re)opens the detail pane in the narrow layout. */
  const selectFromTree = React.useCallback((recordingId: string): void => {
    if (compact) setDetailCollapsed(false)
    selectRecording(recordingId)
  }, [compact, selectRecording])

  // A cleared selection (trash, project switch, page back) must not leave the
  // next opened Recording collapsed.
  React.useEffect(() => {
    if (selectedRecordingId === undefined && detailCollapsed) setDetailCollapsed(false)
  }, [selectedRecordingId, detailCollapsed])

  // Candidates for the empty-state "switch to a project with recordings"
  // affordance. The active project is excluded: switching to it would be a
  // no-op when its detail already reports no recordings.
  const switchableProjects = React.useMemo(
    () => projects.filter((project) => (project.recordingCount ?? 0) > 0 && project.root !== activeRoot),
    [projects, activeRoot],
  )

  const openFolder = React.useCallback(async (): Promise<void> => {
    if (onPickDirectory === undefined || pickingFolder) return
    setPickingFolder(true)
    try {
      const picked = await onPickDirectory()
      if (picked === undefined || picked.trim().length === 0) return
      if (api.addRoot === undefined) throw new Error('panel API cannot register folders')
      const project = await api.addRoot(picked.trim())
      await projectsQuery.refetch()
      selectRoot(project.root)
    } catch (error) {
      setToast(toastFromError(error))
    } finally {
      setPickingFolder(false)
    }
  }, [api, onPickDirectory, pickingFolder, projectsQuery, selectRoot])

  const writes = usePanelWriteActions({
    root: queryRoot,
    write: writable ? api.write : undefined,
    onError: setToast,
  })
  const canWrite = writes !== undefined

  const capabilitiesQuery = useQuery({
    queryKey: ['panel', 'capabilities'],
    queryFn: async (): Promise<PanelCapabilities> =>
      api.capabilities === undefined ? NO_CAPABILITIES : await api.capabilities(),
    staleTime: 60_000,
  })
  const capabilities = capabilitiesQuery.data ?? NO_CAPABILITIES

  const recordingActions = usePanelRecordingActions({
    root: queryRoot,
    actions: writable ? api.actions : undefined,
    onError: setToast,
    onSuccess: setToast,
    onReplayStarted: ({ recordingId, runId }) => {
      setActiveReplay({ recordingId, runId })
      setReplayStartedAt(Date.now())
      // Clear the selection so the newest (replay) Run is adopted once it appears.
      selectRun(undefined)
    },
    onReplayUnavailable: (message) => setReplayUnavailableHint(message),
    onTrashed: (result) => {
      setActiveReplay(undefined)
      if (selectedRecordingId === result.recordingId) selectRecording(undefined)
    },
  })

  const replayEnabled = writable
    && api.actions !== undefined
    && capabilities.replay
    && replayUnavailableHint === undefined
  const replayHint = replayUnavailableHint ?? (!writable
    ? '独立 panel 进程没有回放服务；请从 DSH 右侧栏打开面板后再重跑'
    : !capabilities.replay
      ? '当前宿主没有可用的回放服务（config.replay.enabled=false）'
      : undefined)

  React.useEffect(() => {
    if (toast === undefined) return
    const timer = setTimeout(() => setToast(undefined), 6000)
    return () => clearTimeout(timer)
  }, [toast])

  const projectQuery = useInfiniteQuery({
    queryKey: ['panel', 'project', queryRoot],
    queryFn: ({ pageParam }) => api.getProject(queryRoot, { limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    enabled: queryRoot.length > 0,
    getNextPageParam: (last) => last.recordingsPage?.hasMore === true
      ? last.recordingsPage.offset + last.recordingsPage.limit
      : undefined,
  })
  const project = React.useMemo(
    () => mergeProjectPages(projectQuery.data?.pages ?? []),
    [projectQuery.data],
  )
  const projectErrorCode = projectQuery.error instanceof PanelApiError ? projectQuery.error.code : undefined
  const projectMissing = projectErrorCode === 'PANEL_ROOT_NOT_FOUND'

  const debouncedSearch = useDebouncedValue(search.trim(), 250)
  const searchActive = debouncedSearch.length > 0
  const searchQuery = useQuery({
    queryKey: allProjects
      ? ['panel', 'search-all', debouncedSearch]
      : ['panel', 'search', queryRoot, debouncedSearch],
    queryFn: async (): Promise<PanelSearchResult | PanelCrossProjectSearchResult> => (
      allProjects
        ? await api.searchAll(debouncedSearch, { limit: 100 })
        : await api.search(queryRoot, debouncedSearch)
    ),
    enabled: debouncedSearch.length > 0 && (allProjects || queryRoot.length > 0),
  })
  const singleSearchResult: PanelSearchResult | undefined = !allProjects && searchActive
    ? searchQuery.data as PanelSearchResult | undefined
    : undefined
  const crossSearchResult: PanelCrossProjectSearchResult | undefined = allProjects && searchActive
    ? searchQuery.data as PanelCrossProjectSearchResult | undefined
    : undefined

  const statsQuery = useQuery({
    queryKey: ['panel', 'stats'],
    queryFn: () => api.stats(),
    enabled: allProjects,
  })

  const activeReplayForSelected = activeReplay !== undefined
    && activeReplay.recordingId === selectedRecordingId
    ? activeReplay
    : undefined

  const recordingQuery = useQuery({
    queryKey: ['panel', 'recording', queryRoot, selectedRecordingId ?? ''],
    queryFn: () => api.getRecording(queryRoot, selectedRecordingId ?? ''),
    enabled: !allProjects && queryRoot.length > 0 && selectedRecordingId !== undefined,
    // Poll only while a replay started from this panel is preparing/running.
    // `false` keeps the normal cache policy for every other detail view.
    refetchInterval: (query) => {
      if (activeReplayForSelected === undefined) return false
      if (Date.now() - replayStartedAt > REPLAY_POLL_MAX_MS) return false
      const run = query.state.data?.runs.find((item) => item.runId === activeReplayForSelected.runId)
      if (run === undefined) return replayPollIntervalMs
      return run.status === 'preparing' || run.status === 'running' ? replayPollIntervalMs : false
    },
  })

  const activeRunForSelected = React.useMemo(() => {
    if (activeReplayForSelected === undefined) return undefined
    return recordingQuery.data?.runs.find((run) => run.runId === activeReplayForSelected.runId)
  }, [activeReplayForSelected, recordingQuery.data])

  React.useEffect(() => {
    if (project === undefined || selectedRecordingId === undefined) return
    if (!project.recordings.some((recording) => recording.recordingId === selectedRecordingId)) {
      selectRecording(undefined)
    }
  }, [project, selectedRecordingId, selectRecording])

  React.useEffect(() => {
    const detail = recordingQuery.data
    if (detail === undefined) return
    if (selectedRunId !== undefined && detail.runs.some((run) => run.runId === selectedRunId)) return
    selectRun(detail.runs[0]?.runId)
  }, [recordingQuery.data, selectedRunId, selectRun])

  // Adopt the replayed Run as soon as it appears, so its progress (and later
  // its video) is what the detail shows.
  React.useEffect(() => {
    if (activeRunForSelected !== undefined) selectRun(activeRunForSelected.runId)
  }, [activeRunForSelected, selectRun])

  // Terminal status: stop the inline progress line, refresh tree/stats (new
  // run counts, video presence) and confirm the outcome. The ref makes this
  // fire exactly once per run, even though the query is invalidated meanwhile.
  const settledReplayRun = React.useRef<string | undefined>(undefined)
  const replayRefreshTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => {
    if (replayRefreshTimer.current !== undefined) clearTimeout(replayRefreshTimer.current)
  }, [])
  React.useEffect(() => {
    if (activeRunForSelected === undefined) return
    if (activeRunForSelected.status === 'preparing' || activeRunForSelected.status === 'running') return
    if (settledReplayRun.current === activeRunForSelected.runId) return
    settledReplayRun.current = activeRunForSelected.runId
    setActiveReplay(undefined)
    if (activeRunForSelected.status === 'completed') {
      setToast({
        id: Date.now(),
        code: 'PANEL_REPLAY_COMPLETED',
        message: `重跑完成：${activeRunForSelected.runId}`,
        variant: 'success',
      })
    } else if (activeRunForSelected.status === 'failed') {
      setToast({
        id: Date.now(),
        code: 'PANEL_REPLAY_FAILED',
        message: `重跑失败：${activeRunForSelected.errorCode ?? activeRunForSelected.runId}`,
      })
    }
    void queryClient.invalidateQueries({ queryKey: ['panel', 'project', queryRoot] })
    void queryClient.invalidateQueries({ queryKey: ['panel', 'stats'] })
    void queryClient.invalidateQueries({ queryKey: ['panel', 'recording', queryRoot] })
    // The host finalizes the WebM *after* run.json reaches `completed`, so one
    // immediate refetch can still see a 0-byte video. Refresh once more so the
    // size/playback state settles without the user reloading the panel.
    if (replayRefreshTimer.current !== undefined) clearTimeout(replayRefreshTimer.current)
    replayRefreshTimer.current = setTimeout(() => {
      replayRefreshTimer.current = undefined
      void queryClient.invalidateQueries({ queryKey: ['panel', 'recording', queryRoot] })
      void queryClient.invalidateQueries({ queryKey: ['panel', 'project', queryRoot] })
    }, 1_500)
  }, [activeRunForSelected, queryClient, queryRoot])

  const stats = project?.stats ?? EMPTY_STATS
  const systemStats: PanelSystemStats | undefined = allProjects ? statsQuery.data?.system : undefined

  const retryProjects = (): void => {
    void projectsQuery.refetch()
  }
  const retryProject = (): void => {
    void projectQuery.refetch()
  }
  const retryRecording = (): void => {
    void recordingQuery.refetch()
  }
  const loadMoreProjects = (): void => {
    void projectsQuery.fetchNextPage()
  }
  const loadMoreRecordings = (): void => {
    void projectQuery.fetchNextPage()
  }
  const retryStats = (): void => {
    void statsQuery.refetch()
  }

  const header = (
    <PanelHeader
      compact={compact}
      projects={projects}
      projectsTotal={projectsTotal}
      activeRoot={activeRoot}
      allProjects={allProjects}
      onSelectRoot={selectRoot}
      {...(onPickDirectory === undefined ? {} : { onOpenFolder: () => { void openFolder() }, pickingFolder })}
      search={search}
      onSearch={setSearch}
      searchResultCount={allProjects
        ? crossSearchResult?.returned
        : singleSearchResult?.recordings.length}
      searching={searchActive && searchQuery.isFetching}
      stats={stats}
      systemStats={systemStats}
      statsLoading={allProjects
        ? statsQuery.isLoading
        : projectsQuery.isLoading || (projectQuery.isLoading && project === undefined)}
      project={allProjects ? undefined : project}
      writable={canWrite}
    />
  )

  const asideContent = allProjects ? (
    <AllProjectsAside
      projects={projects}
      report={statsQuery.data}
      reportLoading={statsQuery.isLoading}
      reportError={statsQuery.isError ? errorMessage(statsQuery.error) : undefined}
      onRetryReport={retryStats}
      searchActive={searchActive}
      searching={searchActive && searchQuery.isFetching}
      searchResult={crossSearchResult}
      onOpenProject={selectRoot}
      onOpenRecording={openCrossRecording}
      projectsTotal={projectsTotal}
      hasMoreProjects={projectsQuery.hasNextPage === true}
      loadingMoreProjects={projectsQuery.isFetchingNextPage}
      onLoadMoreProjects={loadMoreProjects}
    />
  ) : projectsQuery.isLoading ? (
    <TreeSkeleton />
  ) : (
    <Tree
      project={project}
      selectedRecordingId={selectedRecordingId}
      onSelect={selectFromTree}
      searchResult={singleSearchResult}
      loading={projectQuery.isLoading && project === undefined}
      projectMissing={projectMissing}
      writes={writes}
      {...(recordingActions === undefined
        ? {}
        : {
            recordingActions: {
              canReplay: replayEnabled,
              canTrash: writable && capabilities.trash,
              replayHint,
              pending: recordingActions.pending,
              replay: async (recordingId: string): Promise<boolean> =>
                (await recordingActions.replay(recordingId)) !== undefined,
              trash: async (recordingId: string): Promise<boolean> =>
                (await recordingActions.trash(recordingId)) !== undefined,
            },
          })}
      hasMore={projectQuery.hasNextPage === true}
      loadingMore={projectQuery.isFetchingNextPage}
      onLoadMore={loadMoreRecordings}
      totalRecordings={project?.recordingsTotal}
    />
  )

  const detailActions: RecordingActionsView | undefined = selectedRecordingId === undefined
    ? undefined
    : {
        replayEnabled,
        ...(replayHint === undefined ? {} : { replayHint }),
        replayPending: recordingActions?.pending.has(`replay:${selectedRecordingId}`) === true,
        ...(activeRunForSelected === undefined ? {} : { activeRun: activeRunForSelected }),
        trashPending: recordingActions?.pending.has(`trash:${selectedRecordingId}`) === true,
        onReplay: async () => recordingActions === undefined
          ? false
          : (await recordingActions.replay(selectedRecordingId)) !== undefined,
        ...(writable && capabilities.trash && recordingActions !== undefined
          ? {
              onTrash: async () => (await recordingActions.trash(selectedRecordingId)) !== undefined,
            }
          : {}),
      }

  const mainContent = allProjects ? (
    <AllProjectsMain
      searchActive={searchActive}
      searching={searchActive && searchQuery.isFetching}
      hasResults={(crossSearchResult?.returned ?? 0) > 0}
      onOpenFolder={onPickDirectory === undefined ? undefined : () => { void openFolder() }}
      pickingFolder={pickingFolder}
    />
  ) : (
    <MainContent
      {...(compact ? { compact: true } : {})}
      projectsLoading={projectsQuery.isLoading}
      projectsError={projectsQuery.isError ? errorMessage(projectsQuery.error) : undefined}
      onRetryProjects={retryProjects}
      hasProjects={projects.length > 0}
      projectError={projectQuery.isError ? errorMessage(projectQuery.error) : undefined}
      projectMissing={projectMissing}
      onRetryProject={retryProject}
      onOpenFolder={onPickDirectory === undefined ? undefined : () => { void openFolder() }}
      pickingFolder={pickingFolder}
      switchableProjects={switchableProjects}
      onSwitchProject={selectRoot}
      projectLoading={projectQuery.isLoading}
      project={project}
      searchActive={searchActive}
      searchIsFetching={searchQuery.isFetching}
      searchHasResults={(singleSearchResult?.recordings.length ?? 0) > 0}
      selectedRecordingId={selectedRecordingId}
      recordingLoading={recordingQuery.isLoading}
      recordingError={recordingQuery.isError ? errorMessage(recordingQuery.error) : undefined}
      onRetryRecording={retryRecording}
      detail={recordingQuery.data}
      {...(detailActions === undefined ? {} : { detailActions })}
      selectedRunId={selectedRunId}
      onSelectRun={selectRun}
      onBackRecording={compact ? closeDetailPane : () => selectRecording(undefined)}
      videoUrl={(runId, options) => api.videoUrl(queryRoot, runId, options)}
    />
  )

  const selectedSummary = React.useMemo(
    () => project?.recordings.find((recording) => recording.recordingId === selectedRecordingId),
    [project, selectedRecordingId],
  )
  const selectedTitle = recordingQuery.data?.recording.title ?? selectedSummary?.title ?? '选中的录制'

  /**
   * Project-level states (no projects, missing root, empty project) keep their
   * actionable surface in the narrow layout too. They replace the detail pane
   * only while nothing is selected.
   */
  const projectSurface = !allProjects && selectedRecordingId === undefined && (
    (!projectsQuery.isLoading && projects.length === 0)
    || projectMissing
    || projectQuery.isError
    || (project !== undefined && project.recordings.length === 0)
  )
  const detailPaneOpen = !allProjects
    && compact
    && selectedRecordingId !== undefined
    && !detailCollapsed
  const showRestoreBar = !allProjects
    && compact
    && selectedRecordingId !== undefined
    && !detailPaneOpen

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-variant={variant}
      data-layout={compact ? 'sidebar' : 'page'}
      data-testid="panel-root"
    >
      {header}

      {compact ? (
        projectSurface ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="sidebar-surface">
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden bg-card/30">{asideContent}</div>
            <main
              className="min-h-0 min-w-0 flex-1 overflow-auto border-t border-border bg-background"
              data-testid="sidebar-surface-main"
            >
              {mainContent}
            </main>
          </div>
        ) : (
          <SidebarLayout
            list={asideContent}
            {...(detailPaneOpen ? { detail: mainContent } : {})}
            {...(selectedRecordingId === undefined ? {} : { detailTitle: selectedTitle })}
            {...(showRestoreBar
              ? {
                  footer: (
                    <button
                      type="button"
                      data-testid="detail-reopen"
                      title="展开选中录制的详情"
                      onClick={() => setDetailCollapsed(false)}
                      className="flex h-8 shrink-0 items-center gap-2 border-t border-border bg-card/70 px-3 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                    >
                      <ChevronUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">详情已收起 · {selectedTitle}</span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">展开</span>
                    </button>
                  ),
                }
              : {})}
            onCloseDetail={closeDetailPane}
          />
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="h-[38vh] shrink-0 border-b border-border bg-card/30 md:h-auto md:w-[340px] md:border-b-0 md:border-r">
            {asideContent}
          </aside>
          <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-background">
            {mainContent}
          </main>
        </div>
      )}

      {toast === undefined ? null : <Toast toast={toast} onDismiss={() => setToast(undefined)} />}
    </div>
  )
}

interface PanelHeaderProps {
  readonly compact: boolean
  readonly projects: readonly PanelProjectSummary[]
  readonly projectsTotal: number | undefined
  readonly activeRoot: string | undefined
  readonly allProjects: boolean
  readonly onSelectRoot: (root: string) => void
  readonly onOpenFolder?: (() => void) | undefined
  readonly pickingFolder?: boolean | undefined
  readonly search: string
  readonly onSearch: (query: string) => void
  readonly searchResultCount: number | undefined
  readonly searching: boolean
  readonly stats: PanelStats
  readonly systemStats: PanelSystemStats | undefined
  readonly statsLoading: boolean
  readonly project: PanelProject | undefined
  readonly writable: boolean
}

function PanelHeader({
  compact,
  projects,
  projectsTotal,
  activeRoot,
  allProjects,
  onSelectRoot,
  onOpenFolder,
  pickingFolder,
  search,
  onSearch,
  searchResultCount,
  searching,
  stats,
  systemStats,
  statsLoading,
  project,
  writable,
}: PanelHeaderProps): React.JSX.Element {
  const meta = project === undefined ? null : (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground',
        compact ? 'mt-1.5' : 'mt-2',
      )}
    >
      <span className="truncate font-mono" title={project.root}>{project.root}</span>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5">
        {project.indexSource === 'loaded' ? 'index.json' : '索引已重建（写入前会按站点补全）'}
      </span>
      {project.warnings.length > 0 ? (
        <span className="shrink-0 text-amber-600 dark:text-amber-400">
          {project.warnings.length} 条数据提示
        </span>
      ) : null}
    </div>
  )

  if (compact) {
    return (
      <header className="shrink-0 border-b border-border bg-card/70 backdrop-blur">
        <div className="flex items-center gap-2 px-3 pt-2.5">
          <Clapperboard className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">录制与回放</span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {writable ? '可编辑' : '只读'}
          </span>
        </div>
        <div className="flex flex-col gap-2 px-3 py-2">
          <ProjectPicker
            compact
            includeAll
            projects={projects}
            projectsTotal={projectsTotal}
            value={activeRoot}
            onChange={onSelectRoot}
            {...(onOpenFolder === undefined ? {} : { onOpenFolder, picking: pickingFolder === true })}
          />
          <SearchBox
            value={search}
            onChange={onSearch}
            resultCount={searchResultCount}
            searching={searching}
            placeholder={allProjects
              ? '跨项目搜索标题、recordingId、意图、Run 状态…'
              : '搜索标题、recordingId、用例意图、Run 状态…'}
          />
        </div>
        <div className="px-3 pb-2">
          <StatsCards compact stats={stats} system={systemStats} loading={statsLoading} />
          {meta}
        </div>
      </header>
    )
  }

  return (
    <header className="shrink-0 border-b border-border bg-card/70 backdrop-blur">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Clapperboard className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">录制与回放</div>
            <div className="text-[11px] text-muted-foreground">
              全局 · {writable ? '可编辑（双击改名）' : '只读'}
            </div>
          </div>
        </div>

        <div className="hidden h-6 w-px bg-border sm:block" aria-hidden="true" />

        <ProjectPicker
          includeAll
          projects={projects}
          projectsTotal={projectsTotal}
          value={activeRoot}
          onChange={onSelectRoot}
          {...(onOpenFolder === undefined ? {} : { onOpenFolder, picking: pickingFolder === true })}
        />

        <SearchBox
          value={search}
          onChange={onSearch}
          resultCount={searchResultCount}
          searching={searching}
          placeholder={allProjects
            ? '跨项目搜索标题、recordingId、意图、Run 状态…'
            : '搜索标题、recordingId、用例意图、Run 状态…'}
        />
      </div>

      <div className="px-4 pb-3">
        <StatsCards stats={stats} system={systemStats} loading={statsLoading} />
        {meta}
      </div>
    </header>
  )
}

interface MainContentProps {
  readonly compact?: boolean
  readonly projectsLoading: boolean
  readonly projectsError: string | undefined
  readonly onRetryProjects: () => void
  readonly hasProjects: boolean
  readonly projectError: string | undefined
  readonly projectMissing?: boolean
  readonly onRetryProject: () => void
  readonly onOpenFolder?: (() => void) | undefined
  readonly pickingFolder?: boolean | undefined
  /** Projects with recordings, excluding the active one (empty-state switch). */
  readonly switchableProjects: readonly PanelProjectSummary[]
  readonly onSwitchProject: (root: string) => void
  readonly projectLoading: boolean
  readonly project: PanelProject | undefined
  readonly searchActive: boolean
  readonly searchIsFetching: boolean
  readonly searchHasResults: boolean
  readonly selectedRecordingId: string | undefined
  readonly recordingLoading: boolean
  readonly recordingError: string | undefined
  readonly onRetryRecording: () => void
  readonly detail: PanelRecordingDetail | undefined
  /** M3 replay/trash state for the selected recording. */
  readonly detailActions?: RecordingActionsView | undefined
  readonly selectedRunId: string | undefined
  readonly onSelectRun: (runId: string) => void
  /** Leave the detail and return to the still-mounted tree. */
  readonly onBackRecording: () => void
  readonly videoUrl: (runId: string, options?: { readonly download?: boolean }) => string
}

function MainContent(props: MainContentProps): React.JSX.Element {
  if (props.projectsLoading) return <DetailSkeleton />
  if (props.projectsError !== undefined) {
    return <ErrorState title="项目列表加载失败" message={props.projectsError} onRetry={props.onRetryProjects} />
  }
  if (!props.hasProjects) {
    return (
      <EmptyState
        icon={FolderGit2}
        title="没有可用的项目"
        description="把 DSH 工作区加入项目列表，或用「打开文件夹」选择一个已有录制的目录。"
        testId="projects-empty"
      >
        {props.onOpenFolder === undefined ? null : (
          <FolderButton onClick={props.onOpenFolder} disabled={props.pickingFolder === true} />
        )}
      </EmptyState>
    )
  }
  if (props.projectMissing === true) {
    return (
      <EmptyState
        icon={FolderX}
        title="项目不存在"
        description="这个目录已被移动或删除。重新选择其他项目，或用「打开文件夹」重新添加。"
        testId="project-missing"
      >
        {props.onOpenFolder === undefined ? null : (
          <FolderButton onClick={props.onOpenFolder} disabled={props.pickingFolder === true} />
        )}
      </EmptyState>
    )
  }
  if (props.projectError !== undefined) {
    return <ErrorState title="项目加载失败" message={props.projectError} onRetry={props.onRetryProject} />
  }
  if (props.projectLoading || props.project === undefined) return <DetailSkeleton />
  if (props.project.recordings.length === 0) {
    return (
      <EmptyState
        icon={Clapperboard}
        title="这个项目还没有录制"
        description={`${props.project.name}（${props.project.root}）下没有找到 .dsh/record-replay/recordings。完成一次录制后再回到这里。`}
        testId="project-empty"
      >
        <ProjectEmptyActions
          projects={props.switchableProjects}
          onSwitch={props.onSwitchProject}
          {...(props.onOpenFolder === undefined ? {} : { onOpenFolder: props.onOpenFolder })}
          pickingFolder={props.pickingFolder === true}
        />
      </EmptyState>
    )
  }
  if (props.selectedRecordingId === undefined) {
    if (props.searchActive && !props.searchIsFetching && !props.searchHasResults) {
      return (
        <EmptyState
          icon={SearchX}
          title="没有匹配的录制"
          description="搜索会匹配录制标题、recordingId、用例意图和 Run 状态（completed / failed / cancelled）。"
          testId="search-empty"
        />
      )
    }
    return (
      <EmptyState
        icon={Clapperboard}
        title="选择一条录制"
        description={`从${props.compact === true ? '上方' : '左侧'}分类树选择 Recording，查看它的 Runs、用例意图、视频和失败详情。`}
        testId="detail-empty"
      />
    )
  }
  if (props.recordingError !== undefined) {
    return <ErrorState title="录制加载失败" message={props.recordingError} onRetry={props.onRetryRecording} />
  }
  if (props.recordingLoading || props.detail === undefined) return <DetailSkeleton />
  const recording = props.detail.recording
  const categoryName = props.project.categories.find((category) => category.id === recording.categoryId)?.name
    ?? recording.site
  const scenario = recording.scenarioId === undefined
    ? undefined
    : props.project.scenarios.find((item) => item.id === recording.scenarioId)
  const context = {
    categoryName,
    ...(scenario === undefined ? {} : { scenarioName: scenario.name }),
  }
  return (
    <RecordingDetail
      detail={props.detail}
      selectedRunId={props.selectedRunId}
      onSelectRun={props.onSelectRun}
      onBack={props.onBackRecording}
      context={context}
      videoUrl={props.videoUrl}
      {...(props.compact === true ? { compact: true } : {})}
      {...(props.detailActions === undefined ? {} : { actions: props.detailActions })}
    />
  )
}

/** Shared "open another folder" action used by the empty states. */
function FolderButton({
  onClick,
  disabled,
}: {
  readonly onClick: () => void
  readonly disabled: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid="open-folder"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
    >
      <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
      {disabled ? '正在选择…' : '打开文件夹'}
    </button>
  )
}

/**
 * Empty-state recovery for a project without recordings: expand the projects
 * that *do* have data and switch to one of them. Keeps the folder picker next
 * to it so a project that is not listed yet stays reachable.
 */
function ProjectEmptyActions({
  projects,
  onSwitch,
  onOpenFolder,
  pickingFolder,
}: {
  readonly projects: readonly PanelProjectSummary[]
  readonly onSwitch: (root: string) => void
  readonly onOpenFolder?: (() => void) | undefined
  readonly pickingFolder: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false)
  const listId = React.useId()
  const hasCandidates = projects.length > 0

  React.useEffect(() => {
    if (!hasCandidates) setExpanded(false)
  }, [hasCandidates])

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-2">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {hasCandidates ? (
          <button
            type="button"
            data-testid="switch-to-recorded"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <FolderSearch className="h-3.5 w-3.5" aria-hidden="true" />
            切换到有录制的项目
          </button>
        ) : null}
        {onOpenFolder === undefined ? null : (
          <FolderButton onClick={onOpenFolder} disabled={pickingFolder} />
        )}
      </div>
      {hasCandidates && expanded ? (
        <div
          id={listId}
          data-testid="recorded-project-list"
          className="w-full overflow-hidden rounded-md border border-border bg-card text-left shadow-sm"
        >
          {projects.map((project) => (
            <button
              key={project.root}
              type="button"
              data-testid="recorded-project-option"
              title={project.root}
              onClick={() => onSwitch(project.root)}
              className="flex w-full min-w-0 items-center gap-2 border-b border-border px-2.5 py-2 text-left transition-colors last:border-b-0 hover:bg-accent"
            >
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{project.name}</span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {project.recordingCount ?? 0} 录制
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
