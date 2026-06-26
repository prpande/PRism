# Viewed-state overlay reconciliation (#600)

**Issue:** #600 — Frontend: viewed-state optimistic overlay is never reconciled on
POST success → shadows server truth + rolls back to a stale snapshot (#442 follow-up).
**Tier/Risk:** T2 / hands-off. Single hook (`frontend/src/hooks/useFileViewState.ts`)
+ tests. `area:reliability` correctness; no risk surface (no auth/token/submit/schema/
sidecar), no `design` label.

## Problem

`useFileViewState` layers an optimistic `overlay` (path → desired viewed flag) over a
head-matched `serverViewed` set derived from `draftSession.session.fileViewState.viewedFiles`.
The overlay is written on toggle and removed **only** on the POST `.catch`. There is no
success handler. Two correctness bugs follow:

- **Bug A — overlay never cleared on success.** After a successful POST the override
  persists for the lifetime of the key `owner/repo/number@headSha`. Because the overlay
  always wins over `serverViewed`, a later refetch carrying *newer* server truth (the file
  un-viewed in another window/device) is shadowed — the file shows viewed indefinitely, and
  `countViewedFiles` (Overview "Viewed" tile + tree header) is wrong.
- **Bug B — failed rollback reverts to a STALE snapshot.** Rollback deletes the override,
  falling back to `serverViewed`, which is **not** refetched after a successful POST.
  Trace: mark `a.ts` (POST ok; server now viewed; `serverViewed` still `{}`), then unmark
  `a.ts` (POST fails) → rollback drops the override → falls back to `serverViewed = {}` →
  UI shows not-viewed, but the server holds `a.ts` viewed. Reachable single-window with a
  flaky network.

## Constraint the issue's literal fix misses

A file-viewed POST does **not** trigger `draftSession.refetch()` (own-tab SSE events are
filtered by `useStateChangedSubscriber`). So `serverViewed` is **stale immediately after a
successful POST** until an unrelated event (cross-tab change, reload, reconcile) refetches
it. The issue says "on success, drop the override so `viewedPaths` falls back to authoritative
`serverViewed`" — but dropping it immediately makes a just-marked file flash back to
**un-viewed** and stay that way until the next refetch (seconds, or until navigation). The fix
must reconcile **without** that flash and **without** an extra network round-trip per toggle.

## Approach: hook-local "confirmed" cache, evicted when the server snapshot agrees

Split the single overlay into two key-scoped maps:

- `pending` — in-flight optimistic values (today's overlay).
- `confirmed` — the last POST-**acked** value per path; bridges the gap between a successful
  POST and the next server refetch.

`viewedPaths` derivation priority (highest wins): **(1) `pending` → (2) `confirmed` →
(3) `serverViewed`**. The empty-overlay fast path must gate on **both** maps being empty
(`pending.size === 0 && confirmed.size === 0`) and return the same `serverViewed` `Set`
identity, so an unchanged viewed-set doesn't churn the context value. Both maps are scoped to
the current `key`; on a key change (new PR / head advance) they read as empty, preserving the
existing head-scoped reset.

Handlers (all gen-guarded by the existing per-path `genRef`, so a late/out-of-order POST never
clobbers a newer toggle). **Each handler also carries the existing `.catch`'s key-guard: it
writes/deletes under the *toggle-time* `key` captured in the closure, and no-ops when
`prev.key !== key`.** This is load-bearing for the success handler (the one that didn't exist
before): an in-flight POST that ACKs *after* a head advance must stamp `confirmed` under the
old head, where the key-scoped read ignores it — never under the live head.

- **toggle:** bump gen; write `pending[path] = desired` (toggle-time key); POST.
- **POST success** (gen current): delete `pending[path]`; set `confirmed[path] = desired`
  (both under the toggle-time key). No flash — `confirmed` keeps the file showing `desired`
  while `serverViewed` is stale.
- **POST failure** (gen current): delete `pending[path]`. Falls back to `confirmed[path]`
  (the prior acked value) or `serverViewed`. Fixes Bug B.
- **Eviction:** drop every `confirmed[path]` whose value the server now **agrees** with
  (`serverViewed.has(path) === confirmed[path]`). This is **temporal**, so it must be a
  committed state mutation in a `useEffect` keyed on `[serverViewed, key]` — *not* folded into
  the `viewedPaths` memo (a render-time "minus currently-agreeing" derivation would re-shadow
  the path the instant the server diverges again, failing Bug A). Use a functional
  `setConfirmed(prev => …)` that returns `prev` when nothing is evicted (avoids an extra render
  on every non-evicting refetch, and dodges a stale-closure read since `confirmed` is not an
  effect dep). Once the server has caught up, the bridge is redundant; removing it means any
  *later* divergence (the file un-viewed elsewhere) is honored by `serverViewed`. Fixes Bug A,
  flash-free. The rule is value-agnostic — a `confirmed:false` un-view is evicted identically
  once the server drops the path.

### Why eviction-on-agree resolves the core ambiguity

`confirmed[path]` and `serverViewed` differ in exactly two situations that are structurally
identical (value alone can't tell them apart): (a) the **bridge window** before the first
refetch reflects our write, and (b) the server **changed away** after we acked. Eviction is
*temporal*: the first refetch that agrees with our confirm clears it; from then on the server
wins. This is correct whenever a refetch reflecting our write arrives before any external
change reverts it — the common path.

### Acknowledged residual races (degrade gracefully)

Two narrow windows remain; both are the low-stakes, self-healing viewed-state the issue calls
out as "not data loss", and neither loses any real review work:

1. **External change between our ACK and the next agreeing refetch.** If a path is changed
   externally (un-viewed in another window/device) after our successful POST but before a
   refetch reflects *our* write, the refetch never "agrees" with `confirmed` (it already shows
   the external value), so `confirmed` lingers and shadows the external change. The lifetime is
   **not** brief: because no refetch will ever agree, it persists until the next head advance,
   PR switch, or a user re-toggle of that path — potentially the rest of the session on a
   static head. The race is **symmetric** across toggle directions (a `confirmed:true` mark
   shadowing an external un-view, and a `confirmed:false` un-view shadowing an external mark,
   behave identically). This is **better on Bug A than today** (today's overlay *never* clears),
   but it is a real residual, not a strict improvement on every axis — see (2).
2. **Out-of-order / regressing refetch.** Today's permanent overlay also shields against a
   *stale* `serverViewed` snapshot: if a draft-session GET resolves out of order and delivers an
   older snapshot after a newer one, the permanent overlay keeps showing the marked value.
   Eviction removes that shield, so a regressing snapshot landing *after* eviction can briefly
   flash the path back. This is gated on out-of-order GET delivery: `useDraftSession.refetch()`
   guards only against a **PR change** mid-flight (`activePrKeyRef`), **not** against two
   concurrent **same-PR** refetches resolving last-write-loses
   (`useDraftSession.ts:132-147`). So the assumption this fix leans on is **per-head monotonic
   snapshot delivery**, which holds in the common single-refetch path but is not guaranteed
   under concurrent refetches. Closing it would require last-write-wins sequencing in
   `useDraftSession` (out of scope for #600 — a `draftSession` concern, not this hook's).

Approach 2 (below) *would* close residual (1) — a refetch on success pulls authoritative server
state including the external change. We accept residual (1) to avoid that approach's cost; the
choice is justified on blast radius, not on the residual being unfixable.

## Acceptance criteria

- Successful POST reconciles its override (gen-guarded) — Bug A test + the head-advance-race test.
- Failed POST restores the prior acked value, not a stale snapshot — Bug B test.
- Tests cover mark-ok-then-unmark-fail, refetch-after-success-with-changed-server, the
  symmetric un-view eviction, and the head-advance-during-in-flight-success leak.
- All existing `useFileViewState` behaviors preserved (overlay race, late-failure gen-guard,
  head-advance reset, pre-head no-op).

## Out of scope

- **Refetching `draftSession` on POST success (Approach 2).** It closes residual race (1)
  above by asking the server for authoritative state, so it is *more* correct on that axis.
  Rejected for **blast radius / re-render cost**: a `draftSession.refetch()` re-renders the
  whole PR-detail subtree and adds a GET per toggle (toggles are user-paced, so the cost is
  bounded, but it is real). It introduces no *new* race class — the hook already layers over a
  refetched `serverViewed` — so "new races" is **not** a valid objection; blast radius is.
- Last-write-wins sequencing in `useDraftSession` to close residual race (2).
- Server-side per-path versioning.
