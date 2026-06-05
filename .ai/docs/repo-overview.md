# Repository overview

PRism is **mid-implementation**. Main contents:

- `PRism.sln` and six backend projects: `PRism.Core`, `PRism.Core.Contracts`, `PRism.GitHub`, `PRism.Web`, `PRism.AI.Contracts`, `PRism.AI.Placeholder`
- `tests/` — `PRism.Core.Tests`, `PRism.GitHub.Tests`, `PRism.Web.Tests`
- `frontend/` — React + Vite + TS app (per S0+S1)
- `desktop/` — Electron desktop shell (v0.2.0): TypeScript main process that spawns the self-contained `PRism.Web` binary as a managed sidecar (stdout-port handshake → `/api/health` gate) and points a sandboxed `BrowserWindow` at `http://127.0.0.1:<port>`. Additive — no app-domain code lives here; the shell wraps the *unchanged* web app. Design: `docs/specs/2026-06-02-electron-desktop-shell-design.md`
- `validation-harness/` — manual / scripted validation harness
- Build infra: `Directory.Build.props`, `Directory.Packages.props`, `BannedSymbols.txt`, `NuGet.config`, `.editorconfig`, `.gitattributes`
- `run.ps1` — orchestrates dev workflow (PowerShell host)
- `.ai/docs/` — tool-agnostic AI agent rules (this tree)
- `.cursor/rules/` — Cursor project rules (`mdc:` links into `.ai/docs/`)
- `docs/spec/` — the authoritative PoC specification (read in numerical order)
- `docs/backlog/` — prioritized v2 backlog (P0 / P1 / P2 / P4; P3 was dropped)
- `docs/roadmap.md` — implementation slice plan (S0+S1 → S6) with live slice statuses
- `docs/specs/` — per-slice / per-task design docs; see `docs/specs/README.md` for the status-grouped index
- `docs/plans/` — step-by-step implementation plans
- `docs/solutions/` — documented solutions with YAML frontmatter (`module`, `tags`, `problem_type`)
- `design/handoff/` — visual/interaction design prototype (reference, **not** production code)
- `assets/icons/` — app icons (`PRism{16,32,48,64,256,512}.ico` + `PRismOG.png`)
- `TESTING.md` — tester-facing walkthrough for the **unsigned desktop preview builds** (Windows SmartScreen / macOS Gatekeeper bypass, data-folder locations)
- `.github/workflows/` — `ci.yml`, `claude.yml` (`@claude` mention handler), `claude-code-review.yml` (auto-review on every PR), `publish.yml` (manual workflow_dispatch — produces self-contained `win-x64` + `osx-arm64` binaries and attaches to a draft GitHub Release; `include_macos` input gates whether the macOS binary reaches `releases/latest`, default false at v0.1.0 per `docs/specs/2026-05-28-v1-completion-roadmap-design.md`), `publish-desktop.yml` (manual workflow_dispatch on a `v0.2.*` tag — builds the Electron shell + bundled sidecar into unsigned `win-x64` portable/NSIS + opt-in `osx-arm64` `.dmg` via electron-builder, attaches to a draft Release; coexists with `publish.yml` which still owns `v0.1.*`), `integration-tests.yml` (live-GitHub contract test suite per `docs/contract-tests.md`), `unclaim-on-close.yml` (label hygiene — removes the `in-progress` claim label when an issue closes; not a gate, per `.ai/docs/issue-resolution-workflow.md` step 11)

`docs/spec/` is the source of truth for the *full* PoC contract — including parts not yet shipped. `docs/roadmap.md` (slice-keyed) and `docs/specs/README.md` (spec-keyed) track shipped state. `docs/README.md` is the document map; start there.

`docs/spec/00-verification-notes.md` falsifies several easy assumptions about GitHub's API surface — it is load-bearing for the rest of the spec.
