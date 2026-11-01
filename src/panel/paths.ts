/**
 * Panel path discipline.
 *
 * The panel is a cross-project browser: every `root` comes from HTTP, so it is
 * checked against a whitelist (DSH workspaces + explicit `--root` directories)
 * *after* symlink resolution. Recording/run ids are matched against the Core id
 * grammar before they are ever joined into a path. No request may name a file
 * directly; video is addressed by `runId` and resolved inside the run directory.
 */
import { realpath, stat } from 'node:fs/promises'
import * as path from 'node:path'

import { PanelError } from './errors.js'

export const PANEL_STORE_SEGMENTS = ['.dsh', 'record-replay'] as const
export const RECORDING_ID_PATTERN = /^rec_[A-Za-z0-9_]+$/u
export const RUN_ID_PATTERN = /^run_[A-Za-z0-9_]+$/u
export const VIDEO_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:webm|mp4)$/u

/** `<project>/.dsh/record-replay` */
export function storeRoot(projectRoot: string): string {
  return path.join(projectRoot, ...PANEL_STORE_SEGMENTS)
}

export function recordingsDir(projectRoot: string): string {
  return path.join(storeRoot(projectRoot), 'recordings')
}

export function panelIndexPath(projectRoot: string): string {
  return path.join(storeRoot(projectRoot), 'index.json')
}

/** `<project>/.dsh/record-replay/trash` — the safe delete destination. */
export function trashDir(projectRoot: string): string {
  return path.join(storeRoot(projectRoot), 'trash')
}

/**
 * One trash entry name: `<recordingId>-<compact UTC timestamp>`, for example
 * `rec_abc-20261101T102350123Z`.
 *
 * The filesystem-safe compact stamp avoids `:`/`.` (awkward in shell paths and
 * on some filesystems) while staying lexicographically sortable.
 */
export function trashEntryName(recordingId: string, now: number = Date.now()): string {
  const safeId = assertSafeRecordingId(recordingId)
  const stamp = new Date(now).toISOString().replace(/[-:.]/gu, '')
  return `${safeId}-${stamp}`
}

export function recordingDir(projectRoot: string, recordingId: string): string {
  return path.join(recordingsDir(projectRoot), assertSafeRecordingId(recordingId))
}

export function runDir(projectRoot: string, recordingId: string, runId: string): string {
  return path.join(recordingDir(projectRoot, recordingId), 'runs', assertSafeRunId(runId))
}

export function isRecordingId(value: unknown): value is string {
  return typeof value === 'string' && RECORDING_ID_PATTERN.test(value)
}

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value)
}

export function assertSafeRecordingId(value: unknown): string {
  if (!isRecordingId(value)) {
    throw new PanelError(
      'PANEL_INVALID_ID',
      'recording id must match ^rec_[A-Za-z0-9_]+$',
      400,
    )
  }
  return value
}

export function assertSafeRunId(value: unknown): string {
  if (!isRunId(value)) {
    throw new PanelError('PANEL_INVALID_ID', 'run id must match ^run_[A-Za-z0-9_]+$', 400)
  }
  return value
}

/** True when `candidate` is `root` or lives below it (both resolved). */
export function isContained(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (resolvedCandidate === resolvedRoot) return true
  return resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
}

export function assertContained(root: string, candidate: string, what: string): string {
  const resolved = path.resolve(candidate)
  if (!isContained(root, resolved)) {
    throw new PanelError('PANEL_ROOT_DENIED', `${what} escapes the project root`, 403)
  }
  return resolved
}

/** Canonical directory path, or undefined when the path does not exist / is not a directory. */
export async function canonicalDirectory(input: string): Promise<string | undefined> {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) return undefined
  try {
    const info = await stat(input)
    if (!info.isDirectory()) return undefined
    return await realpath(input)
  } catch {
    return undefined
  }
}

/** Canonical file path, or undefined when it does not exist / is not a regular file. */
export async function canonicalFile(input: string): Promise<string | undefined> {
  try {
    const info = await stat(input)
    if (!info.isFile()) return undefined
    return await realpath(input)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Site derivation
// ---------------------------------------------------------------------------

const SECOND_LEVEL_SUFFIXES = new Set([
  'com.cn',
  'com.hk',
  'com.tw',
  'com.au',
  'com.br',
  'com.tr',
  'co.uk',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.in',
  'org.uk',
  'net.cn',
  'org.cn',
])

const SITE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  bilibili: 'B站',
  saucedemo: 'SauceDemo',
  wikipedia: 'Wikipedia',
  github: 'GitHub',
  google: 'Google',
  youtube: 'YouTube',
  x: 'X',
  twitter: 'X',
}

/** `search.bilibili.com` → `bilibili`; `www.saucedemo.com` → `saucedemo`. */
export function siteFromHost(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/^www\./u, '')
  if (normalized.length === 0) return 'uncategorized'
  if (normalized === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(normalized)) return normalized
  const parts = normalized.split('.').filter((part) => part.length > 0)
  if (parts.length <= 1) return normalized
  const lastTwo = parts.slice(-2).join('.')
  const label = SECOND_LEVEL_SUFFIXES.has(lastTwo)
    ? parts[parts.length - 3]
    : parts[parts.length - 2]
  return label ?? normalized
}

/** Site token for a URL, or undefined when it cannot be parsed. */
export function siteFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return siteFromHost(url.hostname)
  } catch {
    return undefined
  }
}

/** Human display name for a category site token. */
export function siteDisplayName(site: string): string {
  return SITE_DISPLAY_NAMES[site] ?? site
}

/** A stable, path-safe category id derived from the site token. */
export function categoryIdForSite(site: string): string {
  const slug = site
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return slug.length === 0 ? 'uncategorized' : slug
}

/** Fallback site for recordings without a navigable URL. */
export function siteFromTitle(title: string): string {
  const separator = title.search(/[：:]/u)
  const prefix = separator > 0 ? title.slice(0, separator).trim() : ''
  if (prefix.length > 0 && /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u.test(prefix)) {
    return siteFromHost(prefix)
  }
  if (/^desktop\b/iu.test(title)) return 'desktop'
  return 'uncategorized'
}

export function isSafeVideoFile(name: string): boolean {
  return VIDEO_FILE_PATTERN.test(name)
}
