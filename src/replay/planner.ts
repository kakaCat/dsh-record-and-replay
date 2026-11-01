import type { BrowserActionKind } from '../core/api.js'
import type { ProjectedStep } from '../recording/index.js'

/** Plan 阶段判定：来源步骤是否能在当前 Driver 能力下语义重放。 */
export function unsupportedReasonForStep(
  step: ProjectedStep,
  supportedActions: ReadonlySet<BrowserActionKind>,
  values: Readonly<Record<string, string>> = {},
): string | undefined {
  const action = step.action
  if (step.status !== 'success') return `source step status is ${step.status}`
  if (!supportedActions.has(action.kind)) return `driver does not support ${action.kind}`
  if ('target' in action && action.target?.css !== undefined) return 'css-only targets are unsupported'
  if (action.kind === 'setValue' && (action.value === '********' || action.secretRef !== undefined)) {
    const provided = values[step.stepId] ?? (action.secretRef === undefined ? undefined : values[action.secretRef])
    if (provided === undefined || provided.length === 0) {
      return 'setValue requires a replay value; redacted values cannot be replayed without values[stepId]'
    }
  }
  return undefined
}
