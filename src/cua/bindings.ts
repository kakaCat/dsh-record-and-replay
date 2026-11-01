import type { JsonObject, OperationContext } from '../core/api.js'
import type { CuaToolResult } from './transport.js'
import {
  BrowserDriverError,
  type BrowserBinding,
  type Observation,
} from '../driver/api.js'
import { TargetMutex } from '../driver/mutex.js'

/** Narrow caller surface needed by the Cua adapter, so tests need no MCP process. */
export interface CuaToolCaller {
  callTool(name: string, args: JsonObject, context: OperationContext): Promise<CuaToolResult>
  /**
   * Native transports approve an existing-profile attach only for the exact
   * pid/window that is being bound; MCP transports have no such boundary.
   */
  armExistingProfileGrant?(grant: { readonly pid: number; readonly windowId: number }): void | Promise<void>
  clearExistingProfileGrant?(): void | Promise<void>
}

export interface CuaViewport {
  /** Tab viewport width in CSS pixels. */
  readonly width: number
  /** Tab viewport height in CSS pixels. */
  readonly height: number
}

export interface CuaBindingRecord {
  readonly binding: BrowserBinding
  readonly cuaSession: string
  readonly observation?: Observation
  /** Native tab count at the last bind/refresh, used to spot a new tab. */
  readonly tabCount?: number
  /** Cua binding route at bind time (`native_cdp_window`); a change means another target. */
  readonly bindingRoute?: string
  /**
   * Tab viewport measured once per binding from Cua's screenshot metadata.
   * Used to aim a no-target scroll at the viewport centre.
   */
  readonly viewport?: CuaViewport
}

/**
 * Owns the DSH-session-to-browser-window relationship.
 * It never treats a Cua session label as an authorization token.
 */
export class CuaSessionRegistry {
  private readonly records = new Map<string, CuaBindingRecord>()
  private readonly mutex = new TargetMutex()
  private sequence = 0

  reserve(sessionId: string, pid: number, windowId: number): void {
    this.mutex.acquire(TargetMutex.key(pid, windowId), sessionId)
  }

  releaseReservation(sessionId: string, pid: number, windowId: number): void {
    this.mutex.release(TargetMutex.key(pid, windowId), sessionId)
  }

  commit(record: CuaBindingRecord): void {
    const existing = this.records.get(record.binding.sessionId)
    if (existing !== undefined && existing.binding.id !== record.binding.id) {
      this.releaseReservation(
        existing.binding.sessionId,
        existing.binding.pid,
        existing.binding.windowId,
      )
    }
    this.records.set(record.binding.sessionId, record)
  }

  get(sessionId: string): CuaBindingRecord | undefined {
    return this.records.get(sessionId)
  }

  assertCurrent(binding: BrowserBinding): CuaBindingRecord {
    const record = this.records.get(binding.sessionId)
    if (record === undefined || record.binding.id !== binding.id) {
      throw new BrowserDriverError('BROWSER_BINDING_STALE', 'Browser binding is no longer owned by this session')
    }
    if (record.binding.generation !== binding.generation) {
      throw new BrowserDriverError('BROWSER_BINDING_STALE', 'Browser binding generation is stale')
    }
    this.mutex.assertOwned(TargetMutex.key(binding.pid, binding.windowId), binding.sessionId)
    return record
  }

  /**
   * A click can activate a new tab in the same window. Cua mints a fresh
   * session-scoped target id and tab ids for every bind-mode query, so both
   * handles must be replaced together from one response; mixing them yields
   * `browser_tab_not_found`.
   */
  retarget(
    binding: BrowserBinding,
    targetId: string,
    tabId: string,
    tabCount: number,
  ): CuaBindingRecord {
    const record = this.assertCurrent(binding)
    const next: CuaBindingRecord = {
      ...record,
      binding: { ...record.binding, targetId, tabId },
      tabCount,
    }
    this.records.set(binding.sessionId, next)
    return next
  }

  /** Remember the latest native tab count without switching tabs. */
  setTabCount(binding: BrowserBinding, tabCount: number): CuaBindingRecord {
    const record = this.assertCurrent(binding)
    const next: CuaBindingRecord = { ...record, tabCount }
    this.records.set(binding.sessionId, next)
    return next
  }

  /** Cache the tab viewport so later scrolls need no second screenshot. */
  setViewport(binding: BrowserBinding, viewport: CuaViewport): CuaBindingRecord {
    const record = this.assertCurrent(binding)
    const next: CuaBindingRecord = { ...record, viewport }
    this.records.set(binding.sessionId, next)
    return next
  }

  updateObservation(binding: BrowserBinding, observation: Observation): CuaBindingRecord {
    const record = this.assertCurrent(binding)
    const next: CuaBindingRecord = { ...record, observation }
    this.records.set(binding.sessionId, next)
    return next
  }

  clearObservation(binding: BrowserBinding): void {
    const record = this.assertCurrent(binding)
    const { observation: _observation, ...rest } = record
    this.records.set(binding.sessionId, rest)
  }

  detach(binding: BrowserBinding): void {
    const record = this.records.get(binding.sessionId)
    if (record === undefined || record.binding.id !== binding.id) return
    this.records.delete(binding.sessionId)
    this.releaseReservation(binding.sessionId, binding.pid, binding.windowId)
  }

  nextGeneration(): number {
    this.sequence += 1
    return this.sequence
  }

  bindingId(sessionId: string): string {
    return `binding-${sessionId}-${String(this.nextGeneration())}`
  }
}
