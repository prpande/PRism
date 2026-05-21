import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// .env.local is optional today (gh CLI is the primary PAT source per design §7.5).
// Loaded for forward-compat in case future overrides need it. quiet:true suppresses
// the dotenv@17+ default informational injection log (loud by default since v17.0).
dotenv.config({ path: '.env.local', quiet: true });

// Per-run DataDir keeps the suite hermetic — no leakage from a developer's local
// %LOCALAPPDATA%/PRism state.json. globalSetup will commit the PAT into this DataDir's
// PRism.tokens.cache via the real /api/auth/connect flow.
const e2eDataDir = path.join(os.tmpdir(), `PRism-e2e-real-${Date.now()}`);
fs.mkdirSync(e2eDataDir, { recursive: true });

const backend = {
  command:
    'cd .. && dotnet run --project PRism.Web --no-launch-profile --urls http://localhost:5181 -- --no-browser',
  url: 'http://localhost:5181/api/health',
  reuseExistingServer: false,
  timeout: 120_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  env: {
    ASPNETCORE_ENVIRONMENT: 'Test',
    PRISM_E2E_REAL_INJECT: '1',
    // PRISM_E2E_FAKE_REVIEW deliberately NOT set — Program.cs rejects the combo.
    DataDir: e2eDataDir,
    PRISM_POLLER_CADENCE_SECONDS: '1',
    // Override FileLoggerExtensions Test-env gate so the stale-OID investigation
    // methodology can capture structured logs to <DataDir>/logs/prism-yyyy-MM-dd.log.
    // See docs/specs/2026-05-19-stale-oid-banner-investigation-design.md Section 3.4.
    PRISM_FILE_LOGGER_FORCE: '1',
  },
};

export default defineConfig({
  testDir: './e2e/real',
  fullyParallel: false,
  workers: 1,
  retries: 0, // see design §7.6 — flake-loudly is intentional for real-flow
  globalSetup: './e2e/real/global-setup.ts',
  webServer: [backend],
  use: {
    browserName: 'chromium' as const,
    baseURL: 'http://localhost:5181',
    trace: 'retain-on-failure', // retries:0 means 'on-first-retry' never fires; capture trace on the single attempt instead
  },
  projects: [{ name: 'real' }],
});
