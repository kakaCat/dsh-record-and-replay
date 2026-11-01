/** 套件结果 → JUnit XML，供 CI 消费。 */
export interface JUnitCase {
  readonly name: string
  readonly status: string
  readonly errorCode?: string
  readonly error?: string
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function toJUnit(suiteName: string, cases: readonly JUnitCase[]): string {
  const failures = cases.filter(item => item.status !== 'completed').length
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${escapeXml(suiteName)}" tests="${String(cases.length)}" failures="${String(failures)}" errors="0">`,
  ]
  for (const item of cases) {
    lines.push(`  <testcase name="${escapeXml(item.name)}">`)
    if (item.status !== 'completed') {
      const message = item.error ?? item.errorCode ?? item.status
      lines.push(`    <failure message="${escapeXml(message)}">${escapeXml(message)}</failure>`)
    }
    lines.push('  </testcase>')
  }
  lines.push('</testsuite>')
  return `${lines.join('\n')}\n`
}
