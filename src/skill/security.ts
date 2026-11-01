import {
  SkillServiceError,
  hasRequiredSkillSections,
  missingSkillSections,
  type SkillDraft,
} from './model.js'

export interface SkillSecurityIssue {
  readonly code: 'SKILL_INVALID' | 'SKILL_SECRET_DETECTED' | 'SKILL_COORDINATE_ONLY'
  readonly message: string
}

const SECRET_LINE = /(?:^|\n)\s*(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*([^\s#]+)/gi
const REDACTION_MASK = /\*{8,}/
const COORDINATE =
  /(?:\b(?:x|y)\s*[:=]\s*-?\d+|\bcoordinates?\b|\[\s*-?\d+\s*,\s*-?\d+\s*\]|\(\s*-?\d+\s*,\s*-?\d+\s*\))/i
const VALUE_PLACEHOLDER = /^\{\{[^{}]+\}\}$/

/** 返回所有非占位符形式的明文秘密值；占位符 `{{name}}` 合法。 */
function findPlaintextSecrets(markdown: string): readonly string[] {
  const secrets: string[] = []
  const pattern = new RegExp(SECRET_LINE.source, SECRET_LINE.flags)
  for (const match of markdown.matchAll(pattern)) {
    const value = match[1] ?? ''
    if (!VALUE_PLACEHOLDER.test(value)) secrets.push(value)
  }
  return secrets
}

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

/** 检查 Markdown 的安全与质量约束；只返回问题，不改写内容。 */
export function inspectSkillMarkdown(markdown: string): readonly SkillSecurityIssue[] {
  const issues: SkillSecurityIssue[] = []
  if (!hasRequiredSkillSections(markdown)) {
    issues.push({
      code: 'SKILL_INVALID',
      message: `missing required sections: ${missingSkillSections(markdown).join(', ')}`,
    })
  }
  const verification = sectionBody(markdown, 'Verification')
  if (verification.length === 0) {
    issues.push({ code: 'SKILL_INVALID', message: 'Verification section must not be empty' })
  }
  if (REDACTION_MASK.test(markdown)) {
    issues.push({ code: 'SKILL_SECRET_DETECTED', message: 'Skill must not contain a redaction mask' })
  }
  SECRET_LINE.lastIndex = 0
  if (findPlaintextSecrets(markdown).length > 0) {
    issues.push({ code: 'SKILL_SECRET_DETECTED', message: 'Skill appears to contain a plaintext secret' })
  }
  if (COORDINATE.test(markdown)) {
    issues.push({ code: 'SKILL_COORDINATE_ONLY', message: 'Skill must not rely on coordinates' })
  }
  return issues
}

/** 校验草案；有安全/质量问题时抛稳定错误码。 */
export function assertSafeSkillMarkdown(markdown: string): void {
  const issue = inspectSkillMarkdown(markdown)[0]
  if (issue !== undefined) throw new SkillServiceError(issue.code, issue.message)
}

/** 校验草案对象；用于生成/安装共用的门禁。 */
export function assertSafeSkillDraft(draft: SkillDraft): void {
  assertSafeSkillMarkdown(draft.markdown)
  if (draft.status !== 'ready') {
    throw new SkillServiceError('SKILL_EVIDENCE_INSUFFICIENT', 'draft is not ready for review')
  }
  if (draft.ambiguities.some((item) => item.toLowerCase().includes('coordinate'))) {
    throw new SkillServiceError('SKILL_COORDINATE_ONLY', 'draft has unresolved coordinate ambiguity')
  }
}

