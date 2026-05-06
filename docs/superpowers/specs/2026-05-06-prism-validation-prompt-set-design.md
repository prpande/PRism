# PRism Validation Prompt Set — Design

**Status:** Approved (incremental approval through brainstorm Q1–Q5 + Blocks 1–3 + simplification pass).
**Date:** 2026-05-06
**Authors:** Pratyush Pande (driver), Claude Code (drafter).

## Goal

A self-contained, copy-paste-and-go prompt set that lets teammates (and Pratyush, via Claude Cloud) generate a steady stream of realistic PR activity across the 5 validation target repos to validate PRism end-to-end — without anyone setting anything up beforehand, without anyone running multiple commands, and without ever risking a merge to `main`.

The prompts produce **fixtures**. PRism (driven separately) is the **consumer** of those fixtures. The prompts do not test PRism themselves.

## What the prompts must exercise (in PRism, when consumed)

- PR list / inbox refresh
- Diff rendering with multiple comment authors visible
- Pending-review submit pipeline (drafts, replies, verdict, summary all atomic)
- Polling banner / iteration loop when fresh activity arrives mid-review
- Three verdict types — but cloud-env always uses `Comment` to stay safe; `Approve` and `RequestChanges` only ever come from a human

## Validation targets

| # | Slug | Repo | Stack |
|---|---|---|---|
| 1 | `chat-bff` | mindbody/Mindbody.BizApp.Chat.Bff | C# / .NET 10 |
| 2 | `chat-agent-appointments` | mindbody/Mindbody.BizApp.Chat.Agent.Appointments | C# / .NET 10 |
| 3 | `api-codex` | mindbody/Api.Codex | Markdown / skills |
| 4 | `bizapp-bff` | mindbody/Mindbody.BizApp.Bff | C# / .NET 10 |
| 5 | `mobile-business-gateway` | mindbody/Mindbody.Mobile.BusinessGateway | C# / .NET 10 |

Default branches differ across these (one is `master`, four are `main`), but the prompts never touch the default branch — they key off `prism-validation`, a long-lived sandbox branch pre-created on each repo. Adding a 6th repo is a one-time `gh api` call to create `prism-validation` plus a row in the README — no prompt edits.

## Architecture

Three prompt families, one file each, parameterized at distribution time by target repo:

```
validation-harness/
├── README.md                      # distribution + usage + adding new repos
└── prompts/
    ├── open-validation-pr.md      # Family 1 — for human teammates
    ├── iterate-pr.md              # Family 2 — for Claude Cloud (or teammates)
    └── act-as-second-reviewer.md  # Family 3 — for Claude Cloud only
```

### Family 1: `open-validation-pr.md`

For human teammates. ~5 minutes, copy-paste, walk away with a PR URL.

Steps:
1. Bootstrap (auth, identity, workspace, MSYS path-conversion fix).
2. Single-branch shallow clone of `prism-validation` only.
3. Generate fresh feature branch `validation/<slug>-<YYYYMMDD-HHmmss>` (disjoint from the `prism-validation` base branch — see "Branch namespace" below).
4. Detect repo language (probe for `*.csproj`/`*.sln` → csharp; else markdown fallback).
5. Pick a recipe via `$(date +%S) % 5`.
6. Apply recipe — additive only, never breaks compilation, never modifies CI/Docker/csproj.
7. Commit (`validation: <recipe-name>`), push, `gh pr create --base prism-validation`.
8. Apply `prism-validation` label (create on first run if missing).
9. Print PR URL.

### Family 2: `iterate-pr.md`

For Claude Cloud (and teammates as fallback). Drives the iteration / banner-on-remote-change flow in PRism.

Steps:
1. Bootstrap.
2. Discover target PR — `gh pr list --label prism-validation --state open --json` for the repo. If multiple, pick most recently updated.
3. Read all review activity.
4. Identify actionable, unanswered comments (skip threads where current user has already replied via `in_reply_to_id` chain).
5. Apply a single small commit addressing the feedback. Hard limits: <20 lines diff, no new flaws, no reverts.
6. Commit (`validation: address review feedback [cloud-env]`), push.
7. Reply to each addressed thread: `Addressed in <sha>. [cloud-env]`.
8. Print summary.

Idempotent — re-running with no new comments is a clean no-op.

### Family 3: `act-as-second-reviewer.md`

For Claude Cloud only. Adds non-blocking review activity from a different identity (in spirit; same user pre-Option-B, marked) so PRism sees comment-author diversity per PR.

Steps:
1. Bootstrap.
2. Discover target PR (same logic as Family 2).
3. Read the diff.
4. Generate 2–3 plausible mild nitpicks. Constraints: never `Approve`, never `RequestChanges`, never duplicate an existing comment body, prefix every body with `[cloud-env] `.
5. Submit as a single review (`event: COMMENT` + inline `comments[]`) via one `gh api` call.
6. Print summary.

## Recipe catalogs

### `csharp` recipes (5)

All additive; none break compilation. The `claude-code-review.yml` reviewer is content-aware and flags any of them.

1. **Stale TODO** — append `// TODO: revisit before next release` to a doc comment.
2. **Vague log message** — add a new `_logger.LogDebug("processing");` line (with a deliberately vague message) near the top of an existing method body. Purely additive — never modify an existing log line.
3. **Naming drift in comment** — comment refers to a method by a slightly-wrong name.
4. **Redundant XML doc** — `/// <summary>Does what the name says.</summary>` above a public method.
5. **Hardcoded literal** — string constant for a URL/timeout that obviously belongs in `appsettings.json`.

### `markdown` recipes (5)

For `Api.Codex` and any future markdown-only repo.

1. **Frontmatter typo** — `descrption:` instead of `description:`.
2. **Broken internal link** — link target file/anchor doesn't exist.
3. **Skipped heading level** — `# H1` directly to `### H3`.
4. **Vague TBD placeholder** — `## Examples\nTBD`.
5. **Unlabeled code fence** — bare ```` ``` ```` without a language hint.

## Idempotency

| Mechanism | Rule |
|---|---|
| **Feature branch** | `validation/<slug>-<YYYYMMDD-HHmmss>`. Second-grain. Suffix `-2`, `-3` on collision. Note: feature branches live under the `validation/` namespace, **not** under `prism-validation/`, to avoid Git's loose-ref file/directory conflict with the base branch. |
| **Workspace dir** | `~/prism-validation/<slug>/` reused. Existing → `git fetch` + reset to `origin/prism-validation`. Missing → fresh shallow clone. |
| **Long-lived sandbox branch** | Pre-created remotely. Prompt only resets local copy; never recreates remote (a missing remote branch is an error condition, not a self-heal trigger). |
| **Recipe rotation** | `seconds % 5` — re-running gives variety, 6 runs cover all 5 plus one repeat. |
| **Iteration dedup** | Skip comment threads where current user has already replied. |
| **Reviewer dedup** | Skip nitpick lines whose body matches an existing review comment. |
| **Cloud-env marker** | `[cloud-env]` literal in commit messages and reply bodies; `[cloud-env] ` prefix on inline review comment bodies. Single-line `sed` removal when Option B (separate identity) lands. |

## Edge cases & error paths

| Scenario | Bootstrap response |
|---|---|
| `gh` not installed | OS-detect, print install command (`winget install GitHub.cli` / `brew install gh` / `apt install gh`), exit. |
| `gh` not authed | `gh auth login --web --git-protocol https`, retry. |
| Token missing `repo` scope | `gh auth refresh -h github.com -s repo,workflow,read:org`. |
| Git Bash on Windows path mangling | `export MSYS_NO_PATHCONV=1` at the top of every prompt's bootstrap. Real wrinkle hit during preflight. |
| SAML/SSO not authorized | Print `https://github.com/orgs/mindbody/sso` link with instructions, exit. |
| `git` not installed | Print install link, exit. |
| Workspace dir corrupt | Wipe and re-clone shallow. |
| `prism-validation` branch missing on remote | Exit with "ask Pratyush to recreate" — never auto-create from a teammate's run. |
| No open validation PR (Families 2/3) | Exit cleanly with "run `open-validation-pr` first". |
| Multiple open validation PRs (Families 2/3) | Pick most recently updated; log all candidates. |
| `git push` fails | Retry once, then fail with clear message. |

## Explicit non-goals

- No teardown prompt — bulk-close validation PRs via a one-off `gh` command on Pratyush's machine.
- No cross-repo orchestration — each prompt run targets exactly one repo.
- No metrics or telemetry on which teammate ran what.
- Family 3 never `Approve` or `RequestChanges` — only `Comment`.
- Family 2 never reverts a previous validation commit — only adds.
- The prompts don't validate PRism functionality directly — they generate fixtures.

## Deferred / future

- **Option B (separate identity)** — when Pratyush sets up a `prism-validation-bot` GitHub user with its own PAT, the cloud-env prompts get a one-line edit removing `[cloud-env]` markers and switching auth.
- **Refresh `prism-validation` from default** — if the sandbox branch drifts so far from `main`/`master` that fixtures stop being interesting, refresh via `gh api`. Out of scope for the prompts themselves.
- **Adding more repos** — append a row to the README mapping table and run the same one-time `gh api` call that created the initial five sandbox branches.

## Source-of-truth references

- This design doc: `docs/superpowers/specs/2026-05-06-prism-validation-prompt-set-design.md`
- Generated artifacts: `validation-harness/`
- Trigger that surfaced the MSYS path-conversion gotcha: branch-creation preflight on 2026-05-06.
- Confirmed at preflight: BizApp.Bff is .NET 10.0; Mobile.BusinessGateway defaults to `master`; the other four default to `main`. None of those facts matter for the prompts (they target `prism-validation` only) but are recorded here in case we ever need to refresh the sandbox.
