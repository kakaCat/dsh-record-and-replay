/**
 * DSH client half of the global record/replay panel.
 *
 * The panel lives in the **right sidebar**, not the main column:
 *
 *   - `sidebar.footer.action`: the left-sidebar entry (the sanctioned additive
 *     left-column seat). Its button calls `ctx.sidebarRight.openTab`, so a click
 *     never replaces the conversation's main panel.
 *   - `sidebarRightTabs`: one page type, `recordReplay`, that appears in the
 *     right column's title strip and guide.
 *   - `sidebar.right.pane.tab`: the body for that type (keyed by the definition
 *     id), rendering the same `PanelApp` in its narrow, stacked variant.
 *
 * Why the footer seat instead of the old `sidebar.panellist` row: a panellist
 * row is hard-wired by the sidebar shell to select a matching main panel
 * (`selectPanel(id)`), and the right sidebar is session-scoped. The footer
 * action owns its own button, which is what lets the entry open the right
 * column instead of taking over the main area.
 *
 * Data comes from the host routes at `/api/record-replay` registered by
 * `src/plugin/index.ts`; the panel never talks to a standalone port.
 */
import * as React from 'react'

import { PanelApp } from '../panel/App.js'
import { createPanelApi, type PanelApi } from '../panel/api.js'
import type { PanelActiveRecording } from '../../panel/types.js'

const NS = 'record-replay'
const PANEL_ID = 'record-replay'
/** Page type users open in the right sidebar (`sidebarRight.openTab(kind)`). */
const TAB_KIND = 'recordReplay'
/** Tab implementation id; the keyed `sidebar.right.pane.tab` body registers under it. */
const TAB_IMPL_ID = 'dsh-record-replay'
const API_PREFIX = '/api/record-replay'

const panelApi = createPanelApi(API_PREFIX)

const LOCALES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  zh: {
    title: '录制回放',
    description: '浏览录制、用例意图与回放视频',
    openHint: '请先在会话中打开右侧栏',
  },
  en: {
    title: 'Record & Replay',
    description: 'Browse recordings, their intent, and replay videos',
    openHint: 'Open a conversation before using the right sidebar',
  },
}

interface ClientSlots {
  inject(name: string, callback: () => () => void): (() => void) | void
  register(options: Record<string, unknown>, component: React.ComponentType<any>): () => void
}

interface ClientLocale {
  register(namespace: string, dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void
  bind(namespace: string): (key: string) => string
}

/** Read-only observable handed out by DSH client services. */
interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Right-sidebar navigation face (`ctx.sidebarRight`). */
interface SidebarRightService {
  openTab(kind: string, options?: Record<string, unknown>): void
  /** The Session on screen; absent while a global panel replaces the conversation. */
  mounted?: SnapshotStore<string | undefined>
}

/** One Host workspace as listed by the Workspace Controller. */
interface WorkspaceItem {
  readonly workspaceId: string
  readonly path: string
  readonly sessionIds?: readonly string[]
}

interface WorkspacesService {
  readonly list: SnapshotStore<{ readonly items?: readonly WorkspaceItem[] }>
}

interface SessionSummary {
  readonly cwd?: string
  readonly workspaceId?: string
}

interface SessionsService {
  readonly list: SnapshotStore<{ readonly byId?: Readonly<Record<string, SessionSummary>> }>
}

/** The DSH directory-picking face (`ctx.uiWorkspace`). */
interface UiWorkspaceService {
  pickDirectory(): Promise<string>
}

/**
 * Resolve the current session's workspace root, refreshed whenever the
 * sidebar's mounted session or the workspace/session catalogs change.
 *
 * The value feeds the panel's default-project rule ("current session /
 * recently used workspace"). When DSH's services are unavailable the panel
 * falls back to the host's own ordering.
 */
function createCurrentRootStore(): {
  subscribe(listener: () => void): () => void
  getSnapshot(): string | undefined
  set(value: string | undefined): void
} {
  let value: string | undefined
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return value
    },
    set(next) {
      if (next === value) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const currentRootStore = createCurrentRootStore()
let mountedSession = (): string | undefined => undefined
let resolveSessionRoot: ((sessionId: string) => string | undefined) | undefined
let pickDirectory: (() => Promise<string>) | undefined

function refreshCurrentRoot(): void {
  const sessionId = mountedSession()
  currentRootStore.set(sessionId === undefined ? undefined : resolveSessionRoot?.(sessionId))
}

/** Opens DSH's composed directory picker; throws when the service is absent. */
async function openDirectoryPicker(): Promise<string | undefined> {
  if (pickDirectory === undefined) throw new Error('DSH directory picker is not available')
  return await pickDirectory()
}

/** Right-sidebar tab-type registry (`ctx.sidebarRightTabs`). */
interface SidebarRightTabRegistry {
  register(definition: Record<string, unknown>): () => void
}

/** Scope handed to an `ctx.inject([...])` callback. */
interface InjectedScope {
  get<T>(name: string): T | undefined
  slots: ClientSlots
}

/** The slice of the DSH client context this plugin needs. */
export interface ClientContext {
  readonly slots: ClientSlots
  readonly locale: ClientLocale
  effect(fn: () => (() => void) | void, label?: string): void
  inject(services: readonly string[], callback: (scope: InjectedScope) => (() => void) | void): void
}

/** Cordis services the client plugin waits for before loading at all. */
export const inject = ['slots', 'locale']

/** Right-sidebar entry glyph; used by both the left entry and the guide. */
function RecordReplayIcon({ size = 18 }: { readonly size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 10.5h16V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M4 10.5 5.6 5.6A2 2 0 0 1 7.5 4.2H19a1 1 0 0 1 1 1v5.3" />
      <path d="m8 4.4 2.2 4.4M13 4.4l2.2 4.4M18 4.4l2.2 4.4" />
    </svg>
  )
}

/** Live recording state for the footer entry; polls only while the entry is mounted. */
function useActiveRecordings(api: PanelApi, enabled: boolean, root: string | undefined): {
  readonly recordings: readonly PanelActiveRecording[]
  readonly error: string | undefined
  readonly remove: (recordingId: string) => void
} {
  const [recordings, setRecordings] = React.useState<readonly PanelActiveRecording[]>([])
  const [error, setError] = React.useState<string | undefined>()

  React.useEffect(() => {
    if (!enabled || api.listActive === undefined) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      try {
        const list = await api.listActive?.(root)
        if (!cancelled && list !== undefined) {
          setRecordings(list)
          setError(undefined)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) timer = setTimeout(() => { void load() }, 1000)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, enabled, root])

  return {
    recordings,
    error,
    remove: recordingId => setRecordings(previous => previous.filter(item => item.recordingId !== recordingId)),
  }
}

/** One-second clock for the live timer; only runs while a recording is visible. */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

function StopIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

function DiscardIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </svg>
  )
}

/** Render the panel inside the right column, in its narrow stacked layout. */
function RecordReplayTab(): React.JSX.Element {
  const preferredRoot = React.useSyncExternalStore(
    currentRootStore.subscribe,
    currentRootStore.getSnapshot,
    () => undefined,
  )
  return (
    <div className="rr-root rr-root--sidebar" data-testid="record-replay-tab">
      <PanelApp
        api={panelApi}
        variant="sidebar"
        writable
        {...(preferredRoot === undefined ? {} : { preferredRoot })}
        onPickDirectory={openDirectoryPicker}
      />
    </div>
  )
}

/**
 * Register the right-sidebar page type and its left-sidebar entry.
 * @param ctx - DSH client context carrying slots, locale, and optional rightbar services.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, LOCALES), `${NS}: locale`)
  const t = ctx.locale.bind(NS)

  let openPanel: () => boolean = () => false

  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
    const tabs = scope.get<SidebarRightTabRegistry>('sidebarRightTabs')
    const rightbar = scope.get<SidebarRightService>('sidebarRight')
    if (tabs === undefined || rightbar === undefined) return

    const disposers: (() => void)[] = []
    disposers.push(tabs.register({
      id: TAB_IMPL_ID,
      kind: TAB_KIND,
      priority: 'extension',
      title: () => t('title'),
      guide: [{ id: 'recordings', order: 40, title: () => t('title'), description: () => t('description') }],
    }))
    const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_IMPL_ID,
      locale: NS,
    }, RecordReplayTab))
    if (typeof disposeBody === 'function') disposers.push(disposeBody)

    openPanel = () => {
      try {
        rightbar.openTab(TAB_KIND)
        return true
      } catch (error) {
        // No mounted right-sidebar seat: outside a conversation, or on a global
        // main panel. The entry explains instead of switching the main area.
        console.warn('[record-replay] right sidebar is not available:', error)
        return false
      }
    }

    // Follow the on-screen Session so the panel can default to its workspace.
    if (rightbar.mounted !== undefined) {
      mountedSession = () => rightbar.mounted?.getSnapshot()
      const offMounted = rightbar.mounted.subscribe(refreshCurrentRoot)
      disposers.push(() => {
        offMounted()
        mountedSession = () => undefined
        refreshCurrentRoot()
      })
      refreshCurrentRoot()
    }

    return () => {
      openPanel = () => false
      for (const dispose of disposers.reverse()) dispose()
    }
  })

  // Current-session workspace lookup for the default project rule.
  ctx.inject(['workspaces', 'sessions'], (scope) => {
    const workspaces = scope.get<WorkspacesService>('workspaces')
    const sessions = scope.get<SessionsService>('sessions')
    if (workspaces === undefined) return
    resolveSessionRoot = (sessionId) => {
      const owner = workspaces.list.getSnapshot().items
        ?.find((workspace) => workspace.sessionIds?.includes(sessionId) === true)
      if (owner !== undefined) return owner.path
      return sessions?.list.getSnapshot().byId?.[sessionId]?.cwd
    }
    const offWorkspaces = workspaces.list.subscribe(refreshCurrentRoot)
    const offSessions = sessions?.list.subscribe(refreshCurrentRoot)
    refreshCurrentRoot()
    return () => {
      offWorkspaces()
      offSessions?.()
      resolveSessionRoot = undefined
      refreshCurrentRoot()
    }
  })

  // DSH's composed directory picker (native/browse backend already mounted).
  ctx.inject(['uiWorkspace'], (scope) => {
    const service = scope.get<UiWorkspaceService>('uiWorkspace')
    if (service === undefined) return
    pickDirectory = () => service.pickDirectory()
    return () => {
      pickDirectory = undefined
    }
  })

  /** Left-sidebar entry: opens the right-column tab, never selects a main panel. */
  function RecordReplayEntry({
    wide = true,
    watchActive = true,
    api = panelApi,
  }: {
    readonly wide?: boolean
    /** Disable polling in tests or in seats that should stay static. */
    readonly watchActive?: boolean
    readonly api?: PanelApi
  }): React.JSX.Element {
    const [hint, setHint] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [confirmDiscard, setConfirmDiscard] = React.useState(false)
    const [actionError, setActionError] = React.useState<string | undefined>()
    const preferredRoot = React.useSyncExternalStore(
      currentRootStore.subscribe,
      currentRootStore.getSnapshot,
      () => undefined,
    )
    const { recordings, error, remove } = useActiveRecordings(api, watchActive, preferredRoot)
    const active = recordings.find(recording => recording.root === preferredRoot) ?? recordings[0]
    const now = useNow(active !== undefined)

    React.useEffect(() => {
      if (!hint) return
      const timer = setTimeout(() => setHint(false), 4000)
      return () => clearTimeout(timer)
    }, [hint])

    React.useEffect(() => {
      setConfirmDiscard(false)
    }, [active?.recordingId])

    React.useEffect(() => {
      if (!confirmDiscard) return
      const timer = setTimeout(() => setConfirmDiscard(false), 4000)
      return () => clearTimeout(timer)
    }, [confirmDiscard])

    const live = active !== undefined
    const startedAt = live ? Date.parse(active.createdAt) : Number.NaN
    const elapsed = live && Number.isFinite(startedAt) ? formatElapsed(now - startedAt) : ''

    const stopRecording = async (): Promise<void> => {
      if (active === undefined || api.actions?.stop === undefined) return
      setBusy(true)
      setActionError(undefined)
      try {
        await api.actions.stop(active.root, active.recordingId)
        remove(active.recordingId)
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    }

    const discardRecording = async (): Promise<void> => {
      if (active === undefined || api.actions?.discard === undefined) return
      if (!confirmDiscard) {
        setConfirmDiscard(true)
        return
      }
      setBusy(true)
      setActionError(undefined)
      try {
        await api.actions.discard(active.root, active.recordingId)
        remove(active.recordingId)
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
        setConfirmDiscard(false)
      }
    }

    const message = actionError ?? error ?? (hint ? t('openHint') : undefined)

    return (
      <div className={live ? 'rr-entry-wrap rr-entry-wrap--live' : 'rr-entry-wrap'}>
        <div className="rr-entry-row">
          <button
            type="button"
            data-testid="record-replay-entry"
            className={wide ? 'rr-entry' : 'rr-entry rr-entry--rail'}
            aria-label={live ? `${t('title')} ${elapsed}` : t('title')}
            title={live
              ? `${active.title} · ${String(active.stepCount)} 步${active.suppressedCount === undefined || active.suppressedCount === 0 ? '' : ` · 已抑制 ${String(active.suppressedCount)} 步`} · ${elapsed}`
              : t('title')}
            onClick={() => setHint(!openPanel())}
          >
            <RecordReplayIcon size={wide ? 16 : 18} />
            {wide ? (
              <span className={live ? 'rr-entry__label rr-entry__label--live' : 'rr-entry__label'}>
                {live ? `录制中 ${elapsed}` : t('title')}
              </span>
            ) : null}
            {live ? <span className="rr-entry__dot" data-testid="record-replay-active" aria-hidden="true" /> : null}
          </button>
          {live && wide ? (
            <div className="rr-entry__controls">
              <button
                type="button"
                data-testid="record-replay-stop"
                className="rr-entry__control"
                title="停止录制"
                aria-label="停止录制"
                disabled={busy || api.actions?.stop === undefined}
                onClick={() => { void stopRecording() }}
              >
                <StopIcon />
              </button>
              <button
                type="button"
                data-testid="record-replay-discard"
                className={confirmDiscard ? 'rr-entry__control rr-entry__control--danger' : 'rr-entry__control'}
                title={confirmDiscard ? '再点一次确认丢弃' : '丢弃录制'}
                aria-label={confirmDiscard ? '确认丢弃录制' : '丢弃录制'}
                disabled={busy || api.actions?.discard === undefined}
                onClick={() => { void discardRecording() }}
              >
                <DiscardIcon />
              </button>
            </div>
          ) : null}
        </div>
        {message !== undefined ? (
          <p className="rr-entry__hint" role="status">{message}</p>
        ) : null}
      </div>
    )
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: PANEL_ID,
    order: 30,
    label: () => t('title'),
    locale: NS,
  }, RecordReplayEntry))
}

export { PANEL_ID, TAB_IMPL_ID, TAB_KIND, RecordReplayIcon, RecordReplayTab }
