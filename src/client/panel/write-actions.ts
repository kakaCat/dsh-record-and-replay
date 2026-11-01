/**
 * M3-lite panel writes: rename + 未分组收纳.
 *
 * The write face is optional (`PanelApi.write`). When it is absent the panel
 * stays a pure read-only view: no double-click handlers, no dialogs.
 */
import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { PanelApiError, type PanelWriteApi } from './api.js'

export interface PanelToast {
  /** Monotonic id so repeated failures restart the auto-dismiss timer. */
  readonly id: number
  readonly code: string
  readonly message: string
  /** `error` (default) is the red failure toast; `success` confirms an action. */
  readonly variant?: 'error' | 'success'
}

export interface PanelWrites {
  /** Write keys currently in flight (`category:<id>`, `recording:<id>`, …). */
  readonly pending: ReadonlySet<string>
  renameCategory(categoryId: string, name: string): Promise<boolean>
  renameScenario(scenarioId: string, name: string): Promise<boolean>
  createScenario(categoryId: string, name: string): Promise<boolean>
  renameRecording(recordingId: string, title: string): Promise<boolean>
}

export interface UsePanelWriteActionsOptions {
  /** Active project root; writes are rejected by the host without it. */
  readonly root: string
  /** Undefined for read-only entries (standalone `/panel/`). */
  readonly write: PanelWriteApi | undefined
  readonly onError: (toast: PanelToast) => void
}

function toastFrom(error: unknown): PanelToast {
  const code = error instanceof PanelApiError ? error.code : 'PANEL_REQUEST_FAILED'
  const message = error instanceof Error ? error.message : String(error)
  return { id: Date.now() + Math.random(), code, message }
}

export function usePanelWriteActions(options: UsePanelWriteActionsOptions): PanelWrites | undefined {
  const { root, write, onError } = options
  const queryClient = useQueryClient()
  const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set())
  // Ref guards duplicate submits inside one tick (state updates are async).
  const pendingRef = React.useRef<Set<string>>(new Set())

  const requireWrite = React.useCallback((): PanelWriteApi => {
    if (write === undefined) throw new Error('write API is unavailable')
    return write
  }, [write])

  const run = React.useCallback(async (
    key: string,
    task: () => Promise<unknown>,
  ): Promise<boolean> => {
    if (write === undefined) return false
    if (pendingRef.current.has(key)) return false
    pendingRef.current.add(key)
    setPending(new Set(pendingRef.current))
    // Keep the key pending until the refresh settles, so a second Enter /
    // dialog click during refetch cannot start another write.
    const clearPending = (): void => {
      pendingRef.current.delete(key)
      setPending(new Set(pendingRef.current))
    }
    try {
      await task()
    } catch (error) {
      clearPending()
      onError(toastFrom(error))
      return false
    }
    // Refresh the tree together with the detail/search caches that may show
    // the renamed title. A failed refresh must not turn a successful write
    // into an error toast; TanStack Query will retry on the next mount.
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['panel', 'project', root] }),
        queryClient.invalidateQueries({ queryKey: ['panel', 'recording', root] }),
        queryClient.invalidateQueries({ queryKey: ['panel', 'search', root] }),
      ])
    } catch {
      // Keep the successful write result; the next mount refetches.
    } finally {
      clearPending()
    }
    return true
  }, [write, onError, queryClient, root])

  const renameCategory = React.useCallback(
    async (categoryId: string, name: string): Promise<boolean> =>
      await run(`category:${categoryId}`, () => requireWrite().updateCategory(root, categoryId, name)),
    [run, requireWrite, root],
  )
  const renameScenario = React.useCallback(
    async (scenarioId: string, name: string): Promise<boolean> =>
      await run(`scenario:${scenarioId}`, () => requireWrite().updateScenario(root, scenarioId, name)),
    [run, requireWrite, root],
  )
  const createScenario = React.useCallback(
    async (categoryId: string, name: string): Promise<boolean> =>
      await run(`scenario-create:${categoryId}`, () =>
        requireWrite().createScenario(root, categoryId, name, { includeUngrouped: true })),
    [run, requireWrite, root],
  )
  const renameRecording = React.useCallback(
    async (recordingId: string, title: string): Promise<boolean> =>
      await run(`recording:${recordingId}`, () => requireWrite().updateRecording(root, recordingId, { title })),
    [run, requireWrite, root],
  )

  if (write === undefined) return undefined
  return { pending, renameCategory, renameScenario, createScenario, renameRecording }
}
