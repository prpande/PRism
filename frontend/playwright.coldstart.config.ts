import { defineConfig } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// #619 cold-start cache E2E — exercises the REAL InboxCacheRehydrator.StartAsync → TryRehydrate
// path with no test-only orchestrator shim. Playwright evaluates this file (and the seeding
// below) at CONFIG-PARSE time, BEFORE the webServer boots, so we pre-seed the backend's DataDir
// with the on-disk artifacts a previously-connected, previously-populated install would hold:
//   config.json (identity login=e2e-user), PRism.tokens.cache (committed PAT → hasToken=true),
//   inbox-snapshot.json (real IdentityKeyedFileCache envelope), activity-feed.json (shape parity).
// FIDELITY NOTE: under PRISM_E2E_FAKE_REVIEW=1, Program.cs swaps the real ActivityProvider (which
// owns the #619 activity rehydrate code) for FakeActivityProvider, so activity-feed.json is NOT
// consumed — the rail paints the fake feed. Inbox rehydrate IS the real production path.
const LOGIN = 'e2e-user';
const HOST = 'https://github.com';
const PORT = 5210; // outside the app auto-port band (5180–5199) and the real-flow port (5181)
const ORIGIN = `http://localhost:${PORT}`;

const e2eDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'PRism-coldstart-'));

fs.writeFileSync(
  path.join(e2eDataDir, 'config.json'),
  JSON.stringify({
    github: { accounts: [{ id: 'default', host: HOST, login: LOGIN, 'local-workspace': null }] },
  }),
);

fs.writeFileSync(
  path.join(e2eDataDir, 'PRism.tokens.cache'),
  JSON.stringify({ version: 1, tokens: { default: 'ghp_e2e_coldstart_seed' } }),
);

const envelope = (version: number, payload: unknown) => ({
  version,
  'owner-login': LOGIN,
  'owner-host': HOST,
  payload,
});
const ISO = '2026-06-30T11:50:00+00:00';

fs.writeFileSync(
  path.join(e2eDataDir, 'inbox-snapshot.json'),
  JSON.stringify(
    envelope(1, {
      sections: {
        'review-requested': [
          {
            reference: { owner: 'acme', repo: 'api', number: 123 },
            title: 'Cold start cached PR',
            author: LOGIN,
            repo: 'acme/api',
            'updated-at': ISO,
            'pushed-at': ISO,
            'commit-count': 1,
            'changed-files': 1,
            'comment-count': 0,
            additions: 10,
            deletions: 2,
            'head-sha': 'cache0000000000000000000000000000000000',
            ci: 'none',
            'last-viewed-head-sha': null,
            'last-seen-comment-id': null,
          },
        ],
      },
      enrichments: {},
      'last-refreshed-at': ISO,
      'ai-enrichment-settled': [],
    }),
  ),
);

fs.writeFileSync(
  path.join(e2eDataDir, 'activity-feed.json'),
  JSON.stringify(
    envelope(1, {
      items: [
        {
          'actor-login': 'noah.s',
          'actor-avatar-url': null,
          'actor-is-bot': false,
          verb: 'reviewed',
          repo: 'acme/api',
          'pr-number': 1810,
          title: 'PR #1810',
          url: 'https://github.com/acme/api/pull/1810',
          timestamp: ISO,
          source: 'received-event',
        },
      ],
      'generated-at': ISO,
      degraded: { 'received-events': false, notifications: false, watching: false },
      watching: [],
      stale: false,
    }),
  ),
);

console.log(`[cold-start] seeded DataDir=${e2eDataDir}`);

const backend = {
  command: `npm run build && cd .. && dotnet build PRism.Web --nologo --verbosity minimal && dotnet run --project PRism.Web --no-launch-profile --urls ${ORIGIN} -- --no-browser`,
  url: `${ORIGIN}/api/health`,
  reuseExistingServer: false,
  timeout: 180_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  env: {
    ASPNETCORE_ENVIRONMENT: 'Test',
    PRISM_E2E_FAKE_REVIEW: '1',
    DataDir: e2eDataDir,
    PRISM_POLLER_CADENCE_SECONDS: '2',
  },
};

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/cold-start-cache.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  webServer: [backend],
  use: { browserName: 'chromium' as const, baseURL: ORIGIN, trace: 'on-first-retry' },
  projects: [{ name: 'coldstart' }],
});
