import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillServiceError } from '../../../src/skill/model.js'
import { FsSkillStore } from '../../../src/skill/store.js'
import { validDraft } from './fixtures.js'

async function storeFixture(): Promise<{ root: string; store: FsSkillStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-store-'))
  return { root, store: new FsSkillStore({ root }) }
}

describe('FsSkillStore', () => {
  it('writes drafts atomically, installs versions, and keeps old versions loadable', async () => {
    const { root, store } = await storeFixture()
    try {
      const draft = validDraft()
      const draftPath = await store.saveDraft(draft)
      expect(draftPath).toContain('_drafts/draft_example/SKILL.md')
      expect((await store.readDraft(draft.draftId)).draft.markdown).toContain('## Verification')

      await expect(store.install(draft.draftId, { confirmed: false })).rejects.toMatchObject({
        code: 'SKILL_NOT_CONFIRMED',
      })
      const first = await store.install(draft.draftId, { confirmed: true })
      expect(first.version).toBe(1)
      expect((await store.listInstalled()).map(skill => skill.version)).toEqual([1])

      // IF-3 幂等：同一 draftId 重复确认安装返回已安装版本，不重复递增。
      const reinstall = await store.install(draft.draftId, { confirmed: true })
      expect(reinstall.version).toBe(1)
      expect((await store.listInstalled()).map(skill => skill.version)).toEqual([1])

      // 同名但不同草案 → 版本递增，旧版本仍可读。
      await store.saveDraft(validDraft({ draftId: 'draft_second', recordingId: 'rec_second', recordingSha256: 'b'.repeat(64) }))
      const second = await store.install('draft_second', { confirmed: true })
      expect(second.version).toBe(2)
      expect((await store.load('example-form')).skill.version).toBe(2)
      expect((await store.load('example-form', 1)).skill.version).toBe(1)
      await expect(store.load('example-form', 99)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
      await expect(store.load('example-form', 0)).rejects.toMatchObject({ code: 'SKILL_INVALID' })
      await expect(store.load('missing-skill')).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate draft ids and path escapes', async () => {
    const { root, store } = await storeFixture()
    try {
      const draft = validDraft()
      await store.saveDraft(draft)
      await expect(store.saveDraft(draft)).rejects.toMatchObject({ code: 'SKILL_DRAFT_CONFLICT' })
      await expect(store.saveDraft(validDraft({ draftId: 'draft_escape', site: '../evil' }))).rejects.toBeInstanceOf(
        SkillServiceError,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
