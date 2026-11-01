#!/usr/bin/env node
// 统计回放视频占用：node scripts/video-usage.mjs [--root <dir>]
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const rootIndex = process.argv.indexOf('--root')
const root = resolve(rootIndex > 0 ? process.argv[rootIndex + 1] : '.dsh/record-replay/recordings')

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

async function dirs(path) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

let totalFiles = 0
let totalBytes = 0
const perRecording = []
for (const recording of await dirs(root)) {
  const runsDir = join(root, recording, 'runs')
  let files = 0
  let bytes = 0
  for (const run of await dirs(runsDir)) {
    const videoDir = join(runsDir, run, 'video')
    try {
      for (const file of await readdir(videoDir)) {
        if (!/\.(webm|mp4)$/u.test(file)) continue
        const info = await stat(join(videoDir, file))
        files += 1
        bytes += info.size
      }
    } catch {
      // 无视频目录
    }
  }
  if (files > 0) perRecording.push({ recording, files, bytes })
  totalFiles += files
  totalBytes += bytes
}

for (const entry of perRecording.sort((a, b) => b.bytes - a.bytes)) {
  console.log(`${entry.recording}  ${String(entry.files).padStart(3)} 次  ${human(entry.bytes)}`)
}
console.log(`---\n合计: ${totalFiles} 个视频, ${human(totalBytes)}`)
