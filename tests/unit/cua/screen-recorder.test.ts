import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ScreenRecorder, screenRecorderArgs } from '../../../src/cua/screen-recorder.js'

type RecorderProcess = ReturnType<typeof spawn>

function fakeRecorderProcess(onQuit: () => void): {
  readonly child: RecorderProcess
  readonly stdin: NonNullable<RecorderProcess['stdin']>
} {
  const child = new EventEmitter() as unknown as RecorderProcess
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  })
  const stdin = new EventEmitter() as unknown as NonNullable<RecorderProcess['stdin']>
  Object.assign(stdin, {
    writable: true,
    write: vi.fn(() => true),
    end: vi.fn(() => {
      Object.assign(child, { exitCode: 0 })
      onQuit()
      child.emit('exit')
      return stdin
    }),
  })
  Object.assign(child, { stdin })
  return { child, stdin }
}

describe('cua/screen-recorder', () => {
  it('records WebM/VP9 from the first macOS screen with a bounded size', () => {
    const args = screenRecorderArgs({ outputDir: '/tmp/video', platform: 'darwin', input: '0:none', width: 1280, fps: 10, crf: 36 }, '/tmp/video/replay.webm')
    expect(args).toContain('avfoundation')
    expect(args).toContain('0:none')
    expect(args).toContain('libvpx-vp9')
    expect(args).toContain('scale=1280:-2')
    expect(args).toContain('/tmp/video/replay.webm')
    expect(args.join(' ')).toContain('-an')

    const mp4 = screenRecorderArgs({ outputDir: '/tmp/video', platform: 'darwin', format: 'mp4' }, '/tmp/video/replay.mp4')
    expect(mp4).toContain('libx264')
    expect(mp4).toContain('yuv420p')
  })

  it('uses the Windows desktop capture input without changing the encoder', () => {
    const args = screenRecorderArgs({ outputDir: 'C:\\video', platform: 'win32', input: 'desktop' }, 'C:\\video\\replay.webm')
    expect(args).toEqual(expect.arrayContaining(['-f', 'gdigrab', '-i', 'desktop', 'libvpx-vp9']))
    expect(args).not.toContain('avfoundation')
  })

  it('captures a Linux virtual display and supports a container-visible output path', () => {
    const args = screenRecorderArgs({
      outputDir: '/host/video',
      platform: 'linux',
      input: ':99.0',
      fileArgument: '/out/run/video/replay.webm',
    }, '/host/video/replay.webm')
    expect(args).toEqual(expect.arrayContaining(['-f', 'x11grab', '-i', ':99.0']))
    expect(args.at(-1)).toBe('/out/run/video/replay.webm')
    expect(args).not.toContain('avfoundation')
  })

  it('finalizes the video through ffmpeg q instead of POSIX signals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'screen-recorder-'))
    const file = join(root, 'replay.webm')
    const { child, stdin } = fakeRecorderProcess(() => writeFileSync(file, 'finalized video'))
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn
    const recorder = new ScreenRecorder(spawnProcess)
    try {
      await recorder.start({ outputDir: root, platform: 'win32' })
      await expect(recorder.stop()).resolves.toBe(file)
      expect(stdin.write).toHaveBeenCalledWith('q')
      expect(stdin.end).toHaveBeenCalledOnce()
      expect(child.kill).not.toHaveBeenCalled()
      expect(spawnProcess).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['gdigrab']), {
        stdio: ['pipe', 'ignore', 'ignore'],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
