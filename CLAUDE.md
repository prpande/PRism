# CLAUDE.md

This file is the **Claude Code** entry point for this repository. Shared guidance lives in [`.ai/docs/`](.ai/docs/) so Cursor and other agents can consume the same content without duplicating prose.

## Shared rules (`.ai/docs/`)

| File | Contents |
|------|----------|
| [`repo-overview.md`](.ai/docs/repo-overview.md) | Top-level tree, doc map pointer |
| [`development-process.md`](.ai/docs/development-process.md) | TDD, commands / publish targets, pre-push checklist |
| [`architectural-invariants.md`](.ai/docs/architectural-invariants.md) | Non-negotiable architecture decisions |
| [`design-handoff.md`](.ai/docs/design-handoff.md) | `design/handoff/` prototype rules |
| [`documentation-maintenance.md`](.ai/docs/documentation-maintenance.md) | Which docs to update per change type |
| [`behavioral-guidelines.md`](.ai/docs/behavioral-guidelines.md) | Collaboration and coding discipline |
| [`frontend-conventions.md`](.ai/docs/frontend-conventions.md) | React + Vite + TS notes |
| [`operating-context.md`](.ai/docs/operating-context.md) | Current cadence, spec/plan paths |

Index and wiring instructions: [`.ai/README.md`](.ai/README.md). Cursor loads the same docs via [`.cursor/rules/`](.cursor/rules/).

## Claude-only: spec and plan locations

- Per-slice / per-task design docs (output of brainstorming): `docs/specs/YYYY-MM-DD-<topic>-design.md`
- Per-slice / per-task implementation plans (output of writing-plans): `docs/plans/YYYY-MM-DD-<topic>.md`

These paths override the default `docs/superpowers/specs/` and `docs/superpowers/plans/` locations baked into the superpowers skills. The `docs/superpowers/` subtree no longer exists. Specs and plans live flat under `docs/` so other AI tools and contributors find them without traversing a tooling-specific subdirectory.

## Claude-only: auto-review of new specs and plans

When a new spec or plan is written under `docs/specs/` or `docs/plans/` (typically as the final step of `superpowers:brainstorming` or `superpowers:writing-plans`), invoke `compound-engineering:ce-doc-review` on the freshly written file *before* pinging the user for the human-review pass. Apply the suggestions that hold up to scrutiny — judged with `superpowers:receiving-code-review` rigor (don't accept blindly; push back when warranted). Then ask the user to review the cleaned-up doc. The handoff to writing-plans / executing-plans waits on the user pass, not the machine pass.

The skill is `compound-engineering:ce-doc-review`. If it is not installed in a future session, fall back to the spec's existing self-review pass (placeholders / consistency / scope / ambiguity) and surface the gap to the user.

**One pass, no silent iteration.** Run `ce-doc-review` once on each freshly written doc. If applying suggestions would produce a substantively different doc that warrants re-review, only run a second pass at the user's explicit request — never iterate silently.

**Visible rejections.** When handing the cleaned-up doc to the user for the human-review pass, surface every finding `ce-doc-review` raised along with the action taken (Applied / Deferred / Skipped) and a one-line reason for non-applies.

**How "automatic" this is:** Claude is the executor. The trigger is the PR diff: when drafting commits that change anything covered by [`.ai/docs/documentation-maintenance.md`](.ai/docs/documentation-maintenance.md), scan the matching doc *before* opening the PR and include the doc edit in the same PR.
