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

## Key insight

On the GitHub REST API, a review's `submitted_at` is non-null **exactly when** the
review has been submitted. A PENDING review (the viewer's own unsubmitted draft) has
`submitted_at: null`, and that pending draft is precisely the null-`commit_id` case
property (1) names. So a single eligibility gate resolves both halves of the issue.

## Decision (R1) — selection rule

Replace the array-position-trusting selection with a `submitted_at`-max selection over
**submitted reviews that carry a head**:

> Among the viewer's reviews (case-insensitive `user.login` match), consider only those
> with **both `submitted_at` and `commit_id` non-null**. Select the review with the
> **maximum `submitted_at`**; its `commit_id` is the "last reviewed head." If no review
> is eligible (across all walked pages), the result is `null`.

- **Resolves property 2 (ordering):** selection is by `submitted_at`-max, independent of
  array position — within a page and across pages. The #322 cross-page Link-walk stays;
  the running `best` is compared by timestamp across everything seen rather than
  overwritten by encounter order.
- **Resolves property 1 (null `commit_id`):** a pending draft (`submitted_at: null`) is
  excluded by the gate, so the rule falls back to the latest *submitted* review with a
  head. This is **decision A** of the issue ("fall back to prior non-null"), which the
  issue itself calls "arguably correct."

### Tie-break (R1a)

`best` is replaced only when a candidate's `submitted_at` is **strictly greater** than
the current best's. On an exact-timestamp tie the earlier-selected entry is retained
(deterministic for a given input). Two submitted reviews sharing a second-precision
`submitted_at` essentially never occurs, and either head is equally valid when it does;
no review-`id` tie-break is introduced.

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

## Out of scope (unchanged)

- **Review `state` filtering** (DISMISSED / COMMENTED). Submitted reviews of any state
  that carry `submitted_at` + `commit_id` count today and continue to count. This slice
  does not introduce state-based filtering.
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
  read `commit_id` (string?) and `submitted_at`. `submitted_at` is parsed with
  `JsonElement.TryGetProperty` + `GetDateTimeOffset()`. A malformed timestamp throws a
  `FormatException`, which `InboxJsonGuard.IsMalformedItem` already recognizes → that one
  review is skipped, scan continues (no tick abort).
- Eligibility: `commit_id` non-null/non-empty **and** `submitted_at` present.
- Update: `if (submittedAt > bestSubmittedAt) { bestSubmittedAt = submittedAt; best = commitId; }`
  with `bestSubmittedAt` initialized to null (any real timestamp is `>` null under the
  chosen comparison helper) — implemented so the **strictly-greater** semantics of R1a
  hold and the first eligible review is always taken.
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

3. **PENDING review (`submitted_at: null`) with a `commit_id` is excluded.** Two viewer
   reviews: a submitted one (`submitted_at` present, `commit_id: "old"`) and a pending
   one (`submitted_at: null`, `commit_id: "head"`). PR head is `"head"`. The pending
   review is excluded, so `best` = `"old"` ≠ `"head"` ⇒ PR **included**. (Under today's
   rule the pending review's `"head"` would win ⇒ excluded — this test pins R2.)

4. **Cross-page max-by-timestamp.** Page 1 holds the viewer review with the **newer**
   `submitted_at` (at head); page 2 holds an **older** `submitted_at` (at old sha), with
   a `rel="next"` link from page 1 to page 2. PR head equals the page-1 review's
   `commit_id` ⇒ PR **excluded**, proving the max is taken across pages by timestamp, not
   reset or overwritten by the later page.

5. **Malformed `submitted_at` skips one review, scan continues.** A page with one viewer
   review whose `submitted_at` is a non-date string (`"not-a-date"`) and a second valid
   viewer review (`submitted_at` present, `commit_id: "old"`). PR head `"new"`. The
   malformed review is skipped via `InboxJsonGuard`; `best` = `"old"` ⇒ PR **included**;
   no throw.

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
