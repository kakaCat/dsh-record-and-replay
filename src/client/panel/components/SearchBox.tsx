import type * as React from 'react'
import { Search, X } from 'lucide-react'

import { Input } from './ui/input.js'

export interface SearchBoxProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly resultCount?: number | undefined
  readonly searching?: boolean | undefined
  readonly placeholder?: string | undefined
}

export function SearchBox({
  value,
  onChange,
  resultCount,
  searching = false,
  placeholder = '搜索标题、recordingId、用例意图、Run 状态…',
}: SearchBoxProps): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label="搜索录制"
          className="pl-9 pr-9"
        />
        {value.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="清空搜索"
            className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {value.length > 0 ? (
        <span className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
          {searching ? '搜索中…' : `${String(resultCount ?? 0)} 条匹配`}
        </span>
      ) : null}
    </div>
  )
}
