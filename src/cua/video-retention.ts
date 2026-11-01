/** 回放视频留存：每个 workspace 只保留最近 N 个，失败/取消的 Run 不删。 */
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface PruneVideosOptions {
  /** `<root>/recordings/<recordingId>/runs` 的绝对路径。 */
  readonly runsDir: string
  /** 保留的最近视频数量（>=1）。 */
  readonly keep: number
}

/** 返回被删除的文件路径；失败/取消的 Run 与状态不可读的 Run 一律保留。 */
export async function pruneRecordingVideos(options: PruneVideosOptions): Promise<readonly string[]> {
  if (!Number.isInteger(options.keep) || options.keep < 1) return []
  let runs: string[]
  try {
    runs = await readdir(options.runsDir)
  } catch {
    return []
  }
  const videos: Array<{ path: string; runDir: string; mtime: number }> = []
  for (const run of runs) {
    const runDir = join(options.runsDir, run)
    const videoDir = join(runDir, 'video')
    let files: string[]
    try {
      files = await readdir(videoDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!/\.(webm|mp4)$/u.test(file)) continue
      const path = join(videoDir, file)
      try {
        const info = await stat(path)
        videos.push({ path, runDir, mtime: info.mtimeMs })
      } catch {
        // 统计失败的文件跳过。
      }
    }
  }
  videos.sort((a, b) => b.mtime - a.mtime)
  const removed: string[] = []
  for (const candidate of videos.slice(options.keep)) {
    let status = 'unknown'
    try {
      const raw: unknown = JSON.parse(await readFile(join(candidate.runDir, 'run.json'), 'utf8'))
      const record = raw as { status?: unknown }
      if (typeof record.status === 'string') status = record.status
    } catch {
      // 状态读不到就保留，宁可不删。
      continue
    }
    if (status !== 'completed') continue
    try {
      await unlink(candidate.path)
      removed.push(candidate.path)
    } catch {
      // 删除失败忽略，下次再试。
    }
  }
  return removed
}
