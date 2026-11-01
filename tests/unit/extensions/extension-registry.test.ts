import { describe, expect, it } from 'vitest'
import { ExtensionRegistry, ExtensionRegistryError } from '../../../src/driver/registry.js'
import { defaultRedactor } from '../../../src/recording/redaction.js'
import {
  FakeBrowserDriver,
  FakeTransport,
  MemoryRecordingStore,
  assertConformanceOk,
  runDriverContract,
  runRedactorContract,
  runStoreContract,
  runTransportContract,
} from '../../../src/testing/index.js'
import { CUA_REQUIRED_BROWSER_TOOLS } from '../../../src/cua/capabilities.js'

describe('ExtensionRegistry', () => {
  it('rejects duplicate registration with a stable code', () => {
    const registry = new ExtensionRegistry()
    const driver = new FakeBrowserDriver({ id: 'com.example.driver-a' })
    registry.register('driver', 'com.example.driver-a', driver)

    expect(() => registry.register('driver', 'com.example.driver-a', driver)).toThrowError(
      expect.objectContaining({ code: 'EXTENSION_ALREADY_REGISTERED' }),
    )
  })

  it('allows the same id in a different extension kind', () => {
    const registry = new ExtensionRegistry()
    registry.register('driver', 'com.example.same', new FakeBrowserDriver({ id: 'com.example.same' }))
    registry.register('store', 'com.example.same', new MemoryRecordingStore())
    expect(registry.list()).toHaveLength(2)
  })

  it('rejects active unload and allows disposal after use', async () => {
    const registry = new ExtensionRegistry()
    const driver = new FakeBrowserDriver({ id: 'com.example.driver-active' })
    const dispose = registry.register('driver', 'com.example.driver-active', driver)

    await registry.withActive('driver', 'com.example.driver-active', async () => {
      expect(() => dispose()).toThrowError(expect.objectContaining({ code: 'EXTENSION_IN_USE' }))
    })

    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow()
    expect(registry.get('driver', 'com.example.driver-active')).toBeUndefined()
  })

  it('rejects malformed extensions and reserved built-in ids', () => {
    const registry = new ExtensionRegistry()
    expect(() => registry.register('driver', 'com.example.bad', { id: 'bad' })).toThrowError(
      expect.objectContaining({ code: 'EXTENSION_CONTRACT_INVALID' }),
    )
    expect(() => registry.register('driver', 'dsh.reserved', new FakeBrowserDriver({ id: 'dsh.reserved' }))).toThrowError(
      expect.objectContaining({ code: 'EXTENSION_CONTRACT_INVALID' }),
    )
  })

  it('returns EXTENSION_NOT_FOUND for unknown active use', async () => {
    const registry = new ExtensionRegistry()
    await expect(registry.withActive('store', 'com.example.missing', async () => undefined)).rejects.toMatchObject({
      code: 'EXTENSION_NOT_FOUND',
    })
  })

  it('exposes registry errors with stable codes', () => {
    const error = new ExtensionRegistryError('EXTENSION_IN_USE', 'active')
    expect(error.code).toBe('EXTENSION_IN_USE')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('extension conformance suite', () => {
  it('FakeBrowserDriver passes the BrowserDriver contract', async () => {
    const result = await runDriverContract(new FakeBrowserDriver({ id: 'com.example.conformance-driver' }))
    assertConformanceOk(result)
    expect(result.ok).toBe(true)
  })

  it('FakeTransport passes the CuaTransport contract', async () => {
    const transport = new FakeTransport(CUA_REQUIRED_BROWSER_TOOLS)
    const result = await runTransportContract(transport)
    assertConformanceOk(result)
  })

  it('MemoryRecordingStore passes the RecordingStore contract', async () => {
    const result = await runStoreContract(new MemoryRecordingStore())
    assertConformanceOk(result)
  })

  it('defaultRedactor passes the Redactor contract', async () => {
    const result = await runRedactorContract(defaultRedactor)
    assertConformanceOk(result)
  })

  it('assertConformanceOk surfaces failed checks', async () => {
    const transport = new FakeTransport(['not_a_required_tool'])
    const result = await runTransportContract(transport, ['missing_tool'])
    expect(result.ok).toBe(false)
    expect(() => assertConformanceOk(result)).toThrow(/missing_tool/)
  })
})
