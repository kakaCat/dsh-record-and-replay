import {
  SCHEMA_VERSION,
  newRecordingId,
  type BrowserAction,
  type OperationContext,
  type Principal,
  type RecordingId,
  type StepId,
} from '../core/api.js'
import {
  BrowserDriverError,
  type BindBrowserInput,
  type BrowserBinding,
  type BrowserDriver,
  type DriverCapabilities,
  type Observation,
  type ResolvedTarget,
} from '../driver/api.js'

export interface FakeBrowserDriverOptions {
  readonly id?: string
  readonly actions?: readonly BrowserAction['kind'][]
  readonly missingButton?: boolean
}

/** 无浏览器依赖的 BrowserDriver 样例，供 conformance 与第三方扩展测试使用。 */
export class FakeBrowserDriver implements BrowserDriver {
  readonly id: string
  readonly actions: readonly BrowserAction['kind'][]
  missingButton: boolean
  private sequence = 0
  private readonly pages = new Map<string, { url: string; clicked: number; values: string[] }>()

  constructor(options: FakeBrowserDriverOptions = {}) {
    this.id = options.id ?? 'com.example.fake-browser-driver'
    this.actions = options.actions ?? ['navigate', 'click', 'setValue']
    this.missingButton = options.missingButton ?? false
  }

  async capabilities(): Promise<DriverCapabilities> {
    return { actions: this.actions, locators: ['role', 'name', 'text', 'url'], driverVersion: '0.38.0' }
  }

  async bind(input: BindBrowserInput, context: OperationContext): Promise<BrowserBinding> {
    if (input.launch === 'isolated') {
      throw new BrowserDriverError('ACTION_UNSUPPORTED', 'this fake driver does not launch isolated browsers')
    }
    if (input.pid <= 0 || input.windowId <= 0) {
      throw new BrowserDriverError('INVALID_ARGUMENT', 'pid and windowId must be positive integers')
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

  async observe(binding: BrowserBinding, _context?: OperationContext): Promise<Observation> {
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

  async execute(
    binding: BrowserBinding,
    action: BrowserAction,
    _resolved?: unknown,
    _context?: OperationContext,
  ): Promise<{ status: 'ok' }> {
    const page = this.ensure(binding)
    if (action.kind === 'navigate') page.url = action.url
    else if (action.kind === 'click') page.clicked += 1
    else if (action.kind === 'setValue') page.values.push(action.value)
    else throw new BrowserDriverError('ACTION_UNSUPPORTED', `${action.kind} is unsupported`)
    return { status: 'ok' }
  }

  async release(_binding?: BrowserBinding, _context?: OperationContext): Promise<void> {}
}

export function fakePrincipal(sessionId = 'session-fake-driver'): Principal {
  return { sessionId, agentId: 'agent-fake-driver' }
}

export function fakeOperationContext(sessionId = 'session-fake-driver'): OperationContext {
  return { principal: fakePrincipal(sessionId), callId: 'call-fake-driver', origin: 'internal', signal: new AbortController().signal }
}

export function fakeRecordingId(): RecordingId {
  return newRecordingId()
}

export function fakeStepId(prefix = 'step_fake'): StepId {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}` as StepId
}

export { SCHEMA_VERSION }
