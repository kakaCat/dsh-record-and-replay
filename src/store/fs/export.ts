/**
 * `.dshreplay` 导出（design/interfaces.md IF-4 Exporter、design/data-model.md M3「导出无 lock/tmp」、
 * plan §4.5 第 7 条）。
 *
 * 归档格式（`formatVersion: 1`）：
 * - 单文件：header + files 的 JSON 再 gzip（`readArchive` 也接受未压缩 JSON，便于调试）；
 * - `files[].path` 是相对 Recording 目录的 POSIX 路径；每份内容带 sha256 与字节数，读入时校验；
 * - Run 默认不导出（用户显式 `includeRuns` 时才附加）；锁、临时文件、坏尾备份一律排除；
 * - 导出只读 Recording 事实，绝不写回原目录。
 *
 * 容量说明：V1 把内容整体读入内存再 gzip；500 MiB 级 assets 导出应在上层限制或后续版本改为
 * 流式容器（接口形状不变）。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { isRecordingId, type RecordingId } from '../../core/api.js'
import {
  StoreError,
  parseManifest,
  type DshReplayArchive,
  type DshReplayFileEntry,
  type ExportRecordingInput,
  type ExportResult,
  type RecordingExporter,
} from '../api.js'
import {
  STORE_LAYOUT,
  assertSafeRecordingId,
  ensureStoreRoot,
  exportsDir,
  isCorruptBackupName,
  isErrno,
  isTmpName,
  listEntries,
  manifestPath,
  readJsonFile,
  recordingDir,
  sha256Hex,
  toPosixPath,
  writeFileAtomic,
} from './paths.js'

export interface FsExporterOptions {
  readonly root: string
  readonly clock?: () => number
}

export async function createFsExporter(options: FsExporterOptions): Promise<FsExporter> {
  const root = await ensureStoreRoot(options.root)
  return new FsExporter({ ...options, root })
}

export class FsExporter implements RecordingExporter {
  readonly root: string
  private readonly clock: () => number

  constructor(options: FsExporterOptions) {
    if (typeof options.root !== 'string' || options.root.length === 0) {
      throw new StoreError('INVALID_ARGUMENT', 'exporter root must be a non-empty path')
    }
    this.root = path.resolve(options.root)
    this.clock = options.clock ?? Date.now
  }

  async exportRecording(input: ExportRecordingInput): Promise<ExportResult> {
    const recordingId = assertSafeRecordingId(input.recordingId)
    const dir = recordingDir(this.root, recordingId)
    if (!(await directoryExists(dir))) {
      throw new StoreError('RECORDING_NOT_FOUND', 'recording directory does not exist', { recordingId })
    }

    // 先读 manifest：坏 manifest 不导出（避免把不可诊断的数据当成功产物）。
    const rawManifest = await readJsonFile(manifestPath(this.root, recordingId), {
      what: 'manifest',
      recordingId,
    })
    parseManifest(rawManifest, { expectedRecordingId: recordingId })

    const includeRuns = input.includeRuns ?? false
    const files = await collectFiles(dir, includeRuns)
    const entries: DshReplayFileEntry[] = []
    for (const relativePath of files) {
      const absolute = path.join(dir, ...relativePath.split('/'))
      const content = await fs.readFile(absolute)
      entries.push({
        path: relativePath,
        sha256: sha256Hex(content),
        bytes: content.byteLength,
        contentBase64: content.toString('base64'),
      })
    }

    const archive: DshReplayArchive = {
      format: 'dshreplay',
      formatVersion: 1,
      recordingId,
      exportedAt: new Date(this.clock()).toISOString(),
      files: entries,
    }
    const payload = gzipSync(Buffer.from(`${JSON.stringify(archive)}\n`, 'utf8'))
    const destination = this.resolveDestination(recordingId, input.destination)
    await writeFileAtomic(destination, payload, { mode: 0o600 })

    return {
      recordingId,
      filePath: destination,
      fileCount: entries.length,
      bytes: payload.byteLength,
      sha256: sha256Hex(payload),
    }
  }

  async readArchive(filePath: string): Promise<DshReplayArchive> {
    let raw: Buffer
    try {
      raw = await fs.readFile(filePath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new StoreError('RECORDING_NOT_FOUND', 'export file does not exist')
      }
      throw new StoreError('STORE_INIT_FAILED', 'could not read the export file', { cause: error })
    }

    let json: string
    try {
      json = looksGzipped(raw) ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
    } catch (error) {
      throw new StoreError('STORE_CORRUPT_JSONL', 'export file is not a readable .dshreplay archive', {
        cause: error,
      })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(json) as unknown
    } catch (error) {
      throw new StoreError('STORE_CORRUPT_JSONL', 'export file does not contain valid JSON', { cause: error })
    }
    return validateArchive(parsed)
  }

  private resolveDestination(recordingId: RecordingId, destination: string | undefined): string {
    if (destination === undefined || destination.length === 0) {
      return path.join(exportsDir(this.root), `${recordingId}.dshreplay`)
    }
    const resolved = path.isAbsolute(destination)
      ? destination
      : path.resolve(exportsDir(this.root), destination)
    return resolved.endsWith('.dshreplay') ? resolved : `${resolved}.dshreplay`
  }
}

/**
 * 递归收集要导出的文件（相对 Recording 目录的 POSIX 路径，按路径排序保证确定性）。
 *
 * 排除规则：`recording.lock` 及任何 `*.lock`、所有 `*.tmp-*`/`tmp/` 临时内容、
 * `*.corrupt-*`/`*.bak` 坏尾备份；`runs/` 默认排除。
 */
export async function collectFiles(dir: string, includeRuns: boolean): Promise<readonly string[]> {
  const collected: string[] = []

  const walk = async (current: string, relativeDir: string): Promise<void> => {
    for (const entry of await listEntries(current)) {
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (isExcluded(relative, entry.name, includeRuns)) continue
      if (entry.isDirectory()) {
        await walk(entry.fullPath, relative)
      } else if (entry.isFile()) {
        collected.push(relative)
      }
      // 符号链接不跟随：导出只包含 Recording 自己写入的常规文件。
    }
  }

  await walk(dir, '')
  return collected.sort()
}

function isExcluded(relative: string, name: string, includeRuns: boolean): boolean {
  if (name === STORE_LAYOUT.lock || name.endsWith('.lock')) return true
  if (isTmpName(name) || name.startsWith('tmp-')) return true
  if (isCorruptBackupName(name)) return true
  const segments = relative.split('/')
  if (segments.includes(STORE_LAYOUT.tmp)) return true
  if (!includeRuns && segments[0] === STORE_LAYOUT.runs) return true
  return false
}

async function directoryExists(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw error
  }
}

function looksGzipped(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

function validateArchive(value: unknown): DshReplayArchive {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StoreError('STORE_CORRUPT_JSONL', 'export archive must be an object')
  }
  const record = value as Readonly<Record<string, unknown>>
  if (record['format'] !== 'dshreplay') {
    throw new StoreError('STORE_CORRUPT_JSONL', 'export archive format must be "dshreplay"')
  }
  if (record['formatVersion'] !== 1) {
    throw new StoreError('STORE_UNSUPPORTED_VERSION', 'export archive formatVersion must be 1')
  }
  if (!isRecordingId(record['recordingId'])) {
    throw new StoreError('STORE_CORRUPT_JSONL', 'export archive recordingId is invalid')
  }
  if (typeof record['exportedAt'] !== 'string' || record['exportedAt'].length === 0) {
    throw new StoreError('STORE_CORRUPT_JSONL', 'export archive exportedAt must be a non-empty string')
  }
  if (!Array.isArray(record['files'])) {
    throw new StoreError('STORE_CORRUPT_JSONL', 'export archive files must be an array')
  }

  const files: DshReplayFileEntry[] = record['files'].map((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new StoreError('STORE_CORRUPT_JSONL', `export archive files[${String(index)}] must be an object`)
    }
    const file = entry as Readonly<Record<string, unknown>>
    if (typeof file['path'] !== 'string' || file['path'].length === 0) {
      throw new StoreError('STORE_CORRUPT_JSONL', `export archive files[${String(index)}].path is invalid`)
    }
    if (typeof file['contentBase64'] !== 'string') {
      throw new StoreError('STORE_CORRUPT_JSONL', `export archive files[${String(index)}].contentBase64 is invalid`)
    }
    const content = Buffer.from(file['contentBase64'], 'base64')
    const actualSha = sha256Hex(content)
    if (typeof file['sha256'] !== 'string' || file['sha256'] !== actualSha) {
      throw new StoreError('STORE_CORRUPT_JSONL', `export archive files[${String(index)}] sha256 mismatch`)
    }
    if (typeof file['bytes'] !== 'number' || file['bytes'] !== content.byteLength) {
      throw new StoreError('STORE_CORRUPT_JSONL', `export archive files[${String(index)}] byte length mismatch`)
    }
    return {
      path: toPosixPath(file['path']),
      sha256: actualSha,
      bytes: content.byteLength,
      contentBase64: file['contentBase64'],
    }
  })

  return {
    format: 'dshreplay',
    formatVersion: 1,
    recordingId: record['recordingId'],
    exportedAt: record['exportedAt'],
    files,
  }
}
