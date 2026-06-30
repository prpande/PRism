import { defineConfig } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A per-run DataDir keeps E2E hermetic: no leakage from a developer's local
// %LOCALAPPDATA%/PRism token cache or state.json into the test backend, and
// no leakage from one test run into the next. mkdtempSync (NOT a Date.now()
// suffix) guarantees a unique dir even when two suites start in the same
// millisecond — load-bearing for #217 parallel agents, where two e2e runs on
// distinct ports must not share a backend store. Placed under the OS temp dir so
// it cleans up via standard temp-folder eviction.
const e2eDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'PRism-e2e-'));

// Port is parameterized (#217) so multiple agents/worktrees can run the suite in
// parallel without colliding on 5180. Default 5180 keeps single-agent + CI flows
// unchanged. Pick a band outside the app's auto-port range (5180–5199) and the
// reserved 5181 real-flow port — see .ai/docs/parallel-agent-testing.md.
//
// Require an integer in the valid TCP range; anything else (negative, fractional,
// non-numeric, out-of-range) falls back to 5180 rather than templating an invalid
// URL like http://localhost:-1 or http://localhost:5180.5. A plain
// `Number(x) || 5180` would let truthy-but-invalid values like -1 through.
const DEFAULT_E2E_PORT = 5180;
function parseE2ePort(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_E2E_PORT;
}
const e2ePort = parseE2ePort(process.env.PRISM_E2E_PORT);
const isDefaultPort = e2ePort === DEFAULT_E2E_PORT;

// Single uniform test profile: the `prod` project (single-binary path —
// Kestrel serves /api/* AND the React bundle from wwwroot on :5180) runs
// EVERYWHERE, local and CI. It is what ships and what users hit, so local and
// CI exercise the SAME suite — a prerequisite for "N consistent runs on both"
// to mean anything.
//
// The former `dev` project (Vite dev server on :5173) was dropped: it re-ran
// the same UI logic against a different server purely to exercise Vite's
// config/proxy, which (a) surfaces instantly the moment a developer runs
// `npm run dev`, (b) is covered in CI by `__tests__/vite-config.smoke.test.ts`
// (loads vite.config.ts via Vite's programmatic API — <2s, no browser), and
// (c) cost real reliability: Vite + `dotnet run` startup contention on Windows
// runners produced intermittent ERR_CONNECTION_REFUSED, and the `/api`-proxy-
// only surface made /test/* calls 404 under dev. One profile removes both
// failure modes and the relative-vs-absolute /test URL footgun.
//
// `isCI` gates reuseExistingServer together with isDefaultPort (reuse a running
// server locally only on the default port; always boot fresh in CI or on a
// parallel-agent's non-default port).
const isCI = !!process.env.CI;

const backendWebServer = {
  // The frontend build is folded INTO the webServer command — not run from
  // globalSetup — because Playwright starts `webServer` BEFORE `globalSetup`.
  // On a fresh checkout (CI container) wwwroot does not exist yet, so a
  // server that boots first resolves an empty WebRoot ("WebRootPath was not
  // found"), and MapStaticAssets/MapFallbackToFile then 404s every SPA route
  // for the life of the process — globalSetup's later build is too late to
  // help the already-listening server. Building here guarantees wwwroot AND
  // the static-web-assets manifest exist before Kestrel binds. (Locally this
  // command is skipped when reuseExistingServer reuses a running app.)
  //
  // The explicit `dotnet build` after `npm run build` regenerates
  // PRism.Web.staticwebassets.endpoints.json against the fresh wwwroot;
  // without it an incremental `dotnet run` keeps a stale manifest and serves
  // bundle JS/CSS as 200 OK / 0 bytes.
  //
  // --no-launch-profile so PRism.Web/Properties/launchSettings.json (which
  // forces ASPNETCORE_ENVIRONMENT=Development) doesn't override the Test env
  // var Playwright passes via `env` below. Without this flag, the
  // FakeReviewService swap never engages.
  command: `npm run build && cd .. && dotnet build PRism.Web --nologo --verbosity minimal && dotnet run --project PRism.Web --no-launch-profile --urls http://localhost:${e2ePort} -- --no-browser`,
  url: `http://localhost:${e2ePort}/api/health`,
  // Reuse a running server locally ONLY on the default port. A non-default port
  // means a parallel agent explicitly asked for an isolated server — reusing
  // whatever is already on that port would cross-talk with another agent's
  // backend (possibly a different dataDir). Always boot fresh in CI.
  reuseExistingServer: !isCI && isDefaultPort,
  // Headroom for the folded build (npm build + dotnet build) on a cold CI
  // container before Kestrel binds the health URL.
  timeout: 180_000,
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
    // Pull the ActivePrPoller cadence down so the reconciliation spec sees
    // a `pr-updated` SSE event within Playwright's 30s default test timeout
    // (production default is 30s — too slow to fit a snapshot-shift fire
    // inside one test cycle).
    PRISM_POLLER_CADENCE_SECONDS: '1',
  },
};

const prodProject = {
  name: 'prod',
  use: { browserName: 'chromium' as const, baseURL: `http://localhost:${e2ePort}` },
};

export default defineConfig({
  testDir: './e2e',
  // The real-flow suite (./e2e/real/*.spec.ts) runs against a different backend port
  // (5181, started by playwright.real.config.ts) and requires a real GitHub PAT. The
  // default config (fake-mode, port 5180) must not pick these up — they would fail with
  // connect ECONNREFUSED against /test/real-inject. Run real-flow via
  // `npm run test:e2e:real` (which uses playwright.real.config.ts) instead.
  // cold-start-cache.spec.ts runs ONLY under playwright.coldstart.config.ts (its own
  // pre-seeded backend on :5210). The default fake-mode backend boots an EMPTY data dir,
  // so the cold-start rehydrate the spec asserts can't happen here — exclude it.
  testIgnore: ['**/real/**', '**/cold-start-cache.spec.ts'],
  fullyParallel: false,
  // Serialize across files, not just within them. The .NET backend is a single
  // long-running process with global fake state (FakeReviewSubmitter +
  // FakeReviewBackingStore + ActivePrCache + state.json), so concurrent
  // Playwright workers pollute each other's scenarios — even with the
  // /test/reset between-test hook, the reset is per-spec and cannot quiesce
  // mutations in flight from a sibling worker. S5 PR7 worked around this with
  // the `--workers=1` CLI flag; baking it in removes the carve-out and lets
  // every future spec rely on a clean backend. True per-worker isolation
  // (each worker spawning its own backend on a private port) is a larger
  // structural change deferred to its own slice if/when e2e wall-clock
  // becomes load-bearing.
  workers: 1,
  retries: 1,
  // No globalSetup: the frontend/.NET build it used to run is now folded into
  // the webServer command, because Playwright runs webServer BEFORE globalSetup
  // — so a globalSetup build lands too late to populate wwwroot on a fresh
  // checkout. See backendWebServer.command above.
  webServer: [backendWebServer],
  use: {
    trace: 'on-first-retry',
  },
  // Per-platform screenshot baselines (e2e/__screenshots__/<platform>/...) so the
  // PR9 no-layout-shift-on-banner spec's supplementary diff doesn't fail on
  // contributors running a different OS against a baseline rendered elsewhere. CI
  // runs Playwright in the Linux container (.github/workflows/ci.yml), so the
  // canonical baselines live under linux/; win32/ is retained for local CI=1
  // runs on Windows.
  expect: {
    toHaveScreenshot: {
      pathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
    },
  },
  projects: [prodProject],
});
