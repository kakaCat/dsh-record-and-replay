/**
 * Project-skill projection.
 *
 * DSH's `skill-filesystem` provider discovers `<workspace>/.dsh/skills/<name>/SKILL.md`
 * (or `<name>.md`) and requires `name` + `description` in the frontmatter. The
 * library under `.dsh/skill-library` stays authoritative (versions, counters);
 * this module writes a plain copy where DSH can find it.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/u

/** DSH requires kebab-case skill names; anything else cannot be published. */
export function isPublishableName(name: string): boolean {
  return KEBAB.test(name)
}

/** First Summary sentence, trimmed to a catalog-sized description. */
export function describeSkill(markdown: string): string {
  const summary = /^## Summary\s*\n+([^\n]+)/mu.exec(markdown)?.[1]?.trim()
  if (summary === undefined || summary.length === 0) return 'Replay a recorded browser flow.'
  // The Summary carries provenance after the first sentence; the catalog only
  // benefits from the routing sentence.
  const sentenceEnd = summary.indexOf('. ')
  const description = sentenceEnd > 0 ? summary.slice(0, sentenceEnd + 1) : summary
  return description.length > 200 ? `${description.slice(0, 197)}...` : description
}

/** Inject `description` once; preserves every other frontmatter line verbatim. */
export function withDescription(markdown: string, description: string): string {
  const match = FRONTMATTER.exec(markdown)
  if (match === null) return markdown
  const frontmatter = match[1] ?? ''
  if (/^description:/mu.test(frontmatter)) return markdown
  const injected = `---\n${frontmatter}\ndescription: ${JSON.stringify(description)}\n---\n${markdown.slice(match[0].length)}`
  return injected
}

export interface PublishProjectSkillOptions {
  readonly workspaceRoot: string
  readonly name: string
  readonly markdown: string
}

/**
 * Write `<workspace>/.dsh/skills/<name>/SKILL.md`. Returns undefined for a name
 * DSH would reject, so the caller keeps the library install without pretending
 * the skill is discoverable.
 */
export async function publishProjectSkill(options: PublishProjectSkillOptions): Promise<string | undefined> {
  if (!isPublishableName(options.name)) return undefined
  const directory = join(options.workspaceRoot, '.dsh', 'skills', options.name)
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'SKILL.md')
  await writeFile(file, withDescription(options.markdown, describeSkill(options.markdown)))
  return file
}
