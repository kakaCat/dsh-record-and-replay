import { describe, expect, it } from 'vitest'

import { REDACTED_VALUE, redactJsonValue, redactStepEvent } from '../../../src/recording/redaction.js'

describe('recording redaction', () => {
  it('masks generic secret shapes inside result strings', () => {
    expect(redactJsonValue('note', 'card 4111 1111 1111 1111')).toBe('card [REDACTED_CREDIT_CARD]')
    expect(redactJsonValue('note', 'key AKIAIOSFODNN7EXAMPLE')).toBe('key [REDACTED_AWS_ACCESS_KEY]')
    expect(redactJsonValue('note', 'token sk-abcdefghijklmnopqrstuvwxyz')).toBe('token [REDACTED_API_KEY]')
  })

  it('keeps the secret-key rule and the setValue mask', () => {
    expect(redactJsonValue('password', 'hunter2')).toBe('***')
    const event = {
      type: 'step.started' as const,
      schemaVersion: 1 as const,
      stepId: 'step_x' as never,
      seq: 1,
      callId: 'call-1',
      origin: 'agent' as const,
      action: { kind: 'setValue' as const, target: { role: 'textbox' }, value: 'plain' },
      startedAt: 1,
    }
    const redacted = redactStepEvent(event)
    if (redacted.type !== 'step.started') throw new Error('expected a started event')
    expect(redacted.action).toMatchObject({ value: REDACTED_VALUE })
  })
})
