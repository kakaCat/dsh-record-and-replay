import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const PUBLIC_DIR = path.resolve(process.cwd(), 'public')
const PORT = Number(process.env.ACTIVITY_SERVER_PORT ?? 4173)

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function safePath(urlPath: string): string | undefined {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, '')
  const filePath = path.resolve(PUBLIC_DIR, normalized === '' ? 'activity.html' : normalized)
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return undefined
  return filePath.endsWith(path.sep) ? path.join(filePath, 'activity.html') : filePath
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const filePath = safePath(request.url ?? '/')
  if (filePath === undefined) {
    response.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = await readFile(filePath)
    response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
  }
}

export function startActivityServer(port = PORT): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handle(request, response)
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      })
    })
  })
}

if (process.env.ACTIVITY_SERVER_AUTOSTART === '1') {
  void startActivityServer().then(({ port }) => {
    console.log(`activity server listening on http://127.0.0.1:${String(port)}/activity.html`)
  })
}
