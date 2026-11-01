import { describe, expect, it } from 'vitest'
import {
  ACTION_KINDS,
  ACTION_SPECS,
  ASSERT_CHECK_KINDS,
  ASSERT_CHECK_SPECS,
  CUA_BROWSER_ACTION_KINDS,
  CUA_DESKTOP_ACTION_KINDS,
  CUA_LOCATOR_FIELDS,
  LAUNCH_MODES,
  TARGET_FIELDS,
  TARGET_FIELD_SCHEMAS,
  TARGET_URL_FIELDS,
  WINDOW_TARGET_FIELDS,
  actionFieldNames,
  actionSchema,
  assertCheckFieldNames,
  assertCheckSchema,
  isLaunchMode,
  isProfileName,
  launchModeSchema,
  targetSchema,
  targetUrlSchema,
  windowTargetSchema,
} from '../../../src/core/contracts.js'
import { BROWSER_ACTION_KINDS } from '../../../src/core/api.js'
import { CuaBrowserDriver } from '../../../src/cua/browser-driver.js'

type SchemaObject = Record<string, unknown>

function propertiesOf(schema: unknown): Record<string, unknown> {
  return (schema as SchemaObject)['properties'] as Record<string, unknown>
}

function oneOfOf(schema: unknown): SchemaObject[] {
  return (schema as SchemaObject)['oneOf'] as SchemaObject[]
}

describe('core/contracts', () => {
  it('defines launch modes once and derives the schema enum from it', () => {
    expect([...LAUNCH_MODES]).toEqual(['existing', 'isolated', 'desktop'])
    expect(isLaunchMode('desktop')).toBe(true)
    expect(isLaunchMode('desktop ')).toBe(false)
    expect(isLaunchMode(undefined)).toBe(false)

    expect((launchModeSchema('pick one') as SchemaObject)['enum']).toEqual([...LAUNCH_MODES])
    expect((launchModeSchema('pick one') as SchemaObject)['default']).toBe('existing')
  })

  it('derives the locator schema and key list from one field map', () => {
    expect(Object.keys(propertiesOf(targetSchema()))).toEqual([...TARGET_FIELDS])
    expect([...TARGET_FIELDS]).toEqual(['url', 'role', 'name', 'text', 'index', 'css', 'extensions'])
    expect(TARGET_FIELDS).toEqual(Object.keys(TARGET_FIELD_SCHEMAS))
    expect(Object.keys(propertiesOf(targetUrlSchema()))).toEqual([...TARGET_URL_FIELDS])
    expect([...TARGET_URL_FIELDS]).toEqual(['origin', 'path'])
  })

  it('derives the window target schema shared by bind/replay/suite/test-run', () => {
    const schema = windowTargetSchema('override') as SchemaObject
    expect(schema['type']).toBe('object')
    expect(schema['additionalProperties']).toBe(false)
    expect(Object.keys(propertiesOf(schema))).toEqual([...WINDOW_TARGET_FIELDS])
    expect([...WINDOW_TARGET_FIELDS]).toEqual(['launch', 'pid', 'windowId', 'profileName'])
    expect((propertiesOf(schema)['launch'] as SchemaObject)['enum']).toEqual([...LAUNCH_MODES])
  })

  it('derives the action schema and strict key list from ACTION_SPECS', () => {
    expect([...ACTION_KINDS]).toEqual([
      'navigate',
      'click',
      'setValue',
      'drag',
      'scroll',
      'key',
      'wait',
      'assert',
    ])
    expect([...BROWSER_ACTION_KINDS]).toEqual([...ACTION_KINDS])

    const variants = oneOfOf(actionSchema())
    expect(variants).toHaveLength(ACTION_KINDS.length)
    for (const [index, kind] of ACTION_KINDS.entries()) {
      const variant = variants[index] as SchemaObject
      const properties = propertiesOf(variant)
      expect((properties['kind'] as SchemaObject)['const']).toBe(kind)
      expect((variant['required'] as readonly string[]).includes('kind')).toBe(true)
      expect(Object.keys(properties)).toEqual(actionFieldNames(kind))
      expect(Object.keys(properties)).toEqual(Object.keys(ACTION_SPECS[kind].fields))
    }
  })

  it('derives assert-check schema and key list from one spec map', () => {
    expect([...ASSERT_CHECK_KINDS]).toEqual(['url', 'text', 'element', 'value'])
    const variants = oneOfOf(assertCheckSchema())
    for (const [index, kind] of ASSERT_CHECK_KINDS.entries()) {
      const variant = variants[index] as SchemaObject
      expect((propertiesOf(variant)['kind'] as SchemaObject)['const']).toBe(kind)
      expect(Object.keys(propertiesOf(variant))).toEqual(assertCheckFieldNames(kind))
      expect(Object.keys(propertiesOf(variant))).toEqual(Object.keys(ASSERT_CHECK_SPECS[kind].fields))
    }
  })

  it('advertises exactly the Cua browser actions derived from ACTION_SPECS', () => {
    expect([...CUA_BROWSER_ACTION_KINDS]).toEqual(['navigate', 'click', 'setValue', 'drag', 'scroll', 'assert'])
    for (const kind of CUA_BROWSER_ACTION_KINDS) expect(ACTION_KINDS).toContain(kind)
    expect(CUA_BROWSER_ACTION_KINDS).not.toContain('wait')
    expect(CUA_BROWSER_ACTION_KINDS).not.toContain('key')
  })

  it('keeps the browser driver capability table on the shared constants', async () => {
    const driver = new CuaBrowserDriver({
      callTool: async () => ({ isError: false, content: [] }),
    })
    const capabilities = await driver.capabilities()
    expect(capabilities.actions).toEqual(CUA_BROWSER_ACTION_KINDS)
    expect(capabilities.locators).toEqual(CUA_LOCATOR_FIELDS)
  })

  it('advertises the desktop capability table separately (key yes, navigate/no wait)', async () => {
    expect([...CUA_DESKTOP_ACTION_KINDS]).toEqual(['click', 'setValue', 'drag', 'scroll', 'key', 'assert'])
    const driver = new CuaBrowserDriver({
      callTool: async () => ({ isError: false, content: [] }),
    })
    const desktop = await driver.capabilities('desktop')
    expect(desktop.actions).toEqual(CUA_DESKTOP_ACTION_KINDS)
    expect(desktop.actions).toContain('key')
    expect(desktop.actions).not.toContain('navigate')
    expect(desktop.actions).not.toContain('wait')
    expect((await driver.capabilities('isolated')).actions).toEqual(CUA_BROWSER_ACTION_KINDS)
  })

  it('validates profile names with the same pattern used in the schema', () => {
    expect(isProfileName('dsh-main_1.2-3')).toBe(true)
    expect(isProfileName('')).toBe(false)
    expect(isProfileName('a'.repeat(65))).toBe(false)
    expect(isProfileName('bad name')).toBe(false)
  })
})
