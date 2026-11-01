/**
 * IF-3 安装集成测试（design/test-cases.md TC-3、TC-4；decomposition t4）。
 *
 * 覆盖：
 * - 未确认/拒绝 → `SKILL_NOT_CONFIRMED` 且 `skills/` 一个文件都不写（TC-3）；
 * - 确认后临时文件 + 原子 rename，v1 落盘且来源/frontmatter 完整；
 * - 同名不同草案版本递增，旧版本仍可读；
 * - 同一 draftId 重复确认安装幂等，不重复递增版本；
 * - 同名并发安装一个成功、一个 `SKILL_VERSION_CONFLICT`，v1 不被覆盖（TC-4）；
 * - 目标版本槽位已被占用（版本目录原子预留）同样返回 `SKILL_VERSION_CONFLICT`；
 * - 质量门禁：缺 Verification / 非 ready / 秘密 在写入前被拦；
 * - `SkillReviewService.install` 门面可用。
 *
 * 测试只写系统临时目录，不触碰仓库内文件或真实 Skill 目录。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InstalledSkill } from '../../src/skill/model.js'
import { installSkillDraft, reviewSkillDraft, SkillReviewService } from '../../src/skill/review.js'
import { FsSkillStore } from '../../src/skill/store.js'
import { validDraft, validMarkdown } from '../unit/skill/fixtures.js'

const SITE = 'example'
const FLOW = 'form'
const SKILL_NAME = 'example-form'

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-skill-install-'))
}

function skillDir(root: string): string {
  return join(root, 'skills', SITE, FLOW)
}

function versionFile(root: string, version: number): string {
  return join(skillDir(root), 'versions', `v${String(version)}`, 'SKILL.md')
}

/** 列出 `skills/` 下残留的临时文件（原子写必须把它们全部 rename 掉）。 */
async function tempArtifacts(root: string): Promise<readonly string[]> {
  const entries = await readdir(join(root, 'skills'), { recursive: true }).catch(() => [] as string[])
  return entries.filter(entry => entry.includes('.tmp-'))
}

async function skillsTreeExists(root: string): Promise<boolean> {
  return stat(join(root, 'skills')).then(
    () => true,
    () => false,
  )
}

/** 绕过 Store 的写入门禁，模拟磁盘上已存在但未通过校验的草案。 */
async function writeRawDraft(root: string, draft: ReturnType<typeof validDraft>): Promise<void> {
  const dir = join(root, '_drafts', draft.draftId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'draft.json'), `${JSON.stringify(draft, null, 2)}\n`, 'utf8')
  await writeFile(join(dir, 'SKILL.md'), draft.markdown, 'utf8')
}

function secondDraft(): ReturnType<typeof validDraft> {
  return validDraft({
    draftId: 'draft_second',
    recordingId: 'rec_second',
    recordingSha256: 'b'.repeat(64),
  })
}

function thirdDraft(): ReturnType<typeof validDraft> {
  return validDraft({
    draftId: 'draft_third',
    recordingId: 'rec_third',
    recordingSha256: 'c'.repeat(64),
  })
}

describe('installSkillDraft (IF-3)', () => {
  it('refuses unconfirmed or rejected installs without writing skills/ (TC-3)', async () => {
    const root = await makeRoot()
    const store = new FsSkillStore({ root })
    try {
      const draft = validDraft()
      await store.saveDraft(draft)

      await expect(store.install(draft.draftId, { confirmed: false })).rejects.toMatchObject({
        code: 'SKILL_NOT_CONFIRMED',
      })
      await expect(
        installSkillDraft({ draftId: draft.draftId, decision: 'rejected' }, { store }),
      ).rejects.toMatchObject({ code: 'SKILL_NOT_CONFIRMED' })
      expect(await skillsTreeExists(root)).toBe(false)

      // 草案原样保留，审查者可以继续审查/确认。
      expect((await store.readDraft(draft.draftId)).draft.markdown).toContain('## Verification')
      expect((await reviewSkillDraft(draft.draftId, { store })).validation.ok).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('installs a confirmed draft as v1 with atomic rename and provenance frontmatter', async () => {
    const root = await makeRoot()
    const store = new FsSkillStore({ root })
    try {
      const draft = validDraft()
      await store.saveDraft(draft)

      const installed = await installSkillDraft({ draftId: draft.draftId, decision: 'confirmed' }, { store })

      expect(installed.name).toBe(SKILL_NAME)
      expect(installed.version).toBe(1)
      expect(installed.site).toBe(SITE)
      expect(installed.flow).toBe(FLOW)
      expect(installed.sourceRecordings).toEqual([{ recordingId: 'rec_example', sha256: draft.recordingSha256 }])
      expect(installed.status).toBe('active')
      expect(installed.path).toBe(join(skillDir(root), 'SKILL.md'))

      const active = await readFile(installed.path, 'utf8')
      expect(active).toContain('name: "example-form"')
      expect(active).toContain('version: 1')
      expect(active).toContain('rec_example')
      expect(active).toContain(draft.recordingSha256)
      expect(active).toContain('## Verification')
      expect(active).toContain('Submit the example form.')

      // 版本副本与 active 一致；临时文件全部 rename 完毕。
      expect(await readFile(versionFile(root, 1), 'utf8')).toBe(active)
      expect(await tempArtifacts(root)).toEqual([])

      // 安装走 Store 写入；审查仍只读。
      const summary = await reviewSkillDraft(draft.draftId, { store })
      expect(summary.validation.ok).toBe(true)
      expect(await readFile(summary.draftPath, 'utf8')).toBe(draft.markdown)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('increments versions for same-name installs and keeps old versions loadable', async () => {
    const root = await makeRoot()
    const store = new FsSkillStore({ root })
    try {
      await store.saveDraft(validDraft())
      await store.saveDraft(secondDraft())

      const first = await installSkillDraft({ draftId: 'draft_example', decision: 'confirmed' }, { store })
      const second = await installSkillDraft({ draftId: 'draft_second', decision: 'confirmed' }, { store })
      expect(first.version).toBe(1)
      expect(second.version).toBe(2)

      const active = await store.load(SKILL_NAME)
      expect(active.skill.version).toBe(2)
      const loadedV1 = await store.load(SKILL_NAME, 1)
      expect(loadedV1.skill.version).toBe(1)
      expect(loadedV1.skill.sourceRecordings[0]?.recordingId).toBe('rec_example')
      expect(loadedV1.markdown).toContain('Submit the example form.')

      // 两个版本都在盘上，且内容各自带自己的来源（旧版本没有被覆盖）。
      expect(await readFile(versionFile(root, 1), 'utf8')).toContain('rec_example')
      expect(await readFile(versionFile(root, 2), 'utf8')).toContain('rec_second')
      expect(await readFile(versionFile(root, 1), 'utf8')).not.toBe(await readFile(versionFile(root, 2), 'utf8'))
      expect(await tempArtifacts(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns the existing version when the same draft is confirmed twice (IF-3 idempotency)', async () => {
    const root = await makeRoot()
    const store = new FsSkillStore({ root })
    try {
      await store.saveDraft(validDraft())

      const first = await installSkillDraft({ draftId: 'draft_example', decision: 'confirmed' }, { store })
      const again = await installSkillDraft({ draftId: 'draft_example', decision: 'confirmed' }, { store })

      expect(first.version).toBe(1)
      expect(again.version).toBe(1)
      expect((await store.load(SKILL_NAME)).skill.version).toBe(1)
      expect(await readdir(join(skillDir(root), 'versions'))).toEqual(['v1'])
      expect(await tempArtifacts(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets exactly one concurrent same-name install win; the other returns SKILL_VERSION_CONFLICT (TC-4)', async () => {
    const root = await makeRoot()
    const store = new FsSkillStore({ root })
    try {
      await store.saveDraft(validDraft())
      await store.saveDraft(secondDraft())
      await store.saveDraft(thirdDraft())
      const installedV1 = await installSkillDraft({ draftId: 'draft_example', decision: 'confirmed' }, { store })
      expect(installedV1.version).toBe(1)

      // 两个独立 Store 实例模拟两个进程/会话同时安装各自的「v2」草案。
      const processA = new FsSkillStore({ root })
      const processB = new FsSkillStore({ root })
      const results = await Promise.allSettled([
        processA.install('draft_second', { confirmed: true }),
        processB.install('draft_third', { confirmed: true }),
      ])

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<InstalledSkill> => result.status === 'fulfilled',
      )
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toMatchObject({ code: 'SKILL_VERSION_CONFLICT' })
      expect(fulfilled[0]?.value.version).toBe(2)

      // 旧版本仍可读，没有被并发安装覆盖。
      expect((await store.load(SKILL_NAME, 1)).skill.version).toBe(1)
      expect(await readFile(versionFile(root, 1), 'utf8')).toContain('rec_example')
      expect((await store.load(SKILL_NAME)).skill.version).toBe(2)
      expect((await readdir(join(skillDir(root), 'versions'))).sort()).toEqual(['v1', 'v2'])
      expect(await tempArtifacts(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns SKILL_VERSION_CONFLICT when the target version slot is already taken', async () => {
    const root = await makeRoot()
    const store = new FsSkillStore({ root })
    try {
      await store.saveDraft(validDraft())
      await store.saveDraft(secondDraft())
      await installSkillDraft({ draftId: 'draft_example', decision: 'confirmed' }, { store })
      // 版本目录的原子预留：槽位已存在即冲突，绝不覆盖。
      await mkdir(join(skillDir(root), 'versions', 'v2'), { recursive: true })

      await expect(store.install('draft_second', { confirmed: true })).rejects.toMatchObject({
        code: 'SKILL_VERSION_CONFLICT',
      })
      expect((await store.load(SKILL_NAME)).skill.version).toBe(1)
      expect((await store.load(SKILL_NAME, 1)).skill.version).toBe(1)
      expect(await tempArtifacts(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks installs that fail the review quality gate, writing nothing', async () => {
    const cases: ReadonlyArray<{
      readonly name: string
      readonly draft: ReturnType<typeof validDraft>
      readonly code: string
    }> = [
      {
        name: 'missing Verification',
        draft: validDraft({ markdown: validMarkdown().replace('## Verification', '## Not-Veification') }),
        code: 'SKILL_INVALID',
      },
      {
        name: 'plaintext secret',
        draft: validDraft({ markdown: `${validMarkdown()}\nPassword: hunter2\n` }),
        code: 'SKILL_SECRET_DETECTED',
      },
      {
        name: 'not ready draft',
        draft: validDraft({ draftId: 'draft_not_ready', status: 'evidence_insufficient' }),
        code: 'SKILL_INVALID',
      },
    ]
    for (const testCase of cases) {
      const root = await makeRoot()
      const store = new FsSkillStore({ root })
      try {
        await writeRawDraft(root, testCase.draft)
        await expect(
          installSkillDraft({ draftId: testCase.draft.draftId, decision: 'confirmed' }, { store }),
        ).rejects.toMatchObject({ code: testCase.code })
        // Store 门禁兜底：绕过 review 直接安装同样被拦。
        await expect(store.install(testCase.draft.draftId, { confirmed: true })).rejects.toBeInstanceOf(Error)
        expect(await skillsTreeExists(root)).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('exposes review then install through the SkillReviewService facade', async () => {
    const root = await makeRoot()
    const store = new FsSkillStore({ root })
    try {
      const draft = validDraft()
      await store.saveDraft(draft)
      const service = new SkillReviewService({ store })

      expect((await service.review(draft.draftId)).validation.ok).toBe(true)
      expect(await skillsTreeExists(root)).toBe(false)

      const installed = await service.install({ draftId: draft.draftId, decision: 'confirmed' })
      expect(installed.version).toBe(1)
      expect(await skillsTreeExists(root)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
