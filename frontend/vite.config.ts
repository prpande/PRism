import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_E2E_TEST is read from the host process environment at build time and baked
// into the bundle so window.__prism_test_getTabId is exposed for Playwright mocked-mode
// specs. Belt-and-suspenders relative to Vite's automatic VITE_* exposure — relying on
// `import.meta.env.VITE_E2E_TEST` alone failed on Windows CI runners where the env-var
// set via the workflow `env:` block didn't propagate to Vite's loadEnv. An explicit
// `define` makes the injection deterministic across hosts and Vite versions.
const VITE_E2E_TEST = JSON.stringify(process.env.VITE_E2E_TEST ?? 'false');

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_E2E_TEST': VITE_E2E_TEST,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5180',
    },
  },
  build: {
    outDir: '../PRism.Web/wwwroot',
    emptyOutDir: true,
  },
});
