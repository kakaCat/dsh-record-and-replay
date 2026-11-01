import { describe, expect, it } from 'vitest'

import { actionUrlCandidates, isPrivateBrowserTitle, matchesDeniedUrl } from '../../../src/privacy/policy.js'

describe('privacy policy', () => {
  it('matches denied URLs case-insensitively by substring', () => {
    expect(matchesDeniedUrl('https://Bank.Example/account', ['bank.example'])).toBe(true)
    expect(matchesDeniedUrl('https://example.test/', ['bank.example'])).toBe(false)
    expect(matchesDeniedUrl(undefined, ['bank.example'])).toBe(false)
    expect(matchesDeniedUrl('https://example.test/', [])).toBe(false)
  })

  it('collects URLs from navigate, targets, drags, waits and assertions', () => {
    expect(actionUrlCandidates({ kind: 'navigate', url: 'https://a.test/x' })).toEqual(['https://a.test/x'])
    expect(actionUrlCandidates({
      kind: 'click',
      target: { url: { origin: 'https://a.test', path: '/p' }, role: 'button' },
    })).toEqual(['https://a.test', '/p', 'https://a.test/p'])
    expect(actionUrlCandidates({
      kind: 'drag',
      from: { url: { origin: 'https://a.test' } },
      to: { url: { path: '/drop' } },
    })).toEqual(['https://a.test', '/drop'])
    expect(actionUrlCandidates({
      kind: 'wait',
      condition: { kind: 'url', url: 'https://a.test/done' },
      timeoutMs: 1000,
    })).toEqual(['https://a.test/done'])
    expect(actionUrlCandidates({
      kind: 'assert',
      check: { kind: 'url', contains: '/settings' },
    })).toEqual(['/settings'])
    expect(actionUrlCandidates({ kind: 'scroll', deltaX: 0, deltaY: 10 })).toEqual([])
  })

  it('recognizes browser private-window titles without flagging ordinary pages', () => {
    for (const title of [
      'New Tab - Incognito',
      'New Tab - InPrivate',
      'Start Page — Private Browsing',
      'New Private Window',
      'New Tab - Private',
      '新标签页 - 无痕浏览',
      '私密浏览',
    ]) {
      expect(isPrivateBrowserTitle(title)).toBe(true)
    }
    for (const title of [
      'Private Equity - Wikipedia',
      'New Tab',
      'Bank of Example - Sign in',
      '私密数据平台',
    ]) {
      expect(isPrivateBrowserTitle(title)).toBe(false)
    }
    expect(isPrivateBrowserTitle(undefined)).toBe(false)
  })
})
