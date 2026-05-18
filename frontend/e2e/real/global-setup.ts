import { chromium, request } from '@playwright/test';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SandboxFixture } from './helpers/sandbox-fixture';

const BACKEND = 'http://localhost:5181';

export default async function globalSetup(): Promise<void> {
  // 1. Read fixtures.json.
  const fxPath = path.join('e2e', 'real', 'fixtures.json');
  if (!fs.existsSync(fxPath)) {
    throw new Error(
      `fixtures.json not found at ${fxPath}. Run \`npm run setup-real-e2e-fixtures\` first; see docs/e2e/real-flow.md.`,
    );
  }
  const fixtures = JSON.parse(fs.readFileSync(fxPath, 'utf8')) as SandboxFixture[];

  // 2. Validate gh auth.
  try {
    execFileSync('gh', ['api', '/user'], { stdio: 'ignore' });
  } catch {
    throw new Error('gh CLI is not authenticated. Run `gh auth login --scopes repo` first.');
  }

  // 3. Capture PAT.
  const pat = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8' }).trim();
  if (!pat) throw new Error('gh auth token returned empty.');

  // 4. Verify viewer.login matches fixtures' owning login (defense against accidental wrong-identity run).
  const viewer = JSON.parse(
    execFileSync('gh', ['api', 'graphql', '-f', 'query={ viewer { login } }'], { encoding: 'utf8' }),
  ) as { data: { viewer: { login: string } } };
  const myLogin = viewer.data.viewer.login;
  // Anchored match — `split('-').slice(-1)[0]` would yield "doe" for "john-doe" because GitHub
  // logins can contain hyphens. The setup script writes branches as `e2e-real-${name}-fixture-${login}`
  // (Task 11), so the `-fixture-` literal is a stable boundary regardless of login internals.
  const fixtureLogin = fixtures[0].branch.match(/-fixture-(.+)$/)?.[1] ?? '';
  if (myLogin !== fixtureLogin) {
    throw new Error(
      `gh auth identity mismatch: current login is "${myLogin}" but fixtures.json was generated for "${fixtureLogin}". Re-run setup-real-e2e-fixtures or switch gh auth context.`,
    );
  }

  // 5. Rebuild frontend + backend so wwwroot manifest matches built assets (mirrors fake-mode global-setup).
  console.log('[real-flow-setup] building frontend bundle…');
  execSync('npm run build', { stdio: 'inherit' });
  console.log('[real-flow-setup] rebuilding PRism.Web so static-assets manifest matches wwwroot…');
  execSync('dotnet build PRism.Web --nologo --verbosity minimal', { stdio: 'inherit', cwd: '..' });

  // 6. Wait for backend health (the webServer block starts it; this is just a courtesy poll).
  const apiCtx = await request.newContext();
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await apiCtx.get(`${BACKEND}/api/health`);
      if (r.ok()) {
        healthy = true;
        break;
      }
    } catch {
      // backend still booting
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  await apiCtx.dispose();
  if (!healthy) throw new Error('backend never reached /api/health within 60s');

  // 7. Bootstrap an auth-eligible request context: launch chromium, GET /, capture the prism-session
  //    cookie. SessionTokenMiddleware enforces auth on /api/* under Test env; OriginCheckMiddleware
  //    rejects POSTs without Origin. A page.request bound to a navigated browser context satisfies both
  //    (cookie jar + auto-Origin). A bare APIRequestContext does neither.
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: BACKEND });
  const page = await context.newPage();
  await page.goto('/'); // stamps prism-session cookie via text/html cookie-stamping middleware

  // 8. POST PAT via /api/auth/connect. /commit only fires on warning (NoReposSelected).
  //    PRism serializes JSON in camelCase (PRism.Core/Json/JsonSerializerOptionsFactory.cs sets
  //    PropertyNamingPolicy = JsonNamingPolicy.CamelCase) — read camelCase keys, not PascalCase.
  const connectResp = await page.request.post('/api/auth/connect', {
    data: { pat },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!connectResp.ok()) {
    // Do NOT include the raw response body — a malformed validation response could echo
    // the submitted PAT, and Playwright captures globalSetup stdout. Status code is enough
    // to diagnose; re-run with --debug to inspect the body interactively if needed.
    throw new Error(`POST /api/auth/connect failed: HTTP ${connectResp.status()}`);
  }
  const connectBody = (await connectResp.json()) as { ok: boolean; error?: string; warning?: string; login?: string };
  if (!connectBody.ok) {
    throw new Error(`/api/auth/connect rejected PAT: error=${connectBody.error ?? '(unknown)'}`);
  }
  if (connectBody.warning) {
    // Soft warning (NoReposSelected, typical for fine-grained PATs). Accept by calling /commit.
    const commitResp = await page.request.post('/api/auth/connect/commit', {});
    if (!commitResp.ok()) {
      // Same PAT-echo defence as above — status only.
      throw new Error(`POST /api/auth/connect/commit failed: HTTP ${commitResp.status()}`);
    }
    console.log(`[real-flow-setup] PAT committed with warning=${connectBody.warning}`);
  } else {
    console.log('[real-flow-setup] PAT committed inline (no warning)');
  }

  await browser.close();
  console.log('[real-flow-setup] ready.');
}
