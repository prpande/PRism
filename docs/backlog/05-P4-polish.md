# P4 — Polish & Quality-of-Life

The long tail. Individually low-impact, collectively define the difference between "a tool I use because I have to" and "a tool I love." High volume — pick items based on user-reported friction and your own daily-use feedback. Items are loosely value-grouped but order within groups is mostly indicative.

Priority sub-ranks here are less prescriptive than in higher tiers. Treat this as a menu rather than a queue.

---

## Group A — Submit & comment workflow

### P4-A1: Resolve / unresolve conversations
- **Effort**: M
- **Dependencies**: shifts the architecture from atomic-submit-only to "atomic submit + a few targeted live writes"
- **⚠️ Architectural significance.** This is the **first feature that crosses the reviewer-atomic-submit invariant** described in `spec/01-vision-and-acceptance.md` (principle 4). Despite living in P4, it is *not* a "low individual impact" item — the invariant break itself, regardless of feature scope, changes how reviewers reason about "until I click submit, nothing is sent." When this is scheduled, **consider promoting it to P2 or P3** so the architectural decision lands with appropriate review.
- **Description.** Inside a thread on an existing comment, a "Resolve" button. Resolving posts directly to GitHub (live write, not part of the next review submission). User can also un-resolve.
- **Implementation notes.** Architecturally: introduce `ILiveAction` interface separate from `IReviewService.SubmitReviewAsync`. Resolve / unresolve are the only `ILiveAction` calls in v2. Document the change in `spec/01-vision-and-acceptance.md` principle 4 explicitly: "atomic for review submission, immediate for thread-state changes."
- **Acceptance.** Resolving a thread updates GitHub and the local view immediately.

### P4-A2: Edit own previously-submitted comments
- **Effort**: M
- **Dependencies**: P4-A1 (similar live-write pattern)
- **Description.** Pencil icon on user's own existing comments. Click → opens edit composer. Save → live PATCH to GitHub.

### P4-A3: Delete own previously-submitted comments
- **Effort**: S
- **Dependencies**: P4-A2
- **Description.** Trash icon on user's own existing comments with a confirmation prompt.

### P4-A4: Code suggestion blocks
- **Effort**: M
- **Description.** GitHub's ` ```suggestion ` markdown blocks. Composer adds a "Suggest a code change" button that opens a special composer with an editable copy of the original code. Renders in existing comments with author-side accept/reject UI.
- **Implementation notes.** Significant — requires extending the comment composer with a structured-suggestion mode + rendering UI for the author-side experience. Multiple sub-tasks.

### P4-A5: Multi-line comment ranges
- **Effort**: M
- **Description.** Drag across multiple lines in the diff to anchor a comment to a range.
- **Implementation notes.** Frontend-heavy. `react-diff-view` line selection + range tracking. GitHub's API natively supports `start_line` for multi-line comments.

### P4-A6: Mention autocomplete (`@user` popup)
- **Effort**: M
- **Description.** Typing `@` in a composer surfaces a dropdown of repo collaborators. Tab/Enter selects.
- **Implementation notes.** Fetch collaborators on PR open; cache. Frontend autocomplete with fuzzy match.

### P4-A7: Saved review templates
- **Effort**: S
- **Description.** Snippets like "lgtm", "nit:", "blocking:" accessible via slash-command in the composer or a settings-managed list.

### P4-A8: Comment-on-rendered-markdown-prose
- **Effort**: L
- **Description.** Anchor comments to the rendered output of a markdown file, not the raw line. Requires DOM-anchor primitives + serialization.

### P4-A9: Inline patch application
- **Effort**: L
- **Description.** "Apply this suggestion to my local clone" without leaving the tool. Requires deep integration with local git workflows.

---

## Group B — Diff viewer enhancements

### P4-B1: Whitespace-recompute toggle (full ignore-whitespace)
- **Effort**: M
- **Description.** A toggle to fully recompute the diff with whitespace-ignore semantics, producing structurally different hunks. Different from the simpler "hide whitespace-only lines" approach the PoC's AI categorization replaces.
- **Implementation notes.** Fetch full file contents (already done for `.md` rendering); run jsdiff with whitespace-ignore option; render the new hunks.

### P4-B2: Diff-aware rendered markdown
- **Effort**: L
- **Description.** Render markdown but highlight inserted/removed prose *in the rendered output*. Hard — requires custom renderer with diff metadata pipeline.

### P4-B3: Other rendered file types
- **Effort**: M each (multiple sub-tasks)
- **Description.** Add language-dispatcher entries for:
  - `.html` — rendered preview
  - `.svg` — rendered preview
  - `.json` — pretty-printed
  - `.csv` — table view
  - `.ipynb` — Jupyter notebook with cells/outputs
  - `.mdx` — MDX-with-components rendering
- Pick by user demand. SVG and JSON are likely first wins.

### P4-B4: Image diff
- **Effort**: M
- **Description.** When a PR changes an image, show old / new side-by-side or overlaid with diff visualization.

### P4-B5: Word-level diff in rendered markdown
- **Effort**: M
- **Description.** Currently word-level diff only on raw text/code. Extend to rendered markdown comparison.

### P4-B6: KaTeX/MathJax for math blocks
- **Effort**: S
- **Description.** Same dispatcher pattern as Mermaid. Add `math` language → KaTeX renderer.

### P4-B7: Click-to-zoom for Mermaid diagrams
- **Effort**: S
- **Description.** Click a diagram → modal with pan/zoom. Useful for large flowcharts.

### P4-B8: Per-file expand-context-to-full-file
- **Effort**: S
- **Description.** Show full file content with the diff highlighted, on demand. PoC explicitly excluded; revisit if reviewers complain.

### P4-B9: Search within an open PR
- **Effort**: M
- **Description.** Ctrl+F over PR content (across all files in the diff). PoC defers to browser Ctrl+F.

### P4-B10: Performance work for very large PRs
- **Effort**: L
- **Description.** Virtualization for file trees with 500+ files; lazy hunk loading; streamed diff fetching.

---

## Group C — Real-time / sync

### P4-C1: Configurable per-PR cadence
- **Effort**: S
- **Description.** Different polling rates for different PRs (e.g., faster for the one being actively reviewed; slower for awaiting-author).

### P4-C2: Auto-reanchor with line-content-matching (the option-c we explicitly rejected)
- **Effort**: M
- **Description.** Risky; only revisit if user feedback shows manual reconciliation is too tedious. Implement with strict safety guards (only auto-reanchor when line content is byte-identical at exactly one location in the new file).

### P4-C3: Webhook-based push (real-time)
- **Effort**: L
- **Description.** Required for hosted multi-tenant deployment; outside PoC scope. If ever pursuing hosted, design here.

---

## Group D — Inbox enhancements

### P4-D1: Configured-repos dashboard (team-lead queue)
- **Effort**: M
- **Description.** A second inbox view: "All open PRs across these N repos." For tech leads / EMs.

### P4-D2: Closed/merged PR history
- **Effort**: M
- **Description.** Toggle to show closed/merged PRs in the inbox, retrospective review.

### P4-D3: Saved filters / custom inbox sections
- **Effort**: M
- **Description.** User-defined sections beyond the fixed five. e.g., "My team's PRs", "Frontend PRs."

### P4-D4: Stale PRs section
- **Effort**: S
- **Description.** PRs with no activity in N days.

### P4-D5: Drafts section
- **Effort**: S
- **Description.** PRs marked as draft on GitHub.

### P4-D6: Inbox sorting options
- **Effort**: S
- **Description.** Sort by author, age, size (additions+deletions), last activity.

### P4-D7: Search across inbox
- **Effort**: M
- **Description.** Text search over PR titles, authors, repos.

### P4-D8: Cross-account inbox unification
- **Effort**: M
- **Dependencies**: P4-G1 (multi-account support)
- **Description.** Combine multiple GitHub identities into one inbox.

---

## Group E — Iteration depth (CodeFlow-style)

### P4-E1: Comment-per-iteration anchoring
- **Effort**: M
- **Description.** Each draft comment remembers which iteration it was filed in. Surfaces in iteration-specific views.

### P4-E2: "Addressed in iteration N" status
- **Effort**: L
- **Dependencies**: P4-E1
- **Description.** Per-comment state machine across iterations. A comment filed in iteration 1 can be marked "addressed in iteration 3."

### P4-E3: "What's new since I last reviewed" auto-filter
- **Effort**: M
- **Description.** When reopening a PR, jump straight to the iteration delta the user hasn't seen.

### P4-E4: Author-marked iteration boundaries
- **Effort**: M
- **Description.** Author can manually group commits into a logical "review round" via a UI action. Affects iteration tab boundaries.

### P4-E5: Per-iteration review submissions
- **Effort**: L
- **Description.** Submit one review per iteration instead of cumulative. Significant write-path redesign.

---

## Group F — UI / UX polish

### P4-F1: Settings UI
- **Effort**: M
- **Description.** Form-based config editing instead of file-editing. Includes validation, save/cancel, and avoids conflicts with `FileSystemWatcher` hot-reload.

### P4-F2: Per-repo config overrides
- **Effort**: M
- **Description.** Config sections like `repos: { "owner/repo": { polling: ... } }` to override defaults per-repo.

### P4-F3: Vim-mode keyboard shortcuts (full chord set)
- **Effort**: M
- **Description.** Beyond the PoC's seven essential shortcuts. Modal navigation, registers, etc.

### P4-F4: Custom themes
- **Effort**: S
- **Description.** Beyond light/dark/system. User-supplied CSS variable overrides.

### P4-F5: Notifications
- **Effort**: M
- **Description.** Browser push, system tray, or email digests on inbox updates. Per-channel opt-in.

### P4-F6: Multi-PR tabs
- **Effort**: M
- **Description.** Multiple PRs open simultaneously inside the tool. Currently one PR at a time, browser back to navigate.

### P4-F7: Activity feed
- **Effort**: M
- **Description.** Recent actions across all PRs the user has touched.

### P4-F8: Mobile / tablet UI
- **Effort**: L
- **Description.** Responsive layout for non-desktop. Lower priority — code review is fundamentally a desktop activity.

### P4-F9: Multi-tab conflict notification
- **Effort**: S
- **Description.** When two browser tabs save conflicting drafts (same PR, same line) within a polling window, the losing tab currently sees its work overwritten silently (last-writer-wins). Surface a toast in the losing tab: "Another tab updated this draft just now." Optionally offer to merge or keep-yours.
- **Why this is here, not in PoC.** The PoC's multi-tab consistency policy (`spec/02-architecture.md` § "Multi-tab consistency") is "eventual consistency via SSE; last-writer-wins on conflicting drafts." This item upgrades the LWW case from silent to surfaced. Cheap once SSE is shipping.
- **Implementation notes.**
  - The `StateChanged` SSE event already includes `fields_touched`; if a tab's local in-memory state for one of those fields differs from its last-known-server-value, surface the toast.
  - Avoid false positives on the tab that *did* the write — the SSE round-trip will return its own write event; the originating tab should ignore its own writes by tracking the request-ID it just sent.
- **Connections.** Pairs with the multi-tab consistency section in `spec/02-architecture.md`. Promote earlier than P4 if reviewers report losing comments due to multi-tab use.

---

## Group G — Auth & identity

### P4-G1: Multi-account support
- **Effort**: M
- **Description.** Switch between multiple GitHub identities (e.g., personal + work) in one running instance.

### P4-G2: Per-org / per-repo scope-management UI
- **Effort**: S
- **Description.** Visualize which repos the user's PAT covers; prompt for scope expansion when needed.

### P4-G3: OAuth device flow for GitHub auth
- **Effort**: S–M
- **Dependencies**: none
- **Description.** Replace the manual fine-grained PAT paste with "Sign in with GitHub" device flow. User clicks button → opens `github.com/login/device` → enters code → tool receives token via the device-flow endpoint. No manual token regeneration on expiry.
- **Why this is here, not in P0.** Independent of every P0 foundation; gated on the decision to distribute beyond the immediate circle. Originally planned as P0-3; moved to P4 because it does not unblock any AI-workstream item.
- **Implementation notes.**
  - Register a GitHub OAuth App at `github.com/settings/developers` (one-time, by the project maintainer).
  - Ship the OAuth App's `client_id` with the binary (it's not a secret in device flow).
  - New backend endpoint `POST /api/auth/start-device-flow` returns `{ user_code, verification_uri, device_code, expires_in, interval }` from `https://github.com/login/device/code`.
  - Frontend shows the `user_code` + `verification_uri` prominently; user opens link, enters code.
  - Backend polls `https://github.com/login/oauth/access_token` at `interval` until `slow_down`, `pending`, or success.
  - On success: token stored via MSAL Extensions (same as PAT).
  - Handle scope mismatch — device flow tokens have user-token scope, may differ from fine-grained PAT semantics. Document.
- **Acceptance criteria sketch.**
  - "Sign in with GitHub" button on first-run screen successfully completes device flow.
  - Resulting token has access to PR review endpoints used elsewhere in the app.
  - Token persists across application restart.
  - Re-auth flow works (e.g., on 401, re-prompt with device flow).
- **Connections.**
  - Independent of AI workstream.
  - Enables: cleaner distribution to colleagues.

---

## Group H — CI & status checks

### P4-H1: Status-check detail drill-down
- **Effort**: M
- **Description.** View test failure logs, build outputs inline.

### P4-H2: Re-trigger checks
- **Effort**: S
- **Description.** "Rerun this failed CI job" without leaving the tool.

### P4-H3: Branch protection awareness
- **Effort**: M
- **Description.** Show which checks are required, which are blocking merge, who can override.

### P4-H4: Test result viewer
- **Effort**: M
- **Description.** Parse JUnit/xUnit/etc. reports, show failed tests with stack traces.

### P4-H5: Coverage delta visualization
- **Effort**: M
- **Description.** "This PR drops coverage by 2%" with file-level breakdown.

---

## Group I — Linked context

### P4-I1: Related issues
- **Effort**: S
- **Description.** PR mentions issue #N → show issue title/state inline.

### P4-I2: Related PRs
- **Effort**: M
- **Description.** Sibling PRs (e.g., a backend PR referenced from a frontend PR).

### P4-I3: Cross-repo dependency graph
- **Effort**: L
- **Description.** Which other repos consume the symbol you're changing.

### P4-I4: Local-clone integration outside chat
- **Effort**: M
- **Dependencies**: P0-4
- **Description.** Cross-reference with editor state (e.g., open this file in VS Code from the file tree).

---

## Group J — Author-side features

If ever building a sibling tool ("Prauthor"). Keeping out of this one is a deliberate design choice.

### P4-J1: Merge action
### P4-J2: Dismiss-review
### P4-J3: Request review from someone
### P4-J4: Mark-ready / mark-draft
### P4-J5: Edit PR title/description
### P4-J6: Resolve merge conflicts

---

## Group K — Ops & infrastructure

### P4-K1: Telemetry / analytics (with explicit opt-in)
- **Effort**: M
- **Description.** Anonymous usage data to identify what features are actually used.

### P4-K2: Crash reporting
- **Effort**: S
- **Description.** Automatic stack-trace capture and (with opt-in) upload.

### P4-K3: Auto-update
- **Effort**: M
- **Description.** Check for new versions and self-update.

### P4-K4: Apple Developer signing & notarization
- **Effort**: S
- **Description.** Clean Gatekeeper UX on macOS. Costs $99/yr.

### P4-K5: Windows installer (MSI)
- **Effort**: S
- **Description.** Proper installer instead of bare binary.

### P4-K6: Homebrew formula
- **Effort**: S
- **Description.** `brew install prism`.

### P4-K7: Linux explicit testing & support
- **Effort**: S
- **Description.** Verify and document Linux support (probably already works due to .NET cross-platform).

### P4-K8: Offline mode
- **Effort**: L
- **Description.** Review already-fetched PRs without internet. Cache PR diffs / comments for offline read; queue submit until back online.

### P4-K9: Backup/restore of draft state
- **Effort**: S
- **Description.** Export/import the JSON state file (or SQLite if migrated).

### P4-K10: Structured logging / OpenTelemetry export
- **Effort**: M
- **Description.** Beyond file logs. Useful for hosted future.

### P4-K11: Internationalization (i18n)
- **Effort**: M
- **Description.** Extract strings into resource files. Add language packs.

### P4-K12: Native desktop shell via Photino.NET
- **Effort**: S (1-2 days)
- **Dependencies**: none
- **Description.** Replace the "open browser pointing at localhost" launcher with a native window pointing at localhost, using Photino.NET. Provides a real app-feel: distinct entry in taskbar / Dock with the PRism icon, no browser chrome, native window decorations, no URL bar. Both modes coexist — the backend still serves localhost, so the user can also open a browser tab if they want.
- **Why this lives in P4 and not earlier.** Cosmetic, not functional. The wedge of the tool (file-by-file diff, iterations, rendered markdown, AI seams) doesn't depend on chrome. Browser-based PoC validates the thesis cheaply; native shell adds polish for wider distribution.
- **Implementation notes.**
  - Add `Photino.NET` NuGet package to `PRism.Web`.
  - Replace the call site of `BrowserLauncher.Open(url)` with creation of a `PhotinoWindow` pointing at the same URL.
  - Persist window size / position / maximize state in `config.json` under a new `window` section. Restore on next launch.
  - Cross-platform notes:
    - **Windows:** WebView2 ships with Win11 / modern Edge. For older Win10, bundle the WebView2 Evergreen Bootstrapper (~3MB) — Photino has documented integration.
    - **macOS:** WKWebView is built-in; nothing extra ships.
    - **Linux:** WebKitGTK varies by distro; document the dependency (`libwebkit2gtk-4.0-37` on Debian-family).
  - Keep `BrowserLauncher` as a fallback. A config flag `ui.shell: "native" | "browser"` (default `"native"` once shipped) lets the user pick. Useful for power users who like browser DevTools.
  - Wire up basic input shortcuts the browser would normally provide: `Cmd/Ctrl + +/-/0` for zoom, `Cmd/Ctrl + Q` for quit (macOS). Photino exposes input hooks for this.
  - Optional native menu bar (macOS) with File / Edit / View / Help. Defer if not needed.
  - DevTools: enabled in dev builds, disabled in release builds. Toggle via `ui.devToolsEnabled` config flag for power users.
- **Acceptance criteria sketch.**
  - Launching the app produces a native window titled "PRism" with the app icon in taskbar / Dock.
  - Window size / position persists across launches.
  - All keyboard shortcuts from the PoC spec (j, k, n, p, c, Esc, Cmd/Ctrl+Enter, Cmd/Ctrl+R, ?) continue to work.
  - WebSocket connections (for v2 chat) work inside the WebView.
  - On Windows without WebView2 installed, app shows a clear "WebView2 required" message with a link to install, rather than crashing.
  - User can switch to browser mode via config and the app launches in browser instead.
- **Connections.**
  - Pairs with: P4-K2 (crash reporting — native shell makes proper crash dialogs more natural).
  - Pairs with: P4-K3 (auto-update — native shell can do native update flows).
  - Pairs with: P4-F5 (notifications — native window enables proper OS notifications).

---

## Group L — Stale review-session cleanup

### P4-L1: Prune old review sessions
- **Effort**: S
- **Description.** When `state.json` accumulates many old PRs (closed/merged + last touched >90 days ago), prune them. Configurable.

### P4-L2: Migrate state to SQLite if draft volume grows
- **Effort**: M
- **Description.** PoC uses JSON file. If draft volume / query needs grow large, swap `IAppStateStore` to a SQLite implementation. Provider abstraction makes this mechanical.

---

## Group M — Repo cloning enhancements

### P4-M1: Per-repo clone settings
- **Effort**: S
- **Dependencies**: P0-4
- **Description.** Per-repo overrides for clone depth, sparseness, allowed/disallowed branches.

### P4-M2: Clone garbage collection
- **Effort**: S
- **Dependencies**: P0-4
- **Description.** Background prune of clones not accessed in 30 days. Configurable.

### P4-M3: Disk usage warning UI
- **Effort**: S
- **Dependencies**: P0-4
- **Description.** Pre-clone size warning for large repos.

### P4-M4: Read-only-tool-scope enforcement
- **Effort**: S
- **Dependencies**: P0-4, P2-2
- **Description.** Already a hardcoded constraint in P2-2. This item is about runtime audit + tests verifying no Bash/Edit/Write tools can be invoked even via prompt-injection.

---

## Group N — AI infrastructure (post-P0)

### P4-N1: MCP server registry / user-supplied MCP
- **Effort**: M
- **Dependencies**: P2-2
- **Description.** Let advanced users plug in their org's internal MCP servers (docs, ticketing, observability). Config-driven, no code change per server.

### P4-N2: AI feedback loop / telemetry
- **Effort**: M
- **Dependencies**: P4-K1 (telemetry baseline)
- **Description.** When user accepts/rejects AI suggestions, capture the signal (locally) for future personalization or model selection.

### P4-N3: Per-feature LLM budget caps
- **Effort**: S
- **Dependencies**: P0-6 (token tracking)
- **Description.** "Stop using Claude after I've spent N tokens today." Useful for users managing subscription rate-limit consumption.

### P4-N4: Local-LLM-only mode (Ollama)
- **Effort**: M
- **Dependencies**: P0-1
- **Description.** New `OllamaLlmProvider` for users who can't or won't send code to remote LLMs. Quality will be lower than Claude; gate behind explicit user opt-in with quality caveats.

### P4-N5: Privacy disclosure UI
- **Effort**: S
- **Dependencies**: any AI feature shipping
- **Description.** Clear "this feature sends your code to provider X" dialog at first enable per feature. Don't bury in TOS.

### P4-N6: Streaming for one-shot AI features
- **Effort**: M
- **Description.** Currently summary/ranking/etc. are blocking. Stream output for perceived latency improvement.

### P4-N7: Multi-turn session resumption for chat
- **Effort**: S
- **Description.** Resume the chat from yesterday's session. Already partially supported via Claude Code's `--resume` flag; needs UI affordance.

---

## Group O — Backups & data

### P4-O1: Manual backup of state file
- **Effort**: S
- **Description.** Settings action: "Export state.json + config.json as a zip."

### P4-O2: Cloud sync of preferences
- **Effort**: L
- **Description.** Config + drafts sync across devices via user-chosen cloud backend (Dropbox, GDrive, etc.). Optional, opt-in.

---

## How to read this group of items

This is a long list. Two strategies for working through it:

1. **User-driven:** Ship the PoC, use it daily for 30+ days, observe what bites. Promote items in this list as evidence accumulates.
2. **Quick-wins-first:** Group through estimating effort and pick the S items grouped by group. Two days of P4-A7 (templates) + P4-B6 (math) + P4-D6 (sorting) + P4-K2 (crash reporting) is a noticeable polish pass.

Both are valid; alternate. Avoid the trap of "I'll do all of Group A before any of Group B" — that's how products end up balanced poorly.
