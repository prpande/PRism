# Merged / closed PR history: Design

**Date**: 2026-06-02.
**Status**: Not started. Spec only. **Scope decided 2026-06-02: full slice** (read-only audit/gaps **+** the standing "Recently closed" inbox section) — the lean alternative in § 10 was considered and declined.
**Branch**: `merged-pr-history-spec` (worktree at `D:\src\PRism-worktrees\merged-pr-history`).
**Backlog origin**: Brings forward [`docs/backlog/05-P4-polish.md`](../backlog/05-P4-polish.md) **P4-D2 — Closed/merged PR history**. P4 work nominally gates on the post-v1 validation trial; this slice is a **pre-gate pull-forward** and is justified only if author dogfooding has surfaced revisiting-done-PRs as real daily friction. If no such signal exists, the sequencing call (this vs. finishing v1's tag/publish path) is the roadmap owner's to make — see § 10.
**Source authorities**: [`docs/spec/03-poc-features.md`](../spec/03-poc-features.md) § 2 (Inbox) is the contract this extends; [`docs/specs/2026-05-06-inbox-read-design.md`](2026-05-06-inbox-read-design.md) is the inbox pipeline this section plugs into. This document does not restate them; it commits to a subset and adds decisions.

---

## 1. Goal

Let a reviewer **revisit a PR after it is done** — merged or closed-without-merge — for three jobs:

- **(a) Retrospective / audit** — re-read a PR you reviewed, including your own past comments, after it merged.
- **(c) Catch-up** — a PR that merged *or was closed without merging* (abandoned / superseded) out from under you, where you had already invested review effort; see the final state and that it is now frozen.
- **(b-with-link)** — a colleague drops a link to a done PR; you open and read it.

**Honest division of labor (per product-lens review).** These three jobs are *not* served equally by one surface, and saying so up front keeps the scope honest:

- **(b-with-link)** is served entirely by the **existing URL-paste escape hatch** the moment the detail view renders done PRs read-only. The section adds nothing here.
- **(a) retrospective** splits by age: a PR you reviewed **within the window** is served by the section (you scan "what did I wrap up recently" without hunting for the URL); a PR **older than the window** is served by paste-URL today and by the deferred (b-without-link) search later. The section does **not** claim to serve older-than-window retrospective.
- **(c) catch-up** is the section's strongest distinct value: for a reviewer who was away for days, the section is the surface that says "these wrapped up while you were out." The in-the-moment variant (PR closes while you watch) is the live banner (§ 5.2.3).

So the section's defensible charter is a **bounded, personal "recently wrapped up" feed** — not a browse engine. The unbounded repo-history browse is explicitly deferred (§ 2). **Strategic note:** adding a standing read-only surface nudges PRism from a pure review-*action* tool toward also being a place you *read* done PRs. That is an intended, bounded step (it strengthens the daily-driver story), not a pivot toward a github.com mirror; the read-only view exists to support revisiting your own review work, not to browse arbitrary PRs.

The work is two pieces:

1. **Discovery** — a new **"Recently closed"** inbox section. The net-new build.
2. **Read-only detail for done PRs** — which **already substantially exists** (built across S3/S5). This slice **audits** it against the three jobs and closes a small set of named gaps (§ 5).

End-to-end demo at slice completion:

1. Open the inbox. Below the five open sections, a collapsed **"Recently closed (N)"** section.
2. Expand it → rows (pre-fetched, no load step) for PRs you authored / commented on / were mentioned in / reviewed, that **merged or closed in the last 14 days**, capped at 30, newest-first. Each row carries a text-primary **Merged** or **Closed** badge.
3. Click a row → the **read-only PR detail view**: threads, others' comments, your past submitted comments, **and the diff** all render; **no composers, no verdict picker, no Submit**. A header label states "Merged ⟨when⟩" or "Closed ⟨when⟩".
4. If that PR closed while you had **unsubmitted drafts**, the Drafts tab renders them read-only and copy-able; nothing is deleted (locally — no remote cleanup this slice, see § 5.2.2).
5. Paste a done-PR URL into the escape hatch → same read-only detail view (b-with-link), no new discovery surface.
6. With the open detail view of a PR that then merges, within one poll cycle a banner appears: "This PR was just merged/closed. Unsubmitted drafts can no longer be submitted. Reload to read-only view." Reload is explicit.

---

## 2. Scope

### In scope

- **New inbox section `recently-closed`** in the existing inbox pipeline ([`InboxRefreshOrchestrator`](../../PRism.Core/Inbox/InboxRefreshOrchestrator.cs) + [`GitHubSectionQueryRunner`](../../PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs)), via an **explicit orchestrator branch** (matching the existing `ci-failing` fan-out pattern — no new interface). Rendered **last**, **collapsed by default**.
- **Participant-union discovery (two sub-queries)**: `is:closed is:pr` × {`involves:@me`, `reviewed-by:@me`}, each with a `closed:>=<today − windowDays>` clause, unioned + deduplicated client-side by `PrReference`, sorted by close time desc, capped at a constant. (`review-requested:@me` is **deferred** — see § 3.1.)
- **Both merged and closed-unmerged**, distinguished by a per-row text-primary badge (`Merged` | `Closed`). The closed-unmerged case is in scope because it serves the abandoned-review half of job (c) (§ 1).
- **Config**: a single bool toggle `inbox.sections.recentlyClosed` (default `true`), matching the five existing section toggles. The window (14 days) and cap (30 rows) are **hardcoded named constants** this slice, **not** config keys — `ConfigStore.PatchAsync` has no Int type today, so int config is disproportionate plumbing for tuning knobs no PoC user will touch. Promotion to config is a trivial follow-up once an Int field type exists.
- **Close-state threading**: `RawPrInboxItem` and `PrInboxItem` gain nullable `MergedAt` / `ClosedAt`; the dedicated branch populates them from the REST enricher (the authoritative source for both timestamps); the closed-section rows are **exempted from the empty-`HeadSha` drop filter** (§ 3.3).
- **Read-only detail audit + gap closure** (§ 5): confirm every GitHub-mutating surface is suppressed on a done PR **and the diff still renders**, then close the named gaps — **merged/closed header label** (timestamp only, no actor), **read-only Drafts tab**, and the **live transition banner** — building only what is actually absent.
- **Tests** per § 8.

### Out of scope (deferred)

- **(b-without-link) repo-wide done-PR search/browse** — unbounded; a search surface, not an inbox. Stays in P4 (adjacent to P4-D1). The escape hatch covers the with-link case; older-than-window (a) retrospective rides this deferred path.
- **`review-requested:@me is:closed` sub-query** — deferred pending live verification it returns rows not already caught by `involves`/`reviewed-by` (§ 3.1).
- **`windowDays` / `maxRows` as config** — hardcoded this slice (above).
- **Re-opening / acting on a done PR.** No "comment anyway," regardless of what GitHub's API would still accept.
- **Remote pending-review cleanup.** Deleting the orphaned GitHub PENDING-review shell left on a now-closed PR is **deferred** out of this slice — it is the only *mutation* in an otherwise read-only feature and carries real misfire risk (see § 5.2.2). The local read-only locked panel fully serves the reading jobs; the remote shell is invisible inside PRism.
- **Merged-by actor in the header label.** "Merged ⟨when⟩ by ⟨login⟩" needs a new GraphQL field + contract threading for a display-only nicety; deferred. The header shows "Merged ⟨when⟩" / "Closed ⟨when⟩" (§ 5.2.1).
- **State pruning** of old review sessions (P4-L1) — orthogonal.
- **AI enrichment** of history rows — inherits the existing no-op posture.

---

## 3. Discovery: the `recently-closed` section

### 3.1 Queries

GitHub's issue-search has **no boolean OR across qualifiers**, and `involves:@me` is `author OR assignee OR mentions OR commenter` — it **excludes reviewer**. So "active participant on a done PR" needs at least two searches, unioned client-side:

| Sub-query id | Search string |
|---|---|
| `involves` | `is:pr is:closed involves:@me closed:>=<cutoff> archived:false` |
| `reviewed` | `is:pr is:closed reviewed-by:@me closed:>=<cutoff> archived:false` |

`<cutoff>` is `today − windowDays` formatted `YYYY-MM-DD` (GitHub's `closed:>=` is day-granular — fine for a 14-day window). The date is computed **server-side** from a single injected clock seam (`Func<DateTimeOffset>`, the same pattern already in `PRism.Web/Logging/FileLoggerProvider.cs`), never inline `Now`, so it is testable and identical across both sub-queries within one refresh.

`is:closed` **includes merged PRs** (a merge is a close) and `closed:` filters on the close timestamp for both merged and closed-unmerged — verified design assumption. The union dedups by `PrReference`, so a PR matching both sub-queries appears once; the `MergedAt ?? ClosedAt` sort key handles the merged case (merge date == close date).

These are **2 additional Search API calls**. A full refresh issues **4 Search calls today** (`review-requested`, `awaiting-author`, `authored-by-me`, `mentioned`; `ci-failing` reuses the authored superset and is *not* a separate Search call — see `GitHubSectionQueryRunner.cs:18-24`), so this raises it to **6**. At 120s cadence that is 3 calls/min against the 30-req/min Search secondary limit — comfortably within budget. They run only when the section is enabled and visible (same `ResolveVisibleSections()` gate as every section).

**REST enrichment fan-out (the cost the Search count hides).** Because close-state comes from the REST enricher (§ 3.3), each closed row also costs one `pulls/{n}` GET — **up to `MaxHistoryRows` (30) extra REST calls per *cold* refresh**, on top of the open sections' existing fan-out. This hits the **5000/hr core limit** (a different budget from the 30/min Search limit), bounded by `GitHubPrEnricher`'s existing concurrency cap of 8. Worst case ≈ 30 calls/2 min = 15/min, well under 5000/hr. Steady state is near-free: a closed PR's `updated_at` is frozen, so the enricher cache `(Reference, UpdatedAt)` hits permanently after the first fetch. The plan must confirm the cap-8 semaphore is **shared** with the open-section fan-out (not a second concurrent burst of 8) so cold-start concurrency stays bounded.

> **Deferred sub-query + known coverage gap (logged):** `review-requested:@me is:closed` would cover the "requested but never engaged" sliver of (c) — a PR you were asked to review but **never commented on and never submitted a review for** before it closed. That case is a **clean miss** for the two shipped sub-queries: `involves` is author/assignee/mentions/commenter and `reviewed-by` requires a *submitted* review, so a purely-passive requested reviewer falls into neither — it is **not** redundant coverage. The slice ships this gap knowingly because (i) whether GitHub still returns a review-request after close is an **untested behavior assumption** (closing may dismiss the request, making the query dead weight), and (ii) the requested-but-totally-passive case is the weakest (c) variant. **Deferred** until a live search confirms `review-requested:@me is:closed` returns rows; if it does, it is a one-line addition to the union. Not shipped on an unverified premise.

### 3.2 Union, dedup, sort, cap

- **Union + dedup** by `PrReference` (owner/repo/number). A PR you authored *and* reviewed appears once. Intra-section only — see § 3.4 for cross-section.
- **Sort** by `MergedAt ?? ClosedAt` descending (most-recently-done first).
- **Cap** at the `MaxHistoryRows` constant (30) **after** sort, so the cap keeps the newest. When the cap truncates, surface a **non-count hint** at the foot of the section: *"Showing the 30 most recent — older closed PRs aren't listed. Paste a URL to open one."* This is the honest recovery path (the escape hatch is unbounded), and unlike the open sections — bounded by real actionability — this section is bounded by an arbitrary cap, so the user must be told the list is incomplete and how to reach the rest. Truncation is also logged. (Reaching the cap inside a 14-day window is the (b-without-link) signal, deferred by design.)

### 3.3 Row shape, close-state threading, and badge

Open-section rows use [`PrInboxItem`](../../PRism.Core.Contracts/PrInboxItem.cs), which has no close-state fields, and the pipeline's intermediate [`RawPrInboxItem`](../../PRism.Core/Inbox/RawPrInboxItem.cs) doesn't either. The section needs two facts neither carries: **merged-vs-closed** and **close time**. Critically, **no existing extraction site reads `merged_at`/`closed_at`** — `GitHubSectionQueryRunner.SearchAsync` reads only `updated_at`/`title`/`comments`, and `GitHubPrEnricher.FetchAsync` (the REST `pulls/{n}` fan-out) reads `head.sha`/`additions`/`deletions`/`commits`/`pushed_at`. So this is a thread-through, not a relabel:

- Add nullable `MergedAt: DateTimeOffset?` and `ClosedAt: DateTimeOffset?` to **both** `RawPrInboxItem` and `PrInboxItem` (both null on open rows ⇒ no behavior change).
- **Populate them in the REST enricher**, which is the authoritative source: `pulls/{n}` returns both `merged_at` and `closed_at` reliably. The Search payload's `pull_request` sub-object carries `merged_at` but **not** `closed_at` dependably, so the close timestamp for closed-unmerged PRs *must* come from the enricher, not Search. `MaterializePrInboxItem` carries the fields through. **Cache caveat:** `GitHubPrEnricher`'s cache key is `(Reference, UpdatedAt)`; a close transition normally bumps `updated_at` (cache miss → re-fetch with the new timestamps), but the new `MergedAt`/`ClosedAt` fields must be part of the cache identity (or the close branch must bypass the cache) so a transition that does *not* bump `updated_at` can't serve a stale open-era row with null timestamps. Cheapest acceptable alternative: accept the 120s self-heal and document it like the § 3.4 non-atomic note.
- **Badge**: `MergedAt != null` → `Merged`; else `Closed`. **Text-primary** (the word is the signal; any glyph is decorative) to avoid color-only encoding (WCAG 1.4.1) and the ambiguity of a bare `⊘`. The row `aria-label` includes the state ("… · merged" / "… · closed"). A merged PR has both timestamps set (merge implies close), so keying the badge on `MergedAt` presence — not on which timestamp is larger — guarantees a merged PR never renders "Closed."

**Empty-`HeadSha` survival (load-bearing — two drop points, not one).** Closed rows face **two** independent drop gates, and the plan must clear both:
1. **Enricher 404** (`GitHubPrEnricher.FetchAsync` returns `null` on `pulls/{n}` 404). This correctly drops a row whose repo was transferred/deleted (§ 7) — but a merged-with-deleted-*branch* PR still returns `200` from `pulls/{n}` (the PR object survives branch deletion), so this gate does **not** drop the headline case. The § 8 regression fixture must therefore be a PR with an **intact repo** and only the head branch deleted, else it exercises the wrong path.
2. **Empty-`HeadSha` filter** (`InboxRefreshOrchestrator.cs:120` drops items with empty `HeadSha`). Correct for open PRs (empty ⇒ enrichment failed), **wrong for closed ones**: dropping a deleted-branch merged PR would make the section silently miss exactly the PRs most likely to belong there. The dedicated branch **must not** route `recently-closed` items through this filter (or must exempt them). Prefer populating `HeadSha` from the `pulls/{n}` `head.sha` (still returned as a string after branch deletion) or `merge_commit_sha` so the row carries a real SHA and the empty-string special case disappears.

Acceptance test: *a merged PR with an intact repo + deleted head branch still appears in `recently-closed`* (§ 8).

**Unread signal and freshness (corrected to the real `InboxRow`).** `InboxRow` has **no "N new comments" delta badge** — it renders a `New` chip (gated on `lastViewedHeadSha == null`), a raw `commentCount`, and freshness glow (`rowFresh`/`rowToday`/`rowOlder`) off `updatedAt`. On a frozen PR these urgency cues are wrong: a closed PR receives **no new commits by definition**, so the `lastViewedHeadSha != HeadSha` "new commits" comparison is meaningless (and outright broken if `HeadSha` is empty — a stamped SHA `!= ""` reads as "always changed"). Therefore `recently-closed` rows **suppress the `New` chip and the freshness glow** (always neutral `rowOlder`), and render only the static facts (title / repo / author / age / `commentCount` + the Merged/Closed badge). No new "since you looked" delta badge is introduced this slice.

### 3.4 Cross-section dedup with the open sections

The five existing sections are `is:open`; `recently-closed` is `is:closed`. At steady state the sets are disjoint, so `recently-closed` does **not** participate in [`InboxDeduplicator`](../../PRism.Core/Inbox/InboxDeduplicator.cs)'s symmetric rules (1↔4, 3↔5) — those stay exactly as they are, and a regression test asserts they're unchanged. The one edge: the searches within a refresh are **not atomic**, so a PR that closes *between* an open-section search and the closed-section search could appear in both for a single 120s tick. The consequence is benign — two separate UI blocks show one row twice for one cycle, self-healing on the next refresh. Not worth an atomic "as-of" snapshot (YAGNI); noted so it isn't mistaken for a bug.

### 3.5 Section behavior and copy

- **Order**: last, after `ci-failing` (appended after the CI fan-out block in the orchestrator's explicit insertion order, ~line 157).
- **Initial state**: **collapsed**. The existing `InboxSection` hardcodes `useState(true)`; this needs a `defaultOpen?: boolean` prop, passed `false` for `recently-closed` (lowest-friction; avoids coupling the generic component to a section id). It is retrospective, not a daily-driver, and must not push the actionable sections down. Header: `Recently closed (N)`.
- **Load model**: the section's data is fetched on the standard 120s cadence **regardless of collapsed/expanded state** (the backend `ResolveVisibleSections()` gate is independent of UI expansion); expanding reveals **pre-fetched** rows with no additional load step, so there is no expand-triggered loading state — the empty-state copy fires immediately on first expand when the set is empty.
- **Empty state**: muted placeholder — *"No PRs closed in the last 14 days."* (window value tracks the constant).
- **All-empty interaction**: counts toward the existing "Nothing in your inbox right now" check like any section.
- **Hide**: `inbox.sections.recentlyClosed: false` removes the section and skips both queries.
- **Token-scope hiding**: a done PR in a repo the PAT can't read is hidden by the **existing** filter + footer. No new path.

---

## 4. Polling and the live transition

The section refreshes on the **same 120s inbox cadence** (one extra diff per cycle; no separate cadence — YAGNI). The standard inbox banner already covers "a PR newly appeared in a section," so a PR moving from an open section into `recently-closed` between polls surfaces with no new wiring. The **detail-view** live transition is § 5.2.3.

---

## 5. Read-only detail view: audit + gap closure

**This is mostly already built.** The job here is to *verify* existing behavior covers the three jobs and *close named gaps*, not to construct a read-only mode.

### 5.1 What already exists (verify, do not rebuild)

- [`Pr`](../../PRism.Core.Contracts/Pr.cs) carries `State`, `IsMerged`, `IsClosed`; frontend `types.ts` exposes `isMerged`/`isClosed`.
- `prState: 'open' | 'closed' | 'merged'` is derived in `FilesTab`, `OverviewTab`, `PrDetailPage`.
- `PrHeader` computes `isClosedOrMerged` → **suppresses the verdict picker and disables/hides Submit** (`PrHeader.tsx` ~112/310/330).
- Persistence is hard-blocked on done PRs (`useComposerAutoSave.ts` — `if (p.prState !== 'open') return;`) and composers render a "PR closed/merged — text not saved" banner; every composer honors `readOnly`.
- S5's submit pipeline already handles the closed/merged case (pending-review bulk-discard via `deletePullRequestReview`).

**Acceptance for § 5.1**: an audit pass (one Playwright spec + manual checklist) opening a merged PR **and** a closed-unmerged PR confirms (i) **zero** reachable GitHub-mutating control, **and** (ii) **the diff and threads render** — not just that controls are absent. Item (ii) is load-bearing, and there are **two distinct diff failure surfaces** that must be handled separately — the round-1 framing conflated them:

- **Primary diff** (`pulls/{n}/files` via `PaginatePullsFilesAsync`) — this is the canonical base..head diff and does **not** throw `RangeUnreachableException`; it calls `EnsureSuccessStatusCode()`, so a 404/410 on a transferred/GC'd PR propagates as a raw `HttpRequestException` → 500 / error page. The plan must map that to a typed, graceful "diff unavailable for this PR" result, **not** an error page. This is the gap that actually bites the merged-PR jobs.
- **Older-iteration diff** (cross-iteration `compare/{base}...{head}` via `FetchCompareFilesAsync`) — this is the *only* path that throws `RangeUnreachableException` (`GitHubReviewService.cs:312,615`) when intermediate iteration SHAs are GC'd. Fallback: an explicit "older iterations unavailable on this merged PR" message.

The plan must first **confirm whether the S3 `catch (RangeUnreachableException)` diff handler already shipped** (per `docs/plans/2026-05-06-s3-pr-detail-read.md`) and renders a user-visible `ProblemDetails`, not a raw 500 — if so, only the primary-diff typed-failure mapping + the Playwright assertions are net-new.

### 5.2 Named gaps to close

Specified here as acceptance criteria; the plan confirms which are genuinely absent and builds only those.

**5.2.1 — Merged/closed header label.** The header must state the terminal status: "Merged ⟨relative-time⟩" or "Closed ⟨relative-time⟩". **This is net-new, not a relabel** — but only the *timestamps* are: the PR-detail GraphQL query (`GitHubReviewService.cs:22-26`) already selects `closedAt`/`mergedAt`, but the `Pr` contract discards the values (it keeps only the `IsMerged`/`IsClosed` bools), so the plan surfaces `mergedAt`/`closedAt` through `Pr` + `types.ts`. The **"by ⟨login⟩" actor clause is dropped** (§ 2, deferred): it would require adding `mergedBy{login}` to the query plus contract threading for a display-only nicety, and "Merged ⟨when⟩" is complete information for every job this slice serves.

**5.2.2 — Read-only Drafts tab (the (c) collision, resolved locally).** If `state.json` holds unsubmitted drafts/replies/verdict for a now-done PR, the **Drafts tab** must render them **read-only and copy-able**, and the reconciliation / stale-draft surface is suppressed (no head to reconcile against). Today the Drafts tab (`DraftsTab` / `DraftListItem`) renders Edit/Delete unconditionally and `PrHeader` offers only a **destructive** "Discard all" on `isClosedOrMerged` — there is **no non-destructive read path**, so this is net-new. Implementation: thread `prState`/`readOnly` into `DraftsTab` to suppress the action buttons and render bodies as **selectable markdown text** (selectable text *is* the copy mechanism — no new component); the Drafts sub-tab stays in the strip.

The invariant collision — *"text is sacred"* (never delete drafts) vs *"truthful by default"* (never show un-submittable drafts as submittable) — is resolved **entirely locally**: the local draft text is preserved and shown **locked**, never auto-deleted, never presented as submittable. That satisfies both invariants for everything the PRism user sees.

> **Remote pending-review shell — deferred, not done here (round-2 reversal).** A non-null `pendingReviewId` (a GitHub PENDING-review shell from S5) on a now-closed PR is un-submittable cruft on github.com. Round 1 proposed courtesy-deleting it. **Round-2 adversarial review reversed this:** `DeletePendingReviewAsync` is **not** best-effort — it throws `GitHubGraphQLException` on any error (`GitHubReviewService.Submit.cs:177-194`), so deleting a closed PR's shell (the case most likely to 404 / already-be-gone) would *throw on the read path and break the local locked panel* it was meant to coexist with. Worse, with no specified trigger/idempotency guard and `isClosed` derived from a single read, an `isClosed`-briefly-wrong race could **delete a pending review on a still-open PR — real data loss.** It is the only *mutation* in an otherwise read-only slice, for a benefit (tidying a shell invisible inside PRism) that doesn't serve any of the three jobs. **Deferred** (§ 2). When eventually built, it must be: **fire-and-forget** (swallow `GitHubGraphQLException` / `HttpRequestException` / `RateLimitExceededException`, decoupled from render), **one-shot idempotent** (a per-session "already attempted" flag — the local `pendingReviewId` is never cleared, so a naive per-load trigger re-fires forever), gated on an **authoritative** done-state (the same confirmed `prState→done` signal as the § 5.2.3 banner, never a transient/optimistic read), with cross-tab staleness explicitly addressed or declared out of scope.

**5.2.3 — Live merge/close transition banner.** When a PR open in the detail view transitions to done (via the existing `PrUpdated` event / active-PR poller), surface a banner: *"This PR was just merged/closed. Unsubmitted drafts can no longer be submitted. Reload to read-only view."* "Banner, not mutation": no auto-mutate; Reload is explicit. The detail page already renders `BannerRefresh` ("N new updates") and `CrossTabPresenceBanner` in the same slot. To avoid stacked banners fighting for the slot, the transition banner **supersedes and replaces** `BannerRefresh` when `prState` flips to done (its Reload message is a strict superset of the update message), renders in the same slot with `role="status"`, and is **not dismissible** (unlike `BannerRefresh`) — the only safe next action is Reload.

### 5.3 Non-goals inside the detail view

- No "comment anyway" / re-open / re-review affordance.
- No dedicated "what changed since you last looked" diff beyond the existing unread badges + standard reload.

---

## 6. Components and data flow

**Backend (additive):**

- **Dedicated orchestrator branch** (not a new interface — matches the `ci-failing` fan-out precedent at `InboxRefreshOrchestrator.cs:133-145`): when `recently-closed` is enabled+visible, run the two searches, union/dedup/sort/cap, populate close-state via the REST enricher, and emit the section **without** routing through the empty-`HeadSha` drop filter. Clock seam injected for the cutoff.
- `InboxSectionsConfig` — add `bool RecentlyClosed` (default `true`); update the `AppConfig.Default` instantiation. `MaxHistoryRows` (30) and `HistoryWindowDays` (14) are **constants**, not config.
- `RawPrInboxItem` + `PrInboxItem` — add nullable `MergedAt` / `ClosedAt` (with the cache-key caveat, § 3.3).
- For § 5.2.1: surface the already-queried `mergedAt`/`closedAt` values through the `Pr` contract + `types.ts` (no new GraphQL field — the actor clause is deferred).

**Frontend (additive):**

- Inbox section list — render `recently-closed` last, `defaultOpen={false}`; text-primary merged/closed badge + aria state; neutral freshness; window-aware empty copy; truncation hint.
- Detail view — the § 5.2 gaps only (header label, read-only Drafts tab, transition banner). Read-only gating already flows from `prState`.

**Data flow:** inbox refresh → `ResolveVisibleSections()` includes `recently-closed` when enabled → dedicated branch runs 2 Search calls (server-computed cutoff) → REST enrich for close-state (no HeadSha filter) → union/dedup/sort/cap → section payload with per-row `MergedAt`/`ClosedAt` → diff vs prior snapshot → standard `InboxUpdated` SSE + banner. Detail open → existing PR fetch (now surfacing `mergedAt`/`closedAt`) → existing `readOnly` gating → § 5.2 surfaces.

---

## 7. Error handling

- **Per-sub-query isolation**: each search isolates failure like the existing sections (failed sub-query → empty + logged; the section renders from the other). Cancellation and `RateLimitExceededException` propagate to skip the tick.
- **A done PR that 404s** (repo transferred/deleted since close): the enrichment fan-out skips the row rather than failing the section. (Note: a merged-with-deleted-*branch* PR does **not** 404 — § 3.3.)
- **Primary diff fails** (`pulls/{n}/files` 404/410 on a transferred/GC'd done PR): map to a typed "diff unavailable" result, not a raw `HttpRequestException` → 500 (§ 5.1).
- **`RangeUnreachableException` on a GC'd cross-iteration diff** (§ 5.1): graceful "older iterations unavailable" message, not an error page.
- **Empty window**: muted placeholder, not an error.
- **Cap reached**: truncation hint (§ 3.2) + log.
- **Clock**: cutoff from the injected seam; never inline `Now`.

---

## 8. Testing

**Backend unit:**
- Cutoff from the clock seam (frozen-clock assertion on both sub-query strings).
- Two-way union + dedup by `PrReference` (author∩reviewer PR appears once).
- Sort by `MergedAt ?? ClosedAt` desc; cap keeps newest; cap-truncation logs + surfaces the hint.
- Close-state extraction end-to-end: a **closed-unmerged** PR gets non-null `ClosedAt` (from the REST enricher, since Search omits `closed_at`); a **merged** PR gets non-null `MergedAt`.
- **A merged PR with an intact repo + deleted head branch still appears** (empty-`HeadSha` exemption regression; the fixture must be intact-repo so it exercises the filter gate, not the enricher-404 gate — § 3.3).
- Badge derivation; section gating (disabled → both queries skipped); `InboxDeduplicator` unchanged (regression).
- Per-sub-query failure isolation.

**Detail read-only (audit):**
- Playwright: merged PR **and** closed-unmerged PR → zero reachable mutating control **and** diff + threads render.
- Read-only Drafts tab renders iff unsubmitted drafts exist; action buttons suppressed; bodies selectable; `state.json` drafts intact after viewing (no local OR remote deletion — remote cleanup is deferred, § 5.2.2).
- Reconciliation surface suppressed on a done PR.
- **Primary-diff failure** (`pulls/{n}/files` 404/410) renders the typed "diff unavailable" message, not a 500.
- **Cross-iteration `RangeUnreachableException`** path renders the "older iterations unavailable" fallback, not an error.
- Live-transition banner: unit test on the banner reducer for `PrUpdated` → done, including supersession of `BannerRefresh`. The **real-flow mid-view merge** Playwright e2e is **deferred to a follow-up** (needs a sandbox PR that merges mid-session — consistent with PR #58/#66 staging), recorded in the deferrals sidecar, not silently dropped.

**Frontend:**
- `recently-closed` collapsed by default (`defaultOpen={false}`); text-primary badges + aria state; neutral freshness; window-aware empty copy; truncation hint.

**Frozen-PR reuse:**
- The frozen-PR contract suite pins real merged PRs (#1/#16/#19/#22/#28). Reuse one to assert the read-only detail renders coherently — including the diff — against a *real* merged PR. **Confirm at least one fixture PR has a deleted head branch / GC'd SHAs**, else the test gives false confidence on the § 5.1 (ii) diff-renders criterion.

---

## 9. Open questions for the planning pass

- **`review-requested:@me is:closed` live check** — run the search against a real account; keep the sub-query only if it returns rows not already caught by `involves`/`reviewed-by` (§ 3.1).
- **S3 `RangeUnreachableException` handler status** — confirm the S3 diff handler shipped and renders a user-visible `ProblemDetails` (not a raw 500); if so, only the primary-diff typed-failure mapping + Playwright assertions are net-new (§ 5.1).
- **Frozen-PR fixture suitability** — does at least one of PRs #1/#16/#19/#22/#28 have an **intact repo + deleted head branch** (and GC'd intermediate SHAs), to exercise the § 5.1 diff-renders paths? If not, add a fixture that does.
- **Enricher cache identity** — add `MergedAt`/`ClosedAt` to the `GitHubPrEnricher` cache key, or accept the 120s self-heal (§ 3.3)?
- **Shared concurrency semaphore** — confirm the closed-section REST fan-out shares the cap-8 semaphore with the open-section fan-out rather than stacking a second burst (§ 3.1).

*(Resolved during this review and no longer open: config shape — hardcode constants + bool toggle, § 2; query-runner shape — orchestrator branch not interface, § 6; locked-panel shape — read-only `DraftsTab` reuse, local-only, § 5.2.2; header label — timestamp only, actor deferred, § 5.2.1; remote pending-review cleanup — deferred, § 5.2.2 / § 2.)*

---

## 10. Sequencing note (for the roadmap owner)

This slice pulls a P4 item ahead of v1's remaining critical path (the `v0.1.0` tag + first real `publish.yml` dispatch) and ahead of the validation trial that P4 nominally gates on. That is a legitimate move **if** dogfooding has surfaced revisiting-done-PRs as real friction; it is premature **if** it hasn't. The product-lens review also raised a sharper structural question: because (b-with-link) is fully served by the escape hatch and older-than-window (a) rides the deferred search path, the standing section's distinct value is narrowed to (c)-after-the-fact + within-window (a). A leaner alternative is to ship **only § 5 (read-only audit + gap closures)** — which is cheap and closes real coverage — and **defer the standing section** until a dogfood signal or the v1 trial confirms demand for a recently-done feed. Both the pull-forward and the section-vs-no-section call are the roadmap owner's; this spec documents the full section so the decision is made against a concrete artifact rather than in the abstract.

**Decision (2026-06-02): full slice.** The standing section ships alongside the read-only audit/gaps; the lean alternative is recorded above as considered-and-declined. The sequencing flag stands as a documented acknowledgement, not a blocker.
