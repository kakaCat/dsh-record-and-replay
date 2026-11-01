import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneRecordingVideos } from '../../../src/cua/video-retention.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function run(dir: string, status: string, name: string, mtimeMs: number): Promise<void> {
  const videoDir = join(dir, 'video')
  await mkdir(videoDir, { recursive: true })
  await writeFile(join(dir, 'run.json'), JSON.stringify({ status }))
  await writeFile(join(videoDir, name), 'x')
  const { utimes } = await import('node:fs/promises')
  await utimes(join(videoDir, name), new Date(mtimeMs), new Date(mtimeMs))
}

describe('cua/video-retention', () => {
  it('keeps the newest N completed videos and never deletes failed runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-retention-'))
    roots.push(root)
    const runs = join(root, 'runs')
    await run(join(runs, 'old'), 'completed', 'old.webm', 1_000)
    await run(join(runs, 'mid'), 'failed', 'mid.webm', 2_000)
    await run(join(runs, 'new'), 'completed', 'new.webm', 3_000)

    const removed = await pruneRecordingVideos({ runsDir: runs, keep: 1 })
    expect(removed.map(path => path.split('/').at(-3))).toEqual(['old'])
    expect(await import('node:fs/promises').then(fs => fs.access(join(runs, 'mid', 'video', 'mid.webm')).then(() => true, () => false))).toBe(true)
  })
})
