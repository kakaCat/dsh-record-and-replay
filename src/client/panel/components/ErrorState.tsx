import { AlertCircle, RefreshCw } from 'lucide-react'

import { Button } from './ui/button.js'

export interface ErrorStateProps {
  readonly title?: string
  readonly message: string
  readonly onRetry?: () => void
}

export function ErrorState({ title = '加载失败', message, onRetry }: ErrorStateProps): React.JSX.Element {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 px-8 py-12 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-xl border border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="max-w-md">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{message}</p>
      </div>
      {onRetry === undefined ? null : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          重试
        </Button>
      )}
    </div>
  )
}
