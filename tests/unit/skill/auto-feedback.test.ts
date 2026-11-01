import { describe, expect, it, vi } from 'vitest'
import { applyAutoFeedback } from '../../../src/plugin/auto-feedback.js'
import type { RunSummary } from '../../../src/host/service.js'
import type { SkillFeedback, SkillIndexEntry } from '../../../src/skill/model.js'
import type { RecordingId } from '../../../src/core/api.js'

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run_1',
    recordingId: 'rec_1',
    status: 'completed',
    ownerSessionId: 'session-a',
    ...overrides,
  }
}

function entry(name: string, recordingIds: readonly RecordingId[]): SkillIndexEntry {
  return {
    name,
    site: 'example',
    flow: 'flow',
    triggers: [],
    path: `/tmp/${name}/SKILL.md`,
    sourceRecordingIds: recordingIds,
    status: 'active',
  }
}

function setup(options: { entries?: readonly SkillIndexEntry[]; enabled?: boolean } = {}) {
  const feedback = vi.fn(async (_feedback: SkillFeedback) => ({ applied: true }))
  return {
    feedback,
    options: {
      enabled: options.enabled ?? true,
      listSkills: async () => options.entries ?? [],
      feedback,
      now: () => '2026-10-31T00:00:00.000Z',
    },
  }
}

describe('plugin/auto-feedback', () => {
  it('feeds a completed run into every skill distilled from that recording', async () => {
    const { feedback, options } = setup({
      entries: [entry('a', ['rec_1']), entry('b', ['rec_2']), entry('c', ['rec_1'])],
    })

    const applied = await applyAutoFeedback({ ...options, run: run() })

    expect(applied).toEqual(['a', 'c'])
    expect(feedback).toHaveBeenCalledTimes(2)
    expect(feedback).toHaveBeenCalledWith({
      runId: 'run_1',
      recordingId: 'rec_1',
      skillName: 'a',
      result: 'success',
      at: '2026-10-31T00:00:00.000Z',
    })
  })

  it('reports a failed run with its failed step', async () => {
    const { feedback, options } = setup({ entries: [entry('a', ['rec_1'])] })

    await applyAutoFeedback({
      ...options,
      run: run({ status: 'failed', failedStepId: 'step_9' }),
    })

    expect(feedback).toHaveBeenCalledWith(expect.objectContaining({
      result: 'failed',
      failedStepId: 'step_9',
    }))
  })

  it('does nothing when disabled, non-terminal, or unrelated', async () => {
    const disabled = setup({ entries: [entry('a', ['rec_1'])], enabled: false })
    expect(await applyAutoFeedback({ ...disabled.options, run: run() })).toEqual([])
    expect(disabled.feedback).not.toHaveBeenCalled()

    const running = setup({ entries: [entry('a', ['rec_1'])] })
    expect(await applyAutoFeedback({ ...running.options, run: run({ status: 'running' }) })).toEqual([])
    expect(running.feedback).not.toHaveBeenCalled()

    const unrelated = setup({ entries: [entry('a', ['rec_other'])] })
    expect(await applyAutoFeedback({ ...unrelated.options, run: run() })).toEqual([])
    expect(unrelated.feedback).not.toHaveBeenCalled()
  })
})
