/**
 * Double-clicking 未分组 opens this dialog: name a new scenario and move every
 * currently ungrouped recording of the category into it (one atomic index write).
 */
import * as React from 'react'
import { Layers3 } from 'lucide-react'

import { cn } from '../lib/utils.js'
import { buttonVariants } from './ui/button.js'

export interface CreateScenarioDialogProps {
  readonly categoryId: string
  readonly categoryName: string
  /** Number of ungrouped recordings that will be collected. */
  readonly count: number
  readonly saving: boolean
  readonly onConfirm: (name: string) => Promise<boolean>
  readonly onCancel: () => void
}

export function CreateScenarioDialog({
  categoryId,
  categoryName,
  count,
  saving,
  onConfirm,
  onCancel,
}: CreateScenarioDialogProps): React.JSX.Element {
  const [draft, setDraft] = React.useState('')
  const trimmed = draft.trim()

  const submit = async (): Promise<void> => {
    if (saving || trimmed.length === 0) return
    await onConfirm(trimmed)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="create-scenario-dialog"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`create-scenario-title-${categoryId}`}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-4 text-foreground shadow-xl"
      >
        <div className="flex items-center gap-2">
          <Layers3 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <h2 id={`create-scenario-title-${categoryId}`} className="text-sm font-semibold">
            新建场景并收纳当前 {count} 条录制
          </h2>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          在「{categoryName}」下创建场景，当前未分组的 {count} 条录制会全部归入新场景。
        </p>

        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted-foreground">场景名称</span>
            <input
              type="text"
              autoFocus
              value={draft}
              maxLength={80}
              disabled={saving}
              placeholder="例如：登录流程"
              aria-label="新场景名称"
              data-testid="create-scenario-input"
              onChange={(event) => setDraft(event.target.value)}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
            />
          </label>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={onCancel}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 px-3 text-xs')}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving || trimmed.length === 0}
              data-testid="create-scenario-confirm"
              className={cn(buttonVariants({ size: 'sm' }), 'h-8 px-3 text-xs')}
            >
              {saving ? '创建中…' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
