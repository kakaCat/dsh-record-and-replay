/**
 * Store 文件布局与路径安全（design/interfaces.md IF-4「root containment / 相对证据路径」、
 * docs/projects/PRJ-0001/plan/implementation-plan.md §4.3 / §4.5）。
 *
 * 纪律：
 * - 所有落盘路径都必须经过 root containment：解析后的路径必须仍在 Store 根/Recording 目录内；
 * - ID 只允许 Core 的正则，任何非法值在打开文件前拒绝（STORE_INVALID_ID / STORE_PATH_ESCAPE）；
 * - JSON/manifest 一律「同目录临时文件 → fsync → rename」原子替换，绝不直接覆盖半个 JSON；
 * - 步骤文件只追加完整一行；临时文件、锁与坏尾备份不进入导出。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { isRecordingId, isRunId, type RecordingId, type RunId } from '../../core/api.js'
import { StoreError } from '../api.js'

/** 目录/文件名的唯一事实来源（plan §4.3）。 */
export const STORE_LAYOUT = {
  recordings: 'recordings',
  exports: 'exports',
  tmp: 'tmp',
  manifest: 'manifest.json',
  steps: 'steps.jsonl',
  suppressed: 'suppressed.jsonl',
  lock: 'recording.lock',
  assets: 'assets',
  runs: 'runs',
  gitignore: '.gitignore',
  gitignoreContent: '*\n!.gitignore\n',
  tmpMarker: '.tmp-',
} as const

/** 临时文件/目录统一后缀前缀；恢复与导出都据此排除。 */
export function tmpNameFor(filePath: string): string {
  return `${filePath}${STORE_LAYOUT.tmpMarker}${randomSuffix()}`
}

export function isTmpName(name: string): boolean {
  return name.includes(STORE_LAYOUT.tmpMarker)
}

/** 坏尾备份文件名（steps.jsonl.corrupt-<ts>.bak），导出必须排除。 */
export function isCorruptBackupName(name: string): boolean {
  return name.includes('.corrupt-') || name.endsWith('.bak')
}

function randomSuffix(): string {
  return randomUUID().replaceAll('-', '')
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export function recordingsDir(root: string): string {
  return path.join(root, STORE_LAYOUT.recordings)
}

export function exportsDir(root: string): string {
  return path.join(root, STORE_LAYOUT.exports)
}

export function tmpDir(root: string): string {
  return path.join(root, STORE_LAYOUT.tmp)
}

/** 校验并返回 RecordingId；非法值在打开任何文件之前拒绝。 */
export function assertSafeRecordingId(value: unknown, field = 'recordingId'): RecordingId {
  if (!isRecordingId(value)) {
    throw new StoreError('STORE_INVALID_ID', `${field} is not a valid RecordingId (expected ^rec_[A-Za-z0-9_]+$)`)
  }
  return value
}

export function assertSafeRunId(value: unknown, field = 'runId'): RunId {
  if (!isRunId(value)) {
    throw new StoreError('STORE_INVALID_ID', `${field} is not a valid RunId (expected ^run_[A-Za-z0-9_]+$)`)
  }
  return value
}

export function recordingDir(root: string, recordingId: RecordingId): string {
  return path.join(recordingsDir(root), assertSafeRecordingId(recordingId))
}

export function manifestPath(root: string, recordingId: RecordingId): string {
  return path.join(recordingDir(root, recordingId), STORE_LAYOUT.manifest)
}

export function stepsPath(root: string, recordingId: RecordingId): string {
  return path.join(recordingDir(root, recordingId), STORE_LAYOUT.steps)
}

export function suppressedPath(root: string, recordingId: RecordingId): string {
  return path.join(recordingDir(root, recordingId), STORE_LAYOUT.suppressed)
}

export function lockPath(root: string, recordingId: RecordingId): string {
  return path.join(recordingDir(root, recordingId), STORE_LAYOUT.lock)
}

export function assetsDir(root: string, recordingId: RecordingId): string {
  return path.join(recordingDir(root, recordingId), STORE_LAYOUT.assets)
}

export function runsDir(root: string, recordingId: RecordingId): string {
  return path.join(recordingDir(root, recordingId), STORE_LAYOUT.runs)
}

export function runDir(root: string, recordingId: RecordingId, runId: RunId): string {
  return path.join(runsDir(root, recordingId), assertSafeRunId(runId))
}

/**
 * Root containment：解析后的 `candidate` 必须等于 `root` 或位于其下。
 * 用于所有「拼接用户/JSON 输入得到的路径」的最后一道校验。
 */
export function assertContained(root: string, candidate: string, what = 'path'): string {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(prefix)) {
    throw new StoreError('STORE_PATH_ESCAPE', `${what} escapes the store root`)
  }
  return resolvedCandidate
}

/** 把任意路径转成 POSIX 形态（持久化 JSON 里只用 POSIX 分隔符）。 */
export function toPosixPath(value: string): string {
  return value.split(path.sep).join('/').split('\\').join('/')
}

/**
 * 校验并归一化 Recording 内相对证据路径。
 *
 * 契约（design/data-model.md 约束）：只允许 `assets/` 或 `runs/<runId>/` 前缀，
 * 不允许 `..`、绝对路径、盘符与 NUL；返回归一化后的 POSIX 相对路径。
 */
export function normalizeRelativeRecordingPath(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new StoreError('STORE_PATH_ESCAPE', 'relative path must be a non-empty string')
  }
  if (relativePath.includes('\0')) {
    throw new StoreError('STORE_PATH_ESCAPE', 'relative path must not contain NUL bytes')
  }
  const posix = toPosixPath(relativePath)
  if (posix.startsWith('/') || /^[A-Za-z]:\//.test(posix) || posix.startsWith('//')) {
    throw new StoreError('STORE_PATH_ESCAPE', 'relative path must not be absolute')
  }
  const segments = posix.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new StoreError('STORE_PATH_ESCAPE', 'relative path must not contain empty, "." or ".." segments')
  }
  const [first] = segments
  if (first !== STORE_LAYOUT.assets && first !== STORE_LAYOUT.runs) {
    throw new StoreError('STORE_PATH_ESCAPE', 'relative path must start with "assets/" or "runs/"')
  }
  if (first === STORE_LAYOUT.runs) {
    const runId = segments[1]
    if (runId === undefined || !isRunId(runId)) {
      throw new StoreError('STORE_PATH_ESCAPE', 'runs/ path must name a valid runId as its second segment')
    }
  }
  return segments.join('/')
}

/** 把相对证据路径解析成绝对路径，并做最终 containment 校验。 */
export function resolveRecordingPath(root: string, recordingId: RecordingId, relativePath: string): string {
  const normalized = normalizeRelativeRecordingPath(relativePath)
  const dir = recordingDir(root, recordingId)
  const resolved = path.join(dir, ...normalized.split('/'))
  return assertContained(dir, resolved, 'recording file')
}

// ---------------------------------------------------------------------------
// 原子写 / JSON
// ---------------------------------------------------------------------------

export interface AtomicWriteOptions {
  readonly mode?: number
}

/**
 * 原子写文件：同目录临时文件 → 写满 → fsync → rename 覆盖目标。
 * 任一步失败都清理临时文件；磁盘满映射成 STORE_DISK_FULL。
 */
export async function writeFileAtomic(
  filePath: string,
  data: Uint8Array | string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const target = path.resolve(filePath)
  const tmp = tmpNameFor(target)
  const mode = options.mode ?? 0o600
  let handle: fs.FileHandle | undefined
  try {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    handle = await fs.open(tmp, 'wx', mode)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(tmp, target)
    await syncDirectory(path.dirname(target))
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined)
    }
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw mapFsError(error, 'write file')
  }
}

/** manifest 等 JSON 文件：稳定缩进 + 结尾换行，便于人工 diff/审计。 */
export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export interface ReadJsonOptions {
  readonly what: string
  readonly recordingId?: RecordingId
  /** 文件不存在时的错误码；缺省 RECORDING_NOT_FOUND。 */
  readonly missingCode?: 'RECORDING_NOT_FOUND' | 'STORE_CORRUPT_JSONL' | 'STORE_INIT_FAILED'
}

export async function readJsonFile(filePath: string, options: ReadJsonOptions): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new StoreError(
        options.missingCode ?? 'RECORDING_NOT_FOUND',
        `${options.what} does not exist`,
        options.recordingId === undefined ? {} : { recordingId: options.recordingId },
      )
    }
    throw mapFsError(error, `read ${options.what}`, options.recordingId)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new StoreError(
      'STORE_CORRUPT_JSONL',
      `${options.what} is not valid JSON`,
      options.recordingId === undefined ? { cause: error } : { recordingId: options.recordingId, cause: error },
    )
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // rename 的持久化依赖目录 fsync；个别平台/文件系统不支持，失败不影响主流程。
  try {
    const handle = await fs.open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // best-effort：不把不支持目录 fsync 的平台判成写失败。
  }
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate)
    return true
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw mapFsError(error, 'stat path')
  }
}

export async function directorySize(directory: string): Promise<number> {
  let total = 0
  for (const entry of await listEntries(directory)) {
    if (entry.isDirectory()) {
      total += await directorySize(entry.fullPath)
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(entry.fullPath)).size
      } catch {
        // 并发删除时跳过：大小统计是限额提示，不是事实来源。
      }
    }
  }
  return total
}

export interface DirectoryEntry {
  readonly name: string
  readonly fullPath: string
  readonly isFile: () => boolean
  readonly isDirectory: () => boolean
}

/** 列目录（不存在返回空），条目按名称排序，保证导出/恢复结果确定。 */
export async function listEntries(directory: string): Promise<readonly DirectoryEntry[]> {
  let dirents: readonly import('node:fs').Dirent[]
  try {
    dirents = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return []
    throw mapFsError(error, 'list directory')
  }
  return dirents
    .map((dirent) => ({
      name: dirent.name,
      fullPath: path.join(directory, dirent.name),
      isFile: () => dirent.isFile(),
      isDirectory: () => dirent.isDirectory(),
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

// ---------------------------------------------------------------------------
// 哈希
// ---------------------------------------------------------------------------

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 对文件内容做流式 sha256（不整文件载入内存）。 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      hash.update(chunk)
    })
    stream.on('error', (error) => {
      reject(mapFsError(error, 'hash file'))
    })
    stream.on('end', () => {
      resolve()
    })
  })
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// Store 根初始化 / 错误映射
// ---------------------------------------------------------------------------

/**
 * 建立 Store 根：`recordings/`、`exports/`、`tmp/` 与目录级 `.gitignore`。
 *
 * 该目录含 URL、输入摘要与截图，必须默认被 Git 忽略（plan §4.3「建议目录权限 0700」）。
 */
export async function ensureStoreRoot(root: string): Promise<string> {
  const resolved = path.resolve(root)
  try {
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 })
    await fs.mkdir(recordingsDir(resolved), { recursive: true, mode: 0o700 })
    await fs.mkdir(exportsDir(resolved), { recursive: true, mode: 0o700 })
    await fs.mkdir(tmpDir(resolved), { recursive: true, mode: 0o700 })
    const gitignore = path.join(resolved, STORE_LAYOUT.gitignore)
    if (!(await pathExists(gitignore))) {
      await writeFileAtomic(gitignore, STORE_LAYOUT.gitignoreContent)
    }
  } catch (error) {
    if (error instanceof StoreError) throw error
    throw mapFsError(error, 'initialize store root')
  }
  return resolved
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

/** 文件系统错误 → Store 稳定错误码（消息不含绝对路径）。 */
export function mapFsError(error: unknown, action: string, recordingId?: RecordingId): StoreError {
  const ids = recordingId === undefined ? {} : { recordingId }
  if (error instanceof StoreError) return error
  if (isErrno(error, 'ENOSPC') || isErrno(error, 'EDQUOT')) {
    return new StoreError('STORE_DISK_FULL', `disk is full while trying to ${action}`, { ...ids, cause: error })
  }
  if (isErrno(error, 'ENOENT')) {
    return new StoreError('RECORDING_NOT_FOUND', `missing file while trying to ${action}`, { ...ids, cause: error })
  }
  if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM') || isErrno(error, 'EROFS')) {
    return new StoreError('STORE_INIT_FAILED', `permission denied while trying to ${action}`, {
      ...ids,
      cause: error,
    })
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new StoreError('STORE_INIT_FAILED', `${action} failed: ${detail}`, { ...ids, cause: error })
}
