/**
 * Inline rename input used by the tree (double-click → edit).
 *
 * Enter saves, Escape cancels, blur saves. Saving is disabled while a commit
 * is in flight so a double Enter / blur cannot submit twice; a failed commit
 * keeps the editor open (the shell shows a toast with the error code).
 */
import * as React from 'react'

import { cn } from '../lib/utils.js'

export interface EditableLabelProps {
  readonly value: string
  readonly ariaLabel: string
  readonly onCommit: (value: string) => Promise<boolean>
  readonly onCancel: () => void
  readonly saving?: boolean
  readonly maxLength?: number
  readonly testId?: string
  readonly className?: string
}

export function EditableLabel({
  value,
  ariaLabel,
  onCommit,
  onCancel,
  saving = false,
  maxLength = 80,
  testId,
  className,
}: EditableLabelProps): React.JSX.Element {
  const [draft, setDraft] = React.useState(value)
  const [busy, setBusy] = React.useState(false)
  const finishedRef = React.useRef(false)
  const busyRef = React.useRef(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const input = inputRef.current
    if (input === null) return
    input.focus()
    input.select()
  }, [])

  const finish = async (commit: boolean): Promise<void> => {
    if (finishedRef.current || busyRef.current) return
    if (!commit) {
      finishedRef.current = true
      onCancel()
      return
    }
    const next = draft.trim()
    if (next.length === 0) {
      // Empty input is a cancel, not a write: the host would reject it anyway.
      finishedRef.current = true
      onCancel()
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      const saved = await onCommit(next)
      if (saved) {
        finishedRef.current = true
        onCancel()
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const disabled = saving || busy

  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      aria-label={ariaLabel}
      data-testid={testId}
      maxLength={maxLength}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={() => {
        void finish(true)
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          void finish(true)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          void finish(false)
        }
      }}
      className={cn(
        'h-7 w-full min-w-0 rounded-md border border-input bg-background px-1.5 text-[13px] text-foreground outline-none',
        'focus:ring-1 focus:ring-ring disabled:opacity-60',
        className,
      )}
    />
  )
}
