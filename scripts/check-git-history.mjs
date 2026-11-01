#!/usr/bin/env node
/**
 * Read-only scan of every reachable commit for details that must not ship in a
 * public history: real home/volume paths, an optional account name, and secret
 * shapes. This complements `check-public-boundary.mjs`, which only scans the
 * working tree.
 *
 * Set PUBLIC_BOUNDARY_ACCOUNT to also flag a bare account name (for example
 * `PUBLIC_BOUNDARY_ACCOUNT=<account> pnpm check:history`). Exits 1 when any
 * commit matches; the rewrite recipe is in docs/guides/public-release.md.
 */
import { execFileSync } from 'node:child_process'

const ACCOUNT_NAME = process.env.PUBLIC_BOUNDARY_ACCOUNT?.trim() ?? ''
const ACCOUNT_PATTERN = ACCOUNT_NAME.length === 0
  ? undefined
  : new RegExp(`\\b${ACCOUNT_NAME.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u')

const ALLOWED_HOME_NAMES = new Set(['<user>', '<name>', 'me', 'user', 'you', 'demo', 'example', 'name'])
const ALLOWED_VOLUME_NAMES = new Set(['<volume>', 'work', 'secret', 'demo', 'example', 'data'])

const SECRET_RULES = [
  { name: 'private key header', pattern: 'BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY' },
  { name: 'OpenAI-style API key', pattern: 'sk-[A-Za-z0-9_-]{20,}' },
  { name: 'AWS access key', pattern: 'AKIA[0-9A-Z]{16}' },
  { name: 'GitHub token', pattern: 'gh[pousr]_[A-Za-z0-9]{20,}' },
]

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function pathHits(text) {
  const hits = []
  for (const match of text.matchAll(/\/Users\/([^/\s"'`]+)/gu)) {
    if (!ALLOWED_HOME_NAMES.has(match[1]) && !match[1].startsWith('.') && !match[1].startsWith('<')) hits.push(`/Users/${match[1]}`)
  }
  for (const match of text.matchAll(/\/home\/([^/\s"'`]+)/gu)) {
    if (!ALLOWED_HOME_NAMES.has(match[1]) && !match[1].startsWith('.') && !match[1].startsWith('<')) hits.push(`/home/${match[1]}`)
  }
  for (const match of text.matchAll(/\/Volumes\/([^/\s"'`]+)/gu)) {
    if (!ALLOWED_VOLUME_NAMES.has(match[1]) && !match[1].startsWith('<')) hits.push(`/Volumes/${match[1]}`)
  }
  if (ACCOUNT_PATTERN?.test(text) === true) hits.push('account name')
  return hits
}

function parseGrep(output, commit) {
  const rows = []
  for (const raw of output.split('\n').filter(Boolean)) {
    const withoutCommit = raw.startsWith(`${commit}:`) ? raw.slice(commit.length + 1) : raw
    const match = /^([^:]+):(\d+):(.*)$/u.exec(withoutCommit)
    if (match !== null) rows.push({ file: match[1], line: Number(match[2]), text: match[3] })
  }
  return rows
}

const commits = git(['rev-list', '--all']).split('\n').filter(Boolean)
const findings = []
for (const commit of commits) {
  const subject = git(['show', '-s', '--format=%s', commit]).trim()
  const pathRows = parseGrep(git(['grep', '-n', '-E', '-e', '/Users/|/home/|/Volumes/', commit, '--', '.']), commit)
    .filter(row => row.file !== 'scripts/check-public-boundary.mjs' && row.file !== 'scripts/check-git-history.mjs')
  for (const row of pathRows) {
    const hits = pathHits(row.text)
    if (hits.length > 0) findings.push({ commit, subject, rule: 'personal path', file: row.file, line: row.line, detail: hits.join(', ') })
  }
  for (const rule of SECRET_RULES) {
    const rows = parseGrep(git(['grep', '-n', '-E', '-e', rule.pattern, commit, '--', '.']), commit)
      .filter(row => row.file !== 'tests/unit/recording/redaction.test.ts' && row.file !== 'scripts/check-public-boundary.mjs' && row.file !== 'scripts/check-git-history.mjs')
    for (const row of rows) findings.push({ commit, subject, rule: rule.name, file: row.file, line: row.line })
  }
}

if (findings.length > 0) {
  for (const finding of findings.slice(0, 25)) {
    const detail = finding.detail === undefined ? '' : ` (${finding.detail})`
    console.error(`${finding.commit.slice(0, 7)} ${finding.subject} :: ${finding.rule}${detail} :: ${finding.file}:${String(finding.line)}`)
  }
  if (findings.length > 25) console.error(`... ${String(findings.length - 25)} more finding(s) omitted`)
  const counts = new Map()
  for (const finding of findings) counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1)
  console.error(`\n${String(findings.length)} history finding(s) across ${String(commits.length)} commits:`)
  for (const [rule, count] of counts) console.error(`  ${rule}: ${String(count)}`)
  console.error('See docs/guides/public-release.md for the git-filter-repo recipe.')
  process.exit(1)
}
console.log(`git history OK: ${String(commits.length)} commits scanned.`)
