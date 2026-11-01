/** 测试套件文件：一组 Recording + 目标 + 参数，按顺序回放。 */
import { formatLaunchModes, isLaunchMode, type LaunchMode, type WindowTarget } from '../core/contracts.js'
import { HostError } from '../host/index.js'

/** 与 bind/replay 共用同一份 launch / target 定义（见 `core/contracts.ts`）。 */
export type SuiteLaunch = LaunchMode
export type SuiteTarget = WindowTarget

export interface SuiteCase {
  readonly name: string
  readonly recordingId: string
  readonly values?: Readonly<Record<string, string>>
  readonly baseUrl?: string
  readonly target?: SuiteTarget
  /** 单 case 超时预算（毫秒，正整数）；缺省取 suite.timeoutMs / 调用方默认值。 */
  readonly timeoutMs?: number
}

export interface TestSuite {
  readonly name?: string
  readonly target?: SuiteTarget
  readonly baseUrl?: string
  /** 套件级回放输入值；case.values 覆盖同名键。 */
  readonly values?: Readonly<Record<string, string>>
  /** 套件级超时预算（毫秒，正整数）；case.timeoutMs 优先。 */
  readonly timeoutMs?: number
  readonly cases: readonly SuiteCase[]
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostError('INVALID_ARGUMENT', `${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function positiveInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HostError('INVALID_ARGUMENT', `${what} must be a positive integer`)
  }
  return value
}

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new HostError('INVALID_ARGUMENT', `${what} must be a non-empty string`)
  }
  return value
}

function parseValues(
  value: unknown,
  what: string,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  const map = record(value, what)
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry !== 'string') throw new HostError('INVALID_ARGUMENT', `${what}.${key} must be a string`)
    out[key] = resolveValue(entry, env, `${what}.${key}`)
  }
  return out
}

export function parseSuiteTarget(value: unknown, what = 'target'): SuiteTarget {
  const raw = record(value, what)
  const launch = raw['launch']
  if (launch !== undefined && !isLaunchMode(launch)) {
    throw new HostError('INVALID_ARGUMENT', `${what}.launch must be ${formatLaunchModes()}`)
  }
  const target: { -readonly [K in keyof SuiteTarget]: SuiteTarget[K] } = {}
  if (launch !== undefined) target.launch = launch
  if (raw['pid'] !== undefined) target.pid = positiveInt(raw['pid'], `${what}.pid`)
  if (raw['windowId'] !== undefined) target.windowId = positiveInt(raw['windowId'], `${what}.windowId`)
  const profileName = raw['profileName'] === undefined ? undefined : optionalString(raw['profileName'], `${what}.profileName`)
  if (profileName !== undefined) target.profileName = profileName
  const mode = target.launch ?? 'existing'
  if (mode === 'isolated') {
    if (target.pid !== undefined || target.windowId !== undefined) {
      throw new HostError('INVALID_ARGUMENT', `${what}: pid/windowId must be omitted for isolated`)
    }
  } else if (target.pid === undefined || target.windowId === undefined) {
    throw new HostError('INVALID_ARGUMENT', `${what}: pid and windowId are required for ${mode}`)
  }
  return target
}

/** `${VAR}` 形式的凭据引用；找不到环境变量就报错，不落明文。 */
function resolveValue(value: string, env: Readonly<Record<string, string | undefined>>, what: string): string {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value)
  if (match === null) return value
  const name = match[1] as string
  const resolved = env[name]
  if (resolved === undefined || resolved.length === 0) {
    throw new HostError('INVALID_ARGUMENT', `${what} references missing environment variable ${name}`)
  }
  return resolved
}

/** 严格解析套件 JSON；错误信息直接指出字段路径。 */
export function parseTestSuite(value: unknown, env: Readonly<Record<string, string | undefined>> = process.env): TestSuite {
  const raw = record(value, 'suite')
  const name = optionalString(raw['name'], 'suite.name')
  const target = raw['target'] === undefined ? undefined : parseSuiteTarget(raw['target'], 'suite.target')
  const baseUrl = optionalString(raw['baseUrl'], 'suite.baseUrl')
  const timeoutMs = raw['timeoutMs'] === undefined ? undefined : positiveInt(raw['timeoutMs'], 'suite.timeoutMs')
  const values = parseValues(raw['values'], 'suite.values', env)
  const casesRaw = raw['cases']
  if (!Array.isArray(casesRaw) || casesRaw.length === 0) {
    throw new HostError('INVALID_ARGUMENT', 'suite.cases must be a non-empty array')
  }
  const seen = new Set<string>()
  const cases = casesRaw.map((entry, index) => {
    const what = `suite.cases[${String(index)}]`
    const item = record(entry, what)
    const caseName = optionalString(item['name'], `${what}.name`)
    if (caseName === undefined) throw new HostError('INVALID_ARGUMENT', `${what}.name is required`)
    if (seen.has(caseName)) throw new HostError('INVALID_ARGUMENT', `duplicate case name ${JSON.stringify(caseName)}`)
    seen.add(caseName)
    const recordingId = item['recordingId']
    if (typeof recordingId !== 'string' || !/^rec_[A-Za-z0-9_]+$/u.test(recordingId)) {
      throw new HostError('INVALID_ARGUMENT', `${what}.recordingId must be rec_*`)
    }
    const values = parseValues(item['values'], `${what}.values`, env)
    const caseTarget = item['target'] === undefined ? undefined : parseSuiteTarget(item['target'], `${what}.target`)
    const caseBaseUrl = optionalString(item['baseUrl'], `${what}.baseUrl`)
    const caseTimeoutMs = item['timeoutMs'] === undefined ? undefined : positiveInt(item['timeoutMs'], `${what}.timeoutMs`)
    return {
      name: caseName,
      recordingId,
      ...(values === undefined ? {} : { values }),
      ...(caseBaseUrl === undefined ? {} : { baseUrl: caseBaseUrl }),
      ...(caseTarget === undefined ? {} : { target: caseTarget }),
      ...(caseTimeoutMs === undefined ? {} : { timeoutMs: caseTimeoutMs }),
    }
  })
  return {
    ...(name === undefined ? {} : { name }),
    ...(target === undefined ? {} : { target }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(values === undefined ? {} : { values }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    cases,
  }
}
