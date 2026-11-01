import { describe, expect, it, vi } from 'vitest'
import {
  SCHEMA_VERSION,
  newStepId,
  type BrowserAction,
  type JsonValue,
  type Principal,
  type StepId,
} from '../../../src/core/api.js'
import { REDACTED_VALUE } from '../../../src/recording/redaction.js'
import { RecordingService, RecordingServiceError } from '../../../src/recording/service.js'
import {
  StoreError,
  type RecordingStore,
  type RecordingWriter,
  type StepCursor,
  type StoreManifest,
  type StoreStepEvent,
  type StoreStepFinished,
  type StoreStepStarted,
  type StoredStepEvent,
  type SuppressedStepRecord,
} from '../../../src/store/api.js'

class FakeWriter implements RecordingWriter {
  readonly events: StoreStepEvent[] = []
  readonly suppressed: SuppressedStepRecord[] = []
  closedStatus: 'completed' | 'failed' | 'interrupted' | 'cancelled' | undefined
  closedEndReason: string | undefined
  private closed = false

  manifest: StoreManifest

  constructor(
    private readonly store: FakeStore,
    manifest: StoreManifest,
  ) {
    this.manifest = manifest
  }

  get recordingId(): StoreManifest['recordingId'] {
    return this.manifest.recordingId
  }

  async append(event: StoreStepEvent): Promise<void> {
    if (this.closed) {
      throw new StoreError('RECORDING_ALREADY_COMPLETED', 'writer is closed', { recordingId: this.manifest.recordingId })
    }
    this.events.push(event)
    const started = this.events.filter((candidate) => candidate.type === 'step.started')
    const lastSeq = started.reduce((max, candidate) => Math.max(max, candidate.seq), 0)
    this.manifest = { ...this.manifest, lastSeq, stepCount: started.length }
    this.store.upsert(this.manifest)
  }

  async appendSuppressed(record: SuppressedStepRecord): Promise<void> {
    this.suppressed.push(record)
    this.manifest = { ...this.manifest, suppressedCount: this.suppressed.length }
    this.store.upsert(this.manifest)
  }

  async writeAsset(input: { path: string }): Promise<string> {
    return input.path
  }

  async close(input?: { status?: 'completed' | 'failed' | 'interrupted' | 'cancelled'; endReason?: string }): Promise<StoreManifest> {
    this.closed = true
    this.closedStatus = input?.status ?? 'completed'
    this.closedEndReason = input?.endReason
    const next: StoreManifest = {
      ...this.manifest,
      status: this.closedStatus,
      ...(input?.endReason === undefined ? {} : { endReason: input.endReason as NonNullable<StoreManifest['endReason']> }),
      completedAt: new Date().toISOString(),
    }
    this.manifest = next
    this.store.upsert(next)
    return next
  }
}

class FakeStore implements RecordingStore {
  readonly root = '/tmp/fake-store'
  private readonly manifests = new Map<string, StoreManifest>()
  private readonly writers = new Map<string, FakeWriter>()

  async open(input: { manifest: StoreManifest }): Promise<RecordingWriter> {
    this.upsert(input.manifest)
    const writer = new FakeWriter(this, input.manifest)
    this.writers.set(input.manifest.recordingId, writer)
    return writer
  }

  async readManifest(recordingId: StoreManifest['recordingId']): Promise<StoreManifest> {
    const manifest = this.manifests.get(recordingId)
    if (manifest === undefined) {
      throw new StoreError('RECORDING_NOT_FOUND', 'recording not found', { recordingId })
    }
    return manifest
  }

  async *readSteps(recordingId: StoreManifest['recordingId'], _cursor?: StepCursor): AsyncIterable<StoredStepEvent> {
    const writer = this.writers.get(recordingId)
    if (writer === undefined) {
      throw new StoreError('RECORDING_NOT_FOUND', 'recording not found', { recordingId })
    }
    for (const [index, event] of writer.events.entries()) {
      yield { ...event, line: index + 1 }
    }
  }

  async listRecordings(): Promise<readonly StoreManifest[]> {
    return [...this.manifests.values()]
  }

  async close(): Promise<void> {}

  writerOf(recordingId: string): FakeWriter {
    const writer = this.writers.get(recordingId)
    if (writer === undefined) throw new Error(`missing fake writer ${recordingId}`)
    return writer
  }

  upsert(manifest: StoreManifest): void {
    this.manifests.set(manifest.recordingId, manifest)
  }
}

const principal = (sessionId: string): Principal => ({ sessionId, agentId: 'agent-test' })

const startInput = {
  title: 'Recording test',
  driver: { id: 'cua-driver', version: '0.38.0', transport: 'mcp' },
  browser: { app: 'Chrome' },
}

function started(stepId: StepId, callId: string, action: BrowserAction): StoreStepStarted {
  return {
    type: 'step.started',
    schemaVersion: SCHEMA_VERSION,
    stepId,
    seq: 1,
    callId,
    origin: 'agent',
    action,
    startedAt: 1_000,
  }
}

function finished(stepId: StepId, callId: string, resultSummary?: JsonValue): StoreStepFinished {
  const base = {
    type: 'step.finished',
    stepId,
    callId,
    status: 'success',
    finishedAt: 1_010,
    durationMs: 10,
  } as const
  return resultSummary === undefined ? base : { ...base, resultSummary }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('RecordingService', () => {
  it('persists one started/finished pair and completes on stop', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)
    const stepId = newStepId()

    await service.record(started(stepId, 'call-1', { kind: 'navigate', url: 'https://example.test' }))
    await service.record(finished(stepId, 'call-1'))
    const stopped = await service.stop(recording.recordingId, owner)

    expect(stopped.status).toBe('completed')
    expect(store.writerOf(recording.recordingId).closedStatus).toBe('completed')
    expect(store.writerOf(recording.recordingId).events).toHaveLength(2)
  })

  it('records the end reason on stop and exposes it on the descriptor', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)

    const stopped = await service.stop(recording.recordingId, owner)

    expect(stopped.endReason).toBe('tool_stopped')
    expect((await store.readManifest(recording.recordingId)).endReason).toBe('tool_stopped')
  })

  it('auto-stops at maxDurationSeconds and records max_duration', async () => {
    vi.useFakeTimers()
    try {
      const store = new FakeStore()
      const service = new RecordingService({ store, maxDurationSeconds: 30 })
      const owner = principal('session-a')
      const recording = await service.start(startInput, owner)

      await vi.advanceTimersByTimeAsync(30_000)

      const manifest = await store.readManifest(recording.recordingId)
      expect(manifest.status).toBe('completed')
      expect(manifest.endReason).toBe('max_duration')
      expect(store.writerOf(recording.recordingId).closedStatus).toBe('completed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not auto-stop when maxDurationSeconds is 0', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store, maxDurationSeconds: 0 })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)

    await new Promise(resolve => setTimeout(resolve, 40))
    expect((await store.readManifest(recording.recordingId)).status).toBe('recording')
    await service.stop(recording.recordingId, owner)
  })

  it('discard marks the recording cancelled and keeps the evidence', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)
    const stepId = newStepId()
    await service.record(started(stepId, 'call-1', { kind: 'navigate', url: 'https://example.test' }))
    await service.record(finished(stepId, 'call-1'))

    const discarded = await service.discard(recording.recordingId, owner)

    expect(discarded.status).toBe('cancelled')
    expect(discarded.endReason).toBe('cancelled')
    expect(store.writerOf(recording.recordingId).closedStatus).toBe('cancelled')
    expect(store.writerOf(recording.recordingId).events).toHaveLength(2)
    // A second discard is idempotent and returns the terminal descriptor.
    expect((await service.discard(recording.recordingId, owner)).status).toBe('cancelled')
  })

  it('suppresses a denied navigate and every following step until an allowed navigate', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store, deniedUrlPatterns: ['bank.example'] })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)

    const denied = newStepId()
    await service.record(started(denied, 'call-1', { kind: 'navigate', url: 'https://bank.example/login' }))
    await service.record(finished(denied, 'call-1'))

    const click = newStepId()
    await service.record(started(click, 'call-2', { kind: 'click', target: { role: 'button', name: 'Pay' } }))
    await service.record(finished(click, 'call-2'))

    const allowed = newStepId()
    await service.record(started(allowed, 'call-3', { kind: 'navigate', url: 'https://example.test/' }))
    await service.record(finished(allowed, 'call-3'))

    const writer = store.writerOf(recording.recordingId)
    expect(writer.events.map(event => event.type)).toEqual(['step.started', 'step.finished'])
    expect(writer.events[0]).toMatchObject({ type: 'step.started', seq: 1 })
    expect(writer.suppressed).toHaveLength(2)
    expect(writer.suppressed[0]).toMatchObject({ reason: 'url_excluded', actionKind: 'navigate' })
    expect(writer.suppressed[1]).toMatchObject({ reason: 'url_blocked', actionKind: 'click' })
    expect((await store.readManifest(recording.recordingId)).suppressedCount).toBe(2)

    const steps = await collect(service.readSteps(recording.recordingId))
    expect(steps).toHaveLength(1)
    expect(steps[0]?.actionKind).toBe('navigate')
    await service.stop(recording.recordingId, owner)
  })

  it('suppresses a step whose semantic target belongs to a denied URL', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store, deniedUrlPatterns: ['bank.example'] })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)
    const stepId = newStepId()

    await service.record(started(stepId, 'call-1', {
      kind: 'click',
      target: { url: { origin: 'https://bank.example', path: '/pay' }, role: 'button' },
    }))
    await service.record(finished(stepId, 'call-1'))

    const writer = store.writerOf(recording.recordingId)
    expect(writer.events).toHaveLength(0)
    expect(writer.suppressed[0]).toMatchObject({ reason: 'url_excluded', actionKind: 'click' })
    await service.stop(recording.recordingId, owner)
  })

  it('does not suppress anything without denied URL patterns', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)
    const stepId = newStepId()

    await service.record(started(stepId, 'call-1', { kind: 'navigate', url: 'https://bank.example/login' }))
    await service.record(finished(stepId, 'call-1'))

    expect(store.writerOf(recording.recordingId).events).toHaveLength(2)
    expect(store.writerOf(recording.recordingId).suppressed).toHaveLength(0)
    await service.stop(recording.recordingId, owner)
  })

  it('stores consent metadata with the session that granted it', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start({
      ...startInput,
      consent: { mode: 'explicit', scope: 'browser actions in this workspace' },
    }, owner)

    expect(recording.consent).toMatchObject({
      mode: 'explicit',
      scope: 'browser actions in this workspace',
      grantedBy: 'session-a',
    })
    expect((await store.readManifest(recording.recordingId)).consent?.grantedBy).toBe('session-a')
    await service.stop(recording.recordingId, owner)
  })

  it('rejects an empty or oversized consent scope', async () => {
    const service = new RecordingService({ store: new FakeStore() })
    await expect(service.start({
      ...startInput,
      consent: { mode: 'implicit', scope: '   ' },
    }, principal('session-a'))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.start({
      ...startInput,
      consent: { mode: 'implicit', scope: 'x'.repeat(201) },
    }, principal('session-a'))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('deduplicates repeated events by stepId + callId + type', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)
    const stepId = newStepId()

    await service.record(started(stepId, 'call-1', { kind: 'navigate', url: 'https://example.test' }))
    await service.record(finished(stepId, 'call-1'))
    await service.record(finished(stepId, 'call-1'))

    const events = store.writerOf(recording.recordingId).events
    expect(events.filter((event) => event.type === 'step.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'step.finished')).toHaveLength(1)
  })

  it('start is idempotent by principal session id and idempotency key', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const first = await service.start({ ...startInput, idempotencyKey: 'key-1' }, owner)
    const second = await service.start({ ...startInput, idempotencyKey: 'key-1' }, owner)

    expect(second.recordingId).toBe(first.recordingId)
    await service.stop(first.recordingId, owner)
  })

  it('rejects a second active recording from another session', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const first = await service.start(startInput, principal('session-a'))

    await expect(service.start(startInput, principal('session-b'))).rejects.toMatchObject({
      code: 'RECORDING_LOCKED',
      recordingId: first.recordingId,
    })
    await service.stop(first.recordingId, principal('session-a'))
  })

  it('persists an optional intent in the manifest and descriptor', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start({ ...startInput, intent: '  核对 B 站搜索首屏  ' }, owner)

    expect(recording.intent).toBe('核对 B 站搜索首屏')
    const manifest = await store.readManifest(recording.recordingId)
    expect(manifest.intent).toBe('核对 B 站搜索首屏')
    await service.stop(recording.recordingId, owner)
  })

  it('rejects a blank intent', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })

    await expect(service.start({ ...startInput, intent: '   ' }, principal('session-a'))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('starts a recording without an intent for older callers', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)

    expect(recording.intent).toBeUndefined()
    expect((await store.readManifest(recording.recordingId)).intent).toBeUndefined()
    await service.stop(recording.recordingId, owner)
  })

  it('redacts setValue text and secret-shaped result fields before append', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)
    const stepId = newStepId()
    const secret = 'correct horse battery staple'

    await service.record(started(stepId, 'call-secret', {
      kind: 'setValue',
      target: { role: 'textbox', name: 'Name' },
      value: secret,
      secretRef: 'vault.name',
    }))
    await service.record(finished(stepId, 'call-secret', {
      password: secret,
      nested: { token: 'abc123', ok: 'visible' },
    }))

    const events = store.writerOf(recording.recordingId).events
    const startedEvent = events.find((event) => event.type === 'step.started')
    const finishedEvent = events.find((event) => event.type === 'step.finished')
    expect(startedEvent?.type).toBe('step.started')
    if (startedEvent?.type !== 'step.started') throw new Error('missing started event')
    expect(startedEvent.action.kind).toBe('setValue')
    if (startedEvent.action.kind !== 'setValue') throw new Error('unexpected action')
    expect(startedEvent.action.value).toBe(REDACTED_VALUE)
    expect(startedEvent.action.secretRef).toBe('vault.name')
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(finishedEvent?.type).toBe('step.finished')
    expect(JSON.stringify(finishedEvent)).toContain('"password":"***"')
    expect(JSON.stringify(finishedEvent)).toContain('"token":"***"')
  })

  it('stop waits for queued started events before closing', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)
    const stepId = newStepId()

    const pending = service.record(started(stepId, 'call-queued', {
      kind: 'navigate',
      url: 'https://example.test/queued',
    }))
    await service.stop(recording.recordingId, owner)
    await pending

    expect(store.writerOf(recording.recordingId).events).toHaveLength(1)
  })

  it('projects running steps while recording and interrupted steps after terminal stop', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)
    const stepId = newStepId()

    await service.record(started(stepId, 'call-open', { kind: 'navigate', url: 'https://example.test/open' }))
    const running = await collect(service.readSteps(recording.recordingId))
    expect(running).toHaveLength(1)
    expect(running[0]?.status).toBe('running')

    await service.stop(recording.recordingId, owner)
    const interrupted = await collect(service.readSteps(recording.recordingId))
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]?.status).toBe('interrupted')
  })

  it('rejects stop from another principal and unknown ids', async () => {
    const store = new FakeStore()
    const service = new RecordingService({ store })
    const owner = principal('session-a')
    const recording = await service.start(startInput, owner)

    await expect(service.stop(recording.recordingId, principal('session-b'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.get('rec_missing_000001' as never)).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' })
    await service.stop(recording.recordingId, owner)
  })

  it('surfaces service errors with stable codes', () => {
    const error = new RecordingServiceError('RECORDING_LOCKED', 'locked')
    expect(error.code).toBe('RECORDING_LOCKED')
    expect(error).toBeInstanceOf(Error)
  })
})
