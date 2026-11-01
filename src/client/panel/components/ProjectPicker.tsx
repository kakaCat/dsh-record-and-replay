import type * as React from 'react'
import { PANEL_ALL_PROJECTS_ROOT, type PanelProjectSummary } from '../../../panel/types.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js'
import { FolderGit2, FolderPlus, Layers, Loader2 } from 'lucide-react'

export interface ProjectPickerProps {
  readonly projects: readonly PanelProjectSummary[]
  readonly value: string | undefined
  readonly onChange: (root: string) => void
  /** Fill the row (right sidebar) instead of using the fixed desktop width. */
  readonly compact?: boolean
  /** Opens the host directory picker; absent on the read-only standalone page. */
  readonly onOpenFolder?: (() => void) | undefined
  readonly picking?: boolean
  /** Adds the "全部项目" entry (`value = '*'`) for cross-project search/stats. */
  readonly includeAll?: boolean
  /** Known project count for the "全部项目" badge (may exceed the loaded pages). */
  readonly projectsTotal?: number | undefined
}

export function ProjectPicker({
  projects,
  value,
  onChange,
  compact = false,
  onOpenFolder,
  picking = false,
  includeAll = false,
  projectsTotal,
}: ProjectPickerProps): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Select
        value={value ?? ''}
        onValueChange={onChange}
        disabled={projects.length === 0}
      >
        <SelectTrigger className={compact ? 'w-full min-w-0' : 'w-[260px] min-w-0'} aria-label="选择项目">
          <SelectValue placeholder={projects.length === 0 ? '没有可用项目' : '选择项目'} />
        </SelectTrigger>
        <SelectContent>
          {includeAll ? (
            <SelectItem value={PANEL_ALL_PROJECTS_ROOT} title="跨项目搜索与统计" data-testid="project-option-all">
              <span className="flex min-w-0 items-center gap-2">
                <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">全部项目</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {projectsTotal ?? projects.length} 项目
                </span>
              </span>
            </SelectItem>
          ) : null}
          {projects.map((project) => (
            <SelectItem key={project.root} value={project.root} title={project.root}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{project.name}</span>
                {project.recordingCount === undefined || project.recordingCount === 0 ? null : (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                    {project.recordingCount} 录制
                  </span>
                )}
                {project.isCurrent === true ? (
                  <span className="shrink-0 rounded bg-primary/12 px-1.5 py-0.5 text-[10px] text-primary">当前</span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {onOpenFolder === undefined ? null : (
        <button
          type="button"
          onClick={onOpenFolder}
          disabled={picking}
          aria-label="打开文件夹"
          title="打开文件夹…（记住最近打开）"
          data-testid="project-open-folder"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          {picking
            ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            : <FolderPlus className="h-4 w-4" aria-hidden="true" />}
        </button>
      )}
    </div>
  )
}
