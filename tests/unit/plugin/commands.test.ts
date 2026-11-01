import { describe, expect, it, vi } from 'vitest'
import { createRecordCommands, type CommandInvocationLike, type RecordCommandPorts } from '../../../src/plugin/commands.js'

function invocation(rawInput = ''): CommandInvocationLike {
  return { agent: { id: 'agent-1' }, rawInput, signal: new AbortController().signal }
}

function ports(overrides: Partial<RecordCommandPorts> = {}): RecordCommandPorts {
  return {
    status: vi.fn(async () => '{"ok":true}'),
    start: vi.fn(async (title: string) => `started ${title}`),
    stop: vi.fn(async () => 'stopped'),
    discard: vi.fn(async () => 'discarded'),
    bind: vi.fn(async (pid: number, windowId: number) => `bound ${String(pid)} ${String(windowId)}`),
    launch: vi.fn(async (profileName: string | undefined) => `launched ${profileName ?? 'new'}`),
    ...overrides,
  }
}

function command(name: string, p: RecordCommandPorts) {
  const found = createRecordCommands(p).find(definition => definition.name === name)
  if (found === undefined) throw new Error(`missing command ${name}`)
  return found
}

describe('plugin/record commands', () => {
  it('exposes stable slash command names', () => {
    expect(createRecordCommands(ports()).map(definition => definition.name))
      .toEqual(['record-status', 'record-start', 'record-stop', 'record-discard', 'record-launch', 'record-bind'])
  })

  it('starts a recording with the trimmed title', async () => {
    const p = ports()
    const result = await command('record-start', p).handler(invocation('  login flow  '))
    expect(result).toEqual({ kind: 'success', text: 'started login flow' })
    expect(p.start).toHaveBeenCalledWith('login flow', expect.anything())
  })

  it('rejects an empty start title with usage text', async () => {
    const p = ports()
    const result = await command('record-start', p).handler(invocation('   '))
    expect(result).toEqual({ kind: 'error', text: 'usage: /record-start <title>' })
    expect(p.start).not.toHaveBeenCalled()
  })

  it('parses bind arguments and rejects malformed ones', async () => {
    const p = ports()
    expect(await command('record-bind', p).handler(invocation('123 456')))
      .toEqual({ kind: 'success', text: 'bound 123 456' })

    expect(await command('record-bind', p).handler(invocation('123')))
      .toEqual({ kind: 'error', text: 'usage: /record-bind <pid> <windowId>' })
    expect(await command('record-bind', p).handler(invocation('0 456')))
      .toEqual({ kind: 'error', text: 'usage: /record-bind <pid> <windowId>' })
    expect(await command('record-bind', p).handler(invocation('1 2 3')))
      .toEqual({ kind: 'error', text: 'usage: /record-bind <pid> <windowId>' })
  })

  it('launches an isolated browser with or without a profile name', async () => {
    const p = ports()
    expect(await command('record-launch', p).handler(invocation('')))
      .toEqual({ kind: 'success', text: 'launched new' })
    expect(await command('record-launch', p).handler(invocation('dsh-main')))
      .toEqual({ kind: 'success', text: 'launched dsh-main' })
    expect(await command('record-launch', p).handler(invocation('bad name!')))
      .toEqual({ kind: 'error', text: 'profileName must be 1-64 characters of [A-Za-z0-9._-]' })
  })

  it('turns a port failure into an error result with its stable code', async () => {
    const p = ports({
      start: async () => { throw Object.assign(new Error('recording is off'), { code: 'FEATURE_DISABLED' }) },
    })
    const result = await command('record-start', p).handler(invocation('x'))
    expect(result).toEqual({ kind: 'error', text: 'FEATURE_DISABLED: recording is off' })
  })

  it('reports status and stop through the ports', async () => {
    const p = ports()
    expect(await command('record-status', p).handler(invocation()))
      .toEqual({ kind: 'success', text: '{"ok":true}' })
    expect(await command('record-stop', p).handler(invocation()))
      .toEqual({ kind: 'success', text: 'stopped' })
    expect(await command('record-discard', p).handler(invocation()))
      .toEqual({ kind: 'success', text: 'discarded' })
  })
})
