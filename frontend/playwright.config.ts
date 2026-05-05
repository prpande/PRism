import { defineConfig } from '@playwright/test';

// Two projects, two serving modes:
//   `dev`  hits the Vite dev server (5173) which proxies /api to the .NET backend (5180).
//   `prod` hits the .NET backend (5180) directly, exercising the production single-binary path
//          where Kestrel serves both /api/* and the React bundle from wwwroot. This catches the
//          class of bugs that only manifest when shipping the binary (missing UseStaticFiles,
//          stale wwwroot hashes, SPA-fallback misconfiguration, JS bundle errors at mount).
//
// `globalSetup` populates wwwroot via `npm run build` before the .NET webServer starts so the
// prod project has something to serve. CI's separate frontend-build step makes this redundant
// but it keeps `npx playwright test` self-contained for local runs.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 1,
  globalSetup: './e2e/global-setup.ts',
  webServer: [
    {
      command:
        'cd .. && dotnet run --project PRism.Web --urls http://localhost:5180 -- --no-browser',
      url: 'http://localhost:5180/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'dev',
      use: { browserName: 'chromium', baseURL: 'http://localhost:5173' },
    },
    {
      name: 'prod',
      use: { browserName: 'chromium', baseURL: 'http://localhost:5180' },
    },
  ],
});
