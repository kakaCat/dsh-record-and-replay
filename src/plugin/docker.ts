/**
 * dsh-record-and-replay/docker — independently switchable Docker backend.
 *
 * The row is disabled by default in cordis.patch.yml. Enabling it changes only
 * the execution environment: the main line keeps its existing tools, store,
 * semantic replay and panel, while this registration selects container-backed
 * Cua MCP and Xvfb video recording for newly created workspace runtimes.
 */
import { resolveDockerConfig } from '../docker/config.js'
import { disposeAllRuntimes, registerSharedDockerConfig, type PluginLogger } from './shared.js'

export const name = 'dsh-record-and-replay/docker'

export function apply(ctx: unknown, rawConfig?: unknown): void {
  const logger = (ctx as { logger?: (name: string) => PluginLogger }).logger?.(name) ?? console
  const config = resolveDockerConfig(rawConfig)
  const unregister = registerSharedDockerConfig(config)

  // Toggling the row must also affect workspaces whose local runtime was already
  // created. Disposal releases their bindings/containers before the next call.
  void disposeAllRuntimes()
  logger.info('dsh-record-and-replay/docker: Docker backend enabled; containers start lazily per workspace')

  ;(ctx as { effect?: (fn: () => () => void, label?: string) => void }).effect?.(() => {
    return () => {
      unregister()
      void disposeAllRuntimes()
      logger.info('dsh-record-and-replay/docker: Docker backend disabled; host transport restored')
    }
  }, name + ': dispose')
}
