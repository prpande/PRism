# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo state

PRism is **mid-implementation**. The repo's main contents:

- `PRism.sln` and six backend projects: `PRism.Core`, `PRism.Core.Contracts`, `PRism.GitHub`, `PRism.Web`, `PRism.AI.Contracts`, `PRism.AI.Placeholder`
- `tests/` — `PRism.Core.Tests`, `PRism.GitHub.Tests`, `PRism.Web.Tests`
- `frontend/` — React + Vite + TS app (per S0+S1)
- `validation-harness/` — manual / scripted validation harness
- Build infra: `Directory.Build.props`, `Directory.Packages.props`, `BannedSymbols.txt`, `NuGet.config`, `.editorconfig`, `.gitattributes`
- `run.ps1` — orchestrates dev workflow (PowerShell host)
- `docs/spec/` — the authoritative PoC specification (read in numerical order)
- `docs/backlog/` — prioritized v2 backlog (P0 / P1 / P2 / P4; P3 was dropped)
- `docs/roadmap.md` — implementation slice plan (S0+S1 → S6) with live slice statuses
- `docs/specs/` — per-slice / per-task design docs (output of brainstorming); see `docs/specs/README.md` for the status-grouped index
- `docs/plans/` — step-by-step implementation plans (output of writing-plans)
- `docs/solutions/` — documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`)
- `design/handoff/` — visual/interaction design as a self-contained HTML+JSX prototype (reference, **not** production code)
- `assets/icons/` — app icons (`PRism{16,32,48,64,256,512}.ico` + `PRismOG.png`)
- `.github/workflows/` — `ci.yml`, `claude.yml` (`@claude` mention handler), `claude-code-review.yml` (auto-review on every PR)

Implementation is in progress. `docs/spec/` remains the source of truth for the *full* PoC contract — including parts not yet shipped. `docs/roadmap.md` (slice-keyed) and `docs/specs/README.md` (spec-keyed) track shipped state. `docs/README.md` is the document map; start there.

`docs/spec/00-verification-notes.md` falsifies several easy assumptions about GitHub's API surface — it's load-bearing for the rest of the spec.

## Development process

**All production code is written test-first, red → green → refactor. No exceptions.**

- **Red**: write a failing test that proves the new behavior is needed. Run it; confirm it fails for the expected reason (not a compile error or a typo).
- **Green**: write the simplest implementation that makes the test pass. Don't generalize, don't anticipate, don't add scope.
- **Refactor**: clean up while tests stay green. If refactoring breaks tests, the refactor is the cause — fix it without changing test expectations.

This applies to every slice in `docs/roadmap.md` and to every commit. The spec's DoD lists *which* tests must exist (submit pipeline, reconciliation, migration); TDD is *how* every test in the codebase comes into existence — including the ones the DoD doesn't enumerate. Tests are the spec at the implementation level: if a behavior isn't tested, it isn't required, and adding production code that doesn't make a failing test pass is a process violation.

A few practical implications:
- **Every PR's first commit on a new behavior is the failing test.** Implementation lands in a follow-up commit (or a squashed commit that clearly pairs them). A diff that shows production code without a corresponding new test is a smell — the reviewer asks why.
- **Bug fixes start with a regression test that fails on `main`.** Then the fix lands.
- **Refactors that don't change behavior do not require new tests** — the existing suite is the safety net. If the existing suite doesn't cover the area being refactored, write the tests *first* (red against current behavior, green confirming current behavior), then refactor.
- **No "I'll add tests later" backlog items.** If a test wasn't written first, the behavior wasn't actually built — the work is incomplete.
- **No mocking the system under test.** Mock external boundaries (GitHub HTTP, OS keychain, file system where it makes the test painfully slow); test real classes against real collaborators inside the project.

## Commands

Canonical build / test / dev / publish commands live in [`README.md`](README.md) § Development workflow. Don't duplicate them here.

The publish targets are an architectural commitment, not just a command:

- `dotnet publish -r win-x64   --self-contained -p:PublishSingleFile=true`
- `dotnet publish -r osx-arm64 --self-contained -p:PublishSingleFile=true`

`osx-x64` (Intel Mac) is **explicitly out of scope** for the PoC — do not add it as a publish target without a documented test path.

## Architectural invariants the spec commits to

These are decisions already made and adversarially reviewed. Don't relitigate them in implementation; if they're wrong, the spec changes first.

- **GitHub-only, not multi-provider.** `IReviewService` is GitHub-shaped (cloud + GHES via configurable `github.host`). No `IReviewProvider`, no `ProviderCapabilities.Extensions`, no `VerdictExtensions` — earlier drafts had these and they were removed. `Verdict` is GitHub's three values: `Approve | RequestChanges | Comment`.
- **Source-level Octokit isolation.** `using Octokit;` must not appear in any source file under `PRism.Core` or `PRism.Web`. Octokit ships transitively via DI registration in `PRism.Web/Program.cs`; this is a *source-hygiene* rule for testability, **not** a binary-level isolation promise.
- **Capability-flag-gated AI seams.** PoC ships every AI seam interface with a `Noop*` implementation, ~25 placeholder DTOs in `PRism.AI.Contracts`, and 9 frontend slots that render `null`. `/api/capabilities` returns `false` for every `ai.*` flag in PoC. v2 lights them up by registering implementations and flipping flags — no Core refactor.
- **Reviewer-atomic submit via GraphQL pending review.** Drafts, replies, verdict, and summary stage in a GitHub *pending review* (invisible to others) and finalize together on Submit. The `addPullRequestReview` → `addPullRequestReviewThread`/`Reply` → `submitPullRequestReview` pipeline is resumable; `pendingReviewId`, per-thread `threadId`, and per-reply `replyCommentId` are stamped into `state.json` as they come back, and a `<!-- prism:client-id:<draftId> -->` HTML-comment marker in the body closes the lost-response window. See `docs/spec/00-verification-notes.md` § C1 and § C7.
- **Banner, not mutation.** Remote state never auto-applies to the diff under the cursor or to the reviewer's drafts. Polling produces a non-intrusive banner; reload is explicit. The narrow exception is informational widgets about *other* people's content (existing comment bodies, thread-state badges).
- **Truthful by default.** PoC shows whitespace, unfiltered diffs, and every draft. Filtering/categorization is the v2 AI layer's job.
- **One host per launch.** `github.host` is set once per process; switching hosts mid-launch is not supported. On startup, `state.json.lastConfiguredGithubHost` is compared against config and a host change clears every `pendingReviewId` / `threadId` / `replyCommentId` (draft *bodies* are preserved — text is sacred).
- **Cross-platform paths.** Always `Environment.GetFolderPath(SpecialFolder.LocalApplicationData)`; never hardcode `%APPDATA%` or `~/...`. Token storage uses MSAL Extensions (DPAPI on Windows, Keychain on macOS, `libsecret` on Linux — Linux is P4 and has documented failure-mode messaging).
- **Wire-format conventions.** All JSON enums round-trip as **kebab-case lowercase** (e.g. `"prism-created"`, `"request-changes"`) via a single `JsonStringEnumConverter` with a kebab-case naming policy on the application's `JsonSerializerOptions`. New enums inherit this automatically.
- **GraphQL Node IDs are opaque.** Treat `pendingReviewId` (`PRR_…`), `threadId` (`PRRT_…`), `replyCommentId`, etc. as opaque strings — no parsing, no prefix-sniffing, no synthesizing. Equality and pass-through to GraphQL only.
- **`.prism/` is the only directory PRism creates inside the user's workspace.** All clones, worktrees, and ref caches live under `<localWorkspace>/.prism/` (or `<dataDir>/.prism/` if no workspace). User-owned clones at `<workspace>/<repo>/` must remain visibly untouched. PoC ships the audit machinery but doesn't exercise it (no chat in PoC).

## Design handoff usage

`design/handoff/` is a high-fidelity interactive prototype using inline-Babel React. **Recreate the UI in the production stack (React + Vite + TS per spec); don't lift the JSX verbatim.** Key non-negotiables called out in `design/handoff/README.md`:

- Port `tokens.css` oklch values **as-is** — don't approximate to hex. The accent-rotation system depends on the parameterized hue.
- The spacing scale jumps `--s-6` (24) → `--s-8` (32). There is no `--s-7`.
- Don't add a hero panel to the inbox. It was tried and removed.
- Don't render the right activity rail below the 1180px breakpoint.
- Light-mode `--surface-1` is `oklch(0.985 0.003 250)`, not `#fff`. The slate tint matters.
- Only PR `#1842` is deeply mocked in the prototype; other tabs render stubs. In production, every tab gets the full PR Detail view.

## Operating in this repo right now

- Most edits at this stage will be to spec or backlog markdown. When a spec change has cross-cutting consequences, search the corpus for the affected term — many spec sections reference each other and `docs/spec/00-verification-notes.md` cross-links throughout.
- `docs/spec-review.md` is transient working notes from adversarial review passes; findings get absorbed into the spec proper. Don't edit it as if it were canonical.
- The two `.github/workflows/*.yml` workflows mention `@claude` and run on every PR. Be aware that opening a PR triggers an automated Claude code review.

### Spec and plan locations

- Per-slice / per-task design docs (output of brainstorming): `docs/specs/YYYY-MM-DD-<topic>-design.md`
- Per-slice / per-task implementation plans (output of writing-plans): `docs/plans/YYYY-MM-DD-<topic>.md`

These paths override the default `docs/superpowers/specs/` and `docs/superpowers/plans/` locations baked into the superpowers skills. The `docs/superpowers/` subtree no longer exists. Specs and plans live flat under `docs/` so other AI tools and contributors find them without traversing a tooling-specific subdirectory.

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
| Spec edited after its plan was written | Mechanically sync the matching `docs/plans/<source>.md` in the **same PR** before any review or resumed implementation. Default values, file lists, schema fields, error contracts, and test rows propagating from the spec must reach the plan first; otherwise reviews surface stale-cross-ref noise instead of plan-quality findings. |
| Planning or architectural decision rejects/defers an alternative | New entry in `docs/<specs\|plans>/<source>-deferrals.md` sidecar (create if absent) + reference from the matching `docs/specs/README.md` bullet. Triggered by any session that weighs alternatives — `ce-doc-review` rigor passes, brainstorming Q-decisions, plan-writing alternatives, ADR deferrals, in-conversation rigor passes. See sidecar schema below. |
| New `.github/workflows/` file or major workflow change | `CLAUDE.md` § Repo state if visible to contributors |

**Out of scope for this rule:**
- `docs/spec/` describes the full PoC target — it is a forward-looking design contract, not a status board. Don't rewrite it to match shipped state. The roadmap, README Status, and spec index track shipped state.
- `docs/spec-review.md` is transient working notes (per existing guidance) — no maintenance obligation.

**Auto-review of new specs and plans.** When a new spec or plan is written under `docs/specs/` or `docs/plans/` (typically as the final step of `superpowers:brainstorming` or `superpowers:writing-plans`), invoke `compound-engineering:ce-doc-review` on the freshly written file *before* pinging the user for the human-review pass. Apply the suggestions that hold up to scrutiny — judged with `superpowers:receiving-code-review` rigor (don't accept blindly; push back when warranted). Then ask the user to review the cleaned-up doc. The handoff to writing-plans / executing-plans waits on the user pass, not the machine pass.

The skill is `compound-engineering:ce-doc-review`. If it is not installed in a future session, fall back to the spec's existing self-review pass (placeholders / consistency / scope / ambiguity) and surface the gap to the user.

**One pass, no silent iteration.** Run `ce-doc-review` once on each freshly written doc. If applying suggestions would produce a substantively different doc that warrants re-review, only run a second pass at the user's explicit request — never iterate silently. Iteration without an exit criterion can converge on "the auto-reviewer always reports clean," which is the failure mode this rule prevents.

**Visible rejections.** When handing the cleaned-up doc to the user for the human-review pass, surface every finding `ce-doc-review` raised along with the action taken (Applied / Deferred / Skipped) and a one-line reason for non-applies. The user must be able to spot-check filtering — silent suppression of uncomfortable findings (e.g., premise challenges) under the banner of "didn't hold up to scrutiny" is the failure mode this rule prevents. Practical shape: a brief synthesis block (Coverage table + per-finding action list) printed to the conversation when handing off, not buried in the spec file itself.

**How "automatic" this is:** Claude is the executor. The trigger is the PR diff: when drafting commits that change any of the items above, scan the matching doc *before* opening the PR and include the doc edit in the same PR. PRs that ship code without the matching doc update are incomplete — flag and fix before merge.

**Deferrals sidecar schema.** Each entry in a `<source>-deferrals.md` follows this shape — the first sidecar to land (`docs/specs/2026-05-06-s3-pr-detail-read-deferrals.md`) is the canonical reference:

```markdown
---
source-doc: docs/specs/<source>.md
created: YYYY-MM-DD
status: open | resolved | superseded
---

## [Defer|Skip] <Title>

- **Source:** <which session — e.g., `ce-doc-review` 7-persona pass on YYYY-MM-DD>
- **Severity:** P0 | P1 | P2 | P3 | n/a
- **Date:** YYYY-MM-DD
- **Reason:** <why we deferred or skipped — one paragraph>
- **Revisit when:** <concrete trigger; "n/a" for skips>
- **Original finding evidence:** <quote or paraphrase>
```

`[Defer]` = will revisit (Revisit-when names the trigger). `[Skip]` = rejected with reasoning, do NOT revisit unless new evidence. Don't re-edit entries after the fact — frozen record. Updates land as new entries citing the prior one.

## General behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes. These bias toward caution over speed; for trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

*Source: [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md)*
