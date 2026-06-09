# Activity Rail — Phase 1 (real `received_events` actor feed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded `activityData.ts` mock behind the Inbox Activity rail with a real, fault-isolated GitHub `received_events` actor feed, surfaced through a Settings toggle, with graceful loading / empty / degraded states.

**Architecture:** A dedicated `GET /api/activity` endpoint, isolated from the inbox pipeline. A fault-isolated `GitHubReceivedEventsReader` (mirrors `GitHubCiFailingDetector`) feeds a pure `ActivityFeedBuilder` (normalize → 24h window → event-`id` dedup → sort → cap). A singleton `IActivityProvider` composes them. The frontend `useActivity` hook polls ~90s with last-good retention; `ActivityRail` renders the single Activity panel with an in-rail, default-hidden, **transient** bot toggle. No server cache in P1 (that lands in P2). Phase 2 (notifications merge + Watching) is a separate plan, gated on a keep decision.

**Tech Stack:** .NET 10 (PRism.Core / PRism.GitHub / PRism.Web, xUnit + FluentAssertions), React + Vite + TypeScript (vitest + Testing Library), Playwright e2e.

**Spec:** `docs/specs/2026-06-09-activity-rail-real-data-design.md`. This plan implements only the sections tagged **[P1]** / **[shared]**.

---

## Pre-flight (do this first, once)

- [ ] **Step 0.1: Revert the pre-test throwaway.** The worktree has uncommitted "pre-test" edits (a banner-commented reconstruction) in `ActivityRail.tsx`, `activityData.ts`, and `InboxPage.tsx`. Implementation must start from the committed baseline, not the throwaway.

```bash
cd D:/src/PRism-137-activity-rail-data
git checkout -- frontend/src/components/ActivityRail/ frontend/src/pages/InboxPage.tsx
git status --short   # expect: clean (no ActivityRail/InboxPage changes)
```

- [ ] **Step 0.2: Confirm green baseline.** From the worktree:

```bash
cd D:/src/PRism-137-activity-rail-data
dotnet build PRism.Web --nologo --verbosity minimal
```
Expected: build succeeds. (Frontend deps install on first `./run.ps1` / vitest run via `npm ci`.)

---

## File Structure

**Backend — new (`PRism.Core/Activity/`, pure, no GitHub/HTTP):**
- `PRism.Core/Activity/ActivityContracts.cs` — wire records + enums (`ActivityItem`, `ActivityResponse`, `ActivityDegradation`, `ActivitySource`, `ActivityVerb`).
- `PRism.Core/Activity/RawReceivedEvent.cs` — adapter-agnostic input record + `ReceivedEventsResult`.
- `PRism.Core/Activity/IReceivedEventsReader.cs` — reader port.
- `PRism.Core/Activity/IActivityProvider.cs` — provider port.
- `PRism.Core/Activity/ActivityFeedBuilder.cs` — pure builder (the logic core).
- `PRism.Core/Activity/ActivityProvider.cs` — composes reader + builder (logs dropped-recognized).

**Backend — new (`PRism.GitHub/Activity/`, the HTTP adapter):**
- `PRism.GitHub/Activity/GitHubReceivedEventsReader.cs` — fault-isolated `IReceivedEventsReader`.

**Backend — modified:**
- `PRism.GitHub/ServiceCollectionExtensions.cs` — register `IReceivedEventsReader`.
- `PRism.Web/Endpoints/ActivityEndpoints.cs` — **new**, `MapActivity()` → `GET /api/activity`.
- `PRism.Web/Program.cs` — register `IActivityProvider`, call `app.MapActivity()`, add `IActivityProvider` to the `PRISM_E2E_FAKE_REVIEW` swap.
- `PRism.Web/TestHooks/FakeActivityProvider.cs` — **new**, deterministic feed for e2e.

**Frontend — new:**
- `frontend/src/api/activity.ts` — `getActivity()` client call.
- `frontend/src/hooks/useActivity.ts` — polling hook with last-good retention.

**Frontend — modified:**
- `frontend/src/api/types.ts` — add `ActivityVerb`, `ActivitySource`, `ActivityItem`, `ActivityResponse`.
- `frontend/src/components/ActivityRail/ActivityRail.tsx` — rewrite (Activity-only, real data, bot toggle, states, links).
- `frontend/src/components/ActivityRail/ActivityRail.module.css` — add toggle/state styles.
- delete `frontend/src/components/ActivityRail/activityData.ts`.
- `frontend/src/components/ActivityRail/__tests__/ActivityRail.test.tsx` — rewrite for the one-section P1 rail.
- `frontend/src/components/Inbox/InboxSkeleton.tsx` — render a single rail block in P1.
- `frontend/src/components/Inbox/InboxSkeleton.test.tsx` — update the rail-block assertion.
- `frontend/src/contexts/PreferencesContext.tsx` — add `'inbox.showActivityRail'` to `PreferenceKey` + `readKey`/`writeKey`.
- `frontend/src/components/Settings/panes/InboxPane.tsx` — add the "Show activity rail" toggle row.
- `frontend/e2e/parity-baselines.spec.ts` — already enables the rail; baseline regenerates from the new render.

---

# Backend

### Task 1: Activity contracts, raw input, and ports

**Files:**
- Create: `PRism.Core/Activity/ActivityContracts.cs`
- Create: `PRism.Core/Activity/RawReceivedEvent.cs`
- Create: `PRism.Core/Activity/IReceivedEventsReader.cs`
- Create: `PRism.Core/Activity/IActivityProvider.cs`
- Test: `tests/PRism.Core.Tests/Activity/ActivityContractsTests.cs`

- [ ] **Step 1.1: Write the contracts.** Create `PRism.Core/Activity/ActivityContracts.cs`:

```csharp
using System.Collections.Generic;

namespace PRism.Core.Activity;

// Wire enums serialize kebab-case to match the architectural invariant (see how
// CiStatus serializes — JsonStringEnumConverter + KebabCaseLower naming). For P1
// every ActivityVerb is a single lowercase word, so kebab == lowercase; the
// endpoint test in Task 5 asserts the wire value and fails red if the converter
// is missing.
public enum ActivitySource
{
    ReceivedEvent,        // wire: "received-event"  (P2 adds Notification)
}

public enum ActivityVerb
{
    Opened, Reopened, Closed, Merged, Reviewed, Commented, Other,
    // NB: no Pushed — PushEvent has no PR number and `synchronize` is filtered
    // from the Events API (see spec § Scope). P2 adds ReviewRequested, Mentioned.
}

// Every Phase-1 item is PR-anchored and carries an actor (events always do).
// ActorLogin/ActorAvatarUrl are nullable only so P2 notification rows (no actor)
// fit the same record additively.
public sealed record ActivityItem(
    string? ActorLogin,
    string? ActorAvatarUrl,
    bool ActorIsBot,
    ActivityVerb Verb,
    string Repo,
    int PrNumber,
    string? Title,
    string Url,
    System.DateTimeOffset Timestamp,
    ActivitySource Source);

// P2 grows this additively (adds Notifications, Watching flags).
public sealed record ActivityDegradation(bool ReceivedEvents);

// P2 adds IReadOnlyList<WatchedRepoActivity> Watching additively.
public sealed record ActivityResponse(
    IReadOnlyList<ActivityItem> Items,
    System.DateTimeOffset GeneratedAt,
    ActivityDegradation Degraded);
```

- [ ] **Step 1.2: Write the raw input record + reader result.** Create `PRism.Core/Activity/RawReceivedEvent.cs`:

```csharp
using System.Collections.Generic;

namespace PRism.Core.Activity;

// Adapter-agnostic projection of one GitHub received_events item. The reader
// (PRism.GitHub) parses JSON into this; the builder (pure) maps it to ActivityItem.
// `Id` is the GitHub event id — the dedup key (re-emitted duplicates share it).
// `IsPullRequestComment` is true only for an IssueCommentEvent whose payload.issue
// carried a pull_request marker (the reader resolves this; PrNumber = issue.number).
public sealed record RawReceivedEvent(
    string Id,
    string Type,
    string? ActorLogin,
    string? ActorAvatarUrl,
    string Repo,
    string? Action,
    int? PrNumber,
    string? Title,
    string? HtmlUrl,
    bool Merged,
    bool IsPullRequestComment,
    System.DateTimeOffset CreatedAt);

public readonly record struct ReceivedEventsResult(
    IReadOnlyList<RawReceivedEvent> Events,
    bool Degraded);
```

- [ ] **Step 1.3: Write the ports.** Create `PRism.Core/Activity/IReceivedEventsReader.cs`:

```csharp
using System.Threading;
using System.Threading.Tasks;

namespace PRism.Core.Activity;

// Fault-isolated: NEVER throws on transport/429/403/5xx — returns empty + Degraded.
// Mirrors GitHubCiFailingDetector's degrade-don't-throw contract.
public interface IReceivedEventsReader
{
    Task<ReceivedEventsResult> ReadAsync(CancellationToken ct);
}
```

Create `PRism.Core/Activity/IActivityProvider.cs`:

```csharp
using System.Threading;
using System.Threading.Tasks;

namespace PRism.Core.Activity;

public interface IActivityProvider
{
    Task<ActivityResponse> GetActivityAsync(CancellationToken ct);
}
```

- [ ] **Step 1.4: Write a contract sanity test.** Create `tests/PRism.Core.Tests/Activity/ActivityContractsTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class ActivityContractsTests
{
    [Fact]
    public void ActivityResponse_holds_items_and_degradation()
    {
        var item = new ActivityItem("alice", null, false, ActivityVerb.Reviewed,
            "acme/api", 7, "Fix it", "https://github.com/acme/api/pull/7",
            System.DateTimeOffset.UnixEpoch, ActivitySource.ReceivedEvent);
        var resp = new ActivityResponse([item], System.DateTimeOffset.UnixEpoch,
            new ActivityDegradation(ReceivedEvents: false));

        resp.Items.Should().ContainSingle().Which.PrNumber.Should().Be(7);
        resp.Degraded.ReceivedEvents.Should().BeFalse();
    }
}
```

- [ ] **Step 1.5: Run + commit.**

```bash
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ActivityContractsTests" --nologo
git add PRism.Core/Activity tests/PRism.Core.Tests/Activity/ActivityContractsTests.cs
git commit -m "feat(#137): activity contracts, raw input, and ports (P1)"
```
Expected: PASS.

---

### Task 2: `ActivityFeedBuilder` (pure logic core)

**Files:**
- Create: `PRism.Core/Activity/ActivityFeedBuilder.cs`
- Test: `tests/PRism.Core.Tests/Activity/ActivityFeedBuilderTests.cs`

- [ ] **Step 2.1: Write the failing tests.** Create `tests/PRism.Core.Tests/Activity/ActivityFeedBuilderTests.cs`:

```csharp
using System;
using FluentAssertions;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class ActivityFeedBuilderTests
{
    private static readonly DateTimeOffset Now = new(2026, 6, 9, 12, 0, 0, TimeSpan.Zero);

    private static RawReceivedEvent Ev(
        string id, string type, string? actor = "alice", string repo = "acme/api",
        string? action = null, int? pr = 7, bool merged = false,
        bool isPrComment = false, int hoursAgo = 1, string? avatar = "https://a/x.png",
        string? title = "T", string? url = "https://github.com/acme/api/pull/7")
        => new(id, type, actor, avatar, repo, action, pr, title, url, merged, isPrComment,
            Now.AddHours(-hoursAgo));

    [Fact]
    public void Maps_review_reviewcomment_issuecomment_pr_lifecycle()
    {
        var raw = new[]
        {
            Ev("1", "PullRequestReviewEvent"),
            Ev("2", "PullRequestReviewCommentEvent"),
            Ev("3", "IssueCommentEvent", isPrComment: true),
            Ev("4", "PullRequestEvent", action: "opened"),
            Ev("5", "PullRequestEvent", action: "reopened"),
            Ev("6", "PullRequestEvent", action: "closed", merged: false),
            Ev("7", "PullRequestEvent", action: "closed", merged: true),
        };

        var verbs = ActivityFeedBuilder.Build(raw, Now).Items
            .OrderBy(i => i.Timestamp).Select(i => i.Verb).ToArray();

        // Distinct ids + same timestamp ordering preserved via stable sort by ts desc.
        ActivityFeedBuilder.Build(raw, Now).Items.Select(i => i.Verb).Should()
            .BeEquivalentTo(new[]
            {
                ActivityVerb.Reviewed, ActivityVerb.Commented, ActivityVerb.Commented,
                ActivityVerb.Opened, ActivityVerb.Reopened, ActivityVerb.Closed, ActivityVerb.Merged,
            });
    }

    [Fact]
    public void Drops_plain_issue_comment_and_unmapped_types()
    {
        var raw = new[]
        {
            Ev("1", "IssueCommentEvent", isPrComment: false),   // plain issue → drop
            Ev("2", "PushEvent", pr: null),                      // no PR → drop
            Ev("3", "WatchEvent"),                               // unmapped → drop
            Ev("4", "PullRequestReviewEvent"),                   // kept
        };

        ActivityFeedBuilder.Build(raw, Now).Items.Should().ContainSingle()
            .Which.Verb.Should().Be(ActivityVerb.Reviewed);
    }

    [Fact]
    public void Drops_and_counts_recognized_event_missing_actor_or_pr()
    {
        var raw = new[]
        {
            Ev("1", "PullRequestReviewEvent", actor: null),      // recognized but no actor
            Ev("2", "PullRequestReviewEvent", pr: null),         // recognized but no PR
            Ev("3", "PullRequestReviewEvent"),                   // kept
        };

        var result = ActivityFeedBuilder.Build(raw, Now);
        result.Items.Should().ContainSingle();
        result.DroppedRecognized.Should().Be(2);
    }

    [Fact]
    public void Tags_bots_by_suffix_and_allowlist()
    {
        var raw = new[]
        {
            Ev("1", "PullRequestReviewEvent", actor: "mergewatch-playlist[bot]"),
            Ev("2", "PullRequestReviewEvent", actor: "Copilot"),
            Ev("3", "PullRequestReviewEvent", actor: "alice"),
        };

        var byActor = ActivityFeedBuilder.Build(raw, Now).Items
            .ToDictionary(i => i.ActorLogin!, i => i.ActorIsBot);

        byActor["mergewatch-playlist[bot]"].Should().BeTrue();
        byActor["Copilot"].Should().BeTrue();
        byActor["alice"].Should().BeFalse();
    }

    [Fact]
    public void Dedups_reemitted_duplicate_by_event_id_keeping_distinct_ids()
    {
        var raw = new[]
        {
            Ev("dup", "PullRequestReviewEvent", actor: "Copilot", pr: 195, hoursAgo: 1),
            Ev("dup", "PullRequestReviewEvent", actor: "Copilot", pr: 195, hoursAgo: 1), // same id
            Ev("other", "PullRequestReviewEvent", actor: "Copilot", pr: 195, hoursAgo: 5), // distinct id
        };

        // Same id collapses to one; the distinct-id second review by the same
        // actor on the same PR is PRESERVED (it is real, distinct activity).
        ActivityFeedBuilder.Build(raw, Now).Items.Should().HaveCount(2);
    }

    [Fact]
    public void Windows_to_last_24h()
    {
        var raw = new[]
        {
            Ev("1", "PullRequestReviewEvent", hoursAgo: 1),
            Ev("2", "PullRequestReviewEvent", hoursAgo: 25),   // outside 24h
        };

        ActivityFeedBuilder.Build(raw, Now).Items.Should().ContainSingle()
            .Which.Id().Should().Be("https://github.com/acme/api/pull/7");  // placeholder; see note
    }

    [Fact]
    public void Sorts_newest_first_and_caps_to_max_raw_items()
    {
        var raw = Enumerable.Range(0, 70)
            .Select(i => Ev(i.ToString(), "PullRequestReviewEvent", pr: i, hoursAgo: i % 23 + 1,
                url: $"https://github.com/acme/api/pull/{i}"))
            .ToArray();

        var items = ActivityFeedBuilder.Build(raw, Now).Items;
        items.Count.Should().Be(ActivityFeedBuilder.MaxRawItems);   // 50, NOT 12 (client caps to 12)
        items.Should().BeInDescendingOrder(i => i.Timestamp);
    }
}
```

> **Note on the `.Id()` line:** delete that assertion line — it's a stray placeholder. The `Windows_to_last_24h` test only needs `Should().ContainSingle()`. (Left here so you SEE it and remove it; do not ship a `.Id()` call — `ActivityItem` has no such method.)

- [ ] **Step 2.2: Run to verify red.**

```bash
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ActivityFeedBuilderTests" --nologo
```
Expected: FAIL — `ActivityFeedBuilder` does not exist.

- [ ] **Step 2.3: Implement the builder.** Create `PRism.Core/Activity/ActivityFeedBuilder.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.Linq;

namespace PRism.Core.Activity;

public readonly record struct ActivityBuildResult(
    IReadOnlyList<ActivityItem> Items,
    int DroppedRecognized);

public static class ActivityFeedBuilder
{
    public const int MaxRawItems = 50;       // server ceiling; client filters bots then caps to 12
    private const int WindowHours = 24;

    // Suffix-less bots that won't match the "[bot]" heuristic. Confirm exact login
    // at implementation (Copilot's received_events login lacked the suffix).
    private static readonly HashSet<string> KnownBots =
        new(StringComparer.OrdinalIgnoreCase) { "Copilot" };

    public static ActivityBuildResult Build(
        IReadOnlyList<RawReceivedEvent> events, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(events);

        var dropped = 0;
        var mapped = new List<ActivityItem>(events.Count);

        foreach (var e in events)
        {
            var verb = MapVerb(e);
            if (verb is null) continue;                       // unmapped type → silent drop (not counted)

            // Recognized type but missing the data that makes a row valid → drop + COUNT.
            if (string.IsNullOrEmpty(e.ActorLogin) || e.PrNumber is null || string.IsNullOrEmpty(e.Url()))
            {
                dropped++;
                continue;
            }

            mapped.Add(new ActivityItem(
                ActorLogin: e.ActorLogin,
                ActorAvatarUrl: e.ActorAvatarUrl,
                ActorIsBot: IsBot(e.ActorLogin),
                Verb: verb.Value,
                Repo: e.Repo,
                PrNumber: e.PrNumber.Value,
                Title: e.Title,
                Url: e.HtmlUrl!,
                Timestamp: e.CreatedAt,
                Source: ActivitySource.ReceivedEvent));
        }

        var items = mapped
            .Where(i => i.Timestamp >= now.AddHours(-WindowHours))   // 24h window
            .GroupBy(_ => 0)                                          // placeholder to allow id-dedup below
            .SelectMany(g => g)
            .ToList();

        // Event-id dedup: collapse re-emitted duplicates (same GitHub event id),
        // but KEEP distinct ids even if same actor/verb/PR (real distinct activity).
        var byId = new Dictionary<string, ActivityItem>(StringComparer.Ordinal);
        var idOf = events.ToDictionary(e => e, e => e.Id);   // not used; see simpler approach below
        // Simpler: dedup on the raw id mapped alongside. Rebuild with id carried.

        // --- replace the above block: carry id through mapping ---
        throw new NotImplementedException("see Step 2.4 — this scaffold is intentionally incomplete");
    }

    private static ActivityVerb? MapVerb(RawReceivedEvent e) => e.Type switch
    {
        "PullRequestReviewEvent" => ActivityVerb.Reviewed,
        "PullRequestReviewCommentEvent" => ActivityVerb.Commented,
        "IssueCommentEvent" when e.IsPullRequestComment => ActivityVerb.Commented,
        "PullRequestEvent" => e.Action switch
        {
            "opened" => ActivityVerb.Opened,
            "reopened" => ActivityVerb.Reopened,
            "closed" => e.Merged ? ActivityVerb.Merged : ActivityVerb.Closed,
            _ => null,
        },
        _ => null,
    };

    private static bool IsBot(string login) =>
        login.EndsWith("[bot]", StringComparison.OrdinalIgnoreCase) || KnownBots.Contains(login);
}

internal static class RawReceivedEventUrl
{
    public static string? Url(this RawReceivedEvent e) => e.HtmlUrl;
}
```

- [ ] **Step 2.4: Replace the scaffold with the real pipeline.** The Step 2.3 body intentionally threw to force you to write the clean version. Replace the entire `Build` method body with this (keeps id through mapping so dedup is by event id):

```csharp
    public static ActivityBuildResult Build(
        IReadOnlyList<RawReceivedEvent> events, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(events);

        var dropped = 0;
        var cutoff = now.AddHours(-WindowHours);
        var byId = new Dictionary<string, ActivityItem>(StringComparer.Ordinal);

        foreach (var e in events)
        {
            var verb = MapVerb(e);
            if (verb is null) continue;                         // unmapped → silent drop

            if (string.IsNullOrEmpty(e.ActorLogin) || e.PrNumber is null || string.IsNullOrEmpty(e.HtmlUrl))
            {
                dropped++;                                      // recognized but unusable → drop + count
                continue;
            }

            if (e.CreatedAt < cutoff) continue;                 // 24h window
            if (byId.ContainsKey(e.Id)) continue;               // event-id dedup (keep first; ids are unique per event)

            byId[e.Id] = new ActivityItem(
                ActorLogin: e.ActorLogin,
                ActorAvatarUrl: e.ActorAvatarUrl,
                ActorIsBot: IsBot(e.ActorLogin),
                Verb: verb.Value,
                Repo: e.Repo,
                PrNumber: e.PrNumber.Value,
                Title: e.Title,
                Url: e.HtmlUrl,
                Timestamp: e.CreatedAt,
                Source: ActivitySource.ReceivedEvent);
        }

        var items = byId.Values
            .OrderByDescending(i => i.Timestamp)
            .Take(MaxRawItems)
            .ToList();

        return new ActivityBuildResult(items, dropped);
    }
```

Then delete the now-unused `RawReceivedEventUrl` helper and the dead `idOf`/`GroupBy` lines from Step 2.3.

- [ ] **Step 2.5: Fix the stray test line.** In `ActivityFeedBuilderTests.Windows_to_last_24h`, delete the `.Which.Id()...` assertion; keep just:

```csharp
        ActivityFeedBuilder.Build(raw, Now).Items.Should().ContainSingle();
```

- [ ] **Step 2.6: Run to verify green + commit.**

```bash
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ActivityFeedBuilderTests" --nologo
git add PRism.Core/Activity/ActivityFeedBuilder.cs tests/PRism.Core.Tests/Activity/ActivityFeedBuilderTests.cs
git commit -m "feat(#137): pure ActivityFeedBuilder — verb map, bot tag, event-id dedup, 24h window, cap (P1)"
```
Expected: PASS (all builder tests).

---

### Task 3: `GitHubReceivedEventsReader` (fault-isolated adapter)

**Files:**
- Create: `PRism.GitHub/Activity/GitHubReceivedEventsReader.cs`
- Test: `tests/PRism.GitHub.Tests/Activity/GitHubReceivedEventsReaderTests.cs`

The reader needs the authenticated login to build `GET /users/{login}/received_events`. Read it from `ITokenStore.ReadTransientLoginAsync` is not right (transient); instead the committed login lives in app state. **Use the same login the rest of the app uses** — inject a `Func<Task<string?>>` login reader bound in DI (Task 4 wires it to the committed login source). For the reader, treat a null/empty login as a degraded read (empty + Degraded).

- [ ] **Step 3.1: Write failing tests.** Create `tests/PRism.GitHub.Tests/Activity/GitHubReceivedEventsReaderTests.cs`:

```csharp
using System.Net;
using System.Text;
using FluentAssertions;
using PRism.GitHub.Activity;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Activity;

public sealed class GitHubReceivedEventsReaderTests
{
    private static GitHubReceivedEventsReader Sut(FakeHttpMessageHandler handler, string? login = "octocat") =>
        new(new FakeHttpClientFactory(handler, new System.Uri("https://api.github.com/")),
            () => System.Threading.Tasks.Task.FromResult<string?>("token"),
            () => System.Threading.Tasks.Task.FromResult(login));

    private static HttpResponseMessage Ok(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private const string ReviewEvent = """
    [{
      "id": "100", "type": "PullRequestReviewEvent",
      "actor": { "login": "alice", "avatar_url": "https://a/alice.png" },
      "repo": { "name": "acme/api" },
      "payload": { "action": "created",
        "pull_request": { "number": 7, "title": "Fix login", "html_url": "https://github.com/acme/api/pull/7", "merged": false } },
      "created_at": "2026-06-09T11:00:00Z"
    }]
    """;

    private const string IssueCommentOnPr = """
    [{
      "id": "101", "type": "IssueCommentEvent",
      "actor": { "login": "bob", "avatar_url": "https://a/bob.png" },
      "repo": { "name": "acme/api" },
      "payload": { "action": "created",
        "issue": { "number": 9, "title": "Bug", "html_url": "https://github.com/acme/api/pull/9", "pull_request": { "url": "https://api.github.com/repos/acme/api/pulls/9" } } },
      "created_at": "2026-06-09T10:00:00Z"
    }]
    """;

    [Fact]
    public async Task Parses_review_event_with_actor_and_pr_number()
    {
        var result = await Sut(FakeHttpMessageHandler.Returns(HttpStatusCode.OK, ReviewEvent)).ReadAsync(default);

        result.Degraded.Should().BeFalse();
        var e = result.Events.Should().ContainSingle().Subject;
        e.Id.Should().Be("100");
        e.Type.Should().Be("PullRequestReviewEvent");
        e.ActorLogin.Should().Be("alice");
        e.PrNumber.Should().Be(7);
        e.HtmlUrl.Should().Be("https://github.com/acme/api/pull/7");
        e.IsPullRequestComment.Should().BeFalse();
    }

    [Fact]
    public async Task IssueComment_marks_pr_comment_and_uses_issue_number()
    {
        var result = await Sut(FakeHttpMessageHandler.Returns(HttpStatusCode.OK, IssueCommentOnPr)).ReadAsync(default);

        var e = result.Events.Should().ContainSingle().Subject;
        e.IsPullRequestComment.Should().BeTrue();
        e.PrNumber.Should().Be(9);
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task Non_success_degrades_to_empty_without_throwing(HttpStatusCode code)
    {
        var result = await Sut(FakeHttpMessageHandler.Returns(code, "{}")).ReadAsync(default);

        result.Events.Should().BeEmpty();
        result.Degraded.Should().BeTrue();
    }

    [Fact]
    public async Task Transport_failure_degrades_without_throwing()
    {
        var result = await Sut(FakeHttpMessageHandler.Throws(new HttpRequestException("boom"))).ReadAsync(default);

        result.Events.Should().BeEmpty();
        result.Degraded.Should().BeTrue();
    }

    [Fact]
    public async Task Null_login_degrades_without_calling_github()
    {
        var called = false;
        var handler = new FakeHttpMessageHandler(_ => { called = true; return Ok("[]"); });

        var result = await Sut(handler, login: null).ReadAsync(default);

        called.Should().BeFalse();
        result.Degraded.Should().BeTrue();
    }
}
```

- [ ] **Step 3.2: Run to verify red.**

```bash
dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubReceivedEventsReaderTests" --nologo
```
Expected: FAIL — reader does not exist.

- [ ] **Step 3.3: Implement the reader.** Create `PRism.GitHub/Activity/GitHubReceivedEventsReader.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.GitHub.Activity;

// Fault-isolated received_events reader. Mirrors GitHubCiFailingDetector:
// degrade-don't-throw on ANY non-success / transport failure (CI/feed enrichment
// must never break the surface). No 429 rethrow here — unlike the inbox poller,
// the activity endpoint has no orchestrator backoff loop, so a 429 simply degrades.
public sealed class GitHubReceivedEventsReader : IReceivedEventsReader
{
    private const int PerPage = 100;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<Task<string?>> _readLogin;

    public GitHubReceivedEventsReader(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<Task<string?>> readLogin)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readLogin = readLogin;
    }

    public async Task<ReceivedEventsResult> ReadAsync(CancellationToken ct)
    {
        var login = await _readLogin().ConfigureAwait(false);
        if (string.IsNullOrEmpty(login))
            return new ReceivedEventsResult([], Degraded: true);

        try
        {
            var token = await _readToken().ConfigureAwait(false);
            using var http = _httpFactory.CreateClient("github");
            using var req = new HttpRequestMessage(HttpMethod.Get,
                $"users/{Uri.EscapeDataString(login)}/received_events?per_page={PerPage}");
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.UserAgent.ParseAdd("PRism/0.1");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");

            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
                return new ReceivedEventsResult([], Degraded: true);

            await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
                return new ReceivedEventsResult([], Degraded: true);

            var list = new List<RawReceivedEvent>(doc.RootElement.GetArrayLength());
            foreach (var el in doc.RootElement.EnumerateArray())
            {
                var parsed = Parse(el);
                if (parsed is not null) list.Add(parsed);
            }
            return new ReceivedEventsResult(list, Degraded: false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;   // genuine cancellation propagates
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            return new ReceivedEventsResult([], Degraded: true);
        }
    }

    private static RawReceivedEvent? Parse(JsonElement el)
    {
        if (!el.TryGetProperty("id", out var idEl) || !el.TryGetProperty("type", out var typeEl))
            return null;
        var id = idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : idEl.GetRawText();
        var type = typeEl.GetString();
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(type)) return null;

        string? actorLogin = null, actorAvatar = null;
        if (el.TryGetProperty("actor", out var actor) && actor.ValueKind == JsonValueKind.Object)
        {
            actorLogin = actor.TryGetProperty("login", out var l) ? l.GetString() : null;
            actorAvatar = actor.TryGetProperty("avatar_url", out var a) ? a.GetString() : null;
        }

        var repo = el.TryGetProperty("repo", out var r) && r.TryGetProperty("name", out var rn)
            ? rn.GetString() ?? "" : "";

        string? action = null;
        int? prNumber = null;
        string? title = null, htmlUrl = null;
        var merged = false;
        var isPrComment = false;

        if (el.TryGetProperty("payload", out var p) && p.ValueKind == JsonValueKind.Object)
        {
            action = p.TryGetProperty("action", out var ac) ? ac.GetString() : null;

            if (p.TryGetProperty("pull_request", out var pr) && pr.ValueKind == JsonValueKind.Object)
            {
                if (pr.TryGetProperty("number", out var n) && n.TryGetInt32(out var num)) prNumber = num;
                title = pr.TryGetProperty("title", out var t) ? t.GetString() : null;
                htmlUrl = pr.TryGetProperty("html_url", out var u) ? u.GetString() : null;
                merged = pr.TryGetProperty("merged", out var m) && m.ValueKind == JsonValueKind.True;
            }
            else if (p.TryGetProperty("issue", out var issue) && issue.ValueKind == JsonValueKind.Object)
            {
                isPrComment = issue.TryGetProperty("pull_request", out var prMarker)
                    && prMarker.ValueKind == JsonValueKind.Object;
                if (issue.TryGetProperty("number", out var n) && n.TryGetInt32(out var num)) prNumber = num;
                title = issue.TryGetProperty("title", out var t) ? t.GetString() : null;
                htmlUrl = issue.TryGetProperty("html_url", out var u) ? u.GetString() : null;
            }
        }

        var createdAt = el.TryGetProperty("created_at", out var ca)
            && ca.TryGetDateTimeOffset(out var dto) ? dto : default;

        return new RawReceivedEvent(id, type, actorLogin, actorAvatar, repo, action,
            prNumber, title, htmlUrl, merged, isPrComment, createdAt);
    }
}
```

- [ ] **Step 3.4: Run to verify green + commit.**

```bash
dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubReceivedEventsReaderTests" --nologo
git add PRism.GitHub/Activity tests/PRism.GitHub.Tests/Activity
git commit -m "feat(#137): fault-isolated GitHubReceivedEventsReader (P1)"
```
Expected: PASS.

---

### Task 4: `ActivityProvider` + DI wiring

**Files:**
- Create: `PRism.Core/Activity/ActivityProvider.cs`
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs`
- Modify: `PRism.Web/Program.cs` (provider registration only; endpoint in Task 5)
- Test: `tests/PRism.Core.Tests/Activity/ActivityProviderTests.cs`

- [ ] **Step 4.1: Write failing provider tests.** Create `tests/PRism.Core.Tests/Activity/ActivityProviderTests.cs`:

```csharp
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class ActivityProviderTests
{
    private sealed class FakeReader(ReceivedEventsResult result) : IReceivedEventsReader
    {
        public Task<ReceivedEventsResult> ReadAsync(CancellationToken ct) => Task.FromResult(result);
    }

    private static RawReceivedEvent Review(string id) => new(
        id, "PullRequestReviewEvent", "alice", null, "acme/api", "created", 7, "T",
        "https://github.com/acme/api/pull/7", false, false, System.DateTimeOffset.UtcNow);

    [Fact]
    public async Task Maps_reader_output_into_response()
    {
        var reader = new FakeReader(new ReceivedEventsResult([Review("1")], Degraded: false));
        var sut = new ActivityProvider(reader, NullLogger<ActivityProvider>.Instance);

        var resp = await sut.GetActivityAsync(default);

        resp.Items.Should().ContainSingle().Which.Verb.Should().Be(ActivityVerb.Reviewed);
        resp.Degraded.ReceivedEvents.Should().BeFalse();
    }

    [Fact]
    public async Task Propagates_degradation_with_empty_items()
    {
        var reader = new FakeReader(new ReceivedEventsResult([], Degraded: true));
        var sut = new ActivityProvider(reader, NullLogger<ActivityProvider>.Instance);

        var resp = await sut.GetActivityAsync(default);

        resp.Items.Should().BeEmpty();
        resp.Degraded.ReceivedEvents.Should().BeTrue();
    }
}
```

- [ ] **Step 4.2: Run to verify red.**

```bash
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ActivityProviderTests" --nologo
```
Expected: FAIL — `ActivityProvider` does not exist.

- [ ] **Step 4.3: Implement the provider.** Create `PRism.Core/Activity/ActivityProvider.cs`:

```csharp
using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace PRism.Core.Activity;

public sealed class ActivityProvider : IActivityProvider
{
    private readonly IReceivedEventsReader _reader;
    private readonly ILogger<ActivityProvider> _log;

    public ActivityProvider(IReceivedEventsReader reader, ILogger<ActivityProvider> log)
    {
        _reader = reader;
        _log = log;
    }

    public async Task<ActivityResponse> GetActivityAsync(CancellationToken ct)
    {
        var read = await _reader.ReadAsync(ct).ConfigureAwait(false);
        var built = ActivityFeedBuilder.Build(read.Events, DateTimeOffset.UtcNow);

        if (built.DroppedRecognized > 0)
            _log.LogDebug("Activity: dropped {Count} recognized events missing actor/PR (payload-shape drift?).",
                built.DroppedRecognized);

        return new ActivityResponse(
            built.Items, DateTimeOffset.UtcNow, new ActivityDegradation(read.Degraded));
    }
}
```

- [ ] **Step 4.4: Register the reader in `PRism.GitHub/ServiceCollectionExtensions.cs`.** Add inside `AddPrismGitHub(...)`, next to the other reader registrations (after the `ICiFailingDetector` block):

```csharp
        services.AddSingleton<PRism.Core.Activity.IReceivedEventsReader>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var state = sp.GetRequiredService<IAppStateStore>();   // committed-login source
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new PRism.GitHub.Activity.GitHubReceivedEventsReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                async () => (await state.GetAsync(CancellationToken.None)).LastConfiguredLogin);
        });
```

> **Login source:** confirm the committed-login property name and the state-store interface during implementation (search for where `priorLogin`/`newLogin` come from in `AuthEndpoints.cs` — it reads the committed login from app state). Replace `IAppStateStore`/`GetAsync`/`LastConfiguredLogin` with the real members. If the login isn't readily available from state, fall back to a one-time `GET /user` lookup cached in the reader — but prefer the state value (no extra call). The reader already degrades gracefully on a null login, so a missing source fails safe.

- [ ] **Step 4.5: Register the provider in `PRism.Web/Program.cs`.** Add near the other singleton service registrations (before `var app = builder.Build();`):

```csharp
builder.Services.AddSingleton<PRism.Core.Activity.IActivityProvider, PRism.Core.Activity.ActivityProvider>();
```

- [ ] **Step 4.6: Run to verify green + commit.**

```bash
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ActivityProviderTests" --nologo
dotnet build PRism.Web --nologo --verbosity minimal
git add PRism.Core/Activity/ActivityProvider.cs PRism.GitHub/ServiceCollectionExtensions.cs PRism.Web/Program.cs tests/PRism.Core.Tests/Activity/ActivityProviderTests.cs
git commit -m "feat(#137): ActivityProvider + DI wiring (reader in GitHub, provider in Web) (P1)"
```
Expected: tests PASS; Web builds.

---

### Task 5: `GET /api/activity` endpoint

**Files:**
- Create: `PRism.Web/Endpoints/ActivityEndpoints.cs`
- Modify: `PRism.Web/Program.cs` (call `app.MapActivity()`)
- Test: `tests/PRism.Web.Tests/Endpoints/ActivityEndpointsTests.cs`

- [ ] **Step 5.1: Write failing endpoint tests.** Create `tests/PRism.Web.Tests/Endpoints/ActivityEndpointsTests.cs`. Model the host/factory on the existing `PreferencesEndpointsTests` (uses `PRismWebApplicationFactory` / `WebApplicationFactory<Program>`). The factory must register a fake `IActivityProvider` so the endpoint is deterministic:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Activity;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public sealed class ActivityEndpointsTests
{
    private sealed class StubProvider(ActivityResponse resp) : IActivityProvider
    {
        public Task<ActivityResponse> GetActivityAsync(CancellationToken ct) => Task.FromResult(resp);
    }

    private static WebApplicationFactory<Program> FactoryWith(ActivityResponse resp) =>
        new PRismWebApplicationFactory().WithWebHostBuilder(b =>
            b.ConfigureServices(s =>
            {
                s.RemoveAll(typeof(IActivityProvider));
                s.AddSingleton<IActivityProvider>(new StubProvider(resp));
            }));

    private static ActivityResponse OneReviewed() => new(
        [new ActivityItem("alice", null, false, ActivityVerb.Reviewed, "acme/api", 7, "Fix",
            "https://github.com/acme/api/pull/7", System.DateTimeOffset.UnixEpoch, ActivitySource.ReceivedEvent)],
        System.DateTimeOffset.UnixEpoch, new ActivityDegradation(false));

    [Fact]
    public async Task Returns_200_with_items_and_kebab_case_enums()
    {
        await using var factory = FactoryWith(OneReviewed());
        var client = factory.CreateClient();   // PRismWebApplicationFactory attaches the session cookie

        var resp = await client.GetAsync(new System.Uri("/api/activity", System.UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        var json = await resp.Content.ReadAsStringAsync();
        // Architectural invariant: enums serialize kebab-case.
        json.Should().Contain("\"verb\":\"reviewed\"");
        json.Should().Contain("\"source\":\"received-event\"");

        var body = JsonDocument.Parse(json).RootElement;
        body.GetProperty("items").GetArrayLength().Should().Be(1);
        body.GetProperty("degraded").GetProperty("receivedEvents").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public async Task Returns_200_degraded_with_empty_items()
    {
        await using var factory = FactoryWith(new ActivityResponse(
            [], System.DateTimeOffset.UnixEpoch, new ActivityDegradation(true)));
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new System.Uri("/api/activity", System.UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = JsonDocument.Parse(await resp.Content.ReadAsStringAsync()).RootElement;
        body.GetProperty("items").GetArrayLength().Should().Be(0);
        body.GetProperty("degraded").GetProperty("receivedEvents").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Requires_session_token()
    {
        await using var factory = FactoryWith(OneReviewed());
        // A client WITHOUT the session cookie must be 401'd by SessionTokenMiddleware.
        var client = factory.CreateClient(new WebApplicationFactoryClientOptions());
        client.DefaultRequestHeaders.Remove("X-PRism-Session");

        var resp = await client.GetAsync(new System.Uri("/api/activity", System.UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
```

> **Session-cookie note:** match however `PreferencesEndpointsTests` obtains an authed client (it uses `PRismWebApplicationFactory`). If that factory auto-authes, the `Requires_session_token` test must construct a *raw* client that bypasses the auto-auth; adapt to the real helper. If there's no easy un-authed client, replace that test with the existing pattern other endpoint tests use to assert middleware coverage (or drop it — the middleware is global and already covered elsewhere; the AC only needs the endpoint to sit behind it, which it does by registration).

- [ ] **Step 5.2: Run to verify red.**

```bash
dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~ActivityEndpointsTests" --nologo
```
Expected: FAIL — endpoint not mapped.

- [ ] **Step 5.3: Implement the endpoint.** Create `PRism.Web/Endpoints/ActivityEndpoints.cs`:

```csharp
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.Web.Endpoints;

internal static class ActivityEndpoints
{
    public static IEndpointRouteBuilder MapActivity(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        // Dedicated, inbox-isolated feed. Always 200: failure surfaces via
        // Degraded.ReceivedEvents + empty Items (the provider never throws on a
        // degraded read). No server cache in P1 (lands in P2). Inherits the global
        // middleware pipeline (session-token gate) like every other /api/* route.
        app.MapGet("/api/activity", async (IActivityProvider provider, CancellationToken ct) =>
            Results.Ok(await provider.GetActivityAsync(ct).ConfigureAwait(false)));

        return app;
    }
}
```

- [ ] **Step 5.4: Register the endpoint in `PRism.Web/Program.cs`.** Add to the endpoint-map chain, right after `app.MapInbox();`:

```csharp
app.MapActivity();
```

- [ ] **Step 5.5: Run to verify green.**

```bash
dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~ActivityEndpointsTests" --nologo
```
Expected: PASS. If the kebab-case enum assertions fail, the JSON serializer isn't applying the project's enum naming to these new enums — find how `CiStatus` gets its `JsonStringEnumConverter`/`JsonNamingPolicy` (search `JsonStringEnumConverter` in `PRism.Web`/`Program.cs`/`PRism.Core`) and ensure `ActivityVerb`/`ActivitySource` are covered the same way (usually a global `JsonSerializerOptions` converter — no per-enum attribute needed). Re-run until green.

- [ ] **Step 5.6: Commit.**

```bash
git add PRism.Web/Endpoints/ActivityEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/ActivityEndpointsTests.cs
git commit -m "feat(#137): GET /api/activity endpoint (always-200, degraded-via-flag) (P1)"
```

---

# Frontend

### Task 6: Frontend types + API client

**Files:**
- Modify: `frontend/src/api/types.ts`
- Create: `frontend/src/api/activity.ts`

- [ ] **Step 6.1: Add wire types.** Append to `frontend/src/api/types.ts`:

```typescript
// #137 Activity rail (Phase 1). Mirrors PRism.Core/Activity contracts; enums are
// the kebab-case wire strings. P2 grows ActivityResponse (Watching) + ActivityVerb
// (review-requested, mentioned) + degraded flags additively — read leniently.
export type ActivityVerb =
  | 'opened'
  | 'reopened'
  | 'closed'
  | 'merged'
  | 'reviewed'
  | 'commented'
  | 'other';

export type ActivitySource = 'received-event';

export interface ActivityItem {
  actorLogin: string | null;
  actorAvatarUrl: string | null;
  actorIsBot: boolean;
  verb: ActivityVerb;
  repo: string;
  prNumber: number;
  title: string | null;
  url: string;
  timestamp: string;
  source: ActivitySource;
}

export interface ActivityDegradation {
  receivedEvents: boolean;
}

export interface ActivityResponse {
  items: ActivityItem[];
  generatedAt: string;
  degraded: ActivityDegradation;
}
```

- [ ] **Step 6.2: Add the client call.** Create `frontend/src/api/activity.ts`:

```typescript
import { apiClient } from './client';
import type { ActivityResponse } from './types';

export function getActivity(): Promise<ActivityResponse> {
  return apiClient.get<ActivityResponse>('/api/activity');
}
```

- [ ] **Step 6.3: Typecheck + commit.**

```bash
cd frontend && npx tsc -b && cd ..
git add frontend/src/api/types.ts frontend/src/api/activity.ts
git commit -m "feat(#137): activity wire types + getActivity client (P1)"
```
Expected: `tsc -b` clean. (Per repo note, `tsc --noEmit` is vacuous here — use `tsc -b`.)

---

### Task 7: `useActivity` polling hook

**Files:**
- Create: `frontend/src/hooks/useActivity.ts`
- Test: `frontend/src/hooks/useActivity.test.tsx`

- [ ] **Step 7.1: Write failing tests.** Create `frontend/src/hooks/useActivity.test.tsx`:

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ActivityResponse } from '../api/types';
import { useActivity } from './useActivity';

const { getActivityMock } = vi.hoisted(() => ({ getActivityMock: vi.fn() }));
vi.mock('../api/activity', () => ({ getActivity: getActivityMock }));

const RESP = (n: number): ActivityResponse => ({
  items: [
    {
      actorLogin: 'alice', actorAvatarUrl: null, actorIsBot: false, verb: 'reviewed',
      repo: 'acme/api', prNumber: n, title: 'T', url: `https://github.com/acme/api/pull/${n}`,
      timestamp: new Date().toISOString(), source: 'received-event',
    },
  ],
  generatedAt: new Date().toISOString(),
  degraded: { receivedEvents: false },
});

beforeEach(() => {
  getActivityMock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useActivity', () => {
  test('loads, then polls on the cadence', async () => {
    getActivityMock.mockResolvedValueOnce(RESP(1)).mockResolvedValueOnce(RESP(2));
    const { result } = renderHook(() => useActivity());

    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(1));
    expect(getActivityMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(2));
    expect(getActivityMock).toHaveBeenCalledTimes(2);
  });

  test('retains last-good data when a poll fails', async () => {
    getActivityMock.mockResolvedValueOnce(RESP(1)).mockRejectedValueOnce(new Error('blip'));
    const { result } = renderHook(() => useActivity());

    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    // Last-good data preserved; error surfaced.
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data?.items[0].prNumber).toBe(1);
  });
});
```

- [ ] **Step 7.2: Run to verify red.**

```bash
cd frontend && npx vitest run src/hooks/useActivity.test.tsx && cd ..
```
Expected: FAIL — hook does not exist.

- [ ] **Step 7.3: Implement the hook.** Create `frontend/src/hooks/useActivity.ts`:

```typescript
import { useEffect, useRef, useState } from 'react';
import { getActivity } from '../api/activity';
import type { ActivityResponse } from '../api/types';

const POLL_MS = 90_000;

export interface UseActivityResult {
  data: ActivityResponse | null;
  isLoading: boolean;
  error: Error | null;
}

// Polls /api/activity every ~90s. Retains last-good data across a failed poll
// (no error flash on a transient blip), mirroring usePrDetail's preservation rule.
// Tab-hidden visibility-pause is deferred to P2 (the 3-call cost makes it worth it there).
export function useActivity(): UseActivityResult {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const dataRef = useRef<ActivityResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await getActivity();
        if (cancelled) return;
        dataRef.current = next;
        setData(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Keep dataRef.current (last good) — do NOT clear data.
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { data, isLoading, error };
}
```

- [ ] **Step 7.4: Run to verify green + commit.**

```bash
cd frontend && npx vitest run src/hooks/useActivity.test.tsx && cd ..
git add frontend/src/hooks/useActivity.ts frontend/src/hooks/useActivity.test.tsx
git commit -m "feat(#137): useActivity polling hook with last-good retention (P1)"
```
Expected: PASS.

---

### Task 8: Rewrite `ActivityRail` (real data, bot toggle, states, links)

**Files:**
- Rewrite: `frontend/src/components/ActivityRail/ActivityRail.tsx`
- Modify: `frontend/src/components/ActivityRail/ActivityRail.module.css`
- Delete: `frontend/src/components/ActivityRail/activityData.ts`
- Rewrite: `frontend/src/components/ActivityRail/__tests__/ActivityRail.test.tsx`

- [ ] **Step 8.1: Write failing tests.** Replace `frontend/src/components/ActivityRail/__tests__/ActivityRail.test.tsx` with (create `__tests__/` if the current test sits beside the component — match the existing location):

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ActivityResponse } from '../../../api/types';
import { ActivityRail } from '../ActivityRail';

const { useActivityMock } = vi.hoisted(() => ({ useActivityMock: vi.fn() }));
vi.mock('../../../hooks/useActivity', () => ({ useActivity: useActivityMock }));

function resp(partial: Partial<ActivityResponse> = {}): ActivityResponse {
  return {
    items: [],
    generatedAt: new Date().toISOString(),
    degraded: { receivedEvents: false },
    ...partial,
  };
}
const item = (over: Partial<ActivityResponse['items'][0]>): ActivityResponse['items'][0] => ({
  actorLogin: 'alice', actorAvatarUrl: null, actorIsBot: false, verb: 'reviewed',
  repo: 'acme/api', prNumber: 7, title: 'Fix login', url: 'https://github.com/acme/api/pull/7',
  timestamp: new Date().toISOString(), source: 'received-event', ...over,
});

const renderRail = () => render(<MemoryRouter><ActivityRail /></MemoryRouter>);

beforeEach(() => useActivityMock.mockReset());

describe('ActivityRail (P1)', () => {
  test('renders only the Activity section — no Watching', () => {
    useActivityMock.mockReturnValue({ data: resp(), isLoading: false, error: null });
    renderRail();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.queryByText('Watching')).toBeNull();
  });

  test('renders actor + verb + PR ref as an in-app link', () => {
    useActivityMock.mockReturnValue({
      data: resp({ items: [item({ actorLogin: 'noah.s', verb: 'reviewed', prNumber: 1810 })] }),
      isLoading: false, error: null,
    });
    renderRail();
    const link = screen.getByRole('link', { name: /noah\.s reviewed #1810/i });
    expect(link).toHaveAttribute('href', '/pr/acme/api/1810');
  });

  test('hides bots by default and reveals them via the toggle, re-capping to 12', async () => {
    const items = [
      item({ actorLogin: 'alice', prNumber: 1 }),
      item({ actorLogin: 'mergewatch[bot]', actorIsBot: true, prNumber: 2 }),
    ];
    useActivityMock.mockReturnValue({ data: resp({ items }), isLoading: false, error: null });
    renderRail();

    // Default hidden: bot row absent.
    expect(screen.queryByText(/mergewatch\[bot\]/)).toBeNull();
    expect(screen.getByText(/alice/)).toBeInTheDocument();

    // Toggle on → bot row appears.
    await userEvent.click(screen.getByRole('button', { name: /show bots/i }));
    expect(screen.getByText(/mergewatch\[bot\]/)).toBeInTheDocument();
  });

  test('empty (quiet) state names the window', () => {
    useActivityMock.mockReturnValue({ data: resp({ items: [] }), isLoading: false, error: null });
    renderRail();
    expect(screen.getByText('No pull-request activity in the last 24h')).toBeInTheDocument();
  });

  test('empty (all-bots, default hidden) names the filter, not the window', () => {
    useActivityMock.mockReturnValue({
      data: resp({ items: [item({ actorLogin: 'ci[bot]', actorIsBot: true })] }),
      isLoading: false, error: null,
    });
    renderRail();
    expect(screen.getByText(/no human activity in the last 24h/i)).toBeInTheDocument();
  });

  test('degraded note is distinct from empty', () => {
    useActivityMock.mockReturnValue({
      data: resp({ items: [], degraded: { receivedEvents: true } }),
      isLoading: false, error: null,
    });
    renderRail();
    expect(screen.getByText('Activity unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/last 24h$/)).not.toBe(screen.getByText('Activity unavailable'));
  });

  test('malformed PR url falls back to an external anchor without throwing', () => {
    useActivityMock.mockReturnValue({
      data: resp({ items: [item({ url: 'not a url' })] }),
      isLoading: false, error: null,
    });
    renderRail();
    const link = screen.getByRole('link', { name: /alice reviewed #7/i });
    expect(link).toHaveAttribute('href', 'not a url');   // external <a>, no crash
  });
});
```

- [ ] **Step 8.2: Run to verify red.**

```bash
cd frontend && npx vitest run src/components/ActivityRail && cd ..
```
Expected: FAIL.

- [ ] **Step 8.3: Implement the rewrite.** Replace `frontend/src/components/ActivityRail/ActivityRail.tsx`:

```typescript
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../Avatar/Avatar';
import { formatAge } from '../../utils/relativeTime';
import { useActivity } from '../../hooks/useActivity';
import type { ActivityItem, ActivityVerb } from '../../api/types';
import styles from './ActivityRail.module.css';

const MAX_VISIBLE = 12;

const VERB_PHRASE: Record<ActivityVerb, string> = {
  opened: 'opened',
  reopened: 'reopened',
  closed: 'closed',
  merged: 'merged',
  reviewed: 'reviewed',
  commented: 'commented on',
  other: 'updated',
};

// Parse a github.com PR html_url → the in-app /pr/:owner/:repo/:number path.
// Returns null on any non-PR / malformed url so the caller can fall back to <a>.
function inAppPrPath(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  return `/pr/${m[1]}/${m[2]}/${m[3]}`;
}

function prRef(item: ActivityItem): string {
  // Repo names from received_events are "owner/repo"; show the short repo + #n,
  // matching the spec phrasing examples ("MindBodyPOS#5436", "#1810").
  const shortRepo = item.repo.includes('/') ? item.repo.split('/')[1] : item.repo;
  return `${shortRepo}#${item.prNumber}`;
}

function Row({ item }: { item: ActivityItem }) {
  const path = inAppPrPath(item.url);
  const label = `${item.actorLogin} ${VERB_PHRASE[item.verb]} #${item.prNumber}${
    item.title ? ` — ${item.title}` : ''
  }`;
  const inner = (
    <>
      <Avatar src={item.actorAvatarUrl} login={item.actorLogin ?? ''} size="sm" />
      <span className={styles.actor}>{item.actorLogin}</span> {VERB_PHRASE[item.verb]}{' '}
      <span className={styles.pr}>{prRef(item)}</span>
      <span className={styles.when}> · {formatAge(item.timestamp)}</span>
    </>
  );
  return (
    <li className={styles.item}>
      {path ? (
        <Link to={path} className={styles.rowLink} aria-label={label}>
          {inner}
        </Link>
      ) : (
        <a href={item.url} className={styles.rowLink} aria-label={label} rel="noreferrer">
          {inner}
        </a>
      )}
    </li>
  );
}

export function ActivityRail() {
  const { data, isLoading, error } = useActivity();
  const [showBots, setShowBots] = useState(false); // transient; default HIDDEN

  const all = data?.items ?? [];
  const visible = useMemo(
    () => all.filter((i) => showBots || !i.actorIsBot).slice(0, MAX_VISIBLE),
    [all, showBots],
  );

  const degraded = data?.degraded.receivedEvents ?? false;
  const showDegraded = (!data && error) || degraded;
  const hasAnyItems = all.length > 0;
  const allHiddenAreBots = hasAnyItems && visible.length === 0; // every row filtered by the toggle

  return (
    <aside className={styles.rail} aria-label="Activity" data-testid="activity-rail">
      <section className={styles.section}>
        <header className={styles.head}>
          <span className={styles.title}>Activity</span>
          <span className={styles.muted}>last 24h</span>
          <button
            type="button"
            className={styles.botToggle}
            aria-pressed={showBots}
            onClick={() => setShowBots((v) => !v)}
          >
            Show bots
          </button>
        </header>

        {isLoading && !data ? (
          <ol className={styles.list} aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className={styles.skeletonRow} aria-hidden="true" />
            ))}
          </ol>
        ) : showDegraded ? (
          <p className={styles.degraded} role="status">
            Activity unavailable
          </p>
        ) : allHiddenAreBots ? (
          <p className={styles.empty}>No human activity in the last 24h — turn on “Show bots” to see bot activity</p>
        ) : visible.length === 0 ? (
          <p className={styles.empty}>No pull-request activity in the last 24h</p>
        ) : (
          <ol className={styles.list}>
            {visible.map((it) => (
              <Row key={`${it.url}:${it.verb}:${it.timestamp}`} item={it} />
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}
```

- [ ] **Step 8.4: Add the new CSS classes.** Append to `frontend/src/components/ActivityRail/ActivityRail.module.css` (existing `.rail/.section/.head/.title/.muted/.list/.item/.actor/.pr/.when` stay):

```css
.botToggle {
  margin-left: auto;
  font-size: var(--text-2xs);
  color: var(--text-3);
  background: transparent;
  border: 1px solid var(--border-1);
  border-radius: 999px;
  padding: 1px 8px;
  cursor: pointer;
}
.botToggle[aria-pressed='true'] {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.rowLink {
  color: inherit;
  text-decoration: none;
  display: block;
}
.rowLink:hover .pr {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.empty,
.degraded {
  font-size: var(--text-xs);
  margin: 0;
}
.empty {
  color: var(--text-3);
}
.degraded {
  color: var(--warning-fg, var(--text-2));
  background: var(--warning-soft, var(--surface-2));
  border: 1px solid var(--warning-border, var(--border-1));
  border-radius: var(--radius-2);
  padding: var(--s-2) var(--s-3);
}
.skeletonRow {
  height: 14px;
  margin-bottom: var(--s-3);
  border-radius: var(--radius-1);
  background: var(--surface-2);
}
```

> Adjust the `.head` rule if needed so the toggle sits at the trailing edge (the existing `.head` is `justify-content: space-between`; `margin-left: auto` on the toggle keeps title + muted left and toggle right). If `--warning-*` tokens don't exist, use the existing alert/snackbar token names — grep `StreamHealthSnackbar.module.css` for the project's warning treatment and reuse it so "broken" reads distinctly from the muted "quiet" copy.

- [ ] **Step 8.5: Delete the mock.**

```bash
git rm frontend/src/components/ActivityRail/activityData.ts
```
(If `tsc -b` flags any other importer, there should be none — the exports were rail-only. Fix any straggler import.)

- [ ] **Step 8.6: Run tests + typecheck to verify green + commit.**

```bash
cd frontend && npx vitest run src/components/ActivityRail && npx tsc -b && cd ..
git add frontend/src/components/ActivityRail
git commit -m "feat(#137): rewrite ActivityRail on real data — bot toggle (default hidden), states, in-app links (P1)"
```
Expected: PASS + clean typecheck.

---

### Task 9: Single-panel skeleton + InboxPage wiring

**Files:**
- Modify: `frontend/src/components/Inbox/InboxSkeleton.tsx`
- Modify: `frontend/src/components/Inbox/InboxSkeleton.test.tsx`
- Verify: `frontend/src/pages/InboxPage.tsx` (already gates on `showActivityRail`; just confirm)

- [ ] **Step 9.1: Update the skeleton test (red).** In `frontend/src/components/Inbox/InboxSkeleton.test.tsx`, change the rail assertion to expect a single block. Replace the `renders the rail only when showRail is true` test body with:

```typescript
  it('renders the rail (single P1 panel) only when showRail is true', () => {
    const { rerender } = render(<InboxSkeleton showRail={false} />);
    expect(screen.queryByTestId('inbox-skeleton-rail')).toBeNull();
    rerender(<InboxSkeleton showRail />);
    const rail = screen.getByTestId('inbox-skeleton-rail');
    // P1 rail shows ONE panel block (Watching's second block returns in P2).
    expect(within(rail).getAllByTestId('skeleton')).toHaveLength(1);
  });
```

> If `Skeleton` doesn't carry `data-testid="skeleton"`, count via the rail's direct element children instead (e.g. `rail.children`). Adapt to the real `Skeleton` testid; the load-bearing assertion is "one block, not two."  Add `within` to the import from `@testing-library/react`.

- [ ] **Step 9.2: Run to verify red.**

```bash
cd frontend && npx vitest run src/components/Inbox/InboxSkeleton.test.tsx && cd ..
```
Expected: FAIL (currently two blocks).

- [ ] **Step 9.3: Reduce the skeleton to one block.** In `frontend/src/components/Inbox/InboxSkeleton.tsx`, change the rail branch from two `<Skeleton>` blocks to one:

```typescript
        {showRail && (
          <div className={styles.rail} data-testid="inbox-skeleton-rail">
            {/* P1: single Activity panel. The second (Watching) block returns in P2. */}
            <Skeleton height={120} radius={10} />
          </div>
        )}
```

Also fix the stale doc-comment above the component (it references `useAiGate('inboxRanking')`); update to: `` `showRail` is supplied by InboxPage from the inbox.showActivityRail preference (#137/#309). ``

- [ ] **Step 9.4: Confirm InboxPage needs no change.** `frontend/src/pages/InboxPage.tsx` already has `const showActivityRail = preferences?.inbox.showActivityRail ?? false;`, renders `<InboxSkeleton showRail={showActivityRail} />`, and `{showActivityRail && <ActivityRail />}`. Verify those three lines are the committed baseline (Step 0.1 reverted the throwaway). No edit required.

```bash
cd frontend && npx vitest run src/components/Inbox/InboxSkeleton.test.tsx && npx tsc -b && cd ..
```
Expected: PASS + clean.

- [ ] **Step 9.5: Commit.**

```bash
git add frontend/src/components/Inbox/InboxSkeleton.tsx frontend/src/components/Inbox/InboxSkeleton.test.tsx
git commit -m "feat(#137): single-panel P1 inbox rail skeleton (P1)"
```

---

### Task 10: Settings "Show activity rail" toggle + preference wiring

**Files:**
- Modify: `frontend/src/contexts/PreferencesContext.tsx`
- Modify: `frontend/src/components/Settings/panes/InboxPane.tsx`
- Test: `frontend/src/components/Settings/panes/InboxPane.test.tsx` (extend or create)

- [ ] **Step 10.1: Add the preference key + read/write arms.** In `frontend/src/contexts/PreferencesContext.tsx`:

Add to the `PreferenceKey` union (after `'inbox.sectionOrder'`):

```typescript
  | 'inbox.showActivityRail'
```

Add to `readKey` (after the `inbox.sectionOrder` arm):

```typescript
  if (key === 'inbox.showActivityRail') return prefs.inbox.showActivityRail;
```

Add to `writeKey` (after the `inbox.sectionOrder` arm):

```typescript
  if (key === 'inbox.showActivityRail')
    return { ...prefs, inbox: { ...prefs.inbox, showActivityRail: value as boolean } };
```

- [ ] **Step 10.2: Add the Settings toggle.** In `frontend/src/components/Settings/panes/InboxPane.tsx`, add a row mirroring the existing `Switch` pattern. Place it after the section toggles / sort row. Use the existing `set(...)` helper and `Switch` component already imported in the file:

```typescript
<div className={pane.row}>
  <Switch
    id="inbox-show-activity-rail"
    label="Show activity rail"
    checked={showActivityRail}
    onChange={(next) => set('inbox.showActivityRail', next).catch(() => {})}
  />
  <div className={pane.spring} />
  <span className={pane.subLabel}>Hidden on narrow windows.</span>
</div>
```

> Read the current value the same way `defaultSort`/`sections` are read at the top of `InboxPane` (e.g. `const showActivityRail = prefs.inbox.showActivityRail;` from whatever preferences accessor the pane already uses). Match the existing row markup (`pane.row`, `pane.subLabel` — if `subLabel` doesn't exist, reuse the muted class the pane already uses for helper text). The static sub-label is always shown (the panel doesn't branch on viewport).

- [ ] **Step 10.3: Add/extend the pane test.** In `frontend/src/components/Settings/panes/InboxPane.test.tsx` (create if absent, modeling the existing Settings pane tests), add:

```typescript
test('Show activity rail toggle reflects and writes inbox.showActivityRail', async () => {
  // Render the pane with a preferences provider whose inbox.showActivityRail = false,
  // spying on the preference setter (mirror how the other InboxPane tests mount it).
  // Assert the switch is unchecked, click it, and assert set('inbox.showActivityRail', true).
  // (Fill in using the file's existing render harness + setter spy.)
});
```

> Replace the comment body with the concrete assertions using this file's existing test harness (the other Settings pane tests show how the preference setter is spied and how the pane is mounted). The test must (1) assert initial unchecked state from `showActivityRail: false`, (2) click the switch, (3) assert the setter was called with `('inbox.showActivityRail', true)`.

- [ ] **Step 10.4: Run + typecheck + commit.**

```bash
cd frontend && npx vitest run src/components/Settings src/contexts/PreferencesContext && npx tsc -b && cd ..
git add frontend/src/contexts/PreferencesContext.tsx frontend/src/components/Settings/panes/InboxPane.tsx frontend/src/components/Settings/panes/InboxPane.test.tsx
git commit -m "feat(#137): Settings → Inbox 'Show activity rail' toggle + preference wiring (P1)"
```
Expected: PASS + clean. (Backend `inbox.showActivityRail` already round-trips — `PreferencesEndpointsTests` covers it; no backend change.)

---

### Task 11: e2e fake provider + visual baseline

**Files:**
- Create: `PRism.Web/TestHooks/FakeActivityProvider.cs`
- Modify: `PRism.Web/Program.cs` (add `IActivityProvider` to the `PRISM_E2E_FAKE_REVIEW` swap)
- Verify/adjust: `frontend/e2e/parity-baselines.spec.ts` (already enables the rail)
- Baselines: `frontend/e2e/__screenshots__/{linux,win32}/inbox-activity-rail.png`

- [ ] **Step 11.1: Create the deterministic fake provider.** Create `PRism.Web/TestHooks/FakeActivityProvider.cs`:

```csharp
using System;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.Web.TestHooks;

// Deterministic activity feed for Playwright visual baselines. Registered ONLY under
// ASPNETCORE_ENVIRONMENT=Test + PRISM_E2E_FAKE_REVIEW=1 (Program.cs swap) — never in
// Production. Mirrors FakeReviewAuth's role on the IActivityProvider seam. Returns a
// fixed human-dominant feed (bots present but hidden by the rail's default-off toggle).
public sealed class FakeActivityProvider : IActivityProvider
{
    private static readonly DateTimeOffset Base = new(2026, 6, 9, 12, 0, 0, TimeSpan.Zero);

    public Task<ActivityResponse> GetActivityAsync(CancellationToken ct)
    {
        ActivityItem It(string actor, bool bot, ActivityVerb verb, int pr, int minsAgo, string repo = "acme/api") =>
            new(actor, null, bot, verb, repo, pr, $"PR #{pr}",
                $"https://github.com/{repo}/pull/{pr}", Base.AddMinutes(-minsAgo), ActivitySource.ReceivedEvent);

        var items = new[]
        {
            It("noah.s", false, ActivityVerb.Reviewed, 1810, 38),
            It("alice", false, ActivityVerb.Commented, 5436, 60, "acme/pos"),
            It("Copilot", true, ActivityVerb.Reviewed, 1810, 40),
            It("jules.t", false, ActivityVerb.Reviewed, 1827, 120),
            It("rohit", false, ActivityVerb.Opened, 1842, 180),
            It("noah.s", false, ActivityVerb.Merged, 1815, 300),
        };
        return Task.FromResult(new ActivityResponse(items, Base, new ActivityDegradation(false)));
    }
}
```

- [ ] **Step 11.2: Add the provider to the e2e DI swap.** In `PRism.Web/Program.cs`, inside the existing `if (builder.Environment.IsEnvironment("Test") && Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1")` block, add after the review-service swaps:

```csharp
    builder.Services.RemoveAll(typeof(PRism.Core.Activity.IActivityProvider));
    builder.Services.AddSingleton<PRism.Core.Activity.IActivityProvider, PRism.Web.TestHooks.FakeActivityProvider>();
```

> This keeps the fake behind the same env+flag guard as the review fakes — no new HTTP injection surface (the DI-swap approach the spec mandates over a test-only route).

- [ ] **Step 11.3: Confirm the e2e spec.** `frontend/e2e/parity-baselines.spec.ts` already has an `inbox-activity-rail` test that POSTs `inbox.showActivityRail: true` and reloads. With the fake provider now feeding real-shaped data, the rail render changes (was the mock, now the fake feed), so the baseline must regenerate. No spec-logic change is required unless the test asserts the old mock text — read it and remove any assertion tied to the deleted mock's strings ("pushed iter 3", "Watching", "platform/billing-svc"). The screenshot assertion stays.

- [ ] **Step 11.4: Build backend + run the e2e spec locally to (re)generate the baseline.**

```bash
cd frontend
npx playwright test parity-baselines.spec.ts -g "inbox-activity-rail" --update-snapshots
cd ..
```
Expected: the spec passes and writes/updates `inbox-activity-rail.png` for your local platform (`win32`). **Inspect the screenshot** — it must show the single Activity panel, human rows only (bots hidden), no Watching section. If it looks right, this is the local baseline.

> **Linux baseline (CI):** the canonical baseline lives under `__screenshots__/linux/`. Per the repo convention, regenerate it from the CI e2e artifact (download the CI `actual.png`, verify the diff, copy over `__screenshots__/linux/inbox-activity-rail.png`) rather than hand-rendering on Windows. Do this after the PR's first CI run produces the artifact. (See the memory note "Regen Linux Playwright parity baseline via CI artifact".)

- [ ] **Step 11.5: Add a production-guard assertion (security).** The fake provider must never serve in Production. The existing `TestEndpoints_NotLiveInProduction` test covers `/test/*`; the activity fake is gated by the same env+flag block, so add a focused test in `tests/PRism.Web.Tests/` asserting that under Production (no `PRISM_E2E_FAKE_REVIEW`), the resolved `IActivityProvider` is the real `ActivityProvider`, not `FakeActivityProvider`:

```csharp
[Fact]
public void Production_resolves_real_ActivityProvider_not_fake()
{
    using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => b.UseEnvironment("Production"));
    using var scope = factory.Services.CreateScope();
    var provider = scope.ServiceProvider.GetRequiredService<PRism.Core.Activity.IActivityProvider>();
    provider.Should().BeOfType<PRism.Core.Activity.ActivityProvider>();
}
```

- [ ] **Step 11.6: Run backend tests + commit.**

```bash
dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~ActivityProvider|FullyQualifiedName~ActivityEndpoints" --nologo
git add PRism.Web/TestHooks/FakeActivityProvider.cs PRism.Web/Program.cs frontend/e2e tests/PRism.Web.Tests
git commit -m "test(#137): e2e FakeActivityProvider (env+flag-gated) + rail baseline + prod-guard (P1)"
```
Expected: PASS.

---

### Task 12: Full-suite gate + docs

**Files:**
- Modify: any doc per `.ai/docs/documentation-maintenance.md` that lists endpoints/features (e.g. an API/endpoint inventory or feature-state doc, if present).
- Modify: the spec's status line (flip Phase 1 to "Implemented" once merged — optional, can be a follow-up).

- [ ] **Step 12.1: Run the full pre-push suite (one long command at a time).**

```bash
dotnet test --nologo
```
Then:
```bash
cd frontend && npx vitest run && npx tsc -b && cd ..
```
Expected: all green. Fix any cross-file fallout (e.g. a lingering `activityData` import, a snapshot needing update).

- [ ] **Step 12.2: prettier (raw, to avoid the rtk mask).** Per the repo note, verify formatting with raw prettier, not the rtk-proxied lint:

```bash
cd frontend && npx prettier --check "src/**/*.{ts,tsx,css}" "e2e/**/*.ts" && cd ..
```
Expected: "All matched files use Prettier code style!" If not, `npx prettier --write` the offenders and re-commit.

- [ ] **Step 12.3: Update docs.** Scan `.ai/docs/documentation-maintenance.md`; if it points at a doc that inventories endpoints or rail/feature state, add `GET /api/activity` and the rail's real-data status there. Commit any doc edit in this same branch.

```bash
git add -A
git commit -m "docs(#137): note GET /api/activity + activity rail real-data (P1)"
```

- [ ] **Step 12.4: B1 visual sign-off (gated).** This issue is B1+B2 gated. Before opening the PR for merge, capture the rail screenshots (default human-only view + bots-toggled-on) and post them for owner visual sign-off, plus the PAT-scope note (classic `repo`, verified live; FG Events:read) and the `## Proof` disposition of every ce-doc-review finding. Do NOT merge without the owner's B1 pass.

---

## Self-Review (completed against the spec)

**Spec coverage (P1 sections):**
- received_events reader (fault-isolated) → Task 3. ✅
- Pure builder: verb map (no "pushed"), bot tag, event-`id` dedup, 24h window, sort, cap to `MaxRawItems`, dropped-recognized counter → Task 2. ✅
- `GET /api/activity` always-200 + degraded flag, behind session auth, no server cache → Task 5. ✅
- Contracts (P1 shape: Items/GeneratedAt/Degraded{ReceivedEvents}; kebab-case enums; no `Pushed`) → Task 1. ✅
- `useActivity` ~90s poll + last-good retention → Task 7. ✅
- Rail rewrite: Activity-only; actor+verb+PR ref; **bot toggle default-hidden, transient `useState`**; in-app `<Link>` w/ external fallback; states (cold-load skeleton, rail-mount loading via same `isLoading && !data` branch, empty-quiet, empty-bots-filtered, degraded distinct); avatar `sm`; per-row `aria-label` with Title; relative-time reuse; mock deleted → Task 8. ✅
- Single-panel P1 skeleton → Task 9. ✅
- Settings "Show activity rail" toggle + static sub-label + preference wiring → Task 10. ✅
- PAT scopes (classic `repo`, FG Events:read) — documented in PR Proof + Task 12.4 (no `RequiredScopes` change). ✅
- e2e fake via **DI-swap** (not a test route) + baseline + prod guard → Task 11. ✅
- Generic degraded note, **no `AuthInvalid`** (#312 owns the global gap) → Task 8 (single "Activity unavailable"). ✅

**Type consistency:** `ActivityItem`/`ActivityResponse`/`ActivityDegradation`/`ActivityVerb`/`ActivitySource` names match backend↔frontend; `MaxRawItems` (50, server) vs `MAX_VISIBLE` (12, client) distinct and intentional; reader returns `ReceivedEventsResult`, builder returns `ActivityBuildResult`, provider returns `ActivityResponse`.

**Known plan-time confirmations (flagged inline, fail-safe):**
- The committed-login source for the reader (Task 4.4) — confirm the real state-store member; reader degrades safely if null.
- Enum kebab-case serialization (Task 5.5) — confirm the global converter covers the new enums; the endpoint test fails red otherwise.
- `Switch`/`pane.subLabel` markup names in `InboxPane` (Task 10.2) and the `Skeleton` testid (Task 9.1) — match the file's existing conventions.
- Session-cookie un-authed client in the endpoint test (Task 5.1) — adapt to `PRismWebApplicationFactory`'s auth helper.

**Out of scope (P2, not planned here):** notifications source, Watching panel, two-stage cross-feed merge, slot reservation, ~60s TTL cache + identity-change `Reset()`, visibility-pause, actorless phrasing, persisted bot preference.
