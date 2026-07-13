# Activity-rail poll: gate on document visibility

**Issue:** [#732](https://github.com/prpande/PRism/issues/732) · **Tier:** T2 · **Risk:** hands-off
**Precedents:** `InboxPage.tsx` (#717 / PR #729), `useCheckRuns.ts` (#636)

## Problem

`useActivity.ts` runs `setInterval(() => void poll(), 90_000)` with no visibility gate. While the
rail is `enabled`, a backgrounded tab keeps polling `/api/activity` every 90s.

Unlike the inbox 8s backstop (#717), which revalidates a localhost snapshot, `/api/activity` is a
**real GitHub read** — a 3-call fan-out over `received_events` + `notifications` +
`user/subscriptions`. A backgrounded tab with the rail visible therefore burns ~120 GitHub reads an
hour against the PAT's rate-limit budget, rendering a view nobody is looking at.

The hook's own comment (`useActivity.ts:16-17`) already concedes the gap: *"Tab-hidden
visibility-pause remains future work."*

## Goal

While the rail is enabled and the tab is hidden, `/api/activity` is not called at all. On return to
visible, the rail catches up immediately rather than waiting out the remainder of a 90s tick.

Non-goals: changing the 90s cadence; changing the `enabled` semantics; changing the rail's
steady-state rendered content; touching the module-scoped `cachedActivity` (#359) or the backend.

## Design

Mirror `InboxPage.tsx:69-95` rather than inventing a variant. That code is the reviewed,
shipped expression of this exact pattern, and divergence here would be gratuitous.

```
let inFlight = false;                     // single-flight — useCheckRuns.ts:103
let id: ReturnType<typeof setInterval> | undefined;

const poll = async () => {
  if (inFlight) return;                   // drop an overlapping dispatch
  inFlight = true;
  try {
    const next = await getActivity();
    if (cancelled) return;
    cachedActivity = next;
    setData(next);
    setError(null);
    if (next.stale && !immediateRefetchFired && document.visibilityState === 'visible') {
      immediateRefetchFired = true;
      queueMicrotask(() => { if (!cancelled) void poll(); });
    }
  } catch (e) {
    if (cancelled) return;
    setError(e instanceof Error ? e : new Error(String(e)));
  } finally {
    inFlight = false;
    if (!cancelled) setIsLoading(false);
  }
};

const start = () => { id ??= setInterval(() => void poll(), POLL_MS); };
const stop  = () => { if (id !== undefined) { clearInterval(id); id = undefined; } };

const onVisibility = () => {
  if (document.visibilityState === 'visible') {
    if (id === undefined) void poll();   // catch up exactly once per resume
    start();
  } else {
    stop();
  }
};

if (cachedActivity === null) setIsLoading(true);      // unchanged — keeps decision 1 honest
if (document.visibilityState === 'visible') { void poll(); start(); }
document.addEventListener('visibilitychange', onVisibility);
```

Cleanup removes the listener, sets `cancelled = true`, and calls `stop()`.

`stop()` deliberately does **not** abort a request already in flight. A poll *issued* while visible
is not a poll *fired* while hidden, so letting it land violates neither the goal nor AC1; it writes
`cachedActivity` and `setData` on a hidden tab, which is unobservable and self-consistent. Aborting
would need an `AbortController` the `getActivity()` seam does not currently take, which is a
backend-adjacent change this issue's non-goals exclude.

### The decisions this design makes

**1. The on-mount `poll()` is gated too, not just the interval.**

The issue's acceptance criterion reads *"No `/api/activity` poll fires while `document.hidden` (rail
enabled)"* — unqualified. Today's `void poll()` at line 92 fires unconditionally on mount. Mount
while hidden is reachable (browser tab-restore on startup; a keep-alive remount of `InboxPage` in a
background tab), so leaving the mount fetch ungated would violate AC1 on exactly the path the issue
is about.

Gating it costs one behavioral wrinkle: mounting while hidden with an empty `cachedActivity` leaves
`isLoading === true` until the tab is shown (`isLoading` settles to `false` only in `poll()`'s
`finally`, or via the `!enabled` early return). That is correct — the skeleton is the honest state
for "data is coming, nothing yet," it is unobservable while the tab is hidden, and the resume path
fires `poll()` immediately, which clears it. The alternative (settle to a not-loading empty state)
would render an empty rail on return, a worse lie. See `positional-skeleton-is-a-location-promise`.

`InboxPage.tsx`'s effect has no initial fetch to gate — its first load comes from `useInbox` — so
the divergence is in the *scope of what is gated*, not in the mechanism. The mount-while-hidden path
is not hypothetical: `InboxPage.test.tsx:417` already ships a case for it
(`mounts silent while hidden, then arms on first foreground — #717`).

**2. `if (id === undefined)` guards the catch-up, not a boolean `wasHidden` flag.**

Browsers emit `visibilitychange` with `visibilityState === 'visible'` on some focus/blur cycles with
no intervening `hidden`. Keying the catch-up off "the interval is currently unarmed" makes a
redundant `visible` event a no-op by construction: `id` is still armed, so no extra fetch. This is
the #717 / PR #729 refinement, and `id` is already the state we must track for `stop()`, so no
second variable is introduced. A `wasHidden` boolean would be a redundant, drift-prone mirror of
`id`'s armed/unarmed state.

**3. `immediateRefetchFired` stays scoped to the effect closure and is never reset on resume.**

The #619 one-shot exists so a backend that keeps answering `stale: true` cannot drive an unbounded
refetch loop (DES-4 explicitly refuses to treat `stale → false` as the loop terminator). Resetting
it on every visibility resume would restore that hole: an alt-tabbing user could re-arm the one-shot
indefinitely, which is the same class of bug `useCheckRuns.ts:204-208` calls out for its
rerun-watch deadline. So the flag stays effect-scoped and untouched by the resume path.

Losing nothing matters here: the resume path already fires a fresh `poll()`, so the data is current
regardless of whether the stale-nudge is still available.

**4. The `#619` stale-nudge is visibility-gated, and the one-shot flag is spent only when it fires.**

Without this, the change misses its own goal. `stop()` clears the interval but does not cancel an
in-flight request. So: a poll issued while visible lands `stale: true` *after* the tab goes hidden;
`cancelled` is still `false` (it is set only on unmount); the nudge queues a microtask; the microtask
fires `getActivity()` — a real GitHub read on a hidden tab. This is most reachable on cold-start
rehydration, exactly where `stale: true` comes from, and it is a letter-violation of AC1.

Adding `document.visibilityState === 'visible'` to the nudge's condition closes it. Setting
`immediateRefetchFired` only when the nudge actually fires is what preserves #619: if the stale
response lands while hidden, the flag stays unspent, so the resume poll's own `stale: true` still
earns its one nudge. The loop remains bounded at one nudge per effect run either way, because the
flag is set synchronously inside `poll()` before the microtask is queued.

**5. A single-flight guard (`inFlight`) replaces any response-ordering machinery.**

`if (id === undefined) void poll()` keys the catch-up off "the interval is unarmed," not off "no
request is pending." Mount fires poll A; the user hides (`stop()` clears `id`) and re-shows before A
resolves; `id === undefined`, so poll B fires. A and B both write module-scoped `cachedActivity` and
call `setData`, with no sequencing guard — if A resolves after B, the older snapshot silently
clobbers the newer and the rail shows stale activity until the next tick. `InboxPage.tsx`'s
`revalidate()` never faced this because it mutates no module cache and has no mount fetch; the
mirror inherits the shape without the protection.

`useCheckRuns.ts:103,138-139,197` already solves this in-repo with a per-effect `inFlight` boolean —
single-flight, skip overlapping dispatches. Reusing it is strictly stronger than a generation counter
here (two responses can never be in flight, so they cannot be reordered) and adds three lines instead
of a new concept. It also subsumes the pre-existing hazard of a 90s tick firing while a slow poll is
still pending. The `#619` nudge is unaffected: `queueMicrotask`'s callback runs after `poll()`'s
`finally` has already cleared `inFlight`.

Consequence for AC2: on resume, *at most* one poll fires — none when a request is already pending,
because that pending request **is** the catch-up.

### Resume-window staleness (accepted, not fixed)

Today the ungated poll keeps `cachedActivity` at most ~90s stale, so a returning user sees ≤90s-old
activity immediately. After this change, for the duration of the resume poll's round-trip (~1–3s for
the 3-call fan-out), the rail renders data cached before the hidden period — which may be hours old —
with no on-screen cue. `ActivityRail.tsx:210` only shows a skeleton on `isLoading && !data`, and
`isLoading` is false whenever the cache is warm, so the revalidation is silent.

This is accepted, for three reasons. It is the established contract: #359 chose exactly this
stale-while-revalidate behavior for the unmount/remount path, deliberately suppressing the skeleton
to avoid a flash. The exposure is one fetch, not the hidden duration. And adding a freshness
affordance would change rendered output, which reclassifies this issue as **B1 (UI-visual)** under
`.ai/docs/issue-resolution-workflow.md` and routes a P3 tech-debt change through a human visual
gate — a poor trade for a 1–3s cue. Tracked separately rather than smuggled in here; see
`## Deferred work`.

### Composition with `enabled`

The effect returns early when `!enabled`, before any of this. So a disabled rail arms no interval
**and** registers no `visibilitychange` listener — the `enabled` gate strictly dominates, and the
#300/#283/#507 no-fetch-when-hidden guarantee is untouched. Toggling `enabled` re-runs the effect
(it is the sole dependency), which re-evaluates visibility at that moment.

## Test plan

New cases in `useActivity.test.tsx`, following `InboxPage.test.tsx:357-471`'s harness
(`Object.defineProperty(document, 'visibilityState', …)` + `dispatchEvent(new Event('visibilitychange'))`).
`afterEach` restores `visibilityState` to `'visible'` so state cannot bleed between cases.

| # | Case | Asserts |
|---|---|---|
| 1 | Visible, then hidden; advance 3 × 90s | call count frozen at the mount fetch — the interval is *paused*, not merely skipped |
| 2 | Hidden → visible | exactly one additional call, fired without advancing the timer |
| 3 | Visible → visible (redundant event, no intervening hidden) | no additional call |
| 4 | Mount while hidden | zero calls; `isLoading` stays `true`; a later `visible` fires exactly one |
| 5 | `enabled === false` while hidden→visible events fire | zero calls **and** `isLoading === false` (the `enabled` gate dominates; no listener registered) |
| 6 | Stale on mount, then hidden → visible with the resume response **also** `stale: true` | the #619 one-shot is not re-armed — total call count is exactly 3 |
| 7 | Poll in flight → tab hidden → response lands `stale: true` | the nudge does **not** fire; zero calls until `visible`, then exactly one |
| 8 | Mount poll still in flight → hidden → visible | no second concurrent poll (single-flight); call count stays 1 |

Case 1 must fail on `main` before the fix (it will: the interval is ungated).

Cases 3, 6, 7, and 8 are the regression guards for the subtle decisions, and each is built to fail a
plausible wrong implementation rather than to pass the right one:

- **Case 3** fails a `wasHidden` boolean that does not track the interval's armed state.
- **Case 6** pins the *resume* response to `stale: true` on purpose. With a `stale: false` resume
  response the case passes vacuously — a hypothetical implementation that reset
  `immediateRefetchFired` on every resume would look identical. Only a stale resume response makes
  the reset observable, as a 4th call where the correct implementation makes 3.
- **Case 7** fails any implementation that gates only the interval and the mount fetch, leaving the
  `#619` microtask nudge ungated.
- **Case 8** fails the `id === undefined` catch-up without a single-flight guard.

Cases 1 and 2 together are also why the design *pauses* the interval rather than skipping the tick
body: a skipped tick still burns a timer, and an early-return tick offers no prompt catch-up, so it
would fail Case 2.

Cases 7 and 8 need a deferred promise (resolve `getActivity` manually) so the tab can change
visibility while a request is genuinely pending.

Existing tests stay untouched and green: jsdom defaults `visibilityState` to `'visible'`, so the
mount-time `poll()` + `start()` path is exactly today's behavior. `afterEach` must restore
`visibilityState` to `'visible'` — the cases mutate it via `Object.defineProperty` on a shared
`document`, and without the restore a later case in the same file inherits `'hidden'`.

## Acceptance criteria

- [ ] Zero `/api/activity` calls while `enabled && document.visibilityState === 'hidden'` — including
      on mount, and including the `#619` microtask nudge. (A request *issued* while visible is
      allowed to land while hidden; it is not a new call.)
- [ ] `hidden → visible` fires *at most* one prompt `poll()` — none when a request is already
      pending, since that pending request is the catch-up.
- [ ] A redundant `visible` event fires none.
- [ ] `enabled === false` fetches nothing and settles `isLoading` to `false` (unchanged), even while
      visibility events fire.
- [ ] The #619 one-shot still bounds the stale-refetch loop across a resume, and is not consumed by a
      nudge that never fired.
- [ ] No two `getActivity()` requests are ever in flight concurrently.
- [ ] The stale `useActivity.ts:16-17` "future work" comment is removed.
- [ ] Pre-push checklist green.

## Deferred work

- **[Defer] Freshness cue while the resume catch-up poll is in flight** — #753. Pausing the poll
  moves the rail's worst-case displayed staleness from ~90s to the hidden duration, for the ~1–3s of
  the resume fetch, with no on-screen cue. Accepted here because it matches #359's established silent
  stale-while-revalidate contract, and because adding a cue changes rendered output and would
  reclassify this P3 as B1 (UI-visual). Revisit: on a report of the rail looking stale on tab return,
  or the next time the rail's loading affordances are touched.
- **[Skip] Extract a shared `useVisibilityGatedInterval` hook.** Three call sites now carry a
  visibility gate (`InboxPage.tsx`, `useCheckRuns.ts`, `useActivity.ts`), which is the usual trigger
  for extraction. But they are not the same shape: `InboxPage` gates a pure interval with no initial
  fetch, `useCheckRuns` gates a self-rescheduling `setTimeout` chain with an abort controller and a
  fixed rerun deadline, and `useActivity` gates an interval *plus* a mount fetch and a one-shot
  stale nudge. A hook general enough to cover all three would take a callback, an initial-fire flag,
  a cadence, and an abort signal — more surface than the ~10 lines it replaces at each site, and it
  would have to reproduce `useCheckRuns`'s deliberate refusal to re-arm on resume. Rejected as
  premature abstraction (YAGNI); revisit only if a fourth, structurally identical site appears.
