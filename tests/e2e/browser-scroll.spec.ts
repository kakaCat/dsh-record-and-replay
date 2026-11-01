import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const enabled = process.env.CUA_E2E === '1'

describe.skipIf(!enabled)('Cua browser scroll E2E', () => {
  it('scrolls a local long page to the bottom and keeps browser key unsupported', async () => {
    const result = await execFileAsync('pnpm', ['tsx', 'tests/spikes/cua-browser-scroll.test.ts'], {
      cwd: process.cwd(),
      env: { ...process.env },
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    const output = `${result.stdout}\n${result.stderr}`
    expect(output).toContain('"status": "pass"')
    expect(output).toContain('"reachedBottom": true')
    expect(output).toContain('"driverErrorCode": "ACTION_UNSUPPORTED"')
    expect(output).not.toContain('browser_key')
  }, 200_000)
})
