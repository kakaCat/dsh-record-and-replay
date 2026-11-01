import { describe, expect, it } from 'vitest'
import { WINDOW_TARGET_FIELDS, windowTargetSchema } from '../../../src/core/contracts.js'
import { toParameterSpec } from '../../../src/plugin/index.js'

describe('plugin/tool-schema', () => {
  it('keeps every declared target property when converting to dsh-tools parameters', () => {
    const parameters = toParameterSpec({
      type: 'object',
      additionalProperties: false,
      required: ['suite'],
      properties: {
        suite: { type: 'string' },
        target: windowTargetSchema('Override the suite target.'),
      },
    })

    const target = parameters['target'] as Record<string, unknown>
    expect(target['type']).toBe('object')
    expect(target['additionalProperties']).toBe(false)
    expect(Object.keys(target['properties'] as Record<string, unknown>)).toEqual([...WINDOW_TARGET_FIELDS])
  })

  it('turns an open object into JSON instead of an empty closed object', () => {
    const parameters = toParameterSpec({
      type: 'object',
      additionalProperties: false,
      properties: {
        extensions: { type: 'object' },
        values: { type: 'object', additionalProperties: { type: 'string' } },
      },
    })

    // The old conversion produced `{type:'object', additionalProperties:false}`
    // with no properties, so dsh-tools rejected every key before the handler ran.
    expect(parameters['extensions']).toMatchObject({ type: 'json' })
    expect(parameters['values']).toMatchObject({ type: 'json' })
  })

  it('keeps explicitly closed empty objects closed', () => {
    const parameters = toParameterSpec({
      type: 'object',
      additionalProperties: false,
      properties: {
        empty: { type: 'object', additionalProperties: false, properties: {} },
      },
    })

    expect(parameters['empty']).toMatchObject({ type: 'object', additionalProperties: false })
  })
})
