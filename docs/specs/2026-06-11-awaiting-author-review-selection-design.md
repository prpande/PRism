---
title: Awaiting-author filter — review-selection semantics (null commit_id + sort-order-robust)
issue: 367
origin: none
type: fix
status: design
tier: T3-hands-off
area: backend
---

# Awaiting-author filter: review-selection semantics

## Problem

`GitHubAwaitingAuthorFilter.FetchLastReviewShaAsync` decides, for each candidate PR,
the head SHA the viewer most-recently reviewed at. The inbox "awaiting-author" /
"Needs re-review" section keeps a PR when that reviewed SHA differs from the current
head (`best != null && best != headSha`) — i.e. the viewer reviewed, then the author
pushed.

Issue #322 (U2) fixed reviews **pagination** (Link-walk every page instead of reading
only page 1) but deliberately left the **selection rule** unchanged. Two pre-existing
properties remain:

1. **Null `commit_id` on the latest review.** The current rule
   (`if (sha != null) best = sha;`, `GitHubAwaitingAuthorFilter.cs:105`) keeps the
   *last-in-array* viewer review that has a non-null `commit_id`. A viewer review with
   `commit_id: null` — in practice a still-PENDING (unsubmitted) draft — is skipped, so
   `best` falls back to the most recent non-null review. "Last non-null viewer
   `commit_id`" is not strictly "the latest viewer review."

2. **Ordering is empirical, not contractual.** "Last in the array = most recent" relies
   on GitHub returning reviews in ascending order. `GET /pulls/{n}/reviews` exposes no
   `sort`/`direction` params and documents no sort order (empirically by monotonic
   review `id`). The #322 page-cap warning is the only safety net.

Neither is a regression — this is the same selection behavior as before #322. This slice
makes the selection **deliberate and ordering-robust**.

**Why now.** No user-visible misfire is on record today: GitHub's de-facto ascending
order makes the ordering property empirically inert and the null-`commit_id` case rare.
This is low-cost robustness — it converts an empirical, undocumented dependency on
GitHub's return order into a contractual `submitted_at`-max rule, removing a latent
correctness cliff (a future GitHub ordering change, or a downstream change that relies on
this selection) before it can bite. It also lands cleanly while the #322 context is warm.

## Key insight

On the GitHub REST API, a review's `submitted_at` is non-null **exactly when** the
review has been submitted. A PENDING review (the viewer's own unsubmitted draft) has
`submitted_at: null`, and that pending draft is precisely the null-`commit_id` case
property (1) names. So a single eligibility gate resolves both halves of the issue.

Note the JSON shape: a pending review emits `submitted_at` as a JSON `null` — the
property is *present* with `JsonValueKind.Null`, not absent. The eligibility check must
therefore test the **value kind** (`JsonValueKind.String`), not merely
`TryGetProperty`-presence. Calling `GetDateTimeOffset()` on a null-kind element throws
`InvalidOperationException`; relying on that throw to exclude pending reviews would
(a) route a normal draft through the malformed-item `catch` and log it every tick as
"malformed JSON shape," and (b) conflate a routine pending review with corrupt JSON. The
codebase already established the correct guard for exactly this trap —
`GitHubReviewService.cs:909-918` checks `ValueKind != JsonValueKind.String` before
`GetDateTimeOffset()` — and this slice mirrors it.

## Decision (R1) — selection rule

Replace the array-position-trusting selection with a `submitted_at`-max selection over
**submitted reviews that carry a head**:

> Among the viewer's reviews (case-insensitive `user.login` match), consider only those
> with a **string-kind `submitted_at`** (a real timestamp — excludes JSON-null pending
> drafts and absent fields) **and a non-null, non-empty `commit_id`**. Select the review
> with the **maximum `submitted_at`**; its `commit_id` is the "last reviewed head." If no
> review is eligible (across all walked pages), the result is `null`.

- **Resolves property 2 (ordering):** selection is by `submitted_at`-max, independent of
  array position — within a page and across pages. The #322 cross-page Link-walk stays;
  the running `best` is compared by timestamp across everything seen rather than
  overwritten by encounter order.
- **Page-cap interaction (unchanged correctness).** The #322 10-page cap is preserved.
  When a PR exceeds the cap, the genuinely-latest review (page 11+) is never fetched —
  but because GitHub returns reviews ascending, `submitted_at`-max over the fetched
  pages 1–10 selects the **same** review the old array-last rule would have, so
  truncation is no *more* wrong than today, and the `ReviewPagesCapped` warning still
  fires unchanged.
- **Resolves property 1 (null `commit_id`):** a pending draft (`submitted_at: null`) is
  excluded by the gate, so the rule falls back to the latest *submitted* review with a
  head. This is **decision A** of the issue ("fall back to prior non-null"), which the
  issue itself calls "arguably correct."

### Tie-break (R1a)

`best` is replaced only when a candidate's `submitted_at` is **strictly greater** than
the current best's. On an exact-timestamp tie the earlier-encountered entry is retained,
giving a deterministic result for a given input ordering. Two *submitted* reviews sharing
a second-precision `submitted_at` requires a sub-second resubmit, which essentially never
occurs; when it does, the retained head is whichever the walk saw first. That result is
arbitrary (not provably "the latest") but deterministic — acceptable for this signal, and
not worth a review-`id` secondary sort. The eligibility gate also tightens `commit_id`
from the old `!= null` to **non-null and non-empty**; GitHub does not emit an empty
`commit_id`, so this is a deliberate defensive tightening with no practical behavior
change.

### Decision A — submitted review with null `commit_id` (R1b)

A *submitted* review (`submitted_at` present) whose `commit_id` is null is unusual but
API-permitted. Per decision A, it is treated identically to any other ineligible review:
skipped, the rule falls back to the next-latest eligible review. No PR is suppressed on
account of it; no special branch is added. (Decision B — suppress the PR from
awaiting-author when the latest submitted review has no comparable head — was considered
and rejected: it hides PRs that may genuinely need re-review and adds branching for a
case that effectively never occurs.)

## Intended behavior change (R2)

Today's `if (sha != null) best = sha;` counts a PENDING review that happens to carry a
`commit_id` toward "I reviewed at this head." Under R1 it will not (its `submitted_at` is
null). This is a deliberate correctness improvement — the viewer's own unsubmitted draft
should not mark a PR as reviewed-at-head — and a real, if rare, behavior change. It is
in scope and intended, not an accident.

**Scope of the change is narrow.** It bites only a pending draft carrying a *non-null*
`commit_id` *at the current head*. The common pending shape (`commit_id: null`) is
already skipped today (the `sha != null` guard), so its behavior is unchanged. In the
affected case the PR was previously suppressed from awaiting-author by the draft and will
now appear there (falling back to the prior submitted review's head). One consequence
worth naming: such a PR is arguably awaiting *the reviewer's own submit*, not the author,
yet it surfaces under "Needs re-review / awaiting author." This is acceptable — an
unsubmitted draft is not a completed review, and submitting it clears the PR from the
section. If draft-in-progress entries prove noisy in practice, distinguishing "you have a
draft here" from "author pushed after you reviewed" is a separate follow-up, not this
slice.

## Out of scope (unchanged)

- **Review `state` filtering** (DISMISSED / COMMENTED). Submitted reviews of any state
  that carry `submitted_at` + `commit_id` count today and continue to count. This slice
  does not introduce state-based filtering. Note a benign consequence: a DISMISSED or
  stale review whose `commit_id` points at a since-force-pushed/rebased (vanished) SHA is
  still eligible and, if it is the `submitted_at`-max, becomes `best`; since
  `best != headSha` the PR stays in awaiting-author at that dead SHA. This is intended —
  the head moved past the reviewed commit, which is exactly the re-review signal — and is
  the same outcome as before this slice.
- **Pagination & page-cap warning** (#322 U2), **per-review JSON isolation**
  (`InboxJsonGuard`), **absent-PR cache eviction** (#322 U1), the `(PrReference, headSha)`
  cache key and its semantics, **404 / 429 / cancellation** paths, and the **concurrency
  cap**. All preserved exactly.
- **Interface and callers.** `FetchLastReviewShaAsync` stays private; `FilterAsync` and
  `IAwaitingAuthorFilter` are untouched. The downstream keep-condition
  (`best != null && best != headSha`) is unchanged.

## Architecture

Single-method change inside `PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs`:

- `FetchLastReviewShaAsync` returns `string?` as today. Internally it now tracks
  `DateTimeOffset? bestSubmittedAt` alongside `string? best`.
- Per-review parsing (already inside the `try` guarded by `InboxJsonGuard.IsMalformedItem`):
  read `commit_id` (string?) and `submitted_at`.
- **Eligibility (kind-guarded, no exception path for the normal pending case):**
  ```csharp
  var commitId = review.TryGetProperty("commit_id", out var c) ? c.GetString() : null;
  if (string.IsNullOrEmpty(commitId)) continue;                       // pending/no-head → skip
  if (!review.TryGetProperty("submitted_at", out var sa) ||
      sa.ValueKind != JsonValueKind.String) continue;                  // null-kind/absent → skip
  var submittedAt = sa.GetDateTimeOffset();                            // string-kind only
  ```
  The `ValueKind != JsonValueKind.String` check (mirroring `GitHubReviewService.cs:917`)
  means a JSON-`null` `submitted_at` (PENDING) is excluded as a normal `continue`, **not**
  thrown-and-caught — so no "malformed JSON shape" Debug line is emitted for routine
  pending drafts. A genuinely malformed timestamp (a non-date *string*) reaches
  `GetDateTimeOffset()` and throws `FormatException`, which `InboxJsonGuard.IsMalformedItem`
  recognizes → that one review is skipped, scan continues (no tick abort).
- **Update (explicit null-guard — the bare lifted `>` operator returns `false` against a
  null operand, so it must not be used alone):**
  ```csharp
  if (bestSubmittedAt is null || submittedAt > bestSubmittedAt.Value)
  {
      bestSubmittedAt = submittedAt;
      best = commitId;
  }
  ```
  This takes the first eligible review (when `bestSubmittedAt` is still null) and
  thereafter applies the **strictly-greater** semantics of R1a.
- The page loop, Link-walk, page cap, 404/429 handling, and the post-loop
  `ReviewPagesCapped` warning are unchanged. `best`/`bestSubmittedAt` persist across page
  iterations so the max is global, not per-page.

The `commit_id == headSha` comparison and all `FilterAsync` logic remain byte-identical.

## Testing

**Fixture realism update.** The existing helper `ReviewsResponse(viewerLogin, sha)` and
the inline paginated JSON in `GitHubAwaitingAuthorFilterTests` emit `user.login` +
`commit_id` only. Under R1 a review without `submitted_at` is ineligible, which would
drop every PR in the current tests. Update the fixtures to carry realistic **ascending**
`submitted_at` values matching their existing `commit_id` ordering, so every current
assertion (`Includes_pr_with_newer_commits_than_last_review`,
`Excludes_pr_where_viewer_review_matches_head_sha`,
`Most_recent_review_on_page_2_is_used_not_page_1`,
`Single_page_with_no_next_link_returns_page_1_best`,
`Malformed_review_item_is_skipped_scan_continues`,
`Page_cap_is_honored_and_does_not_loop_forever`, the cache/eviction/concurrency tests)
stays valid. This is test-realism maintenance, not a semantics change to those cases.

**Test-harness prerequisite (for test 3's no-log assertion).** The current `BuildSut`
(`GitHubAwaitingAuthorFilterTests.cs:16-18`) is 2-arg and injects no logger, so the SUT
runs under `NullLogger` and emits nothing observable. The SUT ctor already accepts an
optional `ILogger<GitHubAwaitingAuthorFilter>` (`GitHubAwaitingAuthorFilter.cs:21-29`), so
add a `BuildSut` overload that passes one in. Capture/assert via **Moq** (already a package
ref in `PRism.GitHub.Tests`): `Mock<ILogger<GitHubAwaitingAuthorFilter>>`, then
`logger.Verify(l => l.Log(LogLevel.Debug, It.IsAny<EventId>(), It.IsAny<It.IsAnyType>(),
It.IsAny<Exception?>(), It.IsAny<Func<It.IsAnyType, Exception?, string>>()), Times.Never)`
to assert `ReviewItemSkipped` did **not** fire. (`ReviewItemSkipped` is the source-gen
`LoggerMessage` at `GitHubAwaitingAuthorFilter.cs:132-134`, `LogLevel.Debug`; the
source-gen path lowers to that generic `ILogger.Log` overload, so the `Times.Never` verify
must target it.) Do **not** depend on `PRism.Web.Tests`' `ListLoggerProvider` — it is in a
different, unreferenced test project.

**New tests** (all in `GitHubAwaitingAuthorFilterTests`):

1. **Out-of-order array picks true-latest by timestamp.** A single page lists two viewer
   reviews where the array-*first* has the **newer** `submitted_at` (at the current head)
   and the array-*last* has an **older** `submitted_at` (at an old sha). The PR head
   equals the newer review's `commit_id` ⇒ PR is **excluded**. The old array-position
   rule would pick the array-last "old" sha ≠ head ⇒ wrongly include.

2. **Latest-by-`submitted_at` review has `commit_id: null` → fall back (decision A).**
   Two viewer reviews: an older one (`submitted_at` earlier, `commit_id: "old"`) and a
   newer one (`submitted_at` later, `commit_id: null`). PR head is `"new"`. The null
   review is skipped; `best` = `"old"` ≠ `"new"` ⇒ PR **included** (awaiting author at
   the older reviewed head).

3. **PENDING review (JSON-`null` `submitted_at`) is dropped from selection — clean, no
   malformed-log; the PR is still included via the prior review.** Two viewer reviews: a
   submitted one (`submitted_at` present, `commit_id: "old"`) and a pending one with a
   literal `"submitted_at": null` (JSON null, not an absent field) and `commit_id: "head"`.
   PR head is `"head"`. The pending review is dropped from selection by the `ValueKind`
   gate, so `best` = `"old"` ≠ `"head"` ⇒ **the PR is included**. (Under today's rule the
   pending review's `"head"` would win ⇒ PR excluded — this test pins R2.) Assert (via the
   Moq logger above) that **no** `ReviewItemSkipped` ("malformed JSON shape") entry is
   emitted — the pending review takes the normal `continue`, not the exception path.
   **The non-null `commit_id: "head"` is load-bearing:** under the commit_id-first gate a
   fully-pending review (`commit_id: null`) would be skipped at the *commit_id* gate and
   never reach the `ValueKind` check, so this fixture deliberately carries a non-null
   `commit_id` to force the review onto the `ValueKind` path. This is the distinct
   null-kind path that test 5's non-date *string* does not exercise.

4. **Cross-page max-by-timestamp.** Page 1 holds the viewer review with the **newer**
   `submitted_at` (at head); page 2 holds an **older** `submitted_at` (at old sha), with
   a `rel="next"` link from page 1 to page 2. PR head equals the page-1 review's
   `commit_id` ⇒ PR **excluded**, proving the max is taken across pages by timestamp, not
   reset or overwritten by the later page.

5. **Malformed `submitted_at` (non-date *string*) skips one review via the guard, scan
   continues.** A page with one viewer review whose `submitted_at` is a non-date string
   (`"not-a-date"`, `JsonValueKind.String` so it passes the kind gate and reaches
   `GetDateTimeOffset()`) **and carries a non-null `commit_id` (e.g. `"x"`)** so it
   survives the commit_id-first gate and actually reaches the parse — plus a second valid
   viewer review (`submitted_at` present, `commit_id: "old"`). PR head `"new"`. The
   malformed review throws `FormatException`, caught by `InboxJsonGuard.IsMalformedItem`;
   `best` = `"old"` ⇒ PR **included**; no throw out of the filter. (Without the non-null
   `commit_id`, the review would be dropped at the commit_id gate before
   `GetDateTimeOffset()`, leaving the `FormatException` branch — AC4 — unexercised.) This
   pins the `FormatException` branch — distinct from test 3's clean `null`-kind exclusion.

**Verification:** `dotnet build -c Release` (0/0) and `dotnet test -c Release` on
`PRism.GitHub.Tests` green. Backend-only — no frontend files touched, so frontend
lint/build/vitest/e2e pre-push steps are N/A.

## Acceptance criteria

- **AC1 (ordering-robust):** selection picks the viewer review with the maximum
  `submitted_at`, independent of array position, within and across pages. (Tests 1, 4.)
- **AC2 (null-`commit_id` semantics, decision A):** a review with null `commit_id` —
  whether the latest-by-`submitted_at` or otherwise — is excluded, and the rule falls
  back to the latest eligible submitted review. (Test 2.)
- **AC3 (PENDING excluded, R2):** a review with `submitted_at: null` is excluded even if
  it carries a `commit_id`. (Test 3.)
- **AC4 (robust parsing):** a malformed `submitted_at` skips that one review via the
  existing JSON guard without aborting the tick; transport/cancellation/rate-limit still
  propagate. (Test 5; existing 429/cancellation tests unchanged.)
- **AC5 (no collateral change):** pagination, page-cap warning, cache eviction, the
  cache key, 404/429/cancellation, concurrency cap, `FilterAsync`, and
  `IAwaitingAuthorFilter` are unchanged; all pre-existing tests pass after fixture
  `submitted_at` enrichment.

Refs #322.
