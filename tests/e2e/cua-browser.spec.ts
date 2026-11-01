import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const enabled = process.env.CUA_E2E === '1'

describe.skipIf(!enabled)('Cua browser E2E', () => {
  it('runs the verified M0 browser action chain without dsh_browser', async () => {
    const result = await execFileAsync('pnpm', ['tsx', 'tests/spikes/cua-binding.test.ts'], {
      cwd: process.cwd(),
      env: { ...process.env },
      timeout: 180_000,
    })
    const output = `${result.stdout}\n${result.stderr}`
    expect(output).toContain('"status": "pass"')
    expect(output).toContain('"bindingQuality": "exact"')
    expect(output).toContain('"tabRebindVerified": true')
    expect(output).toContain('"dshBrowserCalls": 0')
    expect(output).not.toContain('dsh_browser_open')
    expect(output).not.toContain('dsh_browser_click')
  }, 200_000)
})
