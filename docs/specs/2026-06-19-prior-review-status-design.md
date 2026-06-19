# Surface the viewer's prior review on a PR — Slice 1: PR detail (#512)

**Status:** spec (T3, B1-gated). Round-1 `ce-doc-review` applied (6 personas). Source issue:
[#512](https://github.com/prpande/PRism/issues/512). Relates to
[#367](https://github.com/prpande/PRism/issues/367) (awaiting-author last-reviewed-head selection),
[#322](https://github.com/prpande/PRism/issues/322) (reviews Link-walk),
[#318](https://github.com/prpande/PRism/issues/318) (kebab verdict wire).

## Problem

After you submit a review on a PR through PRism, nothing tells you — when you reopen that PR
later — that you've **already reviewed** it, what your verdict was, when, or whether your review
is **stale** because new commits landed since. The PR-detail header surfaces none of it, so it is
easy to start re-reviewing a PR you already signed off on. GitHub makes this obvious (reviewer
sidebar shows ✓ Approved / ✗ Changes requested / 💬 Commented and flags "new commits since your
review"); PRism should reach parity on the **state + staleness** signal.

The data already exists: `GitHubAwaitingAuthorFilter` (#367) selects the viewer's review by max
`submitted_at` for inbox routing, but that selection is consumed only for section placement and
never shown.

## Scope decision — this is Slice 1 of 2

The issue spans two surfaces with very different cost/value profiles, so it is sliced:

- **Slice 1 (this spec): PR detail.** High-value, low-cost. Rides the **existing GraphQL PR-detail
  fetch** — zero extra API calls. Self-contained.
- **Slice 2 (separate follow-up issue, cross-linked): inbox cross-section marker.** The costly part:
  today the per-PR REST reviews walk runs **only** on `awaiting-author` candidates.

  The Slice-2 follow-up must distinguish two inbox sub-cases (product-lens R1):
  - (a) `awaiting-author` / re-review rows — the section **already implies** "you reviewed this," so
    an explicit per-row verdict marker is genuinely marginal.
  - (b) **`review-requested` rows you reviewed at a prior head** — the issue's "loses the signal
    entirely" case. This is the **only** place the core problem is unsolved and is the high-value
    target; it should be Slice 2's primary AC, priced against the REST-walk cost on **that section
    alone** (not a blanket all-sections walk).

This spec covers **Slice 1 only.**

## Decision

Surface the viewer's **latest effective submitted review** on the PR-detail review-action control:

- **Backend:** extend the PR-detail GraphQL query to fetch the viewer's reviews + identity, select
  the latest one (#367-style), and ship a minimal `ViewerReview { state, submittedAt, commitSha? }`
  on `PrDetailDto`.
- **Frontend:** fold that into the **existing** `ReviewActionButton` (the header's split button) so
  its **fill reflects your submitted verdict**, with a caption underneath (relative time + a stale
  flag). The same control still drives changing your review.

Design was validated with the owner via real-token mockups (button-as-status, "Treatment A":
single-line button + caption beneath; both themes; including the idle, stale, and mid-change "was …"
engaged states).

### Why merge into the action button (not a separate badge)

The header's `ReviewActionButton` **already** paints its fill from the *draft* verdict
(`deriveFace` → `fill-approve`/`fill-request-changes`/`fill-comment`). Reusing it for the *submitted*
verdict keeps one control that means "your review on this PR" — status when idle, action when you
engage — instead of adding a second redundant verdict surface beside it.

**The overloaded-control tradeoff (acknowledged).** In the engaged state (composing a new review
over a prior one) the single control simultaneously expresses your prior verdict, your in-progress
draft, and the submit action. The precedence rule below (draft wins the face; prior demotes to the
caption "was …") plus the existing `*` unsaved-marker disambiguate it, and the mid-change state was
in the validated mockup. This is a deliberate trade of a small always-visible ambiguity in the
engaged state for the simplicity win in the common idle state.

## Design

### 1. Data source & selection (backend)

Extend `GitHubReviewService.PrDetailGraphQLQuery` (`PRism.GitHub/GitHubReviewService.cs`) at **two
positions** (scope-guardian R4):
- **Query root level** (sibling of `repository`): `viewer{login}`.
- **Inside `pullRequest{…}`**: a dedicated reviews connection
  `reviews(last:100){nodes{author{login} state submittedAt commit{oid}}}`.

**Why a dedicated `reviews` connection** rather than extending the shared `TimelineNodes`
`... on PullRequestReview{submittedAt}` fragment: `TimelineNodes` is shared with `GetTimelineAsync`'s
`TimelineQuery` (extending it over-fetches there), and `reviews(last:100)` returns 100 *reviews* not
100 *mixed timeline events* — far less likely to truncate your latest review. `last:100` returns the
last 100 reviews oldest→newest; the max-`submittedAt` selection below is order-robust regardless, and
the cap only drops the *oldest* reviews.

**Viewer identity (feasibility R1 / adversarial R1 / coherence R1).** `viewer` serializes to
`data.viewer.login` — a **sibling** of `data.repository`, NOT under the `pullRequest` node. The
existing parsers all receive `pull = data.repository.pullRequest`, which has no `viewer` child. So
`GetPrDetailAsync` reads the viewer login from `doc.RootElement` (it already has `doc` in scope) via
`TryGetPath(root, "data", "viewer", "login")` and passes it to the parser:

```
GitHubPrParser.ParseViewerReview(JsonElement pull, string? viewerLogin) → ViewerReview?
```

This mirrors #367's `FetchLastReviewShaAsync(..., string viewerLogin, ...)` passed-login pattern.
The login here is the **token's authenticated user**, self-consistent with the reviews fetched in the
same round-trip; it is intentionally **not** routed through the app's `IViewerLoginProvider` chain
(adversarial R4). In single-account today they agree; Slice 2's inbox marker must use the **same**
identity source to stay consistent.

**Selection** — `ParseViewerReview` returns, among `pull.reviews.nodes` where
`author.login == viewerLogin` (ordinal-ignore-case) and `submittedAt` is string-kind, the one with
**max `submittedAt`**, **excluding `DISMISSED`** (see Edge cases). `PENDING` is excluded for free (no
`submittedAt`). Map `state` → `ReviewState`. Returns `null` when the viewer has no effective review.

**Selection is decoupled from staleness (adversarial R3).** Do **not** require a non-empty
`commit.oid` for selection — that gate is inherited from #367's head-comparison purpose and here it
would drop a real COMMENTED review (→ "Submit review" on a PR you reviewed, defeating the feature).
A review with a null/empty `commit.oid` is still selected; its `CommitSha` is carried as `null` and
staleness is reported as *unknown* (no stale flag, still "You reviewed"). Per-node JSON access is
isolated (mirror `InboxJsonGuard`) so one malformed node is skipped, not the load.

### 2. Backend DTO (minimal — backend ships the *fact*, frontend renders it)

New in `PRism.Core.Contracts`:

```csharp
// Serialized kebab-case (approved / changes-requested / commented) by the
// JsonStringEnumConverter(KebabCaseJsonNamingPolicy) already registered on
// JsonSerializerOptionsFactory.Api — verify with an STJ probe. No custom converter or
// allowlist needed: this is an OUTPUT-only field, so #318's inbound-strictness concern
// (reject malformed verdict strings on deserialize) does not apply here (feasibility R3).
public enum ReviewState { Approved, ChangesRequested, Commented }
public sealed record ViewerReview(ReviewState State, DateTimeOffset SubmittedAt, string? CommitSha);
```

`PrDetailDto` gains `ViewerReview` as a new **positional ctor parameter, appended last**:

```csharp
public sealed record PrDetailDto(
    Pr Pr, ClusteringQuality ClusteringQuality, IReadOnlyList<IterationDto>? Iterations,
    IReadOnlyList<CommitDto> Commits, IReadOnlyList<IssueCommentDto> RootComments,
    IReadOnlyList<ReviewThreadDto> ReviewComments, bool TimelineCapHit,
    ViewerReview? ViewerReview);   // NEW — null = you have no effective review
```

**Construction-site impact (scope-guardian R1 / coherence).** Adding a positional param breaks every
`new PrDetailDto(...)` call — they must pass the new arg:
- `GitHubReviewService.GetPrDetailAsync` (`GitHubReviewService.cs:140`) → pass
  `ParseViewerReview(pull, viewerLogin)`.
- `PRism.Web/TestHooks/FakePrReader.cs:57` and any other test-double / fake that constructs
  `PrDetailDto` directly → pass `ViewerReview: null` (or a fixture value).

**Loader needs no change.** `PrDetailLoader` rebuilds the DTO with
`detail with { ClusteringQuality, Iterations, Commits }`. A C# `with`-expression **preserves**
fields it does not list, so the `ViewerReview` set by `GetPrDetailAsync` survives the loader
untouched — no loader edit.

### 3. Frontend — fold into `ReviewActionButton`

**Types** (`frontend/src/api/types.ts`):
```ts
export type ReviewState = 'approved' | 'changes-requested' | 'commented';
export interface ViewerReview { state: ReviewState; submittedAt: string; commitSha: string | null }
// the PrDetail type gains: viewerReview?: ViewerReview | null
```

**Prop threading (feasibility / coherence residual).** The data reaches the button through three
hops the implementer must wire: `PrDetailView` (renders `PrHeader`, already passes
`currentHeadSha={data?.pr.headSha}`) → pass `viewerReview={data?.viewerReview}`; add `viewerReview`
to `PrHeaderProps`; `PrHeader` computes the stale boolean (below) and passes `viewerReview` +
`submittedReviewStale` to `ReviewActionButton` (which today receives neither).

**`reviewActionState.ts`** — extend `ReviewActionInputs` with **pre-computed** fields, NOT raw PR
data (scope-guardian R2 / coherence R2 — mirror the existing `headShaDrift: boolean` pattern; keep
`deriveFace` a pure input→face transform with no string-compare / array-search):
```ts
viewerReview: ViewerReview | null;
submittedReviewStale: boolean;   // computed in PrHeader: see §4
```

`deriveFace` gains **fill precedence**:
1. Closed/merged → `secondary` ("Drafts") — **unchanged** (see Edge cases for the caption).
2. **In-progress draft verdict** (`session.draftVerdict`) → that verdict's fill + existing `*`
   unsaved marker — wins the face.
3. Else **submitted `viewerReview.state`** → that state's fill (NEW).
4. Else `accent` "Submit review" — unchanged.

The face exposes caption fields consumed by `ReviewActionButton.tsx`:
- **No draft, has submitted review** → `You reviewed · {relativeTime}`; append `· out of date`
  when `submittedReviewStale`.
- **Draft over a prior review** → face shows the draft; caption demotes to
  `was {PRIOR_VERDICT_LABEL[state]} · {relativeTime}`.
- No submitted review → no caption (unchanged from today).

`mainAction` / enable rules / menu are **unchanged** (decision (a): reuse existing submit-enable
rules; no new self-review gating).

**Past-tense label map (design-lens R7).** The caption needs noun forms distinct from the action
`VERDICT_LABEL`; add:
```ts
const PRIOR_VERDICT_LABEL: Record<ReviewState, string> =
  { approved: 'Approved', 'changes-requested': 'Changes requested', commented: 'Commented' };
```

**Caption layout contract (design-lens R2).** `.root` reflows to `flex-direction: column` with the
caption as a second flex child (`align-items: flex-end` so it right-aligns under the split button).
Caption: `font-size: var(--text-2xs)`, `color: var(--text-3)`; the stale rider uses
`color: var(--warning-fg)`. The caption is **conditionally rendered** (absent when there is no
submitted review and no draft-over-prior); the header tolerates the height change (the action column
is not fixed-height). It is **not** absolutely positioned (would overlap header content below).

**Draft-vs-submitted discriminator (design-lens R5).** A submitted "Changes requested" and a draft
"Request changes" share the amber `fill-request-changes`. The deliberate discriminators are (1) the
draft's `*` unsaved marker (absent on a pure submitted state) and (2) the caption ("You reviewed …"
vs none). This was validated in the mockup; implementers must **not** add an ad-hoc face
differentiator.

**Session-load window (design-lens R6).** `viewerReview` arrives with the PR-detail payload, which
is independent of the draft-session GET (`sessionLoaded`). The caption renders from PR-detail data
regardless of `sessionLoaded`; while `frozen` (`!sessionLoaded` or in-submit-flow) the button face
follows existing freeze styling and the caption still shows the submitted status (read-only).

**Accessibility (design-lens R1/R4).** The submitted verdict must not be conveyed by fill color +
caption alone. When `viewerReview` is present, the button carries an `aria-label` (or
`aria-describedby` → the caption element) that includes the status in words, e.g.
`"Approve — you reviewed 2 days ago"` (+ `", out of date"` when stale). The `⚠`-equivalent is **not**
used as the SR signal — the caption spells out "out of date" in words; any decorative glyph is
`aria-hidden="true"` (matching the existing `.reconfirm` / asterisk treatment). In the mid-change
state the caption ("was Approved · …") is in an `aria-live="polite"` region so SR users learn the
prior verdict differs from the draft.

### 4. Staleness — boolean, derived in `PrHeader`

Staleness is computed in `PrHeader` (where `pr.headSha` lives) and passed as the pre-computed
`submittedReviewStale` boolean:

```
submittedReviewStale = viewerReview?.commitSha != null && viewerReview.commitSha !== pr.headSha
```

**Slice 1 reports staleness as a boolean ("out of date"), not a commit count** (scope-guardian R3 /
adversarial R2). The mockup showed "N commits behind", but a count derived from the loaded `Commits`
list is **unreliable**: that list is `timelineItems(first:100)`-capped (the DTO already carries
`TimelineCapHit`), so a truncated list yields a *too-low, authoritative-looking* count — worse than
no count. Squash/base-merge heads also break the count. The boolean meets the AC ("a stale indicator
says so") and removes the fragile commit-list traversal + its branches. A reliable count is deferred
(it belongs with complete commit data; revisit in Slice 2 or when the timeline is fully paginated).
When `commitSha` is `null` (review carried no commit), staleness is **unknown** → no stale flag,
caption stays "You reviewed".

### 5. Copy

- Approved → green `fill-approve`, "You reviewed · 2d ago"
- Changes requested → amber `fill-request-changes`, "You reviewed · 2d ago"
- Commented → blue `fill-comment`, "You reviewed · 2d ago"
- Stale → caption appends `· out of date` (warning-fg)
- Mid-change → caption `was Approved · 2d ago`

**Relative-time format (design-lens R3).** Reuse an existing formatter if one exists under
`frontend/src/` (check during implementation); otherwise define one with these thresholds:
`< 60s` → "just now"; `< 60m` → "Nm ago"; `< 24h` → "Nh ago"; else "Nd ago". The caption never
renders an empty or "0m ago" time.

## Edge cases / selection semantics

- **Dismissed reviews excluded from selection.** A dismissed review no longer counts as your
  effective opinion; excluding it falls back to your latest non-dismissed submitted review, or `null`
  ("Submit review"). Keeps displayed states to exactly {Approved, Changes requested, Commented}, no
  "dismissed" badge. Narrow, justified divergence from #367's state-agnostic selection (different
  purpose — inbox routing by last-reviewed *head*); the two selectors stay independent.
- **Review with null/empty `commit.oid`:** selected normally (selection decoupled from staleness,
  §1); `CommitSha = null` → staleness unknown.
- **>100 reviews:** `reviews(last:100)` could truncate the latest; accepted, consistent with the
  existing `TimelineCapHit` posture.
- **Pending (unsubmitted) review:** excluded (no `submittedAt`); the existing `pending` / "Resume
  review" face is unaffected and wins via draft precedence.
- **You are the PR author:** you can only have a `COMMENTED` review; it surfaces normally ("You
  reviewed · …"). No self-review submit gating added here.
- **Closed/merged PR you reviewed (adversarial residual / §3 step 1).** The face stays
  `secondary`/"Drafts" — **unchanged** (`deriveFace.fill` still hard-forces `secondary` on
  closed/merged). Only the **caption** surfaces the submitted status ("You reviewed · …",
  read-only). The merged/closed status label in `.pr-meta` is unchanged.

## Risk classification

**Gated — B1 (UI-visual):** `needs-design` label + new rendered status on the review-action control.
The spec is the human gate; it returns to the owner before planning.

**Not B2.** Read-only surfacing of already-fetched reviews. It does not touch the reviewer-atomic
submit pipeline, auth/PAT scopes, token storage, persisted `state.json`, or the verdict/enable
transition rules — the only behavior change to `deriveFace` is the **new fill precedence step 3**,
which slots *below* the existing draft-verdict step (draft still wins), leaving the draft/submit
affordance intact. The GraphQL change only *adds* read fields. Per the pre-PR re-check, re-classify
to B2 if implementation drifts into the submit pipeline.

## Out of scope (Slice 2 / deferred)

- Inbox per-row "already reviewed (stale?)" marker — Slice 2 (see Scope decision; primary target =
  the `review-requested`-after-prior-review case).
- **The conversation-timeline review-summary surface** (product-lens R3). GitHub also shows your
  submitted review *event + its summary body* in the conversation. Slice 1 reaches parity on
  **state + staleness only**. The Overview today renders inline review-**comment threads**
  (`reviewComments`), **not** the review-level summary body or a "you submitted Approved on date"
  event — that surface does not exist and is **not** owned by any current slice. Deliberately
  deferred, not "already done."
- A reliable "N commits behind" count (see §4).
- Multiple-prior-review history (latest effective review only).
- Self-review submit gating (cannot Approve/Request-changes your own PR) — separate latent issue.

## Testing strategy

Non-bug (enhancement): tests authored test-first (red→green within the PR).

**Backend (`PRism.GitHub.Tests`):**
- `ParseViewerReview` unit tests (synthetic payloads — these carry the real coverage): selects
  max-`submittedAt` viewer review; maps each state; excludes `DISMISSED`/`PENDING`/non-viewer;
  **selects a review with null/empty `commit.oid`** (→ `CommitSha == null`); returns `null` when
  none; isolates a malformed node; resolves viewer login from the root element.
- Update the **two frozen-query tests** for the new shape — **and the strip allowlist** (feasibility
  R2): `GraphQlByteIdentityTests.cs` (`ExpectedPrDetail` constant — add `viewer{login}` at root AND
  `reviews(...)` inside `pullRequest`, two positions); the integration
  `FrozenPrismPrTests.Frozen_pr_graphql_shape_unchanged` + `LiveGitHubFixture.cs`; add `viewer`
  (and `author` on the reviews connection) to `FixtureStripAllowlist.AllowedFieldNames`, **or**
  document that the new fields are stripped and the byte-identity test is the real guard for them.
- `GetPrDetailAsync` test: `ViewerReview` populated on the DTO; update the `new PrDetailDto(...)`
  construction sites + `FakePrReader`/test doubles.
- STJ probe: `ReviewState` serializes kebab (`approved` / `changes-requested` / `commented`).

**Frontend (`vitest`):**
- `deriveFace`: precedence (draft > submitted > none), each submitted state's fill, caption fields
  (fresh / stale / mid-change "was …" using `PRIOR_VERDICT_LABEL`).
- `PrHeader` staleness: `commitSha === headSha` → not stale; `!==` → stale; `commitSha == null` →
  not stale (unknown).
- `ReviewActionButton`: caption present/absent per state; `aria-label`/`aria-describedby` carries the
  status; existing action behavior unchanged.

**Proof:** new tests (test-first) + the AC checklist + the B1 visual (the validated mockup states,
re-shot from the running app) + the doc-review dispositions below.

## Acceptance criteria (Slice 1)

- [ ] Opening a PR you've reviewed shows your latest submitted review state (Approved / Changes
  requested / Commented) with relative time, on the review-action control, with an SR-accessible
  label.
- [ ] If your review's `commitSha` ≠ current head, a stale indicator ("out of date") shows; if the
  review carried no commit, no stale flag (unknown).
- [ ] While composing a new/updated review, the draft verdict wins the button face; the prior verdict
  demotes to the caption ("was …").
- [ ] Viewer-review state is sourced from the existing GraphQL PR-detail fetch (no duplicate API
  walk); selection mirrors #367 (max `submitted_at`, excluding dismissed), decoupled from staleness.

## Doc-review dispositions (round 1 — 6 personas)

**Applied:** viewer-login reachability fix (parser takes resolved login) [feasibility/adversarial/
coherence]; DTO signature shown + construction-site impact listed, loader-`with` clarified [scope-
guardian/coherence]; staleness simplified to a boolean, count deferred [scope-guardian/adversarial];
pre-computed `submittedReviewStale` instead of `headSha` in inputs [scope-guardian/coherence];
selection decoupled from `commit.oid`, `CommitSha` nullable [adversarial]; a11y SR label + glyph
aria-hidden [design-lens]; caption layout contract [design-lens]; `PRIOR_VERDICT_LABEL` [design-
lens]; relative-time format [design-lens]; amber discriminator documented [design-lens]; session-load
window rule [design-lens]; strip-allowlist + two-position byte-identity note [feasibility/scope-
guardian]; #318 reference reworded (output-only) [feasibility]; `viewer.login` identity note
[adversarial]; closed/merged caption-only resolution [adversarial]; prop-thread chain [feasibility/
coherence]; Slice-2 sub-case framing [product-lens]; parity out-of-scope wording tightened
[product-lens].

**Noted (no spec change):** mid-change overloaded-control risk — the engaged "was …" state was in
the validated mockup [product-lens, FYI].

**Open for the owner gate:** §4 drops the mockup's "N commits behind" to a boolean "out of date" for
robustness (cap can make a count silently wrong). Confirm the boolean is acceptable, or request the
count gated on `!TimelineCapHit` + reviewed-sha-locatable.

## Self-review

- No TBD/TODO/placeholders.
- Consistency: backend ships `{state, submittedAt, commitSha?}`; staleness is a frontend-computed
  boolean — stated consistently in §2/§3/§4 and ACs. Construction-site claim corrected.
- Scope: bounded to PR detail; inbox, count, summary-surface, self-review gating, history deferred.
- Ambiguity resolved: viewer-login path, dismissed-excluded, commit-null handling, draft-wins-face,
  closed/merged caption-only, treatment A.
