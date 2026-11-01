import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST_CONFIG,
  HostError,
  assertFeatureEnabled,
  isFeatureEnabled,
  resolveHostConfig,
} from '../../../src/host/config.js'
import {
  assertNoCallerSuppliedPrincipal,
  assertSessionOwnership,
  derivePrincipal,
} from '../../../src/host/principal.js'

function codeOf(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return (error as { code?: unknown }).code
  }
  return undefined
}

describe('host/config', () => {
  it('enables recording, replay and skill by default and keeps the documented capacity defaults', () => {
    expect(DEFAULT_HOST_CONFIG.recording.enabled).toBe(true)
    expect(DEFAULT_HOST_CONFIG.replay.enabled).toBe(true)
    expect(DEFAULT_HOST_CONFIG.skill.enabled).toBe(true)
    expect(DEFAULT_HOST_CONFIG.recording.maxSteps).toBe(10_000)
    expect(DEFAULT_HOST_CONFIG.recording.maxBytes).toBe(500 * 1024 * 1024)
    expect(DEFAULT_HOST_CONFIG.recording.maxDurationSeconds).toBe(1800)
    expect(DEFAULT_HOST_CONFIG.recording.consent).toBe('implicit')
    expect(DEFAULT_HOST_CONFIG.replay.maxRuns).toBe(50)
    expect(DEFAULT_HOST_CONFIG.transport).toBe('mcp')
    expect(DEFAULT_HOST_CONFIG.transportFallback).toBe(true)
    expect(DEFAULT_HOST_CONFIG.tools.allow).toEqual([])
    expect(resolveHostConfig(undefined)).toEqual(DEFAULT_HOST_CONFIG)
    expect(resolveHostConfig({})).toEqual(DEFAULT_HOST_CONFIG)
  })

  it('accepts a fully specified configuration', () => {
    const config = resolveHostConfig({
      transport: 'native',
      transportFallback: false,
      recording: {
        enabled: true,
        rootDir: 'artifacts/recordings',
        maxSteps: 5,
        maxBytes: 1024,
        maxDurationSeconds: 60,
        consent: 'explicit',
        privacy: { deniedUrlPatterns: ['bank.example', '/account'], blockPrivateBrowsing: false },
      },
      replay: { enabled: true, maxRuns: 3 },
      tools: { allow: ['cua_record_action', 'cua_record_query'] },
    })
    expect(config.transport).toBe('native')
    expect(config.transportFallback).toBe(false)
    expect(config.recording).toEqual({
      enabled: true,
      rootDir: 'artifacts/recordings',
      maxSteps: 5,
      maxBytes: 1024,
      maxDurationSeconds: 60,
      consent: 'explicit',
      privacy: { deniedUrlPatterns: ['bank.example', '/account'], blockPrivateBrowsing: false },
    })
    expect(config.replay).toEqual({ enabled: true, maxRuns: 3, video: true, videoFormat: 'webm', videoMaxRuns: 50 })
    expect(config.tools.allow).toEqual(['cua_record_action', 'cua_record_query'])
  })

  it('rejects unknown keys, wrong types and out-of-range capacities before resources exist', () => {
    expect(codeOf(() => resolveHostConfig({ unknown: true }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { enabled: 'yes' } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { mystery: 1 } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ replay: { maxRuns: 0 } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { maxSteps: -1 } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { maxSteps: 1_000_000 } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { maxBytes: 1.5 } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { maxDurationSeconds: -1 } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { maxDurationSeconds: 1.5 } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { maxDurationSeconds: 86_401 } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { consent: 'yes' } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { privacy: { deniedUrlPatterns: 'bank' } } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { privacy: { deniedUrlPatterns: [''] } } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { privacy: { deniedUrlPatterns: ['x'], mystery: true } } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { privacy: { blockPrivateBrowsing: 'yes' } } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ transport: 'http' }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ transportFallback: 'yes' }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig('config'))).toBe('CONFIG_INVALID')
  })

  it('keeps recording.rootDir workspace-relative', () => {
    expect(codeOf(() => resolveHostConfig({ recording: { rootDir: '/tmp/recordings' } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { rootDir: '../outside' } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ recording: { rootDir: '' } }))).toBe('CONFIG_INVALID')
    expect(resolveHostConfig({ recording: { rootDir: 'artifacts/recordings' } }).recording.rootDir)
      .toBe('artifacts/recordings')
  })

  it('validates the tool allowlist shape', () => {
    expect(codeOf(() => resolveHostConfig({ tools: { allow: 'cua_record_action' } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ tools: { allow: [''] } }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveHostConfig({ tools: { allow: ['cua_record_action', 'cua_record_action'] } })))
      .toBe('CONFIG_INVALID')
  })

  it('returns FEATURE_DISABLED while a feature is off', () => {
    const config = resolveHostConfig({
      recording: { enabled: false },
      replay: { enabled: false },
      skill: { enabled: false },
    })
    expect(isFeatureEnabled(config, 'recording')).toBe(false)
    expect(codeOf(() => assertFeatureEnabled(config, 'recording'))).toBe('FEATURE_DISABLED')
    expect(codeOf(() => assertFeatureEnabled(config, 'replay'))).toBe('FEATURE_DISABLED')

    const enabled = resolveHostConfig({ recording: { enabled: true }, replay: { enabled: true } })
    expect(isFeatureEnabled(enabled, 'recording')).toBe(true)
    expect(() => assertFeatureEnabled(enabled, 'recording')).not.toThrow()
    expect(() => assertFeatureEnabled(enabled, 'replay')).not.toThrow()
  })

  it('carries a stable code on HostError', () => {
    const error = new HostError('FORBIDDEN', 'nope')
    expect(error.code).toBe('FORBIDDEN')
    expect(error.message).toBe('nope')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('host/principal', () => {
  it('derives the Principal from the Host execution context only', () => {
    expect(derivePrincipal({ agent: { id: 'agent-1' }, session: { id: 'session-1' } }))
      .toEqual({ agentId: 'agent-1', sessionId: 'session-1' })
  })

  it('rejects a missing agent or session identity as INVALID_ARGUMENT', () => {
    expect(codeOf(() => derivePrincipal(undefined))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => derivePrincipal({ session: { id: 'session-1' } }))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => derivePrincipal({ agent: { id: 'agent-1' } }))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => derivePrincipal({ agent: { id: '' }, session: { id: 'session-1' } }))).toBe('INVALID_ARGUMENT')
  })

  it('rejects caller supplied ownerSessionId and other identity keys', () => {
    expect(codeOf(() => assertNoCallerSuppliedPrincipal({ ownerSessionId: 'session-b' }))).toBe('FORBIDDEN')
    expect(codeOf(() => assertNoCallerSuppliedPrincipal({ sessionId: 'session-b' }))).toBe('FORBIDDEN')
    expect(codeOf(() => assertNoCallerSuppliedPrincipal({ principal: { sessionId: 'session-b' } }))).toBe('FORBIDDEN')
    expect(codeOf(() => assertNoCallerSuppliedPrincipal({ nested: { agentId: 'agent-b' } }))).toBe('FORBIDDEN')
    expect(codeOf(() => assertNoCallerSuppliedPrincipal({ list: [{ ownerSessionId: 'session-b' }] }))).toBe('FORBIDDEN')
  })

  it('tolerates explicit undefined identity keys and unrelated arguments', () => {
    expect(() => assertNoCallerSuppliedPrincipal({ ownerSessionId: undefined, url: 'https://example.test' }))
      .not.toThrow()
    expect(() => assertNoCallerSuppliedPrincipal({ target: { role: 'button', name: 'Submit' } }))
      .not.toThrow()
  })

  it('requires explicit session ownership for control commands', () => {
    const principal = { agentId: 'agent-1', sessionId: 'session-1' }
    expect(() => assertSessionOwnership(principal, 'session-1')).not.toThrow()
    expect(codeOf(() => assertSessionOwnership(principal, 'session-2'))).toBe('FORBIDDEN')
    expect(codeOf(() => assertSessionOwnership(principal, undefined))).toBe('FORBIDDEN')
    expect(codeOf(() => assertSessionOwnership(principal, ''))).toBe('FORBIDDEN')
  })
})
