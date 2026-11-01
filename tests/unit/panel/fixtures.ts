import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

export interface FixtureRun {
  readonly runId: string
  readonly status: 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly failedStepId?: string
  readonly video?: Uint8Array
}

export interface FixtureRecording {
  readonly recordingId: string
  readonly title: string
  /** Persisted manifest intent; omitted to emulate recordings written before this field existed. */
  readonly intent?: string
  readonly site?: string
  readonly status?: 'recording' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
  readonly endReason?: 'tool_stopped' | 'max_duration' | 'cancelled' | 'failed' | 'interrupted'
  readonly suppressedCount?: number
  readonly stepCount?: number
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly urls?: readonly string[]
  readonly runs?: readonly FixtureRun[]
}

export interface FixtureProject {
  readonly root: string
  readonly cleanup: () => Promise<void>
}

const DEFAULT_CREATED = '2026-10-31T10:00:00.000Z'
const DEFAULT_UPDATED = '2026-10-31T10:05:00.000Z'

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function stepEvents(recordingId: string, urls: readonly string[]): string {
  const lines: string[] = []
  urls.forEach((url, index) => {
    const seq = index + 1
    lines.push(JSON.stringify({
      type: 'step.started',
      schemaVersion: 1,
      stepId: `step_${recordingId}_${String(seq)}`,
      seq,
      callId: `call_${recordingId}_${String(seq)}`,
      origin: 'agent',
      action: { kind: 'navigate', url },
      startedAt: 1_793_448_000_000 + seq,
    }))
    lines.push(JSON.stringify({
      type: 'step.finished',
      stepId: `step_${recordingId}_${String(seq)}`,
      callId: `call_${recordingId}_${String(seq)}`,
      status: 'success',
      finishedAt: 1_793_448_000_100 + seq,
      durationMs: 100,
    }))
  })
  return `${lines.join('\n')}\n`
}

export async function writeRecording(projectRoot: string, fixture: FixtureRecording): Promise<void> {
  const dir = path.join(projectRoot, '.dsh', 'record-replay', 'recordings', fixture.recordingId)
  await mkdir(path.join(dir, 'runs'), { recursive: true })
  const createdAt = fixture.createdAt ?? DEFAULT_CREATED
  const updatedAt = fixture.updatedAt ?? DEFAULT_UPDATED
  const stepCount = fixture.stepCount ?? (fixture.urls?.length ?? 0)
  await writeJson(path.join(dir, 'manifest.json'), {
    schemaVersion: 1,
    recordingId: fixture.recordingId,
    title: fixture.title,
    ...(fixture.intent === undefined ? {} : { intent: fixture.intent }),
    status: fixture.status ?? 'completed',
    ...(fixture.endReason === undefined ? {} : { endReason: fixture.endReason }),
    ...(fixture.suppressedCount === undefined ? {} : { suppressedCount: fixture.suppressedCount }),
    ...(fixture.site === undefined ? {} : { site: fixture.site }),
    ownerSessionId: 'session-panel-test',
    driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
    browser: { app: 'Chrome' },
    createdAt,
    updatedAt,
    lastSeq: stepCount,
    stepCount,
    completedAt: updatedAt,
    stepsSha256: '0'.repeat(64),
  })
  await writeFile(path.join(dir, 'steps.jsonl'), stepEvents(fixture.recordingId, fixture.urls ?? ['https://example.test/']), 'utf8')
  if ((fixture.status ?? 'completed') === 'recording') {
    const now = Date.now()
    await writeJson(path.join(dir, 'recording.lock'), {
      lockId: 'lock-panel-test',
      recordingId: fixture.recordingId,
      ownerSessionId: 'session-panel-test',
      pid: 1,
      startedAt: now,
      heartbeatAt: now,
    })
  }

  for (const run of fixture.runs ?? []) {
    const runPath = path.join(dir, 'runs', run.runId)
    await mkdir(path.join(runPath, 'evidence'), { recursive: true })
    await writeFile(path.join(runPath, 'steps.jsonl'), '', 'utf8')
    await writeJson(path.join(runPath, 'run.json'), {
      schemaVersion: 1,
      runId: run.runId,
      recordingId: fixture.recordingId,
      recordingSha256: '0'.repeat(64),
      driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
      status: run.status,
      startedAt: run.startedAt ?? '2026-10-31T11:00:00.000Z',
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      ...(run.failedStepId === undefined ? {} : { currentStepId: run.failedStepId }),
      ...(run.errorCode === undefined
        ? {}
        : { error: { code: run.errorCode, message: run.errorMessage ?? 'failed' } }),
    })
    if (run.video !== undefined) {
      await mkdir(path.join(runPath, 'video'), { recursive: true })
      await writeFile(path.join(runPath, 'video', 'replay.webm'), run.video)
    }
  }
}

/** Create a temporary project root with the standard `.dsh/record-replay` layout. */
export async function createFixtureProject(fixtures: readonly FixtureRecording[] = []): Promise<FixtureProject> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-panel-test-'))
  for (const fixture of fixtures) {
    await writeRecording(root, fixture)
  }
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function writeIndex(projectRoot: string, value: unknown): Promise<void> {
  await writeJson(path.join(projectRoot, '.dsh', 'record-replay', 'index.json'), value)
}
