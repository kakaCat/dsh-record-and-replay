/**
 * Build the DSH client half as a lazy CJS bundle.
 *
 * DSH serves plugin bundles that execute `window.__ModuleLoader__.load({id,
 * factory})`: the script only registers a factory, and the factory is
 * materialized later with a `require` that resolves React from the shell's
 * shared module table. Vite's CJS library output is wrapped into exactly that
 * envelope here, and the extracted Tailwind CSS is injected inside the factory
 * (the loader has no separate stylesheet channel for plugin bundles).
 */
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ID = 'dsh-record-replay'

function dshClientBundle() {
  return {
    name: 'dsh-client-bundle',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const styles = Object.entries(bundle)
        .filter(([, output]) => output.type === 'asset' && output.fileName.endsWith('.css'))
        .map(([, output]) => String(output.source))
      for (const [key, output] of Object.entries(bundle)) {
        if (output.type === 'asset' && output.fileName.endsWith('.css')) delete bundle[key]
      }
      const css = styles.join('\n')

      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !output.isEntry) continue
        output.code = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PLUGIN_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    (() => {
      const css = ${JSON.stringify(css)};
      if (css.length === 0 || typeof document === "undefined") return;
      const previous = document.querySelector('style[data-plugin-css=${PLUGIN_ID}]');
      if (previous !== null) previous.remove();
      const style = document.createElement("style");
      style.setAttribute("data-plugin-css", ${JSON.stringify(PLUGIN_ID)});
      style.textContent = css;
      document.head.appendChild(style);
    })();
${output.code}
    return module.exports;
  },
});
`
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), dshClientBundle()],
  publicDir: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: path.resolve(root, 'dist/client'),
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    target: 'es2022',
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(root, 'src/client/plugin/index.tsx'),
      formats: ['cjs'],
      fileName: () => 'client.js',
    },
    rollupOptions: {
      // React comes from the shell's frozen module table; everything else is
      // bundled so the plugin has no runtime npm resolution.
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    },
  },
})
