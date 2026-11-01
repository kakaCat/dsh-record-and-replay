import { describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION,
  newStepId,
  type BrowserAction,
  type Principal,
  type RecordingId,
  type StepId,
} from '../../src/core/api.js'
import {
  BrowserDriverError,
  type BindBrowserInput,
  type BrowserBinding,
  type BrowserDriver,
  type DriverCapabilities,
  type Observation,
  type ResolvedTarget,
} from '../../src/driver/api.js'
import type { ProjectedStep } from '../../src/recording/index.js'
import {
  MemoryRunStore,
  SemanticReplayRunner,
  type RecordingSource,
} from '../../src/replay/index.js'
import type { StoreManifest } from '../../src/store/api.js'

const owner: Principal = { sessionId: 'session-replay', agentId: 'agent-test' }
const recordingId = 'rec_replay_fixture_001' as RecordingId
const hash = 'a'.repeat(64)

function actionNavigate(): BrowserAction {
  return { kind: 'navigate', url: 'https://example.test/start' }
}

function actionClick(): BrowserAction {
  return { kind: 'click', target: { role: 'button', name: 'Submit' } }
}

function projectedStep(seq: number, stepId: StepId, action: BrowserAction, status: ProjectedStep['status'] = 'success'): ProjectedStep {
  return {
    stepId,
    seq,
    callId: `call-${String(seq)}`,
    origin: 'agent',
    actionKind: action.kind,
    action,
    status,
    startedAt: 1_000 + seq,
    finishedAt: 1_010 + seq,
    durationMs: 10,
  }
}

class FakeRecordingSource implements RecordingSource {
  verifyCalls = 0
  changed = false

  constructor(
    readonly manifest: StoreManifest,
    readonly steps: readonly ProjectedStep[],
  ) {}

  async readManifest(): Promise<StoreManifest> {
    return this.manifest
  }

  async *readSteps(): AsyncIterable<ProjectedStep> {
    yield* this.steps
  }

  async verifyRecordingUnchanged(): Promise<boolean> {
    this.verifyCalls += 1
    return !this.changed
  }
}

function manifest(status: StoreManifest['status'] = 'completed'): StoreManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    recordingId,
    title: 'Replay fixture',
    status,
    ownerSessionId: owner.sessionId,
    driver: { id: 'fake-replay-driver', version: '0.38.0', transport: 'mcp' },
    browser: { app: 'Chrome' },
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    lastSeq: 2,
    stepCount: 2,
    stepsSha256: hash,
  }
}

class FakeReplayDriver implements BrowserDriver {
  readonly id = 'fake-replay-driver'
  readonly actions: readonly BrowserAction['kind'][]
  readonly receivedValues: string[] = []
  missingButton = false
  private sequence = 0
  private readonly pages = new Map<string, { url: string; clicked: number; values: string[] }>()

  constructor(options: { missingButton?: boolean; actions?: readonly BrowserAction['kind'][] } = {}) {
    this.missingButton = options.missingButton ?? false
    this.actions = options.actions ?? ['navigate', 'click', 'setValue']
  }

  async capabilities(): Promise<DriverCapabilities> {
    return { actions: this.actions, locators: ['role', 'name', 'text', 'url'], driverVersion: '0.38.0' }
  }

  async bind(input: BindBrowserInput, context: { principal: Principal }): Promise<BrowserBinding> {
    if (input.launch === 'isolated') {
      throw new BrowserDriverError('ACTION_UNSUPPORTED', 'this fake driver does not launch isolated browsers')
    }
    const id = `bt-${context.principal.sessionId}-${String(input.windowId)}`
    this.pages.set(id, { url: 'about:blank', clicked: 0, values: [] })
    return {
      id,
      driverId: this.id,
      sessionId: context.principal.sessionId,
      pid: input.pid,
      windowId: input.windowId,
      targetId: id,
      tabId: `tab-${String(input.windowId)}`,
      generation: 1,
    }
  }

  private ensure(binding: BrowserBinding): { url: string; clicked: number; values: string[] } {
    const page = this.pages.get(binding.id) ?? { url: 'about:blank', clicked: 0, values: [] }
    this.pages.set(binding.id, page)
    return page
  }

  async observe(binding: BrowserBinding): Promise<Observation> {
    const page = this.ensure(binding)
    this.sequence += 1
    return {
      observationId: `obs-${String(this.sequence)}`,
      bindingGeneration: binding.generation,
      url: page.url,
      elements: [
        ...(this.missingButton ? [] : [{ ref: `p${String(this.sequence)}:0`, role: 'button', name: 'Submit', actions: ['click'] }]),
        { ref: `p${String(this.sequence)}:1`, role: 'textbox', name: 'Name', actions: ['type'] },
      ],
    }
  }

  async resolve(_binding: BrowserBinding, target: { role?: string; name?: string }, observation: Observation): Promise<ResolvedTarget> {
    const matches = observation.elements.filter((element) =>
      (target.role === undefined || element.role === target.role)
      && (target.name === undefined || element.name === target.name),
    )
    if (matches.length === 0) throw new BrowserDriverError('TARGET_NOT_FOUND', 'target element not found')
    if (matches.length > 1) throw new BrowserDriverError('TARGET_AMBIGUOUS', 'target element is ambiguous')
    const match = matches[0]
    if (match === undefined) throw new BrowserDriverError('TARGET_NOT_FOUND', 'target element not found')
    return { ref: match.ref, role: match.role, observationId: observation.observationId }
  }

  async execute(binding: BrowserBinding, action: BrowserAction): Promise<{ status: 'ok' }> {
    const page = this.ensure(binding)
    if (action.kind === 'navigate') page.url = action.url
    else if (action.kind === 'click') page.clicked += 1
    else if (action.kind === 'setValue') {
      this.receivedValues.push(action.value)
      page.values.push(action.value)
    }
    else throw new BrowserDriverError('ACTION_UNSUPPORTED', `${action.kind} is unsupported`)
    return { status: 'ok' }
  }

  async release(): Promise<void> {}
}

function makeRunner(source: FakeRecordingSource, driver: FakeReplayDriver, settleTimeoutMs = 50) {
  const runStore = new MemoryRunStore()
  const binding: BrowserBinding = {
    id: 'bt-replay-test',
    driverId: driver.id,
    sessionId: owner.sessionId,
    pid: 100,
    windowId: 10,
    targetId: 'bt-replay-test',
    tabId: 'tab-10',
    generation: 1,
  }
  const runner = new SemanticReplayRunner({
    recordings: source,
    runStore,
    driver,
    binding: () => binding,
    settleTimeoutMs,
  })
  return { runner, runStore }
}

describe('ReplayService / Semantic Runner', () => {
  it('plans executable recordings and replays the fixture 20/20', async () => {
    const step1 = projectedStep(1, newStepId(), actionNavigate())
    const step2 = projectedStep(2, newStepId(), actionClick())
    const source = new FakeRecordingSource(manifest(), [step1, step2])
    const driver = new FakeReplayDriver()
    const { runner } = makeRunner(source, driver)

    const plan = await runner.plan(recordingId)
    expect(plan.executable).toBe(true)
    expect(plan.stepCount).toBe(2)
    expect(plan.writeActionCount).toBe(1)
    expect(plan.unsupportedSteps).toEqual([])

    for (let index = 0; index < 20; index += 1) {
      const runId = await runner.execute(recordingId, {}, owner)
      const run = await runner.getRun(runId)
      expect(run.status).toBe('completed')
      expect(run.recordingSha256).toBe(hash)
    }
    expect(source.verifyCalls).toBeGreaterThanOrEqual(40)
  })

  it('replays redacted setValue steps when a process-only value is supplied', async () => {
    const step1 = projectedStep(1, newStepId(), actionNavigate())
    const step2 = projectedStep(2, newStepId(), {
      kind: 'setValue',
      target: { role: 'textbox', name: 'Name' },
      value: '********',
    })
    const source = new FakeRecordingSource(manifest(), [step1, step2])
    const driver = new FakeReplayDriver()
    const { runner } = makeRunner(source, driver)

    const blocked = await runner.plan(recordingId)
    expect(blocked.executable).toBe(false)
    expect(blocked.unsupportedSteps[0]?.stepId).toBe(step2.stepId)

    const runId = await runner.execute(recordingId, { values: { [step2.stepId]: 'Alice' } }, owner)
    expect((await runner.getRun(runId)).status).toBe('completed')
    expect(driver.receivedValues).toEqual(['Alice'])
  })

  it('fails with stepId and TARGET_NOT_FOUND when a semantic target disappears', async () => {
    const step1 = projectedStep(1, newStepId(), actionNavigate())
    const step2 = projectedStep(2, newStepId(), actionClick())
    const source = new FakeRecordingSource(manifest(), [step1, step2])
    const driver = new FakeReplayDriver({ missingButton: true })
    const { runner } = makeRunner(source, driver)

    const runId = await runner.execute(recordingId, {}, owner)
    const run = await runner.getRun(runId)

    expect(run.status).toBe('failed')
    expect(run.currentStepId).toBe(step2.stepId)
    expect(run.error?.code).toBe('TARGET_NOT_FOUND')
    expect(source.changed).toBe(false)
  })

  it('marks unsupported steps and refuses to execute the recording', async () => {
    const step1 = projectedStep(1, newStepId(), actionNavigate())
    const step2 = projectedStep(2, newStepId(), { kind: 'scroll', deltaX: 0, deltaY: 100 })
    const source = new FakeRecordingSource(manifest(), [step1, step2])
    const driver = new FakeReplayDriver({ actions: ['navigate', 'click', 'setValue'] })
    const { runner } = makeRunner(source, driver)

    const plan = await runner.plan(recordingId)
    expect(plan.executable).toBe(false)
    expect(plan.unsupportedSteps[0]?.stepId).toBe(step2.stepId)
    await expect(runner.execute(recordingId, {}, owner)).rejects.toMatchObject({ code: 'REPLAY_UNSUPPORTED_STEP' })
  })

  it('rejects recordings that are not completed', async () => {
    const source = new FakeRecordingSource(manifest('interrupted'), [])
    const driver = new FakeReplayDriver()
    const { runner } = makeRunner(source, driver)

    await expect(runner.plan(recordingId)).rejects.toMatchObject({ code: 'RECORDING_INCOMPLETE' })
  })

  it('retries a target that renders late instead of failing the run', async () => {
    const step1 = projectedStep(1, newStepId(), actionNavigate())
    const step2 = projectedStep(2, newStepId(), actionClick())
    const source = new FakeRecordingSource(manifest(), [step1, step2])
    const driver = new FakeReplayDriver()
    const original = driver.resolve.bind(driver)
    let attempts = 0
    driver.resolve = async (binding, target, observation) => {
      attempts += 1
      if (attempts < 3) throw new BrowserDriverError('TARGET_NOT_FOUND', 'not rendered yet')
      return await original(binding, target, observation)
    }
    const { runner } = makeRunner(source, driver, 2_000)

    const runId = await runner.execute(recordingId, {}, owner)
    const run = await runner.getRun(runId)
    expect(run.status).toBe('completed')
    expect(attempts).toBe(3)
  })

  it('skips failed steps instead of replaying them', async () => {
    const click = actionClick()
    const step1 = projectedStep(1, newStepId(), actionNavigate())
    const step2 = projectedStep(2, newStepId(), click, 'error')
    const step3 = projectedStep(3, newStepId(), click)
    const source = new FakeRecordingSource(manifest(), [step1, step2, step3])
    const driver = new FakeReplayDriver()
    const { runner } = makeRunner(source, driver)

    const plan = await runner.plan(recordingId)
    expect(plan.stepCount).toBe(2)
    expect(plan.executable).toBe(true)

    const runId = await runner.execute(recordingId, {}, owner)
    const run = await runner.getRun(runId)
    expect(run.status).toBe('completed')
  })

  it('uses idempotencyKey to avoid duplicate Run creation', async () => {
    const step1 = projectedStep(1, newStepId(), actionNavigate())
    const source = new FakeRecordingSource(manifest(), [step1])
    const driver = new FakeReplayDriver()
    const { runner } = makeRunner(source, driver)

    const first = await runner.execute(recordingId, { idempotencyKey: 'once' }, owner)
    const second = await runner.execute(recordingId, { idempotencyKey: 'once' }, owner)
    expect(second).toBe(first)
    expect(await runner.getRun(first)).toMatchObject({ status: 'completed' })
  })
})
