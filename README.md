# PRism

Local-first PR review tool that runs on the reviewer's own machine. See [`docs/spec/`](docs/spec/) for the full specification and [`docs/roadmap.md`](docs/roadmap.md) for the implementation slice plan.

## Status

Implementation in progress. S0+S1 (foundations) and S2 (inbox read) have shipped; S3 (PR detail read) has its five backend PRs (PR1 state migration, PR2 iteration clustering, PR3 `IReviewService` extensions, PR4 `PrDetailLoader` + backend endpoints, PR5 SSE per-PR fanout + active-PR poller + `SessionTokenMiddleware`) and four frontend PRs (PR6 PR-detail shell, PR7 Files tab, PR8 Diff Pane + Markdown pipeline, PR9 Overview tab + AI summary endpoint) all merged. Task 10 (documentation updates) and Task 11 (contract tests against the frozen `api-codex` PR) remain. See [`docs/roadmap.md`](docs/roadmap.md) for the live slice table and [`docs/specs/README.md`](docs/specs/README.md) for the spec status index.

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

## Process

All production code is written test-first (red → green → refactor). See [`.ai/docs/development-process.md`](.ai/docs/development-process.md).
