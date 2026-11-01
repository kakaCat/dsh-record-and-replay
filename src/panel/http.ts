/**
 * HTTP interface for the global record/replay panel.
 *
 *   GET  /panel/projects[?limit=&offset=]
 *   GET  /panel/project?root=…[&limit=&offset=]
 *   GET  /panel/recording?root=…&id=…
 *   GET  /panel/video?runId=…[&root=…][&download=1]   (Range/HEAD supported)
 *   GET  /panel/search?q=…[&root=…][&limit=]           (no/`*` root = all projects)
 *   GET  /panel/stats                                  (system + per-project stats)
 *   GET  /panel/capabilities                           (replay/trash availability)
 *   POST /panel/root { root }   register an explicitly picked folder
 *   POST /panel/replay { root, recordingId, values? }  (503 without a replay service)
 *
 * The trash action is registered only on the DSH fetch mount (this standalone
 * command stays read-only). Static panel assets are served from `/panel/`; the
 * API paths win over static resolution. Every request root goes through
 * `PanelService.resolveRoot`.
 */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as path from 'node:path'

import { PanelError, panelBadRequest } from './errors.js'
import { parsePagination, parseSearchLimit } from './pagination.js'
import { isContained } from './paths.js'
import type { PanelService } from './service.js'
import { PANEL_ALL_PROJECTS_ROOT } from './types.js'

export interface PanelHandlerOptions {
  readonly service: PanelService
  /** Directory containing the built Vite app (`dist/panel`). */
  readonly publicDir?: string
  /** Allow cross-origin reads (loopback DSH UI). Default false. */
  readonly cors?: boolean
}

export type PanelHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

interface ByteRange {
  readonly start: number
  readonly end: number
}

function securityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
}

function corsHeaders(enabled: boolean): Record<string, string> {
  if (!enabled) return {}
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, range',
    'access-control-expose-headers': 'content-length, content-range, accept-ranges, content-disposition',
  }
}

function jsonBody(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = jsonBody(value)
  response.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  response.end(response.req?.method === 'HEAD' ? undefined : body)
}

function sendText(
  response: ServerResponse,
  status: number,
  text: string,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  })
  response.end(response.req?.method === 'HEAD' ? undefined : text)
}

function errorStatus(error: PanelError): number {
  return error.status
}

function errorPayload(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof PanelError) {
    return { status: errorStatus(error), code: error.code, message: error.message }
  }
  return { status: 500, code: 'PANEL_INTERNAL', message: 'internal panel error' }
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  sendJson(
    response,
    405,
    { error: { code: 'PANEL_METHOD_NOT_ALLOWED', message: `allowed methods: ${allow}` } },
    { allow },
  )
}

/** Parse a single `Range: bytes=…` header. `undefined` = no range, `invalid` = 416. */
export function parseByteRange(header: string | undefined, size: number): ByteRange | 'invalid' | undefined {
  if (header === undefined || header.trim().length === 0) return undefined
  const match = /^bytes=(.+)$/u.exec(header.trim())
  if (match === null) return 'invalid'
  const spec = match[1]
  if (spec === undefined || spec.includes(',')) return 'invalid'
  const [startText, endText] = spec.split('-')
  if (startText === undefined || endText === undefined) return 'invalid'

  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    if (size === 0) return 'invalid'
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }

  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start < 0) return 'invalid'
  if (start >= size) return 'invalid'
  const end = endText === '' ? size - 1 : Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

function staticFilePath(publicDir: string, pathname: string): string | undefined {
  let relative = pathname
  if (relative === '/' || relative === '/panel') return undefined
  if (!relative.startsWith('/panel/')) return undefined
  relative = relative.slice('/panel/'.length)
  if (relative.length === 0) relative = 'index.html'
  let decoded: string
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, '')
  if (normalized.split(path.sep).includes('..')) return undefined
  const resolved = path.resolve(publicDir, normalized)
  if (!isContained(publicDir, resolved)) return undefined
  return resolved
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  publicDir: string | undefined,
  pathname: string,
): Promise<void> {
  if (publicDir === undefined) {
    sendText(response, 404, 'panel assets are not configured\n')
    return
  }
  if (pathname === '/' || pathname === '/panel') {
    response.writeHead(302, { location: '/panel/', ...securityHeaders() })
    response.end()
    return
  }
  const filePath = staticFilePath(publicDir, pathname)
  if (filePath === undefined) {
    sendText(response, 404, 'not found\n')
    return
  }
  let info
  try {
    info = await stat(filePath)
  } catch {
    sendText(response, 404, 'not found\n')
    return
  }
  if (!info.isFile()) {
    sendText(response, 404, 'not found\n')
    return
  }
  let body: Buffer
  try {
    body = await readFile(filePath)
  } catch {
    sendText(response, 404, 'not found\n')
    return
  }
  const extension = path.extname(filePath).toLowerCase()
  const immutable = filePath.includes(`${path.sep}assets${path.sep}`)
  response.writeHead(200, {
    ...securityHeaders(),
    'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  response.end(body)
}

async function serveVideo(
  request: IncomingMessage,
  response: ServerResponse,
  service: PanelService,
  url: URL,
  cors: boolean,
): Promise<void> {
  const runId = url.searchParams.get('runId')
  const root = url.searchParams.get('root')
  const video = await service.getVideo(runId, root)
  const download = url.searchParams.get('download') === '1'
  const baseHeaders: Record<string, string> = {
    ...securityHeaders(),
    ...corsHeaders(cors),
    'content-type': video.contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
    ...(download ? { 'content-disposition': `attachment; filename="${video.downloadName}"` } : {}),
  }

  if (video.size === 0) {
    response.writeHead(200, { ...baseHeaders, 'content-length': '0' })
    response.end()
    return
  }

  const range = parseByteRange(request.headers.range, video.size)
  if (range === 'invalid') {
    response.writeHead(416, {
      ...baseHeaders,
      'content-range': `bytes */${String(video.size)}`,
    })
    response.end()
    return
  }

  const selected = range ?? { start: 0, end: video.size - 1 }
  const length = selected.end - selected.start + 1
  const status = range === undefined ? 200 : 206
  response.writeHead(status, {
    ...baseHeaders,
    ...(range === undefined
      ? {}
      : { 'content-range': `bytes ${String(selected.start)}-${String(selected.end)}/${String(video.size)}` }),
    'content-length': String(length),
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }

  const stream = createReadStream(video.filePath, { start: selected.start, end: selected.end })
  stream.on('error', () => {
    if (!response.headersSent) {
      sendJson(response, 500, { error: { code: 'PANEL_INTERNAL', message: 'video read failed' } })
    } else {
      response.destroy()
    }
  })
  stream.pipe(response)
}

const MAX_JSON_BODY_BYTES = 1024 * 1024

async function readJsonObject(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_JSON_BODY_BYTES) {
      throw panelBadRequest('PANEL_INVALID_BODY', 'request body is too large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) throw panelBadRequest('PANEL_INVALID_BODY', 'request body must be a JSON object')
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

/**
 * M3 action bodies carry `root` (per the API contract); the query parameter is
 * still honoured so curl/debug callers can pass it either way.
 */
function bodyRoot(
  body: Readonly<Record<string, unknown>>,
  searchParams: URLSearchParams,
): string | undefined {
  const fromBody = body['root']
  if (typeof fromBody === 'string') return fromBody
  return searchParams.get('root') ?? undefined
}

async function routeApi(
  request: IncomingMessage,
  response: ServerResponse,
  service: PanelService,
  url: URL,
  cors: boolean,
): Promise<boolean> {
  const { pathname, searchParams } = url
  const method = request.method ?? 'GET'

  switch (pathname) {
    case '/panel/projects': {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(response, 'GET, HEAD, OPTIONS')
        return true
      }
      const page = parsePagination(searchParams.get('limit'), searchParams.get('offset'))
      const pageResult = await service.listProjectsPage(page)
      sendJson(response, 200, pageResult)
      return true
    }
    case '/panel/project': {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(response, 'GET, HEAD, OPTIONS')
        return true
      }
      const page = parsePagination(searchParams.get('limit'), searchParams.get('offset'))
      const project = await service.getProject(searchParams.get('root'), page)
      sendJson(response, 200, { project })
      return true
    }
    case '/panel/recording': {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(response, 'GET, HEAD, OPTIONS')
        return true
      }
      const detail = await service.getRecording(searchParams.get('root'), searchParams.get('id'))
      sendJson(response, 200, detail)
      return true
    }
    case '/panel/search': {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(response, 'GET, HEAD, OPTIONS')
        return true
      }
      const root = searchParams.get('root')
      const query = searchParams.get('q')
      if (root === null || root.trim().length === 0 || root === PANEL_ALL_PROJECTS_ROOT) {
        const result = await service.searchAll(query, {
          limit: parseSearchLimit(searchParams.get('limit')),
        })
        sendJson(response, 200, result)
        return true
      }
      const result = await service.search(root, query)
      sendJson(response, 200, result)
      return true
    }
    case '/panel/stats': {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(response, 'GET, HEAD, OPTIONS')
        return true
      }
      sendJson(response, 200, await service.getStatsReport())
      return true
    }
    case '/panel/capabilities': {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(response, 'GET, HEAD, OPTIONS')
        return true
      }
      sendJson(response, 200, service.capabilities())
      return true
    }
    case '/panel/active': {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(response, 'GET, HEAD, OPTIONS')
        return true
      }
      sendJson(response, 200, await service.listActiveRecordings(searchParams.get('root')))
      return true
    }
    case '/panel/stop': {
      if (method !== 'POST') {
        methodNotAllowed(response, 'POST, OPTIONS')
        return true
      }
      const body = await readJsonObject(request)
      sendJson(response, 200, await service.stopRecording(bodyRoot(body, searchParams), body))
      return true
    }
    case '/panel/discard': {
      if (method !== 'POST') {
        methodNotAllowed(response, 'POST, OPTIONS')
        return true
      }
      const body = await readJsonObject(request)
      sendJson(response, 200, await service.discardRecording(bodyRoot(body, searchParams), body))
      return true
    }
    case '/panel/replay': {
      if (method !== 'POST') {
        methodNotAllowed(response, 'POST, OPTIONS')
        return true
      }
      const body = await readJsonObject(request)
      sendJson(response, 200, await service.startReplay(bodyRoot(body, searchParams), body))
      return true
    }
    case '/panel/video': {
      if (method !== 'GET' && method !== 'HEAD') {
        methodNotAllowed(response, 'GET, HEAD, OPTIONS')
        return true
      }
      await serveVideo(request, response, service, url, cors)
      return true
    }
    case '/panel/root': {
      if (method !== 'POST') {
        methodNotAllowed(response, 'POST, OPTIONS')
        return true
      }
      const body = await readJsonObject(request)
      const root = body['root']
      const project = await service.registerRoot(typeof root === 'string' ? root : undefined)
      sendJson(response, 200, { project })
      return true
    }
    default:
      return false
  }
}

export function createPanelHandler(options: PanelHandlerOptions): PanelHandler {
  const cors = options.cors === true
  return async (request, response) => {
    const method = request.method ?? 'GET'
    if (cors && method === 'OPTIONS') {
      response.writeHead(204, {
        ...securityHeaders(),
        ...corsHeaders(true),
        'content-length': '0',
      })
      response.end()
      return
    }

    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      sendJson(response, 400, { error: { code: 'PANEL_NOT_FOUND', message: 'invalid request url' } })
      return
    }

    try {
      const isApi = url.pathname.startsWith('/panel/') && !url.pathname.startsWith('/panel/assets/')
      if (isApi) {
        const headers = corsHeaders(cors)
        if (Object.keys(headers).length > 0) {
          for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
        }
        const handled = await routeApi(request, response, options.service, url, cors)
        if (handled) return
      }
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(response, 405, 'method not allowed\n', { allow: 'GET, HEAD, OPTIONS' })
        return
      }
      await serveStatic(request, response, options.publicDir, url.pathname)
    } catch (error) {
      const payload = errorPayload(error)
      if (response.headersSent) {
        response.destroy()
        return
      }
      sendJson(response, payload.status, { error: { code: payload.code, message: payload.message } })
    }
  }
}
