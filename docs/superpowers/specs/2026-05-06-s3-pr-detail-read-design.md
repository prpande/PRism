# S3 — PR Detail (read): Design

**Slice**: S3 — third slice in [`docs/roadmap.md`](../../roadmap.md), follows the shipped S0+S1 and S2.
**Date**: 2026-05-06.
**Status**: Brainstormed; awaiting plan.
**Branch**: `feat/s3-pr-detail-spec` (worktree at `C:/src/PRism-s3-spec`).
**Source authorities**: [`docs/spec/`](../../spec/) is the PoC specification this slice implements; [`design/handoff/`](../../../design/handoff/) is the visual reference. This document does not restate the PoC spec; it commits to a specific subset, records deviations from spec text where the design handoff or implementation reality forced a different choice, and adds slice-specific decisions.

---

## 1. Goal

Make the PR detail surface real. Three sub-tabs — **Overview**, **Files**, **Drafts** — under the PR header, where Files is the diff workhorse, Overview is a contextual landing card, and Drafts is rendered as a disabled stub until S4. An active-PR poller drives a non-intrusive update banner via per-subscription SSE. Iteration tabs are computed via the new weighted-distance clustering algorithm. AI placeholders render in three locations when `aiPreview` is on.

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
10. Author pushes new commits to PR #1 → within ~30s a banner appears on PR #1's tab: *"PR updated — Iter 4 available, 2 new comments — Reload."* Click Reload → page reloads at the new state. The inbox row still shows the unread badge (Reload does not write `lastViewedHeadSha`); navigating back to the inbox and re-opening PR #1 clears the badge.
11. Quit and relaunch → `state.json` is migrated from legacy `version: 1` to the new timestamp-based `version: <YYYYMMDDHHMM>` silently; bookkeeping fields are preserved.
12. The Drafts tab is visually disabled (greyed, count `0`, no-op on click).
13. Toggle AI preview in the header → Overview tab renders an AI summary card with canned placeholder data; file tree renders priority dots in a new column; AI hunk annotations are *not* inserted in PoC even with the toggle on (per spec § 4: "never inserted in PoC").

## 2. Scope

### In scope

- PR detail page + three-tab strip (Overview / Files / Drafts) under the PR header.
- File tree as a collapsible directory tree with smart-compaction of single-child chains, per-directory viewed-count rollups, and the AI focus-dot column slot. Collapse state resets on every PR-detail open in S3.
- Side-by-side and unified diff via `react-diff-view`, three lines of context, Shiki syntax highlighting from a single shared instance.
- Word-level diff highlighting via `jsdiff` overlaid on changed lines.
- Existing review-comment threads rendered inline read-only, anchored to lines.
- Iteration tabs (last three numbered tabs inline + "All iterations ▾" dropdown) and the Compare picker (with auto-swap on reverse selection and the same-iteration empty state).
- Iteration clustering: `IIterationClusteringStrategy` interface + `WeightedDistanceClusteringStrategy` impl with two live multipliers (`FileJaccardMultiplier`, `ForcePushMultiplier`) and four stubs returning `1.0` (`MessageKeywordMultiplier`, `DiffSizeMultiplier`, `ReviewEventMultiplier`, `BranchActivityMultiplier`); MAD-based adaptive threshold; hard floor (5 min) and ceiling (3 days); coefficients in config.
- `j` / `k` (file nav), `v` (viewed toggle), `d` (diff-mode toggle) keyboard shortcuts on the Files tab.
- Active-PR poller (`BackgroundService`) at 30 s cadence, paused when no subscribed PRs.
- SSE lifecycle: per-PR subscribe / unsubscribe through REST endpoints, write-timeout backpressure (5 s), idle-eviction (15 min), heartbeat every 25 s.
- New SSE event type `pr-updated` carrying `ActivePrUpdated { prRef, headShaChanged, commentCountChanged, newHeadSha?, newCommentCount? }`.
- Banner refresh on PR detail when a `pr-updated` event arrives for the visible PR.
- First-mount writes for `lastViewedHeadSha` and `lastSeenCommentId` via `POST /api/pr/{ref}/mark-viewed`. Reload does *not* write these.
- Per-file viewed-checkbox state via `POST /api/pr/{ref}/files/{path}/viewed` writing into `Reviews.Sessions[ref].ViewedFiles` (a new field on `ReviewSessionState`).
- State schema decomposition: `AppState.ReviewSessions: dict<...>` is replaced by `AppState.Reviews: PrSessionsState { Sessions: dict<...> }`. Schema version becomes a `YYYYMMDDHHMM`-format `long` (UTC). Migration shim handles legacy `version: 1` files.
- Markdown rendering pipeline (`react-markdown` v9+, `remark-gfm`, Shiki, lazy-loaded Mermaid) shared across PR description, comment bodies, and `.md` file rendering.
- Markdown rendering for `.md` files in the diff with a toggle between rendered and raw-diff views.
- Diff content pagination over `pulls/{n}/files` (>100-file PRs paginate cleanly) and a `truncated: true` propagation surface for the rare > 300-file case, with a footer banner deep-linking to github.com.
- API surface (Section 5): `GET /api/pr/{ref}`, `GET /api/pr/{ref}/diff?range=`, `GET /api/pr/{ref}/file?path=&sha=`, `POST /api/pr/{ref}/mark-viewed`, `POST /api/pr/{ref}/files/{path}/viewed`, `POST /api/events/subscriptions`, `DELETE /api/events/subscriptions/{prRef}`. `GET /api/events` is extended (subscriber-ID assignment as the first SSE event).
- AI seam wiring: existing `IPrSummarizer`, `IFileFocusRanker`, `IHunkAnnotator` interfaces (already defined in `PRism.AI.Contracts/Seams/`) are wired into three frontend slots — `<AiSummaryCard>` (Overview), `<AiFileFocusBadges>` (file tree column), `<AiHunkAnnotation>` (diff inline; never inserted in PoC). DI binds either `Noop*` or `Placeholder*` based on `ui.aiPreview`.
- Documentation deliverables (Section 7): canonicalize the iteration-clustering algorithm doc, rewrite affected spec sections, update the roadmap, update the architectural-readiness spec.
- Architectural readiness landed alongside this slice: `PrSessionsState` wrap (ADR-S4-1) and the first inline migration shim (foundation for ADR-S4-2's framework, which extracts when migration #2 arrives).

### Out of scope

- Comment composer; reply composer; draft persistence; stale-draft reconciliation; verdict re-confirmation. (S4.)
- Submit flow; pending-review GraphQL pipeline; verdict picker enabled. (S5 — disabled in S3.)
- Multi-tab consistency `StateChanged` events. (S4 — only `inbox-updated` and `pr-updated` events in S3.)
- AI seam wiring beyond the three slots above (`<AiComposerAssistant>`, `<AiDraftSuggestionsPanel>`, AI badge slot in stale-draft reconciliation, AI validator section in submit dialog, AI inbox enrichment beyond S2 — all later).
- The four stubbed-at-`1.0` iteration-clustering multipliers (message keywords, diff size, review events, branch activity) — slots exist; tests pin the stub contract; calibration lands later.
- Iteration-clustering coefficient calibration workflow.
- Whole-file diff expansion in the diff pane. (`P4-B8`.)
- Markdown HTML allowlist (`<details>`, `<sub>`, `<sup>`, `<kbd>`, etc.). (P4 backlog.)
- Section / directory collapse-state persistence in `state.json`. (S6 / v2.)
- AI hunk annotations inserted into the diff. (v2.)
- AI Chat drawer (`<AiChatDrawer>`) and repo-clone consent flow. (P0+.)
- macOS / Linux CI; single-file publish profiles; accessibility baseline; viewport-screenshot regression test. (S6.)
- Migration framework extraction. (Lands when S4's migration #2 motivates it.)

### Acknowledged carryforwards

- `PrSessionsState` is introduced in S3 but only S4 will materially fill it; S3's writes are the existing `LastViewedHeadSha` / `LastSeenCommentId` / `PendingReviewId` / `PendingReviewCommitOid` fields plus the new `ViewedFiles` per session, now namespaced under `Reviews.Sessions[*]`.
- The migration framework lands as a single inline shim in S3 (one v1 → `<timestamp>` step). When S4 introduces a second migration, the if-chain converts to an ordered list of `(toVersion, transform)` steps. Recorded in the architectural-readiness spec.
- The Drafts sub-tab is rendered greyed in S3; S4 lights it up alongside the comment composer and stale-draft reconciliation panel.
- The PR-root conversation on the Overview tab is read-only in S3; S4 wires the reply composer alongside the inline-comment composer.

## 3. Authority precedence and deviations from the PoC spec

[`design/handoff/`](../../../design/handoff/) is the **default** authority on visual layout, structure, and interaction. Where the PoC spec text in [`docs/spec/`](../../spec/) drifts from the handoff, the handoff wins unless the user explicitly overrides. Each deviation below is recorded so spec edits in Section 7 close the gap.

| Deviation | What the spec says | What S3 ships | Source of decision |
|---|---|---|---|
| AI summary slot position | Spec § 3 places `<AiSummarySlot>` "between the sticky header and the sticky iteration tabs." | Card on the Overview tab; iteration tabs only render on the Files tab. | Roadmap S3 row mentions "Overview-tab AI summary card"; handoff layout. |
| File tree shape | Spec § 3 says "Files grouped by directory; directories collapsible." Handoff prototype renders a flat list. | Collapsible directory tree with smart compaction. | User override of the handoff's flat list, restoring the spec's grouped intent and adding smart compaction + per-directory viewed rollups. |
| Iteration clustering | Spec § 3 describes a 60-second time-gap policy with force-push as a hard boundary, configurable via `iterations.clusterGapSeconds`. | Weighted-distance algorithm with multiple multipliers; force-push reframed as a soft signal (long-gap multiplier); MAD threshold; coefficients in `iterations.clusteringCoefficients`. | The user-authored algorithm doc, canonicalized in S3 to `docs/spec/iteration-clustering-algorithm.md`. |
| Reload semantics for unread bookkeeping | Spec § 3 / § 8 are silent on whether Reload writes `lastViewedHeadSha` / `lastSeenCommentId`. | Reload does NOT write these. Writes only happen on the *first* PR-detail mount; re-mount after navigation writes again. | Q2 brainstorming decision. |
| PR-root conversation rendering | Spec § 3 excludes the chronological PR conversation feed from PoC. | PR-root *issue-level* comments render read-only on the Overview tab; the chronological feed (commits + comments + reviews + status updates + force-pushes in time order) remains out of scope. | Q4 brainstorming decision: the spec's exclusion targeted the merged feed; the issue-comments alone are a single API call and a single read-only list. |
| Schema versioning format | Spec / existing code use sequential integer `version` (`1`, `2`, …). | `version` becomes a `YYYYMMDDHHMM` (UTC) `long`, e.g., `202605061425L`. | User-stated convention; uniquely owned per developer; sortable; doubles as documentation. |

## 4. Project structure changes

### New / modified directories

```
PRism.Core/
├── State/
│   ├── AppState.cs                     ← MODIFIED: ReviewSessions → Reviews; Version becomes long
│   ├── PrSessionsState.cs              ← NEW
│   ├── ReviewSessionState.cs           ← MODIFIED: adds ViewedFiles field
│   ├── AppStateMigrations.cs           ← NEW: v1 → <timestamp> shim
│   └── AppStateStore.cs                ← MODIFIED: dispatch through migration; CurrentVersion is timestamp
├── Iterations/                         ← NEW namespace
│   ├── IIterationClusteringStrategy.cs
│   ├── WeightedDistanceClusteringStrategy.cs
│   ├── IterationClusteringCoefficients.cs
│   ├── IDistanceMultiplier.cs
│   ├── FileJaccardMultiplier.cs        ← LIVE
│   ├── ForcePushMultiplier.cs          ← LIVE
│   ├── MessageKeywordMultiplier.cs     ← STUB returns 1.0
│   ├── DiffSizeMultiplier.cs           ← STUB
│   ├── ReviewEventMultiplier.cs        ← STUB
│   ├── BranchActivityMultiplier.cs     ← STUB
│   ├── MadThresholdComputer.cs
│   ├── ClusteringInput.cs
│   └── IterationCluster.cs
├── PrDetail/                           ← NEW namespace
│   ├── IPrDetailLoader.cs
│   ├── PrDetailLoader.cs
│   ├── ActivePrPoller.cs               ← BackgroundService
│   ├── ActivePrSubscriberRegistry.cs
│   ├── ActivePrPollerState.cs
│   └── PrDetailSnapshot.cs
└── Events/
    └── (extend IReviewEventBus with ActivePrUpdated)

PRism.Core.Contracts/
├── PrDetailDto.cs                      ← NEW
├── DiffDto.cs                          ← NEW (carries truncated: bool)
├── DiffRangeRequest.cs                 ← NEW
└── ActivePrUpdate.cs                   ← NEW

PRism.GitHub/
├── PrDetail/                           ← NEW
│   ├── GitHubPrDetailFetcher.cs        ← single GraphQL round-trip for PR meta + timeline + comments
│   ├── GitHubFileContentFetcher.cs     ← REST contents endpoint
│   └── GitHubDiffFetcher.cs            ← REST pulls/{n}/files with pagination + truncated detection
└── Iterations/                         ← NEW
    └── GitHubTimelineFetcher.cs        ← PullRequestTimelineItems → ClusteringInput

PRism.AI.Contracts/                     ← UNCHANGED (interfaces exist)
PRism.AI.Placeholder/                   ← UNCHANGED (impls exist)

PRism.Web/
├── Endpoints/
│   ├── PrDetailEndpoints.cs            ← NEW
│   ├── EventsEndpoints.cs              ← MODIFIED: subscriber-id assignment + subscriptions endpoints
│   └── PrDetailDtos.cs                 ← NEW
└── Sse/
    └── SseChannel.cs                   ← MODIFIED: per-subscriber subscription set; per-PR fanout; write-timeout + idle-eviction

PRism.Tools.ClusteringDiscipline/       ← NEW (developer aid CLI)
└── Program.cs                          ← discipline-check harness; not shipped with binary

frontend/src/
├── api/
│   ├── prDetail.ts                     ← NEW
│   └── events.ts                       ← MODIFIED: subscribe / unsubscribe RPC; subscriberId capture
├── hooks/
│   ├── usePrDetail.ts                  ← NEW
│   ├── useActivePrUpdates.ts           ← NEW
│   ├── useFileTreeState.ts             ← NEW
│   └── useEventSource.ts               ← MODIFIED: ready-state gate on subscriber-assigned
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
│   │   │       ├── ExistingCommentWidget.tsx
│   │   │       ├── AiHunkAnnotation.tsx
│   │   │       ├── MarkdownFileView.tsx
│   │   │       └── DiffTruncationBanner.tsx
│   │   └── DraftsTab/
│   │       └── DraftsTabDisabled.tsx
│   └── Markdown/
│       ├── MarkdownRenderer.tsx
│       ├── shikiInstance.ts
│       └── MermaidBlock.tsx
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
│   │   ├── AppStateMigrationsTests.cs
│   │   └── AppStateStoreMigrationTests.cs
│   ├── Iterations/
│   │   ├── WeightedDistanceClusteringStrategyTests.cs
│   │   ├── FileJaccardMultiplierTests.cs
│   │   ├── ForcePushMultiplierTests.cs
│   │   └── MadThresholdComputerTests.cs
│   └── PrDetail/
│       ├── ActivePrSubscriberRegistryTests.cs
│       └── PrDetailLoaderTests.cs
├── PRism.GitHub.Tests/
│   ├── PrDetail/
│   │   ├── GitHubPrDetailFetcherTests.cs
│   │   └── GitHubDiffFetcherTests.cs    ← incl. pagination + truncation cases
│   └── Iterations/
│       └── GitHubTimelineFetcherTests.cs
├── PRism.GitHub.Tests.Integration/      ← NEW project (contract tests)
│   └── FrozenApiCodexPrTests.cs
└── PRism.Web.Tests/
    ├── PrDetailEndpointsTests.cs
    └── EventsSubscriptionsEndpointTests.cs
```

### Reference graph (unchanged from S2)

- `PRism.Core` → `PRism.Core.Contracts`, `PRism.AI.Contracts`
- `PRism.GitHub` → `PRism.Core`, `PRism.Core.Contracts` (only project allowed to reference Octokit per the banned-API analyzer; S3's GitHub HTTP stays raw `HttpClient`).
- `PRism.AI.Placeholder` → `PRism.AI.Contracts`
- `PRism.Web` → `PRism.Core`, `PRism.GitHub`, `PRism.AI.Contracts`, `PRism.AI.Placeholder`

## 5. Stack additions beyond S0+S1 / S2

- **`react-diff-view`** — diff rendering library. Used for both side-by-side and unified modes.
- **`jsdiff`** (npm `diff`) — word-level highlighting overlay on changed lines.
- **`react-markdown` v9+** + **`remark-gfm`** — Markdown pipeline. Pin to v9 specifically; older versions allowed `javascript:` URLs in autolinks. `urlTransform` is set to a strict allowlist (`http`, `https`, `mailto`).
- **`shiki`** — syntax highlighting. Single shared instance used by both diff and Markdown rendering paths.
- **`mermaid`** — lazy-loaded inside `MermaidBlock.tsx` via dynamic import.
- **`eventsource-mock`** (or 30-line in-house fake) — Vitest test polyfill for SSE.
- No new backend libraries. ASP.NET Core's `HttpResponse.WriteAsync` + `FlushAsync` continues to handle SSE; pagination in `GitHubDiffFetcher` is a manual loop on `Link rel="next"`.

## 6. Backend architecture

### 6.1 PR detail load and cache

```
GET /api/pr/{owner}/{repo}/{number}                  → PrDetailLoader.LoadAsync
  ↓
GitHubPrDetailFetcher.FetchAsync (single GraphQL round-trip)
  → PR meta (title, body, author, head/base, mergeability, ciSummary, isMerged/isClosed, openedAt)
  → PullRequestTimelineItems → ClusteringInput
  → PR-root issue-level comments (read-only)
  → Existing review-comment threads
  ↓
WeightedDistanceClusteringStrategy.Cluster(ClusteringInput, coefficients)
  → IterationCluster[] (numbered, with before/after SHAs and commit lists)
  ↓
PrDetailSnapshot { Pr, Iterations, RootComments, ReviewComments } cached per (prRef, headSha)
  → returned as PrDetailDto
```

The diff is a **separate** fetch (`GET /api/pr/{ref}/diff?range=base..head`) because it changes per iteration tab and Compare picker selection — keeping it out of the initial detail fetch lets the page paint Overview without blocking on diff bytes. `GitHubDiffFetcher` handles `pulls/{n}/files` pagination via `Link rel="next"` and surfaces `truncated: true` if the response signals truncation (i.e., the >300-file `compare` cap is reached). File content for `.md` rendering and (later, in S4) reconciliation is `GET /api/pr/{ref}/file?path=&sha=`, cached per `(file, sha)` for the page session lifetime.

`IPrDetailLoader` is a thin coordinator; `GitHubPrDetailFetcher` does the heavy lifting. The split exists so the clustering algorithm can be unit-tested against in-memory `ClusteringInput` without touching GitHub.

### 6.2 Active-PR poller and SSE per-PR fanout

```
EventsEndpoints
  GET    /api/events                       → SseChannel.AddSubscriber(response)
                                              generates subscriberId; emits as first event;
                                              holds connection; sends heartbeats every 25 s
  POST   /api/events/subscriptions         { subscriberId, prRef }
                                            → ActivePrSubscriberRegistry.Add(subscriberId, prRef)
  DELETE /api/events/subscriptions/{prRef}?subscriberId=...
                                            → ActivePrSubscriberRegistry.Remove(subscriberId, prRef)

ActivePrPoller (BackgroundService)
  loop every config.polling.activePrSeconds (default 30):
    wait until ActivePrSubscriberRegistry.UniquePrRefs.Count > 0
    for each unique prRef:
      poll pulls/{n}                                (head SHA, mergeability, state)
      poll pulls/{n}/comments?per_page=1            (Link rel=last → count)
      poll pulls/{n}/reviews?per_page=1             (Link rel=last → count)
      compare against ActivePrPollerState[prRef]:
        if (headSha changed) or (commentCount changed):
          Publish(ActivePrUpdated { prRef, headShaChanged, commentCountChanged, newHeadSha?, newCommentCount? })
          update ActivePrPollerState[prRef]
    backoff on 4xx/5xx; exponential up to 5 minutes; reset on next success

SseChannel.Publish(ActivePrUpdated evt)
  for each subscriber subscribed to evt.prRef:
    try with 5 s write timeout:
      response.WriteAsync($"event: pr-updated\ndata: {json}\n\n")
      await response.Body.FlushAsync(ct)
    on timeout / pipe error: drop subscriber, close response

idle-eviction loop (separate timer, 60 s tick):
  for each subscriber where lastEventDeliveredAt > 15 min ago:
    drop subscriber
```

Two design notes worth pinning:

- **Per-PR poll is independent of subscriber count for that PR.** If three browser tabs all subscribe to the same PR, the poll runs once and the event fans out three times. Polling cost scales with unique PRs, not subscribers.
- **Reload doesn't write to `ActivePrPollerState`.** When a Reload causes a new `LoadAsync`, the page shows the new state but the poller's state machine continues from its last poll. The next tick after Reload sees no diff and won't republish.

### 6.3 State decomposition and migration

```csharp
// PRism.Core/State/AppState.cs
public sealed record AppState(
    long Version,
    PrSessionsState Reviews,
    AiState AiState,
    string? LastConfiguredGithubHost)
{
    public static AppState Default { get; } = new(
        Version: AppStateMigrations.CurrentVersion,
        Reviews: new PrSessionsState(new Dictionary<string, ReviewSessionState>()),
        AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
        LastConfiguredGithubHost: null);
}

// PRism.Core/State/PrSessionsState.cs (NEW)
public sealed record PrSessionsState(
    IReadOnlyDictionary<string, ReviewSessionState> Sessions);

// ReviewSessionState — adds ViewedFiles
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

S3 (`<YYYYMMDDHHMM>` is the migration's mint timestamp, UTC, set at PR-merge time):

```json
{
  "version": 202605061425,
  "reviews": {
    "sessions": {
      "owner/repo/123": {
        "last-viewed-head-sha": "...",
        "last-seen-comment-id": "...",
        "pending-review-id": null,
        "pending-review-commit-oid": null,
        "viewed-files": { "src/Foo.cs": "abc123" }
      }
    }
  },
  "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
  "last-configured-github-host": "github.com"
}
```

#### Migration shim

```csharp
// PRism.Core/State/AppStateMigrations.cs (NEW)
internal static class AppStateMigrations
{
    public const long CurrentVersion = <YYYYMMDDHHMM>L;  // mint timestamp filled in at implementation

    public static JsonNode Migrate(JsonNode root)
    {
        var stored = root["version"]?.GetValue<long>() ?? 1L;
        if (stored > CurrentVersion)
            throw new UnsupportedStateVersionException(stored, CurrentVersion);
        if (stored < CurrentVersion) root = ApplyAllMigrationsFrom(stored, root);
        return root;
    }

    private static JsonNode ApplyAllMigrationsFrom(long stored, JsonNode root)
    {
        // S3 has a single migration step (legacy → CurrentVersion).
        // When S4 introduces migration #2, this becomes an ordered list dispatch.
        if (stored < CurrentVersion) root = MigrateLegacyToCurrent(root);
        return root;
    }

    private static JsonNode MigrateLegacyToCurrent(JsonNode root)
    {
        // 1. Lift root["review-sessions"] → root["reviews"]["sessions"].
        // 2. For each session, default viewed-files to {} if absent.
        // 3. Bump version to CurrentVersion.
    }
}
```

`AppStateStore.LoadAsync` calls `AppStateMigrations.Migrate(root)` between file-read and deserialization. `SaveAsync` always writes at `CurrentVersion`. The migration runs on cold start. Tests cover legacy → current, current → unchanged, and `version > CurrentVersion` throws.

### 6.4 Iteration clustering pipeline

```
GitHubTimelineFetcher.FetchAsync(prRef)
  → ClusteringInput {
      Commits:         [{ sha, authorTimestamp, message, changedFiles[], additions, deletions }],
      ForcePushes:     [{ beforeSha, afterSha, occurredAt }],
      ReviewEvents:    [{ submittedAt }],
      AuthorPrComments:[{ authoredAt }]
    }

WeightedDistanceClusteringStrategy.Cluster(input, coefficients)
  if input.Commits.Length <= 1:
      return single iteration   (short-circuit)
  
  sort commits by (authorTimestamp, parentChainPosition)
  
  for each consecutive pair (c_i, c_{i+1}):
    Δt = authorTimestamp(c_{i+1}) - authorTimestamp(c_i)
    multiplier = product of all IDistanceMultiplier impls in DI:
      - FileJaccardMultiplier:    1 - 0.5 × jaccard(files(c_i), files(c_{i+1}))
      - ForcePushMultiplier:      1.5 if ∃ forcePush in (c_i, c_{i+1}] AND Δt > forcePushLongGapSeconds else 1.0
      - MessageKeyword:           1.0 (stub)
      - DiffSize:                 1.0 (stub)
      - ReviewEvent:              1.0 (stub)
      - BranchActivity:           1.0 (stub)
    weighted_d[i] = max(HARD_FLOOR_5MIN, min(HARD_CEILING_3DAYS, Δt × multiplier))
  
  threshold = MadThresholdComputer.Compute(weighted_d, k = coefficients.MadK)
  
  boundaries = indices where weighted_d[i] > threshold
  emit IterationCluster[] partitioned at those boundaries
```

`IDistanceMultiplier` is the strategy slot. Adding the four stubbed multipliers later is purely additive: drop a new class into the namespace, register it in DI, no change to `WeightedDistanceClusteringStrategy`.

Coefficients (`IterationClusteringCoefficients`) come from config:

```jsonc
"iterations": {
  "clustering-coefficients": {
    "file-jaccard-weight": 0.5,
    "force-push-after-long-gap": 1.5,
    "force-push-long-gap-seconds": 600,
    "tiny-followup-commit": 0.4,
    "tiny-followup-line-threshold": 10,
    "review-event-stretch": 1.3,
    "branch-activity-stretch": 1.2,
    "mad-k": 3,
    "hard-floor-seconds": 300,
    "hard-ceiling-seconds": 259200
  }
}
```

Force-push as a multiplier (rather than a hard boundary) is a deliberate departure from the spec § 3 wording. The algorithm doc reframes it as a soft signal whose strength scales with the time gap; `ForcePushMultiplier` returns `1.5` only when the gap exceeds `force-push-long-gap-seconds`, otherwise `1.0`. Spec § 3's iteration-reconstruction text gets rewritten accordingly (Section 7).

## 7. Frontend architecture

### 7.1 Page composition

```
PrDetailPage (route /pr/:owner/:repo/:number)
  ├─ on mount:
  │   1. usePrDetail({ prRef })                      — fetches /api/pr/{ref}; renders skeleton while pending
  │   2. on success: POST /api/pr/{ref}/mark-viewed { headSha, maxCommentId }
  │   3. POST /api/events/subscriptions { subscriberId, prRef }
  ├─ on unmount:
  │   DELETE /api/events/subscriptions/{prRef}?subscriberId=...
  ├─ PrHeader            (title, branch, mergeability chip, CI chip, VerdictPicker disabled, Submit disabled)
  ├─ PrSubTabStrip       (Overview / Files / Drafts; Drafts greyed disabled)
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
  │   ├─ Header: "Files · N/M viewed" + filter icon (filter is not implemented in S3; render a stub)
  │   ├─ Tree nodes from treeBuilder.ts:
  │   │   - DirectoryNode: smart-compacted path, viewed-rollup count, chevron, recursive children
  │   │   - FileNode: status icon, path basename, +adds/-dels, viewed checkbox, AI focus dot slot
  │   ├─ Selected file highlighted; j/k navigate within the tree (visiting only file nodes)
  │   └─ v on the selected file toggles viewed
  │
  └─ DiffPane (right pane)
      ├─ Diff for currently-selected file at the iteration's range
      ├─ react-diff-view side-by-side OR unified (toggle d, persisted to ui prefs in state.json — minimal field add)
      ├─ Three lines of context per hunk
      ├─ Shiki syntax highlighting (single shared instance)
      ├─ jsdiff word-level highlighting overlay on changed lines
      ├─ Existing comment widgets inline between code lines (read-only)
      ├─ AiHunkAnnotation widgets — never inserted (PoC)
      ├─ DiffTruncationBanner if DiffDto.truncated === true
      └─ For .md files: MarkdownFileView with toggle "Rendered / Raw diff"
```

`treeBuilder.ts` is a pure function: takes `FileChange[]` → tree nodes with smart compaction applied. Per-file viewed-checkbox state is server-side via `state.reviews.sessions[ref].viewed-files` (a new field). Per spec § 3: a file is viewed iff `ViewedFiles[path]` exists AND that stored `headSha` is unchanged-against-current-head for that file. The cheapest signal: a file is viewed iff `ViewedFiles[path] == prDetail.headSha || (ViewedFiles[path] is set AND file is unchanged between ViewedFiles[path] and prDetail.headSha)`. The second branch reuses the per-file "last-touched-by-iteration" lookup that the iteration cluster output produces.

### 7.3 Overview tab

```
OverviewTab
  ├─ AiSummaryCard       (gated on useCapabilities()["ai.summary"]; renders null when off)
  │                      PoC content via PlaceholderPrSummarizer when aiPreview = true
  ├─ PrDescription       (rendered Markdown of pr.body via MarkdownRenderer)
  ├─ StatsTiles          (files / drafts = 0 / threads / viewed N/M)
  ├─ PrRootConversation  (read-only thread of issue-level comments)
  └─ ReviewFilesCta      + keyboard hints
```

`PrRootConversation` does NOT include a "Reply to this PR…" button in S3 (composer lands in S4). The footer renders static copy: *"Reply lands when the comment composer ships in S4."*

### 7.4 SSE consumer

A single `useEventSource` hook at the App level:

- Opens `EventSource('/api/events')` on App mount; closes on unmount.
- Parses two event types: `inbox-updated` (S2) and `pr-updated` (S3).
- Holds a "ready" gate: subscribe POSTs are deferred until the first `subscriber-assigned` event lands. On reconnect, the frontend re-emits subscribe RPCs for every active PR using the new subscriberId.
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
/pr/:owner/:repo/:number/files/:filePath?iter=N → Files tab with the named file selected at iter N
```

A deep link to a specific file/iter survives reload. URL paste from S2's escape hatch lands directly on these routes.

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
       → 404  if range references an unreachable SHA

GET    /api/pr/{owner}/{repo}/{number}/file?path=&sha=
       → 200  text/plain  (raw file content; for .md rendering and word-diff)
       → 404  if file/sha missing
       → 415  if file is binary

POST   /api/pr/{owner}/{repo}/{number}/mark-viewed
       body: { headSha, maxCommentId }
       → 204  writes lastViewedHeadSha + lastSeenCommentId into Reviews.Sessions[ref]

POST   /api/pr/{owner}/{repo}/{number}/files/{filePath}/viewed
       body: { headSha, viewed: bool }
       → 204  toggles per-file viewed; writes Reviews.Sessions[ref].ViewedFiles[path]

GET    /api/events
       → 200  text/event-stream
              first event:   event: subscriber-assigned\ndata: { subscriberId }\n\n
              subsequent:    event: inbox-updated | pr-updated\ndata: {...}\n\n
              heartbeats:    :heartbeat (every 25 s)

POST   /api/events/subscriptions
       body: { subscriberId, prRef }
       → 204  registers (subscriberId, prRef)
       → 404  { type: "/events/subscriber-unknown" }
       → 409  { type: "/events/already-subscribed" }      (idempotent)

DELETE /api/events/subscriptions/{prRef}?subscriberId=...
       → 204  always (idempotent)
```

All JSON is kebab-case-lowercase via the application's `JsonSerializerOptions` + `JsonStringEnumConverter` (per the wire-format conventions in CLAUDE.md). Errors use RFC 7807 `application/problem+json` with stable `type` slugs the frontend matches on. `prRef` is `{ owner, repo, number }` everywhere.

If the backend restarts while a frontend tab is open, the EventSource reconnects natively and the frontend receives a fresh `subscriber-assigned` event. The ready-state gate in `useEventSource` defers subscribe POSTs until that event lands, avoiding 404s against the old subscriberId.

## 9. Documentation deliverables

This section enumerates every doc change S3 lands. The slice is not done until each row below ships.

### 9.1 New documents

| Path | Purpose |
|---|---|
| `docs/spec/iteration-clustering-algorithm.md` | Canonicalized copy of the user's algorithm doc; replaces `Downloads/pr-iteration-detection-algorithm.md` as the authority; linked from spec § 3. |
| `docs/superpowers/specs/2026-05-06-s3-pr-detail-read-design.md` | This document. |
| `docs/superpowers/plans/2026-05-06-s3-pr-detail-read.md` | Generated by the writing-plans skill after this design is approved. |

### 9.2 Edits to existing spec documents

| Doc | Change | Reason |
|---|---|---|
| `docs/spec/03-poc-features.md` § 3 "Iteration reconstruction" | Replace 60s-clustering policy + manual-merge UI with reference to `docs/spec/iteration-clustering-algorithm.md`; keep history-rewriting force-push and historical-SHA-unavailable cases (correctness, not policy); retire `iterations.clusterGapSeconds` config in favor of `iterations.clusteringCoefficients`. | Q6 brainstorming: algorithm doc is authoritative. |
| `docs/spec/03-poc-features.md` § 3 "Layout (top to bottom)" | Move `<AiSummarySlot>` from "between sticky header and sticky iteration tabs" to "AI summary card on the Overview tab"; describe the three-tab strip (Overview / Files / Drafts) as the layer between PR header and per-tab content; iteration tabs render only on the Files tab. | Q1 brainstorming: handoff is canon. |
| `docs/spec/03-poc-features.md` § 3 "File tree" | Replace prose about a flat list with collapsible directory tree, smart-compaction note, per-directory viewed-rollup note, reset-on-open collapse-state note. | Q5b brainstorming: user override of the handoff's flat shape. |
| `docs/spec/03-poc-features.md` § 3 "PR view scope" | Add: "PR-root issue-level comments are rendered read-only on the Overview tab. The chronological PR conversation feed (commits + comments + reviews + status updates + force-push events in time order) remains out of scope." | Q4 brainstorming: narrow the exclusion. |
| `docs/spec/03-poc-features.md` § 3 "Banner refresh on PR update" + § 8 "Banner update model" | Note explicitly that Reload does NOT update `lastViewedHeadSha` / `lastSeenCommentId`; those write only on PR-detail mount. | Q2 brainstorming. |
| `docs/spec/03-poc-features.md` § 3 "Diff display" | Add: "Diff content truncation at GitHub's 300-file `compare` cap is surfaced via a footer banner with a deep link to github.com." | Section 8 design decision. |
| `docs/spec/04-ai-seam-architecture.md` § `<AiSummarySlot>` | Relocate the slot's documented position from "between sticky header and iteration tabs" to "Overview tab hero card." Drop sticky-stack rationale; replace with Overview-tab placement rationale. | Q1. |
| `docs/spec/02-architecture.md` § "State schema (PoC)" | Document `PrSessionsState` wrapper, `ViewedFiles` per session, timestamp-format `version` field. | Section 6.3. |
| `docs/spec/02-architecture.md` § "Schema migration policy" | Replace prose about sequential integer schema versions with the `YYYYMMDDHHMM` (UTC) `long` convention; reference `AppStateMigrations.CurrentVersion`. | Schema version format. |
| `docs/spec/00-verification-notes.md` § C2 | Update reference to iteration-reconstruction algorithm (point at the new doc). | Q6. |

### 9.3 Edits to the roadmap

`docs/roadmap.md`:

- **S3 row** — fill in spec status (`Shipped — superpowers/specs/2026-05-06-s3-pr-detail-read-design.md`) on slice completion. Add: "Includes `PrSessionsState` wrap + first timestamp-versioned migration shim (architectural readiness ADR-S4-1 landed; ADR-S4-2's framework deferred to S4)."
- **Architectural readiness table** — change ADR-S4-1 status from "open" to "landed in S3 (PR #N)". ADR-S4-2 stays "open" (full migration framework deferred until migration #2 motivates extraction).
- **Tweaks panel comparison table** — diff-mode toggle row: change "Lands in slice" from "S3" to "S3 (shipped)".
- **AI placeholder behavior — per-slice rendering** — update the S3 row to enumerate the three placeholder slots (Overview AI summary card, file-tree focus dots, hunk annotation slot — the last only as an inserted-widget API capability, not actually inserted).

### 9.4 Edits to the architectural-readiness spec

`docs/superpowers/specs/2026-05-06-architectural-readiness-design.md`:

- ADR-S4-1 — append: *"**Status (2026-05-06):** Landed in S3 alongside the first state writes. The wrap also added `ViewedFiles` per session; the AppState shape is now `Reviews.Sessions[]`."*
- ADR-S4-2 — append: *"**Status (2026-05-06):** A single inline migration shim landed in S3 (`AppStateMigrations.MigrateLegacyToCurrent`). The migration *framework* (ordered chain of `(toVersion, transform)` steps, version negotiation registry) remains gated to S4 — extraction happens when migration #2 arrives, motivated by S4's drafts/replies/reconciliation schema additions."*
- Add a new section: *"**Versioning convention.** Schema versions are `YYYYMMDDHHMM` (UTC) `long` values, not sequential integers. Established 2026-05-06 with the S3 migration. See `PRism.Core/State/AppStateMigrations.cs`."*

### 9.5 Items deferred from S3 — recorded so future slices know

| Item | Where it goes | When it lands |
|---|---|---|
| Comment composer / reply composer | Already in roadmap S4 row | S4 |
| Drafts tab activation | Add "S4 also activates the previously-disabled Drafts tab in the PR sub-tab strip" to the S4 row | S4 |
| PR-root conversation reply composer | Note in spec § 3 Overview-tab subsection: "Reply composer on PR-root comments lands in S4 alongside the inline-comment composer" | S4 |
| Verdict picker enabled / Submit Review enabled | Already in S5 row | S5 |
| Whole-file diff expansion | Already in P4 backlog (`P4-B8`) | post-PoC |
| Markdown HTML allowlist (`<details>`, `<sub>`, `<sup>`, `<kbd>`, etc.) | Confirm P4 backlog entry; add if missing | post-PoC |
| Section / directory collapse-state persistence in `state.json` | Add to S6 row's settings consolidation | S6 / v2 |
| AI hunk annotations actually inserted into the diff | Already deferred (PoC: never inserted) | v2 |
| Other four iteration-clustering multipliers | New backlog item: `P0-* — flesh out remaining iteration-clustering multipliers (message keywords, diff size, review events, branch activity)` | P0+ calibration |
| Iteration-clustering coefficient calibration workflow | New backlog item: `P0-* — coefficient tuning corpus + workflow` | P0+ calibration |
| Migration framework extraction | Already noted in ADR-S4-2 status update | S4 |

The two "new backlog item" rows above are net-new additions to `docs/backlog/`; S3 creates them so the deferred work has a documented home.

## 10. Error handling

### 10.1 GitHub API failures

| Failure | Backend behavior | Frontend behavior |
|---|---|---|
| 401 / 403 with revoked-token shape | Endpoints surface `{ type: "/auth/expired" }` | Banner: *"Token expired. Reconnect to continue."* + link to Setup. Already-loaded data stays visible read-only. |
| 404 on PR | `GET /api/pr/{ref}` → `{ type: "/pr/not-found" }` | Empty-state placeholder with the parsed PR ref + "Back to inbox" link. |
| 404 / 422 on diff range (unreachable SHA) | `GET /api/pr/{ref}/diff` → `{ type: "/diff/range-unreachable", range }` | Diff pane shows: *"This iteration's commits are no longer available on GitHub."* The iteration tab stays clickable; only the diff body shows the message. |
| 5xx from GitHub | `IReviewService` retries with exponential backoff up to 30 s; then returns `{ type: "/github/unavailable" }` | Banner: *"GitHub is unreachable. Retrying…"* with manual Retry. Already-loaded data stays visible. |
| Rate limit (`x-ratelimit-remaining: 0`) | Honor `x-ratelimit-reset`; queue background polls until then; user-initiated requests return `{ type: "/github/rate-limited", resetAt }` | Banner: *"GitHub rate limit reached. Resumes at HH:MM."* Active-PR poller pauses; resumes after the reset. |

### 10.2 Iteration clustering failures

| Failure | Behavior |
|---|---|
| `ClusteringInput.Commits.Length == 0` | Return zero iterations; emit "All changes" tab only; file tree renders the empty-PR placeholder. |
| `ClusteringInput.Commits.Length == 1` | Short-circuit to a single iteration containing that commit. |
| MAD threshold hits a degenerate case (all weighted distances equal) | Fall back to one-tab-per-commit; log a warning. |
| GitHub returns a malformed timeline event | Drop that event from `ClusteringInput`; log; continue. Don't fail the page load. |
| A commit's `changedFiles` is unavailable (truncation; large-PR case) | Treat that commit's file set as unknown; the multiplier returns `1.0`. The commit still participates in the timeline; clustering is dominated by other multipliers + raw time gap. |

### 10.3 SSE / subscription failures

| Failure | Behavior |
|---|---|
| Backend restart while frontend connected | EventSource reconnects natively; new `subscriber-assigned`; frontend re-subscribes every open PR. |
| Subscribe POST returns 404 (stale subscriberId) | Frontend force-closes the EventSource; reconnects from scratch. |
| Subscribe POST returns 409 (already-subscribed) | Idempotent no-op. Logged at debug. |
| Active-PR poller throws on a single PR mid-tick | Catch; log; skip that PR for this tick; continue to the next subscribed PR. |
| SSE flush blocks > 5 s on a slow client | Drop the subscriber; close the response; the client's EventSource reconnects natively. |
| Idle eviction (no events delivered for 15 min) | Drop the subscriber; close the response. The frontend's silence-watcher (a 30 s heartbeat listener) notices and reconnects. |

### 10.4 State migration failures

| Failure | Behavior |
|---|---|
| `state.json` has `version > CurrentVersion` | `LoadAsync` throws `UnsupportedStateVersionException`; the app surfaces a startup error: *"This state.json was written by a newer version of PRism. Either upgrade PRism or delete the file. Path: …"* Quit cleanly. |
| `state.json` malformed (invalid JSON or doesn't match any known shape) | Log; back up as `state.json.broken-<timestamp>`; start with `AppState.Default`. The user keeps their session but loses bookkeeping; the broken file is preserved. |
| Migration mid-flight write failure | `AppStateStore` already uses lockfile + temp-file + atomic rename; the legacy file stays intact until the new file is durable. If the rename fails, the next launch sees the legacy file and re-runs the migration. Idempotent. |

### 10.5 File-tree / diff failures

| Failure | Behavior |
|---|---|
| `react-diff-view` throws on a malformed patch | Error boundary around `DiffPane`; render "could not display diff" placeholder; log patch + error. Other files in the tree still render. |
| `.md` rendering throws (Mermaid syntax error, etc.) | Mermaid block specifically: catch and render the raw fenced code block with a small "Mermaid render failed" indicator. The rest of the file renders normally. |
| `.md` file is binary or unreadable | `GET /api/pr/{ref}/file` returns 415; frontend shows "this file can't be rendered as text" placeholder; raw-diff toggle still available. |
| Markdown contains script-injection (`<script>`, `javascript:` URL) | `react-markdown` v9+ default schema strips it; renders as escaped text. |

### 10.6 Edge cases

- **Empty-PR (no commits beyond base).** File tree empty + placeholder; submit disabled (already disabled in S3); banner refresh continues. Overview tab still renders (PR description, stats with `0 files / 0 threads`, "Review files" CTA disabled with hover tooltip).
- **Closed / merged PR while user is viewing it.** Header banner per spec § 3; submit disabled (already disabled). When the PR re-opens via poll, banner clears.
- **PR > 100 files.** `pulls/{n}/files` paginates; backend collects all pages; frontend renders the full set.
- **PR > 300 files of diff content.** GitHub returns truncated; backend surfaces `truncated: true`; frontend renders `DiffTruncationBanner` with a deep link to github.com.

## 11. Testing strategy

The discipline from CLAUDE.md and S2 precedent: TDD throughout, no mocks of the system under test, mocks only at external boundaries, every behavior commit pairs a failing test with the implementation that turns it green.

### 11.1 The pyramid

```
  ┌─────────────────────────────────────────────┐
  │ contract tests (~5)                         │  PRism.GitHub.Tests.Integration
  │ real GitHub against frozen api-codex PR     │  manual / nightly CI only
  └─────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────┐
  │ web-API integration tests (~26)             │  PRism.Web.Tests
  │ WebApplicationFactory + FakeGitHubServer    │  every commit
  └─────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────┐
  │ unit tests (~80)                            │  PRism.Core.Tests + PRism.GitHub.Tests
  │ pure C# against fakes; pure React           │  + frontend (vitest)
  │ components against props                    │  every commit
  └─────────────────────────────────────────────┘
```

### 11.2 Unit-test surface

| Subject | Lives in | Test count | Why |
|---|---|---|---|
| `WeightedDistanceClusteringStrategy` | `PRism.Core.Tests/Iterations/` | ~12 | Single-commit short-circuit; force-push as multiplier; Jaccard at extremes (0, 1); MAD threshold against synthetic gap distributions; hard floor; hard ceiling; degenerate all-equal case → fallback; coefficient changes flip clustering decisions deterministically. |
| `FileJaccardMultiplier` | same | ~5 | Disjoint files; full overlap; partial overlap; empty file-set handling; missing-files signal returns neutral `1.0`. |
| `ForcePushMultiplier` | same | ~4 | No force push → `1.0`; force push within short gap → `1.0`; force push after long gap → `1.5`; multiple force-pushes in a window. |
| `MadThresholdComputer` | same | ~4 | Bimodal distribution; single-mode distribution; single-element collection; constant-distance collection (degenerate). |
| `IDistanceMultiplier` stubs (Message / DiffSize / Review / Branch) | same | 1 each | Each currently returns `1.0` unconditionally. The test pins that contract. |
| `treeBuilder.ts` | `frontend/src/components/PrDetail/FilesTab/FileTree/__tests__/` | ~8 | Empty input; single file; deep single-child chain (smart compaction); siblings break compaction; per-directory rollup math; mixed file statuses. |
| `AppStateMigrations.MigrateLegacyToCurrent` | `PRism.Core.Tests/State/` | ~6 | Legacy → current shape; preserves existing fields; defaults `viewedFiles` to `{}`; idempotent (re-applying to current input is unchanged); future-version throws; malformed input is a hard error. |
| `ActivePrSubscriberRegistry` | `PRism.Core.Tests/PrDetail/` | ~6 | Add / remove / dedup; multi-subscriber for same PR; unique-PR-set computation; idempotent re-add; cleanup on subscriber drop. |
| `MarkdownRenderer` | frontend vitest | ~5 | `<script>` rendered as escaped text; `javascript:` URL stripped; `mailto` / `http` / `https` allowed; raw HTML allowlist verified empty; Mermaid lazy-load wrapper. |
| `PrDetailLoader` orchestration | `PRism.Core.Tests/PrDetail/` | ~10 | Each loader step calls expected fakes in expected order; failure of any step bubbles cleanly; cache hit/miss logic. |
| React components (header, sub-tab strip, file-tree row, banner, stats tiles, PR-root conversation, AI summary card, diff truncation banner) | frontend vitest | ~15 | Capability-flag-gated rendering; disabled-tab click is no-op; viewed-checkbox toggle; banner appearance / dismiss; AI off vs preview-on rendering. |

Total unit tests: ~80.

### 11.3 Web-API integration tests

`PRism.Web.Tests` already uses `WebApplicationFactory<Program>` with a `FakeGitHubServer` registered as the `IReviewService` backing implementation. S3 expands the fake to cover the new endpoints.

| Endpoint / scenario | Tests |
|---|---|
| `GET /api/pr/{ref}` happy path | 1 |
| `GET /api/pr/{ref}` 404 | 1 |
| `GET /api/pr/{ref}` 401 (token expired) | 1 |
| `GET /api/pr/{ref}/diff?range=` | 3 (base..head, iter range, malformed range) |
| `GET /api/pr/{ref}/diff` paginates `pulls/{n}/files` | 1 |
| `GET /api/pr/{ref}/diff` propagates `truncated: true` | 1 |
| Pagination loop respects bound limit | 1 |
| `POST /api/pr/{ref}/mark-viewed` | 2 (happy; idempotent re-call) |
| `POST /api/pr/{ref}/files/{path}/viewed` | 2 (toggle on; toggle off) |
| `GET /api/events` first-event contract | 1 (`subscriber-assigned` delivered first) |
| `POST /api/events/subscriptions` | 3 (happy; 404 on unknown subscriber; 409 on already-subscribed) |
| `DELETE /api/events/subscriptions/{prRef}` | 2 (happy; idempotent on already-removed) |
| Active-PR poll → `pr-updated` event end-to-end | 2 (head changed; comment count changed) |
| Active-PR poll: zero subscribers → poller idles | 1 |
| Active-PR poll: per-subscriber fanout | 1 (A & B subscribed to PR X get the event; C subscribed to PR Y doesn't) |
| State migration on cold-start | 2 (legacy file migrated; current-version file unchanged) |

Total: ~26.

### 11.4 Contract tests against the frozen `api-codex` PR

A new project `PRism.GitHub.Tests.Integration` with `[Trait("Category", "Integration")]`. Default `dotnet test` excludes the trait via runsettings; CI has a separate job that runs only the integration tests with a configured `PRISM_INTEGRATION_PAT` env var.

| Test | Purpose |
|---|---|
| `Frozen_pr_returns_expected_iteration_count` | Pin the iteration-cluster output against the locked PR. |
| `Frozen_pr_returns_expected_files_in_diff` | Confirms the diff-fetcher pagination and file shape against real bytes. |
| `Frozen_pr_existing_comments_have_expected_anchors` | Confirms comment-thread fetching against real wire shape. |
| `Frozen_pr_force_push_event_appears_in_timeline` | Smoke for force-push detection on a real timeline event. |
| `Frozen_pr_handles_pat_scope_validation_for_read_paths` | Confirms `IReviewService.ValidateCredentialsAsync` returns the expected scope set. |

**Frozen PR setup is one-off manual work.** Open a PR on `mindbody/Api.Codex` against `prism-validation`, push three iterations of varying shape (one normal cadence, one tight-amend cluster, one force-push), then **lock the conversation and the PR** so no further activity changes the fixture. The PR's URL becomes a config value in the integration test project. The same long-lived `prism-validation` branch the validation harness uses is the host for this fixture; it does not interfere with regular validation activity because the PR is locked.

### 11.5 Iteration-clustering discipline check

A one-shot manual measurement run before locking S3 coefficients. Not part of the automated test suite.

1. Pick 3–5 PRs each from `bizapp-bff` and `mobile-business-gateway` covering: clean push cadence; heavy-amend cluster; force-push rebase; multi-day work; CI-amend pipeline.
2. For each PR, manually annotate where iteration boundaries should be (the developer is the source of truth — per the algorithm doc's tuning approach).
3. Run `WeightedDistanceClusteringStrategy.Cluster(...)` against each via the `PRism.Tools.ClusteringDiscipline` CLI: `dotnet run --project PRism.Tools.ClusteringDiscipline -- <prRef>`.
4. Record per-PR: hand-labeled boundary count, algorithm boundary count, agreement %.
5. If aggregate agreement < 70%, tune coefficients; if still bad, fall back to one-tab-per-commit default.
6. Document results in this slice spec under "Iteration clustering — discipline-check observations" with date, PR set, and final coefficient values. (Section to be filled in at slice completion.)

`mindbody-pos` and `Express Android` (under `C:\src\`) are reserved for later fine-tuning.

### 11.6 Frontend testing tooling

- **Vitest** + **React Testing Library** (S2 precedent).
- **`eventsource-mock`** (or 30-line in-house fake from S2's plan) for SSE.
- No Playwright / Cypress in S3. End-to-end browser testing is S6's territory (viewport-screenshot regression test).

### 11.7 Test-first slicing

Strawman PR sequence inside the S3 slice. The plan-writing step refines this; the design's job is to commit to the test layer for each concern.

| PR | Concern | Tests landed | Implementation landed |
|---|---|---|---|
| 1 | State migration | `AppStateMigrationsTests` | `AppStateMigrations` + `AppState` / `PrSessionsState` rewrite + `AppStateStore.LoadAsync` migration call |
| 2 | Iteration clustering core | `WeightedDistance...Tests` + multiplier tests | `WeightedDistanceClusteringStrategy` + multipliers + `MadThresholdComputer` |
| 3 | GitHub timeline + diff fetch | `GitHubTimelineFetcherTests` + `GitHubDiffFetcherTests` | `GitHubTimelineFetcher` + `GitHubPrDetailFetcher` + `GitHubDiffFetcher` |
| 4 | PR detail backend assembly | `PrDetailLoaderTests` + `PrDetailEndpointsTests` | `PrDetailLoader` + endpoints |
| 5 | SSE per-PR + active-PR poller | `ActivePrSubscriberRegistryTests` + `EventsSubscriptionsEndpointTests` + `ActivePrPollerTests` | `ActivePrSubscriberRegistry` + `ActivePrPoller` + `SseChannel` mods |
| 6 | Frontend PR detail shell | vitest tests for header / sub-tab strip / banner | `PrDetailPage` + routing replacement |
| 7 | Files tab — file tree | vitest for `treeBuilder.ts` + components | `FileTree` + `treeBuilder` + `FilesTab` plumbing |
| 8 | Files tab — diff pane | vitest for `DiffPane`, `WordDiffOverlay`, `MarkdownRenderer` | `DiffPane` + `react-diff-view` wiring + `jsdiff` overlay + Markdown pipeline |
| 9 | Overview tab | vitest for `OverviewTab` and children | `OverviewTab` + `PrRootConversation` (read-only) + `StatsTiles` + AI placeholders |
| 10 | Doc updates | n/a (docs-only) | spec / roadmap / arch-readiness updates per § 9 |
| 11 | Contract tests + frozen PR creation | the 5 contract tests | `PRism.GitHub.Tests.Integration` project + frozen-PR setup |
| 12 | Discipline check | n/a | `PRism.Tools.ClusteringDiscipline` + recorded results in this spec |

## 12. Iteration clustering — discipline-check observations

*To be filled in at slice completion. Template:*

> Tested against [N] PRs from `mindbody/Mindbody.BizApp.Bff` and `mindbody/Mindbody.Mobile.BusinessGateway` on [date]. Coefficients used: [final values]. Aggregate agreement with hand-labeled boundaries: [%]. Decision: [retain defaults / tune to X / fall back to one-tab-per-commit].
