import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SCHEMA_VERSION, newStepId, type Principal } from '../../src/core/api.js'
import { RecordingService } from '../../src/recording/index.js'
import { writeSessionExport } from '../../src/recording/session-export.js'
import { createFsRecordingStore } from '../../src/store/fs/jsonl-store.js'

const owner: Principal = { sessionId: 'session-export', agentId: 'agent-export' }
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-session-export-'))
  roots.push(root)
  return root
}

describe('session export', () => {
  it('writes session.json, agent actions and the suppressed channel atomically', async () => {
    const workspaceRoot = await workspace()
    const storeRoot = path.join(workspaceRoot, '.dsh', 'record-replay')
    const store = await createFsRecordingStore({ root: storeRoot })
    const service = new RecordingService({ store, deniedUrlPatterns: ['bank.example'] })
    const recording = await service.start({
      title: 'Export demo',
      intent: 'Export one workflow.',
      driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
      browser: { app: 'Chrome' },
    }, owner)

    const open = newStepId()
    await service.record({
      type: 'step.started',
      schemaVersion: SCHEMA_VERSION,
      stepId: open,
      seq: 1,
      callId: 'call-open',
      origin: 'agent',
      action: { kind: 'navigate', url: 'https://shop.example/' },
      startedAt: 1_000,
    })
    await service.record({
      type: 'step.finished',
      stepId: open,
      callId: 'call-open',
      status: 'success',
      finishedAt: 1_100,
      durationMs: 100,
    })

    const type = newStepId()
    await service.record({
      type: 'step.started',
      schemaVersion: SCHEMA_VERSION,
      stepId: type,
      seq: 2,
      callId: 'call-type',
      origin: 'agent',
      action: { kind: 'setValue', target: { role: 'textbox', name: 'Name' }, value: 'top secret' },
      startedAt: 2_000,
    })
    await service.record({
      type: 'step.finished',
      stepId: type,
      callId: 'call-type',
      status: 'success',
      finishedAt: 2_100,
      durationMs: 100,
    })

    const denied = newStepId()
    await service.record({
      type: 'step.started',
      schemaVersion: SCHEMA_VERSION,
      stepId: denied,
      seq: 3,
      callId: 'call-denied',
      origin: 'agent',
      action: { kind: 'navigate', url: 'https://bank.example/secret' },
      startedAt: 3_000,
    })
    await service.record({
      type: 'step.finished',
      stepId: denied,
      callId: 'call-denied',
      status: 'success',
      finishedAt: 3_100,
      durationMs: 100,
    })
    await service.stop(recording.recordingId, owner)

    const manifest = await store.readManifest(recording.recordingId)
    const steps = []
    for await (const step of service.readSteps(recording.recordingId)) steps.push(step)
    const suppressedText = await readFile(
      path.join(storeRoot, 'recordings', recording.recordingId, 'suppressed.jsonl'),
      'utf8',
    )
    const destination = path.join(workspaceRoot, 'export', 'session')
    const result = await writeSessionExport({
      recordingId: recording.recordingId,
      destination,
      manifest,
      steps,
      suppressedText,
    })

    expect(result).toMatchObject({ directory: destination, fileCount: 3 })
    const session = JSON.parse(await readFile(path.join(destination, 'session.json'), 'utf8')) as Record<string, unknown>
    expect(session).toMatchObject({
      format: 'dsh-record-replay-session',
      formatVersion: 1,
      id: recording.recordingId,
      status: 'completed',
      endReason: 'tool_stopped',
      suppressedCount: 1,
      eventsPath: 'events.jsonl',
      suppressedEventsPath: 'suppressed.jsonl',
    })
    expect(session['endedAt']).toEqual(expect.any(String))

    const events = (await readFile(path.join(destination, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.map(event => event['kind'])).toEqual([
      'session.started',
      'agent.action',
      'agent.action',
      'session.ended',
    ])
    expect(events.filter(event => event['kind'] === 'agent.action')).toHaveLength(2)
    expect(JSON.stringify(events)).not.toContain('window.changed')
    expect(JSON.stringify(events)).not.toContain('mouse.click')
    expect(events.map(event => event['kind'])).not.toContain('suppressed')
    expect(JSON.stringify(events)).not.toContain('top secret')

    const exportedSuppressed = await readFile(path.join(destination, 'suppressed.jsonl'), 'utf8')
    expect(exportedSuppressed).toContain('url_excluded')
    expect(exportedSuppressed).not.toContain('bank.example')

    await expect(writeSessionExport({
      recordingId: recording.recordingId,
      destination,
      manifest,
      steps,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await store.close()
  })
})
