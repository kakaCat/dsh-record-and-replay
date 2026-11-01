import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION,
  newStepId,
  type JsonValue,
  type Principal,
  type StepId,
} from '../../src/core/api.js'
import { RecordingService } from '../../src/recording/index.js'
import { createFsRecordingStore } from '../../src/store/fs/jsonl-store.js'

const owner: Principal = { sessionId: 'session-integration', agentId: 'agent-test' }

const input = {
  title: 'Store integration recording',
  driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
  browser: { app: 'Chrome' },
}

async function withTempStore<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recording-service-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function started(stepId: StepId) {
  return {
    type: 'step.started' as const,
    schemaVersion: SCHEMA_VERSION,
    stepId,
    seq: 1,
    callId: 'call-store-integration',
    origin: 'agent' as const,
    action: { kind: 'setValue' as const, target: { role: 'textbox', name: 'Name' }, value: 'top secret' },
    startedAt: 1_000,
  }
}

function finished(stepId: StepId): { type: 'step.finished'; stepId: StepId; callId: string; status: 'success'; finishedAt: number; durationMs: number; resultSummary: JsonValue } {
  return {
    type: 'step.finished',
    stepId,
    callId: 'call-store-integration',
    status: 'success',
    finishedAt: 1_005,
    durationMs: 5,
    resultSummary: { password: 'top secret', ok: 'visible' },
  }
}

describe('RecordingService with FsRecordingStore', () => {
  it('persists one redacted logical step and projects it from disk', async () => {
    await withTempStore(async (root) => {
      const store = await createFsRecordingStore({ root })
      const service = new RecordingService({ store })
      const recording = await service.start(input, owner)
      const stepId = newStepId()

      await service.record(started(stepId))
      await service.record(finished(stepId))
      const stopped = await service.stop(recording.recordingId, owner)

      expect(stopped.status).toBe('completed')
      const manifest = await store.readManifest(recording.recordingId)
      expect(manifest.stepCount).toBe(1)
      expect(manifest.lastSeq).toBe(1)
      expect(manifest.stepsSha256).toMatch(/^[0-9a-f]{64}$/)

      const steps: string[] = []
      for await (const step of service.readSteps(recording.recordingId)) {
        steps.push(JSON.stringify(step))
      }
      expect(steps).toHaveLength(1)
      expect(steps[0]).toContain('"status":"success"')
      expect(steps.join('\n')).not.toContain('top secret')
      expect(steps.join('\n')).toContain('"password":"***"')

      await store.close()
    })
  })

  it('suppresses denied URLs into suppressed.jsonl and keeps steps.jsonl clean', async () => {
    await withTempStore(async (root) => {
      const store = await createFsRecordingStore({ root })
      const service = new RecordingService({ store, deniedUrlPatterns: ['bank.example'] })
      const recording = await service.start(input, owner)
      const stepId = newStepId()

      await service.record({
        ...started(stepId),
        callId: 'call-denied',
        action: { kind: 'navigate', url: 'https://bank.example/secret?q=1' },
      })
      await service.record({ ...finished(stepId), callId: 'call-denied' })
      await service.stop(recording.recordingId, owner)

      const manifest = await store.readManifest(recording.recordingId)
      expect(manifest.suppressedCount).toBe(1)
      expect(manifest.stepCount).toBe(0)

      const recordingDir = join(root, 'recordings', recording.recordingId)
      expect(await readFile(join(recordingDir, 'steps.jsonl'), 'utf8')).toBe('')
      const suppressed = await readFile(join(recordingDir, 'suppressed.jsonl'), 'utf8')
      expect(suppressed).toContain('"reason":"url_excluded"')
      expect(suppressed).not.toContain('bank.example')
      expect(suppressed).not.toContain('secret')

      await store.close()
    })
  })

  it('persists intent in manifest.json and reads it back', async () => {
    await withTempStore(async (root) => {
      const store = await createFsRecordingStore({ root })
      const service = new RecordingService({ store })
      const intent = '用 search 关键词核对首屏结果。'
      const recording = await service.start({ ...input, intent }, owner)
      await service.stop(recording.recordingId, owner)

      const manifestPath = join(root, 'recordings', recording.recordingId, 'manifest.json')
      const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as { intent?: string }
      expect(raw.intent).toBe(intent)
      expect((await store.readManifest(recording.recordingId)).intent).toBe(intent)
      expect((await service.get(recording.recordingId)).intent).toBe(intent)

      await store.close()
    })
  })
})
