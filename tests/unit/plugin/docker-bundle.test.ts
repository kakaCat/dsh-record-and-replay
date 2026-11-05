import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

describe('Docker bundle resources', () => {
  it('ships an independently disabled plugin row and all runtime/display resources', () => {
    const pkg = JSON.parse(read('../../../package.json')) as {
      readonly exports: Readonly<Record<string, unknown>>
      readonly files: readonly string[]
    }
    const patch = read('../../../cordis.patch.yml')
    expect(patch).toMatch(/- id: record-replay-docker\s*\n\s*name: dsh-record-and-replay\/docker\s*\n\s*disabled: true/u)
    expect(pkg.exports['./docker']).toBeDefined()
    expect(pkg.exports['./docker/locale/*.json']).toBe('./docker/locale/*.json')
    expect(pkg.exports['./docker/icon']).toBe('./docker/icon.svg')
    expect(pkg.files).toContain('docker')
    for (const file of ['Dockerfile', 'entrypoint.sh', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
      expect(existsSync(new URL(`../../../docker/${file}`, import.meta.url)), `missing docker/${file}`).toBe(true)
    }
  })

  it('pins the container to the supported Cua/Linux route and records through X11', () => {
    expect(read('../../../docker/Dockerfile')).toContain('CUA_DRIVER_RS_VERSION=0.38.0')
    expect(read('../../../docker/Dockerfile')).toContain('FROM debian:bookworm-slim')
    expect(read('../../../docker/entrypoint.sh')).toContain('Xvfb')
    expect(read('../../../docker/entrypoint.sh')).toContain('dsh-record-replay-ready')
  })
})
