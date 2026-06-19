# Surface the viewer's prior review on a PR — Slice 1: PR detail (#512)

**Status:** spec (T3, B1-gated). Source issue: [#512](https://github.com/prpande/PRism/issues/512).
Relates to [#367](https://github.com/prpande/PRism/issues/367) (awaiting-author last-reviewed-head selection), [#322](https://github.com/prpande/PRism/issues/322) (reviews Link-walk).

## Problem

After you submit a review on a PR through PRism, nothing tells you — when you reopen that PR
later — that you've **already reviewed** it, what your verdict was, when, or whether your review
is **stale** because new commits landed since. The PR-detail header surfaces none of it, so it is
easy to start re-reviewing a PR you already signed off on. GitHub makes this obvious (reviewer
sidebar shows ✓ Approved / ✗ Changes requested / 💬 Commented and flags "new commits since your
review"); PRism should reach parity.

The data already exists: `GitHubAwaitingAuthorFilter` (#367) selects the viewer's review by max
`submitted_at` for inbox routing, but that selection is consumed only for section placement and
never shown.

## Scope decision — this is Slice 1 of 2

The issue spans two surfaces with very different cost/value profiles, so it is sliced:

- **Slice 1 (this spec): PR detail.** High-value, low-cost. Rides the **existing GraphQL PR-detail
  fetch** — zero extra API calls. Self-contained.
- **Slice 2 (separate follow-up issue, cross-linked): inbox cross-section marker.** The costly part:
  today the per-PR REST reviews walk runs **only** on `awaiting-author` candidates; marking
  `review-requested` rows you previously reviewed (the case the issue calls out as "loses the signal
  entirely") needs that walk on more sections = N extra calls per inbox tick. The marginal value is
  also lower there — `awaiting-author` and the re-review section already *imply* "you reviewed this"
  by being that section. Deferred and tracked separately.

This spec covers **Slice 1 only.**

## Decision

Surface the viewer's **latest effective submitted review** on the PR-detail review-action control:

- **Backend:** extend the PR-detail GraphQL query to fetch the viewer's reviews + identity, select
  the latest one with #367's semantics, and ship a minimal `ViewerReview { state, submittedAt,
  commitSha }` on `PrDetailDto`.
- **Frontend:** fold that into the **existing** `ReviewActionButton` (the header's split button) so
  its **fill reflects your submitted verdict** with a caption underneath (relative time +
  staleness). The same control still drives changing your review.

Design was validated with the owner via real-token mockups (button-as-status, "Treatment A":
single-line button + caption beneath; both themes).

### Why merge into the action button (not a separate badge)

The header's `ReviewActionButton` **already** paints its fill from the *draft* verdict
(`deriveFace` → `fill-approve`/`fill-request-changes`/`fill-comment`). Reusing it for the *submitted*
verdict keeps one control that means "your review on this PR" — status when idle, action when you
engage — instead of adding a second redundant verdict surface beside it.

## Design

### 1. Data source & selection (backend)

Extend `GitHubReviewService.PrDetailGraphQLQuery` (`PRism.GitHub/GitHubReviewService.cs`) with:
- `viewer{login}` at the top level (the authenticated user for the token — exactly whose review we
  want; no caller plumbing needed).
- A **dedicated reviews connection** on the pull request:
  `reviews(last:100){nodes{author{login} state submittedAt commit{oid}}}`.

**Why a dedicated `reviews` connection** rather than extending the shared `TimelineNodes`
`... on PullRequestReview{submittedAt}` fragment:
- `TimelineNodes` is shared with `GetTimelineAsync`'s `TimelineQuery`; extending it would over-fetch
  on the timeline path.
- `reviews(last:100)` returns 100 *reviews*, not 100 *mixed timeline events* — far less likely to
  truncate your latest review than the existing timeline first-page cap.

**Selection** — new pure parser `GitHubPrParser.ParseViewerReview(JsonElement pull)`:
- Read `data...viewer.login` for the viewer identity.
- Among `reviews.nodes` where `author.login == viewer.login` (ordinal-ignore-case), with a non-empty
  `commit.oid` and a string-kind `submittedAt`, pick **max `submittedAt`** — mirroring #367's
  selection (`GitHubAwaitingAuthorFilter.FetchLastReviewShaAsync`).
- **Exclude `DISMISSED`** (see Edge cases). `PENDING` is excluded for free (no `submittedAt`).
- Map `state` → `ReviewState` enum. Returns `null` when the viewer has no effective review.

Per-node JSON access is isolated so one malformed review node is skipped, not the load (mirror the
existing `InboxJsonGuard` pattern in the filter).

### 2. Backend DTO (minimal — backend ships the *fact*, frontend renders it)

New in `PRism.Core.Contracts`:

```csharp
// kebab wire, #318 strict-allowlist pattern (NOT the permissive 2-arg JsonStringEnumConverter)
public enum ReviewState { Approved, ChangesRequested, Commented }
public sealed record ViewerReview(ReviewState State, DateTimeOffset SubmittedAt, string CommitSha);
```

`PrDetailDto` gains one optional field: `ViewerReview? ViewerReview` (`null` = you have no effective
review). Wire serialization is kebab-case (`approved` / `changes-requested` / `commented`),
consistent with the verdict wire contract established in #318 — verified with a probe, not assumed
(see [[reference_jsonstringenumconverter_permissive]]).

`GetPrDetailAsync` populates it via `ParseViewerReview`. `PrDetailLoader.LoadAsync` rebuilds the DTO
with `detail with { ClusteringQuality, Iterations, Commits }` (record copy) — `ViewerReview` is an
unlisted field, so it **survives automatically**; no loader change needed.

### 3. Frontend — fold into `ReviewActionButton`

`frontend/src/api/types.ts`:
```ts
export type ReviewState = 'approved' | 'changes-requested' | 'commented';
export interface ViewerReview { state: ReviewState; submittedAt: string; commitSha: string }
// PrDetail type gains: viewerReview?: ViewerReview | null
```

`reviewActionState.ts` — extend `ReviewActionInputs` with `viewerReview: ViewerReview | null` and
`headSha: string`, and extend `deriveFace` with **fill precedence**:

1. Closed/merged → `secondary` ("Drafts") — unchanged.
2. **In-progress draft verdict** (`session.draftVerdict`) → that verdict's fill, with the existing
   `*` pending marker — wins the face (it's what you're about to submit).
3. Else **submitted `viewerReview.state`** → that state's fill (NEW).
4. Else `accent` "Submit review" — unchanged.

The face exposes new caption fields consumed by `ReviewActionButton.tsx`:
- **No draft, has submitted review** → caption: `You reviewed · {relativeTime}`; if stale, append
  `· ⚠ {n} commits behind` (or `· ⚠ earlier commit` when `n` is unknown).
- **Draft over a prior review** → face shows the draft; caption demotes to `was {Verdict} · {time}`.
- No submitted review → no caption (state 1/2 unchanged from today).

`mainAction` / enable rules / menu are **unchanged** — reusing the existing submit-enable predicate
(decision (a): no new self-review gating in this slice).

### 4. Staleness — derived frontend-side

The frontend already has `pr.headSha`, `Iterations`, and `Commits`. Staleness =
`viewerReview.commitSha !== pr.headSha`. The "N commits behind" count is derived by locating
`commitSha` in the commit list and counting commits after it; when the reviewed commit is absent
(force-push rewrote history), fall back to "earlier commit" with no count. Keeping this on the
frontend keeps the DTO to a single field and puts presentation logic where the iteration/commit data
already lives.

### 5. Copy

- Approved → green `fill-approve`, "You reviewed · 2d ago"
- Changes requested → amber `fill-request-changes`, "You reviewed · 2d ago"
- Commented → blue `fill-comment`, "You reviewed · 2d ago"
- Stale → caption appends `· ⚠ 3 commits behind` (warning-fg)
- Mid-change → caption `was Approved · 2d ago`

(The button face label reuses the existing `VERDICT_LABEL` map: "Approve"/"Request changes"/
"Comment" — the caption uses the past-tense "You reviewed" framing rather than re-labelling the
face.)

## Edge cases / selection semantics

- **Dismissed reviews are excluded from selection.** A dismissed review no longer counts as your
  effective opinion (GitHub strikes it through). Excluding it means selection falls back to your
  latest non-dismissed submitted review, or `null` ("Submit review") if all were dismissed — so the
  displayed states stay exactly {Approved, Changes requested, Commented}, with no separate
  "dismissed" badge. This is a deliberate, narrow divergence from #367's state-agnostic selection
  (which serves a different purpose — inbox routing by last-reviewed *head*).
- **>100 reviews** could in theory truncate the latest via `reviews(last:100)`; acceptable and
  consistent with the existing `TimelineCapHit` first-page-only posture. Not signalled separately.
- **Pending (unsubmitted) review:** excluded (no `submitted_at`); the existing `pending` /
  "Resume review" face is unaffected and still wins via draft precedence.
- **You are the PR author** (own PR in "authored-by-me"): you can only have left a `COMMENTED`
  review; it surfaces normally. No self-review submit gating is added here (existing behavior; a
  separate latent issue).
- **Closed/merged PR you reviewed:** the control is already `frozen`/"Drafts"; the submitted-status
  face/caption applies under the same frozen interactivity rules (read-only). The merged/closed
  status label in `.pr-meta` is unchanged.

## Risk classification

**Gated — B1 (UI-visual):** `needs-design` label + new rendered status on the review-action control.
The spec is the human gate; it returns to the owner before planning.

**Not B2.** This is a read-only surfacing of already-fetched reviews. It does **not** touch the
reviewer-atomic submit pipeline (`addPullRequestReview` → `submitPullRequestReview`), auth/PAT
scopes, token storage, persisted `state.json` schema, or the verdict/enable transition rules. The
GraphQL change only *adds* read fields. Per the pre-PR re-check, if implementation drifts into the
submit pipeline, re-classify to B2.

## Out of scope (Slice 2 follow-up)

- Inbox per-row "already reviewed (stale?)" marker, including the `review-requested`-after-prior-
  review case and the REST reviews-walk expansion to more sections.
- Full prior-review summary/threads rendered in the Overview (review threads already render in the
  review-comments surface). Slice 1 is a compact state on the action button only.
- Showing a *history* of multiple prior reviews (we show the latest effective one only).
- Self-review submit gating (cannot Approve/Request-changes your own PR) — separate latent
  correctness issue; file if desired.

## Testing strategy

Non-bug (enhancement): tests authored test-first (red→green within the PR).

**Backend (`PRism.GitHub.Tests`):**
- `ParseViewerReview` unit tests: selects max-`submitted_at` viewer review; maps each state; excludes
  `DISMISSED`/`PENDING`/non-viewer/empty-commit/null-submitted; returns `null` when none; isolates a
  malformed node.
- Update the **two frozen-query tests** for the new query shape:
  `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs` (`PrDetailGraphQLQuery_is_byte_identical`,
  the `ExpectedPrDetail` constant) and the integration
  `tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs` (`Frozen_pr_graphql_shape_unchanged`)
  + its fixture in `LiveGitHubFixture.cs`.
- `GetPrDetailAsync` test: `ViewerReview` populated on the DTO from a payload with viewer reviews.
- STJ probe: `ReviewState` serializes kebab on the wire.

**Frontend (`vitest`):**
- `reviewActionState` `deriveFace`: precedence (draft > submitted > none), each submitted state's
  fill, caption fields (fresh / stale / mid-change "was …").
- Staleness derivation: `commitSha === headSha` → not stale; `!==` with locatable commit → N count;
  absent commit → fallback copy.
- `ReviewActionButton` render: caption present/absent per state; existing action behavior unchanged.

**Proof:** new tests (test-first) + the AC checklist + the B1 visual (the validated mockup states,
re-shot from the running app).

## Acceptance criteria (Slice 1)

- [ ] Opening a PR you've reviewed shows your latest submitted review state (Approved / Changes
  requested / Commented) with relative time, on the review-action control.
- [ ] If your review's `commitSha` ≠ current head, a stale indicator ("N commits behind", or
  "earlier commit") shows.
- [ ] While composing a new/updated review, the draft verdict wins the button face; the prior verdict
  demotes to the caption ("was …").
- [ ] Viewer-review state is sourced from the existing GraphQL PR-detail fetch (no duplicate API
  walk); selection mirrors #367, excluding dismissed.

## Self-review (placeholders / consistency / scope / ambiguity)

- No TBD/TODO/placeholders.
- Consistency: backend ships `{state, submittedAt, commitSha}`; staleness + count are frontend-
  derived — stated consistently in §2/§4 and ACs.
- Scope: bounded to PR detail; inbox + self-review gating + history explicitly deferred.
- Ambiguity resolved: dismissed → excluded; draft-vs-submitted face → draft wins; treatment → A.
