---
title: "Real-flow Playwright e2e suite — submit pipeline against live GitHub"
date: 2026-05-18
status: design
revisions:
  - 2026-05-18: brainstorm pass + ce-doc-review — design committed for human review
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
2. **Live-GitHub acceptance** of the four submit-pipeline mutations the four scenarios exercise (`addPullRequestReview`, `addPullRequestReviewThread`, `submitPullRequestReview`, `deletePullRequestReview`). The existing `PRism.GitHub.Tests` already pin the request shape PRism *emits*; they do not assert that GitHub *accepts* it. Real-flow closes that narrow but real gap.
3. HTML-comment marker durability through GitHub's GraphQL pipeline (live C7 empirical gate, exercised by scenario 3).
4. Real auth and transport failure modes the fake elides — specifically the mid-flight "lost response" window (scenario 3) and head-OID drift mid-pipeline (scenario 4).

Scope is **four scenarios**: happy-path, foreign-pending-review (Resume path), lost-response-adoption, and stale-commit-oid. Coverage rationale and per-scenario details in §6.

### 1.1 Alternative considered, not chosen: curtail `/test/mark-pr-viewed` in the existing fake specs

The post-mortem proposes two equally valid remedies for "test bypasses production wire-up": delete the seed, or add a parallel real-flow test. The cheapest remedy for closing the *original deferral alone* is to delete the `recordPrViewed` call from `frontend/e2e/s5-submit-happy-path.spec.ts` (and possibly the other three fake specs) so the existing CI suite drives the FE wire-up. That would catch the exact PR#55 bug class in CI with no production-code surface and no new sandbox infrastructure.

Real-flow was chosen anyway because goals 2-4 above are **not** reachable by removing the seed — they require live GitHub. Closing the deferral is a *side-effect* of scenario 1 in the real-flow suite, not the sole motivation. A separate (smaller) follow-up to delete `recordPrViewed` from the matching fake specs would close the loop on goal 1 inside CI too; that's tracked as out-of-scope in §2 ("Migrating other S5 specs off `recordPrViewed`") and remains a candidate for a separate PR.

## 2. Non-goals

- Replacing the 15 fake-mode specs. They continue to run as the CI merge gate. Real-flow is opt-in via a separate config (`playwright.real.config.ts`) and is **not** wired into the default `npx playwright test` command.
- Cross-tab stamp poisoning (separate deferral, requires session-shape change).
- On-disk log writer for PRism.Web.
- Toast.requestId polish + apiClient timeout.
- Migrating other S5 specs off `recordPrViewed` — only the four real-flow specs use the live backend. (Separate PR candidate per §1.1.)
- Real-flow coverage for `AttachReplyAsync`, `DeletePullRequestReviewThreadAsync`, REST file fetches at non-head OIDs. These remain fake-only; the four scenarios above don't require them.
- Provisioning per-teammate sandbox repos. All teammates run against the single shared `prpande/prism-sandbox` repo (see §7 for the multi-teammate model).
- Mutation testing / programmatic regression-catch automation. Regression-catch verification (§8) is a one-time per-PR developer attestation, not automated.

## 3. Approach in one paragraph

A separate Playwright config (`playwright.real.config.ts`) boots PRism.Web on port 5181 with `PRISM_E2E_REAL_INJECT=1` (and **no** `PRISM_E2E_FAKE_REVIEW`). A small `DelegatingHandler` registered in `PRism.Web/TestHooks/` — engaged only when **both** `ASPNETCORE_ENVIRONMENT=Test` AND `PRISM_E2E_REAL_INJECT=1` are set — intercepts the GraphQL HttpClient pipeline and consults a singleton failure injector keyed on the **top-level GraphQL selection-set field name** (e.g., `addPullRequestReviewThread`). The PAT comes from `gh auth token --hostname github.com` at `globalSetup`-time and is supplied to PRism through the **programmatic `/setup` flow** (writing to the OS-keychain-backed `TokenStore` via the existing `/api/auth/connect` path), preserving the architectural invariant that PATs never land in `state.json` (`docs/spec/02-architecture.md:711`). Four long-lived "fixture" PRs per teammate (suffixed by their GitHub login) sit on `prpande/prism-sandbox`, idempotently created/repaired by a one-time setup script; each test's `beforeEach` runs a `resetSandboxFixture` helper that force-resets the fixture branch, deletes any leftover viewer-owned pending reviews, and captures a `sinceTs` for review-scoped assertions. Specs drive the full chain (mark-viewed → submit → finalize) with no backend shortcuts.

## 4. Production-code surface

### 4.1 `TestFailureInjectionHandler` (PRism.Web)

`PRism.Web/TestHooks/TestFailureInjectionHandler.cs` — a `DelegatingHandler` that sits in the GraphQL `HttpClient` pipeline (the `"github"` named client registered in `PRism.GitHub/ServiceCollectionExtensions.cs:31`). On each `SendAsync`:

1. Read the request body (buffered `StringContent` — safe to re-read).
2. **Sniff the top-level selection-set field name** by scanning the GraphQL query text. Concrete regex contract (pin in implementation): `\{\s*([A-Za-z_][A-Za-z0-9_]*)` capturing group 1, anchored after the outer brace following the anonymous `mutation($vars)` header. For PRism's mutations (current state — see §10 sniff-brittleness risk), this yields the field name (e.g., `addPullRequestReviewThread`). **Match using exact string equality, never substring/prefix**, because `addPullRequestReviewThread` is a strict prefix of `addPullRequestReviewThreadReply` (the AttachReply mutation at `GitHubReviewService.Submit.cs:118-128`). A naive `body.Contains(fieldName)` impl would silently mis-route. Identifier-boundary parsing is load-bearing; the handler carries an inline comment naming this. **Scope of the sniff:** works for the four mutations the four scenarios inject into. Read queries (e.g., `FindOwnPendingReviewAsync`) wrap their actual data field inside `repository { pullRequest { reviews { ... } } }`, so the regex would yield `repository` — not useful as an injection key. If a future scenario needs to inject into a query, the handler grows a per-query-name lookup; out of scope today.
3. Consult `RealTransportFailureInjector.TryConsume(fieldName, afterEffectWanted: false, out var preEx)`. If matched, throw `preEx` **before** forwarding (simulates client-side fault — GitHub never sees the call).
4. `await base.SendAsync(request, ct)` to forward.
5. Consult `TryConsume(fieldName, afterEffectWanted: true, out var postEx)`. If matched, throw `postEx` **after** the response is received (simulates the "lost response" window — GitHub committed; PRism never saw the result).
6. Otherwise return the response.

**Why the placement moved from `PRism.GitHub` to `PRism.Web`:** ce-doc-review surfaced that adding a `TestHooks/` namespace to the production GraphQL adapter (`PRism.GitHub.dll`) sets a precedent for test infra accreting into production libraries. `PRism.Web/TestHooks/` already houses the fake-side seam and the `/test/*` endpoint surface; the handler logically sits there too. It's registered into the same DI chain that decorates the named `"github"` HttpClient — the handler doesn't need to live in the same project as the client config.

### 4.2 `RealTransportFailureInjector`

`PRism.Web/TestHooks/RealTransportFailureInjector.cs` — DI-singleton state container. API:

```csharp
void InjectFailure(string graphQLFieldName, Exception ex, bool afterEffect);
bool TryConsume(string graphQLFieldName, bool afterEffectWanted, out Exception ex);
void Reset();
```

One-shot semantics: each `InjectFailure` arms a single trigger; `TryConsume` consumes it iff the `afterEffectWanted` flag matches. The key is the GraphQL field name (per §4.1 step 2), **not** a C# method name (the fake-side `FakeReviewSubmitter` keys on C# names — the two layers' key spaces are intentionally different because they sit at different levels of the stack). Thread-safe via a single `lock`.

### 4.3 `RealInjectEndpoints` (PRism.Web)

`PRism.Web/TestHooks/RealInjectEndpoints.cs` — gated **by the extension method itself** (matching the existing `TestEndpoints.cs` pattern: extension method early-returns if env preconditions are missing; `Program.cs` calls unconditionally). The extension method engages only when **both** `ASPNETCORE_ENVIRONMENT=Test` AND `PRISM_E2E_REAL_INJECT=1` are set. Single endpoint:

```http
POST /test/real-inject/inject-failure
Origin: http://localhost:5181
Content-Type: application/json

{ "graphQLFieldName": "addPullRequestReviewThread", "afterEffect": true, "message": "simulated post-effect" }
```

Resolves `RealTransportFailureInjector` from DI and calls `InjectFailure`. Subject to `OriginCheckMiddleware` (loopback-only) like every other `/test/*` route.

### 4.4 `TestEndpoints.cs` addition: `POST /test/clear-pr-session`

```http
POST /test/clear-pr-session
Origin: http://localhost:5181

{ "owner": "prpande", "repo": "prism-sandbox", "number": 42 }
```

Gated on `Test` env only (no new env gate). The handler does **two** things; they touch different concurrency surfaces so they aren't actually one `UpdateAsync` (an earlier draft of this spec claimed they were — that was wrong):

1. Nukes the PR's session in `state.json` (drafts, `PendingReviewId`, `LastViewedHeadSha`, `DraftSummary`, `DraftVerdict`) via `IAppStateStore.UpdateAsync` — without touching auth state.
2. **Removes every subscriber for this PR from `ActivePrSubscriberRegistry`** by calling `Remove(subscriberId, prRef)` for each id returned by the registry's `SubscribersFor(prRef)` query. (`IActivePrCache` itself doesn't expose unsubscribe; subscription state lives in the sibling `ActivePrSubscriberRegistry` — verified against `PRism.Core/PrDetail/ActivePrSubscriberRegistry.cs`. If `SubscribersFor` isn't a public method on the registry today, the implementation adds it — single ConcurrentDictionary lookup; ~5 LOC.)

The race closure isn't "one UpdateAsync" — it's the poller's own snapshot pattern: `ActivePrPoller` reads `UniquePrRefs()` at tick-start, so any subscriber removed between ticks is observed on the next tick. The cost of NOT closing this race would be a poller-emitted `pr-updated` SSE event landing on a spec that's already trying to assert a clean state — annoying but not corrupting. The race-closure motivation is determinism of `resetSandboxFixture`'s wall-clock, not data correctness.

Returns 204. ~40 LOC across handler + registry helper. Reusable beyond the real-flow suite if a future fake-mode spec wants per-PR session reset.

### 4.5 `Program.cs` changes

Three small conditional blocks. **Ordering matters:** the REAL_INJECT handler-registration block (b) must run **after** the existing `AddPrismGitHub()` call so the named `"github"` HttpClient already exists when the handler-chain extension is applied. This is documented inline as a comment so a future refactor doesn't reorder.

```csharp
// (a) Mutex check — REAL_INJECT and FAKE_REVIEW are mutually exclusive.
if (Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1"
 && Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1")
{
    throw new InvalidOperationException(
      "PRISM_E2E_FAKE_REVIEW and PRISM_E2E_REAL_INJECT are mutually exclusive — " +
      "injection only makes sense against the real GitHub backend.");
}

// (b) Handler registration. Co-gated on Test env + REAL_INJECT.
//     MUST run after AddPrismGitHub() so the named "github" client is already configured.
if (builder.Environment.IsEnvironment("Test")
 && Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1")
{
    builder.Services.AddSingleton<RealTransportFailureInjector>();
    builder.Services.AddTransient<TestFailureInjectionHandler>();
    builder.Services.AddHttpClient("github")          // additive — preserves BaseAddress set by AddPrismGitHub
        .AddHttpMessageHandler<TestFailureInjectionHandler>();
}

// (c) Endpoint map. Extension method self-guards on (Test env + REAL_INJECT); called unconditionally.
app.MapRealInjectEndpoints();
```

**One non-obvious Program.cs edit:** the existing `UseStaticWebAssets()` block is currently gated on `PRISM_E2E_FAKE_REVIEW=1`. Real-flow mode doesn't set that env var, so without an update the SPA bundle would serve as 0-byte assets and the browser would never bootstrap. The gate needs to widen to `IsEnvironment("Test") && (PRISM_E2E_FAKE_REVIEW=1 || PRISM_E2E_REAL_INJECT=1)`. One-line change; called out in §12.

Total production-code LOC introduced: ~90, all gated. No edits to `GitHubReviewService.*`.

### 4.6 What this cannot engage in production

Two independent gates must both be true: (1) `ASPNETCORE_ENVIRONMENT=Test`, (2) `PRISM_E2E_REAL_INJECT=1`. Production deployments set neither. A developer who exports `PRISM_E2E_REAL_INJECT=1` in their shell profile to avoid retyping it for the test suite cannot accidentally engage the handler against a real production build, because production builds set `ASPNETCORE_ENVIRONMENT=Production`. The `/test/real-inject/*` endpoint and the `DelegatingHandler` are both behind the AND-gate. This is materially stronger than the existing `PRISM_E2E_FAKE_REVIEW` single-gate pattern; the upgrade is deliberate because REAL_INJECT controls behaviour against the live GitHub API, where the blast radius of accidental engagement is non-trivial.

## 5. Test-only surface (`frontend/e2e/real/`)

### 5.1 `helpers/gh-sandbox.ts`

Typed wrappers around `gh api` (via `execFileSync('gh', [...])` — argv-style, no shell interpolation):

| Helper | Implementation |
|---|---|
| `getPrHeadOid(prNumber)` | GraphQL `pullRequest(number).headRefOid` |
| `listOwnPendingReviews(prNumber)` | GraphQL `pullRequest.reviews(states: PENDING, first: 5)` filtered by `viewer.login` |
| `listSubmittedReviewsSince(prNumber, sinceTs)` | GraphQL `pullRequest.reviews(first: 10)` filtered by `viewer.login` AND `submittedAt >= sinceTs` (the timestamp captured in `beforeEach` — prevents prior runs' reviews on the same fixture PR from polluting assertions) |
| `createPendingReview(fixture, {threadBody})` | `addPullRequestReview` + `addPullRequestReviewThread` |
| `deletePendingReview(reviewId)` | `deletePullRequestReview` |
| `advanceHead(fixture, {fileChanges, commitMessage})` | `createCommitOnBranch` with `expectedHeadOid` for race protection |
| `forceResetBranch(fixture)` | REST `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` with `force:true` |
| `viewerLogin()` | GraphQL `viewer.login` (cached) |

Repo target is hardcoded to `prpande/prism-sandbox` (see §7 for the multi-teammate model). A one-line comment in the file explains why — no parameterization seam needed today (YAGNI).

### 5.2 `helpers/real-inject.ts`

```typescript
export async function injectRealFailure(
  request: APIRequestContext,
  opts: { graphQLFieldName: string; afterEffect: boolean; message?: string }
): Promise<void>;
```

Wraps `POST /test/real-inject/inject-failure`. Note the key is `graphQLFieldName` (per §4.1), not `operationName` — the lower-cased GraphQL selection field (`addPullRequestReviewThread`, `submitPullRequestReview`, etc.).

### 5.3 `helpers/reset-sandbox-fixture.ts`

The per-test reset (called from each spec's `beforeEach`):

```typescript
export interface ResetResult { sinceTs: string; }   // ISO-8601, captured AT END of reset

export async function resetSandboxFixture(
  request: APIRequestContext,
  fixture: SandboxFixture
): Promise<ResetResult> {
  // 1. Delete any leftover viewer-owned pending reviews (recovers from crashed prior runs).
  for (const p of gh.listOwnPendingReviews(fixture.prNumber)) {
    gh.deletePendingReview(p.id);
  }
  // 2. Force-reset the branch to its known baseOid (clears stale-oid head advances).
  gh.forceResetBranch(fixture);
  // 3. Clear PRism's local PR session AND unsubscribe (single UpdateAsync; closes poller race).
  const resp = await request.post('/test/clear-pr-session', {
    data: { owner: 'prpande', repo: 'prism-sandbox', number: fixture.prNumber },
    headers: { Origin: 'http://localhost:5181' },
  });
  if (!resp.ok()) throw new Error(`/test/clear-pr-session failed: ${resp.status()}`);
  // 4. Capture sinceTs AFTER the reset so submitted-review assertions can scope to this test only.
  //    (GitHub doesn't delete submitted review threads when their commit OID becomes unreachable —
  //    50 prior happy-path runs leave 50 reviews on the fixture PR. Scoping by timestamp avoids
  //    needing a "delete all viewer-submitted reviews" sweep we don't otherwise need.)
  //
  //    sinceTs is read from GitHub's server clock — NOT `new Date().toISOString()` —
  //    so test-runner clock skew (NTP outage, suspend/resume, dual-boot) can't flip
  //    the comparison. Cheapest source: `Date` HTTP response header on any gh-api call
  //    we'd make anyway, OR a quick `gh api graphql` returning `{ rateLimit { resetAt } }`
  //    and a known anchor. Concrete impl: capture the Date header from the final
  //    `forceResetBranch` REST response and parse it as ISO-8601.
  return { sinceTs: serverClockFromResponseHeader };
}
```

Runs in ~2-3s. The captured `sinceTs` is passed into `listSubmittedReviewsSince` assertions in §6.

### 5.4 `fixtures.json` (gitignored, locally generated)

Each teammate's `frontend/e2e/real/fixtures.json` records their four PRs:

```json
[
  {
    "name": "happy",
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

Four specs under `frontend/e2e/real/`. Each `beforeEach` runs `const { sinceTs } = await resetSandboxFixture(request, fixture)` and stashes `sinceTs` for assertion-scoping. Each uses a `createInlineDraftReal`-shaped helper retargeted to its fixture's anchor file/line. **No spec calls any backend shortcut to stamp session state** — the FE wire-up must drive it.

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

- `gh.listSubmittedReviewsSince(prNumber, sinceTs)` contains **exactly one** Comment review with our summary body.
- `gh.listOwnPendingReviews(prNumber)` is empty (finalized cleanly).
- SubmitDialog Finalize step has `data-state="done"`.

**Regression net for:** FE→BE `/mark-viewed` wire-up, live-GitHub acceptance of `addPullRequestReview` + `addPullRequestReviewThread` + `submitPullRequestReview`, FE submit-progress SSE handling.

### 6.2 `s5-real-foreign-pending-review.spec.ts` (Resume path)

```
beforeEach extension: gh.createPendingReview(foreignFixture, {threadBody: "Pre-seeded foreign thread."})
                      — pre-seeds a pending review the FE session has never stamped.
                      (Runs AFTER resetSandboxFixture so it's not deleted by the reset.
                       Spec asserts gh.listOwnPendingReviews(prNumber).length === 1
                       immediately after the seed call — load-bearing ordering invariant;
                       a future refactor that moves the seed earlier should trip this
                       assertion rather than fail silently as if FindOwnPendingReview
                       had a real bug.)

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

- `gh.listSubmittedReviewsSince(prNumber, sinceTs)` shows **exactly one** Comment review with two threads (imported + own).
- `gh.listOwnPendingReviews(prNumber)` empty.

**Regression net for:** `FindOwnPendingReviewAsync` GraphQL shape against live GitHub, TOCTOU re-fetch, draft-import flow, anchored-line enrichment from a real file blob. Discard is not separately tested at real-flow — `resetSandboxFixture`'s cleanup loop already exercises `deletePullRequestReview`.

### 6.3 `s5-real-lost-response-adoption.spec.ts` (seam headline)

```
1. setupAndOpenScenarioPrReal(page, lostResponseFixture)
2. Wait for mark-viewed
3. createInlineDraftReal(page, lostResponseFixture, "Body — first attempt should fail mid-stream.")
4. injectRealFailure({graphQLFieldName: "addPullRequestReviewThread", afterEffect: true})
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

- `gh.listSubmittedReviewsSince(prNumber, sinceTs)` shows exactly ONE Comment review with EXACTLY ONE thread (no duplicate from re-attach — proves marker matched on real GitHub).
- After the run, `gh.listOwnPendingReviews(prNumber)` empty.

**Regression net for:** the `DelegatingHandler` seam itself, `FindOwnPendingReviewAsync` adoption-vs-foreign branching, HTML-comment marker durability on live GitHub (this is the running C7 empirical gate).

### 6.4 `s5-real-stale-commit-oid.spec.ts`

```
1. setupAndOpenScenarioPrReal(page, staleOidFixture)
2. Wait for mark-viewed (stamps LastViewedHeadSha=baseOid)
3. createInlineDraftReal(...)
4. injectRealFailure({graphQLFieldName: "addPullRequestReviewThread", afterEffect: false})
   ← Begin lands; AttachThread fails pre-effect; session stamps PendingReviewId=X@baseOid
5. Submit → expect dialog Failed
6. gh.advanceHead(staleOidFixture, fileChanges, "advance head")
7. Await SSE 'pr-updated' event with up to 30s timeout (GitHub read-replica propagation +
   poller cadence — see §10 for the budget rationale)
8. Reload banner appears; click Reload
   ← mark-viewed re-stamps LastViewedHeadSha=newOid
9. Submit Review → Confirm
   ← FindOwnPendingReviewAsync returns review at baseOid
   ← Pipeline: own review, but pending.CommitOid != newOid → stale-commit-oid path
   ← Pipeline deletes orphan, recreates pending at newOid, re-attaches thread, finalizes
10. Expect "Review submitted"
```

Assertions:

- `gh.listSubmittedReviewsSince(prNumber, sinceTs)` shows ONE finalized Comment review.
- Submitted review's `commitOid` matches `newOid` (not `baseOid`).
- `gh.listOwnPendingReviews` empty.

**Regression net for:** real `addPullRequestReview` at a non-head OID, `deletePullRequestReview` orphan cleanup, `createCommitOnBranch` helper interop, full stale-recreation pipeline against real GraphQL.

**Known fragility:** step 7 depends on GitHub read-replica propagation + the `ActivePrPoller` cadence. 30s is the empirical headroom budget (see §10 risks). Mitigated by awaiting the `pr-updated` SSE event (the same event that triggers the Reload banner) rather than polling state directly. If the SSE never arrives within 30s the test fails loudly — `retries:0` is intentional, but the failure message clearly indicates "poller/SSE timeout, may be real GitHub eventual-consistency on slow days" so a developer can distinguish flake from design break.

### 6.5 Coverage matrix

| Surface | Happy | Foreign | LostResp | StaleOID |
|---|---|---|---|---|
| FE `/mark-viewed` | ✅ | ✅ | ✅ | ✅ |
| `addPullRequestReview` acceptance | ✅ | | ✅ | ✅ |
| `addPullRequestReviewThread` acceptance | ✅ | (helper) | ✅ | ✅ |
| `submitPullRequestReview` acceptance | ✅ | ✅ | ✅ | ✅ |
| `FindOwnPendingReviewAsync` live shape | | ✅ | ✅ | ✅ |
| Marker durability | | | ✅ | |
| `deletePullRequestReview` acceptance | | (reset) | | ✅ |

## 7. Lifecycle, setup, and multi-teammate model

### 7.1 Multi-teammate isolation

The sandbox repo is shared. To prevent teammate-A's runs from breaking teammate-B's runs (force-reset on the same branch, head-advance races, etc.), every fixture name is suffixed with the teammate's GitHub login:

- `e2e-real-happy-fixture-pratyush`
- `e2e-real-happy-fixture-alice`
- (etc.)

Each developer has their own four PRs on `prpande/prism-sandbox`. `listOwnPendingReviews` already filters by `viewer.login`, so pending-review state is also teammate-isolated.

**Sandbox-repo prereqs the owner manages** (operator runbook lists these):

1. Each new teammate is added as a collaborator: `gh api -X PUT repos/prpande/prism-sandbox/collaborators/<login> -F permission=push`.
2. **GitHub Actions is disabled on `prpande/prism-sandbox`** (`gh api -X PUT repos/prpande/prism-sandbox/actions/permissions -F enabled=false`). A push-permission collaborator can otherwise commit a `.github/workflows/*.yml` file that executes in the owner's runner context with any inherited org-level secrets. Disabling Actions closes this blast radius.
3. **`master` has no branch protection** that blocks force-push from collaborators (the setup script does not modify `master`, only `e2e-real-*` branches, but if branch protection later lands on `master`, the setup script's PR-target should switch to a protected-base scheme).
4. **Recommended:** teammates use a fine-grained PAT scoped to `prpande/prism-sandbox` only, with `contents:write` + `pull_requests:write` + `metadata:read`. Classic `repo`-scoped PATs work but grant access to every private repo the teammate can reach, which is more blast radius than the test surface needs. The operator runbook calls this out.

**One-machine-per-teammate invariant.** A teammate running the suite from two machines under the same `gh` identity would have both machines race on the same `e2e-real-*-fixture-<login>` branches on GitHub. The setup script is per-machine idempotent but does not coordinate across machines. Documented as an invariant; no cross-machine locking is provided.

### 7.2 One-time setup script

`frontend/scripts/setup-real-e2e-fixtures.ts` (idempotent, per-teammate):

```
1. Read viewer.login via gh GraphQL.
2. For each of [happy, foreign, lost-response, stale-oid]:
   - branch = `e2e-real-${name}-fixture-${login}`
   - If branch missing: create from master with one seed commit adding/modifying anchorFile
     to have ≥1 diff line vs master.
   - If branch exists: force-reset to its known baseOid (read from existing fixtures.json
     if present; otherwise capture the current branch tip as baseOid).
   - If PR missing: open it (title: `[e2e fixture, ${login}] ${name}`).
   - If PR exists: reuse (gh pr list --head ${branch} returns it).
   - Capture fixture metadata (prNumber, prNodeId, baseOid, anchorFile, anchorLine).
3. Write frontend/e2e/real/fixtures.json with all 4 fixtures.
```

Re-runnable any time. A developer can run it to repair drifted fixtures or refresh anchors if `master` advances. No file lock (initial design had one; ce-doc-review noted concurrent same-machine runs are not a real scenario and the script is idempotent anyway). The one-machine-per-teammate invariant in §7.1 covers the cross-machine case.

### 7.3 Order of operations on a fresh clone

```
1. (One-time, per teammate) gh auth login --scopes repo
   (Or: create a fine-grained PAT scoped to prism-sandbox per §7.1 #4 and `gh auth login` with --with-token)
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

PAT loading respects the `02-architecture.md:711` invariant ("PAT stored in OS keychain, never in `state.json`"). Pre-injection into `state.json` was in the first draft of this design and was wrong — `TokenStore` writes to MSAL-wrapped `PRism.tokens.cache` (DPAPI/keychain-protected); writing plaintext JSON to `state.json` would both fail to be picked up AND violate the architectural contract. We instead drive PRism's real `/setup` flow programmatically once per session.

**Important auth-middleware constraint:** `playwright.real.config.ts` runs the backend under `ASPNETCORE_ENVIRONMENT=Test`. `SessionTokenMiddleware._enforced = !env.IsDevelopment()` (verified in `PRism.Web/Middleware/SessionTokenMiddleware.cs:43`), so it enforces session-token + cookie on every `/api/*` mutating request. `/api/auth/connect` is **not** in the `/test/*` exempt namespace. Additionally, `OriginCheckMiddleware` (`PRism.Web/Middleware/OriginCheckMiddleware.cs:34-39`) rejects any POST with missing/non-loopback `Origin`. A bare `request.post('/api/auth/connect', {data: {pat}})` from an APIRequestContext that's never navigated PRism's HTML will 403 (no Origin) or 401 (no session token). globalSetup must complete the bootstrap dance first.

```
1. Read fixtures.json. If missing → throw with actionable message
   ("Run `npm run setup-real-e2e-fixtures` first; see docs/e2e/real-flow.md").
2. Validate gh auth: execFileSync('gh', ['api', '/user']).
   On non-2xx / not logged in → throw with `gh auth login --scopes repo` hint.
3. Capture PAT: execFileSync('gh', ['auth', 'token', '--hostname', 'github.com']).
4. Read viewer.login via gh, assert it matches fixtures.json's owning login (defends against
   a teammate accidentally running with a different gh-auth context — e.g., a bot identity —
   from the one that created their fixtures).
5. Wait for backend health (GET /api/health — the one path exempt from SessionTokenMiddleware).
6. Bootstrap the auth context: launch chromium, open a page, GET / (HTML response — backend stamps
   prism-session cookie via Program.cs' text/html cookie-stamping middleware). Capture the
   cookie value from the browser context. From here on, use the BROWSER PAGE'S request context
   (page.request) — it auto-includes the cookie AND auto-includes Origin: http://localhost:5181
   on POSTs. (The bare APIRequestContext from request.newContext() does neither; use the
   page-bound one.)
7. POST PAT through /api/auth/connect:
     - On 200 AuthConnectSuccess → TokenStore.CommitAsync ran inline; done.
     - On 200 AuthConnectWithWarning (currently only NoReposSelected; a fine-grained
       sandbox-scoped PAT trips this) → POST /api/auth/connect/commit to accept the warning
       and complete the commit.
     - On AuthConnectValidationFailed / AuthConnectError → throw with the error code; the
       PAT is bad.
   Verified shape against PRism.Web/Endpoints/AuthEndpoints.cs:38-115; the "/connect + /commit"
   pattern from an earlier draft of this doc was wrong — /commit fires only on warning.
8. Run `npm run build` + `dotnet build PRism.Web` (mirrors the existing fake-mode
   global-setup at frontend/e2e/global-setup.ts — same reasoning: regenerate the wwwroot
   manifest so MapStaticAssets serves real bytes rather than the prior cached 0-byte
   bundle. If frontend/e2e/global-setup.ts changes, update both setups in lockstep).
```

Each spec's `beforeEach` then navigates to the fixture PR directly (no `/setup` navigation per spec — the PAT is already committed for the run).

### 7.6 Why `retries: 0`

Real GitHub mutations don't undo. A flaky test that "passed on retry" might have left confusing state on the sandbox or masked a real bug that only surfaces on the first attempt of a fresh sequence. The fake config can safely retry because `/test/reset` nukes everything between runs. Real-flow can't — `resetSandboxFixture` runs at `beforeEach`, not before retry, so a retry would inherit half-mutated state. Disabling retries sidesteps this. Real-flow tests are local-dev tools, not a CI gate; a developer can re-run by hand.

**Distinguishing flake from regression.** Two sources of legitimate non-design flake exist: (a) GitHub read-replica propagation lag on the stale-OID spec (§6.4 — 30s budget), (b) transient API blips (5xx, rate-limit edge cases). Each spec's assertion messages name the surface that timed out so the developer can read the failure and decide. If the same spec fails twice in a row, treat as regression; if it fails once then passes on a manual rerun, treat as flake and capture in the operator runbook's troubleshooting section.

### 7.7 Crash recovery

If a run is killed mid-test:

- **GitHub-side state:** the next run's `beforeEach` runs `resetSandboxFixture`, which deletes lingering viewer-owned pending reviews and force-resets the branch to `baseOid`. Recovers cleanly.
- **PRism-side state:** per-run `DataDir` lives in `os.tmpdir()`, overwritten on next config load. `globalSetup` re-injects the PAT via the real `/api/auth/connect` flow against the fresh DataDir.
- **Dangling commits on the sandbox** (from `createCommitOnBranch` runs that were force-reset away): GitHub GCs unreferenced commits over time. Not our problem.
- **Stranded submitted reviews on fixture PRs from prior runs:** GitHub does not delete submitted review threads when the anchored commit OID becomes unreachable. They accumulate over time but do **not** affect spec assertions, because all submitted-review assertions use `listSubmittedReviewsSince(prNumber, sinceTs)` scoped to the per-test timestamp.

No `globalTeardown` is needed.

## 8. Regression-catch verification (Definition of Done item)

Each spec is paired with a one-line production-code edit that should make it fail. The developer performs this locally before opening the PR, restores, and attests in the PR description. The runbook lives in `docs/e2e/real-flow.md`:

| Spec | Edit to introduce | Expected failure surface |
|---|---|---|
| `s5-real-happy-path` | Comment out the `postMarkViewed(...)` block in `frontend/src/hooks/usePrDetail.ts:66-79` | `waitForResponse(/mark-viewed/)` times out; subsequent submit returns 400 `head-sha-not-stamped` |
| `s5-real-foreign-pending-review` | Force `FindOwnPendingReviewAsync` to return `null` (early-return in the impl) | Pipeline reaches Begin without foreign-detection; GitHub refuses second pending review for same viewer → Begin fails; spec fails on dialog Failed state (NOT on missing modal — that earlier framing was wrong; the modal can't render if FindOwn returns null because the pipeline never sees a pending review) |
| `s5-real-lost-response-adoption` | Remove the marker prefix from `DraftThreadRequest.BodyMarkdown` thread-formatting | Adoption can't match on second submit → AttachThread fires twice → assertion "exactly 1 thread" fails (count = 2) |
| `s5-real-stale-commit-oid` | Replace the `StaleCommitOidRecreating` branch in `SubmitPipeline` with `throw` | Second submit Failed; spec times out waiting for "Review submitted" heading |

(Foreign-pending-review row was tightened by ce-doc-review — the original framing of "skip FindOwn preflight" produces a different failure mode than the assertion expects.)

## 9. Trade-offs accepted

1. **Test-only seam in a production assembly (PRism.Web).** ~90 LOC of gated code under `PRism.Web/TestHooks/`. Co-gated on `ASPNETCORE_ENVIRONMENT=Test` AND `PRISM_E2E_REAL_INJECT=1`. Placement was moved out of `PRism.GitHub` to keep the production GraphQL adapter clean of test infra. Alternatives considered and rejected:
   - **`protected virtual` seams in `GitHubReviewService.Submit.cs`** — pollutes the production class with a subclass-only surface and misses the actual transport layer (only intercepts at our boundary).
   - **`mitmproxy`-style local intercept process** — would leave production code 100% unmodified and allow byte-perfect transport-level simulation (including TCP-reset cases the exception-throwing handler can't simulate). The chosen seam is materially cheaper: ~90 LOC of gated handler + zero new runtime dependencies, vs ~300 LOC of proxy harness + a Python/Node process the rest of the test infra doesn't need. The mitmproxy win is narrowly *"zero production-code blast radius and byte-level transport fidelity"* — not a cost-parity story. Rejected for now in favor of the cheaper DI-registered handler. Worth revisiting if the seam needs to grow (e.g., latency injection, byte-corruption tests) where the production-code-blast-radius cost starts to compound.
2. **Four long-lived PRs per teammate on the sandbox.** Sandbox is throwaway (description says so). Branch names are obviously dedicated. Easy to GC manually if a teammate leaves.
3. **PAT identity = real reviewer.** Comments and reviews land under whoever's `gh` is authenticated. Acceptable on a dedicated sandbox. Mitigation: fine-grained PATs scoped to `prism-sandbox` only (recommended in §7.1).
4. **Real-flow not in CI.** Local-dev / pre-release gate only. The 15 fake-mode specs continue to be the CI merge gate. See §10 for the rot risk this opens up.
5. **`retries: 0`** for real-flow — flakiness fails loudly rather than masking. Defended in §7.6.
6. **Hardcoded `prpande/prism-sandbox` in helpers.** Single shared repo per the brief. Parameterizing for per-teammate sandboxes is YAGNI; if it ever matters, the seam is a one-line config object.
7. **Per-teammate fixture model with collaborator-management.** Designed for the explicitly-anticipated teammate workflow. ce-doc-review challenged this as premature given the current 1-developer state; kept because the user named teammate participation as a near-term expectation and the alternative (rebuild the suite when the first teammate joins) doesn't reduce total cost.

## 10. Risks

- **Rot from opt-in disuse.** Real-flow is local-dev / pre-release only with four prereq steps. If the suite isn't run regularly, fixture metadata drifts, `gh` CLI flags evolve, and re-running becomes archeology. Mitigation: a "pre-release sanity" section in `docs/e2e/real-flow.md` (which is in §11 DoD) documenting the suite as a release-tag prereq. If governance ever wants this enforced beyond a runbook entry, a follow-up edit to `.ai/docs/development-process.md` adds the checkbox; deferring that to a separate PR keeps governance-doc changes out of this feature PR.
- **GitHub API contract changes.** Most are additive; mutation-shape breaks are rare. Real-flow specs are our canary — failing immediately on contract drift, which is one of the values of this suite.
- **HTML-comment marker stripping.** If GitHub ever strips them, `s5-real-lost-response-adoption` fails as the live C7 empirical gate. That's a feature, not a bug.
- **Stale-OID spec poller-cadence + replica-propagation sensitivity.** GitHub's GraphQL read replicas can serve stale data for 5-15s after a mutation lands on the primary. Combined with the 1s poller cadence + SSE emit, the 30s budget in §6.4 should be sufficient on typical days, but a slow-API window can exceed it. Mitigated by SSE event-wait rather than time-based polling; if the SSE never arrives, the spec fails loudly with a clearly-named timeout surface (see §7.6 flake-vs-regression).
- **Rate-limit budget.** 4 specs × ~5 GraphQL mutations × ~50 runs/day ≈ 1000 points, vs the 5000/hour budget per PAT. Plenty of headroom.
- **DelegatingHandler operation-keying brittleness.** The selection-field-name sniff (§4.1) assumes mutations have a single top-level selection — true for all current PRism.GitHub.Submit mutations. If a future submit pipeline batches multiple mutations into one GraphQL request, the sniff routes by the first selection only. Documented in the handler with a one-line comment; if multi-selection mutations ever ship, the sniff expands to per-position routing.

## 11. Definition of Done

- All 4 real-flow specs pass on first attempt against a freshly-set-up sandbox: `npm run test:e2e:real`.
- Each spec's mechanical regression-catch verified locally (one-line edits from §8); attestation in the PR description.
- Default `npx playwright test` (fake mode) still passes — unchanged.
- Pre-push checklist runs clean per `.ai/docs/development-process.md` (`npm run lint`, `npm run build`, full e2e, etc.).
- `docs/e2e/real-flow.md` operator doc lands in the same PR. Minimum sections: prereqs (gh auth, collaborator-add, Actions-disabled assertion), running, what each spec catches, verifying regression nets (§8 table), known flake surfaces (§7.6). Troubleshooting and refresh-master sections can land as stub headers and grow as real problems surface in use.
- `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md`: revisions-log entry added; original `[Defer] e2e Playwright test driving the real usePrDetail → mark-viewed → submit → Finalize chain.` entry updated with `**Status update:** Resolved` line pointing at this spec doc + the 4 new spec files.
- Sandbox-repo prereqs verified before merge: `gh api repos/prpande/prism-sandbox/actions/permissions` returns `{"enabled": false}`; `gh api repos/prpande/prism-sandbox/branches/master/protection` returns 404 (no protection blocking force-push).

## 12. Files created and changed

| Path | Change |
|---|---|
| `PRism.Web/TestHooks/TestFailureInjectionHandler.cs` | NEW |
| `PRism.Web/TestHooks/RealTransportFailureInjector.cs` | NEW |
| `PRism.Web/TestHooks/RealInjectEndpoints.cs` | NEW |
| `PRism.Web/TestHooks/TestEndpoints.cs` | + `/test/clear-pr-session` endpoint (clears session AND `IActivePrCache` subscription in one `UpdateAsync`) |
| `PRism.Web/Program.cs` | + 3 conditional blocks (mutex check, handler registration co-gated on Test+REAL_INJECT, endpoint map); also widen the existing `UseStaticWebAssets()` gate to engage under REAL_INJECT=1 as well (one-line OR) |
| `PRism.Core/PrDetail/ActivePrSubscriberRegistry.cs` | If `SubscribersFor(prRef)` isn't already public, + one ConcurrentDictionary lookup method (~5 LOC) so `/test/clear-pr-session` can iterate-and-Remove subscribers for a PR |
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
| `frontend/package.json` | + `setup-real-e2e-fixtures`, `test:e2e:real` scripts; + `tsx` and `dotenv` in devDependencies |
| `frontend/.gitignore` | + `e2e/real/fixtures.json`, `.env.local` |
| `docs/e2e/real-flow.md` | NEW (operator runbook — minimum sections per §11 DoD) |
| `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md` | + revisions-log entry, deferral status update |
