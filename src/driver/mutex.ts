import { BrowserDriverError } from './api.js'

/**
 * Cooperative one-writer-per-native-window lock.
 *
 * Scope is pid + native window, not a Cua target id: target ids are scoped to a
 * Cua session and cannot prove that two DSH sessions point at the same window.
 * Rejecting a second owner is safer than serializing unknown browser state.
 */
export class TargetMutex {
  private readonly owners = new Map<string, string>()

  static key(pid: number, windowId: number): string {
    return `${String(pid)}:${String(windowId)}`
  }

  acquire(key: string, ownerSessionId: string): void {
    const current = this.owners.get(key)
    if (current !== undefined && current !== ownerSessionId) {
      throw new BrowserDriverError('BROWSER_TARGET_BUSY', 'Browser window is already owned by another DSH session')
    }
    this.owners.set(key, ownerSessionId)
  }

  assertOwned(key: string, ownerSessionId: string): void {
    if (this.owners.get(key) !== ownerSessionId) {
      throw new BrowserDriverError('BROWSER_BINDING_STALE', 'Browser binding is not owned by this session')
    }
  }

  release(key: string, ownerSessionId: string): void {
    if (this.owners.get(key) === ownerSessionId) this.owners.delete(key)
  }

  ownerOf(key: string): string | undefined {
    return this.owners.get(key)
  }
}
