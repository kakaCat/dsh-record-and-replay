import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OperationContext } from '../../../src/core/api.js'
import { apply, name } from '../../../src/plugin/docker.js'
import { disposeAllRuntimes, runtimeForWorkspace } from '../../../src/plugin/shared.js'

let unregister: (() => void) | undefined

afterEach(async () => {
  unregister?.()
  unregister = undefined
  await disposeAllRuntimes()
})

function context(): OperationContext {
  return {
    principal: { sessionId: 'docker-test', agentId: 'docker-test' },
    callId: 'docker-test',
    origin: 'internal',
    signal: new AbortController().signal,
  }
}

describe('plugin/docker entry (record-replay-docker line)', () => {
  it('switches shared workspaces to Docker only while the independent row is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-docker-entry-'))
    let disposer: (() => void) | undefined
    const ctx = {
      logger: () => ({ info: () => undefined, warn: () => undefined }),
      effect: (run: () => () => void) => {
        disposer = run()
      },
    }
    try {
      expect(name).toBe('dsh-record-and-replay/docker')
      apply(ctx, { image: 'example.test/dsh-record-replay:entry-test' })
      unregister = disposer

      const docker = await runtimeForWorkspace(root)
      expect(docker.transportState()).toMatchObject({ requested: 'docker', active: null })
      await expect(docker.driver.bind({ launch: 'existing', pid: 1, windowId: 2 }, context()))
        .rejects.toMatchObject({ code: 'ACTION_UNSUPPORTED' })
      await expect(docker.driver.callTool('list_windows', {}, context()))
        .rejects.toMatchObject({ code: 'ACTION_UNSUPPORTED' })

      disposer?.()
      unregister = undefined
      const local = await runtimeForWorkspace(root)
      expect(local.transportState()).toMatchObject({ requested: 'mcp', active: null })
      expect(local.driver.transport).toBe('mcp')
    } finally {
      await disposeAllRuntimes()
      await rm(root, { recursive: true, force: true })
    }
  })
})
