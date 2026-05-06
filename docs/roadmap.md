# PoC Implementation Roadmap

The full PoC defined in [`spec/`](./spec/) is a 5–8 month build (per [`spec/01-vision-and-acceptance.md`](./spec/01-vision-and-acceptance.md) § "PoC scope vs. validation cost"). This document decomposes it into seven sub-projects, each gets its own implementation spec under [`superpowers/specs/`](./superpowers/specs/) and its own implementation cycle. Brainstorm one, plan one, build one — don't try to spec the whole PoC at once.

The decomposition is dependency-ordered. Don't reorder without a reason.

| Slice | Scope | Demo at end of slice | Spec status |
|---|---|---|---|
| **S0+S1 — Foundations + Setup** | `PRism.sln` skeleton, host + port selection, browser auto-launch, `IAppStateStore` / `ConfigStore` / `TokenStore`, lockfile + PID-liveness, AI seam interfaces with both `Noop*` and `Placeholder*` impls, **`ui.aiPreview` flag-driven DI + `/api/capabilities`**, `IReviewService` interface + `ValidateCredentialsAsync` impl, `github.host` config + host-change modal, first-run Setup screen (PAT entry per design handoff), landing shell with top-chrome (header + empty PR tab strip), React + Vite + TS frontend with oklch tokens, **light/dark theme** via `ui.theme` config + hot-reload (`light` / `dark` / `system`), **accent** via `ui.accent` config + hot-reload (`indigo` / `amber` / `teal`). Inline header controls for theme, accent, and AI preview (instant flip); full Settings page lands in S6. **No Tweaks panel.** | Launch binary → browser opens → Setup screen → paste PAT → token validated against GitHub → routes to placeholder Inbox shell. Header controls flip theme / accent / AI preview instantly; AI preview has no visible effect yet (no host components). | **Shipped** — `superpowers/specs/2026-05-05-foundations-and-setup-design.md` |
| **S2 — Inbox (read)** | Five-section inbox with deduplication, inbox poller, `/api/events` SSE channel for **`InboxUpdated` only** (per-tab subscribe/unsubscribe lifecycle defers to S3 alongside its first consumer), URL-paste escape hatch (input + parse + host-match; navigates to a "PR detail lands in S3" stub on success), frontend inbox view per design handoff. **Renders AI placeholders for**: inbox row category chips, freshness/unread badges (non-AI), the activity rail. | Setup → Inbox loads with five sections; PRs visible; URL-paste jumps to S3-stub PR detail page on a valid in-host URL. AI preview toggle now produces visible category chips. | **Shipped** — `superpowers/specs/2026-05-06-inbox-read-design.md` + `superpowers/plans/2026-05-06-s2-inbox-read.md` (PR #4) |
| **S3 — PR Detail (read)** | PR header, file tree, side-by-side diff via `react-diff-view`, iteration tabs + arbitrary-pair Compare, `j`/`k` nav + viewed checkbox, word-level diff via jsdiff, Mermaid + GFM markdown rendering, existing-comment rendering inline, active-PR poller + **per-tab subscribe/unsubscribe lifecycle + SSE write-timeout backpressure + idle-eviction** (all deferred from S2 — land here alongside the first per-PR consumer) + banner refresh, **first-visit `lastViewedHeadSha` / `lastSeenCommentId` writes** on PR-detail open (read path lands in S2; without writes the unread-badges in S2 stay quiet by design), **diff-mode toggle (side-by-side / unified) — production feature, not Tweaks**. **No drafts. Renders AI placeholders for**: file-tree focus dots, Overview-tab AI summary card, AI hunk annotation chips above hunks. | Click a PR → file tree + diff + iteration tabs work end-to-end on a real GitHub PR. AI preview toggle now produces visible AI summary, focus dots, hunk annotations. | Not started |
| **S4 — Drafts + composer** | `PUT /api/pr/{ref}/draft` single-funnel write endpoint, draft persistence across sessions, comment composer, replies to existing comments, the **seven-row stale-draft reconciliation matrix** (per [`spec/03-poc-features.md`](./spec/03-poc-features.md) § 5). **Multi-tab consistency `StateChanged` events** (umbrella event fires alongside typed `DraftSaved` / `DraftDiscarded` / `DraftSubmitted` per [`spec/04-ai-seam-architecture.md`](./spec/04-ai-seam-architecture.md) § `IReviewEventBus`) — first slice where state mutations originate. Submit button still disabled. | Save drafts on a PR; quit and relaunch; drafts survive; classification fires correctly when a teammate pushes. | Not started |
| **S5 — Submit pipeline** | GraphQL pending-review pipeline (`addPullRequestReview` → `addPullRequestReviewThread`/`Reply` → `submitPullRequestReview`), resumable retry state machine, `<!-- prism:client-id:<id> -->` lost-response marker, verdict re-confirm, all DoD-mandated tests for submit + reconciliation + state migration. **Renders AI placeholders for**: submit-modal AI validator card, Ask AI drawer with pre-baked messages. | End-to-end demo (steps 1–13 of [`spec/01-vision-and-acceptance.md`](./spec/01-vision-and-acceptance.md) § "The PoC demo") passes. AI preview toggle produces visible AI validator and pre-baked Ask AI conversation. | Not started |
| **S6 — Polish + distribution** | **Settings page** consolidating all user preferences into a single home (theme, accent, AI preview — same controls as the S0+S1 header but with a discoverable destination; plus GitHub host, polling cadences, inbox section visibility, logging level, state-event-log retention, etc. as later slices add fields). The header controls remain for instant flip; the Settings page is the comprehensive surface. **"Replace token" footer link** per [`spec/03-poc-features.md`](./spec/03-poc-features.md) § Settings — disconnects the current PAT (`TokenStore.ClearAsync` + viewer-login reset) and routes back to the Setup screen. Identity-change rule for `state.json` (carry forward drafts when same login, clear `pendingReviewId`/`threadId`/`replyCommentId` when different login — analogous to the existing host-change rule) gets brainstormed in this slice. Keyboard cheatsheet, accessibility baseline, single-file publish profiles for `win-x64` and `osx-arm64`, macOS Gatekeeper / Windows SmartScreen first-run copy, viewport-screenshot regression test, README. | A binary other people can download and run. | Not started |

## Why this cut

- **S0 + S1 is a walking skeleton.** Every project compiles and one path runs end-to-end before any feature is built. Cheaper than 5 features-worth of speculative infra.
- **AI seam scaffolding lands in S0**, not later. The spec is firm that retrofitting seams is the worst trade and the marginal cost in S0 is small (interfaces + `Noop*` classes + `Placeholder*` classes + DTO records).
- **Submit (S5) is its own slice** because it's the highest-risk, highest-test-coverage chunk of the spec. Putting it after read paths (S2, S3) lets the author dogfood reading PRs while still building submit.
- **No P3 slice.** Multi-platform was dropped per [`spec/01-vision-and-acceptance.md`](./spec/01-vision-and-acceptance.md) Principle 6.

## Process: TDD throughout

**Every slice ships test-first, red → green → refactor.** No production code lands without a failing test that proved the need. See [`CLAUDE.md`](../CLAUDE.md) § Development process for the full rule and practical implications. The DoD in [`spec/01-vision-and-acceptance.md`](./spec/01-vision-and-acceptance.md) enumerates *which* tests must exist by the end of the PoC; TDD is how every test (including the ones the DoD doesn't enumerate) comes into existence.

## What was dropped from the design handoff's Tweaks panel

The interactive prototype at [`design/handoff/`](./../design/handoff/) carries a floating Tweaks panel. Most of it was design-discovery scaffolding and is **not** in the production scope:

| Tweak | Production status | Lands in slice |
|---|---|---|
| Theme (light / dark / system) | **Kept.** Production feature, controlled via `ui.theme` config field with `FileSystemWatcher` hot-reload. | S0+S1 |
| Diff mode (side-by-side / unified) | **Kept.** Production feature, lives on the PR detail toolbar with `d` keyboard shortcut. | S3 |
| Density (Comfortable / Compact) | Dropped. Density tokens stay in `tokens.css` for design-time use; no user toggle ships. | — |
| Accent (Indigo / Amber / Teal) | **Kept.** Production feature. The oklch hue parameterization (`--accent-h`, `--accent-c`) is exposed via `ui.accent` config field with `FileSystemWatcher` hot-reload; user can cycle between the three accents to tune their preference. | S0+S1 |
| AI augmentation toggle | **Replaced.** The AI on/off semantics graduate to `ui.aiPreview` (config + UI toggle); see "AI placeholder behavior" below. | S0+S1 (architecture) |
| Show stale-draft panel toggle | Dropped. The Drafts tab is unconditional once S4 ships. | — |

## AI placeholder behavior (S0+S1 architecture, rendered slice-by-slice)

S0+S1 lands the architecture; each subsequent slice plugs in placeholders as the host component arrives.

**Architecture:**
- Every AI seam interface in [`spec/04-ai-seam-architecture.md`](./spec/04-ai-seam-architecture.md) gets two PoC implementations: a `Noop*` class (returns null/empty, the spec's PoC default) and a `Placeholder*` class (returns canned data lifted from [`design/handoff/data.jsx`](./../design/handoff/data.jsx)).
- DI registration in `PRism.Web/Program.cs` reads `ui.aiPreview` (a new config field, default `false`) and binds either the `Noop*` set or the `Placeholder*` set.
- `/api/capabilities` reads the same flag and reports every `ai.*` capability as `false` (when `aiPreview: false`) or `true` (when `aiPreview: true`).
- Frontend behavior is unchanged from the spec: every AI slot exists in the component tree and renders `null` when its capability flag is `false`. The flag flip is the only thing that changes between AI-off and AI-preview.

**Why this matters:** when v2 ships real AI, the only change is swapping `Placeholder*` for the real provider. Frontend code, slot wiring, and capability machinery are unchanged. The capability-flag-gated architecture is exercised end-to-end from day one rather than being theoretical until the first real AI feature lands.

**Toggle UX:** S0+S1 ships **inline header controls** — a small cluster in the header's right side (theme cycle, accent picker, AI preview toggle) for instant flip-and-feel comparison. The full **Settings page** lands in S6 and consolidates these same controls (plus all later preferences) into a single discoverable home. Header controls stay after S6 ships — quick-flip and the comprehensive surface coexist.

## When a slice changes shape

If implementation reveals a slice is too large or wrong-shaped, update this table and the relevant spec doc *before* re-planning. Don't let the cut drift silently.

## Architectural readiness

Cross-cutting structural work surfaced by a spec/backlog vs. current-code review (May 2026). Each item is gated to the slice it must land before. Items at the *Now* gate are not blocked by any slice and are next in queue.

Full design and rationale: [`superpowers/specs/2026-05-06-architectural-readiness-design.md`](./superpowers/specs/2026-05-06-architectural-readiness-design.md).

| Gate | Item | PR / status |
|---|---|---|
| **Now** | Banned-API analyzer (no `Octokit.*` in `PRism.Core` / `PRism.Web` / `PRism.AI.*`) | PR 1 |
| **Now** | DI extension methods per project (`AddPrismCore` / `AddPrismGitHub` / `AddPrismAi` / `AddPrismWeb`) | PR 2 |
| **Now** | Named records for all wire shapes (replace inline `new { ok = ... }` in endpoint files) | PR 3 |
| **Before S4** | Decompose `AppState` into typed sub-records (`InboxState` / `PrSessionsState` / placeholder `AiState`) | open |
| **Before S4** | Schema-versioned migration support in `AppStateStore` | open |
| **Before S5** | Split `IReviewService` into capability sub-interfaces (`IReviewAuth` / `IPrDiscovery` / `IPrReader` / `IReviewSubmitter`) | open |
| **Before S5** | Partial-class split of `GitHubReviewService` by capability area | open (optional) |
| **Before P0+** | Frontend types codegen for `frontend/src/types/api.ts` (NSwag or equivalent) | open |
| **Before P0+** | Document homes for `PRism.Git.Clone`, `PRism.Mcp.Host`, `PRism.AI.Chat`, AI cache, prompt-injection sanitizer | open |
| **Before P0+** | `IHostedService` for `ConfigStore` async init (replaces `GetAwaiter().GetResult()` pragma) | open |
| **Convention** | State machines live in `<Feature>/Pipeline/` sub-folders with a single entry-point class | adopt before first machine lands (S4 stale-draft reconciliation) |
