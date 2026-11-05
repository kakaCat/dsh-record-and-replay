import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CuaTransport } from '../../../src/cua/transport.js'
import { resolveDockerConfig } from '../../../src/docker/config.js'
import { DockerCuaRuntime, type DockerExec } from '../../../src/docker/runtime.js'

let imageSequence = 0

afterEach(() => {
  vi.unstubAllEnvs()
})

function fakeTransport(): CuaTransport {
  return {
    kind: 'mcp',
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
  }
}

function runtimeFor(
  root: string,
  exec: DockerExec,
  options: {
    readonly autoBuild?: boolean
    readonly persistProfiles?: boolean
    readonly transportFactory?: (options: unknown) => Promise<CuaTransport>
    readonly spawnProcess?: typeof spawn
  } = {},
): DockerCuaRuntime {
  imageSequence += 1
  return new DockerCuaRuntime({
    config: resolveDockerConfig({
      image: `example.test/dsh-record-replay:test-${imageSequence}`,
      ...(options.autoBuild === undefined ? {} : { autoBuild: options.autoBuild }),
      ...(options.persistProfiles === undefined ? {} : { persistProfiles: options.persistProfiles }),
    }),
    workspaceRoot: root,
    storeRoot: join(root, '.dsh', 'record-replay'),
    exec,
    ...(options.transportFactory === undefined ? {} : { transportFactory: options.transportFactory as never }),
    ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
  })
}

describe('docker/runtime', () => {
  it('builds the bundled image once, starts one constrained container and connects MCP through docker exec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-docker-runtime-'))
    const calls: string[][] = []
    const exec: DockerExec = async (args) => {
      calls.push([...args])
      if (args[0] === 'image' && args[1] === 'inspect') throw new Error('No such image')
      if (args[0] === 'container' && args[1] === 'inspect') return 'true'
      return ''
    }
    let connectOptions: { command?: string; args?: readonly string[]; env?: Record<string, string> } | undefined
    vi.stubEnv('DOCKER_HOST', 'unix:///tmp/dsh-docker-test.sock')
    vi.stubEnv('DOCKER_CONTEXT', 'dsh-test-context')
    const runtime = runtimeFor(root, exec, {
      transportFactory: async (options) => {
        connectOptions = options as { command?: string; args?: readonly string[]; env?: Record<string, string> }
        return fakeTransport()
      },
    })
    try {
      const first = await runtime.ensureContainer()
      await expect(runtime.ensureContainer()).resolves.toBe(first)
      await runtime.connect()

      expect(calls.filter(call => call[0] === 'build')).toHaveLength(1)
      expect(calls.filter(call => call[0] === 'run')).toHaveLength(1)
      const run = calls.find(call => call[0] === 'run') ?? []
      expect(run).toEqual(expect.arrayContaining([
        '--platform', runtime.platform,
        '--read-only',
        '--rm',
        '--cap-drop', 'ALL',
        '--cap-add', 'SYS_ADMIN',
        '--cap-add', 'SYS_CHROOT',
      ]))
      expect(run.join(' ')).toContain(`type=bind,source=${runtime.storeRoot},target=/out`)
      expect(run.join(' ')).toContain(`type=volume,source=dsh-rr-cua-home-`)
      expect(run.join(' ')).not.toContain('docker.sock')
      expect(connectOptions).toEqual({
        command: 'docker',
        args: ['exec', '-i', runtime.containerName, 'cua-driver', 'mcp'],
        env: {
          DOCKER_HOST: 'unix:///tmp/dsh-docker-test.sock',
          DOCKER_CONTEXT: 'dsh-test-context',
        },
        connectTimeoutMs: 30_000,
      })

      await runtime.dispose()
      expect(calls.at(-1)).toEqual(['rm', '--force', runtime.containerName])
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when autoBuild is disabled and the image is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-docker-runtime-'))
    const calls: string[][] = []
    const runtime = runtimeFor(root, async (args) => {
      calls.push([...args])
      if (args[0] === 'image') throw new Error('No such image')
      return ''
    }, { autoBuild: false })
    try {
      await expect(runtime.ensureContainer()).rejects.toMatchObject({ code: 'CUA_TRANSPORT_UNAVAILABLE' })
      expect(calls.some(call => call[0] === 'build')).toBe(false)
      expect(calls.some(call => call[0] === 'run')).toBe(false)
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps only store-contained video paths into the container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-docker-runtime-'))
    const runtime = runtimeFor(root, async () => '')
    try {
      const host = join(runtime.storeRoot, 'recordings', 'rec_a', 'runs', 'run_b', 'video', 'replay.webm')
      expect(runtime.containerPathFor(host)).toBe('/out/recordings/rec_a/runs/run_b/video/replay.webm')
      expect(() => runtime.containerPathFor(join(root, 'outside.webm'))).toThrow(/inside the recording store/)
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records Xvfb through container ffmpeg and finalizes into the host run directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-docker-runtime-'))
    const outputDir = join(root, '.dsh', 'record-replay', 'recordings', 'rec_a', 'runs', 'run_b', 'video')
    const hostFile = join(outputDir, 'replay.webm')
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>
    const stdin = new EventEmitter() as unknown as NonNullable<ReturnType<typeof spawn>['stdin']>
    Object.assign(child, { exitCode: null, signalCode: null, kill: vi.fn() })
    Object.assign(stdin, {
      writable: true,
      write: vi.fn(() => true),
      end: vi.fn(() => {
        writeFileSync(hostFile, 'docker video')
        Object.assign(child, { exitCode: 0 })
        child.emit('exit')
        return stdin
      }),
    })
    Object.assign(child, { stdin })
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn
    const runtime = runtimeFor(root, async (args) => args[0] === 'container' ? 'true' : '', { spawnProcess })
    const recorder = runtime.createVideoRecorder()
    try {
      await recorder.start({ outputDir })
      await expect(recorder.stop()).resolves.toBe(hostFile)
      expect(spawnProcess).toHaveBeenCalledOnce()
      const [binary, args] = vi.mocked(spawnProcess).mock.calls[0] as unknown as [string, string[]]
      expect(binary).toBe('docker')
      expect(args.slice(0, 2)).toEqual(['exec', '-i'])
      expect(args).toContain(runtime.containerName)
      expect(args).toContain('x11grab')
      expect(args).toContain(':99.0')
      expect(args.at(-1)).toBe('/out/recordings/rec_a/runs/run_b/video/replay.webm')
      expect(stdin.write).toHaveBeenCalledWith('q')
    } finally {
      await recorder.stop()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recreates an owned container after it stops instead of caching the dead name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-docker-runtime-'))
    let running = false
    let runs = 0
    const runtime = runtimeFor(root, async (args) => {
      if (args[0] === 'image') return ''
      if (args[0] === 'run') {
        runs += 1
        running = true
        return 'container-id'
      }
      if (args[0] === 'container') return running ? 'true' : 'false'
      if (args[0] === 'exec') {
        if (!running) throw new Error('container is not running')
        return ''
      }
      return ''
    })
    try {
      await runtime.ensureContainer()
      running = false
      await runtime.ensureContainer()
      expect(runs).toBe(2)
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-inspects images for later runtimes and runs profile hygiene inside Docker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-docker-runtime-'))
    const image = 'example.test/dsh-record-replay:shared-image-check'
    let inspections = 0
    const calls: string[][] = []
    const exec: DockerExec = async (args) => {
      calls.push([...args])
      if (args[0] === 'image') inspections += 1
      if (args[0] === 'container') return 'true'
      return ''
    }
    const first = new DockerCuaRuntime({
      config: resolveDockerConfig({ image }),
      workspaceRoot: root,
      storeRoot: root,
      exec,
    })
    const second = new DockerCuaRuntime({
      config: resolveDockerConfig({ image }),
      workspaceRoot: root,
      storeRoot: root,
      exec,
    })
    try {
      await first.ensureContainer()
      await second.ensureContainer()
      expect(inspections).toBe(2)
      await second.prepareProfile('demo-profile')
      const hygiene = calls.find(call => call[0] === 'exec' && call.includes('python3'))
      expect(hygiene).toBeDefined()
      expect(hygiene?.at(-1)).toBe('demo-profile')
      await expect(second.prepareProfile('../outside')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    } finally {
      await first.dispose()
      await second.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
