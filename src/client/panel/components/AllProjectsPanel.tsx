import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FolderGit2, Globe2, Loader2, SearchX } from 'lucide-react'

import type {
  PanelCrossProjectGroup,
  PanelCrossProjectMatch,
  PanelCrossProjectSearchResult,
  PanelProjectSummary,
  PanelStats,
  PanelStatsReport,
} from '../../../panel/types.js'
import { cn, formatBytes, formatDate, formatPercent } from '../lib/utils.js'
import { handleListKeyDown } from '../lib/keyboard.js'
import { EmptyState } from './EmptyState.js'
import { ErrorState } from './ErrorState.js'
import { StatusBadge } from './StatusBadge.js'

const ROW_FOCUS_CLASS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background'

// ---------------------------------------------------------------------------
// Left column in "全部项目" mode: project overview, or grouped cross-project
// search results once the user types in the search box.
// ---------------------------------------------------------------------------

export interface AllProjectsAsideProps {
  /** Loaded pages of the project selector (M2 pagination). */
  readonly projects: readonly PanelProjectSummary[]
  readonly report: PanelStatsReport | undefined
  readonly reportLoading: boolean
  readonly reportError: string | undefined
  readonly onRetryReport: () => void
  readonly searchActive: boolean
  readonly searching: boolean
  readonly searchResult: PanelCrossProjectSearchResult | undefined
  readonly onOpenProject: (root: string) => void
  readonly onOpenRecording: (root: string, projectName: string, recordingId: string) => void
  readonly projectsTotal: number | undefined
  readonly hasMoreProjects: boolean
  readonly loadingMoreProjects: boolean
  readonly onLoadMoreProjects: () => void
}

export function AllProjectsAside(props: AllProjectsAsideProps): React.JSX.Element {
  if (props.searchActive) {
    return (
      <CrossProjectResults
        searching={props.searching}
        result={props.searchResult}
        onOpenRecording={props.onOpenRecording}
      />
    )
  }
  return (
    <ProjectOverview
      projects={props.projects}
      report={props.report}
      loading={props.reportLoading}
      error={props.reportError}
      onRetry={props.onRetryReport}
      onOpenProject={props.onOpenProject}
      projectsTotal={props.projectsTotal}
      hasMore={props.hasMoreProjects}
      loadingMore={props.loadingMoreProjects}
      onLoadMore={props.onLoadMoreProjects}
    />
  )
}

function ProjectOverview({
  projects,
  report,
  loading,
  error,
  onRetry,
  onOpenProject,
  projectsTotal,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  readonly projects: readonly PanelProjectSummary[]
  readonly report: PanelStatsReport | undefined
  readonly loading: boolean
  readonly error: string | undefined
  readonly onRetry: () => void
  readonly onOpenProject: (root: string) => void
  readonly projectsTotal: number | undefined
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly onLoadMore: () => void
}): React.JSX.Element {
  const statsByRoot = React.useMemo(() => {
    const map = new Map<string, PanelStats>()
    for (const entry of report?.projects ?? []) map.set(entry.root, entry.stats)
    return map
  }, [report])

  if (loading && projects.length === 0) {
    return (
      <div className="space-y-2 p-3" aria-hidden="true">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="h-14 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    )
  }
  if (error !== undefined && projects.length === 0) {
    return <ErrorState title="项目统计加载失败" message={error} onRetry={onRetry} />
  }
  if (projects.length === 0) {
    return (
      <EmptyState
        icon={FolderGit2}
        title="没有可用的项目"
        description="把 DSH 工作区加入项目列表，或用「打开文件夹」选择一个已有录制的目录。"
        compact
        testId="all-projects-empty"
      />
    )
  }

  const total = projectsTotal ?? projects.length
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="all-projects-overview">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>全部项目</span>
        <span className="tabular-nums" data-testid="all-projects-count">{total} 个项目</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2" onKeyDown={handleListKeyDown}>
        {projects.map((project) => {
          const stats = statsByRoot.get(project.root)
          return (
          <button
            key={project.root}
            type="button"
            data-testid="project-stat-row"
            data-project-root={project.root}
            data-keyboard-row=""
            title={project.root}
            onClick={() => onOpenProject(project.root)}
            className={cn(
              'mb-1 flex w-full min-w-0 flex-col gap-1 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:border-border hover:bg-accent/50',
              ROW_FOCUS_CLASS,
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{project.name}</span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {stats?.recordings ?? project.recordingCount ?? 0} 录制
              </span>
            </div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">{project.root}</div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
              <span>{stats === undefined ? '统计加载中' : `${String(stats.runs)} Run`}</span>
              {stats === undefined ? null : (
                <>
                  <span aria-hidden="true">·</span>
                  <span className={cn(stats.failedRuns > 0 && 'text-red-600 dark:text-red-400')}>
                    {formatPercent(stats.failureRate)} 失败率
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{stats.videoFiles} 个视频 · {formatBytes(stats.videoBytes)}</span>
                </>
              )}
            </div>
          </button>
          )
        })}
        {hasMore ? (
          <button
            type="button"
            data-testid="projects-load-more"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            {loadingMore ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
            {loadingMore ? '正在加载…' : '加载更多项目'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cross-project search results, grouped by project with a virtualized list.
// ---------------------------------------------------------------------------

type CrossRow =
  | { readonly kind: 'group'; readonly key: string; readonly group: PanelCrossProjectGroup }
  | {
    readonly kind: 'match'
    readonly key: string
    readonly group: PanelCrossProjectGroup
    readonly match: PanelCrossProjectMatch
  }

function buildCrossRows(result: PanelCrossProjectSearchResult | undefined): CrossRow[] {
  if (result === undefined) return []
  const rows: CrossRow[] = []
  for (const group of result.groups) {
    rows.push({ kind: 'group', key: `group:${group.projectRoot}`, group })
    for (const match of group.matches) {
      rows.push({
        kind: 'match',
        key: `match:${group.projectRoot}:${match.recording.recordingId}`,
        group,
        match,
      })
    }
  }
  return rows
}

const MATCH_RUN_LIMIT = 2

export function CrossProjectResults({
  result,
  searching,
  onOpenRecording,
}: {
  readonly result: PanelCrossProjectSearchResult | undefined
  readonly searching: boolean
  readonly onOpenRecording: (root: string, projectName: string, recordingId: string) => void
}): React.JSX.Element {
  const rows = React.useMemo(() => buildCrossRows(result), [result])
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const virtual = rows.length > 80
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === 'group' ? 32 : 80,
    overscan: 10,
    enabled: virtual,
  })

  if (result === undefined) {
    return (
      <div className="space-y-2 p-3" aria-hidden="true" data-testid="cross-search-loading">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-12 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title={searching ? '正在搜索全部项目…' : '没有匹配的录制'}
        description={searching
          ? '跨项目扫描标题、recordingId、用例意图、分类/场景名和 Run 状态。'
          : '试试标题片段、recordingId、用例意图、分类/场景名或 Run 状态（completed / failed）。'}
        compact
        testId="cross-search-empty"
      />
    )
  }

  const renderRow = (row: CrossRow): React.JSX.Element => {
    if (row.kind === 'group') {
      return (
        <div
          className="flex min-h-8 w-full items-center gap-2 rounded-md bg-muted/60 px-2 text-[11px] font-medium"
          data-testid="cross-search-group"
          title={row.group.projectRoot}
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{row.group.projectName}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{row.group.matches.length} 条</span>
        </div>
      )
    }
    const { match } = row
    const recording = match.recording
    const context = [match.categoryName, match.scenarioName].filter((value): value is string => value !== undefined)
    return (
      <button
        type="button"
        data-testid={`cross-result-${recording.recordingId}`}
        data-project-root={row.group.projectRoot}
        data-keyboard-row=""
        title={recording.title}
        onClick={() => onOpenRecording(row.group.projectRoot, row.group.projectName, recording.recordingId)}
        className={cn(
          'flex w-full min-w-0 flex-col justify-center gap-1 rounded-lg py-1.5 pl-2 pr-1 text-left transition-colors hover:bg-accent/60',
          ROW_FOCUS_CLASS,
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{recording.title}</span>
          <span className="shrink-0">
            <StatusBadge status={recording.status} />
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[10px] text-muted-foreground">
          <span className="truncate font-mono">{recording.recordingId}</span>
          {context.length === 0 ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span className="max-w-[38%] truncate">{context.join(' / ')}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{recording.runCount} Run</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{formatDate(recording.updatedAt)}</span>
          {match.matchKind === 'run' ? (
            <span className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
              Run 匹配
            </span>
          ) : null}
        </div>
        {match.matchedRuns.length === 0 ? null : (
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[10px] text-muted-foreground">
            {match.matchedRuns.slice(0, MATCH_RUN_LIMIT).map((run) => (
              <span key={run.runId} className="inline-flex shrink-0 items-center gap-1">
                <StatusBadge status={run.status} />
                <span className="truncate">{formatDate(run.startedAt)}</span>
              </span>
            ))}
            {match.matchedRuns.length > MATCH_RUN_LIMIT ? (
              <span className="shrink-0">+{match.matchedRuns.length - MATCH_RUN_LIMIT}</span>
            ) : null}
          </div>
        )}
      </button>
    )
  }

  const header = (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      <span>跨项目搜索结果</span>
      <span className="tabular-nums" data-testid="cross-search-count">
        {result.truncated ? `${result.returned} / ${result.total} 条` : `${result.returned} 条`}
      </span>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="cross-search-results">
      {header}
      {result.truncated ? (
        <div className="shrink-0 border-b border-border bg-amber-500/10 px-3 py-1 text-[10px] text-amber-700 dark:text-amber-400">
          结果超过 {result.limit} 条，仅显示前 {result.returned} 条；请补充关键词。
        </div>
      ) : null}
      {virtual ? (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-2" onKeyDown={handleListKeyDown}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              if (row === undefined) return null
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full px-1 py-0.5"
                  style={{ transform: `translateY(${String(virtualRow.start)}px)` }}
                >
                  {renderRow(row)}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2" onKeyDown={handleListKeyDown}>
          {rows.map((row) => (
            <div key={row.key} className="px-1 py-0.5">
              {renderRow(row)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main area in "全部项目" mode (before a result is opened).
// ---------------------------------------------------------------------------

export function AllProjectsMain({
  searchActive,
  searching,
  hasResults,
  onOpenFolder,
  pickingFolder,
}: {
  readonly searchActive: boolean
  readonly searching: boolean
  readonly hasResults: boolean
  readonly onOpenFolder?: (() => void) | undefined
  readonly pickingFolder: boolean
}): React.JSX.Element {
  if (searchActive) {
    if (searching) {
      return (
        <EmptyState
          icon={Globe2}
          title="正在搜索全部项目…"
          description="并行扫描每个项目的录制、用例意图和 Run 状态。"
          testId="all-projects-searching"
        />
      )
    }
    if (!hasResults) {
      return (
        <EmptyState
          icon={SearchX}
          title="没有匹配的录制"
          description="跨项目搜索会匹配标题、recordingId、用例意图、分类/场景名和 Run 状态；试试更短的关键词。"
          testId="search-all-empty"
        />
      )
    }
    return (
      <EmptyState
        icon={Globe2}
        title="选择一条跨项目结果"
        description="点击左侧搜索结果会切换到对应项目，并选中该录制查看 Runs、用例意图和视频。"
        testId="all-projects-prompt"
      />
    )
  }
  return (
    <EmptyState
      icon={Globe2}
      title="全部项目"
      description="搜索框会跨所有项目查找录制；左侧列表显示每个项目的录制数、Run 数、失败率和视频占用。选择项目即可进入分类树。"
      testId="all-projects-main"
    >
      {onOpenFolder === undefined ? null : (
        <button
          type="button"
          onClick={onOpenFolder}
          disabled={pickingFolder}
          data-testid="all-projects-open-folder"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
        >
          打开文件夹
        </button>
      )}
    </EmptyState>
  )
}
