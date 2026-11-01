import { describe, expect, it } from 'vitest'
import { parseTestSuite } from '../../../src/plugin/suite.js'

const suite = {
  name: 'smoke',
  target: { launch: 'desktop', pid: 42, windowId: 7 },
  baseUrl: 'http://127.0.0.1:5000',
  cases: [
    { name: 'open', recordingId: 'rec_aaa', values: { p: 'x' } },
    { name: 'search', recordingId: 'rec_bbb', target: { launch: 'isolated' } },
  ],
}

describe('plugin/suite', () => {
  it('parses a target, baseUrl and per-case overrides', () => {
    const parsed = parseTestSuite(suite)
    expect(parsed.name).toBe('smoke')
    expect(parsed.target).toEqual({ launch: 'desktop', pid: 42, windowId: 7 })
    expect(parsed.baseUrl).toBe('http://127.0.0.1:5000')
    expect(parsed.cases).toHaveLength(2)
    expect(parsed.cases[1]?.target).toEqual({ launch: 'isolated' })
  })

  it('parses suite/case timeoutMs and rejects non-positive budgets', () => {
    const parsed = parseTestSuite({
      timeoutMs: 30000,
      cases: [
        { name: 'slow', recordingId: 'rec_aaa', timeoutMs: 5000 },
        { name: 'default', recordingId: 'rec_bbb' },
      ],
    })
    expect(parsed.timeoutMs).toBe(30000)
    expect(parsed.cases[0]?.timeoutMs).toBe(5000)
    expect(parsed.cases[1]?.timeoutMs).toBeUndefined()

    expect(() => parseTestSuite({ timeoutMs: 0, cases: [{ name: 'a', recordingId: 'rec_1' }] }))
      .toThrowError(/suite\.timeoutMs must be a positive integer/)
    expect(() => parseTestSuite({ cases: [{ name: 'a', recordingId: 'rec_1', timeoutMs: -1 }] }))
      .toThrowError(/timeoutMs must be a positive integer/)
  })

  it('rejects duplicate names, missing window ids and bad values', () => {
    expect(() => parseTestSuite({
      cases: [{ name: 'a', recordingId: 'rec_1' }, { name: 'a', recordingId: 'rec_2' }],
    })).toThrowError(/duplicate case name/)

    expect(() => parseTestSuite({
      cases: [{ name: 'a', recordingId: 'rec_1', target: { launch: 'desktop', pid: 1 } }],
    })).toThrowError(/windowId/)

    expect(() => parseTestSuite({
      cases: [{ name: 'a', recordingId: 'rec_1', values: { p: 1 } }],
    })).toThrowError(/values\.p/)

    expect(() => parseTestSuite({ cases: [] })).toThrowError(/non-empty/)

    const resolved = parseTestSuite({
      cases: [{ name: 'env', recordingId: 'rec_1', values: { p: '${SAUCE_PWD}' } }],
    }, { SAUCE_PWD: 's3cret' })
    expect(resolved.cases[0]?.values).toEqual({ p: 's3cret' })

    expect(() => parseTestSuite({
      cases: [{ name: 'missing', recordingId: 'rec_1', values: { p: '${NOPE}' } }],
    }, {})).toThrowError(/missing environment variable NOPE/)
  })
})
