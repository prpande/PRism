# Validation Suite Phase 1 — Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/specs/2026-05-28-manual-validation-test-plan-design.md`

**Goal:** Bootstrap the `e2e-validation/` directory tree and ship J-P0-01 (first-time setup → routes to inbox) as a runnable Playwright spec end-to-end. First of 5 phases of SP1; subsequent phases add more fixtures, helpers, and scenarios on top of this foundation.

**Architecture:** Standalone Node project at repo-root `e2e-validation/`. Playwright's `webServer` block launches `dotnet run` in Test-env composition (with `PRISM_E2E_REAL_INJECT=1` but **without** `PRISM_E2E_FAKE_REVIEW`, so real `GitHubReviewService` is used). One spec walks the first-time-setup user journey: cold-boot SPA → paste PAT → land on inbox. No fixtures, no helpers for HTTP API interaction — J-P0-01 is purely UI-driven and needs neither.

**Tech Stack:** Playwright 1.59.1, TypeScript 5.7.3, Node 22+. Target backend: PRism.Web (.NET 10). Cross-platform launch via shell-chain in `playwright.config.ts`.

**Black-box isolation contract:** Per the spec, `e2e-validation/` owns its `package.json`, `tsconfig.json`, `playwright.config.ts`, `node_modules/`, and helpers. NO TypeScript imports from `frontend/`, `tests/`, or any other in-repo tree. Shell-level coordination (calling `npm run build` in `frontend/`, calling `dotnet run` for `PRism.Web`) is allowed because it's external-artifact invocation, not code sharing.

**Acceptance for Phase 1:** From a fresh checkout of the Phase 1 branch:
1. `cd e2e-validation && npm ci` succeeds.
2. With `PRISM_VALIDATION_PRIMARY_PAT` env var set to a valid fine-grained PAT, `npx playwright test` runs J-P0-01 and reports PASS.
3. PRism's binary launches via the webServer block in Test env, serves the SPA, validates the PAT against real GitHub, and routes to the inbox (URL `/`).

**Out of scope for Phase 1** (covered in Phases 2-5):
- Sandbox repo creation (`prpande/prism-validation-sandbox`) — not needed for J-P0-01
- All helpers except `recipes.ts`: `fixture-types.ts`, `reset-fixture.ts`, `inject-real-failure.ts`, `gh-sandbox.ts`, `reconciliation-fixtures.ts`
- All scripts: `setup-fixtures.ts`, `sandbox-health.ts`, `reset-sandbox.ts`
- Recipes A, C, D (harness), E (only Recipe B is needed for J-P0-01)
- The other 43 scenarios (J-P0-02..J-P3-07) + visual review pack (V-1..V-44)
- Orchestrator (`npm run validate-experience`) — that's SP2
- Pass-ordering enforcement (J-P2-11 `@last-in-pass` tag) — that's SP2
- `tsx` dependency — added in Phase 2 when `scripts/setup-fixtures.ts` actually needs it

---

## File structure after Phase 1

```
e2e-validation/
├── .gitignore              # node_modules, test-results, playwright-report
├── package.json            # own deps (Playwright, TypeScript, @types/node)
├── package-lock.json       # COMMITTED (matches frontend's pattern; enables npm ci)
├── tsconfig.json           # standalone TS config
├── README.md               # how to run + Recipe B pointer
├── playwright.config.ts    # webServer launches dotnet run in Test env
├── helpers/
│   └── recipes.ts          # Recipe-B PAT env-var lookup
└── specs/
    └── j-p0-01-first-time-setup.spec.ts
```

7 files committed (including lockfile). No `node_modules/` in commits (gitignored). No `fixtures.json` yet (Phase 2+).

---

## Cross-platform command syntax

The user's documented environment is **Windows + PowerShell** (per the project env description). The plan provides both PowerShell and bash variants for each non-portable shell command. Use whichever matches your shell.

Git commands, npm commands, dotnet commands, and npx commands are identical on both shells. Only filesystem ops (`mkdir`, `rm`, env-var setting) differ.

---

## Task 1: Create implementation worktree

**Files:** None in the repo. Creates a new git worktree at `D:\src\PRism-validation-phase1`.

**Rationale:** Per project's user-level instructions (CLAUDE.md): NEVER make code changes on an existing branch. Phase 1 implementation needs its own isolated worktree off `main`.

- [ ] **Step 1: Verify you're at the repo root**

```bash
cd D:/src/PRism
git status
```

Expected: working tree clean, branch `main`, no uncommitted changes.

- [ ] **Step 2: Fetch latest from origin and create the worktree**

```bash
git fetch origin --quiet
git worktree add ../PRism-validation-phase1 -b validation-suite-phase1-bootstrap origin/main
```

Expected: `Preparing worktree (new branch 'validation-suite-phase1-bootstrap')`, then `HEAD is now at <sha> <msg>` — the worktree is created at `D:\src\PRism-validation-phase1` on a new branch off `origin/main`.

- [ ] **Step 3: Verify worktree**

```bash
git worktree list
```

Expected output includes:
```
D:/src/PRism                            <sha> [main]
D:/src/PRism-manual-validation-spec     <sha> [manual-validation-test-plan-spec]
D:/src/PRism-validation-phase1          <sha> [validation-suite-phase1-bootstrap]
```

All subsequent tasks operate inside `D:\src\PRism-validation-phase1`. Use absolute paths in subsequent commands or `cd` into the worktree before running.

---

## Task 2: Scaffold e2e-validation directory + .gitignore

**Files:**
- Create: `D:\src\PRism-validation-phase1\e2e-validation\.gitignore`

- [ ] **Step 1: Create the directory**

PowerShell:
```powershell
New-Item -ItemType Directory -Force -Path D:/src/PRism-validation-phase1/e2e-validation/helpers | Out-Null
New-Item -ItemType Directory -Force -Path D:/src/PRism-validation-phase1/e2e-validation/specs | Out-Null
```

Bash (Git Bash / WSL):
```bash
mkdir -p D:/src/PRism-validation-phase1/e2e-validation/helpers
mkdir -p D:/src/PRism-validation-phase1/e2e-validation/specs
```

Expected: directories created without error. Verify with `ls D:/src/PRism-validation-phase1/e2e-validation/` (or `Get-ChildItem D:/src/PRism-validation-phase1/e2e-validation/`).

- [ ] **Step 2: Create .gitignore**

Write to `D:\src\PRism-validation-phase1\e2e-validation\.gitignore`:

```
# Node
node_modules/
npm-debug.log*

# Playwright outputs
test-results/
playwright-report/
playwright/.cache/

# Per-run artifacts (Phase 2+; not generated yet in Phase 1)
fixtures.json

# Editor / OS noise
.DS_Store
.vscode/
.idea/
*.swp
```

**Note:** `package-lock.json` is NOT gitignored. The validation suite commits its lockfile, matching the `frontend/` pattern and enabling `npm ci` for reproducible installs. This also defends against the documented Windows-CI optional-peer-drift failure mode (`@emnapi/*` entries dropped by Windows `npm install` causing Linux CI `npm ci` `EUSAGE` failures). If a future CI workflow runs the validation suite, the lockfile is the only thing that ensures consistent dep trees across platforms.

- [ ] **Step 3: Initial commit**

```bash
cd D:/src/PRism-validation-phase1
git add e2e-validation/.gitignore
git commit -m "chore(validation): scaffold e2e-validation/ directory"
```

Expected: `1 file changed, 14 insertions(+)`.

---

## Task 3: package.json + npm install + commit lockfile

**Files:**
- Create: `D:\src\PRism-validation-phase1\e2e-validation\package.json`
- Create: `D:\src\PRism-validation-phase1\e2e-validation\package-lock.json` (generated by `npm install`)

- [ ] **Step 1: Write package.json**

Write to `D:\src\PRism-validation-phase1\e2e-validation\package.json`:

```json
{
  "name": "prism-e2e-validation",
  "private": true,
  "version": "0.1.0",
  "description": "PRism black-box end-to-end validation suite. Owns its dependencies and tooling; no imports from elsewhere in the repo.",
  "type": "module",
  "scripts": {
    "test": "playwright test",
    "test:debug": "playwright test --debug",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@playwright/test": "1.59.1",
    "@types/node": "22.10.5",
    "typescript": "5.7.3"
  }
}
```

**Notes:**
- Versions are pinned exactly (no `^` or `~`). Black-box isolation extends to dependency drift — we want reproducible behavior.
- `@playwright/test 1.59.1` matches what `frontend/package.json` uses today. `typescript: 5.7.3` is the validation suite's independent pin — `frontend/` runs `typescript: ^6.0.3` but the black-box isolation contract allows independent versions. 5.7.3 is the most recent stable that avoids TS 6.x breaking changes around removed legacy `lib` defaults.
- `tsx` is NOT a Phase 1 dep — no Phase 1 script or spec invokes it. Phase 2 adds it when `scripts/setup-fixtures.ts` needs to run TS scripts directly.

- [ ] **Step 2: Install dependencies + generate lockfile**

PowerShell or bash:
```bash
cd D:/src/PRism-validation-phase1/e2e-validation
npm install
```

Expected: completes without errors. Creates `node_modules/` and `package-lock.json`.

- [ ] **Step 3: Verify Playwright binary is usable**

```bash
cd D:/src/PRism-validation-phase1/e2e-validation
npx playwright --version
```

Expected: `Version 1.59.1` (or matching the pinned version).

- [ ] **Step 4: Install Playwright browsers**

```bash
cd D:/src/PRism-validation-phase1/e2e-validation
npx playwright install chromium
```

Expected: Chromium downloads (~150 MB) and installs. May take 1-2 minutes on first run.

- [ ] **Step 5: Commit package.json + lockfile**

```bash
cd D:/src/PRism-validation-phase1
git add e2e-validation/package.json e2e-validation/package-lock.json
git commit -m "chore(validation): add package.json + lockfile with pinned Playwright + TypeScript deps"
```

Expected: `2 files changed, ~3000 insertions(+)` (lockfile dominates the diff).

---

## Task 4: tsconfig.json + README skeleton

**Files:**
- Create: `D:\src\PRism-validation-phase1\e2e-validation\tsconfig.json`
- Create: `D:\src\PRism-validation-phase1\e2e-validation\README.md`

- [ ] **Step 1: Write tsconfig.json**

Write to `D:\src\PRism-validation-phase1\e2e-validation\tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["helpers/**/*.ts", "specs/**/*.ts", "playwright.config.ts"],
  "exclude": ["node_modules", "test-results", "playwright-report"]
}
```

**Notes:**
- `module: NodeNext` matches `package.json`'s `"type": "module"` — Playwright uses native ESM resolution.
- `strict: true` + `noUnusedLocals/Parameters` enforce strict TS hygiene from day one. The suite is small enough that strictness is cheap.
- `types: ["node"]` scopes ambient types to Node's; we don't pull in DOM types globally (Playwright tests get DOM via Playwright's own typings inside `page.evaluate`).

- [ ] **Step 2: Write README.md skeleton**

Write to `D:\src\PRism-validation-phase1\e2e-validation\README.md`:

```markdown
# PRism Validation Suite

End-to-end black-box validation of PRism via its public HTTP surface + browser interaction.

**Spec:** `../docs/specs/2026-05-28-manual-validation-test-plan-design.md`

**Status:** Phase 1 — bootstrap + J-P0-01 first scenario.

## Quick start

```sh
cd e2e-validation
npm ci
npx playwright install chromium
```

Set Recipe B PAT (one-time per shell):

```sh
# bash / zsh
export PRISM_VALIDATION_PRIMARY_PAT=ghp_…

# PowerShell
$env:PRISM_VALIDATION_PRIMARY_PAT = "ghp_…"
```

Run the suite:

```sh
npx playwright test
```

The webServer block in `playwright.config.ts` launches PRism via `dotnet run` automatically. The build chain depends on `frontend/` having dependencies installed (`cd ../frontend && npm install` if you haven't already).

## What this suite is

Per the spec, this is the validation suite — a separate black-box e2e suite peer to the existing CI tests. It exercises PRism through the binary it ships, not via internal test scaffolds. See `../docs/specs/2026-05-28-manual-validation-test-plan-design.md` for the full design including the no-faking rule, sandbox repo policy, and scenario taxonomy.

## What's in Phase 1

- Bootstrap (`package.json`, `package-lock.json`, `tsconfig.json`, `playwright.config.ts`)
- Recipe-B PAT lookup helper (`helpers/recipes.ts`)
- J-P0-01 spec (`specs/j-p0-01-first-time-setup.spec.ts`)

Phases 2-5 add fixture types, more helpers (reset-fixture, inject-real-failure, gh-sandbox, reconciliation-fixtures), more scripts (setup-fixtures, sandbox-health, reset-sandbox), and the remaining 43 scenarios. See the spec's [Future stages](../docs/specs/2026-05-28-manual-validation-test-plan-design.md#future-stages) section.

## Recipes

### Recipe B — primary PAT

Generate a fine-grained GitHub PAT at https://github.com/settings/personal-access-tokens/new with the scopes listed in PRism's main README. **Select at least one repository under "Repository access"** — fine-grained PATs default to "Public repositories" which produces a no-repos-selected warning during the first-time setup flow.

Set as env var:

```sh
export PRISM_VALIDATION_PRIMARY_PAT=ghp_…       # bash/zsh
$env:PRISM_VALIDATION_PRIMARY_PAT = "ghp_…"     # PowerShell
```

The validation suite reads this env var via `helpers/recipes.ts`. If unset, J-P0-01 throws a clear error directing you here.

(Recipes A, C, D, E land in Phases 2-5 as the scenarios that need them ship.)
```

- [ ] **Step 3: Verify tsconfig is valid (no source files yet — should be trivially OK)**

```bash
cd D:/src/PRism-validation-phase1/e2e-validation
npx tsc --noEmit
```

Expected: command exits 0 with no output (no source files match `include` patterns yet).

- [ ] **Step 4: Commit**

```bash
cd D:/src/PRism-validation-phase1
git add e2e-validation/tsconfig.json e2e-validation/README.md
git commit -m "chore(validation): add tsconfig.json + README skeleton"
```

Expected: `2 files changed, ~60 insertions(+)`.

---

## Task 5: helpers/recipes.ts

**Files:**
- Create: `D:\src\PRism-validation-phase1\e2e-validation\helpers\recipes.ts`

**Rationale:** J-P0-01 needs the Recipe-B PAT. The helper reads `process.env.PRISM_VALIDATION_PRIMARY_PAT` with a clear error if unset. Phases 2-5 extend this file with Recipe C (secondary PAT), Recipe E (destructive PAT), and Recipe D wiring.

- [ ] **Step 1: Write recipes.ts**

Write to `D:\src\PRism-validation-phase1\e2e-validation\helpers\recipes.ts`:

```typescript
/**
 * Recipe-* helpers — environment-variable lookups for the PATs and other
 * scenario preconditions defined in the validation suite spec.
 *
 * Phase 1 only needs Recipe B (primary PAT) for J-P0-01.
 * Phase 2+ adds Recipe C (secondary PAT for identity-change scenarios) and
 * Recipe E (destructive PAT for J-P2-11) here.
 *
 * All recipes throw clear errors when their precondition isn't met — the
 * thrown message names the env var and points to README.md so the engineer
 * running the suite knows exactly what to fix.
 */

/**
 * Recipe B — primary GitHub PAT.
 *
 * Required env var: `PRISM_VALIDATION_PRIMARY_PAT`.
 *
 * Generate at https://github.com/settings/personal-access-tokens/new with
 * the scopes documented in PRism's main README. Select at least one
 * repository under "Repository access" — fine-grained PATs default to
 * "Public repositories" which surfaces a no-repos-selected warning in
 * PRism's setup flow.
 *
 * @throws if the env var is unset or empty.
 */
export function getPrimaryPat(): string {
  const pat = process.env.PRISM_VALIDATION_PRIMARY_PAT;
  if (!pat || pat.trim().length === 0) {
    throw new Error(
      'Recipe B PAT not configured. Set PRISM_VALIDATION_PRIMARY_PAT to a ' +
        'fine-grained GitHub PAT with the scopes listed in README.md, with ' +
        'at least one repository selected. See `e2e-validation/README.md` ' +
        '§ "Recipe B — primary PAT".',
    );
  }
  return pat;
}
```

- [ ] **Step 2: Verify compiles**

```bash
cd D:/src/PRism-validation-phase1/e2e-validation
npx tsc --noEmit
```

Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
cd D:/src/PRism-validation-phase1
git add e2e-validation/helpers/recipes.ts
git commit -m "feat(validation): add Recipe B (primary PAT) env-var lookup"
```

Expected: `1 file changed, ~30 insertions(+)`.

---

## Task 6: playwright.config.ts with webServer block

**Files:**
- Create: `D:\src\PRism-validation-phase1\e2e-validation\playwright.config.ts`

**Rationale:** Load-bearing file for the Test-env launch model. Mirrors `frontend/playwright.real.config.ts`'s structure but launches from `e2e-validation/` (one level deeper from repo root), so the shell-chain commands are adjusted.

- [ ] **Step 1: Write playwright.config.ts**

Write to `D:\src\PRism-validation-phase1\e2e-validation\playwright.config.ts`:

```typescript
import { defineConfig } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Per-run DataDir keeps the suite hermetic — no leakage from a developer's
// local %LOCALAPPDATA%/PRism state.json into the test backend, and no
// leakage from one validation pass into the next. PRism's binary reads
// the DataDir env var (set in webServer.env below) on startup.
const e2eDataDir = path.join(os.tmpdir(), `PRism-validation-${Date.now()}`);
fs.mkdirSync(e2eDataDir, { recursive: true });
// Surface the per-run DataDir so the on-disk log file (<DataDir>/logs/) is
// locatable after the run — Playwright prints no banner for it.
console.log(`[validation] DataDir=${e2eDataDir}`);

// The webServer launches PRism with the Test-env composition specified by
// the spec's "no faking rule" clause (4):
//   - ASPNETCORE_ENVIRONMENT=Test  → exposes /test/clear-pr-session and
//                                     /test/real-inject/* setup endpoints.
//   - PRISM_E2E_REAL_INJECT=1      → enables route-interception endpoints.
//   - PRISM_E2E_FAKE_REVIEW NOT SET → FakeReviewSubmitter is NOT registered;
//                                     real GitHubReviewService handles all
//                                     submit-pipeline work against real
//                                     GitHub.
//   - DataDir=<per-run temp>       → hermetic per validation pass.
//   - --no-browser                 → suppresses the production auto-open
//                                     of a browser; Playwright owns the
//                                     browser surface.
//
// Build chain: PRism.Web serves the SPA from PRism.Web/wwwroot, populated
// by `npm run build` in frontend/. A fresh checkout has no wwwroot — the
// command builds frontend first, then launches the backend. Adds ~30s to
// first run; subsequent runs reuse the built wwwroot.
//
// Working dir for the command is e2e-validation/, so paths to frontend/
// and PRism.Web are relative to it (../frontend, ../PRism.Web).
const backend = {
  command:
    'cd ../frontend && npm run build && cd ../ && dotnet run --project PRism.Web --no-launch-profile --urls http://localhost:5181 -- --no-browser',
  url: 'http://localhost:5181/api/health',
  reuseExistingServer: false,
  timeout: 180_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  env: {
    ASPNETCORE_ENVIRONMENT: 'Test',
    PRISM_E2E_REAL_INJECT: '1',
    // PRISM_E2E_FAKE_REVIEW deliberately NOT set — Program.cs rejects the
    // combo and the validation suite must use the real submitter.
    DataDir: e2eDataDir,
  },
};

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 0, // flake-loudly is intentional — real-flow against real GitHub
  webServer: [backend],
  use: {
    browserName: 'chromium' as const,
    baseURL: 'http://localhost:5181',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'validation' }],
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
});
```

- [ ] **Step 2: Verify compiles**

```bash
cd D:/src/PRism-validation-phase1/e2e-validation
npx tsc --noEmit
```

Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
cd D:/src/PRism-validation-phase1
git add e2e-validation/playwright.config.ts
git commit -m "feat(validation): add playwright.config.ts with Test-env webServer"
```

Expected: `1 file changed, ~50 insertions(+)`.

---

## Task 7: Sanity-check failing spec (proves the launcher boots)

**Files:**
- Create: `D:\src\PRism-validation-phase1\e2e-validation\specs\sanity-check.spec.ts` (will be deleted in Task 8)

**Rationale:** Before writing the real J-P0-01 spec (which depends on PRism's SPA + a valid PAT + real GitHub), prove that the Playwright + webServer + dotnet-run chain boots end-to-end. The sanity-check intentionally fails on an assertion so we can confirm:
1. Playwright starts.
2. `dotnet run` builds and starts PRism.
3. The webServer block detects `http://localhost:5181/api/health` returning 200.
4. The browser opens and `page.goto('/')` succeeds.
5. The test fails on the intentional assertion (proving test discovery + execution works).

If this spec fails for any reason OTHER than the intentional assertion, the launcher chain is broken and J-P0-01 will too.

- [ ] **Step 1: Write the sanity-check spec**

Write to `D:\src\PRism-validation-phase1\e2e-validation\specs\sanity-check.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test('sanity check — proves launcher boots; will be deleted in Task 8', async ({ page }) => {
  // If we get here, dotnet run started, PRism's /api/health returned 200,
  // Playwright launched chromium, and page.goto succeeded against the SPA.
  await page.goto('/');

  // Intentional assertion failure — confirms test discovery + execution
  // actually run an assertion (vs. silently passing on no-assertions).
  // Once this fails as expected, Task 8 replaces this spec with J-P0-01.
  expect(true, 'intentional fail — replace this spec with J-P0-01 next').toBe(false);
});
```

- [ ] **Step 2: Run the spec — expect the launcher to boot and the spec to fail on the intentional assertion**

```bash
cd D:/src/PRism-validation-phase1/e2e-validation
npx playwright test
```

Expected on success of the boot-sequence:
- Console shows `[validation] DataDir=...` (from playwright.config.ts).
- Console shows frontend build output (Vite tsc + build).
- Console shows `dotnet run` startup logs.
- Console shows `Now listening on: http://localhost:5181`.
- Playwright launches and runs the sanity-check spec.
- Test FAILS with: `Error: intentional fail — replace this spec with J-P0-01 next`.
- Exit code: 1 (because of the failing test).

Expected wall-clock: ~60-90 seconds for first run (frontend build + dotnet run cold start + chromium launch).

**If the spec fails BEFORE reaching the intentional assertion**, the launcher chain is broken. Common causes:
- `npm install` not run in `frontend/` — fix with `cd ../frontend && npm install`.
- `dotnet` not on PATH — install .NET 10 SDK.
- Port 5181 already in use — kill the conflicting process.
- Build error in PRism.Web — run `cd .. && dotnet build PRism.Web` from the worktree root to see the error.

Debug with `npx playwright test --debug` if needed.

- [ ] **Step 3: Commit (transient — the spec is deleted in Task 8)**

```bash
cd D:/src/PRism-validation-phase1
git add e2e-validation/specs/sanity-check.spec.ts
git commit -m "test(validation): add sanity-check spec proving launcher boots [transient]"
```

Expected: `1 file changed, ~10 insertions(+)`. The `[transient]` tag flags that the next commit deletes this file.

---

## Task 8: Replace with the real J-P0-01 spec

**Files:**
- Create: `D:\src\PRism-validation-phase1\e2e-validation\specs\j-p0-01-first-time-setup.spec.ts`
- Delete: `D:\src\PRism-validation-phase1\e2e-validation\specs\sanity-check.spec.ts`

**Rationale:** With the launcher proven, write the actual J-P0-01 scenario per the spec.

**Two correctness points worth flagging:**

1. **The post-Continue destination is `/`, NOT `/inbox`.** PRism's `SetupPage.tsx` calls `navigate('/')` on successful connect; `App.tsx` mounts `<InboxPage />` at path `/`. There is no `/inbox` route — the Header treats `/` and `/inbox` as equivalent only for "Inbox tab is active" highlighting, not as actual routes. Waiting for `/inbox` would time out forever.

2. **Fine-grained PATs commonly trigger `no-repos-selected` warning modal.** When `/api/auth/connect` returns `warning: 'no-repos-selected'`, `SetupPage` renders `<NoReposWarningModal>` instead of navigating. The spec must detect the modal and click its "Continue anyway" button (which POSTs to `/api/auth/connect/commit`). Recipe B's README updated in Task 4 directs the user to select at least one repo, but the spec is defensive and handles the modal if it appears.

Selectors are based on `frontend/src/components/Setup/SetupForm.tsx` (heading: "Connect to GitHub"; PAT input aria-label: "Personal access token"; Continue button text: "Continue") and `frontend/src/components/Setup/NoReposWarningModal.tsx` (verify the modal's "Continue anyway" button text — adjust the regex below if needed).

- [ ] **Step 1: Write the J-P0-01 spec**

Write to `D:\src\PRism-validation-phase1\e2e-validation\specs\j-p0-01-first-time-setup.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
import { getPrimaryPat } from '../helpers/recipes';

/**
 * J-P0-01. First-time setup → routes to inbox
 *
 * Pre-conditions:
 *   - Hermetic per-run DataDir (provided by playwright.config.ts webServer block).
 *   - PRISM_VALIDATION_PRIMARY_PAT env var set to a valid fine-grained PAT
 *     (Recipe B; see e2e-validation/README.md).
 *   - PRism launched in Test env (provided by webServer; no FakeReviewSubmitter).
 *
 * Steps walk the user journey: open the SPA → Setup screen renders →
 * paste PAT → click Continue → handle no-repos-selected modal if present
 * → wait for navigation to inbox (URL = '/').
 *
 * This is the wedge's first-impression scenario. If this breaks, no user
 * reaches anything.
 *
 * Spec reference: docs/specs/2026-05-28-manual-validation-test-plan-design.md
 * § Part 1 J-P0-01.
 */
test.describe('@P0 J-P0-01 First-time setup → routes to inbox', () => {
  test('cold-boot, paste PAT, lands on inbox', async ({ page }) => {
    const pat = getPrimaryPat();

    // 1. Open the SPA. The hermetic DataDir has no token, so the SPA's
    //    route guards redirect to /setup.
    await page.goto('/');

    // 2. Setup screen renders. Selectors match SetupForm.tsx (the SPA's
    //    Setup component — heading "Connect to GitHub", PAT input
    //    aria-label "Personal access token", Continue button).
    await expect(
      page.getByRole('heading', { name: /connect to github/i }),
    ).toBeVisible({ timeout: 30_000 });

    const patField = page.getByLabel(/personal access token/i);
    await expect(patField).toBeVisible();

    const continueButton = page.getByRole('button', { name: /continue/i });
    // Continue is disabled until a PAT is typed.
    await expect(continueButton).toBeDisabled();

    // 3. Paste primary PAT. fill() triggers the React state update so
    //    Continue enables.
    await patField.fill(pat);
    await expect(continueButton).toBeEnabled();

    // 4. Click Continue. PRism's backend validates the PAT against real
    //    GitHub via /api/auth/connect.
    await continueButton.click();

    // 5. Handle the no-repos-selected warning modal if PRism surfaces it.
    //    Fine-grained PATs without explicit repo selection trigger the
    //    `warning: 'no-repos-selected'` branch in SetupPage, which renders
    //    NoReposWarningModal instead of navigating. The modal's primary
    //    action commits the token via /api/auth/connect/commit and then
    //    navigates. If the PAT did have repos selected, this branch
    //    no-ops (the modal never appears) and we proceed to step 6.
    //
    //    Pattern: race the modal vs the navigation. Whichever resolves
    //    first wins.
    const modal = page.getByRole('dialog');
    const reposPath = await Promise.race([
      // Modal appears: click the primary action and proceed.
      modal.waitFor({ state: 'visible', timeout: 10_000 }).then(async () => {
        const continueAnyway = modal.getByRole('button', {
          name: /continue anyway|accept|commit/i,
        });
        await continueAnyway.click();
        return 'modal-resolved';
      }),
      // Modal never appears — happy path.
      page.waitForURL('/', { timeout: 10_000 }).then(() => 'direct-nav'),
    ]).catch(() => 'unknown');

    // After modal-resolve (if any), wait for the eventual navigation to /.
    // If we already navigated (direct-nav), this returns immediately.
    if (reposPath !== 'direct-nav') {
      await page.waitForURL('/', { timeout: 30_000 });
    }

    // 6. Inbox renders. The inbox is mounted at `/` per App.tsx. Assert
    //    on an inbox-specific element (the "Inbox" navigation tab being
    //    active, or the inbox sections heading area) to confirm we
    //    landed on the right surface — not just any page that happens
    //    to be at `/`.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('main')).toBeVisible();
    // The "Inbox" tab in the header should be the active tab.
    await expect(page.getByRole('link', { name: /^inbox$/i })).toBeVisible();
  });
});
```

- [ ] **Step 2: Delete the sanity-check spec**

PowerShell:
```powershell
Remove-Item D:/src/PRism-validation-phase1/e2e-validation/specs/sanity-check.spec.ts
```

Bash:
```bash
rm D:/src/PRism-validation-phase1/e2e-validation/specs/sanity-check.spec.ts
```

Expected: file removed without error.

- [ ] **Step 3: Run J-P0-01**

PowerShell:
```powershell
cd D:/src/PRism-validation-phase1/e2e-validation
$env:PRISM_VALIDATION_PRIMARY_PAT = "ghp_your_token_here"
npx playwright test
```

Bash:
```bash
cd D:/src/PRism-validation-phase1/e2e-validation
export PRISM_VALIDATION_PRIMARY_PAT=ghp_your_token_here
npx playwright test
```

Expected output:
```
[validation] DataDir=/tmp/PRism-validation-...
Running 1 test using 1 worker
  ✓  [validation] › j-p0-01-first-time-setup.spec.ts:N:N › @P0 J-P0-01 ... › cold-boot, paste PAT, lands on inbox (~15s)
  1 passed (~95s)
```

(Total includes frontend build + dotnet startup + chromium launch.)

**If J-P0-01 fails on selector lookups** (heading / PAT field / Continue button not found), the SPA's Setup component has changed since 2026-05-28. Steps to debug:
1. Run `npx playwright test --debug` to step through interactively.
2. Use the Playwright inspector to inspect the DOM and find the actual selectors.
3. Update the spec to match.

**If J-P0-01 fails on `/api/auth/connect` rejection** (Continue clicks but the page doesn't navigate), the PAT may be invalid or have insufficient scopes. Verify the PAT works by hitting `GET /user` directly:
```bash
curl -H "Authorization: token $PRISM_VALIDATION_PRIMARY_PAT" https://api.github.com/user
# PowerShell: curl -H "Authorization: token $env:PRISM_VALIDATION_PRIMARY_PAT" https://api.github.com/user
```

Expected: HTTP 200 with the user's login. If 401, regenerate the PAT.

**If J-P0-01 fails on the modal "Continue anyway" button** not being found by the `/continue anyway|accept|commit/i` regex, inspect `frontend/src/components/Setup/NoReposWarningModal.tsx` for the actual button text and update the regex.

- [ ] **Step 4: Commit**

```bash
cd D:/src/PRism-validation-phase1
git add e2e-validation/specs/
git commit -m "feat(validation): J-P0-01 first-time setup spec (replaces sanity-check)"
```

Expected: `2 files changed, ~70 insertions(+), 10 deletions(-)`.

---

## Task 9: Final clean-clone verification + README finalization + final commit

**Files:**
- Modify: `D:\src\PRism-validation-phase1\e2e-validation\README.md` (any final adjustments based on actually running the suite)

**Rationale:** Verify the acceptance criterion: from a fresh checkout, a Claude Code session can `cd e2e-validation && npm ci && npx playwright test` and J-P0-01 passes. This catches any missing-doc / missing-step gap.

- [ ] **Step 1: Simulate a fresh checkout (clear caches)**

PowerShell:
```powershell
cd D:/src/PRism-validation-phase1/e2e-validation
Remove-Item -Recurse -Force node_modules, test-results, playwright-report -ErrorAction SilentlyContinue
```

Bash:
```bash
cd D:/src/PRism-validation-phase1/e2e-validation
rm -rf node_modules test-results playwright-report
```

- [ ] **Step 2: Walk the README's Quick Start verbatim**

```bash
cd D:/src/PRism-validation-phase1/e2e-validation
npm ci
npx playwright install chromium
# PAT already set in shell from Task 8
npx playwright test
```

Expected: Same successful run as Task 8 step 3. Total time will be longer (~3-5 min) because of the fresh `npm ci` + (possibly) Chromium re-download.

**`npm ci` vs `npm install` choice:** `npm ci` requires the lockfile and installs strictly from it. This is what the README's Quick Start prescribes; verifying that flow works confirms the lockfile is complete + correct.

If any step fails because the README told the engineer to do something other than what actually works, fix the README.

- [ ] **Step 3: Final README adjustments (if any)**

Based on the walk-through, update `e2e-validation/README.md` if:
- Any command in the Quick Start needs adjustment.
- A step is missing.
- A prerequisite is unstated.

If the README walked cleanly, no changes are needed and this step is a no-op commit.

- [ ] **Step 4: Final commit + status**

```bash
cd D:/src/PRism-validation-phase1
git add e2e-validation/README.md
# If README has actual changes:
git commit -m "docs(validation): clarify Quick Start based on clean-clone walk"
# If no changes:
# (skip the commit; the README is already accurate from Task 4)

# Final verification: the branch's commit history
git log --oneline origin/main..HEAD
```

Expected: 7-8 commits on the branch:
```
<sha> docs(validation): clarify Quick Start based on clean-clone walk   (only if README needed updates)
<sha> feat(validation): J-P0-01 first-time setup spec (replaces sanity-check)
<sha> test(validation): add sanity-check spec proving launcher boots [transient]
<sha> feat(validation): add playwright.config.ts with Test-env webServer
<sha> feat(validation): add Recipe B (primary PAT) env-var lookup
<sha> chore(validation): add tsconfig.json + README skeleton
<sha> chore(validation): add package.json + lockfile with pinned Playwright + TypeScript deps
<sha> chore(validation): scaffold e2e-validation/ directory
```

- [ ] **Step 5: Verify final acceptance**

The acceptance criterion from the spec is met when:
1. ✅ `cd e2e-validation && npm ci` succeeds. (Verified Task 3 + Task 9 step 2.)
2. ✅ With `PRISM_VALIDATION_PRIMARY_PAT` set, `npx playwright test` runs J-P0-01 and reports PASS. (Verified Task 8 step 3.)
3. ✅ PRism's binary launches via the webServer block in Test env, serves the SPA, validates the PAT against real GitHub, routes to `/`. (Same verification.)

Phase 1 is complete. Phase 2 starts with this branch merged + its plan (also in this PR) as input.

---

## Phase 1 acceptance summary

When all 9 tasks are complete:

| Spec requirement (Phase 1 scope) | Implementing task |
|---|---|
| `e2e-validation/` directory at repo root | Task 2 |
| Own `package.json` with pinned deps | Task 3 |
| Own `package-lock.json` (committed) | Task 3 |
| Own `tsconfig.json` | Task 4 |
| Own `README.md` with run instructions | Task 4, Task 9 |
| `helpers/recipes.ts` (Recipe B lookup) | Task 5 |
| `playwright.config.ts` with Test-env webServer (no `PRISM_E2E_FAKE_REVIEW`) | Task 6 |
| J-P0-01 spec runs end-to-end against real GitHub + real PRism binary | Tasks 7, 8 |
| Clean-clone-walk verification | Task 9 |

**Items explicitly NOT in Phase 1** (deferred to Phases 2-5):

| Item | Reason |
|---|---|
| `helpers/fixture-types.ts` | No Phase 1 consumer; Phase 2 introduces it alongside its first consumer (`reset-fixture.ts` / `setup-fixtures.ts`) |
| `helpers/reset-fixture.ts`, `helpers/inject-real-failure.ts`, `helpers/gh-sandbox.ts`, `helpers/reconciliation-fixtures.ts` | Needed by Phase 2+ scenarios; not by J-P0-01 |
| `scripts/setup-fixtures.ts`, `scripts/sandbox-health.ts`, `scripts/reset-sandbox.ts` | Same |
| Sandbox repo `prpande/prism-validation-sandbox` creation (one-time gh command) | Phase 2 needs it for fixtures |
| `tsx` devDep | No Phase 1 script invokes it; Phase 2 adds when `scripts/setup-fixtures.ts` lands |
| Recipes A, C, D, E | Only Recipe B is needed for J-P0-01 |
| 43 other journey scenarios (J-P0-02..J-P3-07) | Phases 2-5 add by priority tier |
| Visual review pack (V-1..V-44) | Pilot-flagged; SP3 |
| Orchestrator (`npm run validate-experience`) | SP2 |
| Pass-ordering enforcement (J-P2-11 `@last-in-pass`) | SP2 |

These are intentionally deferred because:
- J-P0-01 is a pure UI flow that needs no GitHub sandbox state. Bootstrapping the sandbox repo + fixtures + helpers for one scenario is over-investment.
- Proving the launcher chain works with the smallest possible spec is the highest-value-per-unit-of-work in this phase.
- Phases 2-5 each add ~15-25 tasks but build on a proven foundation; if Phase 1 reveals the architecture is wrong (e.g., the launch model doesn't actually work in practice), Phases 2-5 don't get invested in until that's resolved.

---

## Notes for the Phase 1 implementer

- **Worktree:** All work happens in `D:\src\PRism-validation-phase1`. The spec lives in `D:\src\PRism-manual-validation-spec\docs\specs\2026-05-28-manual-validation-test-plan-design.md` (a different worktree); read it from that path or from `docs/specs/...` in the implementation worktree (the spec was committed on the parent PR that includes this plan; once merged it's on `main` for both worktrees).
- **Tooling expectations:** Node 22+, .NET 10 SDK, gh CLI (not needed for Phase 1 but useful for sanity-checking PATs).
- **PAT scope:** Recipe B PAT needs the scopes listed in PRism's main README — fine-grained PAT with `Pull requests: Read and write`, `Contents: Read`, `Checks: Read`, `Commit statuses: Read`. **And at least one repo selected under "Repository access"** — fine-grained PATs default to "Public repositories" which surfaces a `no-repos-selected` warning. The J-P0-01 spec handles the warning modal, but the README directs users to avoid it upfront.
- **What "PASS" means:** J-P0-01 passing means the launcher chain works AND PRism's Setup → inbox-at-`/` flow works against real GitHub. It does NOT mean the validation suite is "done"; it means Phase 1 is done.
- **If the SPA selectors have changed** since 2026-05-28 (the plan date), update `j-p0-01-first-time-setup.spec.ts` to match. The plan's `SetupForm.tsx` is the source of truth for the Setup screen's DOM; `NoReposWarningModal.tsx` is the source for the warning-modal button text.
- **Cross-platform:** The plan provides PowerShell and Bash variants for non-portable shell commands (`mkdir`, `rm`, env-var setting). Git/npm/dotnet/npx commands are identical on both shells.
