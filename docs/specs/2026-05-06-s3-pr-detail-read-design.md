# S3 — PR Detail (read): Design

**Slice**: S3 — third slice in [`docs/roadmap.md`](../../roadmap.md), follows the shipped S0+S1 and S2.
**Date**: 2026-05-06.
**Status**: Brainstormed; awaiting plan. Refined 2026-05-06 after a 7-persona document review (PR #13).
**Branch**: `feat/s3-pr-detail-spec` (worktree at `C:/src/PRism-s3-spec`).
**Source authorities**: [`docs/spec/`](../../spec/) is the PoC specification this slice implements; [`design/handoff/`](../../../design/handoff/) is the visual reference. This document does not restate the PoC spec; it commits to a specific subset, records deviations from spec text where the design handoff or implementation reality forced a different choice, and adds slice-specific decisions.

---

## 1. Goal

Make the PR detail surface real. Three sub-tabs — **Overview**, **Files**, **Drafts** — under the PR header, where Files is the diff workhorse, Overview is a contextual landing card, and Drafts is rendered as a disabled stub until S4. An active-PR poller drives a non-intrusive update banner via per-subscription SSE. Iteration tabs are computed via the new weighted-distance clustering algorithm with two live multipliers (file Jaccard, force-push). AI placeholders render in three locations when `aiPreview` is on.

End-to-end demo at slice completion:

1. Run binary; arrive at the inbox (S2 unchanged).
2. Click a PR row → PR detail page loads with header, sub-tab strip, and the Overview tab as default.
3. Overview shows: AI summary placeholder card (off by default in PoC config), PR description rendered as Markdown, stats tiles, PR-root issue comments rendered read-only, and a "Review files" CTA.
4. Switch to the Files tab → file tree (collapsible directory tree, smart-compacted, with per-directory viewed rollups) on the left; side-by-side diff via `react-diff-view` with word-level highlighting via `jsdiff` on the right.
5. Iteration tabs above the diff: All changes / last three numbered iterations inline / "All iterations ▾" dropdown / "Compare ⇄" picker. Iterations are computed via the weighted-distance algorithm.
6. `j` / `k` navigate file selection; `v` toggles viewed; `d` toggles side-by-side / unified.
7. Click a file ending in `.md` → rendered-Markdown view with a toggle to raw diff. Mermaid blocks render lazily.
8. Existing GitHub review comments render inline read-only between code lines on their anchored line.
9. Open a second PR in a different inbox row → PRism's tab strip shows both; the SSE connection holds; both PRs are subscribed for poll-driven updates.
10. Author pushes new commits to PR #1 → within ~30 s a banner appears on PR #1's tab: *"PR updated — Iter 4 available, 2 new comments — Reload."* Click Reload → page reloads at the new state. The inbox row still shows the unread badge (Reload does not write `lastViewedHeadSha`); navigating back to the inbox and re-opening PR #1 clears the badge.
11. Quit and relaunch → `state.json` is migrated from `version: 1` to `version: 2` silently; bookkeeping fields are preserved.
12. The Drafts tab is visually disabled (greyed, count `0`, no-op on click).
13. Toggle AI preview in the header → Overview tab renders an AI summary card with canned placeholder data; file tree renders priority dots in a new column; AI hunk annotations are *not* inserted in PoC even with the toggle on (per spec § 4: "never inserted in PoC").

## 2. Scope

### In scope

- PR detail page + three-tab strip (Overview / Files / Drafts) under the PR header.
- File tree as a collapsible directory tree with smart-compaction of single-child chains, per-directory viewed-count rollups, and the AI focus-dot column slot. Collapse state resets on every PR-detail open in S3.
- Side-by-side and unified diff via `react-diff-view`, three lines of context, Shiki syntax highlighting from a single shared instance.
- Word-level diff highlighting via `jsdiff` overlaid on changed lines.
- Existing review-comment threads rendered inline read-only, anchored to lines. Multiple threads anchored at the same line render as a vertical stack inside one widget (per `react-diff-view`'s one-widget-per-change constraint).
- Iteration tabs (last three numbered tabs inline + "All iterations ▾" dropdown) and the Compare picker (with auto-swap on reverse selection and the same-iteration empty state).
- Iteration clustering: `IIterationClusteringStrategy` interface + `WeightedDistanceClusteringStrategy` impl with **two live multipliers** (`FileJaccardMultiplier`, `ForcePushMultiplier`); MAD-based adaptive threshold; hard floor (5 min) and ceiling (3 days); degenerate-case fallback to one-tab-per-commit; coefficients in config; sorts by `committedDate` (refreshed by `--amend`/rebase, more reliable than `authoredDate`). The four future multipliers (message keywords, diff size, review events, branch activity) are documented in `docs/spec/iteration-clustering-algorithm.md` but not implemented in S3.
- Per-commit changed-files data for `FileJaccardMultiplier` is fetched via REST `GET /repos/{o}/{r}/commits/{sha}` fan-out (concurrency cap 8, matching S2's pattern). GraphQL's `Commit` type does not expose changed-file paths.
- `j` / `k` (file nav), `v` (viewed toggle), `d` (diff-mode toggle) keyboard shortcuts on the Files tab.
- Active-PR poller (`BackgroundService`) at 30 s cadence, paused when no subscribed PRs. Per-PR backoff state (a flaky PR doesn't starve healthy PRs).
- SSE lifecycle: per-PR subscribe / unsubscribe through REST endpoints, write-timeout backpressure (5 s), idle-eviction (15 min on `lastClientActivity` — heartbeat replies count), heartbeat every 25 s as a **named SSE event** (`event: heartbeat\ndata: {}\n\n` — comment lines starting with `:` are invisible to the browser's `EventSource` `onmessage` and cannot drive a silence-watcher), frontend silence-watcher at 35 s on the named heartbeat.
- New SSE event type `pr-updated` carrying `ActivePrUpdated { prRef, headShaChanged, commentCountChanged, newHeadSha?, newCommentCount? }`.
- Banner refresh on PR detail when a `pr-updated` event arrives for the visible PR.
- First-mount writes for `lastViewedHeadSha` and `lastSeenCommentId` via `POST /api/pr/{ref}/mark-viewed`. Reload does *not* write these.
- Per-file viewed-checkbox state via `POST /api/pr/{ref}/files/viewed` (path travels in the request body, not the URL — keeps the route static, avoids ASP.NET catch-all encoding traps with `%2F` / NFC-NFD / leading dots, and lets the body length cap apply uniformly). Writes into `ReviewSessions[ref].ViewedFiles` (a new field on `ReviewSessionState`).
- State schema change: `ReviewSessionState` gains a `ViewedFiles` field (`filePath → headShaAtTimeOfMark`). Schema version increments from `1` to `2` (sequential `int`). Top-level `AppState.ReviewSessions: dict<...>` shape stays unchanged.
- **Forward-incompat handling**: `state.json` files with `version > CurrentVersion` enter **read-only mode** — the app loads, a banner explains the version mismatch, and **all save attempts are blocked** until the binary is upgraded (or the user explicitly re-initializes state via Setup). The earlier "best-effort recognized fields" framing is reverted: a save-and-downgrade path that silently drops unrecognized fields would corrupt v3+ pendingreview-IDs introduced by S4/S5.
- Markdown rendering pipeline (`react-markdown` v9+, `remark-gfm`, Shiki, lazy-loaded Mermaid pinned to `securityLevel: 'strict'`) shared across PR description, comment bodies, and `.md` file rendering.
- Markdown rendering for `.md` files in the diff with a toggle between rendered and raw-diff views.
- Diff content fetched via two GitHub REST endpoints in tandem: `pulls/{n}/files` for the file list (paginated to GitHub's 3000-file ceiling) and `pulls/{n}` for the `changed_files` integer count. **Truncation is derived**: `truncated = (pull.changed_files > assembled files.length)` — the `compare` endpoint's truncation behavior is documented only in prose and the response carries no `truncated` field; deriving from the count is the correctness-preserving signal. Frontend renders a `DiffTruncationBanner` deep-linking to github.com when truncated.
- API surface (Section 8): `GET /api/pr/{ref}`, `GET /api/pr/{ref}/diff?range=`, `GET /api/pr/{ref}/file?path=&sha=` (with authz check that the path is in the PR's diff and a 5 MB size cap), `POST /api/pr/{ref}/mark-viewed`, `POST /api/pr/{ref}/files/viewed` (path in body), `POST /api/events/subscriptions`, `DELETE /api/events/subscriptions` (subscriberId + prRef in request body, not query string). `GET /api/events` extends to emit `subscriber-assigned` as the first event.
- All mutating endpoints (POST/DELETE) enforce the spec-mandated `X-PRism-Session` token header (per `docs/spec/02-architecture.md` § "Cross-origin defense for the localhost API"). The middleware lands in S3; the contract is specified in § 8 (constant-time comparison, 401 problem-slug `/auth/session-stale`, frontend force-reload on 401, cookie re-stamped on every HTML response). `OriginCheckMiddleware` is also tightened to **reject empty/missing Origin on POST/PUT/PATCH/DELETE** (currently accepts empty) — both layers ship in S3.
- AI seam wiring: existing `IPrSummarizer`, `IFileFocusRanker`, `IHunkAnnotator` interfaces (already defined in `PRism.AI.Contracts/Seams/`) are wired into three frontend slots — `<AiSummaryCard>` (Overview), `<AiFileFocusBadges>` (file tree column), `<AiHunkAnnotation>` (diff inline; never inserted in PoC). DI binds either `Noop*` or `Placeholder*` based on `ui.aiPreview`.
- `IReviewService` grows new methods (`GetPrDetailAsync`, `GetDiffAsync(prRef, range)`, `GetFileContentAsync`, `GetTimelineAsync`). The capability split per ADR-S5-1 remains gated to S5; S3 keeps a single growing interface for one slice.
- Documentation deliverables (Section 9): canonicalize the iteration-clustering algorithm doc, rewrite affected spec sections, update the roadmap, update the architectural-readiness spec.

### Out of scope

- Comment composer; reply composer; draft persistence; stale-draft reconciliation; verdict re-confirmation. (S4.)
- Submit flow; pending-review GraphQL pipeline; verdict picker enabled. (S5 — disabled in S3.)
- Multi-tab consistency `StateChanged` events. (S4 — only `inbox-updated` and `pr-updated` events in S3.)
- AI seam wiring beyond the three slots above (`<AiComposerAssistant>`, `<AiDraftSuggestionsPanel>`, AI badge slot in stale-draft reconciliation, AI validator section in submit dialog, AI inbox enrichment beyond S2 — all later).
- The four future iteration-clustering multipliers (message keywords, diff size, review events, branch activity) — documented in the algorithm doc; not implemented in S3.
- Iteration-clustering coefficient calibration workflow.
- `PrSessionsState` wrap (ADR-S4-1) — remains gated to S4; doing the wrap rename alongside S4's drafts/replies/reconciliation field additions is more economical than two consecutive migrations.
- Migration framework extraction (ADR-S4-2). S3 ships a single inline `MigrateV1ToV2` helper method on `AppStateStore`. The framework lands when S4's migration #2 motivates it.
- `IReviewService` capability split (ADR-S5-1) — remains gated to S5.
- Schema versioning format change to `YYYYMMDDHHMM` longs — reverted; integer versions stand.
- Whole-file diff expansion in the diff pane. (`P4-B8`.)
- Markdown HTML allowlist (`<details>`, `<sub>`, `<sup>`, `<kbd>`, etc.). (P4 backlog.)
- Section / directory collapse-state persistence in `state.json`. (S6 / v2.)
- AI hunk annotations inserted into the diff. (v2.)
- AI Chat drawer (`<AiChatDrawer>`) and repo-clone consent flow. (P0+.)
- macOS / Linux CI; single-file publish profiles; accessibility baseline; viewport-screenshot regression test. (S6.)

### Acknowledged carryforwards

- `ReviewSessionState` gains a `ViewedFiles` field in S3. The `PrSessionsState` wrap (ADR-S4-1) remains deferred to S4; bundling the wrap rename with S4's other state-shape additions is cheaper than two consecutive migrations.
- S3 ships a single inline `MigrateV1ToV2` helper method on `AppStateStore`. The migration framework per ADR-S4-2 lands when S4 introduces the second migration.
- `IReviewService` grows in S3; the capability split per ADR-S5-1 happens in S5 as originally gated.
- The Drafts sub-tab is rendered greyed in S3; S4 lights it up alongside the comment composer and stale-draft reconciliation panel.
- The PR-root conversation on the Overview tab is read-only in S3; S4 wires the reply composer alongside the inline-comment composer.

## 3. Authority precedence and deviations from the PoC spec

[`design/handoff/`](../../../design/handoff/) is the **default** authority on visual layout, structure, and interaction. Where the PoC spec text in [`docs/spec/`](../../spec/) drifts from the handoff, the handoff wins unless the user explicitly overrides. Each deviation below is recorded so spec edits in Section 9 close the gap.

| Deviation | What the spec says | What S3 ships | Source of decision |
|---|---|---|---|
| AI summary slot position | Spec § 3 places `<AiSummarySlot>` "between the sticky header and the sticky iteration tabs." | Card on the Overview tab; iteration tabs only render on the Files tab. | Roadmap S3 row mentions "Overview-tab AI summary card"; handoff layout. |
| File tree shape | Spec § 3 says "Files grouped by directory; directories collapsible." Handoff prototype renders a flat list. | Collapsible directory tree with smart compaction. | User override of the handoff's flat list, restoring the spec's grouped intent and adding smart compaction + per-directory viewed rollups. |
| Iteration clustering | Spec § 3 describes a 60-second time-gap policy with force-push as a hard boundary, configurable via `iterations.clusterGapSeconds`. | Weighted-distance algorithm with two live multipliers (file Jaccard, force-push); force-push reframed as a soft signal (long-gap multiplier); MAD threshold; degenerate-case fallback to one-tab-per-commit; coefficients in `iterations.clusteringCoefficients`. | The user-authored algorithm doc, canonicalized in S3 to `docs/spec/iteration-clustering-algorithm.md`. |
| Reload semantics for unread bookkeeping | Spec § 3 / § 8 are silent on whether Reload writes `lastViewedHeadSha` / `lastSeenCommentId`. | Reload does NOT write these. Writes only happen on the *first* PR-detail mount; re-mount after navigation writes again. | Q2 brainstorming decision. |
| PR-root conversation rendering | Spec § 3 excludes the chronological PR conversation feed from PoC. | PR-root *issue-level* comments render read-only on the Overview tab; the chronological feed (commits + comments + reviews + status updates + force-pushes in time order) remains out of scope. | Q4 brainstorming decision: the spec's exclusion targeted the merged feed; the issue-comments alone are a single API call and a single read-only list. |

## 4. Project structure changes

### New / modified directories

```
PRism.Core/
├── State/
│   ├── AppState.cs                     ← MODIFIED: Version stays int (1 → 2); top-level shape unchanged
│   ├── ReviewSessionState.cs           ← MODIFIED: adds ViewedFiles field
│   └── AppStateStore.cs                ← MODIFIED: adds private MigrateV1ToV2 helper; LoadAsync calls it before Deserialize
├── IReviewService.cs                   ← MODIFIED: adds GetPrDetailAsync, GetDiffAsync(range), GetFileContentAsync, GetTimelineAsync
├── Iterations/                         ← NEW namespace
│   ├── IIterationClusteringStrategy.cs
│   ├── WeightedDistanceClusteringStrategy.cs
│   ├── IterationClusteringCoefficients.cs
│   ├── IDistanceMultiplier.cs
│   ├── FileJaccardMultiplier.cs        ← LIVE
│   ├── ForcePushMultiplier.cs          ← LIVE
│   ├── MadThresholdComputer.cs
│   ├── ClusteringInput.cs
│   └── IterationCluster.cs
├── PrDetail/                           ← NEW namespace
│   ├── IPrDetailLoader.cs
│   ├── PrDetailLoader.cs               ← coordinator: calls IReviewService methods, runs clustering, composes snapshot
│   ├── ActivePrPoller.cs               ← BackgroundService; per-PR backoff state
│   ├── ActivePrSubscriberRegistry.cs
│   ├── ActivePrPollerState.cs          ← per-PR { lastPolledAt, lastError, nextRetryAt, headSha, commentCount }
│   └── PrDetailSnapshot.cs
└── Events/
    └── (extend IReviewEventBus with ActivePrUpdated)

PRism.Core.Contracts/
├── PrDetailDto.cs                      ← NEW
├── DiffDto.cs                          ← NEW (carries truncated: bool)
├── DiffRangeRequest.cs                 ← NEW
└── ActivePrUpdate.cs                   ← NEW

PRism.GitHub/
└── GitHubReviewService.cs              ← MODIFIED: new method bodies for GetPrDetailAsync (single GraphQL round-trip with timeline-cursor pagination), GetDiffAsync (dual-endpoint: pulls/{n}/files for list + compare for truncated flag), GetFileContentAsync (REST contents API with size cap), GetTimelineAsync (PullRequestTimelineItems → ClusteringInput, with REST fan-out for per-commit changedFiles). The partial-class split per ADR-S5-2 stays optional/deferred.

PRism.AI.Contracts/                     ← UNCHANGED (interfaces exist)
PRism.AI.Placeholder/                   ← UNCHANGED (impls exist)

PRism.Web/
├── Endpoints/
│   ├── PrDetailEndpoints.cs            ← NEW
│   ├── EventsEndpoints.cs              ← MODIFIED: subscriber-id assignment + subscriptions endpoints
│   └── PrDetailDtos.cs                 ← NEW
├── Middleware/
│   ├── OriginCheckMiddleware.cs        ← MODIFIED: rejects empty/missing Origin on POST/PUT/PATCH/DELETE (was: short-circuited to next on empty Origin)
│   └── SessionTokenMiddleware.cs       ← NEW: enforces X-PRism-Session header on POST/PUT/PATCH/DELETE; constant-time comparison; 401 problem-slug `/auth/session-stale`
└── Sse/
    └── SseChannel.cs                   ← MODIFIED: per-subscriber subscription set (ConcurrentDictionary<subscriberId, SseSubscriber> + inverted index PrRef→Set<subscriberId>); per-PR fanout; write-timeout via CancellationToken+Task.Delay race; idle-eviction; subscriberId is 256-bit Guid; emitted as `subscriber-assigned` (first SSE event); heartbeat is a NAMED event (`event: heartbeat\ndata: {}\n\n`), NOT a `:heartbeat` comment line

frontend/src/
├── api/
│   ├── prDetail.ts                     ← NEW
│   └── events.ts                       ← MODIFIED: subscribe / unsubscribe RPC; subscriberId capture; X-PRism-Session header on mutating calls
├── hooks/
│   ├── usePrDetail.ts                  ← NEW
│   ├── useActivePrUpdates.ts           ← NEW
│   ├── useFileTreeState.ts             ← NEW
│   └── useEventSource.ts               ← MODIFIED: ready-state Promise resolves on subscriber-assigned event; subscribe POSTs await it
├── components/
│   ├── PrDetail/
│   │   ├── PrDetailPage.tsx            ← REPLACES S2 stub
│   │   ├── PrHeader.tsx
│   │   ├── PrSubTabStrip.tsx
│   │   ├── BannerRefresh.tsx
│   │   ├── EmptyPrPlaceholder.tsx
│   │   ├── OverviewTab/
│   │   │   ├── OverviewTab.tsx
│   │   │   ├── AiSummaryCard.tsx
│   │   │   ├── PrDescription.tsx
│   │   │   ├── StatsTiles.tsx
│   │   │   ├── PrRootConversation.tsx  ← read-only in S3
│   │   │   └── ReviewFilesCta.tsx
│   │   ├── FilesTab/
│   │   │   ├── FilesTab.tsx
│   │   │   ├── IterationTabStrip.tsx
│   │   │   ├── ComparePicker.tsx
│   │   │   ├── FileTree/
│   │   │   │   ├── FileTree.tsx
│   │   │   │   ├── DirectoryNode.tsx
│   │   │   │   ├── FileNode.tsx
│   │   │   │   └── treeBuilder.ts      ← pure function; smart-compaction logic
│   │   │   └── DiffPane/
│   │   │       ├── DiffPane.tsx
│   │   │       ├── WordDiffOverlay.tsx
│   │   │       ├── ExistingCommentWidget.tsx ← stacks multiple threads at same line
│   │   │       ├── AiHunkAnnotation.tsx
│   │   │       ├── MarkdownFileView.tsx
│   │   │       └── DiffTruncationBanner.tsx
│   │   └── DraftsTab/
│   │       └── DraftsTabDisabled.tsx
│   └── Markdown/
│       ├── MarkdownRenderer.tsx
│       ├── shikiInstance.ts
│       └── MermaidBlock.tsx            ← initialize with securityLevel: 'strict', htmlLabels: false
├── pages/
│   └── (PrDetailPage replaces S3StubPrPage; route /pr/:owner/:repo/:number rebound)
└── styles/
    ├── pr-detail.module.css
    ├── file-tree.module.css
    ├── diff-pane.module.css
    └── markdown.module.css

tests/
├── PRism.Core.Tests/
│   ├── State/
│   │   └── AppStateStoreMigrationTests.cs    ← tested through public LoadAsync/SaveAsync boundary (no `InternalsVisibleTo` needed); v1 → v2; idempotency on re-applied v2; missing-version throws (matches existing behavior); future-version → read-only-mode flag set; saves blocked while in read-only mode
│   ├── Iterations/
│   │   ├── WeightedDistanceClusteringStrategyTests.cs ← incl. degenerate-fallback tab cap (max 20) + occurredAt clamp test
│   │   ├── FileJaccardMultiplierTests.cs
│   │   ├── ForcePushMultiplierTests.cs
│   │   ├── MadThresholdComputerTests.cs
│   │   └── ClusteringDisciplineCheck.cs      ← `[SkippableFact]` env-var-gated discipline-check harness (folded in from former PR 12)
│   └── PrDetail/
│       ├── ActivePrSubscriberRegistryTests.cs
│       ├── ActivePrPollerBackoffTests.cs     ← per-PR isolation
│       └── PrDetailLoaderTests.cs
├── PRism.GitHub.Tests/
│   └── GitHubReviewServiceTests.cs           ← new methods, against fakes; pagination; truncated derived from `pull.changed_files` count; per-commit fan-out cap
├── PRism.GitHub.Tests.Integration/           ← NEW project (contract tests)
│   └── FrozenApiCodexPrTests.cs              ← pinned to commit-SHA, not branch HEAD
└── PRism.Web.Tests/
    ├── PrDetailEndpointsTests.cs             ← incl. POST /files/viewed body-shape, 422 cap-exceeded, 409 stale-headSha, GET /file 422-not-in-diff vs 422-snapshot-evicted
    ├── EventsSubscriptionsEndpointTests.cs
    ├── OriginCheckMiddlewareTests.cs         ← MODIFIED: empty-Origin rejection on POST/DELETE (was short-circuit-to-next)
    └── SessionTokenMiddlewareTests.cs        ← X-PRism-Session enforcement; constant-time comparison; 401 problem-slug shape; stale-token-after-restart full-page-reload
```

### Reference graph (unchanged from S2)

- `PRism.Core` → `PRism.Core.Contracts`, `PRism.AI.Contracts`
- `PRism.GitHub` → `PRism.Core`, `PRism.Core.Contracts` (only project allowed to reference Octokit per the banned-API analyzer; S3's GitHub HTTP stays raw `HttpClient`).
- `PRism.AI.Placeholder` → `PRism.AI.Contracts`
- `PRism.Web` → `PRism.Core`, `PRism.GitHub`, `PRism.AI.Contracts`, `PRism.AI.Placeholder`

## 5. Stack additions beyond S0+S1 / S2

- **`react-diff-view`** — diff rendering library. Used for both side-by-side and unified modes. Multi-thread rendering at the same line uses one widget that internally stacks the threads (the library's widgets prop is one-per-change).
- **`jsdiff`** (npm `diff`) — word-level highlighting overlay on changed lines.
- **`react-markdown` v9+** + **`remark-gfm`** — Markdown pipeline. Pin to v9 specifically; older versions allowed `javascript:` URLs in autolinks. `urlTransform` is set to a strict allowlist (`http`, `https`, `mailto`). Adversarial-input sanitization tests pin the pipeline's behavior against `<script>`, `<iframe>`, `<img onerror=>`, `<object>`, `data:` and `vbscript:` URLs (Section 11.2).
- **`shiki`** — syntax highlighting. A single shared instance lives in `frontend/src/components/Markdown/shikiInstance.ts` and is consumed by both diff and Markdown rendering paths via thin adapters; the singleton owns the lazy-grammar-load cache.
- **`mermaid`** — lazy-loaded inside `MermaidBlock.tsx` via dynamic import. Initialized with `{ securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } }` to defend against XSS via SVG / foreignObject injection (PR descriptions and `.md` files in PRs are author-controlled). Pinned to an exact patch range in `package.json`; major-version bumps require manual approval (Renovate/Dependabot label). The Mermaid behavior is verified by a **behavioral** test (feed an adversarial flow definition with a `click ... javascript:...` directive; assert the rendered SVG contains no actionable JS), not just an init-options spy — option renames in future Mermaid versions cannot mask a regression.
- **`eventsource-mock`** (or 30-line in-house fake) — Vitest test polyfill for SSE.
- **`Xunit.SkippableFact`** — adds the `[SkippableFact]` attribute used for the env-var-gated iteration-clustering discipline-check harness (§ 11.5). Without this, `[Fact(Skip="...")]` is unconditionally skipped and cannot un-skip from an env var.
- No other new backend libraries. ASP.NET Core's `HttpResponse.WriteAsync` + `FlushAsync` continues to handle SSE; pagination in `GitHubReviewService.GetDiffAsync` is a manual loop on `Link rel="next"`. Write-timeout is implemented as a `CancellationTokenSource` + `Task.Delay` race against `FlushAsync`.

## 6. Backend architecture

### 6.1 PR detail load and cache

```
GET /api/pr/{owner}/{repo}/{number}                  → PrDetailLoader.LoadAsync
  ↓
IReviewService.GetPrDetailAsync(prRef)
  → single GraphQL round-trip:
     PR meta (title, body, author, head/base, mergeability, ciSummary, isMerged/isClosed, openedAt)
     PullRequestTimelineItems (with cursor pagination — collects all pages up to a configured cap)
     PR-root issue-level comments (paginated; read-only)
     Existing review-comment threads (paginated; read-only)
  ↓
IReviewService.GetTimelineAsync(prRef)
  → PullRequestTimelineItems already fetched above; this method exists for direct unit-test
    access against the clustering algorithm. Inside GetPrDetailAsync, the timeline shape
    is also computed and passed forward so the clustering input is composed once.
  ↓
WeightedDistanceClusteringStrategy.Cluster(ClusteringInput, coefficients)
  → IterationCluster[] (numbered, with before/after SHAs and commit lists)
  ↓
PrDetailSnapshot { Pr, Iterations, RootComments, ReviewComments } cached per (prRef, headSha)
  → returned as PrDetailDto
```

The diff is a **separate** fetch (`GET /api/pr/{ref}/diff?range=base..head`) because it changes per iteration tab and Compare picker selection. `IReviewService.GetDiffAsync(prRef, range)` makes **two GitHub calls** (one of them already cached from the PR-detail load):

1. `GET /repos/{o}/{r}/pulls/{n}/files` — paginates via `Link rel="next"` to collect the file list (GitHub's hard cap is 3000 files / 30 pages).
2. `GET /repos/{o}/{r}/pulls/{n}` — already fetched and cached as part of `GetPrDetailAsync`; we only need its `changed_files` integer.

The two compose into `DiffDto { range, files: FileChangeDto[], truncated: bool }`. **Truncation is derived**: `truncated = (pull.changed_files > files.Length)` — i.e., GitHub knows the real file count and reports it, so any shortfall in our assembled list (whether from the implicit `compare` 300-file cliff for cross-iteration ranges or the `pulls/{n}/files` 3000-file ceiling) surfaces as a count mismatch. The `compare` endpoint's truncated behavior is only documented in prose and the response body carries no `truncated` field, so we do NOT call it for this purpose; `pull.changed_files` is the canonical signal.

File content for `.md` rendering and word-diff is `GET /api/pr/{ref}/file?path=&sha=`. The endpoint validates `(path, sha)` against the loaded `PrDetailSnapshot` (rejects 422 if the path is not in the PR's diff). Response is capped at 5 MB; oversize files return 413. Cached per `(file, sha)` for the page session lifetime.

`IPrDetailLoader` is a thin coordinator in `PRism.Core/PrDetail/`. The clustering algorithm is unit-testable against in-memory `ClusteringInput` without touching GitHub.

### 6.2 Active-PR poller and SSE per-PR fanout

```
EventsEndpoints
  GET    /api/events                       → SseChannel.AddSubscriber(response)
                                              generates 256-bit Guid subscriberId;
                                              emits "event: subscriber-assigned\ndata: { subscriberId }\n\n"
                                              as the first SSE message;
                                              subsequent heartbeat every 25 s as a NAMED event:
                                                "event: heartbeat\ndata: {}\n\n"
                                                (NOT a `:heartbeat` comment line — comments are
                                                 invisible to browser EventSource onmessage and
                                                 cannot drive the frontend silence-watcher)
                                              subscriberId is in-memory only, lifetime = SSE connection
  POST   /api/events/subscriptions         body: { subscriberId, prRef }   (subscriberId in body, NEVER query string)
                                            → ActivePrSubscriberRegistry.Add(subscriberId, prRef)
  DELETE /api/events/subscriptions         body: { subscriberId, prRef }
                                            → ActivePrSubscriberRegistry.Remove(subscriberId, prRef)

ActivePrPoller (BackgroundService)
  loop every config.polling.activePrSeconds (default 30):
    wait until ActivePrSubscriberRegistry.UniquePrRefs.Count > 0
    for each unique prRef:
      if ActivePrPollerState[prRef].nextRetryAt > now: skip this tick (per-PR backoff isolation)
      try:
        poll pulls/{n}                                (head SHA, mergeability, state)
        poll pulls/{n}/comments?per_page=1            (Link rel=last → count)
        poll pulls/{n}/reviews?per_page=1             (Link rel=last → count)
        if (headSha changed) or (commentCount changed):
          Publish(ActivePrUpdated { prRef, headShaChanged, commentCountChanged, newHeadSha?, newCommentCount? })
        update ActivePrPollerState[prRef]; clear backoff
      on 4xx/5xx:
        ActivePrPollerState[prRef].nextRetryAt = now + min(2^errorCount × 30s, 5min)
        log; continue to next prRef (no global pause)

SseChannel.Publish(ActivePrUpdated evt)
  for each subscriber subscribed to evt.prRef:
    using a CancellationTokenSource with 5 s timeout:
      response.WriteAsync($"event: pr-updated\ndata: {json}\n\n")
      await response.Body.FlushAsync(cts.Token)
    on timeout / pipe error: drop subscriber, close response

idle-eviction loop (separate timer, 60 s tick):
  for each subscriber where lastClientActivity > 15 min ago:
    drop subscriber
  // lastClientActivity is updated on every successful flush (heartbeats included),
  // so a healthy connection never trips eviction; a connection where TCP-close went
  // unobserved is GC'd within 15 min.

cache-invalidation on coefficient hot-reload:
  IterationClusteringCoefficients is hot-reloaded via FileSystemWatcher (S0+S1 pattern).
  PrDetailSnapshot is cached per (prRef, headSha, coefficientsGeneration). When the
  coefficients change, `coefficientsGeneration` increments; the next snapshot lookup
  misses and recomputes. Without this, a 110-commit PR clustered under
  `skipJaccardAboveCommitCount = 100` would keep showing the Jaccard-skipped clustering
  even after the user raises the cap to 200.
```

Three design notes worth pinning:

- **Per-PR poll is independent of subscriber count for that PR.** If three browser tabs all subscribe to the same PR, the poll runs once and the event fans out three times. Polling cost scales with unique PRs, not subscribers.
- **Per-PR backoff isolation.** A flaky PR doesn't starve healthy PRs. Each `ActivePrPollerState[prRef]` carries its own `nextRetryAt`; the poller skips backed-off PRs but continues polling the rest at the normal cadence.
- **Reload doesn't write to `ActivePrPollerState`.** When a Reload causes a new `LoadAsync`, the page shows the new state but the poller's state machine continues from its last poll. The next tick after Reload sees no diff and won't republish.

**SubscriberId trust model.** SubscriberId is treated as a process-local capability token. It is 256-bit cryptorandom (a `Guid` generated server-side), held only in `SseChannel`'s in-memory map, invalidated when the SSE connection closes, and never logged (it's transmitted in request bodies, not query strings, to keep it out of access logs). A leaked subscriberId remains valid only as long as the underlying SSE connection lives. Combined with the `X-PRism-Session` header check on POST/DELETE, this defends against CSRF and against sibling-process replay.

**OS-suspend / network-blink resilience.** When the OS suspends and resumes 17+ minutes later, the backend's idle-eviction has dropped the subscriber but the frontend's queued subscribe POSTs (issued pre-suspend) still carry the old subscriberId. On resume, those land as 404s while the EventSource silence-watcher independently triggers a reconnect. To prevent the two recovery paths from racing: every subscribe POST is fired with an `AbortController.signal` keyed to the current ready-state Promise generation. When the Promise re-resets (any reconnect, any 404), all in-flight subscribe POSTs are aborted by the frontend before the new POSTs fire against the new subscriberId.

### 6.3 State decomposition and migration

```csharp
// PRism.Core/State/AppState.cs — top-level shape unchanged from S0+S1
public sealed record AppState(
    int Version,                                                     // 1 → 2 (sequential int)
    IReadOnlyDictionary<string, ReviewSessionState> ReviewSessions,
    AiState AiState,
    string? LastConfiguredGithubHost)
{
    public static AppState Default { get; } = new(
        Version: 2,
        ReviewSessions: new Dictionary<string, ReviewSessionState>(),
        AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
        LastConfiguredGithubHost: null);
}

// PRism.Core/State/ReviewSessionState.cs — adds ViewedFiles
public sealed record ReviewSessionState(
    string? LastViewedHeadSha,
    string? LastSeenCommentId,
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    IReadOnlyDictionary<string, string> ViewedFiles);   // filePath → headShaAtTimeOfMark
```

#### On-disk JSON shape

Legacy v1:

```json
{
  "version": 1,
  "review-sessions": {
    "owner/repo/123": {
      "last-viewed-head-sha": "...",
      "last-seen-comment-id": "...",
      "pending-review-id": null,
      "pending-review-commit-oid": null
    }
  },
  "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
  "last-configured-github-host": "github.com"
}
```

S3 (v2):

```json
{
  "version": 2,
  "review-sessions": {
    "owner/repo/123": {
      "last-viewed-head-sha": "...",
      "last-seen-comment-id": "...",
      "pending-review-id": null,
      "pending-review-commit-oid": null,
      "viewed-files": { "src/Foo.cs": "abc123" }
    }
  },
  "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
  "last-configured-github-host": "github.com"
}
```

#### Migration helper

```csharp
// PRism.Core/State/AppStateStore.cs — adds a private static helper + a read-only flag
private const int CurrentVersion = 2;

// Set to true when LoadAsync sees a future-version state.json.
// Inspected by SaveAsync; when true, save attempts are blocked (returns false to caller, surfaces banner).
internal bool IsReadOnlyMode { get; private set; }

private JsonNode MigrateIfNeeded(JsonNode root)
{
    var versionNode = root["version"];
    if (versionNode is null)
        // Missing version is the existing AppStateStore.LoadAsync contract: quarantine + default.
        // The migration helper does NOT silently default to v1.
        throw new UnsupportedStateVersionException(0);

    var stored = versionNode.GetValue<int>();

    if (stored > CurrentVersion)
    {
        // Forward-incompat: load best-effort, but mark read-only so SaveAsync refuses subsequent writes.
        // The previous "best-effort with silent field drop on save" behavior was reverted —
        // it would corrupt v3+ pendingreview-IDs introduced by S4/S5 on downgrade-then-resave.
        IsReadOnlyMode = true;
        return root;
    }

    if (stored < 2) root = MigrateV1ToV2(root);
    IsReadOnlyMode = false;
    return root;
}

private static JsonNode MigrateV1ToV2(JsonNode root)
{
    // Idempotent: if a session already has viewed-files, leave it.
    var sessions = root["review-sessions"]?.AsObject();
    if (sessions is not null)
    {
        foreach (var (_, session) in sessions)
        {
            session!["viewed-files"] ??= new JsonObject();
        }
    }
    root["version"] = 2;
    return root;
}
```

`AppStateStore.LoadAsync` parses the file to `JsonNode`, calls `MigrateIfNeeded(root)`, then `root.Deserialize<AppState>(jsonOptions)`. **`SaveAsync` checks `IsReadOnlyMode` first**: if true, it returns without writing and the caller surfaces the read-only banner (the user can read state but cannot mutate it until the binary is upgraded). Otherwise, `SaveAsync` always writes at `CurrentVersion`. Tests are scoped to the public `LoadAsync` / `SaveAsync` boundary; no `InternalsVisibleTo` is needed for the migration helper. Test cases: legacy → v2, v2 → unchanged, missing-version throws (matches existing `AppStateStore` behavior), future-version → load succeeds + save fails + banner triggered, idempotent re-migration, malformed JSON → quarantine + default.

When S4 introduces migration #2, the `if (stored < 2) ...` chain extracts into the framework per ADR-S4-2.

### 6.4 Iteration clustering pipeline

```
IReviewService.GetTimelineAsync(prRef)
  → ClusteringInput {
      Commits:         [{ sha, committedDate, message, additions, deletions, changedFiles[] }],   ← changedFiles via REST fan-out
      ForcePushes:     [{ beforeSha?, afterSha?, occurredAt }],                                   ← ? = nullable after GitHub GC
      ReviewEvents:    [{ submittedAt }],
      AuthorPrComments:[{ authoredAt }]
    }

    Implementation note: per-commit changedFiles is fetched via REST GET /repos/{o}/{r}/commits/{sha}
    fan-out (concurrency cap 8). GraphQL's Commit type does not expose changed-file paths.
    A single PR with N commits costs N additional REST calls. For PRs with > 100 commits, we
    add a config switch `iterations.skipJaccardAboveCommitCount` (default 100) that disables
    Jaccard for that PR — the multiplier returns 1.0 — to bound rate-limit consumption.

WeightedDistanceClusteringStrategy.Cluster(input, coefficients)
  if input.Commits.Length <= 1:
      return single iteration   (short-circuit)
  
  sort commits by committedDate
    // committedDate (not authoredDate) — refreshed by --amend / rebase, more reliable
    // for ordering. authoredDate can lie about timeline position after history rewrites.
  
  for each consecutive pair (c_i, c_{i+1}):
    Δt = max(0, committedDate(c_{i+1}) - committedDate(c_i))
      // clamp to zero — defends against bad clocks producing negative gaps
    multiplier = product of all IDistanceMultiplier impls in DI:
      - FileJaccardMultiplier:    1 - 0.5 × jaccard(files(c_i), files(c_{i+1}))
                                  (returns 1.0 if either commit has unknown changedFiles)
      - ForcePushMultiplier:      1.5 if ∃ forcePush in (c_i, c_{i+1}] AND Δt > forcePushLongGapSeconds else 1.0
                                  (force-pushes with null SHAs are positioned by occurredAt)
    weighted_d[i] = max(HARD_FLOOR_5MIN, min(HARD_CEILING_3DAYS, Δt × multiplier))
  
  // Degenerate-case detector: if > 50% of weighted_d are clamped to HARD_FLOOR_5MIN,
  // the algorithm has insufficient signal — fall back. But:
  //   (a) cap the fallback at `iterations.maxFallbackTabs` (default 20): the
  //       IterationTabStrip is sized for "Last 3 inline + dropdown," not 100.
  //   (b) GATE the fallback by `weighted_d.Length >= MadK * 2` so small-N tight-
  //       amend cases (3-5 commits with sub-floor gaps) don't spuriously trigger
  //       fallback; the MAD path produces a single cluster correctly when all
  //       weighted distances are equal (no edge exceeds median + 1).
  if (weighted_d.Length >= coefficients.MadK * 2
      AND count(d == HARD_FLOOR_5MIN for d in weighted_d) > 0.5 × weighted_d.Length):
      if commits.Length <= coefficients.MaxFallbackTabs:
          return one cluster per commit
      else:
          return single "inconclusive" cluster covering all commits
  
  threshold = MadThresholdComputer.Compute(weighted_d, k = coefficients.MadK)
  
  boundaries = indices where weighted_d[i] > threshold
  emit IterationCluster[] partitioned at those boundaries

  // Force-push positioning when SHAs are GC'd:
  //   For force-push events with null beforeSha/afterSha, position by occurredAt.
  //   Apply the same skepticism as committedDate: clamp `max(0, occurredAt - prevCommit.committedDate)`
  //   so a server-clock-vs-committer-clock skew can't fabricate a long-gap multiplier
  //   on what is actually a co-located force-push.
```

`IDistanceMultiplier` is the strategy slot. Adding the four future multipliers is purely additive: drop a new class into the namespace, register it in DI, no change to `WeightedDistanceClusteringStrategy`.

Coefficients (`IterationClusteringCoefficients`) come from config:

```jsonc
"iterations": {
  "clustering-coefficients": {
    "file-jaccard-weight": 0.5,
    "force-push-after-long-gap": 1.5,
    "force-push-long-gap-seconds": 600,
    "mad-k": 3,
    "hard-floor-seconds": 300,
    "hard-ceiling-seconds": 259200,
    "skip-jaccard-above-commit-count": 100,
    "degenerate-floor-fraction": 0.5,
    "max-fallback-tabs": 20
  }
}
```

Force-push as a multiplier (rather than a hard boundary) is a deliberate departure from the spec § 3 wording. The algorithm doc reframes it as a soft signal whose strength scales with the time gap; `ForcePushMultiplier` returns `1.5` only when the gap exceeds `force-push-long-gap-seconds`, otherwise `1.0`. Spec § 3's iteration-reconstruction text gets rewritten accordingly (Section 9).

## 7. Frontend architecture

### 7.1 Page composition

```
PrDetailPage (route /pr/:owner/:repo/:number)
  ├─ on mount:
  │   1. usePrDetail({ prRef })                      — fetches /api/pr/{ref}; renders skeleton while pending
  │   2. on success: POST /api/pr/{ref}/mark-viewed { headSha, maxCommentId }   (with X-PRism-Session header)
  │   3. POST /api/events/subscriptions { subscriberId, prRef }                  (awaits subscriber-assigned ready gate)
  ├─ on unmount:
  │   DELETE /api/events/subscriptions { subscriberId, prRef }
  ├─ PrHeader            (title, branch, mergeability chip, CI chip, VerdictPicker disabled, Submit disabled)
  ├─ PrSubTabStrip       (Overview / Files / Drafts; Drafts greyed disabled — `aria-disabled="true"`, hover tooltip "Drafts arrive in S4"; keyboard Tab skips it)
  ├─ BannerRefresh       (visible iff useActivePrUpdates() reports an update for this prRef since last load)
  └─ <Outlet>            — renders OverviewTab | FilesTab | DraftsTabDisabled
```

The `mark-viewed` endpoint is its own POST (not folded into `GET /api/pr/{ref}`) because Q2's decision keeps it idempotent on first-mount but distinct from re-fetches. Reload triggers a new `GET /api/pr/{ref}` but does NOT call `mark-viewed`. Re-mounting the page (navigate away and back) calls both.

### 7.2 Files tab

```
FilesTab
  ├─ IterationTabStrip (sticky)
  │   ├─ "All changes" tab
  │   ├─ Last 3 numbered iteration tabs inline
  │   ├─ "All iterations ▾" dropdown (older iterations)
  │   └─ ComparePicker [Iter X ▾] ⇄ [Iter Y ▾]   (auto-swap, same-iter empty state)
  │
  ├─ FileTree (left pane)
  │   ├─ Header: "Files · N/M viewed" + filter icon (filter clicking shows "Filtering lands in S6" tooltip — UI stub)
  │   ├─ Tree nodes from treeBuilder.ts:
  │   │   - DirectoryNode: smart-compacted path, viewed-rollup count, chevron, recursive children
  │   │   - FileNode: status icon, path basename, +adds/-dels, viewed checkbox, AI focus dot column (column reserved 16px even when off, to avoid layout shift on aiPreview toggle)
  │   ├─ Selected file highlighted with focus ring; j/k navigate within the tree (visiting only file nodes; wraps at end)
  │   └─ v on the selected file toggles viewed (animated transition; directory rollup re-counts synchronously)
  │
  └─ DiffPane (right pane)
      ├─ Diff for currently-selected file at the iteration's range
      ├─ react-diff-view side-by-side OR unified (toggle d, persisted to ui prefs in state.json — minimal field add)
      ├─ Three lines of context per hunk
      ├─ Shiki syntax highlighting (single shared instance)
      ├─ jsdiff word-level highlighting overlay on changed lines
      ├─ Existing comment widgets inline between code lines (read-only); multiple threads at the same line stack in one widget
      ├─ AiHunkAnnotation widgets — never inserted (PoC); placement geometry: above hunk header, gutter-aligned, max-width matches hunk width
      ├─ DiffTruncationBanner if DiffDto.truncated === true
      └─ For .md files: MarkdownFileView with toggle "Rendered / Raw diff" (default Rendered; toggle persists per-PR in session state, not state.json)
```

`treeBuilder.ts` is a pure function: takes `FileChange[]` → tree nodes with smart compaction applied.

**File-viewed semantics.** Two modes depending on whether per-commit `changedFiles` data is available:

- **Default mode (PR ≤ `iterations.skipJaccardAboveCommitCount`, default 100 commits):** A file is viewed iff `ViewedFiles[path]` exists AND **every commit in the PR's commit graph between `ViewedFiles[path]` and `prDetail.headSha` has known `changedFiles` AND none of them touched this path**. The lookup walks the full PR commit graph, not just clustered iterations — merge commits, rebases-onto-main, and any commit excluded from clustering are still considered. For commits with unknown `changedFiles` (rare; truncation), the rule treats the path as **possibly touched** — the checkbox resets. This errs on "not-viewed when uncertain," matching truthful-by-default.
- **Skipped-Jaccard mode (PR > 100 commits, where the per-commit REST fan-out is bypassed):** A file is viewed iff `ViewedFiles[path] == prDetail.headSha` — exact-SHA match only. **No graph walk.** This avoids the failure mode where every viewed mark resets every page load on huge PRs because every commit's `changedFiles` is unknown. The cost: any new iteration on a >100-commit PR resets every viewed mark, even on files the new iteration didn't touch. Documented trade-off; surface area for huge PRs is rare in dogfooding and the alternative (per-commit fan-out on every viewed-check) violates the cap's rate-limit defense.

When a file flips from viewed → not-viewed because of a new iteration, the row animates a brief reset using the design system's `--t-med` token (150 ms ease-out fade on the checkmark — matches the handoff's `--t-med` declaration; the earlier 200 ms value was outside the token scale). The directory rollup re-counts synchronously. No banner; the row's visual state is the signal.

**Per-file viewed-checkbox in-flight state.** Clicking the checkbox triggers an **optimistic toggle** — the UI flips immediately and the `POST /api/pr/{ref}/files/viewed` request fires in parallel. On 204, the optimistic state stands. On 422 (`/viewed/cap-exceeded` or `/viewed/path-not-in-diff`) or 409 (`/viewed/stale-head-sha`), the UI **rolls back** the visual state and surfaces a brief inline toast on the row ("can't mark — try Reload" for stale-head-sha; "viewed limit reached, reset via Settings" for cap-exceeded). The directory rollup re-counts after rollback. While the request is in flight, the checkbox's hover/focus state is suppressed (no double-click compounding requests).

**AI focus dot column accessibility.** The 16 px column (reserved even when `aiPreview` is off, to avoid layout shift on toggle) renders a small dot when `aiPreview === true` and the file has an AI focus rating. Each dot has `role="img"` + `aria-label="AI focus: <high|medium|low>"`; rows without a dot still render an `aria-hidden="true"` placeholder span at the same width. Screen readers announce the focus rating after the file path; muted rows (viewed) keep their normal label.

### 7.3 Overview tab

```
OverviewTab
  ├─ AiSummaryCard       (gated on useCapabilities()["ai.summary"])
  │                      Three states explicitly:
  │                        - capability off: card not rendered; container reserves 0px
  │                        - capability on, aiPreview off: card not rendered; container reserves 0px
  │                        - capability on, aiPreview on:  card renders with PlaceholderPrSummarizer's canned content
  │                      (PoC default is capability off; see PRism.AI.Contracts/Capabilities/.)
  ├─ PrDescription       (rendered Markdown of pr.body via MarkdownRenderer)
  ├─ StatsTiles          (files / drafts = 0 / threads / viewed N/M)
  ├─ PrRootConversation  (read-only thread of issue-level comments; no "Mark all read" button — that lands when reply composer ships in S4)
  └─ ReviewFilesCta      (primary button "Review files" + footer kbd hints "j next file · k previous · v mark viewed")
```

**Visual hierarchy.** With aiPreview on, `AiSummaryCard` is the hero (handoff's `overview-card-hero` + `ai-tint` accent gradient). With aiPreview off (PoC default), `PrDescription` gets the **non-AI hero treatment**: same 12 px radius (`--radius-4`) and 20 px padding (`var(--s-5)`) as the AI hero, but with a 3 px accent-color left border (`--accent`) instead of the gradient tint, and slightly larger leading-row typography (PR title rendered above the body in `--text-md` weight 600). This avoids the four-equal-weight-cards generic-dashboard pattern; the description anchors the page visually whether or not AI is on. Stats tiles sit below the hero. Conversation comes after stats. CTA sits at the bottom of the column. Single-column layout below `1180px`; two-column layout above (description + conversation in the wide column, stats in the narrow side). The handoff's `overview-grid` + `overview-card-hero` + `overview-cta` class names port directly; an additional `overview-card-hero-no-ai` modifier ports the non-AI hero treatment.

`PrRootConversation` does NOT include a "Reply to this PR…" button in S3 (composer lands in S4). The footer renders static copy: *"Reply lands when the comment composer ships in S4."*

### 7.4 SSE consumer

A single `useEventSource` hook at the App level:

- Opens `EventSource('/api/events')` on App mount; closes on unmount.
- Parses four event types: `subscriber-assigned` (handshake), `heartbeat` (silence-watcher reset), `inbox-updated` (S2), `pr-updated` (S3).
- Holds a `Promise<string>` for `subscriberId` that resolves when the first `subscriber-assigned` event lands. Every subscribe POST awaits this promise before firing — no race between component mount and SSE handshake. **Subscribe POSTs are issued with an `AbortController.signal` keyed to the current Promise generation; on reconnect (Promise re-resets), all in-flight POSTs are aborted before new ones fire against the new subscriberId.**
- On reconnect, the promise re-resets (a new pending `Promise<string>`) and the frontend re-emits subscribe RPCs for every active PR using the new subscriberId once the new handshake completes.
- **35 s silence-watcher** resets on every received message — `subscriber-assigned`, `heartbeat`, `inbox-updated`, `pr-updated`. With heartbeat firing every 25 s, one missed heartbeat is tolerated; two consecutive misses (>50 s of silence) trip the watcher: `eventSource.close()` then `new EventSource(...)`. This recovers from middleboxes that keep TCP alive but stop forwarding bytes.
- On 401 from any mutating endpoint (`type: /auth/session-stale` indicating `X-PRism-Session` rejection): force a full-page reload to refresh the session cookie. This is the documented recovery path for backend-restart token rotation.
- Pushes received events into a typed event bus (zustand or React Context — matches S2's existing infrastructure).
- Reconnect handled natively by EventSource; the frontend tracks the set of currently-subscribed PR refs so it can re-subscribe after reconnect.

### 7.5 Routing

Existing routes (from S2):

```
/                         → InboxPage
/pr/:owner/:repo/:number  → S3StubPrPage     ← REPLACED in S3 by PrDetailPage
```

New routes (S3):

```
/pr/:owner/:repo/:number                        → PrDetailPage (default → Overview tab)
/pr/:owner/:repo/:number/files                  → PrDetailPage (Files tab active)
/pr/:owner/:repo/:number/drafts                 → PrDetailPage (DraftsTabDisabled active)
/pr/:owner/:repo/:number/files/*?iter=N         → Files tab with the named file selected at iter N (filePath via wildcard route to support nested paths)
```

A deep link to a specific file/iter survives reload. URL paste from S2's escape hatch lands directly on these routes.

### 7.6 Interaction-state matrix

Every fetched surface declares loading / empty / error / partial states.

**Skeleton timing pattern (delayed-spinner).** Skeletons follow a delayed-spinner rule, not "always show for ≥ N ms": the loading skeleton **does not render until the response has been pending for 100 ms**, and once shown holds for at least 300 ms. Localhost cache hits (typical: < 20 ms) never show the skeleton at all, so there's no artificial latency on the happy path. Slow responses get a stable skeleton (no sub-100 ms flicker). Implemented with a small `useDelayedLoading` hook.

| Surface | Loading | Empty | Error | Partial |
|---|---|---|---|---|
| `GET /api/pr/{ref}` | Delayed skeleton: header bar + 3-tab strip + body grid placeholder. Renders only if pending > 100 ms; holds ≥ 300 ms. | Empty PR (no commits beyond base): file tree empty + spec § 3 placeholder copy. | RFC 7807 banner per § 10. Page chrome stays interactive; tabs render their own error states. | n/a (single fetch). |
| `GET /api/pr/{ref}/diff?range=` | Diff pane delayed skeleton (file tree stays populated; the previously-selected file's diff shows a brief fade-out then skeleton if pending > 100 ms). | Empty range (Compare picker same-iter): "No changes between Iter X and Iter X." | Diff pane only — file tree stays interactive. | `truncated: true` → diff renders + DiffTruncationBanner footer. |
| `GET /api/pr/{ref}/file?path=&sha=` | `.md` rendered view: small delayed spinner inside the view. | n/a (path is in diff per authz). | "This file can't be rendered as text" placeholder (415); "File too large to render in PRism — open on github.com" (413); raw-diff toggle still available. | n/a. |
| Existing comment threads | Comment widgets render with reduced opacity until thread bodies arrive (already in `PrDetailDto`). | "No review comments yet" line below the diff hunks. | Per-thread error widget; other threads keep rendering. | n/a. |
| Mermaid block | "Loading diagram…" placeholder while the lazy module imports. | n/a. | "Mermaid render failed" indicator + raw fenced code block. | n/a. |
| `AiSummaryCard` (placeholder) | n/a (synchronous in PoC). | n/a (when off: card not rendered). | n/a. | n/a. |
| Compare picker (`GET /diff?range=` triggered by picker change) | Picker shows pending-state spinner inside the active selector chip; diff pane delayed-skeletons separately. | Same-iter empty state mirrors the diff-range row. | Inline error chip on the picker; previously-rendered diff stays visible until user clicks again. | n/a. |
| Per-file viewed-checkbox toggle | Optimistic UI flip; checkbox `aria-busy="true"` while POST in flight; suppressed hover/focus (no double-click compounding). | n/a. | Visual rollback on 422/409; brief inline toast on the row ("can't mark — try Reload" / "viewed limit reached"). Directory rollup re-counts after rollback. | n/a. |

### 7.7 Breakpoint convention

PR detail uses one breakpoint, analogous to the inbox's 1180px convention:

- **≥ 1180px**: Overview tab is two-column (description + conversation in wide; stats tile column on narrow side). Files tab is two-pane (file tree 280px + diff pane fills).
- **< 1180px**: Overview tab is single-column (vertical stack). Files tab keeps two-pane but the file tree becomes a **collapsible left sheet (overlay, not push-content)**: chevron toggle in the Files header opens the sheet from the left edge with a translucent scrim over the diff pane; **selecting a file auto-collapses the sheet** so the diff regains full width; the chevron remains visible for re-opening. Focus traps inside the sheet while it's open (Esc closes; Tab cycles tree items). The diff pane fills the full width whenever the sheet is closed.
- **< 900px**: side-by-side diff mode auto-flips to unified for legibility (the user's `d` toggle still works; the auto-flip is a presentation default, not a state mutation).

### 7.8 Keyboard / focus management

- **On `PrDetailPage` mount**: focus moves to the active sub-tab control (`role="tab"`); screen readers announce tab name + state.
- **On sub-tab change** (Overview ↔ Files; Drafts is `aria-disabled` and Tab skips it): focus moves to the tab content's first interactive element. Overview → "Review files" CTA. Files → file tree's selected file (or first file if none selected).
- **On iteration tab change**: focus stays on the iteration chip. The previously-selected file persists across iteration switches if it still exists in the new range; otherwise selection moves to the first file in the new range.
- **On `BannerRefresh` appearance**: focus does NOT move (avoid hijacking the user's attention). The banner has `role="status"` and `aria-live="polite"` so screen readers announce it; the Reload button is reachable via Tab.
- **On Compare picker open**: focus traps inside the dropdown; Escape closes; focus returns to the picker chip.
- **`v`** on the selected file toggles viewed; the focus ring stays on the file row (does not move).
- **`d`** toggles diff mode globally for the Files tab; focus stays where it was.
- **Coexistence with the App-level keyboard handler from S0+S1.** The Files-tab shortcuts (`j`/`k`/`v`/`d`) live in a per-page handler that registers via `useEffect` on `PrDetailPage` mount and unregisters on unmount. The App-level handler (which owns global shortcuts like `?` for cheatsheet, `Esc` for modal close, `⌘K`/`Ctrl+K`) takes precedence. **Input-eating-keys guard** (per `design/handoff/README.md`): all keyboard handlers — App-level and per-page — short-circuit when `event.target` is a `<textarea>`, `<input>`, `<select>`, or any element with `contenteditable="true"`. This protects future S4 composer typing without requiring the composer's components to manage cancellation. Test coverage in `frontend/src/hooks/__tests__/useFilesTabShortcuts.test.tsx` asserts the guard fires for each input element type.

## 8. API surface

```
GET    /api/pr/{owner}/{repo}/{number}
       → 200  PrDetailDto {
                pr:              { ref, title, body, author, branches, mergeability, ciSummary, state, headSha, baseSha, isMerged, isClosed, openedAt },
                iterations:      IterationDto[],          // numbered, with beforeSha/afterSha/commits/range
                rootComments:    IssueCommentDto[],       // read-only
                reviewComments:  ReviewThreadDto[]        // read-only
              }
       → 404  { type: "/pr/not-found", prRef }
       → 401  { type: "/auth/expired" }

GET    /api/pr/{owner}/{repo}/{number}/diff?range=base..head
       → 200  DiffDto { range, files: FileChangeDto[], truncated: bool }
              // truncated derived: pull.changed_files (from cached pulls/{n}) > files.length
       → 404  if range references an unreachable SHA

GET    /api/pr/{owner}/{repo}/{number}/file?path=&sha=
       → 200  text/plain  (raw file content; for .md rendering and word-diff)
       → 404  { type: "/file/missing" } if file/sha missing
       → 413  { type: "/file/too-large" } if file > 5 MB
       → 415  { type: "/file/binary" } if file is binary
       → 422  { type: "/file/not-in-diff" } if (path, sha) is not in the loaded PR's diff
       → 422  { type: "/file/snapshot-evicted" } if the PR's PrDetailSnapshot is gone — frontend must refetch /api/pr/{ref} and retry

POST   /api/pr/{owner}/{repo}/{number}/mark-viewed                          [requires X-PRism-Session, non-empty Origin]
       body: { headSha, maxCommentId }
       → 204  writes lastViewedHeadSha + lastSeenCommentId into ReviewSessions[ref]
       → 409  { type: "/viewed/stale-head-sha" } if headSha != prDetail.headSha
       → 423  { type: "/state/read-only" } if state.json is in forward-incompat read-only mode (binary needs upgrade)

POST   /api/pr/{owner}/{repo}/{number}/files/viewed                         [requires X-PRism-Session, non-empty Origin]
       body: { path, headSha, viewed: bool }
       → 204  toggles per-file viewed; writes ReviewSessions[ref].ViewedFiles[path]
       → 422  { type: "/viewed/path-not-in-diff" } if path is not in the loaded PR's diff
       → 422  { type: "/viewed/path-too-long" } if path > 4096 bytes
       → 422  { type: "/viewed/cap-exceeded" } if ReviewSessions[ref].ViewedFiles already has 10 000 entries
       → 409  { type: "/viewed/stale-head-sha" } if headSha != prDetail.headSha
       → 423  { type: "/state/read-only" } if state.json is in forward-incompat read-only mode
       (Path travels in the body, not the URL — keeps the route static, avoids ASP.NET catch-all
        encoding traps with %2F / NFC-NFD / leading dots, lets the byte-length cap apply uniformly.
        Server canonicalizes the path to NFC and rejects requests with `..`/`.`/leading-`/`/trailing-`/`
        before the in-diff comparison. Comparison is exact UTF-8 byte equality with one of
        DiffDto.files[].path.)

GET    /api/events
       → 200  text/event-stream
              first event:   event: subscriber-assigned\ndata: { subscriberId }\n\n
              subsequent:    event: inbox-updated | pr-updated\ndata: {...}\n\n
              heartbeats:    :heartbeat (every 25 s)

POST   /api/events/subscriptions                                            [requires X-PRism-Session]
       body: { subscriberId, prRef }
       → 204  registers (subscriberId, prRef)
       → 404  { type: "/events/subscriber-unknown" }
       → 409  { type: "/events/already-subscribed" }      (idempotent)

DELETE /api/events/subscriptions                                            [requires X-PRism-Session]
       body: { subscriberId, prRef }
       → 204  always (idempotent)
```

All JSON is kebab-case-lowercase via the application's `JsonSerializerOptions` + `JsonStringEnumConverter` (per the wire-format conventions in CLAUDE.md). Errors use RFC 7807 `application/problem+json` with stable `type` slugs the frontend matches on. `prRef` is `{ owner, repo, number }` everywhere.

**Cross-origin defense.** All POST/DELETE endpoints listed above pass through two middleware layers, in this order:

1. **`OriginCheckMiddleware`** — MODIFIED in S3 to **reject empty/missing Origin** on POST/PUT/PATCH/DELETE (the existing implementation short-circuits to next on empty Origin; that exemption is removed). Origin must be one of the configured loopback patterns; otherwise 403 `{ type: "/auth/bad-origin" }`. Localhost dev (Vite at `:5173`) sends a non-empty Origin so legitimate dev traffic still flows.
2. **`SessionTokenMiddleware`** — NEW in S3. Reads the `X-PRism-Session` header; compares against the per-launch token in memory using `CryptographicOperations.FixedTimeEquals` (constant-time, no early-out on mismatch); emits 401 `{ type: "/auth/session-stale" }` on mismatch or absence. The frontend's `useEventSource` 401-handler does a full-page reload to re-fetch the index and rotate the cookie. The cookie is re-stamped on **every HTML response** (not only the first), so the index reload always picks up the current launch's token.

The two layers are complementary: Origin defends against cross-origin POSTs from arbitrary same-machine browser tabs; SessionToken defends against same-origin attempts from a stale tab whose cookie is from a previous launch.

**Backend-restart resilience.** If the backend restarts while a frontend tab is open: (a) EventSource reconnects natively; the frontend gets a fresh `subscriber-assigned` event; the ready-state Promise defers subscribe POSTs until then. (b) Mutating POST/DELETE attempts in flight at restart land against a backend that no longer recognizes the old session token — they get 401 `/auth/session-stale`, which triggers the full-page reload. The reload re-fetches the index, the new cookie is stamped, the frontend re-renders, and pending intent is lost (the user is back at the inbox; URL preserves their PR detail context). This is the documented contract; tests in `SessionTokenMiddlewareTests` cover it.

## 9. Documentation deliverables

This section enumerates every doc change S3 lands. The slice is not done until each row below ships.

### 9.1 New documents

| Path | Purpose |
|---|---|
| `docs/spec/iteration-clustering-algorithm.md` | Canonicalized copy of the user's algorithm doc; replaces `Downloads/pr-iteration-detection-algorithm.md` as the authority; linked from spec § 3. Documents all six multipliers (two live, four future) and the tuning approach. |
| `docs/specs/2026-05-06-s3-pr-detail-read-design.md` | This document. |
| `docs/plans/2026-05-06-s3-pr-detail-read.md` | Generated by the writing-plans skill after this design is approved. |

### 9.2 Edits to existing spec documents

| Doc | Change | Reason |
|---|---|---|
| `docs/spec/03-poc-features.md` § 3 "Iteration reconstruction" | Replace 60s-clustering policy with reference to `docs/spec/iteration-clustering-algorithm.md`; keep history-rewriting force-push and historical-SHA-unavailable cases (correctness, not policy); retire `iterations.clusterGapSeconds` config in favor of `iterations.clusteringCoefficients`; document the `committedDate` choice and the per-commit REST fan-out. | Q6 brainstorming + R1 review refinement. |
| `docs/spec/03-poc-features.md` § 3 "Layout (top to bottom)" | Move `<AiSummarySlot>` from "between sticky header and sticky iteration tabs" to "AI summary card on the Overview tab"; describe the three-tab strip (Overview / Files / Drafts) as the layer between PR header and per-tab content; iteration tabs render only on the Files tab. | Q1 brainstorming: handoff is canon. |
| `docs/spec/03-poc-features.md` § 3 "File tree" | Replace prose about a flat list with collapsible directory tree, smart-compaction note, per-directory viewed-rollup note, reset-on-open collapse-state note. | Q5b brainstorming. |
| `docs/spec/03-poc-features.md` § 3 "Viewed checkbox semantics" | Clarify that the lookup walks the full PR commit graph (not just clustered iterations); commits with unknown `changedFiles` cause the checkbox to reset (truthful-by-default). | R-review refinement (adversarial F6). |
| `docs/spec/03-poc-features.md` § 3 "PR view scope" | Add: "PR-root issue-level comments are rendered read-only on the Overview tab. The chronological PR conversation feed (commits + comments + reviews + status updates + force-push events in time order) remains out of scope." | Q4 brainstorming: narrow the exclusion. |
| `docs/spec/03-poc-features.md` § 3 "Banner refresh on PR update" + § 8 "Banner update model" | Note explicitly that Reload does NOT update `lastViewedHeadSha` / `lastSeenCommentId`; those write only on PR-detail mount. | Q2 brainstorming. |
| `docs/spec/03-poc-features.md` § 3 "Diff display" | Add: "Diff content uses two endpoints in tandem: `pulls/{n}/files` for the file list (paginated to 3000), `compare/{base}...{head}` for the `truncated` flag at the 300-file cap. Truncation surfaces a footer banner with a deep link to github.com." | Section 8 design decision. |
| `docs/spec/04-ai-seam-architecture.md` § `<AiSummarySlot>` | Relocate the slot's documented position from "between sticky header and iteration tabs" to "Overview tab hero card." Drop sticky-stack rationale; replace with Overview-tab placement rationale. | Q1. |
| `docs/spec/02-architecture.md` § "State schema (PoC)" | Document `ViewedFiles` per session (`filePath → headShaAtTimeOfMark`). Top-level shape unchanged; integer schema versions stand. | Section 6.3. |
| `docs/spec/02-architecture.md` § "Cross-origin defense for the localhost API" | S3 ships both layers per spec mandate: `OriginCheckMiddleware` modified to reject empty/missing Origin on POST/PUT/PATCH/DELETE; `SessionTokenMiddleware` added enforcing `X-PRism-Session` with constant-time comparison and 401 problem-slug `/auth/session-stale`; cookie re-stamped on every HTML response (not only first); frontend force-reload on 401 documented. Replace the architecture spec's brief mention with these contract details. | Section 8 (security review refinement). |
| `docs/spec/02-architecture.md` § "Schema migration policy" | Document the read-only-mode behavior for forward-incompat (`version > CurrentVersion`): app loads, banner surfaces, all mutating endpoints return 423 `/state/read-only` until binary upgrade. Replace any prior "best-effort recognized fields" or "quit cleanly" wording with the read-only-mode contract. | Section 6.3 + Section 10.4. |
| `docs/spec/00-verification-notes.md` § C2 | Update reference to iteration-reconstruction algorithm (point at the new doc). Add a `react-markdown` v9 sanitization-test note (analogous to the M19 / M20 / M21 verification notes). | Q6 + R-review refinement. |

### 9.3 Edits to the roadmap

`docs/roadmap.md`:

- **S3 row** — fill in spec status (`Shipped — specs/2026-05-06-s3-pr-detail-read-design.md`) on slice completion. Add: "Adds `ViewedFiles` field to `ReviewSessionState` + a single inline `MigrateV1ToV2` helper. Closes the spec-mandated `X-PRism-Session` middleware gap (security baseline; see § 8 design contract). ADR-S4-1 (`PrSessionsState` wrap) and ADR-S4-2 (migration framework) remain gated to S4."
- **Architectural readiness table** — ADR-S4-1 stays "open" (still gated to S4). ADR-S4-2 stays "open" (still gated to S4). Add a new "**Now → Shipped in S3**" row: *"`X-PRism-Session` + tightened `OriginCheckMiddleware` (security baseline mandated by `02-architecture.md` § Cross-origin defense). Landed in S3 alongside the first batch of state-mutating endpoints."* This documents that S3 closed the spec gap.
- **Tweaks panel comparison table** — diff-mode toggle row: change "Lands in slice" from "S3" to "S3 (shipped)" on slice completion.
- **AI placeholder behavior — per-slice rendering** — update the S3 row to enumerate the three placeholder slots (Overview AI summary card, file-tree focus dots, hunk annotation slot — the last only as an inserted-widget API capability, not actually inserted).

### 9.4 Edits to the architectural-readiness spec

`docs/specs/2026-05-06-architectural-readiness-design.md`:

- ADR-S4-1 — append: *"**Status (2026-05-06):** Considered for S3 pull-forward and rejected. S3 only adds `ViewedFiles` to `ReviewSessionState`; the wrap rename remains gated to S4 so it can land alongside S4's drafts/replies/reconciliation field additions in a single migration."*
- ADR-S4-2 — append: *"**Status (2026-05-06):** S3 ships a single inline `MigrateV1ToV2` helper method on `AppStateStore`. The migration framework (ordered chain of `(toVersion, transform)` steps) remains gated to S4 — extraction happens when S4 introduces migration #2."*

### 9.5 Items deferred from S3 — recorded so future slices know

| Item | Where it goes | When it lands |
|---|---|---|
| Comment composer / reply composer | Already in roadmap S4 row | S4 |
| Drafts tab activation | Add "S4 also activates the previously-disabled Drafts tab in the PR sub-tab strip" to the S4 row | S4 |
| PR-root conversation reply composer + "Mark all read" button | Note in spec § 3 Overview-tab subsection: "Reply composer + Mark-all-read on PR-root comments lands in S4 alongside the inline-comment composer" | S4 |
| `PrSessionsState` wrap (ADR-S4-1) | Architectural-readiness ADR-S4-1 stays gated to S4 | S4 |
| Migration framework (ADR-S4-2) | Lands when S4 introduces migration #2 | S4 |
| `IReviewService` capability split (ADR-S5-1) | Stays gated to S5 | S5 |
| Verdict picker enabled / Submit Review enabled | Already in S5 row | S5 |
| Whole-file diff expansion | Already in P4 backlog (`P4-B8`) | post-PoC |
| Markdown HTML allowlist (`<details>`, `<sub>`, `<sup>`, `<kbd>`, etc.) | Confirm P4 backlog entry; add if missing | post-PoC |
| Section / directory collapse-state persistence in `state.json` | Add to S6 row's settings consolidation | S6 / v2 |
| AI hunk annotations actually inserted into the diff | Already deferred (PoC: never inserted) | v2 |
| File-tree filter affordance | Stub clicks today; full implementation in S6 | S6 |
| Other four iteration-clustering multipliers (message keywords, diff size, review events, branch activity) | New backlog item: `P0-* — flesh out remaining iteration-clustering multipliers` | P0+ calibration |
| Iteration-clustering coefficient calibration workflow | New backlog item: `P0-* — coefficient tuning corpus + workflow` | P0+ calibration |

The two "new backlog item" rows above are net-new additions to `docs/backlog/`; S3 creates them so the deferred work has a documented home.

## 10. Error handling

### 10.1 GitHub API failures

| Failure | Backend behavior | Frontend behavior |
|---|---|---|
| 401 / 403 with revoked-token shape | Endpoints surface `{ type: "/auth/expired" }` | Banner: *"Token expired. Reconnect to continue."* + link to Setup. Already-loaded data stays visible read-only. |
| 404 on PR | `GET /api/pr/{ref}` → `{ type: "/pr/not-found" }` | Empty-state placeholder with the parsed PR ref + "Back to inbox" link. |
| 404 / 422 on diff range (unreachable SHA) | `GET /api/pr/{ref}/diff` → `{ type: "/diff/range-unreachable", range }` | Diff pane shows: *"This iteration's commits are no longer available on GitHub."* The iteration tab stays clickable; only the diff body shows the message. |
| 5xx from GitHub | `IReviewService` retries with exponential backoff up to 30 s; then returns `{ type: "/github/unavailable" }` | Banner: *"GitHub is unreachable. Retrying…"* with manual Retry. Already-loaded data stays visible. |
| Rate limit (`x-ratelimit-remaining: 0`) | Honor `x-ratelimit-reset`; queue background polls until then; user-initiated requests return `{ type: "/github/rate-limited", resetAt }` | Banner: *"GitHub rate limit reached. Resumes at HH:MM."* Active-PR poller pauses globally (the rate limit is account-scoped). |

### 10.2 Iteration clustering failures

| Failure | Behavior |
|---|---|
| `ClusteringInput.Commits.Length == 0` | Return zero iterations; emit "All changes" tab only; file tree renders the empty-PR placeholder. |
| `ClusteringInput.Commits.Length == 1` | Short-circuit to a single iteration containing that commit. |
| MAD threshold hits a degenerate case (all weighted distances equal) | Fall back to one-tab-per-commit; log a warning. |
| > 50% of weighted distances clamped to hard floor | Algorithm has insufficient signal; fall back to one-tab-per-commit; log a warning. |
| GitHub returns a malformed timeline event | Drop that event from `ClusteringInput`; log; continue. Don't fail the page load. |
| A commit's `changedFiles` REST fan-out fails or returns nothing | Treat that commit's file set as unknown; `FileJaccardMultiplier` returns `1.0` (neutral). The commit still participates in the timeline. |
| PR has > `iterations.skipJaccardAboveCommitCount` (default 100) commits | Skip the per-commit fan-out entirely for this PR; `FileJaccardMultiplier` returns `1.0` for every pair. Bounds rate-limit consumption on huge PRs. |
| `HeadRefForcePushedEvent.beforeCommit` / `afterCommit` is null (GitHub GC) | Position the force-push by `occurredAt` timestamp. `ForcePushMultiplier` still applies. |

### 10.3 SSE / subscription failures

| Failure | Behavior |
|---|---|
| Backend restart while frontend connected | EventSource reconnects natively; new `subscriber-assigned`; frontend re-subscribes every open PR. The ready-state Promise prevents POSTs against the stale subscriberId. |
| Subscribe POST returns 404 (stale subscriberId) | Frontend force-closes the EventSource; reconnects from scratch. |
| Subscribe POST returns 409 (already-subscribed) | Idempotent no-op. Logged at debug. |
| Active-PR poller throws on a single PR mid-tick | Catch; log; mark that PR for backoff (per-PR isolation); continue to the next subscribed PR. |
| SSE flush blocks > 5 s on a slow client | Drop the subscriber; close the response; the client's EventSource reconnects natively. |
| Idle eviction (no client activity for 15 min on `lastClientActivity`) | Drop the subscriber; close the response. The frontend's silence-watcher (35 s, allowing one missed heartbeat) notices and reconnects. |

### 10.4 State migration failures

| Failure | Behavior |
|---|---|
| `state.json` has `version > CurrentVersion` | **Read-only mode.** `MigrateIfNeeded` sets `AppStateStore.IsReadOnlyMode = true` and returns the file unchanged. `Deserialize<AppState>` runs against best-effort recognized fields. The app loads and operates as a viewer; **all save attempts are blocked** by `SaveAsync` and surface as 423 `{ type: "/state/read-only" }` on mutating endpoints. A startup banner surfaces: *"This `state.json` was written by a newer version of PRism. The app is in read-only mode; upgrade the binary to resume saving."* This protects against the silent-field-loss failure mode of a save-and-downgrade path: a v3+ pendingreview field S3 doesn't recognize would be lost on the next save. The user's options are (a) upgrade the binary, or (b) explicitly re-initialize state via Setup (clears `state.json`, drafts and bookkeeping start fresh). |
| `state.json` has missing `version` field | Throw `UnsupportedStateVersionException(0)` (matches the existing `AppStateStore.LoadAsync` contract). Quarantine + start with `AppState.Default` per the malformed-JSON path below. The migration helper does NOT silently default to v1 — a missing `version` is the file's own statement that something is off, and quarantining preserves the user's signal. |
| `state.json` malformed (invalid JSON or doesn't match v1 or v2 shape) | Log; back up as `state.json.corrupt-<timestamp>` (matches the existing `AppStateStore.cs` quarantine convention); start with `AppState.Default`. The user keeps their session but loses bookkeeping; the broken file is preserved. |
| Migration mid-flight write failure | `AppStateStore` uses temp-file + atomic rename; the legacy file stays intact until the new file is durable. If the rename fails, the next launch sees the legacy file and re-runs the migration. The migration is idempotent (re-applying to a v2 file is a no-op because `viewed-files` already exists on every session). |

### 10.5 File-tree / diff failures

| Failure | Behavior |
|---|---|
| `react-diff-view` throws on a malformed patch | Error boundary around `DiffPane`; render "could not display diff" placeholder; log **patch metadata only** (file path, hunk count, byte length) — never the patch body. Other files in the tree still render. |
| `.md` rendering throws (Mermaid syntax error, etc.) | Mermaid block specifically: catch and render the raw fenced code block with a small "Mermaid render failed" indicator. The rest of the file renders normally. |
| `.md` file is binary or unreadable | `GET /api/pr/{ref}/file` returns 415; frontend shows "this file can't be rendered as text" placeholder; raw-diff toggle still available. |
| `.md` file > 5 MB | `GET /api/pr/{ref}/file` returns 413; frontend shows "file too large to render in PRism — open on github.com" placeholder. |
| Markdown contains script-injection (`<script>`, `javascript:` URL) | `react-markdown` v9+ default schema strips it; renders as escaped text. The pinned vitest sanitization suite (Section 11.2) verifies this against an adversarial-input corpus. |

### 10.6 Edge cases

- **Empty-PR (no commits beyond base).** File tree empty + placeholder; submit disabled (already disabled in S3); banner refresh continues. Overview tab still renders (PR description, stats with `0 files / 0 threads`, "Review files" CTA disabled with hover tooltip).
- **Closed / merged PR while user is viewing it.** Header banner per spec § 3; submit disabled (already disabled). When the PR re-opens via poll, banner clears.
- **PR > 100 files (file list).** `pulls/{n}/files` paginates; backend collects all pages; frontend renders the full set.
- **PR > 300 files of diff content.** GitHub `compare` returns truncated; backend surfaces `truncated: true`; frontend renders `DiffTruncationBanner` with a deep link to github.com.
- **PR > 100 commits.** Per-commit `changedFiles` fan-out is skipped (config: `iterations.skipJaccardAboveCommitCount`); clustering relies on time gap + force-push only.

## 11. Testing strategy

The discipline from CLAUDE.md and S2 precedent: TDD throughout, no mocks of the system under test, mocks only at external boundaries, every behavior commit pairs a failing test with the implementation that turns it green.

### 11.1 The pyramid

```
  ┌─────────────────────────────────────────────┐
  │ contract tests (~5)                         │  PRism.GitHub.Tests.Integration
  │ real GitHub against frozen api-codex PR     │  manual / nightly CI only
  │ pinned to commit-SHA, not branch HEAD       │
  └─────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────┐
  │ web-API integration tests (~30)             │  PRism.Web.Tests
  │ WebApplicationFactory + FakeGitHubServer    │  every commit
  └─────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────┐
  │ unit tests (~75)                            │  PRism.Core.Tests + PRism.GitHub.Tests
  │ pure C# against fakes; pure React           │  + frontend (vitest)
  │ components against props                    │  every commit
  └─────────────────────────────────────────────┘
```

### 11.2 Unit-test surface

| Subject | Lives in | Test count | Why |
|---|---|---|---|
| `WeightedDistanceClusteringStrategy` | `PRism.Core.Tests/Iterations/` | ~16 | Single-commit short-circuit; force-push as multiplier; Jaccard at extremes (0, 1); MAD threshold against synthetic gap distributions; hard floor; hard ceiling; degenerate all-equal case → fallback; > 50% floor-clamped → fallback; **fallback caps at `maxFallbackTabs` (default 20) — > 20 commits → single "inconclusive" cluster, not 100 tabs**; coefficient changes flip clustering decisions deterministically; sort uses `committedDate`; negative-Δt clamps to zero; **occurredAt for null-SHA force-push clamps `max(0, occurredAt - prev.committedDate)`**. |
| `FileJaccardMultiplier` | same | ~5 | Disjoint files; full overlap; partial overlap; empty file-set handling; unknown-changedFiles signal returns neutral `1.0`. |
| `ForcePushMultiplier` | same | ~5 | No force push → `1.0`; force push within short gap → `1.0`; force push after long gap → `1.5`; multiple force-pushes in a window; force-push with null beforeSha/afterSha positioned by occurredAt. |
| `MadThresholdComputer` | same | ~4 | Bimodal distribution; single-mode distribution; single-element collection; constant-distance collection (degenerate). |
| `treeBuilder.ts` | `frontend/src/components/PrDetail/FilesTab/FileTree/__tests__/` | ~8 | Empty input; single file; deep single-child chain (smart compaction); siblings break compaction; per-directory rollup math; mixed file statuses. |
| `AppStateStore` migration (tested through public `LoadAsync` / `SaveAsync` boundary; no `InternalsVisibleTo` needed) | `PRism.Core.Tests/State/` | ~7 | Legacy v1 → v2 shape; idempotent on v2 input; preserves existing fields; defaults `viewed-files` to `{}`; idempotent on partial-migration input (`viewed-files` already present); future-version → load succeeds + `IsReadOnlyMode` flag set + `SaveAsync` returns false; missing-version → throws `UnsupportedStateVersionException(0)` (matches existing contract). |
| `ActivePrSubscriberRegistry` | `PRism.Core.Tests/PrDetail/` | ~6 | Add / remove / dedup; multi-subscriber for same PR; unique-PR-set computation; idempotent re-add; cleanup on subscriber drop. |
| `ActivePrPoller` per-PR backoff | same | ~5 | Healthy PR continues at 30s while flaky PR is in backoff; backoff expires on next-retry tick; reset on success; one PR's exception doesn't suppress others. |
| `MarkdownRenderer` (sanitization) | frontend vitest | ~14 | Adversarial-input corpus, sourced from OWASP HTML5 cheat sheet + Cure53 DOMPurify fixtures + `rehype-sanitize` regression tests. Categories: `<script>` rendered as escaped; `javascript:` autolink stripped; reference-style link `[x]: javascript:...` stripped; HTML-entity-obfuscated autolink (`&#106;avascript:`) stripped; `data:` URL in `<img>` stripped; `vbscript:` URL stripped; `<iframe>` stripped; `<object>` stripped; inline SVG with `<use href=>` / `<foreignObject>` / `<animate attributeName='href'>` stripped; `<style>` block + `style=` attribute (CSS injection vectors) stripped; MathML with `href` / event handlers stripped; `<base href=>` stripped; `<form action=>` stripped; raw-HTML allowlist verified empty. |
| Mermaid sanitization | frontend vitest | ~3 | Behavioral (not init-options spy): feed adversarial flow with `click ... javascript:...` directive, assert rendered SVG has no actionable JS; assert raw `<script>` in node label renders as text; assert `mermaid.initialize` was called with `securityLevel: 'strict'` (sanity check). |
| `PrDetailLoader` orchestration | `PRism.Core.Tests/PrDetail/` | ~10 | Each loader step calls expected `IReviewService` methods in expected order; failure of any step bubbles cleanly; cache hit/miss logic. |
| React components (header, sub-tab strip, file-tree row, banner, stats tiles, PR-root conversation, AI summary card, diff truncation banner, focus-on-mount) | frontend vitest | ~15 | Capability-flag-gated rendering; disabled-tab click is no-op; viewed-checkbox toggle; banner appearance / dismiss; AI off vs preview-on rendering; focus management. |

Total unit tests: ~75.

### 11.3 Web-API integration tests

`PRism.Web.Tests` already uses `WebApplicationFactory<Program>` with a `FakeGitHubServer` registered as the `IReviewService` backing implementation. S3 expands the fake to cover the new endpoints.

| Endpoint / scenario | Tests |
|---|---|
| `GET /api/pr/{ref}` happy path | 1 |
| `GET /api/pr/{ref}` 404 | 1 |
| `GET /api/pr/{ref}` 401 (token expired) | 1 |
| `GET /api/pr/{ref}/diff?range=` | 3 (base..head, iter range, malformed range) |
| `GET /api/pr/{ref}/diff` paginates `pulls/{n}/files` | 1 |
| `GET /api/pr/{ref}/diff` propagates `truncated: true` from `compare` | 1 |
| Pagination loop respects bound limit | 1 |
| `GET /api/pr/{ref}/file` happy path | 1 |
| `GET /api/pr/{ref}/file` 422 `/file/not-in-diff` when path not in diff | 1 |
| `GET /api/pr/{ref}/file` 422 `/file/snapshot-evicted` after cache clear | 1 |
| `GET /api/pr/{ref}/file` 413 when file > 5 MB | 1 |
| `POST /api/pr/{ref}/mark-viewed` | 3 (happy; idempotent re-call; 409 stale-headSha) |
| `POST /api/pr/{ref}/files/viewed` (path-in-body) | 5 (toggle on; toggle off; 422 path-not-in-diff; 422 cap-exceeded; 409 stale-headSha) |
| Body path canonicalization | 4 (rejects `..`, `.`, leading `/`, trailing `/`; rejects `%2F` differences after canonicalization) |
| `X-PRism-Session` enforcement on POST/DELETE | 4 (happy; rejected without header; rejected with stale-launch token; constant-time-comparison sanity) |
| `OriginCheckMiddleware` empty-Origin rejection | 2 (POST with empty Origin → 403 `/auth/bad-origin`; GET with empty Origin still allowed) |
| `423 /state/read-only` on mutating endpoints when state is in read-only mode | 1 |
| `GET /api/events` first-event contract | 1 (`subscriber-assigned` delivered first) |
| `POST /api/events/subscriptions` | 3 (happy; 404 on unknown subscriber; 409 on already-subscribed) |
| `DELETE /api/events/subscriptions` | 2 (happy; idempotent on already-removed) |
| Active-PR poll → `pr-updated` event end-to-end | 2 (head changed; comment count changed) |
| Active-PR poll: zero subscribers → poller idles | 1 |
| Active-PR poll: per-PR backoff isolation | 1 (PR A flapping; PR B continues to receive updates) |
| Active-PR poll: per-subscriber fanout | 1 (A & B subscribed to PR X get the event; C subscribed to PR Y doesn't) |
| State migration on cold-start | 4 (v1 file migrated; v2 file unchanged; future-version → read-only mode + saves blocked; missing-version → quarantine) |

Total: ~30.

### 11.4 Contract tests against the frozen `api-codex` PR

A new project `PRism.GitHub.Tests.Integration` with `[Trait("Category", "Integration")]`. Default `dotnet test` excludes the trait via runsettings; CI has a separate job that runs only the integration tests with a configured `PRISM_INTEGRATION_PAT` env var.

| Test | Purpose |
|---|---|
| `Frozen_pr_returns_expected_iteration_count` | Pin the iteration-cluster output against the locked PR. |
| `Frozen_pr_returns_expected_files_in_diff` | Confirms the diff-fetcher pagination and file shape against real bytes. |
| `Frozen_pr_existing_comments_have_expected_anchors` | Confirms comment-thread fetching against real wire shape. |
| `Frozen_pr_force_push_event_appears_in_timeline` | Smoke for force-push detection on a real timeline event. |
| `Frozen_pr_handles_pat_scope_validation_for_read_paths` | Confirms `IReviewService.ValidateCredentialsAsync` returns the expected scope set. |

**Frozen PR setup is one-off manual work.** Open a PR on `mindbody/Api.Codex` against `prism-validation`, push three iterations of varying shape (one normal cadence, one tight-amend cluster, one force-push), then **lock the conversation and the PR**. **Tests fetch by commit-SHA, not branch HEAD** — a config in the integration test project lists the expected SHAs. If a teammate or bot pushes to the source branch, tests still pass because they read the snapshot at the pinned SHA. Drift detection lives in a separate test (`Frozen_pr_graphql_shape_unchanged`) that asserts the raw GraphQL response shape against a checked-in fixture JSON, so GitHub-API-shape drift is decoupled from PR-data drift. **Failure-message contract**: when the shape test fails, it surfaces a structured field-by-field diff (`expected: <field>, got: <field>` with a list of added/removed/changed paths) so a triage engineer can identify which GraphQL field changed without manually diffing the fixture. The business-logic tests (`Frozen_pr_returns_expected_iteration_count`, etc.) include a hint in their failure message: *"If `Frozen_pr_graphql_shape_unchanged` is also failing, fix the fixture first; this assertion runs against the parsed shape."* A 30-minute fixture-rebuild procedure lives in the test project's README.

### 11.5 Iteration-clustering discipline check

A one-shot manual measurement run before locking S3 coefficients. Not part of the automated test suite. Implemented as a **`[SkippableFact]` test** (from `Xunit.SkippableFact`, see § 5) in `PRism.Core.Tests/Iterations/ClusteringDisciplineCheck.cs`. The test calls `Skip.IfNot(Environment.GetEnvironmentVariable("PRISM_DISCIPLINE_PR_REFS") != null)` at the top — so the test runs only when the env var is set, and is skipped otherwise. (Plain `[Fact(Skip="...")]` is unconditionally skipped and cannot un-skip via env var.)

1. Pick 3–5 PRs each from `bizapp-bff` and `mobile-business-gateway` covering: clean push cadence; heavy-amend cluster; force-push rebase; multi-day work; CI-amend pipeline.
2. For each PR, manually annotate where iteration boundaries should be (the developer is the source of truth — per the algorithm doc's tuning approach).
3. Run the test with the env var set: `PRISM_DISCIPLINE_PR_REFS="org/repo/123,org/repo/456" dotnet test --filter Discipline`.
4. Record per-PR: hand-labeled boundary count, algorithm boundary count, agreement %.
5. If aggregate agreement < 70%, tune coefficients; if still bad, fall back to one-tab-per-commit default.
6. Document results in this slice spec under "Iteration clustering — discipline-check observations" with date, PR set, and final coefficient values.

`mindbody-pos` and `Express Android` (under `C:\src\`) are reserved for later fine-tuning.

### 11.6 Frontend testing tooling

- **Vitest** + **React Testing Library** (S2 precedent).
- **`eventsource-mock`** (or 30-line in-house fake from S2's plan) for SSE.
- No Playwright / Cypress in S3. End-to-end browser testing is S6's territory (viewport-screenshot regression test).

### 11.7 Test-first slicing

Strawman PR sequence inside the S3 slice. The plan-writing step refines this; the design's job is to commit to the test layer for each concern.

| PR | Concern | Tests landed | Implementation landed |
|---|---|---|---|
| 1 | State migration | `AppStateStoreMigrationTests` (through public boundary) | Adds `ViewedFiles` to `ReviewSessionState`; private `MigrateV1ToV2` + `IsReadOnlyMode` flag on `AppStateStore`; LoadAsync wires it in; SaveAsync respects the flag |
| 2 | Iteration clustering core (incl. discipline-check harness) | `WeightedDistance...Tests` (incl. fallback-tab-cap + occurredAt clamp) + `FileJaccardMultiplierTests` + `ForcePushMultiplierTests` + `MadThresholdComputerTests` + `ClusteringDisciplineCheck` (`[SkippableFact]`) | `WeightedDistanceClusteringStrategy` + 2 multipliers + threshold + degenerate-case detector + fallback-tab-cap. Discipline check folds in here (one file, one skipped fact); recording results in § 12 still happens but isn't a separate PR. |
| 3 | `IReviewService` extensions | `GitHubReviewServiceTests` | New methods on `GitHubReviewService` (single GraphQL round-trip; dual-endpoint diff via `pulls/{n}/files` + `pulls/{n}` `changed_files`; per-commit fan-out for Jaccard; file content with size cap) |
| 4 | PR detail backend assembly | `PrDetailLoaderTests` + `PrDetailEndpointsTests` (incl. body-shape POST /viewed, 422/409/423 error shapes, path canonicalization) | `PrDetailLoader` + endpoints |
| 5 | SSE + active-PR poller + middleware | `ActivePrSubscriberRegistryTests` + `ActivePrPollerBackoffTests` + `EventsSubscriptionsEndpointTests` + `OriginCheckMiddlewareTests` (empty-Origin rejection on POST/DELETE) + `SessionTokenMiddlewareTests` | `ActivePrSubscriberRegistry` + `ActivePrPoller` (per-PR backoff) + `SseChannel` mods (named heartbeat event) + `OriginCheckMiddleware` mods + `SessionTokenMiddleware` (constant-time comparison, 401 problem-slug, cookie re-stamping on every HTML response) |
| 6 | Frontend PR detail shell | vitest tests for header / sub-tab strip / banner / focus-on-mount / 401-recovery-via-page-reload / OS-suspend AbortController behavior | `PrDetailPage` + routing replacement + `useEventSource` (named-heartbeat watcher, AbortController on subscribe) |
| 7 | Files tab — file tree | vitest for `treeBuilder.ts` + components + sub-1180px sheet open/close/focus-trap + AI focus dot aria-label + viewed-checkbox optimistic+rollback + keyboard input-eating-keys guard | `FileTree` + `treeBuilder` + `FilesTab` plumbing + breakpoint behavior + sheet component |
| 8 | Files tab — diff pane | vitest for `DiffPane`, `WordDiffOverlay`, `MarkdownRenderer` (14-input adversarial corpus), behavioral Mermaid sanitization | `DiffPane` + `react-diff-view` wiring + `jsdiff` overlay + Markdown pipeline |
| 9 | Overview tab | vitest for `OverviewTab` and children, including `overview-card-hero-no-ai` modifier | `OverviewTab` + `PrDescription` non-AI hero + `PrRootConversation` (read-only) + `StatsTiles` + AI placeholders |
| 10 | Doc updates | n/a (docs-only) | spec / roadmap / arch-readiness updates per § 9 |
| 11 | Contract tests + frozen PR creation | the 5 frozen-PR contract tests + `Frozen_pr_graphql_shape_unchanged` (structured-diff failure message) | `PRism.GitHub.Tests.Integration` project + frozen-PR setup pinned to commit-SHAs |

## 12. Iteration clustering — discipline-check observations

*To be filled in at slice completion. Template:*

> Tested against [N] PRs from `mindbody/Mindbody.BizApp.Bff` and `mindbody/Mindbody.Mobile.BusinessGateway` on [date]. Coefficients used: [final values]. Aggregate agreement with hand-labeled boundaries: [%]. Decision: [retain defaults / tune to X / fall back to one-tab-per-commit].
