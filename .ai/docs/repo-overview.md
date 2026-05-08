# Repository overview

PRism is **mid-implementation**. Main contents:

- `PRism.sln` and six backend projects: `PRism.Core`, `PRism.Core.Contracts`, `PRism.GitHub`, `PRism.Web`, `PRism.AI.Contracts`, `PRism.AI.Placeholder`
- `tests/` — `PRism.Core.Tests`, `PRism.GitHub.Tests`, `PRism.Web.Tests`
- `frontend/` — React + Vite + TS app (per S0+S1)
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
- `.github/workflows/` — `ci.yml`, `claude.yml` (`@claude` mention handler), `claude-code-review.yml` (auto-review on every PR)

`docs/spec/` is the source of truth for the *full* PoC contract — including parts not yet shipped. `docs/roadmap.md` (slice-keyed) and `docs/specs/README.md` (spec-keyed) track shipped state. `docs/README.md` is the document map; start there.

`docs/spec/00-verification-notes.md` falsifies several easy assumptions about GitHub's API surface — it is load-bearing for the rest of the spec.
