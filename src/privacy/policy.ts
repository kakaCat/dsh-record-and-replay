/**
 * 录制隐私策略（P0-2）：URL 排除与私密浏览窗口识别。
 *
 * 设计边界：
 * - 本模块只做纯文本判定，不读 Store / 不碰 Cua / 不写盘，Host 与 Recording 都可安全复用；
 * - URL 规则用**大小写不敏感的子串**而不是正则：配置来自用户，避免灾难性回溯；
 * - 私密浏览只能凭窗口标题判断（Cua 的 bind 不返回 bundle id）；模式刻意收窄到浏览器
 *   自带的私密窗口标题，宁可漏判也不误杀普通页面；可由配置整体关闭。
 */
import type { BrowserAction, SemanticTarget } from '../core/api.js'

export const MAX_DENIED_URL_PATTERNS = 50
export const MAX_DENIED_URL_PATTERN_LENGTH = 500

/** 命中即抑制该步骤（以及之后的步骤，直到导航到未排除的 URL）。 */
export function matchesDeniedUrl(url: string | undefined, patterns: readonly string[]): boolean {
  if (url === undefined || url.length === 0 || patterns.length === 0) return false
  const haystack = url.toLowerCase()
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase()
    return needle.length > 0 && haystack.includes(needle)
  })
}

/** 一个动作里所有可判定的 URL：navigate URL、语义目标的 origin/path、wait/assert 的 URL。 */
export function actionUrlCandidates(action: BrowserAction): readonly string[] {
  const urls: string[] = []
  switch (action.kind) {
    case 'navigate':
      urls.push(action.url)
      break
    case 'click':
    case 'setValue':
      urls.push(...targetUrls(action.target))
      break
    case 'drag':
      urls.push(...targetUrls(action.from), ...targetUrls(action.to))
      break
    case 'scroll':
    case 'key':
      urls.push(...targetUrls(action.target))
      break
    case 'wait':
      if (action.condition.kind === 'url') urls.push(action.condition.url)
      break
    case 'assert':
      if (action.check.kind === 'url') {
        urls.push(action.check.contains)
      } else if (action.check.kind === 'element' || action.check.kind === 'value') {
        urls.push(...targetUrls(action.check.target))
      }
      break
  }
  return [...new Set(urls.filter((url) => url.length > 0))]
}

function targetUrls(target: SemanticTarget | undefined): readonly string[] {
  if (target?.url === undefined) return []
  const { origin, path } = target.url
  return [
    ...(origin === undefined ? [] : [origin]),
    ...(path === undefined ? [] : [path]),
    ...(origin === undefined || path === undefined ? [] : [`${origin}${path}`]),
  ]
}

/**
 * 浏览器私密窗口标题模式。覆盖 Chrome/Brave/Edge/Safari/Firefox 的英文与中文标题，
 * 不使用单独的 "private"（会把 "Private Equity" 这类页面误判成私密窗口）。
 */
const PRIVATE_BROWSER_TITLE_PATTERNS: readonly RegExp[] = [
  /\bincognito\b/iu,
  /\binprivate\b/iu,
  /\bprivate browsing\b/iu,
  /\bprivate window\b/iu,
  /\bprivate tab\b/iu,
  /\bprivate mode\b/iu,
  /\bnew (?:tab|window)\b.*\bprivate\b/iu,
  /无痕/u,
  /隐私浏览/u,
  /私密浏览/u,
]

export function isPrivateBrowserTitle(title: string | undefined): boolean {
  if (title === undefined) return false
  const trimmed = title.trim()
  if (trimmed.length === 0) return false
  return PRIVATE_BROWSER_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed))
}
