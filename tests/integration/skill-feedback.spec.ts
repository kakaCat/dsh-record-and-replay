/**
 * IF-6 反馈集成测试（design/interfaces.md IF-6、design/test-cases.md TC-8/TC-9、decomposition t7）。
 *
 * 覆盖：
 * - TC-8 成功反馈：successCount +1、lastVerified 更新、正文与其它 frontmatter 字段不变；
 * - TC-9 失败反馈：failureCount +1、needsReview=true、status 降为 needs_review；
 * - 取消的 Run 不计数，但同样登记 runId（重复上报仍幂等）；
 * - 同一 runId 重复上报（含并发）只计一次，返回首次结果；
 * - 两个不同 runId 并发成功 → successCount +2（不丢计数）；
 * - 持锁未释放 → SKILL_FEEDBACK_CONFLICT；过期锁可回收后继续；
 * - 未知 Skill → SKILL_NOT_FOUND；
 * - `SkillFeedbackService` 门面与函数入口行为一致。
 *
 * 测试只写系统临时目录，不触碰仓库内文件或真实 Skill 目录。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordSkillFeedback, SkillFeedbackService, type SkillFeedbackReceipt } from '../../src/skill/feedback.js'
import type { SkillFeedback } from '../../src/skill/model.js'
import { FsSkillStore } from '../../src/skill/store.js'
import { validDraft } from '../unit/skill/fixtures.js'

const SITE = 'example'
const FLOW = 'form'
const SKILL_NAME = 'example-form'

const FIRST_AT = '2026-10-30T01:02:03.000Z'
const SECOND_AT = '2026-10-30T04:05:06.000Z'

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-skill-feedback-'))
}

function skillDir(root: string): string {
  return join(root, 'skills', SITE, FLOW)
}

function activeSkillFile(root: string): string {
  return join(skillDir(root), 'SKILL.md')
}

function lockFile(root: string): string {
  return join(skillDir(root), '.feedback.lock')
}

async function installedStore(root: string): Promise<{ root: string; store: FsSkillStore }> {
  const store = new FsSkillStore({ root })
  await store.saveDraft(validDraft())
  await store.install('draft_example', { confirmed: true })
  return { root, store }
}

function feedback(overrides: Partial<SkillFeedback> = {}): SkillFeedback {
  return {
    runId: 'run_success' as SkillFeedback['runId'],
    recordingId: 'rec_example' as SkillFeedback['recordingId'],
    skillName: SKILL_NAME,
    result: 'success',
    at: FIRST_AT,
    ...overrides,
  }
}

/** `---` 之后的正文；反馈只允许改 frontmatter，这一段必须逐字节不变。 */
function bodyOf(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  expect(match).not.toBeNull()
  return markdown.slice(match?.[0].length ?? 0)
}

describe('recordSkillFeedback (IF-6)', () => {
  it('updates lastVerified/successCount on success without rewriting the body (TC-8)', async () => {
    const root = await makeRoot()
    const { store } = await installedStore(root)
    try {
      const before = await readFile(activeSkillFile(root), 'utf8')
      const receipt = await recordSkillFeedback(feedback(), { store })

      expect(receipt).toMatchObject({
        skillName: SKILL_NAME,
        result: 'success',
        successCount: 1,
        failureCount: 0,
        needsReview: false,
        applied: true,
        duplicate: false,
        lastVerified: FIRST_AT,
      })

      const after = await readFile(activeSkillFile(root), 'utf8')
      // 正文逐字节不变；其余 frontmatter 字段（name/version/来源）也原样保留。
      expect(bodyOf(after)).toBe(bodyOf(before))
      expect(after).toContain('name: "example-form"')
      expect(after).toContain('version: 1')
      expect(after).toContain('source_recordings')
      expect(after).toContain(`last_verified: "${FIRST_AT}"`)
      expect(after).toContain('success_count: 1')
      expect(after).toContain('failure_count: 0')

      const loaded = await store.load(SKILL_NAME)
      expect(loaded.skill.successCount).toBe(1)
      expect(loaded.skill.lastVerified).toBe(FIRST_AT)
      expect(loaded.skill.status).toBe('active')

      // 门面与函数入口行为一致。
      const service = new SkillFeedbackService({ store })
      const second = await service.record(feedback({ runId: 'run_second_at' as SkillFeedback['runId'], at: SECOND_AT }))
      expect(second.successCount).toBe(2)
      expect(second.lastVerified).toBe(SECOND_AT)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks needsReview and increments failureCount on failure (TC-9)', async () => {
    const root = await makeRoot()
    const { store } = await installedStore(root)
    try {
      const before = await readFile(activeSkillFile(root), 'utf8')
      const receipt = await recordSkillFeedback(
        feedback({ runId: 'run_failed' as SkillFeedback['runId'], result: 'failed', failedStepId: 'step_3' as const }),
        { store },
      )

      expect(receipt).toMatchObject({
        result: 'failed',
        successCount: 0,
        failureCount: 1,
        needsReview: true,
        applied: true,
        duplicate: false,
      })
      expect(receipt.lastVerified).toBeUndefined()

      const after = await readFile(activeSkillFile(root), 'utf8')
      expect(bodyOf(after)).toBe(bodyOf(before))
      expect(after).toContain('failure_count: 1')
      expect(after).toContain('needs_review: true')

      const loaded = await store.load(SKILL_NAME)
      expect(loaded.skill.failureCount).toBe(1)
      expect(loaded.skill.needsReview).toBe(true)
      // 失败后 active 降为 needs_review，索引/搜索结果不再把它当健康 Skill。
      expect(loaded.skill.status).toBe('needs_review')
      // 成功计数不受失败影响。
      expect(loaded.skill.successCount).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not count cancelled Runs but still records the runId for idempotency', async () => {
    const root = await makeRoot()
    const { store } = await installedStore(root)
    try {
      const before = await readFile(activeSkillFile(root), 'utf8')
      const receipt = await recordSkillFeedback(
        feedback({ runId: 'run_cancelled' as SkillFeedback['runId'], result: 'cancelled' }),
        { store },
      )

      expect(receipt).toMatchObject({
        result: 'cancelled',
        successCount: 0,
        failureCount: 0,
        needsReview: false,
        applied: false,
        duplicate: false,
      })
      // 取消不计数也不改盘（除了幂等账本）。
      expect(await readFile(activeSkillFile(root), 'utf8')).toBe(before)

      // 同一 runId 之后又报 success：仍按首次结果（cancelled）返回，不计数。
      const repeated = await recordSkillFeedback(feedback({ runId: 'run_cancelled' as SkillFeedback['runId'] }), {
        store,
      })
      expect(repeated.duplicate).toBe(true)
      expect(repeated.applied).toBe(false)
      expect(repeated.successCount).toBe(0)

      const loaded = await store.load(SKILL_NAME)
      expect(loaded.skill.successCount).toBe(0)
      expect(loaded.skill.failureCount).toBe(0)
      expect(loaded.skill.needsReview).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is idempotent per runId and returns the first result', async () => {
    const root = await makeRoot()
    const { store } = await installedStore(root)
    try {
      const first = await recordSkillFeedback(feedback({ at: FIRST_AT }), { store })
      const again = await recordSkillFeedback(feedback({ at: SECOND_AT }), { store })

      expect(first).toMatchObject({ successCount: 1, applied: true, duplicate: false })
      expect(again).toMatchObject({
        successCount: 1,
        applied: false,
        duplicate: true,
        lastVerified: FIRST_AT,
      })
      expect((await store.load(SKILL_NAME)).skill.successCount).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('counts two concurrent successful Runs without losing increments (TC-9)', async () => {
    const root = await makeRoot()
    await installedStore(root)
    try {
      const before = await readFile(activeSkillFile(root), 'utf8')
      // 两个独立 Store 实例模拟两个进程/会话同时上报不同 Run。
      const processA = new FsSkillStore({ root })
      const processB = new FsSkillStore({ root })
      const receipts = await Promise.all([
        recordSkillFeedback(feedback({ runId: 'run_concurrent_a' as SkillFeedback['runId'] }), { store: processA }),
        recordSkillFeedback(feedback({ runId: 'run_concurrent_b' as SkillFeedback['runId'] }), { store: processB }),
      ])

      expect(receipts.map(receipt => receipt.applied)).toEqual([true, true])
      const loaded = await new FsSkillStore({ root }).load(SKILL_NAME)
      expect(loaded.skill.successCount).toBe(2)
      expect(loaded.skill.failureCount).toBe(0)
      expect(bodyOf(await readFile(activeSkillFile(root), 'utf8'))).toBe(bodyOf(before))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('counts a concurrently duplicated runId exactly once', async () => {
    const root = await makeRoot()
    await installedStore(root)
    try {
      const processA = new FsSkillStore({ root })
      const processB = new FsSkillStore({ root })
      const receipts = await Promise.all([
        recordSkillFeedback(feedback({ runId: 'run_same' as SkillFeedback['runId'] }), { store: processA }),
        recordSkillFeedback(feedback({ runId: 'run_same' as SkillFeedback['runId'] }), { store: processB }),
      ])

      const applied = receipts.filter((receipt: SkillFeedbackReceipt) => receipt.applied)
      const duplicates = receipts.filter((receipt: SkillFeedbackReceipt) => receipt.duplicate)
      expect(applied).toHaveLength(1)
      expect(duplicates).toHaveLength(1)
      expect((await new FsSkillStore({ root }).load(SKILL_NAME)).skill.successCount).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns SKILL_FEEDBACK_CONFLICT when the lock stays held, leaving counters untouched', async () => {
    const root = await makeRoot()
    const { store } = await installedStore(root)
    try {
      const before = await readFile(activeSkillFile(root), 'utf8')
      // 活锁（心跳新鲜）：重试预算内拿不到锁 → IF-6 冲突错误码。
      await mkdir(skillDir(root), { recursive: true })
      await writeFile(
        lockFile(root),
        `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
        'utf8',
      )

      await expect(
        recordSkillFeedback(feedback(), { store, retryTimeoutMs: 60 }),
      ).rejects.toMatchObject({ code: 'SKILL_FEEDBACK_CONFLICT' })

      expect(await readFile(activeSkillFile(root), 'utf8')).toBe(before)
      expect((await store.load(SKILL_NAME)).skill.successCount).toBe(0)

      // 持锁者退出后同一反馈可正常写入。
      await rm(lockFile(root), { force: true })
      expect((await recordSkillFeedback(feedback(), { store })).successCount).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reclaims a stale feedback lock and applies the update', async () => {
    const root = await makeRoot()
    const { store } = await installedStore(root)
    try {
      await writeFile(
        lockFile(root),
        `${JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60_000 })}\n`,
        'utf8',
      )
      const receipt = await recordSkillFeedback(feedback(), { store, retryTimeoutMs: 200 })
      expect(receipt.successCount).toBe(1)
      expect((await store.load(SKILL_NAME)).skill.successCount).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects feedback for an unknown skill with SKILL_NOT_FOUND', async () => {
    const root = await makeRoot()
    const store = new FsSkillStore({ root })
    try {
      await expect(
        recordSkillFeedback(feedback({ skillName: 'missing-skill' }), { store }),
      ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
