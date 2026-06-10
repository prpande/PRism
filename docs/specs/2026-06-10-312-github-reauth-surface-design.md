# #312 — Mid-session GitHub credential-invalid re-auth surface

**Issue:** [#312](https://github.com/prpande/PRism/issues/312) — "Mid-session GitHub PAT revocation/expiry has no re-auth surface (app degrades silently)"
**Date:** 2026-06-10
**Tier / Risk:** T3 · gated **B2** (auth/token surface) + **B1** (new visible banner)
**Worktree / branch:** `D:\src\PRism-312-reauth-surface` / `feature/312-reauth-surface`

---

## 1. Problem

When the stored GitHub PAT is revoked, expires, or loses required scope **while the app is running**, PRism has no surface that tells the user to re-authenticate. Every GitHub-backed feature degrades silently:

- `InboxPoller` catches the failure in a generic `catch (Exception)` and degrades to "retry next cadence" (`PRism.Core/Inbox/InboxPoller.cs:69`) — stale/empty inbox, no prompt.
- Direct GitHub-backed requests (PR-detail load, draft fetch) propagate the GitHub failure as an unhandled `HttpRequestException`, which the Web layer surfaces as **HTTP 500** — not 401. So the existing frontend reconnect path (`apiClient` → `prism-auth-rejected` on a 401 → `App.isAuthed`) **never fires** for a GitHub credential failure. That path only triggers on a PRism **session-cookie** 401 from `SessionTokenMiddleware`. (Note: some user-facing GitHub-backed endpoints *catch* the failure and remap it to a typed 4xx rather than letting it bubble to 500 — see § 7.2, which is why the foreground trigger does not rely on 500 alone.)
- The only GitHub-401 → `InvalidToken` interpretation (`GitHubReviewService.ValidateCredentialsAsync` → `InterpretAsync`, `PRism.GitHub/GitHubReviewService.cs:69-203`) runs **only at token connect/replace time**, never during normal operation.
- `/api/auth/state` reports only `HasToken` (a token is *stored*) — never whether it is still *valid* (`PRism.Web/Endpoints/AuthEndpoints.cs:26-39`, `AuthDtos.cs:5`).

**Net effect:** a dead PAT mid-session = the app looks quietly broken (empty inbox, failed PR loads) with no "Reconnect GitHub" affordance.

### Correction to the issue's framing

The issue says the global reconnect path "fires only on a session-cookie 401, not on a GitHub PAT 401." True, but the operative reason a GitHub 401 is invisible is that it is **masked** before it reaches the client as an actionable status (as a 500 on the unhandled path, or remapped to a typed 4xx on the handled paths). Detection therefore cannot piggyback on the existing 401 plumbing — it must happen at the GitHub transport seam. This also means the **inbox** (the headline degraded surface) never produces a failing client request the user is waiting on: it degrades on a background poller that catches-and-swallows. Any "map the failed request to a 401" approach is structurally incomplete.

## 2. Goals

1. A mid-session GitHub **401** (revoked / expired / bad-credentials PAT) produces a visible, **app-level** re-auth prompt — not just per-feature quiet degradation.
2. Transient **403 / 429 / transport / 5xx** failures do **not** trigger the prompt (no false "reconnect").
3. The prompt routes to the **existing** token replace flow (`/setup?replace=1`); no fine-grained-PAT steering (classic-PAT lineage, #213).
4. Inbox + PR-detail + (future) activity rail all feed **one** signal — no per-surface carve-out. (This is why #137's activity-rail re-auth was deferred here.)

## 3. Non-goals

- Mid-session **scope-loss** (a GitHub `403`, including a token that still authenticates but lost a scope — GraphQL returns `200`-with-errors for this, not `401`) detection. Ambiguous with SSO/rate-limit; stays a quiet degrade this slice. Follow-up candidate (§ 11).
- Re-validating the token proactively on a timer / heartbeat. Detection is **reactive** — it rides real GitHub traffic.
- Changing `InboxPoller`'s degrade behavior. The poller keeps degrading; the new signal rides *underneath* it (the transport handler) and explains *why* to the user.
- Persisting credential-health across restarts. It is live process state; a restart re-validates on the first GitHub call.
- The SSE-push ("prompt even while fully idle") variant. Explicitly rejected in favor of poll/refetch (§ 10, Approach A).

### Accepted limitation (Approach A)

In the **fully-idle** case — the PAT dies while the user sits on an already-loaded inbox with no interaction and no window-focus change — the banner surfaces only on the next focus or triggered refetch (§ 7.2). The headline complaint (silent degradation) is therefore *fully* closed for active users and *bounded* (not instant) for idle ones. This is the deliberate cost of skipping SSE-push (§ 10). The owner accepts this at the spec gate; if idle latency is felt in practice, the SSE-push follow-up (§ 11) closes it.

## 4. Acceptance criteria

- [ ] A mid-session GitHub 401 on **any** GitHub-backed call (inbox poll, PR load, draft fetch) flips a server-side credential-invalid latch.
- [ ] `GET /api/auth/state` reports the latch as `githubCredentialInvalid: boolean`.
- [ ] The frontend renders a **red/danger, non-dismissible** app-level banner (mirroring `StreamHealthSnackbar`'s *appearance*, but persistent — no `×`) whenever `hasToken && githubCredentialInvalid`. In the **background/idle** case, surfacing is bounded by the next window-focus or triggered refetch (Approach A, § 10) — it is **not** instantaneous, by design.
- [ ] The banner's **Reconnect** action routes to `/setup?replace=1`. "Non-dismissible" means the *user* cannot close it — it still auto-closes when the credential becomes valid (committing a valid token, or the auto-clear in the next criterion). The replace flow's validate-before-swap (existing) refuses an invalid token, so the user cannot clear the banner with a bad one.
- [ ] A single transient `401`, or any `403 / 429 / 5xx / transport` failure, does **not** flip the latch (no false banner) — the latch flips only on **2 consecutive** authenticated 401s (§ 6.1).
- [ ] The latch **auto-clears** on the next successful *authenticated* GitHub call, and clears immediately on a successful connect-commit / replace.
- [ ] A bad **candidate** token during connect/replace validation does **not** flip the latch for the still-stored token (all candidate-token probe paths opt out).
- [ ] A successful token **replace** does not leave a residual false-invalid latch even if an old-token request was in flight across the swap (epoch guard, § 6.2).
- [ ] The re-auth banner is **suppressed while the SSE stream is unhealthy** (connection-loss takes precedence) **and on the `/setup` route** (the page that fixes it).
- [ ] While the credential is invalid, `/setup?replace=1` is **exit-gated**: navigating away redirects back until a valid token is committed (the user can only leave once re-auth succeeds).
- [ ] The latch engages for **github.com** hosts only this slice; GHES requests pass through without flipping it (§ 11).

## 5. Architecture overview

```
GitHub API ──401/2xx──▶ GitHubAuthHealthHandler (DelegatingHandler on "github" client)
                              │ (epoch-guarded, auth-header-gated)
                              │ 401×2 → invalid          2xx → MarkValid()
                              ▼
                    IGitHubCredentialHealth  (PRism.Core singleton: IsInvalid, Epoch)
                              │  read
                              ▼
                    GET /api/auth/state  → { …, githubCredentialInvalid }
                              │
   refetch triggers:         ▼
   focus / identity / reconnect / **failed-request (debounced)**
                              ▼
                    useAuth().authState.githubCredentialInvalid
                              ▼
   GitHubAuthBanner (red Snackbar)  ── Reconnect ──▶ /setup?replace=1
        (suppressed while !streamHealthy, and on /setup)
```

A single chokepoint (the handler on the one named `"github"` HttpClient that all 19 GitHub call sites share — verified: 18 `CreateClient("github")` sites + 1 separate feedback client) feeds the signal; everything else reads it.

## 6. Backend design

### 6.1 `IGitHubCredentialHealth` (PRism.Core)

New singleton, minimal and thread-safe:

```csharp
namespace PRism.Core.Auth;

public interface IGitHubCredentialHealth
{
    bool IsInvalid { get; }
    int  Epoch     { get; }    // bumped on every token change; see § 6.2 race guard
    void RecordAuthFailure();  // handler, on an authenticated 401: ++counter; flips IsInvalid at the threshold
    void MarkValid();          // handler 2xx OR endpoint commit: counter→0, IsInvalid→false
    void BumpEpoch();          // endpoint commit (token changed)
}
```

**Consecutive-401 threshold (debounce against transient/false 401s).** Because the banner is now **non-dismissible** (§ 7.4), a single spurious 401 on a genuinely-valid token would otherwise force the user through an unnecessary re-auth with no escape — a real cost flagged by the adversarial + security reviews. The latch therefore flips invalid only after **`THRESHOLD = 2` consecutive** authenticated 401s with no intervening authenticated 2xx. `RecordAuthFailure()` increments an internal counter and sets `IsInvalid` once it reaches the threshold; `MarkValid()` resets the counter to 0 and clears `IsInvalid`. A genuinely dead token 401s on *every* call, so the second consecutive failure (next poll tick or retry) flips it within one cadence — detection stays prompt; a lone transient blip that is followed by any 2xx never flips. (This does not reopen the dismiss-and-forget hole — it is non-dismissible either way; it only filters the false-trigger.)

Default implementation backs the state with a small lock so `IsInvalid`, `Epoch`, and the counter stay coordinated. Initial state: **valid** (`IsInvalid == false`, `Epoch == 0`, counter `== 0`).

**Premise (stated, load-bearing):** credential health is modeled **process-global** because PRism stores exactly one GitHub token per process and all windows/tabs share it via the same `/api/auth/state`. One surface's masked 401 correctly raises the banner in every window — intended. If PRism ever goes multi-account (per-window token), the latch must become per-token.

No persistence. The methods track current state; an **edge transition** is any actual `IsInvalid` change (false→true or true→false) regardless of call site (handler or endpoint). Logging fires **once per edge** by comparing state before vs after the call (valid→invalid at Warning, invalid→valid at Information) — so an explicit `MarkValid()` (§ 6.4) followed by a handler `MarkValid()` on the next 2xx does not double-log. The log line carries only the transition direction and a timestamp — **never** request URL, headers, or any token fragment.

### 6.2 `GitHubAuthHealthHandler : DelegatingHandler` (PRism.GitHub)

Registered on the named `"github"` client (the handler type also needs its own DI registration so `AddHttpMessageHandler<>()` can resolve it):

```csharp
services.AddTransient<GitHubAuthHealthHandler>();
services.AddHttpClient("github", …)
        .AddHttpMessageHandler<GitHubAuthHealthHandler>();   // ServiceCollectionExtensions.cs:33
```

(The feedback client — `GitHubFeedbackSubmitter.ClientName`, a separate registration targeting the feedback repo — is intentionally **not** wired; its one-off 401s have their own error surface and must not raise an app-level GitHub re-auth banner. Pinned by a negative test, § 9.)

Behavior, capturing the epoch around the inner send to defeat the in-flight-old-token race:

```csharp
protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
{
    var epochBefore = _health.Epoch;
    var resp = await base.SendAsync(req, ct).ConfigureAwait(false);

    // Opt-out: candidate-token validation probes (§ 6.3) never touch the latch.
    if (req.Options.TryGetValue(SkipHealthKey, out var skip) && skip) return resp;
    // Only authenticated requests carry signal about the *stored* token's validity.
    if (req.Headers.Authorization is null) return resp;
    // This slice scopes detection to github.com; a GHES 401 can be resource-authz,
    // not credential-invalidity, and would false-trigger a non-dismissible banner (§ 11).
    if (!HostUrlResolver.IsGitHubDotCom(req.RequestUri)) return resp;

    if (resp.StatusCode == HttpStatusCode.Unauthorized)
    {
        // Ignore a 401 from a token that was already replaced mid-flight (epoch moved).
        if (_health.Epoch == epochBefore) _health.RecordAuthFailure();   // flips invalid at THRESHOLD
    }
    else if (resp.IsSuccessStatusCode)
    {
        _health.MarkValid();   // resets the consecutive-401 counter and clears invalid
    }
    return resp;
}
```

| Outcome | Action |
|---------|--------|
| `401`, auth header present, epoch unchanged | `RecordAuthFailure()` — flips `IsInvalid` only on the **2nd consecutive** such 401 |
| `401`, epoch changed during the request (a replace landed) | **ignored** (stale old-token 401) |
| `2xx`, auth header present | `MarkValid()` (resets the 401 counter) |
| no `Authorization` header (unauthenticated/public call) | no-op (can't speak to the stored token) |
| non-github.com host (GHES) | no-op this slice (§ 11) |
| `skip` option set (validation probe) | no-op |
| `403 / 429 / other non-2xx` | no-op |
| transport exception from `base.SendAsync` | no-op (rethrow unchanged) |

The handler **never** alters the response or throws — it observes and passes through. It does not read the body (no stream consumption); `StatusCode == 401` is the whole signal.

**Why `401` is the clean discriminator:** GitHub (github.com) returns `401` only for bad/missing/revoked/expired credentials. Rate-limiting is `403`/`429`; SAML SSO enforcement is `403`. So `401` unambiguously means "the token is bad" → actionable as re-auth. The two guards above (auth-header-present, epoch-unchanged) keep an *unauthenticated* 2xx from falsely clearing a real invalid latch and a *superseded-token* 401 from falsely setting one. See § 11 for the GHES-edge caveat.

### 6.3 Validation opt-out (candidate-token guard) — all probe paths

`/api/auth/connect` and `/api/auth/replace` probe GitHub with a **candidate** transient token through the same `"github"` client. A bad candidate must not latch the **stored** token as invalid. The probe sets the opt-out on its `HttpRequestMessage`:

```csharp
req.Options.Set(SkipHealthKey, true);  // SkipHealthKey = new HttpRequestOptionsKey<bool>("prism-skip-credential-health")
```

**Thread the opt-out as a parameter, do not hardcode it inside `ValidateCredentialsAsync`.** That method has **three** callers, not two (feasibility-verified):
- `/api/auth/connect` and `/api/auth/replace` — **candidate** token → **skip** (pass `skipCredentialHealth: true`).
- `ViewerLoginHydrator` (`ViewerLoginHydrator.cs:60`) — validates the **stored, committed** token at startup → must **NOT** skip. A dead stored token here *should* latch invalid so the banner shows on launch (this is a *feature* — startup detection). Pass `skipCredentialHealth: false` (the default).

So `ValidateCredentialsAsync(bool skipCredentialHealth = false, …)` sets the request option from the parameter. The fine-grained-token follow-up probes invoked *during candidate validation* (repo-visibility / search probes around `GitHubReviewService.cs:217`) inherit the same candidate context and also set the skip option. Hardcoding the option at the request-build site (the earlier draft's "set it at line 77") would wrongly suppress the hydrator's stored-token signal.

Negative tests (§ 9): a bad **candidate** during connect/replace does **not** flip the latch; a dead **stored** token at hydrator startup **does**.

### 6.4 Explicit clear + epoch bump on successful (re)connect

On a successful validate+commit (connect or replace), the endpoint calls `BumpEpoch()` **then** `MarkValid()`:

- `BumpEpoch()` invalidates any in-flight old-token request: a 401 from the just-replaced token arrives with `epochBefore < CurrentEpoch` and is ignored (§ 6.2).
- `MarkValid()` clears the latch **immediately**, rather than waiting for the next GitHub 2xx.

Call sites: `/api/auth/connect` success-commit (`AuthEndpoints.cs:88`), `/api/auth/connect/commit`, and `/api/auth/replace` success-commit.

**Latch-clear is validation-gated (mandatory-valid guarantee).** `BumpEpoch()`/`MarkValid()` are called from **only** these post-validation commit paths and the handler's authenticated-2xx branch — never from a path that commits a token without a successful GitHub probe. Verified: `/api/auth/replace` rolls back the candidate and returns `BadRequest` *before* any `CommitAsync` when validation fails (`AuthEndpoints.cs:233-240,279`), so an invalid token can never reach commit and therefore never clears the latch. A negative test pins this: `/api/auth/replace` with a bad token leaves `githubCredentialInvalid == true` (§ 9). This is what makes "the user cannot proceed out of the degraded state with a bad token" (§ 7.4) true rather than asserted.

**Why this is not redundant with auto-clear-on-2xx (rejected scope-guardian removal):** `SetupPage` `await refetch()`s `/api/auth/state` immediately after a successful replace. If the latch were cleared only by the *next* GitHub 2xx (a poll cadence away), that refetch would read `githubCredentialInvalid: true` and **flash the red banner on top of the success the user just achieved**. The explicit `MarkValid()` on commit closes that window. Auto-clear-on-2xx remains as the belt-and-suspenders backstop for any other recovery path.

### 6.5 `/api/auth/state` surfacing

Inject `IGitHubCredentialHealth` into the `GET /api/auth/state` delegate (`AuthEndpoints.cs:26`) and extend the DTO:

```csharp
internal sealed record AuthStateResponse(
    bool HasToken, string Host, AuthHostMismatch? HostMismatch, bool GithubCredentialInvalid);
```

PascalCase record property `GithubCredentialInvalid` serializes to `githubCredentialInvalid` via the existing camelCase JSON policy (same as `HasToken`→`hasToken`). No new endpoint; no new event.

## 7. Frontend design

### 7.1 `AuthState` + `useAuth`

- `frontend/src/api/types.ts:74` — add `githubCredentialInvalid: boolean;` to `AuthState`.
- `frontend/src/hooks/useAuth.tsx` — the flag rides the existing `authState`; no new fetch. Add **one** refetch trigger: a `prism-request-failed` window event, **debounced** (~750ms; named constant at plan time). Existing triggers (focus / `prism-identity-changed` / `prism-events-reconnected`) are unchanged. Note `prism-events-reconnected` already refetches on SSE reconnect — this is what re-surfaces the snackbar after the stream-unhealthy suppression (§ 7.4) lifts.

### 7.2 `apiClient` request-failure signal (not 5xx-only)

`frontend/src/api/client.ts` — in the `if (!resp.ok)` block (line 67), after the existing 401 handling, dispatch a refetch signal on **any** failed response:

```ts
window.dispatchEvent(new CustomEvent('prism-request-failed'));
```

**Why not restrict to 5xx (adversarial finding):** a masked GitHub 401 surfaces as a 500 on the unhandled path *but as a typed 4xx on endpoints that catch-and-remap it* (e.g. PR-detail `Results.Problem` 404/422). Restricting the trigger to 5xx would miss those foreground interactions, leaving the user with a typed error and no re-auth affordance. The **latch is the source of truth** — it already flipped at the transport seam regardless of how the Web layer reshaped the status — so the client only needs *any* failure as a cue to re-read `/api/auth/state`. The refetch is a cheap GET of in-memory state; the ~750ms debounce collapses bursts and the common benign 4xx (409 submit-in-flight, 422 tab-id) cost only one cheap debounced GET that returns `githubCredentialInvalid: false` (no snackbar).

### 7.3 Shared `Snackbar` primitive

Extract the presentational shape of `StreamHealthSnackbar` into a reusable `Snackbar` (new `components/Snackbar/`):

- Props: `tone: 'warning' | 'danger'`, `message: ReactNode`, `action?: { label: string; onClick: () => void }`, `onDismiss?: () => void` (**optional** — the dismiss `×` renders only when provided; the warning/connectivity consumer passes it, the danger/re-auth consumer does not), and explicit `role` / `aria-live` (caller-supplied, since the two tones differ — see § 7.4).
- CSS module mirrors `StreamHealthSnackbar.module.css` (top-center fixed, `top:100px`, `z-index:200`, slide-in, reduced-motion-aware). Tone maps to design tokens for **all three** facets — background, **border**, and foreground: `warning` → `--warning-soft` / `border 1px solid --warning` / `--warning-fg`; `danger` → `--danger-soft` / `border 1px solid --danger` / `--danger-fg` (theme-aware, `tokens.css:113-115` light / `:187-189` dark). The border is explicit so the danger variant keeps the same visual boundary as the existing warning one.
- `StreamHealthSnackbar` is re-pointed at `<Snackbar tone="warning" message="Connection lost — reconnecting" action={{label:'Retry now', onClick: retry}} onDismiss={…} role="status" aria-live="polite" />` with **zero visual change** (regression-pinned by its existing test + visual baselines).

> **Scope note (rejected scope-guardian removal):** the extraction is kept rather than forking the CSS module. Building `GitHubAuthBanner` against a copy would create the exact two-copies-drift the codebase already suffers (#326/#328); extracting at the moment the *second* instance appears is the natural, lower-risk point, and the warning consumer is pinned by an existing test + baseline so the refactor is verifiable. If the owner prefers to minimize the B2 diff, the fallback is a standalone fork + a #328 follow-up — called out at the gate.

### 7.4 `GitHubAuthBanner`

New component, mirroring `StreamHealthSnackbar`'s **appearance** (red top-center bar) but with **action-required, non-dismissible** behavior (owner decision: re-auth is mandatory, not optional):

- Reads `useAuth()` for `authState.githubCredentialInvalid && authState.hasToken`, `useStreamHealth()` for `healthy`, and the router location.
- Renders `null` unless `hasToken && githubCredentialInvalid && healthy && route !== '/setup'`. There is **no local dismiss state and no `×`** — the banner stays up the entire time the credential is invalid, on every route except `/setup`. (Suppressing on `/setup` avoids showing a "reconnect" prompt on top of the very page that performs the reconnect.)
- Renders `<Snackbar tone="danger" message="GitHub access token invalid — reconnect" action={{ label: 'Reconnect', onClick: () => navigate('/setup?replace=1') }} role="status" aria-live="polite" />` — **no `onDismiss`**, so the primitive renders no dismiss button.
  - **Copy (revised per design/product review):** "GitHub access token invalid — reconnect" — accurate for revoked / expired / bad-credential cases (the earlier "sign-in expired" implied OAuth-session timeout and misframed a *revoked* token; PRism uses PATs). Final copy is a B1 item the owner confirms at the visual gate.
  - **a11y (corrected — a persistent region must not re-announce):** a *non-dismissible* banner stays mounted for the whole invalid session, so `aria-live="assertive"` would re-announce "GitHub access token invalid — reconnect" on **every** re-render / route change (App re-renders on each navigation + refetch) — disruptive to the point of unusable with a screen reader. Use **`role="status"` / `aria-live="polite"` / `aria-atomic="true"`**, with the live-region element kept **always mounted** and only its text *content* toggling on the invalid edge, so it announces **once** when it appears and once when it clears — not on every render. (Assertive is for transient urgent interrupts, not a standing condition.) It does **not** steal focus on appear; `Reconnect` is keyboard-reachable.
- **Mandatory re-auth — the replace screen is a one-way gate (owner directive).** While `githubCredentialInvalid && hasToken`, `/setup?replace=1` is **exit-gated**: the user cannot return to the app until a **valid** token is committed. A navigation guard (mirroring the existing first-run `!hasToken` gate that redirects app routes to `/setup`) holds the user on the replace screen while the credential is invalid — any away-navigation redirects back to `/setup?replace=1`. Only a successful **validate-before-swap** commit (`/api/auth/replace`, § 1) clears `githubCredentialInvalid` and releases them; an invalid candidate token is rejected and never commits, so it never opens the gate. The banner is **suppressed on `/setup`** because the screen *is* the gate — no redundant prompt. On app routes the non-dismissible banner remains the cue to start re-auth; once the user enters the replace screen, the gate ensures they finish. `isAuthed` stays true (we do **not** fall back to the first-run flow and lose context elsewhere) — the lock is a credential-invalid route guard scoped to the replace screen, not a teardown of app state.
- **Navigation target is a compile-time string literal** (`/setup?replace=1`); it must never be derived from a server-supplied field, so a compromised/MITM'd response cannot redirect the user to an attacker-controlled setup page.
- **Message lives in the banner, not the setup screen (owner directive).** The user-facing explanation is carried by the banner copy ("GitHub access token invalid — reconnect"); the `/setup` replace screen text is **not** modified (no added context line). The existing #213 classic-PAT guidance and rejection copy on that screen are sufficient for completing re-auth.
- **Position.** Mounts at the connectivity slot (floating top-center, `top:100px`), matching `StreamHealthSnackbar`'s appearance per the owner's original directive. Because the flow funnels the user into the exit-gated replace screen, the banner is a transient cue rather than a permanent fixture to work around; exact placement/overlap is a B1 visual the owner eyeballs at green-and-ready.
- Mounted in `App.tsx` next to `StreamHealthSnackbar` (`App.tsx:184`); the credential-invalid navigation guard lives alongside the existing routing gate in `App.tsx`.

**Co-occurrence / suppression bound:** suppressing on `!healthy` and on `/setup` means only one bar shows at the shared `top:100px` slot. If the PRism server connection is *also* down, the re-auth banner is deferred — but while the server is unreachable the app is non-functional anyway and `/api/auth/state` can't be read, so the credential prompt is moot until the server returns. On reconnect, `prism-events-reconnected` refetches auth-state (§ 7.1) and the banner surfaces if still invalid. The masking window is therefore **bounded by SSE reconnect, not unbounded**.

**No first-run teardown:** `isAuthed = hasToken && !authInvalidated` is **untouched** — we do not fall back to the un-authed first-run flow, so app state/context is preserved. On app routes the banner is an overlay (consistent with `Banner, not mutation`); the *only* lock is the replace-screen exit guard above. Recovery (successful replace) bumps the epoch + clears the latch (§ 6.4); the SetupPage refetch then drops the banner without a flash and the guard releases.

> **Resolved (owner decisions).** (1) **Non-dismissible** — design-lens (P1) and product-lens (P2) flagged that `StreamHealthSnackbar` is dismissible only because connectivity *self-heals*; a dead PAT does not, so a dismissible banner would let the user re-hide the silent-broken state #312 exists to fix. (2) **One-way gate** — the replace screen is exit-gated: the user can only leave once a valid token is committed (the banner is suppressed there since the screen is the gate). (3) **Message in the banner, setup text unchanged.** (4) **github.com-only** this slice (§ 11). The banner persists on app routes until a valid token is committed (or the latch auto-clears on a later authenticated 2xx).

## 8. Data flow — the two paths

**Background (idle / inbox):** PAT dies → next `InboxPoller` tick's authenticated GitHub call 401s → handler `RecordAuthFailure()`. Inbox degrades as today. Snackbar surfaces on the next `/api/auth/state` refetch (window focus, or a `prism-request-failed` from any request the user makes). Matches the chosen "surface when they interact/refocus" promptness (Approach A) and the § 3 accepted limitation for the fully-idle case.

**Foreground (direct interaction):** user opens a PR with a dead PAT → GitHub call 401s → handler `RecordAuthFailure()`; the request still fails → Web returns 500 *or* a remapped typed 4xx → `apiClient` dispatches `prism-request-failed` → debounced `useAuth` refetch → `githubCredentialInvalid: true` → banner. The very interaction that failed surfaces the explanation, regardless of how the endpoint reshaped the error status.

**Recovery:** Reconnect → `/setup?replace=1` → successful replace `BumpEpoch()` + `MarkValid()` (§ 6.4) + SetupPage `refetch()` → `githubCredentialInvalid: false` → banner gone (no flash). A stale in-flight old-token 401 across the swap is ignored by the epoch guard.

## 9. Testing strategy

**Backend (xUnit):**
- `GitHubAuthHealthHandler` (stub inner handler): 401+auth-header+same-epoch → `RecordAuthFailure`; 401 with epoch changed mid-request → **no-op**; 401 with no auth header → no-op; 2xx+auth-header → `MarkValid`; 2xx no auth header → no-op; 403/429/500 → no-op; transport throw → no-op + rethrow; `prism-skip-credential-health` option → no-op on a 401.
- **Threshold test:** one isolated authenticated 401 → `IsInvalid == false` (not flipped); **two consecutive** → `IsInvalid == true`; a 2xx *between* two 401s resets the counter so it does not flip.
- `IGitHubCredentialHealth` default impl: initial `IsInvalid == false` / `Epoch == 0` / counter 0; `RecordAuthFailure` flips only at `THRESHOLD`; `MarkValid` resets counter + clears; `BumpEpoch` increments; edge-only logging fires once per actual `IsInvalid` change.
- `/api/auth/state` integration (`WebApplicationFactory`): latch invalid → `githubCredentialInvalid == true`; valid → false.
- **Candidate-token negative test:** connect/replace with a bad candidate token (validation 401, `skipCredentialHealth: true`) → `/api/auth/state` still `githubCredentialInvalid == false`.
- **Stored-token startup-latch test:** `ViewerLoginHydrator` validating a dead **stored** token (`skipCredentialHealth: false`) → `githubCredentialInvalid == true` after two failures (confirms the hydrator does *not* skip).
- **Mandatory-valid test:** `POST /api/auth/replace` with an **invalid** token → `BadRequest`, no commit, and `githubCredentialInvalid` stays `true` (the latch cannot be cleared by a bad token).
- **Feedback-client negative test:** a 401 on the feedback-client path → `githubCredentialInvalid == false` (pins the handler-wiring exclusion).
- **Replace-race test:** an old-token 401 delivered after a `BumpEpoch` does not set the latch.
- **Red-on-main proof:** an integration test where a fake `"github"` client returns two 401s on an inbox/PR path, then asserts `/api/auth/state` reports `githubCredentialInvalid == true`. **Red on `origin/main`** (no field / no handler — fails to compile or returns false), green on head.

**Frontend (vitest):**
- `Snackbar` primitive: renders message/action/dismiss; tone class mapping incl. border; reduced-motion.
- `StreamHealthSnackbar`: unchanged behavior after re-pointing (existing test stays green).
- `GitHubAuthBanner`: shows on `hasToken && invalid && healthy && route!=='/setup'`; hidden when `!hasToken`, `!invalid`, `!healthy`, or on `/setup`; renders **no dismiss button** and stays mounted while invalid (no dismiss path); Reconnect navigates to `/setup?replace=1`.
- `Snackbar` primitive: renders the `×` only when `onDismiss` is provided (warning consumer) and omits it otherwise (danger consumer).
- `useAuth`: `prism-request-failed` triggers a debounced refetch; flag surfaces from `authState`.
- `apiClient`: a failed response dispatches `prism-request-failed`.

**e2e (Playwright):** B1 visual baseline for the red banner (a fake-mode route forcing `githubCredentialInvalid` via the auth-state fake). New baselines regenerated from CI artifact per house process.

## 10. Rejected alternatives

- **Detect in `InboxPoller`'s catch block (single surface).** Rejected: re-introduces the per-surface carve-out #137 was deferred to avoid; couples credential-health to the inbox feature/cadence; only the poller could set *and* clear it; foreground interaction wouldn't latch until the next tick; and the swallowed generic `Exception` requires lossy status re-classification. The handler sits *underneath* the poller and covers it plus every other surface at the clean raw-status seam. (Owner-confirmed.)
- **Map the GitHub 401 to an HTTP 401 problem-response and reuse `prism-auth-rejected`.** Rejected as a *complete* fix: the inbox degrades on a background poller with no client request to remap. Works only for foreground; misses the headline surface.
- **New `githubCredentialInvalid` field pushed over SSE (prompt-while-idle).** Deferred (Approach A chosen): more wiring for the narrow fully-idle window. Kept as a follow-up (§ 11) if idle latency is felt.
- **Per-call-site reporting at the provider seam (issue's literal suggestion).** Rejected vs. the handler: spreads identical reporting across many call sites (drift risk), where one `DelegatingHandler` covers all current and future calls with zero per-site code.
- **Trigger the foreground refetch on 5xx only.** Rejected (adversarial finding): endpoints that remap a GitHub 401 to a typed 4xx would be missed. Trigger on any failed request instead; the latch is the source of truth (§ 7.2).
- **Drop the explicit `MarkValid()` on commit as gold-plating.** Rejected (§ 6.4): it prevents a red-snackbar flash on the immediate post-replace `SetupPage` refetch.
- **Dismissible snackbar (mirroring `StreamHealthSnackbar`'s nature).** Rejected by the owner after design/product review: connectivity self-heals so dismissing is harmless, but a dead PAT does not — a dismissible banner would let the user re-hide the silent-broken state. Chosen instead: **non-dismissible while invalid + mandatory valid re-auth** (§ 7.4).

## 11. Follow-ups (out of scope)

- Mid-session **scope-loss (403 / GraphQL-200-with-errors)** detection (needs SSO/rate-limit disambiguation).
- **GHES 401 detection (decided: deferred).** On GitHub Enterprise Server some versions return `401` for resource-level authorization failures, not only credential invalidity, which could false-trigger a non-dismissible banner. **Owner decision: scope the latch to github.com only this slice** (§ 6.2 host gate); GHES re-auth detection — with the SSO/resource-401 disambiguation it needs — is a follow-up. GHES users keep today's silent-degrade behavior until then (no regression).
- **False-positive recovery (non-dismissible).** With the threshold + auto-clear-on-2xx, a genuinely-valid token self-heals on the next authenticated 2xx (active poller / next interaction). The narrow residual — a false latch while fully idle with no further traffic — is bounded by the next focus/refetch. If even that proves annoying, a one-shot authenticated re-probe (`GET /user` with the stored token) on banner mount could confirm-or-clear before forcing replace; deferred unless observed.
- **#137** activity rail: once landed, its GitHub calls feed this latch automatically (no extra work) — verify at that time.
- **SSE-push promptness** for the fully-idle case (§ 3) if Approach A's latency is felt.

**`prism-request-failed` is an auth-state-refetch cue only** (§ 7.2) — it is not a general failure bus; nothing else should subscribe to it for unrelated behavior.

## 12. File-change map (orientation, not exhaustive)

**Backend**
- `PRism.Core/Auth/IGitHubCredentialHealth.cs` (+ impl) — **new**.
- `PRism.GitHub/GitHubAuthHealthHandler.cs` — **new** `DelegatingHandler`.
- `PRism.GitHub/ServiceCollectionExtensions.cs:33` — register handler type + `.AddHttpMessageHandler<>()`; register the latch singleton.
- `PRism.GitHub/GitHubReviewService.cs:77,217` — candidate-token probes set the skip option.
- `PRism.Web/Endpoints/AuthEndpoints.cs:26,88,…` — read latch in `/state`; `BumpEpoch()`+`MarkValid()` on connect/replace success.
- `PRism.Web/Endpoints/AuthDtos.cs:5` — add `GithubCredentialInvalid`.

**Frontend**
- `frontend/src/components/Snackbar/` — **new** shared primitive (+ module + test).
- `frontend/src/components/StreamHealthSnackbar/StreamHealthSnackbar.tsx` — re-point at `Snackbar` (no visual change).
- `frontend/src/components/GitHubAuthBanner/` — **new** (+ test).
- `frontend/src/api/types.ts:74` — `githubCredentialInvalid` on `AuthState`.
- `frontend/src/api/client.ts:67` — dispatch `prism-request-failed` on any failed response.
- `frontend/src/hooks/useAuth.tsx` — debounced refetch on `prism-request-failed`.
- `frontend/src/App.tsx:184` — mount `GitHubAuthBanner`; add the credential-invalid **navigation guard** (exit-gate the `/setup?replace=1` screen while `githubCredentialInvalid`, alongside the existing first-run routing gate).

## 13. Risk / gate

- **B2 (auth/token surface):** this spec is the spec-gate artifact. Owner reviews the *approach* before planning.
- **B1 (new red banner):** visual assert at green-and-ready (screenshots / baseline), plus the **copy** ("GitHub access token invalid — reconnect") the owner confirms. Behavior resolved: non-dismissible while invalid; floating top-center (connectivity-slot appearance) — § 7.4.
- **Owner decisions — resolved at the gate:** (1) replace screen is a **one-way exit-gate** (leave only on valid token); (2) **GHES → github.com-only** this slice (§ 6.2 host gate, § 11); (3) message stays in the **banner**, `/setup` screen text **unchanged**; (4) non-dismissible + consecutive-401 threshold.
- Secrets scan over the diff required at PR time. The handler/latch inspect status codes and the *presence* of an `Authorization` header only — they never read, log, or expose token material (§ 6.1 logging contract).
