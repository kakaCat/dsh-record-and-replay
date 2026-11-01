/**
 * Model-assisted Skill drafting (P1-2): the port the generator calls and the
 * prompt library it uses.
 *
 * The deterministic generator remains the source of truth for steps, targets,
 * inputs, verification and provenance. A model may only enrich the natural
 * language surface (summary, preconditions, ambiguities); its output is parsed
 * strictly and never replaces the evidence-derived structure.
 */
export type SkillDraftMode = 'template' | 'model'

export interface SkillModelRequest {
  readonly prompt: string
  readonly system?: string
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}

/** Host-provided one-shot completion port; `id` is recorded in provenance. */
export interface SkillModelPort {
  readonly id: string
  complete(request: SkillModelRequest): Promise<string>
}

export interface DraftEnrichment {
  readonly summary?: string
  readonly preconditions?: readonly string[]
  readonly ambiguities?: readonly string[]
  /** Compact factual memory for `_drafts/<draftId>/memory.md`. */
  readonly memory?: string
}

export interface SkillPrompt {
  readonly id: string
  readonly title: string
  readonly text: string
}

/**
 * Prompt identifiers recovered from the reference Record & Replay implementation.
 * The drafting prompt below is the one this plugin actually calls; the rest are
 * kept for host/CLI callers that want the same review vocabulary.
 */
export const SKILL_PROMPTS: readonly SkillPrompt[] = [
  {
    id: 'describe-activity',
    title: 'Describe Activity',
    text: 'Read {{EVENT_STREAM_PATH}} and summarize the observed workflow and likely goal. Use only recorded evidence and call out ambiguity.',
  },
  {
    id: 'suggest-next-actions',
    title: 'Suggest Next Actions',
    text: 'Read {{EVENT_STREAM_PATH}} and return at most three concrete next actions supported by the recording.',
  },
  {
    id: 'draft-memory',
    title: 'Create Memory MD',
    text: 'Read {{EVENT_STREAM_PATH}} and write a compact factual memory to {{EVENT_STREAM_DIRECTORY}}/memory.md. Exclude secrets and raw JSON.',
  },
  {
    id: 'draft-replay-plan',
    title: 'Draft Replay Plan',
    text: 'Read {{EVENT_STREAM_PATH}} and draft prerequisites, reliable replay steps, verification, and ambiguities. Prefer semantic tools over coordinates.',
  },
  {
    id: 'create-replay-skill',
    title: 'Create Replay Skill',
    text: 'Read {{EVENT_STREAM_PATH}} and write a reusable workflow draft to {{EVENT_STREAM_DIRECTORY}}/record-and-replay-skill.md with Summary, Preconditions, Replay Steps, Verification, and Ambiguities.',
  },
]

export function skillPromptById(id: string): SkillPrompt {
  const prompt = SKILL_PROMPTS.find(candidate => candidate.id === id)
  if (prompt === undefined) throw new Error(`unknown Skill prompt: ${id}`)
  return prompt
}

export function renderSkillPrompt(
  prompt: SkillPrompt,
  input: { readonly eventsPath: string; readonly currentDate?: Date },
): string {
  const directory = input.eventsPath.replace(/[\\/][^\\/]*$/u, '')
  return prompt.text
    .replaceAll('{{EVENT_STREAM_PATH}}', input.eventsPath)
    .replaceAll('{{EVENT_STREAM_DIRECTORY}}', directory)
    .replaceAll('{{CURRENT_DATE}}', (input.currentDate ?? new Date()).toISOString().slice(0, 10))
}

export interface DraftPromptInput {
  readonly title: string
  readonly site: string
  readonly steps: readonly string[]
  readonly suppressedStepCount?: number
}

/** Ask for strict JSON; the caller parses and validates every field. */
export function buildDraftPrompt(input: DraftPromptInput): { system: string; prompt: string } {
  const suppressed = input.suppressedStepCount === undefined || input.suppressedStepCount === 0
    ? ''
    : `\nNote: ${String(input.suppressedStepCount)} step(s) were suppressed by the URL privacy policy and are not listed.\n`
  return {
    system:
      'You draft reviewable browser-automation Skill notes from recorded evidence. ' +
      'Return one JSON object only, with no code fences and no prose outside it. ' +
      'Never invent URLs, credentials, secrets, or pointer coordinates. ' +
      'If the evidence is ambiguous, say so in the ambiguities array.',
    prompt: [
      `Workflow title: ${input.title}`,
      `Site: ${input.site}`,
      'Recorded successful steps:',
      ...input.steps.map((step, index) => `${String(index + 1)}. ${step}`),
      suppressed.trim(),
      'Return JSON with this exact shape:',
      '{"summary": "one paragraph describing the workflow and its goal", "preconditions": ["short condition", "..."], "ambiguities": ["short ambiguity", "..."], "memory": "compact factual memory of the workflow"}',
      'Keep the summary under 500 characters. Keep each array item under 300 characters and at most 8 items. Keep memory under 4000 characters and omit credentials or personal data.',
    ].join('\n'),
  }
}

/** Parse the model reply; returns undefined when it is not the requested JSON. */
export function parseDraftEnrichment(text: string): DraftEnrichment | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const summary = typeof record['summary'] === 'string' ? record['summary'].trim() : undefined
  const memory = typeof record['memory'] === 'string' ? record['memory'].trim() : undefined
  const preconditions = stringArray(record['preconditions'])
  const ambiguities = stringArray(record['ambiguities'])
  return {
    ...(summary === undefined || summary.length === 0 || summary.length > 500 ? {} : { summary }),
    ...(memory === undefined || memory.length === 0 || memory.length > 4000 ? {} : { memory }),
    ...(preconditions === undefined ? {} : { preconditions }),
    ...(ambiguities === undefined ? {} : { ambiguities }),
  }
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0 && item.length <= 300)
    .slice(0, 8)
  return items.length === 0 ? undefined : items
}
