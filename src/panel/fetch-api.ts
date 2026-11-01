/**
 * Fetch API face of the panel service.
 *
 * The standalone `panel` command owns a Node `http` server (`server.ts`), but
 * when the panel is mounted inside DSH the data must travel over the host's
 * existing authenticated connection instead of a second port. DSH client
 * plugins register routes through `connection.fetch.register(route)`, whose
 * handler speaks the Web Fetch API; these routes mirror the standalone
 * endpoints, just expressed as `Response`s.
 *
 * Reads are side-effect free. M3 adds the only two actions: `POST /replay`
 * (delegated to the host's replay service; 503 when absent) and `POST /trash`
 * (an atomic move into `.dsh/record-replay/trash/`, never a delete).
 */
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'

import { PanelError, panelBadRequest } from './errors.js'
import { parseByteRange } from './http.js'
import { parsePagination, parseSearchLimit } from './pagination.js'
import type { PanelService } from './service.js'
import { PANEL_ALL_PROJECTS_ROOT } from './types.js'

/** Route shape accepted by DSH's `connection.fetch.register`. */
export interface PanelFetchRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function errorResponse(error: unknown): Response {
  if (error instanceof PanelError) {
    return jsonResponse({ error: { code: error.code, message: error.message } }, error.status)
  }
  return jsonResponse({ error: { code: 'PANEL_INTERNAL', message: 'internal panel error' } }, 500)
}

async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run()
  } catch (error) {
    return errorResponse(error)
  }
}

async function jsonObjectBody(request: Request): Promise<Readonly<Record<string, unknown>>> {
  let text: string
  try {
    text = await request.text()
  } catch {
    throw panelBadRequest('PANEL_INVALID_BODY', 'request body could not be read')
  }
  if (text.trim().length === 0) {
    throw panelBadRequest('PANEL_INVALID_BODY', 'request body must be a JSON object')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw panelBadRequest('PANEL_INVALID_BODY', 'request body must be valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw panelBadRequest('PANEL_INVALID_BODY', 'request body must be a JSON object')
  }
  return parsed as Readonly<Record<string, unknown>>
}

function methodNotAllowed(allow: readonly string[]): Response {
  return new Response(JSON.stringify({
    error: { code: 'PANEL_METHOD_NOT_ALLOWED', message: `allowed methods: ${allow.join(', ')}` },
  }), {
    status: 405,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      allow: allow.join(', '),
    },
  })
}

/** M3 action bodies carry `root`; the query parameter is still honoured. */
function rootFrom(
  body: Readonly<Record<string, unknown>>,
  url: URL,
): string | undefined {
  const fromBody = body['root']
  if (typeof fromBody === 'string') return fromBody
  return url.searchParams.get('root') ?? undefined
}

async function serveVideo(
  service: PanelService,
  request: Request,
  url: URL,
): Promise<Response> {
  const video = await service.getVideo(url.searchParams.get('runId'), url.searchParams.get('root'))
  const download = url.searchParams.get('download') === '1'
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'content-type': video.contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
  })
  if (download) headers.set('content-disposition', `attachment; filename="${video.downloadName}"`)

  if (video.size === 0) {
    headers.set('content-length', '0')
    return new Response(null, { status: 200, headers })
  }

  const range = parseByteRange(request.headers.get('range') ?? undefined, video.size)
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${String(video.size)}`)
    return new Response(null, { status: 416, headers })
  }

  const selected = range ?? { start: 0, end: video.size - 1 }
  const length = selected.end - selected.start + 1
  const status = range === undefined ? 200 : 206
  headers.set('content-length', String(length))
  if (range !== undefined) {
    headers.set('content-range', `bytes ${String(selected.start)}-${String(selected.end)}/${String(video.size)}`)
  }
  if (request.method === 'HEAD') {
    return new Response(null, { status, headers })
  }

  const stream = Readable.toWeb(createReadStream(video.filePath, {
    start: selected.start,
    end: selected.end,
  })) as ReadableStream<Uint8Array>
  return new Response(stream, { status, headers })
}

/**
 * Build the panel endpoints for DSH's connection router.
 *
 * Read endpoints (M1/M1.6 + M2 pagination/search/stats) plus the writes:
 *   GET   /projects[?limit=&offset=]
 *   GET   /project?root=…[&limit=&offset=]
 *   GET   /search?q=…[&root=…][&limit=]   (no/`*` root = all projects)
 *   GET   /stats                           system + per-project statistics
 *   GET   /capabilities                    replay/trash availability
 *   PATCH /category   rename a category
 *   PATCH /scenario   rename a scenario
 *   POST  /scenario   create a scenario (optionally collect 未分组)
 *   PATCH /recording  index-only title override and/or scenario move
 *   POST  /root       remember a folder the user picked in the directory picker
 *   GET   /active     recordings currently in `recording` status
 *   POST  /replay     start a background replay (host replay service required)
 *   POST  /trash      move one recording directory into the trash
 *   POST  /stop       stop an active recording (host control service required)
 *   POST  /discard    discard an active recording (host control service required)
 *
 * `/recording` is one route whose `methods` include GET/HEAD/PATCH, so the
 * plugin never registers the same path twice.
 *
 * @param service - panel service shared by all routes.
 * @param prefix - route prefix. Defaults to `/api/record-replay`.
 * @returns route descriptors ready for `connection.fetch.register`.
 */
export function createPanelFetchRoutes(
  service: PanelService,
  prefix = '/api/record-replay',
): PanelFetchRoute[] {
  const route = (
    path: string,
    methods: readonly string[],
    handle: (request: Request, url: URL) => Promise<Response>,
  ): PanelFetchRoute => ({
    path: `${prefix}${path}`,
    methods,
    requestBody: 'buffered',
    fetch: (request) => guarded(() => handle(request, new URL(request.url))),
  })

  return [
    route('/projects', ['GET', 'HEAD'], async (_request, url) => jsonResponse(
      await service.listProjectsPage(parsePagination(
        url.searchParams.get('limit'),
        url.searchParams.get('offset'),
      )),
    )),
    route('/project', ['GET', 'HEAD'], async (_request, url) => jsonResponse({
      project: await service.getProject(
        url.searchParams.get('root'),
        parsePagination(url.searchParams.get('limit'), url.searchParams.get('offset')),
      ),
    })),
    route('/recording', ['GET', 'HEAD', 'PATCH'], async (request, url) => {
      const method = request.method.toUpperCase()
      if (method === 'PATCH') {
        return jsonResponse(await service.updateRecording(
          url.searchParams.get('root'),
          await jsonObjectBody(request),
        ))
      }
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(['GET', 'HEAD', 'PATCH'])
      return jsonResponse(
        await service.getRecording(url.searchParams.get('root'), url.searchParams.get('id')),
      )
    }),
    route('/search', ['GET', 'HEAD'], async (_request, url) => {
      const root = url.searchParams.get('root')
      if (root === null || root.trim().length === 0 || root === PANEL_ALL_PROJECTS_ROOT) {
        return jsonResponse(await service.searchAll(url.searchParams.get('q'), {
          limit: parseSearchLimit(url.searchParams.get('limit')),
        }))
      }
      return jsonResponse(await service.search(root, url.searchParams.get('q')))
    }),
    route('/stats', ['GET', 'HEAD'], async () => jsonResponse(
      await service.getStatsReport(),
    )),
    route('/capabilities', ['GET', 'HEAD'], async () => jsonResponse(service.capabilities())),
    route('/active', ['GET', 'HEAD'], async (_request, url) => jsonResponse(
      await service.listActiveRecordings(url.searchParams.get('root')),
    )),
    route('/stop', ['POST'], async (request, url) => {
      const body = await jsonObjectBody(request)
      return jsonResponse(await service.stopRecording(rootFrom(body, url), body))
    }),
    route('/discard', ['POST'], async (request, url) => {
      const body = await jsonObjectBody(request)
      return jsonResponse(await service.discardRecording(rootFrom(body, url), body))
    }),
    route('/replay', ['POST'], async (request, url) => {
      const body = await jsonObjectBody(request)
      return jsonResponse(await service.startReplay(rootFrom(body, url), body))
    }),
    route('/trash', ['POST'], async (request, url) => {
      const body = await jsonObjectBody(request)
      return jsonResponse(await service.trashRecording(rootFrom(body, url), body))
    }),
    route('/root', ['POST'], async (request) => {
      const body = await jsonObjectBody(request)
      const root = body['root']
      return jsonResponse({
        project: await service.registerRoot(typeof root === 'string' ? root : undefined),
      })
    }),
    route('/video', ['GET', 'HEAD'], (request, url) => serveVideo(service, request, url)),
    route('/category', ['PATCH'], async (request, url) => {
      const method = request.method.toUpperCase()
      if (method !== 'PATCH') return methodNotAllowed(['PATCH'])
      return jsonResponse(await service.updateCategory(
        url.searchParams.get('root'),
        await jsonObjectBody(request),
      ))
    }),
    route('/scenario', ['PATCH', 'POST'], async (request, url) => {
      const method = request.method.toUpperCase()
      if (method === 'POST') {
        return jsonResponse(await service.createScenario(
          url.searchParams.get('root'),
          await jsonObjectBody(request),
        ))
      }
      if (method === 'PATCH') {
        return jsonResponse(await service.updateScenario(
          url.searchParams.get('root'),
          await jsonObjectBody(request),
        ))
      }
      return methodNotAllowed(['PATCH', 'POST'])
    }),
  ]
}
