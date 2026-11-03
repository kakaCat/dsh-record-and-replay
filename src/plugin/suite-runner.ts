/**
 * 套件执行器：`dsh-record-replay test` 用它完成顺序回放 / 超时 / 重试；
 * 不在模型工具面上（套件回归是 CLI/CI 路径）。
 *
 * 超时不是断言失败：定时器到点后用 `cancelRun(runId)` 中止该 Run，报告记
 * `errorCode: 'RUN_TIMEOUT'` + `timedOut: true`，然后继续下一条 case。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

import type { Principal, RecordingId, RunId } from '../core/api.js'
import type { ReplayPort, RunSummary } from '../host/index.js'
import type { ReplayTarget } from '../host/service.js'
import { toJUnit, type JUnitCase } from './junit.js'
import type { SuiteCase, SuiteTarget, TestSuite } from './suite.js'

/** 单 case 默认预算；`--timeout`、suite.timeoutMs、case.timeoutMs 都可覆盖。 */
export const DEFAULT_CASE_TIMEOUT_MS = 120_000

const DEFAULT_PRINCIPAL: Principal = {
  sessionId: 'dsh-record-replay-suite',
  agentId: 'dsh-record-replay-suite',
}

export interface SuiteCaseReport {
  readonly name: string
  readonly status: string
  readonly runId?: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly videoPath?: string
  /** true = 该 case 因超过 timeoutMs 被中止（errorCode 为 RUN_TIMEOUT）。 */
  readonly timedOut?: boolean
  readonly durationMs: number
}

export interface SuiteRunReport {
  readonly suiteName: string
  readonly cases: readonly SuiteCaseReport[]
  readonly passed: number
  readonly failed: number
  /** 0 when every case completed, otherwise 1. */
  readonly exitCode: 0 | 1
}

export interface ExecuteSuiteOptions {
  readonly suite: TestSuite
  readonly replay: Pick<ReplayPort, 'startReplay' | 'cancelRun'>
  /** 失败后额外重试次数（默认 0，不掩盖真实失败；超时不算可重试失败）。 */
  readonly retries?: number
  /** 调用方超时覆盖（CLI `--timeout`）；case.timeoutMs 仍优先，suite.timeoutMs 次之。 */
  readonly timeoutMs?: number
  /** CLI target override; a case-level target still wins. */
  readonly target?: SuiteTarget
  /** CLI baseUrl override; a case-level baseUrl still wins. */
  readonly baseUrl?: string
  /** CLI values; they win over suite.values and case.values. */
  readonly values?: Readonly<Record<string, string>>
  readonly principal?: Principal
  readonly now?: () => number
  readonly onCase?: (report: SuiteCaseReport, index: number, total: number) => void
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertPositiveInteger(value: number | undefined, what: string): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${what} must be a positive integer`)
  }
}

function mergedValues(
  suite: TestSuite,
  caseValues: Readonly<Record<string, string>> | undefined,
  cliValues: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  const merged = { ...suite.values, ...caseValues, ...cliValues }
  return Object.keys(merged).length === 0 ? undefined : merged
}

/** `WindowTarget` is the loose suite shape; the replay port wants its strict union. */
function toReplayTarget(target: SuiteTarget): ReplayTarget {
  const launch = target.launch ?? 'existing'
  if (launch === 'isolated') {
    return {
      launch,
      ...(target.profileName === undefined ? {} : { profileName: target.profileName }),
    }
  }
  if (target.pid === undefined || target.windowId === undefined) {
    throw new Error(`${launch} target requires pid and windowId`)
  }
  return { launch, pid: target.pid, windowId: target.windowId }
}

function reportFromRun(
  name: string,
  run: RunSummary,
  durationMs: number,
): SuiteCaseReport {
  // The replay port attaches `videoPath` at runtime; the host DTO type does not
  // expose it yet.
  const videoPath = (run as RunSummary & { readonly videoPath?: string }).videoPath
  return {
    name,
    status: run.status,
    runId: run.runId,
    ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
    ...(run.errorMessage === undefined ? {} : { errorMessage: run.errorMessage }),
    ...(videoPath === undefined ? {} : { videoPath }),
    durationMs,
  }
}

function timeoutReport(
  name: string,
  runId: string | undefined,
  timeoutMs: number,
  durationMs: number,
): SuiteCaseReport {
  return {
    name,
    status: 'cancelled',
    ...(runId === undefined ? {} : { runId }),
    errorCode: 'RUN_TIMEOUT',
    errorMessage: `case ${JSON.stringify(name)} timed out after ${String(timeoutMs)}ms; the run was cancelled`,
    timedOut: true,
    durationMs,
  }
}

interface ExecuteCaseArgs {
  readonly testCase: SuiteCase
  readonly replay: Pick<ReplayPort, 'startReplay' | 'cancelRun'>
  readonly principal: Principal
  readonly target: SuiteTarget | undefined
  readonly baseUrl: string | undefined
  readonly values: Readonly<Record<string, string>> | undefined
  readonly timeoutMs: number
  readonly now: () => number
}

/**
 * 跑一条 case 的一次尝试：用定时器 + `cancelRun(runId)` 实现超时。
 *
 * runId 在 `onRunStarted` 之前不可知（plan 阶段），所以超时先记 timedOut，
 * 等 runId 到手再立刻取消——不会留下在途 Run。
 */
async function executeCaseOnce(args: ExecuteCaseArgs): Promise<SuiteCaseReport> {
  const startedAt = args.now()
  let runId: RunId | undefined
  let timedOut = false
  let cancellation: Promise<void> | undefined

  const cancel = (): void => {
    if (runId === undefined || cancellation !== undefined) return
    const id = runId
    cancellation = args.replay.cancelRun(id, args.principal).then(
      () => undefined,
      () => undefined,
    )
  }
  const timer = setTimeout(() => {
    timedOut = true
    cancel()
  }, args.timeoutMs)
  // 不让未触发的定时器拖住进程退出；运行中的 Run 仍由 startReplay 的 Promise 持有。
  timer.unref?.()

  try {
    const run = await args.replay.startReplay({
      recordingId: args.testCase.recordingId as RecordingId,
      ...(args.target === undefined ? {} : { target: toReplayTarget(args.target) }),
      ...(args.values === undefined ? {} : { values: args.values }),
      ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
      onRunStarted: (id) => {
        runId = id
        if (timedOut) cancel()
      },
    }, args.principal)
    if (timedOut) {
      await cancellation
      return timeoutReport(args.testCase.name, runId ?? run.runId, args.timeoutMs, args.now() - startedAt)
    }
    return reportFromRun(args.testCase.name, run, args.now() - startedAt)
  } catch (error) {
    if (timedOut) {
      await cancellation
      return timeoutReport(args.testCase.name, runId, args.timeoutMs, args.now() - startedAt)
    }
    const errorCode = errorCodeOf(error)
    return {
      name: args.testCase.name,
      status: 'error',
      ...(errorCode === undefined ? {} : { errorCode }),
      errorMessage: messageOf(error),
      durationMs: args.now() - startedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Replay every case in order; a failure (including a timeout) is recorded and the loop continues. */
export async function executeSuite(options: ExecuteSuiteOptions): Promise<SuiteRunReport> {
  assertPositiveInteger(options.timeoutMs, 'timeoutMs')
  assertPositiveInteger(options.suite.timeoutMs, 'suite.timeoutMs')
  const now = options.now ?? Date.now
  const principal = options.principal ?? DEFAULT_PRINCIPAL
  const cases: SuiteCaseReport[] = []

  for (const [index, testCase] of options.suite.cases.entries()) {
    assertPositiveInteger(testCase.timeoutMs, `case ${JSON.stringify(testCase.name)} timeoutMs`)
    const target = testCase.target ?? options.target ?? options.suite.target
    const baseUrl = testCase.baseUrl ?? options.baseUrl ?? options.suite.baseUrl
    const values = mergedValues(options.suite, testCase.values, options.values)
    const timeoutMs = testCase.timeoutMs ?? options.timeoutMs ?? options.suite.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS
    const attempts = Math.max(1, (options.retries ?? 0) + 1)
    let report: SuiteCaseReport | undefined
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      report = await executeCaseOnce({
        testCase,
        replay: options.replay,
        principal,
        target,
        baseUrl,
        values,
        timeoutMs,
        now,
      })
      // 超时是预算问题，不靠重试掩盖；completed 也没必要重试。
      if (report.status === 'completed' || report.timedOut === true) break
    }
    const finalReport = report as SuiteCaseReport
    cases.push(finalReport)
    options.onCase?.(finalReport, index, options.suite.cases.length)
  }

  const passed = cases.filter(report => report.status === 'completed').length
  const failed = cases.length - passed
  return {
    suiteName: options.suite.name ?? 'suite',
    cases,
    passed,
    failed,
    exitCode: failed === 0 ? 0 : 1,
  }
}

export function junitPathFor(suitePath: string): string {
  return suitePath.replace(/\.json$/u, '') + '.junit.xml'
}

export async function writeSuiteJUnit(
  filePath: string,
  suiteName: string,
  reports: readonly SuiteCaseReport[],
): Promise<void> {
  const cases: JUnitCase[] = reports.map(report => ({
    name: report.name,
    status: report.status,
    ...(report.errorCode === undefined ? {} : { errorCode: report.errorCode }),
    ...(report.errorMessage === undefined ? {} : { error: report.errorMessage }),
  }))
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, toJUnit(suiteName, cases), 'utf8')
}
