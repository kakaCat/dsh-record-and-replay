/**
 * 直接 ffmpeg 录屏（WebM/VP9），用于回放视频。
 * 不走 Cua 的录制器：它固定输出 mp4，二次转码既慢又占盘。
 */
import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type VideoFormat = 'webm' | 'mp4'

export interface ScreenRecorderOptions {
  readonly outputDir: string
  readonly name?: string
  readonly format?: VideoFormat
  readonly fps?: number
  readonly width?: number
  readonly crf?: number
  /** avfoundation 输入，默认 `0:none`（第一块屏幕、不录音）。 */
  readonly input?: string
  readonly ffmpegPath?: string
}

/** 生成 ffmpeg 参数；导出便于单测，不实际起进程。 */
export function screenRecorderArgs(options: ScreenRecorderOptions, file: string): readonly string[] {
  const format = options.format ?? 'webm'
  const codec = format === 'mp4'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(options.crf ?? 28), '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libvpx-vp9', '-crf', String(options.crf ?? 36), '-b:v', '0']
  return [
    '-y',
    '-f', 'avfoundation',
    '-i', options.input ?? process.env['DSH_REPLAY_VIDEO_INPUT'] ?? '0:none',
    '-r', String(options.fps ?? 10),
    '-vf', `scale=${String(options.width ?? 1280)}:-2`,
    ...codec,
    '-an',
    file,
  ]
}

export class ScreenRecorder {
  private child: ReturnType<typeof spawn> | undefined
  private file: string | undefined

  /** 启动录屏；失败（ffmpeg 缺失/无权限）静默降级，不影响回放。 */
  async start(options: ScreenRecorderOptions): Promise<void> {
    if (this.child !== undefined) return
    await mkdir(options.outputDir, { recursive: true })
    const format = options.format ?? 'webm'
    const file = join(options.outputDir, options.name ?? `replay.${format}`)
    const child = spawn(options.ffmpegPath ?? 'ffmpeg', screenRecorderArgs(options, file), {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.once('error', () => {
      this.child = undefined
    })
    this.child = child
    this.file = file
    // 给 ffmpeg 一点启动时间；立即退出说明录不了，直接降级。
    await new Promise<void>(resolve => setTimeout(resolve, 400))
    if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
      this.child = undefined
    }
  }

  /** SIGINT 让 WebM 正常收尾；返回文件路径，失败返回 undefined。 */
  async stop(): Promise<string | undefined> {
    const child = this.child
    const file = this.file
    this.child = undefined
    this.file = undefined
    if (child === undefined || file === undefined) return undefined
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGINT')
    })
    // ffmpeg 在 SIGINT 下可能以非 0 退出，但 WebM 已正常收尾；以文件是否可读且非空为准。
    try {
      const info = await stat(file)
      return info.size > 0 ? file : undefined
    } catch {
      return undefined
    }
  }
}
