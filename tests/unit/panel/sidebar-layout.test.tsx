// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DETAIL_PERCENT_DEFAULT,
  DETAIL_PERCENT_MAX,
  DETAIL_PERCENT_MIN,
  SidebarLayout,
} from '../../../src/client/panel/components/SidebarLayout.js'

afterEach(cleanup)

function renderLayout(options: {
  readonly withDetail?: boolean
  readonly withFooter?: boolean
} = {}): { readonly onCloseDetail: ReturnType<typeof vi.fn> } {
  const onCloseDetail = vi.fn()
  render(
    <SidebarLayout
      list={<div data-testid="list-body">分类树</div>}
      {...(options.withDetail === false
        ? {}
        : { detail: <div data-testid="detail-body">详情内容</div> })}
      {...(options.withFooter === true ? { footer: <div data-testid="footer-bar">已收起</div> } : {})}
      onCloseDetail={onCloseDetail}
    />,
  )
  return { onCloseDetail }
}

describe('narrow sidebar layout', () => {
  it('stacks the list above a bordered, independently scrolling detail pane', () => {
    renderLayout()
    const list = screen.getByTestId('sidebar-split-list')
    const detail = screen.getByTestId('detail-pane')

    // DOM order: list first, detail below.
    expect(list.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('sidebar-split')).toHaveAttribute('data-detail-open', 'true')

    // The pane has its own scroll surface and a top divider.
    expect(detail.className).toContain('border-t')
    const scroll = screen.getByTestId('detail-pane-scroll')
    expect(scroll.className).toContain('overflow-y-auto')
    expect(scroll.className).toContain('overflow-x-hidden')
    expect(detail).toHaveStyle({ flexBasis: `${String(DETAIL_PERCENT_DEFAULT)}%` })
    expect(screen.getByTestId('detail-pane-bar')).toHaveTextContent('详情')
  })

  it('exposes a horizontal splitter that resizes from the keyboard and resets on double click', () => {
    renderLayout()
    const splitter = screen.getByRole('separator', { name: '调整详情高度' })
    expect(splitter).toHaveAttribute('aria-orientation', 'horizontal')
    expect(splitter).toHaveAttribute('aria-valuemin', String(DETAIL_PERCENT_MIN))
    expect(splitter).toHaveAttribute('aria-valuemax', String(DETAIL_PERCENT_MAX))
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAIL_PERCENT_DEFAULT))

    fireEvent.keyDown(splitter, { key: 'ArrowUp' })
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAIL_PERCENT_DEFAULT + 5))
    expect(screen.getByTestId('detail-pane')).toHaveStyle({ flexBasis: '55%' })

    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    expect(splitter).toHaveAttribute('aria-valuenow', '45')

    fireEvent.keyDown(splitter, { key: 'End' })
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAIL_PERCENT_MAX))
    fireEvent.keyDown(splitter, { key: 'Home' })
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAIL_PERCENT_MIN))

    fireEvent.doubleClick(splitter)
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAIL_PERCENT_DEFAULT))
  })

  it('drags the divider between pointer down and pointer up', () => {
    renderLayout()
    const container = screen.getByTestId('sidebar-split')
    container.getBoundingClientRect = () => ({
      top: 0,
      bottom: 600,
      height: 600,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    const splitter = screen.getByTestId('detail-splitter')
    fireEvent.pointerDown(splitter, { button: 0, pointerId: 1, clientY: 300 })
    expect(splitter).toHaveAttribute('data-dragging', 'true')

    // 600 - 420 = 180 → 30% is the clamp floor.
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: 420 })
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAIL_PERCENT_MIN))

    // 600 - 150 = 450 → 75% clamps to 70%.
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: 150 })
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAIL_PERCENT_MAX))

    fireEvent.pointerUp(splitter, { pointerId: 1, clientY: 150 })
    expect(splitter).toHaveAttribute('data-dragging', 'false')
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: 400 })
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAIL_PERCENT_MAX))
  })

  it('closes the detail with Escape but leaves the list mounted', () => {
    const { onCloseDetail } = renderLayout()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCloseDetail).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('list-body')).toBeInTheDocument()
  })

  it('does not steal Escape from inputs or an open modal', () => {
    const { onCloseDetail } = renderLayout()
    render(<input aria-label="搜索录制" />)
    fireEvent.keyDown(screen.getByLabelText('搜索录制'), { key: 'Escape' })
    expect(onCloseDetail).not.toHaveBeenCalled()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    dialog.remove()
    expect(onCloseDetail).not.toHaveBeenCalled()
  })

  it('gives the list the full height and hides the splitter when no detail is open', () => {
    renderLayout({ withDetail: false, withFooter: true })
    expect(screen.queryByTestId('detail-pane')).toBeNull()
    expect(screen.queryByTestId('detail-splitter')).toBeNull()
    expect(screen.getByTestId('sidebar-split')).toHaveAttribute('data-detail-open', 'false')
    expect(screen.getByTestId('list-body')).toBeInTheDocument()
    expect(screen.getByTestId('footer-bar')).toBeInTheDocument()
  })
})
