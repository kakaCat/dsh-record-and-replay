import { describe, expect, it } from 'vitest'

import {
  SKILL_PROMPTS,
  buildDraftPrompt,
  parseDraftEnrichment,
  skillPromptById,
} from '../../../src/skill/drafting.js'

describe('skill drafting prompts', () => {
  it('keeps the five reference prompt identifiers', () => {
    expect(SKILL_PROMPTS.map(prompt => prompt.id)).toEqual([
      'describe-activity',
      'suggest-next-actions',
      'draft-memory',
      'draft-replay-plan',
      'create-replay-skill',
    ])
    expect(skillPromptById('draft-replay-plan').title).toBe('Draft Replay Plan')
    expect(() => skillPromptById('missing')).toThrow(/unknown Skill prompt/)
  })

  it('builds a strict JSON prompt from the deterministic steps', () => {
    const prompt = buildDraftPrompt({
      title: 'Checkout',
      site: 'shop',
      steps: ['Navigate to `https://shop.test/`.', 'Activate button "Pay".'],
      suppressedStepCount: 2,
    })
    expect(prompt.system).toContain('Return one JSON object only')
    expect(prompt.prompt).toContain('1. Navigate to `https://shop.test/`.')
    expect(prompt.prompt).toContain('2 step(s) were suppressed')
    expect(prompt.prompt).toContain('"summary"')
  })

  it('parses fenced JSON and drops unusable fields', () => {
    const parsed = parseDraftEnrichment('```json\n{"summary":"ok","preconditions":["a",42,""],"ambiguities":["b"]}\n```')
    expect(parsed).toEqual({
      summary: 'ok',
      preconditions: ['a'],
      ambiguities: ['b'],
    })
    expect(parseDraftEnrichment('not json')).toBeUndefined()
    expect(parseDraftEnrichment('{"summary": 42}')).toEqual({})
  })
})
