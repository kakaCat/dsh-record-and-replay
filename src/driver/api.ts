import type {
  BrowserAction,
  BrowserActionKind,
  ErrorCode,
  OperationContext,
  SemanticTarget,
} from '../core/api.js'
import type {
  DesktopLaunchMode,
  ExistingLaunchMode,
  IsolatedLaunchMode,
  LaunchMode,
} from '../core/contracts.js'

/** Public driver capability declaration; implementations must fail loudly for gaps. */
export interface DriverCapabilities {
  readonly actions: readonly BrowserActionKind[]
  readonly locators: readonly ('role' | 'name' | 'text' | 'css' | 'url')[]
  readonly driverVersion: string
}

/**
 * `existing` (default) attaches to the user's running browser window and needs
 * pid/windowId. `isolated` asks the driver to launch a disposable,
 * driver-owned Chromium and binds to it; no user profile is touched.
 */
export type BindBrowserInput =
  | { readonly launch?: ExistingLaunchMode; readonly pid: number; readonly windowId: number }
  | {
    readonly launch: IsolatedLaunchMode
    readonly pid?: number
    readonly windowId?: number
    /** Reuse a named driver-owned profile so cookies/logins persist across runs. */
    readonly profileName?: string
  }
  | { readonly launch: DesktopLaunchMode; readonly pid: number; readonly windowId: number }

/** A run-time browser binding. Driver-private handles must stay in the implementation. */
export interface BrowserBinding {
  readonly id: string
  readonly driverId: string
  readonly sessionId: string
  readonly pid: number
  readonly windowId: number
  /** 当前窗口/标签标题（Cua bind 时可得）；仅用于私密浏览识别，不进公共 DTO。 */
  readonly title?: string
  readonly targetId: string
  readonly tabId: string
  readonly generation: number
}

export interface ObservationElement {
  readonly ref: string
  readonly role: string
  readonly name?: string
  readonly value?: string
  readonly actions?: readonly string[]
  /** Driver visibility hint, e.g. Cua's "in_viewport" / "offscreen". */
  readonly visibility?: string
  /**
   * Stable signature of the element's exposed boolean states (focused,
   * checked, expanded, ...). Lets a click that only moves focus or toggles a
   * control count as an observable change.
   */
  readonly stateSignature?: string
}

export interface Observation {
  readonly observationId: string
  readonly bindingGeneration: number
  readonly url: string
  readonly title?: string
  readonly elements: readonly ObservationElement[]
}

export interface ResolvedTarget {
  readonly ref: string
  readonly role: string
  readonly name?: string
  readonly observationId: string
}

export interface ActionResult {
  readonly status: 'ok'
  readonly summary?: string
  readonly evidence?: Readonly<Record<string, string>>
}

export class BrowserDriverError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BrowserDriverError'
    this.code = code
  }
}

/**
 * BrowserDriver is the only semantic browser boundary.
 * Implementations own target lifetime and must never expose vendor handles.
 */
export interface BrowserDriver {
  readonly id: string

  /** `launch` lets a driver advertise different actions per binding kind. */
  capabilities(launch?: LaunchMode): Promise<DriverCapabilities>

  bind(input: BindBrowserInput, context: OperationContext): Promise<BrowserBinding>

  observe(binding: BrowserBinding, context: OperationContext): Promise<Observation>

  resolve(
    binding: BrowserBinding,
    target: SemanticTarget,
    observation: Observation,
  ): Promise<ResolvedTarget>

  execute(
    binding: BrowserBinding,
    action: BrowserAction,
    resolved: ResolvedTarget | undefined,
    context: OperationContext,
  ): Promise<ActionResult>

  release(binding: BrowserBinding): Promise<void>
}
