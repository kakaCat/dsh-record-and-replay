import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION,
  newStepId,
  type Principal,
  type StepId,
} from '../../src/core/api.js'
import { RecordingService } from '../../src/recording/index.js'
import { recoverStore } from '../../src/store/fs/recovery.js'
import { createFsRecordingStore } from '../../src/store/fs/jsonl-store.js'

const owner: Principal = { sessionId: 'session-recovery', agentId: 'agent-test' }

const startInput = {
  title: 'Recovery fixture',
  driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
  browser: { app: 'Chrome' },
}

function started(stepId: StepId) {
  return {
    type: 'step.started' as const,
    schemaVersion: SCHEMA_VERSION,
    stepId,
    seq: 1,
    callId: 'call-recovery',
    origin: 'agent' as const,
    action: { kind: 'navigate' as const, url: 'https://example.test/recovery' },
    startedAt: 1_000,
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('Recording recovery regression', () => {
  it('marks an unfinished recording interrupted and projects it after recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-recovery-regression-'))
    try {
      const store = await createFsRecordingStore({ root })
      const service = new RecordingService({ store })
      const recording = await service.start(startInput, owner)
      await service.record(started(newStepId()))

      // 模拟 Host/进程在动作中途退出：Store 级关闭把未完成的 Recording 收口为 interrupted。
      await store.close()
      const report = await recoverStore(root)
      expect(report.issues.some((issue) => issue.kind === 'unfinished-step')).toBe(true)

      const reopened = await createFsRecordingStore({ root })
      const manifest = await reopened.readManifest(recording.recordingId)
      expect(manifest.status).toBe('interrupted')
      expect(manifest.endReason).toBe('interrupted')

      const projection = new RecordingService({ store: reopened })
      const steps = await collect(projection.readSteps(recording.recordingId))
      expect(steps).toHaveLength(1)
      expect(steps[0]?.status).toBe('interrupted')
      expect(JSON.stringify(steps)).not.toContain('"status":"success"')
      await reopened.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
