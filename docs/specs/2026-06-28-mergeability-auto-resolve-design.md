# Mergeability Auto-Resolve (Fast Poll-Until-Definitive) — Design

**Issue:** #655 (PR-detail) + inbox extension (sibling scope, see § Issue Tracking)
**Date:** 2026-06-28
**Status:** Design — awaiting user review before planning

## Goal

When a PR's GitHub mergeability is transiently `UNKNOWN`, both the **PR-detail merge panel**
and the **inbox readiness badge** must resolve to the definitive state **automatically and
fast** (a couple of seconds, like GitHub's own UI) — with **no manual refresh** and **no
re-fetch of full PR detail**.

## Architecture (one sentence)

Reuse the existing **separate lightweight readiness query** (`IActivePrBatchReader` /
`GitHubPrBatchReader`) but, the moment `UNKNOWN` is observed for an open non-draft PR, drive
it on a **short exponential backoff burst** (≈1s→16s, ≈5 attempts) instead of the slow
general cadence; surface the resolved value over the SSE channels that already exist
(`pr-updated` for detail, `InboxUpdated` for inbox).

## Tech Stack

.NET 10 background services (`ActivePrPoller`, `InboxRefreshOrchestrator`), GraphQL readiness
batch readers, SSE fan-out, React/TS frontend (`useActivePrUpdates`, `prDetailContext`).

## Global Constraints

- **Separate query only.** Mergeability is fetched via the lightweight readiness batch query
  (head/base/comment/`mergeable`/`mergeStateStatus`/`reviewDecision`/reviews), **never** via
  `GetPrDetailAsync` (diff/timeline/body). No PR-detail re-fetch is ever triggered by a
  mergeability change.
- **Bounded.** The expensive readiness fields force per-PR server-side merge-state compute
  (the reason `GitHubPrBatchReader` caps at 50 aliases, `GitHubPrBatchReader.cs:24-29`). The
  fast burst is capped at **≈5 attempts** per `(ref, head-state)` / `(ref, UpdatedAt)`; after
  the cap a still-`UNKNOWN` PR stops fast-polling (it reverts to normal cadence / next-activity
  pickup) so a forever-`UNKNOWN` PR (e.g. no push access) is never hammered indefinitely.
- **No flicker regression.** Reuse the existing anti-flicker guard: only a change **to** a
  non-`None` readiness publishes (`ActivePrPoller.cs:195-196`); a transient `None` must never
  blank or churn a live badge.
- **Skip drafts entirely.** A draft PR is legitimately `None` (rule: draft → `None`) and must
  **never** be fast-polled on either surface — its `None` is definitive, not transient. Draft
  detection requires `isDraft`, which both readiness readers already fetch from GraphQL for the
  rule; it is plumbed where the skip decision is made (see C2, C3).

---

## Root Cause (shared by both surfaces)

A transient `UNKNOWN` gets **frozen** into a cache that never re-checks it, and even when the
general poll cadence re-checks, it is too slow:

- **PR-detail panel:** `PrActionsPanel` reads readiness off the loaded detail snapshot
  (`usePrDetailContext()`, `PrActionsPanel.tsx:43`), not the live `pr-updated` feed — so it
  shows the snapshot's `None` permanently. (The header already reads the live feed and self-heals;
  the panel alone diverged.)
- **Inbox:** `GitHubPrBatchReader` caches readiness keyed by `(ref, UpdatedAt)`. A first read of
  `UNKNOWN`→`None` is cached; GitHub finishing the compute does **not** bump `UpdatedAt`, so every
  60s refresh re-serves the frozen `None` and a manual refresh can't change it.
- **Cadence latency:** even once unfrozen, `ActivePrPoller` (30s) and `InboxPoller` (~60s) are
  far slower than GitHub's few-seconds compute.

---

## Components

### C1 — PR-detail: panel consumes the live readiness feed (frontend-only)

The live readiness already arrives over SSE: `pr-updated` carries `mergeReadiness`, and
`useActivePrUpdates` latches it (`useActivePrUpdates.ts:84`). `PrDetailView` already overlays it
for the header (`updates.mergeReadiness ?? data?.pr.mergeReadiness`, `PrDetailView.tsx:527`).

**Change:** thread that same live value into `PrActionsPanel`.
- Add a `liveMergeReadiness?: MergeReadiness` field to `prDetailContext`, populated in
  `PrDetailView` from `updates.mergeReadiness` (where `updates` already exists).
- `PrActionsPanel` reads `liveMergeReadiness ?? pr.mergeReadiness` everywhere it currently reads
  `pr.mergeReadiness` for gating/labelling.
- The panel does **not** call `useActivePrUpdates` itself (it has subscribe/unsubscribe side
  effects — a second caller would double-subscribe). It consumes the value via context.

The snapshot's `pr.mergeReadiness` remains only the **first-paint seed** (so an already-computed
PR shows its badge instantly), overlaid by the live value the instant it resolves. No loader
eviction, no PR-detail re-fetch.

### C2 — PR-detail: adaptive fast-retry in `ActivePrPoller`

The poller already polls every subscribed PR via the separate readiness query and publishes
`ActivePrUpdated{ MergeReadinessChanged }` on a `None`→`Ready` flip. The only gap is the **30s
cadence**.

**Change — make the poll cadence adaptive per PR:**
- Track a per-PR fast-retry counter in `ActivePrPollerState` (distinct from the existing
  error-backoff counter).
- In `TickAsync`, after deriving the snapshot, if the PR is **open**, **not a draft**, and its
  `Mergeability` string is `"UNKNOWN"` and the fast-retry counter is under the cap, set
  `state.NextRetryAt = now + fastBackoff(attempt)` (1s, 2s, 4s, 8s, 16s) and increment the
  counter. When readiness becomes definitive (non-`None`) the counter resets and normal cadence
  resumes.
- In `ExecuteAsync`, change the loop delay from a flat `_cadence` to
  `min(_cadence, time-until-soonest-pending NextRetryAt)`, so a PR scheduled at `now+1s` wakes the
  loop in ~1s instead of 30s. (The batched query still serves all due PRs in one read.)
- After the cap (≈5 fast attempts) a still-`UNKNOWN` PR stops being fast-scheduled and falls back
  to the 30s cadence.

**Draft skip:** a draft open PR can also report `mergeable: UNKNOWN`, but a draft is legitimately
not mergeable, so it must not be fast-polled. Add `IsDraft` to `ActivePrPollSnapshot`, populated by
`GitHubActivePrBatchReader` from the GraphQL `isDraft` it already reads for the readiness rule. The
fast-retry condition excludes drafts (`IsDraft == false`).

Resolution path: poller fast-detects the flip → publishes `ActivePrUpdated{ MergeReadinessChanged }`
→ SSE `pr-updated` → `useActivePrUpdates` → panel (C1) + header update. ~1–3s typical.

### C3 — Inbox: unfreeze the readiness cache + fast re-probe pass

Two changes, both mirroring patterns the inbox already uses (the CI probe / async-enrichment patch).

**C3a — stop freezing `None`.** In `GitHubPrBatchReader`, a derived `None` is treated as
**non-definitive only for an open, non-draft PR whose `mergeable` is `UNKNOWN`** — it is not
served as a cache hit, so a re-read re-fetches it. A draft, closed, or merged PR (and any
definitive readiness — `Ready`/`Conflicts`/etc.) caches normally under `(ref, UpdatedAt)`; the
reader already has `isDraft` at derivation time, so drafts are never marked non-definitive. The
non-definitive state is bounded by the per-`(ref, UpdatedAt)` attempt cap below; after the cap,
the `None` is cached so re-reads stop until `UpdatedAt` changes.

To let the inbox orchestrator select re-probe targets (C3b) without re-deriving draftness, expose
`IsDraft` (or an equivalent "readiness pending" signal) on the inbox item so "open, non-draft,
still-`UNKNOWN`" rows are identifiable; drafts are excluded from the target set.

**C3b — fast readiness re-probe pass.** After `RefreshAsync` hydrates and leaves open non-draft
PRs at `None`, run a short-backoff background pass (analogous to the CI probe at
`InboxRefreshOrchestrator.cs:191-223` and the async `OnInboxEnrichmentsReady` patch):
- Re-read **only** those rows' readiness via the batch reader (force-fresh, per C3a), on the fast
  schedule (1s, 2s, 4s, 8s, 16s).
- On each pass, patch the resolved rows into the current `InboxSnapshot` and publish
  `InboxUpdated` (same patch-and-notify shape as the enrichment pass) so the badges appear.
- Dedupe: at most one re-probe pass in flight per refresh generation; cancel it when the next full
  refresh starts or on teardown. Stop when all targeted rows are definitive or the cap is reached.

Resolution path: probe re-reads → patches snapshot → `InboxUpdated` SSE → client re-GETs
`/api/inbox` → badge appears. ~1–3s typical.

---

## Data Flow

```
GitHub (async mergeability compute, ~seconds)
   │
   ├─ PR-detail ──────────────────────────────────────────────────────────────
   │   ActivePrPoller (separate readiness query, ADAPTIVE 1→16s while UNKNOWN, C2)
   │      → ActivePrUpdated{ MergeReadinessChanged } → SSE pr-updated
   │      → useActivePrUpdates.mergeReadiness
   │      → PrHeader (already) + PrActionsPanel (C1, newly plumbed)
   │
   └─ Inbox ──────────────────────────────────────────────────────────────────
       InboxRefreshOrchestrator.RefreshAsync → GitHubPrBatchReader (None NOT frozen, C3a)
          → fast readiness re-probe pass (C3b) → patch InboxSnapshot → InboxUpdated SSE
          → client re-GET /api/inbox → InboxRow ReadinessBadge
```

## The Bound (fast schedule + cap)

- Schedule: `fastBackoff(n)` = `2^n` seconds for n = 0..4 → **1, 2, 4, 8, 16s**; ≈5 attempts,
  ~31s worst case. Common case resolves at attempt 0–1 (1–3s).
- Cap key: detail = per `(ref, head-state)`; inbox = per `(ref, UpdatedAt)`. A new commit
  (head/UpdatedAt change) resets the budget and re-attempts (fresh compute warrants fresh polling).
- After the cap: detail reverts to the 30s cadence; inbox caches the `None` and waits for the next
  `UpdatedAt` change or a manual refresh.

## Error Handling

- Reuse the poller's existing whole-tick rate-limit / transport backoff (`ActivePrPoller.cs`
  rate-limit + poison-payload paths) — a fast tick that errors backs off and retains last-known,
  publishes nothing.
- The inbox re-probe swallows tick-level errors like the existing CI-probe / refresh passes; a
  failed pass leaves the prior snapshot intact and the next pass (or full refresh) retries.
- The attempt cap is itself the safeguard against an endpoint that never returns definitive.

## Testing

- **C1 (vitest):** `PrActionsPanel` with snapshot `mergeReadiness: None` + context
  `liveMergeReadiness: ready` → panel enables/labels as ready; with both `None` → disabled reason
  shows. Assert the panel reads the live value, not the snapshot.
- **C2 (xunit, `ActivePrPollerTests`):** open `UNKNOWN` PR schedules `NextRetryAt ≈ now+1s`;
  `ExecuteAsync` loop wakes early (`min(cadence, nextRetry)`); resolves on a definitive tick and
  publishes `ActivePrUpdated{ MergeReadinessChanged }`; stops fast-scheduling after the cap;
  a definitive (Ready) PR, a `Closed`/`Merged` PR, and a **draft** (`IsDraft == true`,
  `Mergeability == "UNKNOWN"`) PR are **not** fast-scheduled; steady Ready→Ready does not
  fast-schedule.
- **C3a (xunit, `GitHubPrBatchReaderTests`):** open non-draft `UNKNOWN`→`None` is not served from
  cache on the next read (re-fetches); a **draft** `None` **is** cache-served (never re-fetched); a
  definitive readiness is cache-served; after the attempt cap, `None` is cache-served (stops
  re-fetching).
- **C3b (xunit, `InboxRefreshOrchestratorTests`):** a refresh leaving an open non-draft PR at `None`
  triggers a re-probe that re-reads only that row, patches the snapshot, and publishes
  `InboxUpdated`; a **draft** at `None` is **not** a re-probe target; stops at cap; a refresh with
  all-definitive readiness triggers no re-probe; one pass in flight per generation.
- **Live B-gate:** push a commit to a `prpande/prism-sandbox` PR and immediately observe both the
  inbox badge and the detail panel resolve from blank → definitive within a few seconds, with no
  manual refresh (validates the GitHub `UNKNOWN`→definitive premise on a re-read).

## Out of Scope / Deferrals

- No new dedicated query endpoint — reuse the existing readiness batch readers (DRY; a parallel
  query would duplicate `IActivePrBatchReader`).
- No per-row live-readiness SSE channel for the inbox — the inbox updates via its existing
  snapshot+`InboxUpdated` mechanism.
- Re-open-instant correctness on PR-detail (a re-opened PR that resolved while away shows the seed
  for up to one fast tick) is accepted; it self-heals within ~1–3s on re-subscribe and matches the
  header's current behavior.

## Issue Tracking

#655 is **re-scoped to cover both surfaces** — PR-detail (C1/C2) and inbox (C3) — and its body is
updated to describe the inbox case and the draft-skip. Both ship together on this branch.
