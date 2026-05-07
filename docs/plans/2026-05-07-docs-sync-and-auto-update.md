# Docs sync + auto-update — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`docs/specs/2026-05-07-docs-sync-and-auto-update-design.md`](../specs/2026-05-07-docs-sync-and-auto-update-design.md)

**Goal:** Refresh stale docs to reflect current implementation status, restructure `docs/superpowers/{specs,plans}/` → `docs/{specs,plans}/`, add a `## Documentation maintenance` policy + auto-review process to `CLAUDE.md`, and create a status-grouped `docs/specs/README.md` index — all in one coherent PR.

**Architecture:** All docs-only changes plus two cosmetic source-code comment updates (in `run.ps1` and `PRism.Web/Composition/ServiceCollectionExtensions.cs`). No production-code changes, no test changes, no build changes. The work is sequenced: **migrate first** (move + path-update sweep so the verification grep can catch any miss before structural rewrites land on top), **then refresh content**, **then add the new index + policy**, **then verify**.

**Tech Stack:** git (for `git mv` and history-preserving moves), Markdown, PowerShell (host shell). No build/test commands run as part of the PR's primary work. Two `dotnet build PRism.sln` invocations appear as sanity checks (Task 7 Step 4 after a comment-only edit to a `.cs` file; Task 18 Step 5 as the final pre-PR gate) — these confirm the executor didn't accidentally corrupt a source file during the edit pass, not that the PR is building anything new.

---

## File structure

**Create:**
- `docs/plans/2026-05-07-docs-sync-and-auto-update.md` (this file — already created)
- `docs/specs/README.md` (new spec status index)

**Move (via `git mv`, history preserved):**
- `docs/superpowers/specs/*.md` (9 files) → `docs/specs/*.md`
- `docs/superpowers/plans/*.md` (7 files) → `docs/plans/*.md`

**Delete:**
- `docs/superpowers/` (the empty directory after both subtrees clear)

**Modify (path-only references):**
- `CLAUDE.md`, `README.md`, `docs/roadmap.md`, `docs/README.md`
- `docs/spec/00-verification-notes.md`
- `docs/solutions/integration-issues/spa-static-assets-mime-type-fallback-2026-05-05.md`
- `validation-harness/README.md`
- `run.ps1` (single comment line)
- `PRism.Web/Composition/ServiceCollectionExtensions.cs` (single XML doc-comment line — verified comment-only, no `[FromFile]` attribute or load-bearing path)
- The 9 moved spec files + 7 moved plan files (each cross-references siblings; some files contain dense internal references — `2026-05-06-run-script-reset.md` has 9 occurrences, `2026-05-06-pat-scopes-and-validation.md` has 6, `docs/roadmap.md` has 6 spread across sections; `2026-05-06-s3-pr-detail-read.md` contains absolute Windows paths like `C:\src\PRism-s3-spec\docs\superpowers\...`)

**Modify (content rewrites — separate from path updates):**
- `CLAUDE.md` § Repo state, § Commands, new § Documentation maintenance H2, new ### Spec and plan locations subsection
- `README.md` § Status
- `docs/roadmap.md` slice rows + Architectural readiness table
- `docs/README.md` document map

---

## Pre-flight check

Before Task 1, confirm working tree state and commit the spec + plan as the baseline:

```powershell
git status --short
git checkout -b docs/sync-and-auto-update
git add docs/specs/2026-05-07-docs-sync-and-auto-update-design.md docs/plans/2026-05-07-docs-sync-and-auto-update.md
git commit -m "docs(spec+plan): docs sync + auto-update design and plan"
```

---

## Task 1: Move 9 spec files from `docs/superpowers/specs/` to `docs/specs/`

```powershell
git mv docs/superpowers/specs/2026-05-05-foundations-and-setup-design.md docs/specs/
git mv docs/superpowers/specs/2026-05-06-architectural-readiness-design.md docs/specs/
git mv docs/superpowers/specs/2026-05-06-inbox-read-design.md docs/specs/
git mv docs/superpowers/specs/2026-05-06-pat-scopes-and-validation-design.md docs/specs/
git mv docs/superpowers/specs/2026-05-06-prism-validation-prompt-set-design.md docs/specs/
git mv docs/superpowers/specs/2026-05-06-run-script-reset-design.md docs/specs/
git mv docs/superpowers/specs/2026-05-06-s3-pr-detail-read-design.md docs/specs/
git mv docs/superpowers/specs/2026-05-07-appstatestore-windows-rename-retry-design.md docs/specs/
git mv docs/superpowers/specs/2026-05-07-flaky-spa-fallback-test-fix-design.md docs/specs/

git status --short  # expect 9 R lines
git commit -m "chore(docs): move specs to docs/specs/"
```

Verify with `(Get-ChildItem docs/specs -Filter *.md).Count` returning 10 (9 moved + this PR's design doc).

---

## Task 2: Move 7 plan files from `docs/superpowers/plans/` to `docs/plans/`

```powershell
git mv docs/superpowers/plans/2026-05-05-foundations-and-setup.md docs/plans/
git mv docs/superpowers/plans/2026-05-06-pat-scopes-and-validation.md docs/plans/
git mv docs/superpowers/plans/2026-05-06-run-script-reset.md docs/plans/
git mv docs/superpowers/plans/2026-05-06-s2-inbox-read.md docs/plans/
git mv docs/superpowers/plans/2026-05-06-s3-pr-detail-read.md docs/plans/
git mv docs/superpowers/plans/2026-05-07-appstatestore-windows-rename-retry.md docs/plans/
git mv docs/superpowers/plans/2026-05-07-flaky-spa-fallback-test-fix.md docs/plans/

git status --short  # expect 7 R lines
git commit -m "chore(docs): move plans to docs/plans/"
```

Verify with `(Get-ChildItem docs/plans -Filter *.md).Count` returning 8 (7 moved + this PR's plan).

---

## Task 3: Update sibling cross-references inside the 9 moved spec files

For each spec file under `docs/specs/`, substitute:
- `docs/superpowers/specs/` → `docs/specs/`
- `docs/superpowers/plans/` → `docs/plans/`

Inventory and verify per-file:

```powershell
foreach ($f in Get-ChildItem docs/specs -Filter *.md) {
  $count = (Select-String -Path $f.FullName -Pattern 'docs/superpowers' -AllMatches).Matches.Count
  if ($count -gt 0) { "$($f.Name): $count" }
}
```

After edits, the same loop should produce no output. Commit:

```powershell
git add docs/specs/
git commit -m "docs(specs): update sibling cross-refs to docs/specs/ + docs/plans/"
```

---

## Task 4: Update sibling cross-references inside the 7 moved plan files

Same substitutions as Task 3, applied to `docs/plans/`. Plan files have higher reference density:
- `2026-05-06-run-script-reset.md`: 9 `superpowers/` occurrences
- `2026-05-06-pat-scopes-and-validation.md`: 6 occurrences

For these high-count files, after the bulk replace, open and visually verify each occurrence reads correctly in prose context.

**Special handling for `docs/plans/2026-05-06-s3-pr-detail-read.md`:** this file contains ~66 absolute Windows paths like `C:\src\PRism-s3-spec\docs\superpowers\...`. These cluster into two shapes:

- **Documentation references** (e.g., `See \`C:\src\PRism-s3-spec\docs\superpowers\specs\...\``): rewrite to repo-relative form (`See \`docs/specs/...\``).
- **Executable worktree command snippets** (e.g., `git -C C:\src\PRism-s3-spec checkout`, `dotnet build C:\src\PRism-s3-spec\PRism.sln`, `git -C C:\src\PRism-s3-spec add`): the work these commands drove has shipped (PRs #14, #15). They're historical artifacts of a worktree that no longer exists. **Remove the entire command block** or replace with a one-line note: `Originally executed against the C:\src\PRism-s3-spec worktree during S3 PR1/PR2 implementation; commands removed as historical.`

Verify both relative and absolute path checks return zero matches, then commit:

```powershell
foreach ($f in Get-ChildItem docs/plans -Filter *.md) {
  $count = (Select-String -Path $f.FullName -Pattern 'docs/superpowers' -AllMatches).Matches.Count
  if ($count -gt 0) { "STILL PRESENT: $($f.Name): $count" }
}
Select-String -Path docs/plans/*.md -Pattern 'PRism-s3-spec' -AllMatches  # expect no output

git add docs/plans/
git commit -m "docs(plans): update sibling cross-refs + remove absolute path artifacts"
```

---

## Task 5: Update path references in top-level docs

Files: `CLAUDE.md`, `README.md`, `docs/README.md`, `docs/roadmap.md`, `docs/spec/00-verification-notes.md`, `docs/solutions/integration-issues/spa-static-assets-mime-type-fallback-2026-05-05.md`, `validation-harness/README.md`.

Standard substitutions in all files:
- `docs/superpowers/specs/` → `docs/specs/`
- `docs/superpowers/plans/` → `docs/plans/`

`docs/roadmap.md` also references the relative form (without `docs/` prefix):
- `superpowers/specs/` → `specs/`
- `superpowers/plans/` → `plans/`

Verify zero matches per file:

```powershell
$files = @('CLAUDE.md','README.md','docs/README.md','docs/roadmap.md','docs/spec/00-verification-notes.md','docs/solutions/integration-issues/spa-static-assets-mime-type-fallback-2026-05-05.md','validation-harness/README.md')
foreach ($f in $files) {
  $count = (Select-String -Path $f -Pattern 'docs/superpowers|superpowers/specs|superpowers/plans' -AllMatches).Matches.Count
  if ($count -gt 0) { "STILL PRESENT: $f`: $count" }
}
```

Commit:

```powershell
git add CLAUDE.md README.md docs/README.md docs/roadmap.md docs/spec/00-verification-notes.md docs/solutions/integration-issues/spa-static-assets-mime-type-fallback-2026-05-05.md validation-harness/README.md
git commit -m "docs: update path references to docs/specs/ + docs/plans/"
```

---

## Task 6: Update path reference in `run.ps1`

Single comment line (line 17). Change:
```
# See docs/superpowers/specs/2026-05-06-run-script-reset-design.md for rationale.
```
to:
```
# See docs/specs/2026-05-06-run-script-reset-design.md for rationale.
```

Don't commit — bundle with Task 7.

---

## Task 7: Update path reference in `PRism.Web/Composition/ServiceCollectionExtensions.cs`

Single XML doc-comment line (~line 22). Change:
```csharp
    /// <c>docs/superpowers/specs/2026-05-06-architectural-readiness-design.md</c> § PR 2:
```
to:
```csharp
    /// <c>docs/specs/2026-05-06-architectural-readiness-design.md</c> § PR 2:
```

Sanity-check with `dotnet build PRism.sln` (build should succeed; this confirms the file wasn't accidentally corrupted during edit). Commit both source-code path updates together:

```powershell
git add run.ps1 PRism.Web/Composition/ServiceCollectionExtensions.cs
git commit -m "chore: update docs path refs in run.ps1 + ServiceCollectionExtensions.cs"
```

---

## Task 8: Final path-reference sweep + remove empty `docs/superpowers/`

```powershell
$files = Get-ChildItem -Path . -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\' }
$files | Select-String -Pattern 'docs/superpowers'   # expect no functional matches
$files | Select-String -Pattern 'superpowers/'       # expect no functional matches (only historical refs in this PR's spec/plan)
$files | Select-String -Pattern 'PRism-s3-spec'      # expect no matches
```

Acceptable matches: only intentional historical references inside `docs/specs/2026-05-07-docs-sync-and-auto-update-design.md` and `docs/plans/2026-05-07-docs-sync-and-auto-update.md` (these describe the old layout for context).

Then remove the empty directory:

```powershell
(Get-ChildItem docs/superpowers -Recurse).Count   # expect 0
Remove-Item docs/superpowers -Recurse
Test-Path docs/superpowers   # expect False
```

Git won't show anything for removing empty directories, so usually no commit needed here. If `git status --short` shows changes, commit them.

---

## Task 9: Add `### Spec and plan locations` subsection to `CLAUDE.md`

Insert under `## Operating in this repo right now`, before the next H2:

```markdown
### Spec and plan locations

- Per-slice / per-task design docs (output of brainstorming): `docs/specs/YYYY-MM-DD-<topic>-design.md`
- Per-slice / per-task implementation plans (output of writing-plans): `docs/plans/YYYY-MM-DD-<topic>.md`

These paths override the default `docs/superpowers/specs/` and `docs/superpowers/plans/` locations baked into the superpowers skills. The `docs/superpowers/` subtree no longer exists. Specs and plans live flat under `docs/` so other AI tools and contributors find them without traversing a tooling-specific subdirectory.
```

Don't commit — bundle with Tasks 10/11/12.

---

## Task 10: Rewrite `CLAUDE.md` § Repo state

Replace the entire `## Repo state` body with:

```markdown
## Repo state

PRism is **mid-implementation**. The repo's main contents:

- `PRism.sln` and six backend projects: `PRism.Core`, `PRism.Core.Contracts`, `PRism.GitHub`, `PRism.Web`, `PRism.AI.Contracts`, `PRism.AI.Placeholder`
- `tests/` — `PRism.Core.Tests`, `PRism.GitHub.Tests`, `PRism.Web.Tests`
- `frontend/` — React + Vite + TS app (per S0+S1)
- `validation-harness/` — manual / scripted validation harness
- Build infra: `Directory.Build.props`, `Directory.Packages.props`, `BannedSymbols.txt`, `NuGet.config`, `.editorconfig`, `.gitattributes`
- `run.ps1` — orchestrates dev workflow (PowerShell host)
- `docs/spec/` — the authoritative PoC specification (read in numerical order)
- `docs/backlog/` — prioritized v2 backlog (P0 / P1 / P2 / P4)
- `docs/roadmap.md` — implementation slice plan (S0+S1 → S6) with live slice statuses
- `docs/specs/` — per-slice / per-task design docs (output of brainstorming); see `docs/specs/README.md` for the status-grouped index
- `docs/plans/` — step-by-step implementation plans (output of writing-plans)
- `docs/solutions/` — documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`)
- `design/handoff/` — visual/interaction design as a self-contained HTML+JSX prototype (reference, **not** production code)
- `assets/icons/` — app icons (`PRism{16,32,48,64,256,512}.ico` + `PRismOG.png`)
- `.github/workflows/` — `ci.yml`, `claude.yml` (`@claude` mention handler), `claude-code-review.yml` (auto-review on every PR)

Implementation is in progress. `docs/spec/` remains the source of truth for the *full* PoC contract — including parts not yet shipped. `docs/roadmap.md` (slice-keyed) and `docs/specs/README.md` (spec-keyed) track shipped state. `docs/README.md` is the document map; start there.

`docs/spec/00-verification-notes.md` falsifies several easy assumptions about GitHub's API surface — it's load-bearing for the rest of the spec.
```

Don't commit — bundle with Tasks 9/11/12.

---

## Task 11: Replace `CLAUDE.md` § Commands

Replace the entire `## Commands` body with:

```markdown
## Commands

Canonical build / test / dev / publish commands live in [`README.md`](README.md) § Development workflow. Don't duplicate them here.

The publish targets are an architectural commitment, not just a command:

- `dotnet publish -r win-x64   --self-contained -p:PublishSingleFile=true`
- `dotnet publish -r osx-arm64 --self-contained -p:PublishSingleFile=true`

`osx-x64` (Intel Mac) is **explicitly out of scope** for the PoC — do not add it as a publish target without a documented test path.
```

Don't commit — bundle with Tasks 9/10/12.

---

## Task 12: Add `## Documentation maintenance` H2 to `CLAUDE.md`

Insert this new H2 between `## Operating in this repo right now` and `## General behavioral guidelines`:

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

Now commit all four CLAUDE.md edits (Tasks 9 + 10 + 11 + 12) together:

```powershell
git add CLAUDE.md
git commit -m "docs(CLAUDE): rewrite Repo state, replace Commands, add Documentation maintenance + spec/plan locations"
```

---

## Task 13: Update `README.md` § Status

Replace the body of the `## Status` H2 with:

```markdown
Implementation in progress. S0+S1 (foundations) and S2 (inbox read) have shipped; S3 (PR detail read) is mid-flight with PR1 (state migration) and PR2 (iteration clustering) merged. See [`docs/roadmap.md`](docs/roadmap.md) for the live slice table and [`docs/specs/README.md`](docs/specs/README.md) for the spec status index.
```

Verify with `Select-String -Path README.md -Pattern 'Pre-implementation' -CaseSensitive` — should produce no output. Commit:

```powershell
git add README.md
git commit -m "docs(README): update Status to reflect mid-implementation state"
```

---

## Task 14: Update `docs/roadmap.md` slice statuses + Architectural readiness

Update the S3 row's **Spec status** cell to:

```markdown
In progress — [`docs/specs/2026-05-06-s3-pr-detail-read-design.md`](specs/2026-05-06-s3-pr-detail-read-design.md) (PR #13); PR1 state migration (PR #14, [`docs/plans/2026-05-06-s3-pr-detail-read.md`](plans/2026-05-06-s3-pr-detail-read.md)), PR2 iteration clustering (PR #15) shipped; PR3+ remaining.
```

Verify S0+S1 and S2 rows still say "**Shipped**" with correct path references (Task 5 should have updated them to `docs/specs/...` and `docs/plans/...`).

Refresh the `## Architectural readiness` table — re-verify each row against current code/PR state:

- "Banned-API analyzer" → check `BannedSymbols.txt` exists; check analyzer registration in `Directory.Build.props`. If shipped, change cell to `Shipped`.
- "DI extension methods per project" → check `PRism.Web/Composition/ServiceCollectionExtensions.cs` and parallel files. If shipped, change accordingly.
- "Named records for all wire shapes" → spot-check a recent endpoint file in `PRism.Web/`. Update status truthfully.

If a status genuinely cannot be determined from code state alone, flag it inline (`status TBD — verify with maintainer`) rather than guessing.

Commit:

```powershell
git add docs/roadmap.md
git commit -m "docs(roadmap): refresh S3 status + architectural readiness table"
```

---

## Task 15: Update `docs/README.md` document map

Insert two new subsections after `### Backlog (docs/backlog/)` and before `### Design`:

```markdown
### Implementation specs & plans (docs/specs/, docs/plans/)

- [`docs/specs/`](specs/) — per-slice / per-task design docs (output of brainstorming). See [`docs/specs/README.md`](specs/README.md) for the status-grouped index.
- [`docs/plans/`](plans/) — step-by-step implementation plans (output of writing-plans).

### Solutions (docs/solutions/)

Documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`).

```

Commit:

```powershell
git add docs/README.md
git commit -m "docs(README/docs): add specs/plans/solutions to document map"
```

---

## Task 16: Re-verify spec status assignments against current code/PR state

Read-only research task. The spec lists a brainstorming-time snapshot of which specs are Implemented / In progress / Not started; this task produces the verified shape that goes into Task 17.

Commands to drive the research:

```powershell
git log --oneline --all --grep='2026-05-' -- docs/specs/
gh pr list --state merged --limit 30
```

For each spec the snapshot listed as Implemented, verify against code:

- `2026-05-05-foundations-and-setup-design.md` → `PRism.sln` + 6 projects exist, `frontend/` exists.
- `2026-05-06-pat-scopes-and-validation-design.md` → PAT validation exists in `PRism.GitHub` / `PRism.Web`.
- `2026-05-06-prism-validation-prompt-set-design.md` → validation prompts under `validation-harness/`.
- `2026-05-06-run-script-reset-design.md` → `run.ps1` has reset flow.
- `2026-05-06-inbox-read-design.md` → S2 inbox UI exists; PR #4.
- `2026-05-07-appstatestore-windows-rename-retry-design.md` → retry logic in `AppStateStore`; PR #16.
- `2026-05-07-flaky-spa-fallback-test-fix-design.md` → test changes; PR #16.

For "In progress" claims:
- `2026-05-06-s3-pr-detail-read-design.md` → PRs #14, #15 merged; PR3+ open.
- `2026-05-06-architectural-readiness-design.md` → mixed state per Task 14's table refresh.

Note the verified groups for use in Task 17. No commit yet.

---

## Task 17: Create `docs/specs/README.md` spec status index

Create `docs/specs/README.md` using the verified table from Task 16. Template:

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

Adjust the groups to match what Task 16 actually verified. Commit:

```powershell
git add docs/specs/README.md
git commit -m "docs(specs): add spec status index"
```

---

## Task 18: Final verification

The gate before opening the PR. Run all checks; fix anything still broken.

Path verification:

```powershell
$files = Get-ChildItem -Path . -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\' }
$m1 = $files | Select-String -Pattern 'docs/superpowers'
$m2 = $files | Select-String -Pattern 'superpowers/'
$m3 = $files | Select-String -Pattern 'PRism-s3-spec'
"Sweep 1: $(@($m1).Count) match(es)"
"Sweep 2: $(@($m2).Count) match(es)"
"Sweep 3: $(@($m3).Count) match(es)"
```

Acceptable: only intentional historical references inside the spec/plan describing this very migration.

Directory state:

```powershell
Test-Path docs/superpowers       # expect False
Test-Path docs/specs             # expect True
Test-Path docs/plans             # expect True
(Get-ChildItem docs/specs -Filter *.md).Count   # expect 11 (9 specs + this PR's design doc + README.md)
(Get-ChildItem docs/plans -Filter *.md).Count   # expect 8  (7 plans + this PR's plan doc)
```

History preservation:

```powershell
git log --follow --oneline docs/specs/2026-05-05-foundations-and-setup-design.md | Select-Object -First 5
```

Expect a commit predating Task 1's move — proves history was preserved through `git mv`.

Content checks:

```powershell
Select-String -Path CLAUDE.md -Pattern 'pre-implementation' -CaseSensitive:$false   # expect no output
Select-String -Path CLAUDE.md -Pattern '^## Documentation maintenance'              # expect 1
Select-String -Path CLAUDE.md -Pattern '^### Spec and plan locations'               # expect 1
Select-String -Path README.md -Pattern 'Pre-implementation' -CaseSensitive          # expect no output
Select-String -Path docs/roadmap.md -Pattern 'PR #14' -CaseSensitive                # expect 1+
Select-String -Path docs/roadmap.md -Pattern 'PR #15' -CaseSensitive                # expect 1+
Test-Path docs/specs/README.md                                                       # expect True
Select-String -Path docs/specs/README.md -Pattern '^## (Implemented|In progress|Not started)' # expect 3
```

Build sanity (since Task 7 touched a `.cs` file):

```powershell
dotnet build PRism.sln
```

Expect success.

If any check fails, fix inline and commit:

```powershell
git add <files>
git commit -m "docs: address verification findings"
```

If clean, no commit needed.

---

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| § 1 Directory restructure | Tasks 1, 2, 3, 4, 5, 6, 7, 8 |
| § 2 Canonical-path override | Task 9 |
| § 3 CLAUDE.md § Repo state rewrite | Task 10 |
| § 4 CLAUDE.md § Commands replace | Task 11 |
| § 5 README.md § Status | Task 13 |
| § 6 docs/roadmap.md refresh | Task 14 |
| § 7 docs/README.md document map | Task 15 |
| § 8 New docs/specs/README.md | Tasks 16, 17 |
| § 9 New ## Documentation maintenance H2 | Task 12 |
| § Verification | Task 18 |
