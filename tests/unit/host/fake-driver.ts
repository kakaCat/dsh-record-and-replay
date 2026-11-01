/**
 * 测试用 BrowserDriver（IF-2 的最小可用实现）。
 *
 * 只模拟 Host 层需要的行为：绑定所有权、观察代际、语义解析（唯一命中/缺失/歧义）、
 * 执行（可注入失败/可挂起用于取消测试）与释放；不涉及任何 Cua 协议。
 */
import type { BrowserAction, OperationContext, SemanticTarget } from '../../../src/core/api.js'
import {
  BrowserDriverError,
  type ActionResult,
  type BindBrowserInput,
  type BrowserBinding,
  type BrowserDriver,
  type DriverCapabilities,
  type Observation,
  type ObservationElement,
  type ResolvedTarget,
} from '../../../src/driver/api.js'

export interface FakeDriverOptions {
  readonly elements?: readonly ObservationElement[]
  readonly url?: string
}

export class FakeBrowserDriver implements BrowserDriver {
  readonly id = 'fake-driver'

  bindCalls = 0
  observeCalls = 0
  resolveCalls = 0
  releaseCalls = 0
  readonly executeCalls: BrowserAction[] = []

  /** 前 N 次 observe 抛 TARGET_STALE（模拟“动作未发送前”的观测过期）。 */
  staleObserveTimes = 0
  /** execute 抛出的错误（写动作失败；用于断言不会自动重试）。 */
  executeFailure: Error | undefined
  /** execute 挂起，直到 finishHold() 或 context.signal abort。 */
  holdExecute = false

  private readonly elements: readonly ObservationElement[]
  private readonly bindings = new Map<string, BrowserBinding>()
  /** Optional window title returned on bind; tests use it for private-browsing policy. */
  bindingTitle: string | undefined
  private generation = 0
  private observationSeq = 0
  private currentUrl: string
  private releaseHold: (() => void) | undefined

  constructor(options: FakeDriverOptions = {}) {
    this.elements = options.elements ?? [
      { ref: 'e0', role: 'button', name: 'Submit' },
      { ref: 'e1', role: 'textbox', name: 'Name' },
    ]
    this.currentUrl = options.url ?? 'https://example.test/form'
  }

  async capabilities(): Promise<DriverCapabilities> {
    return {
      actions: ['navigate', 'click', 'setValue', 'scroll', 'key', 'wait'],
      locators: ['role', 'name', 'text', 'url'],
      driverVersion: 'fake-1.0.0',
    }
  }

  async bind(input: BindBrowserInput, context: OperationContext): Promise<BrowserBinding> {
    if (input.launch === 'isolated') {
      throw new BrowserDriverError('ACTION_UNSUPPORTED', 'this fake driver does not launch isolated browsers')
    }
    this.bindCalls += 1
    const sessionId = context.principal.sessionId
    this.generation += 1
    const binding: BrowserBinding = {
      id: `binding-${sessionId}-${String(this.generation)}`,
      driverId: this.id,
      sessionId,
      pid: input.pid,
      windowId: input.windowId,
      ...(this.bindingTitle === undefined ? {} : { title: this.bindingTitle }),
      targetId: `target-${sessionId}`,
      tabId: `tab-${sessionId}`,
      generation: this.generation,
    }
    this.bindings.set(sessionId, binding)
    return binding
  }

  async observe(binding: BrowserBinding, _context: OperationContext): Promise<Observation> {
    this.observeCalls += 1
    this.assertCurrent(binding)
    if (this.staleObserveTimes > 0) {
      this.staleObserveTimes -= 1
      throw new BrowserDriverError('TARGET_STALE', 'observation is stale')
    }
    this.observationSeq += 1
    return {
      observationId: `obs-${String(this.observationSeq)}`,
      bindingGeneration: binding.generation,
      url: this.currentUrl,
      title: 'Fake page',
      elements: this.elements,
    }
  }

  async resolve(
    binding: BrowserBinding,
    target: SemanticTarget,
    observation: Observation,
  ): Promise<ResolvedTarget> {
    this.resolveCalls += 1
    this.assertCurrent(binding)
    if (observation.bindingGeneration !== binding.generation) {
      throw new BrowserDriverError('TARGET_STALE', 'observation generation is stale')
    }
    const matches = this.elements.filter(element => {
      if (target.role !== undefined && element.role !== target.role) return false
      if (target.name !== undefined && element.name !== target.name) return false
      if (target.text !== undefined && !`${element.name ?? ''} ${element.value ?? ''}`.includes(target.text)) {
        return false
      }
      return true
    })
    if (matches.length === 0) throw new BrowserDriverError('TARGET_NOT_FOUND', 'no element matched the semantic target')
    if (matches.length > 1) throw new BrowserDriverError('TARGET_AMBIGUOUS', 'more than one element matched')
    const element = matches[0]
    if (element === undefined) throw new BrowserDriverError('TARGET_NOT_FOUND', 'no element matched the semantic target')
    return {
      ref: element.ref,
      role: element.role,
      ...(element.name === undefined ? {} : { name: element.name }),
      observationId: observation.observationId,
    }
  }

  async execute(
    binding: BrowserBinding,
    action: BrowserAction,
    resolved: ResolvedTarget | undefined,
    context: OperationContext,
  ): Promise<ActionResult> {
    this.executeCalls.push(action)
    this.assertCurrent(binding)
    if ((action.kind === 'click' || action.kind === 'setValue') && resolved === undefined) {
      throw new BrowserDriverError('INVALID_ARGUMENT', 'a resolved semantic target is required')
    }
    if (this.holdExecute) {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        this.releaseHold = () => {
          if (settled) return
          settled = true
          resolve()
        }
        context.signal.addEventListener('abort', () => {
          if (settled) return
          settled = true
          reject(new BrowserDriverError('OPERATION_CANCELLED', 'execute was cancelled'))
        }, { once: true })
      })
    }
    if (this.executeFailure !== undefined) throw this.executeFailure
    if (action.kind === 'navigate') this.currentUrl = action.url
    return { status: 'ok', summary: `${action.kind} ok` }
  }

  /** 结束挂起的 execute（模拟动作在取消前完成）。 */
  finishHold(): void {
    this.releaseHold?.()
  }

  async release(binding: BrowserBinding): Promise<void> {
    this.releaseCalls += 1
    const current = this.bindings.get(binding.sessionId)
    if (current !== undefined && current.id === binding.id) this.bindings.delete(binding.sessionId)
  }

  private assertCurrent(binding: BrowserBinding): void {
    const current = this.bindings.get(binding.sessionId)
    if (current === undefined || current.id !== binding.id || current.generation !== binding.generation) {
      throw new BrowserDriverError('BROWSER_BINDING_STALE', 'binding is stale')
    }
  }
}
