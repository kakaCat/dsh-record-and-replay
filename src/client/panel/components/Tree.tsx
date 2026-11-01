import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronRight,
  Clapperboard,
  Folder,
  FolderOpen,
  FolderX,
  FileText,
  Layers3,
  Pencil,
  Plus,
  RotateCcw,
  SearchX,
  Trash2,
  Video,
} from 'lucide-react'

import type {
  PanelIndexCategory,
  PanelProject,
  PanelRecordingSummary,
  PanelSearchResult,
} from '../../../panel/types.js'
import { blurActiveElement, handleListKeyDown, isEditableTarget, TREE_ROW_KEY_ATTRIBUTE } from '../lib/keyboard.js'
import { cn, formatDate } from '../lib/utils.js'
import type { PanelWrites } from '../write-actions.js'
import { usePanelStore } from '../store.js'
import { ConfirmDialog } from './ConfirmDialog.js'
import { CreateScenarioDialog } from './CreateScenarioDialog.js'
import { EditableLabel } from './EditableLabel.js'
import { EmptyState } from './EmptyState.js'
import { StatusBadge } from './StatusBadge.js'

/** Visible focus treatment shared by every navigable tree row. */
const ROW_FOCUS_CLASS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background'

type TreeDepth = 0 | 1 | 2

/**
 * Fixed leading columns shared by every row:
 *
 *     [indent] [chevron 16px] [8px] [icon 16px] [8px] [text]
 *
 * Indentation grows by exactly one 16px column per depth (8 → 24 → 40), so the
 * three label columns land at 56 / 72 / 88px: strictly increasing, and a
 * recording title can never start to the left of its scenario label.
 */
export const TREE_LAYOUT = {
  /** Left gutter in front of the first column. */
  baseIndent: 8,
  /** Each depth shifts the row right by this much. */
  levelStep: 16,
  chevronWidth: 16,
  iconWidth: 16,
  /** Gap between chevron/icon/text columns. */
  gap: 8,
} as const

/** x of the row's own content box (before the chevron slot). */
function indentPx(depth: TreeDepth): number {
  return TREE_LAYOUT.baseIndent + depth * TREE_LAYOUT.levelStep
}

/** x where a row's label starts; identical for the recording's second line. */
function textColumnPx(depth: TreeDepth): number {
  return indentPx(depth)
    + TREE_LAYOUT.chevronWidth
    + TREE_LAYOUT.gap
    + TREE_LAYOUT.iconWidth
    + TREE_LAYOUT.gap
}

/** x of an ancestor level's icon centre — where its vertical guide hangs. */
function railPx(level: 0 | 1): number {
  return indentPx(level)
    + TREE_LAYOUT.chevronWidth
    + TREE_LAYOUT.gap
    + TREE_LAYOUT.iconWidth / 2
}

/** Vertical guide x-offsets, aligned under the parent level's icon centre. */
const RAIL_X: Readonly<Record<0 | 1, number>> = { 0: railPx(0), 1: railPx(1) }
/** Short elbow that connects a guide to the row's own icon. */
const RAIL_STUB_PX = TREE_LAYOUT.gap

export type TreeRow =
  | {
    readonly kind: 'category'
    readonly key: string
    readonly depth: 0
    readonly category: PanelIndexCategory
    readonly count: number
  }
  | {
    readonly kind: 'scenario'
    readonly key: string
    readonly depth: 1
    readonly categoryId: string
    readonly categoryName: string
    readonly scenarioId: string | undefined
    readonly name: string
    readonly count: number
  }
  | {
    readonly kind: 'recording'
    readonly key: string
    readonly depth: 2
    readonly recording: PanelRecordingSummary
  }

/** The one row whose label is currently an input. */
export type TreeEditTarget =
  | { readonly kind: 'category'; readonly id: string; readonly name: string }
  | { readonly kind: 'scenario'; readonly id: string; readonly name: string }
  | { readonly kind: 'recording'; readonly id: string; readonly name: string }

export interface CreateScenarioRequest {
  readonly categoryId: string
  readonly categoryName: string
  readonly count: number
}

/** Row-level replay/trash bridge, wired by the DSH mount only. */
export interface TreeRecordingActions {
  readonly canReplay: boolean
  readonly canTrash: boolean
  readonly replayHint?: string | undefined
  /** Action keys currently in flight (`replay:<id>`, `trash:<id>`). */
  readonly pending: ReadonlySet<string>
  replay(recordingId: string): Promise<boolean>
  trash(recordingId: string): Promise<boolean>
}

export interface BuildTreeRowsOptions {
  readonly visibleRecordingIds?: ReadonlySet<string>
  readonly isExpanded?: (key: string) => boolean
}

/**
 * Flatten categories → scenarios (+ 未分组) → recordings into one row list.
 *
 * Empty categories stay in the tree while browsing (a user-created category
 * must not vanish before it has a recording); when a server-side search is
 * active only branches that contain a match are kept.
 */
export function buildTreeRows(project: PanelProject, options: BuildTreeRowsOptions = {}): TreeRow[] {
  const isExpanded = options.isExpanded ?? (() => true)
  const filtering = options.visibleRecordingIds !== undefined
  const recordings = options.visibleRecordingIds === undefined
    ? project.recordings
    : project.recordings.filter((recording) => options.visibleRecordingIds?.has(recording.recordingId) === true)

  const rows: TreeRow[] = []
  const categories = [...project.categories].sort((left, right) => left.name.localeCompare(right.name))

  for (const category of categories) {
    const categoryRecordings = recordings.filter((recording) => recording.categoryId === category.id)
    // Search results only show the branches that actually matched.
    if (filtering && categoryRecordings.length === 0) continue
    const categoryKey = `category:${category.id}`
    rows.push({
      kind: 'category',
      key: categoryKey,
      depth: 0,
      category,
      count: categoryRecordings.length,
    })
    if (!isExpanded(categoryKey)) continue

    const scenarios = project.scenarios
      .filter((scenario) => scenario.categoryId === category.id)
      .sort((left, right) => left.name.localeCompare(right.name))

    const assigned = new Set<string>()
    for (const scenario of scenarios) {
      const scenarioRecordings = categoryRecordings.filter((recording) => recording.scenarioId === scenario.id)
      // Keep declared but still-empty scenarios when browsing so the
      // category structure does not change shape after a trash action.
      if (filtering && scenarioRecordings.length === 0) continue
      assigned.add(scenario.id)
      const scenarioKey = `scenario:${category.id}:${scenario.id}`
      rows.push({
        kind: 'scenario',
        key: scenarioKey,
        depth: 1,
        categoryId: category.id,
        categoryName: category.name,
        scenarioId: scenario.id,
        name: scenario.name,
        count: scenarioRecordings.length,
      })
      if (!isExpanded(scenarioKey)) continue
      for (const recording of scenarioRecordings) {
        rows.push({ kind: 'recording', key: `recording:${recording.recordingId}`, depth: 2, recording })
      }
    }

    const ungrouped = categoryRecordings.filter(
      (recording) => recording.scenarioId === undefined || !assigned.has(recording.scenarioId),
    )
    if (ungrouped.length > 0) {
      const scenarioKey = `scenario:${category.id}:ungrouped`
      rows.push({
        kind: 'scenario',
        key: scenarioKey,
        depth: 1,
        categoryId: category.id,
        categoryName: category.name,
        scenarioId: undefined,
        name: '未分组',
        count: ungrouped.length,
      })
      if (!isExpanded(scenarioKey)) continue
      for (const recording of ungrouped) {
        rows.push({ kind: 'recording', key: `recording:${recording.recordingId}`, depth: 2, recording })
      }
    }
  }

  return rows
}

function rowHeight(row: TreeRow): number {
  switch (row.kind) {
    case 'category':
      return 40
    case 'scenario':
      return 36
    case 'recording':
      return 60
  }
}

function pendingKeyFor(row: TreeRow): string | undefined {
  switch (row.kind) {
    case 'category':
      return `category:${row.category.id}`
    case 'scenario':
      return row.scenarioId === undefined ? undefined : `scenario:${row.scenarioId}`
    case 'recording':
      return `recording:${row.recording.recordingId}`
  }
}

// ---------------------------------------------------------------------------
// Row scaffolding: fixed leading columns, indentation rails, hover action strip
// ---------------------------------------------------------------------------

/** Rotating disclosure chevron inside the fixed 16px chevron column. */
function ChevronSlot({ expanded }: { readonly expanded: boolean }): React.JSX.Element {
  return (
    <span
      data-tree-chevron=""
      style={{ width: TREE_LAYOUT.chevronWidth, height: TREE_LAYOUT.chevronWidth }}
      className="flex shrink-0 items-center justify-center"
    >
      <ChevronRight
        className={cn(
          'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
          expanded && 'rotate-90',
        )}
        aria-hidden="true"
      />
    </span>
  )
}

/**
 * Leaf rows keep the chevron column as empty space rather than omitting it, so
 * the leaf icon and title stay in the depth-3 columns instead of sliding left
 * underneath the scenario label.
 */
function LeafChevronSlot(): React.JSX.Element {
  return (
    <span
      data-tree-chevron=""
      data-tree-chevron-placeholder=""
      aria-hidden="true"
      style={{ width: TREE_LAYOUT.chevronWidth, height: TREE_LAYOUT.chevronWidth }}
      className="shrink-0"
    />
  )
}

/** 16px icon column shared by folders, scenario collections and leaves. */
function IconSlot({
  leaf = false,
  children,
}: {
  readonly leaf?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      data-tree-icon=""
      {...(leaf ? { 'data-tree-leaf': '' } : {})}
      style={{ width: TREE_LAYOUT.iconWidth, height: TREE_LAYOUT.iconWidth }}
      className="flex shrink-0 items-center justify-center"
    >
      {children}
    </span>
  )
}

/**
 * Marks the depth-specific label column. The x is produced by the fixed leading
 * slots; the data attributes document it for component tests and the design doc
 * (jsdom has no layout engine to measure the real offset).
 */
function textColumnAttributes(depth: TreeDepth): {
  readonly 'data-tree-text': string
  readonly 'data-tree-column-x': number
} {
  return { 'data-tree-text': '', 'data-tree-column-x': textColumnPx(depth) }
}

/** Thin vertical guide + elbow connecting a child row to its parent level. */
function TreeRails({ depth }: { readonly depth: 1 | 2 }): React.JSX.Element {
  const levels: (0 | 1)[] = depth === 2 ? [0, 1] : [0]
  return (
    <>
      {levels.map((level) => (
        <span
          key={`rail-${String(level)}`}
          aria-hidden="true"
          data-tree-rail={level}
          className="pointer-events-none absolute z-10 w-px bg-border"
          style={{ left: RAIL_X[level], top: -2, bottom: -2 }}
        />
      ))}
      <span
        aria-hidden="true"
        data-tree-rail-stub={depth}
        className="pointer-events-none absolute top-1/2 z-10 h-px bg-border"
        style={{ left: RAIL_X[(depth - 1) as 0 | 1], width: RAIL_STUB_PX }}
      />
    </>
  )
}

type RowActionsRenderer = (visible: boolean) => React.ReactNode

interface RowShellProps {
  readonly depth: TreeDepth
  /** Hover/focus-only action strip; receives its own visibility. */
  readonly actions?: RowActionsRenderer | undefined
  readonly actionsTestId?: string | undefined
  readonly children: React.ReactNode
}

/**
 * One tree row: the interactive row element plus the indentation rails and a
 * hover-only action strip. Rails are painted per row (not as one global line),
 * so they collapse together with their subtree.
 */
function RowShell({ depth, actions, actionsTestId, children }: RowShellProps): React.JSX.Element {
  const [hovered, setHovered] = React.useState(false)
  const [focusWithin, setFocusWithin] = React.useState(false)
  const visible = hovered || focusWithin

  return (
    <div
      className="group relative flex h-full w-full min-w-0"
      data-row-shell=""
      data-depth={depth}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocusWithin(false)
      }}
    >
      {children}
      {depth === 0 ? null : <TreeRails depth={depth} />}
      {actions === undefined || actionsTestId === undefined ? null : (
        <div
          data-testid={actionsTestId}
          data-visible={visible ? 'true' : 'false'}
          className={cn(
            'absolute right-1 top-1/2 z-20 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-border/70 bg-card/95 p-0.5 shadow-sm transition-opacity duration-150',
            visible ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          {actions(visible)}
        </div>
      )}
    </div>
  )
}

function RowActionButton({
  label,
  hint,
  testId,
  visible,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string
  /** Extra explanation used as the tooltip (e.g. why the action is disabled). */
  readonly hint?: string | undefined
  readonly testId: string
  readonly visible: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={hint ?? label}
      aria-hidden={visible ? undefined : true}
      data-testid={testId}
      data-row-action=""
      disabled={disabled}
      // Invisible actions must not become hidden tab stops; the focused row
      // reveals the strip first, so a following Tab can still reach them.
      tabIndex={visible ? 0 : -1}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

const HOVER_FADE_CLASS = 'transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0'

/** Fixed-width right-aligned count: numbers never shift the row layout. */
function CountBadge({
  count,
  testId,
  fadeOnHover = false,
}: {
  readonly count: number
  readonly testId: string
  readonly fadeOnHover?: boolean
}): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      className={cn(
        'w-8 shrink-0 text-right text-[11px] font-medium tabular-nums text-muted-foreground',
        fadeOnHover && HOVER_FADE_CLASS,
      )}
    >
      {count}
    </span>
  )
}

function CategoryRow({
  row,
  expanded,
  onToggle,
  editing,
  saving,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  readonly row: Extract<TreeRow, { kind: 'category' }>
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly editing: boolean
  readonly saving: boolean
  readonly onStartEdit: (() => void) | undefined
  readonly onCommit: (value: string) => Promise<boolean>
  readonly onCancel: () => void
}): React.JSX.Element {
  const Icon = expanded ? FolderOpen : Folder
  const actions: RowActionsRenderer | undefined = onStartEdit === undefined
    ? undefined
    : (visible) => (
      <RowActionButton
        label={`重命名分类 ${row.category.name}`}
        testId={`rename-category-${row.category.id}`}
        visible={visible}
        onClick={onStartEdit}
      >
        <Pencil className="h-3 w-3" aria-hidden="true" />
      </RowActionButton>
    )

  if (editing) {
    return (
      <RowShell depth={0}>
        <div
          className="relative flex h-full w-full min-w-0 items-center gap-2 rounded-lg pr-2"
          style={{ paddingLeft: indentPx(0) }}
        >
          <ChevronSlot expanded />
          <IconSlot>
            <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
          </IconSlot>
          <EditableLabel
            value={row.category.name}
            ariaLabel={`分类名称 ${row.category.name}`}
            testId={`edit-category-${row.category.id}`}
            saving={saving}
            onCommit={onCommit}
            onCancel={onCancel}
            className="min-w-0 flex-1"
          />
          <CountBadge count={row.count} testId={`category-count-${row.category.id}`} />
        </div>
      </RowShell>
    )
  }

  return (
    <RowShell depth={0} actionsTestId={`row-actions-category-${row.category.id}`} {...(actions === undefined ? {} : { actions })}>
      <button
        type="button"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={expanded}
        data-depth={row.depth}
        onClick={(event) => {
          // The first click of a double-click must not leave the category collapsed.
          if (event.detail > 1) return
          onToggle()
        }}
        onDoubleClick={onStartEdit}
        title={onStartEdit === undefined ? '展开/收起分类' : '展开/收起分类；双击或 F2 重命名'}
        data-keyboard-row=""
        data-row-kind="category"
        data-testid={`category-row-${row.category.id}`}
        style={{ paddingLeft: indentPx(row.depth) }}
        className={cn(
          'relative flex h-full w-full min-w-0 items-center gap-2 rounded-lg pr-2 text-left text-[14px] font-semibold tracking-tight text-foreground transition-colors hover:bg-accent/70',
          ROW_FOCUS_CLASS,
        )}
      >
        <ChevronSlot expanded={expanded} />
        <IconSlot>
          <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
        </IconSlot>
        <span
          {...textColumnAttributes(row.depth)}
          title={row.category.name}
          className="min-w-0 flex-1 truncate"
        >
          {row.category.name}
        </span>
        <CountBadge
          count={row.count}
          testId={`category-count-${row.category.id}`}
          fadeOnHover={actions !== undefined}
        />
      </button>
    </RowShell>
  )
}

function ScenarioRow({
  row,
  expanded,
  onToggle,
  editing,
  saving,
  onStartEdit,
  onCreateScenario,
  onCommit,
  onCancel,
}: {
  readonly row: Extract<TreeRow, { kind: 'scenario' }>
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly editing: boolean
  readonly saving: boolean
  readonly onStartEdit: (() => void) | undefined
  readonly onCreateScenario: (() => void) | undefined
  readonly onCommit: (value: string) => Promise<boolean>
  readonly onCancel: () => void
}): React.JSX.Element {
  const ungrouped = row.scenarioId === undefined
  const actions: RowActionsRenderer | undefined = ungrouped
    ? onCreateScenario === undefined
      ? undefined
      : (visible) => (
        <RowActionButton
          label={`新建场景并收纳 ${String(row.count)} 条未分组录制`}
          testId={`create-scenario-ungrouped-${row.categoryId}`}
          visible={visible}
          onClick={onCreateScenario}
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
        </RowActionButton>
      )
    : onStartEdit === undefined
      ? undefined
      : (visible) => (
        <RowActionButton
          label={`重命名场景 ${row.name}`}
          testId={`rename-scenario-${row.scenarioId ?? 'ungrouped'}`}
          visible={visible}
          onClick={onStartEdit}
        >
          <Pencil className="h-3 w-3" aria-hidden="true" />
        </RowActionButton>
      )

  if (editing) {
    return (
      <RowShell depth={1}>
        <div
          className="relative flex h-full w-full min-w-0 items-center gap-2 rounded-lg pr-2"
          style={{ paddingLeft: indentPx(1) }}
        >
          <ChevronSlot expanded />
          <IconSlot>
            <Layers3 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </IconSlot>
          <EditableLabel
            value={row.name}
            ariaLabel={`场景名称 ${row.name}`}
            testId={`edit-scenario-${row.scenarioId ?? 'ungrouped'}`}
            saving={saving}
            onCommit={onCommit}
            onCancel={onCancel}
            className="min-w-0 flex-1"
          />
          <CountBadge
            count={row.count}
            testId={ungrouped ? `ungrouped-count-${row.categoryId}` : `scenario-count-${row.scenarioId ?? ''}`}
          />
        </div>
      </RowShell>
    )
  }

  const doubleClick = ungrouped ? onCreateScenario : onStartEdit
  return (
    <RowShell
      depth={1}
      actionsTestId={ungrouped ? `row-actions-ungrouped-${row.categoryId}` : `row-actions-scenario-${row.scenarioId ?? ''}`}
      {...(actions === undefined ? {} : { actions })}
    >
      <button
        type="button"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={expanded}
        data-depth={row.depth}
        data-virtual-group={ungrouped ? 'true' : undefined}
        onClick={(event) => {
          if (event.detail > 1) return
          onToggle()
        }}
        onDoubleClick={doubleClick}
        title={doubleClick === undefined
          ? '展开/收起'
          : ungrouped ? '展开/收起；双击或 F2 新建场景并收纳未分组录制' : '展开/收起；双击或 F2 重命名场景'}
        data-keyboard-row=""
        data-row-kind="scenario"
        data-testid={ungrouped ? `ungrouped-row-${row.categoryId}` : `scenario-row-${row.scenarioId ?? ''}`}
        style={{ paddingLeft: indentPx(row.depth) }}
        className={cn(
          'relative flex h-full w-full min-w-0 items-center gap-2 rounded-lg pr-2 text-left text-[13px] font-medium transition-colors',
          ROW_FOCUS_CLASS,
          // Outline instead of a border: the dashed edge must not consume the
          // 1px that would shift this row's icon off the parent rail.
          ungrouped
            ? 'bg-muted/25 text-muted-foreground outline outline-1 outline-offset-[-1px] outline-dashed outline-border hover:bg-accent/40 hover:text-foreground hover:outline-muted-foreground/40'
            : 'text-foreground/80 hover:bg-accent/60 hover:text-foreground',
        )}
      >
        <ChevronSlot expanded={expanded} />
        <IconSlot>
          <Layers3 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </IconSlot>
        <span
          {...textColumnAttributes(row.depth)}
          title={row.name}
          className={cn('min-w-0 flex-1 truncate', ungrouped && 'font-normal italic')}
        >
          {row.name}
        </span>
        <CountBadge
          count={row.count}
          testId={ungrouped ? `ungrouped-count-${row.categoryId}` : `scenario-count-${row.scenarioId ?? ''}`}
          fadeOnHover={actions !== undefined}
        />
      </button>
    </RowShell>
  )
}

function RecordingRow({
  recording,
  selected,
  matchedByRun,
  onSelect,
  editing,
  saving,
  onStartEdit,
  onCommit,
  onCancel,
  recordingActions,
  onRequestReplay,
  onRequestTrash,
}: {
  readonly recording: PanelRecordingSummary
  readonly selected: boolean
  readonly matchedByRun: boolean
  readonly onSelect: () => void
  readonly editing: boolean
  readonly saving: boolean
  readonly onStartEdit: (() => void) | undefined
  readonly onCommit: (value: string) => Promise<boolean>
  readonly onCancel: () => void
  readonly recordingActions: TreeRecordingActions | undefined
  readonly onRequestReplay: (recording: PanelRecordingSummary) => void
  readonly onRequestTrash: (recording: PanelRecordingSummary) => void
}): React.JSX.Element {
  const replayPending = recordingActions?.pending.has(`replay:${recording.recordingId}`) === true
  const trashPending = recordingActions?.pending.has(`trash:${recording.recordingId}`) === true
  const replayDisabled = recordingActions === undefined
    || !recordingActions.canReplay
    || recording.status !== 'completed'
    || replayPending
  const replayLabel = recording.status !== 'completed'
    ? '只有已完成的录制可以重跑'
    : recordingActions !== undefined && !recordingActions.canReplay
      ? recordingActions.replayHint ?? '当前面板进程没有回放服务'
      : replayPending ? '正在重跑…' : `重跑 ${recording.title}`

  const actions: RowActionsRenderer | undefined = onStartEdit === undefined && recordingActions === undefined
    ? undefined
    : (visible) => (
      <>
        {onStartEdit === undefined ? null : (
          <RowActionButton
            label={`重命名录制 ${recording.title}`}
            testId={`rename-row-${recording.recordingId}`}
            visible={visible}
            onClick={onStartEdit}
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
          </RowActionButton>
        )}
        {recordingActions === undefined ? null : (
          <RowActionButton
            label={`重跑 ${recording.title}`}
            hint={replayLabel}
            testId={`replay-row-${recording.recordingId}`}
            visible={visible}
            disabled={replayDisabled}
            onClick={() => onRequestReplay(recording)}
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
          </RowActionButton>
        )}
        {recordingActions === undefined || !recordingActions.canTrash ? null : (
          <RowActionButton
            label={`移到回收站 ${recording.title}`}
            testId={`trash-row-${recording.recordingId}`}
            visible={visible}
            disabled={trashPending || replayPending}
            onClick={() => onRequestTrash(recording)}
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
          </RowActionButton>
        )}
      </>
    )

  if (editing) {
    return (
      <RowShell depth={2}>
        <div
          className="relative flex h-full w-full min-w-0 items-center gap-2 rounded-lg bg-accent py-1.5 pr-2"
          style={{ paddingLeft: indentPx(2) }}
          data-testid={`recording-row-${recording.recordingId}`}
        >
          <LeafChevronSlot />
          <IconSlot leaf>
            <FileText className="h-4 w-4 text-muted-foreground/70" aria-hidden="true" />
          </IconSlot>
          <EditableLabel
            value={recording.title}
            ariaLabel={`录制标题 ${recording.title}`}
            testId={`edit-recording-${recording.recordingId}`}
            saving={saving}
            onCommit={onCommit}
            onCancel={onCancel}
            className="min-w-0 flex-1"
          />
        </div>
      </RowShell>
    )
  }

  return (
    <RowShell
      depth={2}
      actionsTestId={`row-actions-recording-${recording.recordingId}`}
      {...(actions === undefined ? {} : { actions })}
    >
      <button
        type="button"
        role="treeitem"
        aria-level={3}
        aria-current={selected ? 'true' : undefined}
        aria-selected={selected}
        data-depth={2}
        onClick={onSelect}
        onDoubleClick={onStartEdit}
        data-testid={`recording-row-${recording.recordingId}`}
        data-keyboard-row=""
        data-row-kind="recording"
        data-selected={selected ? 'true' : undefined}
        title={onStartEdit === undefined ? undefined : '双击或 F2 重命名录制标题（只写 index.json）'}
        style={{ paddingLeft: indentPx(2) }}
        className={cn(
          'relative flex h-full w-full min-w-0 items-center gap-2 rounded-lg py-1.5 pr-2 text-left transition-colors',
          ROW_FOCUS_CLASS,
          selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
        )}
      >
        {selected ? (
          <span
            aria-hidden="true"
            data-testid={`selected-bar-${recording.recordingId}`}
            className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary"
          />
        ) : null}
        <LeafChevronSlot />
        <IconSlot leaf>
          <FileText className="h-4 w-4 text-muted-foreground/70" aria-hidden="true" />
        </IconSlot>
        <span
          {...textColumnAttributes(2)}
          className="flex min-w-0 flex-1 flex-col justify-center gap-1"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              data-tree-title=""
              title={recording.title}
              className="min-w-0 flex-1 truncate text-[13px] font-normal"
            >
              {recording.title}
            </span>
            <span className={cn('flex shrink-0 items-center gap-2', actions !== undefined && HOVER_FADE_CLASS)}>
              {recording.titleSource === 'index' ? (
                <span
                  className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  title="标题来自 index.json 覆盖，manifest 未改动"
                >
                  index
                </span>
              ) : null}
              {recording.hasVideo ? <Video className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="有视频" /> : null}
              {recording.failedRunCount > 0 ? (
                <span
                  className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400"
                  title={`${String(recording.failedRunCount)} 个失败 Run`}
                >
                  {recording.failedRunCount} 失败
                </span>
              ) : null}
              {matchedByRun ? (
                <span className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
                  Run
                </span>
              ) : null}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="shrink-0 tabular-nums">{recording.stepCount} 步</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 tabular-nums">{recording.runCount} Run</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{formatDate(recording.updatedAt)}</span>
            <span
              className={cn(
                'ml-auto flex w-14 shrink-0 justify-end',
                actions !== undefined && HOVER_FADE_CLASS,
              )}
              data-testid={`recording-status-${recording.recordingId}`}
            >
              <StatusBadge status={recording.status} />
            </span>
          </span>
        </span>
      </button>
    </RowShell>
  )
}

export interface TreeProps {
  readonly project: PanelProject | undefined
  readonly selectedRecordingId: string | undefined
  readonly onSelect: (recordingId: string) => void
  readonly searchResult?: PanelSearchResult | undefined
  readonly loading?: boolean
  /** The selected root disappeared from disk; show that instead of "no project". */
  readonly projectMissing?: boolean
  /** Undefined = read-only view (standalone panel); no edit affordances. */
  readonly writes?: PanelWrites | undefined
  /** Undefined = no replay/trash service on this surface. */
  readonly recordingActions?: TreeRecordingActions | undefined
  /** M2 pagination: more recording pages available on the server. */
  readonly hasMore?: boolean
  readonly loadingMore?: boolean
  readonly onLoadMore?: (() => void) | undefined
  /** Total recordings in the project (may exceed the loaded pages). */
  readonly totalRecordings?: number | undefined
}

/** Left tree: category → scenario (未分组 when empty) → recording. */
export function Tree({
  project,
  selectedRecordingId,
  onSelect,
  searchResult,
  loading = false,
  projectMissing = false,
  writes,
  recordingActions,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  totalRecordings,
}: TreeProps): React.JSX.Element {
  const expanded = usePanelStore((state) => state.expanded)
  const toggleExpanded = usePanelStore((state) => state.toggleExpanded)
  const isExpanded = React.useCallback(
    (key: string) => expanded[key] ?? true,
    [expanded],
  )
  const [editTarget, setEditTarget] = React.useState<TreeEditTarget | undefined>(undefined)
  const [createRequest, setCreateRequest] = React.useState<CreateScenarioRequest | undefined>(undefined)
  const [confirmAction, setConfirmAction] = React.useState<
    { readonly kind: 'replay' | 'trash'; readonly recording: PanelRecordingSummary } | undefined
  >(undefined)

  // Drop an editor whose row disappeared after an external refresh.
  React.useEffect(() => {
    if (project === undefined || editTarget === undefined) return
    const exists = editTarget.kind === 'category'
      ? project.categories.some((category) => category.id === editTarget.id)
      : editTarget.kind === 'scenario'
        ? project.scenarios.some((scenario) => scenario.id === editTarget.id)
        : project.recordings.some((recording) => recording.recordingId === editTarget.id)
    if (!exists) setEditTarget(undefined)
  }, [project, editTarget])

  const visibleIds = React.useMemo(() => {
    if (searchResult === undefined) return undefined
    return new Set(searchResult.recordings.map((recording) => recording.recordingId))
  }, [searchResult])

  const rows = React.useMemo(
    () => (project === undefined ? [] : buildTreeRows(project, {
      ...(visibleIds === undefined ? {} : { visibleRecordingIds: visibleIds }),
      isExpanded,
    })),
    [project, visibleIds, isExpanded],
  )
  const rowsByKey = React.useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows])

  const useVirtualRows = rows.length > 80
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 10,
    enabled: useVirtualRows,
  })

  const searchActive = searchResult !== undefined

  const confirmBusy = confirmAction === undefined
    ? false
    : recordingActions?.pending.has(`${confirmAction.kind}:${confirmAction.recording.recordingId}`) === true

  const runConfirmedAction = async (): Promise<void> => {
    if (confirmAction === undefined || recordingActions === undefined) return
    const id = confirmAction.recording.recordingId
    const ok = confirmAction.kind === 'replay'
      ? await recordingActions.replay(id)
      : await recordingActions.trash(id)
    if (ok) setConfirmAction(undefined)
  }

  if (loading) {
    return (
      <div className="space-y-3 p-3" aria-hidden="true" data-testid="tree-skeleton">
        {Array.from({ length: 3 }).map((_, group) => (
          <div key={group} className="space-y-1.5">
            <div className="h-9 animate-pulse rounded-lg bg-muted" data-skeleton-depth="0" />
            <div className="ml-4 h-8 animate-pulse rounded-lg bg-muted/80" data-skeleton-depth="1" />
            <div className="ml-8 h-12 animate-pulse rounded-lg bg-muted/60" data-skeleton-depth="2" />
            <div className="ml-8 h-12 animate-pulse rounded-lg bg-muted/60" data-skeleton-depth="2" />
          </div>
        ))}
      </div>
    )
  }

  if (project === undefined) {
    return projectMissing ? (
      <EmptyState
        icon={FolderX}
        title="项目不存在"
        description="这个目录已被移动或删除；在顶部重新选择项目，或用「打开文件夹」重新添加。"
        compact
        testId="tree-project-missing"
      />
    ) : (
      <EmptyState
        icon={Folder}
        title="尚未选择项目"
        description="从顶部选择一个 DSH 工作区开始浏览录制。"
        compact
      />
    )
  }

  if (project.recordings.length === 0) {
    return (
      <EmptyState
        icon={Clapperboard}
        title="这个项目还没有录制"
        description="在会话中运行 /record-start 完成一次录制后，这里会出现分类、场景和回放。"
        compact
        testId="tree-empty"
      />
    )
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title={searchActive ? '没有匹配的录制' : '没有可显示的录制'}
        description={searchActive ? '试试标题片段、recordingId、用例意图或 Run 状态（completed / failed）。' : '检查项目的 .dsh/record-replay 数据。'}
        compact
        testId="tree-no-match"
      />
    )
  }

  const renderRow = (row: TreeRow): React.JSX.Element => {
    const editing = editTarget !== undefined && (
      (row.kind === 'category' && editTarget.kind === 'category' && editTarget.id === row.category.id)
      || (row.kind === 'scenario' && editTarget.kind === 'scenario' && editTarget.id === row.scenarioId)
      || (row.kind === 'recording' && editTarget.kind === 'recording' && editTarget.id === row.recording.recordingId)
    )
    const key = pendingKeyFor(row)
    return (
      <TreeRowView
        row={row}
        expanded={isExpanded(row.key)}
        onToggle={() => toggleExpanded(row.key)}
        selectedRecordingId={selectedRecordingId}
        onSelect={onSelect}
        searchResult={searchResult}
        writes={writes}
        recordingActions={recordingActions}
        editing={editing}
        saving={writes !== undefined && key !== undefined && writes.pending.has(key)}
        onStartEdit={setEditTarget}
        onCancelEdit={() => setEditTarget(undefined)}
        onCreateScenario={setCreateRequest}
        onRequestReplay={(recording) => setConfirmAction({ kind: 'replay', recording })}
        onRequestTrash={(recording) => setConfirmAction({ kind: 'trash', recording })}
      />
    )
  }

  /**
   * Tree keyboard model:
   *   ArrowUp/ArrowDown/Home/End — move focus between *visible* rows, so a
   *        collapsed subtree is skipped exactly like it is on screen;
   *   Enter/Space — native button activation (expand / select);
   *   F2 — rename the focused category/scenario/recording (or open the
   *        create-scenario dialog on 未分组), mirroring double-click;
   *   Escape — leave the row focus; Escape inside an editor is handled by
   *        EditableLabel (which stops there, so this never closes both).
   * Events from the rename input are ignored, so typing never moves focus.
   */
  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (handleListKeyDown(event)) return
    if (isEditableTarget(event.target)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      blurActiveElement()
      return
    }
    if (event.key !== 'F2' || writes === undefined) return
    const source = event.target
    const wrapper = source instanceof HTMLElement
      ? source.closest<HTMLElement>(`[${TREE_ROW_KEY_ATTRIBUTE}]`)
      : null
    const key = wrapper?.getAttribute(TREE_ROW_KEY_ATTRIBUTE)
    if (key === undefined || key === null) return
    const row = rowsByKey.get(key)
    if (row === undefined) return
    event.preventDefault()
    if (row.kind === 'category') {
      setEditTarget({ kind: 'category', id: row.category.id, name: row.category.name })
    } else if (row.kind === 'scenario') {
      if (row.scenarioId === undefined) {
        setCreateRequest({
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          count: row.count,
        })
      } else {
        setEditTarget({ kind: 'scenario', id: row.scenarioId, name: row.name })
      }
    } else {
      setEditTarget({
        kind: 'recording',
        id: row.recording.recordingId,
        name: row.recording.title,
      })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tree-root">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>{searchActive ? '搜索结果' : '分类 / 场景'}</span>
        <span className="flex items-center gap-2">
          {writes === undefined ? null : (
            <span className="hidden text-[10px] font-normal normal-case tracking-normal text-muted-foreground/80 sm:inline">
              ↑↓ 移动 · Enter 打开 · F2 重命名
            </span>
          )}
          <span className="tabular-nums" data-testid="tree-count">
            {searchActive
              ? `${String(visibleIds?.size ?? 0)} 条`
              : totalRecordings !== undefined && totalRecordings > project.recordings.length
                ? `${String(project.recordings.length)} / ${String(totalRecordings)} 条`
                : `${String(project.recordings.length)} 条`}
          </span>
        </span>
      </div>

      {useVirtualRows ? (
        <div
          ref={scrollRef}
          role="tree"
          aria-label="分类 / 场景"
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2"
          data-testid="tree-list"
          onKeyDown={handleTreeKeyDown}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              if (row === undefined) return null
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-row-key={row.key}
                  className="absolute left-0 top-0 w-full px-1 py-0.5"
                  style={{ transform: `translateY(${String(virtualRow.start)}px)`, height: rowHeight(row) }}
                >
                  {renderRow(row)}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div
          role="tree"
          aria-label="分类 / 场景"
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2"
          data-testid="tree-list"
          onKeyDown={handleTreeKeyDown}
        >
          {rows.map((row) => (
            <div
              key={row.key}
              data-row-key={row.key}
              className="px-1 py-0.5"
              style={{ height: rowHeight(row) }}
            >
              {renderRow(row)}
            </div>
          ))}
        </div>
      )}

      {hasMore && onLoadMore !== undefined && !searchActive ? (
        <button
          type="button"
          data-testid="tree-load-more"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="m-2 shrink-0 rounded-md border border-border bg-card px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          {loadingMore
            ? '正在加载…'
            : `加载更多录制（已加载 ${String(project.recordings.length)} / ${String(totalRecordings ?? project.recordings.length)}）`}
        </button>
      ) : null}

      {createRequest === undefined || writes === undefined ? null : (
        <CreateScenarioDialog
          categoryId={createRequest.categoryId}
          categoryName={createRequest.categoryName}
          count={createRequest.count}
          saving={writes.pending.has(`scenario-create:${createRequest.categoryId}`)}
          onConfirm={async (name) => {
            const saved = await writes.createScenario(createRequest.categoryId, name)
            if (saved) setCreateRequest(undefined)
            return saved
          }}
          onCancel={() => setCreateRequest(undefined)}
        />
      )}

      {confirmAction === undefined || recordingActions === undefined ? null : (
        <ConfirmDialog
          testId={confirmAction.kind === 'replay' ? 'tree-replay-confirm' : 'tree-trash-confirm'}
          title={confirmAction.kind === 'replay' ? '重跑这条录制？' : '把这条录制移到回收站？'}
          confirmLabel={confirmAction.kind === 'replay' ? '开始重跑' : '移到回收站'}
          danger={confirmAction.kind === 'trash'}
          busy={confirmBusy}
          description={confirmAction.kind === 'replay' ? (
            <>
              会在一个<b>隔离的 Chromium 窗口</b>里按原步骤重新执行，并新建一个 Run。
              录制中的写动作（提交表单、点击下单等）都会真实发生。
            </>
          ) : (
            <>
              整个录制目录会被<b>移动</b>到
              <code className="mx-1 rounded bg-muted px-1 font-mono text-[10px]">.dsh/record-replay/trash/</code>
              ，不会直接删除；需要时可以手动移回
              <code className="mx-1 rounded bg-muted px-1 font-mono text-[10px]">recordings/</code>
              目录恢复。
            </>
          )}
          onCancel={() => {
            if (!confirmBusy) setConfirmAction(undefined)
          }}
          onConfirm={() => {
            void runConfirmedAction()
          }}
        />
      )}
    </div>
  )
}

function TreeRowView({
  row,
  expanded,
  onToggle,
  selectedRecordingId,
  onSelect,
  searchResult,
  writes,
  recordingActions,
  editing,
  saving,
  onStartEdit,
  onCancelEdit,
  onCreateScenario,
  onRequestReplay,
  onRequestTrash,
}: {
  readonly row: TreeRow
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly selectedRecordingId: string | undefined
  readonly onSelect: (recordingId: string) => void
  readonly searchResult: PanelSearchResult | undefined
  readonly writes: PanelWrites | undefined
  readonly recordingActions: TreeRecordingActions | undefined
  readonly editing: boolean
  readonly saving: boolean
  readonly onStartEdit: (target: TreeEditTarget) => void
  readonly onCancelEdit: () => void
  readonly onCreateScenario: (request: CreateScenarioRequest) => void
  readonly onRequestReplay: (recording: PanelRecordingSummary) => void
  readonly onRequestTrash: (recording: PanelRecordingSummary) => void
}): React.JSX.Element {
  switch (row.kind) {
    case 'category':
      return (
        <CategoryRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          editing={editing}
          saving={saving}
          onStartEdit={writes === undefined
            ? undefined
            : () => onStartEdit({ kind: 'category', id: row.category.id, name: row.category.name })}
          onCommit={async (value) => writes === undefined ? false : await writes.renameCategory(row.category.id, value)}
          onCancel={onCancelEdit}
        />
      )
    case 'scenario': {
      const scenarioId = row.scenarioId
      const startInlineEdit = writes === undefined || scenarioId === undefined
        ? undefined
        : () => onStartEdit({ kind: 'scenario', id: scenarioId, name: row.name })
      const startCreate = writes === undefined || scenarioId !== undefined
        ? undefined
        : () => onCreateScenario({
            categoryId: row.categoryId,
            categoryName: row.categoryName,
            count: row.count,
          })
      return (
        <ScenarioRow
          row={row}
          expanded={expanded}
          onToggle={onToggle}
          editing={editing}
          saving={saving}
          onStartEdit={startInlineEdit}
          onCreateScenario={startCreate}
          onCommit={async (value) => {
            if (writes === undefined || scenarioId === undefined) return false
            return await writes.renameScenario(scenarioId, value)
          }}
          onCancel={onCancelEdit}
        />
      )
    }
    case 'recording': {
      const matchedByRun = searchResult?.matches[row.recording.recordingId]?.kind === 'run'
      return (
        <RecordingRow
          recording={row.recording}
          selected={row.recording.recordingId === selectedRecordingId}
          matchedByRun={matchedByRun}
          onSelect={() => onSelect(row.recording.recordingId)}
          editing={editing}
          saving={saving}
          recordingActions={recordingActions}
          onRequestReplay={onRequestReplay}
          onRequestTrash={onRequestTrash}
          onStartEdit={writes === undefined
            ? undefined
            : () => onStartEdit({
                kind: 'recording',
                id: row.recording.recordingId,
                name: row.recording.title,
              })}
          onCommit={async (value) => writes === undefined
            ? false
            : await writes.renameRecording(row.recording.recordingId, value)}
          onCancel={onCancelEdit}
        />
      )
    }
  }
}
