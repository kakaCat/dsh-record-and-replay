import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import {
  SkillServiceError,
  assertSkillName,
  isSkillStatus,
  skillNameFor,
  type InstalledSkill,
  type SkillIndexEntry,
  type SkillSourceRecording,
} from './model.js'

/**
 * Skill 搜索条件（IF-4）。字段全部可选，多个字段取交集：
 * - `site` / `flow`：大小写不敏感的精确匹配。
 * - `triggers`：查询里的每个触发词都必须命中条目触发词之一（子串、大小写不敏感）。
 * - `query`：自由文本，匹配 name/site/flow/triggers 任意字段（子串、大小写不敏感）。
 */
export interface SkillQuery {
  readonly site?: string
  readonly flow?: string
  readonly triggers?: readonly string[]
  readonly query?: string
}

/** 单个损坏/不可读 Skill 文件的跳过记录；不阻断其它条目。 */
export interface SkillIndexWarning {
  readonly path: string
  readonly message: string
}

/**
 * 轻量索引：只含 SKILL.md frontmatter 投影，不含正文。
 * 搜索只读这一层，避免把 Skill 全文加载进内存。
 */
export interface SkillIndex {
  readonly entries: readonly SkillIndexEntry[]
  readonly warnings: readonly SkillIndexWarning[]
}

/** IF-4 的搜索结果：索引条目 + 本次扫描跳过的坏文件。 */
export type SkillSearchResult = SkillIndex

/**
 * IF-5 的加载结果：已安装 Skill 的 frontmatter 投影 + 原始 frontmatter + 全文。
 * `frontmatter` 保留原始字段，供调用方读取未纳入 InstalledSkill 的扩展字段。
 */
export interface LoadedSkill {
  readonly skill: InstalledSkill
  readonly frontmatter: Readonly<Record<string, unknown>>
  readonly markdown: string
}

export interface SkillCatalog {
  search(query?: SkillQuery): Promise<readonly SkillIndexEntry[]>
  searchDetailed(query?: SkillQuery): Promise<SkillSearchResult>
  /** IF-5：按 name（可选 version）只读加载 SKILL.md 全文与 frontmatter。 */
  load(name: string, version?: number): Promise<LoadedSkill>
  /** 最近一次扫描跳过的坏文件；空数组表示全部干净。 */
  readonly warnings: readonly SkillIndexWarning[]
}

export interface FsSkillCatalogOptions {
  /** Skill 根目录；安装布局为 `<root>/skills/<site>/<flow>/SKILL.md`。 */
  readonly root: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

interface ParsedFrontmatter {
  readonly fields: Record<string, unknown>
  /** frontmatter 之后的正文（保留原始换行）。 */
  readonly body: string
}

/**
 * 拆分 frontmatter 与正文；值格式与 `store.ts` 的序列化对齐：
 * JSON 字面量优先，失败回退为去引号字符串。
 */
function splitFrontmatter(markdown: string): ParsedFrontmatter {
  const match = FRONTMATTER.exec(markdown)
  const raw = match?.[1]
  if (match === null || raw === undefined) {
    throw new SkillServiceError('SKILL_CORRUPT', 'SKILL.md is missing frontmatter')
  }
  const fields: Record<string, unknown> = {}
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const pair = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    const key = pair?.[1]
    if (pair === null || key === undefined) {
      throw new SkillServiceError('SKILL_CORRUPT', `invalid frontmatter line: ${line}`)
    }
    const value = (pair[2] ?? '').trim()
    if (value.length === 0) {
      fields[key] = ''
      continue
    }
    try {
      fields[key] = JSON.parse(value) as unknown
    } catch {
      fields[key] = value.replace(/^["']|["']$/g, '')
    }
  }
  return { fields, body: markdown.slice((match[0] ?? '').length) }
}

/** 只解析 frontmatter 块；正文丢弃，保证索引不持有全文。 */
function parseFrontmatterFields(markdown: string): Record<string, unknown> {
  return splitFrontmatter(markdown).fields
}

function stringField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new SkillServiceError('SKILL_CORRUPT', `frontmatter field ${key} must be a non-empty string`)
  }
  return value
}

function optionalStringField(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key]
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') {
    throw new SkillServiceError('SKILL_CORRUPT', `frontmatter field ${key} must be a string`)
  }
  return value
}

function stringArrayField(fields: Record<string, unknown>, key: string): readonly string[] {
  const value = fields[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new SkillServiceError('SKILL_CORRUPT', `frontmatter field ${key} must be a string array`)
  }
  return value
}

/** 把一份 SKILL.md 投影成索引条目；坏字段抛 SKILL_CORRUPT 由调用方转成警告。 */
function indexEntryFromMarkdown(markdown: string, filePath: string): SkillIndexEntry {
  const fields = parseFrontmatterFields(markdown)
  const name = stringField(fields, 'name')
  assertSkillName(name)
  const status = stringField(fields, 'status')
  if (!isSkillStatus(status)) {
    throw new SkillServiceError('SKILL_CORRUPT', 'frontmatter field status must be active, needs_review or deprecated')
  }
  const lastVerified = optionalStringField(fields, 'last_verified')
  return {
    name,
    site: stringField(fields, 'site'),
    flow: stringField(fields, 'flow'),
    triggers: stringArrayField(fields, 'triggers'),
    path: filePath,
    sourceRecordingIds: sourcesField(fields).map(source => source.recordingId),
    ...(lastVerified === undefined ? {} : { lastVerified }),
    status,
  }
}

function numberField(fields: Record<string, unknown>, key: string): number {
  const value = fields[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SkillServiceError('SKILL_CORRUPT', `frontmatter field ${key} must be a non-negative integer`)
  }
  return value
}

function sourcesField(fields: Record<string, unknown>): readonly SkillSourceRecording[] {
  const value = fields['source_recordings']
  if (!Array.isArray(value)) throw new SkillServiceError('SKILL_CORRUPT', 'source_recordings must be an array')
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new SkillServiceError('SKILL_CORRUPT', 'source_recordings entry must be an object')
    }
    const source = item as Record<string, unknown>
    if (typeof source['recordingId'] !== 'string' || typeof source['sha256'] !== 'string') {
      throw new SkillServiceError('SKILL_CORRUPT', 'source_recordings entry needs recordingId and sha256')
    }
    return { recordingId: source['recordingId'] as SkillSourceRecording['recordingId'], sha256: source['sha256'] }
  })
}

interface ParsedSkillFile {
  readonly skill: InstalledSkill
  readonly frontmatter: Record<string, unknown>
  readonly markdown: string
}

/**
 * IF-5：把已安装的 SKILL.md 解析成 LoadedSkill 的载荷。
 *
 * 只做结构校验（frontmatter 字段齐全、version ≥ 1、正文非空、来源非空），
 * 不做安全/质量门禁——质量校验属于生成与安装阶段（security.ts），加载是只读读取。
 */
function parseLoadedSkill(markdown: string, filePath: string): ParsedSkillFile {
  const { fields, body } = splitFrontmatter(markdown)
  if (body.trim().length === 0) {
    throw new SkillServiceError('SKILL_CORRUPT', 'SKILL.md body is empty')
  }
  const name = stringField(fields, 'name')
  assertSkillName(name)
  const version = numberField(fields, 'version')
  if (version < 1) throw new SkillServiceError('SKILL_CORRUPT', 'version must be >= 1')
  const status = stringField(fields, 'status')
  if (!isSkillStatus(status)) {
    throw new SkillServiceError('SKILL_CORRUPT', 'frontmatter field status must be active, needs_review or deprecated')
  }
  const sourceRecordings = sourcesField(fields)
  if (sourceRecordings.length === 0) {
    throw new SkillServiceError('SKILL_CORRUPT', 'source_recordings must not be empty')
  }
  const needsReview = fields['needs_review']
  if (needsReview !== undefined && needsReview !== '' && typeof needsReview !== 'boolean') {
    throw new SkillServiceError('SKILL_CORRUPT', 'frontmatter field needs_review must be a boolean')
  }
  const lastVerified = optionalStringField(fields, 'last_verified')
  const skill: InstalledSkill = {
    name,
    version,
    path: filePath,
    site: stringField(fields, 'site'),
    flow: stringField(fields, 'flow'),
    triggers: stringArrayField(fields, 'triggers'),
    sourceRecordings,
    ...(lastVerified === undefined ? {} : { lastVerified }),
    successCount: numberField(fields, 'success_count'),
    failureCount: numberField(fields, 'failure_count'),
    needsReview: needsReview === true,
    status,
  }
  return { skill, frontmatter: fields, markdown }
}

/** 一个 `skills/<site>/<flow>/` 目录下的全部版本文件与损坏记录。 */
interface SkillGroup {
  readonly dir: string
  readonly site: string
  readonly flow: string
  active: ParsedSkillFile | null
  activeCorrupt: string | null
  readonly versions: Map<number, ParsedSkillFile>
  readonly corruptVersions: Map<number, string>
  /** 该目录下所有可解析文件声明的 name（用于确认请求的 name 是否属于本目录）。 */
  readonly names: Set<string>
}

interface SkillFileRef {
  readonly file: string
  readonly groupDir: string
  readonly kind: 'active' | 'version'
  readonly version?: number
}

function emptyGroup(dir: string): SkillGroup {
  return {
    dir,
    site: path.basename(path.dirname(dir)),
    flow: path.basename(dir),
    active: null,
    activeCorrupt: null,
    versions: new Map(),
    corruptVersions: new Map(),
    names: new Set(),
  }
}

/** 目录名反推 Skill 名；仅用于 frontmatter 已损坏、无法声明 name 时的兜底诊断。 */
function derivedSkillName(group: SkillGroup): string | undefined {
  try {
    return skillNameFor(group.site, group.flow)
  } catch {
    return undefined
  }
}

/** 记录一份不可解析的 SKILL.md；active 指针与版本副本分开归类，供 load 区分错误码。 */
function recordCorrupt(group: SkillGroup, ref: SkillFileRef, message: string): void {
  if (ref.kind === 'active') {
    group.activeCorrupt ??= message
    return
  }
  if (ref.version !== undefined) group.corruptVersions.set(ref.version, message)
}

function firstValue<T>(values: Iterable<T>): T | undefined {
  for (const value of values) return value
  return undefined
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/** 触发词匹配：任意方向子串命中即可，兼顾精确触发词与较长的自然语言触发词。 */
function triggerMatches(candidate: string, wanted: string): boolean {
  const left = normalize(candidate)
  const right = normalize(wanted)
  return left === right || left.includes(right) || right.includes(left)
}

function assertQuery(query: SkillQuery): void {
  for (const field of ['site', 'flow', 'query'] as const) {
    const value = query[field]
    if (value !== undefined && typeof value !== 'string') {
      throw new SkillServiceError('SKILL_INVALID', `search field ${field} must be a string`)
    }
  }
  if (query.triggers !== undefined) {
    if (!Array.isArray(query.triggers) || query.triggers.some(item => typeof item !== 'string')) {
      throw new SkillServiceError('SKILL_INVALID', 'search field triggers must be a string array')
    }
  }
}

function entryMatches(entry: SkillIndexEntry, query: SkillQuery): boolean {
  const site = query.site === undefined ? '' : normalize(query.site)
  if (site.length > 0 && normalize(entry.site) !== site) return false

  const flow = query.flow === undefined ? '' : normalize(query.flow)
  if (flow.length > 0 && normalize(entry.flow) !== flow) return false

  if (query.triggers !== undefined) {
    const wanted = query.triggers.map(item => item.trim()).filter(item => item.length > 0)
    // 多个触发词取交集：每个都要命中，便于逐层收窄检索。
    for (const wantedTrigger of wanted) {
      if (!entry.triggers.some(trigger => triggerMatches(trigger, wantedTrigger))) return false
    }
  }

  const needle = query.query === undefined ? '' : normalize(query.query)
  if (needle.length > 0) {
    const haystack = [entry.name, entry.site, entry.flow, ...entry.triggers].map(normalize)
    if (!haystack.some(value => value.includes(needle))) return false
  }

  return true
}

function compareEntries(left: SkillIndexEntry, right: SkillIndexEntry): number {
  const byName = left.name.localeCompare(right.name)
  if (byName !== 0) return byName
  const bySite = left.site.localeCompare(right.site)
  if (bySite !== 0) return bySite
  const byFlow = left.flow.localeCompare(right.flow)
  if (byFlow !== 0) return byFlow
  return left.path.localeCompare(right.path)
}

/**
 * 文件型 SkillCatalog（IF-4）：扫描 `<root>/skills/<site>/<flow>/SKILL.md` 的
 * frontmatter 建立轻量索引，按 site/flow/triggers/query 搜索。
 *
 * 直接扫描目录而不是复用 `FsSkillStore.listInstalled()`：后者会静默吞掉坏文件，
 * 无法满足 TC-6「坏 Skill 跳过并警告」。目录布局与 FsSkillStore 保持一致。
 */
export class FsSkillCatalog implements SkillCatalog {
  private readonly skillsRoot: string
  private lastWarnings: readonly SkillIndexWarning[] = []

  constructor(options: FsSkillCatalogOptions) {
    this.skillsRoot = path.join(options.root, 'skills')
  }

  get warnings(): readonly SkillIndexWarning[] {
    return this.lastWarnings
  }

  /** 重建索引；`skills/` 目录缺失视为空索引（尚未安装任何 Skill）。 */
  async buildIndex(): Promise<SkillIndex> {
    let sites: string[]
    try {
      sites = await readdir(this.skillsRoot)
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        this.lastWarnings = []
        return { entries: [], warnings: [] }
      }
      throw new SkillServiceError('SKILL_INDEX_UNAVAILABLE', `skill index root is unreadable: ${this.skillsRoot}`, {
        cause: error,
      })
    }

    const entries: SkillIndexEntry[] = []
    const warnings: SkillIndexWarning[] = []
    for (const site of [...sites].sort()) {
      if (site.startsWith('_')) continue
      const siteDir = path.join(this.skillsRoot, site)
      let flows: string[]
      try {
        flows = await readdir(siteDir)
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') continue
        // 单个站点目录不可读：跳过并警告，不阻断其它站点。
        warnings.push({ path: siteDir, message: `unreadable site directory: ${describeError(error)}` })
        continue
      }
      for (const flow of [...flows].sort()) {
        if (flow.startsWith('_') || flow === 'versions') continue
        const file = path.join(siteDir, flow, 'SKILL.md')
        let markdown: string
        try {
          markdown = await readFile(file, 'utf8')
        } catch (error) {
          if (errnoCode(error) === 'ENOENT') continue
          warnings.push({ path: file, message: `unreadable SKILL.md: ${describeError(error)}` })
          continue
        }
        try {
          entries.push(indexEntryFromMarkdown(markdown, file))
        } catch (error) {
          // 单文件损坏只跳过，保留其余条目。
          warnings.push({ path: file, message: describeError(error) })
        }
      }
    }

    entries.sort(compareEntries)
    this.lastWarnings = warnings
    return { entries, warnings }
  }

  /**
   * 枚举 `skills/<site>/<flow>/SKILL.md` 与 `skills/<site>/<flow>/versions/v<N>/SKILL.md`。
   * 目录布局与 `FsSkillStore` 的安装布局保持一致；目录不可读沿用索引语义。
   */
  private async listSkillFiles(): Promise<readonly SkillFileRef[]> {
    let siteEntries: Dirent[]
    try {
      siteEntries = await readdir(this.skillsRoot, { withFileTypes: true })
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return []
      throw new SkillServiceError('SKILL_INDEX_UNAVAILABLE', `skill index root is unreadable: ${this.skillsRoot}`, {
        cause: error,
      })
    }

    const refs: SkillFileRef[] = []
    for (const siteEntry of [...siteEntries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (siteEntry.name.startsWith('_') || !siteEntry.isDirectory()) continue
      const siteDir = path.join(this.skillsRoot, siteEntry.name)
      let flowEntries: Dirent[]
      try {
        flowEntries = await readdir(siteDir, { withFileTypes: true })
      } catch {
        // 单个站点目录不可读：跳过；load 只关心能否找到目标 Skill。
        continue
      }
      for (const flowEntry of [...flowEntries].sort((left, right) => left.name.localeCompare(right.name))) {
        if (flowEntry.name.startsWith('_') || flowEntry.name === 'versions' || !flowEntry.isDirectory()) continue
        const flowDir = path.join(siteDir, flowEntry.name)
        refs.push({ file: path.join(flowDir, 'SKILL.md'), groupDir: flowDir, kind: 'active' })

        let versionEntries: Dirent[]
        try {
          versionEntries = await readdir(path.join(flowDir, 'versions'), { withFileTypes: true })
        } catch {
          continue
        }
        for (const versionEntry of versionEntries) {
          const match = /^v([1-9]\d*)$/.exec(versionEntry.name)
          const matchedVersion = match?.[1]
          if (matchedVersion === undefined || !versionEntry.isDirectory()) continue
          const parsedVersion = Number(matchedVersion)
          if (!Number.isSafeInteger(parsedVersion)) continue
          refs.push({
            file: path.join(flowDir, 'versions', versionEntry.name, 'SKILL.md'),
            groupDir: flowDir,
            kind: 'version',
            version: parsedVersion,
          })
        }
      }
    }
    return refs
  }

  /**
   * IF-5：按 name + 可选 version 只读加载 SKILL.md 全文与 frontmatter。
   *
   * 版本选择：
   * - 未指定 version → active 指针 `skills/<site>/<flow>/SKILL.md`（安装时写入的最新版本）；
   *   active 指针缺失时回退到已解析的最大版本副本。
   * - 指定 version → 精确匹配该版本副本（active 或 `versions/v<N>/SKILL.md`）；
   *   该版本不存在返回 SKILL_NOT_FOUND，不静默返回别的版本。
   * - 同名多目录（违反 name 唯一不变量）→ 未指定版本时取最高版本，tie-break 目录路径。
   *
   * 错误分类：文件存在但 frontmatter/正文不可解析 → SKILL_CORRUPT；完全找不到 → SKILL_NOT_FOUND。
   * 只读：不写任何文件，也不改动索引警告状态。
   */
  async load(name: string, version?: number): Promise<LoadedSkill> {
    const wanted = assertSkillName(name)
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
      throw new SkillServiceError('SKILL_INVALID', 'version must be a positive integer')
    }

    const groups = new Map<string, SkillGroup>()
    for (const ref of await this.listSkillFiles()) {
      let group = groups.get(ref.groupDir)
      if (group === undefined) {
        group = emptyGroup(ref.groupDir)
        groups.set(ref.groupDir, group)
      }
      let markdown: string
      try {
        markdown = await readFile(ref.file, 'utf8')
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') continue
        recordCorrupt(group, ref, `unreadable SKILL.md: ${describeError(error)}`)
        continue
      }
      try {
        const parsed = parseLoadedSkill(markdown, ref.file)
        group.names.add(parsed.skill.name)
        if (ref.kind === 'active') group.active = parsed
        else if (ref.version !== undefined) group.versions.set(ref.version, parsed)
      } catch (error) {
        recordCorrupt(group, ref, describeError(error))
      }
    }

    const matches: ParsedSkillFile[] = []
    let corruptReason: string | null = null
    const orderedGroups = [...groups.values()].sort((left, right) => left.dir.localeCompare(right.dir))
    for (const group of orderedGroups) {
      const nameKnown = group.names.has(wanted)
      if (!nameKnown) {
        // 目录名推断只用于「该目录没有任何可解析文件声明 name」的兜底；
        // 目录里有其他健康 Skill 的 name 时不能把它当成同名 Skill 的坏文件。
        if (group.names.size > 0 || derivedSkillName(group) !== wanted) continue
        corruptReason ??= group.activeCorrupt
          ?? firstValue(group.corruptVersions.values())
          ?? `skill ${wanted} frontmatter is unreadable`
        continue
      }

      if (version === undefined) {
        if (group.active !== null) {
          matches.push(group.active)
          continue
        }
        if (group.activeCorrupt !== null) {
          corruptReason ??= group.activeCorrupt
          continue
        }
        const highest = [...group.versions.entries()].sort((left, right) => right[0] - left[0])[0]
        if (highest !== undefined) {
          matches.push(highest[1])
          continue
        }
        const corruptVersion = firstValue(group.corruptVersions.values())
        if (corruptReason === null && corruptVersion !== undefined) corruptReason = corruptVersion
        continue
      }

      if (group.active !== null && group.active.skill.version === version) {
        matches.push(group.active)
        continue
      }
      const pinned = group.versions.get(version)
      if (pinned !== undefined) {
        matches.push(pinned)
        continue
      }
      const pinnedCorrupt = group.corruptVersions.get(version)
      if (pinnedCorrupt !== undefined) {
        corruptReason ??= pinnedCorrupt
        continue
      }
      if (group.activeCorrupt !== null && group.versions.size === 0) corruptReason ??= group.activeCorrupt
    }

    if (matches.length > 0) {
      const selected = version === undefined
        ? matches.reduce((best, current) => (current.skill.version > best.skill.version ? current : best))
        : matches[0]
      if (selected !== undefined) {
        return { skill: selected.skill, frontmatter: selected.frontmatter, markdown: selected.markdown }
      }
    }
    if (corruptReason !== null) {
      throw new SkillServiceError('SKILL_CORRUPT', `skill ${wanted} is corrupt: ${corruptReason}`)
    }
    throw new SkillServiceError(
      'SKILL_NOT_FOUND',
      version === undefined ? `skill ${wanted} not found` : `skill ${wanted} version ${String(version)} not found`,
    )
  }

  /** IF-4：只返回索引条目；坏文件通过 `warnings` 暴露。 */
  async search(query: SkillQuery = {}): Promise<readonly SkillIndexEntry[]> {
    return (await this.searchDetailed(query)).entries
  }

  /** 同 `search`，但一次性带回本轮扫描的警告，供 Host 工具回执使用。 */
  async searchDetailed(query: SkillQuery = {}): Promise<SkillSearchResult> {
    assertQuery(query)
    const index = await this.buildIndex()
    return {
      entries: index.entries.filter(entry => entryMatches(entry, query)),
      warnings: index.warnings,
    }
  }
}
