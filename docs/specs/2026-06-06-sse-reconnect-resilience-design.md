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
5. **No user-visible signal when SSE is permanently broken** — all error paths are
   silent; the inbox and PR-detail views go stale with no indication.

## Goals / acceptance criteria

- Reconnects use bounded exponential backoff + jitter.
- The ping probe times out and triggers a (scheduled) reconnect.
- A malformed handshake recovers via reconnect — no infinite hang.
- No reload loop on a 401.
- The user sees a dismissible indicator when live updates stop flowing, which
  clears automatically on recovery.

## Non-goals

- Reworking the server-side SSE pipeline, subscription routing, or the
  reconnect-replay defense (`prism-events-reconnected`). This is client-only.
- Read-receipt / unread accounting (#142 owns SSE subscription accounting).
- Offline detection via `navigator.onLine` — out of scope; the health signal is
  derived purely from stream liveness.

## Key decisions

### D1 — 401 reuses the existing auth-rejected path (not a tombstone)

The issue proposes a `sessionStorage` tombstone to damp the reload loop. The
codebase already solves stale-cookie rejection a cleaner way: `client.ts:76`
dispatches `prism-auth-rejected` on an API 401, and `App.tsx` consumes it to flip
`authInvalidated`, swapping the UI to the setup screen **without a hard reload**.

**Decision:** replace `window.location.reload()` in the SSE 401 path with
`window.dispatchEvent(new CustomEvent('prism-auth-rejected'))`. This removes the
reload (so no loop is possible by construction), needs no tombstone, and unifies
SSE-cookie rejection with the existing API-cookie rejection path.

*Rejected — tombstone + reload:* keeps a second divergent 401 path and a hard
reload; damps the loop instead of eliminating it.

### D2 — Single backoff scheduler for both reconnect triggers

`reconnect()` is invoked from two places today: the silence watchdog and the
`onerror` → ping → success path. Both currently call `connect()` immediately.

**Decision:** introduce `scheduleReconnect()` that waits
`min(MAX, BASE · 2^attempt)` with ±25% jitter before reconnecting, and route both
triggers through it. `attempt` increments per scheduled retry and **resets to 0**
on the next `subscriber-assigned` (a confirmed-alive stream). Constants:
`BASE = 1000ms`, `MAX = 30000ms`.

Jitter uses `Math.random()` (allowed in app code; the Workflow-script restriction
does not apply here).

### D3 — Ping probe timeout

Wrap the existing probe: `fetch('/api/events/ping', { signal: AbortSignal.timeout(5000) })`.
A timeout rejects into the existing `.catch`, which falls through to
`scheduleReconnect()` rather than leaving native EventSource retry to stall.
(The 401-status branch still runs on a *successful* response with status 401.)

### D4 — Malformed handshake recovers

In the `subscriber-assigned` parse `catch`, call `scheduleReconnect()`. The
existing comment claims "next reconnect retries" but nothing triggers one; this
makes the claim true and stops `idPromise` hanging until the 35s watchdog.

### D5 — Health state machine (internal)

Track stream health inside the `openEventStream()` closure:

- A **30s unhealthy timer** arms whenever the stream enters an error/reconnecting
  state (i.e., when `scheduleReconnect()` runs) and is **cleared** on any
  `subscriber-assigned` or data frame.
- If the timer fires → `streamHealthy = false`, notify health subscribers.
- The next `subscriber-assigned` or data frame → `streamHealthy = true`, notify.
- Initial value is `true` (optimistic) so a normal cold-load never flashes the
  indicator. The first connection establishing simply keeps it `true`; a cold
  load that *fails* for 30s flips it `false` like any other outage.

Threshold constant: `UNHEALTHY_AFTER_MS = 30000` (sits just inside the existing
35s `SILENCE_WATCHER_MS`).

### D6 — Health surfacing via the handle (no window bridge)

Extend `EventStreamHandle`:

```ts
streamHealthy(): boolean;
onHealthChange(cb: (healthy: boolean) => void): () => void; // returns unsubscribe
```

New hook `useStreamHealth(): boolean` subscribes via `onHealthChange`, seeds from
`streamHealthy()`, and returns the current value (returns `true` when no provider
is present, mirroring `useEventSource()` null-tolerance). No `window` event bridge
is needed — every consumer lives inside `EventStreamProvider`.

### D7 — Dedicated snackbar, not the Toast system

The Toast system (`components/Toast`) auto-dismisses every kind (info/success 5s,
error 10s), de-dups by `(kind, message)`, and is fire-and-forget. The health
indicator must instead **persist while down**, **clear programmatically on
recovery**, and **re-show on a fresh outage**. That is a state-driven lifecycle,
not the toast queue's event-driven one.

**Decision:** dedicated `StreamHealthSnackbar` component driven by
`useStreamHealth()`, reusing the snackbar visual tokens for consistency.

*Rejected — sticky Toast kind:* would special-case "no auto-dismiss",
"programmatic clear", and "re-show on edge" across the toast queue, fighting its
fire-and-forget model.

## Components & data flow

```
events.ts: openEventStream()
  ├─ scheduleReconnect()      (D2: backoff+jitter; arms unhealthy timer per D5)
  ├─ connect()                (ping timeout D3; malformed-handshake reconnect D4;
  │                            401 → prism-auth-rejected D1; clears unhealthy
  │                            timer + marks healthy on frame/handshake D5)
  └─ handle.streamHealthy() / onHealthChange()   (D6)
        │
        ▼
  useStreamHealth()  ──►  StreamHealthSnackbar   (D7)
        (hook)               renders iff !healthy && !dismissedThisOutage
```

### StreamHealthSnackbar behavior (Section 3 — B1)

- Renders **iff** `!healthy && !dismissedThisOutage`.
- Single line: **"Live updates paused"** · **Reload** button · **×** dismiss.
- Floating: `position: fixed`, centered, **no backdrop**, non-blocking (does not
  block clicks/reads underneath). `role="status"`, `aria-live="polite"`.
- **Dismiss (×)** sets `dismissedThisOutage = true`, hiding it for the current
  outage only. A `healthy → unhealthy` transition resets the flag so a new outage
  re-shows it.
- **Reload** → `window.location.reload()` (clean-state refresh; a force-reconnect
  was considered but reload is simpler and matches the issue copy intent).
- Mounted in the authed tree **inside** `EventStreamProvider` (needs the handle
  context), alongside `ToastContainer`.

**Deferred to the B1 visual gate (real screenshots, not mocked here):**
bottom-center vs top-center placement (lean bottom-center — top collides with
`Header` + `PrTabStrip`) and final copy/iconography.

## Error handling

- Subscribe-loop failures in `useActivePrUpdates` remain non-fatal (unchanged).
- A throwing health subscriber callback must not break the notify loop (swallow
  per-subscriber, matching the existing listener-dispatch pattern).
- The `myEs !== es` captured-self guard and `closed` checks are preserved across
  the new scheduled-reconnect path (a pending backoff timer must be a no-op after
  `close()`).

## Testing strategy

`events.ts` has **no existing tests**, so PR1 stands up `EventSource` + `fetch`
mocks with fake timers.

**PR1 (Sections 1–2, hands-off):**
- Backoff: nth retry waits within `[0.75, 1.25] · min(MAX, BASE·2^n)`; resets to
  BASE after a `subscriber-assigned`.
- Ping probe aborts at 5s and routes to a scheduled reconnect.
- Malformed `subscriber-assigned` → `scheduleReconnect()` (no hang).
- 401 ping response → `prism-auth-rejected` dispatched and **no** reload.
- Health: flips `false` after 30s of no frames/handshake; flips `true` on the next
  handshake/frame; `onHealthChange` fires on each edge; `close()` cancels pending
  timers.

**PR2 (Section 3, B1):**
- Snackbar renders only when unhealthy; hides on recovery.
- Dismiss hides for the current outage; a new `healthy→unhealthy` edge re-shows.
- Reload action invokes reload.
- `useStreamHealth` returns `true` with no provider.

## Packaging

- **PR1** — Sections 1 + 2 (reconnect logic + internal `streamHealthy` flag +
  tests). Fully hands-off; merges on green. The flag is dead-but-tested until PR2.
- **PR2** — Section 3 (`StreamHealthSnackbar` + wiring). Small, B1-gated; human
  visual assert before merge.

## Source

Documentation deferral audit — `docs/specs/2026-05-06-s3-pr-detail-read-deferrals.md`
(~lines 214–323). Verified still unresolved against current code on 2026-06-06.
