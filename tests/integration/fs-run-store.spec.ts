import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, newRunId, newStepId, type RecordingId, type RunId } from '../../src/core/api.js'
import type { RunRecord } from '../../src/replay/index.js'
import { FsRunStore } from '../../src/plugin/fs-run-store.js'

const recordingId = 'rec_fs_run_store' as RecordingId

function runRecord(runId: RunId): RunRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    recordingId,
    recordingSha256: 'a'.repeat(64),
    driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
    status: 'preparing',
    startedAt: '2026-10-30T00:00:00.000Z',
  }
}

describe('FsRunStore', () => {
  it('persists run.json, steps and evidence across store instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fs-run-store-'))
    try {
      const runId = newRunId()
      const stepId = newStepId()
      const store = new FsRunStore({ root })
      const writer = await store.create(runRecord(runId))
      await writer.append({
        type: 'step.started',
        schemaVersion: SCHEMA_VERSION,
        stepId,
        seq: 1,
        callId: stepId,
        origin: 'replay',
        action: { kind: 'navigate', url: 'https://example.test/' },
        startedAt: 1_000,
      })
      await writer.append({
        type: 'step.finished',
        stepId,
        callId: stepId,
        status: 'success',
        finishedAt: 1_010,
        durationMs: 10,
      })
      await writer.writeEvidence('step-1/error.json', '{"ok":true}\n')
      await writer.finish({
        ...runRecord(runId),
        status: 'completed',
        finishedAt: '2026-10-30T00:00:01.000Z',
      })

      const reopened = new FsRunStore({ root })
      expect((await reopened.findRun(runId))?.status).toBe('completed')
      expect(await reopened.stepCountOf(recordingId, runId)).toBe(1)
      const steps = []
      for await (const event of reopened.readSteps(recordingId, runId)) steps.push(event)
      expect(steps.map(event => event.type)).toEqual(['step.started', 'step.finished'])
      expect((await reopened.listAllRuns()).map(record => record.runId)).toContain(runId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
