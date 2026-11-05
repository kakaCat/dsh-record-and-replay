import { HostError } from '../host/config.js'

/** Configuration owned by the independently switchable `/docker` plugin row. */
export interface DockerPluginConfig {
  /** Docker CLI executable on the host. */
  readonly dockerBin: string
  /** Optional image tag. When omitted, a content-addressed tag is built from the bundled assets. */
  readonly image?: string
  /** Build the bundled image when the selected tag is missing. */
  readonly autoBuild: boolean
  /** X11 display inside the container. */
  readonly display: string
  readonly width: number
  readonly height: number
  readonly startupTimeoutMs: number
  readonly buildTimeoutMs: number
  /** Keep Cua's named browser profiles in a per-workspace Docker volume. */
  readonly persistProfiles: boolean
}

export const DEFAULT_DOCKER_CONFIG: DockerPluginConfig = {
  dockerBin: 'docker',
  autoBuild: true,
  display: ':99',
  width: 1280,
  height: 720,
  startupTimeoutMs: 30_000,
  buildTimeoutMs: 600_000,
  persistProfiles: true,
}

function invalid(field: string, requirement: string): never {
  throw new HostError('CONFIG_INVALID', `${field} ${requirement}`)
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid('config', 'must be an object')
  }
  return input as Record<string, unknown>
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field, 'must be a boolean')
  return value
}

function asInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(field, `must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function asExecutable(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\0\r\n]/u.test(value)) {
    invalid('dockerBin', 'must be a non-empty executable path without control characters')
  }
  return value
}

function asImage(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /\s/u.test(value)) {
    invalid('image', 'must be a non-empty Docker image reference without whitespace')
  }
  return value
}

function asDisplay(value: unknown): string {
  if (typeof value !== 'string' || !/^:\d{1,4}$/u.test(value)) {
    invalid('display', 'must be an X11 display such as :99')
  }
  return value
}

export function resolveDockerConfig(input: unknown = {}): DockerPluginConfig {
  if (input === undefined || input === null) return DEFAULT_DOCKER_CONFIG
  const raw = asRecord(input)
  const allowed = new Set([
    'dockerBin',
    'image',
    'autoBuild',
    'display',
    'width',
    'height',
    'startupTimeoutMs',
    'buildTimeoutMs',
    'persistProfiles',
  ])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) invalid(`config.${key}`, 'is not a supported Docker option')
  }
  return {
    dockerBin: raw['dockerBin'] === undefined ? DEFAULT_DOCKER_CONFIG.dockerBin : asExecutable(raw['dockerBin']),
    ...(raw['image'] === undefined ? {} : { image: asImage(raw['image']) }),
    autoBuild: raw['autoBuild'] === undefined ? DEFAULT_DOCKER_CONFIG.autoBuild : asBoolean(raw['autoBuild'], 'autoBuild'),
    display: raw['display'] === undefined ? DEFAULT_DOCKER_CONFIG.display : asDisplay(raw['display']),
    width: raw['width'] === undefined ? DEFAULT_DOCKER_CONFIG.width : asInteger(raw['width'], 'width', 640, 4096),
    height: raw['height'] === undefined ? DEFAULT_DOCKER_CONFIG.height : asInteger(raw['height'], 'height', 480, 2160),
    startupTimeoutMs: raw['startupTimeoutMs'] === undefined
      ? DEFAULT_DOCKER_CONFIG.startupTimeoutMs
      : asInteger(raw['startupTimeoutMs'], 'startupTimeoutMs', 1_000, 120_000),
    buildTimeoutMs: raw['buildTimeoutMs'] === undefined
      ? DEFAULT_DOCKER_CONFIG.buildTimeoutMs
      : asInteger(raw['buildTimeoutMs'], 'buildTimeoutMs', 10_000, 1_800_000),
    persistProfiles: raw['persistProfiles'] === undefined
      ? DEFAULT_DOCKER_CONFIG.persistProfiles
      : asBoolean(raw['persistProfiles'], 'persistProfiles'),
  }
}
