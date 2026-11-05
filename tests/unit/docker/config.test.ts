import { describe, expect, it } from 'vitest'
import { DEFAULT_DOCKER_CONFIG, resolveDockerConfig } from '../../../src/docker/config.js'

function codeOf(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return (error as { code?: unknown }).code
  }
  return undefined
}

describe('docker/config', () => {
  it('uses safe local defaults without selecting a custom image', () => {
    expect(resolveDockerConfig()).toEqual(DEFAULT_DOCKER_CONFIG)
    expect(resolveDockerConfig({})).toEqual(DEFAULT_DOCKER_CONFIG)
    expect(DEFAULT_DOCKER_CONFIG).toMatchObject({
      dockerBin: 'docker',
      autoBuild: true,
      display: ':99',
      width: 1280,
      height: 720,
      startupTimeoutMs: 30_000,
      buildTimeoutMs: 600_000,
      persistProfiles: true,
    })
    expect(DEFAULT_DOCKER_CONFIG.image).toBeUndefined()
  })

  it('accepts an explicit Docker configuration', () => {
    expect(resolveDockerConfig({
      dockerBin: '/usr/local/bin/docker',
      image: 'registry.example.test/cua:0.38.0',
      autoBuild: false,
      display: ':100',
      width: 1440,
      height: 900,
      startupTimeoutMs: 45_000,
      buildTimeoutMs: 900_000,
      persistProfiles: false,
    })).toEqual({
      dockerBin: '/usr/local/bin/docker',
      image: 'registry.example.test/cua:0.38.0',
      autoBuild: false,
      display: ':100',
      width: 1440,
      height: 900,
      startupTimeoutMs: 45_000,
      buildTimeoutMs: 900_000,
      persistProfiles: false,
    })
  })

  it('rejects unknown, malformed and out-of-range options', () => {
    expect(codeOf(() => resolveDockerConfig({ unknown: true }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveDockerConfig({ image: 'image with spaces' }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveDockerConfig({ display: '-volume' }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveDockerConfig({ width: 639 }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveDockerConfig({ height: 480.5 }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveDockerConfig({ autoBuild: 'yes' }))).toBe('CONFIG_INVALID')
    expect(codeOf(() => resolveDockerConfig({ persistProfiles: 1 }))).toBe('CONFIG_INVALID')
  })
})
