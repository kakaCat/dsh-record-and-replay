/**
 * Crash-isolation check for the native worker transport.
 *
 * Requires `pnpm build` (it uses dist/native-host.mjs). It proves that killing
 * the native child process does not kill the parent and surfaces as a
 * transport error instead.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { WorkerTransport } from '../../src/cua/index.js'
import type { OperationContext } from '../../src/core/api.js'

const hostPath = resolve('dist/native-host.mjs')
if (!existsSync(hostPath)) {
  console.error(`missing ${hostPath}; run "pnpm build" first`)
  process.exit(2)
}

function context(): OperationContext {
  return {
    principal: { sessionId: 'worker-spike', agentId: 'worker-spike' },
    callId: 'worker-spike',
    origin: 'internal',
    signal: new AbortController().signal,
  }
}

const transport = await WorkerTransport.create({ hostPath })
try {
  const catalog = await transport.listTools(new AbortController().signal)
  assert.ok(catalog.tools.length >= 8, `expected the Cua catalog, got ${String(catalog.tools.length)}`)
  const internal = catalog.tools.filter(tool => tool.name.startsWith('__dsh_'))
  assert.equal(internal.length, 0, 'internal grant tools must be hidden')

  const health = await transport.callTool('health_report', {}, context())
  const version = (health.structuredContent as { driver_version?: string } | undefined)?.driver_version
  console.log(JSON.stringify({ stage: 'connected', tools: catalog.tools.length, driverVersion: version }))

  const pid = transport.pid
  assert.ok(pid !== undefined, 'native host child process was not found')
  process.kill(pid, 'SIGKILL')
  await sleep(500)

  let failed = false
  try {
    await transport.callTool('health_report', {}, context())
  } catch (error) {
    failed = true
    console.log(JSON.stringify({
      stage: 'crash-isolated',
      code: (error as { code?: string }).code,
      message: error instanceof Error ? error.message : String(error),
    }))
  }
  assert.ok(failed, 'a call against the dead child must fail')
  console.log(JSON.stringify({ status: 'pass', parentAlive: true }))
} finally {
  await transport.close().catch(() => undefined)
}
