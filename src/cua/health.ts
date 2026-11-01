/**
 * Cua `health_report` parsing shared by the DSH plugin and the standalone CLI.
 *
 * Keeping this outside `plugin/index.ts` lets the CLI read the driver version
 * without loading the host plugin (and its DSH peer dependency).
 */

function cuaHealthReportOf(result: unknown): Record<string, unknown> | undefined {
  const value = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> } | undefined
  let data: unknown = value?.structuredContent
  if (data === undefined) {
    const text = value?.content?.find(part => part.type === 'text')?.text
    if (text !== undefined) {
      try { data = JSON.parse(text) } catch { return undefined }
    }
  }
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : undefined
}

export function cuaVersionOf(result: unknown): string | undefined {
  const record = cuaHealthReportOf(result)
  if (record === undefined) return undefined
  // 0.38 CLI: build.version；0.28 native SDK: 顶层 driver_version。
  const build = record['build']
  if (typeof build === 'object' && build !== null) {
    const version = (build as { version?: unknown }).version
    if (typeof version === 'string' && version.length > 0) return version
  }
  const driverVersion = record['driver_version']
  if (typeof driverVersion === 'string' && driverVersion.length > 0) return driverVersion
  const checks = record['checks']
  if (Array.isArray(checks)) {
    for (const check of checks) {
      if (typeof check !== 'object' || check === null) continue
      const entry = check as { name?: unknown; message?: unknown }
      if (entry.name !== 'binary_version' || typeof entry.message !== 'string') continue
      const match = /(\d+\.\d+\.\d+)/u.exec(entry.message)
      if (match?.[1] !== undefined) return match[1]
    }
  }
  return undefined
}

/**
 * A native runtime hosted by a process without an app bundle identity cannot
 * pass macOS TCC checks for inspecting other browser processes. Surface that
 * as a pre-flight reason instead of failing the first bind.
 */
export function cuaNativeIdentityIssue(result: unknown): string | undefined {
  const checks = cuaHealthReportOf(result)?.['checks']
  if (!Array.isArray(checks)) return undefined
  for (const check of checks) {
    if (typeof check !== 'object' || check === null) continue
    const entry = check as { name?: unknown; status?: unknown; message?: unknown }
    if (entry.name !== 'bundle_identity' || entry.status !== 'fail') continue
    const detail = typeof entry.message === 'string' ? `: ${entry.message}` : ''
    return `native Cua runtime has no app bundle identity; macOS will refuse browser process inspection${detail}`
  }
  return undefined
}
