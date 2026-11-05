import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/plugin/index.ts',
    // 第二个插件行入口：cordis.patch.yml 以 record-replay-desktop 装载，缺省关闭。
    desktop: 'src/plugin/desktop.ts',
    // 独立 Docker 后端行：只切换执行环境，缺省关闭。
    docker: 'src/plugin/docker.ts',
    'native-host': 'src/cua/native-host.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: true,
  external: ['@deepseek-ai/dsh-tools', '@trycua/cua-driver'],
  noExternal: [/^@modelcontextprotocol\//],
  target: 'node22',
  minify: false,
})
