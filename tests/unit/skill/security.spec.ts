import { describe, expect, it } from 'vitest'
import { SkillServiceError } from '../../../src/skill/model.js'
import {
  assertSafeSkillDraft,
  inspectSkillMarkdown,
} from '../../../src/skill/security.js'
import { validDraft, validMarkdown } from './fixtures.js'

describe('Skill security', () => {
  it('accepts a safe draft', () => {
    expect(inspectSkillMarkdown(validMarkdown())).toEqual([])
  })

  it('rejects plaintext secrets and redaction masks', () => {
    const secret = validMarkdown().replace('Submit the example form.', 'password: hunter2')
    expect(inspectSkillMarkdown(secret).map(issue => issue.code)).toContain('SKILL_SECRET_DETECTED')
    const mask = validMarkdown().replace('Submit the example form.', 'value: ********')
    expect(inspectSkillMarkdown(mask).map(issue => issue.code)).toContain('SKILL_SECRET_DETECTED')
  })

  it('rejects plaintext secrets even when an earlier value is a placeholder', () => {
    const mixed = validMarkdown().replace(
      'Submit the example form.',
      'token: {{API_TOKEN}}\npassword: hunter2',
    )
    expect(inspectSkillMarkdown(mixed).map(issue => issue.code)).toContain('SKILL_SECRET_DETECTED')
  })

  it('accepts value placeholders as secret substitutes', () => {
    const placeholder = validMarkdown().replace(
      'Submit the example form.',
      'token: {{API_TOKEN}}',
    )
    expect(inspectSkillMarkdown(placeholder).map(issue => issue.code)).not.toContain('SKILL_SECRET_DETECTED')
  })

  it('rejects coordinate-only steps', () => {
    const coordinate = validMarkdown().replace('3. Activate Submit.', '3. Click at x=120, y=240.')
    expect(inspectSkillMarkdown(coordinate).map(issue => issue.code)).toContain('SKILL_COORDINATE_ONLY')
  })

  it('rejects parenthesized and bracketed coordinate targets', () => {
    const parenthesized = validMarkdown().replace('3. Activate Submit.', '3. Click at (120, 240).')
    expect(inspectSkillMarkdown(parenthesized).map(issue => issue.code)).toContain('SKILL_COORDINATE_ONLY')
    const bracketed = validMarkdown().replace('3. Activate Submit.', '3. Click at [120,240].')
    expect(inspectSkillMarkdown(bracketed).map(issue => issue.code)).toContain('SKILL_COORDINATE_ONLY')
  })

  it('rejects missing or empty Verification', () => {
    const missing = validMarkdown().replace(/## Verification[\s\S]*?(?=## Ambiguities)/, '')
    expect(inspectSkillMarkdown(missing).map(issue => issue.code)).toContain('SKILL_INVALID')
    const empty = validMarkdown().replace(/## Verification\n\n- Result contains `Submitted: <name>`\./, '## Verification\n\n')
    expect(inspectSkillMarkdown(empty).map(issue => issue.code)).toContain('SKILL_INVALID')
  })

  it('rejects a non-ready draft', () => {
    expect(() => assertSafeSkillDraft(validDraft({ status: 'evidence_insufficient' }))).toThrow(SkillServiceError)
  })
})
