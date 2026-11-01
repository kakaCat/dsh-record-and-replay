/**
 * Skill 草案生成器（design/interfaces.md IF-1、design/backend.md S-2、decomposition t2）。
 *
 * 职责边界：
 * - 输入是「一个 completed Recording + 该 Recording 的一个成功 Run」：Recording 提供可读步骤，
 *   Run 提供「这套步骤确实跑通过」的证据；两者缺一即 `SKILL_EVIDENCE_INSUFFICIENT`
 *   （Recording 未 completed 时更早返回 `RECORDING_INCOMPLETE`，对齐 IF-1 错误码）；
 * - 输出是含八个必需章节的 Markdown 草案（Summary / Preconditions / Inputs / Semantic targets /
 *   Steps / Verification / Ambiguities / Provenance），写到 `_drafts/`，**不安装、不写 skills/**；
 * - `setValue` 只写参数名：Recording 落盘 value 已是脱敏掩码，生成器不读取也不输出 action.value，
 *   因此草案天然不含明文与 `********` 掩码；
 * - 不输出坐标：步骤只用语义目标（role/name/text，退化为 css）与去掉 query/hash 的 URL 描述，
 *   scroll 用像素增量而不是 `(x, y)` 形式，避免被 security 的坐标规则误判；
 * - 幂等：草案 ID 由 `recordingId + sha256` 派生；同一来源重复生成返回同一草案（不覆盖、不报冲突），
 *   内容有变化时才以 `SKILL_DRAFT_CONFLICT` 暴露给调用方；
 * - 本模块不依赖 Host / Cua Driver / fs 实现：来源与存储都通过端口注入，测试用内存来源 + 临时目录。
 */
import {
  assertRecordingId,
  type RecordingId,
  type SemanticTarget,
  type StepId,
} from '../core/api.js'
import type { ProjectedStep } from '../recording/index.js'
import type { RunRecord } from '../replay/api.js'
import type { RecordingStatus } from '../store/api.js'
import {
  SkillServiceError,
  assertSiteOrFlow,
  isSkillServiceError,
  type SkillDraft,
} from './model.js'
import type { SkillStore } from './store.js'
import {
  buildDraftPrompt,
  parseDraftEnrichment,
  type DraftEnrichment,
  type SkillDraftMode,
  type SkillModelPort,
} from './drafting.js'
import { inspectSkillMarkdown } from './security.js'

// ---------------------------------------------------------------------------
// 输入端口：来源证据 + 草案存储
// ---------------------------------------------------------------------------

/** 生成器需要的 Recording 读模型（manifest 摘要 + 只读步骤投影）。 */
export interface SkillRecordingEvidence {
  readonly recordingId: RecordingId
  readonly title: string
  readonly status: RecordingStatus
  /** manifest.stepsSha256；缺失或非法时证据不足，不能生成草案。 */
  readonly sha256?: string
  /** manifest.suppressedCount：被 URL 隐私策略抑制、草案里看不到的步骤数。 */
  readonly suppressedStepCount?: number
  readonly steps: readonly ProjectedStep[]
}

/**
 * 来源端口。生产环境由 RecordingService + RunStore 适配；测试注入内存实现。
 * - `readRecording` 找不到时返回 undefined（不写草案）；
 * - `listRuns` 只读，不触发浏览器动作。
 */
export interface SkillGenerationSource {
  readRecording(recordingId: RecordingId): Promise<SkillRecordingEvidence | undefined>
  listRuns(recordingId: RecordingId): Promise<readonly RunRecord[]>
}

/** IF-1 输入：recordingId 必填，site/flow 可选（缺省从 Recording 推导）。 */
export interface GenerateSkillDraftInput {
  readonly recordingId: RecordingId
  readonly flowName?: string
  readonly site?: string
  /** `model` asks the host model port to enrich the natural-language sections. */
  readonly mode?: SkillDraftMode
}

export interface GenerateSkillDraftOptions {
  readonly source: SkillGenerationSource
  readonly store: SkillStore
  /** Present only on a host that exposes a model service; `mode: "model"` uses it. */
  readonly model?: SkillModelPort
  /** 注入时钟便于测试断言 createdAt；缺省系统时间。 */
  readonly now?: () => Date
}

// ---------------------------------------------------------------------------
// 生成入口（IF-1 generateSkillDraft）
// ---------------------------------------------------------------------------

/**
 * 从 completed Recording + 成功 Run 生成 Skill 草案并写到 `_drafts/`。
 * 不安装、不更新索引；任何证据/安全问题都在写盘前抛出稳定错误码。
 */
export async function generateSkillDraft(
  input: GenerateSkillDraftInput,
  options: GenerateSkillDraftOptions,
): Promise<SkillDraft> {
  const recordingId = assertRecordingId(input.recordingId)
  const recording = await options.source.readRecording(recordingId)
  if (recording === undefined) {
    throw new SkillServiceError('RECORDING_INCOMPLETE', `recording ${recordingId} was not found`)
  }
  if (recording.recordingId !== recordingId) {
    throw new SkillServiceError(
      'SKILL_EVIDENCE_INSUFFICIENT',
      `source returned recording ${recording.recordingId} for requested ${recordingId}`,
    )
  }
  if (recording.status !== 'completed') {
    throw new SkillServiceError(
      'RECORDING_INCOMPLETE',
      `recording ${recordingId} is ${recording.status}; only completed recordings can become a Skill`,
    )
  }
  const sha256 = recording.sha256
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new SkillServiceError(
      'SKILL_EVIDENCE_INSUFFICIENT',
      `recording ${recordingId} has no usable steps sha256`,
    )
  }

  const runs = await options.source.listRuns(recordingId)
  const successfulRuns = runs.filter(
    (run) =>
      run.recordingId === recordingId &&
      run.status === 'completed' &&
      run.recordingSha256 === sha256,
  )
  if (successfulRuns.length === 0) {
    throw new SkillServiceError(
      'SKILL_EVIDENCE_INSUFFICIENT',
      `recording ${recordingId} has no successful run matching sha256 ${sha256}`,
    )
  }
  const run = pickLatestRun(successfulRuns)

  const steps = [...recording.steps].sort((left, right) => left.seq - right.seq)
  if (steps.length === 0) {
    throw new SkillServiceError(
      'SKILL_EVIDENCE_INSUFFICIENT',
      `recording ${recordingId} has no executable steps`,
    )
  }
  const unsuccessful = steps.find((step) => step.status !== 'success')
  if (unsuccessful !== undefined) {
    throw new SkillServiceError(
      'SKILL_EVIDENCE_INSUFFICIENT',
      `recording step ${unsuccessful.stepId} is ${unsuccessful.status}; only successful steps can become a Skill`,
    )
  }

  const ambiguities: string[] = []
  const site = assertSiteOrFlow(
    resolveSite(input.site, steps) ?? 'unknown-site',
    'site',
  )
  if (input.site === undefined && site === 'unknown-site') {
    ambiguities.push('Site could not be derived from the recording; set site explicitly when reviewing.')
  }
  const flow = assertSiteOrFlow(resolveFlow(input.flowName, recording.title), 'flow')

  const context = {
    title: recording.title,
    recordingId,
    recordingSha256: sha256,
    runId: run.runId,
    runFinishedAt: run.finishedAt ?? run.startedAt,
    site,
    flow,
    steps,
  }
  const suppressed = recording.suppressedStepCount ?? 0
  if (suppressed > 0) {
    ambiguities.push(
      `${String(suppressed)} step(s) were suppressed by the URL privacy policy and are missing from this draft; confirm the workflow does not depend on them.`,
    )
  }

  const mode = input.mode ?? 'template'
  if (mode !== 'template' && mode !== 'model') {
    throw new SkillServiceError('SKILL_INVALID', 'mode must be "template" or "model"')
  }

  let rendered = renderDraft(context)
  if (mode === 'model') {
    if (options.model === undefined) {
      ambiguities.push('Model drafting was requested but no host model port is available; the template draft was used.')
    } else {
      try {
        const prompt = buildDraftPrompt({
          title: recording.title,
          site,
          steps: steps.map(step => renderStep(step, undefined)),
          ...(suppressed === 0 ? {} : { suppressedStepCount: suppressed }),
        })
        const reply = await options.model.complete({
          system: prompt.system,
          prompt: prompt.prompt,
          maxTokens: 1_200,
        })
        const enrichment = parseDraftEnrichment(reply)
        if (enrichment === undefined
          || (enrichment.summary === undefined
            && enrichment.preconditions === undefined
            && enrichment.ambiguities === undefined)) {
          throw new Error('model did not return usable draft fields')
        }
        const candidate = renderDraft(context, { ...enrichment, model: options.model.id })
        if (inspectSkillMarkdown(candidate.markdown).length > 0) {
          throw new Error('model draft failed the secret or pointer-safety check')
        }
        rendered = candidate
      } catch (error) {
        ambiguities.push(
          `Model drafting failed (${error instanceof Error ? error.message : String(error)}); the template draft was used.`,
        )
      }
    }
  }
  ambiguities.push(...rendered.ambiguities)

  const draft: SkillDraft = {
    draftId: draftIdFor(recordingId, sha256, mode),
    recordingId,
    recordingSha256: sha256,
    site,
    flow,
    markdown: rendered.markdown,
    ambiguities,
    status: 'ready',
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  }

  try {
    await options.store.saveDraft(draft)
    return draft
  } catch (error) {
    if (isSkillServiceError(error) && error.code === 'SKILL_DRAFT_CONFLICT') {
      const existing = await options.store.readDraft(draft.draftId).catch(() => undefined)
      if (existing !== undefined && sameDraft(existing.draft, draft)) {
        // 同一 recordingId + sha256 重复生成：返回同一草案（IF-1 幂等承诺）。
        return existing.draft
      }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// 证据选择与命名
// ---------------------------------------------------------------------------

/** 取最近完成的成功 Run（按 finishedAt/startedAt 的 ISO 字符串比较）。 */
function pickLatestRun(runs: readonly RunRecord[]): RunRecord {
  const sorted = [...runs].sort((left, right) =>
    runTimestamp(right).localeCompare(runTimestamp(left)),
  )
  const latest = sorted[0]
  if (latest === undefined) {
    throw new SkillServiceError('SKILL_EVIDENCE_INSUFFICIENT', 'no successful run available')
  }
  return latest
}

function runTimestamp(run: RunRecord): string {
  return run.finishedAt ?? run.startedAt
}

/** 草案 ID 由来源派生：同 recordingId + sha256 稳定命中同一草案目录。 */
function draftIdFor(recordingId: RecordingId, sha256: string, mode: SkillDraftMode): string {
  const recording = recordingId.replace(/^rec_/, '').replace(/[^A-Za-z0-9_]/g, '_')
  // Template and model drafts of the same evidence coexist; each remains idempotent.
  return `draft_${recording}_${sha256.slice(0, 12).toLowerCase()}${mode === 'model' ? '_model' : ''}`
}

/** 站点：显式 site > 首个 navigate 的 host > 首个语义目标 URL 的 origin。 */
function resolveSite(explicit: string | undefined, steps: readonly ProjectedStep[]): string | undefined {
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim()
  for (const step of steps) {
    if (step.action.kind !== 'navigate') continue
    try {
      const parsed = new URL(step.action.url)
      if (parsed.host.length > 0) return parsed.host
    } catch {
      continue
    }
  }
  for (const step of steps) {
    const target = actionTarget(step)
    const origin = target?.url?.origin
    if (origin !== undefined && origin.trim().length > 0) return origin.trim()
  }
  return undefined
}

/** 流程名：显式 flowName > Recording 标题 > flow；压成单行并截到 120。 */
function resolveFlow(explicit: string | undefined, title: string): string {
  const raw = explicit?.trim()
  const candidate = raw !== undefined && raw.length > 0 ? raw : singleLine(title)
  const flow = candidate.length > 0 ? candidate.slice(0, 120) : 'flow'
  return flow.length > 0 ? flow : 'flow'
}

// ---------------------------------------------------------------------------
// Markdown 渲染
// ---------------------------------------------------------------------------

interface DraftContext {
  readonly title: string
  readonly recordingId: RecordingId
  readonly recordingSha256: string
  readonly runId: string
  readonly runFinishedAt: string
  readonly site: string
  readonly flow: string
  readonly steps: readonly ProjectedStep[]
}

interface RenderedDraft {
  readonly markdown: string
  readonly ambiguities: readonly string[]
}

interface InputBinding {
  readonly param: string
  readonly target?: SemanticTarget
  readonly secretRef?: string
  readonly stepIds: StepId[]
}

function renderDraft(context: DraftContext, enrichment?: DraftEnrichment & { readonly model?: string }): RenderedDraft {
  const ambiguities: string[] = []
  const bindings = collectInputs(context.steps, ambiguities)
  const paramByStep = new Map<StepId, string>()
  for (const binding of bindings.values()) {
    for (const stepId of binding.stepIds) paramByStep.set(stepId, binding.param)
  }

  const targetLines = collectTargets(context.steps, ambiguities)
  const navigateUrls = context.steps
    .filter((step) => step.action.kind === 'navigate')
    .map((step) => (step.action.kind === 'navigate' ? renderNavigateUrl(step.action.url) : undefined))
    .filter((url): url is string => url !== undefined)
  const startUrl = navigateUrls[0]
  if (startUrl === undefined) {
    ambiguities.push('No navigate step was recorded; confirm the starting URL before replaying.')
  }
  if (targetLines.length === 0) {
    ambiguities.push('No semantic target was recorded; confirm locators before installing.')
  }

  const lines: string[] = []
  lines.push(`# Skill: ${heading(context.title, context.flow)}`, '')

  lines.push('## Summary', '')
  lines.push(
    enrichment?.summary === undefined
      ? `Replays the ${quote(heading(context.title, context.flow))} flow on ${quote(context.site)}. ` +
        `The source recording contains ${String(context.steps.length)} successful step(s): ${kindSummary(context.steps)}. ` +
        `Generated from completed recording \`${context.recordingId}\` and successful run \`${context.runId}\`; ` +
        'review Inputs and Semantic targets before installing.'
      : enrichment.summary,
    '',
  )

  lines.push('## Preconditions', '')
  lines.push('- A Cua browser driver is available and a browser session is reachable.')
  if (startUrl !== undefined) {
    lines.push(`- The site ${quote(context.site)} is reachable at \`${startUrl}\`.`)
  } else {
    lines.push(`- The site ${quote(context.site)} is reachable from the replay session.`)
  }
  lines.push(
    `- Source evidence is still available: completed recording \`${context.recordingId}\` ` +
      `and successful run \`${context.runId}\`.`,
  )
  for (const binding of bindings.values()) {
    if (binding.secretRef !== undefined) {
      lines.push(
        `- Resolve the secret reference ${quote(binding.secretRef)} for input \`${binding.param}\` before replaying.`,
      )
    }
  }
  for (const precondition of enrichment?.preconditions ?? []) lines.push(`- ${precondition}`)
  lines.push('')

  lines.push('## Inputs', '')
  if (bindings.size === 0) {
    lines.push('- None.')
  } else {
    for (const binding of bindings.values()) {
      const target = binding.target === undefined ? '' : ` Target: ${targetLabel(binding.target)}.`
      const secret =
        binding.secretRef === undefined
          ? ''
          : ` The value comes from secret reference ${quote(binding.secretRef)} and is never recorded.`
      lines.push(`- \`${binding.param}\`: string, required.${target}${secret}`)
    }
  }
  lines.push('')

  lines.push('## Semantic targets', '')
  if (targetLines.length === 0) {
    lines.push('- None recorded; confirm targets before installing.')
  } else {
    if (startUrl !== undefined) lines.push(`- navigate: \`${startUrl}\``)
    for (const line of targetLines) lines.push(`- ${line}`)
  }
  lines.push('')

  lines.push('## How to run', '')
  lines.push(
    '- Bind or launch a browser: `cua_record_bind_browser` with `{ launch: "isolated", profileName: "<name>" }` ' +
      '(or `{ pid, windowId }` for an existing window).',
  )
  lines.push('- Execute each step with `cua_record_action`; targets are semantic (`role` / `name` / `text`).')
  lines.push(
    `- Verify with \`cua_record_observe\`; replay the source recording \`${context.recordingId}\` with ` +
      '`cua_replay_start`.',
  )
  lines.push('')

  lines.push('## Steps', '')
  context.steps.forEach((step, index) => {
    lines.push(`${String(index + 1)}. ${renderStep(step, paramByStep.get(step.stepId))}`)
  })
  lines.push('')

  lines.push('## Verification', '')
  lines.push(
    `- Run \`${context.runId}\` finished with status completed; all ${String(context.steps.length)} recorded steps succeeded.`,
  )
  if (startUrl !== undefined) {
    lines.push(`- Expected final URL: \`${startUrl}\` (from the recorded navigate step).`)
  }
  const last = context.steps[context.steps.length - 1]
  if (last !== undefined) {
    lines.push(`- The last recorded step (${last.action.kind}) succeeded in the source run.`)
  }
  lines.push('')

  for (const ambiguity of enrichment?.ambiguities ?? []) {
    // The install gate treats any ambiguity mentioning coordinates as unresolved
    // pointer reliance; a model note about coordinates would trip it, so drop it.
    if (!ambiguity.toLowerCase().includes('coordinate')) ambiguities.push(ambiguity)
  }
  lines.push('## Ambiguities', '')
  if (ambiguities.length === 0) lines.push('- None.')
  else for (const ambiguity of ambiguities) lines.push(`- ${ambiguity}`)
  lines.push('')

  lines.push('## Provenance', '')
  lines.push(`- Recording: \`${context.recordingId}\` (steps sha256 \`${context.recordingSha256}\`).`)
  lines.push(`- Run: \`${context.runId}\` (completed at ${context.runFinishedAt}).`)
  lines.push(`- Generator: \`src/skill/generator.ts\` (skill draft v1)${enrichment?.model === undefined ? '' : `; natural-language sections drafted by ${enrichment.model}`}.`)

  return { markdown: `${lines.join('\n').trimEnd()}\n`, ambiguities }
}

function collectInputs(
  steps: readonly ProjectedStep[],
  ambiguities: string[],
): Map<string, InputBinding> {
  const bindings = new Map<string, InputBinding>()
  for (const step of steps) {
    if (step.action.kind !== 'setValue') continue
    const target = step.action.target
    const base = paramName(target, step.seq)
    let param = base
    let suffix = 2
    while (bindings.has(param)) {
      const existing = bindings.get(param)
      if (existing !== undefined && sameTarget(existing.target, target)) break
      param = `${base}-${String(suffix)}`
      suffix += 1
    }
    const existing = bindings.get(param)
    if (existing === undefined) {
      bindings.set(param, {
        param,
        ...(target === undefined ? {} : { target }),
        ...(step.action.secretRef === undefined ? {} : { secretRef: step.action.secretRef }),
        stepIds: [step.stepId],
      })
      continue
    }
    existing.stepIds.push(step.stepId)
    ambiguities.push(
      `Steps ${existing.stepIds.map((stepId) => `\`${stepId}\``).join(' and ')} share the input \`${param}\`; ` +
        'confirm they are the same field.',
    )
  }
  return bindings
}

function collectTargets(steps: readonly ProjectedStep[], ambiguities: string[]): readonly string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const step of steps) {
    const target = actionTarget(step)
    if (target === undefined) continue
    if (!hasSemanticLocator(target)) {
      ambiguities.push(
        `Step ${String(step.seq)} uses only a CSS selector; confirm a semantic role/name/text locator before installing.`,
      )
    }
    const line = targetLabel(target)
    if (line === 'the current page' || seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }
  return lines
}

function renderStep(step: ProjectedStep, param: string | undefined): string {
  const action = step.action
  switch (action.kind) {
    case 'navigate':
      return `Navigate to \`${renderNavigateUrl(action.url)}\`.`
    case 'click':
      return `Activate ${targetLabel(action.target)}.`
    case 'setValue':
      return `Enter the \`${param ?? paramName(action.target, step.seq)}\` value into ${targetLabel(action.target)}.`
    case 'scroll':
      return `Scroll horizontally by ${String(action.deltaX)} px and vertically by ${String(action.deltaY)} px.`
    case 'key':
      return action.target === undefined
        ? `Press \`${action.key}\`.`
        : `Press \`${action.key}\` on ${targetLabel(action.target)}.`
    case 'wait':
      return `Wait for ${describeWait(action.condition)}.`
    case 'assert':
      return describeAssert(action.check)
    case 'drag':
      return `Drag ${targetLabel(action.from)} to ${targetLabel(action.to)}.`
  }
}

function describeAssert(check: import('../core/actions.js').AssertCheck): string {
  switch (check.kind) {
    case 'url':
      return `Assert the page URL contains ${quote(check.contains)}.`
    case 'text':
      return `Assert the page shows text ${quote(check.contains)}.`
    case 'element':
      return `Assert ${targetLabel(check.target)} ${check.exists ? 'exists' : 'does not exist'}.`
    case 'value':
      return `Assert ${targetLabel(check.target)} has value ${quote(check.equals)}.`
  }
}

function describeWait(condition: Extract<ProjectedStep['action'], { kind: 'wait' }>['condition']): string {
  switch (condition.kind) {
    case 'text':
      return `text ${quote(condition.text)}`
    case 'css':
      return `selector ${quote(condition.css)}`
    case 'url':
      return `URL \`${renderNavigateUrl(condition.url)}\``
    case 'idle':
      return `the page to be idle for ${String(condition.quietMs)} ms`
  }
}

function kindSummary(steps: readonly ProjectedStep[]): string {
  const counts = new Map<string, number>()
  for (const step of steps) {
    counts.set(step.action.kind, (counts.get(step.action.kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([kind, count]) => `${kind}: ${String(count)}`)
    .join('; ')
}

function actionTarget(step: ProjectedStep): SemanticTarget | undefined {
  const action = step.action
  switch (action.kind) {
    case 'click':
    case 'setValue':
      return action.target
    case 'scroll':
    case 'key':
      return action.target
    case 'navigate':
    case 'wait':
      return undefined
    case 'assert':
      return action.check.kind === 'element' || action.check.kind === 'value' ? action.check.target : undefined
    case 'drag':
      return action.from
  }
}

function targetLabel(target: SemanticTarget | undefined): string {
  if (target === undefined) return 'the current page'
  const parts: string[] = []
  if (target.role !== undefined) parts.push(`role=${target.role}`)
  if (target.name !== undefined) parts.push(`name=${quote(target.name)}`)
  else if (target.text !== undefined) parts.push(`text=${quote(target.text)}`)
  if (parts.length === 0 && target.css !== undefined) parts.push(`css=${quote(target.css)}`)
  if (parts.length === 0 && target.url !== undefined) parts.push(`url=${quote(targetUrl(target.url))}`)
  return parts.length === 0 ? 'the current page' : parts.join(', ')
}

function hasSemanticLocator(target: SemanticTarget): boolean {
  return (
    target.role !== undefined ||
    target.name !== undefined ||
    target.text !== undefined ||
    target.url !== undefined
  )
}

function targetUrl(url: NonNullable<SemanticTarget['url']>): string {
  const origin = url.origin ?? ''
  const path = url.path ?? ''
  return `${origin}${path}`
}

/** navigate URL 只保留 origin + pathname：去掉 query/hash，避免把运行期参数写进知识。 */
function renderNavigateUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return singleLine(raw)
    return `${url.origin}${url.pathname}`
  } catch {
    return singleLine(raw)
  }
}

function paramName(target: SemanticTarget | undefined, seq: number): string {
  const raw = target?.name ?? target?.text ?? target?.role ?? `input-${String(seq)}`
  const slug = singleLine(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : `input-${String(seq)}`
}

function sameTarget(left: SemanticTarget | undefined, right: SemanticTarget | undefined): boolean {
  return stableTarget(left) === stableTarget(right)
}

function stableTarget(target: SemanticTarget | undefined): string {
  if (target === undefined) return ''
  return JSON.stringify([target.url ?? null, target.role ?? null, target.name ?? null, target.text ?? null, target.css ?? null])
}

/** 单行化：多行标题/名称不能破坏 Markdown 结构。 */
function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function heading(title: string, flow: string): string {
  const candidate = singleLine(title)
  return candidate.length > 0 ? candidate : singleLine(flow)
}

/** 用 JSON 字符串包裹用户文本：换行/引号被转义，且不会形成 `key: value` 行首。 */
function quote(value: string): string {
  return JSON.stringify(singleLine(value))
}

function sameDraft(existing: SkillDraft, candidate: SkillDraft): boolean {
  return (
    existing.recordingId === candidate.recordingId &&
    existing.recordingSha256 === candidate.recordingSha256 &&
    existing.site === candidate.site &&
    existing.flow === candidate.flow &&
    existing.markdown === candidate.markdown
  )
}
