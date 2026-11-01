/**
 * Entry point for the isolated native Cua runtime.
 *
 * The plugin never loads the native SDK in the DSH process. It spawns this
 * script and speaks MCP over stdio, so a crash in the Rust driver only kills
 * this short-lived child.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { NativeTransport } from './native-transport.js'
import { createNativeHostServer } from './native-host-server.js'

async function run(): Promise<void> {
  const runtime = await NativeTransport.create()
  const server = createNativeHostServer(runtime)
  const transport = new StdioServerTransport()

  let closing = false
  const shutdown = (code: number): void => {
    if (closing) return
    closing = true
    void runtime.close().catch(() => undefined).finally(() => process.exit(code))
  }

  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))
  process.stdin.on('end', () => shutdown(0))
  process.stdin.on('close', () => shutdown(0))
  server.onclose = () => shutdown(0)

  await server.connect(transport)
  process.stderr.write(`[dsh-native-host] pid=${String(process.pid)} ready\n`)
}

run().catch(error => {
  process.stderr.write(`[dsh-native-host] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
