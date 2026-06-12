# Desktop cold-start stale session cookie — design (#433)

**Issue:** [#433](https://github.com/prpande/PRism/issues/433) · **Tier:** T2 · **Risk:** gated B2 (auth/security surface)

## Problem

On Electron **cold relaunch**, the app flashes a `Couldn't load auth state — HTTP 401`
error modal; clicking **Reload** recovers. Browser-tab builds never see it.

### Root cause (verified against current source)

The session-token scheme assumes a browser-tab model where every launch re-fetches a
fresh `200 text/html` `index.html` and thus a fresh per-process cookie:

1. `SessionTokenProvider` mints a fresh random token each sidecar launch.
2. The token reaches the SPA **only** via the `prism-session` cookie, stamped
   *exclusively* on `200 text/html` responses — predicate
   `ContentType?.StartsWith("text/html")` (`PRism.Web/Program.cs:307`).
3. Electron uses the **default persistent session** (`desktop/src/main.ts` sets no
   `partition`), so both the cookie store and the HTTP cache persist across launches.
4. `index.html` (the SPA shell — Electron loads `http://127.0.0.1:{port}`, i.e. `GET /`,
   per `desktop/src/sidecar.ts:119` + `main.ts:242`) carries only ETag/Last-Modified —
   no `Cache-Control: no-store`. `GET /` is served by the SPA fallback
   (`MapFallbackToFile`, `Program.cs:358`); in a built bundle `MapStaticAssets`
   (`Program.cs:323`) may serve it instead — the fix is route-agnostic so the
   distinction doesn't change correctness (see Fix). On cold relaunch Electron
   revalidates and gets a **`304 Not Modified`** (or serves from disk cache); neither
   carries a `Set-Cookie` (a 304 has no `text/html` body, so the stamping predicate
   never fires).
5. The renderer presents the **previous launch's stale `prism-session` cookie**; the new
   process's token rejects it → `SessionTokenMiddleware` returns
   `401 /auth/session-stale` (`SessionTokenMiddleware.cs:109-119`) on the first
   `/api/auth/state` fetch.
6. `App` renders the generic error modal (`authState === null && error`). The
   `prism-auth-rejected` event (`client.ts:76`) only feeds the #312 credential-invalid
   latch — there is **no** session-stale auto-reload. Only the manual **Reload** button
   re-fetches `index.html` and re-stamps the cookie, which is why it recovers.

The `SessionTokenMiddleware` comment (lines 14–16) asserts the SPA "force-reloads to get
the freshly-stamped one" — **that reload does not exist.** A live *Truthful by default*
violation, independent of the bug.

## Fix (Option 1 — owner-approved)

Option 1 = the issue's **approach A** (root-cause `no-store`) plus a comment correction.
The chosen approach has two parts. (Reserved labels: **approach A/B/C** are the issue's
three options; **Part 1/Part 2** are the two pieces of the chosen approach A.)

**Part 1 — Tie `Cache-Control: no-store` to the cookie-stamping predicate (root cause).**
Inside the existing `OnStarting` block (`Program.cs:303-321`), on the same
`text/html` branch that appends the `prism-session` cookie, also set
`Cache-Control: no-store`. Binding the cache directive to the exact predicate that
stamps the per-process security cookie makes "a response carrying a per-process cookie
must never be cached" one co-located rule that cannot drift from the cookie predicate.
This forces a full `200 text/html` re-fetch every launch → the cookie is always
re-stamped with the current process token → no stale-cookie 401.

- **Route-agnostic by design.** The directive rides the `text/html` predicate, not a
  route, so it applies whichever static handler serves `index.html`
  (`MapFallbackToFile` *or* `MapStaticAssets`). This is why it's preferred over a
  per-route `OnPrepareResponse` on `MapFallbackToFile` (which would re-derive the
  predicate, could drift, and would miss the `MapStaticAssets`-served path).
- **Must overwrite, not append.** `OnStarting` callbacks fire last, immediately before
  headers flush — after any static-file handler has set its own `Cache-Control`. The
  callback therefore **assigns** `Response.Headers.CacheControl = "no-store"` (replace),
  so the final header is `no-store` even if `MapStaticAssets` set `no-cache`/`max-age`
  on the same response. The regression test asserts the *final* header value to pin this.

**Part 2 — Correct the misleading middleware comment.** Rewrite
`SessionTokenMiddleware.cs:14-16` to describe the actual mechanism — each launch
re-fetches a `no-store` `index.html` that re-stamps the cookie — instead of a
nonexistent SPA force-reload.

### Scope boundaries

- `no-store` applies **only** to the `text/html` (cookie-carrying) branch. Fingerprinted
  static assets (JS/CSS) stay cacheable — they carry no cookie and are content-hashed.
- **Deferred — approach B (frontend defense-in-depth):** a one-shot, tombstoned
  auto-reload on a `/auth/session-stale` 401 (distinct from the #312 credential-401).
  Filed as follow-up **#447**. Approach A removes the 304-on-`index.html` trigger for **every
  launch after the first post-upgrade fetch** — but it does **not** retroactively
  invalidate an already-cached *pre-fix* `index.html`, so exactly one launch (see Notes)
  can still 401 with manual-Reload-only recovery. We accept that single residual rather
  than take on B's auth-path complexity now; if that one-time flash proves annoying in
  practice, B (or a one-time cache-bust) is the follow-up.
- **Rejected — approach C (Electron cache clearing in `main.ts`):** narrow, leaves the
  architectural fragility in place, pokes the desktop sidecar seam for no gain over A.

## Acceptance criteria

1. **[test]** A `200 text/html` response (the `MapFallbackToFile` `GET /` path, which the
   unit harness exercises) carries `Cache-Control: no-store` as its **final** header value
   alongside the `prism-session` cookie. Regression test reds on `origin/main` (header
   absent), greens on head. *Coverage boundary:* the unit `WebApplicationFactory` does not
   engage `UseStaticWebAssets`, so this asserts the middleware-level injection only, not the
   built-bundle `MapStaticAssets` path — AC#2 covers that.
2. **[manual — load-bearing]** On a **real built desktop bundle**, cold relaunch no longer
   surfaces the `HTTP 401` auth-state modal. This is the only check of the actual
   production serving path (`MapStaticAssets`), so it is required, not optional. Issue
   instrumentation: renderer cookie value vs the sidecar's `SessionTokenProvider.Current`
   (expect match after fix); the `GET /` response is `200` with `Cache-Control: no-store`
   and a `Set-Cookie`, not `304`.
3. **[review]** The `SessionTokenMiddleware` comment describes the `no-store` re-fetch
   mechanism; no claim of a nonexistent reload remains.

## Test plan

- Backend integration test (mirrors existing `SessionTokenMiddleware` / cookie-stamping
  tests): assert a `200 text/html` response carries both `Set-Cookie: prism-session=…`
  and a **final** `Cache-Control: no-store` (asserts the header value actually sent, to
  pin the overwrite-wins behavior). Negative guard: a non-`text/html` response (e.g. a JSON
  API 200 routed through the same middleware) does **not** get `no-store` from this branch.
- Full backend `dotnet test` suite green (no regression to the existing stamping/auth
  tests).
- Manual desktop cold-relaunch confirmation recorded in the PR `## Proof`.

## Notes

- One-time upgrade artifact (the single case Part 1 does **not** cover): the first launch
  after this ships may `304` once on the already-cached *pre-fix* `index.html` (which has
  no `no-store`), 401, and — with approach B deferred — recover only via a manual Reload.
  That one Reload fetches the `no-store` response, replacing the cached copy; every launch
  after is clean. Accepted as a one-time flash, not hand-waved; B/cache-bust is the
  follow-up if it annoys in practice.
- Related: #282 (cold-start *time*), #369 (manual launcher validation). Distinct.
