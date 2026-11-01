import type { RecordingId, RunId } from '../core/ids.js'

/** Skill 生命周期状态。 */
export const SKILL_STATUSES = ['active', 'needs_review', 'deprecated'] as const
export type SkillStatus = (typeof SKILL_STATUSES)[number]

export const SKILL_DRAFT_STATUSES = ['ready', 'evidence_insufficient'] as const
export type SkillDraftStatus = (typeof SKILL_DRAFT_STATUSES)[number]

export const SKILL_FEEDBACK_RESULTS = ['success', 'failed', 'cancelled'] as const
export type SkillFeedbackResult = (typeof SKILL_FEEDBACK_RESULTS)[number]

/** Skill 草案必须包含的章节；缺一即不可审查/安装。 */
export const SKILL_REQUIRED_SECTIONS = [
  'Summary',
  'Preconditions',
  'Inputs',
  'Semantic targets',
  'Steps',
  'Verification',
  'Ambiguities',
  'Provenance',
] as const

export type SkillRequiredSection = (typeof SKILL_REQUIRED_SECTIONS)[number]

export interface SkillSourceRecording {
  readonly recordingId: RecordingId
  readonly sha256: string
}

/** 尚未安装的 Skill 草案。 */
export interface SkillDraft {
  readonly draftId: string
  readonly recordingId: RecordingId
  readonly recordingSha256: string
  readonly site: string
  readonly flow: string
  readonly markdown: string
  /** Optional compact memory written next to SKILL.md when model drafting produced one. */
  readonly memory?: string
  readonly ambiguities: readonly string[]
  readonly status: SkillDraftStatus
  readonly createdAt: string
}

/** 已安装 Skill 的 frontmatter 投影。 */
export interface InstalledSkill {
  readonly name: string
  readonly version: number
  readonly path: string
  readonly site: string
  readonly flow: string
  readonly triggers: readonly string[]
  readonly sourceRecordings: readonly SkillSourceRecording[]
  readonly lastVerified?: string
  readonly successCount: number
  readonly failureCount: number
  readonly needsReview: boolean
  readonly status: SkillStatus
  /** Where DSH's project skill provider can discover this skill, when published. */
  readonly projectSkillPath?: string
}

/** 搜索阶段的轻量索引条目（不加载全文）。 */
export interface SkillIndexEntry {
  readonly name: string
  readonly site: string
  readonly flow: string
  readonly triggers: readonly string[]
  readonly path: string
  /** Recordings this skill was distilled from (used for auto-feedback). */
  readonly sourceRecordingIds: readonly RecordingId[]
  readonly lastVerified?: string
  readonly status: SkillStatus
}

/** 一次 Run 对 Skill 的反馈。 */
export interface SkillFeedback {
  readonly runId: RunId
  readonly recordingId: RecordingId
  readonly skillName: string
  readonly result: SkillFeedbackResult
  readonly failedStepId?: string
  readonly at: string
}

export interface SkillFeedbackUpdate {
  readonly skillName: string
  readonly successCount: number
  readonly failureCount: number
  readonly needsReview: boolean
  readonly lastVerified?: string
}

export const SKILL_SERVICE_ONLY_CODES = [
  // design/interfaces.md IF-1：来源 Recording 未到 completed 时生成器返回的码。
  'RECORDING_INCOMPLETE',
  'SKILL_DRAFT_NOT_FOUND',
  'SKILL_NOT_FOUND',
  'SKILL_INVALID',
  'SKILL_NOT_CONFIRMED',
  'SKILL_VERSION_CONFLICT',
  'SKILL_SECRET_DETECTED',
  'SKILL_COORDINATE_ONLY',
  'SKILL_EVIDENCE_INSUFFICIENT',
  'SKILL_STORE_WRITE_FAILED',
  'SKILL_STORE_PATH_ESCAPE',
  'SKILL_DRAFT_CONFLICT',
  'SKILL_CORRUPT',
  'SKILL_INDEX_UNAVAILABLE',
  'SKILL_FEEDBACK_CONFLICT',
] as const

export type SkillServiceOnlyCode = (typeof SKILL_SERVICE_ONLY_CODES)[number]

export class SkillServiceError extends Error {
  readonly code: SkillServiceOnlyCode

  constructor(code: SkillServiceOnlyCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SkillServiceError'
    this.code = code
  }
}

export function isSkillServiceError(value: unknown): value is SkillServiceError {
  return value instanceof SkillServiceError
}

/** Skill 名：小写 kebab-case，最长 80；用于目录/索引/工具参数。 */
export function isSkillName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80
}

export function assertSkillName(value: unknown): string {
  if (!isSkillName(value)) {
    throw new SkillServiceError('SKILL_INVALID', 'skill name must be lower-case kebab-case and at most 80 characters')
  }
  return value
}

export function assertDraftId(value: unknown): string {
  if (typeof value !== 'string' || !/^draft_[A-Za-z0-9_]+$/.test(value)) {
    throw new SkillServiceError('SKILL_INVALID', 'draftId must match draft_<id>')
  }
  return value
}

export function assertSiteOrFlow(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 120) {
    throw new SkillServiceError('SKILL_INVALID', `${field} must be a non-empty string up to 120 characters`)
  }
  return value.trim()
}

/** Recording 步骤哈希：64 位十六进制。 */
export function assertRecordingSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new SkillServiceError('SKILL_INVALID', 'recordingSha256 must be a 64-character hex digest')
  }
  return value
}

/** ISO 时间戳；非法值直接拒绝，避免写入不可解析的 frontmatter。 */
export function assertIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new SkillServiceError('SKILL_INVALID', `${field} must be an ISO timestamp`)
  }
  return value
}

/** 校验草案的字段形状；安全与质量约束由 security.ts 负责。 */
export function assertSkillDraftShape(draft: SkillDraft): SkillDraft {
  assertDraftId(draft.draftId)
  if (typeof draft.recordingId !== 'string' || draft.recordingId.trim().length === 0) {
    throw new SkillServiceError('SKILL_INVALID', 'recordingId must be a non-empty string')
  }
  assertRecordingSha256(draft.recordingSha256)
  assertSiteOrFlow(draft.site, 'site')
  assertSiteOrFlow(draft.flow, 'flow')
  if (typeof draft.markdown !== 'string' || draft.markdown.trim().length === 0) {
    throw new SkillServiceError('SKILL_INVALID', 'markdown must be a non-empty string')
  }
  if (draft.memory !== undefined) {
    if (typeof draft.memory !== 'string' || draft.memory.trim().length === 0) {
      throw new SkillServiceError('SKILL_INVALID', 'memory must be a non-empty string when provided')
    }
    if (draft.memory.length > 4000) {
      throw new SkillServiceError('SKILL_INVALID', 'memory must be at most 4000 characters')
    }
  }
  if (!Array.isArray(draft.ambiguities) || draft.ambiguities.some(item => typeof item !== 'string')) {
    throw new SkillServiceError('SKILL_INVALID', 'ambiguities must be a string array')
  }
  if (!isSkillDraftStatus(draft.status)) {
    throw new SkillServiceError('SKILL_INVALID', 'status must be ready or evidence_insufficient')
  }
  assertIsoTimestamp(draft.createdAt, 'createdAt')
  return draft
}

export function isSkillDraftStatus(value: unknown): value is SkillDraftStatus {
  return typeof value === 'string' && (SKILL_DRAFT_STATUSES as readonly string[]).includes(value)
}

/** 从 site/flow 派生稳定 Skill 名；用于没有显式 name 的安装。 */
export function skillNameFor(site: string, flow: string): string {
  const slug = `${site}-${flow}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  if (slug.length === 0) {
    throw new SkillServiceError('SKILL_INVALID', 'site/flow cannot derive a valid skill name')
  }
  return slug.slice(0, 80).replace(/-+$/g, '')
}

/** 检查 Markdown 是否含全部必需章节（## 标题，大小写不敏感）。 */
export function hasRequiredSkillSections(markdown: string): boolean {
  return SKILL_REQUIRED_SECTIONS.every((section) => {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^##\\s+${escaped}\\s*$`, 'im').test(markdown)
  })
}

/** 返回缺失章节，便于审查回执。 */
export function missingSkillSections(markdown: string): readonly SkillRequiredSection[] {
  return SKILL_REQUIRED_SECTIONS.filter((section) => {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return !new RegExp(`^##\\s+${escaped}\\s*$`, 'im').test(markdown)
  })
}

export function isSkillStatus(value: unknown): value is SkillStatus {
  return typeof value === 'string' && (SKILL_STATUSES as readonly string[]).includes(value)
}

export function isSkillFeedbackResult(value: unknown): value is SkillFeedbackResult {
  return typeof value === 'string' && (SKILL_FEEDBACK_RESULTS as readonly string[]).includes(value)
}
