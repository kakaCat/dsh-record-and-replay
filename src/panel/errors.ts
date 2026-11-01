import type { PanelErrorCode } from './types.js'

/** Stable panel error: the HTTP layer maps it to a status code, tests assert on the code. */
export class PanelError extends Error {
  readonly code: PanelErrorCode
  readonly status: number

  constructor(code: PanelErrorCode, message: string, status: number, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PanelError'
    this.code = code
    this.status = status
  }
}

export function panelBadRequest(code: PanelErrorCode, message: string): PanelError {
  return new PanelError(code, message, 400)
}

export function panelForbidden(code: PanelErrorCode, message: string): PanelError {
  return new PanelError(code, message, 403)
}

export function panelNotFound(code: PanelErrorCode, message: string): PanelError {
  return new PanelError(code, message, 404)
}
