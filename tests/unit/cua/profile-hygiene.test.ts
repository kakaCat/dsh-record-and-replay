import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { suppressSessionRestore } from '../../../src/cua/profile-hygiene.js'

async function profileWith(root: string, name: string, preferences: unknown): Promise<string> {
  const dir = join(root, name, 'Default')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'Preferences')
  await writeFile(path, JSON.stringify(preferences))
  return path
}

describe('cua/profile-hygiene', () => {
  it('marks the previous exit as clean so Chrome stops offering session restore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cua-prefs-'))
    try {
      const path = await profileWith(root, 'dsh-demo', {
        profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'Person 1' },
        session: { restore_on_startup: 5, keep: 'yes' },
        other: { keep: true },
      })

      await suppressSessionRestore('dsh-demo', root)

      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        profile: Record<string, unknown>
        session: Record<string, unknown>
        other: Record<string, unknown>
      }
      expect(parsed.profile['exit_type']).toBe('Normal')
      expect(parsed.profile['exited_cleanly']).toBe(true)
      expect(parsed.profile['name']).toBe('Person 1')
      expect(parsed.session['restore_on_startup']).toBe(1)
      expect(parsed.session['keep']).toBe('yes')
      expect(parsed.other).toEqual({ keep: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is a no-op for a profile that does not exist yet or is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cua-prefs-'))
    try {
      await expect(suppressSessionRestore('missing', root)).resolves.toBeUndefined()

      const dir = join(root, 'broken', 'Default')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'Preferences'), 'not json')
      await expect(suppressSessionRestore('broken', root)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
