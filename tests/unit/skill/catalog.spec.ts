import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsSkillCatalog, type SkillQuery } from '../../../src/skill/catalog.js'
import { FsSkillStore } from '../../../src/skill/store.js'
import { validDraft, validMarkdown } from './fixtures.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-skill-catalog-'))
}

/** 按 FsSkillStore 的序列化格式手写一份 SKILL.md，用于构造索引边界场景。 */
function skillFile(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `---\n${lines.join('\n')}\n---\n\n${validMarkdown()}\n`
}

async function writeSkill(root: string, site: string, flow: string, content: string): Promise<string> {
  const dir = join(root, 'skills', site, flow)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  await writeFile(file, content, 'utf8')
  return file
}

/** 安装两个健康 Skill：portal/submit-report 与 shop/checkout。 */
async function installTwo(root: string): Promise<FsSkillStore> {
  const store = new FsSkillStore({ root })
  await store.saveDraft(validDraft({ draftId: 'draft_orders', site: 'shop', flow: 'checkout' }))
  await store.install('draft_orders', { confirmed: true })
  await store.saveDraft(validDraft({ draftId: 'draft_portal', site: 'portal', flow: 'submit-report' }))
  await store.install('draft_portal', { confirmed: true })
  return store
}

describe('FsSkillCatalog 索引', () => {
  it('只投影 frontmatter：条目不含全文，按 name 稳定排序', async () => {
    const root = await tempRoot()
    try {
      await installTwo(root)
      const catalog = new FsSkillCatalog({ root })
      const index = await catalog.buildIndex()

      expect(index.warnings).toEqual([])
      expect(index.entries.map(entry => entry.name)).toEqual(['portal-submit-report', 'shop-checkout'])

      const portal = index.entries[0]
      expect(portal).toBeDefined()
      expect(portal?.site).toBe('portal')
      expect(portal?.flow).toBe('submit-report')
      expect(portal?.triggers).toEqual(['portal', 'submit-report'])
      expect(portal?.status).toBe('active')
      expect(portal?.path).toBe(join(root, 'skills', 'portal', 'submit-report', 'SKILL.md'))
      // 索引条目只含 SkillIndexEntry 字段，且不携带 Markdown 正文。
      expect(Object.keys(portal ?? {}).sort()).toEqual(['flow', 'name', 'path', 'site', 'sourceRecordingIds', 'status', 'triggers'])
      expect(JSON.stringify(portal)).not.toContain('## Summary')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('投影可选 lastVerified / needs_review 状态', async () => {
    const root = await tempRoot()
    try {
      const file = await writeSkill(
        root,
        'manual',
        'flow',
        skillFile({
          name: 'manual-flow',
          version: 3,
          site: 'Manual',
          flow: 'Flow',
          triggers: ['manual', '表单'],
          source_recordings: [{ recordingId: 'rec_manual', sha256: 'b'.repeat(64) }],
          success_count: 2,
          failure_count: 1,
          needs_review: true,
          status: 'needs_review',
          last_verified: '2026-10-30T00:00:00.000Z',
        }),
      )
      const catalog = new FsSkillCatalog({ root })
      const entries = await catalog.search({ query: 'manual' })

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        name: 'manual-flow',
        site: 'Manual',
        flow: 'Flow',
        status: 'needs_review',
        lastVerified: '2026-10-30T00:00:00.000Z',
        path: file,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('尚未安装任何 Skill 时返回空索引', async () => {
    const root = await tempRoot()
    try {
      const catalog = new FsSkillCatalog({ root })
      await expect(catalog.buildIndex()).resolves.toEqual({ entries: [], warnings: [] })
      await expect(catalog.search({ query: 'anything' })).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('FsSkillCatalog 搜索（IF-4）', () => {
  it('按 site 命中、大小写不敏感；不匹配返回空数组', async () => {
    const root = await tempRoot()
    try {
      await installTwo(root)
      const catalog = new FsSkillCatalog({ root })

      await expect(catalog.search({ site: 'Portal' })).resolves.toMatchObject([{ name: 'portal-submit-report' }])
      await expect(catalog.search({ site: 'portal' })).resolves.toMatchObject([{ name: 'portal-submit-report' }])
      await expect(catalog.search({ site: 'unknown' })).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('按 flow 命中；site+flow 取交集', async () => {
    const root = await tempRoot()
    try {
      await installTwo(root)
      const catalog = new FsSkillCatalog({ root })

      await expect(catalog.search({ flow: 'checkout' })).resolves.toMatchObject([{ name: 'shop-checkout' }])
      await expect(catalog.search({ site: 'shop', flow: 'checkout' })).resolves.toMatchObject([{ name: 'shop-checkout' }])
      await expect(catalog.search({ site: 'portal', flow: 'checkout' })).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('按 triggers 命中；多个触发词取交集', async () => {
    const root = await tempRoot()
    try {
      await installTwo(root)
      const catalog = new FsSkillCatalog({ root })

      await expect(catalog.search({ triggers: ['portal'] })).resolves.toMatchObject([{ name: 'portal-submit-report' }])
      await expect(catalog.search({ triggers: ['portal', 'submit-report'] })).resolves.toMatchObject([
        { name: 'portal-submit-report' },
      ])
      await expect(catalog.search({ triggers: ['portal', 'checkout'] })).resolves.toEqual([])
      await expect(catalog.search({ triggers: ['missing'] })).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('按 query 匹配 name/site/flow/triggers；未命中返回 []', async () => {
    const root = await tempRoot()
    try {
      await installTwo(root)
      const catalog = new FsSkillCatalog({ root })

      await expect(catalog.search({ query: 'submit' })).resolves.toMatchObject([{ name: 'portal-submit-report' }])
      await expect(catalog.search({ query: 'CHECKOUT' })).resolves.toMatchObject([{ name: 'shop-checkout' }])
      // 触发词也参与 query 匹配。
      await expect(catalog.search({ query: 'shop' })).resolves.toMatchObject([{ name: 'shop-checkout' }])
      await expect(catalog.search({ query: 'form' })).resolves.toEqual([])
      await expect(catalog.search({ query: 'nothing-here' })).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝非法查询字段', async () => {
    const root = await tempRoot()
    try {
      const catalog = new FsSkillCatalog({ root })
      const badTriggers = { triggers: 'portal' } as unknown as SkillQuery
      const badSite = { site: 42 } as unknown as SkillQuery
      await expect(catalog.search(badTriggers)).rejects.toMatchObject({ code: 'SKILL_INVALID' })
      await expect(catalog.search(badSite)).rejects.toMatchObject({ code: 'SKILL_INVALID' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('FsSkillCatalog 损坏与不可用', () => {
  it('单文件损坏跳过并警告，其余 Skill 仍可搜索', async () => {
    const root = await tempRoot()
    try {
      await installTwo(root)
      const badName = await writeSkill(root, 'broken', 'name', skillFile({ name: 'Not A Skill', site: 'broken', flow: 'name', triggers: [], status: 'active' }))
      const noFrontmatter = await writeSkill(root, 'broken', 'plain', '# no frontmatter\n')
      const catalog = new FsSkillCatalog({ root })

      const result = await catalog.searchDetailed({})
      expect(result.entries.map(entry => entry.name)).toEqual(['portal-submit-report', 'shop-checkout'])
      expect(result.warnings).toHaveLength(2)
      expect(result.warnings.map(warning => warning.path).sort()).toEqual([badName, noFrontmatter].sort())
      expect(result.warnings.every(warning => warning.message.length > 0)).toBe(true)

      // 警告不会把搜索变成失败：未命中仍是空数组，且 warnings 可回读。
      await expect(catalog.search({ query: 'nothing-here' })).resolves.toEqual([])
      expect(catalog.warnings).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skills 根目录不可读时抛 SKILL_INDEX_UNAVAILABLE', async () => {
    const root = await tempRoot()
    try {
      await writeFile(join(root, 'skills'), 'not a directory', 'utf8')
      const catalog = new FsSkillCatalog({ root })
      await expect(catalog.search({})).rejects.toMatchObject({ code: 'SKILL_INDEX_UNAVAILABLE' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('目录名带下划线的中间目录不进入索引', async () => {
    const root = await tempRoot()
    try {
      await installTwo(root)
      await writeSkill(root, '_scratch', 'flow', skillFile({ name: 'scratch-flow', site: 'scratch', flow: 'flow', triggers: [], status: 'active' }))
      const catalog = new FsSkillCatalog({ root })
      const entries = await catalog.search({})
      expect(entries.map(entry => entry.name)).toEqual(['portal-submit-report', 'shop-checkout'])
      expect(catalog.warnings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
