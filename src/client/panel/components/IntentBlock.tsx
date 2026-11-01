/**
 * Intent text shown in the recording overview.
 *
 * With an intent: the original text, its provenance badge, and an
 * expand/collapse control for long text.
 *
 * Without an intent: only an explicit "未填写用例" prompt. The old version fell
 * back to the recording title, which repeated the detail header verbatim and
 * made the overview look untrustworthy.
 */
import * as React from 'react'
import { ChevronDown, ChevronUp, FileText } from 'lucide-react'

import type { PanelRecordingSummary } from '../../../panel/types.js'
import { needsIntentToggle, resolveIntent } from '../lib/intent.js'
import { cn } from '../lib/utils.js'

export interface IntentBlockProps {
  readonly recording: PanelRecordingSummary
  readonly testId?: string
}

function SourceBadge({ source }: { readonly source: 'manifest' | 'index' }): React.JSX.Element {
  if (source === 'index') {
    return (
      <span className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
        index 补注
      </span>
    )
  }
  return <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">录制原文</span>
}

function MissingIntent({ testId }: { readonly testId: string | undefined }): React.JSX.Element {
  return (
    <div
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      role="note"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed border-border bg-card/50 px-3 py-2.5"
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        未填写用例
      </span>
      <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground/80">
        录制时传入 intent，或在 index.json 的 assignments 中补注
      </span>
    </div>
  )
}

export function IntentBlock({ recording, testId }: IntentBlockProps): React.JSX.Element {
  const resolved = resolveIntent(recording)
  const [expanded, setExpanded] = React.useState(false)

  React.useEffect(() => {
    setExpanded(false)
  }, [recording.recordingId, recording.intent])

  if (resolved.missing) return <MissingIntent testId={testId} />

  const toggleable = needsIntentToggle(resolved.text)
  const clamped = toggleable && !expanded

  return (
    <section
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      aria-label="用例意图"
      className="rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">用例意图</span>
        {resolved.source === undefined ? null : <SourceBadge source={resolved.source} />}
        {toggleable ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {expanded ? '收起' : '展开全文'}
            {expanded ? (
              <ChevronUp className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>
      <p
        className={cn(
          'mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90',
          clamped && 'line-clamp-3',
        )}
      >
        {resolved.text}
      </p>
    </section>
  )
}
