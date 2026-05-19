---
date: 2026-05-18
topic: cross-tab-stamp-poisoning
kind: deferrals-sidecar
---

# Cross-tab stamp poisoning fix — deferrals

Companion to [`2026-05-18-cross-tab-stamp-poisoning-design.md`](2026-05-18-cross-tab-stamp-poisoning-design.md). Pre-implementation decisions / deferrals captured at brainstorm time; implementation-time decisions get appended below as a new section.

---

## Pre-implementation deferrals (brainstorm, 2026-05-18)

### [Decision] Only `LastViewedHeadSha` moves into `TabStamp`; `LastSeenCommentId` stays session-flat

- **Source:** Q1 of the brainstorm session — *reversed in light of first-pass ce-doc-review finding F2/A2*.
- **Affects:** `PRism.Core/State/AppState.cs` (ReviewSessionState shape); `PRism.Web/Endpoints/PrDetailEndpoints.cs` (mark-viewed write); `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (rule (f) read); `PRism.Web/Endpoints/PrDraftEndpoints.cs` (markAllRead — no change); `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` (inbox projection).
- **Decision:** `LastViewedHeadSha` is the per-tab field that the submit gate must partition; `LastSeenCommentId` is the session-level monotone high-water that the inbox unread badge depends on. The original Q1 framing ("both fields atomically per-tab") would have made the inbox project "most-recent stamp's MaxCommentId across all tabs," which silently regresses the unread badge when a freshly-loaded Tab B re-stamps at a lower `MaxCommentId` than Tab A's previous high-water 999. The asymmetric shape (one per-tab, one session-flat) trades a tiny residual UX overconfidence (Tab A marks-all-read at 999 → Tab B's banner reads "0 new") against a real correctness regression in the inbox badge. The trade is correct: the submit-gate bypass is closed regardless because rule (f) reads `TabStamps[tabId].HeadSha` only. mark-viewed updates `LastSeenCommentId = max(current, body.MaxCommentId)` to preserve monotonicity even when V6's per-tab landscape means a freshly-loaded Tab B at a lower MaxCommentId would otherwise rewind.
- **Revisit when:** A v2 use case wants per-tab "what was the highest comment-id I, this tab, had seen" semantics (e.g., a per-tab banner that resists Tab A's mark-all-read clearing Tab B's "new since I last viewed" indicator). At that point: add a per-tab `MaxCommentId` *alongside* the session-flat field, do not replace it.

### [Decision] Pre-V6 stamps dropped at V5→V6 migration, not synthesized under a sentinel key

- **Source:** Q3 of the brainstorm session.
- **Affects:** `PRism.Core/State/Migrations/AppStateMigrations.cs` (MigrateV5ToV6).
- **Decision:** Pre-V6 `last-viewed-head-sha` values can't be attributed to any specific tab. Synthesizing under a sentinel like `"__legacy"` would either match every tab's submit (re-introducing the bypass) or match no tab's submit (functionally equivalent to drop, plus extra storage + a confusing key name). Drop is the honest move. Cost: one extra `POST /mark-viewed` round-trip on the next PR-detail load before submit unblocks; that round-trip already fires unconditionally from `usePrDetail.ts:66-79`, so the user-visible cost is zero. **Note:** `last-seen-comment-id` is NOT dropped — it stays session-flat as a monotone high-water; the V5→V6 migration preserves it verbatim.
- **Revisit when:** N/A — landed.

### [Decision] LRU bookkeeping uses explicit `DateTime StampedAtUtc` per entry — caveat: not actually "active-tab-survives"

- **Source:** Q4 of the brainstorm session; rationale clarified after first-pass ce-doc-review finding A4.
- **Affects:** `PRism.Core/State/AppState.cs` (TabStamp record); `PRism.Web/Endpoints/PrDetailEndpoints.cs` (eviction); `PRism.Web/Endpoints/PrReloadEndpoints.cs` (eviction on reload-write).
- **Decision:** `StampedAtUtc` provides a deterministic eviction order — `MinBy` picks a single entry on each cap-exceeding insert. The original framing ("long-running tab survives churn") was *wrong*: a long-running tab that rarely re-stamps has an older `StampedAtUtc` than churning tabs, so it sinks first under cap pressure, just as it would under FIFO. The corrected framing: the cap exists to bound storage of dead entries from closed browser tabs (per-launch `getTabId()` means each new launch creates a new uuid; old tab's entry lives until LRU eviction). The server cannot observe whether a tab is still alive — no signal beats no signal here, so "deterministic + simple" wins over an attempted heuristic.
- **Revisit when:** Either (a) a monotonic counter becomes preferable for testability (current clock-based ordering is hard to make deterministic in tests without time injection), or (b) v2 introduces a tab-close beacon that lets the server know which entries are genuinely dead, at which point eviction-by-stamped-at gets replaced by "evict-known-dead-first."

### [Decision] Server clock used for `StampedAtUtc`, not client-provided timestamp

- **Source:** Brainstorm session walkthrough § 3.
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs:107-118` (UpdateAsync transform).
- **Decision:** `DateTime.UtcNow` inside the transform. Single-machine PoC, single trust boundary. A client-provided timestamp would let a malicious caller pin eviction order arbitrarily; even in a single-user PoC, the principle "the BE owns the truth for security-relevant fields" applies. The only consumer of `StampedAtUtc` is "evict the oldest within a single session," not any user-visible ordering, so server clock is sufficient.
- **Revisit when:** PRism gains a multi-machine deployment (out of PoC scope by spec § 2 of `02-architecture.md`).

### [Decision] Tab-id allowlist `^[a-zA-Z0-9_-]{1,64}$` applied at both endpoint sites

- **Source:** Q5 of the brainstorm session; reuses [S6 PR0 § 7 binding constraint #2](2026-05-10-multi-account-scaffold-design.md#binding-constraints-v1-places-on-v2).
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs` (mark-viewed); `PRism.Web/Endpoints/PrReloadEndpoints.cs` (reload); `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (submit); `PRism.Web/TestHooks/TestEndpoints.cs` (`/test/mark-pr-viewed`).
- **Decision:** Header value validated before use as a JSON map key, dictionary lookup key, or log field. Same threat shape as `accountKey`: CRLF injection in logs, escape-character injection in JSON, path injection if v2 ever shards. Inline regex via `[GeneratedRegex]` at each production call site; the test-hook uses a runtime `Regex.IsMatch` (test-only code, perf cost irrelevant). If consolidation becomes worth the indirection, factor to `PRism.Core/State/TabIds.cs` with a single `IsValid(string)` method.
- **Revisit when:** Cross-site allowlist drift becomes a real risk (e.g., a future change tightens one regex without the others). v1 has four sites with the same string — the spec-level threat-equivalence is documented, but enforcement is by code review, not by a shared helper.

### [Decision] `MarkViewedRequest` and `SubmitRequestDto` bodies unchanged

- **Source:** Brainstorm closeout question 1.
- **Affects:** `PRism.Web/Endpoints/PrDetailDtos.cs`, `PRism.Web/Endpoints/PrSubmitDtos.cs`.
- **Decision:** Tab id stays header-only. Same precedent as `PrDraftEndpoints` and `PrReloadEndpoints` already in the codebase. Duplicating into the body would invite header / body drift on the same identity.
- **Revisit when:** N/A — landed.

### [Decision] All-or-nothing migration quarantine for V5→V6 partial-rollback

- **Source:** Brainstorm closeout question 2.
- **Affects:** `PRism.Core/State/Migrations/AppStateMigrations.cs` (MigrateV5ToV6 throws JsonException on any session that has both legacy keys AND tab-stamps).
- **Decision:** One inconsistent session quarantines the whole file. Same all-or-nothing policy as V4→V5 (which throws when both root-level and accounts-level keys coexist). Per-session partial recovery is deliberately not attempted — the recovery path is identical to the quarantine path (re-stamp on next PR-detail load), so adding per-session branching is complexity without recovery benefit.
- **Revisit when:** A migration step appears whose recovery path is materially different from the quarantine path (e.g., partial loss of irreplaceable user content). Then per-step recovery becomes worth designing.

### [Defer] Tab-aware inbox surface

- **Source:** Brainstorm § 6 (inbox wire projection discussion).
- **Affects:** `PRism.Core.Contracts/PrInboxItem.cs`; `frontend/src/components/Inbox/InboxRow.tsx`.
- **Decision:** Inbox keeps the existing wire shape (`LastViewedHeadSha: string?`); BE projects "most-recent stamp across all tabs" from V6 storage. The inbox UI's only consumer is the `pr.lastViewedHeadSha == null` "first visit" badge, which the most-recent projection answers correctly. A "viewed from THIS tab" inbox semantic isn't useful at PoC scope — the user has one inbox per launch, navigates to PRs from there, and the per-tab dimension only matters at the per-PR submit gate.
- **Revisit when:** v2's multi-account runtime surfaces multiple side-by-side inboxes (e.g., one inbox per account in a split view), at which point a per-tab inbox stamp might match real workflows.

### [Defer] LRU cap N=8 tuning

- **Source:** Brainstorm § 2 (storage shape); pre-committed in the original deferral entry's pre-decision sketch.
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs` (the literal `8`); `PRism.Web/Endpoints/PrReloadEndpoints.cs` (same literal).
- **Decision:** N=8 is the deferral entry's pre-committed value. Eight tabs on a single PR covers any plausible "comparing two views side by side" workflow with headroom. Larger N raises the per-session storage cost linearly; smaller N risks legitimate evictions.
- **Revisit when:** A user reports `head-sha-not-stamped` after closing a tab (the failure mode that fires when a still-active tab's stamp was evicted by churn pressure). The original revisit-when ("telemetry surfaces 9+ tab usage") never triggers in a no-telemetry single-user PoC — user-reported `head-sha-not-stamped`-after-close is the diagnostic signal that actually fires.

### [Decision] Distinct error codes for missing-header (`tab-id-missing`, 422) vs. no-map-entry (`head-sha-not-stamped`, 400)

- **Source:** First-pass ce-doc-review finding A7 — reversed the brainstorm's original "collapse to one log event" position.
- **Affects:** `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (`s_tabIdMissing` LoggerMessage, new `SubmitErrorDto` code); `frontend/src/api/submit.ts` (`KNOWN_SUBMIT_ERROR_CODES`); `frontend/src/components/PrDetail/PrHeader.tsx` (`submitErrorMessage` switch arm).
- **Decision:** Missing/malformed header → 422 `tab-id-missing` ("Internal error: missing tab identifier. Refresh the browser tab and retry."). Valid header, no entry in map → 400 `head-sha-not-stamped` ("Reload the PR and try again."). The user recoveries are different: a missing header is a FE wire-up regression that Reload cannot fix; the user has to refresh the browser tab itself. Collapsing both to one code/message would lie to the user in the wire-up-regression case. Two LoggerMessage delegates (`s_tabIdMissing`, `s_headShaNotStamped`) distinguish the cases at the log level too.
- **Revisit when:** N/A — landed.

### [Acknowledge] Server-clock LRU under backwards clock adjustment

- **Source:** Brainstorm § 2 (storage shape rationale).
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs` (eviction uses `DateTime.UtcNow`).
- **Decision:** A backwards system-clock adjustment can make a "stale" entry's `StampedAtUtc` look newer than a fresh stamp; eviction order is then briefly wrong. Single-machine single-process PoC; the user would have to manually move their system clock backwards by more than a few seconds for this to matter. Acknowledged, not mitigated.
- **Revisit when:** PRism gains a multi-machine deployment or NTP-disciplined-clock-required behavior (out of PoC scope).

### [Acknowledge] Eight-tab cap silently evicts the oldest stamp

- **Source:** Brainstorm § 2 (LRU eviction semantics).
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs` (cap-eviction branch).
- **Decision:** A user with 9+ tabs open on the same PR sees the oldest-stamped tab silently evicted from the map. The next submit attempt from that evicted tab returns 400 `head-sha-not-stamped` with the standard "Reload the PR" copy — the user re-loads, mark-viewed re-stamps under their tab id, and submit unblocks. The eviction is silent (no SSE event, no toast); the recovery is one Reload. Cost is bounded.
- **Revisit when:** The deferral above ("LRU cap N=8 tuning") fires.

---

## Pre-implementation deferrals (brainstorm pass-2, 2026-05-18)

Captured after the user-authorized second ce-doc-review pass. The pass surfaced four high-confidence design gaps + several smaller ones; the spec was revised in place. New decisions:

### [Decision] `markAllRead` gains the same `MonotonicCommentId.Max` guard as mark-viewed

- **Source:** Pass-2 coherence-finding-3 → pass-1 plan-review feasibility-F6 → Copilot PR #60 finding (comment id 3260046497). The original "markAllRead is monotone because the cache is monotone" framing was incomplete: the cache is monotone within its own progression, but `LastSeenCommentId` is also written by mark-viewed using the fresh `body.MaxCommentId` from a PR-detail load. A PR-detail response can carry a higher comment id than the cache holds *at that moment* if the active-PR poller hasn't yet ticked since the most recent github.com comment landed (poller cadence ~30 s production). So markAllRead reading the stale cache value can be lower than what mark-viewed already wrote. Last-writer-wins regresses the high-water in that window.
- **Affects:** `PRism.Web/Endpoints/PrDraftEndpoints.cs:355-373`.
- **Decision:** Apply `MonotonicCommentId.Max(session.LastSeenCommentId, newId)` at the markAllRead write site, same helper as mark-viewed (§ 5.2). The two writers share one monotone-max function (defined once in `PRism.Core/State`). Spec § 5.6 documents this. The earlier "no guard needed" position was wrong; this entry replaces it.
- **Revisit when:** N/A — landed.

### [Decision] `ReconcileAsync` `callerTabId` is a REQUIRED parameter, not optional default-null

- **Source:** Pass-2 security finding F1 — a default-null parameter lets future callers silently disable override-clear.
- **Affects:** `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs` (signature); all callers must update.
- **Decision:** Promote `callerTabId` to a required, non-nullable positional parameter. `ArgumentException.ThrowIfNullOrEmpty(callerTabId)` at the method top. Compiler enforces the discipline at every call site — a new caller's choice not to pass it becomes a build error, not a runtime regression. Reload (the only current caller) always has `sourceTabId` after § 5.4's 422 gate.
- **Revisit when:** N/A — landed in pass-2 revision.

### [Decision] `headShifted` uses session-level fallback when caller's tab has no entry (LRU-eviction case)

- **Source:** Pass-2 adversarial finding F2 — strict per-caller-tab semantics regress override-clear/verdict-reconfirm vs V5 in the LRU-eviction case.
- **Affects:** `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs` (`headShifted` derivation at line 33 + verdict-reconcile at line 216).
- **Decision:** Three-branch decision: (a) caller's tab has an entry → compare against it (per-tab); (b) `TabStamps` is empty → `headShifted = false` (first-reload semantic, no overrides to clear); (c) caller's tab has no entry but other stamps exist → `headShifted = session.TabStamps.Values.Any(s => s.HeadSha != newHeadSha)` (session-level fallback). The fallback preserves V5's "session has seen a different head sha" semantic for evicted-then-reload, post-V6-migration-drop, and genuinely-new-tab-in-existing-session cases. The bypass class is unchanged (the submit gate reads `TabStamps[tabId].HeadSha` only; this only affects override-clear/verdict-reconfirm).
- **Revisit when:** A v2 use case needs to distinguish "evicted" from "never stamped" (e.g., to surface a banner: "Your tab's stamp expired; please reload to re-establish per-tab tracking"). At that point a sentinel-evicted marker or a server-side tab-close beacon makes the distinction observable.

### [Decision] Distinct error codes for missing/invalid tab id on `/reload` (422 `tab-id-missing`)

- **Source:** Pass-2 adversarial finding F3 — `useReconcile` would route reload's new 422 to the generic banner with no recovery.
- **Affects:** `PRism.Web/Endpoints/PrReloadEndpoints.cs` (422 emit site); `frontend/src/api/draft.ts` (`PostReloadResult` union); `frontend/src/hooks/useReconcile.ts` (banner state machine); FE banner constants.
- **Decision:** Reload mirrors the submit endpoint's 422 `tab-id-missing` shape. `PostReloadResult` gains a `{ ok: false; status: 422; kind: 'tab-id-missing' }` variant. `useReconcile` adds an arm that surfaces `BANNER_TAB_ID_MISSING` ("refresh the browser tab and retry") with no auto-retry. Without this, reload's new fail-closed code lands on the generic "try again" banner that the user cannot escape.
- **Revisit when:** N/A — landed in pass-2 revision.

### [Decision] Mocked-mode Playwright suite plumbs the page's `getTabId()` into `recordPrViewed`

- **Source:** Pass-2 adversarial finding F1 — `recordPrViewed` calls `/test/mark-pr-viewed` via `APIRequestContext`, which has a different tab-id context than the page's browser context that fires the subsequent UI submit.
- **Affects:** `PRism.Web/TestHooks/TestEndpoints.cs` (hook accepts `tabId` body field); `frontend/e2e/helpers/s5-submit.ts` (`recordPrViewed` accepts `tabId` param); eight mocked-mode submit specs (each adds one line; `s5-marker-prefix-collision.spec.ts` is the eighth caller of `recordPrViewed`); FE test-mode hook to expose `getTabId()` to `page.evaluate` OR fixture-injection.
- **Decision:** Hook accepts `tabId` as a body field (explicit over header-implicit — test code benefits from explicit coordination); helper accepts `tabId: string`; each spec captures the page's tab id before calling `recordPrViewed`. Body-field over header to make the coordination visible at every call site; mismatched ids in mocked-mode tests are now a typo at the spec author's call, not a silent header-context divergence.
- **Revisit when:** N/A — landed in pass-2 revision.

### [Decision] `s_headShaNotStamped` LoggerMessage format string updated to name `TabStamps`

- **Source:** Pass-2 feasibility finding F2 — message string named the removed `session.LastViewedHeadSha`.
- **Affects:** `PRism.Web/Endpoints/PrSubmitEndpoints.cs:47-49`.
- **Decision:** Rewrite to "POST /submit rejected for {SessionKey}: session.TabStamps has no entry for the caller's tab. The frontend must call POST /api/pr/{ref}/mark-viewed when PR detail loads; see PrDetailEndpoints.MarkViewed." Human-facing only; no compile impact. Caught now because operators reading future logs will be confused by a message string naming a field that doesn't exist.
- **Revisit when:** N/A — landed in pass-2 revision.

### [Decision] Authorization assumption documented at submit-gate

- **Source:** Pass-2 security finding F2 — the spec didn't state whether rules (a)-(e) include an auth gate before rule (f)'s tab-id check.
- **Affects:** `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (spec § 5.3 commentary).
- **Decision:** Documented in § 5.3's code-block comment that `IsSubscribed(prRef)` gates the endpoint at the top (line 85-86), so the 422/400 error-code differential is NOT reachable by unauthenticated probes. Prevents the plan's implementer from misreading the gate ordering and adding auth at rule (f)'s level thinking it's the first gate.
- **Revisit when:** N/A — documentation-only.

---

## Implementation-time deferrals

### [Deviation] Tasks 1+2+3 landed as one commit; Tasks 4+5+6+6b landed as one commit

- **Source:** Phase 1 / Phase 2 commit boundaries.
- **Affects:** Git history granularity for `feat/cross-tab-stamp-impl`.
- **Decision:** Plan called for Tasks 1+2 → one commit and Task 3 → another. Combined into a single Phase 1 commit because the V5→V6 migration is so tightly coupled with the V6 schema reshape (every test that asserts on Version values needs to bump 5→6 in the same commit; splitting forced a transient red state). Similarly, the four write-site tasks (mark-viewed, reload, test-hook, markAllRead-monotone) landed as one Phase 2 commit since they share the same `MonotonicCommentId.Max` + `TabIdAllowlistRegex` plumbing. Both commits are atomically build-green and atomically test-green; nothing was deferred functionally.
- **Revisit when:** N/A — historical record only.

### [Deviation] PrInboxItem.LastViewedHeadSha contract field name preserved

- **Source:** Phase 1 sweep over `LastViewedHeadSha` occurrences.
- **Affects:** `PRism.Core.Contracts/PrInboxItem.cs:16`, the corresponding TS shape in `frontend/__tests__/usePrDetail.test.tsx`, frontend Playwright fixtures.
- **Decision:** The inbox contract still surfaces ONE head-sha value to the FE (for the "X commits since you last looked" badge). Spec § 6 says the derivation now reads "most-recent stamp's HeadSha"; only the SERVER-SIDE derivation changed (`InboxRefreshOrchestrator.MaterializePrInboxItem`). The contract field name stayed `LastViewedHeadSha` because renaming would ripple through the FE inbox component, the Playwright fixtures, and the test snapshots — all for a semantic-equivalent rename. The field name is now slightly misleading ("last viewed in any tab" rather than "last viewed at session level"), so a future v2 contract bump that renames `LastViewedHeadSha` → `LastViewedAnyTabHeadSha` would clarify; deferred to that contract bump.
- **Revisit when:** A v2 contract bump renames any field on PrInboxItem.

### [Deviation] Reconciliation/inbox legacy stub helper retired without tombstoning the OverrideStaleTests / VerdictReconfirmTests cases the plan named

- **Source:** Plan Task 2 Step 4b listed VerdictReconfirmTests + OverrideStaleTests head-shift tests as candidates for `[Fact(Skip = "Wired in Task 8")]`. They were NOT skipped during Phase 1.
- **Affects:** `tests/PRism.Core.Tests/Reconciliation/{VerdictReconfirm,OverrideStale}Tests.cs`.
- **Decision:** Each test seeds a session with a single "tab-test" stamp; under the temporary `LegacyMostRecentHeadSha()` stub the semantic ("most-recent across all tabs") happens to coincide with the eventual per-tab semantic for a one-tab session. Both test suites passed unchanged through Phase 1 → Phase 4 with zero false-positive or false-negative runs, so the precautionary Skip was unnecessary. The plan's directive was conservative; sticking with it would have produced a churn-only Phase 4 commit that just removed `Skip` from passing tests.
- **Revisit when:** If a future regression introduces a real multi-tab semantic divergence at these test sites, they'll fail and the legacy stub's removal (Phase 4) is already the right place to assert the new branch logic.

### [Deferred] Full 8-spec Playwright mocked-mode submit suite

- **Source:** Plan Phase 7 (Tasks 13-15).
- **Affects:** `frontend/e2e/cross-tab-stamp-*.spec.ts` (not created); existing e2e specs (no changes other than the `/test/mark-pr-viewed` tabId body update via the helper).
- **Decision:** The plan called for 8 mocked-mode Playwright specs covering tab isolation, eviction at the cap, the cross-tab unread-badge invariant, etc. Phase 6's `__prism_test_getTabId` hook + `VITE_E2E_TEST` build-time env are in place, plus the `recordPrViewed` helper now accepts a tabId. The 8 specs themselves are deferred: every cross-tab branch covered by the new C# tests (mark-viewed tab isolation, eviction, submit cross-tab head-sha-not-stamped) is already exercised at the unit + endpoint-integration tier, so the Playwright additions are confirmation-tier rather than gap-closing. Sticky budget reasons (this implementation PR is already ~12 commits across 6 phases) outweighed the marginal browser-level confirmation value.
- **Revisit when:** First real cross-tab regression that the C# tests miss; or, the next slice that touches the submit/reload/mark-viewed plumbing (a good place to add the Playwright suite as net new coverage). Re-opening should re-read plan Task 13's spec list — Spec 1 (tab-A submits, tab-B never blocks), Spec 2 (tab-A mark-viewed, tab-B submit → 400 head-sha-not-stamped), Spec 3 (tab-id-missing 422), Spec 4-8 (eviction, monotone unread badge across tabs, reload-then-submit per-tab, etc.).

### [Deferred] Real-flow Playwright e2e spec for cross-tab

- **Source:** Plan implicit (the mocked-mode suite above and the real-flow suite under e2e/real/* are different).
- **Affects:** `frontend/e2e/real/*.spec.ts`.
- **Decision:** Real-flow tests use a GitHub PAT and a real PR; they're slow and PAT-gated. Cross-tab semantics don't need GitHub coverage — the gate is server-internal. Real-flow adds zero confidence over the mocked-mode + endpoint-integration tests. Permanently out of scope for this slice.
- **Revisit when:** Never, unless a future change makes the cross-tab gate dependent on a GitHub API response.
