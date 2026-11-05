import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CuaTransportError } from '../cua/transport.js'

/** Locate the Docker build context in both src/ tests and the bundled dist/ output. */
export function bundledDockerContext(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(moduleDir, '../../docker'),
    path.resolve(moduleDir, '../docker'),
  ]
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'Dockerfile')) && existsSync(path.join(candidate, 'entrypoint.sh'))) {
      return candidate
    }
  }
  throw new CuaTransportError(
    'CUA_TRANSPORT_UNAVAILABLE',
    'The bundled Docker assets are missing; reinstall dsh-record-and-replay with its docker/ directory',
  )
}

/**
 * The default image tag changes with the packaged runtime assets. Upgrading the
 * plugin therefore cannot silently reuse an image built from an older entrypoint.
 */
export async function bundledDockerImageTag(context: string, platform: 'linux/amd64' | 'linux/arm64'): Promise<string> {
  const hash = createHash('sha256')
  for (const name of ['Dockerfile', 'entrypoint.sh']) {
    hash.update(name)
    hash.update('\0')
    hash.update(await readFile(path.join(context, name)))
    hash.update('\0')
  }
  return `dsh-record-and-replay-cua:${platform.slice('linux/'.length)}-${hash.digest('hex').slice(0, 16)}`
}
