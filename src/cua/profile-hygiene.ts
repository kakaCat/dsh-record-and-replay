import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cua's driver-owned browser profile root for the current platform. */
export function cuaProfileRoot(): string | undefined {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'CuaDriver', 'BrowserProfiles')
  }
  if (process.platform === 'win32') {
    const base = process.env['LOCALAPPDATA']
    return base === undefined ? undefined : join(base, 'CuaDriver', 'BrowserProfiles')
  }
  const data = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(data, 'CuaDriver', 'BrowserProfiles')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Cua ends an isolated session by terminating the browser, so Chrome records
 * an unclean exit and offers "restore pages?" on the next named-profile launch.
 * Marking the previous exit as clean suppresses that prompt; enabling
 * restore-on-startup also makes Chrome persist session cookies (login state).
 */
export async function suppressSessionRestore(
  profileName: string,
  root: string | undefined = cuaProfileRoot(),
): Promise<void> {
  if (root === undefined) return
  const preferencesPath = join(root, profileName, 'Default', 'Preferences')
  let raw: string
  try {
    raw = await readFile(preferencesPath, 'utf8')
  } catch {
    // The profile has not been created yet (first launch): nothing to patch.
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (!isRecord(parsed)) return

  const profile = isRecord(parsed['profile']) ? parsed['profile'] : {}
  parsed['profile'] = { ...profile, exit_type: 'Normal', exited_cleanly: true }

  // Session cookies (login state) are only written to disk when Chrome is
  // configured to continue where it left off; Cua terminates the browser, so
  // without this a named profile would lose its login on every relaunch.
  const session = isRecord(parsed['session']) ? parsed['session'] : {}
  parsed['session'] = { ...session, restore_on_startup: 1 }
  try {
    await writeFile(preferencesPath, JSON.stringify(parsed))
  } catch {
    // Best-effort: an unwritable profile must not fail the bind.
  }
}
