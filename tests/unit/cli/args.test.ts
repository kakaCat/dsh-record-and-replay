import { describe, expect, it } from 'vitest'
import { CliUsageError, parseCliArgs } from '../../../src/cli.js'

describe('cli arguments', () => {
  it('parses a suite path, isolated target and repeatable values', () => {
    const options = parseCliArgs([
      'test',
      'tests/suites/web-login.json',
      '--launch=isolated',
      '--junit',
      'out/report.xml',
      '--base-url=https://example.test',
      '--values',
      'step_user=standard_user',
      '--values',
      'step_pass=secret_sauce',
    ])
    expect(options.suitePath).toBe('tests/suites/web-login.json')
    expect(options.target).toEqual({ launch: 'isolated' })
    expect(options.junitPath).toBe('out/report.xml')
    expect(options.baseUrl).toBe('https://example.test')
    expect(options.values).toEqual({ step_user: 'standard_user', step_pass: 'secret_sauce' })
  })

  it('parses a per-case timeout and rejects zero or negative budgets', () => {
    expect(parseCliArgs(['test', 'suite.json', '--timeout', '2500']).timeoutMs).toBe(2500)
    expect(parseCliArgs(['test', 'suite.json', '--timeout=1']).timeoutMs).toBe(1)
    expect(() => parseCliArgs(['test', 'suite.json', '--timeout', '0'])).toThrowError(/positive integer/)
    expect(() => parseCliArgs(['test', 'suite.json', '--timeout', '-5'])).toThrowError(/positive integer/)
    expect(() => parseCliArgs(['test', 'suite.json', '--timeout', '1.5'])).toThrowError(/positive integer/)
    expect(() => parseCliArgs(['test', 'suite.json', '--timeout'])).toThrowError(/requires a value/)
  })

  it('defaults a bare pid/window pair to the existing launch mode', () => {
    const options = parseCliArgs(['test', 'suite.json', '--pid', '42', '--window-id', '7'])
    // parseSuiteTarget omits the default launch mode; the replay port treats
    // a missing launch as "existing".
    expect(options.target).toEqual({ pid: 42, windowId: 7 })
  })

  it('rejects incomplete targets and malformed values', () => {
    expect(() => parseCliArgs(['test', 'suite.json', '--launch', 'desktop', '--pid', '42']))
      .toThrowError(/windowId/)
    expect(() => parseCliArgs(['test', 'suite.json', '--pid', '0']))
      .toThrowError(/positive integer/)
    expect(() => parseCliArgs(['test', 'suite.json', '--values', 'novalue']))
      .toThrowError(CliUsageError)
    expect(() => parseCliArgs(['test', 'suite.json', '--values', 'step=']))
      .toThrowError(/must not be empty/)
  })

  it('rejects unknown commands, options and extra positionals', () => {
    expect(() => parseCliArgs([])).toThrowError(/missing command/)
    expect(() => parseCliArgs(['run', 'suite.json'])).toThrowError(/unknown command/)
    expect(() => parseCliArgs(['test', 'suite.json', '--nope'])).toThrowError(/unknown option/)
    expect(() => parseCliArgs(['test', 'a.json', 'b.json'])).toThrowError(/unexpected argument/)
    expect(() => parseCliArgs(['test'])).toThrowError(/missing <suite.json>/)
  })
})
