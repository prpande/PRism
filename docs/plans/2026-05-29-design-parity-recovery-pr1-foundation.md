# Design parity recovery — PR1 Foundation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Drafted; `compound-engineering:ce-doc-review` pass complete (4 reviewers, 10 findings triaged); awaiting human review before execution.

**Goal:** Land the four atomic Foundation pieces from §4.1 of [`docs/specs/2026-05-29-design-parity-recovery-design.md`](../specs/2026-05-29-design-parity-recovery-design.md) so PR2-PR9 can build on stable scaffolding: dev-mode 401 → 403 fix, handoff-parity-fixture decision (cost-to-gate fallback), Playwright viewport baseline harness without committed baselines, and the side-by-side review convention update.

**Architecture:** TDD per [`.ai/docs/development-process.md`](../../.ai/docs/development-process.md). Pure scaffolding — no JSX className renames, no existing module CSS changes, no `data-testid` additions to production components (deferred to PR2-PR8 per spec §4.1.3). One backend file changes (`EventsEndpoints.cs:64-70`); one backend test changes; one new Playwright spec file lands without committed PNG baselines; one helper file gains a thin alias; one doc file gains a paragraph; a deferrals sidecar captures the cost-to-gate fallback decision.

**Tech Stack:** .NET 10 (`PRism.Web`), xUnit + FluentAssertions (`tests/PRism.Web.Tests`), Playwright 1.59 (`frontend/e2e`).

**Scope decisions locked from the spec's ce-doc-review pass — explicit deviations from spec §4.1:**

| Decision | Spec §4.1 says | PR1 plan does | Why |
|---|---|---|---|
| **HandoffParityFixture** | Build new `HandoffParityFixture` C# class + new `POST /test/load-handoff-parity-fixture` endpoint + multi-scenario `FakeReviewBackingStore` extension | **Skip entirely.** Take the cost-to-gate fallback. Use existing `acme/api/123` scenario fixture for side-by-side review against the locally-loaded handoff prototype. | `FakeReviewBackingStore.Scenario` is a `public static readonly` hardcoded across `FakePrReader` / `FakePrDiscovery` / `FakeReviewSubmitter`. Multi-scenario extension is ~2-3 days. The spec's §4.1.1 fallback explicitly authorizes this. Tracked in deferrals D1. |
| **Production-code `data-testid` additions** | Each PR (PR2-PR8) adds its zone's selectors as part of that slice's JSX touch | No selector additions in PR1. The `parity-baselines.spec.ts` references selectors that mostly don't yet exist | Per spec §4.1.3 carve-out. Each restoration PR unblocks its zone by adding selectors + first baseline together. |
| **Reconciliation-panel zone baseline** | Listed as one of the parity-baselines zones | **Deferred to PR5.** The `UnresolvedPanel` component currently exposes only `data-testid="unresolved-panel-announce"` (an aria-live region), no container `data-testid`. Adding a container testid is a JSX touch and belongs in PR5's slice when that surface restores. | Discovered during PR1 plan review. Tracked in deferrals D2. |

The `pr-header` selector is an exception to the broader "selectors mostly missing" framing — it already exists at `frontend/src/components/PrDetail/PrHeader.tsx:275` (added during prior work for `no-layout-shift-on-banner.spec.ts`). The `pr-detail-header` parity-baseline test will pass `waitFor()` and fail only at the snapshot-compare step (no committed baseline). Every other PR Detail zone test fails earlier at the locator timeout.

---

## File map

**Modify:**
- [`PRism.Web/Endpoints/EventsEndpoints.cs`](../../PRism.Web/Endpoints/EventsEndpoints.cs) — Change `SubscribeAsync` line 64-70 cookie-missing return from `Status401Unauthorized` to `Status403Forbidden`.
- [`tests/PRism.Web.Tests/Endpoints/EventsSubscriptionsEndpointTests.cs`](../../tests/PRism.Web.Tests/Endpoints/EventsSubscriptionsEndpointTests.cs) — Rename test `Subscribe_returns_401_when_no_cookie_session_present` → `Subscribe_returns_403_when_no_cookie_session_present`; flip assertion from `Unauthorized` to `Forbidden`; add a body-type assertion that pins the 403 to the `/events/no-session` problem type (prevents future regressions where a middleware-emitted 403 silently satisfies the test).
- [`.ai/docs/design-handoff.md`](../../.ai/docs/design-handoff.md) — Append a "Parity PR checklist" paragraph documenting the side-by-side review convention.

**Create:**
- `frontend/e2e/parity-baselines.spec.ts` — New Playwright spec defining the zones the parity work will lock against future drift. No baselines committed in this PR.
- `frontend/e2e/helpers/parity-fixture.ts` — New helper file housing `setupAndOpenHandoffParityFixture` so the parity-aware naming is discoverable without grepping `s4-setup.ts`.
- `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` — Deferrals sidecar; the first entry captures the HandoffParityFixture cost-to-gate fallback decision with rationale.

**Out of scope for PR1:**
- Any JSX className edits.
- Any `.module.css` file creation.
- Adding `data-testid` attributes to existing components.
- Implementing the `HandoffParityFixture` C# class or its `/test/load-handoff-parity-fixture` endpoint. (Deferred per the fallback.)

---

## Task 1: Create worktree + feature branch

Per [`~/.claude/CLAUDE.md`](file:///C:/Users/praty/.claude/CLAUDE.md), never make code changes on an existing branch. Create an isolated worktree first.

**Files:** None modified yet.

- [ ] **Step 1.1: Confirm clean working tree on main**

Run from the project root (`D:\src\PRism`):

```bash
git status
```

Expected: nothing besides the untracked `.tmp/` and `.claude/` from prior session work. If anything else is dirty, stop and investigate.

- [ ] **Step 1.2: Create the worktree**

```bash
git worktree add ../PRism-design-parity-pr1 -b design-parity-recovery-pr1-foundation
```

Expected output: `Preparing worktree (new branch 'design-parity-recovery-pr1-foundation')\nHEAD is now at <sha> <last main commit subject>`.

- [ ] **Step 1.3: Switch into the worktree for all subsequent work**

All subsequent paths in this plan are relative to `../PRism-design-parity-pr1/`. The worktree shares the same `.git` directory but has its own working tree.

Verify:
```bash
cd ../PRism-design-parity-pr1 && pwd && git branch --show-current
```

Expected: `D:\src\PRism-design-parity-pr1` (or equivalent absolute path), `design-parity-recovery-pr1-foundation`.

- [ ] **Step 1.4: Verify the worktree builds clean before any edits**

```bash
dotnet build --configuration Release
```

Expected: `Build succeeded.` with 0 warnings, 0 errors. If anything fails, the worktree was created against a dirty main — stop and resolve.

(No commit yet — Task 1 is environment setup.)

---

## Task 2: Dev-mode 401 → 403 fix (TDD)

The smallest, most surgical piece in PR1. Single-line backend change + test rename + assertion flip. Lands first because it doesn't depend on anything else and unblocks dev-mode iteration for the rest of the slice.

**Files:**
- Modify: `tests/PRism.Web.Tests/Endpoints/EventsSubscriptionsEndpointTests.cs:13-34` (rename test method, flip assertion).
- Modify: `PRism.Web/Endpoints/EventsEndpoints.cs:64-70` (return `Forbidden` not `Unauthorized`).

- [ ] **Step 2.1: Rename the test method and flip its assertion (write the failing test)**

Open `tests/PRism.Web.Tests/Endpoints/EventsSubscriptionsEndpointTests.cs` and replace the existing first test method (lines 15-34) with:

```csharp
    [Fact]
    public async Task Subscribe_returns_403_when_no_cookie_session_present()
    {
        // Endpoint's own no-cookie defense (middleware would also 401 if X-PRism-Session
        // were missing). Use an unauthenticated client + manual X-PRism-Session header
        // + a same-origin Origin header so SessionToken AND OriginCheck middleware pass
        // — the test isolates the endpoint's no-cookie branch.
        //
        // Status changed from 401 → 403 in design-parity-recovery PR1 (§4.1.2): 401 means
        // "session token is bad — re-auth"; 403 means "this operation requires SSE connect
        // first." The user IS authenticated; the missing cookie is a sequencing
        // prerequisite, not an auth failure. Prevents apiClient.ts:75-77 from dispatching
        // prism-auth-rejected and bouncing the user to /setup in dev mode where Vite
        // serves the SPA on :5173 and Kestrel never stamped the cookie on :5180.
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateUnauthenticatedClient();

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/events/subscriptions")
        {
            Content = JsonContent.Create(new { prRef = "o/r/1" }),
        };
        req.Headers.Add("X-PRism-Session", factory.SessionToken);
        req.Headers.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));
        // No Cookie header — the endpoint must reject with 403.
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        // Pin the response body's problem type to /events/no-session so this test
        // doesn't silently pass if a future middleware change emits 403 from a
        // different layer (e.g., OriginCheckMiddleware also returns 403 for a wrong
        // Origin). The body-type assertion isolates the endpoint's no-cookie branch.
        var problem = await resp.Content.ReadFromJsonAsync<ProblemDetails>();
        problem!.Type.Should().Be("/events/no-session");
    }
```

- [ ] **Step 2.2: Run the test and verify it fails for the right reason**

```bash
dotnet test --filter "FullyQualifiedName~Subscribe_returns_403_when_no_cookie_session_present" --configuration Release
```

Expected: `Failed!` with one failure: `Expected resp.StatusCode to be Forbidden, but found Unauthorized.` This confirms the test is exercising the right code path before the implementation change lands.

- [ ] **Step 2.3: Apply the implementation change**

Open `PRism.Web/Endpoints/EventsEndpoints.cs` and find the block at lines 64-70 inside `SubscribeAsync`:

```csharp
        var cookieSessionId = ctx.Request.Cookies["prism-session"];
        if (string.IsNullOrEmpty(cookieSessionId))
        {
            return TypedResults.Problem(
                detail: "No prism-session cookie present on this request.",
                type: "/events/no-session",
                statusCode: StatusCodes.Status401Unauthorized);
        }
```

Replace with:

```csharp
        var cookieSessionId = ctx.Request.Cookies["prism-session"];
        if (string.IsNullOrEmpty(cookieSessionId))
        {
            // 401 means "session token is bad — re-auth"; 403 means "this operation
            // requires the SSE connect prerequisite." The user IS authenticated (the
            // middleware bypass in dev mode passed them through); the missing cookie
            // is a sequencing prerequisite, not an auth failure. Returning 401 here
            // caused apiClient.ts to dispatch prism-auth-rejected, flipping the SPA's
            // isAuthed to false and force-redirecting protected routes to /setup in
            // dev mode (Vite serves SPA on :5173, Kestrel stamps cookie on :5180 only).
            // See docs/specs/2026-05-29-design-parity-recovery-design.md §4.1.2.
            return TypedResults.Problem(
                detail: "No prism-session cookie present on this request — connect to /api/events first.",
                type: "/events/no-session",
                statusCode: StatusCodes.Status403Forbidden);
        }
```

- [ ] **Step 2.4: Re-run the test and verify it passes**

```bash
dotnet test --filter "FullyQualifiedName~Subscribe_returns_403_when_no_cookie_session_present" --configuration Release
```

Expected: `Passed!` with one passing test.

- [ ] **Step 2.5: Run the full EventsSubscriptions test file to confirm no neighbor regression**

```bash
dotnet test --filter "FullyQualifiedName~EventsSubscriptionsEndpointTests" --configuration Release
```

Expected: All `EventsSubscriptionsEndpointTests` pass. The neighboring `Subscribe_returns_403_when_cookie_present_but_no_active_sse_connection` test (which already returns 403 for a different reason) is unaffected.

- [ ] **Step 2.6: Audit the frontend 401-branch surface (not just the problem-type string)**

The plan's prior grep for `events/no-session` would not find the actual mechanism — no frontend code branches on the problem-type string. The mechanism is the literal `if (resp.status === 401)` at [`frontend/src/api/client.ts:75`](../../frontend/src/api/client.ts), which dispatches `prism-auth-rejected` for ANY 401. Two greps:

```bash
grep -rn "events/no-session" --include="*.cs" --include="*.ts" --include="*.tsx"
```

Expected: matches only in `PRism.Web/Endpoints/EventsEndpoints.cs` and `tests/PRism.Web.Tests/...`. No frontend matches.

```bash
grep -rn "status === 401\|status == 401\|StatusCode.*401" frontend/src/
```

Expected: one match at `frontend/src/api/client.ts:75-77` (the `prism-auth-rejected` dispatch). Document this in the PR description as the mechanism the fix corrects — the 403 response from the updated endpoint flows past line 75 without triggering the dispatch.

**Also check** the other backend endpoints that return 401 on a similar "unauthorized — not subscribed" path:

```bash
grep -rn "Status401Unauthorized" PRism.Web/Endpoints/
```

Expected: matches in `PrSubmitEndpoints.cs` (submit, resume, discard foreign-pending-review) and `PrDraftsDiscardAllEndpoint.cs`. These return 401 with `"unauthorized"` error code on `IsSubscribed` failure. In dev mode these would also trigger the prism-auth-rejected cascade *if reached before SSE subscribe completes* — but submit / discard-all are user-triggered actions that require deliberate intent, and the subscribe loop completes before a user can realistically dispatch them. **PR1 leaves these as 401**; if a future dev-mode bounce is observed from a submit action, the same 401→403 reasoning applies as a follow-up slice. Document this decision in the deferrals sidecar D3 in Step 2.6.5 below.

- [ ] **Step 2.6.5: Add D3 to the deferrals sidecar (sibling-401-endpoints audit)**

Append the following entry to `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` (after D2):

```markdown

### D3 — Sibling 401 endpoints (PrSubmit / PrDraftsDiscardAll) not flipped
**Date:** 2026-05-29 (PR1 implementation).
**Spec §:** 4.1.2.
**Decision:** Leave `PrSubmitEndpoints.SubmitAsync`, `ResumeForeignPendingReviewAsync`, `DiscardForeignPendingReviewAsync`, and `PrDraftsDiscardAllEndpoint.DiscardAllAsync` returning 401 (`"unauthorized"` SubmitErrorDto code) on `IsSubscribed == false`. Do NOT flip them to 403 in PR1.
**Why:** These are user-triggered mutating actions (submit, resume, discard). For the dev-mode cascade to fire, the user would have to dispatch one of these actions BEFORE the SSE-subscribe loop completes — which is structurally rare (the subscribe POST is `useEffect`-driven and fires on PR-detail mount, well before any user can click Submit or Resume). The Events/Subscribe path is different because it fires *automatically* on every PR detail navigation, so its 401 is the one that user-visibly bounces. Flipping submit/resume/discard would be a defensive change with no current symptom.
**Reversible:** Yes. If a future report observes a dev-mode bounce from a Submit action, the same 401→403 reasoning applies — flip those endpoints in a follow-up slice. The `apiClient.ts:75` dispatch stays the load-bearing trigger; widening the 401→403 conversion is a narrow surface.
**Cross-refs:** Audit performed in PR1 plan Task 2 Step 2.6; affected endpoints enumerated in `grep -rn "Status401Unauthorized" PRism.Web/Endpoints/` output.
```

- [ ] **Step 2.7: Commit the 401 → 403 fix**

```bash
git add tests/PRism.Web.Tests/Endpoints/EventsSubscriptionsEndpointTests.cs PRism.Web/Endpoints/EventsEndpoints.cs
git commit -m "fix(events): subscribe returns 403 not 401 when prism-session cookie absent

Cookie-missing on POST /api/events/subscriptions is a sequencing prerequisite
('connect to /api/events first'), not an auth failure. Returning 401 caused
apiClient.ts:75-77 to dispatch prism-auth-rejected, bouncing protected routes
to /setup in dev mode where Vite serves the SPA on :5173 and Kestrel stamps
the prism-session cookie on :5180 only.

Test renamed and assertion flipped. No frontend changes — the apiClient's
401-as-auth-rejected dispatch stays correct for real 401s (SessionToken
middleware rejection in prod).

Refs docs/specs/2026-05-29-design-parity-recovery-design.md §4.1.2"
```

---

## Task 3: HandoffParityFixture decision — fallback to existing scenario

Per spec §4.1.1's cost-to-gate fallback, `FakeReviewBackingStore` multi-scenario extension is ~2-3 days work (the `Scenario` field is hardcoded across all four fakes). PR1 takes the fallback: side-by-side review uses the existing `acme/api/123` scenario; the locally-loaded handoff prototype provides the left half of the comparison.

This task creates the deferrals sidecar to capture the decision visibly.

**Files:**
- Create: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`.

- [ ] **Step 3.1: Create the deferrals sidecar**

```bash
mkdir -p docs/specs
```

(The `docs/specs` directory already exists; the `mkdir -p` is a no-op safety net.)

Write `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` with this content:

```markdown
# Design parity recovery — deferrals sidecar

Companion to [`2026-05-29-design-parity-recovery-design.md`](2026-05-29-design-parity-recovery-design.md). Tracks deviations from the spec encountered during implementation; one entry per decision, with verdict + rationale.

---

## PR1 — Foundation

### D1 — HandoffParityFixture: cost-to-gate fallback selected
**Date:** 2026-05-29 (PR1 implementation).
**Spec §:** 4.1.1.
**Decision:** Skip the new `HandoffParityFixture` C# class and the `POST /test/load-handoff-parity-fixture` endpoint. PR1 ships no fixture work. Side-by-side review uses the existing `acme/api/123` scenario fixture (`FakeReviewBackingStore.Scenario`) as the implementation side; the locally-loaded handoff prototype (`design/handoff/PRism.html`) provides the reference side.
**Why:** `FakeReviewBackingStore.Scenario` is a `public static readonly` field hardcoded across `FakePrReader`, `FakePrDiscovery`, `FakeReviewSubmitter`, and the test endpoints in `PRism.Web/TestHooks/TestEndpoints.cs`. Multi-scenario extension requires either a registry refactor (every fake takes a per-call reference; the singleton becomes a dictionary) or a parallel store singleton (separate DI registration). Either path is 2-3 days of work plus rework risk on the existing E2E suite (24 specs depend on the current single-scenario shape). The spec's cost-to-gate threshold (~1 day) is exceeded. The marginal value of identical fixture content over the locally-loaded prototype is acknowledged but is not the parity gate — the human side-by-side review is, per spec §4.1.4.
**Consequence:** Reviewers comparing the implementation side against the prototype work with *different PRs* (acme/api/123 "Calc utilities" vs handoff's `#1842` "Refactor LeaseRenewalProcessor"). The comparison is structural ("does this section's card layout match?") rather than content-matched ("does the title wrap at the same column?"). Per spec §4.1.4 this is acceptable for the parity gate; § 4.1.1's stated benefit of "exercises the real render pipeline" still holds because the scenario fixture also exercises the real render pipeline.
**Reversible:** Yes. If a later PR finds the comparison-on-different-content harder than anticipated, a follow-up slice can pay the extension cost. PR1 sets up no obstacle to that.
**Cross-refs:** Spec §4.1.1 cost-to-gate fallback paragraph; the `setupAndOpenHandoffParityFixture` helper landing in Task 4 is a thin alias rather than a fixture-loading entry point.

### D2 — Reconciliation-panel baseline deferred to PR5
**Date:** 2026-05-29 (PR1 implementation).
**Spec §:** 4.1.3.
**Decision:** Drop the `pr-detail-reconciliation-panel` test from PR1's `parity-baselines.spec.ts`. Re-add it in PR5 when the reconciliation surface is restored.
**Why:** The `UnresolvedPanel` component currently exposes only `data-testid="unresolved-panel-announce"` (an aria-live region inside the component) — there is no container `data-testid` to capture the panel's visual zone. Adding a container `data-testid` is a JSX touch that belongs in PR5's slice (where `UnresolvedPanel` gets its module CSS). PR1's "no production code edits" rule (§4.1.5) prevents adding the selector here. The baseline for the dormant reconciliation panel state captures in PR5 alongside the styled state.
**Reversible:** Yes. PR5 re-adds the test definition + adds the container `data-testid` + captures the baseline in one slice.
**Cross-refs:** Spec §4.1.3 zone list; spec §4.5 PR5 scope (Reconciliation surface).
```

Note: D3 (sibling 401 endpoints) is appended later by Task 2 Step 2.6.5. The order is intentional — D1+D2 are PR1-shape decisions, D3 emerges from the Task 2 audit.

- [ ] **Step 3.2: Commit the sidecar**

```bash
git add docs/specs/2026-05-29-design-parity-recovery-deferrals.md
git commit -m "docs(parity): create deferrals sidecar; record HandoffParityFixture fallback

PR1 Foundation captures the spec §4.1.1 cost-to-gate fallback decision:
skip HandoffParityFixture + /test/load-handoff-parity-fixture; use the
existing acme/api/123 scenario for side-by-side parity review. Sidecar
tracks future deviations as the slice progresses.

Refs docs/specs/2026-05-29-design-parity-recovery-design.md"
```

---

## Task 4: setupAndOpenHandoffParityFixture Playwright helper (alias)

Thin alias so reviewers writing parity-comparison code find a function named for the workflow ("set up the handoff-parity comparison") rather than for the underlying fixture ("set up the acme/api/123 scenario"). The naming makes the parity workflow discoverable without grep.

**Files:**
- Create: `frontend/e2e/helpers/parity-fixture.ts`.

- [ ] **Step 4.1: Write the helper as a thin re-export**

Create `frontend/e2e/helpers/parity-fixture.ts` with this content:

```typescript
import type { Page } from '@playwright/test';
import { setupAndOpenScenarioPr } from './s4-setup';

// Sets up the dev-mode Playwright context for parity comparison work and
// navigates to the PR Detail surface that side-by-side reviews use as the
// implementation side. Per the design-parity-recovery roadmap (PR1, spec
// §4.1.1), the spec's HandoffParityFixture was descoped to a cost-to-gate
// fallback (see the deferrals sidecar). This is a thin alias over the
// existing `setupAndOpenScenarioPr` helper. Reviewers compare this
// implementation surface against the locally-loaded handoff prototype
// (`design/handoff/PRism.html`); content differs (the scenario PR is "Calc
// utilities" vs the handoff's "Refactor LeaseRenewalProcessor"), so the
// comparison is structural, not content-matched.
//
// The alias exists so parity PRs (PR2-PR8) can spawn
// `setupAndOpenHandoffParityFixture(page)` and the call site reads as
// parity-workflow intent. The thin-alias shape lets a future slice swap to a
// real handoff-content fixture (lifting the deferral) without changing every
// call site.
//
// Contract: Callers must set the viewport BEFORE invoking this helper —
// `await page.setViewportSize({ width: 1440, height: 900 })` for the
// canonical parity viewport. The helper does not configure viewport so
// callers from non-1440x900 contexts can override.
export async function setupAndOpenHandoffParityFixture(page: Page): Promise<void> {
  await setupAndOpenScenarioPr(page);
  // The scenario fixture lands the user on / (Inbox). Navigate into the PR
  // Detail surface — the side-by-side comparison target — so callers don't
  // have to repeat this step.
  await page.goto('/pr/acme/api/123');
  // Wait for the PR header to mount so callers can immediately screenshot or
  // assert without a follow-up wait. `data-testid="pr-header"` exists at
  // PrHeader.tsx (added during the no-layout-shift-on-banner spec work).
  await page.locator('[data-testid="pr-header"]').waitFor();
}
```

- [ ] **Step 4.2: Run lint to confirm the file parses + import resolves**

```bash
cd frontend && npm run lint && cd ..
```

Expected: lint passes. If the relative-import resolution to `./s4-setup` fails, double-check that `s4-setup.ts` exports `setupAndOpenScenarioPr` (it does — verified during plan writing).

- [ ] **Step 4.3: Commit the helper**

```bash
git add frontend/e2e/helpers/parity-fixture.ts
git commit -m "test(parity): add setupAndOpenHandoffParityFixture helper alias

Thin alias over setupAndOpenScenarioPr. Per design-parity-recovery deferral
D1, the spec's HandoffParityFixture is descoped; side-by-side review uses the
existing acme/api/123 scenario as the implementation side. Future parity PRs
spawn this helper so call sites read as parity-workflow intent and a later
slice can swap to a real handoff-content fixture without touching every site.

Refs docs/specs/2026-05-29-design-parity-recovery-design.md §4.1.1
Refs docs/specs/2026-05-29-design-parity-recovery-deferrals.md D1"
```

---

## Task 5: Viewport baseline harness — `parity-baselines.spec.ts` (no committed baselines)

Per spec §4.1.3, the harness lands without initial PNG baselines. Each restoration PR (PR2-PR8) `--update-snapshots` for its zones as the first styled state becomes the first committed baseline. PR1's spec file enumerates the zones the parity work will lock against future drift; the file passes-or-fails based on whether the targeted `data-testid` selectors exist in each test — which they mostly don't yet (PR2-PR8 adds them per slice).

**Files:**
- Create: `frontend/e2e/parity-baselines.spec.ts`.

- [ ] **Step 5.1: Create the spec with the full zone list**

Write `frontend/e2e/parity-baselines.spec.ts`:

```typescript
import { test, expect, request } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';
import { setupAndOpenHandoffParityFixture } from './helpers/parity-fixture';

// Viewport baseline regression for the design-parity-recovery roadmap. Per
// spec §4.1.3:
//   - Per-zone narrow screenshots; full-page screenshots are too brittle.
//   - `maxDiffPixelRatio: 0.02` — loose tolerance (font hinting + GPU
//     subpixel rendering vary across machines; the PR9 no-layout-shift spec
//     documents the same fragility).
//   - Initial baselines are NOT committed in PR1. Each restoration PR
//     (PR2-PR8) is responsible for `--update-snapshots` on the zones it
//     touches, with the *first styled / passing state* as the first committed
//     baseline. PR7 additionally re-captures `inbox` + `inbox-activity-rail`
//     because Row 2 chrome shifts Inbox Y-position (§6.9).
//   - The harness is a regression gate, NOT a parity gate. Parity is gated by
//     the human side-by-side review per §4.1.4. The harness catches per-zone
//     visual drift between baseline updates; it does not verify any baseline
//     matches the handoff and does not catch token-level changes that
//     propagate within tolerance to multiple zones.
//   - Several zones reference `data-testid` selectors that don't yet exist in
//     the production components. The carve-out in §4.1.3 says each
//     restoration PR (PR2-PR8) adds its zone's selectors as part of that
//     slice's JSX touch. Until then, the affected tests fail at the locator
//     wait — that's the expected pre-restoration state.

const VIEWPORT = { width: 1440, height: 900 };

// Matches the no-layout-shift-on-banner.spec.ts precedent: kill animations via
// per-test addStyleTag (DOM-level), not via Playwright's `animations: 'disabled'`
// screenshot option. One mechanism, not two — the addStyleTag pattern is the
// project's established convention.
const SCREENSHOT_OPTS = {
  maxDiffPixelRatio: 0.02,
};

test.beforeEach(async () => {
  const ctx = await request.newContext();
  await resetBackendState(ctx);
  await ctx.dispose();
});

test.describe('parity baselines — Inbox', () => {
  test('inbox', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    // setupAndOpenScenarioPr lands on '/', so wait for the inbox list to mount.
    await page.locator('main').waitFor();
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await expect(page.locator('main')).toHaveScreenshot('inbox.png', SCREENSHOT_OPTS);
  });

  test('inbox-activity-rail', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    // Activity rail renders only ≥ 1180px viewport per the handoff non-negotiables
    // documented in .ai/docs/design-handoff.md. The 1440px viewport satisfies this.
    const rail = page.locator('[data-testid="activity-rail"]');
    await rail.waitFor();
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await expect(rail).toHaveScreenshot('inbox-activity-rail.png', SCREENSHOT_OPTS);
  });
});

test.describe('parity baselines — Setup', () => {
  test('setup-card', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto('/setup');
    const card = page.locator('[data-testid="setup-card"]');
    await card.waitFor();
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await expect(card).toHaveScreenshot('setup-card.png', SCREENSHOT_OPTS);
  });
});

test.describe('parity baselines — Settings', () => {
  test('settings-page', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    await page.goto('/settings');
    await page.locator('[data-testid="settings-page"]').waitFor();
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await expect(page.locator('[data-testid="settings-page"]')).toHaveScreenshot(
      'settings-page.png',
      SCREENSHOT_OPTS,
    );
  });
});

test.describe('parity baselines — PR Detail', () => {
  test('pr-detail-header', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await expect(page.locator('[data-testid="pr-header"]')).toHaveScreenshot(
      'pr-detail-header.png',
      SCREENSHOT_OPTS,
    );
  });

  test('pr-detail-overview', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    const overview = page.locator('[data-testid="overview-tab"]');
    await overview.waitFor();
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await expect(overview).toHaveScreenshot('pr-detail-overview.png', SCREENSHOT_OPTS);
  });

  test('pr-detail-files-tree', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/files');
    const tree = page.locator('[data-testid="files-tab-tree"]');
    await tree.waitFor();
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await expect(tree).toHaveScreenshot('pr-detail-files-tree.png', SCREENSHOT_OPTS);
  });

  test('pr-detail-files-diff', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/files');
    // Select the canonical scenario file so the diff pane has content. The
    // scenario fixture defines src/Calc.cs at three iterations (Calc1/2/3).
    await page.locator('[data-testid="files-tab-tree"]').getByText('Calc.cs').click();
    const diff = page.locator('[data-testid="files-tab-diff"]');
    await diff.waitFor();
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await expect(diff).toHaveScreenshot('pr-detail-files-diff.png', SCREENSHOT_OPTS);
  });

  test('pr-detail-drafts', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/drafts');
    const drafts = page.locator('[data-testid="drafts-tab"]');
    await drafts.waitFor();
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    await expect(drafts).toHaveScreenshot('pr-detail-drafts.png', SCREENSHOT_OPTS);
  });

  // pr-detail-reconciliation-panel intentionally NOT included in PR1.
  // UnresolvedPanel exposes only `data-testid="unresolved-panel-announce"`
  // (an aria-live region inside the component, not the visible container).
  // Adding a container `data-testid` is a JSX touch that belongs in PR5.
  // See docs/specs/2026-05-29-design-parity-recovery-deferrals.md D2.
});

// PR7-only zones (added when the PR tab strip ships):
// test('app-chrome-tabstrip', ...) — see PR7 plan.
//
// PR8-only zones (added when the Ask AI drawer ships):
// test('ask-ai-drawer', ...) — see PR8 plan.
```

- [ ] **Step 5.2: Run the spec and verify it fails as expected (no baselines committed yet)**

```bash
cd frontend && npx playwright test e2e/parity-baselines.spec.ts --project=prod --reporter=list && cd ..
```

Expected: every test fails with `Error: A snapshot doesn't exist at ...parity-baselines.spec.ts-snapshots/<name>.png, writing actual.` This is the documented pre-restoration state. The harness is structurally correct; each restoration PR (PR2-PR8) will pass `--update-snapshots` for its zones to commit the first styled baseline.

Note: many tests will fail earlier — at the `data-testid` locator `waitFor()` — because those selectors don't yet exist in the production components. That's also expected: PR2-PR8 adds the selectors as part of that slice's JSX touch (per spec §4.1.3 carve-out). Until then, the affected tests are dormant.

- [ ] **Step 5.3: Confirm the spec is wired into the existing Playwright config**

```bash
cd frontend && grep -n "testIgnore\|testDir" playwright.config.ts && cd ..
```

Expected: `testDir: './e2e'` and `testIgnore: '**/real/**'`. The new `parity-baselines.spec.ts` lives at `frontend/e2e/parity-baselines.spec.ts`, so it's automatically picked up. No config changes needed.

- [ ] **Step 5.4: Commit the spec**

```bash
git add frontend/e2e/parity-baselines.spec.ts
git commit -m "test(parity): add viewport baseline harness (no baselines committed)

New parity-baselines.spec.ts enumerates the zones the design-parity-recovery
roadmap will lock against future drift. Per spec §4.1.3:

- Per-zone narrow screenshots, not full-page.
- maxDiffPixelRatio: 0.02 (loose, per PR9's documented font-hinting fragility).
- No PNG baselines committed in PR1. Each restoration PR (PR2-PR8) runs
  --update-snapshots on its zones; the first styled state is the first
  committed baseline.
- Several tests reference data-testid selectors not yet present in production
  components — that's the expected pre-restoration state. Each restoration PR
  adds its zone's selectors as part of its JSX touch.

The harness is a regression gate. The parity gate is the human side-by-side
review (§4.1.4).

Refs docs/specs/2026-05-29-design-parity-recovery-design.md §4.1.3"
```

---

## Task 6: Side-by-side review convention update

Append a Parity PR checklist paragraph to `.ai/docs/design-handoff.md` so reviewers find the convention in the same place as the rest of the handoff rules.

**Files:**
- Modify: `.ai/docs/design-handoff.md`.

- [ ] **Step 6.1: Read the current contents of `.ai/docs/design-handoff.md`**

```bash
cat .ai/docs/design-handoff.md
```

Expected output: short doc with the non-negotiables already documented (tokens as-is, spacing scale gap, slate tints, etc.).

- [ ] **Step 6.2: Append the Parity PR checklist paragraph**

Append the following block to the end of `.ai/docs/design-handoff.md` (one blank line of separation from the current last line):

```markdown

## Parity PR checklist

Every PR in the design-parity-recovery roadmap (see [`docs/specs/2026-05-29-design-parity-recovery-design.md`](../../docs/specs/2026-05-29-design-parity-recovery-design.md)) that ports a handoff-defined surface MUST include side-by-side screenshots in its description: handoff prototype on the left (load `design/handoff/PRism.html` locally), implementation on the right, captured at the same viewport. Use the `compound-engineering:ce-demo-reel` skill for capture if available; otherwise capture via browser DevTools Device Mode at the documented viewport width (1440×900 for the canonical zones) and attach the image to the PR description.

The reviewer's pass on the side-by-side is the **parity gate**. The viewport baseline regression in [`frontend/e2e/parity-baselines.spec.ts`](../../frontend/e2e/parity-baselines.spec.ts) is the **regression gate** — it catches future drift on already-restored zones, not initial fidelity. The fixture content differs between the handoff prototype (PR `#1842` "Refactor LeaseRenewalProcessor") and the implementation side (`acme/api/123` "Calc utilities") per PR1 deferral D1; reviewers compare structure and visual treatment, not content.
```

- [ ] **Step 6.3: Format the appended paragraph with Prettier**

`npm run lint` in `frontend/` runs Prettier against `frontend/` only — it does NOT recurse into `.ai/docs/`. So formatting drift in the appended paragraph is NOT caught by the pre-push lint. Run Prettier directly against the file:

```bash
cd frontend && npx prettier --write ../.ai/docs/design-handoff.md && cd ..
```

Expected: Prettier reformats if needed, exits 0. Re-stage `.ai/docs/design-handoff.md` if it changed.

- [ ] **Step 6.4: Commit the convention update**

```bash
git add .ai/docs/design-handoff.md
git commit -m "docs(parity): document side-by-side review convention

Adds Parity PR checklist to .ai/docs/design-handoff.md. Each parity PR
includes side-by-side screenshots (handoff prototype left, implementation
right) per spec §4.1.4. Reviewer's pass on the side-by-side is the parity
gate; the viewport baseline regression spec catches future drift only.

Refs docs/specs/2026-05-29-design-parity-recovery-design.md §4.1.4"
```

---

## Task 7: Pre-push checklist + open PR

The full pre-push checklist per `.ai/docs/development-process.md`. PR1 is pure scaffolding so the cycle should be uneventful, but per memory `feedback_run_full_pre_push_checklist.md` it's run end-to-end without skipping.

**Files:** None modified — quality gate.

- [ ] **Step 7.1: Frontend lint**

```bash
cd frontend && npm run lint && cd ..
```

Expected: `ESLint` and `prettier --check` both pass. If prettier flags formatting in the new `parity-baselines.spec.ts` or `parity-fixture.ts`, run `cd frontend && npx prettier --write e2e/parity-baselines.spec.ts e2e/helpers/parity-fixture.ts && cd ..`, restage, and amend the relevant commit (per CLAUDE.md, prefer a new commit over amend unless the existing commit is the most recent and the change is mechanical — formatting is the canonical mechanical case).

- [ ] **Step 7.2: Frontend build**

```bash
cd frontend && npm run build && cd ..
```

Expected: TypeScript build succeeds (`tsc -b`) and Vite production build succeeds (output to `dist/`). No errors.

- [ ] **Step 7.3: Frontend unit tests**

```bash
cd frontend && npm test && cd ..
```

Expected: all Vitest suites pass. PR1 doesn't change any production frontend code, so no unit-test regressions are possible — but the lint can flake on the new files until prettier-formatted.

- [ ] **Step 7.4: Backend build + tests**

```bash
dotnet build --configuration Release
dotnet test --no-build --configuration Release
```

Expected: build succeeds with 0 warnings; all tests pass including the renamed `Subscribe_returns_403_when_no_cookie_session_present`. The neighboring `EventsSubscriptionsEndpointTests` cases pass unchanged.

- [ ] **Step 7.5: Playwright e2e (conditional — see README criteria)**

Per `.ai/docs/development-process.md` and the README's Pre-push checklist § 5, Playwright is conditional. PR1's edits are:
- `parity-baselines.spec.ts` (new spec, will fail on missing baselines + missing data-testids — that's the expected pre-restoration state).
- `parity-fixture.ts` (new helper, not exercised by any existing spec).
- `s4-setup.ts` (not modified in PR1; the alias is in a new file).
- Backend `EventsEndpoints.cs` (one-line behavior change — confirm dev-mode 401-redirect bug is fixed in a quick manual smoke).

Run the existing Playwright suite, **explicitly ignoring** the new `parity-baselines.spec.ts` (it's the documented-failing harness):

```bash
cd frontend && npx playwright test --grep-invert "parity baselines" && cd ..
```

Expected: existing specs pass. None regress from the 401 → 403 change because dev-mode SPA flow is the path that 401 was bouncing, and the existing E2E suite runs in `prod` project mode where `SessionTokenMiddleware` enforces auth before reaching the endpoint.

- [ ] **Step 7.6: Manual dev-mode smoke for the 401 → 403 fix**

This is the user-visible behavior the spec §1.2 calls out. Manual verification confirms the dev-mode redirect cascade is gone.

```bash
# Terminal 1
dotnet run --project PRism.Web

# Terminal 2
cd frontend && npm run dev
```

Then open `http://localhost:5173/` in a browser. Expected: lands on Inbox (cached PAT in `%LOCALAPPDATA%\PRism`). Click any PR row. Expected: lands on `/pr/{owner}/{repo}/{number}` and renders the PR Detail surface (unstyled cards — the parity work hasn't started yet, this is the pre-restoration state). The pre-fix behavior was: bouncing to `/setup` within ~50ms due to the 401 cascade.

If the user lands on `/setup` instead of PR Detail, the 401 → 403 fix didn't land. Inspect `EventsEndpoints.cs:64-70` to confirm `Status403Forbidden`. (If the implementer has no cached PAT, follow the existing Setup flow once first — out of scope for this smoke.)

After the smoke, stop both servers. (If they were started by separate terminals, just close them.)

- [ ] **Step 7.7: Open the PR via pr-autopilot**

Per memory `feedback_use_pr_autopilot.md`, default to the `pr-autopilot` skill for PR creation.

Invoke from the worktree directory:

```text
/pr-autopilot
```

The pr-autopilot skill handles preflight self-review, template-filled PR open, reviewer comment loop, CI gating, and merge sequencing. PR1 is small (4 commits across ~5 files), so its first-iteration loop should be fast — preflight may flag the parity-baselines spec's documented failures as a regression worth confirming (the spec's PR description note covers this).

The PR description should explicitly call out:

1. The four pieces (401 → 403, deferrals sidecar D1, parity-fixture helper alias, parity-baselines spec, side-by-side convention doc).
2. The deferral decision in D1 (HandoffParityFixture descoped to fallback).
3. The `parity-baselines.spec.ts` is **expected to fail** in CI for every zone whose `data-testid` selectors don't yet exist (which is all of them in PR1). The spec is included for the regression-gate scaffolding; PR2-PR8 unblocks zones as they restore.

---

## Self-review checklist

Run this on the plan with fresh eyes before handing to an implementer.

- [ ] **Spec coverage.** Each spec §4.1 sub-section maps to a task:
  - §4.1.1 Handoff-parity fixture → Task 3 (D1 fallback) + Task 4 (alias helper).
  - §4.1.2 Dev-mode 401 fix → Task 2 (including sibling 401 audit + D3).
  - §4.1.3 Viewport baseline harness → Task 5 (with D2 deferring reconciliation-panel to PR5).
  - §4.1.4 Side-by-side review convention → Task 6.
  - §4.1.5 PR1 does NOT touch existing frontend code → enforced by the file map + Task 5 creating the parity-baselines spec with selectors that PR2-PR8 will add (no PR1 JSX edits).
- [ ] **Placeholder scan.** Search for TBD, TODO, "add appropriate error handling", "fill in", "implement later". None present.
- [ ] **Type / name consistency.**
  - `setupAndOpenHandoffParityFixture` (Task 4) is called from `parity-baselines.spec.ts` (Task 5).
  - `Subscribe_returns_403_when_no_cookie_session_present` (Task 2) matches what the spec §4.1.2 names.
  - `Status403Forbidden` (Task 2) matches `HttpStatusCode.Forbidden` in the test (Task 2 Step 2.1).
- [ ] **Commit boundaries.** Four logical commits + one quality-gate commitless step. Each commit is independently revertable:
  1. 401 → 403 fix + test rename.
  2. Deferrals sidecar D1.
  3. parity-fixture.ts helper alias.
  4. parity-baselines.spec.ts.
  5. .ai/docs/design-handoff.md convention paragraph.
- [ ] **Pre-push checklist run end-to-end.** Task 7 covers all five steps from `.ai/docs/development-process.md` plus the manual dev-mode smoke that's specific to this PR's behavior change.

---

## Out-of-scope reminder

PR1 sets up scaffolding. The following are the explicitly-listed PR1-NOT-doing items per spec §4.1.5:

- No JSX className renames.
- No new `.module.css` files.
- No additions of `data-testid` attributes to production components. (PR2-PR8 each add their own as part of the slice's JSX touch.)
- No `HandoffParityFixture` C# class. (Descoped to D1 fallback.)
- No `POST /test/load-handoff-parity-fixture` endpoint. (Descoped to D1 fallback.)

If any of those land in PR1, they're scope creep — surface to the user before commit.

---

## After PR1 merges

Each subsequent PR (PR2-PR9) gets its own `superpowers:brainstorming` → `superpowers:writing-plans` cycle per the user's locked-in choice (option A, 2026-05-29). The spec §4.2-§4.9 outlines per-PR scope; brainstorming refines the per-PR details with the implementer's signals from prior PRs in hand.

PR2 (PR Detail chrome) is the natural next step. Its `data-testid` additions for `pr-header` etc. unblock the corresponding `parity-baselines.spec.ts` zones.
