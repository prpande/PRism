# PRism

**A local-first pull-request review tool that runs on your own machine.**

PRism reads your GitHub pull requests and lets you compose an entire review locally — line comments, replies, a verdict, and a summary — then finalizes it as a single GitHub *pending review*. Nothing is visible to anyone until you click **Submit**, at which point the whole review lands at once.

- **Local-first** — runs entirely on your computer; there's no PRism server. The app talks directly to GitHub's API.
- **Private until submit** — your drafts and view state stay on your machine until you choose to submit.
- **Single-user by design** — no server, no team sync, no shared state. A tool for *your* review pass, not a replacement for GitHub as your team's source of truth.

---

## Why PRism

A careful review falls apart when the author force-pushes mid-pass — the diff shifts, half-written comments point at moved code, and you're juggling tabs. PRism is built to keep a session calm:

- **Atomic submit** — drafts, replies, verdict, and summary stage in an invisible GitHub pending review; you finalize when *you* decide the review is done, not comment-by-comment.
- **Banner, not mutation** — a new commit or comment shows a dismissible banner; the diff under your cursor never changes until you choose to reload. You never review a moving target.
- **Your text is sacred** — drafts survive restarts, PR reloads, and token swaps. When a commit moves an anchored line, PRism re-anchors what it can and clearly flags what it couldn't — it never silently drops what you wrote.
- **Truthful diffs** — whitespace shown as-is, nothing filtered or hidden.

---

## Features

**Inbox** — every PR that involves you, grouped by repository, in sections: **Review requested**, **Awaiting author**, **Authored by me**, **Mentioned**, and **CI failing on my PRs**. Rows show author, age, comment count, and unread badges for new commits and comments. A background poll surfaces changes as a banner you apply on your terms. Paste any PR URL to jump to a PR that isn't in your inbox.

**PR review**

- **File tree** — smart-compacted directory paths, per-file *Viewed* checkboxes, live per-directory rollups, and `j`/`k` navigation.
- **Diff viewer** — side-by-side and unified modes, syntax highlighting, word-level intra-line highlighting, and on-demand whole-file context expansion.
- **Iteration tabs** — group the PR's commits into review rounds, so you can focus on just what changed this round, or compare any two rounds side by side.
- **Click-to-comment** — line-anchored drafting with Markdown live-preview, auto-save on keystroke, and replies to existing threads.
- **Overview tab** — the PR description, stats, and PR-level conversation, with rich Markdown rendering (code blocks, Mermaid diagrams).

**Submitting a review** — pick a verdict (**Approve**, **Request changes**, or **Comment**), add an optional summary, and submit. Everything stages as one GitHub pending review and reveals at once. The flow is resumable: a network hiccup won't duplicate the threads or replies in your review.

**Theming and desktop** — light and dark themes. Run PRism as a standalone desktop app with its own window, or as a tab in your default browser — both share the same data folder, so your token and drafts carry across.

**AI augmentation (in development)** — capability-gated seams for Claude-powered review summaries, file-focus hints, and review assistance are already in place, under active development on the V2 branch for a future release. Not in the shipping build yet.

---

## Install and first run

- Download the latest build from the **[Releases page](https://github.com/prpande/PRism/releases)** — a Windows installer or portable executable, and a macOS (Apple Silicon) `.dmg`.
- Builds are **unsigned pre-releases** (code-signing requires a paid developer account), so your OS shows a one-time trust prompt on first launch. This is expected and cleared by the steps below — download only from the official Releases page.
- A standalone browser-tab build is planned; for now you can run that mode from source — see [Development](#development).

### Windows

- **Installer** (`PRism Setup …exe`) — unpacks once at install time (no admin rights needed), then launches like any installed app.
- **Portable** (`PRism …exe`) — runs without installing, but re-extracts to your temp folder on **every** launch, so cold-start is slower (especially the first time on a new machine).
- SmartScreen shows **"Windows protected your PC"** — click **More info → Run anyway**. First launch can be slow while Windows Defender scans the extracted files (a one-time cost).
- PRism opens to the Setup screen, served on a local port in the `5180–5199` range.

### macOS

- Open the `.dmg` and drag PRism into Applications.
- Gatekeeper blocks the unnotarized app: right-click (or Control-click) PRism → **Open**, then **Open** again. On recent macOS you may instead approve it under **System Settings → Privacy & Security → Open Anyway** — [`TESTING.md`](TESTING.md) has the exact per-version steps.
- On the first keychain read, choose **Always Allow** so macOS stops prompting on every launch.

### Connect your GitHub account

PRism authenticates with a GitHub Personal Access Token you paste into the Setup screen on first launch.

- **Classic PAT (recommended)** — reads GitHub Actions check-runs and commit statuses across all your organizations, which powers the inbox's *CI failing* section.
  - Generate one at <https://github.com/settings/tokens/new>
  - Scopes: **`repo`** and **`read:org`**
  - ⚠️ `repo` grants read **and write** to all repositories you can reach. PRism never pushes code, but it does post your review (comments and approvals) on submit. Classic PATs offer no narrower option — if your organization restricts broad tokens, use the fine-grained option below.
- **Fine-grained PAT** — also works, but it's scoped per-organization and can't read Actions checks, so the CI section goes blind to Actions pipelines. Grant **Pull requests: Read and write**, **Contents: Read**, and **Commit statuses: Read**.
- **GitHub Enterprise Server?** Set your GHES host (e.g. `https://github.acmecorp.com`) on the Setup screen before pasting your token.

---

## Using PRism

- **Find a PR** — open the app to your inbox, or paste a PR URL into the box at the top to jump directly to one.
- **Review** — walk the file tree, mark files *Viewed* as you go, and click any line to leave a comment. Use the iteration tabs to focus on a single round of changes.
- **Submit** — choose a verdict, write a summary if you like, and click Submit — your whole review posts at once.
- **Stay current** — when the banner says the PR changed, click Reload. PRism reconciles your in-progress drafts against the new code and flags any it couldn't confidently re-anchor.

**Replacing your token** — Settings → **Replace token** validates a new PAT before swapping it in. If the new token is a different GitHub login, PRism keeps all your draft text, clears the previous account's identifiers, and on your next submit to an affected PR offers to resume or discard any pending review the old account left behind.

**Where your data lives** — drafts and view state live under your OS application-data folder (shared by the desktop app and browser-tab mode). Your token is kept in an OS-protected store, never in plaintext:

- **Windows** — DPAPI-encrypted `PRism.tokens.cache` in your data folder.
- **macOS** — the system Keychain.
- **Linux** (from source) — the libsecret keyring.
- See [`TESTING.md`](TESTING.md) for the exact per-platform paths.

---

## Troubleshooting

- **A token expired** — PRism detects the rejection on any GitHub call and sends you to Setup with a banner to paste a fresh token. Your drafts and view state are preserved.
- **Some PRs are missing from my inbox** — a fine-grained PAT only reports PRs in the repositories and organizations it's scoped to. Paste the PR's URL to open it directly, or switch to a classic PAT for full coverage.
- **Recovering a draft** — identity-change events are recorded in the structured logs under `<dataDir>/logs/` (scrubbed of your token and login — still review them before sharing anywhere). Before a destructive action (Replace token, Discard), copy any draft text out of the composer first.

---

## Development

PRism is an ASP.NET Core backend (`PRism.Web` and supporting `PRism.*` projects) serving a React + Vite + TypeScript frontend, with an optional Electron desktop shell under [`desktop/`](desktop/).

Run it locally with two terminals:

```
# terminal 1 — backend with hot reload (pinned to 5180 in dev)
dotnet watch run --project PRism.Web --urls http://localhost:5180

# terminal 2 — frontend dev server (Vite proxies /api to localhost:5180)
cd frontend && npm install && npm run dev
```

Run the test suites:

```
dotnet test --settings .runsettings
cd frontend && npm test && npx playwright test
```

All production code is written test-first. Contributor guidance — the full development process, pre-push checklist, architectural invariants, and desktop-shell build steps — lives under [`.ai/docs/`](.ai/docs/) (loaded by [`CLAUDE.md`](CLAUDE.md) and [`.cursor/rules/`](.cursor/rules/)). The product specification and design history live under [`docs/`](docs/README.md).

---

## Status

- Began as a single-user proof of concept; now shipping a series of unsigned pre-release builds to early testers.
- The core review experience is feature-complete; AI augmentation is under active development in parallel (on the V2 branch) for a future release.
- The [Releases page](https://github.com/prpande/PRism/releases) is the source of truth for what's downloadable.
