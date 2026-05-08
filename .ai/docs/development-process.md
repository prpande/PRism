# Development process

## Test-driven development

**All production code is written test-first, red → green → refactor. No exceptions.**

- **Red:** write a failing test that proves the new behavior is needed. Run it; confirm it fails for the expected reason (not a compile error or a typo).
- **Green:** write the simplest implementation that makes the test pass. Don't generalize, don't anticipate, don't add scope.
- **Refactor:** clean up while tests stay green. If refactoring breaks tests, the refactor is the cause — fix it without changing test expectations.

This applies to every slice in `docs/roadmap.md` and to every commit. The spec's DoD lists *which* tests must exist (submit pipeline, reconciliation, migration); TDD is *how* every test in the codebase comes into existence — including the ones the DoD doesn't enumerate. Tests are the spec at the implementation level: if a behavior isn't tested, it isn't required, and adding production code that doesn't make a failing test pass is a process violation.

**Practical implications:**

- **Every PR's first commit on a new behavior is the failing test.** Implementation lands in a follow-up commit (or a squashed commit that clearly pairs them). A diff that shows production code without a corresponding new test is a smell — the reviewer asks why.
- **Bug fixes start with a regression test that fails on `main`.** Then the fix lands.
- **Refactors that don't change behavior do not require new tests** — the existing suite is the safety net. If the existing suite doesn't cover the area being refactored, write the tests *first* (red against current behavior, green confirming current behavior), then refactor.
- **No "I'll add tests later" backlog items.** If a test wasn't written first, the behavior wasn't actually built — the work is incomplete.
- **No mocking the system under test.** Mock external boundaries (GitHub HTTP, OS keychain, file system where it makes the test painfully slow); test real classes against real collaborators inside the project.

## Commands

Canonical build / test / dev / publish commands live in [`README.md`](../../README.md) § Development workflow. Don't duplicate them in agent rules.

The publish targets are an architectural commitment, not just a command:

- `dotnet publish -r win-x64   --self-contained -p:PublishSingleFile=true`
- `dotnet publish -r osx-arm64 --self-contained -p:PublishSingleFile=true`

`osx-x64` (Intel Mac) is **explicitly out of scope** for the PoC — do not add it as a publish target without a documented test path.

## Pre-push checklist

Run steps 1–4 locally before every `git push`. They mirror `.github/workflows/ci.yml` so anything CI catches, you catch first. Step 5 (Playwright) is conditional — see comments in [`README.md`](../../README.md) § Pre-push checklist.

```text
# 1. Frontend lint (eslint + prettier --check)
cd frontend && npm run lint

# 2. Frontend build (tsc -b is stricter than --noEmit)
npm run build

# 3. Frontend unit tests (vitest)
npm test

# 4. Backend build + tests
cd .. && dotnet build --configuration Release
dotnet test --no-build --configuration Release

# 5. Frontend e2e (Playwright) — required when README criteria apply
cd frontend && npx playwright test
```
