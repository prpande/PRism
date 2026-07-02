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

### Desktop shell (`desktop/`, v0.2.0)

The Electron shell wraps those *same* self-contained binaries as a managed sidecar — it does not introduce a second runtime. Its commands live in `desktop/package.json`; the architectural commitments:

- **Sidecar, not a fork.** The shell publishes the unchanged `PRism.Web` binary into `desktop/sidecar/` (per-RID rename to `PRism-win-x64.exe` / `PRism-osx-arm64`) and spawns it. No app-domain code lives under `desktop/`. The four backend seams that make this possible (`SidecarMode`, `ParentLivenessProbe`/`Watchdog`, `HostHeaderCheckMiddleware`, the `127.0.0.1` bind) are sidecar-gated and inert in browser-tab mode.
- **Two test tiers.** Pure helpers run as `node:test` units (`cd desktop && npm run test:unit`); the full-stack smoke is a Playwright `_electron` suite (`npm run test:e2e`) that launches the real shell against a **published** sidecar. The e2e is **local/manual**, not wired into CI — it needs a published binary at `PRISM_SIDECAR_BINARY` and `npx playwright install chromium`. See `TESTING.md` and `docs/plans/2026-06-02-electron-desktop-shell.md` § Task D1.
- **Packaging is `v0.2.*`-gated.** `publish-desktop.yml` (electron-builder, unsigned) owns `v0.2.*` tags; `publish.yml` still owns `v0.1.*`, so the browser-tab artifact stays available. macOS is opt-in (`include_macos`) and must pass the real-hardware smoke before a cohort hand-out.

## Pre-push checklist

Run steps 1–4 locally before every `git push`. They mirror `.github/workflows/ci.yml` so anything CI catches, you catch first. Step 5 (desktop) is conditional on a `desktop/` change; step 6 (Playwright) is conditional — see comments in [`README.md`](../../README.md) § Pre-push checklist. Step 7 (PowerShell launcher harnesses) is conditional on a `run.ps1` / `scripts/*.ps1` change and is **not** mirrored in CI, so run it locally.

```text
# 1. Frontend lint (eslint + prettier --check)
cd frontend && npm run lint

# 2. Frontend build (tsc -b is stricter than --noEmit)
npm run build

# 3. Frontend unit tests (vitest)
npm test

# 4. Backend build + tests
#    --settings .runsettings MUST match ci.yml — it excludes Category=Integration
#    and Canonical=Strict. Omitting it runs the live-GitHub integration project
#    (needs PRISM_INTEGRATION_PAT) and strict-canonical tests CI deliberately filters.
cd .. && dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings

# 5. Desktop shell (desktop/) — run when your change touches desktop/. CI runs the
#    desktop job always-on; locally it's gated to save time (the checklist is serial).
cd desktop && npm ci && npm run lint && npm run build && npm run test:unit && cd ..

# 6. Frontend e2e (Playwright) — required when README criteria apply
cd frontend && npx playwright test

# 7. PowerShell launcher harnesses — run when your change touches run.ps1 or
#    scripts/*.ps1. Plain assertion harnesses (no Pester); they run on both pwsh 7 and
#    Windows PowerShell 5.1 and are NOT wired into CI, so run them locally.
#    run.Tests.ps1 covers run.ps1 parameter binding (#274); run-desktop.Tests.ps1
#    covers the desktop launcher's pure helpers.
pwsh -File scripts/run.Tests.ps1
pwsh -File scripts/run-desktop.Tests.ps1
```

## Tooling caveats (false-green traps)

These recur on this repo's Windows-dev / Linux-CI split and have masked real failures. Verify against the actual binary, not a wrapper's summary.

- **Command proxies can mask lint/format exit codes.** If your shell routes commands through a token-saving proxy (e.g. `rtk`), it can report `prettier --check` / `npm run lint` as "formatted correctly" while CI's raw `prettier` fails. Before pushing a frontend change, confirm formatting truthfully by invoking the binary directly from the frontend — `cd frontend && node ./node_modules/prettier/bin/prettier.cjs --check .` (the `.` then scopes to the frontend, matching `npm run lint`'s `prettier --check .`; use `--write <files>` to fix). Don't trust a green `npm run lint` seen through a proxy.
- **Run vitest via the project binary, not `npx vitest`.** `npx` can resolve a cached vitest that ignores the project's `jsdom` environment, failing every render test with `document is not defined` — a false mass-failure, not a regression. Use `npm test` (script: `vitest run`).
- **Windows `npm install` can desync the lockfile for Linux CI.** On Windows, `npm install <pkg>` may drop optional+peer entries (e.g. `@emnapi/core`, `@emnapi/runtime`) that the Linux CI `npm ci` still requires, causing `EUSAGE: Missing … from lock file`. After any `npm install` on Windows, diff `package-lock.json` for removed optional/peer blocks and restore them, then verify with a clean `npm ci`.
- **`tsc --noEmit` is vacuous here; `tsc -b` is the real typecheck.** The frontend uses a project-references root `tsconfig` (`files: []`), so `--noEmit` checks nothing. `npm run build` (which runs `tsc -b`) is what catches type errors — vitest's esbuild transform does not typecheck.

## Cross-tier change checks

- **Wire-shape changes are cross-tier.** Before opening a PR that changes any `/api/*` request/response or SSE payload (dropping, renaming, or restructuring a field), grep the frontend for every consumer of the old shape and confirm each is updated in the same PR or shielded by a documented compat shim. Backend-only preflight and review read only the backend diff and miss React render-tree breakage; a cold-start Playwright smoke is the fastest cross-tier signal.

## Running parallel agents (testing without collisions)

Multiple agents/worktrees can build, launch, and test on one machine at the same
time without colliding on the HTTP port or the data store. Each session takes a
private `(port, dataDir)`: agents launch detached with
`scripts\serve-detached.ps1 -Port 5200 -DataDir $env:TEMP\PRism-wt-0` (a human
watching the console uses `./run.ps1` in the foreground), and run the frontend
e2e with `$env:PRISM_E2E_PORT=5200`. Defaults (5180 / `%LocalApplicationData%\PRism`) are
unchanged for single-agent flows. Full instructions — port band, desktop caveats,
`-Reset` safety, credential notes — are in
[`parallel-agent-testing.md`](parallel-agent-testing.md).
