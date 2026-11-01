/**
 * M3 recording actions: replay and move-to-trash.
 *
 * Both actions are optional (`PanelApi.actions`); the standalone `/panel/`
 * page stays read-only. The hooks mirror `write-actions.ts`: one in-flight key
 * per recording, a stable error toast and cache invalidation after success.
 *
 * Replay returns as soon as the host has persisted the Run; progress is then
 * polled by the App through the ordinary `GET /recording` query, so a new Run
 * and its video show up without a second endpoint.
 */
import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type {
  PanelReplayStartResult,
  PanelTrashResult,
} from '../../panel/types.js'
import { PanelApiError, type PanelRecordingActionsApi } from './api.js'
import type { PanelToast } from './write-actions.js'

export interface PanelRecordingActions {
  /** Action keys currently in flight (`replay:<id>`, `trash:<id>`). */
  readonly pending: ReadonlySet<string>
  replay(recordingId: string): Promise<PanelReplayStartResult | undefined>
  trash(recordingId: string): Promise<PanelTrashResult | undefined>
}

export interface UsePanelRecordingActionsOptions {
  /** Active project root. */
  readonly root: string
  /** Undefined for read-only entries (standalone `/panel/`). */
  readonly actions: PanelRecordingActionsApi | undefined
  readonly onError: (toast: PanelToast) => void
  readonly onSuccess: (toast: PanelToast) => void
  /** Called with the `{ recordingId, runId }` handle right after a replay starts. */
  readonly onReplayStarted: (started: { readonly recordingId: string; readonly runId: string }) => void
  /** Called when the host reports that this process has no replay service. */
  readonly onReplayUnavailable: (message: string) => void
  /** Called with the trash result after the index/tree refresh. */
  readonly onTrashed: (result: PanelTrashResult) => void
}

function toastFrom(error: unknown): PanelToast {
  const code = error instanceof PanelApiError ? error.code : 'PANEL_REQUEST_FAILED'
  const message = error instanceof Error ? error.message : String(error)
  return { id: Date.now() + Math.random(), code, message }
}

export function usePanelRecordingActions(
  options: UsePanelRecordingActionsOptions,
): PanelRecordingActions | undefined {
  const {
    root,
    actions,
    onError,
    onSuccess,
    onReplayStarted,
    onReplayUnavailable,
    onTrashed,
  } = options
  const queryClient = useQueryClient()
  const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set())
  const pendingRef = React.useRef<Set<string>>(new Set())

  const invalidate = React.useCallback(async (): Promise<void> => {
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['panel', 'project', root] }),
        queryClient.invalidateQueries({ queryKey: ['panel', 'recording', root] }),
        queryClient.invalidateQueries({ queryKey: ['panel', 'search', root] }),
        queryClient.invalidateQueries({ queryKey: ['panel', 'search-all'] }),
        queryClient.invalidateQueries({ queryKey: ['panel', 'stats'] }),
        queryClient.invalidateQueries({ queryKey: ['panel', 'projects'] }),
      ])
    } catch {
      // A failed refresh must not turn a successful action into an error; the
      // next mount refetches.
    }
  }, [queryClient, root])

  const run = React.useCallback(async <T,>(
    key: string,
    task: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (actions === undefined) return undefined
    if (pendingRef.current.has(key)) return undefined
    pendingRef.current.add(key)
    setPending(new Set(pendingRef.current))
    let result: T
    try {
      result = await task()
    } catch (error) {
      pendingRef.current.delete(key)
      setPending(new Set(pendingRef.current))
      if (error instanceof PanelApiError && error.code === 'PANEL_REPLAY_UNAVAILABLE') {
        onReplayUnavailable(error.message)
      }
      onError(toastFrom(error))
      return undefined
    }
    await invalidate()
    pendingRef.current.delete(key)
    setPending(new Set(pendingRef.current))
    return result
  }, [actions, invalidate, onError, onReplayUnavailable])

  const replay = React.useCallback(
    async (recordingId: string): Promise<PanelReplayStartResult | undefined> => {
      const result = await run(`replay:${recordingId}`, async () => {
        if (actions === undefined) throw new Error('recording actions are unavailable')
        return await actions.replay(root, recordingId)
      })
      if (result !== undefined) onReplayStarted({ recordingId, runId: result.runId })
      return result
    },
    [run, actions, root, onReplayStarted],
  )

  const trash = React.useCallback(
    async (recordingId: string): Promise<PanelTrashResult | undefined> => {
      const result = await run(`trash:${recordingId}`, async () => {
        if (actions === undefined) throw new Error('recording actions are unavailable')
        return await actions.trash(root, recordingId)
      })
      if (result !== undefined) {
        onTrashed(result)
        onSuccess({
          id: Date.now() + Math.random(),
          code: 'PANEL_TRASHED',
          message: `录制已移到回收站：${result.trashPath}`,
          variant: 'success',
        })
      }
      return result
    },
    [run, actions, root, onTrashed, onSuccess],
  )

  if (actions === undefined) return undefined
  return { pending, replay, trash }
}
