import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import * as path from 'node:path'
import type { RecordingId, RunId } from '../core/api.js'
import { SCHEMA_VERSION } from '../core/api.js'
import { ReplayServiceError, type RunRecord, type RunStore, type RunWriter } from '../replay/index.js'
import type { StepCursor, StoredStepEvent, StoreStepEvent } from '../store/api.js'

export interface FsRunStoreOptions {
  /** Store 根（`.dsh/record-replay`）。 */
  readonly root: string
}

function runDir(root: string, recordingId: RecordingId, runId: RunId): string {
  return path.join(root, 'recordings', recordingId, 'runs', runId)
}

function runFile(root: string, recordingId: RecordingId, runId: RunId): string {
  return path.join(runDir(root, recordingId, runId), 'run.json')
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, filePath)
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<RunRecord>
  return record.schemaVersion === SCHEMA_VERSION
    && typeof record.runId === 'string'
    && typeof record.recordingId === 'string'
    && typeof record.status === 'string'
}

class FsRunWriter implements RunWriter {
  constructor(
    private readonly root: string,
    private record: RunRecord,
  ) {}

  get runId(): RunId { return this.record.runId }
  get recordingId(): RecordingId { return this.record.recordingId }

  async append(event: StoreStepEvent): Promise<void> {
    const file = path.join(runDir(this.root, this.record.recordingId, this.record.runId), 'steps.jsonl')
    await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8')
  }

  async writeEvidence(name: string, data: Uint8Array | string): Promise<string> {
    const normalized = name.replaceAll('\\', '/')
    if (normalized.length === 0 || normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new ReplayServiceError('INVALID_ARGUMENT', 'evidence name must be a relative POSIX path without ".."')
    }
    const dir = path.join(runDir(this.root, this.record.recordingId, this.record.runId), 'evidence', path.dirname(normalized))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(runDir(this.root, this.record.recordingId, this.record.runId), 'evidence', normalized), data)
    return `runs/${this.record.runId}/evidence/${normalized}`
  }

  async update(record: RunRecord): Promise<void> {
    this.record = record
    await atomicJson(runFile(this.root, record.recordingId, record.runId), record)
  }

  async finish(record: RunRecord): Promise<void> {
    this.record = record
    await atomicJson(runFile(this.root, record.recordingId, record.runId), record)
  }
}

/** 文件化 RunStore：run.json + steps.jsonl + evidence/，插件重启后仍可读。 */
export class FsRunStore implements RunStore {
  private readonly root: string

  constructor(options: FsRunStoreOptions) {
    this.root = options.root
  }

  async create(record: RunRecord): Promise<RunWriter> {
    const dir = runDir(this.root, record.recordingId, record.runId)
    await mkdir(path.join(dir, 'evidence'), { recursive: true })
    await writeFile(path.join(dir, 'steps.jsonl'), '', 'utf8')
    await atomicJson(path.join(dir, 'run.json'), record)
    return new FsRunWriter(this.root, record)
  }

  async read(recordingId: RecordingId, runId: RunId): Promise<RunRecord> {
    try {
      const record = await readJson<RunRecord>(runFile(this.root, recordingId, runId))
      if (!isRunRecord(record) || record.recordingId !== recordingId || record.runId !== runId) {
        throw new Error('invalid run.json')
      }
      return record
    } catch {
      throw new ReplayServiceError('RUN_NOT_FOUND', `unknown run ${runId}`, { recordingId, runId })
    }
  }

  async findRun(runId: RunId): Promise<RunRecord | undefined> {
    for (const record of await this.listAllRuns()) {
      if (record.runId === runId) return record
    }
    return undefined
  }

  async listRuns(recordingId: RecordingId): Promise<readonly RunRecord[]> {
    const dir = path.join(this.root, 'recordings', recordingId, 'runs')
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return []
    }
    const runs: RunRecord[] = []
    for (const entry of entries) {
      try {
        const record = await readJson<RunRecord>(path.join(dir, entry, 'run.json'))
        if (isRunRecord(record)) runs.push(record)
      } catch {
        // 单个坏 Run 不阻断其它 Run 的读取。
      }
    }
    return runs
  }

  async listAllRuns(): Promise<readonly RunRecord[]> {
    const recordingsDir = path.join(this.root, 'recordings')
    let entries: string[]
    try {
      entries = await readdir(recordingsDir)
    } catch {
      return []
    }
    const runs: RunRecord[] = []
    for (const entry of entries) {
      runs.push(...await this.listRuns(entry as RecordingId))
    }
    return runs
  }

  async *readSteps(recordingId: RecordingId, runId: RunId, cursor?: StepCursor): AsyncIterable<StoredStepEvent> {
    const file = path.join(runDir(this.root, recordingId, runId), 'steps.jsonl')
    try {
      await stat(file)
    } catch {
      throw new ReplayServiceError('RUN_NOT_FOUND', `unknown run ${runId}`, { recordingId, runId })
    }
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    let line = 0
    for await (const raw of lines) {
      line += 1
      if (cursor?.afterLine !== undefined && line <= cursor.afterLine) continue
      if (raw.trim().length === 0) continue
      yield { ...(JSON.parse(raw) as StoreStepEvent), line }
    }
  }

  async stepCountOf(recordingId: RecordingId, runId: RunId): Promise<number> {
    let count = 0
    for await (const event of this.readSteps(recordingId, runId)) {
      if (event.type === 'step.started') count += 1
    }
    return count
  }
}
