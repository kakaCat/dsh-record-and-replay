/**
 * Project index (`.dsh/record-replay/index.json`) loading and read-only rebuild.
 *
 * M1 never writes the index: when the file is missing or corrupt the categories
 * are rebuilt in memory from each recording's site so browsing still works.
 */
import { readFile } from 'node:fs/promises'

import { PanelError } from './errors.js'
import {
  PANEL_INDEX_VERSION,
  type PanelIndex,
  type PanelIndexAssignment,
  type PanelIndexCategory,
  type PanelIndexScenario,
  type PanelIndexSource,
  type PanelIndexState,
} from './types.js'
import {
  categoryIdForSite,
  isRecordingId,
  panelIndexPath,
  siteDisplayName,
} from './paths.js'

export interface IndexedRecordingRef {
  readonly recordingId: string
  readonly site: string
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Public category for a site token. */
export function categoryForSite(site: string): PanelIndexCategory {
  const id = categoryIdForSite(site)
  return { id, name: siteDisplayName(site), site }
}

/** Build the in-memory index used when index.json is missing or corrupt. */
export function rebuildIndex(recordings: readonly IndexedRecordingRef[]): PanelIndex {
  const seen = new Map<string, PanelIndexCategory>()
  for (const recording of recordings) {
    const category = categoryForSite(recording.site)
    if (!seen.has(category.id)) seen.set(category.id, category)
  }
  return {
    version: PANEL_INDEX_VERSION,
    categories: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    scenarios: [],
    assignments: {},
  }
}

/** Strictly parse a persisted index; `undefined` means the shape is not a v1 index. */
export function parsePanelIndex(value: unknown): PanelIndex | undefined {
  if (!isRecord(value)) return undefined
  if (value['version'] !== PANEL_INDEX_VERSION) return undefined
  const categoriesRaw = value['categories']
  const scenariosRaw = value['scenarios']
  const assignmentsRaw = value['assignments']
  if (!Array.isArray(categoriesRaw) || !Array.isArray(scenariosRaw) || !isRecord(assignmentsRaw)) {
    return undefined
  }

  const categoryIds = new Set<string>()
  const categories: PanelIndexCategory[] = []
  for (const entry of categoriesRaw) {
    if (!isRecord(entry)) return undefined
    if (!nonEmptyString(entry['id']) || !nonEmptyString(entry['name']) || !nonEmptyString(entry['site'])) {
      return undefined
    }
    if (categoryIds.has(entry['id'])) return undefined
    categoryIds.add(entry['id'])
    categories.push({ id: entry['id'], name: entry['name'], site: entry['site'] })
  }

  const scenarioIds = new Set<string>()
  const scenarios: PanelIndexScenario[] = []
  for (const entry of scenariosRaw) {
    if (!isRecord(entry)) return undefined
    if (
      !nonEmptyString(entry['id'])
      || !nonEmptyString(entry['categoryId'])
      || !nonEmptyString(entry['name'])
    ) {
      return undefined
    }
    if (scenarioIds.has(entry['id'])) return undefined
    scenarioIds.add(entry['id'])
    scenarios.push({ id: entry['id'], categoryId: entry['categoryId'], name: entry['name'] })
  }

  const assignments: Record<string, PanelIndexAssignment> = {}
  for (const [recordingId, entry] of Object.entries(assignmentsRaw)) {
    if (!isRecord(entry)) return undefined
    if (!isRecordingId(recordingId)) return undefined
    const scenarioId = nonEmptyString(entry['scenarioId']) ? entry['scenarioId'] : undefined
    const intent = nonEmptyString(entry['intent']) ? entry['intent'] : undefined
    const title = nonEmptyString(entry['title']) ? entry['title'] : undefined
    // An assignment must carry something: a scenario, an intent, a title, or a mix.
    if (scenarioId === undefined && intent === undefined && title === undefined) return undefined
    assignments[recordingId] = {
      ...(scenarioId === undefined ? {} : { scenarioId }),
      ...(intent === undefined ? {} : { intent }),
      ...(title === undefined ? {} : { title }),
    }
  }

  return {
    version: PANEL_INDEX_VERSION,
    categories,
    scenarios,
    assignments,
  }
}

function uniqueCategoryId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

/**
 * Merge auto categories for sites the persisted index does not know about.
 * A valid index keeps its names, scenarios and assignments; only missing
 * categories are appended. The write path persists this merged index, so the
 * helper is shared instead of duplicated.
 */
export function mergeIndex(base: PanelIndex, recordings: readonly IndexedRecordingRef[]): PanelIndex {
  const categories = [...base.categories]
  const used = new Set(categories.map((category) => category.id))
  const sites = new Set(categories.map((category) => category.site))
  let added = 0
  for (const recording of recordings) {
    if (sites.has(recording.site)) continue
    const auto = categoryForSite(recording.site)
    const id = uniqueCategoryId(auto.id, used)
    categories.push({ ...auto, id })
    used.add(id)
    sites.add(recording.site)
    added += 1
  }
  if (added === 0) return base
  return {
    ...base,
    categories: categories.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function sanitizeIndex(base: PanelIndex): { index: PanelIndex; warnings: string[] } {
  const warnings: string[] = []
  const categoryIds = new Set(base.categories.map((category) => category.id))
  const scenarios = base.scenarios.filter((scenario) => categoryIds.has(scenario.categoryId))
  if (scenarios.length !== base.scenarios.length) {
    warnings.push('index.json contains scenarios whose category is missing; they were ignored')
  }
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.id))
  const assignments: Record<string, PanelIndexAssignment> = {}
  let droppedScenarioRefs = 0
  for (const [recordingId, assignment] of Object.entries(base.assignments)) {
    if (assignment.scenarioId !== undefined && !scenarioIds.has(assignment.scenarioId)) {
      droppedScenarioRefs += 1
      // Keep the annotation: an intent without a scenario is still useful.
      if (assignment.intent === undefined) continue
      assignments[recordingId] = { intent: assignment.intent }
      continue
    }
    assignments[recordingId] = assignment
  }
  if (droppedScenarioRefs > 0) {
    warnings.push('index.json contains assignments to missing scenarios; they were ignored')
  }
  return { index: { ...base, scenarios, assignments }, warnings }
}

/**
 * Load `<root>/.dsh/record-replay/index.json`.
 *
 * Missing/corrupt/unreadable → in-memory rebuild (source `rebuilt`).
 * Valid → merge missing site categories (source `loaded`).
 */
export async function loadPanelIndex(
  projectRoot: string,
  recordings: readonly IndexedRecordingRef[],
): Promise<PanelIndexState> {
  const filePath = panelIndexPath(projectRoot)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENOENT') {
      return {
        index: rebuildIndex(recordings),
        source: 'rebuilt',
        warnings: ['index.json is missing; categories were rebuilt from recording sites (read-only)'],
      }
    }
    return {
      index: rebuildIndex(recordings),
      source: 'rebuilt',
      warnings: ['index.json could not be read; categories were rebuilt from recording sites (read-only)'],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      index: rebuildIndex(recordings),
      source: 'rebuilt',
      warnings: ['index.json is not valid JSON; categories were rebuilt from recording sites (read-only)'],
    }
  }

  const index = parsePanelIndex(parsed)
  if (index === undefined) {
    return {
      index: rebuildIndex(recordings),
      source: 'rebuilt',
      warnings: ['index.json does not match version 1; categories were rebuilt from recording sites (read-only)'],
    }
  }

  const sanitized = sanitizeIndex(index)
  const merged = mergeIndex(sanitized.index, recordings)
  const warnings = [...sanitized.warnings]
  if (merged.categories.length !== sanitized.index.categories.length) {
    warnings.push('index.json was missing categories for some sites; they were added in read-only mode')
  }
  return { index: merged, source: 'loaded', warnings }
}

export interface IndexAssignment {
  readonly categoryId: string
  readonly scenarioId?: string
  /** Index-annotated intent; overrides the recording manifest when set. */
  readonly intent?: string
  /** Index-annotated title; overrides the recording manifest when set. */
  readonly title?: string
}

/** Resolve the category/scenario/intent/title a recording belongs to under a loaded index. */
export function assignmentFor(index: PanelIndex, recording: IndexedRecordingRef): IndexAssignment {
  const category = index.categories.find((entry) => entry.site === recording.site)
  const assignment = index.assignments[recording.recordingId]
  if (category === undefined) {
    const auto = categoryForSite(recording.site)
    return {
      categoryId: auto.id,
      ...(assignment?.intent === undefined ? {} : { intent: assignment.intent }),
      ...(assignment?.title === undefined ? {} : { title: assignment.title }),
    }
  }
  if (assignment === undefined) return { categoryId: category.id }
  const target = assignment.scenarioId === undefined
    ? undefined
    : index.scenarios.find((entry) => entry.id === assignment.scenarioId)
  return {
    categoryId: category.id,
    ...(target === undefined ? {} : { scenarioId: target.id }),
    ...(assignment.intent === undefined ? {} : { intent: assignment.intent }),
    ...(assignment.title === undefined ? {} : { title: assignment.title }),
  }
}

/** Defensive guard used by the service when an index is passed in from elsewhere. */
export function assertPanelIndex(value: unknown): PanelIndex {
  const parsed = parsePanelIndex(value)
  if (parsed === undefined) {
    throw new PanelError('PANEL_INTERNAL', 'panel index is invalid', 500)
  }
  return parsed
}

export type { PanelIndex, PanelIndexSource, PanelIndexState }
