import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { executeSuite, writeSuiteJUnit, type SuiteCaseReport } from '../../../src/cli.js'
import type { ReplayPort, RunSummary, StartReplayInput } from '../../../src/host/index.js'
import { parseTestSuite } from '../../../src/plugin/suite.js'
import type { RecordingId, RunId } from '../../../src/core/api.js'

class CodedError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CodedError'
    this.code = code
  }
}

function summary(input: StartReplayInput, status: RunSummary['status'], runId: string): RunSummary {
  return {
    runId: runId as RunId,
    recordingId: input.recordingId as RecordingId,
    status,
    ownerSessionId: 'cli-test',
    ...(status === 'failed'
      ? { errorCode: 'ASSERTION_FAILED' as const, errorMessage: 'assertion failed' }
      : {}),
  }
}

function fakeReplay(
  handler: (input: StartReplayInput) => RunSummary | Promise<RunSummary>,
  cancelled: string[] = [],
): Pick<ReplayPort, 'startReplay' | 'cancelRun'> {
  return {
    async startReplay(input) {
      return handler(input)
    },
    async cancelRun(runId) {
      cancelled.push(runId)
      return {
        runId,
        recordingId: 'rec_cancelled' as RecordingId,
        status: 'cancelled',
        ownerSessionId: 'cli-test',
      }
    },
  }
}

const suite = parseTestSuite({
  name: 'mixed',
  target: { launch: 'isolated' },
  baseUrl: 'https://suite.test',
  values: { shared: 'suite', overridden: 'suite' },
  cases: [
    {
      name: 'ok',
      recordingId: 'rec_aaa',
      baseUrl: 'https://case.test',
      values: { caseOnly: 'case', overridden: 'case' },
    },
    { name: 'assert', recordingId: 'rec_bbb' },
    { name: 'boom', recordingId: 'rec_ccc' },
  ],
})

describe('cli suite execution', () => {
  it('runs every case in order, keeps going after failures and merges inputs', async () => {
    const calls: StartReplayInput[] = []
    const seen: string[] = []
    const replay = fakeReplay((input) => {
      calls.push(input)
      const index = calls.length
      if (index === 1) return summary(input, 'completed', 'run_ok')
      if (index === 2) return summary(input, 'failed', 'run_failed')
      throw new CodedError('REPLAY_UNSUPPORTED_STEP', 'setValue step_1 has no replay value')
    })

    const report = await executeSuite({
      suite,
      replay,
      target: { launch: 'existing', pid: 9, windowId: 8 },
      baseUrl: 'https://cli.test',
      values: { shared: 'cli', overridden: 'cli' },
      onCase: (item) => seen.push(item.name),
    })

    expect(seen).toEqual(['ok', 'assert', 'boom'])
    expect(report.passed).toBe(1)
    expect(report.failed).toBe(2)
    expect(report.exitCode).toBe(1)

    expect(calls[0]?.baseUrl).toBe('https://case.test')
    expect(calls[1]?.baseUrl).toBe('https://cli.test')
    expect(calls[0]?.target).toEqual({ launch: 'existing', pid: 9, windowId: 8 })
    expect(calls[0]?.values).toEqual({ shared: 'cli', overridden: 'cli', caseOnly: 'case' })
    expect(calls[1]?.values).toEqual({ shared: 'cli', overridden: 'cli' })

    expect(report.cases[1]).toMatchObject({
      name: 'assert',
      status: 'failed',
      runId: 'run_failed',
      errorCode: 'ASSERTION_FAILED',
    })
    expect(report.cases[2]).toMatchObject({
      name: 'boom',
      status: 'error',
      errorCode: 'REPLAY_UNSUPPORTED_STEP',
    })
  })

  it('returns exit code 0 only when every case completed', async () => {
    const passing = parseTestSuite({ cases: [{ name: 'one', recordingId: 'rec_one' }] })
    const report = await executeSuite({
      suite: passing,
      replay: fakeReplay(input => summary(input, 'completed', 'run_one')),
    })
    expect(report.exitCode).toBe(0)
    expect(report.failed).toBe(0)
  })

  it('cancels a run that exceeds its timeout and still runs the next case', async () => {
    const cancelled: string[] = []
    const started: string[] = []
    const timeoutSuite = parseTestSuite({
      cases: [
        { name: 'slow', recordingId: 'rec_slow', timeoutMs: 5 },
        { name: 'fast', recordingId: 'rec_fast', timeoutMs: 5000 },
      ],
    })
    const replay = fakeReplay(async (input) => {
      started.push(input.recordingId)
      input.onRunStarted?.('run_slow' as RunId)
      if (input.recordingId === 'rec_slow') {
        await new Promise(resolve => setTimeout(resolve, 30))
        return summary(input, 'cancelled', 'run_slow')
      }
      return summary(input, 'completed', 'run_fast')
    }, cancelled)

    const report = await executeSuite({ suite: timeoutSuite, replay })

    expect(cancelled).toEqual(['run_slow'])
    expect(started).toEqual(['rec_slow', 'rec_fast'])
    expect(report.cases[0]).toMatchObject({
      name: 'slow',
      status: 'cancelled',
      runId: 'run_slow',
      timedOut: true,
      errorCode: 'RUN_TIMEOUT',
    })
    expect(report.cases[0]?.errorMessage).toMatch(/timed out/u)
    expect(report.cases[1]).toMatchObject({ name: 'fast', status: 'completed', runId: 'run_fast' })
    expect(report.cases[1]?.timedOut).toBeUndefined()
    expect(report.passed).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.exitCode).toBe(1)
  })

  it('uses the suite timeout and lets a caller override it', async () => {
    const cancelled: string[] = []
    const suiteWithTimeout = parseTestSuite({
      timeoutMs: 5,
      cases: [{ name: 'slow', recordingId: 'rec_slow' }],
    })
    const replay = fakeReplay(async (input) => {
      input.onRunStarted?.('run_slow' as RunId)
      await new Promise(resolve => setTimeout(resolve, 30))
      return summary(input, 'cancelled', 'run_slow')
    }, cancelled)

    const timedOut = await executeSuite({ suite: suiteWithTimeout, replay })
    expect(timedOut.cases[0]?.timedOut).toBe(true)

    const overridden = await executeSuite({
      suite: suiteWithTimeout,
      replay: fakeReplay(input => summary(input, 'completed', 'run_fast')),
      timeoutMs: 5000,
    })
    expect(overridden.cases[0]?.status).toBe('completed')
    expect(overridden.exitCode).toBe(0)
  })

  it('writes JUnit with failures and escaped suite names', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-record-replay-cli-'))
    const file = path.join(dir, 'nested', 'report.xml')
    const reports: SuiteCaseReport[] = [
      { name: 'ok', status: 'completed', runId: 'run_ok', durationMs: 10 },
      {
        name: 'bad & slow',
        status: 'failed',
        runId: 'run_bad',
        errorCode: 'ASSERTION_FAILED',
        errorMessage: 'expected <inventory>',
        durationMs: 20,
      },
    ]
    try {
      await writeSuiteJUnit(file, 'suite & <mixed>', reports)
      const xml = await readFile(file, 'utf8')
      expect(xml).toContain('name="suite &amp; &lt;mixed&gt;"')
      expect(xml).toContain('tests="2"')
      expect(xml).toContain('failures="1"')
      expect(xml).toContain('name="bad &amp; slow"')
      expect(xml).toContain('<failure message="expected &lt;inventory&gt;">')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
