/**
 * Run 终态反馈（design/interfaces.md IF-6、design/backend.md S-5、decomposition t7）。
 *
 * 语义（design/data-model.md SkillFeedback + design/test-cases.md TC-8/TC-9）：
 * - `runId` 是幂等键：同一 runId 重复上报返回**首次**结果，不重复计数；
 * - `success` → `successCount + 1`，`lastVerified` 更新为本次 `at`；
 * - `failed` → `failureCount + 1`，`needsReview = true`，`active` 状态降为 `needs_review`
 *   （恢复需要重新生成版本，成功反馈不会自动清除 needsReview——data-model 生命周期）；
 * - `cancelled` → 不计数、不改状态，但仍登记 runId，保证之后重复上报幂等；
 * - 不改写正文：只重写 frontmatter 的反馈字段，`---` 之后的内容逐字节保持不变；
 * - 计数更新是「互斥锁 + 进锁后重读再改」：并发 Run 的天真读改写会丢计数，这里要么错峰
 *   合并（两次成功 = +2），要么在重试一次后仍拿不到锁时返回 `SKILL_FEEDBACK_CONFLICT`；
 * - 只改 active 指针 `skills/<site>/<flow>/SKILL.md`；`versions/v<N>/SKILL.md` 是安装时的
 *   历史快照，不做回填（读取当前状态走 active 指针，历史版本保持可追溯）。
 */
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { assertRunId, type RunId } from '../core/ids.js'
import {
  SkillServiceError,
  assertIsoTimestamp,
  assertSkillName,
  isSkillFeedbackResult,
  type InstalledSkill,
  type SkillFeedback,
  type SkillFeedbackResult,
  type SkillFeedbackUpdate,
} from './model.js'
import type { SkillStore } from './store.js'

/** 反馈只需要 load（读 active SKILL.md）；收窄依赖避免误触安装写入口。 */
export type SkillFeedbackStore = Pick<SkillStore, 'load'>

export interface SkillFeedbackOptions {
  readonly store: SkillFeedbackStore
  /**
   * 并发冲突的重试预算（毫秒）。抢不到锁时最多等这么久再重试一次（IF-6「重读重试一次」）；
   * 缺省 2000ms，测试可调小以快速覆盖冲突分支。
   */
  readonly retryTimeoutMs?: number
}

/** IF-6 回执：本次上报是否被计入，以及更新后的计数状态。 */
export interface SkillFeedbackReceipt extends SkillFeedbackUpdate {
  readonly runId: RunId
  readonly result: SkillFeedbackResult
  /** true = 本次确实改了计数（success/failed 的首次上报）；cancelled/重复上报为 false。 */
  readonly applied: boolean
  /** true = 该 runId 之前已上报过，本次直接返回首次结果（幂等）。 */
  readonly duplicate: boolean
}

/** 幂等账本里一条 runId 的首次上报结果。 */
interface FeedbackLedgerEntry {
  readonly result: SkillFeedbackResult
  readonly at: string
  readonly skillName: string
  readonly successCount: number
  readonly failureCount: number
  readonly needsReview: boolean
  readonly lastVerified?: string
}

/** 每个 Skill 目录内的反馈互斥锁（进程崩溃遗留的锁超过 TTL 才会被回收）。 */
const FEEDBACK_LOCK_FILE = '.feedback.lock'

/** 每个 Skill 目录内的 runId 幂等账本。 */
const FEEDBACK_LEDGER_FILE = '.feedback-ledger.json'

const FEEDBACK_LOCK_TTL_MS = 30_000

const DEFAULT_RETRY_TIMEOUT_MS = 2_000

const RETRY_INTERVAL_MS = 5

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/** 原子写：同目录临时文件 + rename；失败清理临时文件并映射为存储错误码。 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, filePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw new SkillServiceError('SKILL_STORE_WRITE_FAILED', `failed to write ${path.basename(filePath)}`, { cause: error })
  }
}

function ledgerPath(skillDir: string): string {
  return path.join(skillDir, FEEDBACK_LEDGER_FILE)
}

function toLedgerEntry(value: unknown): FeedbackLedgerEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  if (!isSkillFeedbackResult(entry['result'])) return undefined
  const at = entry['at']
  const skillName = entry['skillName']
  const successCount = entry['successCount']
  const failureCount = entry['failureCount']
  const needsReview = entry['needsReview']
  const lastVerified = entry['lastVerified']
  if (
    typeof at !== 'string' ||
    typeof skillName !== 'string' ||
    typeof successCount !== 'number' ||
    typeof failureCount !== 'number' ||
    typeof needsReview !== 'boolean'
  ) {
    return undefined
  }
  if (lastVerified !== undefined && typeof lastVerified !== 'string') return undefined
  return {
    result: entry['result'],
    at,
    skillName,
    successCount,
    failureCount,
    needsReview,
    ...(lastVerified === undefined ? {} : { lastVerified }),
  }
}

/** 读账本；不存在视为空。损坏的账本不能静默当空（会重复计数），直接报 SKILL_CORRUPT。 */
async function readFeedbackLedger(skillDir: string): Promise<Record<string, FeedbackLedgerEntry>> {
  let raw: string
  try {
    raw = await readFile(ledgerPath(skillDir), 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return {}
    throw new SkillServiceError('SKILL_CORRUPT', 'failed to read the skill feedback ledger', { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new SkillServiceError('SKILL_CORRUPT', 'the skill feedback ledger is not valid JSON', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SkillServiceError('SKILL_CORRUPT', 'the skill feedback ledger must be an object')
  }
  const ledger: Record<string, FeedbackLedgerEntry> = {}
  for (const [runId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = toLedgerEntry(value)
    // 单条坏记录跳过（该 runId 可重新上报），不阻断其它 runId 的幂等判断。
    if (entry !== undefined) ledger[runId] = entry
  }
  return ledger
}

async function writeFeedbackLedger(skillDir: string, ledger: Record<string, FeedbackLedgerEntry>): Promise<void> {
  await atomicWrite(ledgerPath(skillDir), `${JSON.stringify(ledger, null, 2)}\n`)
}

/** 等持锁者释放；过期（进程崩溃遗留）就地回收。超时返回 false。 */
async function waitForFeedbackLock(lockPath: string, retryTimeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + retryTimeoutMs
  while (Date.now() < deadline) {
    const raw = await readFile(lockPath, 'utf8').catch(() => undefined)
    if (raw === undefined) return true
    let startedAt = Number.NaN
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (typeof parsed['startedAt'] === 'number') startedAt = parsed['startedAt']
    } catch {
      // 锁内容损坏：按遗留锁处理。
    }
    if (!Number.isFinite(startedAt) || Date.now() - startedAt > FEEDBACK_LOCK_TTL_MS) {
      await rm(lockPath, { force: true }).catch(() => undefined)
      return true
    }
    await sleep(RETRY_INTERVAL_MS)
  }
  return false
}

/**
 * 取反馈互斥锁：O_EXCL 创建。
 * 已有持锁者时等它释放并重试一次；重试仍冲突 → `SKILL_FEEDBACK_CONFLICT`（IF-6 语义：
 * 计数可能重试，重试失败即拒绝，不无限等待、不静默丢计数）。
 */
async function acquireFeedbackLock(skillDir: string, retryTimeoutMs: number): Promise<string> {
  const lockPath = path.join(skillDir, FEEDBACK_LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      return lockPath
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw new SkillServiceError('SKILL_STORE_WRITE_FAILED', 'failed to create the skill feedback lock', {
          cause: error,
        })
      }
      if (attempt > 0) {
        throw new SkillServiceError('SKILL_FEEDBACK_CONFLICT', 'another skill feedback update is still in progress')
      }
      if (!(await waitForFeedbackLock(lockPath, retryTimeoutMs))) {
        throw new SkillServiceError('SKILL_FEEDBACK_CONFLICT', 'another skill feedback update is still in progress')
      }
    }
  }
  throw new SkillServiceError('SKILL_FEEDBACK_CONFLICT', 'could not acquire the skill feedback lock')
}

/** 按 Run 终态计算新状态；不改写正文，只返回新的 frontmatter 投影。 */
function applyFeedback(skill: InstalledSkill, feedback: SkillFeedback, at: string): InstalledSkill {
  if (feedback.result === 'cancelled') return skill
  if (feedback.result === 'success') {
    // 成功只提升验证状态；needsReview 不清除（恢复走重新生成版本，data-model 生命周期）。
    return { ...skill, successCount: skill.successCount + 1, lastVerified: at }
  }
  return {
    ...skill,
    failureCount: skill.failureCount + 1,
    needsReview: true,
    // active → needs_review；deprecated 保持弃用，失败不改变弃用决定。
    status: skill.status === 'deprecated' ? 'deprecated' : 'needs_review',
  }
}

/**
 * 只重写 frontmatter 的反馈字段，`---` 之后的正文逐字节保留。
 * 字段值序列化与 `store.ts` 的 `serializeInstalled` 对齐（JSON 字面量）。
 */
function rewriteSkillFeedbackFrontmatter(markdown: string, skill: InstalledSkill): string {
  const match = FRONTMATTER.exec(markdown)
  if (match === null) {
    throw new SkillServiceError('SKILL_CORRUPT', 'SKILL.md is missing frontmatter')
  }
  const updates: Record<string, unknown> = {
    success_count: skill.successCount,
    failure_count: skill.failureCount,
    needs_review: skill.needsReview,
    status: skill.status,
  }
  if (skill.lastVerified !== undefined) updates['last_verified'] = skill.lastVerified

  const raw = match[1] ?? ''
  const keys = Object.keys(updates)
  const replaced = new Set<string>()
  const lines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const key = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)?.[1]
    if (key !== undefined && keys.includes(key)) {
      replaced.add(key)
      lines.push(`${key}: ${JSON.stringify(updates[key])}`)
      continue
    }
    lines.push(line)
  }
  // 缺失的反馈字段（例如首次成功前没有 last_verified）补在 frontmatter 末尾。
  for (const key of keys) {
    if (!replaced.has(key)) lines.push(`${key}: ${JSON.stringify(updates[key])}`)
  }

  const eol = match[0].includes('\r\n') ? '\r\n' : '\n'
  const closing = match[0].endsWith('\n') ? `---${eol}` : '---'
  return `---${eol}${lines.join(eol)}${eol}${closing}${markdown.slice(match[0].length)}`
}

function receiptFromLedger(runId: RunId, entry: FeedbackLedgerEntry, duplicate: boolean): SkillFeedbackReceipt {
  return {
    ...(entry.lastVerified === undefined ? {} : { lastVerified: entry.lastVerified }),
    runId,
    result: entry.result,
    skillName: entry.skillName,
    successCount: entry.successCount,
    failureCount: entry.failureCount,
    needsReview: entry.needsReview,
    applied: !duplicate && entry.result !== 'cancelled',
    duplicate,
  }
}

function assertFeedbackShape(feedback: SkillFeedback): void {
  assertRunId(feedback.runId)
  assertSkillName(feedback.skillName)
  if (!isSkillFeedbackResult(feedback.result)) {
    throw new SkillServiceError('SKILL_INVALID', 'result must be one of success, failed or cancelled')
  }
  assertIsoTimestamp(feedback.at, 'at')
  if (
    feedback.failedStepId !== undefined &&
    (typeof feedback.failedStepId !== 'string' || feedback.failedStepId.trim().length === 0)
  ) {
    throw new SkillServiceError('SKILL_INVALID', 'failedStepId must be a non-empty string when present')
  }
}

/**
 * IF-6 recordSkillFeedback：把一次 Run 终态反馈写回 Skill frontmatter。
 *
 * 顺序：形状校验 → load（SKILL_NOT_FOUND / SKILL_CORRUPT）→ 取锁 → 查幂等账本 →
 * 进锁后重读最新计数 → 改 frontmatter（正文不动）→ 记账 → 释放锁。
 * 并发上报：第二个调用等第一个释放后基于最新计数累加（+2 不丢）；重试一次仍冲突则
 * 返回 `SKILL_FEEDBACK_CONFLICT`。
 */
export async function recordSkillFeedback(
  feedback: SkillFeedback,
  options: SkillFeedbackOptions,
): Promise<SkillFeedbackReceipt> {
  assertFeedbackShape(feedback)
  const retryTimeoutMs = options.retryTimeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS
  if (!Number.isFinite(retryTimeoutMs) || retryTimeoutMs < 0) {
    throw new SkillServiceError('SKILL_INVALID', 'retryTimeoutMs must be a non-negative number')
  }

  const initial = await options.store.load(feedback.skillName)
  const skillDir = path.dirname(initial.skill.path)
  const lockPath = await acquireFeedbackLock(skillDir, retryTimeoutMs)
  try {
    const ledger = await readFeedbackLedger(skillDir)
    const previous = ledger[feedback.runId]
    if (previous !== undefined) {
      // 幂等：同一 runId 重复上报返回首次结果，不再动计数。
      return receiptFromLedger(feedback.runId, previous, true)
    }

    // 进锁后重读：并发上报必须基于磁盘上的最新计数累加，绝不能拿进锁前的快照覆盖。
    const current = await options.store.load(feedback.skillName)
    const updated = applyFeedback(current.skill, feedback, feedback.at)
    if (updated !== current.skill) {
      await atomicWrite(current.skill.path, rewriteSkillFeedbackFrontmatter(current.markdown, updated))
    }

    const entry: FeedbackLedgerEntry = {
      result: feedback.result,
      at: feedback.at,
      skillName: updated.name,
      successCount: updated.successCount,
      failureCount: updated.failureCount,
      needsReview: updated.needsReview,
      ...(updated.lastVerified === undefined ? {} : { lastVerified: updated.lastVerified }),
    }
    try {
      await writeFeedbackLedger(skillDir, { ...ledger, [feedback.runId]: entry })
    } catch (error) {
      // 记账失败回滚计数：宁可这次上报失败，也不能让重复上报二次累加。
      if (updated !== current.skill) {
        await atomicWrite(current.skill.path, current.markdown).catch(() => undefined)
      }
      throw error
    }
    return receiptFromLedger(feedback.runId, entry, false)
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

/** backend.md S-5 的服务形态；Host 工具与 Replay 完成回调按服务注入。 */
export class SkillFeedbackService {
  private readonly options: SkillFeedbackOptions

  constructor(options: SkillFeedbackOptions) {
    this.options = options
  }

  async record(feedback: SkillFeedback): Promise<SkillFeedbackReceipt> {
    return recordSkillFeedback(feedback, this.options)
  }
}
