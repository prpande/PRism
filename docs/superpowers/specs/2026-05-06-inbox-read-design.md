# S2 — Inbox (read): Design

**Slice**: S2 — second slice in [`docs/roadmap.md`](../../roadmap.md), follows the shipped S0+S1.
**Date**: 2026-05-06.
**Status**: Design approved; pending implementation plan via writing-plans skill.
**Branch**: `worktree-spec+inbox-read` (worktree at `D:\src\PRism\.claude\worktrees\spec+inbox-read`).
**Source authorities**: [`docs/spec/`](../../spec/) is the PoC specification this slice implements; [`design/handoff/`](../../../design/handoff/) is the visual reference. This document does not restate the PoC spec; it commits to a specific subset and adds slice-specific decisions.

---

## 1. Goal

Make the inbox real. Five-section list reading from GitHub, deduplicated, polled every 120s, with a non-intrusive update banner driven by Server-Sent Events. Frontend matches the design handoff. AI category chips and a hand-canned activity rail render when the user flips the AI-preview toggle. URL-paste lets a colleague's chat link land on a temporary stub page (replaced by S3's PR detail view).

End-to-end demo at slice completion:

1. Run the binary; setup as before; arrive at the inbox.
2. Five sections render with real PR rows from the user's GitHub: Review requested, Awaiting author, Authored by me, Mentioned, CI failing on my PRs.
3. Sections are deduplicated by the symmetric rule (1↔4, 3↔5).
4. Click a row → routes to a temporary "PR detail lands in S3" stub.
5. Paste a PR URL above the inbox → routes to the same stub if the URL is a PR on the configured `github.host`; inline error otherwise.
6. AI preview toggle (header, S0+S1) → category chips appear on rows; activity rail appears on the right.
7. Within ~120s of an upstream change (new PR in section, new commit, new comment), an "*N new updates — Reload*" banner appears above the sections; click Reload → updates apply.
8. Quit and relaunch → token still works → inbox loads again.

No PR detail view. No drafts. No submit. No active-PR poller. No per-tab SSE subscription.

## 2. Scope

### In scope

- **Backend inbox pipeline (Approach B — pipeline of small components)**: `ISectionQueryRunner`, `IAwaitingAuthorFilter`, `ICiFailingDetector`, `IInboxDeduplicator`, `IInboxItemEnricher` (drift-corrected), wired by an `InboxRefreshOrchestrator`.
- **Five sections** with the spec's Search API queries verbatim (see [`spec/03-poc-features.md`](../../spec/03-poc-features.md) § 2).
- **Backend deduplication** keyed on the symmetric rule (1↔4 review-requested wins; 3↔5 CI-failing wins). Driven by `config.inbox.deduplicate` (default `true`).
- **Per-PR fan-out for sections 2 & 5** with `(prRef, headSha)` caches and a concurrency cap of 8. Section 2 fans out to `pulls/{n}/reviews`; section 5 fans out to Checks API + legacy combined statuses.
- **Inbox poller**: `BackgroundService` running at `config.polling.inboxSeconds` (default 120s). Paused while `/api/events` has zero subscribers; resumes on next connect with an immediate refresh.
- **`/api/events` SSE channel**: `GET` endpoint streaming events from `IReviewEventBus`. S2 emits **`InboxUpdated` only**. Native `EventSource` reconnection. Per-tab subscribe/unsubscribe lifecycle is **deferred to S3** alongside its first per-PR consumer.
- **`/api/inbox` GET**: returns the cached snapshot. Returns `503` if the first refresh hasn't completed within 5 s.
- **`/api/inbox/parse-pr-url` POST**: backend parses the URL, applies host-match against `config.github.host`, returns `{ ok, ref?, error? }`.
- **`PrInboxItem` expansion**: add fields needed for the design-handoff row — `PushedAt`, `IterationNumber`, `CommentCount`, `Additions`, `Deletions`, `HeadSha`, `Ci`, `LastViewedHeadSha`, `LastSeenCommentId`. The last two are read from `state.json`; **writes land in S3**.
- **AI seam drift correction**: rename `IInboxEnricher` → `IInboxItemEnricher`; batched `EnrichAsync(IReadOnlyList<PrInboxItem>)`; rename DTO `InboxEnrichment` → `InboxItemEnrichment(PrId, CategoryChip, HoverSummary)`. Update `Noop*` and `Placeholder*` impls + DI + `IAiSeamSelector` mapping. (See § 6.)
- **Frontend inbox view** per [`design/handoff/screens.jsx`](../../../design/handoff/screens.jsx) `InboxScreen`: five collapsible sections, `DiffBar`, freshness color, comment count, unread-badge slot (quiet in S2 by design). Section-specific empty-state copy. Empty-everywhere hint above sections.
- **URL-paste escape hatch**: input wired to `POST /api/inbox/parse-pr-url`; on success → navigate to `/pr/:owner/:repo/:number` (the **S3 stub page**, deleted in S3); on host-mismatch / malformed → inline error.
- **S3StubPrPage**: temporary page that renders the parsed `PrReference` and a "Back to Inbox" link. Replaced by S3.
- **Activity rail (hand-canned)** lifted verbatim from `design/handoff/screens.jsx`'s `ActivityFeed`; gated on `usePreferences().aiPreview === true`. **Not seam-backed** — see [`spec/04-ai-seam-architecture.md`](../../spec/04-ai-seam-architecture.md) § "What's NOT seamed (deliberate deferrals)" for the deliberate posture.
- **Inbox banner** for `InboxUpdated` events: shows summary (e.g. *"3 new updates"*) + Reload + dismiss.
- **AI category chips on rows** when `useCapabilities()["ai.inboxEnrichment"] === true` and the enrichment map has an entry for the row's `prId`.
- **Token-scope footer** (static) controlled by `config.inbox.showHiddenScopeFooter` (default `true`).
- **1180px responsive collapse** of the activity rail (single CSS `@media` rule).
- **CI**: existing windows-latest workflow continues to run; new tests run inside it. No new CI infrastructure.

### Out of scope

PR detail view (S3); active-PR poller; per-tab SSE subscribe / unsubscribe lifecycle (S3); SSE write-timeout backpressure (S3); SSE idle-eviction (S3); first-visit `lastViewedHeadSha` / `lastSeenCommentId` *writes* (S3); multi-tab consistency `StateChanged` events (S4); `IInboxRanker` real ordering (v2); detection of token-scope-hidden repos (never — see spec § 2 fine-grained-PAT analysis); `Ctrl/Cmd+K` focus-the-input chord shortcut (v2); section-collapse-state persistence (reconsider in S6); `lastRefreshedAt` UI surface (reconsider in S6); macOS / Linux CI (S6); single-file publish profile (S6).

### Acknowledged carryforwards

Schema fields read but not written in S2:

- `state.reviewSessions[*].lastViewedHeadSha` — read for the unread "new commits" badge; null in S2 → badge stays quiet → `<New>` chip fires.
- `state.reviewSessions[*].lastSeenCommentId` — read for the unread "new comments" badge; null in S2 → same behavior.

Config fields read in S2:

- `polling.inboxSeconds` (default 120)
- `inbox.deduplicate` (default `true`)
- `inbox.sections.{reviewRequested|awaitingAuthor|authoredByMe|mentioned|ciFailing}: bool` (default all `true`)
- `inbox.showHiddenScopeFooter: bool` (default `true`)
- `github.host` (read at poller start to pick the right Search API base; host-change between launches still triggers the S0+S1 modal)
- `ui.aiPreview` (drives capability resolution + activity-rail visibility; already read in S0+S1)

## 3. Project structure changes

```
PRism.Core/
└── Inbox/                                ← NEW namespace
    ├── InboxRefreshOrchestrator.cs       ← wires the 5 pipeline steps; ~50 LOC of glue
    ├── ISectionQueryRunner.cs
    ├── IAwaitingAuthorFilter.cs
    ├── ICiFailingDetector.cs
    ├── IInboxDeduplicator.cs
    ├── InboxDeduplicator.cs              ← pure function; lives in Core (no I/O)
    ├── InboxSnapshot.cs                  ← record { sections, enrichments, lastRefreshedAt }
    ├── InboxPoller.cs                    ← BackgroundService
    ├── InboxSubscriberCount.cs           ← shared counter (incr/decr from /api/events lifecycle)
    └── InboxRefreshState.cs              ← prior snapshot (for diff)

PRism.Core.Contracts/
├── PrInboxItem.cs                        ← EXPANDED (new fields)
└── CiStatus.cs                           ← NEW: enum { None | Pending | Failing }

PRism.GitHub/
└── Inbox/                                ← NEW
    ├── GitHubSectionQueryRunner.cs       ← Search API per section (5 parallel calls)
    ├── GitHubAwaitingAuthorFilter.cs     ← pulls/{n}/reviews + (prRef,headSha) cache
    └── GitHubCiFailingDetector.cs        ← Checks API + combined statuses + (prRef,headSha) cache

PRism.AI.Contracts/
├── Seams/IInboxEnricher.cs               ← RENAMED → IInboxItemEnricher.cs (batched)
└── Dtos/InboxEnrichment.cs               ← RENAMED → InboxItemEnrichment.cs

PRism.AI.Placeholder/
└── PlaceholderInboxEnricher.cs           ← updated to batch + new DTO

PRism.Web/
├── Endpoints/
│   ├── InboxEndpoints.cs                 ← NEW: GET /api/inbox + POST /api/inbox/parse-pr-url
│   └── EventsEndpoints.cs                ← NEW: GET /api/events (SSE)
└── Sse/
    └── SseChannel.cs                     ← in-process IReviewEventBus subscriber → SSE writer

frontend/src/
├── api/
│   ├── inbox.ts                          ← NEW: typed wrapper for /api/inbox + parse-pr-url
│   └── events.ts                         ← NEW: EventSource wrapper
├── hooks/
│   ├── useInbox.ts                       ← NEW
│   └── useInboxUpdates.ts                ← NEW (SSE consumer)
├── components/
│   ├── Inbox/
│   │   ├── InboxToolbar.tsx
│   │   ├── PasteUrlInput.tsx
│   │   ├── InboxBanner.tsx
│   │   ├── InboxSection.tsx
│   │   ├── InboxRow.tsx
│   │   ├── DiffBar.tsx
│   │   ├── EmptyAllSections.tsx
│   │   └── InboxFooter.tsx
│   └── ActivityRail/
│       ├── ActivityRail.tsx
│       └── activityData.ts               ← canned items lifted from screens.jsx
├── pages/
│   ├── InboxPage.tsx                     ← RENAMED from InboxShellPage; full implementation
│   └── S3StubPrPage.tsx                  ← NEW: temp landing for URL-paste; DELETED in S3
└── styles/
    ├── inbox.module.css                  ← NEW
    └── activity-rail.module.css          ← NEW (incl. @media (max-width: 1179px))

tests/
├── PRism.Core.Tests/Inbox/                       ← NEW directory
├── PRism.GitHub.Tests/Inbox/                     ← NEW
└── PRism.Web.Tests/InboxEndpointsTests.cs        ← NEW
└── PRism.Web.Tests/EventsEndpointsTests.cs       ← NEW
└── PRism.Web.Tests/ParseUrlEndpointTests.cs      ← NEW
```

**Reference graph** (unchanged from S0+S1):

- `PRism.Core` → `PRism.Core.Contracts`, `PRism.AI.Contracts`
- `PRism.GitHub` → `PRism.Core`, `PRism.Core.Contracts` (only project with `using Octokit;` — though S2's GitHub HTTP stays raw `HttpClient` per S0+S1 convention)
- `PRism.AI.Placeholder` → `PRism.AI.Contracts`
- `PRism.Web` → `PRism.Core`, `PRism.GitHub`, `PRism.AI.Contracts`, `PRism.AI.Placeholder`

## 4. Stack additions beyond S0+S1

None of substance. Specifically:

- **HTTP** — raw `HttpClient` from S0+S1's `GitHubReviewService`. No Octokit calls in S2.
- **SSE** — ASP.NET Core's `HttpResponse.WriteAsync` + `await Response.Body.FlushAsync()`. No third-party SSE library; the protocol is trivial enough to write inline.
- **Frontend SSE** — native `EventSource`. **Test polyfill needed for Vitest/jsdom**: strawman is the `eventsource` npm package or a 30-line in-house fake. Decision deferred to writing-plans.
- **Frontend state** — `useState` + `useContext` only (matches S0+S1).
- **Search API limit awareness** — no library; the orchestrator paces section queries by running them in parallel inside one tick (5 calls per 120s = 2.5/min, well under the 30/min Search API limit).

## 5. Backend data flow

### 5.1 Cold start

```
launch → S0+S1 startup runs unchanged through the host-change check
  → S2 additions:
    register InboxPoller (BackgroundService)
    register SseChannel (singleton; subscribes to IReviewEventBus on construction)
    register InboxRefreshOrchestrator (singleton)
    register the 5 pipeline interfaces with their GitHub-backed implementations
  → InboxPoller starts but does no work until SseChannel.SubscriberCount > 0
```

### 5.2 First inbox subscriber connects

```
GET /api/events                                                       (browser tab opens)
  → middleware: Origin check passes (S0+S1)
  → response: text/event-stream; cache-control: no-store; connection: keep-alive
  → SseChannel.AddSubscriber(response) increments SubscriberCount from 0 → 1
  → InboxPoller observes the count change → schedules an immediate refresh tick
  → meanwhile: response writer holds the connection open; emits ":heartbeat" every 25s

Simultaneously / shortly after:
GET /api/inbox
  → if InboxRefreshOrchestrator has no snapshot:
        if no refresh is currently in flight:
            kick a one-shot orchestrator.RefreshAsync()
            (this is the deadlock-avoidance path: the spec pauses the poller on
             zero subscribers, but the GET itself must cause a refresh on the
             first call so the user is not stuck waiting for an SSE connect
             that may not have raced ahead)
        block up to 10s on a TaskCompletionSource completed by the first refresh
        if 10s elapsed: 503 with ProblemDetails { "type": "/inbox/initializing" }
  → else: serialize the snapshot to JSON and return 200
```

### 5.3 Refresh tick (the pipeline)

```
InboxPoller.ExecuteAsync (every config.polling.inboxSeconds, while SubscriberCount > 0)
  → InboxRefreshOrchestrator.RefreshAsync(ct)
      ├── ISectionQueryRunner.QueryAllAsync(ct)             [5 Search API calls, parallel]
      │     returns Dictionary<sectionId, RawPrInboxItem[]>
      │
      ├── parallel:
      │     IAwaitingAuthorFilter.FilterAsync(rawSec2, ct)  [pulls/{n}/reviews fan-out]
      │       reads/writes (prRef, headSha) cache
      │       concurrency cap = 8; 404s drop the PR silently
      │     ICiFailingDetector.DetectAsync(rawSec3, ct)     [Checks + statuses fan-out]
      │       reads/writes (prRef, headSha) cache
      │       concurrency cap = 8
      │       inclusion rule: any failing check-run OR any error/failure status
      │       sec5 = filter(rawSec3, item => item.Ci == Failing)
      │
      ├── IInboxDeduplicator.Deduplicate(allSections, config.inbox.deduplicate)
      │     pure function applying the symmetric rule (1↔4, 3↔5)
      │
      ├── IInboxItemEnricher.EnrichAsync(allItems, ct)      [AI seam — Noop returns []]
      │     PoC: Placeholder returns canned `InboxItemEnrichment` per item with
      │     CategoryChip = PlaceholderData.SummaryCategory ("Refactor"); Noop returns [].
      │     Result merged into snapshot.enrichments by PrId.
      │
      ├── compute newSnapshot
      ├── compute diff vs prior snapshot:
      │     newOrUpdatedPrCount = |new PRs| + |PRs whose headSha or commentCount changed|
      │     changedSectionIds = sections where any item appeared / disappeared / mutated
      │
      ├── if diff non-empty:
      │     replace snapshot atomically (single ref swap; no lock — the orchestrator is single-writer)
      │     IReviewEventBus.Publish(new InboxUpdated { changedSectionIds, newOrUpdatedPrCount })
      │
      └── if any pipeline step threw:
            log; preserve prior snapshot; do not publish; next tick retries
```

### 5.4 SSE event delivery

```
IReviewEventBus.InboxUpdated published
  → SseChannel.Handle(InboxUpdated evt)
  → for each registered HttpResponse:
       try:
         response.WriteAsync($"event: inbox-updated\ndata: {json}\n\n")
         await response.Body.FlushAsync(ct)
       catch (anything — broken pipe, cancellation):
         silently remove that subscriber; close response
       (S2 has no per-write timeout; lands in S3 with the lifecycle)
```

### 5.5 Subscriber disconnect

```
client closes EventSource (tab close, navigation away, etc.)
  → ASP.NET Core observes connection cancellation (HttpContext.RequestAborted fires)
  → endpoint handler unwinds; SseChannel.RemoveSubscriber decrements count
  → if count reaches 0: InboxPoller pauses (its loop awaits a "subscribers > 0" signal)
```

### 5.6 URL-paste

```
POST /api/inbox/parse-pr-url    body: { "url": "<pasted>" }
  → IReviewService.TryParsePrUrl(url, out PrReference? ref) implemented in PRism.GitHub
       supported URL shapes: https://<host>/<owner>/<repo>/pull/<number>
       host-match against config.github.host (case-insensitive; trailing-slash tolerant)
  → returns one of:
       200 { "ok": true, "ref": { owner, repo, number } }
       200 { "ok": false, "error": "host-mismatch", "configuredHost": "...", "urlHost": "..." }
       200 { "ok": false, "error": "not-a-pr-url" }
       200 { "ok": false, "error": "malformed" }
       400 { "error": "url-required" }    // empty body
       400 { "error": "invalid-json" }    // unparseable body
```

(All "no match" outcomes are 200 with `ok: false` so the frontend gets structured error info without exception-handling 4xxs. The 400s are reserved for genuinely malformed *requests*.)

### 5.7 Endpoints (S2 additions)

| Endpoint | Method | Body / Response |
|---|---|---|
| `/api/inbox` | GET | → `InboxResponse` (see § 7.1) |
| `/api/inbox/parse-pr-url` | POST | `{ url }` → see § 5.6 |
| `/api/events` | GET | SSE stream; emits `event: inbox-updated\ndata: {...}\n\n` and `:heartbeat\n\n` every 25s |

### 5.8 Capability registry

`/api/capabilities` (S0+S1) reports `ai.inboxEnrichment` based on the existing `IAiSeamSelector` rule (Placeholder → `true`, Noop → `false`). No registry change in S2; the existing flag now actually drives a frontend rendering behavior (chip vs. no chip), which in S0+S1 was theoretical.

## 6. AI seam drift correction

Three coordinated changes ship in **one commit** at the start of the slice (no consumer exists yet, so the rename is mechanical):

**1. Interface rename + signature change.**

```csharp
// Before (S0+S1 actual code):
public interface IInboxEnricher
{
    Task<InboxEnrichment?> EnrichAsync(PrReference pr, CancellationToken ct);
}

// After (matches spec/04-ai-seam-architecture.md):
public interface IInboxItemEnricher
{
    Task<IReadOnlyList<InboxItemEnrichment>> EnrichAsync(
        IReadOnlyList<PrInboxItem> items, CancellationToken ct);
}
```

**2. DTO rename + reshape.**

```csharp
// Before:
public sealed record InboxEnrichment(string Category, string? OneLineSummary);

// After:
public sealed record InboxItemEnrichment(string PrId, string? CategoryChip, string? HoverSummary);
```

`PrId` is the canonical `"<owner>/<repo>#<number>"` form `IReviewService.TryParsePrUrl` produces. `CategoryChip` is the short label rendered on the row; `HoverSummary` is the longer text shown on hover (rendered behind a slot that doesn't exist in S2 — keeps the field for v2 without forcing its consumer now).

**3. Implementation updates.**

- `NoopInboxItemEnricher.EnrichAsync` returns `Array.Empty<InboxItemEnrichment>()` (replaces the old `Task.FromResult<InboxEnrichment?>(null)`).
- `PlaceholderInboxItemEnricher.EnrichAsync` projects each input PR to one `InboxItemEnrichment` with `CategoryChip = "Refactor"` (lifted from `PlaceholderData.SummaryCategory`) and a fixed `HoverSummary`.
- DI registration in `Program.cs` updates the singleton type names and the `IAiSeamSelector` mapping dictionaries (currently keyed on `typeof(IInboxEnricher)`, now `typeof(IInboxItemEnricher)`).

One existing test exercises the old seam — `tests/PRism.Core.Tests/Ai/NoopSeamTests.cs::NoopInboxEnricher_returns_null` — and is updated as part of this commit (renamed to `NoopInboxItemEnricher_returns_empty_array`; assertion changed from `BeNull()` to empty-list). No other test code references the old type names. The next commit — wiring the orchestrator — is the first real call site.

## 7. Wire shapes

### 7.1 `GET /api/inbox` response

```jsonc
{
  "sections": [
    {
      "id": "review-requested",
      "label": "Review requested",
      "items": [
        {
          "reference": { "owner": "acme", "repo": "api", "number": 1842 },
          "title": "Lease renewal: consolidate retry policy",
          "author": "amelia.cho",
          "repo": "acme/api",
          "updatedAt": "2026-05-06T10:23:11Z",
          "pushedAt": "2026-05-06T10:18:04Z",
          "iterationNumber": 3,
          "commentCount": 7,
          "additions": 142,
          "deletions": 38,
          "headSha": "abc123…",
          "ci": "none",                         // none | pending | failing
          "lastViewedHeadSha": null,            // null in S2; S3 begins writing
          "lastSeenCommentId": null
        }
      ]
    }
    /* awaiting-author, authored-by-me, mentioned, ci-failing */
  ],
  "enrichments": {
    "acme/api#1842": { "categoryChip": "Refactor", "hoverSummary": "..." }
    /* one entry per PR if ai.inboxEnrichment capability is on; empty object otherwise */
  },
  "lastRefreshedAt": "2026-05-06T10:23:11Z",
  "tokenScopeFooterEnabled": true
}
```

Hidden sections (per `config.inbox.sections.<id>: false`) are **omitted from the array** entirely (no empty header rendered).

JSON enums round-trip as kebab-case lowercase per the S0+S1 convention. Concrete section `id` values: `"review-requested"`, `"awaiting-author"`, `"authored-by-me"`, `"mentioned"`, `"ci-failing"`. CI status values: `"none"`, `"pending"`, `"failing"`. Note the asymmetry with the *config* keys (`config.inbox.sections.reviewRequested` is camelCase, since config keys are property names not enums) — both follow the project's existing rule that *enums* are kebab and *property names* are camel.

### 7.2 `/api/events` frame format

```
event: inbox-updated
data: {"changedSectionIds":["awaiting-author","ci-failing"],"newOrUpdatedPrCount":3}

:heartbeat

```

Heartbeat frames are SSE comments (start with `:`) — browsers ignore them; they exist only to keep proxies and the browser's TCP stack from pruning the connection.

### 7.3 `PrInboxItem` (PRism.Core.Contracts)

```csharp
public sealed record PrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,                       // "<owner>/<repo>" canonical
    DateTimeOffset UpdatedAt,
    DateTimeOffset PushedAt,
    int IterationNumber,               // simplified count of distinct head SHAs
    int CommentCount,
    int Additions,
    int Deletions,
    string HeadSha,
    CiStatus Ci,                       // None | Pending | Failing
    string? LastViewedHeadSha,         // read from state.json; null in S2
    long? LastSeenCommentId);

public enum CiStatus { None, Pending, Failing }
```

`IterationNumber` for S2's row is the count of distinct head SHAs in the PR's history (one extra per-PR REST call would be required to get this precisely; the simpler approach is to bucket by `commits` count from the Search API result, which is good enough for the row chip). Full iteration reconstruction is S3's concern.

## 8. Caches

| Cache | Owner | Key | Lifetime | Invalidation | Spec ref |
|---|---|---|---|---|---|
| Per-section "latest snapshot" | `InboxRefreshOrchestrator` | `(sectionId, queryHash)` | until next 120s tick | wholesale replace | `spec/02-architecture.md` § Caching strategy table row 1 |
| Awaiting-author "user's last review per PR" | `GitHubAwaitingAuthorFilter` | `(prRef, headSha)` | until `headSha` changes | natural key miss | row 2 |
| CI-failing check-runs + statuses | `GitHubCiFailingDetector` | `(prRef, headSha)` | until `headSha` changes | natural key miss | row 3 |

All three are `ConcurrentDictionary<TKey, TValue>` instances; no TTL. Size is naturally bounded by "open PRs in your inbox" (tens, not thousands). Cold-start cost on backend restart is one inbox refresh's worth of fan-out — accepted (see § 11).

The fourth row in the spec's table (active-PR poller) lands in S3.

## 9. Frontend data flow

### 9.1 Routing (App.tsx)

```tsx
<Route path="/" element={<RequireAuth><InboxPage /></RequireAuth>} />
<Route path="/setup" element={<SetupPage />} />
<Route path="/pr/:owner/:repo/:number" element={<RequireAuth><S3StubPrPage /></RequireAuth>} />
```

`S3StubPrPage` reads its three params, renders "PR detail lands in S3 — `<owner>/<repo>#<number>`", and a "Back to Inbox" link. **Deleted in S3** when `PrDetailPage` takes the route.

### 9.2 InboxPage tree

```
InboxPage
└─ InboxContext.Provider (value = useInbox() + useInboxUpdates() + capability gate)
   ├─ InboxBanner                   (when hasUpdate)
   ├─ InboxToolbar
   │  └─ PasteUrlInput
   └─ inbox-grid
      ├─ inbox-sections
      │  ├─ EmptyAllSections        (when every section is empty)
      │  ├─ InboxSection × N
      │  │  └─ InboxRow × M
      │  │     ├─ DiffBar
      │  │     └─ category chip     (when capabilities['ai.inboxEnrichment'] && enrichments[prId])
      │  └─ InboxFooter             (when tokenScopeFooterEnabled)
      └─ ActivityRail               (when preferences.aiPreview === true)
```

Section collapse state is local to each `InboxSection` (`useState`); not persisted across reloads.

`InboxRow` renders as a button whose `onClick` calls `navigate(\`/pr/${ref.owner}/${ref.repo}/${ref.number}\`)` — same destination as the URL-paste flow. Both end up at `S3StubPrPage` in S2, replaced by `PrDetailPage` in S3. Keyboard activation (Enter / Space) follows from the button semantics; no extra wiring needed.

### 9.3 `useInbox` hook

```tsx
function useInbox() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async () => {
    try {
      setData(await api.getInbox());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return { data, error, reload, isLoading: data == null && error == null };
}
```

A `401` from `/api/inbox` (token rejected post-launch) demotes to `/setup` — the demotion already exists in the S0+S1 fetch wrapper.

A `503` from `/api/inbox` (first refresh hasn't completed) is retried by the wrapper with exponential backoff capped at 5s; after three attempts, the inline error renders.

### 9.4 `useInboxUpdates` hook

```tsx
function useInboxUpdates() {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [summary, setSummary] = useState("");

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("inbox-updated", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { newOrUpdatedPrCount: number };
      setHasUpdate(true);
      setSummary(`${data.newOrUpdatedPrCount} new updates`);
    });
    return () => es.close();
  }, []);

  return { hasUpdate, summary, dismiss: () => setHasUpdate(false) };
}
```

Native `EventSource` reconnects with exponential backoff. On reconnect, the server doesn't replay; the user can still hit Reload to fetch the latest snapshot.

### 9.5 URL-paste flow

```
user pastes URL into PasteUrlInput
  → onPaste fires; immediately POST /api/inbox/parse-pr-url
  → on { ok: true }:  navigate(`/pr/${ref.owner}/${ref.repo}/${ref.number}`)
  → on { ok: false }: render inline error pill below input
       host-mismatch:  "This PR is on <urlHost>, but PRism is configured for <configuredHost>."
       not-a-pr-url:   "That doesn't look like a PR link."
       malformed:      "Couldn't parse that URL."
  → on 4xx:           "Couldn't reach the server. Try again."
```

Error pill clears on next input change.

### 9.6 AI placeholder gating

| Surface | Gate | Source |
|---|---|---|
| Row category chip | `capabilities["ai.inboxEnrichment"] === true` AND `enrichments[prId]` exists | `useCapabilities()` + response |
| Activity rail | `preferences.aiPreview === true` | `usePreferences()` |

The gates are different by intent: the chip is gated on a specific capability (the seam's resolution rule decides), while the rail is gated on the preference directly because there is no seam. In S2 both gates flip together (Placeholder ⇒ chip enabled + rail visible; Noop ⇒ neither), but the wiring is independent so v2 can change one without the other.

### 9.7 Activity rail responsive collapse

```css
/* activity-rail.module.css */
.inboxRail { /* desktop styles */ }

@media (max-width: 1179px) {
  .inboxRail { display: none; }
}
```

The grid container (`inbox-grid`) uses `grid-template-columns: 1fr auto` on desktop; when the rail is hidden, it falls back to `1fr` because there's nothing in the second column to claim space. (No `:has()` selector dependency — the layout works without it.)

### 9.8 InboxContext shape

```tsx
interface InboxContextValue {
  sections: InboxSectionDto[];
  enrichments: Record<string, InboxItemEnrichmentDto>;
  isLoading: boolean;
  error: unknown;
  reload: () => Promise<void>;
  hasUpdate: boolean;
  updateSummary: string;
  dismissBanner: () => void;
  tokenScopeFooterEnabled: boolean;
}
```

A single context provider at `InboxPage` level keeps the tree shallow; subcomponents read via `useContext(InboxContext)`. Matches the "useState + useContext only" rule from S0+S1.

## 10. Error handling matrix

| Failure | Layer | Handling | User-facing |
|---|---|---|---|
| Search API 401 | Backend | Demote: clear in-memory snapshot, mark inbox unhealthy. Next `/api/inbox` returns 401. | Frontend demotes to `/setup`. |
| Search API 403 / scopes | Backend | Same as 401. | Same. |
| Search API 422 (invalid query) | Backend | Log at `Warning`; skip this section in the tick; other sections still serve. | Section appears empty in the response; banner / count not affected. |
| Search API 429 / secondary rate limit | Backend | Honor `Retry-After`; skip this tick; resume next cadence. | Frontend never sees it (snapshot stays valid). |
| `pulls/{n}/reviews` 404 (per-PR) | Backend | PR silently filtered from awaiting-author section (token doesn't cover repo). | Soft footer covers it. |
| `pulls/{n}/check-runs` 404 (per-PR) | Backend | Same — PR filtered from CI-failing. | Same. |
| Network exception during refresh | Backend | Skip this tick; log; preserve prior snapshot. | Frontend continues serving prior snapshot. |
| `GET /api/inbox` before first refresh completes | Backend | Block up to 10s on a TaskCompletionSource; if not ready, `503` with `ProblemDetails { type: /inbox/initializing }`. | Frontend retries with exponential backoff; after 3 attempts inline error renders. |
| `POST /api/inbox/parse-pr-url` malformed JSON | Backend | `400 { error: "invalid-json" }`. | Frontend renders generic input error. |
| `POST /api/inbox/parse-pr-url` non-string `url` | Backend | `400 { error: "url-required" }`. | Same. |
| SSE: client disconnect | Backend | Decrement subscriber count; close `HttpResponse`. | n/a |
| SSE: write blocks > 30s | Backend | (Deferred to S3 — write-timeout backpressure) | A stuck client could in theory slow broadcasts; volume is trivial in S2 (1 event / 120s, payload < 200 B). |
| `EventSource` client-side reconnect | Frontend | Native exponential backoff. | None (silent). |
| Hidden section in config | Backend | Section omitted from response array. | Section header doesn't render. |
| `aiPreview = true` but capability says `false` | Frontend | `useCapabilities()` is the gate, not `aiPreview`. | Category chips stay hidden until backend reports the capability. |
| Hidden section in config but PR appears in another section by dedup | Backend | Hidden section is skipped *before* dedup runs (queries don't fire). The PR can still appear in its non-hidden section. | Behaves as the user expects. |
| `state.json` missing the unread-badge keys for a PR | Backend | Treat as null → no unread badge → `<New>` chip via the spec's first-visit rule. | Same first-visit semantics for every PR in S2 (no writes yet). |

**Global pattern** unchanged from S0+S1: ProblemDetails on 5xx with `traceId`; `X-Request-Id` correlation; toast on errors with "Copy diagnostic info"; one global error boundary at the React root.

## 11. Acknowledged trade-offs

- **No per-tab SSE subscribe lifecycle in S2.** S2's single channel can't tell "this tab cares about PR X" — there is no PR-X consumer yet. Lands in S3 alongside the active-PR poller.
- **No SSE write-timeout / idle-eviction.** A stuck client could theoretically slow broadcasts. S2 volume is trivial (1 event per 120s). Lands in S3.
- **Per-PR fan-out caches are per-process.** Backend restart cold-starts caches; first refresh costs ~30 extra REST calls (sec 2 worst case) + 2N for sec 5. Persisting them prematurely would be cache-aliasing the actual spec invalidation rule (head_sha). Stays in-memory.
- **Inbox poller pauses with zero subscribers.** If user closes their last tab and reopens 10 minutes later, the snapshot is stale up to 120s + connect latency. The first connect kicks an immediate refresh; user sees fresh data within seconds.
- **Reads `lastViewedHeadSha` / `lastSeenCommentId` only; never writes.** S2 unread badges are quiet by design. Every PR shows the `<New>` chip until S3 begins writing the keys. This matches the spec's first-visit-suppression rule, just with everything always being a first visit.
- **No detection of token-scope-hidden PRs.** Static footer driven by `config.inbox.showHiddenScopeFooter`. The fine-grained-PAT analysis in `spec/03-poc-features.md` is firm that detection is misleading.
- **Category chip wording.** `Placeholder*` returns the canned strings from `PlaceholderData` — same chip text on every PR. Visually demonstrates the AI-flag flip without pretending to be intelligent. v2 replaces.
- **Activity rail is hand-canned, not seam-backed.** Documented in `spec/04-ai-seam-architecture.md` § "What's NOT seamed (deliberate deferrals)" and `spec/03-poc-features.md` § 2 "Activity rail." Future architecture sweeps should not re-propose adding a seam without a real v2 consumer.
- **AI seam drift correction lands inside the S2 PR.** Could be split, but the rename has zero behavior impact (no consumer was calling the seam) and pairing with the first consumer keeps the diff comprehensible. Easy to split at writing-plans time if reviewers prefer.
- **No `Ctrl/Cmd+K` focus-the-input chord shortcut.** `Ctrl/Cmd+V` to paste into the *already-focused* input is browser-native and works as expected. The chord shortcut to focus the input from anywhere on the page is deferred to v2 with the rest of the chord-shortcut family.
- **Section collapse state is not persisted.** Reopen → all sections expanded. Persistence would need a `state.json` schema field; not worth the schema growth for a UX nicety. Reconsider in S6.
- **No `lastRefreshedAt` UI.** Backend exposes it; frontend doesn't render it. The Reload banner is the user-visible signal. Reconsider in S6.
- **`IterationNumber` is approximate in S2.** Bucketed from the Search API result's commit count. Full iteration reconstruction is S3's concern; the row chip is informational.
- **macOS / Linux not actively tested in S2.** S2 ships windows-latest CI only (matches S0+S1). Manual macOS verification documented in the slice's acceptance procedure.

## 12. Testing strategy

**Process**: TDD throughout. Every behavior listed in §§ 1–11 lands as `red → green → refactor`. The list below is the *expected shape* of the suite at end-of-slice, not a sequenced plan.

### `PRism.Core.Tests/Inbox/`

- **`InboxDeduplicatorTests`** — 1↔4 dedup; 3↔5 dedup; both pairs simultaneously; PR in 1+4+3+5; `deduplicate: false` returns all memberships; empty input; only-one-section non-empty; unrelated overlap (PR in 1+3 — different pair, no dedup); identity rule (no PR appears twice in result); section ordering preserved.
- **`InboxRefreshOrchestratorTests`** — happy path with fakes for all five interfaces; one fan-out throws → other sections still complete; enrichment returns `[]` (Noop) → rows render without chips; enrichment partial coverage → only matching rows get chips; diff-vs-prior emits no event when nothing changed; diff emits event with correct `changedSectionIds` and `newOrUpdatedPrCount`; first refresh signals the gating TCS.
- **`InboxPollerTests`** — subscriber count 0 → no refresh tick fires; first connect → immediate refresh + cadence resumes; last disconnect → cadence pauses (verified via `IClock` advance); exception inside one tick → next tick still runs; cancellation token honored.
- **`InboxSubscriberCountTests`** — increment / decrement / concurrent atomicity; reset on application stop.

### `PRism.GitHub.Tests/Inbox/`

- **`GitHubSectionQueryRunnerTests`** — 5 queries with correct encoded form; rate-limit 429 surfaces typed exception; partial failure (1 of 5 sections fails) → returned dictionary with the 4 successes plus the failure recorded; query-string changes when `github.host` changes (cloud vs GHES base URL).
- **`GitHubAwaitingAuthorFilterTests`** — `pulls/{n}/reviews` per item; cache hit returns cached without HTTP; cache miss issues HTTP; `headSha` change invalidates entry; concurrency cap of 8 honored under load (8 in-flight, 9th queues); 404 → PR filtered out silently.
- **`GitHubCiFailingDetectorTests`** — Checks API + legacy combined-statuses both queried; `any-failing` inclusion rule (failing check-run alone, error/failure status alone, both, all-passing, all-pending); cache behavior mirrors awaiting-author tests; pagination of `/check-runs` if a PR has > 100 checks.

### `PRism.Web.Tests/`

- **`InboxEndpointsTests`** — happy `GET /api/inbox` with 5 sections; `inbox.sections.mentioned: false` config → mentioned section absent; `inbox.deduplicate: false` → all memberships present; `tokenScopeFooterEnabled` reflects config; ProblemDetails shape on 5xx; `503` when first refresh has not completed.
- **`ParseUrlEndpointTests`** — valid cloud URL; valid GHES URL when `github.host = ghe.acme.com`; host-mismatch returns `{ ok: false, error: "host-mismatch" }`; malformed URL → `{ ok: false, error: "malformed" }`; non-PR URL (issue, commit) → `{ ok: false, error: "not-a-pr-url" }`; empty body → 400 `url-required`; invalid JSON → 400 `invalid-json`.
- **`EventsEndpointsTests`** — connection opens → subscriber count increments; close → decrements; emits heartbeat at expected cadence (advance test clock); `InboxUpdated` published on bus → frame written to all subscribers; CSRF/Origin policy permits same-origin SSE GET.

### `frontend/__tests__/` (Vitest + Testing Library + MSW)

- **`InboxRow.test.tsx`** — renders title/repo/author/age; CI status dot; unread badge null when `lastViewedHeadSha == null` (first-visit suppression); category chip renders only when capability + enrichment both present.
- **`InboxSection.test.tsx`** — collapse/expand; section-specific empty-state copy by id; count rendered.
- **`DiffBar.test.tsx`** — width scales relative to `max`; addition / deletion split correct.
- **`PasteUrlInput.test.tsx`** — happy submit → navigate; host-mismatch → inline error; malformed → inline error; clears error on edit.
- **`useInbox.test.tsx`** (MSW) — 200 happy; 401 demotes to `/setup`; 503 retried with backoff; 5xx after retries renders error.
- **`useInboxUpdates.test.tsx`** — polyfilled `EventSource` simulates `inbox-updated`; banner appears with summary; dismiss clears.
- **`S3StubPrPage.test.tsx`** — renders parsed reference; Back link navigates to `/`.

### `frontend/e2e/` (Playwright)

- Cold-start → setup → inbox loads with stub PRs (recorded fixture for the 5 Search API responses).
- URL paste happy → S3 stub renders parsed ref.
- URL paste host mismatch → inline error visible, no navigation.
- SSE banner: simulate `InboxUpdated` via test endpoint → banner appears → click Reload → banner clears, `/api/inbox` re-fetched.
- AI preview toggle (header) flips category chips and activity rail visibility live.

### Test infrastructure additions beyond S0+S1

- `FakeHttpMessageHandler` (already in S0+S1) extended with sequence-based response stubs for the per-PR fan-out.
- `FakeReviewEventBus` for orchestrator tests (record-published-events helper).
- SSE polyfill for Vitest/jsdom (decision deferred to writing-plans: `eventsource` npm package vs ~30-line in-house fake).
- Recorded GitHub Search API JSON fixtures committed under `tests/PRism.GitHub.Tests/Fixtures/inbox-search/`. PRs are anonymized; one fixture per section.
- Deterministic `IClock` for `InboxPoller` cadence tests (already in S0+S1).

## 13. Decisions deferred to writing-plans

- Exact red-test-first sequencing of behaviors within the slice.
- npm package versions for the SSE polyfill (or a 30-line in-house fake).
- Concrete REST call shapes for the per-PR fan-out (raw `HttpClient` per S0+S1 convention; specific `Octokit` calls only if a particular integration benefits).
- Whether `activityData.ts` lives as TS constants or a JSON import.
- Exact SSE heartbeat cadence (strawman: 25s).
- Banner summary copy ("3 new updates" vs handoff's "3 PRs have updates since you last loaded").
- Whether to ship a small `e2e/fixtures/` with anonymized GitHub Search API JSON or to record live during E2E.
- Whether `InboxContext` is a discrete file or co-located in `InboxPage.tsx`.
- Whether the AI seam drift-correction is a separate prep PR or rolled into the S2 PR (lean: rolled in).
- The exact `IInboxRanker` invocation point (the spec lists ranking as identity in PoC; whether to call it as a no-op step in the orchestrator, or skip the call entirely, is a 2-line decision; see backlog `03-P2-extended-ai.md` § P2-13 for the v2 real-ordering entry).

## 14. References

- [`docs/spec/00-verification-notes.md`](../../spec/00-verification-notes.md) — falsified assumptions; the Search API rate-limit and CI inclusion rule for sec 5 are spec-load-bearing.
- [`docs/spec/01-vision-and-acceptance.md`](../../spec/01-vision-and-acceptance.md) — vision + DoD; **Development process** section codifies TDD.
- [`docs/spec/02-architecture.md`](../../spec/02-architecture.md) — stack, project layout, `IReviewService`, host config, polling lifecycle, caching strategy table.
- [`docs/spec/03-poc-features.md`](../../spec/03-poc-features.md) — § 2 Inbox (queries, sections, dedup, polling, footer); § 8 Banner update model; § 12 Error handling baseline.
- [`docs/spec/04-ai-seam-architecture.md`](../../spec/04-ai-seam-architecture.md) — `IInboxItemEnricher` (corrected here), `IReviewEventBus` events, capability registry, "What's NOT seamed" (activity rail).
- [`docs/spec/05-non-goals.md`](../../spec/05-non-goals.md) — confirms PR detail / drafts / submit not in this slice.
- [`docs/roadmap.md`](../../roadmap.md) — slice decomposition; carryforwards from S2 are tracked in S3 and S4 rows.
- [`design/handoff/screens.jsx`](../../../design/handoff/screens.jsx) — `InboxScreen`, `InboxRow`, `InboxSection`, `DiffBar`, `ActivityFeed` are the visual reference; the activity rail's canned data is lifted from the `ActivityFeed` items array.
- [`design/handoff/README.md`](../../../design/handoff/README.md) — responsive rules; tokens; the 1180px breakpoint for the rail.
- [`docs/superpowers/specs/2026-05-05-foundations-and-setup-design.md`](2026-05-05-foundations-and-setup-design.md) — the prior slice's design; defines the stack lock-in and the AI seam DI pattern this slice extends.
- [`CLAUDE.md`](../../../CLAUDE.md) — agent guidance; the TDD development-process rule.
