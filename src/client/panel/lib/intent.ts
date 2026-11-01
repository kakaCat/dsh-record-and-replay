/**
 * Intent text resolution for the record/replay panel.
 *
 * Every recording may carry a user requirement / use-case description. Older
 * recordings do not: the panel then shows only an explicit "intent missing"
 * prompt. It must never fall back to the recording title, because the title is
 * already shown in the detail header — repeating it under "用例意图" made the
 * two fields look like duplicate content.
 */

export interface IntentRecording {
  readonly title: string
  readonly intent?: string
  readonly intentSource?: 'manifest' | 'index'
}

export interface ResolvedIntent {
  /** Intent text when present; otherwise an empty string. */
  readonly text: string
  /** True when the recording has no intent at all. */
  readonly missing: boolean
  readonly source?: 'manifest' | 'index'
}

/** Resolve the text a panel block shows for one recording. */
export function resolveIntent(recording: IntentRecording): ResolvedIntent {
  if (recording.intent !== undefined && recording.intent.trim().length > 0) {
    return {
      text: recording.intent,
      missing: false,
      ...(recording.intentSource === undefined ? {} : { source: recording.intentSource }),
    }
  }
  return { text: '', missing: true }
}

/** Whether the intent is long enough to need an expand/collapse control. */
export function needsIntentToggle(text: string): boolean {
  return text.length > 140 || text.includes('\n')
}
