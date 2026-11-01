/** Toast for panel actions; failures show the stable host error code. */
import * as React from 'react'
import { AlertTriangle, CheckCircle2, X } from 'lucide-react'

import type { PanelToast } from '../write-actions.js'

export function Toast({
  toast,
  onDismiss,
}: {
  readonly toast: PanelToast
  readonly onDismiss: () => void
}): React.JSX.Element {
  const success = toast.variant === 'success'
  return (
    <div
      role="alert"
      data-testid="panel-toast"
      data-variant={success ? 'success' : 'error'}
      className={success
        ? 'fixed bottom-3 right-3 z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-emerald-500/40 bg-card px-3 py-2 text-foreground shadow-xl'
        : 'fixed bottom-3 right-3 z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-red-500/40 bg-card px-3 py-2 text-foreground shadow-xl'}
    >
      <div className="flex items-start gap-2">
        {success ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div
            className={success
              ? 'text-xs font-semibold text-emerald-600 dark:text-emerald-400'
              : 'text-xs font-semibold text-red-600 dark:text-red-400'}
            data-testid="panel-toast-code"
          >
            {toast.code}
          </div>
          <div className="mt-0.5 break-words text-[11px] leading-relaxed text-muted-foreground">
            {toast.message}
          </div>
        </div>
        <button
          type="button"
          aria-label="关闭错误提示"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
