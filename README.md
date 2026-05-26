# PRism

Local-first PR review tool that runs on the reviewer's own machine. See [`docs/spec/`](docs/spec/) for the full specification and [`docs/roadmap.md`](docs/roadmap.md) for the implementation slice plan.

## Status

**Released.** PoC binary v0.1.0 is downloadable from the [Releases page](https://github.com/prpande/PRism/releases/latest):

- Windows x64: [`PRism-win-x64.exe`](https://github.com/prpande/PRism/releases/latest/download/PRism-win-x64.exe)
- macOS Apple Silicon: [`PRism-osx-arm64`](https://github.com/prpande/PRism/releases/latest/download/PRism-osx-arm64)

See [`docs/roadmap.md`](docs/roadmap.md) for slice history and [`docs/specs/README.md`](docs/specs/README.md) for the spec status index.

## Download and first run

Download the binary for your platform from the [Releases page](https://github.com/prpande/PRism/releases/latest):

- **Windows x64** — [`PRism-win-x64.exe`](https://github.com/prpande/PRism/releases/latest/download/PRism-win-x64.exe)
- **macOS Apple Silicon** — [`PRism-osx-arm64`](https://github.com/prpande/PRism/releases/latest/download/PRism-osx-arm64)

PRism is unsigned for the PoC, so the OS surfaces a one-time trust prompt on first launch.

### Windows

Double-click the `.exe`. Windows SmartScreen shows **"Windows protected your PC"** because the binary isn't code-signed. Click **More info → Run anyway**. The backend starts on `http://localhost:5180` and your default browser launches into the PRism Setup screen.

### macOS

The downloaded binary needs the executable bit before macOS will launch it:

```sh
chmod +x ~/Downloads/PRism-osx-arm64
```

Double-click the binary. Gatekeeper shows **"PRism cannot be opened because Apple cannot check it for malicious software"**. Right-click (or Control-click) → **Open**, then **Open** again in the confirmation dialog. The first time PRism reads your token from the keychain, macOS asks **Allow / Always Allow / Deny** — click **Always Allow** so PRism stops prompting on every launch.

### Generate a GitHub Personal Access Token

PRism authenticates with a fine-grained Personal Access Token you generate at <https://github.com/settings/personal-access-tokens/new>. Required scopes:

- **Pull requests** — Read and write
- **Contents** — Read
- **Checks** — Read
- **Commit statuses** — Read

Paste the PAT into the Setup screen on first launch.

## Troubleshooting

### Recovering a lost draft

PRism's dedicated forensic event log (`state-events.jsonl`) is not yet implemented — the DI graph registers a no-op writer for the PoC. Identity-change events DO land in the structured logs at `<dataDir>/logs/` (with prior + new login + draft counts):

```sh
grep "Identity changed" "<dataDir>/logs/"*.log
```

`DraftSaved` events are not currently written to any forensic log. If you need to recover a draft body in the PoC, copy it out of the composer **before** any destructive action (Replace token, Discard, foreign-pending-review Discard).

### Replace token

The Settings page has a **Replace token** link in the Connection section. Clicking it walks you through pasting a new PAT and validates it before swapping. If the new token authenticates as a different GitHub login than the previous one, PRism:

- Preserves all draft text across every PR ("the reviewer's text is sacred").
- Clears the GraphQL Node IDs that the prior login owned.
- Surfaces the foreign-pending-review modal on the next submit on any affected PR, so the prior login's orphan pending reviews can be Resumed or Discarded.

Drafts for PRs your new token cannot access remain in `state.json` invisibly. They re-surface if access is later restored.

## Development workflow

Two terminals.

```
# terminal 1 — backend with hot reload (pinned to 5180 in dev)
dotnet watch run --project PRism.Web --urls http://localhost:5180

# terminal 2 — frontend dev server (Vite proxies /api to localhost:5180)
cd frontend
npm install
npm run dev
```

Run all tests:

```
dotnet test
cd frontend && npm test && npx playwright test
```

Run a single backend test:

```
dotnet test --filter "FullyQualifiedName~AppStateStoreTests"
```

Run a single frontend test:

```
cd frontend && npx vitest run __tests__/setup.test.tsx
```

Generate frontend coverage:

```
cd frontend
npm test -- --coverage
```

Generate backend coverage and an HTML report:

```
dotnet tool install -g dotnet-reportgenerator-globaltool
dotnet test --collect:"XPlat Code Coverage"
reportgenerator -reports:"**/coverage.cobertura.xml" -targetdir:"coveragereport"
```

### Integration tests (live GitHub)

A separate suite at `tests/PRism.GitHub.Tests.Integration/` exercises `GitHubReviewService` against five locked PRs in this repo. Opt-in. The repo-root [`.runsettings`](.runsettings) excludes the integration + canonical-strict tests, but **`.runsettings` is only consulted when `dotnet test` is invoked with `--settings .runsettings`** — plain `dotnet test` (no flag) runs every test including the integration suite, which then needs a PAT to succeed. The pre-push checklist below and `.github/workflows/ci.yml` both pass `--settings .runsettings`.

Explicit run command for the integration suite only:

```
dotnet test --filter "Category=Integration&Canonical!=Strict"
```

Requires `PRISM_INTEGRATION_PAT` env var or `gh auth login`. Full operator runbook: [`docs/contract-tests.md`](docs/contract-tests.md). Design: [`docs/specs/2026-05-18-frozen-pr-contract-tests-design.md`](docs/specs/2026-05-18-frozen-pr-contract-tests-design.md).

### Pre-push checklist

Run steps 1–4 locally before every `git push`. They mirror `.github/workflows/ci.yml` step-for-step so anything CI catches, you catch first. CI is fail-fast — a regression in a later step stays invisible until something earlier passes, so "the last CI was green" is not a substitute for running these steps. Step 5 (Playwright) is conditional — see the comment on that step for when it's required.

```
# 1. Frontend lint (eslint + prettier --check)
cd frontend && npm run lint

# 2. Frontend build (tsc -b is stricter than --noEmit; required, not --noEmit)
npm run build

# 3. Frontend unit tests (vitest)
npm test

# 4. Backend build + tests
cd .. && dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings

# 5. Frontend e2e (Playwright) — required if you touched any of:
#    - frontend/src/pages/, frontend/src/App.tsx, route bindings
#    - any UI surface referenced by frontend/e2e/*.spec.ts
#    - PRism.Web/Endpoints/, middleware, or response shapes the SPA reads
#    Otherwise the prior CI signal is sufficient.
cd frontend && npx playwright test
```

If `tsc -b` reports a generic-narrowing or project-reference error that `tsc --noEmit` would miss, fix it locally — CI runs `tsc -b` (via `npm run build`) and will fail on the same error.

### Stable session token across `dotnet watch run` reloads (Development only)

The backend rotates the per-launch session token on every startup (see [`docs/spec/02-architecture.md`](docs/spec/02-architecture.md) § "Cross-origin defense for the localhost API" — the token travels as the `prism-session` cookie and is echoed in the `X-PRism-Session` header). Under `dotnet watch run` this means every save-triggered restart issues a new token and forces a full SPA reload to pick it up. To keep one token alive across reloads while developing, export `PRISM_DEV_FIXED_TOKEN` as a real environment variable in the shell that runs `dotnet watch run`:

```
# PowerShell (set for the current shell session)
$env:PRISM_DEV_FIXED_TOKEN = "any-base64-string-you-like"

# bash / zsh
export PRISM_DEV_FIXED_TOKEN="any-base64-string-you-like"
```

`SessionTokenProvider` reads the override via `Environment.GetEnvironmentVariable` **only** — deliberately not via `IConfiguration` / `dotnet user-secrets`, to eliminate any path where `appsettings.json` (or a stray user-secrets entry) could leak a fixed token into a non-Development host. The override is honored **only when `ASPNETCORE_ENVIRONMENT == "Development"`** — production hosts ignore the env var entirely (`tests/PRism.Web.Tests/Middleware/SessionTokenProviderTests.cs` enforces this). Without the override, every `dotnet watch run` restart rotates the token and the SPA reloads to refresh the cookie. With it, the SPA stays alive across save-triggered restarts.

## Process

All production code is written test-first (red → green → refactor). See [`.ai/docs/development-process.md`](.ai/docs/development-process.md).
