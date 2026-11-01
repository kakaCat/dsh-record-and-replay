// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PanelProject, PanelSearchResult } from '../../../src/panel/types.js'
import {
  Tree,
  type TreeRecordingActions,
} from '../../../src/client/panel/components/Tree.js'
import { TreeSkeleton } from '../../../src/client/panel/components/LoadingSkeleton.js'
import { usePanelStore } from '../../../src/client/panel/store.js'
import type { PanelWrites } from '../../../src/client/panel/write-actions.js'

function projectFixture(): PanelProject {
  return {
    root: '/tmp/tree-hierarchy',
    name: 'Demo',
    indexSource: 'loaded',
    warnings: [],
    categories: [
      { id: 'bilibili', name: 'B站', site: 'bilibili' },
      { id: 'saucedemo', name: 'SauceDemo', site: 'saucedemo' },
      { id: 'wikipedia', name: 'Wikipedia', site: 'wikipedia' },
      { id: 'empty', name: '空分类', site: 'empty' },
    ],
    scenarios: [
      { id: 'anniv', categoryId: 'bilibili', name: '周年庆' },
      { id: 'empty-scn', categoryId: 'empty', name: '还没录制' },
    ],
    recordings: [
      {
        recordingId: 'rec_bili',
        title: 'B站搜索：明日方舟周年庆',
        site: 'bilibili',
        categoryId: 'bilibili',
        scenarioId: 'anniv',
        status: 'completed',
        stepCount: 4,
        createdAt: '2026-10-31T10:00:00.000Z',
        updatedAt: '2026-10-31T12:00:00.000Z',
        runCount: 2,
        failedRunCount: 1,
        lastRunStatus: 'failed',
        hasVideo: true,
      },
      {
        recordingId: 'rec_bili_v2',
        title: 'B站搜索：明日方舟周年庆 v2',
        site: 'bilibili',
        categoryId: 'bilibili',
        scenarioId: 'anniv',
        status: 'failed',
        stepCount: 3,
        createdAt: '2026-10-30T10:00:00.000Z',
        updatedAt: '2026-10-30T12:00:00.000Z',
        runCount: 1,
        failedRunCount: 1,
        hasVideo: false,
      },
      {
        recordingId: 'rec_shop',
        title: 'SauceDemo：登录验收',
        site: 'saucedemo',
        categoryId: 'saucedemo',
        status: 'recording',
        stepCount: 3,
        createdAt: '2026-10-29T10:00:00.000Z',
        updatedAt: '2026-10-29T12:00:00.000Z',
        runCount: 0,
        failedRunCount: 0,
        hasVideo: false,
      },
      {
        recordingId: 'rec_wiki',
        title: 'Wikipedia：搜索',
        site: 'wikipedia',
        categoryId: 'wikipedia',
        status: 'completed',
        stepCount: 2,
        createdAt: '2026-10-28T10:00:00.000Z',
        updatedAt: '2026-10-28T12:00:00.000Z',
        runCount: 0,
        failedRunCount: 0,
        hasVideo: false,
      },
    ],
    stats: {
      recordings: 4,
      runs: 3,
      failedRuns: 2,
      cancelledRuns: 0,
      failureRate: 2 / 3,
      videoFiles: 1,
      videoBytes: 1024,
      steps: 12,
    },
  }
}

function createWrites(): PanelWrites {
  return {
    pending: new Set<string>(),
    renameCategory: vi.fn(async () => true),
    renameScenario: vi.fn(async () => true),
    createScenario: vi.fn(async () => true),
    renameRecording: vi.fn(async () => true),
  }
}

function createActions(): TreeRecordingActions {
  return {
    canReplay: true,
    canTrash: true,
    pending: new Set<string>(),
    replay: vi.fn(async () => true),
    trash: vi.fn(async () => true),
  }
}

interface RenderTreeOptions {
  readonly project?: PanelProject
  readonly selectedRecordingId?: string
  readonly searchResult?: PanelSearchResult
  readonly writes?: PanelWrites | undefined
  readonly recordingActions?: TreeRecordingActions | undefined
}

function renderTree(options: RenderTreeOptions = {}): void {
  render(
    <Tree
      project={options.project ?? projectFixture()}
      selectedRecordingId={options.selectedRecordingId}
      onSelect={vi.fn()}
      writes={options.writes ?? createWrites()}
      {...(options.searchResult === undefined ? {} : { searchResult: options.searchResult })}
      {...(options.recordingActions === undefined ? {} : { recordingActions: options.recordingActions })}
    />,
  )
}

afterEach(() => {
  cleanup()
  usePanelStore.setState({
    root: undefined,
    selectedRecordingId: undefined,
    selectedRunId: undefined,
    search: '',
    expanded: {},
  })
})

describe('panel tree hierarchy', () => {
  it('gives every level fixed chevron/icon columns and a strictly increasing text column', () => {
    renderTree()

    const category = screen.getByTestId('category-row-bilibili')
    const scenario = screen.getByTestId('scenario-row-anniv')
    const recording = screen.getByTestId('recording-row-rec_bili')

    const textX = (row: HTMLElement): number => {
      const label = row.querySelector<HTMLElement>('[data-tree-text]')
      expect(label).not.toBeNull()
      return Number(label?.getAttribute('data-tree-column-x'))
    }

    expect(category).toHaveAttribute('aria-level', '1')
    expect(category).toHaveAttribute('data-depth', '0')
    expect(category.style.paddingLeft).toBe('8px')
    expect(category.className).toContain('text-[14px]')
    expect(category.className).toContain('font-semibold')
    expect(textX(category)).toBe(56)

    expect(scenario).toHaveAttribute('aria-level', '2')
    expect(scenario).toHaveAttribute('data-depth', '1')
    expect(scenario.style.paddingLeft).toBe('24px')
    expect(scenario.className).toContain('text-[13px]')
    expect(scenario.className).toContain('font-medium')
    expect(textX(scenario)).toBe(72)

    expect(recording).toHaveAttribute('aria-level', '3')
    expect(recording).toHaveAttribute('data-depth', '2')
    expect(recording.style.paddingLeft).toBe('40px')
    expect(textX(recording)).toBe(88)

    // Three distinct label columns, each exactly one 16px step right of the
    // previous one: the recording can never start left of its scenario.
    expect(textX(category)).toBeLessThan(textX(scenario))
    expect(textX(scenario)).toBeLessThan(textX(recording))

    // Every row reserves the same 16px chevron and 16px icon columns.
    for (const row of [category, scenario, recording]) {
      const chevron = row.querySelector<HTMLElement>('[data-tree-chevron]')
      const icon = row.querySelector<HTMLElement>('[data-tree-icon]')
      expect(chevron?.style.width).toBe('16px')
      expect(icon?.style.width).toBe('16px')
      expect(row.className).toContain('gap-2')
    }

    // Fixed-width counts keep the right edge stable while names change.
    expect(screen.getByTestId('category-count-bilibili').className).toContain('w-8')
    expect(screen.getByTestId('scenario-count-anniv').className).toContain('w-8')
    expect(screen.getByTestId('recording-status-rec_bili').className).toContain('w-14')
    expect(screen.getByTestId('recording-status-rec_bili')).toHaveTextContent('完成')
  })

  it('keeps an empty chevron seat and a leaf icon on recording rows', () => {
    renderTree()

    const category = screen.getByTestId('category-row-bilibili')
    const scenario = screen.getByTestId('scenario-row-anniv')
    const recording = screen.getByTestId('recording-row-rec_bili')

    const chevronOf = (row: HTMLElement): HTMLElement | null =>
      row.querySelector<HTMLElement>('[data-tree-chevron]')

    // Expandable rows own a rotating chevron…
    expect(chevronOf(category)?.querySelector('svg')).not.toBeNull()
    expect(chevronOf(category)).not.toHaveAttribute('data-tree-chevron-placeholder')
    expect(chevronOf(scenario)?.querySelector('svg')).not.toBeNull()
    expect(chevronOf(scenario)).not.toHaveAttribute('data-tree-chevron-placeholder')

    // …leaves keep the column empty but reserved, so their text still lands in
    // the depth-3 label column instead of sliding under the scenario label.
    const leafChevron = chevronOf(recording)
    expect(leafChevron).not.toBeNull()
    expect(leafChevron).toHaveAttribute('data-tree-chevron-placeholder')
    expect(leafChevron?.querySelector('svg')).toBeNull()

    const leaf = recording.querySelector<HTMLElement>('[data-tree-leaf]')
    expect(leaf).not.toBeNull()
    expect(leaf?.querySelector('svg')).not.toBeNull()

    // Recording title: 13px normal, truncated, full text available in `title`.
    const title = recording.querySelector<HTMLElement>('[data-tree-title]')
    expect(title?.className).toContain('text-[13px]')
    expect(title?.className).toContain('font-normal')
    expect(title?.className).toContain('truncate')
    expect(title).toHaveAttribute('title', 'B站搜索：明日方舟周年庆')

    // Category/scenario labels also expose their full name via `title`.
    expect(category.querySelector('[data-tree-text]')).toHaveAttribute('title', 'B站')
    expect(scenario.querySelector('[data-tree-text]')).toHaveAttribute('title', '周年庆')
  })

  it('draws one rail per ancestor level, aligned under the parent icon centre', async () => {
    const user = userEvent.setup()
    renderTree()

    const category = screen.getByTestId('category-row-bilibili')
    const scenario = screen.getByTestId('scenario-row-anniv')
    const recording = screen.getByTestId('recording-row-rec_bili')

    const shell = (row: HTMLElement): HTMLElement => {
      const element = row.closest<HTMLElement>('[data-row-shell]')
      if (element === null) throw new Error('row shell not found')
      return element
    }

    // Category: no guide. Scenario: the category guide. Recording: both guides.
    expect(shell(category).querySelectorAll('[data-tree-rail]')).toHaveLength(0)
    expect(shell(scenario).querySelectorAll('[data-tree-rail]')).toHaveLength(1)
    expect(shell(recording).querySelectorAll('[data-tree-rail]')).toHaveLength(2)
    const railXs = Array.from(shell(recording).querySelectorAll<HTMLElement>('[data-tree-rail]'))
      .map((rail) => rail.style.left)
    // Category icon centre (8 + 16 + 8 + 8) and scenario icon centre (+16).
    expect(railXs).toEqual(['40px', '56px'])

    // Each guide elbows right into the row's own icon (8px gap column).
    expect(shell(scenario).querySelector<HTMLElement>('[data-tree-rail-stub]')?.style.left).toBe('40px')
    expect(shell(recording).querySelector<HTMLElement>('[data-tree-rail-stub]')?.style.left).toBe('56px')
    expect(shell(recording).querySelector<HTMLElement>('[data-tree-rail-stub]')?.style.width).toBe('8px')

    // Collapsing the category removes the rows *and* their rails.
    await user.click(category)
    expect(screen.queryByTestId('scenario-row-anniv')).toBeNull()
    expect(screen.queryByTestId('recording-row-rec_bili')).toBeNull()
    expect(screen.getByTestId('category-row-bilibili')).toHaveAttribute('aria-expanded', 'false')

    // Collapsing the scenario keeps the category guide but drops every
    // recording rail with the subtree.
    await user.click(category)
    const reopenedScenario = screen.getByTestId('scenario-row-anniv')
    await user.click(reopenedScenario)
    expect(screen.queryByTestId('recording-row-rec_bili')).toBeNull()
    expect(shell(reopenedScenario).querySelectorAll('[data-tree-rail]')).toHaveLength(1)
  })

  it('rotates the chevron and keeps the whole row a click target', async () => {
    const user = userEvent.setup()
    renderTree()

    const category = screen.getByTestId('category-row-bilibili')
    const chevron = category.querySelector('svg')
    expect(chevron).not.toBeNull()
    expect(chevron?.getAttribute('class')).toContain('rotate-90')

    await user.click(category)
    expect(category.querySelector('svg')?.getAttribute('class')).not.toContain('rotate-90')
    expect(category).toHaveAttribute('aria-expanded', 'false')

    await user.click(category)
    expect(category.querySelector('svg')?.getAttribute('class')).toContain('rotate-90')
    expect(screen.getByTestId('scenario-row-anniv')).toBeInTheDocument()
  })

  it('keeps empty categories (and their empty scenarios) visible while browsing', () => {
    renderTree()

    const emptyCategory = screen.getByTestId('category-row-empty')
    expect(emptyCategory).toBeInTheDocument()
    expect(emptyCategory).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('category-count-empty')).toHaveTextContent('0')
    // A declared scenario with no recording is still part of the structure.
    expect(screen.getByTestId('scenario-row-empty-scn')).toBeInTheDocument()
    expect(screen.getByTestId('scenario-count-empty-scn')).toHaveTextContent('0')
  })

  it('marks 未分组 as a virtual dashed group and keeps double-click create', async () => {
    const user = userEvent.setup()
    renderTree()

    const ungrouped = screen.getByTestId('ungrouped-row-saucedemo')
    expect(ungrouped).toHaveAttribute('data-virtual-group', 'true')
    expect(ungrouped.className).toContain('outline-dashed')
    expect(ungrouped.className).toContain('text-muted-foreground')
    expect(screen.getByTestId('ungrouped-count-saucedemo')).toHaveTextContent('1')

    await user.dblClick(ungrouped)
    expect(await screen.findByTestId('create-scenario-dialog')).toBeInTheDocument()
    expect(screen.getByText('新建场景并收纳当前 1 条录制')).toBeInTheDocument()
  })

  it('reveals rename/replay/trash only on hover or keyboard focus', async () => {
    const user = userEvent.setup()
    const recordingActions = createActions()
    renderTree({ recordingActions })

    const recording = screen.getByTestId('recording-row-rec_bili')
    const actions = screen.getByTestId('row-actions-recording-rec_bili')
    expect(actions).toHaveAttribute('data-visible', 'false')
    expect(actions.className).toContain('opacity-0')

    const rename = screen.getByTestId('rename-row-rec_bili')
    expect(rename).toHaveAttribute('aria-hidden', 'true')
    expect(rename).toHaveAttribute('tabindex', '-1')
    expect(screen.getByTestId('replay-row-rec_bili')).toBeInTheDocument()
    expect(screen.getByTestId('trash-row-rec_bili')).toBeInTheDocument()

    await user.hover(recording)
    expect(actions).toHaveAttribute('data-visible', 'true')
    expect(actions.className).toContain('opacity-100')
    expect(rename).not.toHaveAttribute('aria-hidden')
    expect(rename).toHaveAttribute('tabindex', '0')

    await user.unhover(recording)
    expect(actions).toHaveAttribute('data-visible', 'false')
  })

  it('confirms a row-level replay before calling the action bridge', async () => {
    const user = userEvent.setup()
    const recordingActions = createActions()
    renderTree({ recordingActions })

    await user.hover(screen.getByTestId('recording-row-rec_bili'))
    await user.click(screen.getByTestId('replay-row-rec_bili'))
    expect(await screen.findByTestId('tree-replay-confirm')).toBeInTheDocument()

    await user.click(screen.getByTestId('tree-replay-confirm-confirm'))
    expect(recordingActions.replay).toHaveBeenCalledWith('rec_bili')
  })

  it('marks the selected recording with a 2px bar and a background', () => {
    renderTree({ selectedRecordingId: 'rec_bili' })

    const row = screen.getByTestId('recording-row-rec_bili')
    expect(row).toHaveAttribute('data-selected', 'true')
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(row.className).toContain('bg-accent')

    const bar = screen.getByTestId('selected-bar-rec_bili')
    expect(bar.className).toContain('w-0.5')
    expect(bar.className).toContain('bg-primary')

    expect(screen.getByTestId('recording-row-rec_shop')).not.toHaveAttribute('data-selected')
    expect(screen.queryByTestId('selected-bar-rec_shop')).toBeNull()
  })

  it('hides branches without a search match but keeps matching ancestors', () => {
    const project = projectFixture()
    const searchResult: PanelSearchResult = {
      query: 'failed',
      recordings: [project.recordings[1]!],
      runs: [],
      matches: { rec_bili_v2: { kind: 'recording' } },
    }
    renderTree({ searchResult })

    expect(screen.getByTestId('category-row-bilibili')).toBeInTheDocument()
    expect(screen.getByTestId('scenario-row-anniv')).toBeInTheDocument()
    expect(screen.getByTestId('recording-row-rec_bili_v2')).toBeInTheDocument()
    expect(screen.queryByTestId('recording-row-rec_bili')).toBeNull()
    expect(screen.queryByTestId('category-row-saucedemo')).toBeNull()
    expect(screen.queryByTestId('category-row-empty')).toBeNull()
  })

  it('moves ArrowDown across only the visible rows after a collapse', async () => {
    const user = userEvent.setup()
    renderTree()

    const category = screen.getByTestId('category-row-bilibili')
    expect(screen.getByTestId('scenario-row-anniv')).toBeInTheDocument()

    category.focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByTestId('scenario-row-anniv')).toBeNull()

    const visibleRows = Array.from(
      screen.getByTestId('tree-list').querySelectorAll<HTMLElement>('[data-keyboard-row]'),
    )
    const first = visibleRows[0]
    const second = visibleRows[1]
    expect(first).toBe(category)
    expect(second).toBeDefined()
    first?.focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(second)
  })

  it('indents skeleton rows by depth', () => {
    render(<TreeSkeleton />)
    expect(screen.getAllByTestId('tree-skeleton')).toHaveLength(1)
    const depth0 = document.querySelectorAll('[data-skeleton-depth="0"]')
    const depth1 = document.querySelectorAll('[data-skeleton-depth="1"]')
    const depth2 = document.querySelectorAll('[data-skeleton-depth="2"]')
    expect(depth0).toHaveLength(3)
    expect(depth1).toHaveLength(3)
    expect(depth2).toHaveLength(6)
    expect(depth0[0]?.className).not.toContain('ml-4')
    expect(depth1[0]?.className).toContain('ml-4')
    expect(depth2[0]?.className).toContain('ml-8')
  })

  it('renders the inline tree loading state with indented skeletons', () => {
    render(<Tree project={undefined} selectedRecordingId={undefined} onSelect={vi.fn()} loading />)
    expect(screen.getByTestId('tree-skeleton')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-skeleton-depth="0"]')).toHaveLength(3)
    expect(document.querySelectorAll('[data-skeleton-depth="1"]')).toHaveLength(3)
    expect(document.querySelectorAll('[data-skeleton-depth="2"]')).toHaveLength(6)
  })
})
