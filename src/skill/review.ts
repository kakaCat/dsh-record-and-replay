/**
 * Skill 草案审查（design/interfaces.md IF-2、design/backend.md S-3、decomposition t3）
 * 与确认后安装（IF-3、decomposition t4）。
 *
 * 职责边界：
 * - IF-2 审查：输入只有一个 `draftId`；从 SkillStore 的 `_drafts/` 读取草案，**只读**，绝不写
 *   `skills/`（`SkillReviewStore` 只暴露 `readDraft`，类型层面就拿不到写入口）；
 * - IF-3 安装：`installSkillDraft` 先按审查口径做质量门禁，再交给 SkillStore.install 写安装目录；
 *   decision 不是 confirmed 时返回 `SKILL_NOT_CONFIRMED`，零写入；
 * - 输出 `SkillDraftSummary`：摘要、歧义、来源（recording/sha256 + Provenance 行）以及安装前校验；
 * - 缺必需章节或 Verification 为空时返回 `SKILL_INVALID`（IF-2）；草案不存在透传
 *   `SKILL_DRAFT_NOT_FOUND`；非法 draftId 返回 `SKILL_INVALID`；
 * - 秘密/坐标等安全阻断不在审查阶段抛错，而是进 `validation.issues` 并让 `validation.ok=false`，
 *   让审查者看到「为什么不能安装」；安装阶段再按同一批问题阻断，错误码取第一条 issue（IF-3）。
 */
import type { RecordingId } from '../core/ids.js'
import {
  SKILL_REQUIRED_SECTIONS,
  SkillServiceError,
  assertDraftId,
  assertSkillDraftShape,
  missingSkillSections,
  type InstalledSkill,
  type SkillDraft,
  type SkillDraftStatus,
} from './model.js'
import { inspectSkillMarkdown, type SkillSecurityIssue } from './security.js'
import type { SkillStore } from './store.js'

/** 审查只需要读草案；收窄依赖，避免审查路径意外触碰写接口。 */
export type SkillReviewStore = Pick<SkillStore, 'readDraft'>

/** 安装需要读草案 + 写安装目录。 */
export type SkillInstallStore = Pick<SkillStore, 'readDraft' | 'install'>

export interface SkillReviewOptions {
  readonly store: SkillReviewStore
}

export interface SkillInstallOptions {
  readonly store: SkillInstallStore
}

/** 审查者决策：只有 confirmed 才允许安装；rejected（或任何其它值）零写入。 */
export type SkillInstallDecision = 'confirmed' | 'rejected'

/** IF-3 输入：草案 + 决策（可选显式 Skill 名）。 */
export interface SkillInstallRequest {
  readonly draftId: string
  readonly decision: SkillInstallDecision
  readonly name?: string
}

export type SkillDraftValidationCheckName =
  | 'status'
  | 'required-sections'
  | 'verification'
  | 'secrets'
  | 'coordinates'
  | 'ambiguities'

/** 安装前的一项校验结果；`ok=false` 时 `detail` 说明阻断原因。 */
export interface SkillDraftValidationCheck {
  readonly check: SkillDraftValidationCheckName
  readonly ok: boolean
  readonly detail: string
}

/**
 * 安装前校验汇总。
 * `ok=false` 表示按当前草案直接安装会被安全/质量门禁拒绝；`issues` 只含安全类问题，
 * 章节缺失/Verification 为空会先以 `SKILL_INVALID` 抛出，不进这里。
 */
export interface SkillDraftValidation {
  readonly ok: boolean
  readonly checks: readonly SkillDraftValidationCheck[]
  readonly issues: readonly SkillSecurityIssue[]
}

/** IF-2 回执：审查者据此决定确认、修改或拒绝。 */
export interface SkillDraftSummary {
  readonly draftId: string
  readonly draftPath: string
  readonly recordingId: RecordingId
  readonly recordingSha256: string
  readonly site: string
  readonly flow: string
  readonly status: SkillDraftStatus
  readonly createdAt: string
  /** `## Summary` 正文（原样，保留 Markdown 段落）。 */
  readonly summary: string
  /** `## Verification` 正文；为空时不会返回摘要（先抛 SKILL_INVALID）。 */
  readonly verification: string
  /** 未决歧义，来自草案的 `ambiguities` 字段。 */
  readonly ambiguities: readonly string[]
  /** 来源证据行，来自 `## Provenance` 正文（去 Markdown 列表符号）。 */
  readonly provenance: readonly string[]
  readonly validation: SkillDraftValidation
}

/** 取 `## <heading>` 章节正文；大小写不敏感，遇到下一个 `## ` 即止。 */
function sectionBody(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${heading}`.toLowerCase())
  if (start < 0) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break
    body.push(line)
  }
  return body.join('\n').trim()
}

/** 列表章节转成行数组：优先取 `- ` / `* ` 列表项，退化为非空原文行。 */
function listLines(body: string): readonly string[] {
  const lines = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
  const bullets = lines
    .map(line => /^[-*]\s+(.*)$/.exec(line)?.[1]?.trim() ?? '')
    .filter(line => line.length > 0)
  return bullets.length > 0 ? bullets : lines
}

function coordinateAmbiguities(draft: SkillDraft): readonly string[] {
  return draft.ambiguities.filter(ambiguity => ambiguity.toLowerCase().includes('coordinate'))
}

/**
 * 审查一份已读取的草案；拆出纯函数便于后续 Host 工具在内存对象上复用。
 * 结构性失败（未 ready / 缺章节 / Verification 为空）以 `SKILL_INVALID` 抛出。
 */
export function summarizeSkillDraft(draft: SkillDraft, draftPath = ''): SkillDraftSummary {
  if (draft.status !== 'ready') {
    throw new SkillServiceError(
      'SKILL_INVALID',
      `draft ${draft.draftId} status is ${draft.status}; only ready drafts can be reviewed`,
    )
  }

  const missingSections = missingSkillSections(draft.markdown)
  const verification = sectionBody(draft.markdown, 'Verification')
  const structural: string[] = []
  if (missingSections.length > 0) {
    structural.push(`missing required sections: ${missingSections.join(', ')}`)
  }
  if (verification.length === 0) {
    structural.push('Verification section must not be empty')
  }
  if (structural.length > 0) {
    throw new SkillServiceError('SKILL_INVALID', structural.join('; '))
  }

  const markdownIssues = inspectSkillMarkdown(draft.markdown)
  const secretIssue = markdownIssues.find(issue => issue.code === 'SKILL_SECRET_DETECTED')
  const coordinateIssue = markdownIssues.find(issue => issue.code === 'SKILL_COORDINATE_ONLY')
  const ambiguousCoordinates = coordinateAmbiguities(draft)

  const issues: SkillSecurityIssue[] = []
  if (secretIssue !== undefined) issues.push(secretIssue)
  if (coordinateIssue !== undefined) issues.push(coordinateIssue)
  if (ambiguousCoordinates.length > 0) {
    issues.push({
      code: 'SKILL_COORDINATE_ONLY',
      message: `draft ambiguities mention coordinates: ${ambiguousCoordinates.join('; ')}`,
    })
  }

  const checks: SkillDraftValidationCheck[] = [
    {
      check: 'status',
      ok: true,
      detail: `status=${draft.status}`,
    },
    {
      check: 'required-sections',
      ok: missingSections.length === 0,
      detail: `all ${String(SKILL_REQUIRED_SECTIONS.length)} required sections present`,
    },
    {
      check: 'verification',
      ok: true,
      detail: 'Verification has content',
    },
    {
      check: 'secrets',
      ok: secretIssue === undefined,
      detail: secretIssue?.message ?? 'no plaintext secret detected',
    },
    {
      check: 'coordinates',
      ok: coordinateIssue === undefined,
      detail: coordinateIssue?.message ?? 'no coordinate-only step detected',
    },
    {
      check: 'ambiguities',
      ok: ambiguousCoordinates.length === 0,
      detail:
        ambiguousCoordinates.length === 0
          ? 'no coordinate ambiguity in draft'
          : `ambiguous coordinates: ${ambiguousCoordinates.join('; ')}`,
    },
  ]

  return {
    draftId: draft.draftId,
    draftPath,
    recordingId: draft.recordingId,
    recordingSha256: draft.recordingSha256,
    site: draft.site,
    flow: draft.flow,
    status: draft.status,
    createdAt: draft.createdAt,
    summary: sectionBody(draft.markdown, 'Summary'),
    verification,
    ambiguities: draft.ambiguities,
    provenance: listLines(sectionBody(draft.markdown, 'Provenance')),
    validation: {
      ok: checks.every(check => check.ok),
      checks,
      issues,
    },
  }
}

/** IF-2 reviewSkillDraft：读取草案并返回摘要；不写安装目录。 */
export async function reviewSkillDraft(
  draftId: string,
  options: SkillReviewOptions,
): Promise<SkillDraftSummary> {
  const id = assertDraftId(draftId)
  const { draft, draftPath } = await options.store.readDraft(id)
  // 草案可能是被手改过的磁盘文件：先按模型校验形状，避免半个字段导致审查崩溃。
  assertSkillDraftShape(draft)
  return summarizeSkillDraft(draft, draftPath)
}

/**
 * IF-3 installSkill：审查确认后安装草案。
 *
 * 顺序：确认位 → 读草案 → 形状校验 → 审查口径质量门禁 → Store 原子写入。
 * 质量门禁不过时按第一条 issue 抛错（SKILL_INVALID / SKILL_SECRET_DETECTED /
 * SKILL_COORDINATE_ONLY），任何失败都不写 `skills/`。
 * 同 draftId 重复确认安装由 Store 幂等返回已安装版本（版本只增）。
 */
export async function installSkillDraft(
  request: SkillInstallRequest,
  options: SkillInstallOptions,
): Promise<InstalledSkill> {
  const id = assertDraftId(request.draftId)
  if (request.decision !== 'confirmed') {
    throw new SkillServiceError('SKILL_NOT_CONFIRMED', 'skill draft must be confirmed before install')
  }
  const { draft, draftPath } = await options.store.readDraft(id)
  assertSkillDraftShape(draft)
  const summary = summarizeSkillDraft(draft, draftPath)
  if (!summary.validation.ok) {
    const issue = summary.validation.issues[0]
    if (issue !== undefined) throw new SkillServiceError(issue.code, issue.message)
    throw new SkillServiceError('SKILL_INVALID', 'draft did not pass pre-install validation')
  }
  return options.store.install(id, {
    confirmed: true,
    ...(request.name === undefined ? {} : { name: request.name }),
  })
}

/** backend.md S-3 的服务形态；Host 工具按服务注入，`review` 为 IF-2、`install` 为 IF-3 入口。 */
export class SkillReviewService {
  private readonly store: SkillInstallStore

  constructor(options: { readonly store: SkillInstallStore }) {
    this.store = options.store
  }

  async review(draftId: string): Promise<SkillDraftSummary> {
    return reviewSkillDraft(draftId, { store: this.store })
  }

  async install(request: SkillInstallRequest): Promise<InstalledSkill> {
    return installSkillDraft(request, { store: this.store })
  }
}
