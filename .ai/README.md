# AI docs — shared development rules

This directory is the **single source of truth** for repository-wide guidance consumed by AI coding assistants (Claude Code, Cursor, and future tools). Content is tool-agnostic plain Markdown under `.ai/docs/`.

## Layout

```
.ai/
  README.md          ← this file
  docs/
    repo-overview.md
    development-process.md
    architectural-invariants.md
    design-handoff.md
    documentation-maintenance.md
    behavioral-guidelines.md
    frontend-conventions.md
    operating-context.md

CLAUDE.md            ← Claude Code entry point + Claude-only workflows (links here)
.cursor/rules/*.mdc ← Cursor: frontmatter + mdc: links into .ai/docs/
```

## Doc index

| File | Purpose |
|------|---------|
| `repo-overview.md` | Top-level layout, projects, doc map pointer |
| `development-process.md` | TDD, commands / publish targets, pre-push checklist |
| `architectural-invariants.md` | Non-negotiable product/architecture decisions |
| `design-handoff.md` | `design/handoff/` prototype rules (tokens, layout) |
| `documentation-maintenance.md` | Which docs to update per change type |
| `behavioral-guidelines.md` | Collaboration defaults (thinking, scope, secrets) |
| `frontend-conventions.md` | React + Vite + TS + cross-ref to handoff |
| `operating-context.md` | Current repo cadence, spec/plan paths |

## Integrating a new AI tool

1. Add a config directory for the tool if needed (e.g. `.github/agents/`, `.copilot/`).
2. Reference the relevant `.ai/docs/*.md` files — **do not copy** bodies into the tool config.
3. Updates propagate automatically when `.ai/docs/` changes.

## Updating rules

Edit files in `.ai/docs/` directly. Update `.ai/README.md` **Doc index** only when adding/removing/renaming a shared topic file. Update [`CLAUDE.md`](../CLAUDE.md) link table when adding a new `.ai/docs/` file so Claude Code users still have a route map.
