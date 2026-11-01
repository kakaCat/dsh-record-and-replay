import type { SkillDraft } from '../../../src/skill/model.js'

export function validMarkdown(): string {
  return [
    '# Skill: Example Form',
    '',
    '## Summary',
    '',
    'Submit the example form.',
    '',
    '## Preconditions',
    '',
    '- Chrome is available.',
    '',
    '## Inputs',
    '',
    '- `name`: string, required.',
    '',
    '## Semantic targets',
    '',
    '- Submit: role=button, name=Submit.',
    '',
    '## Steps',
    '',
    '1. Navigate to the form.',
    '2. Enter `name`.',
    '3. Activate Submit.',
    '',
    '## Verification',
    '',
    '- Result contains `Submitted: <name>`.',
    '',
    '## Ambiguities',
    '',
    '- None.',
    '',
    '## Provenance',
    '',
    '- Source recording rec_example.',
    '',
  ].join('\n')
}

export function validDraft(overrides: Partial<SkillDraft> = {}): SkillDraft {
  return {
    draftId: 'draft_example',
    recordingId: 'rec_example',
    recordingSha256: 'a'.repeat(64),
    site: 'example',
    flow: 'form',
    markdown: validMarkdown(),
    ambiguities: [],
    status: 'ready',
    createdAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  }
}
