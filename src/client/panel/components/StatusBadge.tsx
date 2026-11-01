import type * as React from 'react'
import type { PanelRecordingStatus, PanelRunStatus } from '../../../panel/types.js'
import { Badge, type BadgeProps } from './ui/badge.js'

type Status = PanelRecordingStatus | PanelRunStatus

const LABELS: Readonly<Record<Status, string>> = {
  recording: '录制中',
  completed: '完成',
  failed: '失败',
  interrupted: '中断',
  preparing: '准备中',
  running: '运行中',
  cancelled: '已取消',
}

const VARIANTS: Readonly<Record<Status, NonNullable<BadgeProps['variant']>>> = {
  recording: 'destructive',
  completed: 'success',
  failed: 'destructive',
  interrupted: 'warning',
  preparing: 'outline',
  running: 'info',
  cancelled: 'warning',
}

export function StatusBadge({ status, className }: { readonly status: Status; readonly className?: string }): React.JSX.Element {
  return (
    <Badge variant={VARIANTS[status]} className={className} data-status={status}>
      {LABELS[status]}
    </Badge>
  )
}
