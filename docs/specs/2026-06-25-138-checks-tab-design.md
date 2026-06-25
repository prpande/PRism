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
individual checks for the PR's loaded head commit, shows their live progress, and
links out to each run on GitHub.

## Scope decision (owner-selected)

Read-only monitoring **only** in this slice. The issue's acceptance criteria list
re-trigger as "(if feasible)"; it is a new **write/mutation surface** with real
feasibility caveats (only Actions runs are re-runnable; third-party check-runs can
only be *re-requested* of the originating app; fork / no-write-access PRs can't be
re-run; partial-success UX). It is **deferred to a follow-up issue** (see §
Deferred follow-up) so the monitoring value ships clean and the mutation surface
gets its own design + B2 risk gate.

## Non-goals

- **No re-trigger / re-run** in this slice (deferred).
- **No log streaming, inline check output, or annotations.** Those live on
  GitHub; the per-check `detailsUrl` is the escape hatch.
- **No change to the aggregate header chip or inbox CI octicon.** The new tab is
  **additive at the surface level.** One internal refactor *is* in scope and
  called out honestly: the per-check **classification** logic
  (`raw check-run / status JSON → normalized {status, conclusion}`) is **extracted
  into a shared, pure helper** consumed by both `GitHubCiFailingDetector` (which
  continues to fold it into the 4-state rollup) and the new reader (which keeps it
  verbatim). This is a **behavior-preserving** extraction guarded by the existing
  detector tests — see § Backend / R1. The detector's **caching and aggregation**
  semantics are untouched. Sharing classification (not duplicating it) is a
  correctness requirement, not gold-plating: the rules encode ~5 issues of
  hard-won edge cases (#213, #264, #286, #305) that would silently drift if
  copy-pasted.

## Acceptance criteria

- [ ] A "Checks" tab appears on the PR detail page alongside Overview / Files /
  Drafts, always visible (not capability-gated).
- [ ] The tab lists individual checks for the **loaded head commit** with name,
  current state, duration (when available), and a link to the run on GitHub.
- [ ] Check progress is observable without a manual reload (live polling of the
  loaded head's checks while the tab is open and any check is non-terminal).
- [ ] The tab strip surfaces at-a-glance health: a pulsing amber dot while checks
  run, a red warn-count badge for failing checks, a green tick when all pass.
- [ ] Empty / loading / error / partial-read states are handled, including a
  scope/cause-accurate message for the can't-read-checks 403.
- [ ] Re-trigger is filed as a separate issue with the required scope documented.

## Head-SHA model (read this before the rest — it shapes everything)

> This is the load-bearing decision. An earlier draft assumed the tab could track
> the *live* head and "always reflect the current head." It can't, cheaply:
> `useActivePrUpdates` exposes only `headShaChanged: boolean` (not the new SHA),
> and `data.pr.headSha` advances only when the user clicks **Reload** (the
> auto-reload effect fires only on merge/close, `PrDetailView.tsx`). Designing
> around a live-head assumption would poll the *old* head's checks forever after a
> push, and any "drop stale-SHA response" guard is inert because the request and
> response carry the same stale SHA.

**Decision: the Checks tab is scoped to the _loaded head_** (`data.pr.headSha`
from `usePrDetail`), and the client **passes that SHA explicitly** to the
endpoint (mirroring `/diff?range=` and `/file?sha=`, which already take the SHA as
a client parameter rather than resolving it server-side):

- The endpoint reads checks **for the client-supplied SHA** — deterministic, no
  server/client head disagreement.
- Live polling shows the *loaded head's* checks progressing to terminal — which is
  exactly "monitor progress" for the commit the user is looking at.
- When a new push arrives, the **existing head-drift banner** already lights
  (`PrHeader headShaDrift={updates.headShaChanged}`) prompting Reload. On Reload,
  `data.pr.headSha` advances and `useCheckRuns` re-fetches for the new head.
- The `ChecksResponseDto.HeadSha` echo is then a **true** coherence guard: it
  dedups out-of-order responses **within** a SHA series (a slow tick landing after
  a fast one) via an `AbortController` keyed on the in-flight request plus a
  response-SHA equality check; it is no longer asked to detect a head change it
  cannot see.

This keeps the "Banner, not mutation" invariant intact (polled head drift remains
a banner + explicit reload, never an auto-swap of what's under the cursor).

**Verdict-staleness after a push (product R2, reconciled with adversarial R2).**
The Checks tab asserts a *health verdict* (green tick / "all passing"), so after a
push the tab can show a confident verdict for a superseded head until Reload.
Adversarial R2 verified this is **not a new divergence**: the existing header chip
already reads the *loaded* head's `ciSummary` with the same drift-banner-only
signal (`PrDetailView.tsx`), and changing the chip is a non-goal. Neutralizing
*only* the tab glyph would make the tab and chip disagree — the very inconsistency
to avoid. **Decision for v1:** rely on the shared head-drift banner (consistent
with the chip), plus the new-SHA glyph reset (§ Tab strip indicator) so a stale
verdict doesn't survive the Reload itself. An in-tab staleness treatment
(dim/neutralize the glyph + an in-panel "for an earlier commit" line, applied to
*both* chip and tab for consistency) is a noted fast-follow if the verdict
prominence proves misleading in practice.

## Architecture overview

```
GitHub REST                  PRism.GitHub                 PRism.Web              frontend
-----------                  ------------                 ---------              --------
/commits/{sha}/check-runs ─┐  GitHubCheckClassifier ←──── (shared, pure)
                           ├─ IPrChecksReader ─────────── GET …/{n}/checks?sha= ─ useCheckRuns(prRef, headSha, active)
/commits/{sha}/status     ─┘  GitHubPrChecksReader        → ChecksResponseDto   ─ prDetailContext
                              → IReadOnlyList<CheckDto>                          ─ ChecksTab + tab glyph
        ▲
        └─ GitHubCiFailingDetector shares ClassifyCheckRun + HasRegisteredStatuses, folds → 4-state
           (combined-status rollup read unchanged; page-walk NOT shared — see Reader)
```

The slice mirrors the **Hotspots tab** precedent end-to-end: a backend reader → a
new endpoint → a `PrDetailView`-owned hook → `prDetailContext` → a tab component.
No existing tab data path is disturbed.

## Backend

### Shared classification — `GitHubCheckClassifier` (the R1 resolution)

A new **pure** helper in `PRism.GitHub` (no HTTP, no cache). Scope it to **only
what the detector already computes the same way** — sharing more than that would
turn an extraction into a behavior change (see the boundary note below):

```csharp
// raw check-run JSON element → normalized. SHARED: detector + reader.
static (CheckRunStatus Status, CheckConclusion? Conclusion) ClassifyCheckRun(JsonElement run);
// whether a combined-status payload has ≥1 registered context (#286 guard). SHARED.
static bool HasRegisteredStatuses(JsonElement combinedStatusRoot);
// a single combined-status "statuses[]" entry → normalized. READER-ONLY (see boundary note).
static (CheckRunStatus Status, CheckConclusion? Conclusion) ClassifyStatusContext(JsonElement ctx);
```

**Sharing boundary (the behavior-preserving line — adversarial R2).** Two paths
classify *differently today* and must NOT be force-unified:

- **Check-runs:** the detector classifies each run element exactly as the reader
  needs (`GitHubCiFailingDetector.cs:197-212`). `ClassifyCheckRun` is a genuine
  behavior-preserving extraction; the detector folds its result into
  `anyFailing/anyPending/anySuccess`, the reader keeps it verbatim. **Shared.**
- **Combined status:** the detector reads the **server-computed rollup** (`state`
  for the whole commit, `GitHubCiFailingDetector.cs:238-254`) — it never
  enumerates `statuses[]`. The reader needs **per-entry** classification to list
  individual contexts. These are different computations. So `ClassifyStatusContext`
  is **reader-only**, and the detector **keeps reading the rollup `state`
  unchanged**. (`HasRegisteredStatuses` is already shared — the detector calls it
  today for the #286 guard.) Do not claim the detector calls `ClassifyStatusContext`.

So the genuinely behavior-preserving, test-guarded extraction is
**`ClassifyCheckRun` + `HasRegisteredStatuses`**; the existing
`GitHubCiFailingDetectorTests` are the regression net for those. The per-context
status mapping is new reader code (its own tests), not an extraction.

**Check-run classification (`ClassifyCheckRun`) — must match the detector exactly:**

| check-run input | Normalized |
|---|---|
| `status != "completed"` (incl. `queued`, `in_progress`, **`waiting`/`requested`/`pending`** and any future value) | `in-progress` (or `queued` if `status == "queued"`), `Conclusion = null` |
| `status = completed`, `conclusion = success` | `completed`, `success` |
| `status = completed`, `conclusion ∈ {failure, timed_out, cancelled}` | `completed`, mapped (`timed_out`→`timed-out`) |
| `status = completed`, `conclusion ∈ {skipped, neutral, action_required, startup_failure, stale}` | `completed`, mapped (`action_required`→`action-required`); others → kebab |

> **The non-terminal rule is a catch-all, NOT an allowlist (adversarial R2).** The
> detector treats **any** non-`completed` status as pending
> (`GitHubCiFailingDetector.cs:201`); GitHub has added `waiting`/`requested`/`pending`
> beyond `queued`/`in_progress`. Enumerating only two values would silently flip a
> `waiting` check's classification — and the existing detector tests cover only
> `completed`/`in_progress`, so they would **not** catch the regression. Define it
> as `status != "completed"` and add a classifier test for an unknown/future status
> string. (UI maps everything non-terminal to "in-progress" for the glyph;
> `queued` is preserved on the DTO only as a finer label.)

**Legacy combined-status classification:**

| input | Normalized |
|---|---|
| **rollup** `state ∈ {failure, error}` (detector path) | aggregate Failing — detector unchanged |
| **rollup** `state = pending` **and `HasRegisteredStatuses`** (detector path) | aggregate Pending — detector unchanged |
| **rollup** `state = pending` **and NOT `HasRegisteredStatuses`** | aggregate None — the #286 bare-pending guard, detector unchanged |
| **per-entry** `statuses[].state ∈ {failure, error}` (reader, `ClassifyStatusContext`) | `completed`, `failure` |
| **per-entry** `statuses[].state = pending` (reader) | `in-progress`, `null` |
| **per-entry** `statuses[].state = success` (reader) | `completed`, `success` |
| reader: combined status with **NOT `HasRegisteredStatuses`** | contributes **no** `CheckDto` (#286 — a no-legacy-CI PR must not add a phantom check) |

> **#286 is the trap.** GitHub's combined-status returns `state = "pending"` with
> `total_count = 0` for every modern Actions-only PR (the common case). The reader
> applies `HasRegisteredStatuses` and contributes nothing in that case; mapping it
> to an in-progress check would light a permanent false amber pulse.

### Contract — `CheckDto` / `ChecksResponseDto`

New records in `PRism.Core.Contracts`. One unified per-check shape from **either**
source (so the tab covers exactly the inputs the chip reads — see R4).

```csharp
public sealed record CheckDto(
    string Name,                  // check-run "name" / status "context"
    CheckRunStatus Status,        // queued | in-progress | completed
    CheckConclusion? Conclusion,  // success | failure | cancelled | timed-out
                                  // | skipped | neutral | action-required | null
    string Source,                // "check-run" | "status" (UI honesty: no duration for status)
    DateTimeOffset? StartedAt,    // check-runs only; null for legacy status
    DateTimeOffset? CompletedAt,  // check-runs only
    string? DetailsUrl);          // sanitized https-only (see § Security); else null

public enum DegradedReason { None, Auth, Transient } // drives cause-accurate UI copy

public sealed record ChecksResponseDto(
    IReadOnlyList<CheckDto> Checks,
    string HeadSha,               // echoes the requested SHA (coherence dedup, see § Head-SHA model)
    DegradedReason Degraded);     // None = complete read; Auth = a 403; Transient = a 5xx
```

**Degraded precedence (coherence R2):** `Degraded` is a single value. If the two
sources fail with *different* reasons (e.g. check-runs 403 + status 5xx), report
**`Auth` before `Transient`** — the auth cause is the more specific and actionable
one to surface. `None` only when both reads completed cleanly.

`CheckRunStatus`, `CheckConclusion`, and `DegradedReason` are new enums and
round-trip **kebab-case lowercase** via the existing `JsonStringEnumConverter`
(architectural invariant — "Wire-format conventions"). New enums inherit the
policy automatically.

> **`DegradedReason` exists to fix a real mis-message:** a transient 5xx and an
> auth 403 are *both* degraded reads, but the UI copy differs — a 403 means "the
> token can't read checks," a 5xx means "GitHub hiccuped, retry." Collapsing them
> to one boolean would tell a classic-PAT user their token is wrong on a 5xx.

### Reader — `IPrChecksReader` / `GitHubPrChecksReader`

New seam in `PRism.Core` (interface) + `PRism.GitHub` (impl), registered in
`PRism.GitHub/ServiceCollectionExtensions.cs`.

```csharp
public interface IPrChecksReader
{
    Task<ChecksResponseDto> ReadAsync(PrReference pr, string headSha, CancellationToken ct);
}
```

Implementation reuses the established HTTP plumbing and the shared classifier:

- **Check-runs:** `GET repos/{o}/{r}/commits/{sha}/check-runs?per_page=100`,
  following `rel="next"` via `GitHubLinkHeader`, capped at `MaxCheckRunPages = 10`.
- **Legacy statuses:** `GET repos/{o}/{r}/commits/{sha}/status`, enumerating the
  inline `statuses[]` array (each → one `CheckDto`, `Source = "status"`), applying
  the `HasRegisteredStatuses` #286 guard. **Pagination:** follow `rel="next"` on
  `/status` too (same helper, same cap) so a commit with >30 status contexts isn't
  truncated — the AC says "lists individual checks," so first-page-only (the
  detector's aggregate shortcut) is not acceptable here.
- The `rel="next"` page-walk (next-link follow + cap + `ThrowIfRateLimited` +
  degraded-on-non-2xx) lives **in the reader** (a small private loop reused for the
  check-runs and status reads). It is **not** shared with the detector: the
  detector's page loop carries classification-coupled short-circuit state (a
  `Failing` seen on an earlier page is definitive and returned non-degraded even if
  a later page degrades — `GitHubCiFailingDetector.cs:174-185`, pinned by
  `All_passing_first_page_then_degraded_next_page_marks_none_not_passing`). A
  generic walker can't reproduce that without a classification-fold callback, at
  which point it isn't "small and shared." The reader classifies after a full read
  and has no such short-circuit, so its loop is genuinely simple. Duplicating ~20
  mechanical lines is cheaper than coupling the two. (scope-guardian / feasibility /
  adversarial R2 all converged here.)
- All via `GitHubHttp.SendAsync` on the `"github"` client (same-host credential
  guard, rate-limit throwing, API-version header — all inherited). The GHES
  absolute-URL + host-guard discipline (`reference_github_link_pagination_ghes_double_prefix`)
  is inherited, not re-implemented.

**Degraded handling** mirrors the detector's #213 stance: a non-2xx from either
source does **not** throw — it returns the checks read so far with `Degraded =
Auth` (on a 403) or `Transient` (on a 5xx/other non-2xx). A 429 still **throws**
so backoff is preserved (`GitHubHttp.ThrowIfRateLimited`). CI detail is
non-critical enrichment; it must never hard-fail the page.

> **Why a separate reader, not the detector (R1).** The detector's *caching* and
> *aggregation* contract (SHA-keyed terminal cache, never-cache-Pending/degraded,
> 4-state rollup tuned for the inbox sweep) genuinely conflicts with the tab's
> needs (verbatim per-check, on demand, scoped to a client SHA). That justifies a
> separate reader **and a separate cache** (none — the reader is uncached; the
> frontend hook owns freshness). It does **not** justify duplicating the
> classification, which is why classification is extracted and shared (above).

### Endpoint — `GET /api/pr/{owner}/{repo}/{number}/checks?sha={headSha}`

Add to `PRism.Web/Endpoints/PrDetailEndpoints.cs`, beside the existing PR-detail
routes. `sha` is a **required** query parameter supplied by the client (its loaded
`data.pr.headSha`); the endpoint calls `IPrChecksReader.ReadAsync(pr, sha, ct)`
and returns `ChecksResponseDto` (echoing `sha` as `HeadSha`).

**Input validation (§ Security):** `sha` is validated with the **existing
`IsValidGitOid`** (`SharedRegexes.Sha40() || Sha64()` — exactly 40 or 64 hex), the
same validator `/file?sha=` and `/diff?range=` already use; do **not** invent a
looser range — the client always sends a full `data.pr.headSha`, and consistency
keeps one sha contract (feasibility / security R2). `owner` and `repo` are
validated against a GitHub-identifier pattern (`^[A-Za-z0-9_.-]{1,100}$`) before
constructing `PrReference`. (Existing PR-detail endpoints share the
unvalidated-owner/repo gap; this endpoint does not propagate it. Retrofitting the
others is out of scope, noted for a follow-up.)

No new auth surface, no new token scope: it reads check-runs with the **existing**
classic-`repo` PAT exactly as the inbox detector already does
(`reference_github_finegrained_pat_limits`). Re-trigger *would* need a write
scope — deferred.

A `FakePrChecksReader` test hook lands in `PRism.Web/TestHooks/` (mirroring
`FakePrReader`) for deterministic e2e / integration check lists.

## Frontend

### Hook — `useCheckRuns(prRef, headSha, active)`

New hook owned by `PrDetailView` (the `useFileFocusResult` precedent). Signature
takes `active: boolean` and `headSha: string | undefined` as **parameters** (not
context), so it is unit-testable by toggling props.

```ts
type DegradedReason = 'none' | 'auth' | 'transient'; // kebab wire union (matches C# DegradedReason)

interface CheckRunsResult {
  status: 'idle' | 'loading' | 'ok' | 'empty' | 'error';
  degraded: DegradedReason;   // overlay carried on EVERY status incl. 'error' (carries the cause)
  checks: CheckRun[];
  retry: () => void;
}
```

> **`degraded` is a flag, not a status** (scope-guardian/coherence): a partial read
> is "`ok` (or `empty`) with a caveat," not a distinct terminal state. Five
> statuses + a `degraded` overlay; the banner shows when `degraded !== 'none'`.
> On the TS side `DegradedReason` is the **kebab string union** (`'none'|'auth'|
> 'transient'`) deserialized from the wire, so the comparison is the literal
> `degraded !== 'none'` (the C# side is the `DegradedReason` enum). `degraded` is
> meaningful in the **`error`** state too (both sources failed): it carries `auth`
> or `transient` so the error copy is cause-accurate, not generic.
> `checksGlyphState` inspects `checks` only, never `status`.

**Polling model** (option A — lazy + active-only):

- **Visibility gate (the real predicate):** poll only when
  `active && headSha != null && document.visibilityState === 'visible'`, where
  `active` is `PrDetailView`'s view-level mounted flag AND the sub-tab is `checks`
  (`active && effectiveSubTab === 'checks'`, threaded as one derived boolean).
  Keying off the sub-tab alone would poll forever in backgrounded PR tabs; adding
  `document.visibilityState` stops a blurred Electron window from polling.
- **Lazy:** `status = 'idle'`, no fetch, until the gate first goes true.
- **Interval:** re-fetch every **15s** while the gate is true **and** the result is
  still "live" (see stop conditions). 15s (vs the inbox's 30s) keeps fast checks
  responsive without tripling the call rate; CI runs are minutes-long, so it's not
  chatty. **Single-flight:** never overlap fetches — if a tick fires while one is in
  flight, skip it.
- **"Live" = keep polling while** ≥1 check is non-terminal (`Status ∈ {queued,
  in-progress}`) **OR** the list is empty *and* within ~2 min of the gate opening
  (the late-registration window — see below). Otherwise stop.
- **Stop conditions:** all checks terminal (and ≥1 present), gate goes false, the
  late-registration window elapses on a still-empty list, or unmount.
- **429 / error backoff:** on a thrown 429 or network error, **stop the loop** and
  surface `status = 'error'` (+ `degraded` cause) + Retry; do **not** keep firing
  every 15s into a rate limit. (Manual Retry restarts the loop.)
- **Empty handling (no fixed grace skeleton — scope/adversarial R2):** a definitive
  empty read renders **"No checks for this commit" immediately** (no 5s skeleton
  tax on the common no-CI PR — many PRs genuinely have none). To still catch
  *late-registering* checks (just reloaded to a brand-new SHA before GitHub
  registered the runs), the loop keeps polling on an empty list for the
  ~2-min late-registration window above, then stops. The first non-empty result
  switches to normal terminal-based polling. (Backend has no completeness signal,
  so the client can't distinguish genuine-empty from lagging-empty up front — the
  bounded re-poll covers the lag without delaying the genuine case.)
- **Re-fetch on `headSha` change** (i.e. after a user Reload): abort the in-flight
  request (`AbortController`) and start a fresh series for the new SHA.

**Coherence guards (adversarial R2 — no overclaim):** *single-flight* handles
intra-series ordering (no two in-flight requests in one SHA series); the
*`AbortController`* handles the cross-series race (an old-SHA response landing after
a Reload starts a new fetch); the *`HeadSha` echo equality check* is a defensive
cross-series backstop (reject a response whose `HeadSha` ≠ currently-requested SHA).
It does **not** dedup "within a SHA series" — single-flight already precludes that.

Result is published via `prDetailContext` (parallel to `fileFocus`).

### Tab strip indicator (the approved affordance)

`PrTabId` gains `'checks'` (`PrSubTabStrip.tsx`); the Checks tab is **always
rendered** (unlike the AI-gated Hotspots tab).

**Component work (named, not assumed):** the generic `Tab` has only a bespoke
`aiMarkerState` lead-slot prop. Add a generic **`leadingGlyph?: ReactNode`** slot
to `Tab` (the Hotspots `AiMarker` becomes one consumer of it; checks pass a
`ChecksTabGlyph`). This is a real change to the shared `PrSubTabStrip` + its tests.

Two orthogonal signals, from the inbox CI vocabulary (`InboxRow.tsx` octicons):

- **Leading glyph** (the new slot):
  - **in-progress** — `checks.some(c => c.status === 'queued' || c.status === 'in-progress')`
    → **pulsing amber dot** (inbox `pending` color). "Non-terminal" is **defined**
    as `Status ∈ {queued, in-progress}` — a queued-but-not-started check still
    pulses. Wins the lead slot even if some checks have already failed.
  - **all-green** — all terminal, ≥1 `success`, 0 failing, 0 in-progress → **green
    tick** (inbox `passing` check octicon).
  - otherwise → no leading glyph.
- **Trailing badge** — **failing count**, red warn-styled, shown when failing > 0.
  **"Failing" = `Conclusion ∈ {failure, timed-out, cancelled}`** — the same
  conclusions the header chip treats as failing (the detector counts
  `cancelled`/`timed_out` as failing), so the badge matches the chip.

> **Cancelled must be a full failing-tier member, not just a badge count
> (adversarial R2).** An earlier draft counted `cancelled` in the badge but sorted
> it into a lower non-failing tier — so a cancelled-only PR showed a red "1 failing"
> badge and aria, but the failing section in the panel was empty ("badge says 1
> failing, I see none"). Resolution: `{failure, timed-out, cancelled}` are the
> **failing tier** everywhere — badge, aria, sort position (top), and row glyph
> (red). They agree by construction.

`action-required` is a **manual gate, not a failure**: it is **not** in the failing
count, but is **not** silent — it has its own row glyph (amber) and its own sort
tier (below failing, above in-progress). It does not drive the lead glyph or the
badge in v1; revisit surfacing manual gates more prominently if users ask (tracked
against the existing #305 thread).

**Lead-glyph completeness (design R2).** The lead slot has exactly three outcomes:
in-progress → amber pulse; all-green → green tick; **everything else → no lead
glyph** (including a failing-only / cancelled-only terminal state — the **red badge
is the signal there, intentionally, with no lead glyph**). This is deliberate, not
an omission.

**Idle/loading glyph (stale-while-revalidate, with a reload reset — product R2):**
- *Same-SHA re-fetch* (a poll tick): while `status ∈ {idle, loading}` **preserve
  the last-known glyph** — prevents a flicker-to-blank between ticks.
- *New-SHA load* (after a Reload): **clear** the preserved glyph back to the cold
  no-glyph state — do **not** carry the prior head's verdict (e.g. a green tick)
  across the Reload boundary onto a commit whose checks haven't loaded.
- Initial cold load: no glyph until the first response.

A single `checksGlyphState(checks)` derivation is the source of truth for both the
lead glyph and the badge count, so they cannot drift. Pure over the `checks` array,
exhaustively unit-tested (all-queued, running+failing, cancelled-only → red badge +
no lead glyph, all-green → tick, mixed, empty).

**Accessibility:**
- `prefers-reduced-motion: reduce` → the amber dot renders **static** (no pulse);
  the dot itself still conveys in-progress, motion is decorative only.
- The **tab's `aria-label` carries the health summary** (matching how `InboxRow`
  puts CI state in its aria-label), e.g. `"Checks — 2 failing"`, `"Checks —
  running"`, `"Checks — all passing"`, `"Checks — 1 cancelled"` (failing-tier
  count). The visual badge and the dot are `aria-hidden` (their meaning is in the
  label).
- **Live-update policy (design R2):** label changes during polling are
  **intentionally silent** — no `aria-live` on the tab. At the 15s cadence a live
  announcer would be chatty, and the shared head-drift banner already announces the
  consequential change. A keyboard/SR user hears the current health when they
  navigate to the tab. (Documented tradeoff; revisit if users want active
  announcements.)

### Tab panel — `ChecksTab`

New `frontend/src/components/PrDetail/ChecksTab/ChecksTab.tsx`, consuming
`usePrDetailContext()`. Mirrors `HotspotsTab` structure.

- **List:** flat (not grouped by workflow — YAGNI; `detailsUrl` reaches the
  workflow on GitHub). Sorted **problems-first** by tier, stable by name within a
  tier:
  1. **failing** — `Conclusion ∈ {failure, timed-out, cancelled}` (the failing tier,
     matching the badge)
  2. **action-required**
  3. **in-progress** — `Status ∈ {queued, in-progress}`
  4. **neutral / skipped / stale**
  5. **passing** (`success`) last
- **Row:** conclusion glyph (below) + check name + duration + a **"Details ↗"** link
  to `detailsUrl` (opens on github.com; `target="_blank"`, `rel="noopener
  noreferrer"`, the Electron will-navigate guard — URL is https-sanitized
  backend-side, § Security). When `detailsUrl` is null (sanitized out, or a legacy
  status without a target), render the name without a link.
  - **Row glyph mapping (design R2 — was previously undefined):**

    | state | glyph | color |
    |---|---|---|
    | `failure` / `timed-out` | ✗ cross | red |
    | `cancelled` | ✗ cross (or slash) | red (failing tier) |
    | `action-required` | ! / alert octicon | amber |
    | `queued` / `in-progress` | spinner / dot | amber |
    | `skipped` / `neutral` / `stale` | – dash | muted/grey |
    | `success` | ✓ check | green |

    Reuse the `InboxRow` octicon set where it maps (check/cross/dot); the
    action-required and dash glyphs are new but small.
  - **Name overflow:** one line, `text-overflow: ellipsis`, full name in a native
    `title`. Duration + Details are right-aligned fixed columns; the name takes the
    remaining width.
  - **Duration:** `<1s → "<1s"`; `<60s → "Ns"`; `≥60s → "Nm Ss"`; `≥1h → "Nh Mm"`.
    Computed from the **latest poll response** (`CompletedAt − StartedAt`; for an
    in-progress check, `last-response-time − StartedAt`). **No separate per-second
    live-ticker in v1** (scope R2) — it updates each 15s poll, which is adequate for
    minutes-long runs and avoids a second interval + per-second re-renders. Omitted
    when `Source = "status"` (no timing) or `StartedAt` is absent.
- **States:**
  - `idle`/`loading` (cold) → skeleton rows. (Warm re-fetch keeps the last list
    rendered; no skeleton flash.)
  - `empty` → "No checks for this commit." (Rendered immediately on a definitive
    empty read — no fixed grace; see the late-registration re-poll in § Hook.)
  - `error` → message + **Retry**, cause-accurate via `degraded`:
    - `auth` → "Couldn't load checks — the current token may lack access (a classic
      `repo` token is required for the Checks API)."
    - `transient` / 429 / network → "Couldn't load checks — retry."
  - `degraded` overlay (partial read, some checks shown) → a subtle banner above
    the list, copy keyed to `degraded`:
    - `auth` → "PRism couldn't read some checks — the current token may lack
      access (a classic `repo` token is required for the Checks API)." (Does **not**
      claim the token is *definitely* wrong; GHES configs can also 403.)
    - `transient` → "Some checks couldn't be loaded — retry."

### Types

`frontend/src/api/types.ts` gains `CheckRun`, `CheckRunStatus`, `CheckConclusion`,
`DegradedReason`, `ChecksResponse` matching the kebab-case wire enums. Per
`reference_nonoptional_wire_field_escapes_e2e_route_mocks`, any e2e route mock /
fixture returning the checks payload must be hand-checked for the full shape (tsc
does not type Playwright `route.fulfill` bodies).

### Large check counts

The backend caps at ~1000 (10 pages) — the safety valve. The frontend renders the
flat list without virtualization or a display cap in v1 (typical PRs have <30
checks; the problems-first sort puts anything actionable at the top). No soft
display cap (scope R2 — it would need a `TotalCount` field the DTO doesn't carry,
for a case the spec itself calls unlikely). Virtualization is deferred unless real
monorepo usage shows it's needed.

## Security

| Concern | Mitigation |
|---|---|
| `detailsUrl` is provider-controlled (third-party check-run `html_url`/`target_url`) — `javascript:`/`data:` XSS via `<a href>` (and `rel=noopener` does **not** block `javascript:` execution) | **Backend allowlist, `https`-only:** populate `CheckDto.DetailsUrl` only when `Uri.TryCreate(raw, UriKind.Absolute, out var u) && u.Scheme == "https"`; otherwise `null`. Use the codebase's `Uri.TryCreate`+scheme pattern (`GitHubFeedbackSubmitter.cs:34`, `HostUrlResolver.cs:10`), **not** a `StartsWith` check (bypassable). `https`-only matches every other outbound link in the codebase; GitHub `html_url` is always https even on GHES (security R2). |
| `owner`/`repo`/`sha` path & query injection into GitHub REST paths | Validate at the endpoint: `owner`/`repo` `^[A-Za-z0-9_.-]{1,100}$`; `sha` via the existing **`IsValidGitOid`** (`Sha40()||Sha64()`, exactly 40/64 hex) — same as `/file?sha=`, not a bespoke range. |
| PAT egress to off-host (GHES double-prefix) | Inherited `GitHubHttp.ApplyHeaders` same-host guard + absolute-URL `rel="next"` (`reference_github_link_pagination_ghes_double_prefix`). |
| Reverse-tabnabbing on `target="_blank"` | `rel="noopener noreferrer"`. |
| Authz (reading a repo the user shouldn't) | Same model as every PR-detail endpoint — the PAT gates at GitHub (403/404); no new exposure. |

## Error handling summary

| Condition | Backend | Frontend |
|---|---|---|
| No checks / no registered statuses | `Checks = []`, `Degraded = None` | `empty` immediately (definitive); loop re-polls ≤2 min for late registration |
| 403 on a source | partial list, `Degraded = Auth` | list + `auth` banner (scope-accurate copy) |
| 5xx / other non-2xx on a source | partial list, `Degraded = Transient` | list + `transient` banner |
| Both sources fail, different reasons | `Degraded = Auth` (Auth before Transient) | `error` + Retry, `auth` copy |
| Both sources fail (no data) | `Checks = []`, `Degraded = Auth\|Transient` | `error` + Retry (copy keyed to `degraded`) |
| 429 rate-limit | throws | loop stops; `error` + Retry |
| Loaded head advanced (new push) | n/a (client still on old `sha`) | shared drift banner → user Reload → re-fetch new head (see § Head-SHA model) |
| Cross-series stale response (after Reload) | response echoes `HeadSha` | `AbortController` + `HeadSha`-equality backstop |

## Testing strategy

Non-bug enhancement → proof is **test-first** new tests (red→green within PR
history) + the acceptance checklist.

- **Backend — `GitHubCheckClassifier` (`PRism.GitHub.Tests`):** every row of the
  check-run table incl. `cancelled`/`timed_out`/`action_required`/`skipped`/
  `neutral`; the **non-terminal catch-all** (assert an unknown/future status string
  e.g. `"waiting"` normalizes to in-progress, not a fall-through — the narrowing
  regression the existing tests miss); per-context `ClassifyStatusContext` mapping;
  `HasRegisteredStatuses` true/false incl. the **#286 bare-pending** omission. These
  are the highest-value tests (the drift risk lives here).
- **Backend — detector regression:** the existing `GitHubCiFailingDetectorTests`
  must stay green across the `ClassifyCheckRun` + `HasRegisteredStatuses` extraction
  (proves behavior-preserving). The detector's combined-status **rollup** read is
  unchanged (not routed through `ClassifyStatusContext`).
- **Backend — `GitHubPrChecksReader`:** check-runs **and** `/status` pagination
  across `rel="next"`; page cap; degraded `Auth` (403) vs `Transient` (5xx) returns
  partial + correct reason, does not throw; both-fail precedence (Auth before
  Transient); 429 throws; `detailsUrl` sanitization (a `javascript:`, `data:`, and
  `http:` `html_url` each → null; an `https:` one passes).
- **Backend — `PRism.Web` integration:** `GET …/checks?sha=` via
  `FakePrChecksReader`; required-`sha` + `owner`/`repo`/`sha` (`IsValidGitOid`)
  validation rejects malformed input.
- **Frontend (vitest):** `checksGlyphState` over all combinations (all-queued,
  running+failing, **cancelled-only → red badge + no lead glyph**, all-green →
  tick, empty); `ChecksTab` each state (skeleton/empty/error-auth/error-transient/
  auth-degraded/transient-degraded/list); problems-first ordering with cancelled in
  the failing tier; conclusion→glyph mapping incl. action-required; duration
  formatting (no live-tick) + omission for `status` source; name-ellipsis + title;
  glyph **clear on new-SHA load** vs preserve on same-SHA re-fetch; `useCheckRuns`
  lazy-start, poll start/stop on `active` toggle + on all-terminal + on
  `document.hidden`, single-flight, 429-stops-loop, **late-registration re-poll on
  empty then stop after the window**, headSha re-fetch + abort (fake timers). Hook
  arrangement: render `active=false` → no fetch; `active=true` → first fetch; push a
  non-terminal check, advance timers → re-fetch; `active=false` → no further fetch.
- **Accessibility:** tab `aria-label` health summary; reduced-motion static dot.
- **e2e (Playwright, prod project):** open a PR → Checks tab → assert the list +
  tab-strip glyph, `FakePrChecksReader` fixture with mixed states. The
  always-present new tab shifts the strip; verify against the **green** parity e2e
  rather than pre-regenerating baselines (the 2% tolerance likely absorbs it —
  `reference_parity_baseline_2pct_tolerance_absorbs_small_changes`); regen only if
  it actually reds.

## Rejected alternatives

- **R1 — Duplicate the detector's fetch+classify path.** Rejected: the
  classification encodes ~5 issues of edge cases (#213/#264/#286/#305) and would
  drift on the next fix. Resolution: **share classification** (`GitHubCheckClassifier`,
  behavior-preserving extraction) and the mechanical page-walk; keep **caches
  separate** (the real coupling R1's instinct was protecting). The detector's
  aggregate caching/rollup is untouched.
- **R2 — Fold checks into `PrDetailDto` (one-shot).** Rejected: refreshes only on
  reload, failing the "monitor progress" AC.
- **R3 — Ride the 30s active poll.** Rejected: adds a per-check fetch to every
  active-PR tick for every open PR even when no one's on the tab; the active poll
  was deliberately kept lightweight.
- **R4 — Check-runs only (drop legacy commit statuses).** Rejected: a PR whose
  chip is "failing" *because of a legacy status* would show an empty/green tab. The
  tab reads both sources. (Note: the tab is intentionally **more granular** than
  the 4-state chip; the failing **badge** is reconciled to count the same
  conclusions the chip treats as failing, but per-row the tab shows distinctions
  the chip collapses — that is by design, not a contradiction.)
- **R5 — Group the list by workflow.** Rejected for v1 (YAGNI); `detailsUrl`
  reaches the workflow. Revisit if real PRs show unwieldy flat lists.
- **R6 — Track the live head (auto-advancing SHA).** Rejected: the active poller
  exposes only `headShaChanged: boolean`, not the SHA; tracking the live head would
  poll a stale commit until manual reload. Scoped to the loaded head instead (§
  Head-SHA model), consistent with "Banner, not mutation."

## Deferred follow-up — re-trigger

File a P3 issue: **"PR detail Checks tab: re-trigger failed checks."** Scope at
the level needed to file it (the implementing seam/endpoint shape is the
follow-up's own design call, not bound here):

- A new write path (Actions run re-run) + endpoint behind the Checks tab.
- **Required scope to document:** re-running an Actions run needs **write** access
  (classic `repo`, which PRism already requests, grants it; a fine-grained token
  would need `actions: write`).
- Feasibility caveats to design around: only **Actions** runs are re-runnable;
  non-Actions check-runs use *re-request* of the originating app; fork /
  no-write-access PRs can't be re-run (hide/disable with an explanatory tooltip);
  partial-success + optimistic-state UX.
- This is a **B2 (risk-surface) write mutation** → retains the human approach gate,
  unlike this read-only slice (B1 only).

## Risk classification (this slice)

- **Tier:** T3 — slice-sized, new behavior, backend + frontend.
- **Risk:** **gated B1 (UI-visual)** — `needs-design` + new rendered output (tab,
  indicators, list) a human must eyeball. **Not B2:** no new token scope, no token
  storage, no write/mutation, no auth-validation logic; the classification
  extraction is behavior-preserving over the existing aggregate path. Per the
  pre-PR re-check, if implementation drifts into any write call or scope change,
  re-classify to B2 and route to the approach gate.
- **Gate:** pause **after** green-and-ready for the human visual assert (B1), and
  honor the spec/plan human-review gates (gated issue → human gates retained).

## Open product questions (non-blocking, FYI from review)

- **Pulse animation value:** the pulse is the one net-new visual (vs reusing
  static glyphs). Kept because the tab strip is the only place a backgrounded
  reviewer sees CI is *live* without opening the tab; reduced-motion falls back to
  static. Cheap to cut to static later (same `checksGlyphState`).
- **Positioning:** an always-visible Checks tab + always-on CI glyph gives CI
  persistent presence in the PR-detail chrome — a deliberate, contained bet
  (read-only diagnosis; github.com remains the home for CI action/detail). The
  deferred re-trigger is the next step on this axis.
