import { describe, expect, it } from 'vitest'
import { cuaNativeIdentityIssue, cuaVersionOf } from '../../../src/plugin/index.js'

function report(structuredContent: unknown) {
  return { content: [], structuredContent }
}

describe('cua health_report parsing', () => {
  it('reads the 0.38 CLI shape from build.version', () => {
    expect(cuaVersionOf(report({ build: { version: '0.38.0' }, checks: [] }))).toBe('0.38.0')
  })

  it('reads the 0.28 native shape from driver_version', () => {
    expect(cuaVersionOf(report({ driver_version: '0.28.0', checks: [] }))).toBe('0.28.0')
  })

  it('falls back to the binary_version check message', () => {
    expect(cuaVersionOf(report({
      checks: [{ name: 'binary_version', status: 'pass', message: 'cua-driver 0.30.1' }],
    }))).toBe('0.30.1')
  })

  it('returns undefined when no version is present anywhere', () => {
    expect(cuaVersionOf(report({ checks: [] }))).toBeUndefined()
    expect(cuaVersionOf({ content: [{ type: 'text', text: 'not json' }] })).toBeUndefined()
  })

  it('only reports a native identity problem for a failing bundle_identity check', () => {
    expect(cuaNativeIdentityIssue(report({
      checks: [
        { name: 'tcc_accessibility', status: 'pass' },
        { name: 'bundle_identity', status: 'pass', message: 'ok' },
      ],
    }))).toBeUndefined()

    const issue = cuaNativeIdentityIssue(report({
      checks: [
        { name: 'bundle_identity', status: 'fail', message: 'Process has no CFBundleIdentifier.' },
      ],
    }))
    expect(issue).toContain('no app bundle identity')
    expect(issue).toContain('Process has no CFBundleIdentifier.')
  })
})
