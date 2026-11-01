import type * as React from 'react'
import type { LucideIcon } from 'lucide-react'

export interface EmptyStateProps {
  readonly icon: LucideIcon
  readonly title: string
  readonly description: string
  readonly children?: React.ReactNode
  readonly compact?: boolean
  readonly testId?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  compact = false,
  testId,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={
        compact
          ? 'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center'
          : 'flex h-full min-h-[320px] flex-col items-center justify-center gap-3 px-8 py-16 text-center'
      }
      data-testid={testId}
    >
      <div className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-card text-muted-foreground shadow-sm">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="max-w-sm">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  )
}
