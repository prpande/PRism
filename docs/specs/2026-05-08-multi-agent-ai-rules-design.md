# Multi-agent AI rules — design

**Date:** 2026-05-08  
**Scope:** Introduce a tool-agnostic shared rule layer (`.ai/docs/`), slim [`CLAUDE.md`](../../CLAUDE.md) to a Claude Code entry point + links, add Cursor project rules (`.cursor/rules/*.mdc`), and update the documentation-maintenance matrix so shared content evolves with the repo.  
**Out of scope:** Changing production code, tests, CI, or `docs/spec/` PoC contract text. No roadmap slice — this is independent infrastructure (like other ad-hoc specs that do not map to a slice).

## Problem

1. **Single monolithic agent file.** All repo-level AI guidance lives in root `CLAUDE.md` (~220 lines). Cursor and future tools need their own configuration surfaces; copying prose into each tool guarantees drift.

2. **No contextual loading for Claude Code.** The entire file is always in scope for Claude Code sessions regardless of whether work is frontend, backend, or docs-only.

3. **Maintenance table points at `CLAUDE.md` sections.** After splitting content, the trigger→target table must point at `.ai/docs/*.md` files so every contributor (and every agent) updates the same artifacts.

## Approach

Follow the pattern used in Mindbody BizApp BFF (reference only): **`.ai/docs/` holds plain Markdown — the single source of truth.** Per-tool configs are thin wrappers: Cursor `.mdc` files use YAML frontmatter (`globs`, `alwaysApply`) and `mdc:` links to shared files; [`CLAUDE.md`](../../CLAUDE.md) becomes a short routing document plus Claude-specific workflow (e.g. `ce-doc-review`, superpowers path overrides).

**Content split (8 shared files):**

| File | Source |
|------|--------|
| `repo-overview.md` | `CLAUDE.md` § Repo state |
| `development-process.md` | `CLAUDE.md` § Development process + § Commands + [`README.md`](../../README.md) § Pre-push checklist |
| `architectural-invariants.md` | `CLAUDE.md` § Architectural invariants (verbatim) |
| `design-handoff.md` | `CLAUDE.md` § Design handoff usage |
| `documentation-maintenance.md` | `CLAUDE.md` § Documentation maintenance — tool-agnostic parts only; **updated change-type table** (targets `.ai/docs/` not `CLAUDE.md` §) |
| `behavioral-guidelines.md` | `CLAUDE.md` § General behavioral guidelines + **Critical Thinking & Pushback** + **Secrets & Credentials** (repo-appropriate excerpts from maintainer personal config; excludes Memory, worktrees, one-build-at-a-time, tone bans) |
| `frontend-conventions.md` | Consolidated frontend guidance (cross-ref `design-handoff.md` for tokens; Vite + React + TS conventions) |
| `operating-context.md` | `CLAUDE.md` § Operating in this repo right now + § Spec and plan locations |

**Stays in `CLAUDE.md` only:** Auto-review of new specs/plans (`ce-doc-review`, one-pass, visible rejections), superpowers default path overrides, and a link table to every `.ai/docs/*.md` file.

## Changes

1. Add `.ai/README.md` describing SSOT + index table + how to wire a new AI tool.
2. Add `.ai/docs/*.md` (8 files) with migrated prose.
3. Add `.cursor/rules/base-rules.mdc` (`alwaysApply: true`), `frontend.mdc`, `testing.mdc`, and optional `README.md` for the rules table.
4. Replace `CLAUDE.md` body with intro + links + Claude-only sections.
5. Update cross-refs that pointed at `CLAUDE.md` § Development process / Documentation maintenance where a stable canonical link improves clarity: [`README.md`](../../README.md) § Process, [`docs/roadmap.md`](../../docs/roadmap.md) TDD paragraph, [`docs/specs/README.md`](./README.md) maintenance sentence.
6. Do **not** bulk-edit historical specs/plans/deferrals that mention `CLAUDE.md` in narrative or evidence — those are frozen records.

## Verification

- `Grep "CLAUDE.md § Repo state"` across **new** docs — should not appear in `.ai/docs/documentation-maintenance.md` table (replaced by `.ai/docs/repo-overview.md`).
- [`CLAUDE.md`](../../CLAUDE.md) is materially shorter; shared sections exist only under `.ai/docs/`.
- `.cursor/rules/*.mdc` use valid relative `mdc:` paths to `.ai/docs/`.
- [`dotnet test`](../../README.md) / build unchanged (docs-only PR).

## Risks

- **Cursor `mdc:` path resolution:** If a rule link breaks, Cursor may not load shared content — verify paths after merge.
- **Contributors used to `CLAUDE.md`:** README and roadmap now point to `.ai/docs/development-process.md` as canonical for TDD; `CLAUDE.md` still links there for Claude Code.

## Out of scope

- GitHub Copilot instructions, `AGENTS.md`, or other agent stubs (future PR can add one-line pointers to `.ai/docs/`).
- Changing [`CLAUDE.md`](../../CLAUDE.md) workspace rule injection in Cursor UI — project rules in `.cursor/rules/` complement or supersede per-user settings.
