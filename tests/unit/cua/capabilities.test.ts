import { describe, expect, it } from 'vitest'
import {
  CUA_OPTIONAL_BROWSER_TOOLS,
  CUA_REQUIRED_BROWSER_TOOLS,
  evaluateCuaCapabilities,
} from '../../../src/cua/capabilities.js'

const ALL_REQUIRED = [...CUA_REQUIRED_BROWSER_TOOLS]
const ALL_OPTIONAL = [...CUA_OPTIONAL_BROWSER_TOOLS]

describe('evaluateCuaCapabilities', () => {
  it('accepts a complete browser tool catalog', () => {
    const report = evaluateCuaCapabilities({
      toolNames: [...ALL_REQUIRED, ...ALL_OPTIONAL],
      driverVersion: '0.38.0',
    })

    expect(report.transport).toBe('mcp')
    expect(report.driverVersion).toBe('0.38.0')
    expect(report.browserAutomation).toBe(true)
    expect(report.rawRecording).toBe(true)
    expect(report.versionSupported).toBe(true)
    expect(report.missingRequiredTools).toEqual([])
  })

  it('fails the browser gate when browser_type is missing', () => {
    const report = evaluateCuaCapabilities({
      toolNames: ALL_REQUIRED.filter(tool => tool !== 'browser_type'),
    })

    expect(report.browserAutomation).toBe(false)
    expect(report.missingRequiredTools).toEqual(['browser_type'])
  })

  it('rejects an old driver even when tools look complete', () => {
    const report = evaluateCuaCapabilities({ toolNames: ALL_REQUIRED, driverVersion: '0.19.3' })

    expect(report.browserAutomation).toBe(true)
    expect(report.versionSupported).toBe(false)
  })

  it('does not fail automation for optional tools that are absent', () => {
    const report = evaluateCuaCapabilities({ toolNames: ALL_REQUIRED })

    expect(report.browserAutomation).toBe(true)
    expect(report.rawRecording).toBe(false)
    expect(report.missingOptionalTools).toContain('start_recording')
  })

  it('reports only browser-facing tools and a deduplicated count', () => {
    const report = evaluateCuaCapabilities({
      toolNames: [...ALL_REQUIRED, ...ALL_OPTIONAL, 'custom_tool'],
    })

    expect(report.toolCount).toBe(new Set([...ALL_REQUIRED, ...ALL_OPTIONAL, 'custom_tool']).size)
    expect(report.browserTools).toEqual(expect.arrayContaining(['browser_click', 'browser_type', 'get_browser_state']))
    expect(report.browserTools).not.toContain('custom_tool')
  })
})
