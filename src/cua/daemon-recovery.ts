import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Candidate CLI locations, most specific first. */
export function cuaDriverCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const explicit = env['CUA_DRIVER_BIN']
  const executable = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  return [
    ...(explicit === undefined || explicit.length === 0 ? [] : [explicit]),
    join(homedir(), '.local', 'bin', executable),
    ...(platform === 'darwin' ? ['/Applications/CuaDriver.app/Contents/MacOS/cua-driver'] : []),
    // Let the child-process launcher search PATH (including PATHEXT on Windows).
    'cua-driver',
  ]
}

/**
 * The daemon can keep a pending browser setup that survives DSH restarts;
 * `browser_prepare` then fails with `tool_invocation_failed` until the daemon
 * is restarted. Run `cua-driver stop`; the next MCP call starts a fresh one.
 */
export async function stopCuaDaemon(options: {
  readonly candidates?: readonly string[]
  readonly timeoutMs?: number
} = {}): Promise<boolean> {
  const timeout = options.timeoutMs ?? 10_000
  for (const candidate of options.candidates ?? cuaDriverCandidates()) {
    if (candidate !== 'cua-driver' && !existsSync(candidate)) continue
    try {
      await execFileAsync(candidate, ['stop'], { timeout })
      return true
    } catch {
      // Try the next location; the CLI may not be on PATH for GUI apps.
    }
  }
  return false
}
