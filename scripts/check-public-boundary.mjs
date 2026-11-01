#!/usr/bin/env node
/**
 * Reject tracked text that leaks personal machine details or credentials.
 *
 * This is intentionally conservative: placeholders such as `/Users/<user>`,
 * `/Users/me`, `/home/example`, and `<workspace>` are allowed; real user names,
 * external volume paths, and secret-shaped strings are not.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

const ALLOWED_HOME_NAMES = new Set(['<user>', '<name>', 'me', 'user', 'you', 'demo', 'example', 'name'])
const ALLOWED_VOLUME_NAMES = new Set(['<volume>', 'work', 'secret', 'demo', 'example', 'data'])
const ACCOUNT_NAME = process.env.PUBLIC_BOUNDARY_ACCOUNT?.trim() ?? ''
const ACCOUNT_PATTERN = ACCOUNT_NAME.length === 0
  ? undefined
  : new RegExp(`\\b${ACCOUNT_NAME.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u')
const TEXT_EXTENSIONS = /\.(?:md|markdown|txt|json|jsonl|ya?ml|toml|mjs|js|cjs|ts|tsx|jsx|swift|sh|bash|zsh|html|css|xml|csv)$/iu

const SECRET_RULES = [
  { name: 'private key header', pattern: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/u },
  { name: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
  { name: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/u },
]

function personalPathMatches(line) {
  const hits = []
  for (const match of line.matchAll(/\/Users\/([^/\s"'`]+)/gu)) {
    if (!ALLOWED_HOME_NAMES.has(match[1]) && !match[1].startsWith('.') && !match[1].startsWith('<')) hits.push(`/Users/${match[1]}`)
  }
  for (const match of line.matchAll(/\/home\/([^/\s"'`]+)/gu)) {
    if (!ALLOWED_HOME_NAMES.has(match[1]) && !match[1].startsWith('.') && !match[1].startsWith('<')) hits.push(`/home/${match[1]}`)
  }
  for (const match of line.matchAll(/\/Volumes\/([^/\s"'`]+)/gu)) {
    if (!ALLOWED_VOLUME_NAMES.has(match[1]) && !match[1].startsWith('<')) hits.push(`/Volumes/${match[1]}`)
  }
  if (ACCOUNT_PATTERN?.test(line) === true) hits.push('account name')
  return hits
}

const violations = []
for (const file of files) {
  if (!TEXT_EXTENSIONS.test(file)) continue
  if (file === 'scripts/check-public-boundary.mjs' || file === 'scripts/check-git-history.mjs') continue
  let text
  try {
    const buffer = readFileSync(file)
    if (buffer.includes(0)) continue
    text = buffer.toString('utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/u)
  const secretFixture = file === 'tests/unit/recording/redaction.test.ts'
  lines.forEach((line, index) => {
    const hits = personalPathMatches(line)
    if (hits.length > 0) {
      violations.push({ file, line: index + 1, rule: 'personal path', detail: hits.join(', ') })
    }
    if (!secretFixture) {
      for (const rule of SECRET_RULES) {
        if (rule.pattern.test(line)) {
          violations.push({ file, line: index + 1, rule: rule.name, detail: '' })
        }
      }
    }
  })
}

if (violations.length > 0) {
  for (const violation of violations) {
    const suffix = violation.detail.length === 0 ? '' : ` (${violation.detail})`
    console.error(`${violation.file}:${String(violation.line)}: ${violation.rule}${suffix}`)
  }
  console.error(`\n${String(violations.length)} public-boundary violation(s) found.`)
  process.exit(1)
}
console.log(`public boundary OK: ${String(files.length)} tracked files scanned.`)
