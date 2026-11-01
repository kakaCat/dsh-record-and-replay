import type { RecordingId } from '../core/api.js'
import {
  StoreError,
  type CloseRecordingInput,
  type OpenRecordingInput,
  type RecordingStore,
  type RecordingWriter,
  type StepCursor,
  type StoreManifest,
  type StoreStepEvent,
  type StoredStepEvent,
  type SuppressedStepRecord,
} from '../store/api.js'

class MemoryWriter implements RecordingWriter {
  readonly events: StoreStepEvent[] = []
  readonly suppressed: SuppressedStepRecord[] = []
  private closed = false

  constructor(
    private readonly store: MemoryRecordingStore,
    manifest: StoreManifest,
  ) {
    this.manifest = manifest
  }

  manifest: StoreManifest

  get recordingId(): RecordingId { return this.manifest.recordingId }

  async append(event: StoreStepEvent): Promise<void> {
    if (this.closed) {
      throw new StoreError('RECORDING_ALREADY_COMPLETED', 'writer is closed', { recordingId: this.manifest.recordingId })
    }
    const key = `${event.stepId}:${event.callId}:${event.type}`
    if (this.events.some((candidate) => `${candidate.stepId}:${candidate.callId}:${candidate.type}` === key)) {
      return
    }
    this.events.push(event)
    const started = this.events.filter((candidate) => candidate.type === 'step.started')
    const lastSeq = started.reduce((max, candidate) => candidate.type === 'step.started' ? Math.max(max, candidate.seq) : max, 0)
    const next = { ...this.manifest, lastSeq, stepCount: started.length }
    this.manifest = next
    this.store.upsert(next)
  }

  async appendSuppressed(record: SuppressedStepRecord): Promise<void> {
    if (this.closed) {
      throw new StoreError('RECORDING_ALREADY_COMPLETED', 'writer is closed', { recordingId: this.manifest.recordingId })
    }
    this.suppressed.push(record)
    const next = { ...this.manifest, suppressedCount: this.suppressed.length }
    this.manifest = next
    this.store.upsert(next)
  }

  async writeAsset(input: { path: string }): Promise<string> {
    return input.path
  }

  async close(input: CloseRecordingInput = {}): Promise<StoreManifest> {
    this.closed = true
    const status = input.status ?? 'completed'
    const endReason = input.endReason ?? defaultEndReason(status)
    const next: StoreManifest = {
      ...this.manifest,
      status,
      endReason,
      completedAt: new Date().toISOString(),
    }
    this.store.upsert(next)
    this.manifest = next
    return next
  }
}

/** 进程内 RecordingStore 样例；只用于测试/第三方 conformance，不模拟崩溃恢复。 */
export class MemoryRecordingStore implements RecordingStore {
  readonly root = 'memory://recording-store'
  private readonly manifests = new Map<RecordingId, StoreManifest>()
  private readonly writers = new Map<RecordingId, MemoryWriter>()

  async open(input: OpenRecordingInput): Promise<RecordingWriter> {
    const manifest = input.manifest
    if (manifest.status !== 'recording') {
      throw new StoreError('RECORDING_ALREADY_COMPLETED', 'new recordings must start in recording status', { recordingId: manifest.recordingId })
    }
    const existing = this.writers.get(manifest.recordingId)
    if (existing !== undefined) {
      throw new StoreError('STORE_LOCKED', 'recording already has an open writer', { recordingId: manifest.recordingId })
    }
    this.upsert(manifest)
    const writer = new MemoryWriter(this, manifest)
    this.writers.set(manifest.recordingId, writer)
    return writer
  }

  async readManifest(recordingId: RecordingId): Promise<StoreManifest> {
    const manifest = this.manifests.get(recordingId)
    if (manifest === undefined) throw new StoreError('RECORDING_NOT_FOUND', 'recording not found', { recordingId })
    return manifest
  }

  async *readSteps(recordingId: RecordingId, _cursor?: StepCursor): AsyncIterable<StoredStepEvent> {
    const writer = this.writers.get(recordingId)
    if (writer === undefined) throw new StoreError('RECORDING_NOT_FOUND', 'recording not found', { recordingId })
    for (const [index, event] of writer.events.entries()) {
      yield { ...event, line: index + 1 }
    }
  }

  async listRecordings(): Promise<readonly StoreManifest[]> {
    return [...this.manifests.values()]
  }

  async close(): Promise<void> {}

  upsert(manifest: StoreManifest): void {
    this.manifests.set(manifest.recordingId, manifest)
  }

  writerOf(recordingId: RecordingId): MemoryWriter {
    const writer = this.writers.get(recordingId)
    if (writer === undefined) throw new StoreError('RECORDING_NOT_FOUND', 'recording not found', { recordingId })
    return writer
  }
}

function defaultEndReason(status: 'completed' | 'failed' | 'interrupted' | 'cancelled'): NonNullable<StoreManifest['endReason']> {
  switch (status) {
    case 'completed':
      return 'tool_stopped'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    case 'cancelled':
      return 'cancelled'
  }
}
