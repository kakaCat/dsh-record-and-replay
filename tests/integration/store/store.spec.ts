/**
 * JSONL Store 集成测试（design/test-cases.md `tests/integration/store`、t7 验收：
 * 坏尾恢复、锁回收、原子 manifest、导出排除 lock/tmp）。
 *
 * 每个用例独立临时 Store 根；断言只用公开数据（manifest/JSONL/归档内容），不摸内部字段。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RecordingId, StepId } from '../../../src/core/api.js'
import {
  type StoreManifest,
  type StoreStepEvent,
  type StoreStepFinished,
  type StoreStepStarted,
} from '../../../src/store/api.js'
import { createFsRecordingStore } from '../../../src/store/fs/jsonl-store.js'
import { recoverStore } from '../../../src/store/fs/recovery.js'
import { createFsExporter } from '../../../src/store/fs/export.js'
import {
  ensureStoreRoot,
  lockPath,
  manifestPath,
  normalizeRelativeRecordingPath,
  recordingDir,
  sha256File,
  sha256Hex,
  stepsPath,
} from '../../../src/store/fs/paths.js'

const T0 = Date.parse('2026-10-30T05:00:00.000Z')
const iso = (ms: number = T0): string => new Date(ms).toISOString()

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-store-test-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function baseManifest(recordingId: RecordingId, overrides: Partial<StoreManifest> = {}): StoreManifest {
  return {
    schemaVersion: 1,
    recordingId,
    title: 'Store fixture',
    status: 'recording',
    ownerSessionId: 'session-a',
    driver: { id: 'cua-driver', version: '0.28.0', transport: 'mcp' },
    browser: { app: 'Chrome', startUrl: 'http://127.0.0.1:4173/form.html' },
    createdAt: iso(),
    updatedAt: iso(),
    lastSeq: 0,
    stepCount: 0,
    ...overrides,
  }
}

function started(stepId: StepId, seq: number, callId: string = `call-${stepId}`): StoreStepStarted {
  return {
    type: 'step.started',
    schemaVersion: 1,
    stepId,
    seq,
    callId,
    origin: 'agent',
    action: { kind: 'navigate', url: 'http://127.0.0.1:4173/form.html' },
    startedAt: T0 + seq * 10,
  }
}

function finished(stepId: StepId, evidence?: readonly string[], callId: string = `call-${stepId}`): StoreStepFinished {
  return {
    type: 'step.finished',
    stepId,
    callId,
    status: 'success',
    finishedAt: T0 + 5_000,
    durationMs: 12,
    ...(evidence === undefined ? {} : { evidence }),
  }
}

async function collectEvents(
  store: Awaited<ReturnType<typeof createFsRecordingStore>>,
  recordingId: RecordingId,
): Promise<ReadonlyArray<StoreStepEvent & { readonly line: number }>> {
  const events: Array<StoreStepEvent & { readonly line: number }> = []
  for await (const event of store.readSteps(recordingId)) events.push(event)
  return events
}

/** 构造「崩溃现场」：直接写盘，绕过 writer（manifest/steps/锁均可控）。 */
async function writeRawRecording(
  manifest: StoreManifest,
  stepsContent: string,
  lock?: { readonly heartbeatAt: number; readonly ownerSessionId?: string },
): Promise<string> {
  await ensureStoreRoot(root)
  const dir = recordingDir(root, manifest.recordingId)
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
  await fs.mkdir(path.join(dir, 'runs'), { recursive: true })
  await fs.writeFile(manifestPath(root, manifest.recordingId), `${JSON.stringify(manifest, null, 2)}\n`)
  await fs.writeFile(stepsPath(root, manifest.recordingId), stepsContent)
  if (lock !== undefined) {
    await fs.writeFile(
      lockPath(root, manifest.recordingId),
      `${JSON.stringify(
        {
          lockId: 'stale-lock',
          recordingId: manifest.recordingId,
          ownerSessionId: lock.ownerSessionId ?? 'dead-session',
          pid: 999_999,
          startedAt: lock.heartbeatAt,
          heartbeatAt: lock.heartbeatAt,
        },
        null,
        2,
      )}\n`,
    )
  }
  return dir
}

function jsonl(events: readonly StoreStepEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('')
}

describe('FsRecordingStore 布局与路径 containment', () => {
  it('创建 recording 目录、assets/runs、.gitignore，并拒绝非法 ID 与越界路径', async () => {
    const store = await createFsRecordingStore({ root, clock: () => T0 })
    const recordingId = 'rec_layout' as RecordingId
    const writer = await store.open({ manifest: baseManifest(recordingId) })

    const dir = recordingDir(root, recordingId)
    expect((await fs.stat(path.join(dir, 'manifest.json'))).isFile()).toBe(true)
    expect((await fs.stat(path.join(dir, 'assets'))).isDirectory()).toBe(true)
    expect((await fs.stat(path.join(dir, 'runs'))).isDirectory()).toBe(true)
    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    expect(gitignore).toContain('*')
    expect(gitignore).toContain('!.gitignore')

    await expect(store.readManifest('rec_bad-id' as RecordingId)).rejects.toMatchObject({
      code: 'STORE_INVALID_ID',
    })
    expect(() => normalizeRelativeRecordingPath('../../etc/passwd')).toThrowError(
      expect.objectContaining({ code: 'STORE_PATH_ESCAPE' }),
    )
    expect(() => normalizeRelativeRecordingPath('/tmp/x.png')).toThrowError(
      expect.objectContaining({ code: 'STORE_PATH_ESCAPE' }),
    )
    expect(() => normalizeRelativeRecordingPath('assets/x.png')).not.toThrow()

    await writer.close()
    await store.close()

    // 已终态的 recording 不能再次 open（编辑/修复必须 fork 新 Recording）。
    const reopened = await createFsRecordingStore({ root, clock: () => T0 })
    await expect(reopened.open({ manifest: baseManifest(recordingId) })).rejects.toMatchObject({
      code: 'RECORDING_ALREADY_COMPLETED',
    })
    await reopened.close()
  })
})

describe('追加、读取游标、去重与原子 manifest', () => {
  it('started/finished 成对流式读取；同 stepId+callId+type 不产生第二逻辑步骤', async () => {
    const store = await createFsRecordingStore({ root, clock: () => T0 })
    const recordingId = 'rec_stream' as RecordingId
    const writer = await store.open({ manifest: baseManifest(recordingId) })
    const first = 'step_one' as StepId
    const second = 'step_two' as StepId

    await writer.append(started(first, 1))
    await writer.append(finished(first))
    await writer.append(started(second, 2))
    await writer.append(finished(second))
    // 重放同一事件：幂等，不产生第二逻辑步骤。
    await writer.append(started(first, 1))
    await writer.append(finished(first))

    expect(writer.manifest.lastSeq).toBe(2)
    expect(writer.manifest.stepCount).toBe(2)

    const all = await collectEvents(store, recordingId)
    expect(all.map((event) => `${event.type}:${event.stepId}`)).toEqual([
      'step.started:step_one',
      'step.finished:step_one',
      'step.started:step_two',
      'step.finished:step_two',
    ])
    expect(all.map((event) => event.line)).toEqual([1, 2, 3, 4])

    const byLine = await collectEvents(store, recordingId)
    const cursorLine = []
    for await (const event of store.readSteps(recordingId, { afterLine: 2 })) cursorLine.push(event)
    expect(cursorLine.map((event) => event.line)).toEqual([3, 4])
    expect(cursorLine).toHaveLength(2)

    const cursorSeq = []
    for await (const event of store.readSteps(recordingId, { afterSeq: 1 })) cursorSeq.push(event)
    expect(cursorSeq.map((event) => event.stepId)).toEqual([second, second])

    const closed = await writer.close()
    expect(closed.status).toBe('completed')
    expect(closed.stepCount).toBe(2)
    expect(closed.lastSeq).toBe(2)
    expect(closed.completedAt).toBe(iso())
    expect(closed.stepsSha256).toBe(await sha256File(stepsPath(root, recordingId)))

    // 原子 manifest：读出来是完整 JSON，且目录里没有残留 tmp 文件，锁已释放。
    const diskManifest = JSON.parse(await fs.readFile(manifestPath(root, recordingId), 'utf8')) as StoreManifest
    expect(diskManifest.status).toBe('completed')
    expect(diskManifest.stepCount).toBe(2)
    const names = await fs.readdir(recordingDir(root, recordingId))
    expect(names.filter((name) => name.includes('.tmp-'))).toEqual([])
    // staging 目录在原子 rename 后不残留（plan §4.5 第 1 条）。
    expect(await fs.readdir(path.join(root, 'tmp'))).toEqual([])
    await expect(fs.stat(lockPath(root, recordingId))).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(writer.append(started('step_after_close' as StepId, 3))).rejects.toMatchObject({
      code: 'RECORDING_ALREADY_COMPLETED',
    })
    await store.close()
  })

  it('证据路径只允许 assets/ 或 runs/<runId>/，并支持安全写资产', async () => {
    const store = await createFsRecordingStore({ root, clock: () => T0 })
    const recordingId = 'rec_assets' as RecordingId
    const writer = await store.open({ manifest: baseManifest(recordingId) })
    const stepId = 'step_asset' as StepId

    const saved = await writer.writeAsset({ path: 'assets/screenshots/step-1.png', data: 'png-bytes' })
    expect(saved).toBe('assets/screenshots/step-1.png')
    const onDisk = await fs.readFile(path.join(recordingDir(root, recordingId), 'assets/screenshots/step-1.png'), 'utf8')
    expect(onDisk).toBe('png-bytes')

    await expect(writer.writeAsset({ path: '../escape.txt', data: 'x' })).rejects.toMatchObject({
      code: 'STORE_PATH_ESCAPE',
    })

    await writer.append(started(stepId, 1))
    await expect(writer.append(finished(stepId, ['assets/../../etc/passwd']))).rejects.toMatchObject({
      code: 'STORE_PATH_ESCAPE',
    })
    await writer.append(finished(stepId, ['assets/screenshots/step-1.png']))
    const events = await collectEvents(store, recordingId)
    expect(events.at(-1)?.type).toBe('step.finished')
    await writer.close()
    await store.close()
  })

  it('store.close 把仍在录制的 writer 收口为 interrupted（绝不伪报 completed）', async () => {
    const store = await createFsRecordingStore({ root, clock: () => T0 })
    const recordingId = 'rec_interrupt_on_close' as RecordingId
    const writer = await store.open({ manifest: baseManifest(recordingId) })
    await writer.append(started('step_open' as StepId, 1))

    await store.close()
    const manifest = await store.readManifest(recordingId)
    expect(manifest.status).toBe('interrupted')
    expect(manifest.stepCount).toBe(1)
  })

  it('writes suppressed steps to their own append-only file and counts them', async () => {
    const store = await createFsRecordingStore({ root, clock: () => T0 })
    const recordingId = 'rec_suppressed' as RecordingId
    const writer = await store.open({ manifest: baseManifest(recordingId) })
    const base = {
      stepId: 'step_suppressed_a' as StepId,
      callId: 'call-suppressed-a',
      actionKind: 'navigate' as const,
      reason: 'url_excluded' as const,
      at: T0,
    }
    await writer.appendSuppressed(base)
    await writer.appendSuppressed({
      ...base,
      stepId: 'step_suppressed_b' as StepId,
      callId: 'call-suppressed-b',
      reason: 'url_blocked',
    })
    await writer.close({ status: 'completed' })
    await expect(writer.appendSuppressed(base)).rejects.toMatchObject({ code: 'RECORDING_ALREADY_COMPLETED' })

    const manifest = await store.readManifest(recordingId)
    expect(manifest.suppressedCount).toBe(2)
    const text = await fs.readFile(path.join(recordingDir(root, recordingId), 'suppressed.jsonl'), 'utf8')
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ schemaVersion: 1, stepId: 'step_suppressed_a', reason: 'url_excluded' })
    expect(text).not.toContain('http')
    await store.close()
  })

  it('persists endReason for completed, cancelled and interrupted closes', async () => {
    const store = await createFsRecordingStore({ root, clock: () => T0 })
    const completedId = 'rec_end_completed' as RecordingId
    const completed = await store.open({ manifest: baseManifest(completedId) })
    await completed.close({ status: 'completed', endReason: 'max_duration' })
    expect((await store.readManifest(completedId)).endReason).toBe('max_duration')

    const cancelledId = 'rec_end_cancelled' as RecordingId
    const cancelled = await store.open({ manifest: baseManifest(cancelledId) })
    await cancelled.close({ status: 'cancelled' })
    const cancelledManifest = await store.readManifest(cancelledId)
    expect(cancelledManifest.status).toBe('cancelled')
    expect(cancelledManifest.endReason).toBe('cancelled')

    const interruptedId = 'rec_end_interrupted' as RecordingId
    const interrupted = await store.open({ manifest: baseManifest(interruptedId) })
    await interrupted.close({ status: 'interrupted' })
    expect((await store.readManifest(interruptedId)).endReason).toBe('interrupted')
    await store.close()
  })
})

describe('写租约：活跃锁拒绝、空闲锁回收、锁丢失停写', () => {
  it('第二个 writer 被 STORE_LOCKED 拒绝，关闭后锁释放', async () => {
    const storeA = await createFsRecordingStore({ root, clock: () => T0 })
    const storeB = await createFsRecordingStore({ root, clock: () => T0 })
    const recordingId = 'rec_lock' as RecordingId
    const writerA = await storeA.open({ manifest: baseManifest(recordingId) })

    await expect(storeB.open({ manifest: baseManifest(recordingId) })).rejects.toMatchObject({
      code: 'STORE_LOCKED',
    })
    await writerA.close()
    // 关闭后锁文件消失；再次 open 能拿到锁（但 recording 已终态，故用 readManifest 证明锁已释放）。
    await expect(fs.stat(lockPath(root, recordingId))).rejects.toMatchObject({ code: 'ENOENT' })
    await storeA.close()
    await storeB.close()
  })

  it('心跳过期的空闲锁被回收并重建为新 owner', async () => {
    const recordingId = 'rec_reclaim' as RecordingId
    await writeRawRecording(baseManifest(recordingId), '', {
      heartbeatAt: T0 - 60_000,
      ownerSessionId: 'dead-session',
    })

    const store = await createFsRecordingStore({ root, clock: () => T0, lockTtlMs: 1_000 })
    const writer = await store.open({ manifest: baseManifest(recordingId) })
    const lock = JSON.parse(await fs.readFile(lockPath(root, recordingId), 'utf8')) as {
      ownerSessionId: string
      heartbeatAt: number
    }
    expect(lock.ownerSessionId).toBe('session-a')
    expect(lock.heartbeatAt).toBe(T0)
    await writer.close()
    await store.close()
  })

  it('锁被删除后继续 append 必须 STORE_LOCK_LOST', async () => {
    const store = await createFsRecordingStore({ root, clock: () => T0 })
    const recordingId = 'rec_lock_lost' as RecordingId
    const writer = await store.open({ manifest: baseManifest(recordingId) })
    await fs.rm(lockPath(root, recordingId), { force: true })

    await expect(writer.append(started('step_lock_lost' as StepId, 1))).rejects.toMatchObject({
      code: 'STORE_LOCK_LOST',
    })
    await writer.close()
    await store.close()
  })
})

describe('坏尾恢复与 manifest 对账', () => {
  it('坏尾备份原文件、截断到最后完整行、标 interrupted 并对账 manifest', async () => {
    const recordingId = 'rec_torn' as RecordingId
    const good = jsonl([started('step_one' as StepId, 1), finished('step_one' as StepId)])
    const torn = `${good}{"type":"step.finished","stepId":"step_two"`
    const dir = await writeRawRecording(baseManifest(recordingId), torn, { heartbeatAt: T0 - 60_000 })
    const originalBytes = (await fs.readFile(stepsPath(root, recordingId))).length

    const report = await recoverStore(root, { clock: () => T0, lockTtlMs: 1_000 })
    expect(report.scannedRecordings).toBe(1)
    const recording = report.recordings[0]
    expect(recording).toBeDefined()
    const kinds = recording?.issues.map((issue) => issue.kind) ?? []
    expect(kinds).toContain('corrupt-tail')
    expect(kinds).toContain('stale-lock')
    expect(kinds).toContain('manifest-repair')
    expect(recording?.backupPath).toBeDefined()

    const backup = path.join(dir, recording?.backupPath ?? '')
    const backedUp = await fs.readFile(backup, 'utf8')
    expect(backedUp).toBe(torn)
    expect(backedUp.length).toBe(originalBytes)

    const truncated = await fs.readFile(stepsPath(root, recordingId), 'utf8')
    expect(truncated).toBe(good)
    expect(recording?.truncatedBytes).toBe(originalBytes - Buffer.byteLength(good, 'utf8'))

    const manifest = JSON.parse(await fs.readFile(manifestPath(root, recordingId), 'utf8')) as StoreManifest
    expect(manifest.status).toBe('interrupted')
    expect(manifest.stepCount).toBe(1)
    expect(manifest.lastSeq).toBe(1)
    expect(manifest.stepsSha256).toBe(sha256Hex(truncated))
    // 过期锁已回收：锁文件不再存在。
    await expect(fs.stat(lockPath(root, recordingId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('中间完整行非法时不截断（不丢后续数据），只报告 corrupt-jsonl', async () => {
    const recordingId = 'rec_midcorrupt' as RecordingId
    const content = `${jsonl([started('step_one' as StepId, 1)])}not-json\n${jsonl([finished('step_one' as StepId)])}`
    await writeRawRecording(baseManifest(recordingId, { lastSeq: 5, stepCount: 5 }), content)

    const report = await recoverStore(root, { clock: () => T0 })
    const recording = report.recordings[0]
    const kinds = recording?.issues.map((issue) => issue.kind) ?? []
    expect(kinds).toContain('corrupt-jsonl')
    expect(kinds).not.toContain('corrupt-tail')
    expect(await fs.readFile(stepsPath(root, recordingId), 'utf8')).toBe(content)

    // 中间坏行时不得把 manifest 摘要改小（后续数据仍可能存在）。
    const manifest = JSON.parse(await fs.readFile(manifestPath(root, recordingId), 'utf8')) as StoreManifest
    expect(manifest.lastSeq).toBe(5)
    expect(manifest.stepCount).toBe(5)
  })

  it('清理遗留 tmp 文件与超龄 tmp 目录，且不删除 Recording', async () => {
    const store = await createFsRecordingStore({ root, clock: () => T0 })
    const recordingId = 'rec_tmp' as RecordingId
    const writer = await store.open({ manifest: baseManifest(recordingId) })
    await writer.append(started('step_tmp' as StepId, 1))
    await writer.close()
    await store.close()

    const dir = recordingDir(root, recordingId)
    await fs.writeFile(path.join(dir, 'manifest.json.tmp-leftover'), '{"broken":')
    const staleTmp = path.join(root, 'tmp', 'rec_stale.tmp-leftover')
    await fs.mkdir(staleTmp, { recursive: true })
    const ancient = new Date(T0 - 48 * 60 * 60 * 1000)
    await fs.utimes(staleTmp, ancient, ancient)

    const report = await recoverStore(root, { clock: () => T0, tmpRetentionMs: 60_000 })
    expect(report.removedTmpEntries).toBe(1)
    expect(report.issues.some((issue) => issue.kind === 'orphan-tmp')).toBe(true)
    await expect(fs.stat(path.join(dir, 'manifest.json.tmp-leftover'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(staleTmp)).rejects.toMatchObject({ code: 'ENOENT' })
    // Recording 与新写入的步骤都保留。
    const manifest = await store.readManifest(recordingId)
    expect(manifest.stepCount).toBe(1)
  })

  it('未完成的步骤在恢复中报告为 unfinished-step，不伪造 success', async () => {
    const recordingId = 'rec_unfinished' as RecordingId
    await writeRawRecording(baseManifest(recordingId), jsonl([started('step_half' as StepId, 1)]), {
      heartbeatAt: T0 - 60_000,
    })

    const report = await recoverStore(root, { clock: () => T0, lockTtlMs: 1_000 })
    const recording = report.recordings[0]
    expect(recording?.unfinishedStepIds).toEqual(['step_half'])
    expect(recording?.issues.some((issue) => issue.kind === 'unfinished-step')).toBe(true)
    const manifest = JSON.parse(await fs.readFile(manifestPath(root, recordingId), 'utf8')) as StoreManifest
    expect(manifest.status).toBe('interrupted')
  })
})

describe('版本与容量门', () => {
  it('未知 schemaVersion 在读/恢复/open 时都返回 STORE_UNSUPPORTED_VERSION 且不改盘', async () => {
    const recordingId = 'rec_v2' as RecordingId
    const dir = await writeRawRecording(baseManifest(recordingId), '')
    const manifestFile = path.join(dir, 'manifest.json')
    const raw = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, unknown>
    raw['schemaVersion'] = 2
    const rawText = `${JSON.stringify(raw, null, 2)}\n`
    await fs.writeFile(manifestFile, rawText)

    const store = await createFsRecordingStore({ root, clock: () => T0 })
    await expect(store.readManifest(recordingId)).rejects.toMatchObject({
      code: 'STORE_UNSUPPORTED_VERSION',
    })
    await expect(store.open({ manifest: baseManifest(recordingId) })).rejects.toMatchObject({
      code: 'STORE_UNSUPPORTED_VERSION',
    })

    const report = await recoverStore(root, { clock: () => T0 })
    expect(report.issues.some((issue) => issue.kind === 'unsupported-version')).toBe(true)
    expect(await fs.readFile(manifestFile, 'utf8')).toBe(rawText)
    await store.close()
  })

  it('超过步数/字节限额返回 STORE_LIMIT_EXCEEDED，并保留已有历史', async () => {
    const store = await createFsRecordingStore({ root, clock: () => T0, maxSteps: 1 })
    const recordingId = 'rec_limit' as RecordingId
    const writer = await store.open({ manifest: baseManifest(recordingId) })
    await writer.append(started('step_one' as StepId, 1))
    await expect(writer.append(started('step_two' as StepId, 2))).rejects.toMatchObject({
      code: 'STORE_LIMIT_EXCEEDED',
    })
    await writer.close()

    const events = await collectEvents(store, recordingId)
    expect(events).toHaveLength(1)
    await store.close()

    const tinyStore = await createFsRecordingStore({ root, clock: () => T0, maxBytes: 16 })
    const tinyId = 'rec_byte_limit' as RecordingId
    const tinyWriter = await tinyStore.open({ manifest: baseManifest(tinyId) })
    await expect(tinyWriter.append(started('step_big' as StepId, 1))).rejects.toMatchObject({
      code: 'STORE_LIMIT_EXCEEDED',
    })
    await tinyWriter.close()
    await tinyStore.close()
  })
})

describe('.dshreplay 导出', () => {
  async function seedRecording(recordingId: RecordingId): Promise<void> {
    const store = await createFsRecordingStore({ root, clock: () => T0 })
    const writer = await store.open({ manifest: baseManifest(recordingId) })
    const stepId = 'step_export' as StepId
    await writer.append(started(stepId, 1))
    await writer.writeAsset({ path: 'assets/screenshots/step-export.png', data: 'export-png' })
    await writer.append(finished(stepId, ['assets/screenshots/step-export.png']))
    await writer.close()
    await store.close()

    const dir = recordingDir(root, recordingId)
    await fs.mkdir(path.join(dir, 'runs/run_export/evidence'), { recursive: true })
    await fs.writeFile(path.join(dir, 'runs/run_export/evidence/error.json'), '{"code":"TARGET_NOT_FOUND"}\n')
    await fs.mkdir(path.join(dir, 'tmp'), { recursive: true })
    await fs.writeFile(path.join(dir, 'tmp/leak.txt'), 'must not be exported\n')
    await fs.writeFile(path.join(dir, 'recording.lock'), '{"lockId":"x"}\n')
  }

  it('默认导出只含 manifest/steps/assets，排除 lock/tmp，Run 默认不附加', async () => {
    const recordingId = 'rec_export' as RecordingId
    await seedRecording(recordingId)

    const exporter = await createFsExporter({ root, clock: () => T0 })
    const result = await exporter.exportRecording({ recordingId })
    expect(result.filePath.endsWith(`${recordingId}.dshreplay`)).toBe(true)
    expect(result.filePath.startsWith(path.join(root, 'exports'))).toBe(true)
    expect(result.fileCount).toBeGreaterThanOrEqual(3)
    expect(result.sha256).toBe(await sha256File(result.filePath))

    const archive = await exporter.readArchive(result.filePath)
    expect(archive.format).toBe('dshreplay')
    expect(archive.formatVersion).toBe(1)
    expect(archive.recordingId).toBe(recordingId)
    expect(archive.exportedAt).toBe(iso())

    const paths = archive.files.map((file) => file.path)
    expect(paths).toContain('manifest.json')
    expect(paths).toContain('steps.jsonl')
    expect(paths).toContain('assets/screenshots/step-export.png')
    expect(paths.some((entry) => entry.includes('recording.lock'))).toBe(false)
    expect(paths.some((entry) => entry.includes('tmp/'))).toBe(false)
    expect(paths.some((entry) => entry.startsWith('runs/'))).toBe(false)

    for (const file of archive.files) {
      const content = Buffer.from(file.contentBase64, 'base64')
      expect(file.sha256).toBe(sha256Hex(content))
      expect(file.bytes).toBe(content.byteLength)
    }
    const manifest = archive.files.find((file) => file.path === 'manifest.json')
    expect(manifest).toBeDefined()
    const manifestJson = JSON.parse(
      Buffer.from(manifest?.contentBase64 ?? '', 'base64').toString('utf8'),
    ) as StoreManifest
    expect(manifestJson.status).toBe('completed')
    expect(manifestJson.stepsSha256).toBeDefined()
  })

  it('includeRuns 时附加 Run 证据，但仍排除 lock/tmp；可导出到自定义目标', async () => {
    const recordingId = 'rec_export_runs' as RecordingId
    await seedRecording(recordingId)

    const exporter = await createFsExporter({ root, clock: () => T0 })
    const destination = path.join(root, 'custom-export')
    const result = await exporter.exportRecording({ recordingId, includeRuns: true, destination })
    expect(result.filePath).toBe(`${destination}.dshreplay`)

    const archive = await exporter.readArchive(result.filePath)
    const paths = archive.files.map((file) => file.path)
    expect(paths).toContain('runs/run_export/evidence/error.json')
    expect(paths.some((entry) => entry.includes('recording.lock'))).toBe(false)
    expect(paths.some((entry) => entry.includes('tmp/'))).toBe(false)
  })

  it('篡改归档内容后 readArchive 报 STORE_CORRUPT_JSONL（sha256 校验）', async () => {
    const recordingId = 'rec_export_tamper' as RecordingId
    await seedRecording(recordingId)
    const exporter = await createFsExporter({ root, clock: () => T0 })
    const result = await exporter.exportRecording({ recordingId })
    const archive = await exporter.readArchive(result.filePath)

    const tampered = {
      ...archive,
      files: archive.files.map((file, index) =>
        index === 0 ? { ...file, contentBase64: Buffer.from('tampered').toString('base64') } : file,
      ),
    }
    const { gzipSync } = await import('node:zlib')
    const tamperedPath = path.join(root, 'tampered.dshreplay')
    await fs.writeFile(tamperedPath, gzipSync(Buffer.from(JSON.stringify(tampered), 'utf8')))
    await expect(exporter.readArchive(tamperedPath)).rejects.toMatchObject({ code: 'STORE_CORRUPT_JSONL' })
  })
})

describe('Recording 列表', () => {
  it('扫描 manifest 列出全部 Recording（按 createdAt 倒序）', async () => {
    const store = await createFsRecordingStore({ root, clock: () => T0 })
    const older = 'rec_older' as RecordingId
    const newer = 'rec_newer' as RecordingId
    const olderWriter = await store.open({
      manifest: baseManifest(older, { createdAt: new Date(T0 - 60_000).toISOString() }),
    })
    await olderWriter.close()
    const newerWriter = await store.open({
      manifest: baseManifest(newer, { createdAt: new Date(T0).toISOString() }),
    })
    await newerWriter.close()

    const manifests = await store.listRecordings()
    expect(manifests.map((manifest) => manifest.recordingId)).toEqual([newer, older])
    await store.close()
  })
})
