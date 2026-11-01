import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SkillDraft } from '../../../src/skill/model.js'
import { reviewSkillDraft, SkillReviewService, summarizeSkillDraft } from '../../../src/skill/review.js'
import { FsSkillStore } from '../../../src/skill/store.js'
import { validDraft, validMarkdown } from './fixtures.js'

async function reviewFixture(): Promise<{ root: string; store: FsSkillStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-review-'))
  return { root, store: new FsSkillStore({ root }) }
}

/** 绕过 Store 的写入门禁，模拟磁盘上已存在但未通过校验的草案。 */
async function writeRawDraft(root: string, draft: SkillDraft): Promise<string> {
  const dir = join(root, '_drafts', draft.draftId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'draft.json'), `${JSON.stringify(draft, null, 2)}\n`, 'utf8')
  await writeFile(join(dir, 'SKILL.md'), draft.markdown, 'utf8')
  return join(dir, 'SKILL.md')
}

function markdownWithoutSection(section: string): string {
  const lines = validMarkdown().split('\n')
  const start = lines.findIndex(line => line.trim() === `## ${section}`)
  if (start < 0) throw new Error(`fixture has no section ${section}`)
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  if (end < 0) end = lines.length
  return lines.slice(0, start).concat(lines.slice(end)).join('\n')
}

function markdownWithEmptySection(section: string): string {
  const lines = validMarkdown().split('\n')
  const start = lines.findIndex(line => line.trim() === `## ${section}`)
  if (start < 0) throw new Error(`fixture has no section ${section}`)
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  if (end < 0) end = lines.length
  return lines.slice(0, start + 1).concat(['', '']).concat(lines.slice(end)).join('\n')
}

describe('reviewSkillDraft', () => {
  it('returns summary, ambiguities, provenance, verification and a passing pre-install validation', async () => {
    const { root, store } = await reviewFixture()
    try {
      const ambiguities = ['Step 2 target matched two elements in the source run.']
      const draft = validDraft({ ambiguities })
      await store.saveDraft(draft)

      const summary = await reviewSkillDraft(draft.draftId, { store })

      expect(summary.draftId).toBe('draft_example')
      expect(summary.draftPath).toContain('_drafts/draft_example/SKILL.md')
      expect(summary.recordingId).toBe('rec_example')
      expect(summary.recordingSha256).toBe('a'.repeat(64))
      expect(summary.site).toBe('example')
      expect(summary.flow).toBe('form')
      expect(summary.status).toBe('ready')
      expect(summary.createdAt).toBe('2026-10-30T00:00:00.000Z')
      expect(summary.summary).toBe('Submit the example form.')
      expect(summary.verification).toContain('Result contains `Submitted: <name>`.')
      expect(summary.ambiguities).toEqual(ambiguities)
      expect(summary.provenance).toEqual(['Source recording rec_example.'])
      expect(summary.validation.ok).toBe(true)
      expect(summary.validation.checks.map(check => check.check)).toEqual([
        'status',
        'required-sections',
        'verification',
        'secrets',
        'coordinates',
        'ambiguities',
      ])
      expect(summary.validation.checks.every(check => check.ok)).toBe(true)
      expect(summary.validation.issues).toEqual([])

      // 只读：草案文件未被改写，安装目录一个都没有。
      expect(await readFile(summary.draftPath, 'utf8')).toBe(draft.markdown)
      await expect(stat(join(root, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is reachable through the SkillReviewService facade without writing the install tree', async () => {
    const { root, store } = await reviewFixture()
    try {
      const draft = validDraft()
      await store.saveDraft(draft)
      const summary = await new SkillReviewService({ store }).review(draft.draftId)
      expect(summary.draftId).toBe(draft.draftId)
      expect(summary.validation.ok).toBe(true)
      await expect(stat(join(root, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns SKILL_DRAFT_NOT_FOUND when the draft does not exist', async () => {
    const { root, store } = await reviewFixture()
    try {
      await expect(reviewSkillDraft('draft_missing', { store })).rejects.toMatchObject({
        code: 'SKILL_DRAFT_NOT_FOUND',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed draft ids before touching the store', async () => {
    const { root, store } = await reviewFixture()
    try {
      await expect(reviewSkillDraft('../escape', { store })).rejects.toMatchObject({ code: 'SKILL_INVALID' })
      await expect(reviewSkillDraft('draft_', { store })).rejects.toMatchObject({ code: 'SKILL_INVALID' })
      await expect(reviewSkillDraft('', { store })).rejects.toMatchObject({ code: 'SKILL_INVALID' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns SKILL_INVALID when the Verification section is missing, without writing skills/', async () => {
    const { root, store } = await reviewFixture()
    try {
      const draft = validDraft({ markdown: markdownWithoutSection('Verification') })
      await writeRawDraft(root, draft)
      await expect(reviewSkillDraft(draft.draftId, { store })).rejects.toMatchObject({
        code: 'SKILL_INVALID',
        message: expect.stringContaining('Verification'),
      })
      await expect(stat(join(root, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns SKILL_INVALID when the Verification section is empty', async () => {
    const { root, store } = await reviewFixture()
    try {
      const draft = validDraft({ markdown: markdownWithEmptySection('Verification') })
      await writeRawDraft(root, draft)
      await expect(reviewSkillDraft(draft.draftId, { store })).rejects.toMatchObject({
        code: 'SKILL_INVALID',
        message: expect.stringContaining('Verification'),
      })
      await expect(stat(join(root, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns SKILL_INVALID when any other required section is missing', async () => {
    const { root, store } = await reviewFixture()
    try {
      const draft = validDraft({ markdown: markdownWithoutSection('Provenance') })
      await writeRawDraft(root, draft)
      await expect(reviewSkillDraft(draft.draftId, { store })).rejects.toMatchObject({
        code: 'SKILL_INVALID',
        message: expect.stringContaining('Provenance'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects drafts that are not ready', async () => {
    const { root, store } = await reviewFixture()
    try {
      const draft = validDraft({ status: 'evidence_insufficient' })
      await writeRawDraft(root, draft)
      await expect(reviewSkillDraft(draft.draftId, { store })).rejects.toMatchObject({
        code: 'SKILL_INVALID',
        message: expect.stringContaining('evidence_insufficient'),
      })
      await expect(stat(join(root, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('surfaces plaintext secrets as a blocking validation issue instead of writing install files', async () => {
    const { root, store } = await reviewFixture()
    try {
      const draft = validDraft({ markdown: `${validMarkdown()}\nPassword: hunter2\n` })
      await writeRawDraft(root, draft)
      const summary = await reviewSkillDraft(draft.draftId, { store })
      expect(summary.validation.ok).toBe(false)
      expect(summary.validation.issues.map(issue => issue.code)).toContain('SKILL_SECRET_DETECTED')
      expect(summary.validation.checks.find(check => check.check === 'secrets')?.ok).toBe(false)
      await expect(stat(join(root, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('surfaces coordinate-only drafts through both markdown and ambiguity checks', async () => {
    const { root, store } = await reviewFixture()
    try {
      const coordinateMarkdown = validDraft({ markdown: `${validMarkdown()}\n- x: 120\n` })
      await writeRawDraft(root, coordinateMarkdown)
      const markdownSummary = await reviewSkillDraft(coordinateMarkdown.draftId, { store })
      expect(markdownSummary.validation.ok).toBe(false)
      expect(markdownSummary.validation.issues.map(issue => issue.code)).toContain('SKILL_COORDINATE_ONLY')

      const ambiguous = validDraft({
        draftId: 'draft_coordinate',
        ambiguities: ['Step 2 only records coordinates; confirm a semantic locator.'],
      })
      await writeRawDraft(root, ambiguous)
      const ambiguitySummary = await reviewSkillDraft(ambiguous.draftId, { store })
      expect(ambiguitySummary.validation.ok).toBe(false)
      expect(ambiguitySummary.ambiguities).toEqual(ambiguous.ambiguities)
      expect(ambiguitySummary.validation.issues.map(issue => issue.code)).toContain('SKILL_COORDINATE_ONLY')
      expect(ambiguitySummary.validation.checks.find(check => check.check === 'ambiguities')?.ok).toBe(false)

      await expect(stat(join(root, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('summarizeSkillDraft works on an in-memory draft without any store', () => {
    const summary = summarizeSkillDraft(validDraft())
    expect(summary.draftPath).toBe('')
    expect(summary.summary).toBe('Submit the example form.')
    expect(summary.validation.ok).toBe(true)
  })
})
