/**
 * DSH workspace discovery and panel-local state for the project selector.
 *
 * DSH keeps the list of opened workspaces in its storage unit
 * (`~/.dsh/storages/workspace.json`). The panel treats that file as an
 * optional, read-only input: a missing or malformed store only means the
 * selector shows the current directory and explicit `--root` directories.
 *
 * The panel also remembers directories the user opened explicitly through the
 * picker (`~/.dsh/record-replay-panel.json`). This file belongs to the panel,
 * not to any project: it only lists roots, never recording data.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'

export interface DshWorkspaceRecord {
  readonly path: string
  readonly title: string
  readonly updatedAt?: string
}

/** One directory the user picked explicitly, newest first in the state file. */
export interface PanelRecentRoot {
  readonly path: string
  /** ISO timestamp of the last time this root was picked or selected. */
  readonly openedAt: string
}

interface WorkspaceTableEntry {
  readonly path?: unknown
  readonly title?: unknown
  readonly updatedAt?: unknown
}

const MAX_RECENT_ROOTS = 20

/** `~/.dsh` (or `$DSH_HOME`). */
export function dshHomeDirectory(): string {
  const home = process.env['DSH_HOME']
  return home !== undefined && home.length > 0 ? home : path.join(homedir(), '.dsh')
}

/** `~/.dsh/storages/workspace.json`, overridable for tests. */
export function defaultWorkspaceStorePath(): string {
  return path.join(dshHomeDirectory(), 'storages', 'workspace.json')
}

/** `~/.dsh/record-replay-panel.json`, overridable for tests. */
export function defaultPanelStatePath(): string {
  return path.join(dshHomeDirectory(), 'record-replay-panel.json')
}

/** True when `candidate` is the DSH home directory or lives below it. */
export function isDshInternalPath(candidate: string, dshHome = dshHomeDirectory()): boolean {
  const resolvedCandidate = path.resolve(candidate)
  const resolvedHome = path.resolve(dshHome)
  return resolvedCandidate === resolvedHome || resolvedCandidate.startsWith(`${resolvedHome}${path.sep}`)
}

/**
 * Whether a directory is a plausible project root for the selector.
 *
 * The panel host runs inside DSH, so its `process.cwd()` is often the desktop
 * profile (`~/.dsh/profiles/desktop`). That directory has no recordings and is
 * not a user project; showing it as "current" is what made the panel open on
 * an empty `desktop` project. The filesystem root and the user's home are
 * excluded for the same reason.
 */
export function isProjectCandidatePath(
  candidate: string,
  dshHome = dshHomeDirectory(),
  home = homedir(),
): boolean {
  const resolved = path.resolve(candidate)
  if (resolved === path.parse(resolved).root) return false
  if (resolved === path.resolve(home)) return false
  return !isDshInternalPath(resolved, dshHome)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the DSH workspace table; never throws. */
export async function readDshWorkspaces(filePath = defaultWorkspaceStorePath()): Promise<DshWorkspaceRecord[]> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return []
  }
  if (!isRecord(raw)) return []
  const tables = raw['tables']
  if (!isRecord(tables)) return []
  const workspaces = tables['workspaces']
  if (!isRecord(workspaces)) return []

  const records: DshWorkspaceRecord[] = []
  for (const value of Object.values(workspaces)) {
    if (!isRecord(value)) continue
    const entry = value as WorkspaceTableEntry
    if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) continue
    const title = typeof entry.title === 'string' && entry.title.length > 0
      ? entry.title
      : path.basename(entry.path)
    records.push({
      path: entry.path,
      title,
      ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}),
    })
  }
  return records
}

function parseRecentRoots(value: unknown): PanelRecentRoot[] {
  if (!isRecord(value)) return []
  const roots = value['roots']
  if (!Array.isArray(roots)) return []
  const parsed: PanelRecentRoot[] = []
  for (const entry of roots) {
    if (!isRecord(entry)) continue
    if (typeof entry['path'] !== 'string' || !path.isAbsolute(entry['path'])) continue
    const openedAt = typeof entry['openedAt'] === 'string' ? entry['openedAt'] : undefined
    if (openedAt === undefined) continue
    parsed.push({ path: entry['path'], openedAt })
  }
  return parsed.slice(0, MAX_RECENT_ROOTS)
}

/** Read the panel's own recent-root list; never throws. */
export async function readPanelRecentRoots(filePath = defaultPanelStatePath()): Promise<PanelRecentRoot[]> {
  try {
    return parseRecentRoots(JSON.parse(await readFile(filePath, 'utf8')))
  } catch {
    return []
  }
}

/** Persist the recent-root list through a same-directory temp file + rename. */
export async function writePanelRecentRoots(
  roots: readonly PanelRecentRoot[],
  filePath = defaultPanelStatePath(),
): Promise<void> {
  const unique = new Map<string, PanelRecentRoot>()
  for (const entry of roots) {
    if (!path.isAbsolute(entry.path)) continue
    if (!unique.has(entry.path)) unique.set(entry.path, entry)
  }
  const payload = {
    version: 1,
    roots: [...unique.values()].slice(0, MAX_RECENT_ROOTS),
  }
  await mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temp, filePath)
  } catch (error) {
    // Leave the previous state file intact; drop the half-written temp file.
    try {
      await unlink(temp)
    } catch {
      // best effort
    }
    throw error
  }
}

/** Explicit roots from the CLI/environment, newest semantics = caller order. */
export function explicitPanelRoots(envValue = process.env['DSH_RECORD_REPLAY_PANEL_ROOTS']): string[] {
  if (envValue === undefined || envValue.trim().length === 0) return []
  return envValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}
