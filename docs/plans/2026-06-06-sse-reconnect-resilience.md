# SSE Reconnect Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SSE event-stream client resilient — bounded backoff, ping timeout, handshake-failure recovery, loop-free 401 handling — and surface a dismissible "connection lost" snackbar.

**Architecture:** All reconnect/health logic lives in the `openEventStream()` closure in `frontend/src/api/events.ts` (PR1). Health is surfaced on the `EventStreamHandle` and consumed by a new `useStreamHealth()` hook feeding a dedicated `StreamHealthSnackbar` (PR2). Spec: `docs/specs/2026-06-06-sse-reconnect-resilience-design.md` (decisions D1–D8 are referenced by id throughout).

**Tech Stack:** TypeScript, React, Vitest + jsdom (fake timers), CSS modules.

**Worktree:** `D:\src\PRism-wt\141-sse-reconnect-resilience`, branch `feature/141-sse-reconnect-resilience`. Run all commands from `frontend/`.

---

## Conventions for every task

- Run a single test file with: `npx vitest run __tests__/events-handshake.test.tsx` (PR1) or the component file (PR2). Run the whole suite with `npx vitest run`.
- **The full suite must be green at the end of every task.** Several PR1 tasks change behavior that existing tests assert; those tasks migrate the affected tests in the same commit.
- Commit after each task with the message shown.
- Tests pin jitter by passing `openEventStream({ random: () => 0.5 })` → jitter factor `0.75 + 0.5·0.5 = 1.0`, so the backoff delay equals exactly `min(MAX, BASE·2^attempt)`.

## File structure

| File | Responsibility | PR |
|------|----------------|----|
| `frontend/src/api/events.ts` | reconnect state machine, health timers, handle extensions | PR1 |
| `frontend/__tests__/events-handshake.test.tsx` | migrated + extended unit tests for the above | PR1 |
| `frontend/src/hooks/useStreamHealth.ts` | hook bridging the handle's health to React | PR1 |
| `frontend/src/hooks/useEventSource.tsx` | unchanged (provider) — referenced only | — |
| `frontend/src/components/StreamHealthSnackbar/StreamHealthSnackbar.tsx` | the snackbar UI | PR2 |
| `frontend/src/components/StreamHealthSnackbar/StreamHealthSnackbar.module.css` | snackbar styles + z-index + reduced-motion | PR2 |
| `frontend/src/components/StreamHealthSnackbar/index.ts` | barrel | PR2 |
| `frontend/src/components/StreamHealthSnackbar/StreamHealthSnackbar.test.tsx` | component tests | PR2 |
| `frontend/src/App.tsx` | mount the snackbar in the authed tree | PR2 |

---

## Target state of `events.ts` (PR1 reference)

This is the end state PR1 builds toward. Tasks 1–7 add the pieces; this block is the canonical reference for names and structure. The unchanged parts (typed-listener loop, `WINDOW_EVENT_BRIDGE`, `on()`, type exports) are elided with `// …unchanged…`.

```ts
const SILENCE_WATCHER_MS = 35_000;
const UNHEALTHY_AFTER_MS = 30_000;   // D5 — sits inside the 35s watchdog
const BASE_DELAY_MS = 1_000;         // D2
const MAX_DELAY_MS = 30_000;         // D2
const STABLE_AFTER_MS = 10_000;      // D2 dwell
const PING_TIMEOUT_MS = 5_000;       // D3

export type StreamHealthHandle = {
  streamHealthy(): boolean;
  onHealthChange(cb: (healthy: boolean) => void): () => void;
  forceReconnect(): void;
};
export type EventStreamHandle = {
  subscriberId(): Promise<string>;
  reconnectSignal(): AbortSignal;
  on<T extends keyof EventPayloadByType>(
    type: T, callback: (payload: EventPayloadByType[T]) => void,
  ): () => void;
  close(): void;
} & StreamHealthHandle;

export function openEventStream(opts?: { random?: () => number }): EventStreamHandle {
  const random = opts?.random ?? Math.random;
  let es: EventSource;
  let idPromise: Promise<string>;
  let resolveId: (id: string) => void;
  let abortController: AbortController;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let hasEverConnected = false;
  let attempt = 0;
  let reconnectPending = false;            // D2/D8 re-entrancy
  let healthy = true;                      // D5 optimistic
  const healthSubs = new Set<(h: boolean) => void>();

  const listeners: { [K in keyof EventPayloadByType]?: Set<(p: EventPayloadByType[K]) => void> } = {};

  function newIdPromise() { idPromise = new Promise<string>((r) => { resolveId = r; }); }
  function newAbortController() { abortController = new AbortController(); }

  function notifyHealth(next: boolean) {
    if (healthy === next) return;
    healthy = next;
    healthSubs.forEach((cb) => { try { cb(next); } catch { /* per-subscriber isolation */ } });
  }

  // D5/D8: watchdog + health countdown armed together (lockstep), NO health-notify here.
  function armLiveness() {
    if (watchdog) clearTimeout(watchdog);
    if (healthTimer) clearTimeout(healthTimer);
    if (closed) return;
    watchdog = setTimeout(() => scheduleReconnect(), SILENCE_WATCHER_MS);
    healthTimer = setTimeout(() => notifyHealth(false), UNHEALTHY_AFTER_MS);
  }
  // A confirmed liveness signal arrived: mark healthy, re-arm both timers.
  function onLiveness() { notifyHealth(true); armLiveness(); }

  function computeDelay(n: number) {
    const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** n);
    return base * (0.75 + 0.5 * random()); // ±25% jitter
  }

  // D2/D8: single scheduler. immediate=true → forceReconnect (delay 0, attempt unchanged).
  function scheduleReconnect(options?: { immediate?: boolean }) {
    if (closed || reconnectPending) return;
    reconnectPending = true;
    abortController.abort();
    es.close();
    if (watchdog) clearTimeout(watchdog);
    if (dwellTimer) clearTimeout(dwellTimer); // D8: stale dwell must not reset attempt
    newIdPromise();
    newAbortController();
    const delay = options?.immediate ? 0 : computeDelay(attempt++);
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      reconnectPending = false;
      if (!closed) connect();
    }, delay);
  }

  function connect() {
    es = new EventSource('/api/events');
    const myEs = es;
    let probed = false;

    es.onerror = () => {
      if (probed || closed) return;
      if (myEs !== es) return;             // captured-self guard
      probed = true;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS); // D3 fake-timer-drivable
      void fetch('/api/events/ping', { signal: ctrl.signal })
        .then((resp) => {
          clearTimeout(t);
          if (closed || myEs !== es) return;
          if (resp.status === 401) {       // D1
            window.dispatchEvent(new CustomEvent('prism-auth-rejected'));
            closed = true;                 // tombstone
            if (watchdog) clearTimeout(watchdog);
            if (healthTimer) clearTimeout(healthTimer);
            if (backoffTimer) clearTimeout(backoffTimer);
            if (dwellTimer) clearTimeout(dwellTimer);
            es.close();
            return;
          }
          scheduleReconnect();
        })
        .catch(() => {                      // D3: timeout or network error
          clearTimeout(t);
          if (closed || myEs !== es) return;
          scheduleReconnect();
        });
    };

    es.addEventListener('subscriber-assigned', (raw) => {
      try {
        const data = JSON.parse((raw as MessageEvent).data) as { subscriberId: string };
        resolveId(data.subscriberId);
      } catch {
        scheduleReconnect();               // D4
        return;
      }
      if (hasEverConnected) {
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('prism-events-reconnected'));
      } else {
        hasEverConnected = true;
      }
      // D2 dwell: only a stream that SURVIVES the dwell resets attempt.
      if (dwellTimer) clearTimeout(dwellTimer);
      dwellTimer = setTimeout(() => { attempt = 0; }, STABLE_AFTER_MS);
      onLiveness();
    });

    es.addEventListener('heartbeat', () => { onLiveness(); });

    EVENT_TYPES.forEach((type) => {
      es.addEventListener(type, (raw) => {
        // …unchanged parse + bridge + listeners.forEach…
        onLiveness();                       // replaces resetWatchdog()
      });
    });

    armLiveness();                          // arm at connect start (no health-notify)
  }

  newIdPromise();
  newAbortController();
  connect();

  return {
    subscriberId: () => idPromise,
    reconnectSignal: () => abortController.signal,
    on(type, callback) { /* …unchanged… */ },
    streamHealthy: () => healthy,
    onHealthChange(cb) { healthSubs.add(cb); return () => healthSubs.delete(cb); },
    forceReconnect() { scheduleReconnect({ immediate: true }); }, // D6 — guarded by reconnectPending
    close() {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      if (healthTimer) clearTimeout(healthTimer);
      if (backoffTimer) clearTimeout(backoffTimer);
      if (dwellTimer) clearTimeout(dwellTimer);
      abortController.abort();
      es.close();
    },
  };
}
```

---

# PR1 — Reconnect logic + health state machine (hands-off)

### Task 1: Backoff scheduler + re-entrancy guard; migrate silence-watcher tests

**Files:**
- Modify: `frontend/src/api/events.ts`
- Test: `frontend/__tests__/events-handshake.test.tsx`

- [ ] **Step 1: Add the `random` seam + constants + scheduler.** In `events.ts`, add the constants `UNHEALTHY_AFTER_MS`, `BASE_DELAY_MS`, `MAX_DELAY_MS`, `STABLE_AFTER_MS`, `PING_TIMEOUT_MS` (values from the reference block). Change the signature to `openEventStream(opts?: { random?: () => number })` and add `const random = opts?.random ?? Math.random;`. Add outer-scope handles `backoffTimer`, `dwellTimer` (null), and `attempt = 0`, `reconnectPending = false`. Add `computeDelay()` and replace the body of `reconnect()` with the `scheduleReconnect()` from the reference block (without `immediate` yet is fine, but include it now). Change the watchdog arm site and the `onerror`→ping success path to call `scheduleReconnect()` instead of `reconnect()`. Have `scheduleReconnect()` clear `watchdog`/`dwellTimer`, and have `close()` also clear `backoffTimer`/`dwellTimer`.

- [ ] **Step 2: Migrate the four affected timing tests.** Backoff inserts a delay between the watchdog firing (old ES closed) and the new ES being created. Update `events-handshake.test.tsx`:

```ts
// describe('openEventStream — silence watcher ...')
it('reconnects after 35s of silence with no events', () => {
  vi.useFakeTimers();
  try {
    const stream = openEventStream({ random: () => 0.5 }); // pin jitter → delay = BASE
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(35_001);            // watchdog fires: old closed, backoff armed
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_000);             // backoff (BASE) elapses → new ES
    expect(FakeEventSource.instances).toHaveLength(2);
    stream.close();
  } finally { vi.useRealTimers(); }
});

it('heartbeat resets the silence watcher', () => {
  vi.useFakeTimers();
  try {
    const stream = openEventStream({ random: () => 0.5 });
    vi.advanceTimersByTime(25_000);
    FakeEventSource.instances[0].dispatch('heartbeat', { ts: 0 });
    vi.advanceTimersByTime(25_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].closed).toBe(false);
    vi.advanceTimersByTime(10_001);            // 35s after heartbeat → watchdog fires
    expect(FakeEventSource.instances[0].closed).toBe(true);
    vi.advanceTimersByTime(1_000);             // backoff
    expect(FakeEventSource.instances).toHaveLength(2);
    stream.close();
  } finally { vi.useRealTimers(); }
});

it('inbox-updated event also resets the silence watcher', () => {
  vi.useFakeTimers();
  try {
    const stream = openEventStream({ random: () => 0.5 });
    vi.advanceTimersByTime(20_000);
    FakeEventSource.instances[0].dispatch('inbox-updated', { changedSectionIds: [], newOrUpdatedPrCount: 1 });
    vi.advanceTimersByTime(34_999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(2);                 // watchdog fires
    vi.advanceTimersByTime(1_000);             // backoff
    expect(FakeEventSource.instances).toHaveLength(2);
    stream.close();
  } finally { vi.useRealTimers(); }
});

// describe('openEventStream — reconnect signal ...')
it('subscriberId() returns a fresh promise after reconnect', async () => {
  vi.useFakeTimers();
  try {
    const stream = openEventStream({ random: () => 0.5 });
    FakeEventSource.instances[0].dispatch('subscriber-assigned', { subscriberId: 'sub-1' });
    const idBefore = await stream.subscriberId();
    expect(idBefore).toBe('sub-1');
    vi.advanceTimersByTime(35_001);
    vi.advanceTimersByTime(1_000);             // backoff → instances[1] now exists
    FakeEventSource.instances[1].dispatch('subscriber-assigned', { subscriberId: 'sub-2' });
    const idAfter = await stream.subscriberId();
    expect(idAfter).toBe('sub-2');
    stream.close();
  } finally { vi.useRealTimers(); }
});
```

  The `aborts the current reconnect signal when the watcher reconnects` test still passes unchanged (abort happens at `scheduleReconnect()` start, i.e. at `35_001`).

- [ ] **Step 3: Run the file.** `npx vitest run __tests__/events-handshake.test.tsx` → all green (handshake, typed-listener, silence-watcher, reconnect-signal). The ping tests in Task 4 still assume old 401 behavior — run only the non-ping describes if needed, but they should pass since ping behavior is unchanged so far.

- [ ] **Step 4: Add a backoff-growth test.**

```ts
describe('openEventStream — backoff', () => {
  it('grows the delay across consecutive reconnects (no liveness)', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      vi.advanceTimersByTime(35_001);  // watchdog → attempt 0 → delay 1000
      vi.advanceTimersByTime(1_000);
      expect(FakeEventSource.instances).toHaveLength(2);
      vi.advanceTimersByTime(35_001);  // attempt 1 → delay 2000
      vi.advanceTimersByTime(1_999);
      expect(FakeEventSource.instances).toHaveLength(2); // not yet
      vi.advanceTimersByTime(2);
      expect(FakeEventSource.instances).toHaveLength(3);
      stream.close();
    } finally { vi.useRealTimers(); }
  });
});
```

- [ ] **Step 5: Run + commit.** `npx vitest run __tests__/events-handshake.test.tsx` → green.

```bash
git add frontend/src/api/events.ts frontend/__tests__/events-handshake.test.tsx
git commit -m "feat(#141): backoff+jitter reconnect scheduler with re-entrancy guard (D2/D8)"
```

---

### Task 2: Ping probe timeout + network-error → reconnect (D3)

**Files:**
- Modify: `frontend/src/api/events.ts`
- Test: `frontend/__tests__/events-handshake.test.tsx`

- [ ] **Step 1: Write the failing tests.**

```ts
describe('openEventStream — ping timeout (D3)', () => {
  it('reconnects when the ping never resolves (timeout aborts at 5s)', async () => {
    vi.useFakeTimers();
    try {
      // fetch that rejects when its signal aborts, never resolves otherwise
      globalThis.fetch = vi.fn((_url, init?: RequestInit) => new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
      const stream = openEventStream({ random: () => 0.5 });
      FakeEventSource.instances[0].fireError();
      await vi.advanceTimersByTimeAsync(5_000); // ping timeout fires → .catch → scheduleReconnect
      await vi.advanceTimersByTimeAsync(1_000); // backoff
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally { vi.useRealTimers(); }
  });

  it('reconnects on a network-error ping (no longer a silent no-op)', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('network')) as unknown as typeof fetch;
      const stream = openEventStream({ random: () => 0.5 });
      FakeEventSource.instances[0].fireError();
      await vi.advanceTimersByTimeAsync(0);     // microtask: .catch runs → scheduleReconnect
      await vi.advanceTimersByTimeAsync(1_000); // backoff
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally { vi.useRealTimers(); }
  });
});
```

- [ ] **Step 2: Run → fail** (current `.catch` is a silent no-op; no `AbortSignal` either). `npx vitest run __tests__/events-handshake.test.tsx -t "ping timeout"`

- [ ] **Step 3: Implement D3.** In `connect()`'s `es.onerror`, wrap the probe per the reference block: create an `AbortController`, `const t = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS)`, pass `{ signal: ctrl.signal }` to `fetch`, `clearTimeout(t)` in both `.then` and `.catch`, and call `scheduleReconnect()` from the `.catch` (guarded by `closed`/`myEs !== es`).

- [ ] **Step 4: Run → pass.** Also re-run the whole file to confirm the existing `probes at most once per instance` and `5xx reconnect` tests still pass (the 5xx test needs migration in Task 4's batch if it goes red from backoff — if it fails now, migrate it here to use fake timers + `advanceTimersByTimeAsync(1_000)` like the network-error test).

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/api/events.ts frontend/__tests__/events-handshake.test.tsx
git commit -m "feat(#141): ping probe timeout + network-error reconnect (D3)"
```

---

### Task 3: Malformed handshake recovers (D4)

**Files:**
- Modify: `frontend/src/api/events.ts`
- Test: `frontend/__tests__/events-handshake.test.tsx`

- [ ] **Step 1: Write the failing test.**

```ts
describe('openEventStream — malformed handshake (D4)', () => {
  it('reconnects when subscriber-assigned payload is not valid JSON', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      // dispatch a raw frame whose .data is not JSON
      FakeEventSource.instances[0].listeners['subscriber-assigned']?.forEach((cb) =>
        cb({ data: 'not-json{' } as MessageEvent),
      );
      vi.advanceTimersByTime(1_000); // immediate scheduleReconnect (attempt 0 → 1000)
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally { vi.useRealTimers(); }
  });
});
```

- [ ] **Step 2: Run → fail** (current catch swallows; no reconnect). 

- [ ] **Step 3: Implement.** In the `subscriber-assigned` handler's `catch`, call `scheduleReconnect(); return;` (per reference block).

- [ ] **Step 4: Run → pass**, then whole file green.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/api/events.ts frontend/__tests__/events-handshake.test.tsx
git commit -m "feat(#141): malformed subscriber-assigned recovers via reconnect (D4)"
```

---

### Task 4: 401 → dispatch + tombstone; migrate the reload test (D1)

**Files:**
- Modify: `frontend/src/api/events.ts`
- Test: `frontend/__tests__/events-handshake.test.tsx`

- [ ] **Step 1: Rewrite the 401 test (it inverts).** Replace `forces window.location.reload when ping returns 401`:

```ts
it('dispatches prism-auth-rejected and tombstones the stream on a 401 ping (no reload)', async () => {
  vi.useFakeTimers();
  try {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;
    const stream = openEventStream({ random: () => 0.5 });
    FakeEventSource.instances[0].fireError();
    await vi.advanceTimersByTimeAsync(0); // ping resolves
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(dispatchSpy.mock.calls.some(([e]) => (e as Event).type === 'prism-auth-rejected')).toBe(true);
    expect(FakeEventSource.instances[0].closed).toBe(true);
    // tombstoned: no further reconnects ever
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    stream.close();
  } finally { vi.useRealTimers(); }
});
```

  Keep the `reloadSpy` setup in the surrounding `beforeEach` (it now asserts the *absence* of reload).

- [ ] **Step 2: Run → fail** (current code reloads). 

- [ ] **Step 3: Implement D1.** In the ping `.then`, replace the `resp.status === 401` branch body with: dispatch `prism-auth-rejected`, set `closed = true`, clear all four timers, `es.close()`, `return` (per reference block).

- [ ] **Step 4: Run → pass**; whole file green.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/api/events.ts frontend/__tests__/events-handshake.test.tsx
git commit -m "feat(#141): 401 dispatches prism-auth-rejected + tombstones stream, no reload (D1)"
```

---

### Task 5: Dwell-gated backoff reset + stale-dwell cancellation (D2/D8)

**Files:**
- Modify: `frontend/src/api/events.ts`
- Test: `frontend/__tests__/events-handshake.test.tsx`

- [ ] **Step 1: Write the failing tests.**

```ts
describe('openEventStream — dwell-gated reset (D2)', () => {
  it('resets attempt only after the stream survives the 10s dwell', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      // first outage: attempt 0 → delay 1000
      vi.advanceTimersByTime(35_001); vi.advanceTimersByTime(1_000);
      expect(FakeEventSource.instances).toHaveLength(2);
      // new stream handshakes and SURVIVES the dwell → attempt resets to 0
      FakeEventSource.instances[1].dispatch('subscriber-assigned', { subscriberId: 's' });
      vi.advanceTimersByTime(10_000); // dwell elapses → attempt = 0
      // next outage should again use delay 1000 (attempt 0), not 2000
      vi.advanceTimersByTime(35_001); vi.advanceTimersByTime(999);
      expect(FakeEventSource.instances).toHaveLength(2); // not yet at 999
      vi.advanceTimersByTime(2);
      expect(FakeEventSource.instances).toHaveLength(3);
      stream.close();
    } finally { vi.useRealTimers(); }
  });

  it('a stale dwell from a dropped connection does NOT reset attempt (D8)', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      vi.advanceTimersByTime(35_001); vi.advanceTimersByTime(1_000); // attempt 0→1, instance 2
      // instance 2 handshakes (arms dwell) then DROPS before dwell elapses
      FakeEventSource.instances[1].dispatch('subscriber-assigned', { subscriberId: 's' });
      vi.advanceTimersByTime(3_000);          // 3s < 10s dwell
      vi.advanceTimersByTime(35_001 - 3_000); // silence watchdog fires → scheduleReconnect (clears stale dwell)
      // attempt should be 1 here (not reset). delay for attempt 1 = 2000.
      vi.advanceTimersByTime(7_000);          // original dwell would have fired ~now — must NOT reset attempt
      vi.advanceTimersByTime(1_999);
      // if the stale dwell wrongly reset attempt to 0, instance 3 would already exist (delay 1000)
      // with correct behavior (attempt 1, delay 2000) it does not yet
      vi.advanceTimersByTime(2_000);
      expect(FakeEventSource.instances).toHaveLength(3);
      stream.close();
    } finally { vi.useRealTimers(); }
  });
});
```

  > Note: the stale-dwell test is timing-fiddly. The essential assertion is that after an accept-then-drop, the next reconnect uses the **grown** backoff (attempt ≥ 1), proving the dropped stream's dwell did not reset `attempt`. If the exact `advanceTimersByTime` sequencing is awkward against the implementation, simplify by exposing nothing new — instead assert relative timing: capture instance count right after the attempt-1 delay (2000) vs the attempt-0 delay (1000) window.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** In the `subscriber-assigned` handler, after the replay-dispatch block, clear any existing `dwellTimer` and set `dwellTimer = setTimeout(() => { attempt = 0; }, STABLE_AFTER_MS)`. Confirm `scheduleReconnect()` clears `dwellTimer` at its start (added in Task 1 — verify). This makes a superseded stream's dwell unable to fire.

- [ ] **Step 4: Run → pass**; whole file green.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/api/events.ts frontend/__tests__/events-handshake.test.tsx
git commit -m "feat(#141): dwell-gated backoff reset; stale dwell cleared on reconnect (D2/D8)"
```

---

### Task 6: Health state machine + handle surfacing (D5/D6)

**Files:**
- Modify: `frontend/src/api/events.ts`
- Test: `frontend/__tests__/events-handshake.test.tsx`

- [ ] **Step 1: Write the failing tests.**

```ts
describe('openEventStream — health (D5/D6)', () => {
  it('starts healthy and stays healthy while heartbeats arrive', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      expect(stream.streamHealthy()).toBe(true);
      vi.advanceTimersByTime(20_000);
      FakeEventSource.instances[0].dispatch('heartbeat', { ts: 0 });
      vi.advanceTimersByTime(29_000);   // <30s since heartbeat
      expect(stream.streamHealthy()).toBe(true);
      stream.close();
    } finally { vi.useRealTimers(); }
  });

  it('flips unhealthy after 30s with no liveness, and notifies subscribers', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      const onChange = vi.fn();
      stream.onHealthChange(onChange);
      vi.advanceTimersByTime(30_001);
      expect(stream.streamHealthy()).toBe(false);
      expect(onChange).toHaveBeenCalledWith(false);
      stream.close();
    } finally { vi.useRealTimers(); }
  });

  it('recovers to healthy on the next liveness signal', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      const onChange = vi.fn();
      stream.onHealthChange(onChange);
      vi.advanceTimersByTime(30_001);
      // a reconnect eventually opens instance 2; deliver a handshake on it
      vi.advanceTimersByTime(35_001); vi.advanceTimersByTime(1_000);
      FakeEventSource.instance.dispatch('subscriber-assigned', { subscriberId: 's' });
      expect(stream.streamHealthy()).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(true);
      stream.close();
    } finally { vi.useRealTimers(); }
  });

  it('onHealthChange returns an unsubscribe', () => {
    const stream = openEventStream();
    const cb = vi.fn();
    const unsub = stream.onHealthChange(cb);
    unsub();
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);
    expect(cb).not.toHaveBeenCalled();
    vi.useRealTimers();
    stream.close();
  });
});
```

- [ ] **Step 2: Run → fail** (`streamHealthy`/`onHealthChange` not defined).

- [ ] **Step 3: Implement D5/D6.** Add `healthTimer`, `healthy = true`, `healthSubs`, `notifyHealth()`, `armLiveness()`, `onLiveness()` per the reference block. Replace every `resetWatchdog()` call: the **connect() tail** calls `armLiveness()` (no notify); the **handshake/heartbeat/typed-data** handlers call `onLiveness()`. Add `streamHealthy` and `onHealthChange` to the returned handle; extend the `EventStreamHandle` type (and add the `StreamHealthHandle` type). Ensure `close()` and the D1 tombstone clear `healthTimer`.

  > Remove the old `resetWatchdog` function once all call sites use `armLiveness`/`onLiveness`. Do a grep for `resetWatchdog` to confirm none remain.

- [ ] **Step 4: Run → pass**; whole file green.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/api/events.ts frontend/__tests__/events-handshake.test.tsx
git commit -m "feat(#141): stream health state machine + handle surfacing (D5/D6)"
```

---

### Task 7: `forceReconnect()` (D6)

**Files:**
- Modify: `frontend/src/api/events.ts`
- Test: `frontend/__tests__/events-handshake.test.tsx`

- [ ] **Step 1: Write the failing tests.**

```ts
describe('openEventStream — forceReconnect (D6)', () => {
  it('reconnects immediately, bypassing the backoff wait', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      stream.forceReconnect();
      vi.advanceTimersByTime(0); // immediate (delay 0)
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally { vi.useRealTimers(); }
  });

  it('does not reset the backoff curve (attempt unchanged)', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      // climb to attempt 1
      vi.advanceTimersByTime(35_001); vi.advanceTimersByTime(1_000); // attempt 0→1
      stream.forceReconnect(); vi.advanceTimersByTime(0);            // immediate, attempt stays 1
      // a subsequent silence outage should use attempt 1 → delay 2000
      vi.advanceTimersByTime(35_001); vi.advanceTimersByTime(1_999);
      const before = FakeEventSource.instances.length;
      vi.advanceTimersByTime(2);
      expect(FakeEventSource.instances.length).toBe(before + 1);
      stream.close();
    } finally { vi.useRealTimers(); }
  });

  it('is a no-op while a reconnect is already pending (mashing → one EventSource)', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      stream.forceReconnect();
      stream.forceReconnect();
      stream.forceReconnect();
      vi.advanceTimersByTime(0);
      expect(FakeEventSource.instances).toHaveLength(2); // only one new stream
      stream.close();
    } finally { vi.useRealTimers(); }
  });
});
```

- [ ] **Step 2: Run → fail** (`forceReconnect` not defined).

- [ ] **Step 3: Implement.** Add `forceReconnect() { scheduleReconnect({ immediate: true }); }` to the handle. Confirm `scheduleReconnect`'s `if (closed || reconnectPending) return` guard makes the mash a no-op, and that `immediate` skips `attempt++`.

- [ ] **Step 4: Run → pass**; whole file green.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/api/events.ts frontend/__tests__/events-handshake.test.tsx
git commit -m "feat(#141): guarded forceReconnect (D6)"
```

---

### Task 8: `useStreamHealth` hook (D6)

**Files:**
- Create: `frontend/src/hooks/useStreamHealth.ts`
- Test: `frontend/src/hooks/useStreamHealth.test.tsx`

- [ ] **Step 1: Write the failing test.**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { useStreamHealth } from './useStreamHealth';
import type { EventStreamHandle } from '../api/events';

function makeHandle(initial: boolean) {
  let healthy = initial;
  const subs = new Set<(h: boolean) => void>();
  const handle = {
    streamHealthy: () => healthy,
    onHealthChange: (cb: (h: boolean) => void) => { subs.add(cb); return () => subs.delete(cb); },
    forceReconnect: vi.fn(),
    subscriberId: () => Promise.resolve('x'),
    reconnectSignal: () => new AbortController().signal,
    on: () => () => {},
    close: () => {},
  } as unknown as EventStreamHandle;
  const set = (h: boolean) => { healthy = h; subs.forEach((cb) => cb(h)); };
  return { handle, set };
}

// A tiny provider wrapper mirroring useEventSource's context is needed;
// import the real EventStreamContext if exported, else wrap via useEventSource mock.

describe('useStreamHealth', () => {
  it('returns healthy:true and a no-op retry when no provider is present', () => {
    const { result } = renderHook(() => useStreamHealth());
    expect(result.current.healthy).toBe(true);
    expect(typeof result.current.retry).toBe('function');
    result.current.retry(); // must not throw
  });

  it('tracks the handle health and exposes retry → forceReconnect', () => {
    const { handle, set } = makeHandle(true);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(EventStreamTestProvider, { handle, children });
    const { result } = renderHook(() => useStreamHealth(), { wrapper });
    expect(result.current.healthy).toBe(true);
    act(() => set(false));
    expect(result.current.healthy).toBe(false);
    result.current.retry();
    expect(handle.forceReconnect).toHaveBeenCalledTimes(1);
  });
});
```

  > To inject a handle in tests, export a test provider from `useEventSource.tsx` or have `useStreamHealth` accept the handle from `useEventSource()`. Simplest: `useStreamHealth` calls `useEventSource()` internally; in the test, mock `useEventSource` with `vi.mock('../hooks/useEventSource', ...)` returning the fake handle. Replace `EventStreamTestProvider` usage with that mock if cleaner.

- [ ] **Step 2: Run → fail** (hook missing).

- [ ] **Step 3: Implement.**

```ts
// frontend/src/hooks/useStreamHealth.ts
import { useEffect, useState } from 'react';
import { useEventSource } from './useEventSource';

export function useStreamHealth(): { healthy: boolean; retry: () => void } {
  const stream = useEventSource();
  const [healthy, setHealthy] = useState(() => (stream ? stream.streamHealthy() : true));

  useEffect(() => {
    if (!stream) { setHealthy(true); return; }
    setHealthy(stream.streamHealthy());
    return stream.onHealthChange(setHealthy);
  }, [stream]);

  return { healthy, retry: () => stream?.forceReconnect() };
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/hooks/useStreamHealth.ts frontend/src/hooks/useStreamHealth.test.tsx
git commit -m "feat(#141): useStreamHealth hook bridging handle health to React (D6)"
```

---

### Task 9: PR1 pre-push checklist + open PR

- [ ] **Step 1: Full suite.** From `frontend/`: `npx vitest run` → all green.
- [ ] **Step 2: Lint (bypass rtk masking per project note).** `node ./node_modules/prettier/bin/prettier.cjs --check .` then `npm run lint`. Fix any issues.
- [ ] **Step 3: Build.** `npm run build` → succeeds.
- [ ] **Step 4: Sync main.** `git fetch origin && git merge origin/main` (resolve if needed; re-run suite).
- [ ] **Step 5: Open PR1 via `pr-autopilot`** with `## Proof` containing: acceptance-criteria checklist (D1–D6 mapped to tests), the doc-review dispositions summary (rounds 1+2), and the secrets-scan result. Title: `feat(#141): SSE reconnect resilience — logic + health state machine (PR1/2)`. Body must note this is PR1 of 2 and does **not** close #141 (PR2 does). PR1 is hands-off.

---

# PR2 — StreamHealthSnackbar (B1, gated)

> Start PR2 only after PR1 merges. Re-sync `origin/main` into the branch (or a fresh branch off main).

### Task 10: StreamHealthSnackbar component

**Files:**
- Create: `frontend/src/components/StreamHealthSnackbar/StreamHealthSnackbar.tsx`
- Create: `frontend/src/components/StreamHealthSnackbar/StreamHealthSnackbar.module.css`
- Create: `frontend/src/components/StreamHealthSnackbar/index.ts`
- Test: `frontend/src/components/StreamHealthSnackbar/StreamHealthSnackbar.test.tsx`

- [ ] **Step 1: Write the failing tests.** Mock `useStreamHealth` to control health + capture `retry`.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StreamHealthSnackbar } from './StreamHealthSnackbar';

const retry = vi.fn();
let healthy = true;
vi.mock('../../hooks/useStreamHealth', () => ({
  useStreamHealth: () => ({ healthy, retry }),
}));

beforeEach(() => { healthy = true; retry.mockClear(); });

describe('StreamHealthSnackbar', () => {
  it('renders nothing while healthy', () => {
    const { container } = render(<StreamHealthSnackbar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the snackbar when unhealthy', () => {
    healthy = false;
    render(<StreamHealthSnackbar />);
    expect(screen.getByRole('status')).toHaveTextContent(/connection lost/i);
    expect(screen.getByRole('button', { name: /retry now/i })).toBeInTheDocument();
  });

  it('Retry now calls retry()', () => {
    healthy = false;
    render(<StreamHealthSnackbar />);
    fireEvent.click(screen.getByRole('button', { name: /retry now/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('dismiss (×) hides it for the current outage', () => {
    healthy = false;
    render(<StreamHealthSnackbar />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
```

  Plus a rerender test for re-show on a fresh outage edge:

```tsx
it('re-shows on a new healthy→unhealthy edge after dismiss', () => {
  healthy = false;
  const { rerender } = render(<StreamHealthSnackbar />);
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  healthy = true;  rerender(<StreamHealthSnackbar />); // recover
  healthy = false; rerender(<StreamHealthSnackbar />); // fresh outage
  expect(screen.getByRole('status')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement the component.**

```tsx
// StreamHealthSnackbar.tsx
import { useEffect, useRef, useState } from 'react';
import { useStreamHealth } from '../../hooks/useStreamHealth';
import styles from './StreamHealthSnackbar.module.css';

export function StreamHealthSnackbar() {
  const { healthy, retry } = useStreamHealth();
  const [dismissed, setDismissed] = useState(false);
  const wasHealthy = useRef(healthy);

  // Reset the dismiss flag on every healthy → unhealthy edge (a fresh outage).
  useEffect(() => {
    if (wasHealthy.current && !healthy) setDismissed(false);
    wasHealthy.current = healthy;
  }, [healthy]);

  if (healthy || dismissed) return null;

  return (
    <div className={styles.snackbar} role="status" aria-live="polite">
      <span className={styles.message}>Connection lost — reconnecting</span>
      <button type="button" className={styles.retry} onClick={retry}>
        Retry now
      </button>
      <button
        type="button"
        className={styles.dismiss}
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}
```

```css
/* StreamHealthSnackbar.module.css */
.snackbar {
  position: fixed;
  bottom: 24px;                 /* B1 gate may move to top-center */
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--z-snackbar, 200); /* above Header (100), below modal-backdrop (1000) */
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-radius: 8px;
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  font-size: 0.875rem;
  animation: snackbar-in 150ms ease-out;
}
.message { color: var(--text-1); white-space: nowrap; }
.retry { /* match existing text-button styling */ }
.dismiss { background: none; border: none; cursor: pointer; font-size: 1.1rem; line-height: 1; }
@keyframes snackbar-in {
  from { opacity: 0; transform: translate(-50%, 8px); }
  to   { opacity: 1; transform: translate(-50%, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .snackbar { animation: none; }
}
```

```ts
// index.ts
export { StreamHealthSnackbar } from './StreamHealthSnackbar';
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/components/StreamHealthSnackbar/
git commit -m "feat(#141): StreamHealthSnackbar — connection-lost indicator (D7), PR2"
```

---

### Task 11: Mount in App + verify a11y/keyboard

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Mount inside the authed tree.** In `App.tsx`, import `StreamHealthSnackbar` and render it inside `tree` (the child of `EventStreamProvider`), next to `<ToastContainer />`:

```tsx
<ToastContainer />
<StreamHealthSnackbar />
<Cheatsheet />
```

  It must be inside the `EventStreamProvider` subtree so `useStreamHealth → useEventSource` resolves a real handle; `tree` is only wrapped by `EventStreamProvider` when authed (App.tsx:131), which is correct.

- [ ] **Step 2: Confirm Escape is untouched.** Verify no document-level Escape handler is added (the snackbar relies on the × button; Escape belongs to the Modal layer). No code needed — just confirm.

- [ ] **Step 3: Add the z-index token if absent.** Grep `--z-snackbar` and the design-token CSS. If a token convention exists (e.g. in a `:root` block), add `--z-snackbar: 200;`. Otherwise the CSS fallback `var(--z-snackbar, 200)` suffices — no change needed.

- [ ] **Step 4: Run the suite + build.** `npx vitest run` and `npm run build` → green.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/App.tsx
git commit -m "feat(#141): mount StreamHealthSnackbar in authed tree (PR2)"
```

---

### Task 12: PR2 pre-push + B1 visual gate

- [ ] **Step 1: Full suite + lint + build** (as Task 9 steps 1–3).
- [ ] **Step 2: Capture the B1 visual proof.** Run the app (`run.ps1 -Reset None --no-browser`), simulate stream loss (stop the backend or block `/api/events`), screenshot the snackbar in light + dark. Host on a `review-assets/pr-N` branch and embed in the PR per the project's visual-verification convention.
- [ ] **Step 3: Sync main**, then open PR2 via `pr-autopilot`. Title: `feat(#141): connection-lost snackbar (PR2/2)`; body `Closes #141`; `## Proof` includes the visual section. **This is B1-gated** — after green-and-ready, pause and @-mention the assignee for the visual assert (and the bottom-center vs top-center placement decision). Do not self-merge.

---

## Self-review

**Spec coverage:**
- D1 (401 dispatch + tombstone) → Task 4 ✓
- D2 (backoff+jitter, re-entrancy, dwell reset) → Tasks 1, 5 ✓
- D3 (ping timeout + network-error reconnect) → Task 2 ✓
- D4 (malformed handshake) → Task 3 ✓
- D5 (health timer, transport-health, lockstep via armLiveness/onLiveness) → Task 6 ✓
- D6 (handle surfacing, forceReconnect, useStreamHealth) → Tasks 6, 7, 8 ✓
- D7 (dedicated snackbar, copy, dismiss/re-show, a11y, motion) → Tasks 10, 11 ✓
- D8 (timer-lifecycle invariant: clear on reconnect/close/tombstone/forceReconnect) → Tasks 1, 4, 5, 6 ✓
- Existing-tests migration → Tasks 1, 2, 4 ✓
- Packaging (PR1 hands-off, PR2 B1) → Tasks 9, 12 ✓

**Placeholder scan:** test code uses fiddly fake-timer sequencing in Task 5 (flagged inline with a fallback assertion strategy). No "TBD"/"add error handling"/"similar to Task N" placeholders.

**Type consistency:** `streamHealthy()`, `onHealthChange()`, `forceReconnect()` consistent across the reference block, Tasks 6/7/8, and the hook. `scheduleReconnect({ immediate })`, `armLiveness`/`onLiveness`, `computeDelay`, `reconnectPending`, `dwellTimer`, `attempt` consistent across tasks. Hook shape `{ healthy, retry }` consistent in Tasks 8/10.
