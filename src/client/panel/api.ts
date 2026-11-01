import type {
  PanelActiveRecording,
  PanelCapabilities,
  PanelCategoryWriteResult,
  PanelCrossProjectSearchResult,
  PanelProject,
  PanelProjectsPage,
  PanelProjectSummary,
  PanelRecordingControlResult,
  PanelRecordingDetail,
  PanelRecordingWriteResult,
  PanelReplayStartResult,
  PanelScenarioCreateResult,
  PanelScenarioWriteResult,
  PanelSearchResult,
  PanelStatsReport,
  PanelTrashResult,
} from '../../panel/types.js'

/** `limit`/`offset` for the paginated project and recording lists. */
export interface PanelPageQuery {
  readonly limit?: number
  readonly offset?: number
}

export class PanelApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'PanelApiError'
    this.code = code
    this.status = status
  }
}

/**
 * M3-lite write face. Only the DSH mount exposes it (`PATCH/POST` routes);
 * the standalone `/panel/` command deliberately stays read-only, so the
 * property is optional and the panel hides editing when it is absent.
 */
export interface PanelWriteApi {
  updateCategory(root: string, id: string, name: string): Promise<PanelCategoryWriteResult>
  updateScenario(root: string, id: string, name: string): Promise<PanelScenarioWriteResult>
  createScenario(
    root: string,
    categoryId: string,
    name: string,
    options?: { readonly includeUngrouped?: boolean },
  ): Promise<PanelScenarioCreateResult>
  updateRecording(
    root: string,
    recordingId: string,
    patch: { readonly title?: string; readonly scenarioId?: string | null },
  ): Promise<PanelRecordingWriteResult>
}

/**
 * M3 recording actions.
 *
 * `replay` needs the DSH host replay service; `trash` only needs filesystem
 * access. The buttons are driven by `capabilities()` so the standalone panel
 * can show a disabled 重跑 button with an explanation instead of failing late.
 */
export interface PanelRecordingActionsApi {
  replay(
    root: string,
    recordingId: string,
    options?: { readonly values?: Readonly<Record<string, string>> },
  ): Promise<PanelReplayStartResult>
  trash(root: string, recordingId: string): Promise<PanelTrashResult>
  /** Stop an active recording; the host derives the owner principal from the manifest. */
  stop(root: string, recordingId: string): Promise<PanelRecordingControlResult>
  /** Discard an active recording (kept on disk as `cancelled`). */
  discard(root: string, recordingId: string): Promise<PanelRecordingControlResult>
}

export interface PanelApi {
  /** Convenience: the whole selector list (the HTTP endpoint caps a single page). */
  listProjects(): Promise<PanelProjectSummary[]>
  /** One page of the project selector, for the panel's infinite query. */
  listProjectsPage?(query?: PanelPageQuery): Promise<PanelProjectsPage>
  /** Whiten an explicitly picked folder and remember it for this machine. */
  readonly addRoot?: (root: string) => Promise<PanelProjectSummary>
  getProject(root: string, page?: PanelPageQuery): Promise<PanelProject>
  getRecording(root: string, recordingId: string): Promise<PanelRecordingDetail>
  search(root: string, query: string): Promise<PanelSearchResult>
  /** Cross-project search (no root / `*`). Results are grouped by project. */
  searchAll(query: string, options?: { readonly limit?: number }): Promise<PanelCrossProjectSearchResult>
  /** System + per-project statistics for the "全部项目" mode. */
  stats(): Promise<PanelStatsReport>
  videoUrl(root: string, runId: string, options?: { readonly download?: boolean }): string
  /** Recordings currently in `recording` status across whitelisted projects. */
  listActive?(root?: string): Promise<readonly PanelActiveRecording[]>
  /** Replay/trash/control availability for this panel process (M3/P1-1). */
  capabilities?(): Promise<PanelCapabilities>
  /** Present only on entries that expose the M3 action routes (the DSH mount). */
  readonly actions?: PanelRecordingActionsApi
  /** Present only on entries with write routes (the DSH right-sidebar mount). */
  readonly write?: PanelWriteApi
}

interface ApiErrorBody {
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

function queryString(params: Readonly<Record<string, string | number | undefined>>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    const text = String(value)
    if (text.length > 0) search.set(key, text)
  }
  const encoded = search.toString()
  return encoded.length === 0 ? '' : `?${encoded}`
}

function pageParams(page: PanelPageQuery | undefined): { limit?: number; offset?: number } {
  return {
    ...(page?.limit === undefined ? {} : { limit: page.limit }),
    ...(page?.offset === undefined ? {} : { offset: page.offset }),
  }
}

async function readError(response: Response): Promise<PanelApiError> {
  let body: ApiErrorBody | undefined
  try {
    body = await response.json() as ApiErrorBody
  } catch {
    body = undefined
  }
  const code = typeof body?.error?.code === 'string' ? body.error.code : 'PANEL_REQUEST_FAILED'
  const message = typeof body?.error?.message === 'string'
    ? body.error.message
    : `panel request failed with status ${String(response.status)}`
  return new PanelApiError(code, message, response.status)
}

/**
 * Build the panel API against one route prefix.
 *
 * The standalone command serves the panel at `/panel`; the DSH client plugin
 * mounts the same data routes at `/api/record-replay`, backed by the host's
 * authenticated connection. Keeping the prefix a parameter is what lets one
 * component tree serve both entry points without a hard-coded port.
 */
export function createPanelApi(prefix = '/panel', fetchImpl: typeof fetch = fetch): PanelApi {
  const baseUrl = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix

  async function request<T>(
    path: string,
    params: Readonly<Record<string, string | number | undefined>>,
    init?: { readonly method: 'GET' | 'PATCH' | 'POST'; readonly body?: unknown },
  ): Promise<T> {
    const url = `${baseUrl}${path}${queryString(params)}`
    const response = await fetchImpl(url, {
      method: init?.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      credentials: 'same-origin',
    })
    if (!response.ok) throw await readError(response)
    return await response.json() as T
  }

  const write: PanelWriteApi = {
    async updateCategory(root, id, name) {
      return await request<PanelCategoryWriteResult>('/category', { root }, {
        method: 'PATCH',
        body: { id, name },
      })
    },
    async updateScenario(root, id, name) {
      return await request<PanelScenarioWriteResult>('/scenario', { root }, {
        method: 'PATCH',
        body: { id, name },
      })
    },
    async createScenario(root, categoryId, name, options = {}) {
      return await request<PanelScenarioCreateResult>('/scenario', { root }, {
        method: 'POST',
        body: {
          categoryId,
          name,
          ...(options.includeUngrouped === undefined
            ? {}
            : { includeUngrouped: options.includeUngrouped }),
        },
      })
    },
    async updateRecording(root, recordingId, patch) {
      return await request<PanelRecordingWriteResult>('/recording', { root }, {
        method: 'PATCH',
        body: {
          id: recordingId,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.scenarioId === undefined ? {} : { scenarioId: patch.scenarioId }),
        },
      })
    },
  }

  const actions: PanelRecordingActionsApi = {
    async replay(root, recordingId, options = {}) {
      return await request<PanelReplayStartResult>('/replay', {}, {
        method: 'POST',
        body: {
          root,
          recordingId,
          ...(options.values === undefined ? {} : { values: options.values }),
        },
      })
    },
    async trash(root, recordingId) {
      return await request<PanelTrashResult>('/trash', {}, {
        method: 'POST',
        body: { root, recordingId },
      })
    },
    async stop(root, recordingId) {
      return await request<PanelRecordingControlResult>('/stop', {}, {
        method: 'POST',
        body: { root, recordingId },
      })
    },
    async discard(root, recordingId) {
      return await request<PanelRecordingControlResult>('/discard', {}, {
        method: 'POST',
        body: { root, recordingId },
      })
    },
  }

  return {
    async listProjects() {
      const payload = await request<PanelProjectsPage>('/projects', {})
      return [...payload.projects]
    },
    async listProjectsPage(query = {}) {
      return await request<PanelProjectsPage>('/projects', pageParams(query))
    },
    async addRoot(root) {
      const payload = await request<{ project: PanelProjectSummary }>('/root', {}, {
        method: 'POST',
        body: { root },
      })
      return payload.project
    },
    async getProject(root, page = {}) {
      const payload = await request<{ project: PanelProject }>('/project', {
        root,
        ...pageParams(page),
      })
      return payload.project
    },
    async getRecording(root, recordingId) {
      return await request<PanelRecordingDetail>('/recording', { root, id: recordingId })
    },
    async search(root, query) {
      return await request<PanelSearchResult>('/search', { root, q: query })
    },
    async searchAll(query, options = {}) {
      return await request<PanelCrossProjectSearchResult>('/search', {
        q: query,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      })
    },
    async stats() {
      return await request<PanelStatsReport>('/stats', {})
    },
    async listActive(root) {
      return await request<readonly PanelActiveRecording[]>('/active', root === undefined ? {} : { root })
    },
    async capabilities() {
      return await request<PanelCapabilities>('/capabilities', {})
    },
    videoUrl(root, runId, options = {}) {
      return `${baseUrl}/video${queryString({
        root,
        runId,
        ...(options.download === true ? { download: '1' } : {}),
      })}`
    },
    actions,
    write,
  }
}

export const panelApi: PanelApi = createPanelApi()
