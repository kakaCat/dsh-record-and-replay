import { describe, expect, it } from 'vitest'
import { CuaDriverClient, McpTransport } from '../../src/cua/index.js'
import type { OperationContext } from '../../src/core/api.js'

const enabled = process.env.CUA_INTEGRATION === '1'

describe.skipIf(!enabled)('McpTransport against the installed Cua daemon', () => {
  it('lists tools, calls health_report and closes cleanly', async () => {
    const transport = await McpTransport.create({ stderrLines: 20 })
    const client = await CuaDriverClient.connect(transport, {
      requiredTools: ['health_report'],
      driverVersion: '0.38.0',
      connectTimeoutMs: 10_000,
      callTimeoutMs: 10_000,
    })
    const context: OperationContext = {
      principal: { sessionId: 'integration-test', agentId: 'integration-test' },
      callId: 'health-check',
      origin: 'internal',
      signal: new AbortController().signal,
    }

    try {
      expect(client.hasTool('health_report')).toBe(true)
      expect(client.tools.length).toBeGreaterThan(50)
      const result = await client.callTool('health_report', {}, context)
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({ overall: 'ok' })
    } finally {
      await client.close()
    }
  })
})
