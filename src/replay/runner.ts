import {
  SCHEMA_VERSION,
  createPublicError,
  newRunId,
  toPublicError,
  type BrowserAction,
  type OperationContext,
  type Principal,
  type PublicError,
  type RecordingId,
  type RunId,
  type StepId,
} from '../core/api.js'
import {
  type BrowserBinding,
  type BrowserDriver,
  type Observation,
  type ResolvedTarget,
} from '../driver/api.js'
import { failureEvidenceJson } from './evidence.js'
import { unsupportedReasonForStep } from './planner.js'
import { projectStepStream, type ProjectedStep, type RecordingStepEvent } from '../recording/index.js'
import type { StoreManifest, StoreStepEvent, StoreStepFinished, StoreStepStarted } from '../store/api.js'
import {
  ReplayServiceError,
  type RecordingSource,
  type ReplayOptions,
  type ReplayPlan,
  type ReplayRun,
  type ReplayService,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type RunWriter,
  type UnsupportedStep,
} from './api.js'

export interface SemanticReplayRunnerOptions {
  /** Recording 读模型（RecordingService + Store 的组合由 Host 注入）。 */
  readonly recordings: RecordingSource
  /** Run 持久化 SPI。 */
  readonly runStore: RunStore
  readonly driver: BrowserDriver
  /** 为本 Run 获取一个浏览器绑定；Host 可注入当前绑定或新建隔离绑定。 */
  readonly binding: () => Promise<BrowserBinding> | BrowserBinding
  readonly newRunId?: () => RunId
  readonly clock?: () => number
  /** 目标暂时不可见时（页面还在渲染）的重试窗口；0 表示不等待。 */
  readonly settleTimeoutMs?: number
}

const DEFAULT_SETTLE_TIMEOUT_MS = 5_000
const SETTLE_RETRY_INTERVAL_MS = 250

/** 页面尚未渲染出目标：可以刷新快照再试，不是永久失败。 */
function isTargetNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'TARGET_NOT_FOUND'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface ReplayExecutionResult {
  readonly runId: RunId
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly failedStepId?: StepId
  readonly error?: PublicError
  readonly evidencePath?: string
}

/** Semantic-v1 Runner：逐步 observe/resolve/execute，失败即停，证据写入 Run evidence/。 */
export class SemanticReplayRunner implements ReplayService {
  private readonly recordings: RecordingSource
  private readonly runStore: RunStore
  private readonly driver: BrowserDriver
  private readonly binding: () => Promise<BrowserBinding> | BrowserBinding
  private readonly newId: () => RunId
  private readonly clock: () => number
  private readonly settleTimeoutMs: number
  private readonly controllers = new Map<RunId, AbortController>()
  private readonly startedByKey = new Map<string, RunId>()

  constructor(options: SemanticReplayRunnerOptions) {
    this.recordings = options.recordings
    this.runStore = options.runStore
    this.driver = options.driver
    this.binding = options.binding
    this.newId = options.newRunId ?? newRunId
    this.clock = options.clock ?? (() => Date.now())
    this.settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  }

  async plan(recordingId: RecordingId, options: ReplayOptions = {}): Promise<ReplayPlan> {
    void options.strategy
    const manifest = await this.readCompletedManifest(recordingId)
    const sha = manifest.stepsSha256
    if (sha === undefined || !/^[0-9a-f]{64}$/i.test(sha)) {
      throw new ReplayServiceError('RECORDING_HASH_MISMATCH', 'recording has no usable stepsSha256', { recordingId })
    }
    if (!(await this.recordings.verifyRecordingUnchanged(recordingId, sha))) {
      throw new ReplayServiceError('RECORDING_HASH_MISMATCH', 'recording changed while planning', { recordingId })
    }

    const capabilities = await this.driver.capabilities(options.launch)
    const supported = new Set(capabilities.actions)
    const unsupportedSteps: UnsupportedStep[] = []
    let stepCount = 0
    let writeActionCount = 0

    for await (const step of this.recordings.readSteps(recordingId)) {
      // 失败步骤只做审计，不进入回放计划。
      if (step.status !== 'success') continue
      stepCount += 1
      const reason = unsupportedReasonForStep(step, supported, options.values ?? {})
      if (reason !== undefined) {
        unsupportedSteps.push({ stepId: step.stepId, seq: step.seq, reason })
        continue
      }
      if (step.action.kind === 'click' || step.action.kind === 'setValue' || step.action.kind === 'key') {
        writeActionCount += 1
      }
    }

    return {
      recordingId,
      recordingSha256: sha,
      strategy: 'semantic-v1',
      executable: unsupportedSteps.length === 0,
      stepCount,
      writeActionCount,
      unsupportedSteps,
    }
  }

  /**
   * 观察并在目标暂时不可见时重试，解决「导航刚返回、SPA 还没渲染完」的回放失败。
   * 只在 TARGET_NOT_FOUND 上重试，且受 settleTimeoutMs 约束。
   */
  private async resolveStep(
    binding: BrowserBinding,
    action: BrowserAction,
    context: OperationContext,
  ): Promise<{ observation: Observation; resolved: ResolvedTarget | undefined }> {
    const target = 'target' in action ? action.target : undefined
    const deadline = Date.now() + this.settleTimeoutMs
    for (;;) {
      const observation = await this.driver.observe(binding, context)
      if (target === undefined) return { observation, resolved: undefined }
      try {
        return { observation, resolved: await this.driver.resolve(binding, target, observation) }
      } catch (error) {
        if (context.signal.aborted || !isTargetNotFound(error) || Date.now() >= deadline) throw error
        await sleep(SETTLE_RETRY_INTERVAL_MS)
      }
    }
  }

  async execute(recordingId: RecordingId, options: ReplayOptions, principal: Principal): Promise<RunId> {
    const idempotencyKey = options.idempotencyKey
    if (idempotencyKey !== undefined) {
      const existing = this.startedByKey.get(`${principal.sessionId}${idempotencyKey}`)
      if (existing !== undefined) return existing
    }

    const plan = await this.plan(recordingId, options)
    if (!plan.executable) {
      const first = plan.unsupportedSteps[0]
      throw new ReplayServiceError(
        'REPLAY_UNSUPPORTED_STEP',
        `step ${first?.stepId ?? '(unknown)'} is not replayable: ${first?.reason ?? 'unsupported'}`,
        {
          recordingId,
          ...(first?.stepId === undefined ? {} : { stepId: first.stepId }),
        },
      )
    }

    const runId = this.newId()
    const controller = new AbortController()
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort(options.signal.reason)
      else options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true })
    }
    this.controllers.set(runId, controller)

    const startedAt = new Date(this.clock()).toISOString()
    const baseRecord: RunRecord = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      recordingId,
      recordingSha256: plan.recordingSha256,
      driver: {
        id: this.driver.id,
        version: (await this.driver.capabilities()).driverVersion,
        transport: this.driver.transport ?? 'mcp',
      },
      status: 'preparing',
      startedAt,
    }
    const writer = await this.runStore.create(baseRecord)
    if (idempotencyKey !== undefined) {
      this.startedByKey.set(`${principal.sessionId}${idempotencyKey}`, runId)
    }
    options.onRunStarted?.(runId)

    let binding: BrowserBinding | undefined
    try {
      // 调用方在 onRunStarted 里立刻 cancel（例如套件超时）时，连绑定都不必做。
      if (controller.signal.aborted) {
        await writer.finish({ ...baseRecord, status: 'cancelled', finishedAt: new Date(this.clock()).toISOString() })
        return runId
      }
      await writer.update({ ...baseRecord, status: 'running' })
      binding = await this.binding()
      const result = await this.runSteps({
        writer, baseRecord, plan, binding, principal, controller,
        values: options.values ?? {},
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      })
      const finishedAt = new Date(this.clock()).toISOString()
      if (result.status === 'completed') {
        if (!(await this.recordings.verifyRecordingUnchanged(recordingId, plan.recordingSha256))) {
          const error = createPublicError('INVALID_ARGUMENT', 'RECORDING_HASH_MISMATCH: source recording changed during replay')
          await writer.finish({ ...baseRecord, status: 'failed', finishedAt, error })
        } else {
          await writer.finish({ ...baseRecord, status: 'completed', finishedAt })
        }
      } else if (result.status === 'cancelled') {
        await writer.finish({ ...baseRecord, status: 'cancelled', finishedAt })
      } else {
        await writer.finish({
          ...baseRecord,
          status: 'failed',
          ...(result.failedStepId === undefined ? {} : { currentStepId: result.failedStepId }),
          finishedAt,
          ...(result.error === undefined ? {} : { error: result.error }),
        })
      }
      return runId
    } catch (error) {
      const finishedAt = new Date(this.clock()).toISOString()
      const publicError = toPublicError(error)
      await writer.finish({ ...baseRecord, status: 'failed', finishedAt, error: publicError }).catch(() => undefined)
      throw error
    } finally {
      this.controllers.delete(runId)
      if (binding !== undefined) await this.driver.release(binding).catch(() => undefined)
    }
  }

  async getRun(runId: RunId): Promise<ReplayRun> {
    const record = await this.runStore.findRun(runId)
    if (record === undefined) throw new ReplayServiceError('RUN_NOT_FOUND', `unknown run ${runId}`, { runId })
    return toReplayRun(record)
  }

  async *readRunSteps(runId: RunId): AsyncIterable<ProjectedStep> {
    const record = await this.runStore.findRun(runId)
    if (record === undefined) throw new ReplayServiceError('RUN_NOT_FOUND', `unknown run ${runId}`, { runId })
    const events = this.runStore.readSteps(record.recordingId, runId) as AsyncIterable<RecordingStepEvent>
    yield* projectStepStream(events, { terminal: true })
  }

  async cancel(runId: RunId, principal: Principal): Promise<ReplayRun> {
    const record = await this.runStore.findRun(runId)
    if (record === undefined) throw new ReplayServiceError('RUN_NOT_FOUND', `unknown run ${runId}`, { runId })
    void principal
    if (record.status === 'preparing' || record.status === 'running') {
      this.controllers.get(runId)?.abort()
      return toReplayRun({ ...record, status: 'cancelled', finishedAt: new Date(this.clock()).toISOString() })
    }
    return toReplayRun(record)
  }

  private async readCompletedManifest(recordingId: RecordingId): Promise<StoreManifest> {
    const manifest = await this.recordings.readManifest(recordingId)
    if (manifest.status !== 'completed') {
      throw new ReplayServiceError('RECORDING_INCOMPLETE', `recording ${recordingId} is ${manifest.status}; only completed recordings can be replayed`, { recordingId })
    }
    return manifest
  }

  private async runSteps(input: {
    writer: RunWriter
    baseRecord: RunRecord
    plan: ReplayPlan
    binding: BrowserBinding
    principal: Principal
    controller: AbortController
    values: Readonly<Record<string, string>>
    baseUrl?: string
  }): Promise<ReplayExecutionResult> {
    const { writer, baseRecord, plan, binding, principal, controller, values, baseUrl } = input
    const unsupported = new Map(plan.unsupportedSteps.map((step) => [step.stepId, step]))
    let observation: Observation | undefined
    let executed = 0

    for await (const step of this.recordings.readSteps(baseRecord.recordingId)) {
      // 失败步骤不重放：它们从未成功完成，重放只会把同一个错误再演一遍。
      if (step.status !== 'success') continue
      if (unsupported.has(step.stepId)) continue
      if (controller.signal.aborted) return { runId: baseRecord.runId, status: 'cancelled' }

      const context = this.contextFor(principal, baseRecord.runId, step.seq, controller.signal)
      const startedAt = this.clock()
      const started: StoreStepStarted = {
        type: 'step.started',
        schemaVersion: SCHEMA_VERSION,
        stepId: step.stepId,
        seq: step.seq,
        callId: step.stepId,
        origin: 'replay',
        action: step.action,
        startedAt,
      }
      await writer.append(started)
      await writer.update({ ...baseRecord, status: 'running', currentStepId: step.stepId })

      try {
        const prepared = await this.resolveStep(binding, step.action, context)
        observation = prepared.observation
        const resolved = prepared.resolved
        const action = this.applyBaseUrl(this.materializeSecrets(step, values), baseUrl)
        await this.driver.execute(binding, action, resolved, context)
        const finishedAt = this.clock()
        const finished: StoreStepFinished = {
          type: 'step.finished',
          stepId: step.stepId,
          callId: step.stepId,
          status: 'success',
          finishedAt,
          durationMs: finishedAt - startedAt,
        }
        await writer.append(finished)
        executed += 1
      } catch (error) {
        const finishedAt = this.clock()
        const publicError = toPublicError(error)
        await writer.append({
          type: 'step.finished',
          stepId: step.stepId,
          callId: step.stepId,
          status: 'error',
          finishedAt,
          durationMs: finishedAt - startedAt,
          error: publicError,
        })
        const evidencePath = await writer.writeEvidence(
          `step-${String(step.seq)}/error.json`,
          failureEvidenceJson({
            stepId: step.stepId,
            ...(observation?.url === undefined ? {} : { url: observation.url }),
            error: publicError,
          }),
        )
        return { runId: baseRecord.runId, status: 'failed', failedStepId: step.stepId, error: publicError, evidencePath }
      }
    }

    void executed
    return { runId: baseRecord.runId, status: 'completed' }
  }

  /** 端口每次变化时用 baseUrl 覆盖 navigate 的源站，路径/查询/锚点保留。 */
  private applyBaseUrl(action: BrowserAction, baseUrl: string | undefined): BrowserAction {
    if (baseUrl === undefined || action.kind !== 'navigate') return action
    try {
      const original = new URL(action.url)
      const base = new URL(baseUrl)
      const next = new URL(`${original.pathname}${original.search}${original.hash}`, base)
      return { ...action, url: next.toString() }
    } catch {
      return action
    }
  }

  private materializeSecrets(step: ProjectedStep, values: Readonly<Record<string, string>>): BrowserAction {
    const action = step.action
    if (action.kind !== 'setValue') return action
    if (action.value !== '********' && action.secretRef === undefined) return action
    const value = values[step.stepId] ?? (action.secretRef === undefined ? undefined : values[action.secretRef])
    if (value === undefined || value.length === 0) {
      throw new ReplayServiceError('REPLAY_UNSUPPORTED_STEP', `setValue ${step.stepId} has no replay value`, {
        stepId: step.stepId,
      })
    }
    return { ...action, value }
  }

  private contextFor(principal: Principal, runId: RunId, seq: number, signal: AbortSignal): OperationContext {
    return {
      principal,
      callId: `${runId}:${String(seq)}`,
      origin: 'replay',
      signal,
    }
  }
}

function toReplayRun(record: RunRecord): ReplayRun {
  return {
    runId: record.runId,
    recordingId: record.recordingId,
    status: record.status,
    ...(record.currentStepId === undefined ? {} : { currentStepId: record.currentStepId }),
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.error === undefined ? {} : { error: record.error }),
    recordingSha256: record.recordingSha256,
    driverId: record.driver.id,
  }
}

/** 进程内 RunStore（测试与轻量嵌入用）；Fs RunStore 可在后续版本实现同一 SPI。 */
export class MemoryRunStore implements RunStore {
  private readonly records = new Map<RunId, RunRecord>()
  private readonly steps = new Map<RunId, StoreStepEvent[]>()
  private readonly evidence = new Map<RunId, Map<string, string>>()

  async create(record: RunRecord): Promise<RunWriter> {
    this.records.set(record.runId, record)
    this.steps.set(record.runId, [])
    this.evidence.set(record.runId, new Map())
    return new MemoryRunWriter(this, record)
  }

  async read(recordingId: RecordingId, runId: RunId): Promise<RunRecord> {
    const record = this.records.get(runId)
    if (record === undefined || record.recordingId !== recordingId) {
      throw new ReplayServiceError('RUN_NOT_FOUND', `unknown run ${runId}`, { recordingId, runId })
    }
    return record
  }

  async findRun(runId: RunId): Promise<RunRecord | undefined> {
    return this.records.get(runId)
  }

  async listRuns(recordingId: RecordingId): Promise<readonly RunRecord[]> {
    return [...this.records.values()].filter((record) => record.recordingId === recordingId)
  }

  async *readSteps(recordingId: RecordingId, runId: RunId): AsyncIterable<StoreStepEvent & { line: number }> {
    const record = await this.read(recordingId, runId)
    void record
    for (const [index, event] of (this.steps.get(runId) ?? []).entries()) {
      yield { ...event, line: index + 1 }
    }
  }

  async update(record: RunRecord): Promise<void> {
    this.records.set(record.runId, record)
  }

  async append(runId: RunId, event: StoreStepEvent): Promise<void> {
    const list = this.steps.get(runId) ?? []
    list.push(event)
    this.steps.set(runId, list)
  }

  async writeEvidence(runId: RunId, name: string, data: string): Promise<string> {
    const map = this.evidence.get(runId) ?? new Map()
    map.set(name, data)
    this.evidence.set(runId, map)
    return `runs/${runId}/evidence/${name}`
  }
}

class MemoryRunWriter implements RunWriter {
  constructor(
    private readonly store: MemoryRunStore,
    private record: RunRecord,
  ) {}

  get runId(): RunId { return this.record.runId }
  get recordingId(): RecordingId { return this.record.recordingId }

  async append(event: StoreStepEvent): Promise<void> {
    await this.store.append(this.record.runId, event)
  }

  async writeEvidence(name: string, data: Uint8Array | string): Promise<string> {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    return this.store.writeEvidence(this.record.runId, name, text)
  }

  async update(record: RunRecord): Promise<void> {
    this.record = record
    await this.store.update(record)
  }

  async finish(record: RunRecord): Promise<void> {
    this.record = record
    await this.store.update(record)
  }
}
