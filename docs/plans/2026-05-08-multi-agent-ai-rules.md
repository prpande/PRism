# Multi-agent AI rules — implementation plan

> **For agentic workers:** Execute tasks in order. This PR is **docs and config only** — no production code or test changes.

**Spec:** [`docs/specs/2026-05-08-multi-agent-ai-rules-design.md`](../specs/2026-05-08-multi-agent-ai-rules-design.md)

**Goal:** Land `.ai/docs/` as SSOT, slim `CLAUDE.md`, add `.cursor/rules/*.mdc`, and update a few canonical cross-refs (`README.md`, `docs/roadmap.md`, `docs/specs/README.md` intro).

---

## Task 1: Add `.ai/README.md`

- [ ] Create `.ai/README.md` with: purpose (SSOT for all AI tools), directory layout, doc index table, "Integrating a new AI tool" (create tool dir, link to `.ai/docs/*.md`, do not copy content), "Updating rules" (edit `.ai/docs/` only).

**Verify:** `Test-Path .ai/README.md`

---

## Task 2: Add `.ai/docs/*.md` (8 files)

- [ ] `repo-overview.md` — migrate from `CLAUDE.md` § Repo state; add bullet for new `.ai/docs/` and `.cursor/rules/` in the tree list.
- [ ] `development-process.md` — TDD + implications + Commands (publish targets) + `README.md` § Pre-push checklist (inline or by reference).
- [ ] `architectural-invariants.md` — verbatim list from `CLAUDE.md`.
- [ ] `design-handoff.md` — verbatim from `CLAUDE.md` § Design handoff usage.
- [ ] `documentation-maintenance.md` — three-view prose + **updated** change-type table (see spec) + out-of-scope bullets + deferrals schema block; **omit** `ce-doc-review` / one-pass / visible-rejections / "Claude is the executor" (those stay in `CLAUDE.md`).
- [ ] `behavioral-guidelines.md` — Karpathy four sections + Critical Thinking & Pushback + Secrets & Credentials (per design spec exclusions).
- [ ] `frontend-conventions.md` — pointer to `design-handoff.md` for tokens + concise React/Vite/TS notes.
- [ ] `operating-context.md` — Operating in this repo + Spec and plan locations.

**Verify:** eight files exist under `.ai/docs/`; no duplicate full § Documentation maintenance auto-review text in `.ai/docs/`.

---

## Task 3: Add `.cursor/rules/`

- [ ] `base-rules.mdc` — `alwaysApply: true`; `mdc:` links to `repo-overview`, `development-process`, `architectural-invariants`, `behavioral-guidelines`, `operating-context`.
- [ ] `frontend.mdc` — globs `frontend/**`; links to `design-handoff`, `frontend-conventions`.
- [ ] `testing.mdc` — globs `tests/**`, `**/*.test.*`, `**/*.spec.*`; link to `development-process`.
- [ ] `README.md` — table mapping each `.mdc` → `.ai/docs/` targets (optional but matches BizApp.Bff style).

**Verify:** Paths use `../../.ai/docs/...` from `.cursor/rules/` (same as reference repo).

---

## Task 4: Rewrite root `CLAUDE.md`

- [ ] Keep title + one paragraph intro (Claude Code + pointer to `.ai/docs/`).
- [ ] Add link table: each `.ai/docs/*.md` with one-line purpose.
- [ ] Move Claude-only blocks: auto-review (`ce-doc-review`), one pass, visible rejections, "Claude is the executor"; superpowers path override paragraph.
- [ ] Remove migrated sections from body (no duplicate prose).

**Verify:** `CLAUDE.md` line count drops sharply; `Select-String '^## Repo state' CLAUDE.md` returns nothing.

---

## Task 5: Canonical cross-refs

- [ ] [`README.md`](../../README.md) § Process — link to [`.ai/docs/development-process.md`](../../.ai/docs/development-process.md) instead of `CLAUDE.md` § Development process.
- [ ] [`docs/roadmap.md`](../../docs/roadmap.md) — TDD sentence links to `.ai/docs/development-process.md`.
- [ ] [`docs/specs/README.md`](../../docs/specs/README.md) — first paragraph maintenance sentence references `.ai/docs/documentation-maintenance.md` (not only `CLAUDE.md` §).

---

## Task 6: Spec index entry

- [ ] Add this spec under **Not started** in [`docs/specs/README.md`](../../docs/specs/README.md) with link to plan.
- [ ] After PR merges implementation, move entry to **Implemented** and add PR number (human follow-up).

---

## Task 7: Final verification (manual)

```powershell
Test-Path .ai/docs/repo-overview.md
Test-Path .cursor/rules/base-rules.mdc
Select-String -Path CLAUDE.md -Pattern '^## Repo state'        # expect no match
Select-String -Path docs/specs/README.md -Pattern 'documentation-maintenance' 
dotnet build PRism.sln   # optional sanity — should succeed unchanged
```

---

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| `.ai/README.md` | Task 1 |
| Eight `.ai/docs/` files | Task 2 |
| `.cursor/rules/` | Task 3 |
| Slim `CLAUDE.md` | Task 4 |
| Cross-refs | Task 5 |
| `docs/specs/README.md` entry | Task 6 |
