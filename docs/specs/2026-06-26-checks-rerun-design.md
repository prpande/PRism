# Checks tab: per-check re-run (#636)

**Issue:** #636 — Checks tab: re-trigger / re-run checks from PRism. Follow-up to
#138 (PR #635), which shipped the **read-only** Checks tab; re-trigger was deferred
to keep the first slice read-only.
**Tier/Risk:** T3 / **gated B2 (risk-surface)**. Net-new behavior across backend
(new GitHub mutation endpoint + service) and frontend (action UI + poll-loop change),
plus a token-scope doc. B2 because it introduces a **write/mutation surface to
GitHub** and depends on **PAT write scope**. The human spec gate fires after
`ce-doc-review`; the human merge is the backstop.

## Problem

The Checks tab is read-only: `useCheckRuns` polls
`GET /api/pr/{o}/{r}/{n}/checks?sha=…` every 15 s and renders a master-detail view.
When a check fails, the only recourse from PRism is to open `detailsUrl` in GitHub
and re-run it there. #636 asks for a **per-check re-run** action so a reviewer can
re-trigger a check without leaving PRism, with the existing poll converging the new
run's state.

## The issue's premise correction (load-bearing)

The issue says *"Map our `CheckDto.Source` to the right rerun call"* — implying
`Source` distinguishes **check-runs** from **Actions workflow runs**. It does not.
`CheckDto.Source` is `"check-run" | "status"`: it distinguishes the **GitHub Checks
API** from the **legacy commit-status API**. Two facts follow that shape the design:

- **`CheckDto` carries no identifier today** (`Name`, `Status`, `Conclusion`,
  `Source`, `StartedAt`, `CompletedAt`, `DetailsUrl`, `Summary`, `Body`, `AppName`).
  Re-running *anything* requires threading an id through the DTO — an additive
  wire-shape change.
- **Legacy `status`-source checks have no rerun API.** Only `"check-run"` rows are
  ever re-runnable; `"status"` rows are inherently disabled.

## GitHub `rerequest` semantics (verified against the REST docs)

The write path calls `POST /repos/{o}/{r}/check-runs/{check_run_id}/rerequest`.
Confirmed behavior, because it drives the convergence and error designs below:

- **Success is `201`.** (We treat any `2xx` as success — GHES variants may differ.)
- **GitHub does NOT reset the individual check-run.** Per the docs: *"When a check
  run is rerequested, the status of the check **suite** it belongs to is reset to
  queued and the conclusion is cleared. The check run itself is not updated."* GitHub
  forwards a `check_run` `rerequested` webhook to the **App** that created the run;
  the App decides whether and when to re-run and update the run. **Consequence:** the
  individual check-run we poll may stay `completed` for an arbitrary interval (fast
  for GitHub Actions, slow or never for a third-party App that ignores the webhook).
  The UI must NOT assume a guaranteed near-term status transition.
- **`403`** = *"the check run is not rerequestable or doesn't belong to the
  authenticated GitHub App"* — and is **also** the status a token lacking write
  permission gets. It is **overloaded** (non-scope vs scope).
- **`404` / `422`** = the check-run isn't found / isn't in a rerequestable state
  (the raced stale-UI-gate case — the FE "completed" gate is a 15 s-old snapshot, so
  a check that flipped back to running yields `422`).
- **A superseded-but-still-completed check-run id likely returns `2xx`, NOT a 4xx.**
  A check-run id is immutable and survives a head advance; a *completed* run is
  generally still rerequestable, so re-running a 15 s-stale id after the user pushed a
  new commit probably **re-runs the old commit's check** (burns CI on a dead SHA)
  rather than erroring. The REST docs do not promise a 4xx here. This is closed by the
  server-side **SHA guard** (see Error handling).
- The docs **do not state** the exact fine-grained-PAT permission. A classic `repo`
  PAT (what PRism uses) is write-capable and works; we do not assert a precise
  fine-grained permission name in code or copy (see Token-scope documentation).

## Scope (this slice)

- **Per-check re-run only.** A "Re-run" action on the selected check in the
  master-detail panel.
- **NOT in scope (deferred):** "re-run all failed" bulk action (fast-follow once the
  single-check write path is proven; tracked as a follow-up to #636). **Pre-disabling**
  the button from detected token scope (we use attempt-and-surface instead).

## Acceptance criteria

1. The selected check's detail panel shows a **Re-run** control, enabled **only** for
   a re-runnable check: `source === "check-run"` **and** `status === "completed"`
   **and** `checkRunId != null`. For any non-qualifying check it is **disabled with a
   visible reason caption** (legacy status / still running / not re-runnable).
   `status === "completed"` intentionally includes `skipped`/`cancelled` conclusions —
   a non-rerequestable one is gated by GitHub (`403`/`422`) and surfaced via the
   error model below, not pre-filtered.
2. Activating Re-run issues `POST /api/pr/{o}/{r}/{n}/checks/{checkRunId}/rerun?sha=<headSha>`
   (the SHA the check was read under). The backend **SHA-guards** the call (GETs the
   check-run, compares `head_sha`) and, on a match, calls GitHub
   `POST /repos/{o}/{r}/check-runs/{checkRunId}/rerequest`; on a mismatch it returns
   `superseded` without rerequesting.
3. On a `2xx`, the control enters a transient **"Re-running…"** state and the hook's
   **rerun-watch** keeps the poll alive (see Convergence). The control leaves that
   state when **either** the watched check is next observed non-terminal (queued /
   in-progress) **or** the bounded watch window expires. On window-expiry-without-
   transition it re-enables with a neutral note ("Re-run requested — the check
   provider hasn't reported yet"), because a `2xx` only guarantees the webhook was
   sent, not that the App re-ran. The control never hangs disabled indefinitely.
4. Failure is surfaced by a **dedicated write-path outcome** (NOT a reuse of the read
   path's `DegradedFor`):
   - **`auth`** (GitHub `401`) → inline message: "Couldn't re-run — PRism couldn't
     authenticate to GitHub. Reconnect your token."
   - **`not-rerunnable`** (GitHub `403` / `404` / `422`) → inline, scope-agnostic
     message: "Couldn't re-run this check — it may not be re-runnable, or your token
     may lack write access to checks." (`403` is overloaded; this copy avoids sending
     a user with a valid token to needlessly regenerate it, while still naming the
     scope possibility.)
   - **`superseded`** (the SHA guard saw the head advance since the poll) → inline,
     **non-error** note (not the red alert): "The PR was updated — re-run from the
     latest checks." No GitHub rerequest was sent; nothing was wrongly re-run.
   - **`transient`** (`5xx` / network / timeout) → inline message: "Couldn't re-run —
     try again," with a **Retry** affordance.
   No optimistic state is left stranded on any failure; the read poll is unaffected
   and keeps its last-known list.
5. The **required token scope is documented** (rerun needs write; read needs only
   read), and the read path's behavior is unchanged when the token is read-only.

## Architecture

The read path stays untouched and read-only. The write path is a **separate
interface + service + endpoint** that mirrors the reader's substrate (raw
`HttpClient` via the `"github"` named client, closure-injected token) but uses its
**own** response→outcome mapping. Keeping write off `IPrChecksReader` preserves its
read-only contract.

### 1. Wire-shape change (additive, nullable)

- **`CheckDto`** (`PRism.Core.Contracts/CheckDto.cs`) gains `long? CheckRunId` — the
  check-run's GitHub `id`, populated in `GitHubPrChecksReader.ReadCheckRunsAsync`;
  **`null`** on the legacy-status path (`ReadStatusesAsync`). Nullable ⇒ an *optional*
  wire field: typed FE mocks compile unchanged. Per the wire-shape rule, the e2e
  route-mock JSON under `frontend/e2e` is hand-checked regardless (typed mocks are
  enforced by `tsc`, but `route.fulfill` JSON / `as any` fixtures are not).
- **FE `CheckRun`** (`frontend/src/api/types.ts`) gains `checkRunId: number | null`.
- **All `CheckDto` construction sites updated:** `GitHubPrChecksReader` (check-run
  path = `id`, status path = `null`) and the test double `FakePrChecksReader`. The
  `IPrChecksReader` *contract* is unchanged (still read-only, still one method); only
  the `CheckDto` it returns gains a field, so the fake's implementation is updated to
  populate it. STJ serializes positional-record params on write, so the new field
  appears in the GET payload — intended and harmless (additive, nullable).

### 2. Backend write service — new interface, own outcome mapping

- **`IPrChecksRerunner`** (`PRism.Core`):
  ```csharp
  public interface IPrChecksRerunner
  {
      // expectedHeadSha = the SHA the check-run was read under; the impl rejects a
      // mismatch (head advanced since the poll) as `superseded` before rerequesting.
      Task<RerunResultDto> RerunAsync(
          PrReference pr, long checkRunId, string expectedHeadSha, CancellationToken ct);
  }
  ```
- **`RerunOutcome`** (`PRism.Core.Contracts`, kebab-case on the wire per the repo's
  enum convention): `accepted | auth | not-rerunnable | superseded | transient`.
  **`RerunResultDto`** = `record RerunResultDto(RerunOutcome Outcome)`. (Single-field
  wrapper kept deliberately: it gives the endpoint a JSON body to return on the
  200-for-all-outcomes path and room to grow; it does **not** reuse `DegradedReason`,
  whose `Auth/Transient` vocabulary mislabels the write path's overloaded `403`/`422`.)
- **`GitHubPrChecksRerunner`** (`PRism.GitHub`): mirrors `GitHubPrChecksReader`'s
  construction — `IHttpClientFactory` + `Func<Task<string?>>` token closure. Two
  GitHub calls per rerun:
  1. **SHA guard (GET).** `GET /repos/{owner}/{repo}/check-runs/{checkRunId}`, read the
     returned `head_sha`, compare to `expectedHeadSha`. On **mismatch → `superseded`**
     and **do not** rerequest (rerequesting would re-run the dead commit's check). A
     `401`/`403`/`404` on this GET maps like the POST below (`auth`/`not-rerunnable`).
     This is the option-A guard from Error handling.
  2. **Rerequest (POST).** `POST /repos/{owner}/{repo}/check-runs/{checkRunId}/rerequest`
     (owner/repo escaped via `Uri.EscapeDataString`, parity with the #604 audit), **no
     request body** (some GHES versions want `Content-Type: application/json` even on a
     bodyless mutation — set it explicitly to be safe).
  Its **own** status→outcome map (do NOT call `DegradedFor`): `2xx → accepted`;
  `401 → auth`; `403 | 404 | 422 → not-rerunnable`; head-sha mismatch → `superseded`;
  else `→ transient`; thrown `HttpRequestException`/`OperationCanceledException` →
  `transient`, logged at Warning.
- **DI** (`PRism.GitHub/ServiceCollectionExtensions.cs`): register `IPrChecksRerunner`
  as a singleton with the same token-closure shape as the reader.

### 3. Endpoint

`POST /api/pr/{owner}/{repo}/{number:int}/checks/{checkRunId:long}/rerun?sha=<headSha>`
in `PRism.Web/Endpoints/PrDetailEndpoints.cs`:

- Validate `owner`/`repo` against `SharedRegexes.OwnerRepo` → `422` on bad input
  (parity with the GET checks endpoint). `checkRunId` is route-constrained `:long`,
  so a non-numeric id 404s at routing. **`sha`** (the SHA the check was read under) is
  required and validated with `IsValidGitOid` (same as the GET checks route) → `422`
  on absent/malformed; it is passed to `RerunAsync` as `expectedHeadSha` for the guard.
- Inject `IPrChecksRerunner`; call `RerunAsync`; return **`200 OK`** with the
  `RerunResultDto` body (`{ outcome }`) for every outcome the service models — the FE
  branches on `outcome`, mirroring how the read path surfaces a degraded state rather
  than throwing. (`{number}` is path-shape parity with the GET route / routing
  context; the GitHub calls need `owner`, `repo`, `checkRunId`, and `sha` for the
  guard.) The body MUST
  serialize through the **shared API `JsonSerializerOptions`** (kebab-case enum
  policy, `JsonSerializerOptionsFactory`) — the same seam as the GET checks route —
  so `RerunOutcome` emits `not-rerunnable`, not a default-camelCase `notRerunnable`
  the FE union wouldn't match.
- Access control is the **existing** middleware stack — no new gate (see B2 record).

### 4. Frontend

- **API fn** `rerunCheck(prRef, checkRunId, headSha, signal): Promise<RerunResponse>`
  in `frontend/src/api/checks.ts` (posts `?sha=${encodeURIComponent(headSha)}` — the
  series SHA the check was read under, from `useCheckRuns`),
  `RerunResponse = { outcome: RerunOutcome }`. A
  non-`2xx` from **PRism's own** endpoint (e.g. a `401` from `SessionTokenMiddleware`
  on an expired cookie) throws `ApiError` like every other call; the caller maps that
  thrown error to the `transient`/`auth` inline message rather than a modeled outcome.
- **`useCheckRuns`** gains two things, kept distinct:
  - **`refetch(): void`** — an immediate off-timer poll that **bumps a dedicated
    reactive `useState` nonce WITHOUT calling `setStatus('loading')`**, preserving
    stale-while-revalidate (the current list stays rendered). The nonce MUST be a
    `useState` value added to the polling effect's dependency array (sibling to the
    existing `retryNonce`) — **not** a ref, which would not re-run the effect and so
    would not restart a stopped loop. It is **not** an alias of `retry()`; `retry()`
    deliberately sets `loading` to flash the error-screen recovery and must not be
    reused here.
  - **`armRerunWatch(): void`** — sets `rerunWatchUntilRef = Date.now() +
    RERUN_WATCH_MS` (a new bounded window, ~90 s, sibling to `LATE_REGISTRATION_MS`)
    and triggers an immediate `refetch()`. `shouldKeepPolling` gains a leading clause:
    `if (Date.now() < rerunWatchUntilRef.current) return true;` so the loop stays
    alive across the window **even when all checks read terminal** — this is the fix
    for the structural gap where `shouldKeepPolling` returns `false` on all-terminal
    and the loop would otherwise stop, locking the button. The window self-expires;
    a normal non-terminal transition resumes the existing polling logic.
  - **Hidden-tab accounting (single authority).** The hook ticks only while the tab
    is visible (`document.visibilityState === 'visible'`), so a wall-clock-only watch
    would burn down while backgrounded and miss a slow provider's later transition.
    The existing `onVisible` resume handler therefore **re-arms the watch** (pushes
    `rerunWatchUntilRef` out by the unburned remainder, or simply re-arms a full
    window) whenever a rerun is pending and no transition has been observed — so the
    window measures *visible polling opportunity*, not wall-clock. The hook's watch is
    the **single source of truth**: `CheckDetail` derives its "Re-running…" state from
    a hook-exposed signal (the watch being active for the selected check, or the
    check's observed status), and does **not** run an independent `setTimeout`
    deadline of its own — that would diverge from the hook under hide/show.
- **`ChecksTab` / `CheckDetail`**: render the **Re-run** control as a **footer action
  row** in the detail pane, next to the existing "View on GitHub" link (header stays
  read-only). State lives in `CheckDetail` as `rerunState: 'idle' | 'running' |
  'error'` plus an `errorOutcome`.
  - **Enabled** iff `source === "check-run" && status === "completed" && checkRunId
    != null`. Otherwise **disabled with a visible muted caption** (same text style as
    the meta line — NOT a `title`-only tooltip, which is keyboard-/SR-inaccessible):
    `status` source → "Legacy status checks can't be re-run from PRism"; non-completed
    → "Check is still running"; null id → "Not re-runnable".
  - **Click:** set `running`; the button shows label "Re-running…", disabled, with the
    existing row-level **spinner glyph** (`GLYPH_PATH.spinner`, 14×14) prepended — same
    visual vocabulary as an in-progress check row. Call `rerunCheck`; on `2xx`
    `accepted`, call `armRerunWatch()`. On `superseded`, render the neutral note
    (`role="status"`, not the alert) and do **not** arm the watch (nothing was
    re-run). On a modeled failure outcome (or a thrown
    `ApiError`) set `error` + `errorOutcome` and render the inline message **below**
    the button (the summary/body/GitHub link stay visible — it's a status annotation,
    not a blocking error card); `transient` shows a **Retry** affordance (label
    "Retry", matching the existing error card) that **re-invokes `rerunCheck`
    directly** (back to `running` + POST), not merely clearing to `idle` for a second
    manual click.
  - **Leaving `running`:** reset `rerunState` to `idle` when **either** the check's
    `status` becomes non-terminal (a `useEffect` on the selected check's status)
    **or** the hook's rerun-watch goes inactive for that check (the watch expired in
    *visible* time with no transition → the neutral "provider hasn't reported yet"
    note). The deadline is the hook's single watch (above), not a second independent
    `CheckDetail` timer. This prevents the permanently-disabled hang.
  - **Per-check isolation:** `rerunState` must be scoped to the selected check's
    identity, not the panel position — reset to `idle` when the selected check changes
    (a `useEffect` keyed on `checkRunId ?? name`, or `key=` on `<CheckDetail>`).
    Otherwise selecting check A (error) → B → A shows A's stale error. Accepted edge:
    A→B→A while A's rerun is mid-flight loses A's transient "Re-running…" label (resets
    to the eligibility-derived state) — convergence still completes because the hook's
    watch is global and keeps polling; only the per-check button label is non-sticky.
  - **Accessibility / SR:** add a `CheckDetail`-scoped live region for rerun
    announcements (least coupling to the tab-level `announce()` string region):
    `role="status"` for "Re-running <name>" / "<name> re-run requested", and
    **`role="alert"`** for the failure message (immediate, consistent with the
    existing error card's `role="alert"`). Move keyboard focus is unchanged; the
    button keeps focus through the `running`→result transition.

## Error handling (summary)

| GitHub / transport | `RerunOutcome` | FE message |
|---|---|---|
| `2xx` (`201`) | `accepted` | "Re-running…" then watch/converge |
| `401` | `auth` | "…couldn't authenticate to GitHub. Reconnect your token." |
| `403` / `404` / `422` | `not-rerunnable` | "…may not be re-runnable, or your token may lack write access to checks." |
| guard: check-run `head_sha` ≠ read `sha` | `superseded` | "The PR was updated — re-run from the latest checks." (no rerequest sent) |
| `5xx` / network / timeout / thrown | `transient` | "…try again." + Retry |
| PRism-side non-2xx (e.g. expired cookie `401`) | (thrown `ApiError`) | mapped to `auth`/`transient` inline |

The **stale-`checkRunId`** race (head advances between the 15 s poll and the click) is
closed by a **server-side SHA guard** (option A, chosen at the spec gate). Without it,
a stale-but-completed id likely returns `2xx` and re-runs the *superseded commit's*
check — a silent wrong-action (CI burned on a dead SHA while PRism, polling the new
head, shows only "hasn't reported yet"). The guard: the FE passes the SHA the check
was read under; the backend `GET`s the check-run and compares its `head_sha`; on
mismatch it returns `superseded` and **does not rerequest**. Cost is one extra GitHub
`GET` per user-initiated rerun — negligible for an explicit action, and worth keeping a
write surface from acting on the wrong commit. (`useCheckRuns` already aborts the
in-flight series on a SHA change and pulls fresh ids, so the guard mainly catches the
sub-poll-interval window.)

The **eventual-consistency** reality: the immediate `refetch()` after a `2xx` will
very likely still read `completed` (GitHub hasn't processed the rerequest yet, and
never updates the individual run itself). Convergence therefore relies on the
**armed watch window** keeping the poll alive, not on the first refetch — the refetch
is a best-effort early kick, the window is the bound on liveness **measured in visible
polling time** (it is re-armed on `onVisible`; a backgrounded tab does not silently
burn it down).

## Testing

- **`GitHubPrChecksRerunnerTests`** (`tests/PRism.GitHub.Tests`, FakeHttpClientFactory
  + FakeHttpMessageHandler): exact URL + `POST` verb + (no body / explicit
  content-type); `201 → accepted`; `401 → auth`; `403 → not-rerunnable`;
  `404 → not-rerunnable`; `422 → not-rerunnable`; `500 → transient`; thrown
  `HttpRequestException → transient`; owner/repo escaping. **SHA guard:** GET returns a
  **mismatched `head_sha` → `superseded` and the rerequest POST is NEVER fired**
  (assert the POST didn't happen); **matched `head_sha` → proceeds to rerequest**;
  a GET `404`/`403` maps to `not-rerunnable`/`auth`.
- **`ChecksRerunEndpointTests`** (`tests/PRism.Web.Tests`, via a `FakePrChecksRerunner`
  double): `200` + `{outcome:"accepted"}` happy path; `outcome` passthrough for each
  failure (incl. `superseded`); `422` on bad owner/repo **and on absent/malformed
  `sha`**.
- **`GitHubPrChecksReaderTests`**: extend the existing parse test to assert
  `CheckRunId` is set from the check-run `id` and `null` for a legacy status row.
- **FE `ChecksTab.test.tsx`**: button enabled only for a completed check-run row;
  disabled-with-caption for status / in-progress / null-id rows; click calls
  `rerunCheck` and on `accepted` calls `armRerunWatch`; each failure outcome surfaces
  its inline message (and `transient` shows Retry); selecting a different check clears
  a prior error state; the post-success `running` state self-clears on timeout.
- **FE `useCheckRuns.test.ts`**: `refetch()` fetches off-timer **without** flipping
  status to `loading` (list stays rendered); `armRerunWatch()` keeps `shouldKeepPolling`
  true across the window even when all checks are terminal, and the loop stops once
  the window expires with no transition; SHA change still aborts.
- **e2e fake parity (explicit AC):** `FakePrChecksReader` carries a **non-null
  `checkRunId`** on the failing/`check-run` row (so the enabled-button path is
  exercised) and **`null`** on a `status`-source row (so the disabled path is
  exercised). Hand-grep `frontend/e2e` route mocks for `checks` JSON and add
  `checkRunId`.

## Token-scope documentation

Rerun requires a **write-capable** token; the read path needs only read:

- **Classic PAT:** `repo` (covers both check read and `rerequest`). This is the token
  PRism is configured with, so rerun works in practice.
- **Fine-grained PAT:** requires write access to checks (and, for some
  Actions-backed runs, Actions). The GitHub REST docs do not pin a single permission
  name for this endpoint, so the doc points users to grant **write** access for
  checks/Actions and verify in GitHub's PAT permission UI rather than asserting an
  exact string we can't verify.

Document this wherever PRism already documents PAT scopes (the `GitHubAuthValidator`
`RequiredScopes` neighborhood and/or the README/setup scope section — located during
implementation). We do **not** add a write scope to `RequiredScopes`: that would make
a read-only token fail connect-time validation and break the read-only Checks tab for
users who never re-run. The write requirement is surfaced at point-of-use (the
`auth` / `not-rerunnable` messages), not enforced at connect.

## Risk classification (B2 record)

- **Surface touched:** new GitHub **mutation** endpoint + dependence on **PAT write
  scope**. This is the security/write surface in the Axis-B table.
- **Access control (explicit baseline for future reviewers):** the new `POST`
  endpoint is covered by the **existing** app-wide middleware stack —
  `OriginCheckMiddleware` (loopback-origin enforcement) and `SessionTokenMiddleware`
  (per-process session token) — the same gate as every other mutating endpoint. No
  new auth path is added. **`checkRunId` is deliberately NOT validated against the
  PR's own check list**; the trust invariant is that the middleware restricts callers
  to the local user, who already holds the PAT and has equivalent direct GitHub API
  access, so an arbitrary `checkRunId` confers no capability the user lacks. If PRism
  ever moves to a multi-user or network-accessible mode, this invariant must be
  re-examined (it is the documented baseline to diff against).
- **Not touched:** no token *storage* change, no PAT-scope *validation-logic* change
  (we deliberately do **not** extend `RequiredScopes`), no reviewer-atomic submit
  pipeline, no `state.json`/persisted-schema migration, no cross-tab stamp, no sidecar
  seam. The wire-shape change is additive and nullable.
- **Disposition:** **gated B2.** Pause for the human spec review after the two
  `ce-doc-review` passes, before `writing-plans`. PR body carries `## Proof` with the
  secrets scan and the new-tests-first record.

## Rejected alternatives

- **Actions-specific rerun** (`POST /actions/runs/{run_id}/rerun[-failed-jobs]`,
  `run_id` parsed from `detailsUrl`): only covers GitHub Actions, leaves third-party
  check-runs (CircleCI, etc.) with no action, and relies on fragile `detailsUrl`
  parsing or an extra round-trip. The check-run `rerequest` path is uniform across any
  GitHub App check.
- **Check-suite `rerequest`** (`/check-suites/{id}/rerequest`): reruns the whole
  suite — wrong granularity for a per-check action.
- **Write method on `IPrChecksReader`:** breaks the reader's read-only contract and
  grows every read fake. A separate `IPrChecksRerunner` is single-responsibility.
- **Reuse `DegradedReason` / `DegradedFor` on the write path:** its `Auth/Transient`
  vocabulary mislabels `rerequest`'s overloaded `403`/`422` (a valid-token user gets
  told to regenerate their token; a `422` gets a futile "Try again"). A dedicated
  `RerunOutcome` is the fix — the same reason #138 introduced `DegradedReason` in the
  first place.
- **Pre-disable from detected scope:** unreliable for fine-grained PATs (their
  permission set isn't exposed the way classic scopes are in `X-OAuth-Scopes`);
  attempt-and-surface is honest and far less plumbing.
- **No SHA guard (REJECTED at the gate):** an earlier draft deferred the guard on the
  false premise that a stale id self-messages as `not-rerunnable`; round-2 review
  established it likely `2xx`-reruns the wrong commit, so the **guard is adopted**
  (option A, Error handling). The no-guard / client-only-check variant (option B) was
  rejected: it leaves a real wrong-commit window on a write surface, which the one
  extra `GET` cheaply eliminates.

## Open question to resolve in copy (not a blocker)

For a **GitHub Actions**-backed check-run, does `rerequest` re-run the whole workflow
or only that job? The button says "Re-run" the selected check; if GitHub re-runs the
whole suite/workflow the copy may want to set that expectation. Resolve during
implementation when the live behavior can be observed; it affects button/tooltip copy
only, not the mechanism.
