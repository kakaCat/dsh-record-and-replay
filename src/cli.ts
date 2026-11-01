#!/usr/bin/env node
/**
 * Standalone `dsh-record-replay test` CLI.
 *
 * It replays a JSON suite without starting DSH: the same store, recording
 * service, run store and replay port as the plugin, driven by the MCP Cua
 * daemon. See README's "CLI" section and `docs/guides/launchd.md`.
 */
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectCuaBrowserDriver } from './bootstrap/cua-driver.js'
import { createWorkspaceRuntime } from './bootstrap/runtime.js'
import { DEFAULT_HOST_CONFIG } from './host/index.js'
import {
  executeSuite,
  junitPathFor,
  writeSuiteJUnit,
  type SuiteCaseReport,
} from './plugin/suite-runner.js'
import {
  parseSuiteTarget,
  parseTestSuite,
  type SuiteTarget,
  type TestSuite,
} from './plugin/suite.js'
import { startPanelServer } from './panel/server.js'

export {
  DEFAULT_CASE_TIMEOUT_MS,
  executeSuite,
  junitPathFor,
  writeSuiteJUnit,
  type ExecuteSuiteOptions,
  type SuiteCaseReport,
  type SuiteRunReport,
} from './plugin/suite-runner.js'

const USAGE = `Usage:
  dsh-record-replay test <suite.json> [options]
  dsh-record-replay panel [options]

Panel options (read-only record/replay browser):
  --root <dir>          Extra allowed project root (repeatable)
  --port <n>            HTTP port (default 4174)
  --host <addr>         Bind address (default 127.0.0.1)
  --public-dir <dir>    Built panel assets (default <package>/dist/panel)
  --cors                Allow cross-origin reads (loopback DSH UI)
  -h, --help            Show this help

Test options:

Options:
  --junit <path>       Write JUnit XML (default: <suite>.junit.xml)
  --base-url <url>     Override the suite baseUrl (http/https)
  --launch <mode>      Target launch mode: isolated | existing | desktop
  --pid <n>            Browser pid for existing/desktop targets
  --window-id <n>      Browser window id for existing/desktop targets
  --values <id=value>  Replay input value keyed by stepId or secretRef (repeatable)
  --retries <n>        Extra attempts for a failed case (default 0)
  --timeout <ms>       Per-case timeout budget (default 120000; 0/negative rejected)
  -h, --help           Show this help

Exit codes:
  0  every case completed
  1  at least one case failed
  2  usage, suite, Cua or assembly error
`

export interface PanelCliOptions {
  readonly roots: readonly string[]
  readonly port: number
  readonly host: string
  readonly publicDir?: string
  readonly cors: boolean
}

/** Parse `panel [flags]` (the `panel` command token is already removed). */
export function parsePanelArgs(argv: readonly string[]): PanelCliOptions {
  const roots: string[] = []
  let port = 4174
  let host = '127.0.0.1'
  let publicDir: string | undefined
  let cors = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    const equals = argument.indexOf('=')
    const name = argument.startsWith('--') && equals > 0 ? argument.slice(0, equals) : argument
    const inline = argument.startsWith('--') && equals > 0 ? argument.slice(equals + 1) : undefined
    const readValue = (): string => {
      if (inline !== undefined) return inline
      const next = argv[index + 1]
      if (next === undefined) throw new CliUsageError(`${name} requires a value`)
      index += 1
      return next
    }
    switch (name) {
      case '--root': {
        const root = readValue()
        if (root.length === 0) throw new CliUsageError('--root must not be empty')
        roots.push(root)
        break
      }
      case '--port': {
        const value = readValue()
        if (!/^\d+$/u.test(value)) throw new CliUsageError('--port must be an integer between 1 and 65535')
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
          throw new CliUsageError('--port must be an integer between 1 and 65535')
        }
        port = parsed
        break
      }
      case '--host': {
        const value = readValue()
        if (value.length === 0) throw new CliUsageError('--host must not be empty')
        host = value
        break
      }
      case '--public-dir': {
        const value = readValue()
        if (value.length === 0) throw new CliUsageError('--public-dir must not be empty')
        publicDir = value
        break
      }
      case '--cors':
        if (inline !== undefined) throw new CliUsageError('--cors does not take a value')
        cors = true
        break
      case '-h':
      case '--help':
        throw new CliUsageError('help requested')
      default:
        throw new CliUsageError(`unknown panel option ${name}`)
    }
  }

  return {
    roots,
    port,
    host,
    ...(publicDir === undefined ? {} : { publicDir }),
    cors,
  }
}

export interface CliOptions {
  readonly suitePath: string
  readonly junitPath?: string
  readonly baseUrl?: string
  readonly target?: SuiteTarget
  readonly values: Readonly<Record<string, string>>
  readonly retries?: number
  readonly timeoutMs?: number
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

interface ParsedTargetFlags {
  launch?: string
  pid?: number
  windowId?: number
}

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new CliUsageError(`${flag} must be a positive integer`)
  }
  return Number(value)
}

function httpUrl(value: string, flag: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new CliUsageError(`${flag} must be an absolute URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliUsageError(`${flag} must use http or https`)
  }
  return value
}

function parseTargetFlags(flags: ParsedTargetFlags): SuiteTarget | undefined {
  if (flags.launch === undefined && flags.pid === undefined && flags.windowId === undefined) {
    return undefined
  }
  const target: Record<string, unknown> = {}
  if (flags.launch !== undefined) target['launch'] = flags.launch
  if (flags.pid !== undefined) target['pid'] = flags.pid
  if (flags.windowId !== undefined) target['windowId'] = flags.windowId
  // parseSuiteTarget owns launch-value and pid/window completeness checks, so
  // the CLI and the plugin reject the same shapes with the same messages.
  return parseSuiteTarget(target, 'target')
}

/** Parse `test <suite.json> [flags]`; flags may use `--flag value` or `--flag=value`. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  if (argv.length === 0) {
    throw new CliUsageError('missing command; expected "test <suite.json>"')
  }
  const [command, ...rest] = argv
  if (command !== 'test') {
    throw new CliUsageError(`unknown command ${JSON.stringify(command)}; expected "test"`)
  }

  let suitePath: string | undefined
  let junitPath: string | undefined
  let baseUrl: string | undefined
  const targetFlags: ParsedTargetFlags = {}
  const values: Record<string, string> = {}
  let retries: number | undefined
  let timeoutMs: number | undefined

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === undefined) continue
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=')
      const name = equals === -1 ? argument : argument.slice(0, equals)
      const inline = equals === -1 ? undefined : argument.slice(equals + 1)
      const readValue = (): string => {
        if (inline !== undefined) return inline
        const next = rest[index + 1]
        if (next === undefined) throw new CliUsageError(`${name} requires a value`)
        index += 1
        return next
      }
      switch (name) {
        case '--junit': {
          const junit = readValue()
          if (junit.length === 0) throw new CliUsageError('--junit must not be empty')
          junitPath = junit
          break
        }
        case '--base-url':
          baseUrl = httpUrl(readValue(), '--base-url')
          break
        case '--launch':
          targetFlags.launch = readValue()
          break
        case '--pid':
          targetFlags.pid = positiveInteger(readValue(), '--pid')
          break
        case '--window-id':
          targetFlags.windowId = positiveInteger(readValue(), '--window-id')
          break
        case '--retries': {
          const parsed = Number(readValue())
          if (!Number.isInteger(parsed) || parsed < 0) throw new CliUsageError('--retries must be a non-negative integer')
          retries = parsed
          break
        }
        case '--timeout':
          timeoutMs = positiveInteger(readValue(), '--timeout')
          break
        case '--values': {
          const entry = readValue()
          const separator = entry.indexOf('=')
          if (separator <= 0) {
            throw new CliUsageError('--values must be <stepId>=<value> with a non-empty stepId')
          }
          const key = entry.slice(0, separator)
          const value = entry.slice(separator + 1)
          if (value.length === 0) {
            throw new CliUsageError(`--values ${key}= must not be empty`)
          }
          values[key] = value
          break
        }
        default:
          throw new CliUsageError(`unknown option ${name}`)
      }
      continue
    }
    if (argument.startsWith('-') && argument !== '-') {
      throw new CliUsageError(`unknown option ${argument}`)
    }
    if (suitePath !== undefined) {
      throw new CliUsageError(`unexpected argument ${JSON.stringify(argument)}`)
    }
    suitePath = argument
  }

  if (suitePath === undefined || suitePath.length === 0) {
    throw new CliUsageError('missing <suite.json>')
  }

  const target = parseTargetFlags(targetFlags)
  return {
    suitePath,
    ...(junitPath === undefined ? {} : { junitPath }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(target === undefined ? {} : { target }),
    values,
    ...(retries === undefined ? {} : { retries }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface CliIo {
  readonly stdout: { write(text: string): unknown }
  readonly stderr: { write(text: string): unknown }
}

function describeCase(report: SuiteCaseReport, index: number, total: number): string {
  const label = report.timedOut === true ? 'TIMEOUT' : report.status === 'completed' ? 'PASS' : 'FAIL'
  const run = report.runId === undefined ? 'no run' : report.runId
  const code = report.errorCode === undefined ? '' : ` ${report.errorCode}`
  const detail = report.errorMessage === undefined ? '' : ` — ${report.errorMessage}`
  return `${String(index + 1)}/${String(total)} ${label} ${report.name} (${run}, ${String(report.durationMs)}ms${code})${detail}`
}

async function runTestCommand(options: CliOptions, io: CliIo): Promise<number> {
  const workspaceRoot = process.cwd()
  const suitePath = path.resolve(workspaceRoot, options.suitePath)

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(suitePath, 'utf8'))
  } catch (error) {
    io.stderr.write(`error: cannot read suite ${suitePath}: ${messageOf(error)}\n`)
    return 2
  }

  let suite: TestSuite
  try {
    suite = parseTestSuite(raw)
  } catch (error) {
    io.stderr.write(`error: invalid suite ${suitePath}: ${messageOf(error)}\n`)
    return 2
  }

  const suiteName = suite.name ?? path.basename(suitePath)
  const junitPath = options.junitPath === undefined
    ? junitPathFor(suitePath)
    : path.resolve(workspaceRoot, options.junitPath)

  io.stdout.write(`suite: ${suiteName} (${String(suite.cases.length)} case${suite.cases.length === 1 ? '' : 's'})\n`)
  io.stdout.write(`workspace: ${workspaceRoot}\n`)
  if (options.target !== undefined) {
    io.stdout.write(`target: ${JSON.stringify(options.target)}\n`)
  }
  if (options.baseUrl !== undefined) {
    io.stdout.write(`baseUrl: ${options.baseUrl}\n`)
  }
  if (options.timeoutMs !== undefined) {
    io.stdout.write(`timeout: ${String(options.timeoutMs)}ms\n`)
  } else if (suite.timeoutMs !== undefined) {
    io.stdout.write(`timeout: ${String(suite.timeoutMs)}ms\n`)
  }
  io.stdout.write('\n')

  let connection: Awaited<ReturnType<typeof connectCuaBrowserDriver>>
  try {
    connection = await connectCuaBrowserDriver()
  } catch (error) {
    const code = errorCodeOf(error)
    io.stderr.write(
      `error: Cua driver unavailable${code === undefined ? '' : ` (${code})`}: ${messageOf(error)}\n`
      + 'hint: install cua-driver >= 0.38.0 on PATH and authorize it for browser automation\n',
    )
    return 2
  }

  try {
    let runtime: Awaited<ReturnType<typeof createWorkspaceRuntime>>
    try {
      runtime = await createWorkspaceRuntime({
        workspaceRoot,
        config: DEFAULT_HOST_CONFIG,
        driver: connection.driver,
      })
    } catch (error) {
      io.stderr.write(`error: cannot prepare the replay workspace: ${messageOf(error)}\n`)
      return 2
    }

    const report = await executeSuite({
      suite,
      replay: runtime.replay,
      ...(options.target === undefined ? {} : { target: options.target }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(Object.keys(options.values).length === 0 ? {} : { values: options.values }),
      ...(options.retries === undefined ? {} : { retries: options.retries }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      onCase: (item, index, total) => {
        io.stdout.write(`${describeCase(item, index, total)}\n`)
      },
    })

    try {
      await writeSuiteJUnit(junitPath, suiteName, report.cases)
    } catch (error) {
      io.stderr.write(`error: cannot write JUnit ${junitPath}: ${messageOf(error)}\n`)
      return 2
    }

    io.stdout.write(`\n${String(report.passed)} passed, ${String(report.failed)} failed (${String(report.cases.length)} cases)\n`)
    io.stdout.write(`junit: ${junitPath}\n`)
    return report.exitCode
  } catch (error) {
    io.stderr.write(`error: suite execution failed: ${messageOf(error)}\n`)
    return 2
  } finally {
    await connection.close()
  }
}

async function runPanelCommand(options: PanelCliOptions, io: CliIo): Promise<number> {
  const handle = await startPanelServer({
    roots: options.roots,
    port: options.port,
    host: options.host,
    ...(options.publicDir === undefined ? {} : { publicDir: options.publicDir }),
    cors: options.cors,
  })
  const projects = await handle.service.listProjects()
  const current = projects.find((project) => project.isCurrent)?.root ?? 'none'
  io.stdout.write(`panel: ${handle.url}\n`)
  io.stdout.write(`projects: ${String(projects.length)} (current: ${current})\n`)
  io.stdout.write(`api: ${handle.url.replace(/\/panel\/$/u, '')}/panel/projects\n`)
  io.stdout.write('press Ctrl+C to stop\n')

  return new Promise<number>((resolve) => {
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      void handle.close().then(() => resolve(0))
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

function printUsage(io: CliIo): void {
  io.stderr.write(USAGE)
}

/** CLI entry point; returns the process exit code instead of exiting. */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    io.stdout.write(USAGE)
    return 0
  }
  if (argv.length === 0) {
    printUsage(io)
    return 2
  }
  if (argv[0] === 'panel') {
    if (argv[1] === '--help' || argv[1] === '-h') {
      io.stdout.write(USAGE)
      return 0
    }
    let panelOptions: PanelCliOptions
    try {
      panelOptions = parsePanelArgs(argv.slice(1))
    } catch (error) {
      io.stderr.write(`error: ${messageOf(error)}\n\n`)
      printUsage(io)
      return 2
    }
    try {
      return await runPanelCommand(panelOptions, io)
    } catch (error) {
      io.stderr.write(`error: panel could not start: ${messageOf(error)}\n`)
      return 2
    }
  }
  let options: CliOptions
  try {
    options = parseCliArgs(argv)
  } catch (error) {
    io.stderr.write(`error: ${messageOf(error)}\n\n`)
    printUsage(io)
    return 2
  }
  try {
    return await runTestCommand(options, io)
  } catch (error) {
    io.stderr.write(`error: ${messageOf(error)}\n`)
    return 2
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  void runCli().then((code) => {
    process.exitCode = code
  }).catch((error: unknown) => {
    process.stderr.write(`error: ${messageOf(error)}\n`)
    process.exitCode = 2
  })
}
