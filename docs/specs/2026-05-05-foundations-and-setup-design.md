# S0+S1 — Foundations + Setup: Design

**Slice**: S0 + S1 (combined) — first slice in [`docs/roadmap.md`](../../roadmap.md).
**Date**: 2026-05-05.
**Status**: Design approved; pending implementation plan via writing-plans skill.
**Branch**: `spec/foundations` (worktree at `C:\src\PRism-foundations`).
**Source authorities**: [`docs/spec/`](../../spec/) is the PoC specification this slice implements; [`design/handoff/`](../../../design/handoff/) is the visual reference. This document does not restate the PoC spec; it commits to a specific subset and adds slice-specific decisions.

---

## 1. Goal

Ship a walking skeleton: every project compiles, the host boots cross-platform, the OS keychain works, the first GitHub round-trip succeeds, and the design tokens render on a real React surface. Nothing else.

End-to-end demo at slice completion:

1. Run the binary (or `dotnet run` in dev).
2. Browser auto-launches at `http://localhost:<5180–5199>`.
3. If no token is in the keychain → Setup screen.
4. User pastes a fine-grained GitHub PAT → backend calls `GET /user` against the configured `github.host` → either inline error or success.
5. On success → app routes to a placeholder Inbox shell ("Inbox coming soon" + the production top-chrome).
6. Header controls flip theme (light / dark / system), accent (indigo / amber / teal), and AI preview (on / off). All three persist to `config.json`; AI preview flips `/api/capabilities` reporting (no visible AI yet because no host components for AI slots exist in this slice).
7. Quit and relaunch → token survives in keychain → app boots straight to the Inbox shell.

No inbox loading. No PR detail. No drafts. No submit. No SSE. No real AI providers.

## 2. Scope

### In scope

- **Solution skeleton** — `PRism.sln` with seven projects + `frontend/` + `tests/` (see § 3).
- **ASP.NET Core minimal-API host** with port selection from 5180–5199, atomic `state.json.lock` (`O_EXCL`/`CREATE_NEW` create, PID-liveness fallback, binary-path-aware false-positive defense, torn-write recovery), browser auto-launch via `Process.Start`, `--no-browser` flag.
- **Cross-platform paths** via `Environment.GetFolderPath(SpecialFolder.LocalApplicationData)` for `<dataDir>`. No hardcoded `%APPDATA%` / `~/...` anywhere.
- **Stores**:
  - `IAppStateStore` (JSON, atomic-rename writes, in-memory mutex with rollback on flush failure).
  - `ConfigStore` (JSON, `FileSystemWatcher` hot-reload, mtime-poll fallback at 30s when watcher fails to register).
  - `TokenStore` (MSAL Extensions; transient/commit/rollback API for PAT validation; per-platform error messaging).
- **State migration safeguard** — `version: 1` field + load-time version check + refuse-to-load on unknown version. **Migration runner is not in scope** (no schema change yet); the *check* prevents accidentally loading a v2 file in a v1 binary.
- **Forensic state-event log** — `IStateEventLog` interface + `Noop` impl. Real append + rotation deferred to S4.
- **AI seam scaffolding** — every interface from [`spec/04-ai-seam-architecture.md`](../../spec/04-ai-seam-architecture.md) declared in `PRism.AI.Contracts` with both `Noop*` (default) and `Placeholder*` (canned data lifted from `design/handoff/data.jsx`) implementations. `IAiSeamSelector` resolves at request time based on `ui.aiPreview`.
- **`/api/capabilities`** — reflects `ui.aiPreview` from `ConfigStore` at request time; returns `false` for every `ai.*` flag when off, `true` when on.
- **`IReviewService` interface** in `PRism.Core` with the full GitHub-shaped surface from [`spec/02-architecture.md`](../../spec/02-architecture.md). **Only `ValidateCredentialsAsync` is implemented** in `GitHubReviewService`; every other method throws `NotImplementedException`. This is deliberate — methods land slice-by-slice as their consumer arrives.
- **`github.host` config** — derives Octokit base URL (`https://github.com` → `https://api.github.com`; any other host → `<host>/api/v3`). Setup-screen "generate PAT" link templates against the same field.
- **Host-change-between-launches detection** — `state.json.lastConfiguredGithubHost` compared against `config.github.host` at startup. Mismatch surfaces a modal that blocks routing until resolved (Continue clears `pendingReviewId` / `pendingReviewCommitOid` / per-thread / per-reply stamps, preserves draft bodies, updates `lastConfiguredGithubHost`; Revert rewrites `config.json` with the old host and signals process exit).
- **Frontend** — React 19 + Vite 6 + TypeScript 5.x; `tokens.css` ported verbatim from the design handoff; per-component `*.module.css`; native `fetch` wrapped in a tiny client (~50 LOC) that adds `X-Request-Id`, parses ProblemDetails, and surfaces toasts.
- **Setup screen** — PAT entry per [`design/handoff/`](../../../design/handoff/) (mask/unmask, scope pills with copy buttons, host-aware "generate PAT" link, inline error pill on validation failure, Continue button with spinner).
- **Landing shell** — top-chrome (header with logo, Inbox/Setup tabs, **empty** PR tab strip — no tabs because no PRs are loaded), placeholder Inbox page ("Inbox coming soon").
- **Header controls** — three discrete icon buttons in the right cluster of the header: theme cycle (sun/moon/auto), accent cycle (3 colored dots), AI preview toggle (sparkle on/off). All write through to `config.json` via `POST /api/preferences`.
- **Theme + accent application** — `<html data-theme="…">` for theme; CSS vars `--accent-h` and `--accent-c` set on root for accent. Same mechanism as design handoff's `tokens.css`.
- **Logging** — `Microsoft.Extensions.Logging` to console + rolling text file at `<dataDir>/logs/prism-YYYYMMDD.log`. Levels: `Information` (default), `Debug` (via `config.logging.level`). PAT contents and other sensitive values redacted via a `LogScrub` helper.
- **CSRF defense** — Origin-header middleware on POST endpoints (rejects requests where `Origin` doesn't match the bound port). The full session-token model arrives with SSE in S2; this slice ships a strict subset sufficient for the POSTs it serves.
- **Test infrastructure** — xUnit + Moq + `WebApplicationFactory<Program>` for backend; Vitest + Testing Library + MSW for frontend unit; Playwright for E2E. `IClock` injection. Real temp directories for file I/O (no `IFileSystem` mock).
- **CI** — `.github/workflows/ci.yml` running `dotnet build`/`test`, `npm run lint`/`build`/`test`/`playwright test` on `windows-latest` only. macOS CI lands in S6 with code signing.
- **Linting** — `dotnet format --verify-no-changes` in CI; ESLint + Prettier in CI + Husky pre-commit hook with lint-staged. `.editorconfig` at repo root.

### Explicitly out of scope

Inbox loading from GitHub; PR detail view; file tree; diff viewer; iteration tabs; comments; drafts; composer; reconciliation matrix; submit pipeline; verdict logic; SSE plumbing; per-tab subscribe/unsubscribe; multi-tab consistency events; active-PR poller; inbox poller; banner refresh; markdown rendering with Mermaid; word-level diff; keyboard shortcuts beyond Setup form ergonomics; cheatsheet; tweaks panel; settings page; tests for submit/reconciliation/migration runner; single-file publish profiles; macOS Gatekeeper / Windows SmartScreen first-run copy; accessibility deep audit (baseline only); Linux active testing; `IReviewService` methods other than `ValidateCredentialsAsync`; the real `IStateEventLog` append+rotation; the migration runner.

### Acknowledged carryforwards

Reserved-but-not-actively-used schema fields, included now to avoid retrofit pain:

- `state.json` includes: `version`, `reviewSessions: {}`, `aiState: { repoCloneMap: {}, workspaceMtimeAtLastEnumeration: null }`, `lastConfiguredGithubHost`.
- `config.json` includes the full strawman from [`spec/02-architecture.md`](../../spec/02-architecture.md) § Configuration schema (`polling`, `inbox.sections`, `review`, `iterations`, `logging`, `ui`, `github`, `llm`). S0+S1 reads `logging.level`, `ui.theme`, `ui.accent`, `ui.aiPreview`, `github.host`. The rest are persisted-but-ignored; their presence locks the wire shape so v2 features don't reshape the file.

## 3. Project structure

```
PRism.sln
├── PRism.Core                  ← IReviewService interface, IAppStateStore, ConfigStore, ReviewEventBus,
│                                  BrowserLauncher, port selector, lockfile manager, IClock, IAiSeamSelector
├── PRism.Core.Contracts        ← provider DTOs (Pr, FileChange, DraftReview, PrReference, Verdict, ExistingComment,
│                                  AuthValidationResult, etc.)
├── PRism.AI.Contracts          ← AI seam interfaces + DTOs + Noop* default implementations
├── PRism.AI.Placeholder        ← Placeholder* impls returning canned data (lifted from design/handoff/data.jsx)
├── PRism.GitHub                ← Octokit + raw GraphQL; GitHubReviewService (only ValidateCredentialsAsync this slice)
├── PRism.Web                   ← ASP.NET Core host, REST API, DI composition root, static React serving
├── tests/
│   ├── PRism.Core.Tests
│   ├── PRism.GitHub.Tests
│   └── PRism.Web.Tests
└── frontend/                       ← React + Vite + TS source (built into PRism.Web/wwwroot at publish)
    ├── src/
    │   ├── api/                    ← thin HTTP client + typed bindings to backend endpoints
    │   ├── components/             ← Setup, Header, HeaderControls, ThemeToggle, AccentPicker,
    │   │                              AiPreviewToggle, ScopePill, MaskedInput, etc.
    │   ├── pages/                  ← SetupPage, InboxShellPage, HostChangeModal
    │   ├── styles/                 ← tokens.css (verbatim), screens.css (adapted)
    │   ├── ai-slots/               ← capability-flag-gated slots; declared, render null in this slice
    │   ├── hooks/                  ← usePreferences, useCapabilities, useAuth
    │   └── types/api.ts            ← hand-mirrored from PRism.Core.Contracts (NSwag deferred)
    ├── __tests__/                  ← Vitest unit tests
    ├── e2e/                        ← Playwright E2E
    └── vite.config.ts
```

**Reference graph** (source-level Octokit isolation enforced — only `PRism.GitHub` carries `using Octokit;`):

- `PRism.Core` → `PRism.Core.Contracts`, `PRism.AI.Contracts`
- `PRism.GitHub` → `PRism.Core`, `PRism.Core.Contracts` *(only project with `using Octokit;`)*
- `PRism.AI.Placeholder` → `PRism.AI.Contracts`
- `PRism.Web` → `PRism.Core`, `PRism.GitHub`, `PRism.AI.Contracts`, `PRism.AI.Placeholder`
- Test projects → corresponding source project + xUnit + Moq

`PRism.Web` takes a transitive *binary* dependency on Octokit through DI registration but **no `using Octokit;` source directive** appears in any of its files. This is the source-hygiene rule from [`spec/02-architecture.md`](../../spec/02-architecture.md) § Dependency rule, not a binary-isolation promise.

## 4. Stack lock-in

| Layer | Choice |
|---|---|
| Backend runtime | .NET 10 LTS (matches spec) |
| Backend framework | ASP.NET Core minimal APIs |
| Backend JSON | `System.Text.Json` + custom kebab-case `JsonNamingPolicy` registered globally on the application's `JsonSerializerOptions` |
| Backend logging | `Microsoft.Extensions.Logging` (console + rolling file via `Microsoft.Extensions.Logging.File`); no Serilog — built-in is sufficient and removes a dependency |
| Backend HTTP client | `IHttpClientFactory` with named clients keyed on `github.host` |
| Backend test framework | xUnit |
| Backend mocking | Moq |
| Frontend | React 19 + Vite 6 + TypeScript 5.x |
| Frontend routing | React Router v7 (data router mode) |
| Frontend HTTP | native `fetch` wrapped in `~50 LOC` client; adds `X-Request-Id`, parses ProblemDetails, surfaces toasts |
| Frontend styling | Vanilla CSS — `tokens.css` (verbatim) + per-component `*.module.css`. No Tailwind, no CSS-in-JS |
| Frontend state | `useState` + `useContext` only |
| Frontend test | Vitest + Testing Library + MSW; Playwright for E2E |
| Pre-commit | Husky + lint-staged (ESLint / Prettier); `dotnet format --verify-no-changes` as a separate hook step |

**Versions**: pinned in `Directory.Packages.props` (backend) and `package.json` (frontend) at first commit. Concrete versions captured by writing-plans during plan generation.

## 5. Data flow

### 5.1 Cold start

```
launch → parse args (--no-browser?)
  → resolve <dataDir> via Environment.SpecialFolder.LocalApplicationData
  → acquire <dataDir>/state.json.lock (atomic CreateNew; PID-liveness fallback; torn-write recovery)
  → load <dataDir>/state.json (version check; refuse-on-unknown; create empty v1 if missing)
  → load <dataDir>/config.json (create from defaults if missing); start FileSystemWatcher
  → host-change check: state.lastConfiguredGithubHost vs config.github.host → if mismatch, set startup flag
  → keychain probe: TokenStore.HasToken() → bool
  → register Noop* + Placeholder* AI seam impls (both); selector resolves at request time per ui.aiPreview
  → pick port from 5180–5199; bind ASP.NET Core; serve wwwroot static assets
  → unless --no-browser, BrowserLauncher.Open("http://localhost:<port>")
```

### 5.2 First-run / returning launch routing

```
GET /                          → React app loads
GET /api/auth/state            → { hasToken: bool, hostMismatch: { old, new } | null }
   → frontend routes:
       hostMismatch != null   → modal: Continue / Revert
       hasToken == false      → /setup
       hasToken == true       → /inbox-shell
```

`ValidateCredentialsAsync` runs *only* when the user submits a PAT on the Setup screen, not on every cold start. Returning users skip the GitHub round-trip; the token is trusted until proven invalid (a 401 from any later GitHub call demotes the user back to Setup, but that's S2's concern).

### 5.3 PAT entry flow (the only GitHub call in this slice)

```
user pastes PAT → frontend POST /api/auth/connect { pat: <string> }
  → backend: TokenStore.WriteTransient(pat)         [keychain write, scoped to this session token]
  → backend: GitHubReviewService.ValidateCredentialsAsync()
       → Octokit GET /user (host derived from config.github.host)
       → returns AuthValidationResult { ok, login?, scopes?, error? }
  → if ok: TokenStore.Commit() + state.lastConfiguredGithubHost = config.github.host + persist
       response: { ok: true, login: "@username", host: "https://github.com" }
       frontend: route to /inbox-shell
  → if !ok: TokenStore.RollbackTransient()
       response: { ok: false, error: "Invalid token" | "Insufficient scopes" | "Network" }
       frontend: render inline error pill on Setup
```

Transient/Commit pattern keeps a failed PAT out of permanent keychain storage — leverages MSAL Extensions' built-in transactional API.

### 5.4 Preference toggle flow (theme / accent / AI preview)

The body is a flat object with **exactly one key** matching one of the writable preference fields. Multi-key bodies are rejected with 400 (matches the spec's `/api/pr/{ref}/draft` single-field-patch convention).

```
user clicks header toggle → frontend POST /api/preferences
                              body: { "theme": "dark" }                  (single field; valid)
                                 or { "accent": "amber" }
                                 or { "aiPreview": true }
  → backend: ConfigStore.Patch(patch)
      → in-memory mutex; merge patch into ui.* slice; serialize; atomic-rename to config.json
      → FileSystemWatcher fires; ConfigStore observes its own write; idempotent re-read; no-op
  → response: { "theme": <new>, "accent": <new>, "aiPreview": <new> }    (full new ui block)
  → frontend: setState(newUi); document.documentElement.dataset.theme = newUi.theme
              CSS vars --accent-h / --accent-c reset from newUi.accent
              re-fetch /api/capabilities (since aiPreview drives the ai.* flags)
```

External `config.json` edits (the dev-mode use case): `FileSystemWatcher` fires inside the backend; `ConfigStore` re-reads; in-memory state updates. The **frontend** doesn't know without SSE (deferred to S2). In this slice, the frontend re-fetches `/api/preferences` and `/api/capabilities` on `window.onfocus` and on each route navigation.

### 5.5 Host-change-between-launches modal

Detected at cold start (§ 5.1). The modal is the only UI that can render before `/setup` or `/inbox-shell`:

```
Continue → backend clears every state.reviewSessions[*].pendingReviewId / pendingReviewCommitOid
                                / draftComments[*].threadId / draftReplies[*].replyCommentId
                                (preserves draft bodies — there are none yet, but the machinery is exercised)
           backend updates state.lastConfiguredGithubHost = config.github.host
           continue routing as normal
Revert   → backend rewrites config.json with the old github.host value
           backend exits with message "Config reverted; relaunch to take effect"
```

### 5.6 Endpoints

| Endpoint | Method | Body / Response |
|---|---|---|
| `/api/auth/state` | GET | `{ hasToken, hostMismatch? }` |
| `/api/auth/connect` | POST | `{ pat }` → `{ ok, login?, host?, error? }` |
| `/api/auth/host-change-resolution` | POST | `{ resolution: "continue" \| "revert" }` |
| `/api/preferences` | GET / POST | GET → full `ui` block. POST body is a flat single-key object (e.g. `{ "theme": "dark" }`); multi-key bodies → 400. Response: full new `ui` block. |
| `/api/capabilities` | GET | `{ ai: { summary: false, ... } }` — driven by `ui.aiPreview` |
| `/api/health` | GET | `{ port, version, dataDir }` (debug-only) |

`/api/preferences` follows the spec's single-field-patch convention used by `/api/pr/{ref}/draft` (multi-field requests rejected with 400).

### 5.7 AI seam DI binding

Both `Noop*` and `Placeholder*` implementations are registered in DI. Request handlers consume an `IAiSeamSelector` (singleton, reads `ui.aiPreview` from `ConfigStore` at call time) that returns the live impl. Equivalent alternatives considered: keyed services (.NET 8+) or rebuilding the DI container on flag flip; selector pattern chosen as the smallest and most testable.

```csharp
public interface IAiSeamSelector
{
    T Resolve<T>() where T : class;  // returns Placeholder<T> if ui.aiPreview, else Noop<T>
}
```

Because no AI host components render in this slice, no seam method is actually called from the frontend — the selector machinery is exercised only by tests in S0+S1. S2 onward, real consumers arrive.

## 6. Error handling

| Failure | Handling | User-facing message |
|---|---|---|
| All ports 5180–5199 in use | Fail loudly; no fallback. Exit code 2. | Console: *"PRism couldn't claim a port. Stop the other instance(s) (check Task Manager / Activity Monitor for `PRism`) and try again."* |
| Lockfile: another live PRism owns it | Refuse to start; exit code 3. | *"PRism is already running (PID `<n>`). Use that instance, or stop it first."* |
| Lockfile: stale (dead PID) | Log warning "Recovered from stale lockfile from PID `<n>`"; overwrite; continue. | None (silent recovery). |
| Lockfile: PID alive but not `PRism` | Treat as stale; warn; continue. | None. |
| Lockfile: torn JSON | Log "recovered from malformed lockfile"; treat as missing; continue with atomic-create. | None. |
| Lockfile race (two launches in same ms) | `O_EXCL`/`CREATE_NEW` is atomic; loser falls into "another instance" or "stale" branch. | Loser sees "PRism is already running." |
| `state.json` malformed JSON | Refuse to load. Rename to `state.json.corrupt-<timestamp>`; create fresh empty v1. Log critical with full content. | Modal at app boot: *"PRism couldn't read its saved state. Your draft work has been preserved at `<path>`. Started fresh."* |
| `state.json` unknown version | Refuse to load. No migration runner in this slice. | *"This state file was written by a newer version of PRism (v`<n>`). Use that version or delete `state.json` to start fresh."* + exit code 4. |
| `config.json` malformed JSON | Log error; load defaults; do NOT overwrite the broken file. | Banner in app: *"`config.json` couldn't be parsed; using defaults. Fix the file and reload."* |
| Atomic-rename fails on state write | Roll back in-memory mutation to pre-transaction snapshot. API returns 503 with ProblemDetails body. No `IStateEventLog` append. | API consumer sees 503; frontend toasts *"Couldn't save. Try again."* |
| MSAL: macOS unsigned-binary first-read prompt | No code change — OS shows "Always Allow / Allow / Deny". | Setup pre-warning copy explains the prompt. |
| MSAL: Linux `libsecret` missing | Detect via `DllNotFoundException`. | *"OS keychain library not installed. Install `libsecret-1` (`apt install libsecret-1-0` / `dnf install libsecret`), then restart PRism."* |
| MSAL: Linux libsecret installed but no agent | Detect via DBus/no-provider error. | *"OS keychain library is installed but no keyring agent is running. Start `gnome-keyring-daemon` or `kwalletd`, then restart PRism. Common on WSL and minimal sessions."* |
| MSAL: any other keychain failure | Pass through error. | *"OS keychain returned an error: `<message>`. See `<dataDir>/logs/` for details."* |
| PAT validation: 401 | Roll back transient token. | Setup inline error: *"GitHub rejected this token. Check that it hasn't been revoked or expired."* |
| PAT validation: classic PAT, missing scopes | Roll back transient; parse `X-OAuth-Scopes`; diff against required set. | Setup inline error: *"This token is missing scopes: `<missing>`. Regenerate with the listed scopes and try again."* |
| PAT validation: fine-grained PAT, no repos selected | Keep transient pending; both Search probes return zero. | Setup modal: *"Your token has no repos selected. You'll see an empty inbox until you add repos at GitHub. Continue anyway?"* with **Continue anyway** / **Edit token scope** actions. |
| PAT validation: 5xx GitHub | Roll back. | Setup inline error: *"GitHub returned an error. Try again in a moment."* |
| PAT validation: network / DNS / TLS | Roll back; distinguish DNS from generic. | DNS: *"Couldn't reach `<host>`. Check `github.host` in config or your network."* / Generic: *"Network error reaching GitHub. Check your connection and try again."* |
| Host-change modal closed without choosing | Backend serves only the modal-host page; refuses to route to `/setup` / `/inbox-shell`. | Modal stays sticky. |
| FileSystemWatcher fails to register | Log warning. Fall back to a 30s mtime-poll of `config.json`. | None (degraded silently). |
| Browser auto-launch failure | Log error; print URL to console regardless. | Console: *"Browser couldn't launch automatically. Open `http://localhost:<port>` manually."* |

**Global handling pattern:**

- ASP.NET Core's `UseExceptionHandler` middleware maps unhandled exceptions to RFC 9457 ProblemDetails responses with a `traceId` field correlated to the log entry.
- Every API response (success and error) carries an `X-Request-Id` header; frontend toasts on errors include this ID with a "Copy diagnostic info" button so support reports are actionable.
- Frontend has one global error boundary at the React-root level that catches render errors. Boundary copy: *"Something went wrong. The error has been logged. Try reloading."* — with reload button.

## 7. Configuration & state schemas

### 7.1 `config.json` (full strawman; S0+S1 reads only the highlighted fields)

```jsonc
{
  "polling": { "activePrSeconds": 30, "inboxSeconds": 120 },        // reserved (S2+)
  "inbox": { "sections": { /* … */ }, "showHiddenScopeFooter": true }, // reserved (S2+)
  "review": {
    "blockSubmitOnStaleDrafts": true,
    "requireVerdictReconfirmOnNewIteration": true
  },                                                                  // reserved (S5)
  "iterations": { "clusterGapSeconds": 60 },                          // reserved (S3)
  "logging": {
    "level": "info",                                                  // ✓ READ (info | debug)
    "stateEvents": true,
    "stateEventsRetentionFiles": 30
  },
  "ui": {
    "theme": "system",                                                // ✓ READ (light | dark | system)
    "accent": "indigo",                                               // ✓ READ (indigo | amber | teal)
    "aiPreview": false                                                // ✓ READ (true | false)
  },
  "github": {
    "host": "https://github.com",                                     // ✓ READ
    "localWorkspace": null                                            // reserved (P2-2 chat)
  },
  "llm": { /* full v2 strawman; reserved */ }
}
```

Defaults: when `config.json` is absent, the file is created with the values above. Hot-reload re-reads on every save.

`ConfigStore`'s `JsonSerializerOptions` enables `JsonCommentHandling.Skip` and `AllowTrailingCommas` so users can edit `config.json` with comments (jsonc-style, same convention as VS Code settings). The strawman above uses `// …` comments; a freshly-created defaults file is plain JSON without comments.

### 7.2 `state.json` (v1 schema)

```jsonc
{
  "version": 1,
  "reviewSessions": {},                                               // empty in S0+S1
  "aiState": {
    "repoCloneMap": {},
    "workspaceMtimeAtLastEnumeration": null
  },                                                                  // reserved (P2-2 chat)
  "lastConfiguredGithubHost": null                                    // set after first successful PAT
}
```

### 7.3 Lockfile (`state.json.lock`)

```jsonc
{
  "pid": 12345,
  "binaryPath": "C:\\Users\\me\\AppData\\Local\\PRism\\PRism.exe",
  "startedAt": "2026-05-05T14:23:11.000Z"
}
```

Created via `O_EXCL` / `CREATE_NEW`; PID-liveness check on collision; binary-path comparison defends against PID recycling.

## 8. Testing strategy

**Process**: TDD throughout. Every behavior listed in §§ 1–7 lands as `red → green → refactor`. The test list below is the *expected shape* of the suite at end-of-slice, not a sequenced plan.

**`PRism.Core.Tests`** — `IAppStateStore` (empty load, v1 load, unknown-version refuse, malformed-JSON quarantine, atomic-rename success, rename-failure rollback, mutex serialization); `ConfigStore` (empty load, malformed JSON → defaults without overwrite, FSW external-edit re-read, single-field patch, multi-field rejection, empty-after-trim rejection); `Lockfile` (atomic-create success/fail, PID-liveness all four branches, torn-write recovery); port selector (claim, fallback, exhaustion); migration version-check (v1, v2 refused, missing-version refused); host-change detection (match, mismatch, first-launch); AI seam selector (off → Noop, on → Placeholder, runtime flip); JSON kebab-case round-trip (every defined enum); cross-platform path resolution; `IStateEventLog` Noop verifies side-effect-free.

**`PRism.GitHub.Tests`** — Octokit base URL derivation (cloud and GHES); `ValidateCredentialsAsync` (200 happy path, 401, 403 with scopes, 5xx, network exception, DNS-distinct branch); PAT-page link templating (cloud / GHES).

**`PRism.Web.Tests`** (integration via `WebApplicationFactory<Program>`) — every endpoint listed in § 5.6 with happy and error paths; host-change-resolution endpoint (continue, revert); Origin-check middleware (same-origin allowed, cross-origin rejected); ProblemDetails / `X-Request-Id` correlation; static asset serving.

**`frontend/__tests__/`** (Vitest + Testing Library + MSW) — `SetupPage` (rendering, mask/unmask, disabled state, spinner, inline error, success routing); `HeaderControls` (each control's full cycle + correct patch body + state update from response); theme/accent application to DOM; API client (X-Request-Id surfacing, error toast with Copy button, `window.onfocus` re-fetch).

**`frontend/e2e/`** (Playwright against a test build) — cold-start happy path; returning-user flow; header preference toggles; host-change modal (Continue and Revert); `--no-browser` smoke (backend boots, `/api/health` reachable on logged port).

**Test infrastructure decisions** (per § 5 of brainstorming):
- `IClock` injection with `SystemClock` + `TestClock`.
- Real temp directories for file I/O (no `IFileSystem` mock).
- Octokit's `HttpMessageHandler` injection point + `FakeHttpMessageHandler` for HTTP fakes (don't mock `IGitHubClient`).
- MSW for frontend component test fetch fakes.
- Property-based testing skipped (defer to future slices).

**CI**: `.github/workflows/ci.yml` runs on PR + push to main:

```yaml
windows-latest:
  - dotnet restore
  - dotnet build --no-restore /p:TreatWarningsAsErrors=true
  - dotnet test --no-build --logger "trx;LogFileName=test-results.trx"
  - cd frontend
  - npm ci
  - npm run lint
  - npm run build
  - npm test
  - npx playwright install --with-deps
  - npx playwright test
```

The two existing `@claude` workflows continue to run; this is additive.

## 9. Acknowledged trade-offs

- **No SSE in this slice.** External `config.json` edits don't propagate live to the frontend; mitigated by `window.onfocus` re-fetches. SSE arrives in S2.
- **macOS CI deferred to S6** (requires signed binary + macOS runner). Manual macOS verification documented in this slice's acceptance procedure.
- **`osx-x64` not supported** per spec.
- **No single-file publish profile in this slice.** Trim/AOT issues land in S6.
- **No state migration runner.** First v1 → v2 schema change must add the runner before merging.
- **No real `IStateEventLog` impl.** Interface + Noop only; first event producer (S4) writes the real append + rotation.
- **Linux dev works in principle, isn't actively supported.** No CI; failure-mode messaging exists.
- **No accessibility deep audit.** Baseline only — semantic landmarks, keyboard tab order through Setup, ARIA on the three header icon-buttons.
- **`PRism.AI.Placeholder` data is hand-lifted from `design/handoff/data.jsx`.** Deleted wholesale when v2 ships real providers.
- **Origin-header CSRF defense, not the full session-token model.** Sufficient for this slice's POSTs; full model arrives with SSE in S2.

## 10. Decisions deferred to writing-plans

- Exact red-test-first sequencing of behaviors within the slice.
- Specific NuGet package versions and `npm` package versions (pinned in the plan).
- Whether `HeaderControls` ships as three discrete buttons or a single popover menu. Lean toward three discrete buttons for instant flip (consistent with the design handoff's right-cluster icon pattern); plan-writing makes the call.
- Whether the AI preview toggle requires confirmation (e.g., a tooltip the first time it's flipped on) or just flips silently. Defaulting to "flips silently" for ergonomics.
- Repo top-level `README.md` content and dev-environment-bootstrap script.

## 11. References

- [`docs/spec/00-verification-notes.md`](../../spec/00-verification-notes.md) — falsified assumptions.
- [`docs/spec/01-vision-and-acceptance.md`](../../spec/01-vision-and-acceptance.md) — vision + DoD; **Development process** section now codifies TDD.
- [`docs/spec/02-architecture.md`](../../spec/02-architecture.md) — stack, project layout, `IReviewService`, host config, lockfile, atomic-rename, configuration schema, state schema.
- [`docs/spec/03-poc-features.md`](../../spec/03-poc-features.md) — feature spec (most not in S0+S1 but informs interface shapes).
- [`docs/spec/04-ai-seam-architecture.md`](../../spec/04-ai-seam-architecture.md) — AI seam interfaces and DTOs.
- [`docs/roadmap.md`](../../roadmap.md) — slice decomposition (S0+S1 → S6).
- [`design/handoff/`](../../../design/handoff/) — visual / interaction reference.
- [`CLAUDE.md`](../../../CLAUDE.md) — agent guidance, including the TDD development-process rule.
