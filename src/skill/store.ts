import { open, readFile, readdir, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import type { RecordingId } from '../core/ids.js'
import {
  SkillServiceError,
  assertDraftId,
  assertSkillDraftShape,
  assertSkillName,
  skillNameFor,
  type InstalledSkill,
  type SkillDraft,
  type SkillSourceRecording,
  type SkillStatus,
} from './model.js'
import { assertSafeSkillDraft } from './security.js'

export interface SkillStore {
  saveDraft(draft: SkillDraft): Promise<string>
  readDraft(draftId: string): Promise<{ readonly draft: SkillDraft; readonly draftPath: string }>
  install(draftId: string, options: SkillInstallOptions): Promise<InstalledSkill>
  listInstalled(): Promise<readonly InstalledSkill[]>
  load(name: string, version?: number): Promise<{ readonly skill: InstalledSkill; readonly markdown: string }>
}

/** IF-3 安装参数：`confirmed` 是审查者的确认位，false 时零写入。 */
export interface SkillInstallOptions {
  readonly confirmed: boolean
  /** 可选显式 Skill 名；缺省由 site/flow 派生。 */
  readonly name?: string
}

export interface FsSkillStoreOptions {
  readonly root: string
}

/** 安装互斥锁：进程崩溃遗留的锁超过该时长才允许回收。 */
const INSTALL_LOCK_TTL_MS = 30_000

/** 每个 Skill 目录内的安装记录（draftId → version），用于 IF-3 的安装幂等。 */
const INSTALL_RECORD_FILE = '.install-record.json'

/** 每个 Skill 目录内的安装互斥锁文件名。 */
const INSTALL_LOCK_FILE = '.install.lock'

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}

/** 同名已安装 Skill 的最高版本；没有则为 0。 */
function maxInstalledVersion(skills: readonly InstalledSkill[], name: string): number {
  return skills.filter(skill => skill.name === name).reduce((max, skill) => Math.max(max, skill.version), 0)
}

function slugSegment(value: string, field: string): string {
  if (/[\\/]/.test(value) || value === '.' || value === '..') {
    throw new SkillServiceError('SKILL_STORE_PATH_ESCAPE', `${field} must not contain path separators`)
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length === 0 || slug === '.' || slug === '..') {
    throw new SkillServiceError('SKILL_STORE_PATH_ESCAPE', `${field} cannot be used as a directory name`)
  }
  return slug
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${String(process.pid)}-${String(Date.now())}`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, filePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw new SkillServiceError('SKILL_STORE_WRITE_FAILED', `failed to write ${path.basename(filePath)}`, { cause: error })
  }
}

function splitFrontmatter(markdown: string): { readonly fields: Record<string, unknown>; readonly body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (match === null) {
    throw new SkillServiceError('SKILL_CORRUPT', 'SKILL.md is missing frontmatter')
  }
  const fields: Record<string, unknown> = {}
  const rawFields = match[1]
  if (rawFields === undefined) {
    throw new SkillServiceError('SKILL_CORRUPT', 'SKILL.md frontmatter is empty')
  }
  for (const line of rawFields.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const pair = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (pair === null) throw new SkillServiceError('SKILL_CORRUPT', `invalid frontmatter line: ${line}`)
    const key = pair[1]
    const raw = (pair[2] ?? '').trim()
    if (key === undefined) throw new SkillServiceError('SKILL_CORRUPT', `invalid frontmatter line: ${line}`)
    if (raw.length === 0) {
      fields[key] = ''
      continue
    }
    try {
      fields[key] = JSON.parse(raw) as unknown
    } catch {
      fields[key] = raw.replace(/^["']|["']$/g, '')
    }
  }
  return { fields, body: markdown.slice((match[0] ?? '').length) }
}

function stringField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new SkillServiceError('SKILL_CORRUPT', `frontmatter field ${key} must be a non-empty string`)
  }
  return value
}

function numberField(fields: Record<string, unknown>, key: string): number {
  const value = fields[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SkillServiceError('SKILL_CORRUPT', `frontmatter field ${key} must be a non-negative integer`)
  }
  return value
}

function arrayField(fields: Record<string, unknown>, key: string): readonly string[] {
  const value = fields[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new SkillServiceError('SKILL_CORRUPT', `frontmatter field ${key} must be a string array`)
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
    return { recordingId: source['recordingId'] as RecordingId, sha256: source['sha256'] }
  })
}

function serializeInstalled(skill: InstalledSkill, markdown: string): string {
  const fields: Array<[string, unknown]> = [
    ['name', skill.name],
    ['version', skill.version],
    ['site', skill.site],
    ['flow', skill.flow],
    ['triggers', skill.triggers],
    ['source_recordings', skill.sourceRecordings],
    ['success_count', skill.successCount],
    ['failure_count', skill.failureCount],
    ['needs_review', skill.needsReview],
    ['status', skill.status],
  ]
  if (skill.lastVerified !== undefined) fields.push(['last_verified', skill.lastVerified])
  const frontmatter = fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')
  return `---\n${frontmatter}\n---\n\n${markdown.trim()}\n`
}

function installedFromMarkdown(markdown: string, filePath: string): InstalledSkill {
  const { fields } = splitFrontmatter(markdown)
  const name = stringField(fields, 'name')
  assertSkillName(name)
  const version = numberField(fields, 'version')
  if (version < 1) throw new SkillServiceError('SKILL_CORRUPT', 'version must be >= 1')
  const status = stringField(fields, 'status')
  if (status !== 'active' && status !== 'needs_review' && status !== 'deprecated') {
    throw new SkillServiceError('SKILL_CORRUPT', 'invalid skill status')
  }
  const lastVerified = typeof fields['last_verified'] === 'string' ? fields['last_verified'] : undefined
  return {
    name,
    version,
    path: filePath,
    site: stringField(fields, 'site'),
    flow: stringField(fields, 'flow'),
    triggers: arrayField(fields, 'triggers'),
    sourceRecordings: sourcesField(fields),
    ...(lastVerified === undefined ? {} : { lastVerified }),
    successCount: numberField(fields, 'success_count'),
    failureCount: numberField(fields, 'failure_count'),
    needsReview: fields['needs_review'] === true,
    status: status as SkillStatus,
  }
}

/** 文件型 SkillStore：草案在 _drafts/，安装版本在 skills/<site>/<flow>/versions/。 */
export class FsSkillStore implements SkillStore {
  private readonly root: string

  constructor(options: FsSkillStoreOptions) {
    this.root = options.root
  }

  private draftDir(draftId: string): string {
    return path.join(this.root, '_drafts', assertDraftId(draftId))
  }

  private skillDir(site: string, flow: string): string {
    return path.join(this.root, 'skills', slugSegment(site, 'site'), slugSegment(flow, 'flow'))
  }

  private draftMarkdownPath(draftId: string): string {
    return path.join(this.draftDir(draftId), 'SKILL.md')
  }

  async saveDraft(draft: SkillDraft): Promise<string> {
    assertSkillDraftShape(draft)
    slugSegment(draft.site, 'site')
    slugSegment(draft.flow, 'flow')
    assertSafeSkillDraft(draft)
    const dir = this.draftDir(draft.draftId)
    if (await stat(dir).then(() => true, () => false)) {
      throw new SkillServiceError('SKILL_DRAFT_CONFLICT', `draft ${draft.draftId} already exists`)
    }
    await mkdir(dir, { recursive: true })
    try {
      await atomicWrite(path.join(dir, 'draft.json'), `${JSON.stringify(draft, null, 2)}\n`)
      await atomicWrite(path.join(dir, 'SKILL.md'), draft.markdown.endsWith('\n') ? draft.markdown : `${draft.markdown}\n`)
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return this.draftMarkdownPath(draft.draftId)
  }

  async readDraft(draftId: string): Promise<{ readonly draft: SkillDraft; readonly draftPath: string }> {
    const dir = this.draftDir(draftId)
    try {
      const draft = JSON.parse(await readFile(path.join(dir, 'draft.json'), 'utf8')) as SkillDraft
      const markdown = await readFile(this.draftMarkdownPath(draftId), 'utf8')
      return { draft: { ...draft, markdown }, draftPath: this.draftMarkdownPath(draftId) }
    } catch (error) {
      if (error instanceof SkillServiceError) throw error
      throw new SkillServiceError('SKILL_DRAFT_NOT_FOUND', `draft ${draftId} not found`, { cause: error })
    }
  }

  /**
   * IF-3 安装：审查确认后写临时文件 + 原子 rename；同名版本递增，旧版本保留。
   *
   * 并发语义（TC-4）：
   * - Skill 目录内的 `.install.lock` 是**跨实例/跨进程**互斥锁：拿不到锁直接
   *   `SKILL_VERSION_CONFLICT`，绝不排队等待（排队会退化成两个人各写一个新版本）；
   * - 版本目录 `versions/v<N>` 用非递归 `mkdir` 原子预留；即使锁被绕过，
   *   同版本的两个写者也只能有一个成功，另一个 `SKILL_VERSION_CONFLICT`；
   * - 同一 `draftId` 已安装过时（`.install-record.json`）直接返回已安装版本，不重复递增。
   *
   * 失败语义：写失败回滚本次版本目录与安装记录，active 指针保持旧版本不变。
   */
  async install(draftId: string, options: SkillInstallOptions): Promise<InstalledSkill> {
    if (!options.confirmed) {
      throw new SkillServiceError('SKILL_NOT_CONFIRMED', 'skill draft must be confirmed before install')
    }
    const { draft } = await this.readDraft(draftId)
    assertSkillDraftShape(draft)
    // 质量门禁：秘密/坐标/缺 Verification 在写入前拦截（IF-3 SKILL_INVALID 族）。
    assertSafeSkillDraft(draft)
    const name = options.name === undefined ? skillNameFor(draft.site, draft.flow) : assertSkillName(options.name)
    const dir = this.skillDir(draft.site, draft.flow)
    const activePath = path.join(dir, 'SKILL.md')

    const installedForDraft = async (): Promise<InstalledSkill | undefined> => {
      const record = await this.readInstallRecord(dir)
      const version = record[draft.draftId]
      if (version === undefined) return undefined
      const existing = await this.readInstalledFile(path.join(dir, 'versions', `v${String(version)}`, 'SKILL.md'))
      return existing !== undefined && existing.name === name ? existing : undefined
    }
    const alreadyInstalled = await installedForDraft()
    if (alreadyInstalled !== undefined) return alreadyInstalled

    // 乐观并发：先对当前最高版本拍快照，进锁后必须仍与快照一致，否则说明有并发安装。
    // 不依赖「锁恰好被抢到」这种时序，所以并发调用（即使错峰进锁）也稳定返回 SKILL_VERSION_CONFLICT。
    const baseVersion = maxInstalledVersion(await this.listInstalled(), name)
    const lockPath = await this.acquireInstallLock(dir)
    try {
      const installedWhileWaiting = await installedForDraft()
      if (installedWhileWaiting !== undefined) return installedWhileWaiting

      const currentVersion = maxInstalledVersion(await this.listInstalled(), name)
      if (currentVersion !== baseVersion) {
        throw new SkillServiceError(
          'SKILL_VERSION_CONFLICT',
          `skill ${name} was installed concurrently (base v${String(baseVersion)}, now v${String(currentVersion)})`,
        )
      }
      const version = baseVersion + 1
      const versionsDir = path.join(dir, 'versions')
      const versionDir = path.join(versionsDir, `v${String(version)}`)
      await mkdir(versionsDir, { recursive: true })
      try {
        // O_EXCL 语义：并发写者只有一个能占到目标版本目录（乐观快照之外的第二道防线）。
        await mkdir(versionDir)
      } catch (error) {
        if (isErrno(error, 'EEXIST')) {
          throw new SkillServiceError(
            'SKILL_VERSION_CONFLICT',
            `version v${String(version)} of skill ${name} was installed concurrently`,
          )
        }
        throw new SkillServiceError('SKILL_STORE_WRITE_FAILED', 'failed to reserve a skill version directory', { cause: error })
      }

      const installed: InstalledSkill = {
        name,
        version,
        path: activePath,
        site: draft.site,
        flow: draft.flow,
        triggers: [draft.site, draft.flow],
        sourceRecordings: [{ recordingId: draft.recordingId, sha256: draft.recordingSha256 }],
        successCount: 0,
        failureCount: 0,
        needsReview: false,
        status: 'active',
      }
      const markdown = serializeInstalled(installed, draft.markdown)
      const recordBefore = await this.readInstallRecord(dir)
      try {
        // 版本副本与 active 指针都走临时文件 + 原子 rename（先副本、后指针）。
        await atomicWrite(path.join(versionDir, 'SKILL.md'), markdown)
        await atomicWrite(
          path.join(dir, INSTALL_RECORD_FILE),
          `${JSON.stringify({ ...recordBefore, [draft.draftId]: version }, null, 2)}\n`,
        )
        await atomicWrite(activePath, markdown)
      } catch (error) {
        // 回滚：不留半个版本、不留半条安装记录，active 指针保持旧版本。
        await rm(versionDir, { recursive: true, force: true }).catch(() => undefined)
        await this.restoreInstallRecord(dir, recordBefore)
        throw error
      }
      return installed
    } finally {
      await rm(lockPath, { force: true }).catch(() => undefined)
    }
  }

  /** 取安装互斥锁；已有活跃持锁者（或刚抢到锁的另一个实例）→ SKILL_VERSION_CONFLICT。 */
  private async acquireInstallLock(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true })
    const lockPath = path.join(dir, INSTALL_LOCK_FILE)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        return lockPath
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) {
          throw new SkillServiceError('SKILL_STORE_WRITE_FAILED', 'failed to create the skill install lock', { cause: error })
        }
        if (attempt > 0 || !(await this.reclaimStaleInstallLock(lockPath))) {
          throw new SkillServiceError(
            'SKILL_VERSION_CONFLICT',
            'another install is already in progress for this skill',
          )
        }
      }
    }
    throw new SkillServiceError('SKILL_VERSION_CONFLICT', 'could not acquire the skill install lock')
  }

  /** 只有心跳超时的遗留锁可回收；拿不到可信内容也按遗留锁处理。 */
  private async reclaimStaleInstallLock(lockPath: string): Promise<boolean> {
    let raw: string
    try {
      raw = await readFile(lockPath, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return true
      return false
    }
    let startedAt = Number.NaN
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (typeof parsed['startedAt'] === 'number') startedAt = parsed['startedAt']
    } catch {
      // 锁内容损坏：按遗留锁回收。
    }
    if (Number.isFinite(startedAt) && Date.now() - startedAt <= INSTALL_LOCK_TTL_MS) return false
    await rm(lockPath, { force: true }).catch(() => undefined)
    return true
  }

  private async readInstallRecord(dir: string): Promise<Record<string, number>> {
    let raw: string
    try {
      raw = await readFile(path.join(dir, INSTALL_RECORD_FILE), 'utf8')
    } catch {
      return {}
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const record: Record<string, number> = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 1) record[key] = value
      }
      return record
    } catch {
      return {}
    }
  }

  /** 回滚安装记录到本次安装前的快照；没有历史记录时删除文件，避免留下空 JSON。 */
  private async restoreInstallRecord(dir: string, record: Record<string, number>): Promise<void> {
    const file = path.join(dir, INSTALL_RECORD_FILE)
    if (Object.keys(record).length === 0) {
      await rm(file, { force: true }).catch(() => undefined)
      return
    }
    await atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`).catch(() => undefined)
  }

  private async readInstalledFile(file: string): Promise<InstalledSkill | undefined> {
    try {
      return installedFromMarkdown(await readFile(file, 'utf8'), file)
    } catch {
      return undefined
    }
  }

  async listInstalled(): Promise<readonly InstalledSkill[]> {
    const skillsRoot = path.join(this.root, 'skills')
    let sites: string[]
    try {
      sites = await readdir(skillsRoot)
    } catch {
      return []
    }
    const installed: InstalledSkill[] = []
    for (const site of sites) {
      const flows = await readdir(path.join(skillsRoot, site)).catch(() => [] as string[])
      for (const flow of flows) {
        const file = path.join(skillsRoot, site, flow, 'SKILL.md')
        try {
          installed.push(installedFromMarkdown(await readFile(file, 'utf8'), file))
        } catch {
          // 单个坏 Skill 不阻断其它 Skill 的读取。
        }
      }
    }
    return installed
  }

  async load(name: string, version?: number): Promise<{ readonly skill: InstalledSkill; readonly markdown: string }> {
    const wanted = assertSkillName(name)
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
      throw new SkillServiceError('SKILL_INVALID', 'version must be a positive integer')
    }
    const candidates = (await this.listInstalled()).filter(skill => skill.name === wanted)
    if (candidates.length === 0) {
      throw new SkillServiceError('SKILL_NOT_FOUND', `skill ${name} not found`)
    }
    const active = candidates.reduce((best, current) => current.version > best.version ? current : best)
    const file = version === undefined
      ? active.path
      : path.join(path.dirname(active.path), 'versions', `v${String(version)}`, 'SKILL.md')
    let markdown: string
    try {
      markdown = await readFile(file, 'utf8')
    } catch (error) {
      if (version !== undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SkillServiceError('SKILL_NOT_FOUND', `skill ${name} version ${String(version)} not found`, { cause: error })
      }
      throw new SkillServiceError('SKILL_CORRUPT', `failed to read skill ${name}`, { cause: error })
    }
    try {
      return { skill: installedFromMarkdown(markdown, file), markdown }
    } catch (error) {
      if (error instanceof SkillServiceError) throw error
      throw new SkillServiceError('SKILL_CORRUPT', `failed to parse skill ${name}`, { cause: error })
    }
  }
}
