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
  /** macOS 默认 `0:none`；Windows 默认 `desktop`。 */
  readonly input?: string
  readonly ffmpegPath?: string
  /** 测试可注入平台；生产默认当前操作系统。 */
  readonly platform?: NodeJS.Platform
}

/** 生成 ffmpeg 参数；导出便于单测，不实际起进程。 */
export function screenRecorderArgs(options: ScreenRecorderOptions, file: string): readonly string[] {
  const format = options.format ?? 'webm'
  const codec = format === 'mp4'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(options.crf ?? 28), '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libvpx-vp9', '-crf', String(options.crf ?? 36), '-b:v', '0']
  const platform = options.platform ?? process.platform
  const capture = platform === 'win32'
    ? ['-f', 'gdigrab', '-i', options.input ?? process.env['DSH_REPLAY_VIDEO_INPUT'] ?? 'desktop']
    : ['-f', 'avfoundation', '-i', options.input ?? process.env['DSH_REPLAY_VIDEO_INPUT'] ?? '0:none']
  return [
    '-y',
    ...capture,
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

  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  /** 启动录屏；失败（ffmpeg 缺失/无权限）静默降级，不影响回放。 */
  async start(options: ScreenRecorderOptions): Promise<void> {
    if (this.child !== undefined) return
    await mkdir(options.outputDir, { recursive: true })
    const format = options.format ?? 'webm'
    const file = join(options.outputDir, options.name ?? `replay.${format}`)
    const child = this.spawnProcess(options.ffmpegPath ?? 'ffmpeg', screenRecorderArgs(options, file), {
      // stdin 用于跨平台发送 ffmpeg 的 q 退出命令，让容器正常收尾。
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.once('error', () => {
      this.child = undefined
    })
    // 进程已关闭时 stdin 可能异步报 EPIPE；停止逻辑以 exit/文件为准。
    child.stdin?.on('error', () => undefined)
    this.child = child
    this.file = file
    // 给 ffmpeg 一点启动时间；立即退出说明录不了，直接降级。
    await new Promise<void>(resolve => setTimeout(resolve, 400))
    if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
      this.child = undefined
    }
  }

  /** 写入 q 让 WebM/MP4 正常收尾；返回文件路径，失败返回 undefined。 */
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
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      child.once('exit', done)
      if (child.exitCode !== null || child.signalCode !== null) {
        done()
        return
      }
      if (child.stdin?.writable === true) {
        try {
          child.stdin.write('q')
          child.stdin.end()
        } catch {
          // The child may have exited between the exit-code check and the write.
          child.kill('SIGTERM')
        }
      } else {
        child.kill('SIGTERM')
      }
    })
    // ffmpeg 收尾失败时可能以非 0 退出；以文件是否可读且非空为准。
    try {
      const info = await stat(file)
      return info.size > 0 ? file : undefined
    } catch {
      return undefined
    }
  }
}
