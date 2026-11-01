/**
 * Portable session export (P0-3).
 *
 * The internal Store layout (`manifest.json` + `steps.jsonl`) is optimized for
 * replay. This exporter produces a small, self-describing directory for other
 * tools and audits:
 *
 *   session.json      metadata, end reason, counts, relative file names
 *   events.jsonl      session.started / agent.action / session.ended
 *   suppressed.jsonl  copied verbatim when the URL policy suppressed steps
 *
 * It intentionally does **not** pretend to be the reference human event stream:
 * events are `agent.action` records, not `mouse.click` / `window.changed`.
 * Nothing is written into the Store; destination must not already exist.
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

import type { BrowserAction } from '../core/api.js'
import type { ProjectedStep } from './projector.js'
import { RecordingServiceError } from './service.js'
import type { StoreManifest } from '../store/api.js'

export const SESSION_EXPORT_FORMAT = 'dsh-record-replay-session' as const
export const SESSION_EXPORT_VERSION = 1 as const

export interface SessionExportSource {
  readonly recordingId: string
  readonly destination: string
  readonly manifest: StoreManifest
  readonly steps: readonly ProjectedStep[]
  /** Raw `suppressed.jsonl` contents; omitted when no step was suppressed. */
  readonly suppressedText?: string
}

export interface SessionExportResult {
  readonly directory: string
  readonly fileCount: number
  readonly bytes: number
}

export interface SessionDocument {
  readonly format: typeof SESSION_EXPORT_FORMAT
  readonly formatVersion: typeof SESSION_EXPORT_VERSION
  readonly id: string
  readonly title: string
  readonly intent?: string
  readonly status: StoreManifest['status']
  readonly startedAt: string
  readonly endedAt?: string
  readonly endReason?: string
  readonly eventsPath: 'events.jsonl'
  readonly suppressedEventsPath?: 'suppressed.jsonl'
  readonly suppressedCount?: number
  readonly stepsSha256?: string
  readonly consent?: StoreManifest['consent']
  readonly source: {
    readonly driver: StoreManifest['driver']
    readonly browser: StoreManifest['browser']
  }
}

export type SessionEvent =
  | {
      readonly schemaVersion: 1
      readonly kind: 'session.started'
      readonly timestamp: string
      readonly recordingId: string
      readonly title: string
      readonly intent?: string
    }
  | {
      readonly schemaVersion: 1
      readonly kind: 'agent.action'
      readonly id: string
      readonly seq: number
      readonly timestamp: string
      readonly origin: string
      readonly action: BrowserAction
      readonly status: string
      readonly durationMs?: number
      readonly resultSummary?: unknown
      readonly error?: unknown
      readonly evidence?: readonly string[]
    }
  | {
      readonly schemaVersion: 1
      readonly kind: 'session.ended'
      readonly timestamp: string
      readonly status: StoreManifest['status']
      readonly endReason?: string
    }

export function buildSessionDocument(source: SessionExportSource): SessionDocument {
  const { manifest } = source
  const suppressedCount = manifest.suppressedCount ?? 0
  return {
    format: SESSION_EXPORT_FORMAT,
    formatVersion: SESSION_EXPORT_VERSION,
    id: manifest.recordingId,
    title: manifest.title,
    ...(manifest.intent === undefined ? {} : { intent: manifest.intent }),
    status: manifest.status,
    startedAt: manifest.createdAt,
    ...(manifest.completedAt === undefined ? {} : { endedAt: manifest.completedAt }),
    ...(manifest.endReason === undefined ? {} : { endReason: manifest.endReason }),
    eventsPath: 'events.jsonl',
    ...(suppressedCount > 0 ? { suppressedEventsPath: 'suppressed.jsonl' as const } : {}),
    ...(suppressedCount > 0 ? { suppressedCount } : {}),
    ...(manifest.stepsSha256 === undefined ? {} : { stepsSha256: manifest.stepsSha256 }),
    ...(manifest.consent === undefined ? {} : { consent: manifest.consent }),
    source: { driver: manifest.driver, browser: manifest.browser },
  }
}

export function buildSessionEvents(source: Pick<SessionExportSource, 'manifest' | 'steps'>): readonly SessionEvent[] {
  const { manifest } = source
  const events: SessionEvent[] = [
    {
      schemaVersion: SESSION_EXPORT_VERSION,
      kind: 'session.started',
      timestamp: manifest.createdAt,
      recordingId: manifest.recordingId,
      title: manifest.title,
      ...(manifest.intent === undefined ? {} : { intent: manifest.intent }),
    },
  ]
  const steps = [...source.steps].sort((left, right) => left.seq - right.seq)
  for (const step of steps) {
    events.push({
      schemaVersion: SESSION_EXPORT_VERSION,
      kind: 'agent.action',
      id: step.stepId,
      seq: step.seq,
      timestamp: new Date(step.startedAt).toISOString(),
      origin: step.origin,
      action: step.action,
      status: step.status,
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      ...(step.resultSummary === undefined ? {} : { resultSummary: step.resultSummary }),
      ...(step.error === undefined ? {} : { error: step.error }),
      ...(step.evidence === undefined ? {} : { evidence: step.evidence }),
    })
  }
  events.push({
    schemaVersion: SESSION_EXPORT_VERSION,
    kind: 'session.ended',
    timestamp: manifest.completedAt ?? manifest.updatedAt,
    status: manifest.status,
    ...(manifest.endReason === undefined ? {} : { endReason: manifest.endReason }),
  })
  return events
}

/** Write the export atomically: stage in a sibling directory, then rename. */
export async function writeSessionExport(source: SessionExportSource): Promise<SessionExportResult> {
  const destination = path.resolve(source.destination)
  const existing = await lstat(destination).catch(() => undefined)
  if (existing !== undefined) {
    throw new RecordingServiceError('INVALID_ARGUMENT', `export destination already exists: ${destination}`)
  }
  const staging = `${destination}${'.tmp-'}${randomUUID().replaceAll('-', '').slice(0, 8)}`
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 })
    const document = buildSessionDocument(source)
    const events = buildSessionEvents(source)
    const sessionText = `${JSON.stringify(document, null, 2)}\n`
    const eventsText = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
    const files: Array<{ readonly name: string; readonly text: string }> = [
      { name: 'session.json', text: sessionText },
      { name: 'events.jsonl', text: eventsText },
    ]
    if (source.suppressedText !== undefined && source.suppressedText.length > 0) {
      files.push({
        name: 'suppressed.jsonl',
        text: source.suppressedText.endsWith('\n') ? source.suppressedText : `${source.suppressedText}\n`,
      })
    }
    let bytes = 0
    for (const file of files) {
      bytes += Buffer.byteLength(file.text, 'utf8')
      await writeFile(path.join(staging, file.name), file.text, { mode: 0o600 })
    }
    await rename(staging, destination)
    return { directory: destination, fileCount: files.length, bytes }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof RecordingServiceError) throw error
    throw new RecordingServiceError('STORE_INIT_FAILED', `could not write session export: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}
