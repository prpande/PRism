import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// __PRISM_E2E_TEST__ is a custom build-time global that mirrors process.env.VITE_E2E_TEST.
// Using a custom token (rather than redefining `import.meta.env.VITE_E2E_TEST`) sidesteps a
// conflict where Vite's internal `import.meta.env` handling appears to win over the user's
// `define` on this Vite 8 + rolldown build, leaving the prod bundle without the test hook
// even when `VITE_E2E_TEST=true` was set in the host environment. The custom token is
// unambiguous — Vite's `define` replaces every textual occurrence verbatim, and tree-shaking
// drops the branch when the constant is false.
// Diagnostic — surface what the CI shell actually delivered. Will print in the
// `Frontend build` step's log so the cross-tab-stamp slice's e2e wire-up can be
// audited from CI output. Remove once the env-propagation gap is closed.
const rawE2eEnv = process.env.VITE_E2E_TEST;
// eslint-disable-next-line no-console
console.log(
  `[vite.config] process.env.VITE_E2E_TEST = ${JSON.stringify(rawE2eEnv)} ` +
    `(typeof=${typeof rawE2eEnv}, === 'true' → ${rawE2eEnv === 'true'})`,
);
const PRISM_E2E_TEST = JSON.stringify(rawE2eEnv === 'true');

export default defineConfig({
  plugins: [react()],
  define: {
    __PRISM_E2E_TEST__: PRISM_E2E_TEST,
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
