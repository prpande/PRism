# PR detail: read-only "Checks" tab (#138)

**Status:** spec (T3, gated B1 — `needs-design` + user-visible rendered output)
**Issue:** [#138](https://github.com/prpande/PRism/issues/138)

## Problem

The PR detail page exposes only an **aggregate** CI signal — `CiStatus
{none | pending | failing}` rendered as a single header chip
(`PrHeader.tsx:494`) and an inbox-row octicon (`InboxRow.tsx`). There is no way
to see the **individual** checks behind that aggregate: which check is failing,
which is still running, how long each took, or a link to its run on GitHub. A
reviewer who sees a red "failing" chip has to leave PRism and open the PR on
github.com to learn *what* failed.

This spec adds a **read-only "Checks" tab** to the PR detail page that lists the
individual checks for the PR's head commit, shows their live progress, and links
out to each run on GitHub.

## Scope decision (owner-selected)

Read-only monitoring **only** in this slice. The issue's acceptance criteria list
re-trigger as "(if feasible)"; it is a new **write/mutation surface** (a `POST`
to GitHub Actions, a new endpoint, a new `GitHubCheckRunner`) with real
feasibility caveats (only Actions runs are re-runnable; third-party check-runs
can only be *re-requested* of the originating app; fork / no-write-access PRs
can't be re-run at all; partial-success UX). It is **deferred to a follow-up
issue** (see § Deferred follow-up) so the monitoring value ships clean and the
mutation surface gets its own design + B2 risk gate.

## Non-goals

- **No re-trigger / re-run** in this slice (deferred).
- **No log streaming, inline check output, or annotations.** Those live on
  GitHub; the per-check `detailsUrl` is the escape hatch.
- **No change** to the aggregate header chip, the inbox CI octicon, or the
  existing `GitHubCiFailingDetector` aggregate path. The new tab is **additive**;
  it reads the same two GitHub sources but produces a *detailed* list, not the
  4-state rollup. (We deliberately do **not** refactor the detector to feed the
  tab — see Rejected alternatives R1.)

## Acceptance criteria

- [ ] A "Checks" tab appears on the PR detail page alongside Overview / Files /
  Drafts, always visible (not capability-gated).
- [ ] The tab lists individual checks for the head commit with name, current
  state, duration (when available), and a link to the run on GitHub.
- [ ] Check progress is observable without a manual reload (live polling while
  the tab is open and any check is non-terminal).
- [ ] The tab strip surfaces at-a-glance health: a pulsing amber dot while checks
  run, a red warn-count badge for failing checks, a green tick when all pass.
- [ ] Empty / loading / error states are handled, including a specific message
  for the fine-grained-PAT-can't-read-checks 403.
- [ ] Re-trigger is filed as a separate issue with the required scope documented.

## Architecture overview

```
GitHub REST                 PRism.GitHub                PRism.Web            frontend
-----------                 ------------                ---------            --------
/commits/{sha}/check-runs ─┐
                           ├─ IPrChecksReader ───────── GET /api/pr/{o}/{r}/  ─ useCheckRuns(prRef)
/commits/{sha}/status     ─┘  GitHubPrChecksReader      {n}/checks            ─ prDetailContext
                              → IReadOnlyList<CheckDto>  → ChecksResponseDto   ─ ChecksTab
```

The slice is a vertical extension that mirrors the **Hotspots tab** precedent
end-to-end: a backend reader → a new endpoint → a `PrDetailView`-owned hook →
`prDetailContext` → a tab component. No existing tab data path is disturbed.

## Backend

### Contract — `CheckDto` (unified per-check shape)

New record in `PRism.Core.Contracts`. One shape populated from **either** GitHub
source so the tab covers exactly the inputs the aggregate chip reads (otherwise
the tab could contradict the header — a chip that says "failing" because of a
legacy commit status would show an empty/green tab).

```csharp
public sealed record CheckDto(
    string Name,            // check-run "name" / status "context"
    CheckRunStatus Status,  // queued | in-progress | completed
    CheckConclusion? Conclusion, // success | failure | cancelled | timed-out
                                 // | skipped | neutral | action-required | null
    string Source,          // "check-run" | "status" (UI honesty: no duration for status)
    DateTimeOffset? StartedAt,   // check-runs only; null for legacy status
    DateTimeOffset? CompletedAt, // check-runs only
    string? DetailsUrl);    // html_url / target_url — opens the run on github.com

public sealed record ChecksResponseDto(
    IReadOnlyList<CheckDto> Checks,
    string HeadSha,         // the SHA these checks were read for (staleness guard, see § Polling)
    bool Degraded);         // a source returned a non-2xx (e.g. fine-grained 403) → partial read
```

`CheckRunStatus` and `CheckConclusion` are new enums and round-trip **kebab-case
lowercase** via the existing `JsonStringEnumConverter` (architectural invariant —
"Wire-format conventions"). New enums inherit the policy automatically.

**Source mapping** (mirrors `GitHubCiFailingDetector` classification so the tab
and the chip never disagree):

| GitHub field | → `CheckDto` |
|---|---|
| check-run `status` ∈ {queued, in_progress} | `Status = queued` / `in-progress` |
| check-run `status = completed`, `conclusion` | `Status = completed`, `Conclusion` mapped 1:1 (`timed_out`→`timed-out`, `action_required`→`action-required`) |
| legacy status `state = pending` | `Status = in-progress`, `Conclusion = null` |
| legacy status `state ∈ {failure, error}` | `Status = completed`, `Conclusion = failure` |
| legacy status `state = success` | `Status = completed`, `Conclusion = success` |

> Note the **conclusion-level** detail is richer than the detector's 4-state
> rollup: the detector collapses `skipped`/`neutral`/`action_required` to "None"
> (#264, #305). The tab keeps them distinct so the list is truthful per-check.
> The *aggregate* mapping is unchanged.

### Reader — `IPrChecksReader` / `GitHubPrChecksReader`

New seam in `PRism.Core` (interface) + `PRism.GitHub` (impl), registered in
`PRism.GitHub/ServiceCollectionExtensions.cs`.

```csharp
public interface IPrChecksReader
{
    Task<ChecksResponseDto> ReadAsync(PrReference pr, string headSha, CancellationToken ct);
}
```

Implementation reuses the established HTTP plumbing:

- **Check-runs:** `GET repos/{o}/{r}/commits/{sha}/check-runs?per_page=100`,
  following `rel="next"` via `GitHubLinkHeader`, capped at `MaxCheckRunPages = 10`
  (identical pagination + cap to `GitHubCiFailingDetector.FetchChecksAsync` —
  factor the page-walk helper if it reads cleanly, otherwise duplicate the small
  loop rather than entangle the aggregate path).
- **Legacy statuses:** `GET repos/{o}/{r}/commits/{sha}/status`, reading the
  inline `statuses[]` array (each → one `CheckDto` with `Source = "status"`).
- Both via `GitHubHttp.SendAsync` on the `"github"` client (same-host credential
  guard, rate-limit throwing, API-version header — all inherited).

**Degraded handling** mirrors the detector's #213 stance: a non-2xx from either
source (fine-grained 403, transient 5xx) does **not** throw — it returns the
checks read so far with `Degraded = true`. The endpoint surfaces that flag so the
UI can show a partial-read banner rather than a hard error (CI detail is
non-critical enrichment; it must never hard-fail the page). A 429 still throws so
backoff is preserved (`GitHubHttp.ThrowIfRateLimited`).

> **Why a separate reader, not the detector?** The detector's contract is the
> aggregate 4-state rollup with a deliberately lossy classification, an
> SHA-keyed terminal cache, and a "never cache Pending/degraded" protocol tuned
> for the inbox sweep. The tab needs the *opposite*: every check verbatim, no
> lossy collapse, fetched on demand per-PR. Overloading the detector to emit both
> would couple two contracts with conflicting caching semantics. (See R1.)

### Endpoint — `GET /api/pr/{owner}/{repo}/{number}/checks`

Add to `PRism.Web/Endpoints/PrDetailEndpoints.cs`, next to the existing PR-detail
routes. It resolves the PR's **current head SHA** (from the PR-detail snapshot /
loader, the same source the page already uses) and calls
`IPrChecksReader.ReadAsync(pr, headSha, ct)`, returning `ChecksResponseDto`.

No new auth surface, no new token scope: it reads check-runs with the **existing**
classic-`repo` PAT exactly as the inbox detector already does (per project memory
`reference_github_finegrained_pat_limits` — classic `repo` already reads the
Checks API; this slice adds **no** scope requirement). Re-trigger *would* need a
write scope — that is part of the deferred follow-up.

A `FakePrChecksReader` test hook lands in `PRism.Web/TestHooks/` (mirroring
`FakePrReader`) so e2e / hermetic tests get deterministic check lists.

## Frontend

### Hook — `useCheckRuns(prRef)` (lazy + active-only polling)

New hook owned by `PrDetailView` (the `useFileFocusResult` precedent), exposing:

```ts
interface CheckRunsResult {
  status: 'idle' | 'loading' | 'ok' | 'empty' | 'error' | 'degraded';
  checks: CheckRun[];
  retry: () => void;
}
```

Polling model (the § Architecture "A" decision):

- **Lazy:** no fetch until the Checks tab first becomes active (`status` starts
  `'idle'`; the hook keys off an `active` flag threaded from `PrDetailView`, the
  same kept-alive `effectiveSubTab === 'checks'` signal the panel uses).
- **Active-only self-poll:** while the tab is **visible** *and* ≥1 check is
  non-terminal, re-fetch every **~10s**. Polling **stops** when every check is
  terminal, or the tab is hidden, or the component unmounts. Zero cost when no
  one is on the tab — the lightweight 30s active poll is untouched.
- **Head-SHA coherence:** the active PR poller can advance `headSha` mid-session
  (a new push). `useCheckRuns` re-fetches on `headSha` change so the list always
  reflects the current head; `ChecksResponseDto.HeadSha` lets the UI drop a
  late-arriving response for a stale SHA (mirrors the headSha-keyed snapshot
  discipline in `reference_prdetail_snapshot_cache_comment_invalidation`).

Result is published via `prDetailContext` (parallel to `fileFocus`), consumed by
the tab + the tab-strip indicator derivation.

### Tab strip indicator (the approved affordance)

`PrTabId` gains `'checks'` (`PrSubTabStrip.tsx`). The Checks tab is **always
rendered** (unlike the AI-gated Hotspots tab). Two orthogonal signals, drawn from
the inbox CI vocabulary (`InboxRow.tsx` octicon set):

- **Leading glyph** (before the label, the slot Hotspots uses for `AiMarker`):
  - **in-progress** (≥1 non-terminal) → **pulsing amber dot** (inbox `pending`
    color + a gentle pulse to read as "live"). Wins the lead slot even if some
    checks have already failed.
  - **all-green** (all terminal, ≥1 success, 0 failing, 0 in-progress) → **green
    tick** (inbox `passing` check octicon).
  - otherwise → no leading glyph.
- **Trailing badge** — **failing count**, red warn-styled, shown only when
  failing > 0 (same treatment as the Drafts warn badge). Carries the "failing"
  signal; no separate red lead glyph (avoids redundancy).

Combined states: *running with 1 failure so far* → **amber pulse + red "1"**.
*Finished, 2 failed* → **red "2"**, no lead glyph. *Finished, all good* → **green
tick**. *No checks* → nothing (empty state in the panel).

A single `checksGlyphState(checks)` derivation in one place is the source of truth
for both the lead glyph and the badge count, so they cannot drift.

### Tab panel — `ChecksTab`

New `frontend/src/components/PrDetail/ChecksTab/ChecksTab.tsx`, consuming
`usePrDetailContext()`. Mirrors `HotspotsTab` structure.

- **List:** flat (not grouped by workflow — YAGNI; `detailsUrl` reaches the
  workflow on GitHub). Sorted **problems-first**: failing → in-progress →
  neutral/skipped/cancelled → passing last; stable by name within a tier.
- **Row:** status octicon (reused inbox glyph set) + check name + duration
  (`CompletedAt − StartedAt`, omitted when `Source = "status"` or timing absent)
  + **"Details ↗"** link to `detailsUrl` (opens on github.com;
  `target="_blank"` + the repo's `rel`/will-navigate guard per the macOS
  link-nav fix #583/#586/#588).
- **States:**
  - `loading` → skeleton rows.
  - `empty` → "No checks for this commit."
  - `error` → message + Retry button. The fine-grained-PAT 403 / `degraded` case
    gets a **specific** message ("PRism can't read checks with the current token
    — a classic `repo` token is required") rather than a generic failure, since
    that is a known, fixable PRism condition.
  - `degraded` (partial read) → show the checks we have + a subtle
    "Some checks couldn't be loaded — retry" banner.

### Types

`frontend/src/api/types.ts` gains `CheckRun`, `CheckRunStatus`,
`CheckConclusion`, `ChecksResponse` matching the kebab-case wire enums. Per
`reference_nonoptional_wire_field_escapes_e2e_route_mocks`, any e2e route mock /
fixture returning the checks payload must be hand-checked for the full shape
(tsc does not type Playwright `route.fulfill` bodies).

## Error handling summary

| Condition | Backend | Frontend |
|---|---|---|
| No checks / no statuses | `Checks = []`, `Degraded = false` | `empty` state |
| Fine-grained 403 / transient 5xx (one source) | partial list, `Degraded = true` | `degraded` banner + specific 403 copy |
| Both sources fail | `Checks = []`, `Degraded = true` | `error` state + Retry |
| 429 rate-limit | throws (backoff preserved) | `error` state + Retry |
| Head SHA advanced mid-poll | response carries new `HeadSha` | stale-SHA responses dropped |

## Testing strategy

Non-bug enhancement → proof is **test-first** new tests (red→green within PR
history) + the acceptance checklist (no red-on-main needed).

- **Backend (`PRism.GitHub.Tests`):** `GitHubPrChecksReader` mapping —
  check-run status/conclusion → `CheckDto`; legacy status `state` mapping;
  pagination across `rel="next"`; page cap; degraded (non-2xx) returns partial +
  flag, does not throw; 429 throws.
- **Backend (`PRism.Web` integration):** `GET …/checks` returns the DTO via the
  `FakePrChecksReader` hook; head-SHA resolution.
- **Frontend (vitest):** `checksGlyphState` derivation (all state combinations);
  `ChecksTab` rendering of each state (loading/empty/error/degraded/list);
  problems-first ordering; duration formatting + omission for `status` source;
  `useCheckRuns` lazy-start, active-only poll start/stop on terminal + on
  tab-hide, headSha re-fetch (fake timers).
- **e2e (Playwright, prod project):** open a PR → Checks tab → assert the list +
  the tab-strip glyph, using a `FakePrChecksReader` fixture with mixed states.
  Grep existing visual/parity specs for the tab strip before adding (per
  `feedback_grep_visual_specs_when_deleting_page` discipline — additive here, but
  the parity baseline tolerance should absorb a new always-present tab; verify
  against the green e2e rather than pre-emptively regenerating baselines, per
  `reference_parity_baseline_2pct_tolerance_absorbs_small_changes`).

## Rejected alternatives

- **R1 — Extend `GitHubCiFailingDetector` to emit per-check detail.** Rejected:
  the detector's contract (lossy 4-state rollup, SHA-keyed terminal cache,
  never-cache-Pending/degraded protocol for the inbox sweep) conflicts with the
  tab's needs (verbatim per-check, on-demand, no lossy collapse). Coupling them
  entangles two caching semantics. A separate reader keeps each contract clean;
  they share only the small pagination helper if it factors cleanly.
- **R2 — Fold checks into `PrDetailDto` (one-shot).** Rejected: only refreshes on
  explicit reload, failing the "monitor progress" AC.
- **R3 — Ride the 30s active poll.** Rejected: adds a per-check fetch to every
  active-PR tick for every open PR even when no one is on the tab; the active
  poll was deliberately kept lightweight.
- **R4 — Check-runs only (drop legacy commit statuses).** Rejected: a PR whose
  aggregate chip is "failing" *because of a legacy status* would show an empty or
  all-green Checks tab — the tab must explain the chip, so it reads both sources.
- **R5 — Group the list by workflow.** Rejected for v1 (YAGNI): adds a UI layer
  for little gain at typical check counts; `detailsUrl` already reaches the
  workflow. Revisit if real PRs show unwieldy flat lists.

## Deferred follow-up — re-trigger

File a P3 issue: **"PR detail Checks tab: re-trigger failed checks."** Scope:

- New `GitHubCheckRunner` (REST `POST repos/{o}/{r}/actions/runs/{run_id}/rerun`,
  mirroring the `GitHubReviewSubmitter` write pattern) + a `POST
  …/checks/rerun` endpoint.
- **Required scope documented:** re-running an Actions run needs **write** access
  (classic `repo`, which PRism already requests, grants Actions write; a
  fine-grained token would need `actions: write`). Surface the rerun affordance
  only where it's actionable.
- Feasibility caveats to design around: only **Actions** runs are re-runnable via
  this endpoint; non-Actions check-runs use `POST …/check-runs/{id}/rerequest`
  which only *re-asks* the originating app; fork / no-write-access PRs can't be
  re-run (hide or disable the affordance with an explanatory tooltip);
  partial-success + optimistic-state UX.
- This is a **B2 (risk-surface) write mutation** → retains the human approach
  gate, unlike this read-only slice (B1 only).

## Risk classification (this slice)

- **Tier:** T3 — slice-sized, new behavior, backend + frontend.
- **Risk:** **gated B1 (UI-visual)** — `needs-design` label + new rendered output
  (tab, indicators, list) a human must eyeball. **Not B2:** no new token scope,
  no token storage, no write/mutation, no auth-validation logic (the read uses
  the existing classic-PAT check-runs path). Re-trigger (the B2 surface) is
  deferred. Per the pre-PR re-check, if implementation drifts into any write call
  or scope change, re-classify to B2 and route to the approach gate.
- **Gate:** pause **after** green-and-ready for the human visual assert (B1), and
  honor the spec/plan human-review gates (gated issue → human gates retained).
