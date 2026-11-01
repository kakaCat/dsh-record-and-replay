/**
 * Narrow (DSH right sidebar) layout: the category/scenario list stays on top
 * and the selected Recording expands *below* it in its own scroll pane.
 *
 * Why not "detail replaces the main area": the sidebar is only ~400px wide, so
 * a full-surface detail hides the tree the user needs to switch recordings.
 * The pane here never unmounts the list: selecting another row while the
 * detail is open only swaps the pane body, and closing the detail gives the
 * full remaining height back to the list.
 *
 * The divider is draggable (pointer) and adjustable from the keyboard
 * (ArrowUp/ArrowDown/Home/End, double-click resets to 50%). The height is
 * clamped so neither side can collapse the other.
 */
import * as React from 'react'
import { ChevronDown } from 'lucide-react'

import { isEditableTarget } from '../lib/keyboard.js'
import { cn } from '../lib/utils.js'

/** Default detail height, as a percentage of the list+detail split. */
export const DETAIL_PERCENT_DEFAULT = 50
/** Keep at least this much of the split for the detail. */
export const DETAIL_PERCENT_MIN = 30
/** Keep at least this much of the split for the list. */
export const DETAIL_PERCENT_MAX = 70
/** Arrow-key step in percentage points. */
const DETAIL_PERCENT_STEP = 5
/** The list never gets shorter than this when the detail is open. */
const LIST_MIN_PX = 96

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return DETAIL_PERCENT_DEFAULT
  return Math.min(DETAIL_PERCENT_MAX, Math.max(DETAIL_PERCENT_MIN, Math.round(value)))
}

export interface SidebarLayoutProps {
  /** Always-mounted top pane (project chrome outside, tree inside). */
  readonly list: React.ReactNode
  /**
   * Bottom pane body. `undefined` hides the pane and gives the full height to
   * the list (the empty-selection and collapsed states).
   */
  readonly detail?: React.ReactNode | undefined
  /** Slim bar under the list (e.g. "detail collapsed, expand"). */
  readonly footer?: React.ReactNode | undefined
  /** Recording title shown in the pane's own bar (context while the content scrolls). */
  readonly detailTitle?: string | undefined
  /** Close/collapse the detail pane; the selection is kept by the caller. */
  readonly onCloseDetail: () => void
  /** Initial detail height percentage (tests pin it; defaults to 50). */
  readonly initialPercent?: number
}

export function SidebarLayout({
  list,
  detail,
  footer,
  detailTitle,
  onCloseDetail,
  initialPercent = DETAIL_PERCENT_DEFAULT,
}: SidebarLayoutProps): React.JSX.Element {
  const [percent, setPercent] = React.useState(() => clampPercent(initialPercent))
  const [dragging, setDragging] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const detailOpen = detail !== undefined && detail !== null

  // Escape closes the detail first and leaves the tree mounted, so the user
  // does not lose their place. A rename input or a modal confirm owns Escape.
  React.useEffect(() => {
    if (!detailOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (event.altKey || event.ctrlKey || event.metaKey) return
      // A rename input, a search box or an open modal owns Escape while it is
      // active. The tree's own Escape (blur the row) is allowed to bubble
      // through: closing the detail is the first stop, not a keyboard dead end.
      if (isEditableTarget(event.target)) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return
      event.preventDefault()
      onCloseDetail()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [detailOpen, onCloseDetail])

  const resizeFromClientY = (clientY: number): void => {
    const container = containerRef.current
    if (container === null) return
    const rect = container.getBoundingClientRect()
    // jsdom has no layout; a real drag always has a positive height.
    if (rect.height <= 0) return
    setPercent(clampPercent(((rect.bottom - clientY) / rect.height) * 100))
  }

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="sidebar-split"
      data-detail-open={detailOpen ? 'true' : 'false'}
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="sidebar-split-list">
        {list}
      </div>

      {detailOpen ? (
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整详情高度"
            aria-controls="detail-pane"
            aria-valuemin={DETAIL_PERCENT_MIN}
            aria-valuemax={DETAIL_PERCENT_MAX}
            aria-valuenow={percent}
            tabIndex={0}
            data-testid="detail-splitter"
            data-dragging={dragging ? 'true' : 'false'}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              event.currentTarget.setPointerCapture?.(event.pointerId)
              setDragging(true)
            }}
            onPointerMove={(event) => {
              if (!dragging) return
              resizeFromClientY(event.clientY)
            }}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture?.(event.pointerId)
              setDragging(false)
            }}
            onPointerCancel={() => setDragging(false)}
            onDoubleClick={() => setPercent(DETAIL_PERCENT_DEFAULT)}
            onKeyDown={(event) => {
              if (event.key === 'Home') {
                event.preventDefault()
                setPercent(DETAIL_PERCENT_MIN)
                return
              }
              if (event.key === 'End') {
                event.preventDefault()
                setPercent(DETAIL_PERCENT_MAX)
                return
              }
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              const delta = event.key === 'ArrowUp' ? DETAIL_PERCENT_STEP : -DETAIL_PERCENT_STEP
              setPercent((current) => clampPercent(current + delta))
            }}
            className={cn(
              'group relative flex h-2.5 shrink-0 touch-none cursor-row-resize items-center justify-center bg-background outline-none',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute left-1/2 top-1/2 h-0.5 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border transition-colors',
                'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                dragging && 'bg-primary/60 opacity-100',
              )}
            />
          </div>

          <section
            id="detail-pane"
            aria-label="录制详情"
            data-testid="detail-pane"
            data-percent={percent}
            className="flex min-h-0 min-w-0 shrink-0 flex-col border-t border-border bg-background"
            style={{
              flexBasis: `${String(percent)}%`,
              flexGrow: 0,
              flexShrink: 0,
              maxHeight: `calc(100% - ${String(LIST_MIN_PX)}px)`,
            }}
          >
            <div
              className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-card/60 px-3"
              data-testid="detail-pane-bar"
            >
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                详情
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/80"
                title={detailTitle}
                data-testid="detail-pane-title"
              >
                {detailTitle ?? ''}
              </span>
              <button
                type="button"
                data-testid="detail-close"
                aria-label="收起详情"
                title="收起详情（Esc）"
                onClick={onCloseDetail}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div
              className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
              data-testid="detail-pane-scroll"
            >
              {detail}
            </div>
          </section>
        </>
      ) : null}

      {footer}
    </div>
  )
}
