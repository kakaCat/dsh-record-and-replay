import { describe, expect, it } from 'vitest'
import { screenRecorderArgs } from '../../../src/cua/screen-recorder.js'

describe('cua/screen-recorder', () => {
  it('records WebM/VP9 from the first screen with a bounded size', () => {
    const args = screenRecorderArgs({ outputDir: '/tmp/video', width: 1280, fps: 10, crf: 36 }, '/tmp/video/replay.webm')
    expect(args).toContain('avfoundation')
    expect(args).toContain('libvpx-vp9')
    expect(args).toContain('scale=1280:-2')
    expect(args).toContain('/tmp/video/replay.webm')
    expect(args.join(' ')).toContain('-an')

    const mp4 = screenRecorderArgs({ outputDir: '/tmp/video', format: 'mp4' }, '/tmp/video/replay.mp4')
    expect(mp4).toContain('libx264')
    expect(mp4).toContain('yuv420p')
  })
})
