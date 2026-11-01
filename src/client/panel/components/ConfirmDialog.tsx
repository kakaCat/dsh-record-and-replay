/**
 * Small modal confirmation used by the M3 actions (replay / move to trash).
 *
 * Deliberately not `window.confirm`: the panel lives in the DSH right column
 * and a native dialog would block the whole window. Escape cancels and the
 * dialog is inert while the action is in flight.
 */
import * as React from 'react'
import { AlertTriangle, X } from 'lucide-react'

import { cn } from '../lib/utils.js'
import { buttonVariants } from './ui/button.js'

export interface ConfirmDialogProps {
  readonly title: string
  readonly description: React.ReactNode
  readonly confirmLabel: string
  readonly cancelLabel?: string
  readonly danger?: boolean
  readonly busy?: boolean
  readonly testId: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  danger = false,
  busy = false,
  testId,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element {
  const titleId = React.useId()
  const confirmRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-4 text-foreground shadow-xl"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle
            className={cn('mt-0.5 h-4 w-4 shrink-0', danger ? 'text-red-600 dark:text-red-400' : 'text-primary')}
            aria-hidden="true"
          />
          <h2 id={titleId} className="min-w-0 flex-1 text-sm font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="关闭确认框"
            disabled={busy}
            onClick={onCancel}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-2 break-words text-xs leading-relaxed text-muted-foreground">{description}</div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 px-3 text-xs')}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            data-testid={`${testId}-confirm`}
            onClick={onConfirm}
            className={cn(
              buttonVariants({ variant: danger ? 'destructive' : 'default', size: 'sm' }),
              'h-8 px-3 text-xs',
            )}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
