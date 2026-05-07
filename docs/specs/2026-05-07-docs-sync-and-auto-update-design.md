# Docs sync + auto-update — design

**Date:** 2026-05-07
**Scope:** Repository documentation (`CLAUDE.md`, `README.md`, `docs/README.md`, `docs/roadmap.md`, all spec/plan files), plus a directory restructure under `docs/`.
**Out of scope:** `docs/spec/*` content (forward-looking PoC contract; not a status board), `docs/spec-review.md` (transient working notes), `docs/backlog/*` (priority docs unaffected by implementation status).

## Problem

Two distinct issues:

1. **Documentation has drifted from reality.** `CLAUDE.md` § Repo state still says PRism is *pre-implementation* — but `PRism.sln`, six backend projects, `frontend/`, `tests/`, `validation-harness/`, `run.ps1`, and several build-infra files now exist. `CLAUDE.md` § Commands says "no build/test/lint commands exist yet" while `README.md` documents them. `README.md` § Status says "foundations slice is in flight" though S0+S1 and S2 have shipped and S3 is mid-flight. `docs/roadmap.md` lists S3 as `Brainstormed` despite PRs #14 and #15 having shipped two of S3's eleven planned PRs. `docs/README.md` document map omits `docs/superpowers/` (specs + plans) and `docs/solutions/` entirely.
2. **No mechanism exists to prevent drift going forward.** Slice progress, new top-level projects, new commands, and new architectural invariants all land without a paired doc update because nothing names which doc owns each kind of change.

A third concern surfaced during brainstorming: specs and plans live under `docs/superpowers/`, a tooling-specific subdirectory. Other AI tools (Copilot, Codex, Cursor, etc.) and human contributors don't necessarily think to descend into a `superpowers/` directory to find authoritative design docs. The location is incidental — driven by the superpowers skill's default — not chosen.

## Approach

Three coordinated changes:

**A. Restructure.** Move `docs/superpowers/specs/` → `docs/specs/` and `docs/superpowers/plans/` → `docs/plans/`. Remove the empty `docs/superpowers/` directory. Override the brainstorming + writing-plans skill defaults via a new `### Spec and plan locations` subsection in `CLAUDE.md` so future skill invocations land docs in the new canonical paths automatically.

**B. One-shot fix-ups** of the four stale documents (`CLAUDE.md`, `README.md`, `docs/roadmap.md`, `docs/README.md`) plus a new spec status index at `docs/specs/README.md` that groups every spec by *Implemented / In progress / Not started*.

**C. Maintenance policy.** A new `## Documentation maintenance` H2 in `CLAUDE.md` containing a trigger→target table that names, for each kind of change, which doc must update in the same PR. No CI enforcement — Claude follows the policy when drafting PRs; reviewers catch drift via the existing review workflow.

**D. Auto-review of new docs.** Every newly written spec or plan (output of `superpowers:brainstorming` / `superpowers:writing-plans`) gets run through `compound-engineering:ce-doc-review` before the human-review handoff. Suggestions that hold up to scrutiny — judged with `superpowers:receiving-code-review` rigor, not blind acceptance — are applied inline. Only then does Claude ping the user for the human pass. This shifts a class of fixable issues (gaps, ambiguities, missing personas' concerns) left of the user's review time.

A "full automation" alternative (post-merge bot opens follow-up PRs rewriting docs) was rejected during brainstorming. It overlaps with the existing `@claude-code-review` workflow, risks low-quality rewrites going unreviewed, and pays infra cost for a problem that a clear policy already solves.

## Changes

### 1. Directory restructure

Move all 9 specs from `docs/superpowers/specs/` to `docs/specs/`:

- `2026-05-05-foundations-and-setup-design.md`
- `2026-05-06-architectural-readiness-design.md`
- `2026-05-06-inbox-read-design.md`
- `2026-05-06-pat-scopes-and-validation-design.md`
- `2026-05-06-prism-validation-prompt-set-design.md`
- `2026-05-06-run-script-reset-design.md`
- `2026-05-06-s3-pr-detail-read-design.md`
- `2026-05-07-appstatestore-windows-rename-retry-design.md`
- `2026-05-07-flaky-spa-fallback-test-fix-design.md`

Move all 7 plans from `docs/superpowers/plans/` to `docs/plans/`:

- `2026-05-05-foundations-and-setup.md`
- `2026-05-06-pat-scopes-and-validation.md`
- `2026-05-06-run-script-reset.md`
- `2026-05-06-s2-inbox-read.md`
- `2026-05-06-s3-pr-detail-read.md`
- `2026-05-07-appstatestore-windows-rename-retry.md`
- `2026-05-07-flaky-spa-fallback-test-fix.md`

Create `docs/plans/` (it does not yet exist; `git mv` into a missing directory fails). `docs/specs/` already exists and currently contains this design doc — the 9 specs are added alongside it, not into a fresh tree. Use `git mv` so history is preserved. Remove the now-empty `docs/superpowers/` directory after both subtrees are clear.

Update every reference to the old paths across the files identified by grep (~20). The "files" framing understates the work — several files contain dense internal cross-references (e.g., `docs/superpowers/plans/2026-05-06-run-script-reset.md` has 9 `superpowers/` occurrences; `2026-05-06-pat-scopes-and-validation.md` has 6; `docs/roadmap.md` has 6 spread across sections). Treat these as per-file rewrites, not single-line search-and-replace. Watch specifically for absolute Windows paths inside `docs/superpowers/plans/2026-05-06-s3-pr-detail-read.md` (e.g., `C:\src\PRism-s3-spec\docs\superpowers\...`), which the relative-path grep does not catch. The full list of files to update:

- `CLAUDE.md`, `README.md`, `docs/roadmap.md`
- `docs/spec/00-verification-notes.md`
- `docs/solutions/integration-issues/spa-static-assets-mime-type-fallback-2026-05-05.md`
- All 9 spec files and all 7 plan files (each cross-references siblings)
- `validation-harness/README.md`
- `run.ps1`
- `PRism.Web/Composition/ServiceCollectionExtensions.cs`

### 2. Canonical-path override in `CLAUDE.md`

New `### Spec and plan locations` subsection (placed under `## Operating in this repo right now` — same neighborhood as the existing tooling-aware guidance):

```markdown
### Spec and plan locations

- Per-slice / per-task design docs (output of brainstorming): `docs/specs/YYYY-MM-DD-<topic>-design.md`
- Per-slice / per-task implementation plans (output of writing-plans): `docs/plans/YYYY-MM-DD-<topic>.md`

These paths override the default `docs/superpowers/specs/` and `docs/superpowers/plans/` locations baked into the superpowers skills. The `docs/superpowers/` subtree no longer exists. Specs and plans live flat under `docs/` so other AI tools and contributors find them without traversing a tooling-specific subdirectory.
```

### 3. `CLAUDE.md` § Repo state — rewrite

Replace the current text with one that matches the actual tree. Top-level entries to enumerate:

- `PRism.sln` plus six backend projects: `PRism.Core`, `PRism.Core.Contracts`, `PRism.GitHub`, `PRism.Web`, `PRism.AI.Contracts`, `PRism.AI.Placeholder`
- `tests/` with `PRism.Core.Tests`, `PRism.GitHub.Tests`, `PRism.Web.Tests`
- `frontend/` (React + Vite + TS, per S0+S1)
- `validation-harness/`
- Build infra: `Directory.Build.props`, `Directory.Packages.props`, `BannedSymbols.txt`, `NuGet.config`, `.editorconfig`, `.gitattributes`
- `run.ps1` — orchestrates dev workflow
- `docs/spec/`, `docs/backlog/`, `docs/roadmap.md`, `docs/specs/`, `docs/plans/`, `docs/solutions/`
- `design/handoff/`, `assets/icons/`
- `.github/workflows/{ci.yml, claude.yml, claude-code-review.yml}`

Reframe the closing line: docs/spec/ remains the source of truth for *unbuilt* parts of the PoC; `docs/roadmap.md` + `docs/specs/README.md` track shipped state.

### 4. `CLAUDE.md` § Commands — replace

Replace "No build/test/lint commands exist yet..." with:

- One sentence saying canonical commands live in `README.md` § Development workflow.
- Keep the publish-target invariant inline (`win-x64`, `osx-arm64`; `osx-x64` explicitly out of scope) — it's an architectural constraint, not just a command.

### 5. `README.md` § Status — replace

Replace `Pre-implementation; the foundations slice ... is in flight` with:

> Implementation in progress. S0+S1 (foundations) and S2 (inbox read) have shipped; S3 (PR detail read) is mid-flight with PR1 (state migration) and PR2 (iteration clustering) merged. See [`docs/roadmap.md`](docs/roadmap.md) for the live slice table and [`docs/specs/README.md`](docs/specs/README.md) for the spec status index.

### 6. `docs/roadmap.md` — refresh slice statuses

Update S3 row's `Spec status` cell from `Brainstormed` to:

> In progress — `docs/specs/2026-05-06-s3-pr-detail-read-design.md` (PR #13); PR1 state migration (PR #14, [`docs/plans/2026-05-06-s3-pr-detail-read.md`](plans/2026-05-06-s3-pr-detail-read.md)), PR2 iteration clustering (PR #15) shipped; PR3+ remaining.

Confirm S0+S1 and S2 rows still say "Shipped" with current PR/path references after the directory move.

Update the `## Architectural readiness` table to reflect any items that have shipped in the merged PRs (analyzer / DI extensions / named records etc.) — re-verify against current code before writing.

### 7. `docs/README.md` — extend document map

Two new subsections after `### Backlog (docs/backlog/)`:

```markdown
### Implementation specs & plans (docs/specs/, docs/plans/)

- [`docs/specs/`](specs/) — per-slice / per-task design docs (output of brainstorming). See [`docs/specs/README.md`](specs/README.md) for the status-grouped index.
- [`docs/plans/`](plans/) — step-by-step implementation plans (output of writing-plans).

### Solutions (docs/solutions/)

Documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`).
```

### 8. New `docs/specs/README.md` — spec status index

Status-grouped index of every spec. Each entry: title, one-line scope, matching plan link if any, PR(s) that landed it.

```markdown
# Specs index

Per-slice / per-task design docs. New specs land at `docs/specs/YYYY-MM-DD-<topic>-design.md` (output of the brainstorming skill). Each entry below names its matching plan under `docs/plans/` and the PR(s) that landed it.

When a spec's status changes, move its entry to the right group and add the PR reference. Per `CLAUDE.md` § Documentation maintenance, this update lands in the same PR that ships the implementation.

## Implemented

- [`2026-05-05-foundations-and-setup-design.md`](2026-05-05-foundations-and-setup-design.md) — S0+S1 walking skeleton; plan: [`../plans/2026-05-05-foundations-and-setup.md`](../plans/2026-05-05-foundations-and-setup.md). Shipped.
- [`2026-05-06-pat-scopes-and-validation-design.md`](2026-05-06-pat-scopes-and-validation-design.md) — PAT scope set + validation flow; plan: [`../plans/2026-05-06-pat-scopes-and-validation.md`](../plans/2026-05-06-pat-scopes-and-validation.md). Shipped.
- [`2026-05-06-prism-validation-prompt-set-design.md`](2026-05-06-prism-validation-prompt-set-design.md) — Validation prompt corpus. Shipped.
- [`2026-05-06-run-script-reset-design.md`](2026-05-06-run-script-reset-design.md) — `run.ps1` reset/orchestration; plan: [`../plans/2026-05-06-run-script-reset.md`](../plans/2026-05-06-run-script-reset.md). Shipped.
- [`2026-05-06-inbox-read-design.md`](2026-05-06-inbox-read-design.md) — S2 inbox (read); plan: [`../plans/2026-05-06-s2-inbox-read.md`](../plans/2026-05-06-s2-inbox-read.md). PR #4. Shipped.
- [`2026-05-07-appstatestore-windows-rename-retry-design.md`](2026-05-07-appstatestore-windows-rename-retry-design.md) — Windows AV/indexer rename race fix; plan: [`../plans/2026-05-07-appstatestore-windows-rename-retry.md`](../plans/2026-05-07-appstatestore-windows-rename-retry.md). PR #16. Shipped.
- [`2026-05-07-flaky-spa-fallback-test-fix-design.md`](2026-05-07-flaky-spa-fallback-test-fix-design.md) — Deterministic wwwroot stub for SPA fallback test; plan: [`../plans/2026-05-07-flaky-spa-fallback-test-fix.md`](../plans/2026-05-07-flaky-spa-fallback-test-fix.md). PR #16. Shipped.

## In progress

- [`2026-05-06-s3-pr-detail-read-design.md`](2026-05-06-s3-pr-detail-read-design.md) — S3 PR detail (read); plan: [`../plans/2026-05-06-s3-pr-detail-read.md`](../plans/2026-05-06-s3-pr-detail-read.md). PR1 (state migration) + PR2 (iteration clustering) shipped via PRs #14, #15. PR3+ remaining.
- [`2026-05-06-architectural-readiness-design.md`](2026-05-06-architectural-readiness-design.md) — Cross-cutting structural items gated to slices. Mixed status: some *Now*-gate items shipped (analyzer, DI extensions, named records); S3 / S4 / S5 / P0+ items still open.

## Not started

- (none currently — every brainstormed spec has at least started shipping.)

## This index file

[`2026-05-07-docs-sync-and-auto-update-design.md`](2026-05-07-docs-sync-and-auto-update-design.md) — *In progress until the implementation PR lands.*
```

The implementation phase will re-verify each status assignment against current code/PR state before writing — the list above is the brainstorming-time snapshot.

### 9. `CLAUDE.md` — new `## Documentation maintenance` section

Lives between `## Operating in this repo right now` and `## General behavioral guidelines`. Content:

```markdown
## Documentation maintenance

Docs and code drift if you don't keep them in lockstep. Every PR that changes one of the items below MUST update the matching doc(s) in the **same PR**. If unsure, grep the doc corpus for the affected term — many sections cross-reference each other.

**Why three views of project status?** Three sync surfaces — `README.md` § Status, `docs/roadmap.md`, and `docs/specs/README.md` — exist on purpose, each at a different abstraction level:

- `README.md` § Status is the high-level *"where are we?"* answer for someone landing on the repo for the first time. No nuance.
- `docs/roadmap.md` tracks slice-level scope: what each slice means, what's shipped, what's remaining. A slice often contains multiple specs.
- `docs/specs/README.md` is spec-keyed. It also covers specs that **don't map to any roadmap slice** — bug fixes, follow-ups, and ad-hoc work (e.g., `2026-05-07-appstatestore-windows-rename-retry-design.md`, `2026-05-07-flaky-spa-fallback-test-fix-design.md`). The roadmap can't track these because they aren't slices; the spec index is the only place they have a home.

The three views are not redundant — they cover different audiences (casual reader / planner / spec author) and different scopes (project / slice / individual spec). The cost is updating multiple surfaces on slice-progress events; the table below names exactly what to update for each change type so the cost is bounded and explicit.

| Change type | Doc(s) to update |
|---|---|
| Slice PR merged (or partial slice progress) | `docs/roadmap.md` slice row + `README.md` § Status + `docs/specs/README.md` spec status group |
| New top-level project / directory / build infra file | `CLAUDE.md` § Repo state |
| New / changed build, test, run, or publish command | `README.md` (canonical) + `CLAUDE.md` § Commands if it touches an architectural invariant |
| New architectural invariant or change to existing one | `CLAUDE.md` § Architectural invariants + relevant `docs/spec/` section + cross-refs |
| New design handoff non-negotiable | `CLAUDE.md` § Design handoff usage + `design/handoff/README.md` |
| New solution recipe (bug, best practice, workflow pattern) | new file under `docs/solutions/<category>/` with YAML frontmatter |
| New per-slice / per-task design doc | `docs/specs/YYYY-MM-DD-<topic>-design.md` + entry in `docs/specs/README.md` (under "Not started" initially, then promoted as work ships) |
| New per-slice / per-task plan | `docs/plans/YYYY-MM-DD-<topic>.md` |
| Spec status change (Not started → In progress → Implemented) | `docs/specs/README.md` group + cross-link to the PR(s) that moved it |
| New `.github/workflows/` file or major workflow change | `CLAUDE.md` § Repo state if visible to contributors |

**Out of scope for this rule:**
- `docs/spec/` describes the full PoC target — it is a forward-looking design contract, not a status board. Don't rewrite it to match shipped state. The roadmap, README Status, and spec index track shipped state.
- `docs/spec-review.md` is transient working notes (per existing guidance) — no maintenance obligation.

**Auto-review of new specs and plans.** When a new spec or plan is written under `docs/specs/` or `docs/plans/` (typically as the final step of `superpowers:brainstorming` or `superpowers:writing-plans`), invoke `compound-engineering:ce-doc-review` on the freshly written file *before* pinging the user for the human-review pass. Apply the suggestions that hold up to scrutiny — judged with `superpowers:receiving-code-review` rigor (don't accept blindly; push back when warranted). Then ask the user to review the cleaned-up doc. The handoff to writing-plans / executing-plans waits on the user pass, not the machine pass.

The skill is `compound-engineering:ce-doc-review`. If it is not installed in a future session, fall back to the spec's existing self-review pass (placeholders / consistency / scope / ambiguity) and surface the gap to the user.

**One pass, no silent iteration.** Run `ce-doc-review` once on each freshly written doc. If applying suggestions would produce a substantively different doc that warrants re-review, only run a second pass at the user's explicit request — never iterate silently. Iteration without an exit criterion can converge on "the auto-reviewer always reports clean," which is the failure mode this rule prevents.

**Visible rejections.** When handing the cleaned-up doc to the user for the human-review pass, surface every finding `ce-doc-review` raised along with the action taken (Applied / Deferred / Skipped) and a one-line reason for non-applies. The user must be able to spot-check filtering — silent suppression of uncomfortable findings (e.g., premise challenges) under the banner of "didn't hold up to scrutiny" is the failure mode this rule prevents. Practical shape: a brief synthesis block (Coverage table + per-finding action list) printed to the conversation when handing off, not buried in the spec file itself.

**How "automatic" this is:** Claude is the executor. The trigger is the PR diff: when drafting commits that change any of the items above, scan the matching doc *before* opening the PR and include the doc edit in the same PR. PRs that ship code without the matching doc update are incomplete — flag and fix before merge.
```

## Verification

- `compound-engineering:ce-doc-review` was invoked against this spec before the user-review handoff, and applicable suggestions were folded in (or explicitly rejected with reason).
- After all moves, `Grep "docs/superpowers"` returns **zero** matches across the repo.
- `Grep "superpowers"` (broader sweep, no path prefix) returns zero functional matches — only acknowledged historical artifacts (e.g., this spec's own narrative references in the Problem section, if any survive the rewrite).
- `Grep "PRism-s3-spec"` returns zero matches — the absolute Windows paths in `2026-05-06-s3-pr-detail-read.md` are either rewritten to repo-relative form or removed.
- `docs/superpowers/` directory does not exist.
- `docs/specs/` and `docs/plans/` exist; each contains the expected file count (9 specs, 7 plans, plus this design and `README.md`).
- `git log --follow` on each moved file resolves through the rename — `git mv` preserved history.
- `CLAUDE.md` § Repo state contains no string "pre-implementation".
- `README.md` § Status contains no string "Pre-implementation".
- `docs/roadmap.md` S3 row reflects PR1/PR2 shipped.
- `docs/specs/README.md` exists and groups every spec into one of the three status buckets.
- New `## Documentation maintenance` H2 exists in `CLAUDE.md`.
- All cross-references (the 20 files identified by grep) resolve when followed in a Markdown viewer / IDE.

## Risks

- **`run.ps1` reference to `docs/superpowers/`.** If this is a code path (e.g., a path that the script emits to a log or expects on disk), a broken reference could surface as a runtime error. Implementation will verify `run.ps1`'s reference is documentation-only (a comment or help-text string) before changing.
- **Source code reference in `PRism.Web/Composition/ServiceCollectionExtensions.cs`.** Same concern — most likely a comment or doc-link string, but worth verifying it's not a `[FromFile(...)]` attribute or similar before swapping.
- **Skill defaults override may not stick.** The brainstorming skill text says "User preferences for spec location override this default" — but we're relying on Claude reading `CLAUDE.md` and respecting it. If a future skill invocation ignores `CLAUDE.md`, specs could land back in `docs/superpowers/`. Mitigated by the `## Documentation maintenance` policy listing the canonical paths and by the absence of the `docs/superpowers/` directory making the wrong location obviously broken.
- **Status assignments in the new index.** Best-effort categorization at brainstorming time; implementation PR will re-verify each spec against current code + PR state before committing the index.

## Out of scope

- CI enforcement of doc/code sync (rejected during brainstorming — additive in a future PR if drift recurs).
- Touching `docs/spec/*` content (forward-looking design contract; only path references update).
- Rewriting `docs/backlog/*` (priority documents unaffected by implementation status).
- Changes to the `superpowers` skill content itself — `CLAUDE.md` overrides the default location; the skill source is not modified.
- Updating PR descriptions of past PRs to point at new paths.
