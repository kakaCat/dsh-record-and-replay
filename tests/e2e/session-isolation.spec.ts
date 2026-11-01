import { describe, expect, it } from 'vitest'
import { BrowserDriverError } from '../../src/driver/api.js'
import { TargetMutex } from '../../src/driver/mutex.js'
import { FakeBrowserDriver, fakeOperationContext } from '../../src/testing/index.js'

describe('dual session browser E2E', () => {
  it('keeps two session targets separate and rejects a concurrent same-window writer', async () => {
    const driver = new FakeBrowserDriver({ id: 'com.example.session-e2e-driver' })
    const contextA = fakeOperationContext('session-a')
    const contextB = fakeOperationContext('session-b')

    const bindingA = await driver.bind({ pid: 201, windowId: 21 }, contextA)
    const bindingB = await driver.bind({ pid: 201, windowId: 22 }, contextB)

    await driver.execute(bindingA, { kind: 'navigate', url: 'https://example.test/session-a' }, undefined, contextA)
    await driver.execute(bindingB, { kind: 'navigate', url: 'https://example.test/session-b' }, undefined, contextB)

    const observationA = await driver.observe(bindingA, contextA)
    const observationB = await driver.observe(bindingB, contextB)
    expect(observationA.url).toBe('https://example.test/session-a')
    expect(observationB.url).toBe('https://example.test/session-b')
    expect(observationA.url).not.toBe(observationB.url)

    const mutex = new TargetMutex()
    mutex.acquire(TargetMutex.key(201, 21), 'session-a')
    expect(() => mutex.acquire(TargetMutex.key(201, 21), 'session-b')).toThrowError(
      expect.objectContaining({ code: 'BROWSER_TARGET_BUSY' }),
    )
    mutex.release(TargetMutex.key(201, 21), 'session-a')

    await driver.release(bindingA)
    await driver.release(bindingB)
    expect(driver.id).not.toContain('dsh_browser')
  })

  it('surfaces structured binding errors from the fake driver', async () => {
    const driver = new FakeBrowserDriver({ id: 'com.example.session-e2e-driver' })
    await expect(driver.bind({ pid: 0, windowId: 1 }, fakeOperationContext('session-invalid'))).rejects.toBeInstanceOf(BrowserDriverError)
  })
})
