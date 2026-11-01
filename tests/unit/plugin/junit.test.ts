import { describe, expect, it } from 'vitest'
import { toJUnit } from '../../../src/plugin/junit.js'

describe('plugin/junit', () => {
  it('writes testsuite counts and failure messages with escaping', () => {
    const xml = toJUnit('smoke & <suite>', [
      { name: 'ok', status: 'completed' },
      { name: 'bad', status: 'failed', errorCode: 'ASSERTION_FAILED' },
    ])
    expect(xml).toContain('tests="2"')
    expect(xml).toContain('failures="1"')
    expect(xml).toContain('name="smoke &amp; &lt;suite&gt;"')
    expect(xml).toContain('<failure message="ASSERTION_FAILED">ASSERTION_FAILED</failure>')
  })
})
