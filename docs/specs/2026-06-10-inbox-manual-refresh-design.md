# Inbox manual Refresh button — design

**Issue:** [#311](https://github.com/prpande/PRism/issues/311) — Add a manual Refresh button to the Inbox and PR-detail views.
**Scope of this spec:** the **Inbox** half only. The PR-detail half is split to a follow-up issue (see § Scope & deferrals).
**Tier / Risk:** T3 / gated B1 (UI-visual). No B2 risk surface.

## Problem

PRism's inbox freshness is push-based: `InboxPoller` re-polls GitHub on a schedule (`config.polling.inboxSeconds`) and, when the snapshot changes, publishes an `inbox-updated` SSE event; the frontend then surfaces a conditional "N new updates" banner whose Reload calls `useInbox().reload()`. A user who *knows* something changed on GitHub (they just pushed, or a teammate commented) has **no way to pull it now** — if no SSE event has fired, there is no visible affordance, and they must wait out the poll interval.

## Goal

A visible, always-available **Refresh** control in the inbox toolbar that genuinely re-pulls GitHub on demand and reports honestly when it is done — including the common "checked, nothing new" case.

## Chosen approach — semantic C (trigger-and-await)

A "Refresh" button can mean two things, and the cheap one is misleading:

- **(A) Re-read the backend's current view** — call `reload()` (GET `/api/inbox`). Instant, no GitHub cost, but returns the same cached snapshot the schedule already produced. Does not beat the cadence; feels broken when data is identical. **Rejected** — it does not satisfy "reload faster than the scheduled auto refresh."
- **(B) Force the backend to re-poll GitHub now.** The inbox already has the trigger primitive: `InboxPoller.RequestImmediateRefresh()` (used today only by `/api/auth/replace`). This is the semantic the issue asks for.

Within (B) there are two completion models. We choose the **synchronous** one:

> **Semantic C — trigger-and-await:** a new endpoint calls `IInboxRefreshOrchestrator.RefreshAsync(ct)` **directly and awaits it**, returning `200` only once the fresh snapshot is committed. The client then `reload()`s and gets guaranteed-fresh data.

Why C over the async signal-and-forget variant:

- **Honest feedback.** The HTTP request stays open for the duration of the real GitHub pull, so the in-progress indicator reflects actual work — not a guessed timer. The no-change case still returns `200` ("done, nothing new"), which the async variant cannot signal (it emits no SSE when nothing changed).
- **Guaranteed freshness.** `GET /api/inbox` reads the orchestrator's committed `_current` snapshot, so a `reload()` *after* the awaited refresh is guaranteed to see the new data — no SSE race.
- **Natural coalescing.** Disabling the button while the request is in flight prevents a single client from stacking calls, satisfying the debounce/coalesce criterion without new server state.

**Accepted tradeoffs (C):**

- The endpoint bypasses the poller's per-tick rate-limit backoff *local* (`nextDelay`), so a deliberate manual click pulls even if the automatic cadence is currently backing off. This is acceptable: a manual refresh is a low-frequency, user-initiated action, and GitHub's secondary rate limits target sustained traffic, not single clicks. If GitHub *does* rate-limit the pull, `RefreshAsync` re-throws `RateLimitExceededException` **after** committing the (CI-less) snapshot — the endpoint catches it and still returns `200`, and the existing `ciProbeComplete=false` UI path carries the degraded state.
- Calling `RefreshAsync` directly is safe against the concurrent poller tick: the orchestrator serializes all refreshes on its `_writerLock`. Two concurrent manual refreshes (e.g. two browser tabs) queue back-to-back rather than truly coalescing on the server; this is an accepted minor edge — single-client stacking is already prevented, and server-side single-flight coalescing is a possible future refinement, not built now (YAGNI).

## Architecture & data flow

```
[Refresh button] --click-->
  useInboxRefresh.refresh()
    --> POST /api/inbox/refresh
          server: await orch.RefreshAsync(ct)   // _writerLock-serialized; commits _current
          --> 200 OK (no body)                   // or 200 on RateLimitExceededException (snapshot committed)
                                                 // or 503 Problem on real failure (snapshot NOT committed)
    --> on 200: useInbox().reload()  +  updates.dismiss()
    --> on failure: soft inline error; button re-enabled
  (throughout: inbox-loading-bar active; role=status announces "Refreshing inbox…" then "Inbox refreshed")
```

### Backend — `PRism.Web/Endpoints/InboxEndpoints.cs`

New route in `MapInbox`:

```csharp
app.MapPost("/api/inbox/refresh", async (
    IInboxRefreshOrchestrator orch,
    CancellationToken ct) =>
{
    try
    {
        await orch.RefreshAsync(ct).ConfigureAwait(false);
        return Results.Ok();
    }
    catch (RateLimitExceededException)
    {
        // RefreshAsync commits the (CI-less) snapshot BEFORE re-throwing to signal
        // backoff. From the user's perspective the refresh succeeded — the inbox view
        // advanced; ciProbeComplete=false flows through GET /api/inbox as it does today.
        return Results.Ok();
    }
    // OperationCanceledException (client disconnect) propagates — no response needed.
    // Any other exception = snapshot NOT committed (RefreshAsync threw before Volatile.Write)
    // → 503 so the client surfaces a soft failure and leaves the stale view in place.
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        return Results.Problem(title: "Inbox refresh failed", statusCode: 503, type: "/inbox/refresh-failed");
    }
});
```

- **No new DI.** `IInboxRefreshOrchestrator` is already registered (the poller injects it).
- **No `InboxPoller` change.** We do not use `RequestImmediateRefresh()` here — calling the orchestrator directly is what gives us the awaitable completion. The poller's next tick simply diffs against the new baseline `_current`; no desync.
- **Cold start:** if `orch.Current` is null (no snapshot yet), `RefreshAsync` builds the first snapshot from null — no special-casing needed.

### Frontend

- **`frontend/src/api/inbox.ts`** — add `refresh(): Promise<void>` issuing `POST /api/inbox/refresh` (no body; resolves on 2xx, throws `ApiError` otherwise).
- **`frontend/src/hooks/useInboxRefresh.ts`** (new) — owns `isRefreshing` + `error`. `refresh()`:
  1. guard: no-op if already `isRefreshing`;
  2. set `isRefreshing`; POST;
  3. on success → caller's `onRefreshed()` (which does `reload()` + `updates.dismiss()`);
  4. on failure → set `error`;
  5. finally → clear `isRefreshing`.
  It does **not** own `reload`/`dismiss` — those are passed in, keeping the hook decoupled from `useInbox`.
- **`InboxPage.tsx`** — instantiate `useInboxRefresh`, pass `refresh`/`isRefreshing` down to the toolbar; drive the existing loading bar with `active={isLoading || isRefreshing}`. On refresh error, render the shared soft-error treatment (a dismissible inline message; not the blocking `ErrorModal`, since the existing view is still valid).
- **`FilterBar.tsx` / `InboxToolbar.tsx`** — render the Refresh control at the **right end of the controls row, after the Sort dropdown**. Circular-arrow icon button (`btn-icon`), `aria-label="Refresh inbox"`, `disabled={isRefreshing}`, with a subtle in-progress treatment (e.g. reduced opacity / spin) while disabled. At narrow container widths the controls row may wrap; the button stays with the Sort control.
- **A11y** — a visually-hidden `role="status" aria-live="polite"` region (mirroring `InboxBanner`/`BannerRefresh`) announces `"Refreshing inbox…"` on start and `"Inbox refreshed"` on completion. The `LoadingBar` itself stays `aria-hidden` (visual only) as today.

### Banner interaction

A manual refresh **dismisses** any pending "N new updates" banner (`updates.dismiss()` after `reload()`), because the user has just pulled fresh data — the banner is moot. This mirrors the existing `onReload` path (`reload()` + `dismiss()`).

## Testing

**Backend** (`tests/PRism.Web.Tests`):
- `POST /api/inbox/refresh` invokes `RefreshAsync` and returns `200`; `GET /api/inbox` afterward reflects the new snapshot (fake orchestrator/review records the call).
- `RateLimitExceededException` from `RefreshAsync` → endpoint returns `200` (snapshot committed path).
- A non-rate-limit failure → `503` Problem.

**Frontend** (`frontend/__tests__` / co-located):
- `inboxApi.refresh()` issues the POST; resolves on 200, throws on non-2xx.
- `useInboxRefresh`: sets `isRefreshing` true during the call; calls `onRefreshed` on success; sets `error` on failure; ignores re-entrant calls while in flight.
- Toolbar: Refresh button has the accessible name; is `disabled` while `isRefreshing`; clicking calls `refresh`.
- `InboxPage`: clicking Refresh drives the loading bar and dismisses a showing banner.

**E2E** (`frontend/e2e/inbox.spec.ts`): click Refresh → `inbox-loading-bar` activates → settles → button re-enabled. (Visual baselines regenerated as needed; final look is the B1 gate.)

## Scope & deferrals

- **PR-detail Refresh button — deferred to a follow-up issue.** `ActivePrPoller` has **no** immediate-trigger: it runs a single shared `Task.Delay` cadence loop over *all* subscribed PRs, with no per-PR signal. Adding "refresh this PR now" needs new signalling infrastructure (and a one-PR-vs-all targeting decision), and the button lands in the PR-detail header that **#291** is actively rethinking for crowding. Bundling it here would balloon the slice and fight in-flight work. The follow-up issue carries the `ActivePrPoller` immediate-trigger + the header-button placement (coordinated with #291).
- **Server-side coalescing of concurrent manual refreshes** (single-flight across tabs) — not built; single-client stacking is already prevented by the in-flight disable, and the `_writerLock` already serializes. A future refinement if multi-tab double-pull proves to matter.
- **Inbox cohesion restyle (#300)** owns the toolbar's final shape/rounding; this issue only *adds* the control. The button is placed so #300's later restyle does not have to fight it.

## Acceptance criteria (this slice)

- [ ] A visible Refresh control exists in the inbox toolbar (controls row, right of Sort), available regardless of whether the SSE update banner is showing.
- [ ] Triggering it genuinely re-pulls GitHub (semantic C): the endpoint awaits `RefreshAsync` and returns `200` only once the fresh snapshot is committed; the client then `reload()`s.
- [ ] In-progress feedback via the existing `inbox-loading-bar`; the button is disabled while a refresh is in flight (coalesces single-client clicks).
- [ ] A real failure leaves the existing view intact and surfaces a soft, dismissible error (not a blocking modal).
- [ ] Keyboard-accessible with `aria-label="Refresh inbox"`; completion announced via a polite `role="status"` region.
- [ ] A manual refresh dismisses any showing "N new updates" banner.
- [ ] Verified in light + dark themes with before/after screenshots (B1 visual gate).
