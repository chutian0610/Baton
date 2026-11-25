import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * The Web UI (ADR-0007): Vue 3 + Vite, built into dist/ui/ where the daemon
 * serves it at /ui. `base` must match the daemon's mount point so asset URLs
 * come out as /ui/assets/*. The dev-server proxy lets `vite dev` talk to a
 * locally running daemon (BATON_PORT-aware start: `baton daemon`) without
 * CORS — the built bundle is same-origin and needs none of this.
 */
export default defineConfig({
  root: 'ui',
  base: '/ui/',
  plugins: [vue()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/tasks': 'http://127.0.0.1:7600',
      '/projects': 'http://127.0.0.1:7600',
      '/healthz': 'http://127.0.0.1:7600',
      '/mcp': 'http://127.0.0.1:7600',
    },
  },
});
