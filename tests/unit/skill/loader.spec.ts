import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsSkillCatalog, type LoadedSkill } from '../../../src/skill/catalog.js'
import { recordSkillFeedback } from '../../../src/skill/feedback.js'
import { FsSkillStore } from '../../../src/skill/store.js'
import { SkillServiceError } from '../../../src/skill/model.js'
import { validDraft, validMarkdown } from './fixtures.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-skill-loader-'))
}

/** 在必填章节正文里留下版本标记，用于区分不同版本的全文。 */
function markdownWith(marker: string): string {
  return validMarkdown().replace('Submit the example form.', `Submit the example form (${marker}).`)
}

function draftFor(version: number, markdown: string) {
  return validDraft({ draftId: `draft_v${String(version)}`, markdown })
}

/** 安装 example/form 的第 N 版，返回安装结果。 */
async function installVersion(store: FsSkillStore, version: number, marker: string) {
  const draft = draftFor(version, markdownWith(marker))
  await store.saveDraft(draft)
  return store.install(draft.draftId, { confirmed: true })
}

function activePath(root: string): string {
  return join(root, 'skills', 'example', 'form', 'SKILL.md')
}

function versionPath(root: string, version: number): string {
  return join(root, 'skills', 'example', 'form', 'versions', `v${String(version)}`, 'SKILL.md')
}

/** 递归快照（相对路径 → 文件内容），用于断言 load 只读、不写盘。 */
async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true })
  const files: Record<string, string> = {}
  for (const entry of entries) {
    const absolute = join(root, entry)
    if (!(await stat(absolute)).isFile()) continue
    files[entry] = await readFile(absolute, 'utf8')
  }
  return files
}

/** 构造一份手写 SKILL.md，正文非空，frontmatter 由调用方给出。 */
function handWrittenSkill(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\n## Summary\n\nHand-written skill.\n`
}

async function expectSkillError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
  await expect(promise).rejects.toBeInstanceOf(SkillServiceError)
}

describe('FsSkillCatalog.load（IF-5 入口）', () => {
  it('按 name 加载 active 版本：全文 + frontmatter + InstalledSkill 投影', async () => {
    const root = await tempRoot()
    try {
      const store = new FsSkillStore({ root })
      // catalog 先于安装创建：load 不依赖构造时刻的缓存。
      const catalog = new FsSkillCatalog({ root })
      await installVersion(store, 1, 'v1')

      const loaded: LoadedSkill = await catalog.load('example-form')

      expect(loaded.skill).toMatchObject({
        name: 'example-form',
        version: 1,
        site: 'example',
        flow: 'form',
        triggers: ['example', 'form'],
        status: 'active',
        successCount: 0,
        failureCount: 0,
        needsReview: false,
      })
      expect(loaded.skill.path).toBe(activePath(root))
      expect(loaded.skill.sourceRecordings).toEqual([
        { recordingId: 'rec_example', sha256: 'a'.repeat(64) },
      ])
      // 全文（含 frontmatter 与正文）原样读出。
      expect(loaded.markdown.startsWith('---\n')).toBe(true)
      expect(loaded.markdown).toContain('name: "example-form"')
      expect(loaded.markdown).toContain('## Summary')
      expect(loaded.markdown).toContain('## Verification')
      expect(loaded.markdown).toContain('(v1)')
      // frontmatter 为原始字段投影。
      expect(loaded.frontmatter['name']).toBe('example-form')
      expect(loaded.frontmatter['version']).toBe(1)
      expect(loaded.frontmatter['site']).toBe('example')
      expect(loaded.frontmatter['triggers']).toEqual(['example', 'form'])
      expect(catalog.warnings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('未指定 version 返回最新 active；指定 version 读取对应历史版本', async () => {
    const root = await tempRoot()
    try {
      const store = new FsSkillStore({ root })
      await installVersion(store, 1, 'v1')
      await installVersion(store, 2, 'v2')
      const catalog = new FsSkillCatalog({ root })

      const latest = await catalog.load('example-form')
      expect(latest.skill.version).toBe(2)
      expect(latest.skill.path).toBe(activePath(root))
      expect(latest.markdown).toContain('(v2)')

      const pinned = await catalog.load('example-form', 1)
      expect(pinned.skill.version).toBe(1)
      expect(pinned.skill.path).toBe(versionPath(root, 1))
      expect(pinned.markdown).toContain('(v1)')
      expect(pinned.markdown).not.toContain('(v2)')

      const pinnedLatest = await catalog.load('example-form', 2)
      expect(pinnedLatest.skill.version).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('缺失 Skill 与缺失版本返回 SKILL_NOT_FOUND', async () => {
    const root = await tempRoot()
    try {
      const store = new FsSkillStore({ root })
      await installVersion(store, 1, 'v1')
      const catalog = new FsSkillCatalog({ root })

      await expectSkillError(catalog.load('missing-skill'), 'SKILL_NOT_FOUND')
      await expectSkillError(catalog.load('example-form', 9), 'SKILL_NOT_FOUND')

      // 从未安装过任何 Skill（skills/ 目录不存在）同样是 NOT_FOUND，而不是空指针/异常泄漏。
      const emptyRoot = await tempRoot()
      try {
        const emptyCatalog = new FsSkillCatalog({ root: emptyRoot })
        await expectSkillError(emptyCatalog.load('example-form'), 'SKILL_NOT_FOUND')
      } finally {
        await rm(emptyRoot, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('active 指针损坏返回 SKILL_CORRUPT，且已发布的版本副本仍可按 version 加载', async () => {
    const root = await tempRoot()
    try {
      const store = new FsSkillStore({ root })
      await installVersion(store, 1, 'v1')
      const catalog = new FsSkillCatalog({ root })
      await writeFile(activePath(root), 'not a skill file\n', 'utf8')

      await expectSkillError(catalog.load('example-form'), 'SKILL_CORRUPT')
      // 历史版本是独立文件，仍可按 version 读取（回滚演练口径）。
      const pinned = await catalog.load('example-form', 1)
      expect(pinned.skill.version).toBe(1)
      expect(pinned.markdown).toContain('(v1)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('frontmatter 损坏（缺 name）按目录名兜底判定为 SKILL_CORRUPT', async () => {
    const root = await tempRoot()
    try {
      const dir = join(root, 'skills', 'manual', 'form')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'SKILL.md'),
        handWrittenSkill('version: 1\nsite: manual\nflow: form\ntriggers: []\nstatus: active'),
        'utf8',
      )
      const catalog = new FsSkillCatalog({ root })

      await expectSkillError(catalog.load('manual-form'), 'SKILL_CORRUPT')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('正文为空视为损坏；损坏的版本副本只影响该版本的定点读取', async () => {
    const root = await tempRoot()
    try {
      const store = new FsSkillStore({ root })
      await installVersion(store, 1, 'v1')
      await installVersion(store, 2, 'v2')
      const catalog = new FsSkillCatalog({ root })

      // 只保留 frontmatter、删掉正文 → 结构损坏。
      const content = await readFile(activePath(root), 'utf8')
      const closing = content.indexOf('\n---\n')
      expect(closing).toBeGreaterThan(0)
      await writeFile(activePath(root), content.slice(0, closing + 5), 'utf8')
      await expectSkillError(catalog.load('example-form'), 'SKILL_CORRUPT')

      // v2 副本仍健康：定点读取 v2 不受 active 指针损坏影响。
      expect((await catalog.load('example-form', 2)).skill.version).toBe(2)
      // 损坏 v2 版本副本后，未指定版本的 active 读取与定点 v2 分别报对应错误。
      await writeFile(versionPath(root, 2), 'broken version copy\n', 'utf8')
      await expectSkillError(catalog.load('example-form', 2), 'SKILL_CORRUPT')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('其它 Skill 的文件损坏不阻断本 Skill 的加载', async () => {
    const root = await tempRoot()
    try {
      const store = new FsSkillStore({ root })
      await installVersion(store, 1, 'v1')
      await store.saveDraft(validDraft({ draftId: 'draft_shop', site: 'shop', flow: 'checkout' }))
      await store.install('draft_shop', { confirmed: true })
      const catalog = new FsSkillCatalog({ root })

      const shopPath = join(root, 'skills', 'shop', 'checkout', 'SKILL.md')
      await writeFile(shopPath, 'garbage\n', 'utf8')

      const loaded = await catalog.load('example-form')
      expect(loaded.skill.version).toBe(1)
      await expectSkillError(catalog.load('shop-checkout'), 'SKILL_CORRUPT')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('非法 name / version 返回 SKILL_INVALID（含路径逃逸输入）', async () => {
    const root = await tempRoot()
    try {
      const store = new FsSkillStore({ root })
      await installVersion(store, 1, 'v1')
      const catalog = new FsSkillCatalog({ root })

      await expectSkillError(catalog.load('Bad Name'), 'SKILL_INVALID')
      await expectSkillError(catalog.load('../etc/passwd'), 'SKILL_INVALID')
      await expectSkillError(catalog.load('example/../form'), 'SKILL_INVALID')
      await expectSkillError(catalog.load('example-form', 0), 'SKILL_INVALID')
      await expectSkillError(catalog.load('example-form', -1), 'SKILL_INVALID')
      await expectSkillError(catalog.load('example-form', 1.5), 'SKILL_INVALID')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('active 指针缺失时回退到最高版本副本；加载全程只读', async () => {
    const root = await tempRoot()
    try {
      const store = new FsSkillStore({ root })
      await installVersion(store, 1, 'v1')
      await installVersion(store, 2, 'v2')
      const catalog = new FsSkillCatalog({ root })
      const before = await snapshot(root)

      await catalog.load('example-form')
      await catalog.load('example-form', 1)
      await expectSkillError(catalog.load('missing-skill'), 'SKILL_NOT_FOUND')

      // 不新增/修改任何文件（含临时文件），索引告警状态也不变。
      expect(await snapshot(root)).toEqual(before)
      expect(catalog.warnings).toEqual([])

      await rm(activePath(root), { force: true })
      const fallback = await catalog.load('example-form')
      expect(fallback.skill.version).toBe(2)
      expect(fallback.markdown).toContain('(v2)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('来源 Recording 删除后 Skill 仍可读，provenance 字段完整保留（TC-7）', async () => {
    const root = await tempRoot()
    try {
      const store = new FsSkillStore({ root })
      await installVersion(store, 1, 'v1')
      // 反馈一次，让 frontmatter 带上 last_verified（TC-7 要求来源/sha256/version/lastVerified 齐全）。
      await recordSkillFeedback(
        {
          runId: 'run_tc7',
          recordingId: 'rec_example',
          skillName: 'example-form',
          result: 'success',
          at: '2026-10-30T01:02:03.000Z',
        },
        { store },
      )

      // 模拟「来源 Recording 已删除」：Skill 系统加载只读自身目录，从不回读 Recording 存储；
      // 用一个全新 catalog（没有任何来源可用）重读，Skill 必须仍可读。
      const catalog = new FsSkillCatalog({ root })
      const loaded = await catalog.load('example-form')

      expect(loaded.skill.version).toBe(1)
      expect(loaded.skill.sourceRecordings).toEqual([
        { recordingId: 'rec_example', sha256: 'a'.repeat(64) },
      ])
      expect(loaded.skill.lastVerified).toBe('2026-10-30T01:02:03.000Z')
      // provenance 写死在 frontmatter 里，来源删除不影响追溯信息本身。
      expect(loaded.frontmatter['source_recordings']).toEqual([
        { recordingId: 'rec_example', sha256: 'a'.repeat(64) },
      ])
      expect(loaded.frontmatter['last_verified']).toBe('2026-10-30T01:02:03.000Z')
      expect(loaded.markdown).toContain('## Provenance')
      expect(loaded.markdown).toContain('Source recording rec_example.')
      expect(catalog.warnings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
