/**
 * Slash commands for the record/replay plugin.
 *
 * The command registry only passes the receiving agent and the raw input; the
 * plugin supplies the ports, so this module stays free of DSH imports and can
 * be unit-tested with fakes.
 */
import { isProfileName } from '../core/contracts.js'

export interface CommandInvocationLike {
  readonly agent: unknown
  readonly rawInput: string
  readonly signal: AbortSignal
}

export type CommandResultLike =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

export interface CommandDefinitionLike {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: CommandInvocationLike) => Promise<CommandResultLike>
}

export interface RecordCommandPorts {
  readonly status: (invocation: CommandInvocationLike) => Promise<string>
  readonly start: (title: string, invocation: CommandInvocationLike) => Promise<string>
  readonly stop: (invocation: CommandInvocationLike) => Promise<string>
  readonly discard: (invocation: CommandInvocationLike) => Promise<string>
  readonly bind: (pid: number, windowId: number, invocation: CommandInvocationLike) => Promise<string>
  readonly launch: (profileName: string | undefined, invocation: CommandInvocationLike) => Promise<string>
}

function messageOf(error: unknown): { code?: string; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return { ...(typeof code === 'string' ? { code } : {}), message }
}

async function run(work: () => Promise<string>): Promise<CommandResultLike> {
  try {
    return { kind: 'success', text: await work() }
  } catch (error) {
    const { code, message } = messageOf(error)
    return { kind: 'error', text: code === undefined ? message : `${code}: ${message}` }
  }
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function createRecordCommands(ports: RecordCommandPorts): CommandDefinitionLike[] {
  return [
    {
      name: 'record-status',
      description: 'Show the record/replay workspace, feature switches, transport and active recording.',
      handler: async invocation => await run(() => ports.status(invocation)),
    },
    {
      name: 'record-start',
      description: 'Start a browser recording in this workspace. Usage: /record-start <title>',
      input: { hint: '<title>' },
      handler: async invocation => {
        const title = invocation.rawInput.trim()
        if (title.length === 0) {
          return { kind: 'error', text: 'usage: /record-start <title>' }
        }
        return await run(() => ports.start(title, invocation))
      },
    },
    {
      name: 'record-stop',
      description: 'Stop the active recording owned by this session.',
      handler: async invocation => await run(() => ports.stop(invocation)),
    },
    {
      name: 'record-discard',
      description: 'Discard the active recording owned by this session; it is kept for audit but marked cancelled.',
      handler: async invocation => await run(() => ports.discard(invocation)),
    },
    {
      name: 'record-launch',
      description: 'Launch a driver-owned browser and bind it. Usage: /record-launch [profileName]',
      input: { hint: '[profileName]' },
      handler: async invocation => {
        const profileName = invocation.rawInput.trim()
        if (profileName.length > 0 && !isProfileName(profileName)) {
          return { kind: 'error', text: 'profileName must be 1-64 characters of [A-Za-z0-9._-]' }
        }
        return await run(() => ports.launch(profileName.length === 0 ? undefined : profileName, invocation))
      },
    },
    {
      name: 'record-bind',
      description: 'Bind this session to a browser window. Usage: /record-bind <pid> <windowId>',
      input: { hint: '<pid> <windowId>' },
      handler: async invocation => {
        const [pidRaw, windowRaw, extra] = invocation.rawInput.trim().split(/\s+/u)
        const pid = pidRaw === undefined ? undefined : positiveInteger(pidRaw)
        const windowId = windowRaw === undefined ? undefined : positiveInteger(windowRaw)
        if (pid === undefined || windowId === undefined || extra !== undefined) {
          return { kind: 'error', text: 'usage: /record-bind <pid> <windowId>' }
        }
        return await run(() => ports.bind(pid, windowId, invocation))
      },
    },
  ]
}
