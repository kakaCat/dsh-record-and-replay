/**
 * Index write path for the panel (M3-lite: rename + 未分组收纳).
 *
 * Only `<root>/.dsh/record-replay/index.json` is ever written. Recording
 * manifests, steps and runs stay byte-identical: the panel's title override
 * lives in the index, exactly like the `intent` annotation from M1.6.
 *
 * Concurrency model:
 *   - writes to one index file are serialized by a process-local queue, so a
 *     read-modify-write cannot lose a concurrent rename;
 *   - replacement uses a same-directory temp file (`index.json.tmp-<rand>`),
 *     fsync and rename. A concurrent reader therefore observes either the old
 *     or the new complete JSON, never a half-written file;
 *   - readers stay lock-free (`readFile` + `JSON.parse`).
 *
 * Corrupt-index policy:
 *   - missing index → rebuild categories from recording sites, then write;
 *   - valid index → keep names/scenarios/assignments, add missing site
 *     categories, then write;
 *   - index that parses as JSON v1 but has invalid parts → rebuild categories
 *     from sites and keep every readable assignment (never silently blank the
 *     annotations);
 *   - index that is not JSON / not a v1 object → PANEL_INDEX_CORRUPT, no write.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import * as path from 'node:path'

import { PanelError, panelBadRequest, panelNotFound } from './errors.js'
import {
  mergeIndex,
  parsePanelIndex,
  type IndexedRecordingRef,
} from './index-store.js'
import { isRecordingId, panelIndexPath } from './paths.js'
import { scanRecordingRefs } from './scanner.js'
import {
  PANEL_INDEX_VERSION,
  type PanelCategoryWriteResult,
  type PanelIndex,
  type PanelIndexAssignment,
  type PanelIndexCategory,
  type PanelIndexScenario,
  type PanelIndexSource,
  type PanelIndexWriteResult,
  type PanelRecordingWriteResult,
  type PanelScenarioCreateResult,
  type PanelScenarioWriteResult,
} from './types.js'

export const PANEL_NAME_MAX_LENGTH = 80
/** Category/scenario ids are JSON keys, never path segments; still keep them boring. */
export const PANEL_SLUG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

const SALVAGE_WARNING =
  'index.json was partially unreadable; categories were rebuilt from recording sites and readable annotations were kept'

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inputObject(input: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(input)) {
    throw panelBadRequest('PANEL_INVALID_BODY', 'request body must be a JSON object')
  }
  return input
}

/** Trim a display name, reject empty/oversized/control-character names. */
export function assertPanelName(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw panelBadRequest('PANEL_INVALID_NAME', `${what} must be a string`)
  }
  const name = value.trim()
  if (name.length === 0) {
    throw panelBadRequest('PANEL_INVALID_NAME', `${what} must not be empty`)
  }
  if ([...name].length > PANEL_NAME_MAX_LENGTH) {
    throw panelBadRequest(
      'PANEL_INVALID_NAME',
      `${what} must be at most ${String(PANEL_NAME_MAX_LENGTH)} characters`,
    )
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw panelBadRequest('PANEL_INVALID_NAME', `${what} must not contain control characters`)
  }
  return name
}

export function assertPanelSlugId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !PANEL_SLUG_ID_PATTERN.test(value)) {
    throw new PanelError(
      'PANEL_INVALID_ID',
      `${what} must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`,
      400,
    )
  }
  return value
}

function assertPanelRecordingId(value: unknown): string {
  if (!isRecordingId(value)) {
    throw new PanelError('PANEL_INVALID_ID', 'recording id must match ^rec_[A-Za-z0-9_]+$', 400)
  }
  return value
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function compactAssignment(assignment: PanelIndexAssignment): PanelIndexAssignment {
  return {
    ...(assignment.scenarioId === undefined ? {} : { scenarioId: assignment.scenarioId }),
    ...(assignment.intent === undefined ? {} : { intent: assignment.intent }),
    ...(assignment.title === undefined ? {} : { title: assignment.title }),
  }
}

// ---------------------------------------------------------------------------
// Serial queue
// ---------------------------------------------------------------------------

/** Process-local FIFO queue keyed by the index path. */
export class PanelIndexWriteQueue {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return await result
  }
}

/** Shared by every PanelService/route in this process. */
export const panelIndexWriteQueue = new PanelIndexWriteQueue()

// ---------------------------------------------------------------------------
// Load for write
// ---------------------------------------------------------------------------

interface LoadedIndex {
  readonly index: PanelIndex
  readonly source: PanelIndexSource
  readonly warnings: readonly string[]
  /** Recording ids/sites read in the same pass as the index. */
  readonly recordings: readonly IndexedRecordingRef[]
}

function salvagedCategories(
  value: Readonly<Record<string, unknown>>,
  recordings: readonly IndexedRecordingRef[],
): readonly PanelIndexCategory[] {
  const raw = value['categories']
  const categories: PanelIndexCategory[] = []
  const ids = new Set<string>()
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) continue
      const id = stringField(entry['id'])
      const name = stringField(entry['name'])
      const site = stringField(entry['site'])
      if (id === undefined || name === undefined || site === undefined || ids.has(id)) continue
      ids.add(id)
      categories.push({ id, name, site })
    }
  }
  const base: PanelIndex = {
    version: PANEL_INDEX_VERSION,
    categories,
    scenarios: [],
    assignments: {},
  }
  return mergeIndex(base, recordings).categories
}

function salvageIndex(
  value: Readonly<Record<string, unknown>>,
  recordings: readonly IndexedRecordingRef[],
): PanelIndex {
  const categories = salvagedCategories(value, recordings)
  const categoryIds = new Set(categories.map((category) => category.id))

  const scenarios: PanelIndexScenario[] = []
  const scenarioIds = new Set<string>()
  const scenariosRaw = value['scenarios']
  if (Array.isArray(scenariosRaw)) {
    for (const entry of scenariosRaw) {
      if (!isRecord(entry)) continue
      const id = stringField(entry['id'])
      const categoryId = stringField(entry['categoryId'])
      const name = stringField(entry['name'])
      if (id === undefined || categoryId === undefined || name === undefined) continue
      if (scenarioIds.has(id) || !categoryIds.has(categoryId)) continue
      scenarioIds.add(id)
      scenarios.push({ id, categoryId, name })
    }
  }

  const assignments: Record<string, PanelIndexAssignment> = {}
  const assignmentsRaw = value['assignments']
  if (isRecord(assignmentsRaw)) {
    for (const [recordingId, entry] of Object.entries(assignmentsRaw)) {
      if (!isRecordingId(recordingId) || !isRecord(entry)) continue
      const rawScenarioId = stringField(entry['scenarioId'])
      const intent = stringField(entry['intent'])
      const title = stringField(entry['title'])
      // Keep the scenario link only when the scenario itself survived salvage.
      const scenarioId = rawScenarioId !== undefined && scenarioIds.has(rawScenarioId)
        ? rawScenarioId
        : undefined
      if (scenarioId === undefined && intent === undefined && title === undefined) continue
      assignments[recordingId] = {
        ...(scenarioId === undefined ? {} : { scenarioId }),
        ...(intent === undefined ? {} : { intent }),
        ...(title === undefined ? {} : { title }),
      }
    }
  }

  return {
    version: PANEL_INDEX_VERSION,
    categories,
    scenarios,
    assignments,
  }
}

function corruptIndex(message: string, cause?: unknown): PanelError {
  return new PanelError(
    'PANEL_INDEX_CORRUPT',
    `${message}; fix or remove index.json before writing`,
    409,
    cause === undefined ? undefined : { cause },
  )
}

async function loadIndexForWrite(
  projectRoot: string,
  recordings: readonly IndexedRecordingRef[],
): Promise<LoadedIndex> {
  const filePath = panelIndexPath(projectRoot)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return {
        index: mergeIndex(
          { version: PANEL_INDEX_VERSION, categories: [], scenarios: [], assignments: {} },
          recordings,
        ),
        source: 'rebuilt',
        warnings: ['index.json is missing; it was rebuilt from recording sites before writing'],
        recordings,
      }
    }
    throw new PanelError(
      'PANEL_INDEX_UNREADABLE',
      `index.json could not be read: ${messageOf(error)}`,
      500,
      { cause: error },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw corruptIndex('index.json is not valid JSON', error)
  }
  if (!isRecord(parsed)) throw corruptIndex('index.json must be a JSON object')
  if (parsed['version'] !== PANEL_INDEX_VERSION) {
    throw corruptIndex(`index.json must have version ${String(PANEL_INDEX_VERSION)}`)
  }

  const strict = parsePanelIndex(parsed)
  if (strict !== undefined) {
    const merged = mergeIndex(strict, recordings)
    return {
      index: merged,
      source: 'loaded',
      warnings: merged === strict
        ? []
        : ['index.json was missing categories for some sites; they were added while writing'],
      recordings,
    }
  }

  // Version 1 but partially invalid: rebuild the tree shape from recording
  // sites while keeping every assignment we can still read.
  return {
    index: salvageIndex(parsed, recordings),
    source: 'rebuilt',
    warnings: [SALVAGE_WARNING],
    recordings,
  }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/** Stable on-disk shape: sorted ids/keys, compact optional fields, trailing newline. */
export function serializePanelIndex(index: PanelIndex): PanelIndex {
  const categories = [...index.categories].sort((left, right) => left.id.localeCompare(right.id))
  const scenarios = [...index.scenarios].sort(
    (left, right) => left.categoryId.localeCompare(right.categoryId) || left.id.localeCompare(right.id),
  )
  const assignments = Object.fromEntries(
    Object.entries(index.assignments)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([recordingId, assignment]) => [recordingId, compactAssignment(assignment)]),
  )
  return { version: PANEL_INDEX_VERSION, categories, scenarios, assignments }
}

/** Replace `index.json` through a same-directory temp file + fsync + rename. */
export async function writePanelIndexAtomic(projectRoot: string, index: PanelIndex): Promise<void> {
  const serialized = serializePanelIndex(index)
  if (parsePanelIndex(serialized) === undefined) {
    throw new PanelError('PANEL_WRITE_FAILED', 'refusing to persist an index that does not parse', 500)
  }
  const target = panelIndexPath(projectRoot)
  const body = `${JSON.stringify(serialized, null, 2)}\n`
  const temporary = `${target}.tmp-${randomUUID().replaceAll('-', '')}`
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(body, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw new PanelError(
      'PANEL_WRITE_FAILED',
      `index.json could not be written: ${messageOf(error)}`,
      500,
      { cause: error },
    )
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function uniqueScenarioId(name: string, used: ReadonlySet<string>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  const base = slug.length === 0
    ? `scn_${randomUUID().replaceAll('-', '').slice(0, 10)}`
    : `scn_${slug}`
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}-${String(index)}`)) index += 1
  return `${base}-${String(index)}`
}

export interface PanelIndexWriterOptions {
  /** Override the shared queue (tests that want isolation). */
  readonly queue?: PanelIndexWriteQueue
}

/** Outcome of removing one recording's annotation (M3 trash). */
export interface PanelRecordingRemovalResult {
  readonly recordingId: string
  /** False when the recording had no assignment in the index. */
  readonly removed: boolean
}

export class PanelIndexWriter {
  private readonly queue: PanelIndexWriteQueue

  constructor(options: PanelIndexWriterOptions = {}) {
    this.queue = options.queue ?? panelIndexWriteQueue
  }

  private async load(projectRoot: string): Promise<LoadedIndex> {
    return await loadIndexForWrite(projectRoot, await scanRecordingRefs(projectRoot))
  }

  private async mutate<T>(
    projectRoot: string,
    apply: (loaded: LoadedIndex) => Promise<{
      readonly index: PanelIndex
      readonly result: T
    }>,
  ): Promise<T & { readonly indexSource: PanelIndexSource; readonly warnings: readonly string[] }> {
    return await this.queue.run(panelIndexPath(projectRoot), async () => {
      const loaded = await this.load(projectRoot)
      const { index, result } = await apply(loaded)
      await writePanelIndexAtomic(projectRoot, index)
      return { ...result, indexSource: loaded.source, warnings: loaded.warnings }
    })
  }

  /** Rename one category. */
  async updateCategory(projectRoot: string, input: unknown): Promise<PanelCategoryWriteResult> {
    const body = inputObject(input)
    const id = assertPanelSlugId(body['id'], 'category id')
    const name = assertPanelName(body['name'], 'category name')
    return await this.mutate(projectRoot, async (loaded) => {
      const existing = loaded.index.categories.find((category) => category.id === id)
      if (existing === undefined) {
        throw panelNotFound('PANEL_CATEGORY_NOT_FOUND', `category ${id} does not exist in this project`)
      }
      const category: PanelIndexCategory = { ...existing, name }
      return {
        index: {
          ...loaded.index,
          categories: loaded.index.categories.map((entry) => (entry.id === id ? category : entry)),
        },
        result: { category },
      }
    })
  }

  /** Rename one scenario. */
  async updateScenario(projectRoot: string, input: unknown): Promise<PanelScenarioWriteResult> {
    const body = inputObject(input)
    const id = assertPanelSlugId(body['id'], 'scenario id')
    const name = assertPanelName(body['name'], 'scenario name')
    return await this.mutate(projectRoot, async (loaded) => {
      const existing = loaded.index.scenarios.find((scenario) => scenario.id === id)
      if (existing === undefined) {
        throw panelNotFound('PANEL_SCENARIO_NOT_FOUND', `scenario ${id} does not exist in this project`)
      }
      const scenario: PanelIndexScenario = { ...existing, name }
      return {
        index: {
          ...loaded.index,
          scenarios: loaded.index.scenarios.map((entry) => (entry.id === id ? scenario : entry)),
        },
        result: { scenario },
      }
    })
  }

  /**
   * Create a scenario under a category.
   * With `includeUngrouped`, every recording of that category without a
   * scenario is assigned to the new one in the same atomic write.
   */
  async createScenario(projectRoot: string, input: unknown): Promise<PanelScenarioCreateResult> {
    const body = inputObject(input)
    const categoryId = assertPanelSlugId(body['categoryId'], 'category id')
    const name = assertPanelName(body['name'], 'scenario name')
    const includeUngrouped = body['includeUngrouped']
    if (includeUngrouped !== undefined && typeof includeUngrouped !== 'boolean') {
      throw panelBadRequest('PANEL_INVALID_BODY', 'includeUngrouped must be a boolean when present')
    }
    return await this.mutate(projectRoot, async (loaded) => {
      const category = loaded.index.categories.find((entry) => entry.id === categoryId)
      if (category === undefined) {
        throw panelNotFound('PANEL_CATEGORY_NOT_FOUND', `category ${categoryId} does not exist in this project`)
      }
      const scenario: PanelIndexScenario = {
        id: uniqueScenarioId(name, new Set(loaded.index.scenarios.map((entry) => entry.id))),
        categoryId,
        name,
      }
      const assignments: Record<string, PanelIndexAssignment> = { ...loaded.index.assignments }
      let assignedCount = 0
      if (includeUngrouped === true) {
        const categoryScenarios = new Set(
          loaded.index.scenarios
            .filter((entry) => entry.categoryId === categoryId)
            .map((entry) => entry.id),
        )
        for (const ref of loaded.recordings) {
          const recordingCategory = loaded.index.categories.find((entry) => entry.site === ref.site)
          if (recordingCategory?.id !== categoryId) continue
          const current = assignments[ref.recordingId]
          // Dangling/cross-category scenario refs are effectively 未分组 for the tree.
          if (current?.scenarioId !== undefined && categoryScenarios.has(current.scenarioId)) continue
          assignments[ref.recordingId] = {
            ...(current?.intent === undefined ? {} : { intent: current.intent }),
            ...(current?.title === undefined ? {} : { title: current.title }),
            scenarioId: scenario.id,
          }
          assignedCount += 1
        }
      }
      return {
        index: {
          ...loaded.index,
          scenarios: [...loaded.index.scenarios, scenario],
          assignments,
        },
        result: { scenario, assignedCount },
      }
    })
  }

  /**
   * Rename a recording (index override) and/or move it between scenarios.
   * `scenarioId: null` / `''` moves the recording back to 未分组; the manifest
   * is never touched.
   */
  async updateRecording(projectRoot: string, input: unknown): Promise<PanelRecordingWriteResult> {
    const body = inputObject(input)
    const recordingId = assertPanelRecordingId(body['id'])
    const hasTitle = Object.hasOwn(body, 'title')
    const hasScenario = Object.hasOwn(body, 'scenarioId')
    if (!hasTitle && !hasScenario) {
      throw panelBadRequest('PANEL_INVALID_BODY', 'at least one of title or scenarioId is required')
    }
    const title = hasTitle ? assertPanelName(body['title'], 'recording title') : undefined
    let clearScenario = false
    let nextScenarioId: string | undefined
    if (hasScenario) {
      const raw = body['scenarioId']
      if (raw === null || raw === '') {
        clearScenario = true
      } else {
        nextScenarioId = assertPanelSlugId(raw, 'scenario id')
      }
    }

    return await this.mutate(projectRoot, async (loaded) => {
      const ref = loaded.recordings.find((entry) => entry.recordingId === recordingId)
      if (ref === undefined) {
        throw panelNotFound('PANEL_RECORDING_NOT_FOUND', `recording ${recordingId} was not found in this project`)
      }
      const existing = loaded.index.assignments[recordingId]
      let scenarioId = existing?.scenarioId
      if (hasScenario) {
        if (clearScenario) {
          scenarioId = undefined
        } else {
          const target = loaded.index.scenarios.find((scenario) => scenario.id === nextScenarioId)
          if (target === undefined) {
            throw panelNotFound('PANEL_SCENARIO_NOT_FOUND', `scenario ${String(nextScenarioId)} does not exist`)
          }
          const recordingCategory = loaded.index.categories.find((entry) => entry.site === ref.site)
          if (recordingCategory !== undefined && target.categoryId !== recordingCategory.id) {
            throw panelBadRequest(
              'PANEL_SCENARIO_MISMATCH',
              `scenario ${target.id} belongs to category ${target.categoryId}, not ${recordingCategory.id}`,
            )
          }
          scenarioId = target.id
        }
      }
      const nextTitle = title ?? existing?.title
      const assignment: PanelIndexAssignment = compactAssignment({
        ...(scenarioId === undefined ? {} : { scenarioId }),
        ...(existing?.intent === undefined ? {} : { intent: existing.intent }),
        ...(nextTitle === undefined ? {} : { title: nextTitle }),
      })
      const assignments: Record<string, PanelIndexAssignment> = { ...loaded.index.assignments }
      if (Object.keys(assignment).length === 0) {
        delete assignments[recordingId]
      } else {
        assignments[recordingId] = assignment
      }
      return {
        index: { ...loaded.index, assignments },
        result: { recordingId, assignment },
      }
    })
  }

  /**
   * Drop one recording's annotation (M3 trash).
   *
   * Called after the recording directory has been moved to `trash/`, so the
   * recording no longer appears in `scanRecordingRefs` — the write therefore
   * must not require the recording to still exist. An index that has no entry
   * for it is still rewritten (a missing index is rebuilt from the remaining
   * recordings), which keeps the on-disk document consistent for readers.
   */
  async removeRecordingAssignment(
    projectRoot: string,
    recordingId: string,
  ): Promise<PanelRecordingRemovalResult & PanelIndexWriteResult> {
    const safeId = assertPanelRecordingId(recordingId)
    return await this.mutate(projectRoot, async (loaded) => {
      const assignments: Record<string, PanelIndexAssignment> = { ...loaded.index.assignments }
      const removed = Object.hasOwn(assignments, safeId)
      delete assignments[safeId]
      return {
        index: { ...loaded.index, assignments },
        result: { recordingId: safeId, removed },
      }
    })
  }
}

/** Default writer used by `PanelService`; shares the process-wide queue. */
export const panelIndexWriter = new PanelIndexWriter()
