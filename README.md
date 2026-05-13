# PRism

Local-first PR review tool that runs on the reviewer's own machine. See [`docs/spec/`](docs/spec/) for the full specification and [`docs/roadmap.md`](docs/roadmap.md) for the implementation slice plan.

## Status

Implementation in progress. S0+S1 (foundations), S2 (inbox read), S4 (drafts + composer), and S5 (submit pipeline) have shipped; S3 (PR detail read) has its five backend PRs (PR1 state migration, PR2 iteration clustering, PR3 `IReviewService` extensions, PR4 `PrDetailLoader` + backend endpoints, PR5 SSE per-PR fanout + active-PR poller + `SessionTokenMiddleware`) and four frontend PRs (PR6 PR-detail shell, PR7 Files tab, PR8 Diff Pane + Markdown pipeline, PR9 Overview tab + AI summary endpoint) all merged (Task 11 contract tests against the frozen `api-codex` PR remain). S5 landed across an eight-PR cut: PR0a (capability split + verification gates, PR #44), PR1 (`IReviewSubmitter` GraphQL adapter, PR #45), PR2 (`SubmitPipeline` state machine + v3→v4 migration, PR #46), PR3 (backend submit endpoints + SSE events + per-PR submit lock + composer marker-collision rejection + verdict-clear patch shape + scrubber extension, PR #47), PR4 (frontend Submit confirmation dialog + `useSubmit` hook + Submit Review button enable rules + enabled verdict picker + AI validator card + Ask AI empty state + in-flight-submit recovery badge, PR #48), PR5 (foreign-pending-review modal + Resume/Discard sub-modal + Snapshot A→B / IsResolved imported-drafts banner + stale-`commitOID` retry banner with not-yet-Reloaded variant + closed/merged bulk-discard button + confirmation modal + `useSubmitToasts` for the `submit-duplicate-marker-detected` / `submit-orphan-cleanup-failed` toasts + TOCTOU-409 toast, PR #49), and PR7 (DoD E2E test sweep — this PR: working `FakeReviewSubmitter` + `/test/submit/*` test hooks + eight Playwright specs covering the demo happy path, retry-from-each-step, foreign-pending-review Resume/Discard/Cancel, stale-`commitOID` recreate, lost-response marker adoption, closed/merged bulk-discard + orphan-cleanup toast, multi-tab per-PR-lock, and composer marker-prefix collision) all landed. PR0b (Playwright multi-spec state-leak fix + un-fixme of three S4 specs) remains as a carried-forward test-hygiene follow-up — off the demo critical path by construction (PR7 runs its e2e specs with `--workers=1` as the interim workaround). See [`docs/roadmap.md`](docs/roadmap.md) for the live slice table and [`docs/specs/README.md`](docs/specs/README.md) for the spec status index.

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
dotnet test --no-build --configuration Release

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
