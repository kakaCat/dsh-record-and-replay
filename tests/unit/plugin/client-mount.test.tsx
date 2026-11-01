// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import * as React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply, PANEL_ID, TAB_IMPL_ID, TAB_KIND } from '../../../src/client/plugin/mount.js'
import type { PanelApi } from '../../../src/client/panel/api.js'

interface Registration {
  readonly name: string
  readonly options: Record<string, unknown>
  readonly component: React.ComponentType<any>
}

interface Harness {
  readonly registrations: Registration[]
  readonly tabTypes: Record<string, unknown>[]
  readonly openTab: ReturnType<typeof vi.fn>
  readonly disposed: string[]
}

const LABELS: Readonly<Record<string, string>> = {
  title: '录制回放',
  description: '浏览录制、用例意图与回放视频',
  openHint: '请先在会话中打开右侧栏',
}

function createHarness(options: { readonly failOpen?: boolean } = {}): Harness {
  const registrations: Registration[] = []
  const tabTypes: Record<string, unknown>[] = []
  const disposed: string[] = []
  const openTab = vi.fn(() => {
    if (options.failOpen === true) throw new Error('no mounted right sidebar seat')
  })

  const slots = {
    inject(_name: string, callback: () => unknown) {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    register(registryOptions: Record<string, unknown>, component: React.ComponentType<any>) {
      registrations.push({
        name: String(registryOptions['name']),
        options: registryOptions,
        component,
      })
      return () => {
        disposed.push(String(registryOptions['name']))
      }
    },
  }

  const tabRegistry = {
    register(definition: Record<string, unknown>) {
      tabTypes.push(definition)
      return () => {
        disposed.push('tab')
      }
    },
  }

  const ctx = {
    slots,
    locale: {
      register: () => () => undefined,
      bind: () => (key: string) => LABELS[key] ?? key,
    },
    effect(run: () => unknown) {
      run()
    },
    inject(_services: readonly string[], callback: (scope: unknown) => unknown) {
      callback({
        get: (name: string) => {
          if (name === 'sidebarRight') return { openTab }
          if (name === 'sidebarRightTabs') return tabRegistry
          return undefined
        },
        slots,
      })
    },
  }

  apply(ctx as never)
  return { registrations, tabTypes, openTab, disposed }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('client plugin: right-sidebar mount', () => {
  it('registers one right-sidebar tab type and its body, with no main panel', () => {
    const harness = createHarness()

    expect(harness.tabTypes).toHaveLength(1)
    expect(harness.tabTypes[0]).toMatchObject({
      id: TAB_IMPL_ID,
      kind: TAB_KIND,
      priority: 'extension',
    })
    expect((harness.tabTypes[0] as { title: () => string }).title()).toBe('录制回放')

    const names = harness.registrations.map((registration) => registration.name)
    expect(names).toEqual(['sidebar.right.pane.tab', 'sidebar.footer.action'])
    expect(names).not.toContain('main')
    expect(names).not.toContain('sidebar.panellist')

    const body = harness.registrations[0]
    expect(body?.options['key']).toBe(TAB_IMPL_ID)

    const entry = harness.registrations[1]
    expect(entry?.options['id']).toBe(PANEL_ID)
    expect(entry?.options['order']).toBe(30)
    expect((entry?.options['label'] as () => string)()).toBe('录制回放')
  })

  it('opens the right-sidebar tab from the left entry without selecting a main panel', async () => {
    const user = userEvent.setup()
    const harness = createHarness()
    const entry = harness.registrations.find((registration) => registration.name === 'sidebar.footer.action')

    render(React.createElement(entry?.component as React.ComponentType<{ wide: boolean; watchActive: boolean }>, { wide: true, watchActive: false }))
    const button = screen.getByTestId('record-replay-entry')
    expect(button).toHaveTextContent('录制回放')

    await user.click(button)
    expect(harness.openTab).toHaveBeenCalledWith(TAB_KIND)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows a live recording badge and stops it from the footer', async () => {
    const user = userEvent.setup()
    const harness = createHarness()
    const entry = harness.registrations.find((registration) => registration.name === 'sidebar.footer.action')
    const active = {
      root: '/tmp/live-project',
      projectName: 'Live',
      recordingId: 'rec_live',
      title: 'Live recording',
      stepCount: 4,
      createdAt: new Date(Date.now() - 65_000).toISOString(),
      updatedAt: new Date().toISOString(),
    }
    let running = true
    const stop = vi.fn(async () => {
      running = false
      return { recordingId: active.recordingId, status: 'completed' as const, endReason: 'tool_stopped' as const }
    })
    const api = {
      listActive: vi.fn(async () => (running ? [active] : [])),
      capabilities: vi.fn(async () => ({ replay: true, trash: true, control: true })),
      actions: {
        stop,
        discard: vi.fn(async () => ({ recordingId: active.recordingId, status: 'cancelled' as const, endReason: 'cancelled' as const })),
      },
    } as unknown as PanelApi

    render(React.createElement(entry?.component as React.ComponentType<any>, { wide: true, api }))
    expect(await screen.findByTestId('record-replay-active')).toBeInTheDocument()
    expect(screen.getByTestId('record-replay-entry')).toHaveTextContent(/录制中 01:0/)

    await user.click(screen.getByTestId('record-replay-stop'))
    expect(stop).toHaveBeenCalledWith(active.root, active.recordingId)
    await waitFor(() => expect(screen.queryByTestId('record-replay-active')).not.toBeInTheDocument())
  })

  it('requires a second click before discarding a live recording', async () => {
    const user = userEvent.setup()
    const harness = createHarness()
    const entry = harness.registrations.find((registration) => registration.name === 'sidebar.footer.action')
    const active = {
      root: '/tmp/live-project',
      projectName: 'Live',
      recordingId: 'rec_live',
      title: 'Live recording',
      stepCount: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const discard = vi.fn(async () => ({
      recordingId: active.recordingId,
      status: 'cancelled' as const,
      endReason: 'cancelled' as const,
    }))
    const api = {
      listActive: vi.fn(async () => [active]),
      actions: {
        stop: vi.fn(async () => ({ recordingId: active.recordingId, status: 'completed' as const })),
        discard,
      },
    } as unknown as PanelApi

    render(React.createElement(entry?.component as React.ComponentType<any>, { wide: true, api }))
    const button = await screen.findByTestId('record-replay-discard')
    await user.click(button)
    expect(discard).not.toHaveBeenCalled()
    expect(screen.getByTestId('record-replay-discard')).toHaveAttribute('title', '再点一次确认丢弃')
    await user.click(screen.getByTestId('record-replay-discard'))
    expect(discard).toHaveBeenCalledWith(active.root, active.recordingId)
  })

  it('keeps the main area untouched and explains when no right sidebar is mounted', async () => {
    const user = userEvent.setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const harness = createHarness({ failOpen: true })
    const entry = harness.registrations.find((registration) => registration.name === 'sidebar.footer.action')

    render(React.createElement(entry?.component as React.ComponentType<{ wide: boolean; watchActive: boolean }>, { wide: false, watchActive: false }))
    await user.click(screen.getByTestId('record-replay-entry'))

    expect(await screen.findByRole('status')).toHaveTextContent('请先在会话中打开右侧栏')
    expect(warn).toHaveBeenCalled()
  })
})
