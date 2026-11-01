import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describeSkill,
  isPublishableName,
  publishProjectSkill,
  withDescription,
} from '../../../src/skill/publish.js'

const MARKDOWN = `---
name: "bilibili-space-settings"
version: 1
site: "bilibili"
flow: "space-settings"
---

# Skill: B 站个人空间

## Summary

Replays the "space-settings" flow on "bilibili".

## Steps

1. Navigate.
`

describe('skill/publish', () => {
  it('derives a catalog description from the Summary section', () => {
    expect(describeSkill(MARKDOWN)).toBe('Replays the "space-settings" flow on "bilibili".')
    expect(describeSkill('# no summary')).toBe('Replay a recorded browser flow.')
    expect(describeSkill('## Summary\n\nFirst sentence. Second sentence with provenance.')).toBe('First sentence.')
  })

  it('injects description once and preserves the rest of the frontmatter', () => {
    const once = withDescription(MARKDOWN, 'demo description')
    expect(once).toContain('description: "demo description"')
    expect(once).toContain('name: "bilibili-space-settings"')
    expect(withDescription(once, 'second')).toBe(once)
  })

  it('copies the skill into the project skill root DSH scans', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skill-publish-'))
    try {
      const path = await publishProjectSkill({
        workspaceRoot: workspace,
        name: 'bilibili-space-settings',
        markdown: MARKDOWN,
      })
      expect(path).toBe(join(workspace, '.dsh', 'skills', 'bilibili-space-settings', 'SKILL.md'))
      const written = await readFile(path as string, 'utf8')
      expect(written).toContain('description: "Replays the \\"space-settings\\" flow on \\"bilibili\\"."')
      expect(written).toContain('## Steps')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('refuses names DSH would reject', async () => {
    expect(isPublishableName('bilibili-space-settings')).toBe(true)
    expect(isPublishableName('Bad_Name')).toBe(false)
    const workspace = await mkdtemp(join(tmpdir(), 'skill-publish-'))
    try {
      await expect(publishProjectSkill({ workspaceRoot: workspace, name: 'Bad_Name', markdown: MARKDOWN }))
        .resolves.toBeUndefined()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
