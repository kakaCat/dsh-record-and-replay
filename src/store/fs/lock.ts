/**
 * Recording 写租约（design/data-model.md「锁被遗留」、plan §4.5 第 4/6 条）。
 *
 * 语义：
 * - 一个 Recording 同时只允许一个 writer：`recording.lock` 由 `wx`（O_EXCL）创建，存在且心跳新鲜即拒绝；
 * - 锁是**协作锁**，不是安全边界：进程消失后心跳过期，Store 可回收（先确认过期再 unlink 重试）；
 * - 心跳只能证明「写者还活着」，不能证明「写到哪」；恢复以 steps.jsonl 的最后完整行为准；
 * - 锁被删除/替换后，writer 再 append 必须失败（STORE_LOCK_LOST），绝不继续写。
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { StoreError } from '../api.js'
import type { RecordingId } from '../../core/api.js'
import { isErrno, mapFsError, readJsonFile, writeJsonFileAtomic } from './paths.js'

/** 心跳过期阈值（毫秒）。 */
export const DEFAULT_LOCK_TTL_MS = 15_000

/** 锁文件内容（plan §4.5：ownerSessionId/pid/startedAt/heartbeatAt）。 */
export interface RecordingLockRecord {
  readonly lockId: string
  readonly recordingId: RecordingId
  readonly ownerSessionId: string
  readonly pid: number
  readonly startedAt: number
  readonly heartbeatAt: number
}

export interface RecordingLockOptions {
  /** 锁文件绝对路径（Recording 目录内 `recording.lock`）。 */
  readonly lockFile: string
  readonly recordingId: RecordingId
  readonly ownerSessionId: string
  /** 心跳过期阈值；缺省 15s。 */
  readonly ttlMs?: number
  /** 心跳间隔；缺省 ttl/3（下限 50ms）。 */
  readonly heartbeatIntervalMs?: number
  readonly clock?: () => number
  readonly pid?: number
}

export function isLockExpired(record: RecordingLockRecord, now: number, ttlMs: number): boolean {
  return !Number.isFinite(record.heartbeatAt) || now - record.heartbeatAt > ttlMs
}

/** 读取锁文件；不存在返回 undefined，内容损坏按「遗留锁」返回 undefined 让调用方回收。 */
export async function readLockRecord(lockFile: string): Promise<RecordingLockRecord | undefined> {
  let raw: unknown
  try {
    raw = await readJsonFile(lockFile, { what: 'recording lock', missingCode: 'RECORDING_NOT_FOUND' })
  } catch (error) {
    // 不存在或内容损坏都按「无可信持有者」处理：前者是空闲，后者是遗留锁，回收后重建。
    if (error instanceof StoreError && (error.code === 'RECORDING_NOT_FOUND' || error.code === 'STORE_CORRUPT_JSONL')) {
      return undefined
    }
    throw error
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Readonly<Record<string, unknown>>
  if (
    typeof record['lockId'] !== 'string' ||
    record['lockId'].length === 0 ||
    typeof record['recordingId'] !== 'string' ||
    typeof record['ownerSessionId'] !== 'string' ||
    record['ownerSessionId'].length === 0 ||
    typeof record['pid'] !== 'number' ||
    typeof record['startedAt'] !== 'number' ||
    typeof record['heartbeatAt'] !== 'number'
  ) {
    return undefined
  }
  return {
    lockId: record['lockId'],
    recordingId: record['recordingId'] as RecordingId,
    ownerSessionId: record['ownerSessionId'],
    pid: record['pid'],
    startedAt: record['startedAt'],
    heartbeatAt: record['heartbeatAt'],
  }
}

export class RecordingLock {
  private readonly lockFile: string
  private readonly ownerSessionId: string
  private readonly ttlMs: number
  private readonly clock: () => number
  private current: RecordingLockRecord
  private timer: NodeJS.Timeout | undefined
  private released = false

  private constructor(
    lockFile: string,
    ownerSessionId: string,
    ttlMs: number,
    clock: () => number,
    record: RecordingLockRecord,
    heartbeatIntervalMs: number,
  ) {
    this.lockFile = lockFile
    this.ownerSessionId = ownerSessionId
    this.ttlMs = ttlMs
    this.clock = clock
    this.current = record
    this.timer = setInterval(() => {
      void this.refresh().catch(() => undefined)
    }, heartbeatIntervalMs)
    // 心跳不得阻止进程退出（测试进程/宿主退出时由 OS 清理锁文件，靠过期回收）。
    this.timer.unref()
  }

  /**
   * 获取写租约：O_EXCL 创建；已存在且心跳过期则回收（删除后重试），否则 STORE_LOCKED。
   */
  static async acquire(options: RecordingLockOptions): Promise<RecordingLock> {
    const clock = options.clock ?? Date.now
    const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new StoreError('INVALID_ARGUMENT', 'lock ttlMs must be a positive number of milliseconds')
    }
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(50, Math.floor(ttlMs / 3))
    const lockFile = options.lockFile

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = clock()
      const record: RecordingLockRecord = {
        lockId: `${String(options.pid ?? process.pid)}-${String(now)}-${randomUUID().replaceAll('-', '')}`,
        recordingId: options.recordingId,
        ownerSessionId: options.ownerSessionId,
        pid: options.pid ?? process.pid,
        startedAt: now,
        heartbeatAt: now,
      }
      try {
        await fs.mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 })
      } catch (error) {
        throw mapFsError(error, 'prepare recording lock', options.recordingId)
      }
      try {
        const handle = await fs.open(lockFile, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`)
          await handle.sync()
        } finally {
          await handle.close()
        }
        return new RecordingLock(lockFile, options.ownerSessionId, ttlMs, clock, record, heartbeatIntervalMs)
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) {
          throw mapFsError(error, 'acquire recording lock', options.recordingId)
        }
        const existing = await readLockRecord(lockFile)
        if (existing !== undefined && !isLockExpired(existing, now, ttlMs)) {
          throw new StoreError(
            'STORE_LOCKED',
            'recording already has an active writer (lock heartbeat is fresh)',
            { recordingId: options.recordingId },
          )
        }
        // 过期锁或损坏的锁内容：先清理再重试；并发回收时可能撞 EEXIST，最多重试 3 次。
        await fs.rm(lockFile, { force: true }).catch((rmError: unknown) => {
          throw mapFsError(rmError, 'reclaim stale recording lock', options.recordingId)
        })
      }
    }
    throw new StoreError('STORE_LOCKED', 'could not acquire the recording lock after reclaiming a stale lock', {
      recordingId: options.recordingId,
    })
  }

  get record(): RecordingLockRecord {
    return { ...this.current }
  }

  get file(): string {
    return this.lockFile
  }

  get isReleased(): boolean {
    return this.released
  }

  /**
   * 确认锁仍由本 writer 持有；锁被删除/替换 → STORE_LOCK_LOST（此后禁止继续写）。
   */
  async assertHeld(): Promise<void> {
    if (this.released) {
      throw new StoreError('STORE_LOCK_LOST', 'recording lock has already been released')
    }
    const onDisk = await readLockRecord(this.lockFile)
    if (onDisk === undefined || onDisk.lockId !== this.current.lockId) {
      throw new StoreError('STORE_LOCK_LOST', 'recording lock is gone or owned by another writer', {
        recordingId: this.current.recordingId,
      })
    }
    this.current = onDisk
  }

  /** 刷新心跳；锁已丢失时抛 STORE_LOCK_LOST（供调用方停止写入）。 */
  async refresh(): Promise<void> {
    if (this.released) return
    const onDisk = await readLockRecord(this.lockFile)
    if (this.released) return
    if (onDisk === undefined || onDisk.lockId !== this.current.lockId) {
      throw new StoreError('STORE_LOCK_LOST', 'recording lock is gone or owned by another writer', {
        recordingId: this.current.recordingId,
      })
    }
    const updated: RecordingLockRecord = { ...this.current, heartbeatAt: this.clock() }
    await writeJsonFileAtomic(this.lockFile, updated)
    this.current = updated
  }

  /** 释放锁；幂等。锁已被他人替换时绝不删除别人的锁。 */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    const onDisk = await readLockRecord(this.lockFile)
    if (onDisk !== undefined && onDisk.lockId !== this.current.lockId) {
      return
    }
    await fs.rm(this.lockFile, { force: true }).catch(() => undefined)
  }
}
