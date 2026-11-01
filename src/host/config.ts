/**
 * Host 配置：开关、根目录、传输、容量与工具白名单（design/backend.md 模块表 `host/config`）。
 *
 * 纪律：
 * - 默认关闭：`recording.enabled` / `replay.enabled` 默认 false，粒度 = 工作区（design 失败模式节）；
 * - 配置非法一律在**创建任何资源之前**返回 `CONFIG_INVALID`（design/backend.md IF-1 语义）；
 * - 未知键、非法类型、越界容量都显式拒绝，不做静默修补（`noUncheckedIndexedAccess` 风格）；
 * - 错误消息只描述字段，不含绝对路径或凭证。
 */
import type { ErrorCode } from '../core/api.js'
import { MAX_DENIED_URL_PATTERN_LENGTH, MAX_DENIED_URL_PATTERNS } from '../privacy/policy.js'

/**
 * Host 稳定错误。
 *
 * 放在 config 模块（host 的基础依赖）：其余 host 模块只依赖它，不为错误类型单独引入文件。
 * `code` 是 Core 的稳定错误码，能被 `toPublicError` 原样收敛成公共错误。
 */
export class HostError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HostError'
    this.code = code
  }
}

/**
 * 传输选择：`native` 把 Cua SDK 放进独立子进程（崩溃隔离），`mcp` 连已验证的
 * CLI daemon。两条线共享同一 `CuaTransport` 契约，且都不在 DSH 主进程里加载原生库。
 */
export type TransportChoice = 'native' | 'mcp'

/** 录制同意策略：off 不记录；implicit 记录调用方声明；explicit 要求 start 显式传 consent。 */
export type RecordingConsentPolicy = 'off' | 'implicit' | 'explicit'

/** 录制隐私策略：URL 排除 + 私密浏览窗口拦截。 */
export interface RecordingPrivacyConfig {
  /** 大小写不敏感的子串：命中即把该步骤及其后步骤写入 suppressed.jsonl。 */
  readonly deniedUrlPatterns: readonly string[]
  /** 绑定 existing 窗口时，标题命中私密窗口模式则拒绝；默认开。 */
  readonly blockPrivateBrowsing: boolean
}

/** Recording 相关配置；`rootDir` 是被 Store 使用的默认落盘根目录。 */
export interface RecordingConfig {
  readonly enabled: boolean
  readonly rootDir: string
  readonly maxSteps: number
  readonly maxBytes: number
  /** 单个 Recording 最长时长（秒），到点自动以 max_duration 收口；0 = 关闭。 */
  readonly maxDurationSeconds: number
  readonly consent: RecordingConsentPolicy
  readonly privacy: RecordingPrivacyConfig
}

export interface ReplayConfig {
  readonly enabled: boolean
  readonly maxRuns: number
  /** 回放时录制视频（默认开）。 */
  readonly video: boolean
  /** 视频格式：webm（默认，体积小）或 mp4（QuickTime 可直接播放）。 */
  readonly videoFormat: 'webm' | 'mp4'
  /** 每一个 recording 目录最多保留多少个成功 Run 的视频。 */
  readonly videoMaxRuns: number
}

/**
 * Skill 知识库配置（design/backend.md 失败模式节、design/interfaces.md IF-7）：
 * - `enabled` 默认 false：写族工具（generate/install/feedback）返回 `FEATURE_DISABLED`；
 *   读族工具（review/search/load）保持可用，与「录制关闭时历史仍可查询」的口径一致；
 * - `rootDir` 是 Skill 库根（`_drafts/` 与 `skills/` 的父目录），工作区相对路径；
 * - `autoFeedback` 是 Replay 终态自动反哺开关（默认 true）；本卡只做配置与工具接线。
 */
export interface SkillConfig {
  readonly enabled: boolean
  readonly rootDir: string
  readonly autoFeedback: boolean
}

/** 工具白名单：空数组 = 公开全部宿主工具（不是“全部禁用”）。 */
export interface ToolsConfig {
  readonly allow: readonly string[]
}

export interface HostConfig {
  readonly transport: TransportChoice
  /** 首选 native 失败时是否回退 MCP；回退原因会写进状态工具，不是静默降级。 */
  readonly transportFallback: boolean
  readonly recording: RecordingConfig
  readonly replay: ReplayConfig
  readonly skill: SkillConfig
  readonly tools: ToolsConfig
}

/** 工作区内默认落盘目录（design/requirement D-3：记录落在工作区 .dsh 下）。 */
export const DEFAULT_RECORDING_ROOT = '.dsh/record-replay' as const

/** Skill 库默认落盘目录：`<root>/_drafts/` 存草案、`<root>/skills/<site>/<flow>/` 存安装版本。 */
export const DEFAULT_SKILL_ROOT = '.dsh/skill-library' as const

/** 容量上限（design/backend.md 跨关注点：「10,000 步、500 MiB、50 Run」）。 */
export const DEFAULT_MAX_STEPS = 10_000
export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024
export const DEFAULT_MAX_RUNS = 50

/** 录制时长上限（秒），与参考实现的 30 分钟一致。 */
export const DEFAULT_MAX_DURATION_SECONDS = 1800
/** 缺省记录调用方声明的同意；严格模式可设 explicit。 */
export const DEFAULT_RECORDING_CONSENT: RecordingConsentPolicy = 'implicit'

/** 容量校验的硬上限：挡住明显笔误（如 maxSteps: 1e9），不用于估算产品容量。 */
const MAX_STEPS_LIMIT = 100_000
const MAX_BYTES_LIMIT = 10 * 1024 * 1024 * 1024
const MAX_RUNS_LIMIT = 1_000

/** 默认配置：功能默认开启（可用配置逐项关闭），工具白名单为空（= 公开全部宿主工具）。 */
export const DEFAULT_HOST_CONFIG: HostConfig = {
  transport: 'mcp',
  transportFallback: true,
  recording: {
    enabled: true,
    rootDir: DEFAULT_RECORDING_ROOT,
    maxSteps: DEFAULT_MAX_STEPS,
    maxBytes: DEFAULT_MAX_BYTES,
    maxDurationSeconds: DEFAULT_MAX_DURATION_SECONDS,
    consent: DEFAULT_RECORDING_CONSENT,
    privacy: {
      deniedUrlPatterns: [],
      blockPrivateBrowsing: true,
    },
  },
  replay: {
    enabled: true,
    video: true,
    videoFormat: 'webm',
    videoMaxRuns: 50,
    maxRuns: DEFAULT_MAX_RUNS,
  },
  skill: {
    enabled: true,
    rootDir: DEFAULT_SKILL_ROOT,
    autoFeedback: true,
  },
  tools: {
    allow: [],
  },
}

/** Host 功能开关的粒度。 */
export type HostFeature = 'recording' | 'replay' | 'skill'

export function isFeatureEnabled(config: HostConfig, feature: HostFeature): boolean {
  switch (feature) {
    case 'recording':
      return config.recording.enabled
    case 'replay':
      return config.replay.enabled
    case 'skill':
      return config.skill.enabled
  }
}

/** 功能未开启时返回 `FEATURE_DISABLED`（IF-7 的“功能未开启”稳定码）。 */
export function assertFeatureEnabled(config: HostConfig, feature: HostFeature): void {
  if (!isFeatureEnabled(config, feature)) {
    throw new HostError('FEATURE_DISABLED', `${feature} is disabled in the workspace configuration`)
  }
}

/**
 * 解析并校验宿主配置。
 *
 * `input` 来自宿主配置源（未信任、可能被手写坏），返回**完整**配置：未给的字段继承默认值，
 * 但任何非法字段都在这里被拒绝，调用方拿到的一定是可装配的配置。
 */
export function resolveHostConfig(input: unknown = {}): HostConfig {
  if (input === undefined || input === null) {
    return DEFAULT_HOST_CONFIG
  }
  const root = asRecord(input, 'config')
  rejectUnknownKeys(root, ['transport', 'transportFallback', 'recording', 'replay', 'skill', 'tools'], 'config')

  return {
    transport: root['transport'] === undefined ? DEFAULT_HOST_CONFIG.transport : asTransport(root['transport']),
    transportFallback: root['transportFallback'] === undefined
      ? DEFAULT_HOST_CONFIG.transportFallback
      : asBoolean(root['transportFallback'], 'transportFallback'),
    recording: resolveRecording(root['recording']),
    replay: resolveReplay(root['replay']),
    skill: resolveSkill(root['skill']),
    tools: resolveTools(root['tools']),
  }
}

function resolveRecording(input: unknown): RecordingConfig {
  if (input === undefined) return DEFAULT_HOST_CONFIG.recording
  const raw = asRecord(input, 'recording')
  rejectUnknownKeys(raw, ['enabled', 'rootDir', 'maxSteps', 'maxBytes', 'maxDurationSeconds', 'consent', 'privacy'], 'recording')

  const enabled = raw['enabled'] === undefined
    ? DEFAULT_HOST_CONFIG.recording.enabled
    : asBoolean(raw['enabled'], 'recording.enabled')
  const rootDir = raw['rootDir'] === undefined
    ? DEFAULT_HOST_CONFIG.recording.rootDir
    : asRootDir(raw['rootDir'], 'recording.rootDir')
  const maxSteps = raw['maxSteps'] === undefined
    ? DEFAULT_HOST_CONFIG.recording.maxSteps
    : asPositiveInteger(raw['maxSteps'], 'recording.maxSteps', MAX_STEPS_LIMIT)
  const maxBytes = raw['maxBytes'] === undefined
    ? DEFAULT_HOST_CONFIG.recording.maxBytes
    : asPositiveInteger(raw['maxBytes'], 'recording.maxBytes', MAX_BYTES_LIMIT)
  const maxDurationSeconds = raw['maxDurationSeconds'] === undefined
    ? DEFAULT_HOST_CONFIG.recording.maxDurationSeconds
    : asDurationSeconds(raw['maxDurationSeconds'], 'recording.maxDurationSeconds')
  const consent = raw['consent'] === undefined
    ? DEFAULT_HOST_CONFIG.recording.consent
    : asConsentPolicy(raw['consent'], 'recording.consent')
  const privacy = raw['privacy'] === undefined
    ? DEFAULT_HOST_CONFIG.recording.privacy
    : resolveRecordingPrivacy(raw['privacy'])

  return { enabled, rootDir, maxSteps, maxBytes, maxDurationSeconds, consent, privacy }
}

function resolveRecordingPrivacy(input: unknown): RecordingPrivacyConfig {
  const raw = asRecord(input, 'recording.privacy')
  rejectUnknownKeys(raw, ['deniedUrlPatterns', 'blockPrivateBrowsing'], 'recording.privacy')
  const deniedUrlPatterns = raw['deniedUrlPatterns'] === undefined
    ? DEFAULT_HOST_CONFIG.recording.privacy.deniedUrlPatterns
    : asDeniedUrlPatterns(raw['deniedUrlPatterns'], 'recording.privacy.deniedUrlPatterns')
  const blockPrivateBrowsing = raw['blockPrivateBrowsing'] === undefined
    ? DEFAULT_HOST_CONFIG.recording.privacy.blockPrivateBrowsing
    : asBoolean(raw['blockPrivateBrowsing'], 'recording.privacy.blockPrivateBrowsing')
  return { deniedUrlPatterns, blockPrivateBrowsing }
}

function resolveReplay(input: unknown): ReplayConfig {
  if (input === undefined) return DEFAULT_HOST_CONFIG.replay
  const raw = asRecord(input, 'replay')
  rejectUnknownKeys(raw, ['enabled', 'maxRuns', 'video', 'videoFormat', 'videoMaxRuns'], 'replay')

  const enabled = raw['enabled'] === undefined
    ? DEFAULT_HOST_CONFIG.replay.enabled
    : asBoolean(raw['enabled'], 'replay.enabled')
  const maxRuns = raw['maxRuns'] === undefined
    ? DEFAULT_HOST_CONFIG.replay.maxRuns
    : asPositiveInteger(raw['maxRuns'], 'replay.maxRuns', MAX_RUNS_LIMIT)
  const video = raw['video'] === undefined
    ? DEFAULT_HOST_CONFIG.replay.video
    : asBoolean(raw['video'], 'replay.video')
  const videoFormat = raw['videoFormat'] === undefined
    ? DEFAULT_HOST_CONFIG.replay.videoFormat
    : raw['videoFormat'] === 'mp4' || raw['videoFormat'] === 'webm'
      ? raw['videoFormat']
      : (() => { throw new TypeError('replay.videoFormat must be "webm" or "mp4"') })()

  const videoMaxRuns = raw['videoMaxRuns'] === undefined
    ? DEFAULT_HOST_CONFIG.replay.videoMaxRuns
    : asPositiveInteger(raw['videoMaxRuns'], 'replay.videoMaxRuns', MAX_RUNS_LIMIT)

  return { enabled, maxRuns, video, videoFormat, videoMaxRuns }
}

function resolveSkill(input: unknown): SkillConfig {
  if (input === undefined) return DEFAULT_HOST_CONFIG.skill
  const raw = asRecord(input, 'skill')
  rejectUnknownKeys(raw, ['enabled', 'rootDir', 'autoFeedback'], 'skill')

  return {
    enabled: raw['enabled'] === undefined
      ? DEFAULT_HOST_CONFIG.skill.enabled
      : asBoolean(raw['enabled'], 'skill.enabled'),
    rootDir: raw['rootDir'] === undefined
      ? DEFAULT_HOST_CONFIG.skill.rootDir
      : asRootDir(raw['rootDir'], 'skill.rootDir'),
    autoFeedback: raw['autoFeedback'] === undefined
      ? DEFAULT_HOST_CONFIG.skill.autoFeedback
      : asBoolean(raw['autoFeedback'], 'skill.autoFeedback'),
  }
}

function resolveTools(input: unknown): ToolsConfig {
  if (input === undefined) return DEFAULT_HOST_CONFIG.tools
  const raw = asRecord(input, 'tools')
  rejectUnknownKeys(raw, ['allow'], 'tools')
  if (raw['allow'] === undefined) return { allow: [] }

  const value = raw['allow']
  if (!Array.isArray(value)) {
    throw configInvalid('tools.allow must be an array of host tool names')
  }
  const allow: string[] = []
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw configInvalid(`tools.allow[${String(index)}] must be a non-empty string`)
    }
    if (allow.includes(entry)) {
      throw configInvalid(`tools.allow[${String(index)}] duplicates "${entry}"`)
    }
    allow.push(entry)
  })
  return { allow }
}

function asTransport(value: unknown): TransportChoice {
  if (value === 'native' || value === 'mcp') return value
  throw configInvalid('transport must be "native" or "mcp"')
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw configInvalid(`${field} must be a boolean`)
  return value
}

function asRootDir(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw configInvalid(`${field} must be a non-empty string`)
  }
  if (value.includes('\0')) throw configInvalid(`${field} must not contain NUL bytes`)
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw configInvalid(`${field} must be workspace-relative, not an absolute path`)
  }
  const segments = value.split(/[\\/]+/)
  if (segments.includes('..')) {
    throw configInvalid(`${field} must not escape the workspace root`)
  }
  return value
}

function asPositiveInteger(value: unknown, field: string, limit: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > limit) {
    throw configInvalid(`${field} must be an integer in 1..${String(limit)}`)
  }
  return value
}

function asRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configInvalid(`${field} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw configInvalid(`${field} has an unknown key "${key}"`)
  }
}

function configInvalid(message: string): HostError {
  return new HostError('CONFIG_INVALID', message)
}

/** 录制时长上限：0 允许（关闭自动停），最大 24 小时，挡住明显笔误。 */
function asDurationSeconds(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 86_400) {
    throw configInvalid(`${field} must be an integer between 0 and 86400`)
  }
  return value
}

function asConsentPolicy(value: unknown, field: string): RecordingConsentPolicy {
  if (value !== 'off' && value !== 'implicit' && value !== 'explicit') {
    throw configInvalid(`${field} must be "off", "implicit" or "explicit"`)
  }
  return value
}

function asDeniedUrlPatterns(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw configInvalid(`${field} must be an array of strings`)
  if (value.length > MAX_DENIED_URL_PATTERNS) {
    throw configInvalid(`${field} must contain at most ${String(MAX_DENIED_URL_PATTERNS)} entries`)
  }
  const patterns: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw configInvalid(`${field} entries must be strings`)
    const pattern = entry.trim()
    if (pattern.length === 0 || pattern.length > MAX_DENIED_URL_PATTERN_LENGTH) {
      throw configInvalid(`${field} entries must be 1-${String(MAX_DENIED_URL_PATTERN_LENGTH)} characters`)
    }
    patterns.push(pattern)
  }
  return patterns
}
