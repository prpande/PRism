# Non-goals (Explicitly out of PoC scope)

This document is the bouncer at the door. If a feature isn't in the PoC spec (`03-poc-features.md`), it's listed here with a one-line rationale and a pointer to the backlog tier where it lives. The purpose: when a future contributor (including the original author six months from now) is tempted to "just add this little thing," this document is the answer.

For the prioritized backlog with full implementation context, see `backlog/`.

---

## Form factor

| Excluded | Why deferred / rejected |
|---|---|
| Hosted multi-tenant SaaS | Different business with different obligations. PoC validates the wedge first. Re-evaluate post-PoC. |
| Heavyweight desktop wrappers (Electron, Tauri-with-rewrite, WPF native UI) | Wrong tradeoff for a web-app-shaped problem with an ASP.NET Core backend. Bundle size, complexity, language fragmentation. |
| Native desktop window via Photino.NET (lightweight WebView shell) | **Deferred to v2, not rejected.** Architecture is compatible with this swap; ~1-2 days of work. See `backlog/05-P4-polish.md` → P4-K12. PoC ships browser-based to keep the surface minimal. |
| Terminal UI | Limits UX, hostile to the "aesthetically pleasing" goal. |
| IDE extension | Constrains design to host conventions. |
| Mobile / tablet UI | Desktop-only in PoC. |

---

## Auth and identity

| Excluded | Where it goes |
|---|---|
| OAuth device flow | `backlog/05-P4-polish.md` (Group G — when distributing beyond immediate circle) |
| Multi-account support | `backlog/05-P4-polish.md` |
| GitHub App auth | Only relevant for hosted SaaS — outside scope |
| Per-org / per-repo scope-management UI | `backlog/05-P4-polish.md` |

---

## Inbox & discovery

| Excluded | Where it goes |
|---|---|
| Configured-repos dashboard (team-lead queue) | `backlog/05-P4-polish.md` |
| Closed/merged PR history | `backlog/05-P4-polish.md` |
| Saved filters / custom inbox sections | `backlog/05-P4-polish.md` |
| Stale PRs section (no activity in N days) | `backlog/05-P4-polish.md` |
| Drafts section (PRs marked draft) | `backlog/05-P4-polish.md` |
| Inbox sorting options | `backlog/05-P4-polish.md` |
| Search across inbox | `backlog/05-P4-polish.md` |
| Cross-provider inbox unification | Permanently out of scope (multi-provider was dropped). |
| Cross-account inbox unification | `backlog/05-P4-polish.md` |

---

## Review write-path

| Excluded | Why / Where |
|---|---|
| Resolve / unresolve conversations | Requires moving from atomic-submit to live writes. `backlog/05-P4-polish.md`. |
| Edit own previously-submitted comments | `backlog/05-P4-polish.md` |
| Delete own previously-submitted comments | `backlog/05-P4-polish.md` |
| Code suggestion blocks (` ```suggestion ` markdown) | Requires composer + accept-state UI. `backlog/05-P4-polish.md`. |
| Multi-line comment ranges | Single-line covers ~80% of use cases. `backlog/05-P4-polish.md`. |
| Mention autocomplete (`@user` popup) | `backlog/05-P4-polish.md` |
| Comment-on-rendered-markdown-prose | `backlog/05-P4-polish.md` |
| Saved review templates | `backlog/05-P4-polish.md` |
| Inline patch application ("apply suggestion to local clone") | Cross-cutting; `backlog/05-P4-polish.md` |

---

## Iterations (CodeFlow-style depth)

| Excluded | Why / Where |
|---|---|
| Comment-per-iteration anchoring | Drafts stay anchored to current head in PoC. `backlog/05-P4-polish.md`. |
| "Addressed in iteration N" status tracking | Requires a state machine across iterations. `backlog/05-P4-polish.md`. |
| "What's new since I last reviewed" auto-filter (per-user) | `backlog/05-P4-polish.md` |
| Author-marked iteration boundaries | `backlog/05-P4-polish.md` |
| Per-iteration review submissions | `backlog/05-P4-polish.md` |

---

## Diff viewer

| Excluded | Why / Where |
|---|---|
| Whitespace-recompute toggle (full ignore-whitespace re-diff) | PoC always shows whitespace truthfully. `backlog/05-P4-polish.md`. |
| Diff-aware rendered markdown (highlighted insertions/deletions in rendered output) | Requires custom renderer with diff metadata. `backlog/05-P4-polish.md`. |
| Other rendered file types (HTML, SVG, JSON pretty-print, CSV table, ipynb, MDX) | `backlog/05-P4-polish.md` |
| Image diff (side-by-side image preview) | `backlog/05-P4-polish.md` |
| Word-level diff inside rendered markdown | `backlog/05-P4-polish.md` |
| Per-file expand-context-to-full-file | Explicitly cut. `backlog/05-P4-polish.md` if reviewers complain. |
| Search within an open PR (Ctrl+F over PR content) | Browser Ctrl+F suffices in PoC. `backlog/05-P4-polish.md`. |
| Performance work for very large PRs (500+ files virtualization) | `backlog/05-P4-polish.md` |
| KaTeX/MathJax for math blocks | Same dispatcher pattern as Mermaid. `backlog/05-P4-polish.md`. |
| Click-to-zoom / pan for Mermaid diagrams | `backlog/05-P4-polish.md` |

---

## Real-time / sync

| Excluded | Why |
|---|---|
| Webhook-based push (real-time) | Requires hosted form factor or local tunnel. Outside scope. |
| Live UI mutation | Explicitly rejected as bad UX (banner pattern is correct). Recorded so it's not accidentally rebuilt. |
| Configurable per-PR cadence | `backlog/05-P4-polish.md` |
| Auto-reanchor with line-content-matching | Explicitly rejected for PoC (risky failure mode). `backlog/05-P4-polish.md` if user reconciliation proves too tedious. |

---

## Author-side features

| Excluded | Why |
|---|---|
| Merge action | Reviewer tool, not author tool. Authors merge in GitHub. |
| Dismiss-review | Same. |
| Request review from someone | Same. |
| Mark-ready / mark-draft | Same. |
| Edit PR title/description | Same. |
| Resolve merge conflicts | Same. |

These may belong in a sibling tool ("Prauthor") in the future. Not in this product.

---

## CI & status checks

| Excluded | Where |
|---|---|
| Status-check detail drill-down (test failure logs) | `backlog/05-P4-polish.md` |
| Re-trigger checks | `backlog/05-P4-polish.md` |
| Branch protection awareness (which checks required, who can override) | `backlog/05-P4-polish.md` |
| Test result viewer (parse JUnit/xUnit) | `backlog/05-P4-polish.md` |
| Coverage delta visualization | `backlog/05-P4-polish.md` |

---

## Linked context

| Excluded | Where |
|---|---|
| Related-issues view (PR mentions issue #N → show issue) | `backlog/05-P4-polish.md` |
| Related-PRs view | `backlog/05-P4-polish.md` |
| Cross-repo dependency graph | `backlog/05-P4-polish.md` |
| Local-clone integration outside chat (cross-reference editor state) | `backlog/05-P4-polish.md` |

---

## UI / UX nice-to-haves

| Excluded | Where |
|---|---|
| Settings UI (form-based config editing) | `backlog/05-P4-polish.md` |
| Per-repo config overrides | `backlog/05-P4-polish.md` |
| Vim-mode keyboard shortcuts (full chord set) | `backlog/05-P4-polish.md` |
| Custom themes beyond light/dark/system | `backlog/05-P4-polish.md` |
| Notifications (browser push, system tray, email) | `backlog/05-P4-polish.md` |
| Multi-PR tabs (multiple PRs open in-tool) | `backlog/05-P4-polish.md` |
| Activity feed | `backlog/05-P4-polish.md` |

---

## Multi-platform (PERMANENTLY OUT OF SCOPE)

The earlier draft of this section described a multi-provider abstraction with stub projects for non-GitHub backends and a planned `backlog/04-P3-multi-platform.md` tier for ADO / GitLab / Bitbucket / Gerrit adapters. That has been dropped. **PoC and v2 commit to a GitHub-shaped tool** (cloud + GHES via configurable host); no provider abstraction; no `IReviewProvider` interface promising pluggability; no Azure DevOps stub project. See `01-vision-and-acceptance.md` Principle 6 for the rationale.

| Permanently excluded | Note |
|---|---|
| Azure DevOps support | Not planned. ADO has different concepts (snapshot iterations, 5-state vote, work-item linkage) that don't map cleanly to a GitHub-shaped tool. If ever pursued, would be a separate product. |
| GitLab support | Same — not planned. |
| Bitbucket support (Cloud or Server) | Same — not planned. |
| Gerrit support | Same — not planned. |
| Provider plugin marketplace | Same — not planned, and was already rejected as overengineering. |
| Multi-host concurrency | Storage shape scaffolded in v1 (S6 PR0 — `github.accounts: [...]` + `state.json.accounts.default.*`); runtime + UX in v2 (multi-account brainstorm pending). v1 is still single-host per launch; users with both a github.com and a GHES account run two app instances against different data directories. |

GitHub Enterprise Server (GHES) **is** supported via the `github.host` config field — that's first-class, not multi-platform. See `02-architecture.md` § "GitHub host configuration."

---

## AI augmentation (PoC seams everything; PoC builds nothing)

The seams are in PoC. Every AI feature listed below is built in v2.

| Excluded (built in v2) | Backlog tier |
|---|---|
| PR-level summary generation | `backlog/02-P1-core-ai.md` |
| Per-iteration summary | `backlog/02-P1-core-ai.md` |
| File-focus ranker | `backlog/02-P1-core-ai.md` |
| Inbox ranker | `backlog/02-P1-core-ai.md` |
| Inbox item enricher | `backlog/02-P1-core-ai.md` |
| Hunk annotations | `backlog/03-P2-extended-ai.md` |
| Composer assistant ("Refine with AI") | `backlog/03-P2-extended-ai.md` |
| Pre-submit validators | `backlog/03-P2-extended-ai.md` |
| Draft reconciliation assistant | `backlog/03-P2-extended-ai.md` |
| Draft comment suggester | `backlog/03-P2-extended-ai.md` |
| PR chat service (with two-phase repo access) | `backlog/03-P2-extended-ai.md` |
| Whitespace-noise categorization | `backlog/03-P2-extended-ai.md` |
| File-purpose categorization | `backlog/03-P2-extended-ai.md` |
| Risk scoring per hunk | `backlog/03-P2-extended-ai.md` |
| Test coverage delta analysis | `backlog/03-P2-extended-ai.md` |
| Conversation summarization | `backlog/03-P2-extended-ai.md` |
| Token / cost tracking | `backlog/01-P0-foundations.md` |
| Prompt-injection defenses | `backlog/01-P0-foundations.md` |
| MCP server registry (user-supplied MCP) | `backlog/05-P4-polish.md` |
| AI feedback loop / telemetry | `backlog/05-P4-polish.md` |

---

## Ops & infrastructure

| Excluded | Where |
|---|---|
| Telemetry / analytics | `backlog/05-P4-polish.md` (only with explicit opt-in) |
| Crash reporting | `backlog/05-P4-polish.md` |
| Auto-update | `backlog/05-P4-polish.md` |
| Apple Developer signing & notarization | `backlog/05-P4-polish.md` (P4-K4 — when distributing widely) |
| Windows installer (MSI) | `backlog/05-P4-polish.md` |
| Homebrew formula | `backlog/05-P4-polish.md` |
| Linux explicit testing & support | `backlog/05-P4-polish.md` (.NET cross-platform makes it probably-work, but no claim in PoC) |
| Offline mode (review without internet for cached PRs) | `backlog/05-P4-polish.md` |
| Backup/restore of draft state | `backlog/05-P4-polish.md` |
| Structured logging beyond file logs | `backlog/05-P4-polish.md` |
| Internationalization (i18n) | `backlog/05-P4-polish.md` |

---

## Security / privacy hardening

These only apply if/when a hosted multi-tenant version is ever pursued. Recorded for completeness:

- SOC 2 / compliance baseline
- At-rest encryption with customer-managed keys
- Secrets-in-diffs detection
- IP-allowlist for org installations
- Audit log of who reviewed what when
- Data-residency controls

All deferred to a future hosted-product effort that is not in scope for this PoC or v2.
