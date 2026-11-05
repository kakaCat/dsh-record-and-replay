import { stat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OperationContext } from '../../src/core/api.js'
import { CuaBrowserDriver } from '../../src/cua/browser-driver.js'
import { CUA_MINIMUM_DRIVER_VERSION } from '../../src/cua/capabilities.js'
import { CuaDriverClient } from '../../src/cua/client.js'
import { cuaVersionOf } from '../../src/cua/health.js'
import { resolveDockerConfig } from '../../src/docker/config.js'
import { DockerCuaRuntime } from '../../src/docker/runtime.js'

const enabled = process.env['DSH_DOCKER_E2E'] === '1'

describe('Docker Cua runtime (real Docker)', () => {
  it('runs isolated Chromium in Xvfb and records a real video through the bind mount', { skip: !enabled, timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-docker-e2e-'))
    const outputDir = join(root, 'recordings', 'rec_docker', 'runs', 'run_docker', 'video')
    const docker = new DockerCuaRuntime({
      config: resolveDockerConfig({ persistProfiles: false }),
      workspaceRoot: root,
      storeRoot: root,
    })
    const recorder = docker.createVideoRecorder()
    let client: CuaDriverClient | undefined
    let binding: Awaited<ReturnType<CuaBrowserDriver['bind']>> | undefined
    try {
      await recorder.start({ outputDir, format: 'webm' })
      const transport = await docker.connect()
      const probe: OperationContext = {
        principal: { sessionId: 'docker-e2e-probe', agentId: 'docker-e2e' },
        callId: 'docker-e2e-health',
        origin: 'internal',
        signal: AbortSignal.timeout(30_000),
      }
      const health = await transport.callTool('health_report', {}, probe)
      const version = cuaVersionOf(health)
      if (version === undefined) throw new Error('container Cua health_report returned no version')
      client = await CuaDriverClient.connect(transport, {
        driverVersion: version,
        minimumDriverVersion: CUA_MINIMUM_DRIVER_VERSION,
        connectTimeoutMs: 30_000,
      })
      const driver = new CuaBrowserDriver(client)
      const context: OperationContext = {
        principal: { sessionId: 'docker-e2e', agentId: 'docker-e2e' },
        callId: 'docker-e2e-bind',
        origin: 'internal',
        signal: AbortSignal.timeout(90_000),
      }
      binding = await driver.bind({ launch: 'isolated' }, context)
      await driver.execute(binding, { kind: 'navigate', url: 'https://example.com' }, undefined, {
        ...context,
        callId: 'docker-e2e-navigate',
      })
      const observation = await driver.observe(binding, { ...context, callId: 'docker-e2e-observe' })
      expect(observation.url).toContain('example.com')

      const videoPath = await recorder.stop()
      expect(videoPath).toBe(join(outputDir, 'replay.webm'))
      expect((await stat(videoPath ?? '')).size).toBeGreaterThan(0)
    } finally {
      if (binding !== undefined && client !== undefined) {
        await new CuaBrowserDriver(client).release(binding).catch(() => undefined)
      }
      await client?.close().catch(() => undefined)
      await recorder.stop().catch(() => undefined)
      await docker.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
