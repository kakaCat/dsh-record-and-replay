import { describe, expect, it } from 'vitest'

import type { PanelProjectSummary } from '../../../src/panel/types.js'
import {
  REMEMBERED_ROOT_KEY,
  forgetRememberedRoot,
  isProtectedPanelRoot,
  pickDefaultRoot,
  readRememberedRoot,
  rememberRoot,
} from '../../../src/client/panel/lib/project-defaults.js'

function project(
  root: string,
  recordingCount: number,
  isCurrent = false,
): PanelProjectSummary {
  return { root, name: root, recordingCount, ...(isCurrent ? { isCurrent: true } : {}) }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key)
    },
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

describe('pickDefaultRoot', () => {
  it('returns undefined when the host knows no projects', () => {
    expect(pickDefaultRoot({ projects: [] })).toBeUndefined()
  })

  it('prefers the last explicitly selected root when it still has recordings', () => {
    const projects = [project('/a', 3), project('/b', 9), project('/c', 0, true)]
    expect(pickDefaultRoot({ projects, lastRoot: '/a', preferredRoot: '/b' })).toBe('/a')
  })

  it('ignores a remembered project without recordings and falls through to data', () => {
    const projects = [
      project('/Users/me/.dsh/profiles/desktop', 0),
      project('/tmp/with-data', 4),
      project('/tmp/other', 1),
    ]
    expect(pickDefaultRoot({ projects, lastRoot: '/Users/me/.dsh/profiles/desktop' })).toBe('/tmp/with-data')
  })

  it('ignores a remembered DSH home, user home or filesystem root', () => {
    const projects = [
      project('/Users/me/.dsh/profiles/desktop', 5),
      project('/Users/me', 5),
      project('/', 5),
      project('/tmp/data', 2),
    ]
    for (const lastRoot of ['/Users/me/.dsh/profiles/desktop', '/Users/me', '/']) {
      expect(pickDefaultRoot({ projects, lastRoot, preferredRoot: '/tmp/data' })).toBe('/tmp/data')
    }
  })

  it('falls through when the remembered root disappeared', () => {
    const projects = [project('/b', 9), project('/c', 2)]
    expect(pickDefaultRoot({ projects, lastRoot: '/gone', preferredRoot: '/c' })).toBe('/c')
    expect(pickDefaultRoot({ projects, lastRoot: '/gone', preferredRoot: '/gone-too' })).toBe('/b')
  })

  it('does not promote an unmeasured remembered root to priority one', () => {
    const projects = [
      { root: '/unknown', name: 'unknown' },
      project('/tmp/data', 2),
    ]
    expect(pickDefaultRoot({ projects, lastRoot: '/unknown' })).toBe('/tmp/data')
  })

  it('uses the current session workspace when it has recordings', () => {
    const projects = [project('/a', 6), project('/session', 2), project('/with-data', 4)]
    expect(pickDefaultRoot({ projects, preferredRoot: '/session' })).toBe('/session')
  })

  it('falls through an empty session workspace to a project with recordings', () => {
    const projects = [project('/empty-session', 0), project('/with-data', 4), project('/a', 1)]
    expect(pickDefaultRoot({ projects, preferredRoot: '/empty-session' })).toBe('/with-data')
  })

  it('uses the host current directory when no session root is known', () => {
    const projects = [project('/a', 5), project('/cwd', 0, true)]
    expect(pickDefaultRoot({ projects })).toBe('/cwd')
  })

  it('prefers the first project with recordings over an empty one', () => {
    const projects = [project('/empty', 0), project('/data', 3), project('/other', 1)]
    expect(pickDefaultRoot({ projects })).toBe('/data')
  })

  it('falls back to the host order when no project has data', () => {
    const projects = [project('/first', 0), project('/second', 0)]
    expect(pickDefaultRoot({ projects })).toBe('/first')
  })
})

describe('isProtectedPanelRoot', () => {
  it('recognises DSH home, user home and the filesystem root', () => {
    expect(isProtectedPanelRoot('/')).toBe(true)
    expect(isProtectedPanelRoot('/Users/me')).toBe(true)
    expect(isProtectedPanelRoot('/Users/me/')).toBe(true)
    expect(isProtectedPanelRoot('/home/me')).toBe(true)
    expect(isProtectedPanelRoot('/root')).toBe(true)
    expect(isProtectedPanelRoot('/Users/me/.dsh')).toBe(true)
    expect(isProtectedPanelRoot('/Users/me/.dsh/profiles/desktop')).toBe(true)
    expect(isProtectedPanelRoot('/Volumes/work/home/.dsh/record-replay')).toBe(true)
  })

  it('keeps ordinary project directories usable', () => {
    expect(isProtectedPanelRoot('/work/demo-project')).toBe(false)
    expect(isProtectedPanelRoot('/Users/me/projects/demo')).toBe(false)
    expect(isProtectedPanelRoot('/home/me/projects/demo')).toBe(false)
    expect(isProtectedPanelRoot('/tmp/panel-view')).toBe(false)
  })
})

describe('remembered root storage', () => {
  it('round-trips a selection and forgets it', () => {
    const storage = memoryStorage()
    expect(readRememberedRoot(storage)).toBeUndefined()
    rememberRoot('/repo', storage)
    expect(storage.getItem(REMEMBERED_ROOT_KEY)).toBe('/repo')
    expect(readRememberedRoot(storage)).toBe('/repo')
    forgetRememberedRoot(storage)
    expect(readRememberedRoot(storage)).toBeUndefined()
  })

  it('never throws when storage is unavailable or blocked', () => {
    const blocked = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    } as Storage
    expect(readRememberedRoot(blocked)).toBeUndefined()
    expect(() => rememberRoot('/x', blocked)).not.toThrow()
    expect(() => forgetRememberedRoot(blocked)).not.toThrow()
  })
})
