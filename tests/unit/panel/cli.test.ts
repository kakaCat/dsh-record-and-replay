import { describe, expect, it } from 'vitest'

import { CliUsageError, parsePanelArgs } from '../../../src/cli.js'

describe('panel CLI arguments', () => {
  it('defaults to loopback port 4174', () => {
    expect(parsePanelArgs([])).toEqual({
      roots: [],
      port: 4174,
      host: '127.0.0.1',
      cors: false,
    })
  })

  it('parses repeatable roots and server flags', () => {
    expect(parsePanelArgs([
      '--root',
      '/tmp/a',
      '--root=/tmp/b',
      '--port=5005',
      '--host',
      '0.0.0.0',
      '--public-dir',
      'dist/panel',
      '--cors',
    ])).toEqual({
      roots: ['/tmp/a', '/tmp/b'],
      port: 5005,
      host: '0.0.0.0',
      publicDir: 'dist/panel',
      cors: true,
    })
  })

  it('rejects malformed ports, empty values and unknown options', () => {
    expect(() => parsePanelArgs(['--port', '0'])).toThrowError(/between 1 and 65535/)
    expect(() => parsePanelArgs(['--port', '65536'])).toThrowError(/between 1 and 65535/)
    expect(() => parsePanelArgs(['--port', 'abc'])).toThrowError(/between 1 and 65535/)
    expect(() => parsePanelArgs(['--root'])).toThrowError(CliUsageError)
    expect(() => parsePanelArgs(['--root='])).toThrowError(/must not be empty/)
    expect(() => parsePanelArgs(['--cors=1'])).toThrowError(/does not take a value/)
    expect(() => parsePanelArgs(['--nope'])).toThrowError(/unknown panel option/)
  })
})
