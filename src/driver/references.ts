import type { SemanticTarget } from '../core/api.js'
import { BrowserDriverError, type BrowserBinding, type Observation, type ResolvedTarget } from './api.js'

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/**
 * Resolve semantic locators against one immutable observation and verify that
 * the observation still belongs to the current binding generation.
 */
export class ReferenceTable {
  private readonly current = new Map<string, Observation>()

  remember(binding: BrowserBinding, observation: Observation): void {
    this.current.set(binding.id, observation)
  }

  invalidate(binding: BrowserBinding): void {
    this.current.delete(binding.id)
  }

  forget(binding: BrowserBinding): void {
    this.current.delete(binding.id)
  }

  assertFresh(binding: BrowserBinding, observation: Observation): void {
    const active = this.current.get(binding.id)
    if (
      active === undefined
      || active.observationId !== observation.observationId
      || observation.bindingGeneration !== binding.generation
    ) {
      throw new BrowserDriverError('TARGET_STALE', 'Observation is stale; refresh the browser snapshot before resolving')
    }
  }

  resolve(binding: BrowserBinding, target: SemanticTarget, observation: Observation): ResolvedTarget {
    this.assertFresh(binding, observation)
    this.assertUrl(binding, target, observation)

    const hasCss = target.css !== undefined
    if (hasCss) {
      throw new BrowserDriverError('ACTION_UNSUPPORTED', 'CSS-only targets are not supported by the Cua semantic snapshot')
    }
    if (target.role === undefined && target.name === undefined && target.text === undefined) {
      throw new BrowserDriverError('TARGET_NOT_FOUND', 'Semantic target needs role, name or text in addition to URL')
    }

    const matches = observation.elements.filter(element => {
      if (target.role !== undefined && normalize(element.role) !== normalize(target.role)) return false
      if (target.name !== undefined && (element.name === undefined || element.name !== target.name)) return false
      if (target.text !== undefined) {
        const visible = `${element.name ?? ''} ${element.value ?? ''}`
        if (!visible.includes(target.text)) return false
      }
      return true
    })

    if (matches.length === 0) {
      throw new BrowserDriverError('TARGET_NOT_FOUND', 'No visible element matched the semantic target')
    }
    // Prefer elements the user can actually see: a duplicate below the fold is a
    // different control, and clicking it can be delivered without any visible effect.
    const visible = matches.filter(element => element.visibility === undefined || element.visibility === 'in_viewport')
    const pool = visible.length > 0 ? visible : matches
    if (target.index !== undefined) {
      if (!Number.isInteger(target.index) || target.index < 0) {
        throw new BrowserDriverError('INVALID_ARGUMENT', 'target.index must be a non-negative integer')
      }
      const picked = pool[target.index]
      if (picked === undefined) {
        throw new BrowserDriverError('TARGET_NOT_FOUND', `target.index ${String(target.index)} is out of range for ${String(pool.length)} visible matches`)
      }
      return {
        ref: picked.ref,
        role: picked.role,
        ...(picked.name === undefined ? {} : { name: picked.name }),
        observationId: observation.observationId,
      }
    }
    if (pool.length > 1) {
      throw new BrowserDriverError('TARGET_AMBIGUOUS', `Semantic target matched ${String(pool.length)} visible elements; add target.index to disambiguate`)
    }

    const element = pool[0]
    if (element === undefined) {
      throw new BrowserDriverError('TARGET_NOT_FOUND', 'No visible element matched the semantic target')
    }
    return {
      ref: element.ref,
      role: element.role,
      ...(element.name === undefined ? {} : { name: element.name }),
      observationId: observation.observationId,
    }
  }

  private assertUrl(binding: BrowserBinding, target: SemanticTarget, observation: Observation): void {
    if (target.url === undefined) {
      this.assertGeneration(binding)
      return
    }

    let current: URL
    try {
      current = new URL(observation.url)
    } catch {
      throw new BrowserDriverError('TARGET_NOT_FOUND', 'Current browser URL is not a valid URL')
    }
    if (target.url.origin !== undefined && current.origin !== target.url.origin) {
      throw new BrowserDriverError('TARGET_NOT_FOUND', 'Current browser origin does not match the semantic target')
    }
    if (target.url.path !== undefined && current.pathname !== target.url.path) {
      throw new BrowserDriverError('TARGET_NOT_FOUND', 'Current browser path does not match the semantic target')
    }
    this.assertGeneration(binding)
  }

  private assertGeneration(binding: BrowserBinding): void {
    const active = this.current.get(binding.id)
    if (active === undefined) {
      throw new BrowserDriverError('TARGET_STALE', 'Binding has no active observation')
    }
  }
}
