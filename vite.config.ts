import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.resolve(root, 'src/client/panel'),
  base: '/panel/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(root, 'dist/panel'),
    emptyOutDir: false,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/panel/projects': 'http://127.0.0.1:4174',
      '/panel/project': 'http://127.0.0.1:4174',
      '/panel/recording': 'http://127.0.0.1:4174',
      '/panel/video': 'http://127.0.0.1:4174',
      '/panel/search': 'http://127.0.0.1:4174',
    },
  },
})
