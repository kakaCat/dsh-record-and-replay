import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * Loader row names are package specifiers, and the Host resolves each row back
 * to the package manifest by requiring `package.json`'s name to equal the row
 * name verbatim. When they disagree, the host half may still load through a
 * dependency alias while the `dsh.client` half is silently dropped — no
 * sidebar entry and no right-column panel. Keep the three identities aligned:
 * package.json name, cordis.patch.yml row names, and the registered client
 * module id.
 */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const pkg = JSON.parse(read('../../../package.json')) as { name: string }
const patch = read('../../../cordis.patch.yml')

describe('bundle identity', () => {
  it('addresses every loader row by the real package name', () => {
    const rowNames = [...patch.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)]
      .map(match => match[1])
      .filter((name): name is string => name !== undefined)

    expect(rowNames.length).toBeGreaterThan(0)
    for (const rowName of rowNames) {
      expect(
        rowName === pkg.name || rowName.startsWith(`${pkg.name}/`),
        `row name ${rowName} must be ${pkg.name} or a subpath of it`,
      ).toBe(true)
    }
    expect(rowNames).toContain(pkg.name)
    expect(rowNames).toContain(`${pkg.name}/desktop`)
  })

  it('registers the built client half under the package name', () => {
    const bundlePath = new URL('../../../dist/client/client.js', import.meta.url)
    if (!existsSync(bundlePath)) return

    const bundle = readFileSync(bundlePath, 'utf8')
    expect(bundle).toContain(`id: ${JSON.stringify(pkg.name)}`)
  })
})
