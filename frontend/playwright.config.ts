import { defineConfig } from '@playwright/test';

// CI vs. local split — read once so both `webServer` and `projects` agree.
//
// In CI we run only the `prod` project (single-binary path: Kestrel serves
// /api/* and the React bundle from wwwroot). Rationale:
//
//   - `prod` is what end users hit. UI behavior, routing, API calls, and
//     accessibility are all exercised there. ~95% of test value lives in
//     code paths shared between dev and prod.
//   - `dev` is a developer tool. Its bugs (Vite config regressions, /api
//     proxy misconfig, plugin-upgrade breakage) surface immediately when
//     a developer runs `npm run dev` locally — caught at the inner loop,
//     before any commit. CI gating on dev was buying us a slow tripwire
//     for a fast-signaling failure mode.
//   - Vite + `dotnet run` startup contention on Windows runners produced
//     intermittent ERR_CONNECTION_REFUSED in [dev] tests with no diagnostic
//     output. Removing the parallel-startup race eliminates the flake at
//     the source.
//
// Vite-config regression coverage on the CI side moves to a Vitest smoke
// test (`__tests__/vite-config.smoke.test.ts`) that loads `vite.config.ts`
// via Vite's programmatic API. Fast (<2s), no browser orchestration, no
// subprocess startup contention, runs on every CI build.
//
// Locally `npx playwright test` still runs both projects so devs get the
// full coverage during the pre-push checklist.
const isCI = !!process.env.CI;

const backendWebServer = {
  command: 'cd .. && dotnet run --project PRism.Web --urls http://localhost:5180 -- --no-browser',
  url: 'http://localhost:5180/api/health',
  reuseExistingServer: !isCI,
  timeout: 120_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
};

const viteDevWebServer = {
  command: 'npm run dev',
  url: 'http://localhost:5173',
  reuseExistingServer: !isCI,
  timeout: 60_000,
  // Surfacing Vite's stdout/stderr would help the next dev-server flake be
  // diagnosable. Kept on `pipe` so a future regression has visibility.
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
};

const prodProject = {
  name: 'prod',
  use: { browserName: 'chromium' as const, baseURL: 'http://localhost:5180' },
};

const devProject = {
  name: 'dev',
  use: { browserName: 'chromium' as const, baseURL: 'http://localhost:5173' },
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 1,
  globalSetup: './e2e/global-setup.ts',
  webServer: isCI ? [backendWebServer] : [backendWebServer, viteDevWebServer],
  use: {
    trace: 'on-first-retry',
  },
  projects: isCI ? [prodProject] : [devProject, prodProject],
});
