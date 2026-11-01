/**
 * Standalone panel host: serves the read-only API and the built React client.
 *
 * The panel is intentionally a separate entry (`panel` CLI command); it never
 * registers a host tool, so the plugin's 26-tool surface stays unchanged.
 */
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPanelHandler, type PanelHandler } from './http.js'
import { PanelService, type PanelServiceOptions } from './service.js'

export interface StartPanelServerOptions extends PanelServiceOptions {
  /** TCP port; 0 picks an ephemeral port (tests). */
  readonly port?: number
  /** Bind address. Defaults to 127.0.0.1. */
  readonly host?: string
  /** Built Vite app directory. Defaults to `<package>/dist/panel` when present. */
  readonly publicDir?: string
  /** Allow cross-origin reads. Defaults to false. */
  readonly cors?: boolean
  /** Pre-built service (tests). */
  readonly service?: PanelService
}

export interface PanelServerHandle {
  readonly url: string
  readonly port: number
  readonly host: string
  readonly service: PanelService
  readonly publicDir: string | undefined
  readonly handler: PanelHandler
  close(): Promise<void>
}

function hasPanelIndex(dir: string): boolean {
  try {
    return existsSync(path.join(dir, 'index.html'))
  } catch {
    return false
  }
}

/** Locate `dist/panel` both in the bundled CLI and when running from source. */
export function defaultPanelPublicDir(): string | undefined {
  const fromEnv = process.env['DSH_RECORD_REPLAY_PANEL_PUBLIC']
  if (fromEnv !== undefined && fromEnv.length > 0 && hasPanelIndex(fromEnv)) return fromEnv

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // dist/cli.mjs -> dist/panel
    path.resolve(moduleDirectory, 'panel'),
    // src/panel/server.ts -> <repo>/dist/panel
    path.resolve(moduleDirectory, '..', '..', 'dist', 'panel'),
    path.resolve(process.cwd(), 'dist', 'panel'),
  ]
  return candidates.find((candidate) => hasPanelIndex(candidate))
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export async function startPanelServer(options: StartPanelServerOptions = {}): Promise<PanelServerHandle> {
  const service = options.service ?? new PanelService(options)
  const publicDir = options.publicDir ?? defaultPanelPublicDir()
  const host = options.host ?? '127.0.0.1'
  const handler = createPanelHandler({
    service,
    ...(publicDir === undefined ? {} : { publicDir }),
    ...(options.cors === undefined ? {} : { cors: options.cors }),
  })
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      }
      response.end(JSON.stringify({ error: { code: 'PANEL_INTERNAL', message: 'panel request failed' } }))
    })
  })

  const port = await listen(server, options.port ?? 4174, host)
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const url = `http://${displayHost}:${String(port)}/panel/`

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return {
    url,
    port,
    host,
    service,
    publicDir,
    handler,
    close,
  }
}
