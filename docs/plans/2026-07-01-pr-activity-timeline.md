# PR Activity Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Overview tab's standalone root-conversation card with a single unified, newest-first activity+conversation feed (comments as cards, review/push/lifecycle events as markers), with commit-run grouping and live-refresh.

**Architecture:** A new single-PR paginated GraphQL `timelineItems` reader (`IPrTimelineFeedReader`) feeds a `GET .../timeline?cursor=` endpoint. The React feed owns its own fetch (load / "show older" / post-refetch / SSE live-refresh); it does **not** read the `headSha`-keyed PrDetail snapshot. Live-refresh is delivered by widening `ActivePrPoller`'s emission gate so review/reviewer deltas publish the existing `pr-updated` frame. Commit-run grouping is a pure client-side transform.

**Tech Stack:** Backend — C#/.NET 10 minimal APIs, System.Text.Json, GraphQL over `GitHubHttp`. Frontend — React + Vite + TypeScript, vitest + Testing Library, Playwright e2e.

**Spec:** `docs/specs/2026-07-01-pr-activity-timeline-design.md`

## Global Constraints

- Wire enums serialize **kebab-case** (`ActivityVerb` → `approved`, `changes-requested`, `pushed`). Config JSON on disk is kebab-case; API DTOs are camelCase.
- Frontend: run `npm run lint` (prettier `--check` gates CI); `eslint` no-unused-vars ignores `_`-prefixed. Typecheck with `tsc -b`, never `tsc --noEmit`. Run vitest/playwright via the local `.bin` binaries, never `npx`.
- Backend: build/test with the real `dotnet.exe`; xUnit + FluentAssertions; test classes `public sealed class …Tests`, `[Fact]`, methods `Verb_snake_case`.
- GET endpoints under `PrDetailEndpoints.cs` do **not** enforce the tab-id header (mutations only); validate `owner`/`repo` with `SharedRegexes.OwnerRepo()` before use.
- New GraphQL query wire output must be pinned with a `RecordingHttpMessageHandler` + `GraphQlRequest.QueryOf(...).Should().Be(...)` byte-identity golden (repo precedent #682). Capture the golden in its own green commit.
- Adding a card after `StatsTiles` changes the Overview DOM → regenerate the `pr-detail-overview` Playwright visual baseline (Linux via CI artifact) in the same PR; grep e2e specs for `overview-tab` before changing markup.
- Feed is **timeline-endpoint-sourced**; never wire feed freshness to `PrDetailLoader.Invalidate`.

---

## File structure

**Backend (create):**
- `PRism.Core/Activity/TimelineFeedContracts.cs` — `TimelineActorRef`, `TimelineEvent`, `TimelinePage`, `IPrTimelineFeedReader`.
- `PRism.GitHub/Activity/GitHubPrTimelineFeedReader.cs` — paginated `timelineItems` reader.
- `tests/PRism.GitHub.Tests/Activity/GitHubPrTimelineFeedReaderTests.cs`.

**Backend (modify):**
- `PRism.Web/Endpoints/PrDetailEndpoints.cs` — add `GET .../timeline`.
- `PRism.Core/PrDetail/ActivePrPoller.cs` + `ActivePrPollerState.cs` — widen emission gate on reviewer deltas.
- `PRism.Web/Program.cs` (or the DI composition root) — register `IPrTimelineFeedReader`.
- `tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs` — reviewer-delta emission test.

**Frontend (create):**
- `frontend/src/api/timeline.ts` — `getTimelinePage`.
- `frontend/src/components/PrDetail/OverviewTab/timeline/groupCommitRuns.ts` — pure grouping transform.
- `frontend/src/components/PrDetail/OverviewTab/timeline/useTimelineFeed.ts` — feed data hook.
- `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.tsx` — presentational feed + composer host.
- `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.module.css`.
- Co-located `*.test.ts(x)` for the three TS modules.

**Frontend (modify):**
- `frontend/src/api/types.ts` — add `TimelineActorRef`, `TimelineEvent`, `TimelinePage`.
- `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx` — swap `PrRootConversation` for `ActivityFeed`.
- `frontend/e2e/parity-baselines.spec.ts` baseline regen.

---

### Task 1: Backend timeline contracts (`PRism.Core`)

**Files:**
- Create: `PRism.Core/Activity/TimelineFeedContracts.cs`
- Test: `tests/PRism.Core.Tests/Activity/TimelineFeedContractsTests.cs`

**Interfaces:**
- Produces: `TimelineActorRef(string? Login, string? AvatarUrl, bool IsBot)`; `TimelineEvent(string Id, ActivityVerb Verb, TimelineActorRef Actor, DateTimeOffset Timestamp, string? Body, int? CommitCount, string? Subject)`; `TimelinePage(IReadOnlyList<TimelineEvent> Events, string? OlderCursor, bool HasOlder)`; `IPrTimelineFeedReader.ReadPageAsync(PrReference, string? cursor, int pageSize, CancellationToken) → Task<TimelinePage>`.

- [ ] **Step 1: Write the failing test**

```csharp
using FluentAssertions;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class TimelineFeedContractsTests
{
    [Fact]
    public void TimelinePage_exposes_events_cursor_and_hasolder()
    {
        var actor = new TimelineActorRef("alice", "https://a/alice", IsBot: false);
        var evt = new TimelineEvent(
            Id: "c1", Verb: ActivityVerb.Approved, Actor: actor,
            Timestamp: DateTimeOffset.UnixEpoch, Body: null, CommitCount: null, Subject: null);
        var page = new TimelinePage(new[] { evt }, OlderCursor: "cur", HasOlder: true);

        page.Events.Should().ContainSingle().Which.Verb.Should().Be(ActivityVerb.Approved);
        page.OlderCursor.Should().Be("cur");
        page.HasOlder.Should().BeTrue();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter TimelineFeedContractsTests`
Expected: FAIL — `TimelineEvent`/`TimelinePage`/`IPrTimelineFeedReader` do not exist.

- [ ] **Step 3: Write the contracts**

```csharp
namespace PRism.Core.Activity;

/// <summary>Actor on a timeline node. Login/avatar are null for actorless/system events.</summary>
public sealed record TimelineActorRef(string? Login, string? AvatarUrl, bool IsBot);

/// <summary>
/// One node in the unified PR activity feed. <paramref name="Body"/> is non-null only for
/// comments and reviews-with-body (rendered as cards); bare state changes leave it null (markers).
/// <paramref name="CommitCount"/> is set on push nodes for grouped rendering; <paramref name="Subject"/>
/// carries a verb-specific target (e.g. the requested reviewer for <see cref="ActivityVerb.ReviewRequested"/>).
/// </summary>
public sealed record TimelineEvent(
    string Id,
    ActivityVerb Verb,
    TimelineActorRef Actor,
    DateTimeOffset Timestamp,
    string? Body,
    int? CommitCount,
    string? Subject);

/// <summary>
/// One newest-first page of the feed. <paramref name="OlderCursor"/> + <paramref name="HasOlder"/>
/// drive "Show older activity" (backward pagination); when <c>HasOlder</c> is false the synthesized
/// <see cref="ActivityVerb.Opened"/> node is the last (oldest) element.
/// </summary>
public sealed record TimelinePage(
    IReadOnlyList<TimelineEvent> Events,
    string? OlderCursor,
    bool HasOlder);

/// <summary>Reads a single PR's full activity timeline, newest-first, one page at a time.</summary>
public interface IPrTimelineFeedReader
{
    Task<TimelinePage> ReadPageAsync(PrReference prRef, string? cursor, int pageSize, CancellationToken ct);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests --filter TimelineFeedContractsTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Activity/TimelineFeedContracts.cs tests/PRism.Core.Tests/Activity/TimelineFeedContractsTests.cs
git commit -F- <<'EOF'
feat(#620): add PR timeline feed contracts

TimelineActorRef / TimelineEvent / TimelinePage + IPrTimelineFeedReader.
EOF
```

---

### Task 2: `GitHubPrTimelineFeedReader` — paginated timeline read

**Files:**
- Create: `PRism.GitHub/Activity/GitHubPrTimelineFeedReader.cs`
- Test: `tests/PRism.GitHub.Tests/Activity/GitHubPrTimelineFeedReaderTests.cs`

**Interfaces:**
- Consumes: contracts from Task 1; `HostUrlResolver.GraphQlEndpoint`, `GitHubHttp.SendAsync`, `ActivityFeedBuilder`-style bot detection (reuse `__typename == "Bot"`).
- Produces: `GitHubPrTimelineFeedReader(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<string> readHost) : IPrTimelineFeedReader`.

Ordering / cursor semantics: query `timelineItems(last:pageSize, before:$cursor, itemTypes:[…])` with `pageInfo{ hasPreviousPage startCursor }`. GraphQL returns oldest→newest; the reader **reverses** to newest-first. `OlderCursor = startCursor`, `HasOlder = hasPreviousPage`. When `HasOlder` is false, append a synthesized `Opened` event (from `pullRequest.createdAt` + `author`) as the oldest element. Degrade-don't-throw (non-2xx → empty page), mirroring `GitHubPrTimelineReader`.

- [ ] **Step 1: Write the failing tests**

```csharp
using System.Net;
using FluentAssertions;
using PRism.Core;
using PRism.Core.Activity;
using PRism.GitHub.Activity;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Activity;

public sealed class GitHubPrTimelineFeedReaderTests
{
    private static readonly PrReference Pr = new("acme", "api", 7);

    private static GitHubPrTimelineFeedReader MakeReader(HttpStatusCode code, string json)
        => new(
            new FakeHttpClientFactory(FakeHttpMessageHandler.Returns(code, json), new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"),
            () => "https://github.com");

    [Fact]
    public async Task Maps_review_and_commit_nodes_newest_first()
    {
        const string json = """
        {"data":{"repository":{"pullRequest":{
          "createdAt":"2020-01-01T00:00:00Z",
          "author":{"login":"opener","avatarUrl":"https://a/opener","__typename":"User"},
          "timelineItems":{
            "pageInfo":{"hasPreviousPage":true,"startCursor":"CUR"},
            "nodes":[
              {"__typename":"PullRequestCommit","commit":{"oid":"deadbeef","committedDate":"2021-01-01T00:00:00Z","author":{"user":{"login":"bob","avatarUrl":"https://a/bob","__typename":"User"}}}},
              {"__typename":"PullRequestReview","state":"APPROVED","body":"","submittedAt":"2021-01-02T00:00:00Z","author":{"login":"alice","avatarUrl":"https://a/alice","__typename":"User"}}
            ]}}}}}
        """;
        var page = await MakeReader(HttpStatusCode.OK, json).ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);

        page.HasOlder.Should().BeTrue();
        page.OlderCursor.Should().Be("CUR");
        page.Events.Should().HaveCount(2);
        page.Events[0].Verb.Should().Be(ActivityVerb.Approved);      // newest first
        page.Events[0].Actor.Login.Should().Be("alice");
        page.Events[1].Verb.Should().Be(ActivityVerb.Pushed);
        page.Events[1].CommitCount.Should().Be(1);
    }

    [Fact]
    public async Task Synthesizes_opened_node_when_no_older_pages()
    {
        const string json = """
        {"data":{"repository":{"pullRequest":{
          "createdAt":"2020-01-01T00:00:00Z",
          "author":{"login":"opener","avatarUrl":"https://a/opener","__typename":"User"},
          "timelineItems":{"pageInfo":{"hasPreviousPage":false,"startCursor":null},"nodes":[]}}}}}
        """;
        var page = await MakeReader(HttpStatusCode.OK, json).ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);

        page.HasOlder.Should().BeFalse();
        page.Events.Should().ContainSingle();
        page.Events[^1].Verb.Should().Be(ActivityVerb.Opened);
        page.Events[^1].Actor.Login.Should().Be("opener");
    }

    [Fact]
    public async Task Degrades_to_empty_page_on_non_success()
    {
        var page = await MakeReader(HttpStatusCode.BadGateway, "{}").ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);
        page.Events.Should().BeEmpty();
        page.HasOlder.Should().BeFalse();
    }

    [Fact]
    public async Task Posts_byte_identical_first_page_query()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK,
            """{"data":{"repository":{"pullRequest":{"createdAt":"2020-01-01T00:00:00Z","author":null,"timelineItems":{"pageInfo":{"hasPreviousPage":false,"startCursor":null},"nodes":[]}}}}}""");
        var reader = new GitHubPrTimelineFeedReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com");

        await reader.ReadPageAsync(Pr, cursor: null, pageSize: 30, CancellationToken.None);

        GraphQlRequest.QueryOf(handler.LastRequestBody).Should().Be(
            """query{ repository(owner:"acme", name:"api"){ pullRequest(number:7){ createdAt author{ login avatarUrl __typename } timelineItems(last:30, itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,PULL_REQUEST_COMMIT,REVIEW_REQUESTED_EVENT,READY_FOR_REVIEW_EVENT,REOPENED_EVENT,CLOSED_EVENT,MERGED_EVENT]){ pageInfo{ hasPreviousPage startCursor } nodes{ __typename ... on IssueComment{ databaseId createdAt body author{ login avatarUrl __typename } } ... on PullRequestReview{ submittedAt state body author{ login avatarUrl __typename } } ... on PullRequestCommit{ commit{ oid committedDate author{ user{ login avatarUrl __typename } } } } ... on ReviewRequestedEvent{ createdAt actor{ login avatarUrl __typename } requestedReviewer{ ... on User{ login } ... on Team{ name } } } ... on ReadyForReviewEvent{ createdAt actor{ login avatarUrl __typename } } ... on ReopenedEvent{ createdAt actor{ login avatarUrl __typename } } ... on ClosedEvent{ createdAt actor{ login avatarUrl __typename } } ... on MergedEvent{ createdAt actor{ login avatarUrl __typename } } } } } } }""");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter GitHubPrTimelineFeedReaderTests`
Expected: FAIL — reader does not exist.

- [ ] **Step 3: Write the reader**

```csharp
using System.Globalization;
using System.Text;
using System.Text.Json;
using PRism.Core;
using PRism.Core.Activity;

namespace PRism.GitHub.Activity;

/// <summary>
/// Reads one PR's full activity timeline, newest-first, one backward-paged page at a time.
/// Distinct from <see cref="GitHubPrTimelineReader"/> (batched, last:1, inbox enrichment):
/// this issues a single-PR <c>timelineItems(last:N, before:$cursor)</c> query with a pageInfo cursor
/// and timestamps every node. Degrades to an empty page on any transport/parse failure.
/// </summary>
public sealed class GitHubPrTimelineFeedReader : IPrTimelineFeedReader
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<string> _readHost;

    public GitHubPrTimelineFeedReader(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<string> readHost)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readHost = readHost;
    }

    public async Task<TimelinePage> ReadPageAsync(PrReference prRef, string? cursor, int pageSize, CancellationToken ct)
    {
        var empty = new TimelinePage(Array.Empty<TimelineEvent>(), OlderCursor: null, HasOlder: false);

        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        var endpoint = HostUrlResolver.GraphQlEndpoint(_readHost());
        var payload = JsonSerializer.Serialize(new { query = BuildQuery(prRef, cursor, pageSize) });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var resp = await GitHubHttp.SendAsync(
            http, HttpMethod.Post, endpoint.ToString(), token, ct, content: content, apiVersion: false).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode) return empty;

        using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        if (!doc.RootElement.TryGetProperty("data", out var data)) return empty;
        if (!TryGetPath(data, out var pr, "repository", "pullRequest")) return empty;
        if (!TryGetPath(pr, out var items, "timelineItems")) return empty;

        var hasOlder = items.TryGetProperty("pageInfo", out var pi)
            && pi.TryGetProperty("hasPreviousPage", out var hp) && hp.GetBoolean();
        string? olderCursor = null;
        if (items.TryGetProperty("pageInfo", out var pi2)
            && pi2.TryGetProperty("startCursor", out var sc) && sc.ValueKind == JsonValueKind.String)
            olderCursor = sc.GetString();

        var parsed = new List<TimelineEvent>();
        if (items.TryGetProperty("nodes", out var nodes) && nodes.ValueKind == JsonValueKind.Array)
        {
            foreach (var node in nodes.EnumerateArray())
            {
                var evt = ParseNode(node);
                if (evt is not null) parsed.Add(evt);
            }
        }
        parsed.Reverse();   // GraphQL returns oldest→newest; the feed is newest-first

        if (!hasOlder)
        {
            var opened = SynthesizeOpened(pr);
            if (opened is not null) parsed.Add(opened);   // oldest element
        }

        return new TimelinePage(parsed, olderCursor, hasOlder);
    }

    private static string BuildQuery(PrReference pr, string? cursor, int pageSize)
    {
        var before = cursor is null
            ? string.Empty
            : $", before:{JsonSerializer.Serialize(cursor)}";
        var sb = new StringBuilder();
        sb.Append("query{ repository(owner:")
          .Append(JsonSerializer.Serialize(pr.Owner)).Append(", name:")
          .Append(JsonSerializer.Serialize(pr.Repo)).Append("){ pullRequest(number:")
          .Append(pr.Number.ToString(CultureInfo.InvariantCulture))
          .Append("){ createdAt author{ login avatarUrl __typename } timelineItems(last:")
          .Append(pageSize.ToString(CultureInfo.InvariantCulture))
          .Append(before)
          .Append(", itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,PULL_REQUEST_COMMIT,REVIEW_REQUESTED_EVENT,READY_FOR_REVIEW_EVENT,REOPENED_EVENT,CLOSED_EVENT,MERGED_EVENT]){ pageInfo{ hasPreviousPage startCursor } nodes{ __typename ... on IssueComment{ databaseId createdAt body author{ login avatarUrl __typename } } ... on PullRequestReview{ submittedAt state body author{ login avatarUrl __typename } } ... on PullRequestCommit{ commit{ oid committedDate author{ user{ login avatarUrl __typename } } } } ... on ReviewRequestedEvent{ createdAt actor{ login avatarUrl __typename } requestedReviewer{ ... on User{ login } ... on Team{ name } } } ... on ReadyForReviewEvent{ createdAt actor{ login avatarUrl __typename } } ... on ReopenedEvent{ createdAt actor{ login avatarUrl __typename } } ... on ClosedEvent{ createdAt actor{ login avatarUrl __typename } } ... on MergedEvent{ createdAt actor{ login avatarUrl __typename } } } } } } }");
        return sb.ToString();
    }

    private static TimelineEvent? ParseNode(JsonElement node)
    {
        if (!node.TryGetProperty("__typename", out var tn) || tn.ValueKind != JsonValueKind.String) return null;
        return tn.GetString() switch
        {
            "IssueComment" => Event(node, "databaseId", "createdAt", ActivityVerb.Commented, bodyProp: "body"),
            "PullRequestReview" => Review(node),
            "PullRequestCommit" => Commit(node),
            "ReviewRequestedEvent" => Requested(node),
            "ReadyForReviewEvent" => Simple(node, ActivityVerb.Reviewed),   // ReadyForReview → see Risks: verb mapping
            "ReopenedEvent" => Simple(node, ActivityVerb.Reopened),
            "ClosedEvent" => Simple(node, ActivityVerb.Closed),
            "MergedEvent" => Simple(node, ActivityVerb.Merged),
            _ => null,
        };
    }

    private static TimelineEvent Review(JsonElement node)
    {
        var state = node.TryGetProperty("state", out var s) ? s.GetString() : null;
        var verb = state switch
        {
            "APPROVED" => ActivityVerb.Approved,
            "CHANGES_REQUESTED" => ActivityVerb.ChangesRequested,
            _ => ActivityVerb.Reviewed,
        };
        var body = node.TryGetProperty("body", out var b) ? b.GetString() : null;
        var actor = ParseActor(node, "author");
        var ts = ParseTs(node, "submittedAt");
        return new TimelineEvent(Id(actor, ts, "review"), verb, actor, ts,
            Body: string.IsNullOrEmpty(body) ? null : body, CommitCount: null, Subject: null);
    }

    private static TimelineEvent? Commit(JsonElement node)
    {
        if (!node.TryGetProperty("commit", out var commit)) return null;
        var oid = commit.TryGetProperty("oid", out var o) ? o.GetString() ?? "" : "";
        var ts = ParseTs(commit, "committedDate");
        var user = commit.TryGetProperty("author", out var a) && a.TryGetProperty("user", out var u) ? u : default;
        var actor = user.ValueKind == JsonValueKind.Object ? ActorOf(user) : new TimelineActorRef(null, null, false);
        return new TimelineEvent(oid, ActivityVerb.Pushed, actor, ts, Body: null, CommitCount: 1, Subject: null);
    }

    private static TimelineEvent Requested(JsonElement node)
    {
        var actor = ParseActor(node, "actor");
        var ts = ParseTs(node, "createdAt");
        string? subject = null;
        if (node.TryGetProperty("requestedReviewer", out var rr) && rr.ValueKind == JsonValueKind.Object)
            subject = rr.TryGetProperty("login", out var l) ? l.GetString()
                    : rr.TryGetProperty("name", out var n) ? n.GetString() : null;
        return new TimelineEvent(Id(actor, ts, "req"), ActivityVerb.ReviewRequested, actor, ts, null, null, subject);
    }

    private static TimelineEvent Simple(JsonElement node, ActivityVerb verb)
    {
        var actor = ParseActor(node, "actor");
        var ts = ParseTs(node, "createdAt");
        return new TimelineEvent(Id(actor, ts, verb.ToString()), verb, actor, ts, null, null, null);
    }

    private static TimelineEvent Event(JsonElement node, string idProp, string tsProp, ActivityVerb verb, string bodyProp)
    {
        var actor = ParseActor(node, "author");
        var ts = ParseTs(node, tsProp);
        var id = node.TryGetProperty(idProp, out var idEl) && idEl.ValueKind == JsonValueKind.Number
            ? idEl.GetInt64().ToString(CultureInfo.InvariantCulture) : Id(actor, ts, verb.ToString());
        var body = node.TryGetProperty(bodyProp, out var b) ? b.GetString() : null;
        return new TimelineEvent(id, verb, actor, ts, string.IsNullOrEmpty(body) ? null : body, null, null);
    }

    private static TimelineEvent? SynthesizeOpened(JsonElement pr)
    {
        var ts = ParseTs(pr, "createdAt");
        var actor = pr.TryGetProperty("author", out var a) && a.ValueKind == JsonValueKind.Object
            ? ActorOf(a) : new TimelineActorRef(null, null, false);
        return new TimelineEvent($"opened:{actor.Login}", ActivityVerb.Opened, actor, ts, null, null, null);
    }

    private static TimelineActorRef ParseActor(JsonElement node, string prop)
        => node.TryGetProperty(prop, out var a) && a.ValueKind == JsonValueKind.Object
            ? ActorOf(a) : new TimelineActorRef(null, null, false);

    private static TimelineActorRef ActorOf(JsonElement a)
    {
        var login = a.TryGetProperty("login", out var l) ? l.GetString() : null;
        var avatar = a.TryGetProperty("avatarUrl", out var av) ? av.GetString() : null;
        var isBot = a.TryGetProperty("__typename", out var tn) && tn.GetString() == "Bot";
        return new TimelineActorRef(login, avatar, isBot);
    }

    private static DateTimeOffset ParseTs(JsonElement node, string prop)
        => node.TryGetProperty(prop, out var t) && t.ValueKind == JsonValueKind.String
           && DateTimeOffset.TryParse(t.GetString(), CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AdjustToUniversal, out var v)
            ? v : DateTimeOffset.UnixEpoch;

    private static string Id(TimelineActorRef actor, DateTimeOffset ts, string kind)
        => $"{kind}:{actor.Login}:{ts.ToUnixTimeMilliseconds()}";

    private static bool TryGetPath(JsonElement root, out JsonElement leaf, params string[] path)
    {
        leaf = root;
        foreach (var seg in path)
        {
            if (leaf.ValueKind != JsonValueKind.Object || !leaf.TryGetProperty(seg, out leaf))
            {
                leaf = default;
                return false;
            }
        }
        return true;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter GitHubPrTimelineFeedReaderTests`
Expected: PASS (all 4). If the byte-identity golden fails, copy the actual query string from the failure into the assertion — the query is authoritative once green, then never reformat it.

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/Activity/GitHubPrTimelineFeedReader.cs tests/PRism.GitHub.Tests/Activity/GitHubPrTimelineFeedReaderTests.cs
git commit -F- <<'EOF'
feat(#620): paginated single-PR timeline feed reader

Newest-first timelineItems(last:N, before:$cursor) read with pageInfo,
verb mapping, synthesized Opened node, degrade-don't-throw. Byte-identity
golden pins the query wire shape.
EOF
```

---

### Task 3: `GET .../timeline` endpoint + DI registration

**Files:**
- Modify: `PRism.Web/Endpoints/PrDetailEndpoints.cs` (add route near the `/checks` GET, ~line 282)
- Modify: DI composition root (where `IPrTimelineReader`/readers are registered — search `AddSingleton<IPrTimelineReader`) to add `IPrTimelineFeedReader`
- Test: `tests/PRism.Web.Tests/Endpoints/TimelineEndpointTests.cs`

**Interfaces:**
- Consumes: `IPrTimelineFeedReader` (Task 1/2).
- Produces: `GET /api/pr/{owner}/{repo}/{number:int}/timeline?cursor=&pageSize=` → `Results.Ok(TimelinePage)` | 422 on invalid owner/repo.

- [ ] **Step 1: Write the failing test** (use the project's existing `WebApplicationFactory` test harness — override `ConfigureWebHost`, register a fake `IPrTimelineFeedReader`)

```csharp
using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public sealed class TimelineEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public TimelineEndpointTests(WebApplicationFactory<Program> factory) => _factory = factory;

    private sealed class FakeReader : IPrTimelineFeedReader
    {
        public Task<TimelinePage> ReadPageAsync(PrReference prRef, string? cursor, int pageSize, CancellationToken ct)
            => Task.FromResult(new TimelinePage(
                new[] { new TimelineEvent("c1", ActivityVerb.Approved, new TimelineActorRef("alice", null, false), DateTimeOffset.UnixEpoch, null, null, null) },
                OlderCursor: cursor is null ? "CUR" : null, HasOlder: cursor is null));
    }

    private HttpClient Client() => _factory.WithWebHostBuilder(b =>
        b.ConfigureServices(s => s.AddSingleton<IPrTimelineFeedReader>(new FakeReader()))).CreateClient();

    [Fact]
    public async Task Returns_timeline_page()
    {
        var resp = await Client().GetAsync("/api/pr/acme/api/7/timeline");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var page = await resp.Content.ReadFromJsonAsync<TimelinePage>();
        page!.Events.Should().ContainSingle().Which.Verb.Should().Be(ActivityVerb.Approved);
        page.HasOlder.Should().BeTrue();
    }

    [Fact]
    public async Task Rejects_bad_owner()
    {
        var resp = await Client().GetAsync("/api/pr/bad!owner/api/7/timeline");
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter TimelineEndpointTests`
Expected: FAIL — route not mapped (404) / reader unresolved.

- [ ] **Step 3: Register the reader in DI**

Find the existing timeline-reader registration (`grep -rn "IPrTimelineReader" PRism.Web`) and add alongside it:

```csharp
services.AddSingleton<IPrTimelineFeedReader>(sp => new GitHubPrTimelineFeedReader(
    sp.GetRequiredService<IHttpClientFactory>(),
    /* readToken */ () => sp.GetRequiredService<ITokenStore>().GetTokenAsync(),
    /* readHost  */ () => sp.GetRequiredService<IHostProvider>().CurrentHost));
```

Match the exact `readToken`/`readHost` delegates the sibling `GitHubPrTimelineReader` registration uses — copy them verbatim from that registration so host/token resolution is identical.

- [ ] **Step 4: Map the endpoint** (in `PrDetailEndpoints.MapPrDetail`, after the `/checks` GET)

```csharp
app.MapGet("/api/pr/{owner}/{repo}/{number:int}/timeline",
    async (string owner, string repo, int number,
           [FromQuery] string? cursor,
           IPrTimelineFeedReader timeline, CancellationToken ct) =>
    {
        if (!SharedRegexes.OwnerRepo().IsMatch(owner) || !SharedRegexes.OwnerRepo().IsMatch(repo))
            return Results.Problem(type: "/owner-repo/invalid", statusCode: 422);

        var prRef = new PrReference(owner, repo, number);
        var page = await timeline.ReadPageAsync(prRef, cursor, pageSize: 30, ct).ConfigureAwait(false);
        return Results.Ok(page);
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `dotnet test tests/PRism.Web.Tests --filter TimelineEndpointTests`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/PrDetailEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/TimelineEndpointTests.cs
git commit -F- <<'EOF'
feat(#620): GET /api/pr/{owner}/{repo}/{number}/timeline endpoint

Read-only paged timeline endpoint + IPrTimelineFeedReader DI registration.
EOF
```

---

### Task 4: Widen `ActivePrPoller` emission gate for reviewer deltas

**Files:**
- Modify: `PRism.Core/PrDetail/ActivePrPollerState.cs` (add `Last*` reviewer fields)
- Modify: `PRism.Core/PrDetail/ActivePrPoller.cs:279-332` (compute `reviewersChanged`, add to gate, retain state)
- Test: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs` (add a case)

**Interfaces:**
- Produces: a `pr-updated` (`ActivePrUpdated`) frame now publishes when approvals / changes-requested / awaiting-reviewer count changes, even with no head/comment/state/readiness change. This is what the frontend feed subscribes to for live-refresh.

- [ ] **Step 1: Write the failing test** (mirror the existing poller test setup — fake `IActivePrBatchReader` returning two snapshots that differ only in `Approvals`)

```csharp
[Fact]
public async Task Publishes_when_only_approvals_change()
{
    var bus = new RecordingBus();                       // existing test double in this file
    var reader = new StubBatchReader(
        first:  Snapshot(headSha: "h1", approvals: 0, changesRequested: 0, awaiting: new[] { "lee" }),
        second: Snapshot(headSha: "h1", approvals: 1, changesRequested: 0, awaiting: Array.Empty<string>()));
    var poller = MakePoller(reader, bus);

    await poller.TickAsync(CancellationToken.None);     // firstPoll — seeds state, emits
    bus.Events.Clear();
    await poller.TickAsync(CancellationToken.None);     // only approvals changed

    bus.Events.OfType<ActivePrUpdated>().Should().ContainSingle()
       .Which.Approvals.Should().Be(1);
}
```

Adjust `Snapshot(...)`/`MakePoller(...)`/`StubBatchReader`/`RecordingBus` to the exact helpers already present in `ActivePrPollerTests.cs` (read the file first; reuse, don't invent).

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter ActivePrPollerTests`
Expected: FAIL — second tick emits nothing today (gate ignores reviewer deltas).

- [ ] **Step 3: Add retained fields** to `ActivePrPollerState.cs`

```csharp
    public int? LastApprovals { get; set; }
    public int? LastChangesRequested { get; set; }
    public int? LastAwaitingCount { get; set; }
```

- [ ] **Step 4: Compute `reviewersChanged` and add it to the gate** (`ActivePrPoller.cs`, alongside the other `*Changed` bools at ~line 279-297)

```csharp
var reviewersChanged =
    (state.LastApprovals is { } laApprovals && laApprovals != snapshot.Approvals) ||
    (state.LastChangesRequested is { } laCr && laCr != snapshot.ChangesRequested) ||
    (state.LastAwaitingCount is { } laAwait && laAwait != snapshot.AwaitingReviewers.Count);
```

Add `|| reviewersChanged` to the emission `if` at line 301:

```csharp
if (firstPoll || headChanged || baseChanged || commentChanged || stateChanged || readinessChanged || reviewersChanged)
```

Retain the new state after emission (with the other `state.Last* =` writes at ~line 325):

```csharp
state.LastApprovals = snapshot.Approvals;
state.LastChangesRequested = snapshot.ChangesRequested;
state.LastAwaitingCount = snapshot.AwaitingReviewers.Count;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests --filter ActivePrPollerTests`
Expected: PASS. Run the whole `PRism.Core.Tests` project too — the poller is widely covered; confirm no existing emission-count assertion regressed.

Run: `dotnet test tests/PRism.Core.Tests`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/PrDetail/ActivePrPoller.cs PRism.Core/PrDetail/ActivePrPollerState.cs tests/PRism.Core.Tests/PrDetail/ActivePrPollerTests.cs
git commit -F- <<'EOF'
feat(#620): publish pr-updated on reviewer/approval deltas

Widen ActivePrPoller emission gate so a fresh approval / changes-request /
review-request (no head/comment/state/readiness change) still publishes the
frame the timeline feed live-refreshes on.
EOF
```

---

### Task 5: Frontend wire types + `getTimelinePage` client

**Files:**
- Modify: `frontend/src/api/types.ts`
- Create: `frontend/src/api/timeline.ts`
- Test: `frontend/src/api/timeline.test.ts`

**Interfaces:**
- Produces: TS `TimelineActorRef`, `TimelineEvent`, `TimelinePage`; `getTimelinePage(prRef, cursor?, signal?) → Promise<TimelinePage>`.

- [ ] **Step 1: Add the wire types** to `frontend/src/api/types.ts` (near `ActivityItem`)

```typescript
export interface TimelineActorRef {
  login: string | null;
  avatarUrl: string | null;
  isBot: boolean;
}

export interface TimelineEvent {
  id: string;
  verb: ActivityVerb;
  actor: TimelineActorRef;
  timestamp: string;
  body: string | null;
  commitCount: number | null;
  subject: string | null;
}

export interface TimelinePage {
  events: TimelineEvent[];
  olderCursor: string | null;
  hasOlder: boolean;
}
```

- [ ] **Step 2: Write the failing test** (mock `fetch`, mirror `frontend/src/api/checks.test.ts`)

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTimelinePage } from './timeline';

afterEach(() => vi.restoreAllMocks());

describe('getTimelinePage', () => {
  it('requests the timeline path and returns the page', async () => {
    const body = { events: [], olderCursor: 'CUR', hasOlder: true };
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

    const page = await getTimelinePage({ owner: 'acme', repo: 'api', number: 7 });

    expect(spy.mock.calls[0][0]).toContain('/api/pr/acme/api/7/timeline');
    expect(page.hasOlder).toBe(true);
  });

  it('encodes the cursor query param', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ events: [], olderCursor: null, hasOlder: false }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await getTimelinePage({ owner: 'acme', repo: 'api', number: 7 }, 'a b/c');
    expect(spy.mock.calls[0][0]).toContain('cursor=a%20b%2Fc');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run src/api/timeline.test.ts`
Expected: FAIL — `timeline.ts` missing.

- [ ] **Step 4: Write the client**

```typescript
import { apiClient } from './client';
import type { PrReference, TimelinePage } from './types';

export function getTimelinePage(
  prRef: PrReference,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<TimelinePage> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiClient.get<TimelinePage>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/timeline${q}`,
    { signal },
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run src/api/timeline.test.ts`
Expected: PASS. Then `./node_modules/.bin/tsc -b` — no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/timeline.ts frontend/src/api/timeline.test.ts
git commit -m "feat(#620): timeline wire types + getTimelinePage client"
```

---

### Task 6: `groupCommitRuns` pure transform

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/timeline/groupCommitRuns.ts`
- Test: `frontend/src/components/PrDetail/OverviewTab/timeline/groupCommitRuns.test.ts`

**Interfaces:**
- Consumes: `TimelineEvent` (Task 5).
- Produces: `type FeedNode = { kind: 'event'; event: TimelineEvent } | { kind: 'commit-group'; commits: TimelineEvent[]; collapsedByDefault: boolean }`; `groupCommitRuns(events: TimelineEvent[], threshold?: number): FeedNode[]`.

Semantics: input is newest-first. A maximal run of adjacent `pushed` events coalesces into one `commit-group` node (`collapsedByDefault = commits.length > threshold`, default threshold 5). Non-commit events pass through as `event` nodes. A single isolated commit still becomes a `commit-group` of length 1 (`collapsedByDefault=false`) so rendering is uniform ("pushed 1 commit").

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { groupCommitRuns } from './groupCommitRuns';
import type { TimelineEvent } from '../../../../api/types';

const ev = (id: string, verb: TimelineEvent['verb']): TimelineEvent => ({
  id, verb, actor: { login: 'a', avatarUrl: null, isBot: false },
  timestamp: '2021-01-01T00:00:00Z', body: verb === 'commented' ? 'hi' : null,
  commitCount: verb === 'pushed' ? 1 : null, subject: null,
});

describe('groupCommitRuns', () => {
  it('coalesces a consecutive commit run into one group', () => {
    const nodes = groupCommitRuns([ev('1', 'pushed'), ev('2', 'pushed'), ev('3', 'pushed')]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'commit-group', collapsedByDefault: false });
    expect((nodes[0] as { commits: TimelineEvent[] }).commits).toHaveLength(3);
  });

  it('collapses by default when the run exceeds the threshold', () => {
    const run = Array.from({ length: 6 }, (_, i) => ev(String(i), 'pushed'));
    const nodes = groupCommitRuns(run, 5);
    expect(nodes[0]).toMatchObject({ kind: 'commit-group', collapsedByDefault: true });
  });

  it('breaks the run when a non-commit event interrupts it', () => {
    const nodes = groupCommitRuns([ev('1', 'pushed'), ev('2', 'commented'), ev('3', 'pushed')]);
    expect(nodes.map((n) => n.kind)).toEqual(['commit-group', 'event', 'commit-group']);
  });

  it('passes non-commit events through untouched', () => {
    const nodes = groupCommitRuns([ev('1', 'approved')]);
    expect(nodes).toEqual([{ kind: 'event', event: expect.objectContaining({ id: '1' }) }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/timeline/groupCommitRuns.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the transform**

```typescript
import type { TimelineEvent } from '../../../../api/types';

export type FeedNode =
  | { kind: 'event'; event: TimelineEvent }
  | { kind: 'commit-group'; commits: TimelineEvent[]; collapsedByDefault: boolean };

export const COMMIT_GROUP_THRESHOLD = 5;

/**
 * Collapse maximal runs of consecutive `pushed` events (input is newest-first) into a single
 * commit-group node. Runs longer than `threshold` default to collapsed. Non-commit events pass
 * through unchanged. Comments are never grouped (they carry conversation content).
 */
export function groupCommitRuns(
  events: TimelineEvent[],
  threshold: number = COMMIT_GROUP_THRESHOLD,
): FeedNode[] {
  const nodes: FeedNode[] = [];
  let run: TimelineEvent[] = [];

  const flush = () => {
    if (run.length === 0) return;
    nodes.push({ kind: 'commit-group', commits: run, collapsedByDefault: run.length > threshold });
    run = [];
  };

  for (const event of events) {
    if (event.verb === 'pushed') {
      run.push(event);
    } else {
      flush();
      nodes.push({ kind: 'event', event });
    }
  }
  flush();
  return nodes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/timeline/groupCommitRuns.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/timeline/groupCommitRuns.ts frontend/src/components/PrDetail/OverviewTab/timeline/groupCommitRuns.test.ts
git commit -m "feat(#620): commit-run grouping transform"
```

---

### Task 7: `useTimelineFeed` data hook

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/timeline/useTimelineFeed.ts`
- Test: `frontend/src/components/PrDetail/OverviewTab/timeline/useTimelineFeed.test.ts`

**Interfaces:**
- Consumes: `getTimelinePage` (Task 5); `TimelineEvent`, `PrReference`.
- Produces: `useTimelineFeed(prRef: PrReference, opts: { prUpdatedSignal: number }) → { events: TimelineEvent[]; status: 'loading' | 'error' | 'ready'; hasOlder: boolean; loadOlder: () => void; loadingOlder: boolean; refetchNewest: () => void }`.

Behavior: on mount / `prRef` change, load the newest page (`status='loading'` → `'ready'`/`'error'`). `loadOlder` fetches with `olderCursor`, **appends** older events (dedup by `id`), updates `hasOlder`/`olderCursor`. `refetchNewest` re-fetches the first page and merges by `id` (new events prepended; existing kept). `opts.prUpdatedSignal` is a monotonically-increasing counter the parent bumps on each `pr-updated` SSE frame for this PR; a change triggers `refetchNewest`. `AbortController` cancels in-flight on unmount/prRef change.

- [ ] **Step 1: Write the failing tests** (use `@testing-library/react` `renderHook`, mock `./timeline`)

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTimelineFeed } from './useTimelineFeed';
import * as api from '../../../../api/timeline';
import type { TimelineEvent } from '../../../../api/types';

const ev = (id: string): TimelineEvent => ({
  id, verb: 'approved', actor: { login: 'a', avatarUrl: null, isBot: false },
  timestamp: '2021-01-01T00:00:00Z', body: null, commitCount: null, subject: null });
const pr = { owner: 'acme', repo: 'api', number: 7 };

afterEach(() => vi.restoreAllMocks());

describe('useTimelineFeed', () => {
  it('loads the newest page on mount', async () => {
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({ events: [ev('1')], olderCursor: 'C', hasOlder: true });
    const { result } = renderHook(() => useTimelineFeed(pr, { prUpdatedSignal: 0 }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events).toHaveLength(1);
    expect(result.current.hasOlder).toBe(true);
  });

  it('appends older events (deduped) on loadOlder', async () => {
    const spy = vi.spyOn(api, 'getTimelinePage')
      .mockResolvedValueOnce({ events: [ev('2')], olderCursor: 'C', hasOlder: true })
      .mockResolvedValueOnce({ events: [ev('1'), ev('2')], olderCursor: null, hasOlder: false });
    const { result } = renderHook(() => useTimelineFeed(pr, { prUpdatedSignal: 0 }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.hasOlder).toBe(false));
    expect(result.current.events.map((e) => e.id)).toEqual(['2', '1']);   // no duplicate '2'
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetches the newest page when prUpdatedSignal changes', async () => {
    const spy = vi.spyOn(api, 'getTimelinePage')
      .mockResolvedValueOnce({ events: [ev('1')], olderCursor: 'C', hasOlder: true })
      .mockResolvedValueOnce({ events: [ev('9'), ev('1')], olderCursor: 'C', hasOlder: true });
    const { result, rerender } = renderHook(({ sig }) => useTimelineFeed(pr, { prUpdatedSignal: sig }), { initialProps: { sig: 0 } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ sig: 1 });
    await waitFor(() => expect(result.current.events[0].id).toBe('9'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('sets error status when the fetch rejects', async () => {
    vi.spyOn(api, 'getTimelinePage').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useTimelineFeed(pr, { prUpdatedSignal: 0 }));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/timeline/useTimelineFeed.test.ts`
Expected: FAIL — hook missing.

- [ ] **Step 3: Write the hook**

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';
import { getTimelinePage } from '../../../../api/timeline';
import type { PrReference, TimelineEvent } from '../../../../api/types';

type Status = 'loading' | 'error' | 'ready';

function mergeById(primary: TimelineEvent[], incoming: TimelineEvent[]): TimelineEvent[] {
  const seen = new Set(primary.map((e) => e.id));
  return [...primary, ...incoming.filter((e) => !seen.has(e.id))];
}

export function useTimelineFeed(prRef: PrReference, opts: { prUpdatedSignal: number }) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const key = `${prRef.owner}/${prRef.repo}/${prRef.number}`;

  // Initial load (and reload on PR change).
  useEffect(() => {
    const ac = new AbortController();
    setStatus('loading');
    getTimelinePage(prRef, null, ac.signal)
      .then((page) => {
        setEvents(page.events);
        cursorRef.current = page.olderCursor;
        setHasOlder(page.hasOlder);
        setStatus('ready');
      })
      .catch(() => { if (!ac.signal.aborted) setStatus('error'); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadOlder = useCallback(() => {
    if (loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    getTimelinePage(prRef, cursorRef.current)
      .then((page) => {
        setEvents((prev) => mergeById(prev, page.events));
        cursorRef.current = page.olderCursor;
        setHasOlder(page.hasOlder);
      })
      .finally(() => setLoadingOlder(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hasOlder, loadingOlder]);

  const refetchNewest = useCallback(() => {
    getTimelinePage(prRef, null).then((page) => {
      // Prepend genuinely-new events; keep already-loaded older ones.
      setEvents((prev) => {
        const known = new Set(prev.map((e) => e.id));
        const fresh = page.events.filter((e) => !known.has(e.id));
        return [...fresh, ...prev];
      });
    }).catch(() => { /* live-refresh is best-effort; keep the current feed on failure */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Live-refresh: the parent bumps prUpdatedSignal on each pr-updated frame for this PR.
  const firstSignal = useRef(true);
  useEffect(() => {
    if (firstSignal.current) { firstSignal.current = false; return; }
    refetchNewest();
  }, [opts.prUpdatedSignal, refetchNewest]);

  return { events, status, hasOlder, loadOlder, loadingOlder, refetchNewest };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/timeline/useTimelineFeed.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/timeline/useTimelineFeed.ts frontend/src/components/PrDetail/OverviewTab/timeline/useTimelineFeed.test.ts
git commit -m "feat(#620): useTimelineFeed hook (load/older/refetch/live)"
```

---

### Task 8: `ActivityFeed` presentational component (rail, markers, cards, accordion, states, a11y)

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.tsx`
- Create: `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.module.css`
- Test: `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.test.tsx`

**Interfaces:**
- Consumes: `useTimelineFeed` (Task 7), `groupCommitRuns` (Task 6), `Avatar`, `formatAge`, `IssueCommentDto`/`DraftCommentDto`, the reply-context prop shape from `PrRootConversation` (Task 9 lifts the composer in; this task renders the feed body + a `composerSlot` render-prop).
- Produces: `ActivityFeed({ prRef, prUpdatedSignal, composerSlot }: { prRef: PrReference; prUpdatedSignal: number; composerSlot: React.ReactNode })`.

Verb→phrase: import the maps from `ActivityRail` if exported, else define a local `VERB_PHRASE` for the feed (approved → "approved", changes-requested → "requested changes", pushed → "pushed", review-requested → "requested review from", ready-for-review handled per Risks). Render rules: `body != null` → comment card (`CommentCard`, reuse existing); else one-line marker (glyph + actor + phrase + `formatAge`). Commit-group → "pushed N commits", `collapsedByDefault` renders a `<button aria-expanded>` accordion; expand reveals the per-commit list. Bot filter: `showBots` state (default false) filtering `actor.isBot`. States: `loading` → skeleton; `error` → inline retry row (distinct testid); empty (`ready` + zero visible) → "No activity yet". Live-merge announced via a visually-hidden `aria-live="polite"` region.

- [ ] **Step 1: Write the failing tests**

```typescript
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ActivityFeed } from './ActivityFeed';
import * as api from '../../../../api/timeline';
import type { TimelineEvent } from '../../../../api/types';

const ev = (id: string, over: Partial<TimelineEvent>): TimelineEvent => ({
  id, verb: 'approved', actor: { login: 'alice', avatarUrl: null, isBot: false },
  timestamp: '2021-01-01T00:00:00Z', body: null, commitCount: null, subject: null, ...over });
const pr = { owner: 'acme', repo: 'api', number: 7 };

afterEach(() => vi.restoreAllMocks());

describe('ActivityFeed', () => {
  it('renders a comment as a card and a bare approval as a marker', async () => {
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
      events: [ev('c', { verb: 'commented', body: 'looks good' }), ev('a', { verb: 'approved' })],
      olderCursor: null, hasOlder: false });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={<div>composer</div>} />);
    expect(await screen.findByText('looks good')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-marker')).toHaveTextContent('approved');
  });

  it('collapses a >5 commit run into an expandable accordion', async () => {
    const commits = Array.from({ length: 6 }, (_, i) => ev(`p${i}`, { verb: 'pushed', commitCount: 1 }));
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({ events: commits, olderCursor: null, hasOlder: false });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    const acc = await screen.findByRole('button', { name: /6 commits/i });
    expect(acc).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows an empty-state placeholder, not a blank card', async () => {
    vi.spyOn(api, 'getTimelinePage').mockResolvedValue({ events: [], olderCursor: null, hasOlder: false });
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    expect(await screen.findByText(/no activity yet/i)).toBeInTheDocument();
  });

  it('shows a retry-distinct error state on fetch failure', async () => {
    vi.spyOn(api, 'getTimelinePage').mockRejectedValue(new Error('boom'));
    render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={null} />);
    expect(await screen.findByTestId('timeline-error')).toBeInTheDocument();
    expect(screen.queryByText(/no activity yet/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/timeline/ActivityFeed.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Write the component** (and a minimal `.module.css` with `.rail`, `.marker`, `.card`, `.srOnly` — use `position:relative` on the pane container, not `absolute .sr-only`, per repo memory)

```tsx
import { useMemo, useState } from 'react';
import { Avatar } from '../../../Avatar/Avatar';
import { formatAge } from '../../../../utils/relativeTime';
import { CommentCard } from '../../../CommentCard/CommentCard';
import type { PrReference, TimelineEvent, ActivityVerb } from '../../../../api/types';
import { useTimelineFeed } from './useTimelineFeed';
import { groupCommitRuns, type FeedNode } from './groupCommitRuns';
import styles from './ActivityFeed.module.css';

const VERB_PHRASE: Record<ActivityVerb, string> = {
  opened: 'opened', reopened: 'reopened', closed: 'closed', merged: 'merged',
  reviewed: 'reviewed', commented: 'commented', approved: 'approved',
  'changes-requested': 'requested changes', 'review-requested': 'requested review from',
  pushed: 'pushed', mentioned: 'mentioned', 'ci-activity': 'CI', authored: 'authored', other: 'updated',
};

function Marker({ event }: { event: TimelineEvent }) {
  const phrase = VERB_PHRASE[event.verb];
  const tail = event.verb === 'review-requested' && event.subject ? ` ${event.subject}` : '';
  return (
    <li className={styles.marker} data-testid="timeline-marker">
      <Avatar src={event.actor.avatarUrl} login={event.actor.login ?? ''} size="sm" />
      <span className={styles.lead}>
        <span className={styles.actor}>{event.actor.login}</span>{' '}
        <span className={styles.verb}>{phrase}{tail}</span>
      </span>
      <span className={styles.when}>· {formatAge(event.timestamp)}</span>
    </li>
  );
}

function CommitGroup({ commits, collapsedByDefault }: { commits: TimelineEvent[]; collapsedByDefault: boolean }) {
  const [open, setOpen] = useState(!collapsedByDefault);
  const n = commits.length;
  return (
    <li className={styles.marker} data-testid="timeline-commit-group">
      <button type="button" className={styles.accordion} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        pushed {n} {n === 1 ? 'commit' : 'commits'}
      </button>
      {open && (
        <ul className={styles.commitList}>
          {commits.map((c) => (
            <li key={c.id} className={styles.commitRow}>
              <span className={styles.actor}>{c.actor.login}</span>
              <span className={styles.when}>· {formatAge(c.timestamp)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function ActivityFeed({
  prRef, prUpdatedSignal, composerSlot,
}: { prRef: PrReference; prUpdatedSignal: number; composerSlot: React.ReactNode }) {
  const { events, status, hasOlder, loadOlder, loadingOlder } = useTimelineFeed(prRef, { prUpdatedSignal });
  const [showBots, setShowBots] = useState(false);

  const nodes: FeedNode[] = useMemo(
    () => groupCommitRuns(events.filter((e) => showBots || !e.actor.isBot)),
    [events, showBots]);

  return (
    <section className="overview-card" data-testid="activity-feed" aria-label="PR activity">
      <div className={styles.srOnly} role="status" aria-live="polite">
        {status === 'ready' ? `${events.length} activity items` : ''}
      </div>
      {composerSlot}
      <div className={styles.toolbar}>
        <button type="button" aria-pressed={showBots} onClick={() => setShowBots((v) => !v)}>
          {showBots ? 'Hide bots' : 'Show bots'}
        </button>
      </div>

      {status === 'loading' && <div className={styles.skeleton} data-testid="timeline-skeleton" aria-hidden="true" />}
      {status === 'error' && (
        <div className={styles.error} data-testid="timeline-error">
          Couldn’t load activity. <button type="button" onClick={loadOlder}>Retry</button>
        </div>
      )}
      {status === 'ready' && nodes.length === 0 && (
        <p className={styles.empty} data-testid="timeline-empty">No activity yet.</p>
      )}

      {status === 'ready' && nodes.length > 0 && (
        <ol className={styles.rail}>
          {nodes.map((node) =>
            node.kind === 'commit-group' ? (
              <CommitGroup key={node.commits[0].id} commits={node.commits} collapsedByDefault={node.collapsedByDefault} />
            ) : node.event.body != null ? (
              <li key={node.event.id} className={styles.card}>
                <CommentCard
                  density="comfortable"
                  author={node.event.actor.login ?? ''}
                  avatarUrl={node.event.actor.avatarUrl ?? undefined}
                  createdAt={node.event.timestamp}
                  body={node.event.body}
                  data-testid="timeline-comment"
                />
              </li>
            ) : (
              <Marker key={node.event.id} event={node.event} />
            ),
          )}
        </ol>
      )}

      {status === 'ready' && hasOlder && (
        <button type="button" className={styles.older} onClick={loadOlder} disabled={loadingOlder}>
          {loadingOlder ? 'Loading…' : 'Show older activity'}
        </button>
      )}
    </section>
  );
}
```

If `CommentCard`'s prop names differ from the above (verify against `frontend/src/components/CommentCard/CommentCard.tsx`), match its actual signature — the recon shows `PrRootConversation` renders `<CommentCard density="comfortable" …>`; copy the exact prop names it passes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/timeline/ActivityFeed.test.tsx`
Expected: PASS (all 4). Then `./node_modules/.bin/tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.tsx frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.module.css frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.test.tsx
git commit -m "feat(#620): ActivityFeed component (rail, cards, markers, accordion, states, a11y)"
```

---

### Task 9: Lift the composer + wire `ActivityFeed` into `OverviewTab`

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx:107-131`
- Modify: `frontend/src/components/PrDetail/OverviewTab/timeline/useTimelineFeed.ts` (expose `refetchNewest` to the composer post-callback)
- Test: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.test.tsx` (add/adjust) + preserve/port `PrRootConversation.test.tsx` composer cases into an `ActivityFeed` composer test

**Interfaces:**
- Consumes: existing `usePrDetailContext()`; the `replyContext` `useMemo` already computed in `OverviewTab` (line 87-105); the `pr-updated` subscription already in `prDetailContext` (surface a monotonically-increasing counter — reuse the existing `pr-updated` handler that drives live mergeability, adding a bump).
- Produces: Overview renders `ActivityFeed` (with the lifted composer as `composerSlot`) where `PrRootConversation` was.

- [ ] **Step 1: Expose a `pr-updated` counter** — in `prDetailContext.tsx`, where the `pr-updated` frame is already handled (#655 mergeability), add a `prUpdatedSignal` counter to the context value that increments on each frame for the active PR. Write a test in `prDetailContext.test.tsx` asserting the counter increments on a simulated frame. (Mirror the existing mergeability-update test.)

```typescript
// inside the pr-updated handler, alongside the mergeability update:
setPrUpdatedSignal((n) => n + 1);
// expose prUpdatedSignal in the context value object
```

- [ ] **Step 2: Write the failing wiring test**

```typescript
// OverviewTab.test.tsx — render OverviewTab with a context providing prDetail + a mocked timeline,
// assert the activity feed is present and PrRootConversation is not.
expect(screen.getByTestId('activity-feed')).toBeInTheDocument();
expect(screen.queryByTestId('pr-root-comment')).not.toBeInTheDocument();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/OverviewTab.test.tsx`
Expected: FAIL — OverviewTab still renders `PrRootConversation`.

- [ ] **Step 4: Swap the component** in `OverviewTab.tsx` — replace the `<PrRootConversation comments={prDetail.rootComments} replyContext={replyContext} />` line with:

```tsx
<ActivityFeed
  prRef={prRef}
  prUpdatedSignal={prUpdatedSignal}
  composerSlot={
    replyContext ? (
      <PrRootConversationActions replyContext={replyContext} onPosted={/* refetch handled inside ActivityFeed via prUpdatedSignal or an explicit onPosted->refetchNewest bridge */ undefined} />
    ) : null
  }
/>
```

Extract the composer/actions (`PrRootConversationActions` + `PrRootReplyComposer` + `CollapsedComposerAffordance` + `MarkAllReadButton`) out of `PrRootConversation` into a reusable `PrRootConversationActions` export (if not already separately exported) so it can be passed as `composerSlot`. Delete the now-unused `PrRootConversation` comment-list rendering (the feed owns comment rendering now); keep the actions/composer module. Bridge the post-success to `refetchNewest` (either lift `refetchNewest` from `useTimelineFeed` up via a ref/callback, or have the composer publish a local event the feed listens to — simplest: `ActivityFeed` accepts an `onComposerPosted` ref it wires to `refetchNewest`, and the composer calls it after a successful post).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/ src/components/PrDetail/prDetailContext.test.tsx`
Expected: PASS. Then run the **full** frontend suite (composer/draft behavior is broadly covered):

Run: `cd frontend && ./node_modules/.bin/vitest run`
Expected: PASS. Fix any `PrRootConversation`-coupled test that referenced the deleted comment-list by pointing it at `ActivityFeed`'s `timeline-comment` testid.

- [ ] **Step 6: Lint + typecheck + commit**

```bash
cd frontend && ./node_modules/.bin/tsc -b && npm run lint
git add frontend/src/components/PrDetail
git commit -m "feat(#620): render ActivityFeed in Overview; lift composer; live-refresh signal"
```

---

### Task 10: e2e + visual baseline + full verification

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts` (regenerate `pr-detail-overview` baseline)
- Possibly add: `frontend/e2e/pr-detail-timeline.spec.ts` (scenario spec, `--project=prod`)

- [ ] **Step 1: Grep e2e specs** touching the Overview tab before changing markup

Run: `git grep -n "overview-tab\|pr-detail-overview\|pr-root-comment" frontend/e2e`
Expected: enumerates `parity-baselines.spec.ts` + any comment specs; update selectors that referenced `pr-root-comment` to the feed's `timeline-comment` where appropriate.

- [ ] **Step 2: Run the backend + frontend suites green**

Run: `dotnet test` (solution) — Expected: PASS.
Run: `cd frontend && ./node_modules/.bin/vitest run` — Expected: PASS.

- [ ] **Step 3: Run the Overview e2e locally (prod project)**

Run: `cd frontend && ./node_modules/.bin/playwright test parity-baselines.spec.ts --project=prod -g "pr-detail-overview"`
Expected: FAILS on screenshot diff (the feed is new). Confirm the diff is the intended feed, not a regression.

- [ ] **Step 4: Regenerate the Linux baseline via CI artifact** (per repo memory `regen-linux-parity-baseline-via-ci-artifact`) — push the branch, let CI produce the actual, download the `e2e-results` artifact's `pr-detail-overview-actual.png`, verify the diff is intended, copy over `frontend/e2e/__screenshots__/linux/pr-detail-overview.png`, and commit into this PR (do not defer to a follow-up).

- [ ] **Step 5: Live-validate against a real PR** (per spec Verification + repo memory `live-validate-real-pr-in-running-app`): serve detached against the real token store, open a real multi-reviewer PR (e.g. `mindbody/Mindbody.Clients#973`), and confirm: newest-first feed, a comment appears once, composer reachable at top, a >5 commit burst collapses, "Show older" pages to the beginning, an approval appears live without moving scroll.

- [ ] **Step 6: Run the repo pre-push checklist** (`.ai/docs/development-process.md`) verbatim, then commit any baseline/regen.

```bash
git add frontend/e2e
git commit -m "test(#620): timeline e2e + regen pr-detail-overview baseline"
```

---

## Self-Review

**Spec coverage:**
- Unified feed replacing `PrRootConversation` → Tasks 8, 9. ✓
- Paginated timestamped read, `Opened` synth, no review-request-removed → Task 2. ✓
- `GET .../timeline` endpoint → Task 3. ✓
- Live-refresh via widened poller gate → Task 4 (backend) + Tasks 7/9 (frontend subscribe + refetch). ✓
- Flat newest-first ordering + tie-break → Task 2 (reader order) + Task 6/8 render. Tie-break: reader preserves GraphQL order; equal-timestamp stability comes from that stable order — **note:** if a same-timestamp reorder flake appears, add an explicit `id` secondary sort in the reader (documented in Risks).
- One-review-one-unit (bodied approval → card) → Task 2 sets `Body`; Task 8 renders body→card (state glyph on the card: extend `Marker`/`CommentCard` to show the verb glyph for `approved`/`changes-requested` with a body — fold into Task 8 rendering). ✓
- Commit-run grouping/accordion → Tasks 6, 8. ✓
- Source-of-truth (feed owns refetch, no snapshot Invalidate) → Task 7. ✓
- UI states (loading/empty/error/live-merge/end-of-history/bot default/a11y) → Task 8. ✓
- Testing + verification + baseline regen → Task 10. ✓
- Deferred (per-event streaming, unseen divider, comment density) → NOT built (correct). ✓

**Placeholder scan:** the `composerSlot`/`onPosted` bridge in Task 9 Step 4 names two concrete options and picks the ref-callback one — implementer picks the simplest that passes the ported composer tests; not a placeholder but a genuine small integration choice. All code steps show real code.

**Type consistency:** `TimelineEvent`/`TimelinePage`/`TimelineActorRef` field names match across Core (Task 1), reader (Task 2), wire types (Task 5), hook (Task 7), grouping (Task 6), component (Task 8). `FeedNode` shape identical in Tasks 6 and 8. `useTimelineFeed` return shape consumed correctly in Task 8. `groupCommitRuns` threshold constant shared.

## Open items carried to implementation (from spec Risks)
- **ReadyForReview verb** — Task 2 maps it to `ActivityVerb.Reviewed` provisionally; confirm/introduce a dedicated verb during Task 2 if `Reviewed` reads wrong in the UI.
- **Commit-group across page boundaries** — Task 7 `loadOlder` appends older events; grouping (Task 8) re-runs over the full list each render, so a run split across a page merge re-coalesces automatically. Verify in Task 10 Step 5 with a PR whose commit burst spans a page.
- **PrRootConversation test port** — Task 9 Step 5 requires the full frontend suite green; inventory the composer/draft tests first.
