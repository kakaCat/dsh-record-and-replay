import { stat } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION,
  type BrowserAction,
  type RecordingId,
  type RunId,
  type StepId,
} from '../../../src/core/api.js'
import type { ProjectedStep } from '../../../src/recording/index.js'
import type { RunRecord } from '../../../src/replay/api.js'
import { SKILL_REQUIRED_SECTIONS } from '../../../src/skill/model.js'
import { inspectSkillMarkdown } from '../../../src/skill/security.js'
import { FsSkillStore } from '../../../src/skill/store.js'
import {
  generateSkillDraft,
  type SkillGenerationSource,
  type SkillRecordingEvidence,
} from '../../../src/skill/generator.js'
import type { RecordingStatus } from '../../../src/store/api.js'
import type { SkillModelPort } from '../../../src/skill/drafting.js'

const RECORDING_ID = 'rec_demo' as RecordingId
const RUN_ID = 'run_demo' as RunId
const SHA256 = 'a'.repeat(64)

function projectedStep(seq: number, action: BrowserAction): ProjectedStep {
  return {
    stepId: `step_${String(seq)}` as StepId,
    seq,
    callId: `call_${String(seq)}`,
    origin: 'agent',
    actionKind: action.kind,
    action,
    status: 'success',
    startedAt: 1_000 + seq,
    finishedAt: 1_050 + seq,
    durationMs: 50,
  }
}

/** 典型 fixture：navigate（带 query + 明文值）+ setValue（记录里残留 Alice）+ click。 */
const FORM_STEPS: readonly ProjectedStep[] = [
  projectedStep(1, { kind: 'navigate', url: 'http://127.0.0.1:4173/form.html?session=alice' }),
  projectedStep(2, {
    kind: 'setValue',
    target: { role: 'textbox', name: 'Full name' },
    value: 'Alice',
  }),
  projectedStep(3, { kind: 'click', target: { role: 'button', name: 'Submit' } }),
]

function recording(
  overrides: {
    readonly status?: RecordingStatus
    readonly sha256?: string | null
    readonly steps?: readonly ProjectedStep[]
    readonly title?: string
    readonly suppressedStepCount?: number
  } = {},
): SkillRecordingEvidence {
  const base = {
    recordingId: RECORDING_ID,
    title: overrides.title ?? 'Example Form',
    status: overrides.status ?? 'completed',
    ...(overrides.suppressedStepCount === undefined ? {} : { suppressedStepCount: overrides.suppressedStepCount }),
    steps: overrides.steps ?? FORM_STEPS,
  }
  return overrides.sha256 === null ? base : { ...base, sha256: overrides.sha256 ?? SHA256 }
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN_ID,
    recordingId: RECORDING_ID,
    recordingSha256: SHA256,
    driver: { id: 'cua', version: '1.0.0', transport: 'native' },
    status: 'completed',
    startedAt: '2026-10-30T00:00:00.000Z',
    finishedAt: '2026-10-30T00:00:05.000Z',
    ...overrides,
  }
}

class MemorySource implements SkillGenerationSource {
  private readonly evidence: SkillRecordingEvidence | undefined
  private readonly runs: readonly RunRecord[]

  constructor(evidence: SkillRecordingEvidence | undefined, runs: readonly RunRecord[]) {
    this.evidence = evidence
    this.runs = runs
  }

  async readRecording(recordingId: RecordingId): Promise<SkillRecordingEvidence | undefined> {
    return this.evidence?.recordingId === recordingId ? this.evidence : undefined
  }

  async listRuns(): Promise<readonly RunRecord[]> {
    return this.runs
  }
}

async function storeFixture(): Promise<{ root: string; store: FsSkillStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-generator-'))
  return { root, store: new FsSkillStore({ root }) }
}

const NOW = (): Date => new Date('2026-10-30T01:00:00.000Z')

describe('generateSkillDraft', () => {
  it('generates a ready draft with all eight sections, writes it to _drafts, and never installs', async () => {
    const { root, store } = await storeFixture()
    try {
      const draft = await generateSkillDraft(
        { recordingId: RECORDING_ID },
        { source: new MemorySource(recording(), [runRecord()]), store, now: NOW },
      )

      expect(draft.status).toBe('ready')
      expect(draft.recordingId).toBe(RECORDING_ID)
      expect(draft.recordingSha256).toBe(SHA256)
      expect(draft.site).toBe('127.0.0.1:4173')
      expect(draft.draftId).toMatch(/^draft_[A-Za-z0-9_]+$/)
      for (const section of SKILL_REQUIRED_SECTIONS) {
        expect(draft.markdown).toContain(`## ${section}`)
      }
      for (const kind of ['navigate', 'setValue', 'click']) {
        expect(draft.markdown).toContain(kind)
      }
      expect(draft.markdown).toContain('## How to run')
      expect(draft.markdown).toContain('cua_record_action')

      // 不泄漏记录里的明文/掩码/坐标，且通过安全校验。
      expect(draft.markdown).not.toContain('Alice')
      expect(draft.markdown).not.toContain('********')
      expect(draft.markdown).not.toContain('session=alice')
      expect(inspectSkillMarkdown(draft.markdown)).toEqual([])

      // 草案真实落盘到 _drafts，且未写已安装目录。
      const { draft: stored, draftPath } = await store.readDraft(draft.draftId)
      expect(draftPath).toContain('_drafts')
      expect(stored.markdown).toBe(draft.markdown)
      await expect(stat(join(root, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is idempotent for the same recordingId and sha256', async () => {
    const { root, store } = await storeFixture()
    try {
      const source = new MemorySource(recording(), [runRecord()])
      const first = await generateSkillDraft({ recordingId: RECORDING_ID }, { source, store, now: NOW })
      const second = await generateSkillDraft(
        { recordingId: RECORDING_ID },
        { source, store, now: () => new Date('2026-10-31T00:00:00.000Z') },
      )
      expect(second.draftId).toBe(first.draftId)
      expect(second.markdown).toBe(first.markdown)
      expect(second.createdAt).toBe(first.createdAt)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('only writes parameter names for setValue and keeps secret references out of values', async () => {
    const { root, store } = await storeFixture()
    try {
      const steps = [
        projectedStep(1, { kind: 'navigate', url: 'http://127.0.0.1:4173/login.html' }),
        projectedStep(2, {
          kind: 'setValue',
          target: { role: 'textbox', name: 'Password' },
          value: 'hunter2',
          secretRef: 'login-password',
        }),
        projectedStep(3, { kind: 'click', target: { role: 'button', name: 'Sign in' } }),
      ]
      const draft = await generateSkillDraft(
        { recordingId: RECORDING_ID, site: 'login-app', flowName: 'sign-in' },
        { source: new MemorySource(recording({ steps }), [runRecord()]), store, now: NOW },
      )

      expect(draft.site).toBe('login-app')
      expect(draft.flow).toBe('sign-in')
      expect(draft.markdown).toContain('- `password`: string, required.')
      expect(draft.markdown).toContain('Enter the `password` value')
      expect(draft.markdown).toContain('login-password')
      expect(draft.markdown).not.toContain('hunter2')
      expect(inspectSkillMarkdown(draft.markdown)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an interrupted recording with RECORDING_INCOMPLETE and writes nothing', async () => {
    const { root, store } = await storeFixture()
    try {
      await expect(
        generateSkillDraft(
          { recordingId: RECORDING_ID },
          { source: new MemorySource(recording({ status: 'interrupted' }), [runRecord()]), store, now: NOW },
        ),
      ).rejects.toMatchObject({ code: 'RECORDING_INCOMPLETE' })
      await expect(stat(join(root, '_drafts'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects evidence without a successful run and writes nothing', async () => {
    const { root, store } = await storeFixture()
    try {
      await expect(
        generateSkillDraft(
          { recordingId: RECORDING_ID },
          {
            source: new MemorySource(recording(), [runRecord({ status: 'failed' })]),
            store,
            now: NOW,
          },
        ),
      ).rejects.toMatchObject({ code: 'SKILL_EVIDENCE_INSUFFICIENT' })
      await expect(stat(join(root, '_drafts'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a successful run whose source hash does not match', async () => {
    const { root, store } = await storeFixture()
    try {
      await expect(
        generateSkillDraft(
          { recordingId: RECORDING_ID },
          {
            source: new MemorySource(recording(), [runRecord({ recordingSha256: 'b'.repeat(64) })]),
            store,
            now: NOW,
          },
        ),
      ).rejects.toMatchObject({ code: 'SKILL_EVIDENCE_INSUFFICIENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects recordings with no steps or no steps hash', async () => {
    const { root, store } = await storeFixture()
    try {
      await expect(
        generateSkillDraft(
          { recordingId: RECORDING_ID },
          { source: new MemorySource(recording({ steps: [] }), [runRecord()]), store, now: NOW },
        ),
      ).rejects.toMatchObject({ code: 'SKILL_EVIDENCE_INSUFFICIENT' })
      await expect(
        generateSkillDraft(
          { recordingId: RECORDING_ID, site: 'example' },
          { source: new MemorySource(recording({ sha256: null, steps: [] }), []), store, now: NOW },
        ),
      ).rejects.toMatchObject({ code: 'SKILL_EVIDENCE_INSUFFICIENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records ambiguities for CSS-only targets without failing the draft', async () => {
    const { root, store } = await storeFixture()
    try {
      const steps = [
        projectedStep(1, { kind: 'navigate', url: 'http://127.0.0.1:4173/form.html' }),
        projectedStep(2, { kind: 'click', target: { css: '#submit-button' } }),
      ]
      const draft = await generateSkillDraft(
        { recordingId: RECORDING_ID },
        { source: new MemorySource(recording({ steps }), [runRecord()]), store, now: NOW },
      )
      expect(draft.status).toBe('ready')
      expect(draft.ambiguities.join('\n')).toContain('CSS selector')
      expect(draft.markdown).toContain('css="#submit-button"')
      expect(inspectSkillMarkdown(draft.markdown)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('flags suppressed steps as an ambiguity without changing the draft structure', async () => {
    const { root, store } = await storeFixture()
    try {
      const draft = await generateSkillDraft(
        { recordingId: RECORDING_ID },
        { source: new MemorySource(recording({ suppressedStepCount: 3 }), [runRecord()]), store, now: NOW },
      )
      expect(draft.status).toBe('ready')
      expect(draft.ambiguities.join('\n')).toContain('3 step(s) were suppressed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets a model port enrich Summary, Preconditions and Ambiguities', async () => {
    const { root, store } = await storeFixture()
    try {
      const model: SkillModelPort = {
        id: 'test/model',
        complete: async () => JSON.stringify({
          summary: 'A model-written summary of the checkout flow.',
          preconditions: ['The cart contains one item.'],
          ambiguities: ['The payment provider may vary.'],
        }),
      }
      const draft = await generateSkillDraft(
        { recordingId: RECORDING_ID, mode: 'model' },
        { source: new MemorySource(recording(), [runRecord()]), store, model, now: NOW },
      )
      expect(draft.markdown).toContain('A model-written summary of the checkout flow.')
      expect(draft.markdown).toContain('- The cart contains one item.')
      expect(draft.ambiguities).toContain('The payment provider may vary.')
      expect(draft.markdown).toContain('natural-language sections drafted by test/model')
      expect(inspectSkillMarkdown(draft.markdown)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to the template when model mode has no port', async () => {
    const { root, store } = await storeFixture()
    try {
      const noPort = await generateSkillDraft(
        { recordingId: RECORDING_ID, mode: 'model' },
        { source: new MemorySource(recording(), [runRecord()]), store, now: NOW },
      )
      expect(noPort.ambiguities.join('\n')).toContain('no host model port is available')
      expect(noPort.markdown).toContain('Replays the')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to the template when the model reply is invalid', async () => {
    const { root, store } = await storeFixture()
    try {
      const invalid: SkillModelPort = { id: 'test/model', complete: async () => 'not json' }
      const invalidDraft = await generateSkillDraft(
        { recordingId: RECORDING_ID, mode: 'model' },
        { source: new MemorySource(recording(), [runRecord()]), store, model: invalid, now: NOW },
      )
      expect(invalidDraft.ambiguities.join('\n')).toContain('Model drafting failed')
      expect(invalidDraft.markdown).toContain('Replays the')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps template and model drafts of the same recording side by side', async () => {
    const { root, store } = await storeFixture()
    try {
      const template = await generateSkillDraft(
        { recordingId: RECORDING_ID },
        { source: new MemorySource(recording(), [runRecord()]), store, now: NOW },
      )
      const model: SkillModelPort = {
        id: 'test/model',
        complete: async () => JSON.stringify({ summary: 'Model summary.' }),
      }
      const modelled = await generateSkillDraft(
        { recordingId: RECORDING_ID, mode: 'model' },
        { source: new MemorySource(recording(), [runRecord()]), store, model, now: NOW },
      )
      expect(modelled.draftId).not.toBe(template.draftId)
      expect(modelled.draftId.endsWith('_model')).toBe(true)
      expect((await store.readDraft(template.draftId)).draft.status).toBe('ready')
      expect((await store.readDraft(modelled.draftId)).draft.markdown).toContain('Model summary.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a model reply that introduces a plaintext secret', async () => {
    const { root, store } = await storeFixture()
    try {
      const model: SkillModelPort = {
        id: 'test/model',
        complete: async () => JSON.stringify({ summary: 'password: hunter2' }),
      }
      const draft = await generateSkillDraft(
        { recordingId: RECORDING_ID, mode: 'model' },
        { source: new MemorySource(recording(), [runRecord()]), store, model, now: NOW },
      )
      expect(draft.ambiguities.join('\n')).toContain('failed the secret or pointer-safety check')
      expect(draft.markdown).not.toContain('hunter2')
      expect(inspectSkillMarkdown(draft.markdown)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('includes provenance for the recording and the successful run', async () => {
    const { root, store } = await storeFixture()
    try {
      const draft = await generateSkillDraft(
        { recordingId: RECORDING_ID },
        { source: new MemorySource(recording(), [runRecord()]), store, now: NOW },
      )
      expect(draft.markdown).toContain(`- Recording: \`${RECORDING_ID}\` (steps sha256 \`${SHA256}\`).`)
      expect(draft.markdown).toContain(`- Run: \`${RUN_ID}\` (completed at 2026-10-30T00:00:05.000Z).`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
