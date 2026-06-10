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

- Add a pure function in `PRism.Core` — `ApplyViewedState(snapshot, appState) → snapshot'` — that, for each `PrInboxItem`, re-projects `LastViewedHeadSha` (and `LastSeenCommentId`, for consistency) from `appState.Reviews.Sessions[item.Reference].TabStamps` using the **same** projection logic `MaterializePrInboxItem` already applies (the most-recent `TabStamp.HeadSha` by `StampedAtUtc`). Extract that projection into a single shared helper so the refresh path and the overlay cannot drift.
- `GET /api/inbox` loads the current `AppState` (a cheap local `state.json` read) and applies the overlay to `orch.Current` before ordering/serializing sections. The handler stays **read-only** (no write, no GitHub refetch, no orchestrator mutation).
- Net effect: open a PR → `mark-viewed` writes the stamp → return to inbox → `GET` overlays the fresh stamp → bar clears immediately, no manual reload, no #311 refresh required.

The orchestrator's refresh-time projection is left untouched (minimal blast radius); the GET overlay supersedes it at read time. The resulting redundancy (head projected at refresh, re-projected at GET) is harmless and called out for the plan, not removed in this slice.

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

**Considered and rejected (recorded for the plan):** a persisted first-observation baseline ("A1") that would flag head-moves on PRs you haven't opened yet. Rejected as over-built — it requires a new persisted per-PR baseline field, an orchestrator write on the refresh path, and pruning when PRs leave the inbox, to add a nudge the section placement already provides.

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
- **Frontend (`InboxRow`):** never-viewed → **not** unread (A2, flips the existing `IS unread for a never-opened PR` test); viewed-then-head-moved → unread; viewed-matches → not unread; done PR → never unread (unchanged).
- **E2E (Playwright — the reproduction-as-proof the issue asks for):** drive inbox → open a PR → return → assert the row's `data-unread` flips to `false` with no manual reload; and a fresh inbox of never-viewed PRs shows no `data-unread="true"` rows. Write red-first against the current (buggy) code to confirm it reproduces, then green after the fix.

## Scope / non-goals

- `LastSeenCommentId` is overlaid for consistency, but comment-unread is still not surfaced in the inbox (unchanged behavior).
- Independent of **#311** (manual refresh) and **#279** (top-of-screen bars) — no shared code touched. The overlay makes #311's refresh unnecessary *for bar reset specifically*; #311 remains the path for re-fetching the GitHub feed.
- No change to the orchestrator refresh cadence, sections, CI probe, or enrichments.

## Visual baseline impact

Under A2, never-viewed rows lose their bar. If the seeded e2e `inbox` fixture currently renders bars on never-viewed rows, the Linux `inbox` visual baseline will shift. Regenerate from the CI `e2e-results` artifact **after** confirming the rendered diff matches intent (bars gone on never-viewed rows; present only on viewed-then-moved rows). win32 baseline is local-only and out of scope for this PR.

## Acceptance criteria

- [ ] After viewing a PR and returning to the inbox, that row's left bar is cleared without a manual reload (Symptom 1).
- [ ] First-time inbox open does not flag every open PR as new (Symptom 2).
- [ ] The bar reflects genuine unseen activity: a *viewed* PR whose head moved since the last view, and nothing more.
- [ ] Covered by backend (overlay + endpoint), frontend (`InboxRow`), and e2e (reset-on-view + first-run) tests.

## Risks / accepted

- **`state.json` read per `GET /api/inbox`.** A local file read + JSON deserialize per inbox load. Negligible for the single-user localhost model; the state store may already cache. Accepted.
- **Read overlay vs. concurrent `mark-viewed` write.** The GET reads a point-in-time `AppState`; a worst-case interleave reads a slightly stale stamp and self-corrects on the next GET. No correctness loss. Accepted.
- **Lost nudge for unopened PRs (A2).** New commits on a PR you have not yet opened won't light the bar. Surfaced via section/metadata instead. Accepted per owner decision.
