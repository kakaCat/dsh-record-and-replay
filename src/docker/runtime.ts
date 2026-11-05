import { execFile, spawn, type SpawnOptions } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { McpTransport, type McpTransportOptions } from '../cua/mcp-transport.js'
import {
  ScreenRecorder,
  type ScreenRecorderOptions,
  type VideoRecorder,
} from '../cua/screen-recorder.js'
import { CuaTransportError, type CuaTransport } from '../cua/transport.js'
import { HostError } from '../host/config.js'
import { isProfileName } from '../core/contracts.js'
import { bundledDockerContext, bundledDockerImageTag } from './assets.js'
import type { DockerPluginConfig } from './config.js'

const execFileAsync = promisify(execFile)
const READY_FILE = '/tmp/dsh-record-replay-ready'
const OUTPUT_ROOT = '/out'
const MANAGED_LABEL = 'dsh.record-replay.managed=true'
const PROFILE_HYGIENE_SCRIPT = `import json, os, sys
path = os.path.join(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")), "CuaDriver", "BrowserProfiles", sys.argv[1], "Default", "Preferences")
if os.path.isfile(path):
    try:
        with open(path, encoding="utf-8") as source:
            document = json.load(source)
        if isinstance(document, dict):
            profile = document.get("profile") if isinstance(document.get("profile"), dict) else {}
            session = document.get("session") if isinstance(document.get("session"), dict) else {}
            document["profile"] = {**profile, "exit_type": "Normal", "exited_cleanly": True}
            document["session"] = {**session, "restore_on_startup": 1}
            with open(path, "w", encoding="utf-8") as target:
                json.dump(document, target)
    except (OSError, ValueError):
        pass
`
const DOCKER_CONNECTION_ENV = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'DOCKER_API_VERSION',
] as const

/** Preserve the daemon selected by the host for the MCP docker exec child too. */
export function dockerConnectionEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(DOCKER_CONNECTION_ENV.flatMap(key => {
    const value = env[key]
    return value === undefined ? [] : [[key, value] as const]
  }))
}

export type DockerPlatform = 'linux/amd64' | 'linux/arm64'

/** Use a native container so /proc/<browser>/exe retains its real identity. */
export function hostDockerPlatform(arch: string = process.arch): DockerPlatform {
  if (arch === 'x64') return 'linux/amd64'
  if (arch === 'arm64') return 'linux/arm64'
  throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', `Docker Cua backend does not support host architecture ${arch}`)
}

export type DockerExec = (args: readonly string[], timeoutMs: number) => Promise<string>

export interface DockerCuaRuntimeOptions {
  readonly config: DockerPluginConfig
  readonly workspaceRoot: string
  readonly storeRoot: string
  /** Test seam; production uses the configured host Docker CLI. */
  readonly exec?: DockerExec
  readonly transportFactory?: (options: McpTransportOptions) => Promise<CuaTransport>
  readonly spawnProcess?: typeof spawn
}

function dockerError(action: string, error: unknown): CuaTransportError {
  const candidate = error as { stderr?: unknown; message?: unknown }
  const detail = typeof candidate.stderr === 'string' && candidate.stderr.trim().length > 0
    ? candidate.stderr.trim()
    : typeof candidate.message === 'string' ? candidate.message : String(error)
  const tail = detail.split('\n').filter(line => line.trim().length > 0).slice(-8).join('\n').slice(0, 2_000)
  return new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', `Docker ${action} failed: ${tail}`, { cause: error })
}

async function defaultExec(binary: string, args: readonly string[], timeoutMs: number): Promise<string> {
  try {
    const result = await execFileAsync(binary, [...args], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    })
    return result.stdout.trim()
  } catch (error) {
    throw dockerError(args[0] ?? 'command', error)
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, durationMs))
}

// Several workspaces can request the same bundled image concurrently. Share the
// inspect/build promise so only one Docker build runs for a given asset digest.
const imageRequests = new Map<string, Promise<string>>()

/** Owns one plugin-managed virtual-desktop container for one DSH workspace. */
export class DockerCuaRuntime {
  readonly config: DockerPluginConfig
  readonly workspaceRoot: string
  readonly storeRoot: string
  readonly containerName: string
  readonly platform: DockerPlatform

  private readonly exec: DockerExec
  private readonly transportFactory: (options: McpTransportOptions) => Promise<CuaTransport>
  private readonly spawnProcess: typeof spawn
  private readonly workspaceKey: string
  private containerPromise: Promise<string> | undefined
  private recoveryPromise: Promise<string> | undefined
  private closed = false

  constructor(options: DockerCuaRuntimeOptions) {
    this.config = options.config
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.storeRoot = path.resolve(options.storeRoot)
    this.workspaceKey = pathKey(this.workspaceRoot)
    this.platform = hostDockerPlatform()
    this.containerName = `dsh-rr-${this.workspaceKey}-${randomUUID().slice(0, 8)}`
    this.exec = options.exec ?? ((args, timeoutMs) => defaultExec(this.config.dockerBin, args, timeoutMs))
    this.transportFactory = options.transportFactory ?? (transportOptions => McpTransport.create(transportOptions))
    this.spawnProcess = options.spawnProcess ?? spawn
  }

  private async prepareImage(image: string, context: string): Promise<string> {
    await this.exec(['info', '--format', '{{.ServerVersion}}'], 15_000)
    try {
      await this.exec(['image', 'inspect', image], 15_000)
      return image
    } catch (error) {
      if (!this.config.autoBuild) {
        throw new CuaTransportError(
          'CUA_TRANSPORT_UNAVAILABLE',
          `Docker image ${image} is unavailable and docker.autoBuild is false`,
          { cause: error },
        )
      }
    }
    await this.exec([
      'build',
      '--platform', this.platform,
      '--tag', image,
      '--file', path.join(context, 'Dockerfile'),
      context,
    ], this.config.buildTimeoutMs)
    return image
  }

  private async ensureImage(): Promise<string> {
    const context = bundledDockerContext()
    const image = this.config.image ?? await bundledDockerImageTag(context, this.platform)
    const key = `${this.config.dockerBin}\0${image}\0${context}\0${String(this.config.autoBuild)}`
    let request = imageRequests.get(key)
    if (request === undefined) {
      request = this.prepareImage(image, context)
      imageRequests.set(key, request)
    }
    try {
      return await request
    } finally {
      // Share only in-flight work. A later runtime must inspect again so an
      // externally pruned image can be rebuilt instead of using a stale success.
      if (imageRequests.get(key) === request) imageRequests.delete(key)
    }
  }

  private async waitUntilReady(deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      try {
        await this.exec(['exec', this.containerName, 'test', '-f', READY_FILE], 2_000)
        return
      } catch {
        // The container can exist before Xvfb/Openbox have finished starting.
      }
      await sleep(100)
    }
    throw new CuaTransportError(
      'CUA_TRANSPORT_UNAVAILABLE',
      `Docker virtual desktop did not become ready within ${this.config.startupTimeoutMs}ms`,
    )
  }

  private async startContainer(): Promise<string> {
    const image = await this.ensureImage()
    await mkdir(this.storeRoot, { recursive: true })
    const args = [
      'run', '--detach', '--rm', '--init',
      '--platform', this.platform,
      '--name', this.containerName,
      '--label', MANAGED_LABEL,
      '--label', `dsh.record-replay.workspace=${this.workspaceKey}`,
      '--mount', `type=bind,source=${this.storeRoot},target=${OUTPUT_ROOT}`,
      ...(this.config.persistProfiles
        ? ['--mount', `type=volume,source=dsh-rr-cua-home-${this.workspaceKey},target=/var/lib/cua`]
        : ['--tmpfs', '/var/lib/cua:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700']),
      '--env', `DISPLAY=${this.config.display}`,
      '--env', `CUA_SCREEN_WIDTH=${String(this.config.width)}`,
      '--env', `CUA_SCREEN_HEIGHT=${String(this.config.height)}`,
      '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
      '--cap-drop', 'ALL',
      // Chrome's namespace sandbox needs these two capabilities even for its
      // unprivileged runtime user. The container remains non-root and read-only.
      '--cap-add', 'SYS_ADMIN',
      '--cap-add', 'SYS_CHROOT',
      '--pids-limit', '512',
      '--memory', '2g',
      '--cpus', '2',
      '--shm-size', '512m',
      image,
    ]
    try {
      await this.exec(args, this.config.startupTimeoutMs)
      await this.waitUntilReady(Date.now() + this.config.startupTimeoutMs)
      return this.containerName
    } catch (error) {
      await this.stopContainer()
      throw error
    }
  }

  async ensureContainer(): Promise<string> {
    if (this.closed) {
      throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', 'Docker runtime is closed')
    }
    if (this.recoveryPromise !== undefined) return this.recoveryPromise
    if (this.containerPromise === undefined) this.containerPromise = this.startContainer()
    const pending = this.containerPromise
    try {
      const container = await pending
      const running = await this.exec([
        'container', 'inspect', '--format', '{{.State.Running}}', container,
      ], 5_000)
      if (running.trim() === 'true') return container
    } catch {
      // A failed start, external removal, Docker restart or a stopped container
      // all enter the same owned-container recovery path below.
    }
    if (this.closed) throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', 'Docker runtime is closed')

    const recovery = (async (): Promise<string> => {
      if (this.containerPromise === pending) this.containerPromise = undefined
      await this.stopContainer()
      const next = this.startContainer()
      this.containerPromise = next
      return next
    })()
    this.recoveryPromise = recovery
    try {
      return await recovery
    } finally {
      if (this.recoveryPromise === recovery) this.recoveryPromise = undefined
    }
  }

  /** Connect the existing MCP client to a Cua runtime inside this container. */
  async connect(): Promise<CuaTransport> {
    const container = await this.ensureContainer()
    return this.transportFactory({
      command: this.config.dockerBin,
      args: ['exec', '-i', container, 'cua-driver', 'mcp'],
      env: dockerConnectionEnvironment(),
      connectTimeoutMs: this.config.startupTimeoutMs,
    })
  }

  /** ffmpeg runs as the host uid/gid so a non-root container can write the bind mount. */
  spawnRecorderProcess(command: string, args: readonly string[], options: SpawnOptions): ReturnType<typeof spawn> {
    if (this.containerPromise === undefined) {
      throw new CuaTransportError('CUA_TRANSPORT_UNAVAILABLE', 'Docker container has not been started')
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined
    return this.spawnProcess(this.config.dockerBin, [
      'exec', '-i',
      ...(uid === undefined || gid === undefined ? [] : ['--user', `${String(uid)}:${String(gid)}`]),
      this.containerName,
      command,
      ...args,
    ], options)
  }

  containerPathFor(hostFile: string): string {
    const relative = path.relative(this.storeRoot, path.resolve(hostFile))
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new HostError('INVALID_ARGUMENT', 'Docker video output must stay inside the recording store')
    }
    return relative.length === 0 ? OUTPUT_ROOT : `${OUTPUT_ROOT}/${relative.split(path.sep).join('/')}`
  }

  /** Apply the existing named-profile cleanup without touching host files. */
  async prepareProfile(profileName: string): Promise<void> {
    if (!isProfileName(profileName)) {
      throw new HostError('INVALID_ARGUMENT', 'profileName must be 1-64 path-safe ASCII characters')
    }
    const container = await this.ensureContainer()
    await this.exec([
      'exec', container, 'python3', '-c', PROFILE_HYGIENE_SCRIPT, profileName,
    ], 10_000).catch(() => undefined)
  }

  createVideoRecorder(): VideoRecorder {
    return new DockerVideoRecorder(this)
  }

  private async stopContainer(): Promise<void> {
    await this.exec(['rm', '--force', this.containerName], 10_000).catch(() => undefined)
  }

  /** Restart only the container owned by this workspace after a failed bind setup. */
  async restart(): Promise<void> {
    if (this.closed) return
    const pending = this.containerPromise
    const recovery = this.recoveryPromise
    this.containerPromise = undefined
    this.recoveryPromise = undefined
    if (pending !== undefined) await pending.catch(() => undefined)
    if (recovery !== undefined) await recovery.catch(() => undefined)
    await this.stopContainer()
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const pending = this.containerPromise
    const recovery = this.recoveryPromise
    this.containerPromise = undefined
    this.recoveryPromise = undefined
    if (pending !== undefined) await pending.catch(() => undefined)
    if (recovery !== undefined) await recovery.catch(() => undefined)
    await this.stopContainer()
  }
}

function pathKey(workspaceRoot: string): string {
  // A short digest keeps names bounded without exposing the host workspace path.
  return createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12)
}

class DockerVideoRecorder implements VideoRecorder {
  private recorder: ScreenRecorder | undefined

  constructor(private readonly runtime: DockerCuaRuntime) {}

  async start(options: ScreenRecorderOptions): Promise<void> {
    await this.runtime.ensureContainer()
    const format = options.format ?? 'webm'
    const name = options.name ?? `replay.${format}`
    const hostFile = path.join(options.outputDir, name)
    const recorder = new ScreenRecorder(((command: string, args?: readonly string[], spawnOptions?: SpawnOptions) =>
      this.runtime.spawnRecorderProcess(command, args ?? [], spawnOptions ?? {})) as typeof spawn)
    this.recorder = recorder
    await recorder.start({
      ...options,
      platform: 'linux',
      input: `${this.runtime.config.display}.0`,
      fileArgument: this.runtime.containerPathFor(hostFile),
    })
  }

  async stop(): Promise<string | undefined> {
    const recorder = this.recorder
    this.recorder = undefined
    return recorder?.stop()
  }
}
