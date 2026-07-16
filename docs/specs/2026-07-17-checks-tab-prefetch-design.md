# Checks tab: prefetch check-runs on PR-detail open (#743)

**Tier:** T2 (short spec, 1× doc-review, TDD). **Risk:** hands-off — the Checks tab renders
byte-identically; the tab-strip glyph is an existing consumer fed earlier (and held steadier,
see § Glyph continuity).

## Problem

`useCheckRuns` gates its entire lifecycle (initial fetch + 15s poll loop + late-registration
window + rerun watch) on one flag: `active && headSha != null && visible`, where the caller
binds `active` to `checksActive = active && effectiveSubTab === 'checks'`
(`PrDetailView.tsx:292` — the outer `active` there is the view-level route-active prop under
keep-alive). Nothing fetches until the user clicks the Checks tab, so the first visit always
shows a cold loading state, and the tab-strip checks glyph stays empty until then.

Making the whole hook eager would run the 15s poll loop for every opened PR — deliberate
API-cost reasons keep the poll lazy (issue body). The fix is the issue's recommended split:

- **Prefetch the initial fetch** once the PR-detail view is open and `headSha` resolves.
- **Keep the poll loop gated** on the Checks tab being active and the document visible.

## Behavior contract (acceptance criteria)

1. With the PR-detail view active on any sub-tab, one check-runs fetch fires once `headSha`
   resolves and a short dwell elapses — without the Checks tab ever being activated. If the
   document is hidden at that moment, the attempt fires once when it next becomes visible.
2. The 15s poll loop, late-registration re-poll behavior, and rerun watch run **only** while
   the Checks tab is active and the document visible (unchanged from today).
3. Activating the Checks tab after a successful prefetch shows the prefetched list immediately
   (no `loading` flash, no list clear) and starts the normal poll lifecycle with a revalidating
   fetch.
4. Hard cost bound: at most **one issued prefetch request per open PR view per `headSha`**.
   Attempts cancelled during the dwell (rapid tab-switching drive-bys) cost zero requests. Any
   **issued** fetch on either path closes the prefetch gate for that head — the poll tick marks
   the gate at request start exactly like the prefetch does — so leaving the Checks tab never
   triggers a redundant prefetch, even after an aborted or failed poll fetch.
5. Prefetch is **best-effort with no retry**: once a request is issued for a head, it never
   re-issues for that head regardless of outcome (abort mid-flight, transient failure, auth
   failure). A failed prefetch records the degraded classification but **never pre-surfaces
   `error`** — the Checks tab is unmounted, nothing legitimately consumes `error` pre-visit,
   and the first activation would paint the error card for a frame before any post-mount
   reset. The series stays on `loading`: the first visit renders the skeleton, the activation
   tick retries, and only THAT failure surfaces the error card (today's cold-open behavior).
   The glyph stays in the same no-data state as today's lazy behavior — accepted tradeoff.
   Re-visiting a series whose cold failure WAS surfaced by an in-tab tick keeps today's
   behavior (the error card persists over the silent retry, no skeleton flash).
6. The late-registration re-poll window is anchored to the **first tab activation of a
   series**, not prefetch time: a user arriving minutes after the prefetch still gets the full
   ~2-minute grace for late-registering checks. Re-activations of the same series do NOT
   re-arm the window (today's behavior: an expired empty-list window stays expired across
   tab-away/tab-back — no polling grant per re-visit).
7. Glyph continuity: on a `headSha` change while the view is open, the tab-strip glyph keeps
   showing the previous head's verdict until the new head's first result lands (no blank
   flicker on every push). The Checks tab itself still clears and shows the skeleton for a new
   head exactly as today.

## Design

### Hook signature

`useCheckRuns(prRef, headSha, active, prefetch = false)` — new optional 4th param. Sole caller
updated: `PrDetailView.tsx` passes `prefetch = active` (the outer view-level route-active prop;
verified `PrTabHost.tsx` renders one `PrDetailView` per open tab with `active={key === activeKey}`),
so keep-alive background PR tabs never prefetch.

### Series establishment is shared

The poll effect keys series identity on `seriesShaRef` — on a SHA change it resets
degraded/status, reopens the late-registration window, and drops the rerun watch. The prefetch
path runs the same series-transition block (extracted as a `beginSeriesIfNew(sha)` helper
closed over the same refs/setters) before fetching, so the poll effect never clears a
prefetched list on tab activation (AC 3). Two deliberate deltas from today's block:

- `checks`/`checksRef` are still cleared on series transition, but the **last non-empty list
  survives in `glyphChecksRef`** (§ Glyph continuity).
- `prefetchedShaRef` (§ Prefetch gate) needs no reset here — it stores the SHA it was marked
  for, so a new head invalidates it naturally.

### Prefetch gate (single-flight, SHA-keyed)

`prefetchedShaRef: string | undefined` — holds the head that has already had an attempt
**issued** (marked at request start, never unmarked), by either path:

- The prefetch effect skips when `prefetchedShaRef.current === headSha`.
- The poll effect's `tick()` marks it at request start too, so a head fetched (or even
  attempted and aborted/failed) via the Checks tab never prefetches redundantly after the
  user switches away.

### Prefetch effect

A separate effect gated on `prefetch && !active && headSha != null &&
prefetchedShaRef.current !== headSha`:

- **Dwell before firing:** a `PREFETCH_DWELL_MS` (300ms) timer precedes the request. Cleanup
  (view deactivation, unmount, SHA change) clears a pending timer at zero cost — rapid
  tab-switchers never issue requests, and the mark is only written when a request actually
  starts. (This also keeps dev StrictMode's mount→unmount→mount cycle from burning the
  attempt: the first mount's timer is cleared synchronously before it can fire.)
- **Hidden at fire time:** if `document.visibilityState !== 'visible'` when the effect runs, it
  registers a one-shot `visibilitychange` listener that starts the dwell on the first
  transition to visible (self-removing; also removed by cleanup). Covers the app launched
  minimized / backgrounded-during-load case.
- **One-shot:** no poll timers, no `shouldKeepPolling`.
- On request start: `beginSeriesIfNew(headSha)`, mark `prefetchedShaRef.current = headSha`,
  fetch with an `AbortController` aborted by cleanup.
- On success: identical state writes to a successful tick (checks/checksRef/glyphChecksRef/
  hadSuccessRef/degraded/status), with the same `res.headSha !== headSha` cross-series
  backstop. No rerun-watch interaction (a fresh series always has a null watch).
- On error: the shared `commitFetchError(err, surfaceColdError)` chokepoint with
  `surfaceColdError = false` — classification recorded, but the cold arm leaves the series on
  `loading` instead of surfacing `error` to an unmounted tab (AC 5). The poll tick calls the
  same chokepoint with `true` (its cold failure is user-visible). The warm arm (cached-list
  restore) is shared and unreachable from the prefetch path given issue-marking.
- Never retries: abort-after-start and failures leave the mark set (AC 5).

### Poll-effect first-activation latch

`seriesActivatedShaRef: string | undefined` — the head whose series has already had its first
Checks-tab activation. Inside the poll effect (after `beginSeriesIfNew`), when
`seriesActivatedShaRef.current !== headSha` the latch fires once per series:

- If `checksRef.current.length === 0`, re-arm `windowOpenedAtRef.current = Date.now()` before
  the first tick — the prefetch-handoff grace of AC 6.
- If `!hadSuccessRef.current` (cold series whose prefetch failed), set status `loading` before
  the first tick — the cold-open sequence of AC 5.

A per-series latch, not an active-edge detector: re-activations, `retry()`/`refetch()` nonce
re-runs, and transient gate closures (hidden, `headSha` momentarily null) never re-fire it, so
today's re-visit behavior (expired window stays expired; error card persists over silent
retry) is preserved exactly. For a series first established by the poll path itself (manual
Checks visit, deep link), both latch actions are same-instant no-ops after `beginSeriesIfNew`.

### Glyph continuity

`CheckRunsResult` gains an optional member `glyphChecks?: CheckRun[]` (optional for the same
reason as the rerun members — ~10 test stubs build the result inline). It mirrors `checks` on
every successful write but is **not** cleared by the series transition, so it always holds the
last known list across a head change. `PrDetailView` feeds the tab-strip glyph from
`checks.glyphChecks ?? checks.checks`; `ChecksTab` keeps consuming `checks` and is unaffected
(AC 7).

### What does not change

Poll cadence, rerun watch semantics, same-series stale-while-revalidate holds, error
classification, `retry`/`refetch` nonces, the wire contract, the Checks tab's rendered states,
and every consumer other than `PrDetailView`'s call-site + glyph-input lines.

## Test plan (TDD, red first)

`useCheckRuns.test.ts` additions (fake timers; dwell advanced explicitly):
- prefetch=true, active=false → no request before `PREFETCH_DWELL_MS`; one fetch after; status
  resolves; advancing 15s+ produces **no** further calls (no poll loop).
- prefetch with `headSha` undefined → no fetch, idle.
- prefetch while document hidden → no fetch; becomes visible → dwell then one fetch.
- dwell-cancel: unmount (or prefetch→false) before dwell elapses, remount → attempt retries
  (dwell was free); post-start abort: unmount after the request issued, remount → **no** new
  request for the same head (mark stuck, AC 5).
- activation after successful prefetch → status never regresses to `loading`, list preserved,
  revalidating fetch fires, poll continues for non-terminal lists.
- one issued request per head: active-flip re-renders don't refetch; new `headSha` prefetches
  again.
- poll-success closes the gate: active=true fetch succeeds → flip active=false with
  prefetch=true → no prefetch request.
- prefetch failure → degraded classified (auth vs transient) but status stays `loading` (no
  pre-surfaced error card, AC 5); the activation tick retries — its success recovers, and only
  its own failure surfaces `error`.
- late-window re-arm: prefetch resolves empty; advance past `LATE_REGISTRATION_MS`; activate →
  empty-list re-polling continues for a fresh window rather than stopping immediately.
- glyph continuity: successful series, then `headSha` change (still prefetching) →
  `glyphChecks` still returns the old list while `checks` is cleared; new result replaces both.

`PrDetailView.test.tsx`: the hook mock captures args — assert it receives
`(prRef, headSha, checksActive, active)`: prefetch=true while the view is active on Overview;
prefetch=false when the view is inactive (keep-alive background).

## Files

- `frontend/src/hooks/useCheckRuns.ts`
- `frontend/src/hooks/useCheckRuns.test.ts`
- `frontend/src/components/PrDetail/PrDetailView.tsx`
- `frontend/src/components/PrDetail/PrDetailView.test.tsx`
