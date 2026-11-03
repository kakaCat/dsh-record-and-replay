/**
 * dsh-record-replay/desktop —— Cordis 插件入口（桌面行）。
 *
 * 同一 bundle 的第二个装载行，与 `dsh-window` 的「一个 bundle 多行、插件页每行
 * 一个开关」同款：本行在 `cordis.patch.yml` 里 `disabled: true` 缺省关闭，要用
 * 桌面（macOS AX）工具时在插件页把 `record-replay-desktop` 的开关打开。关掉时
 * 本 `apply` 根本不跑，8 个 `cua_desktop_*` 工具不会出现在模型工具列表里——
 * 不是「注册了但报错」，是完全不存在。
 *
 * 本行不带配置：工作区运行时经 `plugin/shared.ts` 与主线共享（同进程唯一实例，
 * 配置以主线登记的为准；主线被禁用时用默认配置）。
 *
 * @module dsh-record-replay/desktop
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createDesktopTools } from './desktop-tools.js'
import {
  execOfCall,
  getRuntime,
  hostCallOf,
  renderJson,
  toParameterSpec,
  type ExecLike,
  type PluginLogger,
} from './shared.js'

export const name = 'dsh-record-replay/desktop'

export function apply(ctx: unknown): void {
  const logger = (ctx as { logger?: (name: string) => PluginLogger }).logger?.(name) ?? console
  const disposers: Array<() => void> = []
  ;(ctx as { inject?: (services: string[], cb: (toolsCtx: any) => void) => void }).inject?.(
    ['tools'],
    (toolsCtx: { effect?: (fn: () => void, label?: string) => void; tools?: { register(tool: unknown): () => void } }) => {
      toolsCtx.effect?.(() => {
        if (toolsCtx.tools === undefined) {
          logger.warn('dsh-record-replay/desktop: tools service unavailable; desktop tools not registered')
          return
        }
        for (const tool of createDesktopTools(async call => (await getRuntime(execOfCall(call), logger)).driver)) {
          disposers.push(toolsCtx.tools.register(defineTool({
            name: tool.name,
            description: tool.description,
            parameters: toParameterSpec(tool.inputSchema),
            output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
            execute: async (args: unknown, exec: ExecLike) => tool.handle(args, hostCallOf(exec)) as Promise<unknown>,
          } as any)))
        }
        logger.info(`dsh-record-replay/desktop: ${String(disposers.length)} desktop tools registered`)
      }, name + ': tools')
    },
  )
  ;(ctx as { effect?: (fn: () => void, label?: string) => void }).effect?.(() => {
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
      // 故意不 dispose 工作区运行时：表是共享的，主线还在用；由主线负责收尾。
    }
  }, name + ': dispose')
}
