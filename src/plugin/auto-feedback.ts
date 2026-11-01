import type { RunSummary } from '../host/service.js'
import type { SkillFeedback, SkillIndexEntry } from '../skill/model.js'

export interface AutoFeedbackOptions {
  readonly run: RunSummary
  /** False when the skill feature or `skill.autoFeedback` is off. */
  readonly enabled: boolean
  readonly listSkills: () => Promise<readonly SkillIndexEntry[]>
  readonly feedback: (feedback: SkillFeedback) => Promise<unknown>
  readonly now?: () => string
}

/**
 * Feed a terminal replay run back into every installed skill distilled from
 * that recording. Idempotency is owned by the feedback ledger (`runId`), so a
 * repeated call is harmless. Cancelled runs are ignored.
 */
export async function applyAutoFeedback(options: AutoFeedbackOptions): Promise<readonly string[]> {
  if (!options.enabled) return []
  if (options.run.status !== 'completed' && options.run.status !== 'failed') return []

  const entries = await options.listSkills()
  const matched = entries.filter(entry => entry.sourceRecordingIds.includes(options.run.recordingId))
  const now = options.now ?? (() => new Date().toISOString())
  const applied: string[] = []
  for (const entry of matched) {
    await options.feedback({
      runId: options.run.runId,
      recordingId: options.run.recordingId,
      skillName: entry.name,
      result: options.run.status === 'completed' ? 'success' : 'failed',
      ...(options.run.failedStepId === undefined ? {} : { failedStepId: options.run.failedStepId }),
      at: now(),
    })
    applied.push(entry.name)
  }
  return applied
}
