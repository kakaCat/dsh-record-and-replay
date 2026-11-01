import { describe, expect, it } from 'vitest'
import {
  SkillServiceError,
  assertSkillDraftShape,
  assertSkillName,
  hasRequiredSkillSections,
  missingSkillSections,
  skillNameFor,
} from '../../../src/skill/model.js'
import { validDraft, validMarkdown } from './fixtures.js'

describe('Skill model', () => {
  it('derives kebab-case skill names and validates names', () => {
    expect(skillNameFor('Example.Test', 'Form Submit')).toBe('example-test-form-submit')
    expect(assertSkillName('example-form')).toBe('example-form')
    expect(() => assertSkillName('Bad Name')).toThrow(SkillServiceError)
  })

  it('requires all eight sections and reports missing ones', () => {
    expect(hasRequiredSkillSections(validMarkdown())).toBe(true)
    const missing = validMarkdown().replace(/## Verification[\s\S]*?(?=## Ambiguities)/, '')
    expect(hasRequiredSkillSections(missing)).toBe(false)
    expect(missingSkillSections(missing)).toContain('Verification')
  })

  it('validates draft shape fields from the data model', () => {
    expect(() => assertSkillDraftShape(validDraft())).not.toThrow()
    expect(() => assertSkillDraftShape(validDraft({ draftId: 'DRAFT-1' }))).toThrow(SkillServiceError)
    expect(() => assertSkillDraftShape(validDraft({ recordingSha256: 'not-a-hash' }))).toThrow(SkillServiceError)
    expect(() => assertSkillDraftShape(validDraft({ createdAt: 'yesterday' }))).toThrow(SkillServiceError)
  })

  it('exposes a stable service error code', () => {
    try {
      assertSkillName('Bad Name')
      throw new Error('expected assertSkillName to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SkillServiceError)
      expect((error as SkillServiceError).code).toBe('SKILL_INVALID')
    }
  })
})
