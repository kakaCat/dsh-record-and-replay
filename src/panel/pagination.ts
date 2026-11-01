/**
 * Shared `limit`/`offset` parsing for the paginated panel lists (M2).
 *
 * A missing or empty query parameter means "use the default". Anything else
 * must be a safe integer inside the documented range: silently clamping a
 * malformed value would hide client bugs, so it is a `400` instead.
 */
import { panelBadRequest } from './errors.js'
import {
  PANEL_PAGE_LIMIT_DEFAULT,
  PANEL_PAGE_LIMIT_MAX,
  PANEL_SEARCH_LIMIT_DEFAULT,
  PANEL_SEARCH_LIMIT_MAX,
  type PanelPageMeta,
} from './types.js'

export interface PanelPagination {
  readonly limit: number
  readonly offset: number
}

export interface Paginated<T> {
  readonly items: readonly T[]
  readonly page: PanelPageMeta
}

function parseInteger(
  value: string | undefined | null,
  code: 'PANEL_INVALID_PAGINATION' | 'PANEL_INVALID_LIMIT',
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null || value.trim().length === 0) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw panelBadRequest(code, `${name} must be an integer between ${String(min)} and ${String(max)}`)
  }
  return parsed
}

/** Parse `limit`/`offset` for project and recording lists (default 50, max 200). */
export function parsePagination(
  limitText: string | undefined | null,
  offsetText: string | undefined | null,
): PanelPagination {
  return {
    limit: parseInteger(
      limitText,
      'PANEL_INVALID_PAGINATION',
      'limit',
      1,
      PANEL_PAGE_LIMIT_MAX,
      PANEL_PAGE_LIMIT_DEFAULT,
    ),
    offset: parseInteger(
      offsetText,
      'PANEL_INVALID_PAGINATION',
      'offset',
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    ),
  }
}

/** Parse the cross-project search result cap (default 100, max 500). */
export function parseSearchLimit(limitText: string | undefined | null): number {
  return parseInteger(
    limitText,
    'PANEL_INVALID_LIMIT',
    'limit',
    1,
    PANEL_SEARCH_LIMIT_MAX,
    PANEL_SEARCH_LIMIT_DEFAULT,
  )
}

/** Slice one page and describe it. Offsets past the end yield an empty page. */
export function paginate<T>(items: readonly T[], pagination: PanelPagination): Paginated<T> {
  const { limit, offset } = pagination
  const total = items.length
  const pageItems = offset >= total ? [] : items.slice(offset, offset + limit)
  return {
    items: pageItems,
    page: {
      total,
      limit,
      offset,
      hasMore: offset + pageItems.length < total,
    },
  }
}
