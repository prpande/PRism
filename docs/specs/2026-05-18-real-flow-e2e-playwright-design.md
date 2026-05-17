---
title: "Real-flow Playwright e2e suite — submit pipeline against live GitHub"
date: 2026-05-18
status: design
revisions:
  - 2026-05-18: brainstorm pass — design committed for human review
related:
  - 2026-05-11-s5-submit-pipeline-deferrals.md   # closes the [Defer] real-flow Playwright test entry
  - 2026-05-11-s5-submit-pipeline-design.md       # the S5 submit pipeline this exercises
  - docs/solutions/integration-issues/submit-review-silent-flash-mark-viewed-wireup-2026-05-15.md
---

# Real-flow Playwright e2e suite — submit pipeline against live GitHub

## 1. Origin and goal

PR #55 fixed a bug where the Submit flow silently flashed and reverted because `usePrDetail` never called `POST /api/pr/{ref}/mark-viewed`. The S5 e2e suite was green when the bug shipped because every spec calls a backend test helper (`/test/mark-pr-viewed`) that stamps the session directly, bypassing the FE wire-up that was missing. The post-mortem (`docs/solutions/integration-issues/submit-review-silent-flash-mark-viewed-wireup-2026-05-15.md`) calls this out as a structural coverage gap: *"when a test seeds session state via a `/test/*` route to bypass the production wire-up, the test surface and the production surface have diverged."*

The s5 deferrals doc records this as `[Defer] e2e Playwright test driving the real usePrDetail → mark-viewed → submit → Finalize chain.`

This design ships a **real-flow Playwright suite** that drives PRism against live GitHub (`prpande/prism-sandbox` private repo). The suite is an *additional* test layer — the 15 fake-mode specs remain the CI gate; the real-flow suite is a local-dev / pre-release gate that catches:

1. FE→BE wire-up regressions (the original mark-viewed bug class).
2. GraphQL contract drift in the submit pipeline.
3. HTML-comment marker durability through GitHub's GraphQL pipeline (live C7 empirical gate).
4. Real auth and transport failure modes the fake elides.

Scope is **four scenarios**: happy-path, foreign-pending-review (Resume path), lost-response-adoption, and stale-commit-oid. Coverage rationale and per-scenario details in §6.

## 2. Non-goals

- Replacing the 15 fake-mode specs. They continue to run as the CI merge gate. Real-flow is opt-in via a separate config (`playwright.real.config.ts`) and is **not** wired into the default `npx playwright test` command.
- Cross-tab stamp poisoning (separate deferral, requires session-shape change).
- On-disk log writer for PRism.Web.
- Toast.requestId polish + apiClient timeout.
- Migrating other S5 specs off `recordPrViewed` — only the four real-flow specs use the live backend.
- Real-flow coverage for `AttachReplyAsync`, `DeletePullRequestReviewThreadAsync`, REST file fetches at non-head OIDs. These remain fake-only; the four scenarios above don't require them.
- Provisioning per-teammate sandbox repos. All teammates run against the single shared `prpande/prism-sandbox` repo (see §7 for the multi-teammate model).

## 3. Approach in one paragraph

A separate Playwright config (`playwright.real.config.ts`) boots PRism.Web on port 5181 with `PRISM_E2E_REAL_INJECT=1` (and **no** `PRISM_E2E_FAKE_REVIEW`). A small `DelegatingHandler` in `PRism.GitHub` — registered only under that env var — intercepts the GraphQL HttpClient pipeline and consults a singleton failure injector keyed on operation name; this is the only seam in production code (~80 LOC, gated). The PAT is supplied by `gh auth token --hostname github.com` at `globalSetup`-time and injected into PRism's per-run `state.json`. Four long-lived "fixture" PRs per teammate (suffixed by their GitHub login) sit on `prpande/prism-sandbox`, idempotently created/repaired by a one-time setup script; each test's `beforeEach` runs a `resetSandboxFixture` helper that force-resets the fixture branch and deletes any leftover viewer-owned pending reviews. Specs drive the full chain (mark-viewed → submit → finalize) with no backend shortcuts.

## 4. Production-code surface

### 4.1 `TestFailureInjectionHandler` (PRism.GitHub)

`PRism.GitHub/TestHooks/TestFailureInjectionHandler.cs` — a `DelegatingHandler` that sits in the GraphQL `HttpClient` pipeline. On each `SendAsync`:

1. Read the request body (buffered `StringContent` — safe to re-read).
2. Sniff the operation name by scanning the GraphQL query text for the leading `mutation <Name>(…)` or `query <Name>(…)` token. Operation-name JSON field is **not** relied on because PRism's submit-side call sites don't always populate it.
3. Consult `RealTransportFailureInjector.TryConsume(operationName, afterEffectWanted: false, out var preEx)`. If matched, throw `preEx` **before** forwarding (simulates client-side fault — GitHub never sees the call).
4. `await base.SendAsync(request, ct)` to forward.
5. Consult `TryConsume(operationName, afterEffectWanted: true, out var postEx)`. If matched, throw `postEx` **after** the response is received (simulates the "lost response" window — GitHub committed; PRism never saw the result).
6. Otherwise return the response.

### 4.2 `RealTransportFailureInjector`

`PRism.GitHub/TestHooks/RealTransportFailureInjector.cs` — DI-singleton state container. API:

```csharp
void InjectFailure(string operationName, Exception ex, bool afterEffect);
bool TryConsume(string operationName, bool afterEffectWanted, out Exception ex);
void Reset();
```

One-shot semantics: each `InjectFailure` arms a single trigger; `TryConsume` consumes it iff the `afterEffectWanted` flag matches. Identical shape to the existing fake-side `FakeReviewSubmitter.InjectFailure`, so spec authoring is symmetric across the two test layers. Thread-safe via a single `lock`.

### 4.3 `RealInjectEndpoints` (PRism.Web)

`PRism.Web/TestHooks/RealInjectEndpoints.cs` — registered only when `PRISM_E2E_REAL_INJECT=1`. Single endpoint:

```http
POST /test/real-inject/inject-failure
Origin: http://localhost:5181
Content-Type: application/json

{ "operationName": "AddPullRequestReviewThread", "afterEffect": true, "message": "simulated post-effect" }
```

Resolves `RealTransportFailureInjector` from DI and calls `InjectFailure`. Subject to the same `OriginCheckMiddleware` and `Test`-env-only gate as other `/test/*` routes.

### 4.4 `TestEndpoints.cs` addition

A small new endpoint, gated on `Test` env only (no separate env gate):

```http
POST /test/clear-pr-session
Origin: http://localhost:5181

{ "owner": "prpande", "repo": "prism-sandbox", "number": 42 }
```

Nukes the PR's session in `state.json` (drafts, `PendingReviewId`, `LastViewedHeadSha`, `DraftSummary`, `DraftVerdict`) without touching auth state. Returns 204. ~20 LOC. Reusable beyond the real-flow suite if a future fake-mode spec wants per-PR session reset.

### 4.5 `Program.cs` changes

Three small conditional blocks:

```csharp
// (a) Mutex check — REAL_INJECT and FAKE_REVIEW are mutually exclusive.
if (Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1"
 && Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1")
{
    throw new InvalidOperationException(
      "PRISM_E2E_FAKE_REVIEW and PRISM_E2E_REAL_INJECT are mutually exclusive — " +
      "injection only makes sense against the real GitHub backend.");
}

// (b) Handler registration (only under REAL_INJECT).
if (Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1")
{
    builder.Services.AddSingleton<RealTransportFailureInjector>();
    builder.Services.AddTransient<TestFailureInjectionHandler>();
    builder.Services.AddHttpClient("github")   // exact name verified at impl time
        .AddHttpMessageHandler<TestFailureInjectionHandler>();
}

// (c) Endpoint map for /test/real-inject/* (only under REAL_INJECT).
//     Called from the existing /test/* mapping site, sibling to MapTestEndpoints.
```

Total production-code LOC introduced: ~80, all gated. No edits to `GitHubReviewService.*`.

### 4.6 What this cannot engage in production

The handler class exists in the `PRism.GitHub` assembly but nothing instantiates it unless `PRISM_E2E_REAL_INJECT=1` at process startup. The sole registration site is `Program.cs`. Production deployments don't set the env var. Same defense-in-depth as `PRISM_E2E_FAKE_REVIEW`.

## 5. Test-only surface (`frontend/e2e/real/`)

### 5.1 `helpers/gh-sandbox.ts`

Typed wrappers around `gh api` (via `execFileSync('gh', [...])` — argv-style, no shell interpolation):

| Helper | Implementation |
|---|---|
| `getPrHeadOid(prNumber)` | GraphQL `pullRequest(number).headRefOid` |
| `listOwnPendingReviews(prNumber)` | GraphQL `pullRequest.reviews(states: PENDING, first: 5)` filtered by `viewer.login` |
| `listSubmittedReviews(prNumber)` | GraphQL `pullRequest.reviews(first: 10)` |
| `createPendingReview(fixture, {threadBody})` | `addPullRequestReview` + `addPullRequestReviewThread` |
| `deletePendingReview(reviewId)` | `deletePullRequestReview` |
| `advanceHead(fixture, {fileChanges, commitMessage})` | `createCommitOnBranch` (no local clone needed; `expectedHeadOid` guards against races) |
| `forceResetBranch(fixture)` | REST `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` with `force:true` |
| `viewerLogin()` | GraphQL `viewer.login` (cached) |

Repo target is hardcoded to `prpande/prism-sandbox` (see §7 for the multi-teammate model). A one-line comment in the file explains why — no parameterization seam needed today (YAGNI).

### 5.2 `helpers/real-inject.ts`

```typescript
export async function injectRealFailure(
  request: APIRequestContext,
  opts: { operationName: string; afterEffect: boolean; message?: string }
): Promise<void>;
```

Wraps `POST /test/real-inject/inject-failure`. Symmetric to the fake-side `injectSubmitFailure` so spec authoring reads identically across the two layers.

### 5.3 `helpers/reset-sandbox-fixture.ts`

The per-test reset (called from each spec's `beforeEach`):

```typescript
export async function resetSandboxFixture(
  request: APIRequestContext,
  fixture: SandboxFixture
): Promise<void> {
  // 1. Delete any leftover viewer-owned pending reviews (recovers from crashed prior runs).
  for (const p of gh.listOwnPendingReviews(fixture.prNumber)) {
    gh.deletePendingReview(p.id);
  }
  // 2. Force-reset the branch to its known baseOid (clears stale-oid head advances).
  gh.forceResetBranch(fixture);
  // 3. Clear PRism's local PR session.
  const resp = await request.post('/test/clear-pr-session', {
    data: { owner: 'prpande', repo: 'prism-sandbox', number: fixture.prNumber },
    headers: { Origin: 'http://localhost:5181' },
  });
  if (!resp.ok()) throw new Error(`/test/clear-pr-session failed: ${resp.status()}`);
}
```

Runs in ~2-3s per call. The per-test cost vs the ~10s of per-test fresh-PR creation was the deciding factor for the long-lived fixture model (§7).

### 5.4 `fixtures.json` (gitignored, locally generated)

Each teammate's `frontend/e2e/real/fixtures.json` records their four PRs:

```json
[
  {
    "name": "happy-fixture",
    "branch": "e2e-real-happy-fixture-pratyush",
    "prNumber": 2,
    "prNodeId": "PR_kwDO…",
    "baseOid": "abc123…",
    "anchorFile": "src/Calc.cs",
    "anchorLine": 3
  },
  …
]
```

Gitignored because PR numbers and OIDs are per-developer repo state, not source. Generated/refreshed by `npm run setup-real-e2e-fixtures` (§7.2).

## 6. Spec-by-spec behavior

Four specs under `frontend/e2e/real/`. Each `beforeEach` runs `resetSandboxFixture`. Each uses a `createInlineDraftReal`-shaped helper retargeted to its fixture's anchor file/line. No spec calls any backend shortcut to stamp session state — the FE wire-up must drive it.

### 6.1 `s5-real-happy-path.spec.ts`

```
1. setupAndOpenScenarioPrReal(page, happyFixture)
2. await page.waitForResponse(r => r.url().endsWith('/mark-viewed') && r.status() === 204)
   ← regression net for the original PR#55 bug
3. createInlineDraftReal(page, happyFixture, "Real-flow body.")
4. Goto PR detail; click Submit Review
5. Fill summary; verdict=Comment; click Confirm Submit
6. Expect "Review submitted" heading
```

Assertions:

- `gh.listSubmittedReviews(prNumber)` contains a Comment review with our summary body.
- `gh.listOwnPendingReviews(prNumber)` is empty (finalized cleanly).
- SubmitDialog Finalize step has `data-state="done"`.

**Regression net for:** FE→BE `/mark-viewed` wire-up, `addPullRequestReview` + `addPullRequestReviewThread` + `submitPullRequestReview` GraphQL contract, FE submit-progress SSE handling.

### 6.2 `s5-real-foreign-pending-review.spec.ts` (Resume path)

```
beforeEach extension: gh.createPendingReview(foreignFixture, {threadBody: "Pre-seeded foreign thread."})
                      — pre-seeds a pending review the FE session has never stamped.

1. setupAndOpenScenarioPrReal(page, foreignFixture)
2. Wait for mark-viewed
3. createInlineDraftReal(...) with own body
4. Submit → expect ForeignPendingReviewModal to render
5. Assert modal shows 1 thread, "Pre-seeded foreign thread." body
6. Click "Resume"
7. Expect imported draft to appear in composer with the foreign body
8. Click Submit again; verdict=Comment; Confirm
9. Expect "Review submitted"
```

Assertions:

- `gh.listSubmittedReviews(prNumber)` shows a Comment review with two threads (imported + own).
- `gh.listOwnPendingReviews(prNumber)` empty.

**Regression net for:** `FindOwnPendingReviewAsync` GraphQL shape, TOCTOU re-fetch, draft-import flow, anchored-line enrichment from a real file blob. Discard is not separately tested at real-flow — `resetSandboxFixture`'s cleanup loop already exercises `deletePullRequestReview`.

### 6.3 `s5-real-lost-response-adoption.spec.ts` (seam headline)

```
1. setupAndOpenScenarioPrReal(page, lostResponseFixture)
2. Wait for mark-viewed
3. createInlineDraftReal(page, lostResponseFixture, "Body — first attempt should fail mid-stream.")
4. injectRealFailure({operationName: "AddPullRequestReviewThread", afterEffect: true})
   ← GitHub commits the thread; PRism throws on response
5. Submit → Confirm → expect dialog to reach Failed state with error message
6. Close dialog
7. Click Submit Review again → Confirm
   ← FindOwnPendingReviewAsync finds OWN pending review (session.PendingReviewId matches)
   ← Adoption matches the previously-attached thread by HTML-comment marker → skips re-attach
   ← Finalize lands
8. Expect "Review submitted"
```

Assertions:

- `gh.listSubmittedReviews` shows exactly ONE Comment review with EXACTLY ONE thread (no duplicate from re-attach — proves marker matched on real GitHub).
- Real-inject side reports exactly 1 total `AddPullRequestReviewThread` call across both submits.

**Regression net for:** the `DelegatingHandler` seam itself, `FindOwnPendingReviewAsync` adoption-vs-foreign branching, HTML-comment marker durability on live GitHub (this is the running C7 empirical gate).

### 6.4 `s5-real-stale-commit-oid.spec.ts`

```
1. setupAndOpenScenarioPrReal(page, staleOidFixture)
2. Wait for mark-viewed (stamps LastViewedHeadSha=baseOid)
3. createInlineDraftReal(...)
4. injectRealFailure({operationName: "AddPullRequestReviewThread", afterEffect: false})
   ← Begin lands; AttachThread fails pre-effect; session stamps PendingReviewId=X@baseOid
5. Submit → expect dialog Failed
6. gh.advanceHead(staleOidFixture, fileChanges, "advance head")
7. Await SSE 'pr-updated' event (10s timeout) — proves poller picked up new head
8. Reload banner appears; click Reload
   ← mark-viewed re-stamps LastViewedHeadSha=newOid
9. Submit Review → Confirm
   ← FindOwnPendingReviewAsync returns review at baseOid
   ← Pipeline: own review, but pending.CommitOid != newOid → stale-commit-oid path
   ← Pipeline deletes orphan, recreates pending at newOid, re-attaches thread, finalizes
10. Expect "Review submitted"
```

Assertions:

- `gh.listSubmittedReviews` shows ONE finalized Comment review.
- Submitted review's `commitOid` matches `newOid` (not `baseOid`).
- `gh.listOwnPendingReviews` empty.

**Regression net for:** real `addPullRequestReview` at a non-head OID, `deletePullRequestReview` orphan cleanup, `createCommitOnBranch` helper interop, full stale-recreation pipeline against real GraphQL.

**Known fragility:** step 7 introduces a real wall-clock dependency on the `ActivePrPoller` cadence. Mitigated by awaiting the `pr-updated` SSE event (the same event that triggers the Reload banner) with a 10s timeout, rather than polling state directly. If the SSE never arrives within 10s the test fails loudly — that's the intended behavior for `retries:0`.

### 6.5 Coverage matrix

| Surface | Happy | Foreign | LostResp | StaleOID |
|---|---|---|---|---|
| FE `/mark-viewed` | ✅ | ✅ | ✅ | ✅ |
| `addPullRequestReview` | ✅ | | ✅ | ✅ |
| `addPullRequestReviewThread` | ✅ | (helper) | ✅ | ✅ |
| `submitPullRequestReview` | ✅ | ✅ | ✅ | ✅ |
| `FindOwnPendingReviewAsync` | | ✅ | ✅ | ✅ |
| Marker durability | | | ✅ | |
| `deletePullRequestReview` | | (reset) | | ✅ |

## 7. Lifecycle, setup, and multi-teammate model

### 7.1 Multi-teammate isolation

The sandbox repo is shared. To prevent teammate-A's runs from breaking teammate-B's runs (force-reset on the same branch, head-advance races, etc.), every fixture name is suffixed with the teammate's GitHub login:

- `e2e-real-happy-fixture-pratyush`
- `e2e-real-happy-fixture-alice`
- (etc.)

Each developer has their own four PRs on `prpande/prism-sandbox`. `listOwnPendingReviews` already filters by `viewer.login`, so pending-review state is also teammate-isolated.

**Prereq the owner manages:** each new teammate must be added as a collaborator on `prpande/prism-sandbox` before they can push branches or create reviews:

```bash
gh api -X PUT repos/prpande/prism-sandbox/collaborators/<login> -F permission=push
```

This is documented in `docs/e2e/real-flow.md` as a prereq.

### 7.2 One-time setup script

`frontend/scripts/setup-real-e2e-fixtures.ts` (idempotent, per-teammate, file-locked):

```
1. Read viewer.login via gh GraphQL.
2. Acquire ~/.cache/prism/setup-real-e2e-fixtures.<login>.lock (prevents parallel runs from clobbering fixtures.json).
3. For each of [happy, foreign, lostresponse, staleoid]:
   - branch = `e2e-real-${name}-fixture-${login}`
   - If branch missing: create from master with one seed commit adding/modifying anchorFile
     to have ≥1 diff line vs master.
   - If branch exists: force-reset to its known baseOid (read from existing fixtures.json
     if present; otherwise capture the current branch tip as baseOid).
   - If PR missing: open it (title: `[e2e fixture, ${login}] ${name}`).
   - If PR exists: reuse (gh pr list --head ${branch} returns it).
   - Capture fixture metadata (prNumber, prNodeId, baseOid, anchorFile, anchorLine).
4. Write frontend/e2e/real/fixtures.json with all 4 fixtures.
5. Release lock.
```

Re-runnable any time. A developer can run it to repair drifted fixtures or refresh anchors if `master` advances.

### 7.3 Order of operations on a fresh clone

```
1. (One-time, per teammate) gh auth login --scopes repo
2. (One-time, per teammate) Owner adds them as collaborator on prpande/prism-sandbox
3. (One-time, per teammate) npm run setup-real-e2e-fixtures
4. (Every run)              npm run test:e2e:real
```

### 7.4 `playwright.real.config.ts`

```typescript
import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

dotenv.config({ path: '.env.local' });

const e2eDataDir = path.join(os.tmpdir(), `PRism-e2e-real-${Date.now()}`);
fs.mkdirSync(e2eDataDir, { recursive: true });

const backend = {
  command: 'cd .. && dotnet run --project PRism.Web --no-launch-profile --urls http://localhost:5181 -- --no-browser',
  url: 'http://localhost:5181/api/health',
  reuseExistingServer: false,
  timeout: 120_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  env: {
    ASPNETCORE_ENVIRONMENT: 'Test',
    PRISM_E2E_REAL_INJECT: '1',
    DataDir: e2eDataDir,
    PRISM_POLLER_CADENCE_SECONDS: '1',
  },
};

export default defineConfig({
  testDir: './e2e/real',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './e2e/real/global-setup.ts',
  webServer: [backend],
  use: { browserName: 'chromium', baseURL: 'http://localhost:5181', trace: 'on-first-retry' },
  projects: [{ name: 'real' }],
});
```

### 7.5 `frontend/e2e/real/global-setup.ts`

```
1. Read fixtures.json. If missing → throw with actionable message
   ("Run `npm run setup-real-e2e-fixtures` first; see docs/e2e/real-flow.md").
2. Validate gh auth: execFileSync('gh', ['api', '/user']).
   On non-2xx / not logged in → throw with `gh auth login --scopes repo` hint.
3. Capture PAT: execFileSync('gh', ['auth', 'token', '--hostname', 'github.com']).
4. Write PAT into PRism's per-run state.json at <DataDir>/state.json so specs
   skip /setup and land on / already authenticated.
   Fallback: if pre-injection isn't clean (state.json shape mismatch at impl time),
   each spec's beforeEach navigates through /setup programmatically — slower but
   workable.
5. Run `npm run build` + `dotnet build PRism.Web` (parity with the existing
   global-setup.ts — ensures wwwroot manifest matches built assets).
```

### 7.6 Why `retries: 0`

Real GitHub mutations don't undo. A flaky test that "passed on retry" might have left confusing state on the sandbox or masked a real bug that only surfaces on the first attempt of a fresh sequence. The fake config can safely retry because `/test/reset` nukes everything between runs. Real-flow can't — `resetSandboxFixture` runs at `beforeEach`, not before retry, so a retry would inherit half-mutated state. Disabling retries sidesteps this. Real-flow tests are local-dev tools, not a CI gate; a developer can re-run by hand and that's strictly more honest than silent auto-retry.

### 7.7 Crash recovery

If a run is killed mid-test:

- **GitHub-side state:** the next run's `beforeEach` runs `resetSandboxFixture`, which deletes lingering viewer-owned pending reviews and force-resets the branch to `baseOid`. Recovers cleanly.
- **PRism-side state:** per-run `DataDir` lives in `os.tmpdir()`, overwritten on next config load. `globalSetup` re-injects PAT into new DataDir. Recovers cleanly.
- **Dangling commits on the sandbox** (from `createCommitOnBranch` runs that were force-reset away): GitHub GCs unreferenced commits over time. Not our problem.

No `globalTeardown` is needed.

## 8. Regression-catch verification (Definition of Done item)

Each spec is paired with a one-line production-code edit that should make it fail. The developer performs this locally before opening the PR, restores, and attests in the PR description. The runbook lives in `docs/e2e/real-flow.md` under "Verifying the regression nets":

| Spec | Edit to introduce | Expected failure surface |
|---|---|---|
| `s5-real-happy-path` | Comment out the `postMarkViewed(...)` block in `frontend/src/hooks/usePrDetail.ts:66-79` | `waitForResponse(/mark-viewed/)` times out; subsequent submit returns 400 `head-sha-not-stamped` |
| `s5-real-foreign-pending-review` | Skip `FindOwnPendingReviewAsync` preflight in `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` | Pipeline reaches Begin with no foreign-detection; spec fails because `ForeignPendingReviewModal` never renders |
| `s5-real-lost-response-adoption` | Remove the marker prefix from `DraftThreadRequest.BodyMarkdown` thread-formatting | Adoption can't match on second submit → AttachThread fires twice → assertion "exactly 1 thread" fails (count = 2) |
| `s5-real-stale-commit-oid` | Replace the `StaleCommitOidRecreating` branch in `SubmitPipeline` with `throw` | Second submit Failed; spec times out waiting for "Review submitted" heading |

## 9. Trade-offs accepted

1. **Test-only seam in production code.** `TestFailureInjectionHandler` + `RealTransportFailureInjector` live in `PRism.GitHub` but engage only under `PRISM_E2E_REAL_INJECT=1`. ~80 LOC of gated code. Justified because there's no other way to drive lost-response-adoption against real GraphQL — the alternative (subclass + `protected virtual` seams in `GitHubReviewService.Submit.cs`) pollutes production code with a subclass-only surface and only intercepts at our boundary, missing the actual transport layer the real-flow suite exists to cover.
2. **Four long-lived PRs per teammate on the sandbox.** Sandbox is throwaway (description says so). Branch names are obviously dedicated. Easy to GC manually if a teammate leaves.
3. **PAT identity = real reviewer.** Comments and reviews land under whoever's `gh` is authenticated. Acceptable on a dedicated sandbox.
4. **Real-flow not in CI.** Local-dev / pre-release gate only. The 15 fake-mode specs continue to be the CI merge gate.
5. **`retries: 0`** for real-flow — flakiness fails loudly rather than masking. Defended in §7.6.
6. **Hardcoded `prpande/prism-sandbox` in helpers.** Single shared repo per the brief. Parameterizing for per-teammate sandboxes is YAGNI; if it ever matters, the seam is a one-line config object.

## 10. Risks

- **GitHub API contract changes.** Most are additive; mutation-shape breaks are rare. Real-flow specs would be our canary — failing immediately on contract drift, which is one of the values of this suite.
- **HTML-comment marker stripping.** If GitHub ever strips them, `s5-real-lost-response-adoption` fails as the live C7 empirical gate. That's a feature, not a bug.
- **Stale-OID spec poller-cadence sensitivity.** Mitigated by SSE `pr-updated` await rather than time-based polling. If the poller hangs, the spec hangs — treat as flake-on-fail, not "design is broken."
- **Rate-limit budget.** 4 specs × ~5 GraphQL mutations × ~50 runs/day ≈ 1000 points, vs the 5000/hour budget per PAT. Plenty of headroom.
- **PRism state.json shape drift.** If `globalSetup`'s pre-injection breaks because `AppState` JSON shape evolves, the fallback (programmatic `/setup` navigation in each spec's `beforeEach`) keeps the suite running with ~3s extra per spec. Worth tracking but not blocking.

## 11. Definition of Done

- All 4 real-flow specs pass on first attempt against a freshly-set-up sandbox: `npm run test:e2e:real`.
- Each spec's mechanical regression-catch verified locally (one-line edits from §8); attestation in the PR description.
- Default `npx playwright test` (fake mode) still passes — unchanged.
- Pre-push checklist runs clean per `.ai/docs/development-process.md` (`npm run lint`, `npm run build`, full e2e, etc.).
- `docs/e2e/real-flow.md` operator doc lands in the same PR.
- `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md`: revisions-log entry added, original `[Defer] e2e Playwright test driving the real usePrDetail → mark-viewed → submit → Finalize chain.` entry updated with `**Status update:** Resolved` line pointing at this spec doc + the 4 new spec files.

## 12. Files created and changed

| Path | Change |
|---|---|
| `PRism.GitHub/TestHooks/TestFailureInjectionHandler.cs` | NEW |
| `PRism.GitHub/TestHooks/RealTransportFailureInjector.cs` | NEW |
| `PRism.Web/TestHooks/RealInjectEndpoints.cs` | NEW |
| `PRism.Web/TestHooks/TestEndpoints.cs` | + `/test/clear-pr-session` endpoint |
| `PRism.Web/Program.cs` | + 3 conditional blocks (mutex, handler reg, endpoint map) |
| `frontend/playwright.real.config.ts` | NEW |
| `frontend/scripts/setup-real-e2e-fixtures.ts` | NEW |
| `frontend/e2e/real/global-setup.ts` | NEW |
| `frontend/e2e/real/helpers/gh-sandbox.ts` | NEW |
| `frontend/e2e/real/helpers/real-inject.ts` | NEW |
| `frontend/e2e/real/helpers/reset-sandbox-fixture.ts` | NEW |
| `frontend/e2e/real/s5-real-happy-path.spec.ts` | NEW |
| `frontend/e2e/real/s5-real-foreign-pending-review.spec.ts` | NEW |
| `frontend/e2e/real/s5-real-lost-response-adoption.spec.ts` | NEW |
| `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts` | NEW |
| `frontend/package.json` | + `setup-real-e2e-fixtures`, `test:e2e:real` scripts |
| `frontend/.gitignore` | + `e2e/real/fixtures.json`, `.env.local` |
| `docs/e2e/real-flow.md` | NEW (operator runbook) |
| `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md` | + revisions-log entry, deferral status update |
