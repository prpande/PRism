import { defineConfig } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A per-run DataDir keeps E2E hermetic: no leakage from a developer's local
// %LOCALAPPDATA%/PRism token cache or state.json into the test backend, and
// no leakage from one test run into the next. The directory is created fresh
// at config-load time and passed to the backend via --DataDir. Placed under
// the OS temp dir so it cleans up via standard temp-folder eviction.
const e2eDataDir = path.join(os.tmpdir(), `PRism-e2e-${Date.now()}`);
fs.mkdirSync(e2eDataDir, { recursive: true });

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
  // --no-launch-profile so PRism.Web/Properties/launchSettings.json (which
  // forces ASPNETCORE_ENVIRONMENT=Development) doesn't override the Test env
  // var Playwright passes via `env` below. Without this flag, the
  // FakeReviewService swap never engages.
  command: `cd .. && dotnet run --project PRism.Web --no-launch-profile --urls http://localhost:5180 -- --no-browser`,
  url: 'http://localhost:5180/api/health',
  reuseExistingServer: !isCI,
  timeout: 120_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  // Boots the backend with the test-only IReviewService swap so the new S4 PR7
  // E2E specs (drafts-survive-restart, reconciliation-fires, multi-tab-
  // consistency, keep-anyway-survives-reload) can drive real backend behavior
  // without needing a GitHub PAT. The existing specs (inbox, cold-start, no-
  // browser) page.route-mock the API surface and are unaffected by the swap.
  // See PRism.Web/TestHooks/FakeReviewService.cs + TestEndpoints.cs and
  // Program.cs (the env-var gate).
  // `DataDir` is read by Program.cs (Configuration["DataDir"]) via the
  // Environment config provider, which gives us a per-run dataDir without
  // having to argv-thread it through `dotnet run -- ...` (the arg-vs-config
  // split there is finicky on Windows shells).
  env: {
    ASPNETCORE_ENVIRONMENT: 'Test',
    PRISM_E2E_FAKE_REVIEW: '1',
    DataDir: e2eDataDir,
  },
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
