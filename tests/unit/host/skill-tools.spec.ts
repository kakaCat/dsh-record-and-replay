/**
 * Skill Host 工具单测（design/interfaces.md IF-7）：工具名稳定、参数校验、功能开关、
 * 业务错误码透传与公开 DTO 投影（不泄露本机绝对路径）。
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveHostConfig } from '../../../src/host/config.js'
import {
  SKILL_HOST_TOOL_NAMES,
  createSkillTools,
  resolveSkillToolAllowlist,
  selectToolsForFamily,
  type HostToolDefinition,
  type SkillHostToolName,
  type SkillToolPorts,
} from '../../../src/host/tools.js'
import type { SkillQuery, SkillSearchResult } from '../../../src/skill/catalog.js'
import type { SkillFeedbackReceipt } from '../../../src/skill/feedback.js'
import type { GenerateSkillDraftInput } from '../../../src/skill/generator.js'
import {
  SkillServiceError,
  type InstalledSkill,
  type SkillDraft,
  type SkillFeedback,
  type SkillIndexEntry,
} from '../../../src/skill/model.js'
import type { SkillDraftSummary, SkillInstallRequest } from '../../../src/skill/review.js'
import { callFor } from './support.js'

const enabledConfig = resolveHostConfig({ skill: { enabled: true } })
const disabledConfig = resolveHostConfig({ skill: { enabled: false } })

const draft: SkillDraft = {
  draftId: 'draft_example',
  recordingId: 'rec_example',
  recordingSha256: 'a'.repeat(64),
  site: 'example',
  flow: 'form',
  markdown: '# Skill\n',
  ambiguities: [],
  status: 'ready',
  createdAt: '2026-10-30T00:00:00.000Z',
}

const summary: SkillDraftSummary = {
  draftId: draft.draftId,
  draftPath: '/workspace/.dsh/skill-library/_drafts/draft_example/SKILL.md',
  recordingId: draft.recordingId,
  recordingSha256: draft.recordingSha256,
  site: draft.site,
  flow: draft.flow,
  status: draft.status,
  createdAt: draft.createdAt,
  summary: 'Submit the example form.',
  verification: 'Result contains Submitted.',
  ambiguities: [],
  provenance: ['Source recording rec_example.'],
  validation: {
    ok: true,
    checks: [
      { check: 'status', ok: true, detail: 'ready' },
      { check: 'required-sections', ok: true, detail: '8/8' },
      { check: 'verification', ok: true, detail: 'present' },
      { check: 'secrets', ok: true, detail: 'clean' },
      { check: 'coordinates', ok: true, detail: 'clean' },
      { check: 'ambiguities', ok: true, detail: 'none' },
    ],
    issues: [],
  },
}

const installed: InstalledSkill = {
  name: 'example-form',
  version: 1,
  path: '/workspace/.dsh/skill-library/skills/example/form/SKILL.md',
  site: 'example',
  flow: 'form',
  triggers: ['example', 'form'],
  sourceRecordings: [{ recordingId: 'rec_example', sha256: 'a'.repeat(64) }],
  successCount: 0,
  failureCount: 0,
  needsReview: false,
  status: 'active',
}

const entry: SkillIndexEntry = {
  name: installed.name,
  site: installed.site,
  flow: installed.flow,
  triggers: [...installed.triggers],
  path: installed.path,
  sourceRecordingIds: installed.sourceRecordings.map(source => source.recordingId),
  status: 'active',
}

const searchResult: SkillSearchResult = {
  entries: [entry],
  warnings: [{ path: '/workspace/.dsh/skill-library/skills/broken/SKILL.md', message: 'invalid frontmatter' }],
}

const receipt: SkillFeedbackReceipt = {
  runId: 'run_example',
  skillName: installed.name,
  successCount: 1,
  failureCount: 0,
  needsReview: false,
  lastVerified: '2026-10-30T00:00:00.000Z',
  result: 'success',
  applied: true,
  duplicate: false,
}

interface FakePorts extends SkillToolPorts {
  readonly calls: {
    readonly generate: ReturnType<typeof vi.fn>
    readonly review: ReturnType<typeof vi.fn>
    readonly install: ReturnType<typeof vi.fn>
    readonly search: ReturnType<typeof vi.fn>
    readonly load: ReturnType<typeof vi.fn>
    readonly feedback: ReturnType<typeof vi.fn>
  }
}

function fakePorts(config = enabledConfig): FakePorts {
  const calls = {
    generate: vi.fn(async (_input: GenerateSkillDraftInput) => draft),
    review: vi.fn(async (_draftId: string) => summary),
    install: vi.fn(async (_request: SkillInstallRequest) => installed),
    search: vi.fn(async (_query: SkillQuery) => searchResult),
    load: vi.fn(async (_name: string, _version: number | undefined) => ({
      skill: installed,
      frontmatter: { name: installed.name, version: installed.version },
      markdown: '---\nname: example-form\n---\n\n# Skill\n',
    })),
    feedback: vi.fn(async (_feedback: SkillFeedback) => receipt),
  }
  return {
    config,
    generate: calls.generate,
    review: calls.review,
    install: calls.install,
    search: calls.search,
    load: calls.load,
    feedback: calls.feedback,
    calls,
  }
}

function tool(tools: readonly HostToolDefinition[], name: SkillHostToolName): HostToolDefinition {
  const found = tools.find(candidate => candidate.name === name)
  if (found === undefined) throw new Error(`tool ${name} is not registered`)
  return found
}

describe('host/skill-tools', () => {
  it('registers the six stable cua_skill_* tool names and supports allowlist filtering', () => {
    const ports = fakePorts()
    expect(createSkillTools(ports).map(candidate => candidate.name)).toEqual([...SKILL_HOST_TOOL_NAMES])
    expect(createSkillTools(ports, { allow: ['cua_skill_load', 'cua_skill_search'] }).map(candidate => candidate.name))
      .toEqual(['cua_skill_search', 'cua_skill_load'])
    expect(resolveSkillToolAllowlist([])).toEqual([...SKILL_HOST_TOOL_NAMES])
    for (const name of SKILL_HOST_TOOL_NAMES) {
      expect(typeof tool(createSkillTools(ports), name).handle).toBe('function')
    }
  })

  it('keeps the skill family narrow under a cross-family tools.allow', () => {
    const ports = fakePorts()
    const all = createSkillTools(ports)
    // 空 allow = 本族全部。
    expect(selectToolsForFamily(all, []).map(tool => tool.name)).toEqual([...SKILL_HOST_TOOL_NAMES])
    // 只点名 Skill：只保留点名项。
    expect(selectToolsForFamily(all, ['cua_skill_load']).map(tool => tool.name)).toEqual(['cua_skill_load'])
    // 只点名另一族：本族 0 个（不得退化为「全部」）。
    expect(selectToolsForFamily(all, ['cua_record_query'])).toEqual([])
  })

  it('rejects unknown or internal tool names with CONFIG_INVALID', () => {
    expect(() => resolveSkillToolAllowlist(['cua_skill_unknown'])).toThrowError()
    try {
      resolveSkillToolAllowlist(['browser_click'])
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CONFIG_INVALID')
    }
  })

  it('rejects malformed arguments with INVALID_ARGUMENT before touching the port', async () => {
    const ports = fakePorts()
    const tools = createSkillTools(ports)
    const call = callFor()

    await expect(tool(tools, 'cua_skill_generate').handle({}, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_skill_generate').handle({ recordingId: 'bad' }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_skill_review').handle({ draftId: 'nope' }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_skill_install').handle({ draftId: 'draft_example' }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_skill_install').handle({ draftId: 'draft_example', decision: 'maybe' }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_skill_search').handle({ triggers: 'one' }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_skill_load').handle({ name: 'Bad Name' }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_skill_feedback').handle({ runId: 'run_example' }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(tool(tools, 'cua_skill_review').handle({ draftId: 'draft_example', extra: true }, call)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    for (const fn of Object.values(ports.calls)) expect(fn).not.toHaveBeenCalled()
  })

  it('rejects caller-supplied principal fields with FORBIDDEN', async () => {
    const tools = createSkillTools(fakePorts())
    await expect(tool(tools, 'cua_skill_review').handle({ draftId: 'draft_example', sessionId: 'session-x' }, callFor()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('returns FEATURE_DISABLED for the write tools while skill is disabled', async () => {
    const ports = fakePorts(disabledConfig)
    const tools = createSkillTools(ports)
    const call = callFor()

    await expect(tool(tools, 'cua_skill_generate').handle({ recordingId: 'rec_example' }, call))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    await expect(tool(tools, 'cua_skill_install').handle({ draftId: 'draft_example', decision: 'confirmed' }, call))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    await expect(tool(tools, 'cua_skill_feedback').handle({
      runId: 'run_example',
      recordingId: 'rec_example',
      skillName: 'example-form',
      result: 'success',
    }, call)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' })

    // 只读族在关闭期间仍可用（回滚/查询语义）。
    await expect(tool(tools, 'cua_skill_review').handle({ draftId: 'draft_example' }, call)).resolves.toBeTruthy()
    await expect(tool(tools, 'cua_skill_search').handle({}, call)).resolves.toBeTruthy()
    await expect(tool(tools, 'cua_skill_load').handle({ name: 'example-form' }, call)).resolves.toBeTruthy()
    // 写族在开关关闭时不得触达应用端口。
    expect(ports.calls.generate).not.toHaveBeenCalled()
    expect(ports.calls.install).not.toHaveBeenCalled()
    expect(ports.calls.feedback).not.toHaveBeenCalled()
  })

  it('passes SKILL_* business error codes through unchanged', async () => {
    const tools = createSkillTools(fakePorts())
    const call = callFor()

    const reviewFailure = new SkillServiceError('SKILL_DRAFT_NOT_FOUND', 'draft missing')
    const generateFailure = new SkillServiceError('RECORDING_INCOMPLETE', 'recording not completed')
    const installFailure = new SkillServiceError('SKILL_NOT_CONFIRMED', 'not confirmed')
    const loadFailure = new SkillServiceError('SKILL_NOT_FOUND', 'skill missing')
    const feedbackFailure = new SkillServiceError('SKILL_FEEDBACK_CONFLICT', 'busy')

    const ports = fakePorts()
    ports.calls.review.mockRejectedValueOnce(reviewFailure)
    ports.calls.generate.mockRejectedValueOnce(generateFailure)
    ports.calls.install.mockRejectedValueOnce(installFailure)
    ports.calls.load.mockRejectedValueOnce(loadFailure)
    ports.calls.feedback.mockRejectedValueOnce(feedbackFailure)
    const ptools = createSkillTools(ports)

    await expect(tool(ptools, 'cua_skill_review').handle({ draftId: 'draft_example' }, call))
      .rejects.toMatchObject({ code: 'SKILL_DRAFT_NOT_FOUND' })
    await expect(tool(ptools, 'cua_skill_generate').handle({ recordingId: 'rec_example' }, call))
      .rejects.toMatchObject({ code: 'RECORDING_INCOMPLETE' })
    await expect(tool(ptools, 'cua_skill_install').handle({ draftId: 'draft_example', decision: 'confirmed' }, call))
      .rejects.toMatchObject({ code: 'SKILL_NOT_CONFIRMED' })
    await expect(tool(ptools, 'cua_skill_load').handle({ name: 'example-form' }, call))
      .rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
    await expect(tool(ptools, 'cua_skill_feedback').handle({
      runId: 'run_example',
      recordingId: 'rec_example',
      skillName: 'example-form',
      result: 'failed',
    }, call)).rejects.toMatchObject({ code: 'SKILL_FEEDBACK_CONFLICT' })
  })

  it('projects public DTOs and never leaks absolute workspace paths', async () => {
    const tools = createSkillTools(fakePorts())
    const call = callFor()

    const reviewed = await tool(tools, 'cua_skill_review').handle({ draftId: 'draft_example' }, call) as Record<string, unknown>
    expect(reviewed).not.toHaveProperty('draftPath')
    expect(reviewed['summary']).toBe(summary.summary)
    expect(reviewed['provenance']).toEqual(summary.provenance)

    const installedOut = await tool(tools, 'cua_skill_install').handle(
      { draftId: 'draft_example', decision: 'confirmed' },
      call,
    ) as Record<string, unknown>
    expect(installedOut).not.toHaveProperty('path')
    expect(installedOut['name']).toBe(installed.name)

    const searched = await tool(tools, 'cua_skill_search').handle({ query: 'example' }, call) as {
      entries: Array<Record<string, unknown>>
      warnings: Array<Record<string, unknown>>
    }
    expect(searched.entries[0]).not.toHaveProperty('path')
    expect(searched.warnings[0]?.['path']).toBe('skills/broken/SKILL.md')

    const loaded = await tool(tools, 'cua_skill_load').handle({ name: 'example-form', version: 1 }, call) as {
      skill: Record<string, unknown>
      frontmatter: Record<string, unknown>
      markdown: string
    }
    expect(loaded.skill).not.toHaveProperty('path')
    expect(loaded.frontmatter['version']).toBe(1)
    expect(loaded.markdown).toContain('example-form')
  })

  it('passes the validated arguments to the application ports', async () => {
    const ports = fakePorts()
    const tools = createSkillTools(ports)
    const call = callFor()

    await tool(tools, 'cua_skill_generate').handle(
      { recordingId: 'rec_example', site: 'example', flow: 'form' },
      call,
    )
    expect(ports.calls.generate).toHaveBeenCalledWith(
      { recordingId: 'rec_example', site: 'example', flowName: 'form' },
      call,
    )

    await tool(tools, 'cua_skill_generate').handle({ recordingId: 'rec_example', mode: 'model' }, call)
    expect(ports.calls.generate).toHaveBeenLastCalledWith({ recordingId: 'rec_example', mode: 'model' }, call)
    await expect(tool(tools, 'cua_skill_generate').handle({ recordingId: 'rec_example', mode: 'other' }, call))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    await tool(tools, 'cua_skill_feedback').handle({
      runId: 'run_example',
      recordingId: 'rec_example',
      skillName: 'example-form',
      result: 'failed',
      failedStepId: 'step_2',
      at: '2026-10-30T00:00:00.000Z',
    }, call)
    expect(ports.calls.feedback).toHaveBeenCalledWith({
      runId: 'run_example',
      recordingId: 'rec_example',
      skillName: 'example-form',
      result: 'failed',
      failedStepId: 'step_2',
      at: '2026-10-30T00:00:00.000Z',
    }, call)
  })
})
