# PRism

Local-first PR review tool that runs on the reviewer's own machine. See [`docs/spec/`](docs/spec/) for the full specification and [`docs/roadmap.md`](docs/roadmap.md) for the implementation slice plan.

## Status

Implementation in progress. S0+S1 (foundations) and S2 (inbox read) have shipped; S3 (PR detail read) is mid-flight with PR1 (state migration), PR2 (iteration clustering), and PR3 (`IReviewService` extensions) merged, and PR4 (`PrDetailLoader` + backend endpoints) in review. See [`docs/roadmap.md`](docs/roadmap.md) for the live slice table and [`docs/specs/README.md`](docs/specs/README.md) for the spec status index.

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

## Process

All production code is written test-first (red → green → refactor). See [`CLAUDE.md`](CLAUDE.md) § Development process.
