# Parallel agents: parameterize port + dataDir (#217)

**Tier:** T2 (Light) · **Risk:** hands-off · **Branch:** `fix/217-parameterize-port-datadir`

## Problem

Multiple agents/worktrees cannot run the app + Playwright in parallel on one
machine: they collide on **port** and on **data store**. The trigger symptom —
"running the app on a non-default port doesn't work" — is the keystone bug.

## Root cause (confirmed against the live tree)

The app is already parallelism-ready; every defect is in the wrapper/orchestration
layer. Confirmed by reading the files at `2418c97` (origin/main):

1. **`run.ps1` clobbers the port via the launch profile.** `run.ps1:150` runs
   `dotnet run --project PRism.Web @DotnetArgs` **without `--no-launch-profile`**,
   so the `http` profile applies and `launchSettings.json:8`
   (`applicationUrl: http://localhost:5180`) pins the port to 5180 and forces
   `ASPNETCORE_ENVIRONMENT=Development`, overriding any `--urls`. **This is the
   keystone bug.** (`frontend/playwright.config.ts:54` already dodges it with
   `--no-launch-profile`.)
2. **`run.ps1` hardcodes the store.** `run.ps1:34` sets
   `$dataDir = %LocalApplicationData%\PRism` with no `-DataDir` param, so every
   instance shares one store (`state.json`, token cache, logs) and the second
   instance contends on the lockfile.
3. **`frontend/playwright.config.ts` hardcodes port 5180** (`command`/`url` at
   `:54–55`, `baseURL` at `:87`) and uses `reuseExistingServer: !isCI` (`:56`), so
   a local run silently **reuses whatever server is already on 5180** — possibly
   another agent's, pointed at a different dataDir. (Its dataDir is already a
   per-run temp dir at `:11` — fine.)

### Scope correction — AC #4 (`desktop/playwright.config.ts`) does NOT hold

The issue's claim #4 ("desktop needs the same port parameterization") is
**incorrect**. The desktop harness is architecturally different and **already
fully parallel-safe**:

- `desktop/playwright.config.ts` has **no `webServer`, no `baseURL`, no port** —
  Electron launches the sidecar itself.
- `desktop/src/sidecar.ts:40` spawns the backend with
  `["--no-browser", ...(opts.dataDir ? ["--dataDir", opts.dataDir] : [])]` —
  **no `--urls`** — so the backend auto-selects a free port
  (`PortSelector.SelectFirstAvailable`) and the shell reads it from stdout via
  `parsePortFromLine` (`desktop/src/ports.ts:2`). That is the issue's own "most
  robust" **Approach A** — desktop already implements it.
- dataDir (`PRISM_DATA_DIR` → `tmp("prism-e2e-")`) and userDataDir
  (`tmp("prism-ud-")`) are already per-launch temp dirs
  (`desktop/test/shell.e2e.ts:23–43`).

Two parallel desktop **e2e runs** therefore already get distinct auto-ports +
private stores with **zero changes**. **No change is made to the desktop config.**
AC #4 is reframed as "verified already parallel-safe (auto-port); no change
needed," with the evidence above carried into the PR `## Proof`.

**Precision (review finding — applied):** the parallel-safety here is a property
of the *e2e harness* (which injects per-launch `PRISM_DATA_DIR` + temp
`--user-data-dir`), not of the desktop config under test, and not of two *real*
desktop instances. Real desktop instances are mutually exclusive by the
**single-instance lock** (`app.requestSingleInstanceLock()` in
`desktop/src/main.ts`, keyed on Electron userData / app identity — not dataDir),
and a real desktop instance with the default dataDir shares
`%LocalApplicationData%\PRism` with a default `run.ps1`. So the desktop config
genuinely needs no change, but the parallel-agent story is a `run.ps1` +
frontend-e2e story; the desktop nuances are documented in
`.ai/docs/parallel-agent-testing.md` (§3) rather than hand-waved as "fully
parallel-safe."

## Approach — C (chosen in the issue)

Make port + dataDir parameterizable with today's values as defaults; the
launch-profile fix is the keystone. Smallest diff that satisfies the criteria.

### 1. `run.ps1`

Add two params (defaults preserve today's behavior exactly):

```powershell
param(
    [ValidateSet('None', 'Token', 'Auth', 'Full')]
    [string]$Reset = 'None',

    [int]$Port = 5180,

    [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PRism'),

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$DotnetArgs
)
```

- Replace the hardcoded `$dataDir` (line 34) with the `$DataDir` param. Because
  PowerShell variable names are case-insensitive, `$dataDir` (the old local) and
  `$DataDir` (the new param) are the **same variable** — so deleting line 34 and
  renaming the param to `$DataDir` makes the existing `-Reset` switch
  (`Remove-TokenCacheFiles -DataDir $dataDir`, `Set-...Sentinel -DataDir $dataDir`,
  `Remove-Item -LiteralPath $dataDir`) pick up the param with no further edits. Do
  **not** keep both a `$dataDir` local and a `$DataDir` param (they alias). (AC:
  "-Reset operates on resolved -DataDir.")
- **`-Reset` destructive-path guard (security finding — applied).** Before the
  `switch ($Reset)` block, when `$Reset -ne 'None'`, validate `$DataDir`:
  reject empty/whitespace; resolve to absolute (`[System.IO.Path]::GetFullPath`);
  refuse a small denylist of paths whose recursive deletion would be
  catastrophic — the repo root (`$PSScriptRoot`), `$env:USERPROFILE`,
  `%LOCALAPPDATA%` itself (vs. its `\PRism` child — the default is allowed),
  `$env:TEMP` itself (vs. a `\PRism-*` child), and any drive root / path shallower
  than 2 segments below a drive. This blocks the concrete footgun: after
  `Push-Location $PSScriptRoot`, `./run.ps1 -DataDir . -Reset Full` would otherwise
  recursively delete the repo checkout. The guard runs only on `-Reset`, so the
  normal launch path is untouched. (The default `%LocalApplicationData%\PRism` is
  explicitly allowed so today's `-Reset` behavior is preserved.)
- Launch line becomes:

  ```powershell
  if (-not $env:ASPNETCORE_ENVIRONMENT) { $env:ASPNETCORE_ENVIRONMENT = 'Development' }
  dotnet run --project PRism.Web --no-launch-profile --urls "http://localhost:$Port" -- --dataDir $DataDir @DotnetArgs
  ```

  - **`--no-launch-profile` is the keystone (drops the port pin) but it also drops
    the profile's `ASPNETCORE_ENVIRONMENT=Development`. We restore Development
    explicitly** (only when unset, so callers/CI can still override). This is
    load-bearing, NOT a cosmetic env detail: in **Development** the default host
    builder auto-enables static-web-assets resolution (the dev-time
    `PRism.Web.staticwebassets.endpoints.json` manifest), so `MapStaticAssets` /
    `MapFallbackToFile("index.html")` serve the SPA bundle. In **Production**
    that auto-enable does not fire (it expects a *published* `wwwroot`), so a bare
    `dotnet run` serves bundle JS/CSS as `200 OK` / 0 bytes and the SPA never
    mounts. Preserving Development keeps run.ps1's behavior byte-for-byte
    equivalent to today (which already runs Development via the profile) while
    making only the **port** newly overridable. This corrects the prior draft,
    which wrongly claimed Production "matches reality" — confirmed wrong by two
    reviewers and prior project experience (the published single-binary uses a
    *different*, publish-time asset path, so "published Production works" does
    **not** transfer to `dotnet run` Production).
  - `--urls` is a host arg (before `--`); `--dataDir`/`--no-browser` are app args
    (after `--`). `Program.cs:45` reads `--dataDir` directly from argv
    (`CommandLineOptions.GetValue`), order-independent, so the value binds
    regardless of `@DotnetArgs` content. `Program.cs:156` reads `--urls` from
    `Configuration["urls"]` → `ExtractPort`, so the port binds.
  - **Contract note (verified, not assumed).** Today `@DotnetArgs` is spliced
    before any `--`. A repo-wide grep of every documented `run.ps1` invocation
    (CI workflows, all `docs/plans/*`, `docs/solutions/*`, README) shows the only
    args ever passed are `-Reset <mode>` (a script param) and `--no-browser` (an
    *app* arg `dotnet run` already forwards). No caller passes a `dotnet run` host
    flag (`-c`, `-v`, `--no-build`, …). So routing `@DotnetArgs` after `--` is
    safe for every known caller. Header comment updated from "args go to
    `dotnet run`" to "args go to the app (e.g. `--no-browser`)."

### 2. `frontend/playwright.config.ts`

```ts
const e2ePort = Number(process.env.PRISM_E2E_PORT ?? 5180);
const isDefaultPort = e2ePort === 5180;
```

- `command`: `--urls http://localhost:${e2ePort}`; `url`:
  `http://localhost:${e2ePort}/api/health`; `prodProject.use.baseURL`:
  `http://localhost:${e2ePort}`.
- `reuseExistingServer: !isCI && isDefaultPort` — never reuse when a non-default
  port is requested (avoids cross-agent reuse). Default-port local runs keep
  today's reuse behavior.
- **Make the per-run `DataDir` collision-proof (applied finding).** Today
  `e2eDataDir = path.join(os.tmpdir(), \`PRism-e2e-${Date.now()}\`)` (`:11`); two
  suites started in the same millisecond would share one backend store —
  defeating the parallel-isolation this slice promises. Switch to
  `fs.mkdtempSync(path.join(os.tmpdir(), 'PRism-e2e-'))` (the same collision-proof
  primitive the desktop harness already uses in `shell.e2e.ts`). One-line change,
  squarely in scope.

### 3. Per-worktree convention + a dedicated agent-facing testing guide

The user expanded this deliverable: publish **clear, agent-facing instructions**
for an agent to test the tool *solo* without clashing with other running
sessions. The home for that is a new doc, **`.ai/docs/parallel-agent-testing.md`**
(referenced from `.ai/docs/development-process.md`, the `.ai/README.md` index, and
the CLAUDE.md docs table), with a one-line pointer from
`development-process.md`. The documented **rule** (not a script — keeps the diff
minimal; the issue allows "helper *or* documented rule"):

- Each agent works in its **own git worktree** (already mandated by the global
  worktree rule), so each has a private `frontend/`/`wwwroot` build output — no
  build-output collision. **Two `run.ps1` from the *same* checkout WOULD collide
  on `wwwroot`** — the per-worktree rule is what prevents that, so it is stated
  explicitly.
- Assign each worktree a distinct `(port, dataDir)`:
  - **port `= 5200 + N`** for worktree index `N = 0, 1, 2, …`. **Start the band at
    5200, NOT 5180** — `PortSelector` auto-selects from **5180–5199**
    (`PortSelector.DefaultFrom/To`) and **5181 is reserved** for the real-flow e2e
    suite (`playwright.real.config.ts`). A pinned port inside 5180–5199 collides
    with the app's own auto-port pool and the real-flow suite. 5200+ clears both.
  - **dataDir `= %TEMP%\PRism-wt-<N>`** (or any private path). The primary checkout
    may keep the defaults (5180 / `%LocalApplicationData%\PRism`); every
    non-primary worktree MUST set both.
- App: `./run.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0 --no-browser`.
- Frontend e2e: `$env:PRISM_E2E_PORT=5200; npm run test:e2e` (dataDir is already a
  per-run unique temp dir — see §2).
- **Desktop:** no `(port, dataDir)` assignment needed — the Electron shell
  auto-discovers the sidecar's port and the e2e harness injects per-launch temp
  `PRISM_DATA_DIR` + `--user-data-dir`. But note the **single-instance lock**
  (`app.requestSingleInstanceLock()`, keyed on Electron userData / app identity,
  not on dataDir): you cannot run two *real* desktop instances at once, and a
  real desktop instance with the **default** dataDir shares
  `%LocalApplicationData%\PRism` with a default `run.ps1` — so to mix a desktop
  instance into a parallel session, give it a private store via `PRISM_DATA_DIR`.
- **Credential note:** an agent dataDir under `%TEMP%` accumulates a live token
  cache (`PRism.tokens.cache`). `%TEMP%` is user-private on Windows, so this is
  not a broad-exposure issue, but prefer a **minimal-scope (read-only) PAT** for
  test runs and run `-Reset Token -DataDir <path>` to clear it when done.
- Zero-config alternative (documented, not default): omit `-Port`/`PRISM_E2E_PORT`
  only in the primary worktree; non-primary worktrees must set them. (Auto-port
  for `run.ps1` itself — omitting `--urls` so the app self-selects from 5180–5199
  — is **out of scope**; it is the issue's deferred Approach A.)

## Test plan

**Non-bug (enhancement) work → proof is test-first artifacts + the acceptance
checklist** (per the issue-resolution workflow's Proof rules).

- **`frontend/playwright.config.ts` → test-first vitest smoke test**
  (`frontend/__tests__/playwright-config.smoke.test.ts`). Same *spirit* as
  `vite-config.smoke.test.ts` (a fast config tripwire), but a **different
  mechanism**: that precedent uses Vite's `loadConfigFromFile()`; the playwright
  config reads `process.env` at module top-level, so this test uses
  `vi.resetModules()` + dynamic `await import('../playwright.config')` with the env
  set per case, and **restores env in `afterEach`** (`vi.unstubAllEnvs()` / restore
  `process.env.CI`/`PRISM_E2E_PORT`) so it doesn't leak into sibling tests in the
  same worker. Asserts, under different `PRISM_E2E_PORT`/`CI` envs:
  - default (unset) → `baseURL`, `webServer[0].url`, and `command` all use 5180;
    `reuseExistingServer === true` when `CI` unset.
  - `PRISM_E2E_PORT=5300` → all three reflect 5300; `reuseExistingServer === false`
    (non-default port). (Test value 5300 is outside the 5180–5199 auto-port band
    and the reserved 5181 real-flow port, matching the §3 convention.)
  - `CI=1` → `reuseExistingServer === false` regardless of port.
  Written **red first** (asserting templated values the current hardcoded config
  doesn't produce), then green after the config change.

- **`run.ps1` → acceptance run (NOT a unit test) — documented deviation.** The
  repo has **no PowerShell test harness** (zero `*.Tests.ps1`, no Pester in CI);
  introducing Pester exceeds Approach C's "smallest keystone diff." `run.ps1` is
  therefore validated by a captured acceptance run, recorded in `## Proof`:
  1. `./run.ps1 -Port 5200 -DataDir <temp-A> --no-browser` → assert the app prints
     `PRism listening on http://localhost:5200 (dataDir: <temp-A>)` — port honored
     (launch-profile no longer wins).
  1a. **SPA actually mounts (catches the Production/empty-asset regression class).**
     `curl http://localhost:5200/` → non-empty `index.html`; then `curl` one hashed
     bundle URL referenced in that HTML → assert `Content-Length > 0` and a sane
     `Content-Type` (the empty-asset failure mode is `200 OK` / 0 bytes / empty
     MIME). `/api/health` alone is insufficient — the host binds and prints the
     port before any asset request, so a health 200 says nothing about whether
     `MapStaticAssets` serves the bundle. This step is the guard for the
     Development-env fix in §1.
  2. Concurrently, `./run.ps1 -Port 5201 -DataDir <temp-B> --no-browser` → both
     run without lockfile contention; each store lands under its own temp dir.
  3. `-Reset Token -DataDir <temp-A>` deletes `<temp-A>\PRism.tokens.cache` (never
     the real `%LocalApplicationData%\PRism`). **`-Reset` is only ever run against
     throwaway temp dirs during validation.**
  4. Defaults: `./run.ps1 --no-browser` (no `-Port`/`-DataDir`) → port **5180**,
     store at `%LocalApplicationData%\PRism` (unchanged from today).

- **`development-process.md` → docs**; no test.

## Acceptance criteria → coverage

| Criterion | Covered by |
|---|---|
| `./run.ps1 -Port <N> -DataDir <path>` honors the port | run.ps1 §1 + acceptance run step 1 |
| Two instances with distinct (port, dataDir) run concurrently | run.ps1 §1 + acceptance run step 2 |
| `PRISM_E2E_PORT` drives the frontend suite; two suites on distinct ports run in parallel | config §2 + smoke test + collision-proof `mkdtempSync` dataDir |
| ~~`desktop/playwright.config.ts` parameterized~~ | **Reframed:** already parallel-safe (auto-port); no change — see Scope correction |
| Defaults unchanged (5180 / `%LocalApplicationData%\PRism`, **and env=Development**) | param defaults + explicit Development restore (§1) + smoke test default case + acceptance steps 1a & 4 |
| `-Reset` operates on resolved `-DataDir` (with destructive-path guard) | run.ps1 §1 |
| Parallel-agent workflow documented | §3 → `.ai/docs/parallel-agent-testing.md` + pointer in `development-process.md` |

## Risk classification

Hands-off. Orchestration/wrapper only; no app code change; no UI (B1); no risk
surface (B2). The `-Reset` refactor parameterizes the *path* the existing delete
targets — it does not alter token-storage logic, and the default path is
unchanged. `-Reset` is validated against throwaway dirs only.

## Considered & rejected

- **Approach A (zero-config auto-port for `run.ps1` + dynamic Playwright
  discovery):** the issue's deferred option; needs `globalSetup`-managed server
  lifecycle + port discovery for the frontend suite (Playwright's static
  `url`/`baseURL` can't be dynamic). Out of scope; reserved as an upgrade.
- **Pester for `run.ps1`:** adds a test framework + CI job for one launcher
  script — exceeds the keystone diff. Acceptance run substitutes.
- **Per-worktree helper script:** more surface than a documented formula for a
  three-worktree workflow; the rule in §3 suffices.

## Doc-review dispositions (1× `ce-doc-review`, T2)

Four reviewers (coherence, feasibility, adversarial, security-lens). Carried into
the PR `## Proof`.

| # | Reviewer | Finding | Severity | Disposition |
|---|---|---|---|---|
| 1 | feasibility + adversarial + (prior exp.) | `--no-launch-profile` flips run.ps1 to Production → SPA static assets break (empty-MIME / 0-byte bundle); "published Production works" doesn't transfer to `dotnet run` | high | **Applied.** Restore `ASPNETCORE_ENVIRONMENT=Development` (when unset) alongside `--no-launch-profile`; defaults now truly unchanged incl. env. |
| 2 | feasibility | Acceptance plan never loads the SPA, so it can't catch finding #1 | medium | **Applied.** Added acceptance step 1a (curl `/` + a hashed bundle URL, assert non-empty body / `Content-Type`). |
| 3 | adversarial | `port = 5180 + N` collides with the app's own auto-port band (5180–5199) and the reserved 5181 real-flow port | medium | **Applied.** Convention starts at **5200 + N**, with the band/reserved-port rationale documented. |
| 4 | security-lens | `-Reset Full` on a user-supplied `-DataDir` (relative/parent path) → unbounded recursive delete (e.g. `-DataDir . -Reset Full` after `Push-Location $PSScriptRoot` wipes the repo) | high | **Applied.** Added a destructive-path guard before the `-Reset` switch (reject empty/whitespace, resolve absolute, denylist repo root / `%USERPROFILE%` / `%LOCALAPPDATA%` / `%TEMP%` / shallow paths). |
| 5 | adversarial | Frontend `e2eDataDir` uses `Date.now()` → same-ms collision shares a store; defeats parallel isolation | low | **Applied.** Switch to `fs.mkdtempSync` (collision-proof; matches desktop harness). |
| 6 | adversarial | "desktop fully parallel-safe" overclaims — it's the e2e *harness*, not the real app (single-instance lock + shared default store) | medium | **Applied.** Narrowed the scope-correction wording; documented the desktop nuances in §3 / the agent guide. |
| 7 | feasibility | vitest precedent mis-cited (`vite-config.smoke` uses `loadConfigFromFile`, not `resetModules`); env-cleanup unspecified | low | **Applied.** Reworded the test plan to the correct mechanism + `afterEach` env restore. |
| 8 | adversarial | "only consumer is `--no-browser`" asserted, not verified | medium | **Applied.** Repo-wide grep confirms only `-Reset`/`--no-browser` are ever passed; recorded as verified. |
| 9 | security-lens | Agent dataDirs in `%TEMP%` accumulate a live PAT cache | low | **Applied.** Added a credential note (minimal-scope PAT; `-Reset Token` cleanup). |
| 10 | feasibility / security | `--urls`→`Configuration["urls"]` ordering sound; bind stays loopback | FYI | **No action** — confirmations, not defects. |

User-driven scope addition (post-review): publish a dedicated agent-facing
testing guide — `.ai/docs/parallel-agent-testing.md` (§3), linked from
`development-process.md`, the `.ai/README.md` index, and the CLAUDE.md docs table.

## Implementation deviations (recorded during execution)

- **`PortSelectorTests` made parallel-safe (added to scope).** During the
  acceptance run, a **real second agent** was running the app on the default port
  **5180**. `dotnet test` then failed: `PortSelectorTests` hard-bound real ports in
  the production **5180–5199** band (`new TcpListener(IPAddress.Loopback, 5180)`),
  which collided with the running app — `TcpListener.Start()` threw
  `AddressAlreadyInUse`. This is the exact parallelism #217 enables, surfacing in
  the *test suite*: any agent running `dotnet test` while any app holds a port in
  5180–5199 would fail. Fix (test-only): the tests now exercise the selection
  algorithm over a **dynamically-discovered isolated high range**
  (`SelectFirstAvailable(from, to)` is already parameterized), with a separate
  constants test pinning the production 5180–5199 range. Verified: the 4 tests pass
  **while the other agent was still bound to 5180**. `Random` → `Guid`-hash scan
  start to satisfy `CA5394` (warnings-as-errors).
- **Frontend port parse uses `Number(env) || 5180`** (not the spec's
  `Number(env ?? 5180)`) so an empty-string `PRISM_E2E_PORT` falls back to 5180
  rather than parsing to `0`. Strictly more robust; same intent.
- **Smoke test loads the config via a runtime file URL**
  (`new URL('../playwright.config.ts', import.meta.url)` + dynamic import), not a
  static `import('../playwright.config')`. A static specifier dragged
  `playwright.config.ts` into `tsconfig.app.json`'s graph and failed `tsc -b` with
  TS6307 (the config is intentionally outside tsc's project graph). The runtime URL
  keeps it out of static analysis while vitest still resolves it — the same
  load-via-runtime-path approach `vite-config.smoke.test.ts` uses.
