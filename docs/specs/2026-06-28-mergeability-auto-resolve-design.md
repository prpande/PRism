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
existing `role=status` live region** in `PrActionsPanel`: announce `"Pull request is ready to merge"`
for mergeable states, or `"Merge unavailable: <READINESS_SHORT>"` for disabled-definitive states.
This reuses the component's established live-region pattern and also covers the visual `none`→badge
swap (the announcement compensates for the abrupt DOM change; we accept the instant swap rather than
a transient inline reason).

Two edge cases the naive implementation gets wrong:
- **Track the *effective* readiness, not `liveMergeReadiness` alone.** `useActivePrUpdates` resets
  `liveMergeReadiness` to `undefined` on every PR navigation (`useActivePrUpdates.ts:60`), and the
  C2 re-emit then fires `mergeReadinessChanged` for an already-ready PR — so an edge keyed on
  `liveMergeReadiness` would re-announce "ready to merge" on **every navigate-back** to a ready PR.
  Track `effective = liveMergeReadiness ?? pr?.mergeReadiness ?? 'none'` in a `useRef` seeded to the
  snapshot value, and fire only on an `effective` `none`→non-`none` transition. Navigate-back to a
  ready PR has `effective` already non-`none` (the seed), so it stays silent; genuine auto-resolve
  starts at `none` and fires once.
- **Don't drop keyboard focus when the Refresh button unmounts.** The `none`-state Refresh button
  unmounts when readiness auto-resolves; a keyboard user parked on it loses focus to `<body>`. The
  existing focus-recovery guard (`PrActionsPanel.tsx:131-140`) only fires when `refreshArmedRef` was
  set by a Refresh *click*, not by a background resolve. Widen the guard to
  `refreshArmedRef.current || document.activeElement === refreshBtnRef.current` (add a `refreshBtnRef`);
  both paths reuse the existing focus-destination logic (Merge button when enabled, reason node when
  disabled).

### C2 — PR-detail: adaptive fast-retry in `ActivePrPoller`

The poller already polls every subscribed PR via the separate readiness query and publishes
`ActivePrUpdated{ MergeReadinessChanged }` on a `None`→`Ready` flip. The only gap is the **30s
cadence**.

**Change — make the poll cadence adaptive per PR:**
- Track a per-PR fast-retry counter in `ActivePrPollerState` (distinct from the existing
  error-backoff counter).
- In `TickAsync`, after deriving the snapshot, if the PR is **open**, **not a draft**, **not
  terminal** (not merged/closed), and its **derived `MergeReadiness` is `None`**, and the
  fast-retry counter is under the cap, set `state.NextRetryAt = now + fastBackoff(attempt)` (1s, 2s,
  4s, 8s, 16s) and increment the counter. When readiness becomes definitive (non-`None`) the counter
  resets and normal cadence resumes.
  - **Gate on the derived readiness, not a raw field.** `MergeReadinessRule.Derive` returns `None`
    from *several* transient inputs — `mergeable == UNKNOWN`, **and** `mergeStateStatus`
    UNKNOWN/null while `mergeable` is already `MERGEABLE`/`CONFLICTING` (GitHub's `mergeStateStatus`
    can lag `mergeable` during the compute window). Keying the fast-retry on the raw `Mergeability`
    string would miss that lag case and leave the badge stuck. Keying on the derived `None` covers
    every transient path with one check.
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
- **Subscribe must wake the loop (the freshly-opened-PR case — the primary target).** A just-opened
  PR has no poller state and no `NextRetryAt`, and `ExecuteAsync` is already asleep on a flat
  cadence — so `min(cadence, NextRetryAt)` cannot shorten the *current* sleep, and the burst can't
  even start for up to 30s, missing the "couple of seconds" goal exactly where it matters most. Add
  a **coalescing wake signal** to `ActivePrPoller`, triggered when a PR newly subscribes
  (`ActivePrSubscriberRegistry`). Implementation specifics:
  - `ExecuteAsync` must adopt `InboxPoller`'s full pattern — a `SemaphoreSlim(0,1)` raced against
    `Task.Delay` via `Task.WhenAny`, **including the signal-loss defense** (`InboxPoller.cs:89-103`,
    ADV-PR2-001). The current flat `Task.Delay(_cadence)` (`ActivePrPoller.cs:105`) has no signal
    race; a bare `min(cadence, NextRetryAt)` delay does **not** cover the freshly-subscribed (no
    prior state) case.
  - **DI seam.** `ActivePrPoller` is registered hosted-service-only
    (`AddHostedService<ActivePrPoller>()`), so it can't be injected to receive the signal. Switch to
    `InboxPoller`'s dual registration — `AddSingleton<ActivePrPoller>()` + `AddHostedService(sp =>
    sp.GetRequiredService<ActivePrPoller>())` — inject the concrete `ActivePrPoller` into
    `SseChannel` (already modified for the re-emit) and call `RequestImmediateRefresh` from
    `TrySubscribe` after the registry add. Add a resolvability test mirroring `InboxPoller`'s.
  - **Min-interval guard.** `useActivePrUpdates` re-subscribes on every SSE reconnect, so a reconnect
    storm would fire back-to-back wakes → back-to-back full-batch readiness polls past the cadence
    floor. Ignore a wake if the loop already ticked within the last few seconds (mirror the
    manual-refresh debounce), so churn can't amplify the expensive query.
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
this the panel would sit on the stale `None` seed until the next genuine readiness change.

**Value source — name a reachable seam.** Neither candidate source exists today: `ActivePrPollerState.LastMergeReadiness`
is private poller state (and reading it off the request thread would violate its single-threaded
mutation discipline), and the active-PR cache (`ActivePrSnapshot`) carries only SHAs/counts, no
readiness. So: add a `MergeReadiness` field to `ActivePrSnapshot`/`IActivePrCache`, populated at the
existing `_cache.Update` call (`ActivePrPoller.cs:237`) from `snapshot.MergeReadiness`; inject the
already-registered `IActivePrCache` singleton into `SseChannel`; the subscribe path
(`SseChannel.TrySubscribe`, which already resolves the subscriber id) writes a targeted `pr-updated`
frame to that one connection when the cached readiness is non-`None`. The cache field **retains the
last-known non-`None`** readiness (mirror `ActivePrPollerState.LastMergeReadiness` at
`ActivePrPoller.cs:230-231` — do not overwrite a cached `Ready` with a transient recompute `None`),
so a re-subscribe surfaces the last real value. If it is `None`/absent (a brand-new PR that has never
resolved), emit nothing and let the C2 burst arm. This adds `IActivePrCache`/`ActivePrSnapshot`,
`SseChannel`, and the subscription endpoint to C1/C2's file set (see Delivery slicing).

*Narrow known race (accepted):* the poller publishes `ActivePrUpdated` (`:205`) **before**
`_cache.Update` (`:237`), so a re-subscribe whose cache read lands in that microsecond window — for a
PR resolving `None`→`Ready` on that exact tick with surviving poller state — both misses the organic
fanout and reads the pre-update value, emitting nothing; the steady `Ready→Ready` anti-flicker guard
then never re-publishes. Recovery: the value is in the cache after `:237`, so the next re-navigation
(or any genuine readiness change) resolves it. Not worth reordering the load-bearing
publish-before-update sequence for a window this narrow.

Resolution path: poller fast-detects the flip → publishes `ActivePrUpdated{ MergeReadinessChanged }`
→ SSE `pr-updated` → `useActivePrUpdates` → panel (C1) + header update. ~1–3s typical.

### C3 — Inbox: unfreeze the readiness cache + fast re-probe pass

Two changes, both mirroring patterns the inbox already uses (the CI probe / async-enrichment patch).

**C3a — stop freezing `None` (a pure stateless skip in the reader).** In `GitHubPrBatchReader`, a
derived `MergeReadiness == None` for an **open, non-draft, non-terminal** PR is **non-definitive**
and is **not written to the `(ref, UpdatedAt)` cache** — so every read re-fetches it until it
resolves. **Gate on the derived readiness, not the raw `mergeable` string** (same reason as C2:
`MergeReadinessRule.Derive` collapses `mergeable == UNKNOWN` *and* the `mergeStateStatus`-lag case to
`None`; a `mergeable`-string gate would re-freeze the lag case). A draft, closed, or merged PR, and
any definitive readiness, cache normally. This is a **pure predicate — no counter and no new reader
parameter**; the reader stays a clean query layer. The fast-attempt cap is *policy* and lives in the
orchestrator (C3b).

To let the orchestrator select re-probe targets (C3b) without re-deriving draftness, expose
`IsDraft` (or an equivalent "readiness pending" signal) on the inbox item.

**C3b — fast readiness re-probe pass (orchestrator-owned).** After `RefreshAsync` hydrates, select
re-probe targets by filtering the post-`ReadAsync` items to **`open && !IsDraft && MergeReadiness ==
None`**; if any, run a short-backoff background pass on the fast schedule (1s, 2s, 4s, 8s, 16s):
- **The fast-attempt counter lives here, not in the reader.** The orchestrator already owns the
  probe loop, the ref set, and the generation CTS, so it owns the per-`(ref, UpdatedAt)` count:
  increment per tick, check for loop-stop, prune stale entries against the current snapshot's refs
  each tick. It dies with the generation CTS (no leak). A manual hard refresh resets *this* counter
  directly — no `hardRefresh` parameter on `ReadAsync` (C3a is stateless).
- **Pass the FULL current inbox item set to `ReadAsync`** (not a subset), patch only the resolved
  rows. `ReadAsync`'s `InboxCacheEviction.PruneAbsent(_cache, liveRefs)` (`GitHubPrBatchReader.cs:100`)
  evicts every cache entry **absent** from the passed list — a subset call would blow away the rest
  of the readiness cache and force a full re-fetch. The still-`None` rows in the full set are
  re-fetched (C3a); the rest are cache-served, so the read is cheap.
- **Serialize `ReadAsync` against the normal refresh.** `GitHubPrBatchReader` assumes refreshes are
  serialized by the poller (`_cachedViewerLogin` is an unlocked plain field; `_cache.Clear()` /
  `PruneAbsent` are unguarded — `GitHubPrBatchReader.cs:39`). A normal `RefreshAsync` landing inside
  the burst would race the detached pass (viewer-swap `Clear()` mid-fetch; divergent `PruneAbsent`
  evictions). The re-probe must therefore hold the orchestrator's `_writerLock` **around each
  `ReadAsync` call**, releasing it across the backoff sleeps so a normal refresh isn't blocked.
- **Lifecycle (net-new machinery — the CI-probe / enrichment analogy does NOT supply this).** The CI
  probe is awaited synchronously inside `RefreshAsync`; `OnInboxEnrichmentsReady` is bus-driven —
  neither is a self-scheduled backoff loop. The re-probe is a **detached `Task`** launched at the end
  of `RefreshAsync`, owning a per-generation `CancellationTokenSource` field; a new refresh cancels
  the prior pass (one in flight). `Dispose()` must additionally cancel/dispose that CTS (today it
  only disposes `_enrichmentSub`/`_writerLock`), and the patch body must re-check the token **and
  `_disposed` *after* acquiring `_writerLock`** (not only before the sleep) — a continuation that
  wakes after a newer generation already wrote would otherwise clobber a newer snapshot or touch a
  disposed lock. Reused patch-and-publish body: take `_writerLock`, re-read `_current`,
  `Volatile.Write` the patched snapshot, publish `InboxUpdated`. **Patch onto the freshly-re-read
  `_current`, not the pre-sleep captured item set**, and skip any resolved row that is absent from it
  (mirror `OnInboxEnrichmentsReady`'s `liveByPrId.TryGetValue(...) → continue` guard) — a PR that a
  concurrent refresh dropped (merged/closed mid-burst) must not be resurrected.
- Stop when all targets are definitive or the cap is reached; either way the rows stay non-frozen
  (C3a) and ride the normal 60s refresh thereafter.

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
- Cap key: **per `(ref, headSha)` on both surfaces** (detail in `ActivePrPollerState`; inbox in the
  orchestrator — so the inbox item must carry `headSha`, one more readiness-query field). Keying on
  `headSha` (not the inbox's `(ref, UpdatedAt)` cache key) is deliberate: mergeability is recomputed
  on a head/base change, **not** on a comment — and `UpdatedAt` bumps on any activity including
  comments. Keying the budget on `UpdatedAt` would let a comment on a never-resolving (e.g. no-push)
  PR re-arm a fresh expensive burst every time, and would defeat the post-cap "demote stuck rows"
  mitigation (the key would keep resetting). A genuine new commit (headSha change) resets the budget
  and re-arms; a base-only re-compute is rare and rides the normal cadence. A manual hard refresh
  resets the inbox orchestrator counter directly (re-opening the burst on demand).
- After the cap: the PR is no longer *fast*-scheduled but is **not frozen** — detail reverts to the
  30s poll cadence, inbox to the 60s refresh re-read (C3a). A slow-to-compute PR therefore still
  self-heals automatically (no manual refresh required); the cap only stops the 1Hz burst.
- **Aggregate cost / fan-out.** The per-PR cap does not bound concurrent count, but three existing
  mechanisms do: the readiness query is **batched** (one read serves all due PRs, ≤50 aliases per
  chunk), the inbox re-probe is **one-pass-in-flight per generation**, and both inherit the poller's
  **rate-limit backoff**. Worst case is a base-branch push invalidating mergeability for every open
  PR at once; the batching + single-pass + backoff keep that within the GraphQL limit the design
  cites, and the detail poller's subscriber set (PRs you're viewing) is small.
- **Honest caveat — persistently-`UNKNOWN` rows are never fully quiescent.** Because a non-definitive
  `None` is never cached (C3a), a *permanently*-`UNKNOWN` open row (e.g. genuinely no push access)
  is re-fetched in the expensive readiness query on **every** 60s refresh — one alias per stuck row,
  bounded by the 50-alias chunk, but non-zero where a frozen `None` previously cost nothing (a
  quiescent inbox would otherwise issue zero batches). Accepted: such rows are rare in practice. If a
  deployment sees many, demote post-cap stuck rows to a slower-than-60s re-probe interval.
- **Debounce manual refresh.** A hard refresh re-opens the fast burst, so repeated Refresh presses
  could sustain ~1Hz expensive reads. The Refresh control must be disabled / debounced while a
  re-probe pass is in flight.

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
  edge announces `"Merge unavailable: <reason>"`. **Navigate-back to an already-`ready` PR (snapshot
  seed `ready`, then a re-emit) does NOT re-announce** (effective-readiness ref seeded to the
  snapshot). **Auto-resolve while focus is on the Refresh button moves focus** to the Merge button
  (enabled) / reason node (disabled), not `<body>`.
- **C2 (xunit, `ActivePrPollerTests`):** open `None` PR schedules `NextRetryAt ≈ now+1s` and
  **`NextRetryAt` survives the successful tick** (conditional-reset fix — not nulled at `:233`);
  **a `None` derived from `mergeStateStatus`-UNKNOWN while `mergeable` is definitive IS fast-retried**
  (derived-readiness gate, not the raw `mergeable` string); the `ExecuteAsync` loop wakes early
  (`min(cadence, nextRetry)`); **a new subscription wakes the loop within ~1s** (coalescing signal),
  so a freshly-subscribed `None` PR is polled without waiting a full cadence; resolves on a definitive
  tick and publishes `ActivePrUpdated{ MergeReadinessChanged }`; after the cap the PR stops *fast*-
  scheduling but is **still polled at the normal cadence** (not frozen); a definitive (Ready) PR, a
  `Closed`/`Merged` PR, and a **draft** are **not** fast-scheduled; steady Ready→Ready does not.
- **Re-emit on subscribe (xunit, SSE / subscription endpoint tests):** with the active-PR cache
  holding `ready` for a ref, subscribing emits a **targeted** `pr-updated{ MergeReadinessChanged =
  true }` to that connection only (not fanned out); cached `None`/absent emits nothing; the cache
  **retains last-known non-`None`** (a transient `None` tick does not overwrite a cached `ready`). A
  **DI resolvability test** confirms `ActivePrPoller` resolves both as a singleton and as the hosted
  service after the dual-registration switch.
- **C3a (xunit, `GitHubPrBatchReaderTests`):** an open non-draft PR whose **derived readiness is
  `None`** (test both the `mergeable == UNKNOWN` and the `mergeStateStatus`-lag inputs) is not
  written to cache and is re-fetched on the next read — **always** (it is a stateless skip, no cap in
  the reader); a **draft** `None` and any definitive readiness **are** cache-served; the reader takes
  no `hardRefresh`/force parameter.
- **C3b (xunit, `InboxRefreshOrchestratorTests`):** a refresh leaving an `open && !IsDraft &&
  None` row triggers a re-probe that calls `ReadAsync` with the **full item set** (not a subset) and
  patches only that row — assert the readiness cache for the OTHER rows is **not** evicted; the
  re-probe holds `_writerLock` around `ReadAsync` (no concurrent reader entry with a normal refresh);
  the **orchestrator** fast-attempt counter (keyed on `(ref, headSha)`) caps the burst and a hard
  refresh resets it; a **comment-only `UpdatedAt` bump does NOT re-arm** the burst (head unchanged);
  a resolved row **absent from the freshly-re-read `_current`** (PR closed mid-burst) is **not**
  patched back in; a **draft** at `None` is **not** a target; all-definitive readiness triggers no
  re-probe; a new refresh **cancels the prior in-flight pass**; `Dispose()` cancels the re-probe CTS;
  after the cap the pass stops but the row stays non-frozen.
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

**Delivery slicing.** C1+C2 (PR-detail: `PrActionsPanel`, `PrDetailView`, `prDetailContext`,
`ActivePrPoller`, `ActivePrSnapshot`/`IActivePrCache`, `SseChannel`, the subscription endpoint, and
the `ServiceCollectionExtensions` DI registration for the poller dual-register) and C3 (inbox:
`GitHubPrBatchReader`, `InboxRefreshOrchestrator`, the inbox item DTO, `InboxRow`) still share **no
modified files** and touch independent pipeline paths, so they are independently deliverable. They ship together on this branch per direction; if C3's net-new re-probe lifecycle
(detached task + per-generation CTS + writer-lock serialization) hits complications, C1+C2 may be
split to a separate PR so the PR-detail fix is not blocked. C3 is the larger/riskier half (new
background machinery), so it carries the deeper review and test burden.
