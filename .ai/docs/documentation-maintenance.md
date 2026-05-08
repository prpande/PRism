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
| Planning or architectural decision rejects/defers an alternative | New entry in `<source>-deferrals.md` beside the source spec or plan under `docs/specs/` or `docs/plans/` (create if absent) + reference from the matching `docs/specs/README.md` bullet. Triggered by any session that weighs alternatives — ce-doc-review rigor passes, brainstorming Q-decisions, plan-writing alternatives, ADR deferrals, in-conversation rigor passes. See deferrals sidecar schema below. |
| New `.github/workflows/` file or major workflow change | `.ai/docs/repo-overview.md` if visible to contributors |
| New/changed behavioral guideline | `.ai/docs/behavioral-guidelines.md` |
| New AI agent integration (new tool config directory) | Wire the tool to `.ai/docs/*.md`; update `.ai/README.md` index table |
| New or renamed `.ai/docs/` topic file | `.ai/README.md` doc index + [`CLAUDE.md`](../../CLAUDE.md) link table |

**Out of scope for this rule:**

- `docs/spec/` describes the full PoC target — it is a forward-looking design contract, not a status board. Don't rewrite it to match shipped state. The roadmap, README Status, and spec index track shipped state.
- `docs/spec-review.md` is transient working notes — no maintenance obligation.

**Deferrals sidecar schema.** A `<source>-deferrals.md` records deferred / skipped items affecting the source doc. The first sidecar to land (`docs/specs/2026-05-06-s3-pr-detail-read-deferrals.md`) is the canonical reference for the schema:

```markdown
---
source-doc: docs/{specs|plans}/<source>.md   # path mirrors the source doc's location
created: YYYY-MM-DD
last-updated: YYYY-MM-DD                     # bump when entries are added or status changes
status: open | resolved | superseded
---

## [Defer|Skip|Superseded] <Title>

- **Source:** <which session — e.g., `ce-doc-review` 7-persona pass on YYYY-MM-DD>
- **Severity:** P0 | P1 | P2 | P3 | n/a
- **Date:** YYYY-MM-DD
- **Reason:** <why we deferred or skipped — one paragraph>
- **Revisit when:** <concrete trigger; "n/a" for skips and superseded>
- **Original finding evidence:** <quote or paraphrase>
```

`[Defer]` = will revisit (Revisit-when names the trigger). `[Skip]` = rejected with reasoning, do NOT revisit unless new evidence. `[Superseded]` = a prior Apply/Defer/Skip decision that a later rigor pass overturned; references the original entry. Don't re-edit entries after the fact — frozen record. Updates land as new entries citing the prior one.

**Auto-review workflow (Claude Code):** See [`CLAUDE.md`](../../CLAUDE.md) — `compound-engineering:ce-doc-review`, one-pass policy, and visible-rejection handoff apply when authoring specs/plans in Claude Code sessions.
