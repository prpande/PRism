---
title: CI hardening — desktop CI tier, SHA-pinned actions, toolchain dedup, checklist drift
issue: 335
epic: 317
tier: T2
risk: hands-off
date: 2026-06-12
status: approved
---

# CI hardening (#335)

Part of the 2026-06 code-quality epic (#317). Five findings from an audit of
`.github/workflows/` and the build docs. This spec grounds each against the
**current** `main` (`fdc14107`) — several line numbers in the issue snapshot had
already shifted, and one item (3) turned out to be doc-only.

## Problem

1. **Desktop shell is built/tested by no workflow.** `ci.yml`'s `build-and-test`
   and `e2e` jobs never touch `desktop/`; `publish-desktop.yml` is
   `workflow_dispatch`-only. A PR editing `desktop/src/*.ts` gets zero `tsc`, zero
   unit tests, and **no lint** (`desktop/package.json` has no `lint` script and the
   directory has no eslint/prettier config at all). #336 just shipped sidecar
   lifecycle fixes whose unit tests ran **local-only**.
2. **Mutable action tags on PR-facing workflows.** `ci.yml` (`checkout@v6`,
   `setup-dotnet@v5`, `setup-node@v6`, `upload-artifact@v7`),
   `integration-tests.yml` (`checkout@v6`, `setup-dotnet@v5`), and `claude.yml`
   (`checkout@v6`) ride mutable tags, while `publish.yml`/`publish-desktop.yml`
   SHA-pin with the rationale *"mutable tags can be force-pushed; pinned SHAs
   cannot."* `ci.yml` even hosts the "Reject unresolved commit-SHA placeholders"
   supply-chain lint while pinning nothing itself.
3. **Pre-push checklist doc drifts from CI.** `development-process.md:56` runs
   `dotnet test --no-build --configuration Release` *without* `--settings
   .runsettings`. (`ci.yml:62` already has the flag — so this is **doc-only**; the
   issue snapshot predates a CI fix.) `.runsettings` is what excludes
   `Category=Integration` + `Canonical=Strict`; the documented local command runs
   the live-GitHub integration project CI deliberately filters.
4. **Toolchain versions duplicated across 5 sites.** `setup-dotnet '10.0.x'` +
   `setup-node '24'` + npm-cache block repeat in `ci.yml`×2, `publish.yml`,
   `publish-desktop.yml`, and (dotnet-only) `integration-tests.yml`. A `net11` bump
   is a five-file edit.
5. **Adjacent hygiene (Low).**
   - `PRism.Core.Tests`, `PRism.GitHub.Tests`, `PRism.Web.Tests` re-declare
     `TargetFramework`/`ImplicitUsings`/`Nullable` already set in
     `Directory.Build.props`. `PRism.GitHub.Tests.Integration` correctly relies on
     the props but **lacks** the shared `<Using Include="Xunit" />` the other three
     carry.
   - `frontend/package.json` declares `@playwright/test: ^1.59.1` (caret) while
     `ci.yml`'s e2e container is `mcr.microsoft.com/playwright:v1.59.1-noble`
     (exact). A lockfile refresh can move the package while the image stays. The
     in-job guard only asserts *a* headless shell exists, not a matching revision.
     Desktop pins `^1.48.0` + TS `^5.6.0` vs frontend `^1.59.1`/`^6.0.3`.

## Non-goals

- Reworking the e2e tier or the Playwright-container strategy (only the
  version-coupling).
- SHA-pinning `anthropics/claude-code-action@v1` — **owner decision** to leave it a
  mutable tag (its maintainers ship fixes via the `@v1` tag; `claude.yml` already
  carries a "drop once upstream resolves" workaround). Documented carve-out, not an
  oversight.
- A `paths:`-gated desktop job. The desktop tier is ~1 min; running it always-on
  avoids adding a third-party `paths-filter` action (which would itself need
  pinning). "Optionally gated" in the issue → declined for simplicity.
- Bumping the desktop TypeScript major if it cascades into non-trivial type fixes —
  see Risks.

## Approach

### Decision: composite action over `global.json` (item 4)

AC#4 is "toolchain versions **defined once**." `global.json` pins only the .NET SDK
band — node `'24'` + the cache block would stay duplicated across 4 sites, only
partially meeting the AC. A composite action centralizes **both** toolchains *and*
their SHA pins. Chosen: **`.github/actions/setup-toolchain`** (owner-approved).

```yaml
# .github/actions/setup-toolchain/action.yml
name: Setup toolchain
description: Install the pinned .NET SDK + Node toolchain. Versions live ONLY here.
inputs:
  dotnet:
    description: Set up the .NET SDK (some jobs are Node-only, e.g. desktop).
    default: 'true'
  node:
    description: Set up Node (some jobs are .NET-only, e.g. integration-tests).
    default: 'true'
  cache-dependency-path:
    # Accepts a newline-separated block for jobs that cache multiple lockfiles
    # (publish-desktop.yml restores frontend + desktop).
    description: npm lockfile path(s) for the setup-node cache.
    default: 'frontend/package-lock.json'
runs:
  using: composite
  steps:
    - if: inputs.dotnet == 'true'
      uses: actions/setup-dotnet@<sha>   # actions/setup-dotnet v5.2.0
      with:
        dotnet-version: '10.0.x'
    - if: inputs.node == 'true'
      uses: actions/setup-node@<sha>     # actions/setup-node v6.4.0
      with:
        node-version: '24'
        cache: 'npm'
        cache-dependency-path: ${{ inputs.cache-dependency-path }}
```

`checkout` cannot live inside a local composite (it's what *fetches* the
composite), so its SHA pin stays per-job. `upload-artifact` stays pinned in
`ci.yml`. Every job becomes `checkout` → `setup-toolchain` (+ inputs):

| Job | `dotnet` | `node` | `cache-dependency-path` |
|-----|----------|--------|--------------------------|
| `ci.yml` build-and-test | t | t | frontend |
| `ci.yml` e2e | t | t | frontend |
| `ci.yml` **desktop** (new) | f | t | desktop |
| `integration-tests.yml` | t | f | (n/a) |
| `publish.yml` | t | t | frontend |
| `publish-desktop.yml` | t | t | frontend **+** desktop (multiline) |

**What centralizes, precisely** (corrected from an earlier overstatement):
the composite collapses the **version literals** (`'10.0.x'`, `'24'`) from 5 sites
to 1, and the **`setup-dotnet`/`setup-node` SHA pins** from 5 sites to 1. The
`checkout` pin (present in *every* job — the most-duplicated) and the
`upload-artifact` pin are NOT centralizable (checkout must precede the composite);
they stay per-file but Dependabot-maintained. So a `net11` bump becomes a 1-file
edit; a `checkout` bump stays multi-file (unavoidable).

**Input typing.** Composite inputs are always strings. Steps gate on
`if: inputs.dotnet == 'true'` (string compare); callers pass string `'true'`/`'false'`
(a YAML boolean `false` coerces to `'false'`, so either is safe). The one caller
whose `cache-dependency-path` differs is `publish-desktop.yml` — it passes a YAML
block scalar (`|`) with both lockfiles, rendered verbatim into setup-node's
multiline `cache-dependency-path`.

### SHA pins (item 2)

Reuse the versions `publish.yml` already pins, but **independently re-verify** each
SHA before committing (don't blind-copy) via
`gh api repos/actions/<name>/git/ref/tags/<tag> --jq .object.sha`:
`checkout` v6.0.2, `setup-dotnet` v5.2.0, `setup-node` v6.4.0, and resolve
`upload-artifact` v7's current SHA. Confirm each output matches the SHA written and
record the matches in `## Proof`. Each pin carries a `# actions/<name> vX.Y.Z`
comment per the repo idiom. Dependabot (`github-actions`, monthly) maintains these.

### Desktop CI tier + lint (item 1)

- **New `desktop` job in `ci.yml`** (windows-latest for parity with
  `build-and-test`; the unit tier is pure `node:test` + `tsc`, platform-agnostic,
  but staying on Windows matches the dev box). Steps: `checkout` →
  `setup-toolchain` (node-only, desktop lockfile) → `npm ci` → `npm run lint` →
  `npm run build` → `npm run test:unit`. Set `ELECTRON_SKIP_BINARY_DOWNLOAD=1`
  and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` — the tier needs only `tsc` + node, not
  the Electron/Playwright binaries (a known cold-install hazard, #336).
- **Lint stack: ESLint (flat config, typescript-eslint) + Prettier**, mirroring
  frontend's `eslint . && prettier --check .`. `no-floating-promises` /
  `no-misused-promises` earn their place on the async sidecar code (the #336 bug
  class). Add `eslint`, `@eslint/js`, `typescript-eslint`, `prettier` to
  `desktop/devDependencies`; add `eslint.config.js` + `.prettierignore`
  (exclude `dist/`, `dist-test/`, `node_modules/`, `sidecar/`).
  - **Type-aware wiring:** those two rules need typescript-eslint's typed linting.
    Desktop has *two disjoint* tsconfigs (`tsconfig.json` = `src/**`;
    `tsconfig.test.json` = `test/**`) and `eslint .` also covers root files
    (`global-setup.ts`, `playwright.config.ts`). Use
    `languageOptions.parserOptions.projectService: true` (typescript-eslint v8) so
    the parser auto-discovers the nearest tsconfig for every linted file rather
    than a hand-maintained `project` array.
  - **Bounded triage:** `no-floating-promises` on previously-unlinted async code can
    surface an unknown number of findings. Run eslint *first*; if the count is
    large, scope the initial config to the high-value type-aware rules
    (`no-floating-promises`, `no-misused-promises`) + js/ts `recommended`, and
    suppress-with-rationale (per #331) rather than fix-everything in this PR. Report
    the actual count in `## Proof`. `lint` script: `eslint . && prettier --check .`.
- **Pre-push checklist** (`development-process.md`): add a desktop tier step
  (`cd desktop && npm ci && npm run lint && npm run build && npm run test:unit`),
  framed as *run it when your change touches `desktop/`* (the local checklist is
  sequential, so gating saves dev time; CI runs the desktop job always-on).
- **Env scoping:** `ELECTRON_SKIP_BINARY_DOWNLOAD` / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`
  are set on the **desktop job only**, never workflow-level, so they can't suppress
  a binary a future job legitimately needs.

### Checklist `.runsettings` drift (item 3)

One-line doc fix: `development-process.md:56` →
`dotnet test --no-build --configuration Release --settings .runsettings`. README has
no duplicate of this command (verified), so the doc is the only site.

### Hygiene (item 5)

- Strip `TargetFramework`/`ImplicitUsings`/`Nullable` from `PRism.Core.Tests`,
  `PRism.GitHub.Tests`, `PRism.Web.Tests` csprojs (inherited from
  `Directory.Build.props`). Add `<ItemGroup><Using Include="Xunit" /></ItemGroup>`
  to `PRism.GitHub.Tests.Integration`. Verified by `dotnet build` staying green.
- **Frontend `@playwright/test`: caret → exact `1.59.1`** to match the pinned
  container image. Lockfile already resolves 1.59.1, so churn is minimal; verify
  with a clean `npm ci`. (Strengthening the in-job guard is the alternative the
  issue offers; exact-pin is the simpler, divergence-proof choice.)
- **Desktop devDep alignment** (best-effort, now CI-validated): bump the
  `package.json` carets `@playwright/test` `^1.48.0` → `^1.59.1` and `typescript`
  `^5.6.0` → `^6.0.3` to match frontend. **Reality check** (the lockfile already
  resolves ahead of the carets): desktop currently locks `@playwright/test` 1.60.0
  and `typescript` 5.9.3, so the playwright caret bump is a near-noop and the actual
  TS jump the new `tsc` job validates is **5.9.3 → 6.0**, not 5.6 → 6.0 — a smaller
  major step than the carets imply. If TS 6 cascades into non-trivial fixes, defer
  that bump to a tracked follow-up issue (not just the PR body) rather than balloon
  this PR; the AC-critical coupling fix is the frontend exact-pin.

## Verification / proof

This is **infra + config + docs** work — there is nothing unit-testable in YAML,
csproj, or markdown. Per the issue-resolution Proof template, non-bug work proves
out via the **acceptance checklist + green CI**, not new unit tests:

- **CI-exercised (3 of 6 jobs):** the composite + SHA pins + desktop job are
  validated by `ci.yml` running green on the PR — `build-and-test`, `e2e`, and the
  new `desktop` job all call the composite. The existing "Reject unresolved
  commit-SHA placeholders" lint guards the pins.
- **NOT CI-exercised (3 of 6 jobs):** `integration-tests.yml`, `publish.yml`,
  `publish-desktop.yml` are `workflow_dispatch`-only, so this PR's CI never runs
  them — a wrong composite input there (especially `publish-desktop.yml`'s multiline
  `cache-dependency-path`) would surface only at release time. This property is
  **inherent** to editing dispatch-only workflows (not introduced by the composite),
  but the composite adds a string-marshaling seam. Mitigation, in order of strength:
  1. **`actionlint` run locally before merge**, over *all* workflows + the composite
     `action.yml`. actionlint statically validates composite `uses:` references and
     surfaces undefined/missing inputs and wrong input names across the dispatch-only
     callers without executing them. Record the clean run in `## Proof`. (actionlint
     is not installed in the repo; fetch a checksum-verified release binary for the
     run — not `curl | bash`.)
  2. **Byte-level diff** of each migrated job: same SHA pins, same version literals,
     same cache paths (multiline preserved for `publish-desktop.yml`).
  3. A permanent **`actionlint` CI step** is a natural follow-up (on-theme for CI
     hardening) but is *not* one of #335's five items — filed as a follow-up rather
     than scope-crept here.
- Desktop lint/build/test: `npm run lint && npm run build && npm run test:unit`
  green locally and in the new CI job.
- csproj hygiene: `dotnet build --configuration Release` green.
- Frontend exact-pin: clean `npm ci` + existing frontend CI steps green.

## Acceptance criteria

- [ ] CI compiles, lints, and unit-tests `desktop/` on every PR; pre-push checklist
      gains the desktop tier.
- [ ] First-party `actions/*` SHA-pinned across `ci.yml` / `integration-tests.yml` /
      `claude.yml`; `claude-code-action@v1` left as a documented carve-out;
      `unclaim-on-close.yml` has no `uses:` (nothing to pin).
- [ ] Pre-push checklist step 4 includes `--settings .runsettings`.
- [ ] `.NET` + Node **version literals + their setup pins** defined once in
      `.github/actions/setup-toolchain`, consumed by all **6** jobs (`checkout` +
      `upload-artifact` pins stay per-file — not centralizable).
- [ ] `@playwright/test` ↔ container-image versions cannot silently diverge
      (frontend exact-pinned to the image tag).
- [ ] Test csprojs no longer re-declare `Directory.Build.props` props; Integration
      csproj carries the shared `<Using Include="Xunit" />`.

## Risks & rejected alternatives

- **Composite touches the release pipeline** (`publish*.yml`) which this PR's CI
  doesn't run — the load-bearing risk (4 reviewers converged). Accepted because the
  alternative (leave publish workflows un-deduped) fails AC#4; mitigated by the
  actionlint-local + byte-diff plan above, not bare "careful diffing."
- **TS desktop bump** (lock 5.9.3 → 6.0) could surface strict-type errors. The new
  desktop `tsc` job validates it in the *same* PR; if it cascades, defer to a
  follow-up issue (see item 5).
- **Always-on desktop job** vs paths-gated: rejected paths-filter (a third-party
  action + pin) for a ~1-min job. Net simpler.
- **`global.json` for item 4**: rejected — dedups only .NET, leaving node duplicated
  (partial AC#4). The issue's explicit "at minimum" fallback.
- **Kept the `dotnet`/`node` composite toggles** (vs a node-only direct setup in the
  desktop job): the toggles express per-job need cleanly (integration=.NET-only,
  desktop=Node-only) and removing them would re-duplicate the Node version, defeating
  AC#4.

## Out of scope / follow-ups surfaced in review

- **`claude.yml` `curl … | bash` pre-install** of the Claude CLI is an unverified
  remote-script exec in the same job that holds `CLAUDE_CODE_OAUTH_TOKEN`
  (security-lens P1). It is a **pre-existing** workaround (anthropics/claude-code-action#1254),
  not introduced here — out of scope for #335; worth a follow-up issue to
  checksum-verify or drop once upstream resolves.
- **Permanent `actionlint` CI step** (see Verification) — follow-up.
- **SHA-pinning `claude-code-action@v1`** — explicit owner decision to leave it;
  revisit if Anthropic offers a stronger stability guarantee than the mutable tag.
