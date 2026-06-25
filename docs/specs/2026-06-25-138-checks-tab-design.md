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

## Architecture overview

```
GitHub REST                  PRism.GitHub                 PRism.Web              frontend
-----------                  ------------                 ---------              --------
/commits/{sha}/check-runs ─┐  GitHubCheckClassifier ←──── (shared, pure)
                           ├─ IPrChecksReader ─────────── GET …/{n}/checks?sha= ─ useCheckRuns(prRef, headSha, active)
/commits/{sha}/status     ─┘  GitHubPrChecksReader        → ChecksResponseDto   ─ prDetailContext
                              → IReadOnlyList<CheckDto>                          ─ ChecksTab + tab glyph
        ▲
        └─ GitHubCiFailingDetector also calls GitHubCheckClassifier, folds → 4-state (unchanged behavior)
```

The slice mirrors the **Hotspots tab** precedent end-to-end: a backend reader → a
new endpoint → a `PrDetailView`-owned hook → `prDetailContext` → a tab component.
No existing tab data path is disturbed.

## Backend

### Shared classification — `GitHubCheckClassifier` (the R1 resolution)

A new **pure** helper in `PRism.GitHub` (no HTTP, no cache) with two functions:

```csharp
// raw check-run JSON element → normalized
static (CheckRunStatus Status, CheckConclusion? Conclusion) ClassifyCheckRun(JsonElement run);
// a single combined-status "statuses[]" entry → normalized
static (CheckRunStatus Status, CheckConclusion? Conclusion) ClassifyStatusContext(JsonElement ctx);
// whether a combined-status payload has ≥1 registered context (the #286 guard)
static bool HasRegisteredStatuses(JsonElement combinedStatusRoot);
```

`GitHubCiFailingDetector` is refactored to call `ClassifyCheckRun` /
`ClassifyStatusContext` / `HasRegisteredStatuses` and fold the normalized values
into its existing 4-state rollup — **behavior-preserving**, with the existing
`GitHubCiFailingDetectorTests` as the regression net. The new reader calls the
same functions and keeps the normalized values verbatim. This single-sources the
classification so a future edge-case fix (the next #264) lands once.

**The classification rules the shared helper must encode** (lifted verbatim from
the detector — enumerated here so they are testable contract, not "mirrors the
detector"):

| GitHub input | Normalized |
|---|---|
| check-run `status ∈ {queued, in_progress}` | `Status = queued` / `in-progress`, `Conclusion = null` |
| check-run `status = completed`, `conclusion = success` | `completed`, `success` |
| check-run `status = completed`, `conclusion ∈ {failure, timed_out, cancelled}` | `completed`, mapped (`timed_out`→`timed-out`) |
| check-run `status = completed`, `conclusion ∈ {skipped, neutral, action_required, startup_failure, stale}` | `completed`, mapped (`action_required`→`action-required`); the others → their kebab forms |
| legacy status `state = pending` **and `HasRegisteredStatuses`** | `in-progress`, `null` |
| legacy status `state = pending` **and NOT `HasRegisteredStatuses`** | **omitted entirely** (the #286 bare-pending guard — a no-legacy-CI PR must NOT contribute a phantom in-progress check) |
| legacy status `state ∈ {failure, error}` | `completed`, `failure` |
| legacy status `state = success` | `completed`, `success` |

> **#286 is the trap.** GitHub's combined-status returns `state = "pending"` with
> `total_count = 0` for every modern Actions-only PR (the common case). Mapping
> that to an in-progress check would light a permanent false amber pulse on the
> tab strip. The bare-pending row above is mandatory.

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
    string? DetailsUrl);          // sanitized https/http only (see § Security); else null

public enum DegradedReason { None, Auth, Transient } // drives cause-accurate UI copy

public sealed record ChecksResponseDto(
    IReadOnlyList<CheckDto> Checks,
    string HeadSha,               // echoes the requested SHA (coherence dedup, see § Head-SHA model)
    DegradedReason Degraded);     // None = complete read; Auth = a 403; Transient = a 5xx
```

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
  degraded-on-non-2xx) is factored into a small shared `GitHubPageWalker` used by
  both the check-runs and status reads, and ideally by the detector too (the page
  walk is mechanical and SHA-safe to share, distinct from classification).
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

**Input validation (§ Security):** `owner` and `repo` are validated against a
GitHub-identifier pattern (`^[A-Za-z0-9_.-]{1,100}$`) and `sha` against
`^[0-9a-fA-F]{7,64}$` at the endpoint before constructing `PrReference` /
interpolating into the GitHub path. (Existing PR-detail endpoints share the
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
interface CheckRunsResult {
  status: 'idle' | 'loading' | 'ok' | 'empty' | 'error';
  degraded: DegradedReason;   // overlay on 'ok'/'empty' — a partial read still has (some) data
  checks: CheckRun[];
  retry: () => void;
}
```

> **`degraded` is a flag, not a status** (scope-guardian/coherence): a partial read
> is "`ok` (or `empty`) with a caveat," not a distinct terminal state. Five
> statuses + a `degraded` overlay; the banner shows when `degraded !== 'none'`.
> `checksGlyphState` inspects `checks` only, never `status`.

**Polling model** (option A — lazy + active-only):

- **Visibility gate (the real predicate):** poll only when
  `active && headSha != null && document.visibilityState === 'visible'`, where
  `active` is `PrDetailView`'s view-level mounted flag AND the sub-tab is `checks`
  (`active && effectiveSubTab === 'checks'`, threaded as one derived boolean).
  Keying off the sub-tab alone would poll forever in backgrounded PR tabs; adding
  `document.visibilityState` stops a blurred Electron window from polling.
- **Lazy:** `status = 'idle'`, no fetch, until the gate first goes true.
- **Interval:** re-fetch every **15s** while the gate is true **and** ≥1 check is
  non-terminal (`Status ∈ {queued, in-progress}`). 15s (vs the inbox's 30s) keeps
  fast checks responsive without tripling the call rate; CI runs are minutes-long,
  so it's not chatty. **Single-flight:** never overlap fetches — if a tick fires
  while one is in flight, skip it.
- **Stop conditions:** all checks terminal, gate goes false, or unmount.
- **429 / error backoff:** on a thrown 429 or network error, **stop the 15s loop**
  and surface `status = 'error'` + Retry; do **not** keep firing every 15s into a
  rate limit. (Manual Retry restarts the loop.)
- **Eventual-consistency grace:** check-runs for a just-loaded SHA can lag. Treat
  an **empty** first response within ~5s of the gate opening as still-`loading`
  (don't flash "No checks for this commit" then fill); after the grace window an
  empty read is a true `empty`.
- **Re-fetch on `headSha` change** (i.e. after a user Reload): abort the in-flight
  request (`AbortController`) and start a fresh series for the new SHA. The
  response-SHA equality check is the belt-and-suspenders dedup.

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
  **"Failing" counts the same conclusions the header chip treats as failing**:
  `Conclusion ∈ {failure, timed-out, cancelled}` (R4 reconciliation — the detector
  counts `cancelled`/`timed_out` as failing, so the badge must too, or a
  cancelled-only PR would show a red chip with no red badge).

`action-required` is **not** counted as failing (it's a manual gate, not a
failure) but is **not** silent either: it gets its own row treatment and sort tier
(below failing, above in-progress) — see the panel. It does not drive the lead
glyph or the badge in v1; revisit surfacing manual gates more prominently if users
ask (tracked against the existing #305 thread).

**Idle/loading glyph (stale-while-revalidate):** while `status ∈ {idle, loading}`,
**preserve the last-known glyph** if one was shown; show no glyph only on the
initial cold load before any data has arrived. Prevents a flicker-to-blank on
tab re-entry / re-fetch.

A single `checksGlyphState(checks)` derivation is the source of truth for both the
lead glyph and the badge count, so they cannot drift. It is pure over the `checks`
array and exhaustively unit-tested (all-queued, running+failing, cancelled-only,
all-green, mixed, empty).

**Accessibility:**
- `prefers-reduced-motion: reduce` → the amber dot renders **static** (no pulse);
  the dot itself still conveys in-progress, motion is decorative only.
- The **tab's `aria-label` carries the health summary** (matching how `InboxRow`
  puts CI state in its aria-label), e.g. `"Checks — 2 failing"`, `"Checks —
  running"`, `"Checks — all passing"`. The visual badge and the dot are
  `aria-hidden` (their meaning is already in the label).

### Tab panel — `ChecksTab`

New `frontend/src/components/PrDetail/ChecksTab/ChecksTab.tsx`, consuming
`usePrDetailContext()`. Mirrors `HotspotsTab` structure.

- **List:** flat (not grouped by workflow — YAGNI; `detailsUrl` reaches the
  workflow on GitHub). Sorted **problems-first**: failing → action-required →
  in-progress → neutral/skipped/cancelled → passing last; stable by name within a
  tier. (`cancelled` is a failing *conclusion* for the badge but sorts in the
  lower "terminal-not-success" group visually — it's a finished non-actionable
  state, distinct from an active failure; the row glyph marks it clearly.)
- **Row:** status octicon (reused inbox glyph set) + check name + duration + a
  **"Details ↗"** link to `detailsUrl` (opens on github.com; `target="_blank"`,
  `rel="noopener noreferrer"`, the Electron will-navigate guard — and the URL is
  already https-sanitized backend-side, § Security). When `detailsUrl` is null
  (sanitized out, or a legacy status without a target), render the name without a
  link.
  - **Name overflow:** one line, `text-overflow: ellipsis`, full name in a native
    `title`. Duration + Details are right-aligned fixed columns; the name takes the
    remaining width.
  - **Duration:** `<1s → "<1s"`; `<60s → "Ns"`; `≥60s → "Nm Ss"`; `≥1h → "Nh Mm"`.
    For an **in-progress** check it shows **elapsed** (`now − StartedAt`),
    live-ticking ~1s via a single interval; after completion it's the final
    `CompletedAt − StartedAt`. Omitted entirely when `Source = "status"` (no
    timing) or `StartedAt` is absent.
- **States:**
  - `idle`/`loading` (cold) → skeleton rows. (Warm re-fetch keeps the last list
    rendered; no skeleton flash.)
  - `empty` → "No checks for this commit." (After the eventual-consistency grace.)
  - `error` → message + **Retry**. Copy is cause-accurate:
    - thrown 429 / network → "Couldn't load checks — retry."
  - `degraded` overlay (partial read, some checks shown) → a subtle banner above
    the list, copy keyed to `DegradedReason`:
    - `Auth` → "PRism couldn't read some checks — the current token may lack
      access (a classic `repo` token is required for the Checks API)." (Does **not**
      claim the token is *definitely* wrong; GHES configs can also 403.)
    - `Transient` → "Some checks couldn't be loaded — retry."

### Types

`frontend/src/api/types.ts` gains `CheckRun`, `CheckRunStatus`, `CheckConclusion`,
`DegradedReason`, `ChecksResponse` matching the kebab-case wire enums. Per
`reference_nonoptional_wire_field_escapes_e2e_route_mocks`, any e2e route mock /
fixture returning the checks payload must be hand-checked for the full shape (tsc
does not type Playwright `route.fulfill` bodies).

### Large check counts

The backend caps at ~1000 (10 pages). The frontend renders the flat list without
virtualization in v1 (typical PRs have <30 checks; the problems-first sort puts
anything actionable at the top). If a read exceeds a soft display cap of **200**
rows, render the first 200 (problems-first) with a "Showing first 200 of N — open
on GitHub for the full set" notice rather than silently truncating. Virtualization
is deferred unless real monorepo usage shows it's needed.

## Security

| Concern | Mitigation |
|---|---|
| `detailsUrl` is provider-controlled (third-party check-run `html_url`/`target_url`) — `javascript:`/`data:` XSS via `<a href>` (and `rel=noopener` does **not** block `javascript:` execution) | **Backend allowlist:** populate `CheckDto.DetailsUrl` only when the URL parses as absolute `https`/`http`; otherwise `null`. Sanitize at the source so every consumer is safe. |
| `owner`/`repo`/`sha` path & query injection into GitHub REST paths | Validate at the endpoint (`owner`/`repo` `^[A-Za-z0-9_.-]{1,100}$`, `sha` `^[0-9a-fA-F]{7,64}$`) before use. |
| PAT egress to off-host (GHES double-prefix) | Inherited `GitHubHttp.ApplyHeaders` same-host guard + absolute-URL `rel="next"` (`reference_github_link_pagination_ghes_double_prefix`). |
| Reverse-tabnabbing on `target="_blank"` | `rel="noopener noreferrer"`. |
| Authz (reading a repo the user shouldn't) | Same model as every PR-detail endpoint — the PAT gates at GitHub (403/404); no new exposure. |

## Error handling summary

| Condition | Backend | Frontend |
|---|---|---|
| No checks / no registered statuses | `Checks = []`, `Degraded = None` | `empty` (after grace) |
| 403 on a source | partial list, `Degraded = Auth` | list + `Auth` banner (scope-accurate copy) |
| 5xx / other non-2xx on a source | partial list, `Degraded = Transient` | list + `Transient` banner |
| Both sources fail (no data) | `Checks = []`, `Degraded = Auth\|Transient` | `error` + Retry (cause-accurate) |
| 429 rate-limit | throws | loop stops; `error` + Retry |
| Loaded head advanced (new push) | n/a (client still on old `sha`) | existing drift banner → user Reload → re-fetch new head |
| Out-of-order responses in a SHA series | response echoes `HeadSha` | `AbortController` + SHA-equality dedup |

## Testing strategy

Non-bug enhancement → proof is **test-first** new tests (red→green within PR
history) + the acceptance checklist.

- **Backend — `GitHubCheckClassifier` (`PRism.GitHub.Tests`):** every row of the
  classification table, including the **#286 bare-pending omission**, `cancelled`
  / `timed_out` / `action_required` / `skipped` / `neutral` mappings. These are
  the highest-value tests (the drift risk lives here).
- **Backend — detector regression:** the existing `GitHubCiFailingDetectorTests`
  must stay green across the classification extraction (proves behavior-preserving).
- **Backend — `GitHubPrChecksReader`:** check-runs + status pagination across
  `rel="next"`; page cap; degraded `Auth` (403) vs `Transient` (5xx) returns
  partial + correct reason, does not throw; 429 throws; `detailsUrl` sanitization
  (a `javascript:` `html_url` → null).
- **Backend — `PRism.Web` integration:** `GET …/checks?sha=` via
  `FakePrChecksReader`; required-param + `owner`/`repo`/`sha` validation rejects
  malformed input.
- **Frontend (vitest):** `checksGlyphState` over all combinations (all-queued,
  running+failing, cancelled-only → red badge, all-green → tick, empty);
  `ChecksTab` each state (skeleton/empty/error/Auth-degraded/Transient-degraded/
  list); problems-first ordering; duration formatting + live-tick (fake timers) +
  omission for `status` source; name-ellipsis + title; `useCheckRuns` lazy-start,
  poll start/stop on `active` toggle + on all-terminal + on `document.hidden`,
  single-flight, 429-stops-loop, eventual-consistency grace, headSha re-fetch +
  abort (fake timers). Hook test arrangement: render with `active=false` → no
  fetch; `active=true` → first fetch; push a non-terminal check, advance timers →
  re-fetch; `active=false` → no further fetch.
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
