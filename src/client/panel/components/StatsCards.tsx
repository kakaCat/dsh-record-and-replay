import type * as React from 'react'
import { AlertTriangle, Clapperboard, FolderGit2, HardDrive, PlayCircle } from 'lucide-react'

import type { PanelStats, PanelSystemStats } from '../../../panel/types.js'
import { cn, formatBytes, formatPercent } from '../lib/utils.js'

export interface StatsCardsProps {
  readonly stats: PanelStats
  readonly loading?: boolean
  /** One wrapping line of numbers for the narrow right sidebar. */
  readonly compact?: boolean
  /**
   * System-wide totals for the "全部项目" mode. When present it replaces the
   * single-project cards and adds the project count.
   */
  readonly system?: PanelSystemStats | undefined
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  readonly label: string
  readonly value: string
  readonly detail: string
  readonly icon: typeof Clapperboard
  readonly tone: 'default' | 'danger'
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <div
        className={
          tone === 'danger'
            ? 'grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400'
            : 'grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary'
        }
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tabular-nums leading-tight">{value}</span>
          <span className="truncate text-[11px] text-muted-foreground">{detail}</span>
        </div>
      </div>
    </div>
  )
}

export function StatsCards({
  stats,
  loading = false,
  compact = false,
  system,
}: StatsCardsProps): React.JSX.Element {
  if (system !== undefined) {
    if (compact) {
      if (loading) {
        return <div className="h-5 w-52 animate-pulse rounded bg-muted" aria-hidden="true" />
      }
      const items = [
        { key: 'projects', label: '项目', value: String(system.projects), detail: '全部', danger: false },
        { key: 'recordings', label: '录制', value: String(system.recordings), detail: `${String(system.steps)} 步`, danger: false },
        { key: 'runs', label: 'Run', value: String(system.runs), detail: `${String(system.cancelledRuns)} 已取消`, danger: false },
        { key: 'failure', label: '失败率', value: formatPercent(system.failureRate), detail: `${String(system.failedRuns)} 失败`, danger: system.failedRuns > 0 },
        { key: 'video', label: '视频', value: formatBytes(system.videoBytes), detail: `${String(system.videoFiles)} 个文件`, danger: false },
      ]
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-5" data-testid="stats-system-compact">
          {items.map((item) => (
            <span key={item.key} className="inline-flex items-baseline gap-1 whitespace-nowrap">
              <span className="text-muted-foreground">{item.label}</span>
              <span className={cn('text-xs font-semibold tabular-nums', item.danger && 'text-red-600 dark:text-red-400')}>
                {item.value}
              </span>
              <span className="text-muted-foreground">· {item.detail}</span>
            </span>
          ))}
        </div>
      )
    }

    if (loading) {
      return (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-[66px] animate-pulse rounded-xl border border-border bg-card" />
          ))}
        </div>
      )
    }
    return (
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5" data-testid="stats-system">
        <StatCard
          label="项目"
          value={String(system.projects)}
          detail="全部项目"
          icon={FolderGit2}
          tone="default"
        />
        <StatCard
          label="总录制"
          value={String(system.recordings)}
          detail={`${String(system.steps)} 步`}
          icon={Clapperboard}
          tone="default"
        />
        <StatCard
          label="总 Run"
          value={String(system.runs)}
          detail={`${String(system.cancelledRuns)} 已取消`}
          icon={PlayCircle}
          tone="default"
        />
        <StatCard
          label="失败率"
          value={formatPercent(system.failureRate)}
          detail={`${String(system.failedRuns)} 失败`}
          icon={AlertTriangle}
          tone={system.failedRuns > 0 ? 'danger' : 'default'}
        />
        <StatCard
          label="视频占用"
          value={formatBytes(system.videoBytes)}
          detail={`${String(system.videoFiles)} 个文件`}
          icon={HardDrive}
          tone="default"
        />
      </div>
    )
  }

  if (compact) {
    if (loading) {
      return <div className="h-5 w-40 animate-pulse rounded bg-muted" aria-hidden="true" />
    }
    const items = [
      { key: 'recordings', label: '录制', value: String(stats.recordings), detail: `${String(stats.steps)} 步`, danger: false },
      { key: 'runs', label: 'Run', value: String(stats.runs), detail: `${String(stats.cancelledRuns)} 已取消`, danger: false },
      { key: 'failure', label: '失败率', value: formatPercent(stats.failureRate), detail: `${String(stats.failedRuns)} 失败`, danger: stats.failedRuns > 0 },
      { key: 'video', label: '视频', value: formatBytes(stats.videoBytes), detail: `${String(stats.videoFiles)} 个文件`, danger: false },
    ]
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-5">
        {items.map((item) => (
          <span key={item.key} className="inline-flex items-baseline gap-1 whitespace-nowrap">
            <span className="text-muted-foreground">{item.label}</span>
            <span className={cn('text-xs font-semibold tabular-nums', item.danger && 'text-red-600 dark:text-red-400')}>
              {item.value}
            </span>
            <span className="text-muted-foreground">· {item.detail}</span>
          </span>
        ))}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-[66px] animate-pulse rounded-xl border border-border bg-card" />
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <StatCard
        label="录制"
        value={String(stats.recordings)}
        detail={`${String(stats.steps)} 步`}
        icon={Clapperboard}
        tone="default"
      />
      <StatCard
        label="Run"
        value={String(stats.runs)}
        detail={`${String(stats.cancelledRuns)} 已取消`}
        icon={PlayCircle}
        tone="default"
      />
      <StatCard
        label="失败率"
        value={formatPercent(stats.failureRate)}
        detail={`${String(stats.failedRuns)} 失败`}
        icon={AlertTriangle}
        tone={stats.failedRuns > 0 ? 'danger' : 'default'}
      />
      <StatCard
        label="视频占用"
        value={formatBytes(stats.videoBytes)}
        detail={`${String(stats.videoFiles)} 个文件`}
        icon={HardDrive}
        tone="default"
      />
    </div>
  )
}
