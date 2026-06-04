# Documentation maintenance

Docs and code drift if you don't keep them in lockstep. Every PR that changes one of the items below MUST update the matching doc(s) in the **same PR**. If unsure, grep the doc corpus for the affected term — many sections cross-reference each other.

**Why three views of project status?** Three sync surfaces — `README.md` § Status, `docs/roadmap.md`, and `docs/specs/README.md` — exist on purpose, each at a different abstraction level:

- `README.md` § Status is the high-level *"where are we?"* answer for someone landing on the repo for the first time. No nuance.
- `docs/roadmap.md` tracks slice-level scope: what each slice means, what's shipped, what's remaining. A slice often contains multiple specs.
- `docs/specs/README.md` is spec-keyed. It also covers specs that **don't map to any roadmap slice** — bug fixes, follow-ups, and ad-hoc work. The roadmap can't track these because they aren't slices; the spec index is the only place they have a home.

The three views are not redundant — they cover different audiences (casual reader / planner / spec author) and different scopes (project / slice / individual spec). The cost is updating multiple surfaces on slice-progress events; the table below names exactly what to update for each change type so the cost is bounded and explicit.

| Change type | Doc(s) to update |
|---|---|
| Slice PR merged (or partial slice progress) | `docs/roadmap.md` slice row + `README.md` § Status + `docs/specs/README.md` spec status group |
| New top-level project / directory / build infra file | `.ai/docs/repo-overview.md` |
| New / changed build, test, run, or publish command | `README.md` (canonical) + `.ai/docs/development-process.md` if it touches process or an architectural invariant |
| New architectural invariant or change to existing one | `.ai/docs/architectural-invariants.md` + relevant `docs/spec/` section + cross-refs |
| New design handoff non-negotiable | `.ai/docs/design-handoff.md` + `design/handoff/README.md` |
| New solution recipe (bug, best practice, workflow pattern) | New file under `docs/solutions/<category>/` with YAML frontmatter |
| New per-slice / per-task design doc | `docs/specs/YYYY-MM-DD-<topic>-design.md` + entry in `docs/specs/README.md` (under "Not started" initially, then promoted as work ships) |
| New per-slice / per-task plan | `docs/plans/YYYY-MM-DD-<topic>.md` |
| Spec status change (Not started → In progress → Implemented) | `docs/specs/README.md` group + cross-link to the PR(s) that moved it |
| Spec edited after its plan was written | Mechanically sync the matching `docs/plans/<source>.md` in the **same PR** before any review or resumed implementation. Default values, file lists, schema fields, error contracts, and test rows propagating from the spec must reach the plan first; otherwise reviews surface stale-cross-ref noise instead of plan-quality findings. |
| Planning or architectural decision rejects/defers an alternative | **Defer** → open (or update) a GitHub issue labelled `deferred` as the system of record, then add a one-line entry linking it under a `## Deferred work` section in the source spec/plan (create the section if absent). **Skip / Superseded** → record the one-line entry in `## Deferred work` only (no issue — nothing to track). Either way, reference from the matching `docs/specs/README.md` bullet. Triggered by any session that weighs alternatives — ce-doc-review rigor passes, brainstorming Q-decisions, plan-writing alternatives, ADR deferrals, in-conversation rigor passes. See deferred-work convention below. |
| New `.github/workflows/` file or major workflow change | `.ai/docs/repo-overview.md` if visible to contributors |
| New/changed behavioral guideline | `.ai/docs/behavioral-guidelines.md` |
| New AI agent integration (new tool config directory) | Wire the tool to `.ai/docs/*.md`; update `.ai/README.md` index table |
| New or renamed `.ai/docs/` topic file | `.ai/README.md` doc index + [`CLAUDE.md`](../../CLAUDE.md) link table |
| Change to the issue-resolution workflow (tiers, gates, proof contract, pipelines) | `.ai/docs/issue-resolution-workflow.md` kept in lockstep + `docs/specs/2026-06-03-issue-resolution-workflow-design.md` if rationale changes |
| New/changed architectural invariant, OR a change moving risk-surface code into a new directory | Mandatory review of the risk-surface table in `.ai/docs/issue-resolution-workflow.md`. Plus a scheduled (monthly) re-audit — code can drift a surface into a new path without touching `architectural-invariants.md`. |

**Out of scope for this rule:**

- `docs/spec/` describes the full PoC target — it is a forward-looking design contract, not a status board. Don't rewrite it to match shipped state. The roadmap, README Status, and spec index track shipped state.
- `docs/spec-review.md` is transient working notes — no maintenance obligation.

**Deferred-work convention (GitHub issues + in-spec links).** Deferred / skipped items affecting a source doc are tracked as **GitHub issues** (the system of record), with a thin pointer kept in the source doc so the decision stays visible in the PR diff. This replaces the former `<source>-deferrals.md` sidecar. Existing sidecars are a frozen historical record — **not migrated**; only new deferrals follow this convention.

- **`[Defer]`** (will revisit): open a GitHub issue — label `deferred` (create the label once if absent), title the deferred work, and in the body capture **Reason**, **Revisit-when** (the concrete trigger), **Source** (which session — e.g. `ce-doc-review` pass on YYYY-MM-DD), **Severity** (P0–P3), **Original finding evidence** (quote/paraphrase), and a back-link to the source spec/plan. The issue is the durable record; close it when the work lands. When starting a slice, find prior deferrals that target it by searching **both** surfaces: `gh issue list --repo prpande/PRism --label deferred --state open` (new work) **and** a grep of the frozen `*-deferrals.md` sidecars under `docs/specs/` (older work, not migrated).
- **`[Skip]`** (rejected, do NOT revisit unless new evidence) and **`[Superseded]`** (a prior decision a later rigor pass overturned): **no issue** — there is nothing to track or close. Record them inline in `## Deferred work` only.

Each source spec/plan carries a `## Deferred work` section; one line per item:

```markdown
## Deferred work

- **[Defer] <Title>** — [#NNN](https://github.com/prpande/PRism/issues/NNN). <one-line reason>. Revisit: <trigger>.
- **[Skip] <Title>** — <one-line reason; why we will not revisit>.
- **[Superseded] <Title>** — overturns <prior decision / issue>; <one-line reason>.
```

Write the in-spec line immediately with a literal `#TBD` marker (it works offline); replace `#TBD` with the real `#NNN` link once the issue is filed — a deterministic find-and-replace. Don't rewrite a `[Defer]` line's history in place — status and decision changes live in the issue thread (or a new `[Superseded]` line), preserving the frozen-record property the sidecar used to provide.

**Auto-review workflow (Claude Code):** See [`CLAUDE.md`](../../CLAUDE.md) — `compound-engineering:ce-doc-review`, one-pass policy, and visible-rejection handoff apply when authoring specs/plans in Claude Code sessions.
