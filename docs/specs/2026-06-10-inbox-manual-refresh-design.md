# Inbox manual Refresh button — design

**Issue:** [#311](https://github.com/prpande/PRism/issues/311) — Add a manual Refresh button to the Inbox and PR-detail views.
**Scope of this spec:** the **Inbox** half only. The PR-detail half is split to a follow-up issue (see § Scope & deferrals).
**Tier / Risk:** T3 / gated B1 (UI-visual). No B2 risk surface.

## Problem

PRism's inbox freshness is push-based: `InboxPoller` re-polls GitHub on a schedule and, when the snapshot changes, publishes an `inbox-updated` SSE event; the frontend then surfaces a conditional "N new updates" banner whose Reload calls `useInbox().reload()`. When something *has* changed on GitHub, the poller surfaces it automatically within the cadence (tens of seconds).

The gap is **latency, not access**: a user who *knows* something just changed (they pushed, or a teammate commented) has no way to shorten the wait to the next poll. There is no "pull now" affordance — they wait out the interval. This is an ergonomic wait-reduction, not a missing capability.

## Goal

A visible, always-available **Refresh** control in the inbox toolbar that re-pulls GitHub on demand and **visibly confirms when the pull has completed** — so the user gets closure even when nothing changed (the common case), instead of a silent settle that reads as "broken."

## Chosen approach — semantic C (trigger-and-await)

A "Refresh" button can mean two things, and the cheap one is misleading:

- **(A) Re-read the backend's current view** — call `reload()` (GET `/api/inbox`). Instant, no GitHub cost, but returns the same cached snapshot the schedule already produced. Does not beat the cadence; feels broken when data is identical. **Rejected.**
- **(B) Force the backend to re-poll GitHub now.** The inbox already has the trigger primitive (`InboxPoller.RequestImmediateRefresh()`, used today by `/api/auth/replace`). This is the semantic the issue asks for.

Within (B), two completion models. We choose the **synchronous** one:

> **Semantic C — trigger-and-await:** a new endpoint calls `IInboxRefreshOrchestrator.RefreshAsync(ct)` **directly and awaits it**, returning a terminal status only once the pull has settled. The client then `reload()`s and renders a visible completion confirmation.

Why C over the **async signal-and-forget** variant (call `RequestImmediateRefresh()`, return `202`, let SSE reconcile): the async variant emits **no** signal when nothing changed (`inbox-updated` only fires on `diff.Changed`), so it cannot give the user a completion moment in the common no-change case — exactly the closure this feature exists to provide. C gives a real awaited completion to attach the confirmation to.

> **Alternative considered:** signal-and-return-`202` plus a *new* lightweight "refresh-complete" SSE event that fires even on no-change. That decouples "completion signal" from "connection held open," avoiding the held-request cost — but at the price of a new event type + frontend wiring. Rejected for this slice in favor of the synchronous model's simplicity; revisit if the held-request latency proves problematic.

**Accepted tradeoffs (C):**

- **Held request.** The POST stays open for the GitHub pull (sections + enrichment + CI probe — several serial sub-requests). This is bounded by a **client-side timeout** (see § Frontend → timeout); on timeout the soft-error path re-enables the button so it can never get permanently stuck. The held-request duration also acts as a **natural throttle** — the button is disabled for the whole pull, so a single client cannot exceed ~one pull per pull-duration.
- **Bypasses the poller's per-tick backoff local.** A deliberate manual click pulls even if the *automatic* cadence is currently backing off. Acceptable: it is a low-frequency, user-initiated action on the user's own PAT; GitHub secondary limits target sustained traffic, not single clicks. A cheap client-side **min-interval guard** (ignore re-clicks within ~3 s of the last completion) blunts an impatient repeat-clicker without server state.
- **`_writerLock` serializes, it does not coalesce.** Calling `RefreshAsync` directly is safe against the concurrent poller tick (the orchestrator serializes all refreshes on its `_writerLock` — no corruption). Two *surfaces* refreshing at once (e.g. the desktop shell + a browser tab) would queue back-to-back (≤ a couple of pulls), not 1000 — realistic concurrency on a single-user localhost box is poller + 1–2 surfaces. Server-side single-flight coalescing is **deliberately not built** (out of threat model for a single-user, own-PAT desktop app); noted as a future refinement if multi-surface double-pull ever proves real.

## Architecture & data flow

```
[Refresh button] --click (ignored if within min-interval or in-flight)-->
  useInboxRefresh.refresh()
    --> POST /api/inbox/refresh  (AbortController, ~30s timeout)
          server: before = orch.Current
                  await orch.RefreshAsync(ct)        // _writerLock-serialized; commits _current
          --> 200 OK (no body)                       // pull settled, snapshot committed
              | on RateLimitExceededException:
              |    view advanced past `before`?  (CI-probe 429 commits CI-less; section 429 does not;
              |    a concurrent poller tick may also have advanced it — see contract note)
              |    --> advanced  -> 200               // view is fresh
              |    --> not adv.  -> 503 Problem        // rate-limited AND view stale; soft error, view intact
              | on OperationCanceledException (disconnect): rethrow (framework maps aborted request to a no-op)
              | on any other exception: 503 Problem    // snapshot NOT committed; view intact
    --> on 200:  useInbox().reload()  +  updates.dismiss()  +  announce/confirm "Inbox refreshed"
    --> on 503/abort:  Toast(error, dismissible); button re-enabled; existing view untouched
  (throughout: inbox-loading-bar active; role=status announces "Refreshing inbox…" then "Inbox refreshed")
```

### Backend — `PRism.Web/Endpoints/InboxEndpoints.cs`

New route in `MapInbox`:

```csharp
app.MapPost("/api/inbox/refresh", async (
    IInboxRefreshOrchestrator orch,
    CancellationToken ct) =>
{
    var before = orch.Current;          // reference identity of the committed snapshot
    try
    {
        await orch.RefreshAsync(ct).ConfigureAwait(false);
        return Results.Ok();             // pull settled; new snapshot committed
    }
    catch (RateLimitExceededException)
    {
        // RefreshAsync re-throws a rate-limit. It commits the (CI-less) snapshot BEFORE
        // re-throwing ONLY when the *CI probe* is the thing that 429'd (orchestrator stashes
        // the rate-limit, finishes the snapshot, Volatile.Writes _current, THEN re-throws).
        // A rate-limit on the *primary* section/enrichment pull propagates BEFORE any commit.
        // We can't cheaply prove "*this call* committed" (see Contract note below), so the
        // success test is the weaker, honest one: did the committed view ADVANCE past where it
        // was when the request arrived? If so it is fresh (this call, or a concurrent poller
        // tick) -> 200. If not, the manual pull was rate-limited and nothing got fresher -> 503.
        return ReferenceEquals(orch.Current, before)
            ? Results.Problem(title: "Inbox refresh rate-limited", statusCode: 503, type: "/inbox/refresh-rate-limited")
            : Results.Ok();              // advanced (CI-less or concurrent); ciProbeComplete may be false (flows through GET)
    }
    catch (OperationCanceledException)
    {
        // Client navigated away mid-refresh (RequestAborted). Rethrow per the house
        // convention (every other endpoint does this): ASP.NET Core maps an aborted-request
        // OCE to a no-op without error-level log noise. (NB: a client-timeout abort does NOT
        // cancel the server pull promptly — cancellation is cooperative — so RefreshAsync may
        // still run to commit; see Contract note.)
        throw;
    }
    catch (Exception) // snapshot NOT committed (RefreshAsync threw before Volatile.Write)
    {
        return Results.Problem(title: "Inbox refresh failed", statusCode: 503, type: "/inbox/refresh-failed");
    }
});
```

**Contract note (rate-limit 200/503 + concurrency).** The reference-compare tests "did the committed view advance," **not** "did *this* call commit" — those differ when a background poller tick commits a fresh snapshot in the window between `before = orch.Current` and the manual call acquiring `_writerLock` inside `RefreshAsync`. In that interleaving a manual pull that itself hit a section-level 429 still returns 200, because the view *did* advance (to the poller's snapshot). This is acceptable: the success contract is "the inbox view is fresh," and it is — the user sees current data; the manual call's own rate-limit is subsumed by the poller's, which backs off on its own path. The only 503 case is "rate-limited **and** the view did not advance at all" (genuinely stale), which is correctly surfaced. A client-side timeout aborts the *request* but not the server pull (cooperative cancellation may not land before `Volatile.Write`); a late silent commit is fine — the view only ever gets fresher, never corrupt.

- **No new DI.** `IInboxRefreshOrchestrator` is already a registered singleton (`ServiceCollectionExtensions.cs:80`); the poller injects it.
- **No `InboxPoller` change, no `RefreshAsync` signature change.** Calling the orchestrator directly is what gives the awaitable completion. The poller's next tick diffs against the new `_current`; no desync.
- **`RateLimitExceededException`** is already in scope (`PRism.Core.Inbox`, imported at `InboxEndpoints.cs:3`).
- **Auth precondition.** The endpoint inherits the same not-configured behavior as `GET /api/inbox`: with no PAT stored, `RefreshAsync`'s GitHub calls fail and the generic `catch` returns `503` (view intact) — it never issues anonymous GitHub calls successfully because the client requires the stored PAT. In practice the inbox (and thus the button) only renders once authenticated; this is defense-in-depth. Covered by a test.
- **Middleware.** The POST sits behind the existing `OriginCheckMiddleware` / `SessionTokenMiddleware` / `HostHeaderCheckMiddleware` (registered before `MapInbox`) — no CSRF/host gap. It has **no request body**, so it is added to the body-size-cap `UseWhen` predicate in `Program.cs` as an explicit no-body exclusion (one-line comment), matching the convention for the other mutating POSTs.

### Frontend

- **`frontend/src/api/inbox.ts`** — add `refresh(signal?: AbortSignal): Promise<void>` issuing `POST /api/inbox/refresh` (no body; resolves on empty-2xx via the existing `client.ts` empty-body handling; throws `ApiError` otherwise). The shared client **already** forwards an optional `AbortSignal` to `fetch` (`client.ts` `RequestOptions.signal`), so `refresh()` just passes one through — no client change.
- **`frontend/src/hooks/useInboxRefresh.ts`** (new) — takes `reload` and `updates.dismiss` as arguments (the two effects it composes) and owns the refresh interaction. It justifies extraction by **accreted complexity** beyond a 3-line handler: an `AbortController` + ~30 s timeout, the min-interval guard (last-success timestamp ref), `isRefreshing`, error state, and the completion-announcement text. State/contract:
  - `isRefreshing: boolean`, `announce: string` (drives the live region), `justRefreshed: boolean` (drives the transient confirmation), `refresh(): void`.
  - `refresh()`: no-op if `isRefreshing` **or** within the min-interval of the last **successful** completion; else set `isRefreshing`, set `announce = "Refreshing inbox…"`, POST with an `AbortController` (~30 s timeout); on **success** → `await reload(); dismiss(); announce = "Inbox refreshed"`; **stamp the last-success time** and show the confirmation; on abort/error → surface a Toast and re-enable with **no** min-interval lockout (an immediate retry after a failure must be allowed); `finally` clears `isRefreshing` only.
  - **Timer alignment:** the transient confirmation stays visible for **≥ the min-interval** (both ~3 s) so there is never a window where the button looks idle but a click is silently swallowed by the lockout — the lockout window is always covered by visible feedback.
- **`InboxPage.tsx`** — instantiate `useInboxRefresh(reload, updates.dismiss)`; pass `refresh`/`isRefreshing` into the toolbar; drive the **warm-path** loading bar (`InboxPage.tsx:90`, the instance rendered alongside content — *not* the cold-load one at line 55) with `active={isLoading || isRefreshing}`. Render the always-present visually-hidden `role="status" aria-live="polite"` announcer here (text = the hook's `announce`), a **separate** element from `InboxBanner`'s `role="status"`. On refresh error, use the existing **Toast** system (`useToast().show({ kind: 'error', … })`) — non-blocking and dismissible, leaving the valid view in place (not the blocking `ErrorModal`). `InboxPage` gains the `useToast` import.
- **Render site & placement** — the button renders inside **`FilterBar`** (`FilterBar.tsx`), in the second `barRow`, immediately after the Sort `<label>` (`FilterBar.tsx:82`). `refresh`/`isRefreshing` are threaded `InboxPage → InboxToolbar → FilterBar` (two prop hops; `InboxToolbar` is a passthrough). To keep Sort and Refresh together when the wrap-enabled `.barRow` wraps at narrow container widths, **wrap the Sort `<label>` and the Refresh button in a shared inline-flex container** so they wrap as one unit (flex-wrap wraps items, not loose groups).
- **Button & in-flight treatment** — a circular-arrow icon button with **`className="btn btn-icon"`** (both classes: `.btn` supplies the `inline-flex` centering that `.btn-icon` alone lacks, so the swapped-in spinner is centered, not top-left), `aria-label="Refresh inbox"` (→ `"Refreshing inbox…"` while in flight) and a native `title="Refresh inbox"` for pointer discoverability (the icon has no visible text label). While `isRefreshing`: `disabled`, and the icon is replaced by a **`<Spinner decorative size="sm" />`** (reuses the existing `prefers-reduced-motion` handling; the button/announcer own the state, so the spinner stays decorative to avoid a second live region). One in-flight treatment only — the decorative spinner, not a separate opacity/keyframe.
- **Completion confirmation (sighted users)** — on a successful settle, show a **transient visible confirmation** (e.g. a brief "Refreshed" pill/checkmark near the button that auto-fades after **~3 s**, ≥ the min-interval per the timer-alignment rule above), so the no-change case reads as "done, checked" rather than "nothing happened / broken." It does **not** distinguish "updated" vs "up to date" — the honest claim is "the pull completed"; the actual data delta (if any) is reflected by the reloaded list itself. This is the lighter resolution of the no-change-feedback gap (no `{changed}` discriminator, no `RefreshAsync` signature change).

### Banner & reload interaction

- A manual refresh **dismisses** any pending "N new updates" banner (`updates.dismiss()` after `reload()`) — the user has just pulled, so the banner is moot. Mirrors the existing `onReload` path.
- The post-success `reload()` (a second GET after the POST already did the work) is kept and justified on **reuse** grounds: it is the existing tested fetch path, reuses the single snapshot→DTO serialization site, and resets `useInbox`'s `isLoading`/`error` — *not* on freshness grounds (the freshness guarantee already comes from the POST awaiting the commit). Returning the snapshot in the POST body to save the round-trip was considered and rejected (couples the endpoint to the GET projection / `useInbox` setter for a marginal local-latency gain).

## Testing

**Backend** (`tests/PRism.Web.Tests`):
- `POST /api/inbox/refresh` invokes `RefreshAsync` and returns `200`; `GET /api/inbox` afterward reflects the new snapshot.
- `RateLimitExceededException` **with** snapshot advanced → `200`; **without** advance → `503` (the lying-200 guard — drive the fake to throw without committing vs. commit-then-throw).
- Any other `RefreshAsync` exception → `503`, and `orch.Current` is unchanged.
- No-PAT/not-configured path returns a classified error (no successful anonymous GitHub call).

**Frontend** (`frontend/__tests__` / co-located):
- `inboxApi.refresh()` issues the POST; resolves on empty-200; throws on non-2xx; aborts on signal.
- `useInboxRefresh`: sets `isRefreshing` during the call; calls `reload` + `dismiss` and sets `announce="Inbox refreshed"` on success; surfaces a Toast on error; ignores re-entrant calls and calls within the min-interval **of a prior success**; a failed/aborted refresh re-enables with **no** lockout (immediate retry allowed); aborts + re-enables on timeout.
- Toolbar: Refresh button has the accessible name; is `disabled` (and shows the decorative spinner) while `isRefreshing`; clicking calls `refresh`.
- `InboxPage`: clicking Refresh drives the warm-path loading bar and dismisses a showing banner; the live region announces.

**E2E** (`frontend/e2e/inbox.spec.ts`): click Refresh → `inbox-loading-bar` activates → settles → confirmation shows → button re-enabled. (Visual baselines regenerated as needed; final look is the B1 gate.)

## Scope & deferrals

- **PR-detail Refresh button — deferred to a follow-up issue.** `ActivePrPoller` has **no** immediate-trigger: it runs a single shared `Task.Delay` cadence loop over *all* subscribed PRs, no per-PR signal. Adding "refresh this PR now" needs new signalling infrastructure (and a one-PR-vs-all targeting decision), and the button lands in the PR-detail header that **#291** is actively rethinking for crowding. The follow-up issue carries the `ActivePrPoller` immediate-trigger + the header-button placement (coordinated with #291). File and link it so the inbox-but-not-PR-detail inconsistency window is bounded.
- **Server-side single-flight coalescing** — not built (see Accepted tradeoffs); future refinement if multi-surface double-pull proves real.
- **`{changed}` "updated vs up-to-date" discriminator** — not built; the transient confirmation reports completion, not delta. Avoids an `IInboxRefreshOrchestrator.RefreshAsync` signature change that would ripple into ~10 test setups for marginal copy nuance.
- **Inbox cohesion restyle (#300)** owns the toolbar's final shape/rounding; this issue only *adds* the control, placed so #300's later restyle does not have to fight it.

## Acceptance criteria (this slice)

- [ ] A visible Refresh control exists in the inbox toolbar (controls row, right of Sort), available regardless of whether the SSE update banner is showing.
- [ ] Triggering it genuinely re-pulls GitHub (semantic C): the endpoint awaits `RefreshAsync` and returns `200` only once the pull has settled and the snapshot is committed; the client then `reload()`s.
- [ ] In-progress feedback via the existing warm-path `inbox-loading-bar` + a decorative spinner in the button; the button is disabled while in flight and within the min-interval (coalesces clicks).
- [ ] The pull is bounded by a client-side timeout; on timeout/failure the button re-enables, the existing view stays intact, and a dismissible Toast surfaces — the button can never get permanently stuck.
- [ ] On success, a transient **visible** confirmation appears so the no-change case reads as "done," and completion is announced to AT via a polite `role="status"` region; the button is keyboard-accessible with `aria-label="Refresh inbox"`.
- [ ] A rate-limit that did not advance the snapshot returns `503` (no false "refreshed"); a manual refresh dismisses any showing "N new updates" banner.
- [ ] Verified in light + dark themes with before/after screenshots (B1 visual gate).
