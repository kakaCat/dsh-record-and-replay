import { describe, expect, it } from 'vitest'
import { ReferenceTable } from '../../../src/driver/references.js'
import type { BrowserBinding, Observation } from '../../../src/driver/api.js'

const binding: BrowserBinding = {
  id: 'binding-test',
  driverId: 'cua-driver',
  sessionId: 'session-test',
  pid: 100,
  windowId: 10,
  targetId: 'bt-test',
  tabId: 'tab-test',
  generation: 1,
}

function observation(): Observation {
  return {
    observationId: 'obs-1',
    bindingGeneration: 1,
    url: 'https://example.test/',
    elements: [
      { ref: 'p1:0', role: 'button', name: 'Add to cart' },
      { ref: 'p1:1', role: 'button', name: 'Add to cart' },
      { ref: 'p1:2', role: 'button', name: 'Back to products' },
    ],
  }
}

function table() {
  const references = new ReferenceTable()
  const snapshot = observation()
  references.remember(binding, snapshot)
  return { references, snapshot }
}

describe('driver/references', () => {
  it('reports ambiguity with a disambiguation hint', () => {
    const { references, snapshot } = table()
    expect(() => references.resolve(binding, { role: 'button', name: 'Add to cart' }, snapshot))
      .toThrowError(/matched 2 visible elements; add target\.index/)
  })

  it('picks the Nth match when target.index is supplied', () => {
    const { references, snapshot } = table()
    expect(references.resolve(binding, { role: 'button', name: 'Add to cart', index: 1 }, snapshot))
      .toMatchObject({ ref: 'p1:1', role: 'button', name: 'Add to cart' })
  })


  it('skips offscreen duplicates and indexes the visible ones', () => {
    const references = new ReferenceTable()
    const snapshot: Observation = {
      observationId: 'obs-2',
      bindingGeneration: 1,
      url: 'https://example.test/',
      elements: [
        { ref: 'p2:0', role: 'button', name: 'Add to cart', visibility: 'offscreen' },
        { ref: 'p2:1', role: 'button', name: 'Add to cart', visibility: 'in_viewport' },
        { ref: 'p2:2', role: 'button', name: 'Add to cart', visibility: 'in_viewport' },
      ],
    }
    references.remember(binding, snapshot)

    // Two visible matches remain ambiguous without an index.
    expect(() => references.resolve(binding, { role: 'button', name: 'Add to cart' }, snapshot))
      .toThrowError(/matched 2 visible elements/)
    expect(references.resolve(binding, { role: 'button', name: 'Add to cart', index: 1 }, snapshot))
      .toMatchObject({ ref: 'p2:2' })
    expect(() => references.resolve(binding, { role: 'button', name: 'Add to cart', index: 2 }, snapshot))
      .toThrowError(/out of range for 2 visible matches/)
  })

  it('falls back to offscreen matches when nothing is visible', () => {
    const references = new ReferenceTable()
    const snapshot: Observation = {
      observationId: 'obs-3',
      bindingGeneration: 1,
      url: 'https://example.test/',
      elements: [
        { ref: 'p3:0', role: 'button', name: 'Add to cart', visibility: 'offscreen' },
      ],
    }
    references.remember(binding, snapshot)
    expect(references.resolve(binding, { role: 'button', name: 'Add to cart', index: 0 }, snapshot))
      .toMatchObject({ ref: 'p3:0' })
  })

  it('rejects an out-of-range or negative index', () => {
    const { references, snapshot } = table()
    expect(() => references.resolve(binding, { role: 'button', name: 'Add to cart', index: 5 }, snapshot))
      .toThrowError(/out of range/)
    expect(() => references.resolve(binding, { role: 'button', name: 'Add to cart', index: -1 }, snapshot))
      .toThrowError(/non-negative integer/)
  })
})
