# #285 — Inbox "new changes" left bar: reset on view + first-run baseline

**Issue:** #285 (bug, area:inbox) — the inbox row's left "new changes" accent bar doesn't reset after viewing a PR, and flags every open PR on first inbox open.
**Status:** Design approved (owner). Gated (UI-visual) — human B1 sign-off retained.
**Branch:** `feature/285-inbox-unread-bar`

## Problem

The left-edge accent bar on an inbox PR row signals "new changes you haven't seen." It misbehaves two ways:

1. **Doesn't reset after viewing.** Open a PR, return to the inbox, and the row's bar stays lit as if still unread — no manual reload clears it within the session.
2. **First-open flood.** On the first inbox open, *every* open PR shows the bar, because a never-viewed PR has `lastViewedHeadSha == null`, which never equals `headSha`.

## Root cause

The unread signal is computed in `frontend/src/components/Inbox/InboxRow.tsx:73`:

```ts
const hasUnseenActivity = !isDone && pr.lastViewedHeadSha !== pr.headSha;
```

`lastViewedHeadSha` is projected backend-side from a per-PR session's view stamps (`InboxRefreshOrchestrator.MaterializePrInboxItem`, reading `state.Reviews.Sessions[ref].TabStamps`). The two symptoms have **distinct** causes:

- **Symptom 1 (stale viewed-state).** `GET /api/inbox` (`PRism.Web/Endpoints/InboxEndpoints.cs:48`) serves `orch.Current` — a **precomputed snapshot** frozen at the last orchestrator refresh. Viewing a PR fires `POST .../mark-viewed` (`usePrDetail` → `PrDetailEndpoints.cs:152`), which writes a fresh `TabStamp(headSha, now)` to `state.json` but does **not** recompute the snapshot. Returning to the inbox remounts `InboxPage` and refetches `GET /api/inbox`, but that returns the same frozen snapshot whose `lastViewedHeadSha` predates the write. The bar only clears on the next full orchestrator refresh (interval / SSE / the #311 manual refresh). The snapshot wrongly **freezes the cheap, local viewed-state together with the expensive, GitHub-sourced feed.**
- **Symptom 2 (first-run flood).** `lastViewedHeadSha == null` (never-viewed) → `null !== headSha` → unread, for every open PR. By design today; the noise is the cost.

## Design

Two independent fixes. Symptom 1 is backend (freshness); Symptom 2 is a frontend semantics change.

### Fix 1 — live viewed-state overlay on GET (Symptom 1)

Separate the two things the snapshot conflates: keep the GitHub-sourced feed cached, recompute the viewed-state overlay live per request.

- Extract the viewed-state projection currently inlined in `MaterializePrInboxItem` (the most-recent `TabStamp.HeadSha` by `StampedAtUtc`, plus the `LastSeenCommentId` projection in the same block) into **one** shared helper that takes a `PrReference` + `AppState` and returns `(lastViewedHeadSha, lastSeenCommentId)`. The session key MUST be derived via `PrReference.ToString()` (the canonical `owner/repo/number` slash form that both `MaterializePrInboxItem` and `mark-viewed`'s write use) — pass `item.Reference` so the key is automatic and cannot diverge.
- Add a pure function in `PRism.Core` — `ApplyViewedState(snapshot, appState) → snapshot'` — that iterates the snapshot's sections and, for each `PrInboxItem` (an immutable record), produces a new item via a `with`-expression whose `LastViewedHeadSha`/`LastSeenCommentId` come from that **same** shared helper.
- **Both** the refresh-time materialization and the GET overlay call the one shared helper — the projection is a single source of truth, so the two paths cannot drift (this is what makes the refresh/overlay redundancy genuinely safe rather than a latent trap).
- `GET /api/inbox` loads the current `AppState` (a cheap local `state.json` read) and applies the overlay to `orch.Current` before ordering/serializing sections. The handler stays **read-only** (no write, no GitHub refetch, no orchestrator mutation).
- Net effect: open a PR → `mark-viewed` writes the stamp → return to inbox → `GET` overlays the fresh stamp → bar clears immediately, no manual reload, no #311 refresh required.

The orchestrator's refresh-time projection still runs (the snapshot carries a baked viewed-state for cold-start), but because it now calls the same shared helper as the overlay, the GET overlay re-projecting on every read is safe redundancy, not a divergence risk. A unit test pins that the refresh-time projection and the GET overlay produce identical `LastViewedHeadSha`/`LastSeenCommentId` for the same `(snapshot, AppState)`.

The fix depends on `InboxPage` **unmounting** when the user views a PR and **remounting** on return (which re-runs `useInbox`'s mount-effect fetch). This holds because only `PrTabHost` is keep-alive — it renders `PrDetailView` per tab, **not** `InboxPage`; the `/` route (rendering `InboxPage`) does not match a `/pr/...` URL, so `InboxPage` unmounts while a PR is open. The e2e proof must exercise this real unmount/remount path (navigate to `/pr/...` then back to `/`), not an in-place reload, or it could pass for the wrong reason.

**Why overlay-on-GET over the alternatives:**
- *vs. recompute snapshot on `mark-viewed`* — couples PR-detail writes to the inbox orchestrator and risks thrash on every PR open; needs a "re-project-only" orchestrator path that doesn't exist.
- *vs. force a full inbox refresh on return* (the #311 mechanism) — re-hits GitHub on every PR close, wasteful, and slower than a local re-projection for a purely local state change.

### Fix 2 — never-viewed is not unread (Symptom 2, "A2")

Change the frontend interpretation of `null` so a never-viewed PR is not flagged:

```ts
const hasUnseenActivity =
  !isDone && pr.lastViewedHeadSha != null && pr.lastViewedHeadSha !== pr.headSha;
```

A PR you've never opened shows no bar; once you open it (stamp recorded) and its head later moves, it flags. The first-open flood disappears. New arrivals are surfaced by their section ("Review requested", etc.), iteration count, and updated-time — not the bar.

Update the explanatory comment at `InboxRow.tsx:67–72` to state the new rule (`null` ⇒ not unread; unread = a *viewed* PR whose head moved since the last view). Done PRs remain terminal/never-flagged (unchanged).

There is **no first-visit affordance** under A2: `null` is simply quiet — no bar, no aria suffix, no "New" chip (the chip was already removed; any `isFirstVisit`-style derivation referenced in older plan docs is dead and should not be reintroduced). The aria-label `· unread` suffix (`InboxRow.tsx:85–89`) rides the same flag, so it correctly disappears for never-viewed rows. No live-region announcement is required when the bar clears on return — the aria-label is the sole accessible signal, correct at render time and discovered when focus lands on the row; a live region is out of scope for this slice.

**Considered and rejected (recorded for the plan):** a persisted first-observation baseline ("A1") that would flag head-moves on PRs you haven't opened yet. Rejected as over-built — it requires a new persisted per-PR baseline field, an orchestrator write on the refresh path, and pruning when PRs leave the inbox. **Cost of A2, explicitly accepted:** the bar now fires only on the "PR I previously opened, its head then moved, and I haven't re-opened it" cohort. The dropped nudge is "new commits on a *review-requested* PR I have not yet opened" (a re-push while it sits in my queue) — that specific case is **not** covered by section placement (the PR was already in "Review requested"; only its head moved). The authored-by-me and already-triaged cases are well-served by A2. The owner accepted this tradeoff knowing the re-push-while-queued nudge is lost; A1 is the path back if that case later proves to matter.

## Data flow (after the fix)

```
View PR:   usePrDetail → POST mark-viewed → TabStamp(headSha, now) → state.json
Return:    InboxPage remounts → GET /api/inbox
GET:       orch.Current (frozen GitHub feed)
            + load state.json (live)
            → ApplyViewedState overlay (re-project LastViewedHeadSha per item)
            → serialize
Row:       hasUnseenActivity = !isDone && lastViewedHeadSha != null && lastViewedHeadSha !== headSha
```

## Testing

- **Backend unit (`ApplyViewedState`):** stale snapshot value + a newer `TabStamp` in state → overlay returns the new head; an item with no session → `LastViewedHeadSha` stays `null`; the shared projection helper is exercised directly.
- **Backend endpoint (Symptom 1 regression guard):** `GET /api/inbox` after a `mark-viewed` write reflects the new head without an orchestrator refresh.
- **Frontend (`InboxRow`):** never-viewed → **not** unread (A2); viewed-then-head-moved → unread; viewed-matches → not unread; done PR → never unread (unchanged). The existing test `it('IS unread for a never-opened PR (lastViewedHeadSha null)…')` at `frontend/__tests__/InboxRow.test.tsx:87` flips to assert `data-unread='false'` **and** that the aria-label does **not** contain `unread`. There are **two** InboxRow test files — `frontend/__tests__/InboxRow.test.tsx` and `frontend/src/components/Inbox/InboxRow.test.tsx`; both seed `lastViewedHeadSha: null` fixtures, so check both for the assumption and avoid leaving a stale duplicate (this double-file hazard bit #135/#143).
- **E2E (Playwright — the reproduction-as-proof the issue asks for):** drive inbox → open a PR → return → assert the row's `data-unread` flips to `false` with no manual reload; and a fresh inbox of never-viewed PRs shows no `data-unread="true"` rows. Write red-first against the current (buggy) code to confirm it reproduces, then green after the fix.

## Scope / non-goals

- `LastSeenCommentId` is overlaid for consistency, but comment-unread is still not surfaced in the inbox (unchanged behavior).
- Independent of **#311** (manual refresh) and **#279** (top-of-screen bars) at the code level — no shared functions. Note the behavioral coupling honestly: after this change the overlay is what keeps bar-reset consistent across *both* a plain return-to-inbox and #311's manual refresh (whose frontend path also re-GETs and re-runs the overlay). #311's refresh-time projection becomes dead *with respect to the bar* (overlaid away on every read); it is left in place (cold-start value) but is no longer the source of truth for viewed-state. A follow-up could remove it; not in this slice.
- No change to the orchestrator refresh cadence, sections, CI probe, or enrichments.

## Visual baseline impact

Under A2, never-viewed rows lose their bar. If the seeded e2e `inbox` fixture currently renders bars on never-viewed rows, the Linux `inbox` visual baseline will shift. Regenerate from the CI `e2e-results` artifact **after** confirming the rendered diff matches intent (bars gone on never-viewed rows; present only on viewed-then-moved rows). win32 baseline is local-only and out of scope for this PR.

## Acceptance criteria

- [ ] After viewing a PR and returning to the inbox, that row's left bar is cleared without a manual reload (Symptom 1).
- [ ] First-time inbox open does not flag every open PR as new (Symptom 2).
- [ ] The bar reflects genuine unseen activity: a *viewed* PR whose head moved since the last view, and nothing more.
- [ ] Covered by backend (overlay + endpoint), frontend (`InboxRow`), and e2e (reset-on-view + first-run) tests.

## Risks / accepted

- **`state.json` read per `GET /api/inbox`.** `AppStateStore.LoadAsync` is **uncached** — it opens a `FileStream`, parses JSON, and runs a migration probe on every call, and it is gate-serialized (`_gate`) with `mark-viewed`/refresh writes. So each inbox load now pays a full state read + parse and competes for that gate. Acceptable at single-user localhost scale; if it ever bites, a version-stamped in-memory cache in `AppStateStore` is the out-of-scope follow-up. (Corrected from an earlier draft that wrongly claimed the store "may already cache.")
- **Read overlay vs. concurrent `mark-viewed` write.** The GET reads a point-in-time `AppState` and re-projects; the overlay is snapshot-driven and idempotent-per-read, so a worst-case interleave reads a slightly stale stamp and self-corrects on the next GET with no accumulated state to corrupt. Set divergence is a non-issue: a PR in state but not in the snapshot is never visited; a PR in the snapshot but not in state stays `null` (no bar under A2). No correctness loss. Accepted.
- **Transient false-positive from a stale snapshot head.** The overlay refreshes viewed-state but **not** the snapshot's `HeadSha`. If the author pushes (head → new), the user opens the PR at the new head (stamp = new head), but the inbox snapshot still holds the *old* head until the next orchestrator refresh, the overlay yields `lastViewedHeadSha = newHead` while the row's `headSha = oldHead` → bar lights even though the user is caught up. This is the mirror of Symptom 1, bounded by the refresh interval and self-healing on the next refresh (or a #311 manual refresh), and no worse than today (where the bar stays lit regardless). The common reset-on-view case — viewing a PR whose head equals the snapshot head — clears correctly. Accepted as a bounded transient.
- **Lost nudge for unopened PRs (A2).** New commits on a PR you have not yet opened won't light the bar — specifically the "re-push while it sits in my Review-requested queue" case, which section placement does not cover. Accepted per owner decision (see Fix 2).
