/**
 * Agent 工具（design/backend.md `host/tools`：向 Agent 暴露稳定语义动作，过滤内部工具；
 * design/use-cases.md IF-1：工具输入采用判别联合，新增动作类型不改旧动作语义）。
 *
 * 纪律：
 * - 工具名是稳定契约（`HOST_TOOL_NAMES` / `SKILL_HOST_TOOL_NAMES`），**绝不**把 Cua 原始工具名
 *   暴露给 Agent；`start_session` / `browser_click` 之类的内部工具即使被写进 `tools.allow`
 *   也拒绝（CONFIG_INVALID）；
 * - 参数一律严格校验：未知键 `INVALID_ARGUMENT`，身份键 `FORBIDDEN`（Principal 只能来自 exec）；
 * - 开关默认关闭：工具工厂本身不裁剪，处理器统一返回 `FEATURE_DISABLED`——直接装配本模块
 *   也拿不到半开放的工具；组合根可以按同一批开关决定是否注册（插件就对
 *   `cua_record_start` / `cua_record_action` / `cua_replay_start` / Skill 写族这样做）；
 * - Skill 工具（design/interfaces.md IF-7）只做参数校验、开关检查与公开 DTO 投影，业务逻辑在
 *   `skill/` 应用服务；业务错误码（`SKILL_*` / `RECORDING_INCOMPLETE`）原样透传，不包装成 Host 错误；
 * - 处理结果只返回公开 DTO（JSON 安全），不含 Driver/Cua 句柄，也不含本机绝对路径
 *   （design/backend.md 非目标：不直接把文件系统路径暴露给 Agent）。
 */
import {
  assertRecordingId,
  assertRunId,
  isBrowserAction,
  isRecordingId,
  isRunId,
  type BrowserAction,
  type JsonObject,
  type JsonValue,
  type RecordingId,
  type RunId,
  type SemanticTarget,
} from '../core/api.js'
import {
  ACTION_KINDS,
  LAUNCH_MODE_ERROR,
  TARGET_FIELDS,
  TARGET_URL_FIELDS,
  WAIT_CONDITION_FIELDS,
  WINDOW_TARGET_FIELDS,
  actionFieldNames,
  actionSchema,
  assertCheckFieldNames,
  isLaunchMode,
  windowTargetProperties,
} from '../core/contracts.js'
import type { LoadedSkill, SkillQuery, SkillSearchResult } from '../skill/catalog.js'
import type { SkillFeedbackReceipt } from '../skill/feedback.js'
import type { GenerateSkillDraftInput } from '../skill/generator.js'
import { isSkillFeedbackResult, type InstalledSkill, type SkillDraft, type SkillFeedback, type SkillIndexEntry } from '../skill/model.js'
import type { SkillDraftSummary, SkillInstallRequest } from '../skill/review.js'
import { assertFeatureEnabled, HostError, type HostConfig } from './config.js'
import { assertNoCallerSuppliedPrincipal, type HostCallContext } from './principal.js'
import type {
  CuaRecordReplayService,
  ObservationDto,
  Page,
  RecordingListQuery,
  RecordingStatus,
  RecordingStep,
  RecordingSummary,
  RunListQuery,
  RunStatus,
  ReplayTarget,
  RunSummary,
  StepListQuery,
  StepViewStatus,
} from './service.js'

/** 宿主公开工具名：Agent 的唯一调用面（稳定契约，只增不改名）。 */
export const HOST_TOOL_NAMES = [
  'cua_record_bind_browser',
  'cua_record_observe',
  'cua_record_action',
  'cua_record_release_browser',
  'cua_record_cancel',
  'cua_record_query',
  'cua_replay_start',
  'cua_replay_cancel',
] as const

export type HostToolName = (typeof HOST_TOOL_NAMES)[number]

/**
 * Skill 知识库工具名（design/interfaces.md IF-7：generate / review / install / search / load / feedback）。
 * 与录制/回放工具同属 Agent 调用面；业务逻辑在 `skill/` 应用服务，这里只做校验与投影。
 */
export const SKILL_HOST_TOOL_NAMES = [
  'cua_skill_generate',
  'cua_skill_review',
  'cua_skill_install',
  'cua_skill_search',
  'cua_skill_load',
  'cua_skill_feedback',
] as const

export type SkillHostToolName = (typeof SKILL_HOST_TOOL_NAMES)[number]

/** 全部宿主工具名：`tools.allow` 的合法取值集合（只增不改名）。 */
export const ALL_HOST_TOOL_NAMES = [...HOST_TOOL_NAMES, ...SKILL_HOST_TOOL_NAMES] as const

export type AnyHostToolName = (typeof ALL_HOST_TOOL_NAMES)[number]

/**
 * Cua 原始工具名（design/interfaces.md IF-1 的工具目录）。这些名字只允许出现在 Transport/Driver 内部，
 * 不得作为宿主工具暴露，也不得出现在 `tools.allow` 里。
 */
export const INTERNAL_CUA_TOOL_NAMES = [
  'start_session',
  'end_session',
  'get_browser_state',
  'browser_prepare',
  'browser_launch',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_key',
  'browser_wait',
  'browser_screenshot',
  'list_apps',
  'get_screenshot',
] as const

export interface HostToolDefinition {
  readonly name: AnyHostToolName
  readonly description: string
  /** 严格输入 Schema：`additionalProperties: false`，写动作采用判别联合。 */
  readonly inputSchema: JsonObject
  readonly handle: (args: unknown, call: HostCallContext) => Promise<JsonValue>
}

type JsonSchema = Readonly<Record<string, unknown>>

const asJson = (value: unknown): JsonValue => value as JsonValue

// Both schemas are generated from `core/contracts.ts`; do not hand-write
// action variants, target fields or launch modes here.
const ACTION_SCHEMA: JsonSchema = actionSchema()

const EMPTY_SCHEMA: JsonSchema = { type: 'object', additionalProperties: false, properties: {} }

const BIND_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: windowTargetProperties(),
}

const ACTION_TOOL_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: { action: ACTION_SCHEMA },
}

const QUERY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { enum: ['recordings', 'recording', 'steps', 'runs', 'run'] },
    recordingId: { type: 'string', pattern: '^rec_[A-Za-z0-9_]+$' },
    runId: { type: 'string', pattern: '^run_[A-Za-z0-9_]+$' },
    cursor: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    status: { type: 'string' },
  },
}

const REPLAY_START_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['recordingId'],
  properties: {
    recordingId: { type: 'string', pattern: '^rec_[A-Za-z0-9_]+$' },
    idempotencyKey: { type: 'string', minLength: 1 },
    ...windowTargetProperties(),
    values: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Replay input values keyed by source stepId or secretRef; process-only.',
    },
    baseUrl: {
      type: 'string',
      minLength: 1,
      description: 'Replace the origin of recorded navigate steps (path/query preserved), e.g. a dev server whose port changes.',
    },
  },
}

const REPLAY_CANCEL_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['runId'],
  properties: { runId: { type: 'string', pattern: '^run_[A-Za-z0-9_]+$' } },
}

/**
 * 校验 `tools.allow`：空数组 = 公开全部宿主工具；未知名字或内部 Cua 工具名都返回 `CONFIG_INVALID`
 * （在创建任何资源之前调用，见 host/index.ts 的装配顺序）。Skill 工具名同样是合法白名单值。
 */
export function resolveToolAllowlist(allow: readonly string[]): readonly HostToolName[] {
  if (allow.length === 0) return HOST_TOOL_NAMES
  assertKnownAllowEntries(allow)
  return HOST_TOOL_NAMES.filter(name => allow.includes(name))
}

/** Skill 工具的 `tools.allow` 过滤；语义与 `resolveToolAllowlist` 一致（空数组 = 全部）。 */
export function resolveSkillToolAllowlist(allow: readonly string[]): readonly SkillHostToolName[] {
  if (allow.length === 0) return SKILL_HOST_TOOL_NAMES
  assertKnownAllowEntries(allow)
  return SKILL_HOST_TOOL_NAMES.filter(name => allow.includes(name))
}

/**
 * 组合根的**跨族**过滤：`tools.allow` 里可能只有另一族的名字。
 *
 * 为什么不能先 `resolve*ToolAllowlist` 再交给 `create*Tools`：那两个工厂把**空数组**解释为
 * 「全部」（历史契约），而「非空 allow 但在本族一个都没命中」解析出来正是空数组——二次过滤会把它
 * 放大成全部工具，等于把用户显式收窄的 allowlist 反向放宽（复核实测：allow=['cua_record_query']
 * 时 6 个 cua_skill_* 仍全部暴露）。
 *
 * 本函数只做一次过滤：空 allow = 该族全部；非空 allow = 该族里点名的那几个（可能一个都没有）。
 */
export function selectToolsForFamily<T extends { readonly name: string }>(
  tools: readonly T[],
  allow: readonly string[],
): readonly T[] {
  return allow.length === 0 ? tools : tools.filter(tool => allow.includes(tool.name))
}

function assertKnownAllowEntries(allow: readonly string[]): void {
  for (const name of allow) {
    if ((INTERNAL_CUA_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new HostError('CONFIG_INVALID', `tools.allow must not expose the internal Cua tool "${name}"`)
    }
    if (!(ALL_HOST_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new HostError('CONFIG_INVALID', `tools.allow has an unknown host tool "${name}"`)
    }
  }
}

/** 构造宿主工具集；按 HOST_TOOL_NAMES 顺序返回，`allow` 只做筛选。 */
export function createHostTools(
  service: CuaRecordReplayService,
  options: { readonly allow?: readonly string[] } = {},
): readonly HostToolDefinition[] {
  const selected = resolveToolAllowlist(options.allow ?? [])
  return selected.map(name => TOOL_FACTORIES[name](service))
}

const TOOL_FACTORIES: {
  readonly [K in HostToolName]: (service: CuaRecordReplayService) => HostToolDefinition
} = {
  cua_record_bind_browser: service => ({
    name: 'cua_record_bind_browser',
    description:
      'Bind this DSH session to a browser or desktop window through the Cua driver. launch=existing attaches to a browser pid/windowId; launch=isolated launches a disposable driver-owned Chromium; launch=desktop binds a macOS AX window (click/setValue/key/assert, no navigate).',
    inputSchema: BIND_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, WINDOW_TARGET_FIELDS)
      const launch = fields['launch']
      if (launch !== undefined && !isLaunchMode(launch)) {
        throw new HostError('INVALID_ARGUMENT', LAUNCH_MODE_ERROR)
      }
      const pid = fields['pid'] === undefined ? undefined : requirePositiveInteger(fields['pid'], 'pid')
      const windowId = fields['windowId'] === undefined ? undefined : requirePositiveInteger(fields['windowId'], 'windowId')
      const profileName = optionalString(fields['profileName'], 'profileName')
      return asJson(await service.bindBrowser({
        ...(launch === undefined ? {} : { launch }),
        ...(pid === undefined ? {} : { pid }),
        ...(windowId === undefined ? {} : { windowId }),
        ...(profileName === undefined ? {} : { profileName }),
      }, call))
    },
  }),

  cua_record_observe: service => ({
    name: 'cua_record_observe',
    description:
      'Read the bound page as a semantic snapshot (url, title, role/name/value elements). Read-only: it never clicks or types.',
    inputSchema: EMPTY_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      readArguments(args, [])
      const observation: ObservationDto = await service.observe(call)
      return asJson(observation)
    },
  }),

  cua_record_action: service => ({
    name: 'cua_record_action',
    description:
      `Execute exactly one semantic browser action (${ACTION_KINDS.join('|')}). Every action is recorded as one step with a started/finished pair; write actions are never retried automatically.`,
    inputSchema: ACTION_TOOL_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, ['action'])
      const action = requireAction(fields['action'])
      return asJson(await service.performAction(action, call))
    },
  }),

  cua_record_release_browser: service => ({
    name: 'cua_record_release_browser',
    description: 'Release the browser binding owned by this session (idempotent, also allowed while the feature is off).',
    inputSchema: EMPTY_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      readArguments(args, [])
      return asJson(await service.releaseBrowser(call))
    },
  }),

  cua_record_cancel: service => ({
    name: 'cua_record_cancel',
    description:
      'Cancel in-flight operations of this session only. Cancellation stops new actions; it does not roll back an action that was already sent.',
    inputSchema: EMPTY_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      readArguments(args, [])
      return asJson(await service.cancelOperations(call))
    },
  }),

  cua_record_query: service => ({
    name: 'cua_record_query',
    description:
      'Read-only activity query: recordings, one recording, its steps, runs, or one run. Returns public DTOs for this session only; it never triggers a browser action.',
    inputSchema: QUERY_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, ['kind', 'recordingId', 'runId', 'cursor', 'limit', 'status'])
      const kind = requireString(fields['kind'], 'kind')
      const cursor = optionalString(fields['cursor'], 'cursor')
      const limit = optionalPositiveInteger(fields['limit'], 'limit', 200)
      const status = optionalString(fields['status'], 'status')
      switch (kind) {
        case 'recordings': {
          const query: RecordingListQuery = {
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
            ...(status === undefined ? {} : { status: status as RecordingStatus }),
          }
          return asJson(await service.listRecordings(query, call))
        }
        case 'recording': {
          const recordingId = assertRecordingId(requireString(fields['recordingId'], 'recordingId'))
          const summary: RecordingSummary | undefined = await service.getRecording(recordingId, call)
          return asJson(summary ?? null)
        }
        case 'steps': {
          const recordingId = assertRecordingId(requireString(fields['recordingId'], 'recordingId'))
          const query: StepListQuery = {
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
            ...(status === undefined ? {} : { status: status as StepViewStatus }),
          }
          const page: Page<RecordingStep> = await service.listSteps(recordingId, query, call)
          return asJson(page)
        }
        case 'runs': {
          const query: RunListQuery = {
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
            ...(status === undefined ? {} : { status: status as RunStatus }),
            ...(fields['recordingId'] === undefined
              ? {}
              : { recordingId: assertRecordingId(requireString(fields['recordingId'], 'recordingId')) }),
          }
          return asJson(await service.listRuns(query, call))
        }
        case 'run': {
          const runId = assertRunId(requireString(fields['runId'], 'runId'))
          const run: RunSummary | undefined = await service.getRun(runId, call)
          return asJson(run ?? null)
        }
        default:
          throw new HostError('INVALID_ARGUMENT', 'kind must be one of: recordings, recording, steps, runs, run')
      }
    },
  }),

  cua_replay_start: service => ({
    name: 'cua_replay_start',
    description:
      'Start a real replay run from a completed recording into the supplied pid/windowId. Requires the replay feature to be enabled; the run is owned by this session. Redacted setValue steps require values keyed by stepId or secretRef.',
    inputSchema: REPLAY_START_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, ['recordingId', 'idempotencyKey', ...WINDOW_TARGET_FIELDS, 'values', 'baseUrl'])
      const recordingId = assertRecordingId(requireString(fields['recordingId'], 'recordingId'))
      const idempotencyKey = optionalString(fields['idempotencyKey'], 'idempotencyKey')
      const launch = fields['launch']
      if (launch !== undefined && !isLaunchMode(launch)) {
        throw invalid(LAUNCH_MODE_ERROR)
      }
      const pid = optionalPositiveInteger(fields['pid'], 'pid', Number.MAX_SAFE_INTEGER)
      const windowId = optionalPositiveInteger(fields['windowId'], 'windowId', Number.MAX_SAFE_INTEGER)
      const values = optionalStringMap(fields['values'], 'values')
      const profileName = optionalString(fields['profileName'], 'profileName')
      let target: ReplayTarget | undefined
      if (launch === 'isolated') {
        if (pid !== undefined || windowId !== undefined) {
          throw invalid('pid and windowId must be omitted when launch is "isolated"')
        }
        target = { launch: 'isolated', ...(profileName === undefined ? {} : { profileName }) }
      } else {
        if ((pid === undefined) !== (windowId === undefined)) {
          throw invalid('pid and windowId must be supplied together')
        }
        if (profileName !== undefined) throw invalid('profileName requires launch "isolated"')
        if (pid !== undefined && windowId !== undefined) {
          target = launch === 'desktop'
            ? { launch: 'desktop', pid, windowId }
            : { launch: 'existing', pid, windowId }
        }
      }
      const baseUrl = optionalString(fields['baseUrl'], 'baseUrl')
      return asJson(await service.startReplay({
        recordingId,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(target === undefined ? {} : { target }),
        ...(values === undefined ? {} : { values }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      }, call))
    },
  }),

  cua_replay_cancel: service => ({
    name: 'cua_replay_cancel',
    description: 'Cancel one replay run owned by this session (idempotent for terminal runs, never retries control commands).',
    inputSchema: REPLAY_CANCEL_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, ['runId'])
      const runId = assertRunId(requireString(fields['runId'], 'runId'))
      return asJson(await service.cancelRun(runId, call))
    },
  }),
}

// ---------------------------------------------------------------------------
// Skill 工具（design/interfaces.md IF-7）：参数校验、开关检查与公开 DTO 投影
// ---------------------------------------------------------------------------

/**
 * Skill 工具的依赖端口（由插件组合根注入；Host 不直接碰文件系统）。
 *
 * 端口方法都带 `HostCallContext`：组合根按 `exec` 的 session cwd 解析工作区，
 * 从而让同一份注册在多个工作区复用（工作区粒度的开关与目录，见 design 失败模式节）。
 */
export interface SkillToolPorts {
  /** 已解析的宿主配置；写族工具读 `skill.enabled` 决定 `FEATURE_DISABLED`。 */
  readonly config: HostConfig
  generate(input: GenerateSkillDraftInput, call: HostCallContext): Promise<SkillDraft>
  review(draftId: string, call: HostCallContext): Promise<SkillDraftSummary>
  install(request: SkillInstallRequest, call: HostCallContext): Promise<InstalledSkill>
  search(query: SkillQuery, call: HostCallContext): Promise<SkillSearchResult>
  load(name: string, version: number | undefined, call: HostCallContext): Promise<LoadedSkill>
  feedback(feedback: SkillFeedback, call: HostCallContext): Promise<SkillFeedbackReceipt>
}

/**
 * 构造 Skill 工具集；按 `SKILL_HOST_TOOL_NAMES` 顺序返回，`allow` 只做筛选（空数组 = 全部）。
 *
 * 开关语义（与录制关闭时只读查询仍可用的口径一致）：
 * - 写族 `generate` / `install` / `feedback` 在 `skill.enabled=false` 时返回 `FEATURE_DISABLED`；
 * - 读族 `review` / `search` / `load` 只读文件、不触发 Cua，关闭期间仍可用于回滚与查询。
 */
export function createSkillTools(
  ports: SkillToolPorts,
  options: { readonly allow?: readonly string[] } = {},
): readonly HostToolDefinition[] {
  const selected = resolveSkillToolAllowlist(options.allow ?? [])
  return selected.map(name => SKILL_TOOL_FACTORIES[name](ports))
}

const SKILL_GENERATE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['recordingId'],
  properties: {
    recordingId: { type: 'string', pattern: '^rec_[A-Za-z0-9_]+$', description: 'Completed source recording of this workspace.' },
    site: { type: 'string', minLength: 1, maxLength: 120, description: 'Optional site name; derived from the recording when omitted.' },
    flow: { type: 'string', minLength: 1, maxLength: 120, description: 'Optional flow name; derived from the recording when omitted.' },
    mode: { type: 'string', enum: ['template', 'model'], description: 'template (default) or model: let the host model enrich Summary/Preconditions/Ambiguities; steps stay deterministic and a failure falls back to template.' },
  },
}

const SKILL_REVIEW_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['draftId'],
  properties: {
    draftId: { type: 'string', pattern: '^draft_[A-Za-z0-9_]+$', description: 'Draft returned by cua_skill_generate.' },
  },
}

const SKILL_INSTALL_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['draftId', 'decision'],
  properties: {
    draftId: { type: 'string', pattern: '^draft_[A-Za-z0-9_]+$' },
    decision: { enum: ['confirmed', 'rejected'], description: 'Only "confirmed" installs; anything else is zero-write (SKILL_NOT_CONFIRMED).' },
    name: { type: 'string', minLength: 1, maxLength: 80, description: 'Optional explicit skill name; derived from site/flow when omitted.' },
  },
}

const SKILL_SEARCH_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    site: { type: 'string', minLength: 1, maxLength: 120 },
    flow: { type: 'string', minLength: 1, maxLength: 120 },
    triggers: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    query: { type: 'string', minLength: 1, description: 'Free text matched against name/site/flow/triggers.' },
  },
}

const SKILL_LOAD_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 80 },
    version: { type: 'integer', minimum: 1, description: 'Installed version; omitted = active version.' },
  },
}

const SKILL_FEEDBACK_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'recordingId', 'skillName', 'result'],
  properties: {
    runId: { type: 'string', pattern: '^run_[A-Za-z0-9_]+$', description: 'Idempotency key: one run reports at most once.' },
    recordingId: { type: 'string', pattern: '^rec_[A-Za-z0-9_]+$' },
    skillName: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 80 },
    result: { enum: ['success', 'failed', 'cancelled'] },
    failedStepId: { type: 'string', minLength: 1, description: 'Source step id when the run failed.' },
    at: { type: 'string', description: 'ISO timestamp; defaults to now.' },
  },
}

const SKILL_TOOL_FACTORIES: {
  readonly [K in SkillHostToolName]: (ports: SkillToolPorts) => HostToolDefinition
} = {
  cua_skill_generate: ports => ({
    name: 'cua_skill_generate',
    description:
      'Generate a Skill draft from a completed recording plus a successful run. Writes _drafts/ only; never installs. Requires skill.enabled.',
    inputSchema: SKILL_GENERATE_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, ['recordingId', 'site', 'flow', 'mode'])
      const recordingId = requireRecordingIdField(fields['recordingId'])
      const site = optionalSiteOrFlow(fields['site'], 'site')
      const flow = optionalSiteOrFlow(fields['flow'], 'flow')
      const mode = fields['mode']
      if (mode !== undefined && mode !== 'template' && mode !== 'model') {
        throw invalid('mode must be "template" or "model"')
      }
      assertSkillWritesEnabled(ports)
      const draft = await ports.generate({
        recordingId,
        ...(site === undefined ? {} : { site }),
        ...(flow === undefined ? {} : { flowName: flow }),
        ...(mode === undefined ? {} : { mode }),
      }, call)
      return asJson({ ...draft })
    },
  }),

  cua_skill_review: ports => ({
    name: 'cua_skill_review',
    description:
      'Read one draft and return its summary, ambiguities, provenance and pre-install validation. Read-only: it never writes skills/.',
    inputSchema: SKILL_REVIEW_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, ['draftId'])
      const draftId = requireDraftIdField(fields['draftId'])
      return asJson(publicDraftSummary(await ports.review(draftId, call)))
    },
  }),

  cua_skill_install: ports => ({
    name: 'cua_skill_install',
    description:
      'Install one draft after reviewer confirmation. decision must be "confirmed"; rejected or missing confirmation is zero-write (SKILL_NOT_CONFIRMED).',
    inputSchema: SKILL_INSTALL_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, ['draftId', 'decision', 'name'])
      const draftId = requireDraftIdField(fields['draftId'])
      const decision = requireInstallDecision(fields['decision'])
      const name = fields['name'] === undefined ? undefined : requireSkillNameField(fields['name'], 'name')
      assertSkillWritesEnabled(ports)
      const installed = await ports.install({ draftId, decision, ...(name === undefined ? {} : { name }) }, call)
      return asJson(publicInstalledSkill(installed))
    },
  }),

  cua_skill_search: ports => ({
    name: 'cua_skill_search',
    description:
      'Search the installed skill index by site/flow/triggers/free text. Read-only: no browser action, no Cua side effect.',
    inputSchema: SKILL_SEARCH_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, ['site', 'flow', 'triggers', 'query'])
      const site = optionalSiteOrFlow(fields['site'], 'site')
      const flow = optionalSiteOrFlow(fields['flow'], 'flow')
      const triggers = optionalStringArray(fields['triggers'], 'triggers')
      const query = optionalSiteOrFlow(fields['query'], 'query')
      const searchQuery: SkillQuery = {
        ...(site === undefined ? {} : { site }),
        ...(flow === undefined ? {} : { flow }),
        ...(triggers === undefined ? {} : { triggers }),
        ...(query === undefined ? {} : { query }),
      }
      return asJson(publicSearchResult(await ports.search(searchQuery, call)))
    },
  }),

  cua_skill_load: ports => ({
    name: 'cua_skill_load',
    description:
      'Load the full SKILL.md of an installed skill (active version, or an explicit version). Read-only, no browser action.',
    inputSchema: SKILL_LOAD_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, ['name', 'version'])
      const name = requireSkillNameField(fields['name'], 'name')
      const version = optionalPositiveInteger(fields['version'], 'version', Number.MAX_SAFE_INTEGER)
      return asJson(publicLoadedSkill(await ports.load(name, version, call)))
    },
  }),

  cua_skill_feedback: ports => ({
    name: 'cua_skill_feedback',
    description:
      'Report one run outcome back to a skill. runId is the idempotency key; failed runs mark needs_review, cancelled runs do not count. Requires skill.enabled.',
    inputSchema: SKILL_FEEDBACK_SCHEMA as unknown as JsonObject,
    handle: async (args, call) => {
      const fields = readArguments(args, ['runId', 'recordingId', 'skillName', 'result', 'failedStepId', 'at'])
      const runId = requireRunIdField(fields['runId'])
      const recordingId = requireRecordingIdField(fields['recordingId'])
      const skillName = requireSkillNameField(fields['skillName'], 'skillName')
      const result = requireFeedbackResultField(fields['result'])
      const failedStepId = optionalString(fields['failedStepId'], 'failedStepId')
      const at = fields['at'] === undefined ? new Date().toISOString() : requireIsoTimestamp(fields['at'], 'at')
      assertSkillWritesEnabled(ports)
      const feedback: SkillFeedback = {
        runId,
        recordingId,
        skillName,
        result,
        ...(failedStepId === undefined ? {} : { failedStepId }),
        at,
      }
      return asJson(await ports.feedback(feedback, call))
    },
  }),
}

/** 写族工具的功能开关：`skill.enabled=false` 时统一 `FEATURE_DISABLED`（IF-7）。 */
function assertSkillWritesEnabled(ports: SkillToolPorts): void {
  assertFeatureEnabled(ports.config, 'skill')
}

/**
 * 去掉本机绝对路径字段，只把公开字段交给 Agent（design/backend.md 非目标：
 * 不直接把文件系统路径暴露给 Agent；Agent 用 name/version 定位 Skill，不需要物理路径）。
 */
function omitAbsolutePath(value: object, key: string): JsonObject {
  const out: Record<string, JsonValue> = {}
  for (const [entryKey, entry] of Object.entries(value)) {
    if (entryKey !== key) out[entryKey] = entry as JsonValue
  }
  return out
}

function publicDraftSummary(summary: SkillDraftSummary): JsonObject {
  return omitAbsolutePath(summary, 'draftPath')
}

function publicInstalledSkill(skill: InstalledSkill): JsonObject {
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(skill)) {
    if (key === 'path' || key === 'projectSkillPath') continue
    out[key] = value as JsonValue
  }
  return out
}

function publicLoadedSkill(loaded: LoadedSkill): JsonObject {
  return {
    skill: publicInstalledSkill(loaded.skill),
    frontmatter: loaded.frontmatter as JsonObject,
    markdown: loaded.markdown,
  }
}

function publicSearchResult(result: SkillSearchResult): JsonObject {
  return {
    entries: result.entries.map(entry => publicIndexEntry(entry)),
    warnings: result.warnings.map(warning => ({
      path: relativeSkillPath(warning.path),
      message: warning.message,
    })),
  }
}

function publicIndexEntry(entry: SkillIndexEntry): JsonObject {
  return omitAbsolutePath(entry, 'path')
}

/** 坏文件警告保留可定位的相对后缀（`skills/...` 或 `_drafts/...`），不泄露工作区绝对路径。 */
function relativeSkillPath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  const skillMarker = normalized.lastIndexOf('/skills/')
  if (skillMarker >= 0) return normalized.slice(skillMarker + 1)
  const draftMarker = normalized.lastIndexOf('/_drafts/')
  if (draftMarker >= 0) return normalized.slice(draftMarker + 1)
  const segments = normalized.split('/').filter(segment => segment.length > 0)
  return segments.slice(-2).join('/') || normalized
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DRAFT_ID_PATTERN = /^draft_[A-Za-z0-9_]+$/

function requireRecordingIdField(value: unknown): RecordingId {
  if (!isRecordingId(value)) throw invalid('recordingId must match ^rec_[A-Za-z0-9_]+$')
  return value
}

function requireRunIdField(value: unknown): RunId {
  if (!isRunId(value)) throw invalid('runId must match ^run_[A-Za-z0-9_]+$')
  return value
}

function requireDraftIdField(value: unknown): string {
  if (typeof value !== 'string' || !DRAFT_ID_PATTERN.test(value)) {
    throw invalid('draftId must match ^draft_[A-Za-z0-9_]+$')
  }
  return value
}

function requireSkillNameField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 80 || !SKILL_NAME_PATTERN.test(value)) {
    throw invalid(`${field} must be lower-case kebab-case and at most 80 characters`)
  }
  return value
}

function requireInstallDecision(value: unknown): 'confirmed' | 'rejected' {
  if (value !== 'confirmed' && value !== 'rejected') {
    throw invalid('decision must be "confirmed" or "rejected"')
  }
  return value
}

function requireFeedbackResultField(value: unknown): SkillFeedback['result'] {
  if (!isSkillFeedbackResult(value)) throw invalid('result must be one of: success, failed, cancelled')
  return value
}

function optionalSiteOrFlow(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 120) {
    throw invalid(`${field} must be a non-empty string up to 120 characters`)
  }
  return value.trim()
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(`${field} must be a non-empty array of non-empty strings`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw invalid(`${field}[${String(index)}] must be a non-empty string`)
    }
    return entry.trim()
  })
}

function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw invalid(`${field} must be an ISO timestamp`)
  }
  return value
}

// ---------------------------------------------------------------------------
// 参数校验：身份键先拒（FORBIDDEN），再查未知键与类型（INVALID_ARGUMENT）
// ---------------------------------------------------------------------------

function readArguments(args: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw invalid('arguments must be an object')
  }
  const record = args as Readonly<Record<string, unknown>>
  assertNoCallerSuppliedPrincipal(record, 'arguments')
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw invalid(`arguments has an unknown key "${key}"`)
  }
  return record
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${field} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, field)
}

function optionalStringMap(value: unknown, field: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${field} must be an object of string values`)
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0) throw invalid(`${field} must not contain an empty key`)
    if (typeof entry !== 'string' || entry.length === 0) {
      throw invalid(`${field}.${key} must be a non-empty string`)
    }
    out[key] = entry
  }
  return out
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalid(`${field} must be a positive integer`)
  }
  return value
}

function optionalPositiveInteger(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined) return undefined
  const parsed = requirePositiveInteger(value, field)
  if (parsed > max) throw invalid(`${field} must not exceed ${String(max)}`)
  return parsed
}

/**
 * 严格动作校验：判别联合 + 逐分支未知键拒绝（core 的 isBrowserAction 只保证形状）。
 * 允许键来自 `core/contracts.ts` 的动作/断言定义，不再在此手写副本。
 */
function requireAction(value: unknown): BrowserAction {
  if (!isBrowserAction(value)) {
    throw invalid(`action must be a valid BrowserAction: ${ACTION_KINDS.join('|')}`)
  }
  const action = value as BrowserAction
  rejectUnknownKeys(action, actionFieldNames(action.kind), 'action')

  const target = targetOfAction(action)
  if (target !== undefined) {
    rejectUnknownKeys(target, TARGET_FIELDS, 'action.target')
    if (target.url !== undefined) rejectUnknownKeys(target.url, TARGET_URL_FIELDS, 'action.target.url')
  }
  if (action.kind === 'wait') {
    rejectUnknownKeys(action.condition, WAIT_CONDITION_FIELDS, 'action.condition')
  }
  if (action.kind === 'assert') {
    rejectUnknownKeys(action.check, assertCheckFieldNames(action.check.kind), 'action.check')
    if (action.check.kind === 'element' || action.check.kind === 'value') {
      rejectUnknownKeys(action.check.target, TARGET_FIELDS, 'action.check.target')
      if (action.check.target.url !== undefined) rejectUnknownKeys(action.check.target.url, TARGET_URL_FIELDS, 'action.check.target.url')
    }
  }
  return action
}

function targetOfAction(action: BrowserAction): SemanticTarget | undefined {
  switch (action.kind) {
    case 'click':
    case 'setValue':
      return action.target
    case 'scroll':
    case 'key':
      return action.target
    default:
      return undefined
  }
}

function rejectUnknownKeys(value: unknown, allowed: readonly string[], field: string): void {
  if (typeof value !== 'object' || value === null) return
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`${field} has an unknown key "${key}"`)
  }
}

function invalid(message: string): HostError {
  return new HostError('INVALID_ARGUMENT', message)
}
