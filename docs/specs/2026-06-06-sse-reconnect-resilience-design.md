# SSE reconnect resilience — design

- **Issue:** [#141](https://github.com/prpande/PRism/issues/141) (Phase 4 — Core Reliability & Correctness)
- **Date:** 2026-06-06
- **Tier / Risk:** T3 / split — Sections 1–2 hands-off; Section 3 (snackbar) is B1 (UI-visual), gated at the visual assert.
- **Status:** design (awaiting human spec review)

## Problem

The SSE event-stream client (`frontend/src/api/events.ts`) has no reconnect
resilience. Under network churn it can hot-loop, hang, or silently stop
delivering updates with no user signal:

1. **No backoff/jitter** — `reconnect()` calls `connect()` immediately on error; a
   flapping server creates a tight reconnect loop.
2. **Ping probe has no timeout** — `fetch('/api/events/ping')` can black-hole and
   stall reconnect for the browser default.
3. **Malformed `subscriber-assigned` hangs the id promise** — a JSON parse error
   is swallowed and `idPromise` never resolves; `useActivePrUpdates` awaiting
   `subscriberId()` hangs until the 35s watchdog.
4. **Reload-on-401 has no loop guard** — `window.location.reload()` on a 401 can
   loop if the cookie is stale but `hasToken` is true.
5. **No user-visible signal when the connection is lost** — all error paths are
   silent; the inbox and PR-detail views go stale with no indication.

## Goals / acceptance criteria

- Reconnects use bounded exponential backoff + jitter that **actually grows**
  under a flapping/accept-then-drop server.
- The ping probe times out and triggers a (scheduled) reconnect.
- A malformed handshake recovers via reconnect — no infinite hang.
- No reload loop on a 401; the SSE stream is torn down on de-auth.
- The user sees a dismissible indicator when the **connection is lost** (~30s),
  which clears automatically on recovery and offers a state-preserving retry.

## Scope of the health signal (read before D5)

This feature detects **connection/transport loss**, not a server that is wedged
but still emitting heartbeats. The existing client already treats `heartbeat`
frames as liveness (they reset the silence watchdog), so a stream where
heartbeats arrive but data does not is, by the transport's own definition, alive.
Detecting a wedged-but-heartbeating data pipeline would require a separate
"expected data cadence" timer that false-positives on legitimately quiet streams
(no PRs changing) — out of scope for this PoC and arguably a server-side concern.

Consequence: the user-facing copy is **"Connection lost — reconnecting,"** not
"Live updates paused" — the latter is inaccurate while backoff is actively
retrying, and overstates what we detect.

## Non-goals

- Reworking the server-side SSE pipeline, subscription routing, or the
  reconnect-replay defense (`prism-events-reconnected`). Client-only.
- Detecting a wedged-but-heartbeating data pipeline (see Scope above).
- Read-receipt / unread accounting (#142 owns SSE subscription accounting).
- Offline detection via `navigator.onLine`.

## Existing tests (this module is NOT greenfield)

`frontend/__tests__/events-handshake.test.tsx` already exists (a `FakeEventSource`
harness + `fetch` mocks + fake timers). Several assertions encode the *current*
behavior and must be **migrated**, not appended to:

- The silence-watcher tests assert a reconnect at exactly `35_001ms`
  (`FakeEventSource.instances` length 1 → 2). D2 inserts a backoff delay before
  the new EventSource, so these must either assert at `35_001 + scheduledDelay` or
  **pin jitter to a fixed value** via the delay seam (below) and assert exactly.
- `forces window.location.reload when ping returns 401` (asserts `reloadSpy`
  called once) **inverts** under D1: it must assert `prism-auth-rejected` is
  dispatched and `reload` is **not** called, plus the stream is torn down.

To keep timing tests deterministic, D2 exposes a **delay seam** (an injectable
jitter/`delayFn`, defaulting to `Math.random`-based) so tests pin backoff to a
fixed value instead of asserting a range.

## Key decisions

### D1 — 401 reuses the existing auth-rejected path AND tombstones the stream

The issue proposes a `sessionStorage` tombstone to damp the reload loop. The
codebase already solves stale-cookie rejection a cleaner way: `client.ts:76`
dispatches `prism-auth-rejected` on an API 401, and `App.tsx:34-43` consumes it to
flip `authInvalidated`, swapping the UI to the setup screen **without a reload**.

**Decision:** in the SSE ping-401 branch, (a) dispatch
`window.dispatchEvent(new CustomEvent('prism-auth-rejected'))` and (b)
**immediately tombstone the stream** — `closed = true; es.close()` and cancel any
pending backoff timer — so no scheduled reconnect can re-open against the 401
endpoint in the window before React unmounts `EventStreamProvider`. On
`prism-auth-recovered`, `EventStreamProvider` remounts and `openEventStream()`
runs fresh. No reload, no loop by construction, no tombstone-in-storage.

**Invariant to honor (not a code change here):** `prism-auth-recovered` must only
be dispatched after a confirmed-successful API response (its sole current
dispatch site). De-auth without reload leaves the session cookie in
`document.cookie`; recovery re-uses it, which is correct only if recovery is
gated on real re-validation.

*Rejected — tombstone-in-storage + reload:* keeps a second divergent 401 path and
a hard reload; damps the loop instead of eliminating it.

### D2 — Single backoff scheduler; reset on dwell, not on the handshake

`reconnect()` is invoked from two places today: the silence watchdog and the
`onerror` → ping path. Both currently call `connect()` immediately.

**Decision:** introduce `scheduleReconnect()` that waits
`min(MAX, BASE · 2^attempt)` with ±25% jitter before reconnecting, and route both
triggers through it. Constants: `BASE = 1000ms`, `MAX = 30000ms`.

- **Re-entrancy guard:** track the pending backoff timer handle.
  `scheduleReconnect()` is a **no-op if a reconnect is already pending or
  in-flight**. This prevents the watchdog and a buffered `onerror` from both
  scheduling during the async backoff gap (which would create two EventSources).
  `close()` and the D1 tombstone both clear the pending timer.
- **Backoff reset on a stability dwell — NOT on `subscriber-assigned`.** Resetting
  `attempt = 0` on the handshake lets an accept-then-drop server reset backoff
  every cycle (handshake is the cheapest thing a broken server still does),
  recreating the tight loop. Instead: on `subscriber-assigned`, start a
  `STABLE_AFTER_MS = 10000` dwell timer; **only if the stream survives that dwell**
  does `attempt` reset to 0. A drop before the dwell elapses keeps `attempt`
  growing, so accept-then-drop backs off correctly.
- **The dwell timer is an outer-scope handle cleared at the start of every
  `reconnect()`/`connect()`** (and on `close()`/tombstone/`forceReconnect()` — see
  the Timer-lifecycle invariant). Without this, a stale dwell from a *dropped*
  connection fires ~10s later and resets `attempt=0` based on a stream that already
  died — silently defeating this whole reset rule. Only the **current** connection's
  survival may reset `attempt`.

Jitter uses `Math.random()` via the delay seam (overridable in tests).

### D3 — Ping probe timeout (fake-timer-drivable) + defined network-error path

Wrap the probe with an **explicit** abort timer (not `AbortSignal.timeout`, whose
internal timer `vi.useFakeTimers()` does not drive):

```ts
const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS); // 5000
fetch('/api/events/ping', { signal: ctrl.signal }) ... finally clearTimeout(t)
```

- On a **timeout or network-error** rejection (the `.catch`), call
  `scheduleReconnect()` instead of the current silent no-op, so a cold-start /
  black-holed probe engages backoff immediately rather than waiting on the 35s
  watchdog.
- The 401 branch still runs on a **resolved** response with `status === 401`
  (D1); timeout only aborts the fetch itself.

### D4 — Malformed handshake recovers

In the `subscriber-assigned` parse `catch`, call `scheduleReconnect()` so a
garbled handshake recovers instead of leaving `idPromise` pending until the 35s
watchdog.

### D5 — Health state machine (internal), anchored to liveness — not to reconnect

Track stream health inside the `openEventStream()` closure with **one** health
timer, anchored to **liveness signals** (handshake / heartbeat / data frame):

- **Mechanism (as implemented — see `frontend/src/api/events.ts`):** health is
  driven by `onLiveness()`, the single chokepoint called from every liveness site
  (`subscriber-assigned`, `heartbeat`, every-typed-data-frame). `onLiveness()` does
  three things: flips health back to `true` (notifying subscribers), re-arms the
  health timer (`armHealthTimer()`), and re-arms the watchdog (`armWatchdog()`).
  The health timer is armed **once at stream init** (right after the first
  `connect()`), and thereafter re-armed **only** by `onLiveness()`. **Crucially,
  `connect()`-tail arms the *watchdog only*, never the health timer.** This is a
  deviation from an earlier draft that folded health into a `resetWatchdog()`
  chokepoint shared with `connect()`-tail: doing so would restart the 30s health
  countdown on every reconnect attempt, so a fast-failing server (the primary
  "connection lost" case) would keep deferring the indicator past 30s under backoff
  churn. Anchoring to liveness — not to connect attempts — keeps "30s without a live
  signal" honest. A discriminating deviation-proof test enforces this (`a reconnect
  does NOT reset the health countdown`).
- If the timer reaches `UNHEALTHY_AFTER_MS = 30000` without a reset →
  `streamHealthy = false`, notify subscribers.
- The next liveness signal → `streamHealthy = true`, notify. (A single >30s outage
  that then recovers correctly shows once and clears — not a spurious flash,
  because it genuinely was down for 30s.)
- Initial value is `true` (optimistic) so a normal cold-load never flashes; a cold
  load that never connects flips `false` at a real 30s (the timer was armed once at
  init), now that the ping `.catch` no longer silently swallows network errors (D3).

Because health resets on the same signals as the 35s watchdog, **`UNHEALTHY_AFTER_MS`
(30s) genuinely sits inside `SILENCE_WATCHER_MS` (35s)**: the UI flips "connection
lost" ~5s before the watchdog fires its reconnect. This is the corrected model;
the prior draft armed the timer off `scheduleReconnect()`, which made "30s" mean
~65s and could never fire on a fast-flapping stream.

### D6 — Handle surfacing (no window bridge)

Extend `EventStreamHandle`:

```ts
streamHealthy(): boolean;
onHealthChange(cb: (healthy: boolean) => void): () => void; // returns unsubscribe
forceReconnect(): void; // see semantics below
```

**`forceReconnect()` semantics (guarded):** **no-op if a connect is already
in-flight** (reuse the re-entrancy handle), otherwise cancel the pending backoff
**and dwell** timers and fire **one** immediate `connect()`. It does **NOT** reset
`attempt`: a manual press doesn't make the server healthier, so a *failed* retry
resumes the existing backoff curve rather than restarting it at 1s; a *successful*
retry resets `attempt` via the normal dwell path. The in-flight no-op makes
mashing "Retry now" harmless — it cannot reproduce the hot loop the backoff exists
to prevent.

New hook `useStreamHealth(): { healthy: boolean; retry: () => void }` subscribes
via `onHealthChange`, seeds from `streamHealthy()`, and exposes `forceReconnect`
as `retry`. Returns `{ healthy: true }` with no provider (mirrors
`useEventSource()` null-tolerance). No `window` event bridge — every consumer
lives inside `EventStreamProvider`.

### D7 — Dedicated snackbar, not the Toast system

The Toast system auto-dismisses every kind (info/success 5s, error 10s), de-dups
by `(kind, message)`, and is fire-and-forget. The health indicator must instead
**persist while down**, **clear programmatically on recovery**, and **re-show on
a fresh outage** — a state-driven lifecycle, not the toast queue's event-driven
one.

**Decision:** dedicated `StreamHealthSnackbar` driven by `useStreamHealth()`,
reusing the snackbar visual tokens for consistency.

*Rejected — sticky Toast kind:* would special-case "no auto-dismiss",
"programmatic clear", and "re-show on edge" across the toast queue.

### D8 — Timer-lifecycle invariant (closes the round-2 timer findings)

This design introduces four timers in the `openEventStream()` closure: the
existing **watchdog**, plus **backoff**, **dwell**, and **health**. To avoid
hand-synchronized lifecycle bugs, all four are **outer-scope handles** governed by
one rule, not per-call-site discipline:

- **Per-stream timers cleared at the start of every `connect()`/`reconnect()`:** a
  superseded stream's pending **dwell** must never fire (it would reset `attempt`
  off a dead connection — the load-bearing failure that defeats D2). The
  captured-self pattern (`myEs !== es`) or an explicit clear-on-entry both work;
  the spec mandates clear-on-entry as the simpler guarantee.
- **All pending timers cleared on `close()`, the D1 tombstone, and
  `forceReconnect()`:** no timer may fire after teardown or fire a duplicate
  reconnect.
- **`scheduleReconnect()` and `forceReconnect()` are no-ops while a reconnect is
  pending/in-flight** (shared re-entrancy handle), so neither the watchdog +
  buffered `onerror` race nor manual "Retry now" mashing can create a second
  EventSource.

Stating this once converts three "remember to also clear X" requirements into a
single structural rule an implementer can't silently violate.

## Components & data flow

```
events.ts: openEventStream()
  ├─ scheduleReconnect()   (D2: backoff+jitter; re-entrancy guard; dwell-gated reset)
  ├─ connect()             (arms watchdog + health timer at start; both reset on
  │                         subscriber-assigned / data / heartbeat; ping timeout D3;
  │                         malformed-handshake reconnect D4; 401 → dispatch
  │                         prism-auth-rejected + tombstone D1)
  └─ handle: streamHealthy() / onHealthChange() / forceReconnect()   (D6)
        │
        ▼
  useStreamHealth()  ──►  StreamHealthSnackbar   (D7)
        (hook)               renders iff !healthy && !dismissedThisOutage
```

### StreamHealthSnackbar behavior (Section 3 — B1)

- Renders **iff** `!healthy && !dismissedThisOutage`.
- Single line: **"Connection lost — reconnecting"** · **Retry now** button · **×**
  dismiss. Final copy/iconography confirmed at the B1 visual gate.
- **Retry now** → `retry()` (`forceReconnect()`, guarded — see D6): cancels the
  pending backoff/dwell wait and fires one immediate reconnect (no-op if already
  connecting). **State-preserving** — does not reload, so keep-alive tab cache,
  scroll, and unsaved composer drafts are retained. (This replaces the earlier
  `window.location.reload()` direction.)
- **Dismiss (×)** sets `dismissedThisOutage = true`, hiding it for the current
  outage only. The flag resets on any `healthy → unhealthy` transition. If the
  user dismisses and the stream stays continuously down (no intervening
  recovery), it remains dismissed for that outage — `retry()` and auto-clear on
  recovery remain available.
- **Layering:** `position: fixed`, centered, **no backdrop**, non-blocking
  (does not block clicks/reads underneath). Self-contained fixed positioning on
  the element itself (does **not** rely on `ToastContainer`, which has none).
  Explicit z-index **below the modal layer** (modal-backdrop is z-1000) — e.g.
  `--z-snackbar: 200`, above Header (z-100) but under modals — so an open
  `ErrorModal`/`HostChangeModal` hides it (correct for a non-blocking signal).
- **A11y / keyboard:** `role="status"`, `aria-live="polite"` (announces once on
  appear). **Escape does NOT dismiss** (Escape belongs to the modal layer); users
  dismiss via the × button. After ×, focus returns to the previously focused
  element (the Modal `previouslyFocused` pattern).
- **Motion:** short opacity + translate enter/exit (~150ms ease-out);
  `@media (prefers-reduced-motion: reduce)` suppresses it (instant).
- **Mount point:** inside `tree` (the child of `EventStreamProvider`, only present
  when authed), alongside `ToastContainer` (App.tsx:120). A health signal only
  makes sense when authed.

**Deferred to the B1 visual gate (real screenshots):** bottom-center vs
top-center placement (lean bottom-center — top collides with `Header` +
`PrTabStrip`) and final copy/iconography.

## Error handling

- Subscribe-loop failures in `useActivePrUpdates` remain non-fatal (unchanged).
- A throwing health subscriber callback must not break the notify loop (swallow
  per-subscriber, matching the existing listener-dispatch pattern).
- The `myEs !== es` captured-self guard, `probed` latch, and `closed` checks are
  preserved across the new scheduled-reconnect path; a pending backoff timer must
  be a no-op after `close()` or the D1 tombstone.

## Testing strategy

Migrate `frontend/__tests__/events-handshake.test.tsx` (see Existing tests) and
extend it. Pin jitter via the D2 delay seam for deterministic timing.

**PR1 (Sections 1–2, hands-off):**
- Backoff (D2): nth retry waits the seam-pinned `min(MAX, BASE·2^n)`; jitter range
  bound test; **`attempt` resets only after the 10s dwell** — an accept-then-drop
  cycle (handshake then immediate drop) keeps `attempt` growing.
- Dwell cancellation (D2/D8): accept → drop at <10s → reconnect → new accept; when
  the *original* 10s elapses, `attempt` is **not** reset to 0 (the stale dwell was
  cleared at reconnect entry).
- Re-entrancy (D2/D8): watchdog + a buffered `onerror` within the backoff gap →
  exactly **one** new EventSource.
- Ping (D3): explicit 5s abort routes to a scheduled reconnect; network-error
  `.catch` schedules a reconnect (no longer a silent no-op).
- Malformed `subscriber-assigned` (D4) → `scheduleReconnect()` (no hang).
- 401 (D1): dispatches `prism-auth-rejected`, does **not** reload, and **tombstones
  the stream** (no further reconnects after).
- Health (D5): flips `false` after 30s with no liveness signal (armed at connect
  start); **`heartbeat` keeps it healthy**; flips `true` on the next signal;
  `onHealthChange` fires on each edge; `close()`/tombstone cancel pending timers.
- `forceReconnect()` (D6): cancels pending backoff/dwell and reconnects once;
  **does not reset `attempt`**; N rapid calls against a failing connect → at most
  **one** EventSource in flight (in-flight no-op).

**PR2 (Section 3, B1):**
- Snackbar renders only when unhealthy; hides on recovery; `useStreamHealth`
  returns `{healthy:true}` with no provider.
- Dismiss hides for the current outage; a new `healthy→unhealthy` edge re-shows.
- "Retry now" invokes `forceReconnect` (and does **not** reload).
- Re-render while mounted (dismiss flag changes, text unchanged) → no duplicate
  live-region announcement.

## Packaging

- **PR1** — Sections 1 + 2: reconnect logic + internal health state machine +
  `EventStreamHandle` extensions (`streamHealthy()` / `onHealthChange()` /
  `forceReconnect()`) + migrated/extended tests. Fully hands-off; merges on green.
  The new handle methods are dead-but-tested until PR2.
  **PR1's health-timing tests are the contract PR2 depends on** — changing them is
  a breaking change, called out so a future reviewer treats them as load-bearing.
- **PR2** — Section 3 (`StreamHealthSnackbar` + wiring). Small, B1-gated; human
  visual assert before merge.

## Source

Documentation deferral audit — `docs/specs/2026-05-06-s3-pr-detail-read-deferrals.md`
(~lines 214–323). Verified still unresolved against current code on 2026-06-06.
