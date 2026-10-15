import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * react -> preact/compat alias, applied with enforce: 'pre' and listed BEFORE the
 * preact preset so every react-flavored import (notably @fullcalendar/react)
 * resolves through preact/compat regardless of plugin order.
 *
 * The @wycal/core alias is FIRST so the shared core (packages/core) resolves
 * from source in dev and build, bypassing node_modules resolution entirely.
 */
function reactCompatAlias(): Plugin {
  return {
    name: 'react-compat-alias',
    enforce: 'pre',
    config: () => ({
      resolve: {
        alias: [
          {
            find: /^@wycal\/core/,
            replacement: fileURLToPath(new URL('./packages/core/src', import.meta.url)),
          },
          { find: /^react$/, replacement: 'preact/compat' },
          { find: /^react-dom$/, replacement: 'preact/compat' },
          { find: /^react-dom\/client$/, replacement: 'preact/compat' },
        ],
      },
    }),
  };
}

const davProxy = {
  '/dav': {
    target: 'http://127.0.0.1:5232',
    changeOrigin: false,
    // Radicale stays prefix-free; the /dav prefix exists only on our origin.
    rewrite: (path: string) => path.replace(/^\/dav/, ''),
  },
};

export default defineConfig({
  plugins: [reactCompatAlias(), preact(), tailwindcss()],
  server: {
    port: 5173,
    proxy: davProxy,
    watch: {
      // The Radicale fixture lives inside the project: its storage rewrites
      // sync-token cache files on every sync REPORT, and Vite answers watched
      // non-source file changes with a full page reload — which restarts the
      // boot sync, which writes again: an infinite reload loop. Keep it out.
      ignored: ['**/scripts/radicale/**', '**/node_modules/**', '**/dist/**'],
    },
  },
  preview: {
    port: 4173,
    proxy: davProxy,
  },
});
