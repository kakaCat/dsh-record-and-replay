import type { BrowserDriver } from './api.js'
import type { Redactor } from '../recording/redaction.js'
import type { RecordingExporter, RecordingStore } from '../store/api.js'

export const EXTENSION_KINDS = ['driver', 'store', 'redactor', 'exporter'] as const
export type ExtensionKind = (typeof EXTENSION_KINDS)[number]

export const EXTENSION_REGISTRY_CODES = [
  'EXTENSION_ALREADY_REGISTERED',
  'EXTENSION_CONTRACT_INVALID',
  'EXTENSION_IN_USE',
  'EXTENSION_NOT_FOUND',
] as const
export type ExtensionRegistryCode = (typeof EXTENSION_REGISTRY_CODES)[number]

export class ExtensionRegistryError extends Error {
  readonly code: ExtensionRegistryCode

  constructor(code: ExtensionRegistryCode, message: string) {
    super(message)
    this.name = 'ExtensionRegistryError'
    this.code = code
  }
}

export interface RegisteredExtension {
  readonly kind: ExtensionKind
  readonly id: string
  readonly value: unknown
}

interface Entry extends RegisteredExtension {
  activeCount: number
  disposed: boolean
}

export type ExtensionDisposable = () => void

function keyOf(kind: ExtensionKind, id: string): string {
  return `${kind}:${id}`
}

function assertValidId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new ExtensionRegistryError('EXTENSION_CONTRACT_INVALID', 'extension id must be a non-empty string')
  }
  if (id.startsWith('dsh.')) {
    throw new ExtensionRegistryError('EXTENSION_CONTRACT_INVALID', 'dsh.* extension ids are reserved for built-ins')
  }
}

function hasFunctions(value: unknown, names: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && names.every((name) => typeof (value as Record<string, unknown>)[name] === 'function')
}

function validateShape(kind: ExtensionKind, id: string, value: unknown): void {
  assertValidId(id)
  switch (kind) {
    case 'driver':
      if (!hasFunctions(value, ['capabilities', 'bind', 'observe', 'resolve', 'execute', 'release'])) {
        throw new ExtensionRegistryError('EXTENSION_CONTRACT_INVALID', 'driver extension must implement BrowserDriver')
      }
      break
    case 'store':
      if (!hasFunctions(value, ['open', 'readManifest', 'readSteps', 'listRecordings', 'close'])) {
        throw new ExtensionRegistryError('EXTENSION_CONTRACT_INVALID', 'store extension must implement RecordingStore')
      }
      break
    case 'redactor':
      if (!hasFunctions(value, ['redactEvent'])) {
        throw new ExtensionRegistryError('EXTENSION_CONTRACT_INVALID', 'redactor extension must implement Redactor')
      }
      break
    case 'exporter':
      if (!hasFunctions(value, ['exportRecording', 'readArchive'])) {
        throw new ExtensionRegistryError('EXTENSION_CONTRACT_INVALID', 'exporter extension must implement RecordingExporter')
      }
      break
  }
}

/**
 * 启动期扩展注册表。注册表只校验形状与生命周期；完整行为由 testing/conformance 复核。
 * active 期间禁止卸载，防止第三方扩展在执行中途被替换。
 */
export class ExtensionRegistry {
  private readonly entries = new Map<string, Entry>()

  register(kind: ExtensionKind, id: string, value: unknown): ExtensionDisposable {
    validateShape(kind, id, value)
    const key = keyOf(kind, id)
    if (this.entries.has(key)) {
      throw new ExtensionRegistryError('EXTENSION_ALREADY_REGISTERED', `${kind} extension already registered: ${id}`)
    }
    this.entries.set(key, { kind, id, value, activeCount: 0, disposed: false })
    return () => this.dispose(kind, id)
  }

  get(kind: ExtensionKind, id: string): unknown {
    return this.entries.get(keyOf(kind, id))?.value
  }

  list(kind?: ExtensionKind): readonly RegisteredExtension[] {
    return [...this.entries.values()]
      .filter((entry) => kind === undefined || entry.kind === kind)
      .map(({ kind: entryKind, id, value }) => ({ kind: entryKind, id, value }))
  }

  async withActive<T>(kind: ExtensionKind, id: string, use: (value: never) => Promise<T> | T): Promise<T> {
    const entry = this.entries.get(keyOf(kind, id))
    if (entry === undefined || entry.disposed) {
      throw new ExtensionRegistryError('EXTENSION_NOT_FOUND', `${kind} extension not registered: ${id}`)
    }
    entry.activeCount += 1
    try {
      return await use(entry.value as never)
    } finally {
      entry.activeCount -= 1
    }
  }

  dispose(kind: ExtensionKind, id: string): void {
    const key = keyOf(kind, id)
    const entry = this.entries.get(key)
    if (entry === undefined || entry.disposed) return
    if (entry.activeCount > 0) {
      throw new ExtensionRegistryError('EXTENSION_IN_USE', `${kind} extension is active and cannot be unloaded: ${id}`)
    }
    entry.disposed = true
    this.entries.delete(key)
  }
}

export type { BrowserDriver, RecordingStore, Redactor, RecordingExporter }
