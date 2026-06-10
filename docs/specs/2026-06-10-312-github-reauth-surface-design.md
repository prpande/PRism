# #312 — Mid-session GitHub credential-invalid re-auth surface

**Issue:** [#312](https://github.com/prpande/PRism/issues/312) — "Mid-session GitHub PAT revocation/expiry has no re-auth surface (app degrades silently)"
**Date:** 2026-06-10
**Tier / Risk:** T3 · gated **B2** (auth/token surface) + **B1** (new visible snackbar)
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

In the **fully-idle** case — the PAT dies while the user sits on an already-loaded inbox with no interaction and no window-focus change — the snackbar surfaces only on the next focus or triggered refetch (§ 7.2). The headline complaint (silent degradation) is therefore *fully* closed for active users and *bounded* (not instant) for idle ones. This is the deliberate cost of skipping SSE-push (§ 10). The owner accepts this at the spec gate; if idle latency is felt in practice, the SSE-push follow-up (§ 11) closes it.

## 4. Acceptance criteria

- [ ] A mid-session GitHub 401 on **any** GitHub-backed call (inbox poll, PR load, draft fetch) flips a server-side credential-invalid latch.
- [ ] `GET /api/auth/state` reports the latch as `githubCredentialInvalid: boolean`.
- [ ] The frontend renders a **red/danger, non-dismissible** app-level banner (mirroring `StreamHealthSnackbar`'s *appearance*, but persistent — no `×`) whenever `hasToken && githubCredentialInvalid`. In the **background/idle** case, surfacing is bounded by the next window-focus or triggered refetch (Approach A, § 10) — it is **not** instantaneous, by design.
- [ ] The banner's **Reconnect** action routes to `/setup?replace=1`, and the banner persists until a **valid** token is committed — the replace flow's validate-before-swap (existing) refuses an invalid token, so the user cannot clear the banner with a bad token.
- [ ] A transient `403 / 429 / 5xx / transport` failure does **not** flip the latch (no false snackbar).
- [ ] The latch **auto-clears** on the next successful *authenticated* GitHub call, and clears immediately on a successful connect-commit / replace.
- [ ] A bad **candidate** token during connect/replace validation does **not** flip the latch for the still-stored token (all candidate-token probe paths opt out).
- [ ] A successful token **replace** does not leave a residual false-invalid latch even if an old-token request was in flight across the swap (epoch guard, § 6.2).
- [ ] The re-auth banner is **suppressed while the SSE stream is unhealthy** (connection-loss takes precedence) **and on the `/setup` route** (the page that fixes it).

## 5. Architecture overview

```
GitHub API ──401/2xx──▶ GitHubAuthHealthHandler (DelegatingHandler on "github" client)
                              │ (epoch-guarded, auth-header-gated)
                              │ 401 → MarkInvalid()      2xx → MarkValid()
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
   GitHubAuthSnackbar (red Snackbar)  ── Reconnect ──▶ /setup?replace=1
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
    int  Epoch     { get; }   // bumped on every token change; see § 6.2 race guard
    void MarkInvalid();
    void MarkValid();
    void BumpEpoch();         // call on connect/replace commit (token changed)
}
```

Default implementation backs the state with a small lock (or `Interlocked`) so `IsInvalid` and `Epoch` stay coordinated. Initial state: **valid** (`IsInvalid == false`, `Epoch == 0`) — before any GitHub call we assume valid; the first real 401 flips it.

**Premise (stated, load-bearing):** credential health is modeled **process-global** because PRism stores exactly one GitHub token per process and all windows/tabs share it via the same `/api/auth/state`. One surface's masked 401 correctly raises the banner in every window — intended. If PRism ever goes multi-account (per-window token), the latch must become per-token.

No persistence. `MarkInvalid` / `MarkValid` are idempotent and track current state; an **edge transition** is any actual state change (false→true or true→false) regardless of call site (handler or endpoint). Logging fires **once per edge** by comparing state before vs after the call (valid→invalid at Warning, invalid→valid at Information) — so an explicit `MarkValid()` (§ 6.4) followed by a handler `MarkValid()` on the next 2xx does not double-log. The log line carries only the transition direction and a timestamp — **never** request URL, headers, or any token fragment.

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

    if (resp.StatusCode == HttpStatusCode.Unauthorized)
    {
        // Ignore a 401 from a token that was already replaced mid-flight (epoch moved).
        if (_health.Epoch == epochBefore) _health.MarkInvalid();
    }
    else if (resp.IsSuccessStatusCode)
    {
        _health.MarkValid();
    }
    return resp;
}
```

| Outcome | Action |
|---------|--------|
| `401`, auth header present, epoch unchanged | `MarkInvalid()` |
| `401`, epoch changed during the request (a replace landed) | **ignored** (stale old-token 401) |
| `2xx`, auth header present | `MarkValid()` |
| no `Authorization` header (unauthenticated/public call) | no-op (can't speak to the stored token) |
| `skip` option set (validation probe) | no-op |
| `403 / 429 / other non-2xx` | no-op |
| transport exception from `base.SendAsync` | no-op (rethrow unchanged) |

The handler **never** alters the response or throws — it observes and passes through. It does not read the body (no stream consumption); `StatusCode == 401` is the whole signal.

**Why `401` is the clean discriminator:** GitHub (github.com) returns `401` only for bad/missing/revoked/expired credentials. Rate-limiting is `403`/`429`; SAML SSO enforcement is `403`. So `401` unambiguously means "the token is bad" → actionable as re-auth. The two guards above (auth-header-present, epoch-unchanged) keep an *unauthenticated* 2xx from falsely clearing a real invalid latch and a *superseded-token* 401 from falsely setting one. See § 11 for the GHES-edge caveat.

### 6.3 Validation opt-out (candidate-token guard) — all probe paths

`/api/auth/connect` and `/api/auth/replace` probe GitHub with a **candidate** transient token through the same `"github"` client. A bad candidate must not latch the **stored** token as invalid. **Every** candidate-token probe sets the opt-out on its `HttpRequestMessage`:

```csharp
req.Options.Set(SkipHealthKey, true);  // SkipHealthKey = new HttpRequestOptionsKey<bool>("prism-skip-credential-health")
```

Probe sites to cover (all build their own `HttpRequestMessage`, so the option is threadable — verified):
- `ValidateCredentialsAsync` → `GET /user` (`GitHubReviewService.cs:77`).
- The fine-grained-token follow-up probes invoked during validation (repo-visibility / search probes around `GitHubReviewService.cs:217`), which also use the `"github"` client with the candidate token.

A negative test asserts a bad candidate during connect/replace does **not** flip the latch (§ 9).

### 6.4 Explicit clear + epoch bump on successful (re)connect

On a successful validate+commit (connect or replace), the endpoint calls `BumpEpoch()` **then** `MarkValid()`:

- `BumpEpoch()` invalidates any in-flight old-token request: a 401 from the just-replaced token arrives with `epochBefore < CurrentEpoch` and is ignored (§ 6.2).
- `MarkValid()` clears the latch **immediately**, rather than waiting for the next GitHub 2xx.

Call sites: `/api/auth/connect` success-commit (`AuthEndpoints.cs:88`), `/api/auth/connect/commit`, and `/api/auth/replace` success-commit.

**Why this is not redundant with auto-clear-on-2xx (rejected scope-guardian removal):** `SetupPage` `await refetch()`s `/api/auth/state` immediately after a successful replace. If the latch were cleared only by the *next* GitHub 2xx (a poll cadence away), that refetch would read `githubCredentialInvalid: true` and **flash the red snackbar on top of the success the user just achieved**. The explicit `MarkValid()` on commit closes that window. Auto-clear-on-2xx remains as the belt-and-suspenders backstop for any other recovery path.

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

> **Scope note (rejected scope-guardian removal):** the extraction is kept rather than forking the CSS module. Building `GitHubAuthSnackbar` against a copy would create the exact two-copies-drift the codebase already suffers (#326/#328); extracting at the moment the *second* instance appears is the natural, lower-risk point, and the warning consumer is pinned by an existing test + baseline so the refactor is verifiable. If the owner prefers to minimize the B2 diff, the fallback is a standalone fork + a #328 follow-up — called out at the gate.

### 7.4 `GitHubAuthSnackbar`

New component, mirroring `StreamHealthSnackbar`'s **appearance** (red top-center bar) but with **action-required, non-dismissible** behavior (owner decision: re-auth is mandatory, not optional):

- Reads `useAuth()` for `authState.githubCredentialInvalid && authState.hasToken`, `useStreamHealth()` for `healthy`, and the router location.
- Renders `null` unless `hasToken && githubCredentialInvalid && healthy && route !== '/setup'`. There is **no local dismiss state and no `×`** — the banner stays up the entire time the credential is invalid, on every route except `/setup`. (Suppressing on `/setup` avoids showing a "reconnect" prompt on top of the very page that performs the reconnect.)
- Renders `<Snackbar tone="danger" message="GitHub access token invalid — reconnect" action={{ label: 'Reconnect', onClick: () => navigate('/setup?replace=1') }} role="alert" aria-live="assertive" />` — **no `onDismiss`**, so the primitive renders no dismiss button.
  - **Copy (revised per design/product review):** "GitHub access token invalid — reconnect" — accurate for revoked / expired / bad-credential cases (the earlier "sign-in expired" implied OAuth-session timeout and misframed a *revoked* token; PRism uses PATs). Final copy is a B1 item the owner confirms at the visual gate.
  - **a11y:** `role="alert"`/`aria-live="assertive"` (vs the amber one's `status`/`polite`) because the condition is action-required and persistent. Following the snackbar convention it does **not** steal focus on appear; the `Reconnect` button is keyboard-reachable.
- **Mandatory re-auth (owner directive):** the banner cannot be dismissed, and the only thing that removes it is the latch returning to valid — which happens only when a **valid** token is committed. The `/setup?replace=1` flow already does **validate-before-swap** (`/api/auth/replace`, § 1): an invalid candidate token is rejected with an inline error and **not** committed, so it never clears the credential-invalid state. Net: the user cannot "proceed" out of the degraded state with a bad token — they either commit a working token (banner clears) or stay blocked. The user is not hard-jailed from navigating the (degraded) app, but the non-dismissible banner is omnipresent until resolved. *(If the owner wants a harder full-screen gate — route-lock to `/setup` until valid, like the first-run `!hasToken` gate — that's a small follow-up tweak; the current design keeps the `Banner, not mutation` posture while making re-auth unavoidable.)*
- **Navigation target is a compile-time string literal** (`/setup?replace=1`); it must never be derived from a server-supplied field, so a compromised/MITM'd response cannot redirect the user to an attacker-controlled setup page.
- Mounted in `App.tsx` next to `StreamHealthSnackbar` (`App.tsx:184`).

**Co-occurrence / suppression bound:** suppressing on `!healthy` and on `/setup` means only one snackbar shows at the shared `top:100px` slot. If the PRism server connection is *also* down, the re-auth snackbar is deferred — but while the server is unreachable the app is non-functional anyway and `/api/auth/state` can't be read, so the credential prompt is moot until the server returns. On reconnect, `prism-events-reconnected` refetches auth-state (§ 7.1) and the snackbar surfaces if still invalid. The masking window is therefore **bounded by SSE reconnect, not unbounded**.

**Banner-over-UI, not redirect:** `isAuthed = hasToken && !authInvalidated` is **untouched** — the user keeps their context; the snackbar is an overlay, consistent with the `Banner, not mutation` architectural invariant. Recovery (successful replace) bumps the epoch + clears the latch (§ 6.4); the SetupPage refetch then drops the snackbar without a flash.

> **Resolved (owner decision) — non-dismissible, mandatory re-auth.** Design-lens (P1) and product-lens (P2) flagged that `StreamHealthSnackbar` is dismissible only because connectivity *self-heals*; a dead PAT does **not** self-heal, so a dismissible banner would let the user re-hide the exact silent-broken state #312 exists to fix. Owner chose **(b) non-dismissible while invalid**, with the added requirement that the replace workflow cannot be completed with an invalid token (satisfied by the existing validate-before-swap on `/api/auth/replace`). The banner therefore persists until a valid token is committed.

## 8. Data flow — the two paths

**Background (idle / inbox):** PAT dies → next `InboxPoller` tick's authenticated GitHub call 401s → handler `MarkInvalid()`. Inbox degrades as today. Snackbar surfaces on the next `/api/auth/state` refetch (window focus, or a `prism-request-failed` from any request the user makes). Matches the chosen "surface when they interact/refocus" promptness (Approach A) and the § 3 accepted limitation for the fully-idle case.

**Foreground (direct interaction):** user opens a PR with a dead PAT → GitHub call 401s → handler `MarkInvalid()`; the request still fails → Web returns 500 *or* a remapped typed 4xx → `apiClient` dispatches `prism-request-failed` → debounced `useAuth` refetch → `githubCredentialInvalid: true` → snackbar. The very interaction that failed surfaces the explanation, regardless of how the endpoint reshaped the error status.

**Recovery:** Reconnect → `/setup?replace=1` → successful replace `BumpEpoch()` + `MarkValid()` (§ 6.4) + SetupPage `refetch()` → `githubCredentialInvalid: false` → snackbar gone (no flash). A stale in-flight old-token 401 across the swap is ignored by the epoch guard.

## 9. Testing strategy

**Backend (xUnit):**
- `GitHubAuthHealthHandler` (stub inner handler): 401+auth-header+same-epoch → `MarkInvalid`; 401 with epoch changed mid-request → **no-op**; 401 with no auth header → no-op; 2xx+auth-header → `MarkValid`; 2xx no auth header → no-op; 403/429/500 → no-op; transport throw → no-op + rethrow; `prism-skip-credential-health` option → no-op on a 401.
- `IGitHubCredentialHealth` default impl: initial `IsInvalid == false` / `Epoch == 0`; mark/clear transitions; `BumpEpoch` increments; edge-only logging fires once per actual state change.
- `/api/auth/state` integration (`WebApplicationFactory`): latch invalid → `githubCredentialInvalid == true`; valid → false.
- **Candidate-token negative test:** connect/replace with a bad candidate token (validation 401, skip-option set) → `/api/auth/state` still `githubCredentialInvalid == false`.
- **Feedback-client negative test:** a 401 on the feedback-client path → `githubCredentialInvalid == false` (pins the handler-wiring exclusion).
- **Replace-race test:** an old-token 401 delivered after a `BumpEpoch` does not set the latch.
- **Red-on-main proof:** an integration test where a fake `"github"` client returns 401 on an inbox/PR path, then asserts `/api/auth/state` reports `githubCredentialInvalid == true`. **Red on `origin/main`** (no field / no handler — fails to compile or returns false), green on head.

**Frontend (vitest):**
- `Snackbar` primitive: renders message/action/dismiss; tone class mapping incl. border; reduced-motion.
- `StreamHealthSnackbar`: unchanged behavior after re-pointing (existing test stays green).
- `GitHubAuthSnackbar`: shows on `hasToken && invalid && healthy && route!=='/setup'`; hidden when `!hasToken`, `!invalid`, `!healthy`, or on `/setup`; renders **no dismiss button** and stays mounted while invalid (no dismiss path); Reconnect navigates to `/setup?replace=1`.
- `Snackbar` primitive: renders the `×` only when `onDismiss` is provided (warning consumer) and omits it otherwise (danger consumer).
- `useAuth`: `prism-request-failed` triggers a debounced refetch; flag surfaces from `authState`.
- `apiClient`: a failed response dispatches `prism-request-failed`.

**e2e (Playwright):** B1 visual baseline for the red snackbar (a fake-mode route forcing `githubCredentialInvalid` via the auth-state fake). New baselines regenerated from CI artifact per house process.

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
- **GHES 401 semantics.** On GitHub Enterprise Server, some versions can return `401` for resource-level authorization failures, not only credential invalidity, which could false-trigger. This slice assumes github.com `401`-means-bad-credentials semantics; the auth-header + epoch guards reduce but don't eliminate the GHES edge. Verify/scope before relying on it for GHES users.
- **#137** activity rail: once landed, its GitHub calls feed this latch automatically (no extra work) — verify at that time.
- **SSE-push promptness** for the fully-idle case (§ 3) if Approach A's latency is felt.

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
- `frontend/src/components/GitHubAuthSnackbar/` — **new** (+ test).
- `frontend/src/api/types.ts:74` — `githubCredentialInvalid` on `AuthState`.
- `frontend/src/api/client.ts:67` — dispatch `prism-request-failed` on any failed response.
- `frontend/src/hooks/useAuth.tsx` — debounced refetch on `prism-request-failed`.
- `frontend/src/App.tsx:184` — mount `GitHubAuthSnackbar`.

## 13. Risk / gate

- **B2 (auth/token surface):** this spec is the spec-gate artifact. Owner reviews the *approach* before planning.
- **B1 (new red banner):** visual assert at green-and-ready (screenshots / baseline), plus the **copy** ("GitHub access token invalid — reconnect") the owner confirms. Behavior resolved: non-dismissible while invalid (§ 7.4).
- Secrets scan over the diff required at PR time. The handler/latch inspect status codes and the *presence* of an `Authorization` header only — they never read, log, or expose token material (§ 6.1 logging contract).
