import type { CuaTransportKind } from './transport.js'

export const CUA_TRANSPORT = 'mcp' as const
/** Floor for the standalone CLI/daemon reached over MCP. */
export const CUA_MINIMUM_DRIVER_VERSION = '0.38.0' as const
/** Floor for the in-process npm SDK (`@trycua/cua-driver` 0.28 line). */
export const CUA_NATIVE_MINIMUM_DRIVER_VERSION = '0.28.0' as const

/** Tools that must exist before this project may claim browser automation support. */
export const CUA_REQUIRED_BROWSER_TOOLS = [
  'start_session',
  'end_session',
  'list_windows',
  'browser_prepare',
  'get_browser_state',
  'browser_navigate',
  'browser_type',
  'browser_click',
] as const

/** Tools that improve diagnostics or replay but are not required for the M0 gate. */
export const CUA_OPTIONAL_BROWSER_TOOLS = [
  'browser_pointer',
  'browser_dialog',
  'browser_select',
  'browser_download',
  'get_recording_state',
  'start_recording',
  'stop_recording',
  'replay_trajectory',
] as const

export type CuaRequiredBrowserTool = (typeof CUA_REQUIRED_BROWSER_TOOLS)[number]

export interface CuaCapabilityInput {
  toolNames: readonly string[]
  driverVersion?: string
  /** Transport-specific floor; defaults to the MCP CLI floor. */
  minimumDriverVersion?: string
  /** Which transport produced the catalog; defaults to the MCP label. */
  transport?: CuaTransportKind
}

export interface CuaCapabilityReport {
  transport: CuaTransportKind
  driverVersion: string | null
  toolCount: number
  browserTools: string[]
  missingRequiredTools: string[]
  missingOptionalTools: string[]
  browserAutomation: boolean
  rawRecording: boolean
  versionSupported: boolean
}

export function semverAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): number[] => value.split('.').map(part => Number.parseInt(part, 10))
  const a = parse(actual)
  const b = parse(minimum)
  if (a.length < 3 || a.some(Number.isNaN) || b.length < 3 || b.some(Number.isNaN)) return false
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left > right) return true
    if (left < right) return false
  }
  return true
}

export function evaluateCuaCapabilities(input: CuaCapabilityInput): CuaCapabilityReport {
  const names = new Set(input.toolNames)
  const browserTools = [...names].filter(name => name.startsWith('browser_') || name === 'get_browser_state')
  const missingRequiredTools = CUA_REQUIRED_BROWSER_TOOLS.filter(name => !names.has(name))
  const missingOptionalTools = CUA_OPTIONAL_BROWSER_TOOLS.filter(name => !names.has(name))
  const minimum = input.minimumDriverVersion ?? CUA_MINIMUM_DRIVER_VERSION
  const versionSupported = input.driverVersion !== undefined
    && semverAtLeast(input.driverVersion, minimum)

  return {
    transport: input.transport ?? CUA_TRANSPORT,
    driverVersion: input.driverVersion ?? null,
    toolCount: names.size,
    browserTools: browserTools.sort(),
    missingRequiredTools,
    missingOptionalTools,
    browserAutomation: missingRequiredTools.length === 0,
    rawRecording: ['start_recording', 'stop_recording', 'get_recording_state'].every(name => names.has(name)),
    versionSupported,
  }
}
