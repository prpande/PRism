# v1 Completion Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the v1 ship work to merged-on-main `v0.1.0` across three sequential phases, each with its own brainstorm/spec/plan cycle.

**Architecture:** This is a **meta-plan**. The roadmap spec at [`docs/specs/2026-05-28-v1-completion-roadmap-design.md`](../specs/2026-05-28-v1-completion-roadmap-design.md) decomposes v1 into three phases, and § 7 of the spec commits each phase to its own spec/plan cycle. This plan covers only (a) landing the roadmap spec itself on `main` with its docs-index updates and (b) orchestration tasks that trigger the per-phase cycles in sequence. Implementation work for Phases 1-3 happens in their own per-phase plans, not here.

**Tech Stack:** N/A — this plan ships docs/orchestration only. The per-phase plans carry tech stack details (Phase 1: .NET hosting + IPC + Win32/POSIX primitives; Phase 2: markdown + light Playwright capture; Phase 3: GitHub Actions + binary dispatch).

**Decomposition note.** The writing-plans skill flags multi-subsystem specs and recommends splitting them. The roadmap spec already does the split — § 7 explicitly names per-phase brainstorm/plan filenames. This plan honors that split rather than trying to inline three subsystems' worth of tasks.

---

### Task 1: Land the v1 roadmap spec PR

**Files:**
- Modify: `docs/specs/README.md` (add new "In progress" entry)
- Modify: `docs/roadmap.md` (add "v1 completion (post-S6)" section after the S6 row)
- Already created: `docs/specs/2026-05-28-v1-completion-roadmap-design.md` (committed at HEAD of `docs/v1-completion-roadmap`)

- [ ] **Step 1: Add the v1 roadmap entry to the spec index**

Edit `docs/specs/README.md`. Find the existing "In progress" section (the block of entries between `## In progress` and `## Not started`). Add this entry to the end of that block, before the blank line that precedes `## Not started`:

```markdown
- [`2026-05-28-v1-completion-roadmap-design.md`](2026-05-28-v1-completion-roadmap-design.md) — v1 ship roadmap decomposing the post-S6 work into three sequential phases: Phase 1 single-instance enforcement (separate brainstorm-then-spec; closes the largest credible v1 data-loss path), Phase 2 README restructure + `CONTRIBUTING.md` extraction + doc/index sweep (bat/ripgrep style; one PR), Phase 3 `v0.1.0` tag (Windows-only) + `publish.yml workflow_dispatch` + post-publish reconciliation (macOS Apple Silicon defers to v0.1.1). Plan: [`../plans/2026-05-28-v1-completion-roadmap.md`](../plans/2026-05-28-v1-completion-roadmap.md). In progress.
```

- [ ] **Step 2: Verify the edit landed at the right anchor**

Run: `grep -n "v1 completion roadmap\|v1-completion-roadmap-design" docs/specs/README.md`
Expected: at least one hit on the line you just added; no hits inside the "Implemented" group (above) or "Not started" group (below).

- [ ] **Step 3: Add the v1 completion section to docs/roadmap.md**

Edit `docs/roadmap.md`. Find the last roadmap table row (S6 — Polish + distribution). Immediately after that row, before the blank line that precedes `## Why this cut`, append a new section:

```markdown

## v1 completion (post-S6)

Post-S6 ship work to reach `v0.1.0` on `releases/latest`. Sequenced via [`specs/2026-05-28-v1-completion-roadmap-design.md`](specs/2026-05-28-v1-completion-roadmap-design.md) and [`plans/2026-05-28-v1-completion-roadmap.md`](plans/2026-05-28-v1-completion-roadmap.md). macOS Apple Silicon defers to v0.1.1 per the roadmap spec § 6.2.

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | Single-instance enforcement (named mutex / `flock` + IPC focus signal). Closes the two-PRism-windows-overwrite-state.json data-loss path. Own brainstorm → spec → plan → PR cycle. | Pending |
| **Phase 2** | README restructure to bat/ripgrep public-tool shape + `CONTRIBUTING.md` extraction + doc/index sweep + hero screenshot. One PR. | Pending |
| **Phase 3** | `v0.1.0` tag (Windows-only binary) + `publish.yml workflow_dispatch` + binary verification + Release promotion + post-publish reconciliation PR. | Pending |
```

- [ ] **Step 4: Verify the roadmap edit**

Run: `grep -n "v1 completion (post-S6)" docs/roadmap.md`
Expected: one hit on the new section heading.

Run: `grep -n "Phase 1\|Phase 2\|Phase 3" docs/roadmap.md | tail -6`
Expected: three rows referring to Phase 1/2/3, each marked "Pending".

- [ ] **Step 5: Commit**

The heredoc blocks in this plan use POSIX-shell syntax and are intended for the harness's Bash tool, not PowerShell. A human running these manually in pwsh should substitute a here-string (`@'...'@`) or `-F .commit-msg.txt`.

```sh
git add docs/specs/README.md docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs(v1): index + roadmap entries for v1 completion roadmap

Adds the v1 completion roadmap to the spec index (In progress) and adds a
new "v1 completion (post-S6)" section to docs/roadmap.md with the three
phases marked Pending. Each phase will be promoted in its own PR as it
ships.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Open the PR via pr-autopilot**

Standing default per memory `feedback_use_pr_autopilot`. Invoke `pr-autopilot` against the current worktree branch (`docs/v1-completion-roadmap`). Let pr-autopilot drive the preflight self-review, PR open with template, and reviewer-bot loop.

Expected: PR opened against `main` containing two commits — the spec commit (already at HEAD~1) and the index/roadmap commit (HEAD). PR autopilot drives review iterations until CI is green.

- [ ] **Step 7: Wait for PR merge, then remove this worktree**

Do not start Task 2 until Task 1's PR is merged to `main`. Track via `gh pr view --json mergedAt` or equivalent. After merge, from the main checkout:

```sh
git -C D:/src/PRism fetch origin --quiet
git -C D:/src/PRism pull --ff-only
git -C D:/src/PRism worktree remove D:/src/PRism-v1-roadmap
```

---

### Task 2: Kick off Phase 1 brainstorm — single-instance enforcement

**Files:** N/A — this task creates a new worktree and invokes the brainstorming skill. The Phase 1 spec lands at `docs/specs/2026-05-XX-single-instance-enforcement-design.md` where `XX` is the brainstorm date.

- [ ] **Step 1: Create an isolated worktree for Phase 1**

```sh
git fetch origin --quiet
git worktree add D:/src/PRism-single-instance -b feat/single-instance-enforcement origin/main
```

Expected: worktree at `D:/src/PRism-single-instance` on a fresh branch off the latest `main` (which now contains the v1 roadmap spec from Task 1).

- [ ] **Step 2: Invoke superpowers:brainstorming with the Phase 1 seed prompt**

In a session targeting the new worktree, invoke `superpowers:brainstorming` with this prompt:

```
Brainstorm single-instance enforcement for PRism. Context lives at
docs/specs/2026-05-28-v1-completion-roadmap-design.md § 2 (specifically § 2.2
"Design questions the Phase 1 brainstorm will resolve"). The ADR seed sketch
is at docs/specs/2026-05-06-architectural-readiness-design.md § ADR-P0-4.

Open questions from § 2.2 (treat as starting list, not final list):
- IPC channel per OS (named pipe / Unix socket / localhost TCP)
- Focus API per OS (Win32 SetForegroundWindow / macOS osascript / url-reopen)
- Second-launch UX — must produce visible feedback (toast or modal);
  silent-focus and stderr-only are pre-rejected per § 2.2
- Mutex naming + <dataDir> scoping (so two <dataDir>s coexist)
- Startup ordering race between lockfile-take and IPC-listener mount
- Lockfile interaction (replace / augment / coexist)

Acceptance bar: docs/specs/2026-05-28-v1-completion-roadmap-design.md § 2.3.
Fallback trigger: § 6.1 — if the plan decomposes to >8 tasks across >3 PRs
or implementation passes 10 calendar days from brainstorm start without
merging, fire the fallback per § 6.1.

Output to docs/specs/2026-05-XX-single-instance-enforcement-design.md where
XX is today's date.
```

- [ ] **Step 3: Verify brainstorm output landed**

Expected: a new spec file at `docs/specs/<today>-single-instance-enforcement-design.md` exists, the user approved it, and `ce-doc-review` ran once on it per CLAUDE.md project rule.

- [ ] **Step 4: Invoke superpowers:writing-plans on the new spec**

In the same session, invoke `superpowers:writing-plans` with the path to the spec file produced in Step 2. The plan lands at `docs/plans/<today>-single-instance-enforcement.md`.

- [ ] **Step 5: Execute the Phase 1 plan**

Either via `superpowers:subagent-driven-development` or `superpowers:executing-plans` per user preference. Lands one or more implementation PRs that close the spec.

- [ ] **Step 6: Apply the fallback if § 6.1 trigger fires**

If, during Step 4 (writing-plans output review) or Step 5 (mid-implementation), the trigger fires (plan decomposes to >8 tasks across >3 PRs at the writing-plans output, OR implementation passes 10 calendar days without merging):

- Stop Phase 1 implementation.
- Open a PR that adds the README known-issue paragraph per § 6.1: *"Avoid launching PRism more than once on the same machine — concurrent instances will overwrite each other's draft state. Single-instance enforcement lands in v1.1."*
- Update `docs/roadmap.md` Phase 1 row from "Pending" to "Deferred to v1.1 — see [link to Phase 1 spec or this plan]".
- Carry forward the Phase 1 brainstorm output to v1.1.

Document the fallback decision in a sidecar `docs/specs/<phase1-spec>-deferrals.md`.

- [ ] **Step 7: Wait for Phase 1 PR(s) merge before Task 3**

Do not start Task 3 until all Phase 1 PR(s) merged to `main` (or the fallback PR from Step 6 merged).

---

### Task 3: Run writing-plans on Phase 2 (using the roadmap as the spec)

**Files:** N/A — this task creates a new worktree and invokes writing-plans. The Phase 2 plan lands at `docs/plans/2026-05-XX-readme-restructure-and-doc-sweep.md` where `XX` is the plan-writing date.

- [ ] **Step 1: Create an isolated worktree for Phase 2**

```sh
git fetch origin --quiet
git worktree add D:/src/PRism-readme-restructure -b feat/readme-restructure origin/main
```

Expected: worktree off the latest `main`, which now contains the v1 roadmap spec + Phase 1 implementation.

- [ ] **Step 2: Invoke superpowers:writing-plans on the roadmap spec § 3**

In a session targeting the new worktree, invoke `superpowers:writing-plans` with this prompt:

```
Write the Phase 2 implementation plan from the v1 completion roadmap.
Source: docs/specs/2026-05-28-v1-completion-roadmap-design.md § 3 (only § 3;
ignore § 2 and § 4 — they have their own cycles).

Phase 2 scope (from § 3 of the roadmap):
- § 3.1: Rewrite README.md to bat/ripgrep public-tool shape (per § 3.1 table)
- § 3.2: Extract dev-workflow content to a new CONTRIBUTING.md (verbatim
  absorption + one-paragraph intro; no expanded onboarding additions)
- § 3.3: Status-truth sweep across docs/specs/README.md, docs/roadmap.md,
  .ai/docs/operating-context.md, .ai/docs/repo-overview.md per § 3.3 table
- § 3.4: Hero screenshot — one hand-captured PNG at assets/screenshots/hero-inbox.png
  (no Playwright script, no npm registration)
- § 3.5 acceptance criteria
- Link-repointing for every cross-link into moved README sections

This is a single-PR plan. The reviewer load may be heavy enough to split
into 2a (text-only) + 2b (screenshot asset) at PR-prep time per § 3 opener —
include that as a documented branch point in the plan, not a pre-commitment.

Output to docs/plans/<today>-readme-restructure-and-doc-sweep.md.
```

- [ ] **Step 3: Verify plan output**

Expected: a new plan file at `docs/plans/<today>-readme-restructure-and-doc-sweep.md` exists. `ce-doc-review` ran once on it per CLAUDE.md project rule. User approved.

- [ ] **Step 4: Execute the Phase 2 plan**

Via `superpowers:subagent-driven-development` or `superpowers:executing-plans` per user preference. Lands one PR (or 2a + 2b if split per § 3 opener).

- [ ] **Step 5: Wait for Phase 2 PR(s) merge before Task 4**

Do not start Task 4 until Phase 2 PR(s) merged. Phase 3 depends on the README being truthful at tag time.

---

### Task 4: Phase 3 — `v0.1.0` dispatch + binary verification

**Files:** N/A — this task is maintainer-driven dispatch + verification on real Windows hardware. No source edits.

- [ ] **Step 1: Confirm pre-flight gates per roadmap § 4.1**

Manual verification:
- `main` is green on `ci.yml` at the commit you will tag.
- `softprops/action-gh-release@v3.0.0` (PR #81) verified against `publish.yml`'s current arg shape. Quick read of `.github/workflows/publish.yml` — confirm input shape matches v3.0.0 docs.
- `publish.yml`'s `GITHUB_TOKEN` permission (`contents: write`) confirmed against any branch-protection rule changes.

Note: `PRISM_INTEGRATION_PAT` is NOT a Phase 3 prerequisite. (Earlier draft listed it; that secret belongs to the contract-test workflow per PR #59, not `publish.yml`.)

- [ ] **Step 2: Dispatch `publish.yml` with `tag = v0.1.0` + `include_macos = false`**

```sh
gh workflow run publish.yml -f tag=v0.1.0 -f include_macos=false
```

Or via the GitHub UI: Actions → publish.yml → Run workflow → input `tag = v0.1.0`, `include_macos` left at the false default → Run.

Expected: workflow run succeeds; a draft GitHub Release at `v0.1.0` exists with ONLY the `win-x64` binary attached. The `osx-arm64` binary builds (the cross-compile path stays exercised) but the workflow's conditional `files:` list omits it from the upload when `include_macos` is false. v0.1.1 will dispatch with `include_macos = true` to add the macOS binary after hardware verification.

- [ ] **Step 3: Download the Windows binary on real hardware**

On a Windows machine (not the build runner). Draft Releases are visible only to authenticated users with `repo` scope, so verify auth first:

```sh
gh auth status
# If not logged in or token lacks repo scope:
#   gh auth login -s repo
```

Then download:

```sh
gh release download v0.1.0 --pattern "PRism-win-x64.exe"
```

Or download via the draft Release page in the browser (also requires authenticated login to the repo).

- [ ] **Step 4: Run the 13-step demo flow per roadmap § 4.3**

Verification checklist (all must pass; if any fails, do NOT promote the draft):
- Double-click `PRism-win-x64.exe`. Verify SmartScreen "Windows protected your PC" copy matches `FirstRunDisclosure`.
- Click "More info → Run anyway". Browser auto-launches on `http://localhost:5180` (or next free 5180–5199).
- Paste a PAT. Inbox loads.
- Complete the 13-step demo flow per `docs/spec/01-vision-and-acceptance.md` § "The PoC demo".
- **If Phase 1 shipped single-instance enforcement**: double-click the binary again. Confirm the second-launch focus + visible feedback (toast or modal per Phase 1's brainstorm output).
- **If Phase 1 fired the § 6.1 fallback**: confirm the README's known-issue paragraph is present in the published release notes / repo README.
- Open Settings → Connection. If "Copy logs path" button exists (per PR #69's `logsPath` GET shape), click it; otherwise locate the path via README's "Where's my data?" section.
- Confirm `<dataDir>/logs/prism-YYYY-MM-DD.log` exists with at least one `Identity changed` or comparable structured-log line.

- [ ] **Step 5: Promote the draft Release (only if Step 4 passed)**

```sh
gh release edit v0.1.0 --draft=false
```

Expected: `https://github.com/prpande/PRism/releases/latest` resolves to the v0.1.0 Release. The README's `releases/latest/download/PRism-win-x64.exe` link 200s.

- [ ] **Step 6: Apply reconciliation per roadmap § 4.5 (only if Step 4 failed)**

If verification surfaced an issue:
1. Delete the failed draft Release: `gh release delete v0.1.0 --yes --cleanup-tag`. (Note: `--cleanup-tag` is best-effort — `softprops/action-gh-release@v3` typically doesn't push the git tag until the draft is promoted, so the flag may be a no-op on the tag side. Either way, re-dispatch with the same tag works.)
2. Open a fix PR; merge it.
3. Re-dispatch per Step 2 with the same `tag = v0.1.0` (or bump the tag if multiple iterations are needed: `v0.1.0-rc.2`, etc.).
4. Re-run verification from Step 3.

**Iteration ceiling: 3 dispatches.** If verification hasn't passed by the 3rd dispatch, escalate — either the publish workflow has a structural issue (its own brainstorm) or v0.1.0 scope needs cutting.

---

### Task 5: Post-publish reconciliation PR

**Files:**
- Modify: `docs/roadmap.md` (flip Phase 3 row from "Pending" to "Shipped — tag v0.1.0")
- Modify: `docs/specs/README.md` (promote the v1 roadmap entry from "In progress" to "Implemented")

- [ ] **Step 1: Create a worktree for the reconciliation PR**

```sh
git fetch origin --quiet
git worktree add D:/src/PRism-v1-reconciliation -b docs/v0.1.0-reconciliation origin/main
```

- [ ] **Step 2: Flip the Phase 3 row in `docs/roadmap.md`**

Find the Phase 3 row in the "v1 completion (post-S6)" section. Change `Pending` to `Shipped — tag v0.1.0, [link to GitHub Release]`.

```diff
 | **Phase 3** | `v0.1.0` tag (Windows-only binary) + `publish.yml workflow_dispatch` + binary verification + Release promotion + post-publish reconciliation PR. | Pending |
+ | **Phase 3** | `v0.1.0` tag (Windows-only binary) + `publish.yml workflow_dispatch` + binary verification + Release promotion + post-publish reconciliation PR. | Shipped — [v0.1.0](https://github.com/prpande/PRism/releases/tag/v0.1.0) |
```

- [ ] **Step 3: Promote the v1 roadmap spec entry in `docs/specs/README.md`**

Find the entry added in Task 1 Step 1 under "In progress". Move it to the end of the "Implemented" group. Change the trailing `. In progress.` to `. Shipped — v0.1.0 [link].` Add a one-line summary if it helps the reader.

- [ ] **Step 4: Verify the edits**

Run: `grep -n "v1-completion-roadmap\|v1 completion" docs/specs/README.md docs/roadmap.md`
Expected: roadmap.md shows "Shipped" on Phase 3 row; specs/README.md entry now under "Implemented" group.

- [ ] **Step 5: Commit**

```sh
git add docs/roadmap.md docs/specs/README.md
git commit -m "$(cat <<'EOF'
docs(v1): v0.1.0 shipped — flip Phase 3 + promote v1 roadmap spec

Phase 3 dispatch verified on Windows; Release v0.1.0 promoted.
Roadmap spec moves to Implemented in the spec index.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Open the PR via pr-autopilot**

Per memory `feedback_use_pr_autopilot`. The PR is small and text-only; expect minimal review iteration.

- [ ] **Step 7: After merge — clean up the three task-created worktrees**

Run from the main checkout (`D:/src/PRism`), not from any of the worktrees being removed:

```sh
git -C D:/src/PRism worktree remove D:/src/PRism-single-instance
git -C D:/src/PRism worktree remove D:/src/PRism-readme-restructure
git -C D:/src/PRism worktree remove D:/src/PRism-v1-reconciliation
```

(The initial `D:/src/PRism-v1-roadmap` worktree was already removed after Task 1's PR merge per the Task 1 Step 7 follow-up. If it's still around, `git -C D:/src/PRism worktree remove D:/src/PRism-v1-roadmap` cleans it up.)

v1 ship complete. Out-of-band follow-up: schedule v0.1.1 (macOS Apple Silicon) when hardware verification path exists.

---

## Out of scope for this plan

The following are explicitly NOT addressed here. Each has its own cycle:

- **Phase 1 implementation details.** Resolved by the Task 2 brainstorm + writing-plans cycle. Includes IPC mechanism choice, focus API per OS, lockfile interaction, second-launch UX picker (constrained to "visible feedback" per § 2.2).
- **Phase 2 file-level task decomposition.** Resolved by the Task 3 writing-plans cycle. Includes exact README structure rewrites, CONTRIBUTING.md content, link-repointing grep targets, hero screenshot capture approach.
- **v0.1.1 macOS Apple Silicon ship.** Tracked separately when hardware acquisition path exists. Out of v1 scope per roadmap § 6.2.
- **All deferrals enumerated in roadmap § 1.3.** Each carries a "why not now" stamp; revisit triggers are documented in the deferrals sidecars.
