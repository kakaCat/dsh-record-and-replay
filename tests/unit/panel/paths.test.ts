import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { PanelError } from '../../../src/panel/errors.js'
import {
  assertContained,
  assertSafeRecordingId,
  assertSafeRunId,
  categoryIdForSite,
  isContained,
  isRecordingId,
  isRunId,
  siteDisplayName,
  siteFromHost,
  siteFromTitle,
  siteFromUrl,
} from '../../../src/panel/paths.js'

describe('panel path discipline', () => {
  it('derives a site token from a URL host', () => {
    expect(siteFromHost('search.bilibili.com')).toBe('bilibili')
    expect(siteFromHost('www.saucedemo.com')).toBe('saucedemo')
    expect(siteFromHost('zh.wikipedia.org')).toBe('wikipedia')
    expect(siteFromHost('shop.example.co.uk')).toBe('example')
    expect(siteFromHost('127.0.0.1')).toBe('127.0.0.1')
    expect(siteFromHost('localhost')).toBe('localhost')
    expect(siteFromUrl('https://search.bilibili.com/all?keyword=x')).toBe('bilibili')
    expect(siteFromUrl('about:blank')).toBeUndefined()
    expect(categoryIdForSite('B站')).toBe('b')
    expect(categoryIdForSite('')).toBe('uncategorized')
    expect(siteDisplayName('bilibili')).toBe('B站')
    expect(siteDisplayName('saucedemo')).toBe('SauceDemo')
  })

  it('falls back to the title when a recording has no navigable URL', () => {
    expect(siteFromTitle('example.com：断言验证')).toBe('example')
    expect(siteFromTitle('desktop smoke')).toBe('desktop')
    expect(siteFromTitle('B站：进入个人空间')).toBe('uncategorized')
  })

  it('accepts only Core recording/run ids', () => {
    expect(isRecordingId('rec_abc123')).toBe(true)
    expect(isRecordingId('rec_../etc')).toBe(false)
    expect(isRecordingId('rec_')).toBe(false)
    expect(isRunId('run_abc123')).toBe(true)
    expect(isRunId('run/../../x')).toBe(false)
    expect(() => assertSafeRecordingId('rec_../../etc')).toThrowError(PanelError)
    expect(() => assertSafeRunId('run_x/y')).toThrowError(/run id/)
  })

  it('keeps resolved paths inside the project root', () => {
    const root = path.resolve('/tmp/panel-root')
    expect(isContained(root, path.join(root, '.dsh', 'record-replay'))).toBe(true)
    expect(isContained(root, path.resolve(root, '..', 'other'))).toBe(false)
    expect(assertContained(root, path.join(root, 'child'), 'test path')).toBe(path.join(root, 'child'))
    expect(() => assertContained(root, path.resolve(root, '..', 'escape'), 'test path'))
      .toThrowError(/escapes the project root/)
  })
})
