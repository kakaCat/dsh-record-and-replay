import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createWorkspaceStoreRuntime } from '../../src/bootstrap/runtime.js'
import { SCHEMA_VERSION, newStepId } from '../../src/core/api.js'
import { resolveHostConfig } from '../../src/host/config.js'
import { RecordingService } from '../../src/recording/index.js'
import { createFsRecordingStore } from '../../src/store/fs/jsonl-store.js'

describe('workspace runtime recovery', () => {
  it('repairs a crashed recording while assembling the workspace runtime', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'dsh-runtime-recovery-'))
    const storeRoot = path.join(workspaceRoot, '.dsh', 'record-replay')
    try {
      const store = await createFsRecordingStore({ root: storeRoot })
      const recordings = new RecordingService({ store, maxDurationSeconds: 0 })
      const recording = await recordings.start({
        title: 'crashed recording',
        driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
        browser: { app: 'Chrome' },
      }, { sessionId: 'session-a', agentId: 'agent-a' })

      // Simulate a process killed mid-recording: the manifest stays "recording",
      // the writer is gone and the heartbeat lock is left behind by a dead pid.
      await unlink(path.join(storeRoot, 'recordings', recording.recordingId, 'recording.lock'))

      const runtime = await createWorkspaceStoreRuntime({
        workspaceRoot,
        config: resolveHostConfig({}),
      })
      const manifest = await runtime.store.readManifest(recording.recordingId)
      expect(manifest.status).toBe('interrupted')
      expect(manifest.endReason).toBe('interrupted')
      expect(runtime.recovery?.repairedRecordings).toContain(recording.recordingId)

      await runtime.store.close()
      await store.close().catch(() => undefined)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('wires the URL privacy policy from host config into the recording service', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'dsh-runtime-privacy-'))
    const storeRoot = path.join(workspaceRoot, '.dsh', 'record-replay')
    try {
      const runtime = await createWorkspaceStoreRuntime({
        workspaceRoot,
        config: resolveHostConfig({ recording: { privacy: { deniedUrlPatterns: ['bank.example'] } } }),
      })
      const owner = { sessionId: 'session-a', agentId: 'agent-a' }
      const recording = await runtime.recordings.start({
        title: 'privacy wiring',
        driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
        browser: { app: 'Chrome' },
      }, owner)
      const stepId = newStepId()
      await runtime.recordings.record({
        type: 'step.started',
        schemaVersion: SCHEMA_VERSION,
        stepId,
        seq: 1,
        callId: 'call-privacy',
        origin: 'agent',
        action: { kind: 'navigate', url: 'https://bank.example/secret' },
        startedAt: 1_000,
      })
      await runtime.recordings.record({
        type: 'step.finished',
        stepId,
        callId: 'call-privacy',
        status: 'success',
        finishedAt: 1_010,
        durationMs: 10,
      })
      await runtime.recordings.stop(recording.recordingId, owner)

      const manifest = await runtime.store.readManifest(recording.recordingId)
      expect(manifest.suppressedCount).toBe(1)
      const suppressed = await readFile(
        path.join(storeRoot, 'recordings', recording.recordingId, 'suppressed.jsonl'),
        'utf8',
      )
      expect(suppressed).toContain('url_excluded')
      expect(suppressed).not.toContain('bank.example')
      await runtime.store.close()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
