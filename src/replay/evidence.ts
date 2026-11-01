import type { PublicError, StepId } from '../core/api.js'

/** 失败证据 JSON（写入 runs/<runId>/evidence/step-N/error.json）。 */
export interface FailureEvidence {
  readonly stepId: StepId
  readonly url?: string
  readonly error: PublicError
}

export function failureEvidenceJson(input: FailureEvidence): string {
  return `${JSON.stringify(input, null, 2)}\n`
}
