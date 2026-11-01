import * as React from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Download,
  Film,
  Loader2,
  PlayCircle,
  RotateCcw,
  Trash2,
  Video,
} from 'lucide-react'

import type {
  PanelRecordingDetail,
  PanelRecordingEndReason,
  PanelRecordingSummary,
  PanelRunSummary,
} from '../../../panel/types.js'
import { cn, formatBytes, formatDate, formatDuration } from '../lib/utils.js'
import { handleListKeyDown } from '../lib/keyboard.js'
import { ConfirmDialog } from './ConfirmDialog.js'
import { EmptyState } from './EmptyState.js'
import { IntentBlock } from './IntentBlock.js'
import { StatusBadge } from './StatusBadge.js'
import { buttonVariants } from './ui/button.js'

/** M3 action state injected by the panel shell (replay + trash). */
export interface RecordingActionsView {
  /** False when this process has no replay service (standalone panel). */
  readonly replayEnabled: boolean
  /** Why the replay button is disabled; shown next to it. */
  readonly replayHint?: string
  readonly replayPending: boolean
  /** The run started by this panel session, while it is preparing/running (or just finished). */
  readonly activeRun?: PanelRunSummary
  readonly trashPending: boolean
  /** Resolves true when the run was accepted (the dialog closes). */
  readonly onReplay: () => Promise<boolean>
  /** Absent on read-only entries. */
  readonly onTrash?: (() => Promise<boolean>) | undefined
}

/**
 * Where the recording sits in the tree. Supplied by the panel shell so the
 * detail can keep the category › scenario context visible even while the tree
 * has been scrolled out of view in a narrow sidebar.
 */
export interface RecordingContext {
  readonly categoryName: string
  readonly scenarioName?: string
}

export interface RecordingDetailProps {
  readonly detail: PanelRecordingDetail
  readonly selectedRunId: string | undefined
  readonly onSelectRun: (runId: string) => void
  readonly videoUrl: (runId: string, options?: { readonly download?: boolean }) => string
  /** Stacked, narrow layout for the DSH right sidebar. */
  readonly compact?: boolean
  /** M3 actions; absent keeps the detail read-only. */
  readonly actions?: RecordingActionsView | undefined
  /** Tree context for the breadcrumb; absent falls back to the recording site. */
  readonly context?: RecordingContext | undefined
  /** Return to the tree. Present on the DSH mount. */
  readonly onBack?: (() => void) | undefined
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Clipboard permissions can reject in embedded frames; try the legacy path.
  }
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}

function CopyRecordingId({ value }: { readonly value: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  React.useEffect(() => () => {
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
  }, [])

  return (
    <button
      type="button"
      data-testid="copy-recording-id"
      aria-label={`复制 Recording ID ${value}`}
      title={copied ? '已复制' : '复制 Recording ID'}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return
          setCopied(true)
          if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
          resetTimer.current = setTimeout(() => setCopied(false), 1_500)
        })
      }}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied
        ? <Check className="h-3 w-3 text-primary" aria-hidden="true" />
        : <Copy className="h-3 w-3" aria-hidden="true" />}
    </button>
  )
}

const END_REASON_LABELS: Readonly<Record<PanelRecordingEndReason, string>> = {
  tool_stopped: '手动停止',
  max_duration: '到达上限',
  cancelled: '主动丢弃',
  failed: '失败',
  interrupted: '中断',
}

function RecordingMeta({ recording }: { readonly recording: PanelRecordingSummary }): React.JSX.Element {
  return (
    <div
      data-testid="recording-meta"
      className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-1">
        <span className="shrink-0 text-muted-foreground/70">ID</span>
        <span className="min-w-0 truncate font-mono text-foreground/80" title={recording.recordingId}>
          {recording.recordingId}
        </span>
        <CopyRecordingId value={recording.recordingId} />
      </span>
      <span className="shrink-0">站点 {recording.site}</span>
      {recording.endReason === undefined
        ? null
        : <span className="shrink-0" data-testid="recording-end-reason">结束 {END_REASON_LABELS[recording.endReason]}</span>}
      {recording.suppressedCount === undefined || recording.suppressedCount <= 0
        ? null
        : <span className="shrink-0 text-amber-600 dark:text-amber-400" data-testid="recording-suppressed-count">已抑制 {recording.suppressedCount} 步</span>}
      <span className="shrink-0">{recording.stepCount} 步</span>
      <span className="shrink-0">{recording.runCount} Run</span>
      <span className="shrink-0">创建 {formatDate(recording.createdAt)}</span>
      <span className="shrink-0">更新 {formatDate(recording.updatedAt)}</span>
    </div>
  )
}

function DetailBreadcrumb({
  context,
  onBack,
}: {
  readonly context: RecordingContext
  readonly onBack: (() => void) | undefined
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      {onBack === undefined ? null : (
        <button
          type="button"
          data-testid="detail-back"
          onClick={onBack}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          返回
        </button>
      )}
      <nav
        aria-label="面包屑"
        data-testid="detail-breadcrumb"
        className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
      >
        <span className="min-w-0 max-w-[10rem] truncate" title={context.categoryName}>
          {context.categoryName}
        </span>
        <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
        {context.scenarioName === undefined ? (
          <span className="shrink-0 italic">未分组</span>
        ) : (
          <span className="min-w-0 max-w-[10rem] truncate" title={context.scenarioName}>
            {context.scenarioName}
          </span>
        )}
      </nav>
    </div>
  )
}

function RunVideo({
  run,
  videoUrl,
}: {
  readonly run: PanelRunSummary
  readonly videoUrl: (runId: string, options?: { readonly download?: boolean }) => string
}): React.JSX.Element {
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const source = videoUrl(run.runId)

  React.useEffect(() => {
    setLoading(true)
    setFailed(false)
  }, [source])

  if (!run.hasVideo) {
    return (
      <EmptyState
        icon={Film}
        title="这个 Run 没有视频"
        description="回放视频默认开启；如果 ffmpeg 没有启动，回放仍会成功，但不会留下视频。"
        compact
        testId="video-empty"
      />
    )
  }

  return (
    <div className="space-y-2" data-testid="selected-run-video">
      <div className="relative overflow-hidden rounded-lg border border-border bg-black">
        <video
          key={source}
          controls
          preload="metadata"
          src={source}
          className="aspect-video w-full bg-black"
          onLoadedMetadata={() => setLoading(false)}
          onLoadedData={() => setLoading(false)}
          onCanPlay={() => setLoading(false)}
          onError={() => {
            setLoading(false)
            setFailed(true)
          }}
          aria-label={`Run ${run.runId} 的回放视频`}
        />
        {loading && !failed ? (
          <div
            data-testid="video-skeleton"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60"
          >
            <div className="absolute inset-0 animate-pulse bg-muted/15" />
            <Loader2 className="relative h-5 w-5 animate-spin text-white/70" />
            <span className="relative text-[11px] text-white/70">视频加载中…</span>
          </div>
        ) : null}
        {failed ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center">
            <p className="text-[11px] leading-relaxed text-white/80">
              浏览器无法播放这个视频（WebM/VP9 需要 Chromium 或 Safari 17+）。
              可直接下载后用本地播放器打开。
            </p>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Video className="h-3.5 w-3.5" aria-hidden="true" />
          {run.videoBytes === undefined ? 'WebM' : formatBytes(run.videoBytes)}
        </span>
        <a
          href={videoUrl(run.runId, { download: true })}
          download
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-7 px-2 text-xs')}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          下载视频
        </a>
      </div>
    </div>
  )
}

function RunError({ run }: { readonly run: PanelRunSummary }): React.JSX.Element | null {
  if (run.status !== 'failed' && run.status !== 'cancelled') return null
  const failed = run.status === 'failed'
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        failed
          ? 'border-red-500/25 bg-red-500/5'
          : 'border-amber-500/25 bg-amber-500/5',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 text-sm font-semibold',
          failed ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400',
        )}
      >
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {failed ? 'Run 失败' : 'Run 已取消'}
      </div>
      <dl className="mt-2 space-y-2 text-xs">
        {run.errorCode === undefined ? null : (
          <div className="flex flex-wrap items-baseline gap-2">
            <dt className="text-muted-foreground">errorCode</dt>
            <dd className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-red-600 dark:text-red-400">
              {run.errorCode}
            </dd>
          </div>
        )}
        {run.failedStepId === undefined ? null : (
          <div className="flex flex-wrap items-baseline gap-2">
            <dt className="text-muted-foreground">失败步骤</dt>
            <dd className="break-all font-mono text-[11px]">{run.failedStepId}</dd>
          </div>
        )}
        {run.errorMessage === undefined ? null : (
          <div>
            <dt className="text-muted-foreground">错误信息</dt>
            <dd className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{run.errorMessage}</dd>
          </div>
        )}
      </dl>
    </div>
  )
}

function RunDetailCard({ run }: { readonly run: PanelRunSummary }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-sm" data-testid="run-detail">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Run 详情</h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <dt className="shrink-0 text-muted-foreground">状态</dt>
          <dd className="min-w-0"><StatusBadge status={run.status} /></dd>
        </div>
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <dt className="shrink-0 text-muted-foreground">耗时</dt>
          <dd className="min-w-0 truncate text-right tabular-nums">{formatDuration(run.durationMs)}</dd>
        </div>
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <dt className="shrink-0 text-muted-foreground">开始</dt>
          <dd className="min-w-0 truncate text-right">{formatDate(run.startedAt)}</dd>
        </div>
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <dt className="shrink-0 text-muted-foreground">结束</dt>
          <dd className="min-w-0 truncate text-right">{formatDate(run.finishedAt)}</dd>
        </div>
        {run.videoBytes === undefined ? null : (
          <div className="col-span-2 flex min-w-0 items-baseline justify-between gap-2">
            <dt className="shrink-0 text-muted-foreground">视频</dt>
            <dd className="min-w-0 truncate text-right tabular-nums">{formatBytes(run.videoBytes)}</dd>
          </div>
        )}
      </dl>
    </div>
  )
}

function RunRow({
  run,
  selected,
  onSelect,
  compact = false,
}: {
  readonly run: PanelRunSummary
  readonly selected: boolean
  readonly onSelect: () => void
  readonly compact?: boolean
}): React.JSX.Element {
  const failed = run.status === 'failed'
  return (
    <button
      type="button"
      role="option"
      onClick={onSelect}
      data-testid={`run-row-${run.runId}`}
      data-keyboard-row=""
      data-selected={selected ? 'true' : undefined}
      aria-selected={selected}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'relative w-full min-w-0 border-b border-border text-left text-xs transition-colors last:border-b-0',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        compact ? 'flex flex-col gap-1 px-3 py-2.5' : 'grid grid-cols-[92px_minmax(0,1fr)_84px_130px] items-center gap-3 px-3 py-2.5 md:grid-cols-[110px_minmax(0,1fr)_96px_150px]',
        selected
          ? 'bg-accent/90 ring-1 ring-inset ring-primary/25'
          : 'hover:bg-accent/40',
        failed && !selected && 'bg-red-500/[0.04]',
      )}
    >
      {selected ? (
        <span
          aria-hidden="true"
          data-testid={`selected-run-bar-${run.runId}`}
          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary"
        />
      ) : null}
      {compact ? (
        <>
          <span className="flex min-w-0 items-center gap-2">
            <StatusBadge status={run.status} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90" title={run.runId}>
              {run.runId}
            </span>
            {run.hasVideo ? <Video className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="有视频" /> : null}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
            <span className="shrink-0 tabular-nums">{formatDate(run.startedAt)}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 tabular-nums">{formatDuration(run.durationMs)}</span>
            {run.errorCode === undefined ? null : (
              <span className="ml-auto min-w-0 truncate text-red-600 dark:text-red-400" title={run.errorCode}>
                {run.errorCode}
              </span>
            )}
          </span>
        </>
      ) : (
        <>
          <span>
            <StatusBadge status={run.status} />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-[11px] text-foreground/90" title={run.runId}>
              {run.runId}
            </span>
            {run.errorCode === undefined ? null : (
              <span className="mt-0.5 block truncate text-[10px] text-red-600 dark:text-red-400">{run.errorCode}</span>
            )}
          </span>
          <span className="tabular-nums text-muted-foreground">{formatDuration(run.durationMs)}</span>
          <span className="truncate text-muted-foreground">{formatDate(run.startedAt)}</span>
        </>
      )}
    </button>
  )
}

function SectionHeading({
  id,
  title,
  count,
  hint,
}: {
  readonly id: string
  readonly title: string
  readonly count?: number
  readonly hint?: string
}): React.JSX.Element {
  return (
    <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <h2 id={id} className="text-sm font-semibold">
        {title}
        {count === undefined ? null : (
          <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </h2>
      {hint === undefined ? null : (
        <span className="min-w-0 text-[11px] text-muted-foreground">{hint}</span>
      )}
    </div>
  )
}

function RunOverview({ runs }: { readonly runs: readonly PanelRunSummary[] }): React.JSX.Element {
  const failed = runs.filter((run) => run.status === 'failed').length
  const withVideo = runs.filter((run) => run.hasVideo).length
  const cells = [
    { label: 'Runs', value: runs.length },
    { label: '失败', value: failed },
    { label: '有视频', value: withVideo },
  ] as const
  return (
    <div className="grid grid-cols-3 gap-2" data-testid="runs-overview">
      {cells.map((cell) => (
        <div
          key={cell.label}
          className="rounded-lg border border-border bg-card px-2 py-1.5 text-center shadow-sm"
        >
          <div className="text-sm font-semibold tabular-nums">{cell.value}</div>
          <div className="text-[10px] text-muted-foreground">{cell.label}</div>
        </div>
      ))}
    </div>
  )
}

export function RecordingDetail({
  detail,
  selectedRunId,
  onSelectRun,
  videoUrl,
  compact = false,
  actions,
  context,
  onBack,
}: RecordingDetailProps): React.JSX.Element {
  const { recording, runs } = detail
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? runs[0]
  const [confirm, setConfirm] = React.useState<'replay' | 'trash' | undefined>(undefined)

  const activeRun = actions?.activeRun
  const running = activeRun?.status === 'preparing' || activeRun?.status === 'running'
  const replayBusy = actions?.replayPending === true || running
  const trashBusy = actions?.trashPending === true
  const replayDisabled = actions === undefined
    || !actions.replayEnabled
    || recording.status !== 'completed'
    || replayBusy
  const replayHint = recording.status !== 'completed'
    ? '只有已完成的录制可以重跑'
    : actions === undefined
      ? undefined
      : !actions.replayEnabled
        ? actions.replayHint ?? '当前面板进程没有回放服务'
        : running
          ? '正在重跑…'
          : undefined

  const replay = actions?.onReplay
  const trash = actions?.onTrash
  const resolvedContext: RecordingContext = context ?? { categoryName: recording.site }

  return (
    <div className="flex min-h-full flex-col" data-testid="recording-detail">
      <header
        data-testid="detail-header"
        className={cn(
          'border-b border-border',
          // The narrow layout owns a pane bar with the recording title, so the
          // header scrolls away instead of holding half of a ~300px pane.
          compact
            ? 'relative bg-background'
            : 'sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85',
        )}
      >
        <div className={cn('mx-auto flex w-full max-w-5xl min-w-0 flex-col', compact ? 'px-3 py-2' : 'px-5 py-4 md:px-6')}>
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <DetailBreadcrumb context={resolvedContext} onBack={onBack} />

            {actions === undefined ? null : (
              <div className="flex shrink-0 flex-wrap items-center gap-2" data-testid="recording-actions">
                <button
                  type="button"
                  data-testid="replay-recording"
                  disabled={replayDisabled}
                  title={replayHint}
                  aria-disabled={replayDisabled}
                  onClick={() => setConfirm('replay')}
                  className={cn(buttonVariants({ variant: 'default', size: 'sm' }), 'h-8 gap-1.5 px-3 text-xs')}
                >
                  {replayBusy
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
                  {replayBusy ? '重跑中…' : '重跑'}
                </button>
                {trash === undefined ? null : (
                  <button
                    type="button"
                    data-testid="trash-recording"
                    disabled={trashBusy || replayBusy}
                    title="移到回收站（不会删除，可从磁盘恢复）"
                    onClick={() => setConfirm('trash')}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 gap-1.5 px-3 text-xs')}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    移到回收站
                  </button>
                )}
              </div>
            )}
          </div>

          <div className={cn('flex min-w-0 flex-wrap items-center gap-2', compact ? 'mt-1.5' : 'mt-2')}>
            <h1
              className={cn(
                'min-w-0 break-words font-semibold tracking-tight',
                compact ? 'text-base' : 'text-lg',
              )}
            >
              {recording.title}
            </h1>
            <StatusBadge status={recording.status} />
          </div>

          <RecordingMeta recording={recording} />

          {replayHint !== undefined && actions !== undefined && !actions.replayEnabled ? (
            <p className="mt-2 text-[11px] text-muted-foreground" data-testid="replay-unavailable">
              {replayHint}
            </p>
          ) : null}

          {replayBusy || activeRun !== undefined ? (
            <div
              className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px]"
              data-testid="replay-status"
              role="status"
              aria-live="polite"
            >
              {activeRun === undefined ? (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  正在启动回放…
                </span>
              ) : (
                <>
                  <span className="text-muted-foreground">重跑</span>
                  <span className="font-mono text-foreground/90">{activeRun.runId}</span>
                  <StatusBadge status={activeRun.status} />
                  {activeRun.status === 'failed' && activeRun.errorCode !== undefined ? (
                    <span className="text-red-600 dark:text-red-400">{activeRun.errorCode}</span>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </header>

      <div className={cn('mx-auto flex w-full max-w-5xl flex-col', compact ? 'gap-3 p-3' : 'gap-6 p-5 md:p-6')}>
        <section aria-labelledby="overview-heading" data-testid="detail-overview">
          <SectionHeading id="overview-heading" title="概览" hint="用例意图与 Run 汇总" />
          <div className="space-y-2">
            <IntentBlock recording={recording} testId="detail-intent" />
            <RunOverview runs={runs} />
          </div>
        </section>

        <section aria-labelledby="runs-heading" data-testid="detail-runs">
          <SectionHeading
            id="runs-heading"
            title="Runs"
            count={runs.length}
            {...(runs.length === 0 ? {} : { hint: '选择 Run 查看对应视频与错误详情' })}
          />

          {runs.length === 0 ? (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <EmptyState
                icon={PlayCircle}
                title="还没有回放 Run"
                description="用 cua_replay_start 或 CLI 回放这个录制后，Run 会出现在这里。"
                compact
                testId="runs-empty"
              />
            </div>
          ) : (
            <div
              className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
              role="listbox"
              aria-label="回放 Run 列表"
              onKeyDown={handleListKeyDown}
            >
              <div className="hidden grid-cols-[110px_minmax(0,1fr)_96px_150px] gap-3 border-b border-border bg-muted/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:grid">
                <span>状态</span>
                <span>Run</span>
                <span>耗时</span>
                <span>开始时间</span>
              </div>
              {runs.map((run) => (
                <RunRow
                  key={run.runId}
                  run={run}
                  compact={compact}
                  selected={run.runId === selectedRun?.runId}
                  onSelect={() => onSelectRun(run.runId)}
                />
              ))}
            </div>
          )}
        </section>

        {selectedRun === undefined ? null : (
          <section aria-labelledby="video-heading" data-testid="detail-video">
            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
              <h2 id="video-heading" className="text-sm font-semibold">回放视频</h2>
              <StatusBadge status={selectedRun.status} />
              <span
                className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground"
                title={selectedRun.runId}
              >
                {selectedRun.runId}
              </span>
            </div>
            <div className="space-y-2">
              <RunVideo key={selectedRun.runId} run={selectedRun} videoUrl={videoUrl} />
              <RunDetailCard run={selectedRun} />
              <RunError run={selectedRun} />
            </div>
          </section>
        )}
      </div>

      {confirm === 'replay' && replay !== undefined ? (
        <ConfirmDialog
          testId="replay-confirm"
          title="重跑这条录制？"
          confirmLabel="开始重跑"
          busy={replayBusy}
          description={(
            <>
              会在一个<b>隔离的 Chromium 窗口</b>里按原步骤重新执行，并新建一个 Run。
              录制中的写动作（提交表单、点击下单等）都会真实发生；生成的视频会写入这条录制的
              <code className="mx-1 rounded bg-muted px-1 font-mono text-[10px]">runs/</code>
              目录。
            </>
          )}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            void replay().then((ok) => {
              if (ok) setConfirm(undefined)
            })
          }}
        />
      ) : null}

      {confirm === 'trash' && trash !== undefined ? (
        <ConfirmDialog
          testId="trash-confirm"
          title="把这条录制移到回收站？"
          confirmLabel="移到回收站"
          danger
          busy={trashBusy}
          description={(
            <>
              整个录制目录会被<b>移动</b>到
              <code className="mx-1 rounded bg-muted px-1 font-mono text-[10px]">.dsh/record-replay/trash/</code>
              ，不会直接删除；需要时可以手动移回
              <code className="mx-1 rounded bg-muted px-1 font-mono text-[10px]">recordings/</code>
              目录恢复。该录制的分类/场景标记也会从 index.json 移除。
            </>
          )}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            void trash().then((ok) => {
              if (ok) setConfirm(undefined)
            })
          }}
        />
      ) : null}
    </div>
  )
}
