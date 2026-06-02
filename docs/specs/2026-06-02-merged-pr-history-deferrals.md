---
source-doc: docs/specs/2026-06-02-merged-pr-history-design.md
created: 2026-06-02
last-updated: 2026-06-02
status: open
revisions:
  - 2026-06-02: PR3 implementation — recorded all PR3-time deferrals (8 forward-looking items) and implementation-time decisions (5 deviations from the plan noted during the read-only detail audit + gap closure tasks 12–17).
---

# Deferrals — Merged / closed PR history spec

Items deliberately not landing in this slice (PR1 / PR2 / PR3). Each entry names its source, the rationale, and the trigger that should reopen the decision.

The three PRs in this slice: **PR1** (#103 — backend `recently-closed` inbox section + `/api/preferences` key + config patch), **PR2** (#105 — frontend section polish + Settings toggle), **PR3** (this PR — read-only detail gaps: Pr-contract `mergedAt`/`closedAt`, merged/closed header label, read-only Drafts tab, live merge/close transition banner with cross-tier close-state wiring, primary + cross-iteration diff-unavailable 422 mapping, read-only audit e2e).

---

## Forward-looking deferrals

### [Defer] Remote pending-review courtesy cleanup on done PRs

- **Source:** Spec § 5.2.2 (explicit deferral, round-2 adversarial reversal); carries forward the S4 deferral in [`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md) "[Defer] Bulk-discard + deletePullRequestReview cleanup" (originally → S5; S5 did not pick it up for closed-PR cases).
- **Reason:** A non-null `pendingReviewId` (a GitHub PENDING-review shell from S5) on a now-closed PR is un-submittable cruft on github.com. The round-2 adversarial review reversed the original proposal: `DeletePendingReviewAsync` is **not** best-effort — it throws `GitHubGraphQLException` on any error, so calling it on a closed PR's shell (the case most likely to 404 / already-be-gone) would throw on the read path and break the local locked panel it was meant to coexist with. Worse, with no idempotency guard, an `isClosed`-briefly-wrong race could delete a pending review on a still-open PR — real data loss. The benefit (tidying a shell invisible inside PRism) does not serve any of the three jobs this slice serves. When eventually built it **must** be: fire-and-forget (swallow `GitHubGraphQLException` / `HttpRequestException` / `RateLimitExceededException`, decoupled from render — `DeletePendingReviewAsync` currently throws on error, breaking the read path), one-shot idempotent (per-session "already attempted" flag — the local `pendingReviewId` is never cleared so a naive per-load trigger re-fires forever), gated on an authoritative done-state (the same confirmed `prState→done` signal now wired in Task 15, never a transient/optimistic read), cross-tab staleness addressed or declared out of scope.
- **Revisit when:** Tidying github.com pending-review shells becomes a real dogfooding need.

### [Defer] `review-requested:@me is:closed` third closed-history sub-query

- **Source:** Spec § 3.1 (explicit deferral, logged coverage gap).
- **Reason:** The closed-history branch runs two searches (`involves:@me`, `reviewed-by:@me`); a reviewer who was requested but never submitted a review on a since-closed PR is not captured by either. The slice ships this gap knowingly because (i) whether GitHub still returns a review-request after close is an untested behavior assumption — closing may dismiss the request, making the query dead weight; (ii) the requested-but-totally-passive case is the weakest variant of job (c). Adding it is a one-line union extension once the behavior is verified live.
- **Revisit when:** Dogfooding shows requested-but-unreviewed closed PRs are missed (pending live verification that `review-requested:@me is:closed` returns rows not already covered by `involves`/`reviewed-by`).

### [Defer] `mergedBy{login}` actor clause on the header label

- **Source:** Spec § 5.2.1 and § 2 (explicit out-of-scope decision).
- **Reason:** "Merged ⟨when⟩" is complete information for every job this slice serves. Adding the "by ⟨login⟩" clause needs a new `mergedBy{login}` GraphQL field added to the PR detail query plus threading through `Pr` contract, `types.ts`, and `PrHeader` for a display-only nicety.
- **Revisit when:** Users want to see who merged / closed the PR.

### [Defer] Real-flow mid-view-merge transition Playwright e2e

- **Source:** Spec § 8 (explicit deferral, line 220).
- **Reason:** The static read-only audit (`frontend/e2e/recently-closed-readonly.spec.ts`, Task 16b) covers the done-PR read experience. The live transition (open→done while watching — `BannerTransition` appears) is unit/integration-tested (`PrDetailPage.transition.test.tsx` + the `ActivePrPoller` emit tests) but not end-to-end against real GitHub. A mid-session-merging sandbox PR (consistent with the PR #58 / #66 staging pattern) is needed.
- **Revisit when:** A mid-session-merging sandbox PR is staged.

### [Defer] `HistoryWindowDays` (14) / `MaxHistoryRows` (30) config promotion

- **Source:** Spec § 2 and § 3 (explicit hardcoded-constants decision).
- **Reason:** Both values live in `InboxHistoryConstants` as named constants, not config keys. `ConfigStore.PatchAsync` has no Int field type, so promoting them to user-configurable knobs requires disproportionate plumbing for values no PoC user will tune.
- **Revisit when:** An Int config field type exists in `ConfigStore.PatchAsync`.

### [Defer] Distinct primary-vs-cross-iteration "diff unavailable" wording

- **Source:** Task 16a implementation (spec § 5.1, § 7).
- **Reason:** Task 16a maps both the primary (base..head `pulls/{n}/files` 404/410) and cross-iteration (3-dot compare `RangeUnreachableException`) paths to one typed 422 (`/diff/range-unreachable`) and one frontend message ("the commit range is no longer reachable on GitHub"). Distinguishing "this older iteration's snapshot is gone" from "the current diff is unavailable" would require the endpoint to encode which range failed — a separate error type or field extension.
- **Revisit when:** Users are confused about which range failed.

### [Defer] Harder composer suppression on done PRs

- **Source:** Task 14 / PR3 detail-view audit.
- **Reason:** On a done PR the inline-comment and PR-root composer affordances still open (they are gated on cross-tab `presence.readOnly`, not `prState`); persistence is hard-blocked (`useComposerAutoSave` early-returns when `prState !== 'open'`) and a "PR closed/merged — text not saved" banner shows. Hiding the affordance entirely on done PRs is a UX cleanup that is not load-bearing for the three jobs: users who open a composer see an immediate error banner and cannot save.
- **Revisit when:** Dogfooding shows an openable-but-non-saving composer on a done PR confuses users.

### [Defer] Transition/refresh banner visible to a passive cross-tab read-only viewer

- **Source:** Task 15b / PR3 detail-view audit. Pre-existing `BannerRefresh` policy gap, now mirrored by `BannerTransition`.
- **Reason:** `BannerTransition` (like the pre-existing `BannerRefresh`) stays visible with an active Reload button even for a passive cross-tab viewer (`presence.readOnly` true); `handleReload` already no-ops the reconcile leg when `readOnly`. The Reload in this state is harmless (refreshes the read-only view) but the banner's language ("Reload to read-only view") is slightly misleading since a passive viewer is already in read-only mode — the language is directed at an active reviewer. This mirrors the pre-existing `BannerRefresh` gap rather than introducing new behavior.
- **Revisit when:** Cross-tab dogfooding shows the passive viewer's Reload causes confusion.

---

## Implementation-time decisions (PR3 deviations from the plan)

### [Decision] Task 15 expanded from FE-only to cross-tier (user-approved, "full fidelity")

- **Source:** Task 15 implementation — plan scoped it as FE-only (`BannerTransition.tsx` + `PrDetailPage.tsx`).
- **Reason:** The `pr-updated` SSE event carried no close-state (`ActivePrUpdatedWire(PrRef, NewHeadSha, HeadShaChanged, CommentCountDelta)`), and on a clean merge the poller emitted nothing (head-sha and comment count unchanged) — making the spec's live banner unimplementable FE-only. User approved the backend extension. **Backend (Task 15a):** `GitHubReviewService.PollActivePrAsync` reads `merged_at` and normalizes `ActivePrPollSnapshot.PrState` to lowercase 3-value (`open`/`closed`/`merged`); `ActivePrUpdated` event + `ActivePrUpdatedWire` + `EmitPrUpdatedRequest` carry `IsMerged`/`IsClosed` (camelCase on the wire); `ActivePrPoller` tracks `LastPrState` and emits on an open→done state transition even when head/comment are unchanged. **Frontend (Task 15b):** `useActivePrUpdates` latches `isMerged`/`isClosed`; `PrDetailPage` shows `BannerTransition` (superseding `BannerRefresh`) when `(updates.isMerged || updates.isClosed) && !(data.pr.isMerged || data.pr.isClosed)` — i.e. the SSE says done but the loaded detail still shows open (self-clears after Reload).

### [Decision] Task 16a finding — cross-iteration `RangeUnreachableException` path was NOT graceful (plan premise false)

- **Source:** Task 16a implementation — plan assumed the S3 handler already mapped it to a user-visible `ProblemDetails`.
- **Reason:** The `RangeUnreachableException` was an unhandled 500; `RangeUnreachableException.cs`'s doc-comment and a test comment FALSELY asserted an endpoint mapping existed (grep: zero `/diff/range-unreachable` occurrences in the codebase). Fixed: the `/api/pr/.../diff` endpoint now catches `RangeUnreachableException` → `Results.Problem(type:"/diff/range-unreachable", statusCode:422)`, covering both the primary (base..head, now throws on 404/410) and cross-iteration (3-dot compare, 404/410) paths; FE `FilesTab` renders a typed "diff unavailable" message for that 422; the lying doc-comment and test comment were corrected.

### [Decision] Task 14 — `readOnly = prState !== 'open' || contextReadOnly`

- **Source:** Task 14 implementation — plan said `readOnly={prState !== 'open'}`.
- **Reason:** Implementation OR-ed in the outlet's cross-tab `presence.readOnly`, since letting this tab Edit/Delete drafts while a peer tab owns the session would race (FilesTab already treats both as suppressors). Closes a latent cross-tab gap.

### [Decision] `formatAge` extracted to `frontend/src/utils/relativeTime.ts`

- **Source:** Task 13 implementation — `formatAge` was private in `InboxRow.tsx`.
- **Reason:** The function was needed by both `InboxRow` (existing) and the new `PrHeader` status label for merged/closed timestamp display. Extracted to a shared util rather than duplicating.

### [Decision] Test-hook corrections (Tasks 15a / 16b)

- **Source:** Tasks 15a and 16b implementation.
- **Reason:** Two test-helper bugs surfaced: `FakeReviewBackingStore.IsClosed` was `!= "OPEN"` (returned `true` for MERGED — now `== "CLOSED"`); `FakePrReader.SetPrState` now derives `mergedAt`/`closedAt` timestamps so the header label renders correctly in e2e (merged → both timestamps, closed-unmerged → `ClosedAt` only).
