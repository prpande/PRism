# #285 — Inbox "new changes" left bar: reset on view

**Issue:** #285 (bug, area:inbox) — the inbox row's left "new changes" accent bar doesn't reset after viewing a PR.
**Status:** Design approved (owner). Gated (UI-visual) — human B1 sign-off retained.
**Branch:** `feature/285-inbox-unread-bar`

## Problem

The left-edge accent bar on an inbox PR row signals "new changes you haven't seen." The issue filed two symptoms; the owner has since reclassified the second:

1. **Doesn't reset after viewing (the bug).** Open a PR, return to the inbox, and the row's bar stays lit as if still unread — no manual reload clears it within the session.
2. **First-open marks every open PR unread — INTENDED, not a bug.** On a fresh start, every open-category PR (review-requested, awaiting-author, authored-by-me, mentioned) shows the bar; merged/closed rows never do. The owner has decided this is the **correct initialization baseline**: everything you have not yet gone through is unread until you open it. This reverses the issue's original AC ("first-time inbox open does not flag every open PR"). No code change is required for this — the current head-sha model already produces exactly this baseline.

So this slice fixes **only Symptom 1**. Symptom 2 is documented as intended behavior.

## Root cause (Symptom 1)

The unread signal is computed in `frontend/src/components/Inbox/InboxRow.tsx:73`:

```ts
const hasUnseenActivity = !isDone && pr.lastViewedHeadSha !== pr.headSha;
```

`lastViewedHeadSha` is projected backend-side from a per-PR session's view stamps (`InboxRefreshOrchestrator.MaterializePrInboxItem`, reading `state.Reviews.Sessions[ref].TabStamps`).

`GET /api/inbox` (`PRism.Web/Endpoints/InboxEndpoints.cs:48`) serves `orch.Current` — a **precomputed snapshot** frozen at the last orchestrator refresh. Viewing a PR fires `POST .../mark-viewed` (`usePrDetail` → `PrDetailEndpoints.cs:152`), which writes a fresh `TabStamp(headSha, now)` to `state.json` but does **not** recompute the snapshot. Returning to the inbox remounts `InboxPage` and refetches `GET /api/inbox`, but that returns the same frozen snapshot whose `lastViewedHeadSha` predates the write. The bar only clears on the next full orchestrator refresh (interval / SSE / the #311 manual refresh).

The snapshot wrongly **freezes the cheap, local viewed-state together with the expensive, GitHub-sourced feed.** That is the whole bug.

## Design — live viewed-state overlay on GET

Separate the two things the snapshot conflates: keep the GitHub-sourced feed cached, recompute the viewed-state overlay live per request. **Backend only; no frontend change.**

- Extract the viewed-state projection currently inlined in `MaterializePrInboxItem` (the most-recent `TabStamp.HeadSha` by `StampedAtUtc`, plus the `LastSeenCommentId` projection in the same block) into **one** shared helper that takes a `PrReference` + `AppState` and returns `(lastViewedHeadSha, lastSeenCommentId)`. The session key MUST be derived via `PrReference.ToString()` (the canonical `owner/repo/number` slash form that both `MaterializePrInboxItem` and `mark-viewed`'s write use) — pass `item.Reference` so the key is automatic and cannot diverge.
- Add a pure function in `PRism.Core` — `ApplyViewedState(snapshot, appState) → snapshot'` — that iterates the snapshot's sections and, for each `PrInboxItem` (an immutable record), produces a new item via a `with`-expression whose `LastViewedHeadSha`/`LastSeenCommentId` come from that **same** shared helper.
- **Both** the refresh-time materialization and the GET overlay call the one shared helper — the projection is a single source of truth, so the two paths cannot drift.
- `GET /api/inbox` loads the current `AppState` (a local `state.json` read) and applies the overlay to `orch.Current` before ordering/serializing sections. The handler stays **read-only** (no write, no GitHub refetch, no orchestrator mutation).
- Net effect: open a PR → `mark-viewed` writes the stamp → return to inbox → `GET` overlays the fresh stamp → bar clears immediately, no manual reload, no #311 refresh required.

The orchestrator's refresh-time projection still runs (the snapshot carries a baked viewed-state for cold-start), but because it calls the same shared helper, the GET overlay re-projecting on every read is safe redundancy, not a divergence risk. A unit test pins that the refresh-time projection and the GET overlay produce identical `LastViewedHeadSha`/`LastSeenCommentId` for the same `(snapshot, AppState)`.

The fix depends on `InboxPage` **unmounting** when the user views a PR and **remounting** on return (which re-runs `useInbox`'s mount-effect fetch). This holds because only `PrTabHost` is keep-alive — it renders `PrDetailView` per tab, **not** `InboxPage`; the `/` route (rendering `InboxPage`) does not match a `/pr/...` URL, so `InboxPage` unmounts while a PR is open. The e2e proof must exercise this real unmount/remount path (navigate to `/pr/...` then back to `/`), not an in-place reload, or it could pass for the wrong reason.

**Why overlay-on-GET over the alternatives:**
- *vs. recompute snapshot on `mark-viewed`* — couples PR-detail writes to the inbox orchestrator and risks thrash on every PR open; needs a "re-project-only" orchestrator path that doesn't exist.
- *vs. force a full inbox refresh on return* (the #311 mechanism) — re-hits GitHub on every PR close, wasteful, and slower than a local re-projection for a purely local state change.

## What is NOT changing (Symptom 2 — intended initialization)

The frontend logic at `InboxRow.tsx:73` is **unchanged**. A never-viewed PR (`lastViewedHeadSha == null`) stays `null !== headSha` → unread; merged/closed (`isDone`) stay never-flagged. That is exactly the owner's intended baseline: **all open-category PRs are unread on initialization, and the bar clears per-PR as the user opens each one** (which now works, via the overlay above). No baseline persistence, no GitHub read-state, no semantics change — those were explored and rejected in favor of "init-all-unread is correct."

"Opened / gone through" means **opening the PR detail view** (which fires `mark-viewed`); merely seeing the row in the inbox does not mark it read.

## Data flow (after the fix)

```
View PR:   usePrDetail → POST mark-viewed → TabStamp(headSha, now) → state.json
Return:    InboxPage unmounts→remounts → GET /api/inbox
GET:       orch.Current (frozen GitHub feed)
            + load state.json (live)
            → ApplyViewedState overlay (re-project LastViewedHeadSha per item)
            → serialize
Row:       hasUnseenActivity = !isDone && lastViewedHeadSha !== headSha   (UNCHANGED)
```

## Testing

- **Backend unit (`ApplyViewedState`):** stale snapshot value + a newer `TabStamp` in state → overlay returns the new head; an item with no session → `LastViewedHeadSha` stays `null` (still unread — the intended init state); the shared projection helper is exercised directly.
- **Backend unit (projection parity):** the refresh-time projection and the GET overlay return identical `(lastViewedHeadSha, lastSeenCommentId)` for the same `(snapshot, AppState)`.
- **Backend endpoint (Symptom 1 regression guard):** `GET /api/inbox` after a `mark-viewed` write reflects the new head without an orchestrator refresh — the bar would clear.
- **Frontend (`InboxRow`):** the existing tests stay **as-is and green** — never-viewed → unread (intended init), viewed-then-head-moved → unread, viewed-matches → not unread, done → never unread. No assertions flip. (Note: there are two InboxRow test files — `frontend/__tests__/InboxRow.test.tsx` and `frontend/src/components/Inbox/InboxRow.test.tsx`; neither needs changing, but confirm both still pass.)
- **E2E (Playwright — the reproduction-as-proof the issue asks for):** drive inbox → confirm an open-category row shows `data-unread="true"` → open the PR (navigate to `/pr/...`) → return to `/` → assert that row's `data-unread` flips to `false` with **no** manual reload. Write red-first against the current (buggy) code to confirm it reproduces, then green after the overlay lands.

## Scope / non-goals

- **No frontend change.** Symptom 2 (init-all-unread) is intended and already implemented by the current head-sha model.
- `LastSeenCommentId` is overlaid for consistency, but comment-unread is still not surfaced in the inbox (unchanged behavior).
- Independent of **#311** (manual refresh) and **#279** (top-of-screen bars) at the code level — no shared functions. Behavioral note: after this change the overlay keeps bar-reset consistent across both a plain return-to-inbox and #311's manual refresh (whose frontend path also re-GETs and re-runs the overlay). #311's refresh-time projection becomes dead *with respect to the bar* (overlaid away on every read); left in place as the cold-start value, removable in a follow-up.
- No change to the orchestrator refresh cadence, sections, CI probe, or enrichments.

## Visual baseline impact

**None expected.** The initialization render is unchanged (all open-category rows unread, exactly as today), so the static `inbox` visual baselines do not shift. The fix is a *behavioral* reset (bar clears after a view), asserted via the e2e flow above, not via a static screenshot. If CI surprises us with a baseline diff, treat it as a signal that init behavior changed unintentionally and investigate rather than blindly regenerate.

## Acceptance criteria

- [ ] After viewing a PR and returning to the inbox, that row's left bar is cleared without a manual reload (Symptom 1 — the bug).
- [ ] Initialization marks every open-category PR (review-requested, awaiting-author, authored-by-me, mentioned) unread; merged/closed are never flagged (intended baseline — reverses the issue's original AC#2, recorded on the PR).
- [ ] After init, the bar tracks per-PR: clears when the user opens the PR, and re-flags if the head moves after a view.
- [ ] Covered by backend (overlay + parity + endpoint) and e2e (reset-on-view) tests; existing frontend `InboxRow` tests remain green unchanged.

## Risks / accepted

- **`state.json` read per `GET /api/inbox`.** `AppStateStore.LoadAsync` is **uncached** — it opens a `FileStream`, parses JSON, and runs a migration probe on every call, and it is gate-serialized (`_gate`) with `mark-viewed`/refresh writes. So each inbox load now pays a full state read + parse and competes for that gate. Acceptable at single-user localhost scale; if it ever bites, a version-stamped in-memory cache in `AppStateStore` is the out-of-scope follow-up.
- **Read overlay vs. concurrent `mark-viewed` write.** The GET reads a point-in-time `AppState` and re-projects; the overlay is snapshot-driven and idempotent-per-read, so a worst-case interleave reads a slightly stale stamp and self-corrects on the next GET with no accumulated state to corrupt. Set divergence is a non-issue: a PR in state but not in the snapshot is never visited; a PR in the snapshot but not in state stays `null` (unread — the intended init state). No correctness loss. Accepted.
- **Transient false-positive from a stale snapshot head.** The overlay refreshes viewed-state but **not** the snapshot's `HeadSha`. If the author pushes (head → new) and the user opens the PR at the new head (stamp = new head) before the next orchestrator refresh, the overlay yields `lastViewedHeadSha = newHead` while the row's `headSha = oldHead` → bar lights even though the user is caught up. Bounded by the refresh interval, self-healing on the next refresh (or a #311 manual refresh), and no worse than today. The common reset-on-view case — viewing a PR whose head equals the snapshot head — clears correctly. Accepted as a bounded transient.
