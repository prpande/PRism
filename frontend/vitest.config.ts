import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./__tests__/setup.ts', './__tests__/setup-mermaid.ts'],
    globals: true,
    css: true,
    // #234: lift the per-test timeout above the 5000ms default so it sits safely
    // above the 8000ms asyncUtilTimeout (configured in setup.ts) — a waitFor that
    // runs to its ceiling under parallel-suite load then fails with its own clear
    // assertion message instead of a generic "test timed out". Only failing tests
    // run this long; passing waits resolve as soon as their condition holds.
    testTimeout: 20000,
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
