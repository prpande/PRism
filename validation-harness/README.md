# PRism Validation Harness

This directory holds the prompt set used to generate **realistic PR activity** across a small set of Mindbody repositories so that PRism (a PR review tool, currently pre-implementation) can be exercised end-to-end against real GitHub fixtures.

The prompts are **for Claude Code**. They are designed to be sent to a teammate via Slack/email and pasted into Claude Code with no prior setup — no clones, no auth, no install. The teammate runs one prompt, walks away, and a small dummy PR appears against the target repo on a sandbox branch.

> **Nothing produced by these prompts ever targets `main` or `master`.** Every PR opens against the long-lived `prism-validation` branch on the target repo. Branch protection on `main`/`master` plus the `--base prism-validation` flag means these PRs are physically unable to merge into production code.

## What's in here

```
validation-harness/
├── README.md                      # this file
└── prompts/
    ├── open-validation-pr.md      # Family 1 — open a fresh validation PR
    ├── iterate-pr.md              # Family 2 — push a follow-up commit and reply to threads
    └── act-as-second-reviewer.md  # Family 3 — post nitpick comments from a second voice
```

Three prompts, parameterized by target repo. No per-repo duplication. Adding a new validation target is one config row, no prompt edits.

## Validation targets

| Slug | Repo | Stack |
|---|---|---|
| `chat-bff` | mindbody/Mindbody.BizApp.Chat.Bff | C# / .NET 10 |
| `chat-agent-appointments` | mindbody/Mindbody.BizApp.Chat.Agent.Appointments | C# / .NET 10 |
| `api-codex` | mindbody/Api.Codex | Markdown / skills |
| `bizapp-bff` | mindbody/Mindbody.BizApp.Bff | C# / .NET 10 |
| `mobile-business-gateway` | mindbody/Mindbody.Mobile.BusinessGateway | C# / .NET 10 |

The `prism-validation` sandbox branch already exists on each of these repos.

## Who runs what

| Prompt | Run by | When |
|---|---|---|
| `open-validation-pr.md` | A human teammate | Once per validation cycle, per repo. ~5 min. |
| `iterate-pr.md` | Pratyush via Claude Cloud (or a teammate as fallback) | After a validation PR has accumulated review activity (bots + reviewers). |
| `act-as-second-reviewer.md` | Pratyush via Claude Cloud | Optionally, when a PR needs more comment-author diversity than the auto-reviewer alone provides. |

The auto-reviewer GitHub Action (`claude-code-review.yml`) on every target repo provides "free" review activity on every validation PR — no human needs to leave the bot's comments.

## How to distribute a prompt to a teammate

The prompts live in this repo as templates. To send one to a teammate, paste the full file contents into Slack/DM along with one extra line indicating the target repo. Either of these formats works:

**Format A — repo line first**

```
Target repo: mindbody/Mindbody.BizApp.Chat.Bff

<paste contents of open-validation-pr.md here>
```

**Format B — repo line at the end**

```
<paste contents of open-validation-pr.md here>

Target repo: mindbody/Mindbody.BizApp.Chat.Bff
```

The teammate then copy-pastes the entire blob into a Claude Code session and lets it run. The prompt instructs Claude Code to extract the target from the message; if it can't find one, Claude will ask once.

You can also use a slug (e.g. `Target repo: chat-bff`) — the prompt knows the slug-to-URL mapping for the five canonical targets.

## What the teammate sees

For `open-validation-pr.md`:
- Claude Code prompts for `gh auth login` if not already authed (browser flow).
- Sets git identity from their GitHub user automatically.
- Creates `~/prism-validation/<slug>/` and clones the `prism-validation` branch only (shallow, single-branch — fast).
- Picks one of 5 baked-in plant-able issues based on the current second-of-minute and applies it to a low-traffic file.
- Commits, pushes a unique timestamped feature branch, opens the PR against `prism-validation`, applies the `prism-validation` label.
- Prints the PR URL.

Total wall time: ~2 minutes after auth.

## Re-runnable / idempotent

All three prompts can be run repeatedly. Each `open-validation-pr` run produces a **new** PR with a fresh second-grained timestamp branch and (most likely) a different recipe. `iterate-pr` is a no-op when no new comments need addressing. `act-as-second-reviewer` skips already-posted nitpicks.

## Adding a new validation target repo

1. Pratyush runs the same one-time `gh api` call that created the initial five sandbox branches:
   ```bash
   export MSYS_NO_PATHCONV=1   # only needed in Git Bash on Windows
   default=$(gh api repos/<owner>/<repo> --jq '.default_branch')
   sha=$(gh api repos/<owner>/<repo>/git/refs/heads/$default --jq '.object.sha')
   gh api -X POST repos/<owner>/<repo>/git/refs -f ref="refs/heads/prism-validation" -f sha="$sha"
   ```
2. Add a row to the **Validation targets** table above (slug + URL + stack).
3. (If new stack besides C#/.NET 10 or markdown) — add a recipe catalog entry to each prompt's "Recipe catalogs" section.
4. Distribute the same prompt to teammates with the new `Target repo: <owner>/<repo>` line. No other changes.

## Cleaning up

Validation PRs accumulate. Close them in bulk with one command per repo:

```bash
gh pr list --repo <owner>/<repo> --label prism-validation --state open --json number --jq '.[].number' \
  | xargs -I {} gh pr close --repo <owner>/<repo> --delete-branch {}
```

The `prism-validation` long-lived branch itself stays put.

## Cloud-env identity caveat (until Option B is set up)

Pratyush currently runs `iterate-pr.md` and `act-as-second-reviewer.md` via Claude Cloud under his own GitHub identity (`prpande`). Comments and commits from those prompts are tagged with `[from cloud-env]` so they're visually distinguishable from his manual activity. When a dedicated `prism-validation-bot` account is provisioned, those tags can be removed in a one-line `sed` against the prompt files.

## Source design doc

Full design rationale, recipe catalogs, and edge-case handling: [`docs/superpowers/specs/2026-05-06-prism-validation-prompt-set-design.md`](../docs/superpowers/specs/2026-05-06-prism-validation-prompt-set-design.md).
