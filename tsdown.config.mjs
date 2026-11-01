import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/plugin/index.ts',
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
