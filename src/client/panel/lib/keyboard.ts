/**
 * Keyboard navigation shared by the panel's tree and list surfaces.
 *
 * Rows are plain `<button>` elements, so Enter/Space activation is browser
 * native. This module only adds Arrow/Home/End focus movement. It deliberately
 * ignores events that originated in an input/textarea/select/contenteditable,
 * so typing a rename (F2 → input) never moves the tree focus.
 */
import type * as React from 'react'

/** Marker attribute on rows that participate in arrow navigation. */
export const KEYBOARD_ROW_SELECTOR = '[data-keyboard-row]'

/** Marker attribute on the row wrapper that owns the row key (Tree). */
export const TREE_ROW_KEY_ATTRIBUTE = 'data-row-key'

/** True when the event target is a text-editing control. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false
  const element = target as HTMLElement
  if (typeof element.tagName !== 'string') return false
  if (element.isContentEditable === true) return true
  const tag = element.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * ArrowUp/ArrowDown/Home/End move DOM focus between `[data-keyboard-row]`
 * elements inside the event's currentTarget. Returns true when it handled the
 * key (the caller can then skip further handling).
 */
export function handleListKeyDown(event: React.KeyboardEvent<HTMLElement>): boolean {
  const key = event.key
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return false
  if (event.altKey || event.ctrlKey || event.metaKey) return false
  if (isEditableTarget(event.target)) return false

  const container = event.currentTarget
  const rows = Array.from(container.querySelectorAll<HTMLElement>(KEYBOARD_ROW_SELECTOR))
  if (rows.length === 0) return false

  const source = event.target
  const currentRow = source instanceof HTMLElement ? source.closest<HTMLElement>(KEYBOARD_ROW_SELECTOR) : null
  const currentIndex = currentRow === null ? -1 : rows.indexOf(currentRow)

  let nextIndex: number
  switch (key) {
    case 'ArrowDown':
      nextIndex = currentIndex < 0 ? 0 : currentIndex + 1
      break
    case 'ArrowUp':
      nextIndex = currentIndex < 0 ? rows.length - 1 : currentIndex - 1
      break
    case 'Home':
      nextIndex = 0
      break
    default:
      nextIndex = rows.length - 1
      break
  }
  const target = rows[Math.max(0, Math.min(rows.length - 1, nextIndex))]
  if (target === undefined) return false
  event.preventDefault()
  target.focus()
  // jsdom (tests) has no layout; browsers scroll the focused row into view.
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' })
  return true
}

/** Clear focus from the active element (Escape outside an editor). */
export function blurActiveElement(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
}
