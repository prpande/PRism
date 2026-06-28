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
- **Bounded — the cap governs only the FAST tier, it never freezes the badge.** The expensive
  readiness fields force per-PR server-side merge-state compute (the reason `GitHubPrBatchReader`
  caps at 50 aliases, `GitHubPrBatchReader.cs:24-29`). The fast burst is capped at **≈5 attempts**
  per `(ref, headSha)` (detail) / `(ref, UpdatedAt)` (inbox). After the cap a still-`UNKNOWN` PR
  stops *fast*-polling but **continues to be re-read on the normal cadence** (detail 30s poller;
  inbox 60s refresh) — its `None` is **never permanently cached as definitive** for an open
  non-draft PR. This both (a) keeps a slow-to-compute PR self-healing automatically with no manual
  refresh, and (b) bounds cost: a forever-`UNKNOWN` PR (e.g. no push access) is re-read at most once
  per normal cadence as one extra alias in a batch that already runs — not hammered at 1Hz.
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

**Accessibility — announce the auto-resolution.** When readiness resolves on its own, the Merge
button enables (or a disabled reason appears) with no user action, and the `none`-state inline
"Mergeability is still being calculated." sentence is replaced by the compact (hover/focus-only)
`ReadinessBadge`. Both are silent to assistive tech today. Add a **readiness-resolved branch to the
existing `role=status` live region** in `PrActionsPanel`: track the `none`→non-`none` edge (prev-ref
vs current `liveMergeReadiness` in a `useEffect`) and announce `"Pull request is ready to merge"` for
mergeable states, or `"Merge unavailable: <READINESS_SHORT>"` for disabled-definitive states. This
reuses the component's established live-region pattern and also covers the visual `none`→badge swap
(the announcement compensates for the abrupt DOM change; we accept the instant swap rather than a
transient inline reason).

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
- **Load-bearing ordering (do not miss this):** the existing success path unconditionally runs
  `state.NextRetryAt = null;` at `ActivePrPoller.cs:233`, *after* the publish block. That reset must
  become **conditional** — clear `NextRetryAt` only when readiness is definitive; on an `UNKNOWN`
  tick the fast-retry `NextRetryAt` written above must survive the success path, or C2 silently
  no-ops (every UNKNOWN PR reverts straight to the 30s cadence). The C2 test asserts `NextRetryAt`
  is non-null after a successful UNKNOWN tick.
- In `ExecuteAsync`, change the loop delay from a flat `_cadence` to
  `min(_cadence, time-until-soonest-pending NextRetryAt)`, so a PR scheduled at `now+1s` wakes the
  loop in ~1s instead of 30s. The early wake re-polls the **whole** subscribed batch in one read
  (the `candidates` filter at `ActivePrPoller.cs:145` includes every non-backed-off PR) — fine
  because the detail subscriber set is small (the PRs you're actively viewing); revisit only if
  that set ever grows large.
- After the cap (≈5 fast attempts) a still-`UNKNOWN` PR stops being *fast*-scheduled and falls back
  to the normal 30s cadence (it is **not** frozen — the poller keeps polling, and the panel keeps
  overlaying the live value when it eventually resolves).
- **Draft→ready latency caveat:** a draft→non-draft flip changes neither head SHA nor `PrState`, so
  nothing wakes the loop early; the burst only arms on the next normal 30s tick. The "couple of
  seconds" goal therefore has up to one cadence of latency for that specific transition. Accepted
  (un-drafting is a deliberate user action, not the freshly-opened-PR case this targets).

**Draft skip:** a draft open PR can also report `mergeable: UNKNOWN`, but a draft is legitimately
not mergeable, so it must not be fast-polled. Add `IsDraft` to `ActivePrPollSnapshot`, populated by
`GitHubActivePrBatchReader` from the GraphQL `isDraft` it already reads for the readiness rule. The
fast-retry condition excludes drafts (`IsDraft == false`).

**Re-open correctness — re-emit readiness on (re)subscribe.** When a client (re)subscribes to a PR
(`POST /api/events/subscriptions`), the server emits that PR's last-known readiness as a **targeted**
`pr-updated{ MergeReadinessChanged = true }` to the subscribing connection only (not a fanout). This
closes the re-open gap: when the poller state survived the unsubscribe/re-subscribe (same-cadence
race, `ActivePrPoller.cs:121-137`) and readiness is unchanged, no organic event fires, so without
this the panel would sit on the stale `None` seed until the next genuine readiness change. Value
source = the poller's last-known readiness for the ref (`ActivePrPollerState.LastMergeReadiness`, or
the active-PR cache); if it is itself `None` for an open non-draft PR, the fast burst arms as usual.
Emit only when last-known readiness is non-`None` (mirrors the anti-flicker guard — a `None` re-emit
would carry nothing and the seed already shows `none`).

Resolution path: poller fast-detects the flip → publishes `ActivePrUpdated{ MergeReadinessChanged }`
→ SSE `pr-updated` → `useActivePrUpdates` → panel (C1) + header update. ~1–3s typical.

### C3 — Inbox: unfreeze the readiness cache + fast re-probe pass

Two changes, both mirroring patterns the inbox already uses (the CI probe / async-enrichment patch).

**C3a — stop freezing `None`.** In `GitHubPrBatchReader`, a derived `None` is treated as
**non-definitive only for an open, non-draft PR whose `mergeable` is `UNKNOWN`** — it is not
served as a cache hit, so a re-read re-fetches it. A draft, closed, or merged PR (and any
definitive readiness — `Ready`/`Conflicts`/etc.) caches normally under `(ref, UpdatedAt)`; the
reader already has `isDraft` at derivation time, so drafts are never marked non-definitive. A
non-definitive `None` is never cached as definitive — it is re-read every cadence until it resolves
(fast during the C3b burst, then on the normal 60s refresh), so the badge always self-heals.

- **Attempt-counter location.** The fast cap needs a per-`(ref, UpdatedAt)` fast-attempt counter,
  but the "don't write the `None`" rule means it cannot live as a cache value. Put it in a parallel
  `ConcurrentDictionary<(ref, UpdatedAt), int>` that is pruned against the **same live ref set** as
  `InboxCacheEviction.PruneAbsent` (`GitHubPrBatchReader.cs:100`), so it can't leak (the `_state`/
  `_cache` co-prune pattern in `ActivePrPoller.TickAsync`). The counter caps the *fast* tier only;
  it does not stop normal-cadence re-reads.
- **Manual refresh resets the fast budget.** `RefreshAsync(hardRefresh: true)` (the inbox Refresh
  button) currently threads `hardRefresh` only into the CI detector (`forceReprobe`,
  `InboxRefreshOrchestrator.cs:204`); `_batchReader.ReadAsync` has no force parameter. Thread
  `hardRefresh` into the reader so a manual refresh **resets the fast-attempt counter** for
  still-`UNKNOWN` open rows (re-opening the fast burst on demand). Without this, a manual refresh
  only triggers a normal-cadence re-read, not a fast one.

To let the inbox orchestrator select re-probe targets (C3b) without re-deriving draftness, expose
`IsDraft` (or an equivalent "readiness pending" signal) on the inbox item so "open, non-draft,
still-`UNKNOWN`" rows are identifiable; drafts are excluded from the target set.

**C3b — fast readiness re-probe pass.** After `RefreshAsync` hydrates and leaves open non-draft
PRs at `None`, run a short-backoff background pass on the fast schedule (1s, 2s, 4s, 8s, 16s):
- **Pass the FULL current inbox item set to `ReadAsync`, not just the UNKNOWN rows**, then patch
  only the resolved UNKNOWN rows. `ReadAsync`'s final step `InboxCacheEviction.PruneAbsent(_cache,
  liveRefs)` (`GitHubPrBatchReader.cs:100`) drops every cache entry whose ref is **absent** from the
  passed list — a subset call would evict the readiness cache for every other inbox PR and force a
  full re-fetch of all open PRs. Per C3a, the still-`UNKNOWN` rows in that full set are re-fetched;
  the rest are cache-served, so the read is cheap.
- **Lifecycle (net-new machinery — the CI-probe / enrichment analogy does NOT supply this).** The
  CI probe is awaited synchronously inside `RefreshAsync`; `OnInboxEnrichmentsReady` is bus-driven —
  neither is a self-scheduled backoff loop. The re-probe is a **detached `Task` launched at the end
  of `RefreshAsync`**, owning a per-refresh-generation `CancellationTokenSource` field on the
  orchestrator; starting a new refresh cancels the prior pass's CTS (one pass in flight), and
  teardown cancels via `_disposed`. Only the **patch-and-publish body** is reused from
  `OnInboxEnrichmentsReady`: take the writer lock, re-read `_current`, `Volatile.Write` the patched
  snapshot, publish `InboxUpdated`.
- Stop the fast loop when all targeted rows are definitive or the fast cap is reached; either way
  the rows remain non-frozen and ride the normal 60s refresh thereafter (per C3a).

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
- Cap key: detail = per `(ref, headSha)`; inbox = per `(ref, UpdatedAt)`. A new commit
  (headSha/UpdatedAt change) resets the budget and re-attempts (fresh compute warrants fresh
  polling). For the inbox, a manual hard refresh also resets the budget (see C3a).
- After the cap: the PR is no longer *fast*-scheduled but is **not frozen** — detail reverts to the
  30s poll cadence, inbox to the 60s refresh re-read (C3a). A slow-to-compute PR therefore still
  self-heals automatically (no manual refresh required); the cap only stops the 1Hz burst.
- **Aggregate cost / fan-out.** The per-PR cap does not bound concurrent count, but three existing
  mechanisms do: the readiness query is **batched** (one read serves all due PRs, ≤50 aliases per
  chunk), the inbox re-probe is **one-pass-in-flight per generation**, and both inherit the poller's
  **rate-limit backoff**. Worst case is a base-branch push invalidating mergeability for every open
  PR at once; the batching + single-pass + backoff keep that within the GraphQL limit the design
  cites, and the detail poller's subscriber set (PRs you're viewing) is small. No additional
  aggregate cap is added.

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
  shows. Assert the panel reads the live value, not the snapshot. Assert the `none`→`ready` edge
  fires the live-region announcement (`"Pull request is ready to merge"`), and a `none`→disabled
  edge announces `"Merge unavailable: <reason>"`.
- **C2 (xunit, `ActivePrPollerTests`):** open `UNKNOWN` PR schedules `NextRetryAt ≈ now+1s` and
  **`NextRetryAt` survives the successful UNKNOWN tick** (the conditional-reset fix — it is not
  nulled at the `:233` success path); `ExecuteAsync` loop wakes early (`min(cadence, nextRetry)`);
  resolves on a definitive tick and publishes `ActivePrUpdated{ MergeReadinessChanged }`; after the
  cap the PR stops *fast*-scheduling but is **still polled at the normal cadence** (not frozen); a
  definitive (Ready) PR, a `Closed`/`Merged` PR, and a **draft** (`IsDraft == true`,
  `Mergeability == "UNKNOWN"`) PR are **not** fast-scheduled; steady Ready→Ready does not
  fast-schedule.
- **Re-emit on subscribe (xunit, SSE / subscription endpoint tests):** subscribing to a PR whose
  last-known readiness is `ready` emits a **targeted** `pr-updated{ MergeReadinessChanged = true }`
  to that connection only (not fanned out to other subscribers); subscribing when last-known is
  `None` emits nothing (anti-flicker).
- **C3a (xunit, `GitHubPrBatchReaderTests`):** open non-draft `UNKNOWN`→`None` is not served from
  cache on the next read (re-fetches) — including **after the fast cap** (never frozen as
  definitive); a **draft** `None` **is** cache-served (never re-fetched); a definitive readiness is
  cache-served; `ReadAsync(hardRefresh: true)` resets the fast-attempt counter for a still-`UNKNOWN`
  open row; the fast-attempt counter is pruned with `PruneAbsent` (no leak).
- **C3b (xunit, `InboxRefreshOrchestratorTests`):** a refresh leaving an open non-draft PR at `None`
  triggers a re-probe that calls `ReadAsync` with the **full item set** (not a subset) and patches
  only that row — assert the readiness cache for the OTHER rows is **not** evicted; publishes
  `InboxUpdated`; a **draft** at `None` is **not** a re-probe target; a refresh with all-definitive
  readiness triggers no re-probe; a new refresh **cancels the prior in-flight pass** (one pass per
  generation); after the fast cap the pass stops but the row stays non-frozen.
- **Live B-gate:** push a commit to a `prpande/prism-sandbox` PR and immediately observe both the
  inbox badge and the detail panel resolve from blank → definitive within a few seconds, with no
  manual refresh (validates the GitHub `UNKNOWN`→definitive premise on a re-read). Also exercise the
  **slow-compute path**: confirm a PR that stays `UNKNOWN` past the ~31s fast burst still resolves on
  the next normal-cadence read (never permanently blank).

## Out of Scope / Deferrals

- No new dedicated query endpoint — reuse the existing readiness batch readers (DRY; a parallel
  query would duplicate `IActivePrBatchReader`).
- No per-row live-readiness SSE channel for the inbox — the inbox updates via its existing
  snapshot+`InboxUpdated` mechanism.
- **Inbox badge appearance is not proactively announced to AT** (the row button is not a live
  region; its `aria-label` gains the readiness suffix on re-render). Accepted — it matches the
  existing async inbox-update behavior (CI probe, AI enrichment), which is also not announced.

## Issue Tracking

#655 is **re-scoped to cover both surfaces** — PR-detail (C1/C2) and inbox (C3) — and its body is
updated to describe the inbox case and the draft-skip.

**Delivery slicing.** C1+C2 (PR-detail) and C3 (inbox) share **no modified files** and touch
independent pipeline paths, so they are independently deliverable. They ship together on this branch
per direction; if C3's net-new re-probe lifecycle (detached task + per-generation CTS) hits
complications, C1+C2 may be split to a separate PR so the PR-detail fix is not blocked. C3 is the
larger/riskier half (new background machinery), so it carries the deeper review and test burden.
