/**
 * Default-project rule for the panel's project selector.
 *
 * Order (the first hit wins):
 *   1. the root the user picked last time (localStorage), but only when it is
 *      still a real project with recordings and is not a DSH-internal path;
 *   2. the workspace of the current DSH session, when it has recordings —
 *      opening the panel from a fresh workspace should still land on data;
 *   3. the host's current directory (standalone `panel --root`/CLI);
 *   4. the first project that actually has recording directories;
 *   5. the first project in the host order.
 *
 * The remembered root is deliberately *not* deleted when it fails validation:
 * it may be a project the user selected again later, and the stored value must
 * survive a startup that opened on another project.
 *
 * Empty project lists produce `undefined`, so the panel shows its empty state
 * instead of pretending some directory is selected.
 */
import type { PanelProjectSummary } from '../../../panel/types.js'

export const REMEMBERED_ROOT_KEY = 'dsh-record-replay:last-root'

export interface DefaultRootInput {
  readonly projects: readonly PanelProjectSummary[]
  readonly lastRoot?: string
  readonly preferredRoot?: string
}

/**
 * Roots that are directories DSH itself owns, the user's home, or the
 * filesystem root. A stored value pointing here is stale state from an older
 * build (or a picker mistake), never a usable project.
 *
 * The client cannot read the host's home directory, so the common POSIX home
 * layouts are recognised structurally. DSH's own home is detected by the
 * `.dsh` path segment, which covers the default `~/.dsh/**` tree.
 */
export function isProtectedPanelRoot(root: string): boolean {
  const normalized = normalizeRoot(root).replace(/\\/gu, '/')
  if (normalized.length === 0) return true
  if (normalized === '/' || normalized === '~') return true

  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  if (segments.includes('.dsh')) return true

  if (normalized === '/root' || normalized === '/var/root') return true
  if (/^\/(?:Users|home)\/[^/]+$/u.test(normalized)) return true
  if (/^[A-Za-z]:\/Users\/[^/]+$/u.test(normalized)) return true

  return false
}

function normalizeRoot(value: string): string {
  let normalized = value.trim()
  while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

function knownRoot(projects: readonly PanelProjectSummary[], candidate: string | undefined): string | undefined {
  if (candidate === undefined || candidate.length === 0) return undefined
  const normalized = normalizeRoot(candidate)
  return projects.find((project) => normalizeRoot(project.root) === normalized)?.root
}

/**
 * Priority 1 candidate: a remembered root must still exist in the project
 * list, must not be a DSH/user/system root, and must have at least one
 * recording directory. `recordingCount === undefined` means the host did not
 * measure it (older callers), which cannot be verified and is therefore not
 * promoted to priority 1.
 */
function rememberedRoot(projects: readonly PanelProjectSummary[], candidate: string | undefined): string | undefined {
  const known = knownRoot(projects, candidate)
  if (known === undefined) return undefined
  if (isProtectedPanelRoot(known)) return undefined
  const project = projects.find((entry) => entry.root === known)
  if ((project?.recordingCount ?? 0) <= 0) return undefined
  return known
}

export function pickDefaultRoot(input: DefaultRootInput): string | undefined {
  const { projects, lastRoot, preferredRoot } = input
  if (projects.length === 0) return undefined

  const remembered = rememberedRoot(projects, lastRoot)
  if (remembered !== undefined) return remembered

  const sessionRoot = knownRoot(projects, preferredRoot)
  if (sessionRoot !== undefined) {
    const project = projects.find((entry) => entry.root === sessionRoot)
    if ((project?.recordingCount ?? 0) > 0) return sessionRoot
  }

  const current = projects.find((project) => project.isCurrent === true)
  if (current !== undefined) return current.root

  const withRecordings = projects.find((project) => (project.recordingCount ?? 0) > 0)
  if (withRecordings !== undefined) return withRecordings.root

  return projects[0]?.root
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Last root the user selected explicitly; never throws. */
export function readRememberedRoot(target: Storage | undefined = storage()): string | undefined {
  try {
    const value = target?.getItem(REMEMBERED_ROOT_KEY)
    return value !== null && value !== undefined && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** Remember an explicit selection; never throws (private mode blocks writes). */
export function rememberRoot(root: string, target: Storage | undefined = storage()): void {
  try {
    target?.setItem(REMEMBERED_ROOT_KEY, root)
  } catch {
    // Losing the preference is harmless; the host order still applies.
  }
}

/** Forget a stored root, for tests and "reset" affordances. */
export function forgetRememberedRoot(target: Storage | undefined = storage()): void {
  try {
    target?.removeItem(REMEMBERED_ROOT_KEY)
  } catch {
    // ignore
  }
}
