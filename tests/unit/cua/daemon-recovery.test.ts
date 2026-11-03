import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stopCuaDaemon, cuaDriverCandidates } from '../../../src/cua/daemon-recovery.js'

async function script(root: string, name: string, exitCode: number): Promise<string> {
  const path = join(root, name)
  await writeFile(path, `#!/bin/sh\nexit ${String(exitCode)}\n`)
  await chmod(path, 0o755)
  return path
}

describe('cua/daemon-recovery', () => {
  it('prefers the explicit CLI path, then looks up the platform executable', () => {
    const win32 = cuaDriverCandidates({ CUA_DRIVER_BIN: 'custom-cua' }, 'win32')
    expect(win32[0]).toBe('custom-cua')
    expect(win32.some(candidate => candidate.endsWith('cua-driver.exe'))).toBe(true)
    expect(win32).toContain('cua-driver')
    expect(win32.some(candidate => candidate.includes('CuaDriver.app'))).toBe(false)

    const darwin = cuaDriverCandidates({}, 'darwin')
    expect(darwin).toContain('/Applications/CuaDriver.app/Contents/MacOS/cua-driver')
    expect(darwin.some(candidate => candidate.endsWith('.exe'))).toBe(false)
  })

  it('stops the daemon through the first working CLI candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cua-daemon-'))
    try {
      const path = await script(root, 'cua-driver', 0)
      await expect(stopCuaDaemon({ candidates: [path] })).resolves.toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports failure when the CLI exits non-zero or is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cua-daemon-'))
    try {
      const failing = await script(root, 'failing', 1)
      await expect(stopCuaDaemon({ candidates: [failing] })).resolves.toBe(false)
      await expect(stopCuaDaemon({ candidates: [join(root, 'missing'), failing] })).resolves.toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
