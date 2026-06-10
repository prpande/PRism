# Activity Rail Phase 2 — notifications merge + Watching panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the second Activity source (`/notifications`) merged into the existing received_events feed via a two-stage cross-feed merge, plus the Watching panel from `/user/subscriptions`, behind a ~60s TTL cache invalidated on identity/token change.

**Architecture:** Extends the merged Phase 1 code (`PRism.Core/Activity`, `PRism.GitHub/Activity`, `PRism.Web`, frontend `ActivityRail`/`useActivity`). Contracts grow **additively** (no breaking wire changes). The merge engine — the only place two feeds combine — lives in `ActivityFeedBuilder`. The provider gains a TTL cache + non-blocking `Reset()`. The rail gains actorless verb phrasing and the Watching `<section>`.

**Tech Stack:** .NET 10 (PRism.Core pure logic / PRism.GitHub adapters / PRism.Web endpoints), React + Vite + TypeScript frontend, xUnit + FluentAssertions (backend), Vitest + Testing Library (frontend), Playwright (e2e visual parity, CI-only).

**Spec:** `docs/specs/2026-06-09-activity-rail-real-data-design.md` (Phase 2 section, lines 489–667).

**Worktree:** `D:/src/PRism-137-activity-rail-phase2`, branch `feature/137-activity-rail-phase2` (cut from `main` @ `b1fe5252`, which has Phase 1 merged). This is a **gated (B1 visual + B2 auth/PAT) issue** — do NOT merge without owner B1 visual sign-off (final task).

> **Wire-casing invariant (read before any frontend task):** PRism serializes all enums **kebab-case** via `JsonStringEnumConverter(KebabCaseJsonNamingPolicy)` (see `PRism.Web/.../JsonSerializerOptionsFactory` and the existing `ActivitySource` wire value `"received-event"`). So `ActivityVerb.ReviewRequested` goes on the wire as `"review-requested"`, `ActivityVerb.Mentioned` as `"mentioned"`, `ActivitySource.Notification` as `"notification"`. **Frontend unions, phrase maps, and tests MUST key on the kebab-case wire values, never the C# PascalCase or camelCase.** Task 10 pins this with an explicit wire-value assertion before the frontend mirrors it.

---

## Pre-flight

- [ ] **Step 0.1: Confirm worktree + branch**

Run: `git -C D:/src/PRism-137-activity-rail-phase2 rev-parse --abbrev-ref HEAD`
Expected: `feature/137-activity-rail-phase2`

- [ ] **Step 0.2: Install frontend deps (worktree has none)**

The freshly-created worktree has no `frontend/node_modules`. Subagents have previously hallucinated vitest passes against an empty `node_modules` here. Install once before any frontend task:

Run: `cd D:/src/PRism-137-activity-rail-phase2/frontend && npm ci`
Then verify: `test -e D:/src/PRism-137-activity-rail-phase2/frontend/node_modules/.bin/vitest && echo OK`
Expected: `OK`. If `npm ci` drifts `package-lock.json`, `git checkout -- package-lock.json` after.

- [ ] **Step 0.3: Green baseline build**

Run: `cd D:/src/PRism-137-activity-rail-phase2 && dotnet build PRism.Web/PRism.Web.csproj`
Expected: 0 errors, 0 warnings (`TreatWarningsAsErrors` is on — CA1305 culture, CA1515, CA2263, CA1848 are enforced as errors).

---

## File Structure

**Backend (PRism.Core/Activity):**
- Modify `ActivityContracts.cs` — grow `ActivitySource`, `ActivityVerb`, `ActivityDegradation`, `ActivityResponse`; add `WatchedRepoActivity`.
- Create `RawNotification.cs` — raw notification DTO + `NotificationsResult`, `WatchedReposResult`.
- Create `INotificationsReader.cs` (with a `since` parameter), `IWatchedReposReader.cs`.
- Create `NotificationReasonMap.cs` — `reason` → `ActivityVerb` mapping (pure, testable).
- Modify `ActivityFeedBuilder.cs` — multi-source overload: normalize notifications, within-group notification dedup, two-stage merge, slot-reserved cap **at the visible 12**, Watching computation.
- Modify `IActivityProvider.cs` — add `void Reset()`.
- Modify `ActivityProvider.cs` — inject notifications + watched readers + `TimeProvider`; TTL cache; **non-blocking** `Reset()` (generation counter); aggregate degradation.

**Backend (PRism.GitHub/Activity):**
- Create `GitHubNotificationsReader.cs`, `GitHubWatchedReposReader.cs` — fault-isolated.
- Modify `ServiceCollectionExtensions.cs` (PRism.GitHub) — register the two readers + register the configured GitHub host source if one exists.

**Backend (PRism.Web):**
- Modify `Endpoints/AuthEndpoints.cs` — call `IActivityProvider.Reset()` on every successful token-commit path: `/api/auth/replace`, `/api/auth/connect`, `/api/auth/connect/commit`.
- Modify `Program.cs` — register `TimeProvider.System`.
- Modify `TestHooks/FakeActivityProvider.cs` — add notification-sourced (actorless) items + a Watching list; implement `Reset()` no-op.
- `Endpoints/ActivityEndpoints.cs` — no behavior change; update its test.

**Frontend:**
- Modify `frontend/src/api/types.ts` — mirror grown contracts (kebab-case verb/source unions, `watching`, grown degradation).
- Modify `frontend/src/components/ActivityRail/ActivityRail.tsx` — actorless verb templates (incl. generic fallback) + null-actor aria-label guard + avatar placeholder, Watching `<section>` with aria-labels, external-routing affordance, 3-flag degraded note.
- Modify `frontend/src/components/ActivityRail/ActivityRail.module.css` — Watching section/row/idle classes.
- Modify `frontend/src/components/Inbox/InboxSkeleton.tsx` — second (Watching) rail skeleton block.

**Tests:** extend each Phase 1 test file + e2e baseline.

---

## Task 1: Grow the contracts (additive)

**Files:**
- Modify: `PRism.Core/Activity/ActivityContracts.cs`
- Test: `tests/PRism.Core.Tests/Activity/ActivityContractsTests.cs`

- [ ] **Step 1: Write failing tests for the grown shape**

```csharp
[Fact]
public void ActivitySource_has_Notification()
    => Enum.IsDefined(ActivitySource.Notification).Should().BeTrue();

[Fact]
public void ActivityVerb_has_ReviewRequested_and_Mentioned()
{
    Enum.IsDefined(ActivityVerb.ReviewRequested).Should().BeTrue();
    Enum.IsDefined(ActivityVerb.Mentioned).Should().BeTrue();
}

[Fact]
public void ActivityDegradation_carries_three_flags()
{
    var d = new ActivityDegradation(ReceivedEvents: true, Notifications: false, Watching: true);
    d.ReceivedEvents.Should().BeTrue();
    d.Notifications.Should().BeFalse();
    d.Watching.Should().BeTrue();
}

[Fact]
public void ActivityResponse_carries_watching()
{
    var w = new WatchedRepoActivity("acme/api", 3, "https://github.com/acme/api");
    var r = new ActivityResponse([], DateTimeOffset.UnixEpoch,
        new ActivityDegradation(false, false, false), [w]);
    r.Watching.Should().ContainSingle().Which.Repo.Should().Be("acme/api");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ActivityContractsTests"`
Expected: compile failure (members/record don't exist yet).

- [ ] **Step 3: Grow the contracts**

```csharp
public enum ActivitySource
{
    ReceivedEvent,   // wire: "received-event"
    Notification,    // wire: "notification"
}

public enum ActivityVerb
{
    Opened, Reopened, Closed, Merged, Reviewed, Commented, Other,
    ReviewRequested,   // wire: "review-requested"; notification reason "review_requested" (actorless)
    Mentioned,         // wire: "mentioned"; notification reason "mention"/"team_mention" (actorless)
}

public sealed record ActivityDegradation(bool ReceivedEvents, bool Notifications, bool Watching);

public sealed record WatchedRepoActivity(string Repo, int Count, string Url);

public sealed record ActivityResponse(
    IReadOnlyList<ActivityItem> Items,
    System.DateTimeOffset GeneratedAt,
    ActivityDegradation Degraded,
    IReadOnlyList<WatchedRepoActivity> Watching);
```

> Growing `ActivityDegradation` 1→3 params and `ActivityResponse` 3→4 is a breaking *source* change inside this assembly. Expect compile errors at the P1 construction sites in `ActivityProvider.cs`, `FakeActivityProvider.cs`, and existing test builders — fixed in their owning tasks (7, 9) and the affected test files. Also update any existing contract-test constructions in this file to the new arity so this task is green in isolation.

- [ ] **Step 4: Verify pass** — same filter → PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Activity/ActivityContracts.cs tests/PRism.Core.Tests/Activity/ActivityContractsTests.cs
git commit -m "feat(#137): grow activity contracts for P2 (Notification source, actorless verbs, Watching, 3-flag degradation)"
```

---

## Task 2: Notification reason→verb map (pure)

**Files:**
- Create: `PRism.Core/Activity/NotificationReasonMap.cs`
- Test: `tests/PRism.Core.Tests/Activity/NotificationReasonMapTests.cs`

- [ ] **Step 1: Write failing test**

```csharp
using PRism.Core.Activity;

public class NotificationReasonMapTests
{
    [Theory]
    [InlineData("review_requested", ActivityVerb.ReviewRequested)]
    [InlineData("mention", ActivityVerb.Mentioned)]
    [InlineData("team_mention", ActivityVerb.Mentioned)]
    [InlineData("comment", ActivityVerb.Commented)]
    [InlineData("subscribed", ActivityVerb.Other)]
    [InlineData("state_change", ActivityVerb.Other)]
    [InlineData("ci_activity", ActivityVerb.Other)]
    [InlineData("", ActivityVerb.Other)]
    [InlineData("totally-unknown", ActivityVerb.Other)]
    public void Maps_reason_to_verb(string reason, ActivityVerb expected)
        => NotificationReasonMap.ToVerb(reason).Should().Be(expected);

    [Theory]
    [InlineData(ActivityVerb.ReviewRequested, true)]
    [InlineData(ActivityVerb.Mentioned, true)]
    [InlineData(ActivityVerb.Commented, false)]
    [InlineData(ActivityVerb.Other, false)]
    public void Flags_you_relevant_verbs(ActivityVerb v, bool expected)
        => NotificationReasonMap.IsYouRelevant(v).Should().Be(expected);
}
```

- [ ] **Step 2: Run to verify failure** — compile failure.

- [ ] **Step 3: Implement**

```csharp
namespace PRism.Core.Activity;

// reason → ActivityVerb. you-relevant reasons (review_requested/mention) map to verbs the
// event side NEVER produces, so a you-relevant notification is always alone in its
// (Repo,Pr,Verb) group and renders as its own actorless row by design (see ActivityFeedBuilder
// Stage B rationale). `comment` maps to Commented (a shared verb) so a non-you-relevant comment
// notification collapses with a comment event. state_change is deliberately NOT disambiguated to
// Opened/Closed/Merged — a notification can't tell which, and a wrong-verb merge is worse than a
// separate "updated" row — so it falls to Other. subscribed/unknown → Other.
public static class NotificationReasonMap
{
    public static ActivityVerb ToVerb(string? reason) => reason switch
    {
        "review_requested" => ActivityVerb.ReviewRequested,
        "mention" or "team_mention" => ActivityVerb.Mentioned,
        "comment" => ActivityVerb.Commented,
        _ => ActivityVerb.Other,
    };

    public static bool IsYouRelevant(ActivityVerb verb)
        => verb is ActivityVerb.ReviewRequested or ActivityVerb.Mentioned;
}
```

- [ ] **Step 4: Verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Activity/NotificationReasonMap.cs tests/PRism.Core.Tests/Activity/NotificationReasonMapTests.cs
git commit -m "feat(#137): notification reason->verb map (you-relevant verbs, safe Other fallback)"
```

---

## Task 3: Reader interfaces + raw notification type

**Files:**
- Create: `PRism.Core/Activity/RawNotification.cs`
- Create: `PRism.Core/Activity/INotificationsReader.cs`
- Create: `PRism.Core/Activity/IWatchedReposReader.cs`
- Test: `tests/PRism.Core.Tests/Activity/RawNotificationTests.cs`

- [ ] **Step 1: Write failing test (shape only)**

```csharp
using PRism.Core.Activity;

public class RawNotificationTests
{
    [Fact]
    public void RawNotification_carries_pr_fields()
    {
        var n = new RawNotification("acme/api", "review_requested", 1842, "PR #1842",
            "https://api.github.com/repos/acme/api/pulls/1842", DateTimeOffset.UnixEpoch);
        n.Repo.Should().Be("acme/api");
        n.Reason.Should().Be("review_requested");
        n.PrNumber.Should().Be(1842);
    }

    [Fact]
    public void NotificationsResult_carries_degraded()
        => new NotificationsResult([], Degraded: true).Degraded.Should().BeTrue();

    [Fact]
    public void WatchedReposResult_carries_degraded()
        => new WatchedReposResult([], Degraded: true).Degraded.Should().BeTrue();
}
```

- [ ] **Step 2: Run to verify failure** — compile failure.

- [ ] **Step 3: Implement**

`RawNotification.cs`:

```csharp
using System;
using System.Collections.Generic;

namespace PRism.Core.Activity;

public sealed record RawNotification(
    string Repo, string Reason, int PrNumber, string? Title,
    string Url,                      // subject.url (API) — builder rewrites to the html PR url
    DateTimeOffset Timestamp);

public readonly record struct NotificationsResult(
    IReadOnlyList<RawNotification> Notifications, bool Degraded);

public readonly record struct WatchedReposResult(
    IReadOnlyList<string> Repos, bool Degraded);  // full names "owner/repo"
```

`INotificationsReader.cs` — **keeps the spec's `since` parameter** (matches `ReadAsync(since, ct)` in spec §496; the builder also window-filters, but passing `since` shrinks the payload and matches the contract):

```csharp
using System;
using System.Threading;
using System.Threading.Tasks;

namespace PRism.Core.Activity;

// Fault-isolated: NEVER throws on transport/429/403/5xx — returns empty + Degraded.
public interface INotificationsReader
{
    Task<NotificationsResult> ReadAsync(DateTimeOffset since, CancellationToken ct);
}
```

`IWatchedReposReader.cs`:

```csharp
using System.Threading;
using System.Threading.Tasks;

namespace PRism.Core.Activity;

// Fault-isolated: NEVER throws — returns empty + Degraded.
public interface IWatchedReposReader
{
    Task<WatchedReposResult> ReadAsync(CancellationToken ct);
}
```

- [ ] **Step 4: Verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Activity/RawNotification.cs PRism.Core/Activity/INotificationsReader.cs PRism.Core/Activity/IWatchedReposReader.cs tests/PRism.Core.Tests/Activity/RawNotificationTests.cs
git commit -m "feat(#137): notification + watched-repos reader interfaces (since param) and raw types"
```

> **Owner decision (resolved 2026-06-10):** use `all=true&since={24h}` — recent activity regardless of GitHub read-state (decoupled from github.com reads; more complete, noisier). The volume this surfaces is what #315's group-by-repo/scroll is for.

---

## Task 4: GitHubNotificationsReader

**Files:**
- Create: `PRism.GitHub/Activity/GitHubNotificationsReader.cs`
- Test: `tests/PRism.GitHub.Tests/Activity/GitHubNotificationsReaderTests.cs`

Mirror `GitHubReceivedEventsReader` (ctor: `IHttpClientFactory` + `Func<Task<string?>> readToken`; no login — `/notifications` is the authed user's). Endpoint: `GET notifications?all=true&since={since:O}&per_page=100` (owner chose `all=true` — recent activity regardless of read-state). Parse each: `repository.full_name`, `reason`, `subject.type` (keep only `"PullRequest"`), `subject.url` → trailing `/pulls/{n}` for `PrNumber` (drop if none), `subject.title`, `updated_at`.

- [ ] **Step 1: Write failing tests (mocked HttpClient)** — copy the `MakeReader` mock-handler helper from `GitHubReceivedEventsReaderTests`. Cover:
  - Parses a PullRequest-subject notification (reason, repo, prNumber from subject.url, title, updated_at).
  - Drops non-PullRequest subjects (`"subject":{"type":"Issue"}`).
  - Drops PullRequest subjects with no `/pulls/{n}` in `subject.url`.
  - 403 → `([], Degraded:true)`; 429 → `([], Degraded:true)`; malformed JSON → `([], Degraded:true)`.
  - Genuine cancellation propagates (`OperationCanceledException` when `ct.IsCancellationRequested`).
  - The request URL carries the `since` query param (assert on the captured `HttpRequestMessage.RequestUri`).

```csharp
[Fact]
public async Task Parses_pr_notification()
{
    const string json = """
    [{"reason":"review_requested","updated_at":"2026-06-10T10:00:00Z",
      "repository":{"full_name":"acme/api"},
      "subject":{"type":"PullRequest","title":"Fix it",
                 "url":"https://api.github.com/repos/acme/api/pulls/1842"}}]
    """;
    var reader = MakeReader(HttpStatusCode.OK, json);
    var result = await reader.ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None);
    result.Degraded.Should().BeFalse();
    var n = result.Notifications.Should().ContainSingle().Subject;
    n.Repo.Should().Be("acme/api"); n.Reason.Should().Be("review_requested"); n.PrNumber.Should().Be(1842);
}

[Fact]
public async Task Drops_non_pullrequest_subjects()
{
    const string json = """
    [{"reason":"subscribed","updated_at":"2026-06-10T10:00:00Z",
      "repository":{"full_name":"acme/api"},
      "subject":{"type":"Issue","title":"x","url":"https://api.github.com/repos/acme/api/issues/5"}}]
    """;
    var result = await MakeReader(HttpStatusCode.OK, json).ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None);
    result.Notifications.Should().BeEmpty(); result.Degraded.Should().BeFalse();
}

[Theory]
[InlineData(HttpStatusCode.Forbidden)]
[InlineData((HttpStatusCode)429)]
public async Task Faults_degrade(HttpStatusCode code)
    => (await MakeReader(code, "").ReadAsync(DateTimeOffset.UnixEpoch, CancellationToken.None)).Degraded.Should().BeTrue();
```

- [ ] **Step 2: Run to verify failure** — compile/assert failure.

- [ ] **Step 3: Implement** — model on `GitHubReceivedEventsReader.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.GitHub.Activity;

public sealed partial class GitHubNotificationsReader : INotificationsReader
{
    private const int PerPage = 100;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;

    public GitHubNotificationsReader(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    { _httpFactory = httpFactory; _readToken = readToken; }

    public async Task<NotificationsResult> ReadAsync(DateTimeOffset since, CancellationToken ct)
    {
        try
        {
            var token = await _readToken().ConfigureAwait(false);
            using var http = _httpFactory.CreateClient("github");
            var sinceParam = Uri.EscapeDataString(since.UtcDateTime.ToString("O", CultureInfo.InvariantCulture));
            using var req = new HttpRequestMessage(HttpMethod.Get,
                $"notifications?all=true&since={sinceParam}&per_page={PerPage}");
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.UserAgent.ParseAdd("PRism/0.1");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");

            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return new NotificationsResult([], Degraded: true);

            using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return new NotificationsResult([], Degraded: true);

            var list = new List<RawNotification>(doc.RootElement.GetArrayLength());
            foreach (var el in doc.RootElement.EnumerateArray())
                if (Parse(el) is { } n) list.Add(n);
            return new NotificationsResult(list, Degraded: false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        { return new NotificationsResult([], Degraded: true); }
    }

    private static RawNotification? Parse(JsonElement el)
    {
        if (!el.TryGetProperty("subject", out var subject)) return null;
        if (!subject.TryGetProperty("type", out var type) || type.GetString() != "PullRequest") return null;
        if (!subject.TryGetProperty("url", out var urlEl)) return null;
        var apiUrl = urlEl.GetString();
        if (string.IsNullOrEmpty(apiUrl)) return null;
        var m = PullsUrl().Match(apiUrl);
        if (!m.Success) return null;
        var pr = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);

        var repo = el.TryGetProperty("repository", out var r) && r.TryGetProperty("full_name", out var fn)
            ? fn.GetString() : null;
        if (string.IsNullOrEmpty(repo)) return null;

        var reason = el.TryGetProperty("reason", out var re) ? re.GetString() ?? "" : "";
        var title = subject.TryGetProperty("title", out var t) ? t.GetString() : null;
        var ts = el.TryGetProperty("updated_at", out var u) && u.TryGetDateTimeOffset(out var dto)
            ? dto : DateTimeOffset.MinValue;
        return new RawNotification(repo, reason, pr, title, apiUrl, ts);
    }

    [GeneratedRegex(@"/pulls/(\d+)$")]
    private static partial Regex PullsUrl();
}
```

- [ ] **Step 4: Verify pass** — `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubNotificationsReaderTests"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/Activity/GitHubNotificationsReader.cs tests/PRism.GitHub.Tests/Activity/GitHubNotificationsReaderTests.cs
git commit -m "feat(#137): GitHubNotificationsReader (PR-subject only, since-bounded, fault-isolated)"
```

---

## Task 5: GitHubWatchedReposReader

**Files:**
- Create: `PRism.GitHub/Activity/GitHubWatchedReposReader.cs`
- Test: `tests/PRism.GitHub.Tests/Activity/GitHubWatchedReposReaderTests.cs`

Endpoint: `GET user/subscriptions?per_page=100`. Return each element's `full_name`. Fault-isolated.

- [ ] **Step 1: Write failing tests** — parses `full_name`s; 403/429/malformed → `([], Degraded:true)`; cancellation propagates.

```csharp
[Fact]
public async Task Parses_full_names()
{
    const string json = """[{"full_name":"acme/api"},{"full_name":"acme/pos"}]""";
    var result = await MakeReader(HttpStatusCode.OK, json).ReadAsync(CancellationToken.None);
    result.Degraded.Should().BeFalse();
    result.Repos.Should().Equal("acme/api", "acme/pos");
}
```

- [ ] **Step 2: Run to verify failure** — compile/assert failure.

- [ ] **Step 3: Implement**

```csharp
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.GitHub.Activity;

public sealed class GitHubWatchedReposReader : IWatchedReposReader
{
    private const int PerPage = 100;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;

    public GitHubWatchedReposReader(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    { _httpFactory = httpFactory; _readToken = readToken; }

    public async Task<WatchedReposResult> ReadAsync(CancellationToken ct)
    {
        try
        {
            var token = await _readToken().ConfigureAwait(false);
            using var http = _httpFactory.CreateClient("github");
            using var req = new HttpRequestMessage(HttpMethod.Get, $"user/subscriptions?per_page={PerPage}");
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.UserAgent.ParseAdd("PRism/0.1");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");

            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return new WatchedReposResult([], Degraded: true);

            using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return new WatchedReposResult([], Degraded: true);

            var list = new List<string>(doc.RootElement.GetArrayLength());
            foreach (var el in doc.RootElement.EnumerateArray())
                if (el.TryGetProperty("full_name", out var fn) && fn.GetString() is { Length: > 0 } name)
                    list.Add(name);
            return new WatchedReposResult(list, Degraded: false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        { return new WatchedReposResult([], Degraded: true); }
    }
}
```

- [ ] **Step 4: Verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/Activity/GitHubWatchedReposReader.cs tests/PRism.GitHub.Tests/Activity/GitHubWatchedReposReaderTests.cs
git commit -m "feat(#137): GitHubWatchedReposReader (fault-isolated)"
```

---

## Task 6: ActivityFeedBuilder — full multi-source merge, dedup, slot-reserved cap, Watching

> **This is the merge engine — the crux of Phase 2.** It is a single logical unit (one file, one test file); do not split it across commits with a broken intermediate. Land it whole.

**Files:**
- Modify: `PRism.Core/Activity/ActivityFeedBuilder.cs`
- Test: `tests/PRism.Core.Tests/Activity/ActivityFeedBuilderTests.cs`

Keep the P1 single-source `Build(events, now)` as a thin delegate to the new overload (empty notifications/watched, default host) so Phase 1 tests stay green.

New signature:

```csharp
public static ActivityBuildResult Build(
    IReadOnlyList<RawReceivedEvent> events,
    IReadOnlyList<RawNotification> notifications,
    IReadOnlyList<string> watchedRepos,
    string host,                 // GitHub host for constructed URLs (Watching, notification rewrite)
    DateTimeOffset now)
```

`ActivityBuildResult` grows to carry `IReadOnlyList<WatchedRepoActivity> Watching` (keeps `Items`, `DroppedRecognized`).

**Constants:** `MaxActivityItems = 12` (the **visible** cap), `MaxRawItems = 50` (server ceiling / client bot-filter headroom), `MinEventSlots = 4`, `MaxWatchingRows = 8`.

**Pipeline:**
1. **Events** — window-filter + map → `ActivityItem` (`Source = ReceivedEvent`), event-`id` dedup (existing P1 logic). Events with null/empty `HtmlUrl`, null `ActorLogin`, or null `PrNumber` are dropped (existing P1 guard — fixtures MUST set these).
2. **Notifications** — window-filter + normalize → `ActivityItem` (`Source = Notification`, `ActorLogin = null`, `Verb = NotificationReasonMap.ToVerb(reason)`, `Url = $"https://{host}/{repo}/pull/{pr}"`, `Title`, `Timestamp = updated_at`).
3. **Two-stage cross-feed merge** keyed on `(Repo, PrNumber, Verb)`:
   - **Stage A — group** all items by that key.
   - **Stage B — within each group:**
     - All event items survive (distinct actors are never collapsed — the actor detail is the payoff).
     - **Notifications within a group are first deduped to the most-recent one** (GitHub re-emits the same `(repo, reason, PR)`; without this, two `comment` notifications on one PR render as two identical actorless rows).
     - The deduped notification: if **you-relevant** (`ReviewRequested`/`Mentioned`) → it stays its **own actorless row**. (By construction this is *always* the case for you-relevant notifications: their verbs have no event counterpart, so they are alone in their group. This is correct and intended — "you were asked to review" is actor-independent and must not be welded onto whichever actor happened to act; see `NotificationReasonMap`.) If **not you-relevant** and the group already has ≥1 event → **drop the notification** (it folds into the most-recent matching event, no new row). If not you-relevant and the group has 0 events → keep it as the (single, deduped) actorless row.
4. **Sort** merged desc by `Timestamp`.
5. **Slot-reserved ordering for the VISIBLE cap (`MaxActivityItems` = 12).** The client takes the first `MaxActivityItems` of the server's order (after bot-filter) **without re-sorting** — so the reservation must be baked into the server's ordering, not applied against the 50-item ceiling (reserving against 50 is a no-op: a fresh-notification flood still fills the visible top-12 and starves events). Build the ordered list so the first `MaxActivityItems` positions contain **at least `MinEventSlots` (4) event items when that many exist**: take the top `MaxActivityItems - MinEventSlots` (8) items by timestamp, then ensure the next slots up to 12 include the most-recent events not already chosen (promote events ahead of notifications to fill the reserved 4), then append the remainder by timestamp up to `MaxRawItems`. Document that the client must preserve server order (it already does: `slice(0, MAX_VISIBLE)` with no re-sort).
6. **Watching.** `Count` = windowed merged items (the full pre-cap merged set) whose `Repo` matches (count is computed BEFORE the cap so a repo above the 12-cap never shows `idle`). Sort `Count` desc then name; `Count>0` first, pad with `idle` watched repos up to `MaxWatchingRows`; `Url = $"https://{host}/{repo}"`.

- [ ] **Step 1: Write failing tests**

Fixture helpers MUST set the fields the P1 guard requires (`HtmlUrl`, `ActorLogin`, `PrNumber`; `IsPullRequestComment=true` for `IssueCommentEvent`) — mirror the existing `ActivityProviderTests.Review()` helper, which passes a real `HtmlUrl`. Otherwise every event is silently dropped and merge assertions fail against an empty feed (a fixture bug masquerading as a merge bug):

```csharp
private const string Host = "github.com";
// NOTE: HtmlUrl is REQUIRED — builder drops events with null/empty HtmlUrl.
private static RawReceivedEvent Ev(string id, string actor, string type, string action,
    string repo, int pr, DateTimeOffset ts, bool merged = false) =>
    new(/* Id */ id, /* Type */ type, /* Action */ action, /* ActorLogin */ actor,
        /* ActorAvatarUrl */ $"https://avatars/{actor}", /* Repo */ repo, /* PrNumber */ pr,
        /* Title */ $"PR #{pr}", /* HtmlUrl */ $"https://github.com/{repo}/pull/{pr}",
        /* Merged */ merged, /* IsPullRequestComment */ type == "IssueCommentEvent",
        /* Timestamp */ ts);
// ^ confirm the exact RawReceivedEvent positional order against the real record before coding.
private static RawNotification Nf(string reason, string repo, int pr, DateTimeOffset ts) =>
    new(repo, reason, pr, $"PR #{pr}", $"https://api.github.com/repos/{repo}/pulls/{pr}", ts);

private static ActivityBuildResult Build(RawReceivedEvent[] ev, RawNotification[] nf, string[] watched, DateTimeOffset now)
    => ActivityFeedBuilder.Build(ev, nf, watched, Host, now);

[Fact] // non-you-relevant duplicate notification folds into matching event, keeping actor
public void Comment_notification_merges_into_matching_event_keeping_actor()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var ev = Ev("1", "noah.s", "PullRequestReviewCommentEvent", "", "acme/api", 10, now.AddMinutes(-5));
    var nf = Nf("comment", "acme/api", 10, now.AddMinutes(-4));        // → Commented, matches verb
    var item = Build([ev], [nf], [], now).Items.Should().ContainSingle().Subject;
    item.ActorLogin.Should().Be("noah.s");
    item.Source.Should().Be(ActivitySource.ReceivedEvent);
}

[Fact] public void Distinct_actors_same_pr_verb_stay_separate()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var a = Ev("1", "noah.s", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-5));
    var b = Ev("2", "jules.t", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-6));
    Build([a, b], [], [], now).Items.Should().HaveCount(2);
}

[Fact] // GENUINE 3-way: comment notification + two distinct comment actors, SAME (Repo,Pr,Commented) group
public void Three_way_comment_notification_merges_into_most_recent_event()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var older = Ev("1", "noah.s", "PullRequestReviewCommentEvent", "", "acme/api", 10, now.AddMinutes(-9));
    var newer = Ev("2", "jules.t", "PullRequestReviewCommentEvent", "", "acme/api", 10, now.AddMinutes(-5));
    var nf = Nf("comment", "acme/api", 10, now.AddMinutes(-4));        // Commented, same group as both events
    var r = Build([older, newer], [nf], [], now);
    r.Items.Should().HaveCount(2);                                     // notif folds in, both actors survive
    r.Items.Select(i => i.ActorLogin).Should().BeEquivalentTo(["noah.s", "jules.t"]);
}

[Fact] // you-relevant notification is always its own actorless row (verb has no event counterpart)
public void Review_requested_notification_stays_actorless_row()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var ev = Ev("1", "noah.s", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-5));
    var nf = Nf("review_requested", "acme/api", 10, now.AddMinutes(-4));
    var r = Build([ev], [nf], [], now);
    r.Items.Should().HaveCount(2);                                     // separate verbs → separate rows
    r.Items.Should().ContainSingle(i => i.Verb == ActivityVerb.ReviewRequested && i.ActorLogin == null);
}

[Fact] // DUPLICATE NOTIFICATIONS collapse (GitHub re-emits same repo/reason/PR)
public void Duplicate_notifications_same_key_collapse_to_one()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var n1 = Nf("comment", "acme/api", 10, now.AddMinutes(-6));
    var n2 = Nf("comment", "acme/api", 10, now.AddMinutes(-4));        // same (Repo,Pr,Commented), no events
    Build([], [n1, n2], [], now).Items.Should().ContainSingle();
}

[Fact] // subscribed→Other never merges with a concrete-verb event for the same PR
public void Subscribed_notification_does_not_merge_with_closed_event()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var ev = Ev("1", "noah.s", "PullRequestEvent", "closed", "acme/api", 10, now.AddMinutes(-5));
    var nf = Nf("subscribed", "acme/api", 10, now.AddMinutes(-4));     // → Other (different verb)
    Build([ev], [nf], [], now).Items.Should().HaveCount(2);
}

[Fact] // SLOT RESERVATION at the visible 12 with notifications NEWER than events (the flood)
public void Slot_reservation_keeps_min_event_rows_in_visible_window()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var events = Enumerable.Range(1, 5)                                // events are OLDER
        .Select(i => Ev(i.ToString(), $"u{i}", "PullRequestReviewEvent", "", "acme/api", i, now.AddMinutes(-30 - i)))
        .ToList();
    var notifs = Enumerable.Range(100, 40)                             // fresh flood, you-relevant so no merge
        .Select(i => Nf("review_requested", "acme/api", i, now.AddMinutes(-1)))
        .ToList();
    var r = Build([.. events], [.. notifs], [], now);
    r.Items.Take(ActivityFeedBuilder.MaxActivityItems)
        .Count(i => i.Source == ActivitySource.ReceivedEvent)
        .Should().BeGreaterThanOrEqualTo(ActivityFeedBuilder.MinEventSlots);  // >=4 events in the visible 12
}

[Fact] public void Watching_count_pre_cap_orders_by_count_then_name_with_idle_padding()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var events = new[]
    {
        Ev("1","a","PullRequestReviewEvent","","acme/api",1, now.AddMinutes(-1)),
        Ev("2","b","PullRequestReviewEvent","","acme/api",2, now.AddMinutes(-2)),
        Ev("3","c","PullRequestReviewEvent","","acme/pos",3, now.AddMinutes(-3)),
    };
    var r = Build(events, [], ["acme/api","acme/pos","acme/idle"], now);
    r.Watching.Select(w => w.Repo).Should().Equal("acme/api", "acme/pos", "acme/idle");
    r.Watching.Single(w => w.Repo == "acme/api").Count.Should().Be(2);
    r.Watching.Single(w => w.Repo == "acme/idle").Count.Should().Be(0);
    r.Watching.Single(w => w.Repo == "acme/api").Url.Should().Be("https://github.com/acme/api");
}

[Fact] // notification-only repo still shows Count>0 (not idle)
public void Watching_counts_notification_only_repo()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var nf = Nf("comment", "acme/api", 10, now.AddMinutes(-3));        // no events
    Build([], [nf], ["acme/api"], now).Watching.Single().Count.Should().Be(1);
}

[Fact] public void Watching_pads_to_max_rows_cap()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var watched = Enumerable.Range(1, 20).Select(i => $"acme/r{i}").ToList();
    Build([], [], [.. watched], now).Watching.Should().HaveCount(8);  // MaxWatchingRows
}

[Fact] public void Notifications_outside_window_filtered()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var stale = Nf("comment", "acme/api", 10, now.AddHours(-30));
    Build([], [stale], [], now).Items.Should().BeEmpty();
}
```

- [ ] **Step 2: Run to verify failure** — `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ActivityFeedBuilderTests"` → fails.

- [ ] **Step 3: Implement** — the multi-source build per the pipeline above. Merge sketch:

```csharp
static (string, int, ActivityVerb) Key(ActivityItem i) => (i.Repo, i.PrNumber, i.Verb);
var merged = new List<ActivityItem>();
foreach (var g in eventItems.Concat(notifItems).GroupBy(Key))
{
    var evs = g.Where(i => i.Source == ActivitySource.ReceivedEvent).ToList();
    merged.AddRange(evs);                                  // distinct actors all survive
    var nf = g.Where(i => i.Source == ActivitySource.Notification)
             .OrderByDescending(i => i.Timestamp).FirstOrDefault();   // collapse re-emits → most recent
    if (nf is null) continue;
    if (NotificationReasonMap.IsYouRelevant(nf.Verb)) { merged.Add(nf); continue; }  // own actorless row
    if (evs.Count == 0) merged.Add(nf);                   // no event to fold into
    // else: non-you-relevant duplicate folds into the most-recent matching event (drop, no new row)
}
var sorted = merged.OrderByDescending(i => i.Timestamp).ToList();
// slot-reserved visible ordering (see pipeline step 5), then Take(MaxRawItems)
// Watching from `merged` (pre-cap) per pipeline step 6
```

Pin the slot-reservation as its own small helper with the test above as the oracle.

- [ ] **Step 4: Verify pass** — full builder test class PASS (and P1 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Activity/ActivityFeedBuilder.cs tests/PRism.Core.Tests/Activity/ActivityFeedBuilderTests.cs
git commit -m "feat(#137): builder multi-source merge + notif dedup + visible-window slot reservation + Watching"
```

---

## Task 7: ActivityProvider — multi-source, TTL cache, non-blocking Reset()

**Files:**
- Modify: `PRism.Core/Activity/IActivityProvider.cs` (add `void Reset();`)
- Modify: `PRism.Core/Activity/ActivityProvider.cs`
- Add package: `Directory.Packages.props` + `tests/PRism.Core.Tests/PRism.Core.Tests.csproj`
- Test: `tests/PRism.Core.Tests/Activity/ActivityProviderTests.cs`

- [ ] **Step 0: Add the FakeTimeProvider test package** (central package management — both edits required, or Task 7 tests won't compile):
  - `Directory.Packages.props`: add `<PackageVersion Include="Microsoft.Extensions.Time.Testing" Version="10.0.0" />` (match the existing `Microsoft.Extensions.*` 10.0.0 line).
  - `tests/PRism.Core.Tests/PRism.Core.Tests.csproj`: add `<PackageReference Include="Microsoft.Extensions.Time.Testing" />` (versionless, per CPM).
  - Verify: `dotnet restore` succeeds.

Inject the three readers + `TimeProvider` (prod registers `TimeProvider.System`). Cache = an instance field `(ActivityResponse Response, DateTimeOffset At)?` guarded by a `SemaphoreSlim` for the *fetch*. **`Reset()` must be non-blocking** (it is called from the auth/replace request thread and must never wait on an in-flight 3-call GitHub fetch): use a generation counter. `Reset()` increments the generation and nulls the cache field **without taking the fetch gate**; `GetActivityAsync` captures the generation before fetching and discards its result (does not cache it) if the generation moved while it was fetching — so a token rotation mid-fetch is never cached.

Host for the builder: read the configured GitHub host the app already uses (search for where `htmlUrl`/host is sourced — e.g. an options/config value; default `"github.com"` if none). Pass it into `ActivityFeedBuilder.Build`.

- [ ] **Step 1: Write failing tests** (seed `FakeTimeProvider` explicitly in **every** test — an unseeded fake starts at an arbitrary epoch and will window-filter real-timestamp fixtures unpredictably):

```csharp
[Fact]
public async Task Caches_within_ttl_then_refetches_after()
{
    var clock = new FakeTimeProvider(DateTimeOffset.UnixEpoch.AddYears(56)); // ~2026, matches fixtures
    var ev = new CountingReceivedEventsReader();
    var p = new ActivityProvider(ev, new EmptyNotifReader(), new EmptyWatchReader(), clock, Host(), NullLogger<ActivityProvider>.Instance);
    await p.GetActivityAsync(default); await p.GetActivityAsync(default);
    ev.Calls.Should().Be(1);                                   // 2nd served from cache
    clock.Advance(TimeSpan.FromSeconds(61));
    await p.GetActivityAsync(default);
    ev.Calls.Should().Be(2);                                   // TTL expired → refetch
}

[Fact]
public async Task Reset_forces_refetch()
{
    var clock = new FakeTimeProvider(DateTimeOffset.UnixEpoch.AddYears(56));
    var ev = new CountingReceivedEventsReader();
    var p = new ActivityProvider(ev, new EmptyNotifReader(), new EmptyWatchReader(), clock, Host(), NullLogger<ActivityProvider>.Instance);
    await p.GetActivityAsync(default); p.Reset(); await p.GetActivityAsync(default);
    ev.Calls.Should().Be(2);
}

[Fact]
public async Task Reset_during_inflight_fetch_discards_that_result()
{
    // a gated reader that blocks until released; call Reset() while the first GetActivityAsync
    // is awaiting; assert the next call refetches (the in-flight result was not cached).
}

[Fact]
public async Task Aggregates_degradation_from_three_sources()
{
    var clock = new FakeTimeProvider(DateTimeOffset.UnixEpoch.AddYears(56));
    var p = new ActivityProvider(new DegradedReceivedEventsReader(), new DegradedNotifReader(), new DegradedWatchReader(), clock, Host(), NullLogger<ActivityProvider>.Instance);
    (await p.GetActivityAsync(default)).Degraded.Should().Be(new ActivityDegradation(true, true, true));
}
```

Also **update the two existing P1 `ActivityProviderTests` constructions** (`new ActivityProvider(reader, NullLogger...)`) to the new 6-arg ctor (pass `EmptyNotifReader`/`EmptyWatchReader`/seeded `FakeTimeProvider`/host). Add the small fake readers (`Counting*`, `Empty*`, `Degraded*`) and `since`-aware notif fakes as nested classes.

- [ ] **Step 2: Run to verify failure** — compile/assert failure.

- [ ] **Step 3: Implement**

```csharp
public sealed partial class ActivityProvider : IActivityProvider, IDisposable
{
    private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(60);
    private readonly IReceivedEventsReader _events;
    private readonly INotificationsReader _notifs;
    private readonly IWatchedReposReader _watched;
    private readonly TimeProvider _clock;
    private readonly string _host;
    private readonly ILogger<ActivityProvider> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private (ActivityResponse Response, DateTimeOffset At)? _cache;
    private int _generation;

    public ActivityProvider(IReceivedEventsReader events, INotificationsReader notifs,
        IWatchedReposReader watched, TimeProvider clock, string host, ILogger<ActivityProvider> log)
    { _events = events; _notifs = notifs; _watched = watched; _clock = clock; _host = host; _log = log; }

    public async Task<ActivityResponse> GetActivityAsync(CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_cache is { } c && now - c.At < Ttl) return c.Response;
            var gen = Volatile.Read(ref _generation);

            var evT = _events.ReadAsync(ct);
            var nfT = _notifs.ReadAsync(now.AddHours(-24), ct);
            var wtT = _watched.ReadAsync(ct);
            await Task.WhenAll(evT, nfT, wtT).ConfigureAwait(false);
            var ev = evT.Result; var nf = nfT.Result; var wt = wtT.Result;

            var built = ActivityFeedBuilder.Build(ev.Events, nf.Notifications, wt.Repos, _host, now);
            if (built.DroppedRecognized > 0) Log.DroppedRecognized(_log, built.DroppedRecognized);

            var resp = new ActivityResponse(built.Items, now,
                new ActivityDegradation(ev.Degraded, nf.Degraded, wt.Degraded), built.Watching);

            if (Volatile.Read(ref _generation) == gen) _cache = (resp, now);  // discard if reset mid-fetch
            return resp;
        }
        finally { _gate.Release(); }
    }

    // Non-blocking: never waits on an in-flight fetch (called on the auth/replace request thread).
    public void Reset()
    {
        Interlocked.Increment(ref _generation);
        _cache = null;
    }

    public void Dispose() => _gate.Dispose();
}
```

> The `_cache = null` write in `Reset()` races benignly with the gated writer; the generation check makes the race safe (a fetch that started before the reset will not overwrite the cleared cache). A torn read of the nullable tuple is avoided because reference assignment of the boxed nullable is atomic on the CLR; if static analysis objects, make `_cache` a `volatile` reference to a small `CacheEntry` class.

- [ ] **Step 4: Verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add Directory.Packages.props tests/PRism.Core.Tests/PRism.Core.Tests.csproj PRism.Core/Activity/IActivityProvider.cs PRism.Core/Activity/ActivityProvider.cs tests/PRism.Core.Tests/Activity/ActivityProviderTests.cs
git commit -m "feat(#137): ActivityProvider multi-source + 60s TTL cache + non-blocking generation Reset()"
```

---

## Task 8: DI registration + cache invalidation on ALL token-commit paths

**Files:**
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` — register `INotificationsReader`/`IWatchedReposReader` (mirror the received-events reader registration: same `IHttpClientFactory` + `readToken` Func; drop `readLogin` — these endpoints are self-scoped).
- Modify: `PRism.Web/Program.cs` — register `builder.Services.AddSingleton(TimeProvider.System)` (not currently registered; the singleton `ActivityProvider` ctor won't resolve without it — the app won't start otherwise) and supply the configured GitHub host to the provider.
- Modify: `PRism.Web/Endpoints/AuthEndpoints.cs` — inject `IActivityProvider`; call `Reset()` on **every** successful token-commit path.
- Test: `tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs`.

**Which paths reset, and why every path (not just identityChanged):** the cache holds private-repo feed data gated by the *current* token's scope. Three handlers commit a token and must invalidate it:
- `/api/auth/replace` — including the **same-login token rotation** case (`identityChanged == false`), which the existing reset block at `AuthEndpoints.cs:364-367` does NOT cover. Place the `Reset()` call **outside** the `if (identityChanged)` block, immediately before the success `return Results.Ok(...)`, so it fires on every successful replace regardless of login change.
- `/api/auth/connect` (`AuthEndpoints.cs:~88`, after `tokens.CommitAsync`).
- `/api/auth/connect/commit` (`AuthEndpoints.cs:~102`, after `tokens.CommitAsync`).

`/api/auth/connect` is the first-real-session path after a token-clear, so omitting it leaks a prior token's cached feed on the very next session once Task 7's cache lands. (In P1 the provider has no cache, so the call is a harmless no-op until Task 7 makes it load-bearing.)

**Why imperative Reset() and NOT bus-subscribe (spec's deferred decision §566-570):** the `IdentityChanged` bus message is published *only inside the `identityChanged` branch*. Subscribing `ActivityProvider` to it would reproduce exactly the same-login-rotation gap we're closing. An unconditional imperative `Reset()` at each commit site covers all branches; subscription does not. Recorded here per the spec's request to weigh the tradeoff.

- [ ] **Step 1: Write failing test** — drive `/api/auth/replace` with the **same** login + a new token; assert the cache was invalidated (inject a spy `IActivityProvider` counting `Reset()` calls, or assert a fresh fetch occurs). Add an equivalent assertion for `/api/auth/connect/commit`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — add `activityProvider.Reset();` at each of the three commit sites (see placement above) and register the readers + `TimeProvider` + host.

- [ ] **Step 4: Verify pass** — `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AuthEndpoints"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/ServiceCollectionExtensions.cs PRism.Web/Program.cs PRism.Web/Endpoints/AuthEndpoints.cs tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs
git commit -m "feat(#137): register P2 readers + reset activity cache on replace/connect/connect-commit"
```

---

## Task 9: FakeActivityProvider — deterministic two-source feed + Watching

**Files:**
- Modify: `PRism.Web/TestHooks/FakeActivityProvider.cs`
- Test: `tests/PRism.Web.Tests/TestHooks/FakeActivityProviderGuardTests.cs` (guard unchanged; ensure it compiles against the new interface — fake implements `Reset()` as a no-op).

Keep the request-relative `now` anchor (Phase 1 lesson: relative ages drift the e2e baseline otherwise). Add at least one **actorless** notification-sourced item per you-relevant verb (so both actorless templates render in the baseline) and a small **Watching** list (mix of `Count>0` and one `idle`).

```csharp
internal sealed class FakeActivityProvider : IActivityProvider
{
    public void Reset() { /* stateless fake */ }

    public Task<ActivityResponse> GetActivityAsync(CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        ActivityItem Ev(string actor, bool bot, ActivityVerb verb, int pr, int minsAgo, string repo = "acme/api") =>
            new(actor, null, bot, verb, repo, pr, $"PR #{pr}",
                $"https://github.com/{repo}/pull/{pr}", now.AddMinutes(-minsAgo), ActivitySource.ReceivedEvent);
        ActivityItem Nf(ActivityVerb verb, int pr, int minsAgo, string repo = "acme/api") =>
            new(null, null, false, verb, repo, pr, $"PR #{pr}",
                $"https://github.com/{repo}/pull/{pr}", now.AddMinutes(-minsAgo), ActivitySource.Notification);

        var items = new[]
        {
            Nf(ActivityVerb.ReviewRequested, 1842, 12),                 // "Review requested on #1842"
            Ev("noah.s", false, ActivityVerb.Reviewed, 1810, 38),
            Ev("alice", false, ActivityVerb.Commented, 5436, 60, "acme/pos"),
            Ev("Copilot", true, ActivityVerb.Reviewed, 1810, 40),
            Nf(ActivityVerb.Mentioned, 1827, 75),                       // "You were mentioned in #1827"
            Ev("jules.t", false, ActivityVerb.Reviewed, 1827, 120),
            Ev("rohit", false, ActivityVerb.Opened, 1842, 180),
            Ev("noah.s", false, ActivityVerb.Merged, 1815, 300),
        };
        var watching = new[]
        {
            new WatchedRepoActivity("acme/api", 5, "https://github.com/acme/api"),
            new WatchedRepoActivity("acme/pos", 1, "https://github.com/acme/pos"),
            new WatchedRepoActivity("acme/infra", 0, "https://github.com/acme/infra"),  // idle
        };
        return Task.FromResult(new ActivityResponse(
            items, now, new ActivityDegradation(false, false, false), watching));
    }
}
```

- [ ] **Step 2: Build + guard test** — `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~FakeActivityProviderGuard"` → PASS (prod still resolves real `ActivityProvider`).

- [ ] **Step 3: Commit**

```bash
git add PRism.Web/TestHooks/FakeActivityProvider.cs
git commit -m "test(#137): fake activity feed gains actorless notifications + Watching list"
```

---

## Task 10: ActivityEndpoints test — Watching + kebab-case wire values

**Files:**
- Test: `tests/PRism.Web.Tests/Endpoints/ActivityEndpointsTests.cs`

Endpoint code is unchanged. The response now serializes `watching[]` and the grown `degraded` object. **Pin the kebab-case wire values here so the frontend (Tasks 11–12) mirrors the real wire, not C# casing.**

- [ ] **Step 1: Extend the endpoint test** to assert the serialized JSON carries:
  - `watching` array,
  - `degraded.notifications` and `degraded.watching` fields,
  - an actorless item with `"source": "notification"` and `"verb": "review-requested"` (the literal kebab-case wire values), and `"verb": "mentioned"`.

```csharp
json.Should().Contain("\"source\":\"notification\"");
json.Should().Contain("\"verb\":\"review-requested\"");   // NOT "reviewRequested"
json.Should().Contain("\"watching\":");
```

- [ ] **Step 2: Run** — `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~ActivityEndpoints"` → PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.Web.Tests/Endpoints/ActivityEndpointsTests.cs
git commit -m "test(#137): pin /api/activity Watching + kebab-case verb/source wire values"
```

---

## Task 11: Frontend types mirror the grown contracts (kebab-case)

**Files:**
- Modify: `frontend/src/api/types.ts`
- Verify with `tsc -b`.

- [ ] **Step 1: Grow the types — use the kebab-case wire values pinned in Task 10**

```typescript
export type ActivityVerb =
  | 'opened' | 'reopened' | 'closed' | 'merged' | 'reviewed' | 'commented' | 'other'
  | 'review-requested' | 'mentioned';

export type ActivitySource = 'received-event' | 'notification';

export interface ActivityDegradation {
  receivedEvents: boolean;
  notifications: boolean;
  watching: boolean;
}

export interface WatchedRepoActivity { repo: string; count: number; url: string; }

export interface ActivityResponse {
  items: ActivityItem[];
  generatedAt: string;
  degraded: ActivityDegradation;
  watching: WatchedRepoActivity[];
}
```

- [ ] **Step 2: Typecheck** — `cd frontend && npx tsc -b` → clean (`tsc --noEmit` is vacuous here).
- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(#137): frontend types (kebab-case verbs/source, Watching, 3-flag degradation)"
```

---

## Task 12: ActivityRail — actorless phrasing + Watching section + external routing

**Files:**
- Modify: `frontend/src/components/ActivityRail/ActivityRail.tsx`
- Modify: `frontend/src/components/ActivityRail/ActivityRail.module.css`
- Test: `frontend/src/components/ActivityRail/__tests__/ActivityRail.test.tsx`

- [ ] **Step 1: Write failing tests**
  - Actorless `verb:'review-requested'` → "Review requested on #1842"; `verb:'mentioned'` → "You were mentioned in #…"; an actorless `verb:'other'`/`'opened'` row → the **generic fallback** ("Activity on #…"), never a dangling fragment and never the literal `null` in the accessible name.
  - Watching `<section>` renders rows: `repo` + count; muted "idle" at `count:0`; the row link's `aria-label` includes the repo and "opens on GitHub".
  - Watching section is **absent** when `watching.length === 0` and not degraded; when `watching.length === 0` AND `degraded.watching` is true, the generic degraded note shows and the Watching header is omitted.
  - The degraded note shows when **any** of the three degraded flags is true.
  - A notification `url` of non-PR shape renders an external `<a>` (target/rel, "opens on GitHub" aria-label, `aria-hidden` icon); an in-app PR url renders a `<Link>`.

- [ ] **Step 2: Run to verify failure** — `cd frontend && npx vitest run src/components/ActivityRail` → fails.

- [ ] **Step 3: Implement**
  - **Actorless phrasing with a guaranteed fallback** (covers every verb so no actorless row is ever a dangling fragment):
    ```typescript
    const ACTORLESS_PHRASE: Record<ActivityVerb, (pr: number) => string> = {
      'review-requested': (pr) => `Review requested on #${pr}`,
      mentioned: (pr) => `You were mentioned in #${pr}`,
      commented: (pr) => `New comment on #${pr}`,
      opened: (pr) => `Opened #${pr}`,
      reopened: (pr) => `Reopened #${pr}`,
      closed: (pr) => `Closed #${pr}`,
      merged: (pr) => `Merged #${pr}`,
      reviewed: (pr) => `Reviewed #${pr}`,
      other: (pr) => `Activity on #${pr}`,
    };
    ```
  - In `Row`, branch on `item.actorLogin == null`: render the actorless template **and** build the `aria-label` from the actorless phrase (never reference `item.actorLogin` when it is null — the existing `${item.actorLogin} ${VERB_PHRASE...}` label must be guarded so no `null` leaks into the accessible name).
  - **Avatar alignment:** actorless rows render the existing `Avatar` placeholder (`<Avatar src={undefined} login="" size="sm" />`) so the avatar column width matches actor rows and text columns stay aligned. Do not omit the avatar (omitting shifts the text column left).
  - **Watching `<section>`** after the Activity section: same `.section` card chrome, but the section title uses a **lighter weight** (`.watchTitle`, font-weight 500 — matching the repo-group-header precedent from #272) so Activity reads as the primary panel. Each row: repo name (owner stripped for display, full name in `title`) + count pill (or muted `.idle` at 0), linking to `w.url` externally with `aria-label` `` `${repo} — ${count} recent ${count === 1 ? 'item' : 'items'}, opens on GitHub` `` (count>0) / `` `${repo} — no recent activity, opens on GitHub` `` (idle); external icon `aria-hidden`.
  - **Degraded note:** replace the existing `const degraded = data?.degraded.receivedEvents ?? false` (ActivityRail.tsx:82) with `const degraded = data ? (data.degraded.receivedEvents || data.degraded.notifications || data.degraded.watching) : false`. Single generic note unchanged.
  - Add the `.watchTitle`, `.idle`, and any Watching row classes to the CSS module.

- [ ] **Step 4: Verify pass** — `npx vitest run src/components/ActivityRail` → PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ActivityRail/
git commit -m "feat(#137): rail actorless phrasing (+fallback/aria/avatar) + Watching section + external routing"
```

---

## Task 13: InboxSkeleton — second (Watching) rail block

**Files:**
- Modify: `frontend/src/components/Inbox/InboxSkeleton.tsx`
- Test: `frontend/src/components/Inbox/__tests__/InboxSkeleton.test.tsx` (if present; else add a render assertion)

- [ ] **Step 1: Add a second skeleton panel** inside the `showRail` block (a second `<Skeleton />` for the Watching panel, smaller than the Activity panel).
- [ ] **Step 2: Test** — assert two rail skeleton blocks render when `showRail`.
- [ ] **Step 3: Run** — `npx vitest run src/components/Inbox` → PASS.
- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Inbox/
git commit -m "feat(#137): inbox skeleton shows Activity + Watching rail panels"
```

---

## Task 14: Full suites + e2e baseline

**Files:**
- e2e baseline (CI-only): `frontend/e2e/__screenshots__/linux/inbox-activity-rail.png`
- e2e spec: `frontend/e2e/parity-baselines.spec.ts` (the `inbox-activity-rail` test)

- [ ] **Step 1: Backend full suite** — `cd D:/src/PRism-137-activity-rail-phase2 && dotnet test` → all green, 0 warnings.
- [ ] **Step 2: Frontend unit + typecheck** — `cd frontend && npx vitest run && npx tsc -b` → green.
- [ ] **Step 3: Prettier (raw, not via rtk)** — `npx prettier --check .` (rtk masks the exit code; run raw). Fix with `npx prettier --write` if needed.
- [ ] **Step 4: Push branch, open PR (base main), let CI run e2e.** The `inbox-activity-rail` baseline WILL mismatch (Watching panel + actorless rows are an intentional layout change). After the CI e2e run, download the `e2e-results` artifact, verify the actual render matches the intended Phase 2 rail (Activity with actorless review-requested + mentioned rows + actor rows, bots hidden; Watching section with 2 active + 1 idle), `cp` the actual over the linux baseline, commit, push. Pre-committing avoids reviewers seeing false-positive snapshot diffs. **Do not regenerate blindly** — confirm the render is correct first (the fake's `now` anchor is request-relative, so ages are stable).
- [ ] **Step 5: win32 baseline** — NOT regenerated here (CI is Linux-only; the win32 baseline is local-only and stays the old shape — regen locally before any win32 Playwright run; out of scope for this PR).

---

## Task 15: PR scopes doc + security verification + final review

- [ ] **Step 1: PAT-scope doc** — classic `repo` covers `/notifications` + `/user/subscriptions` (no new scope); fine-grained adds **Notifications: read** + **Metadata: read** (missing → graceful degrade). Update the relevant PAT-guidance/help copy if Phase 1 added one.
- [ ] **Step 2: Header-redaction verification (security)** — confirm the `"github"` named `HttpClient` pipeline has no `DelegatingHandler` that logs request headers (the two new readers send the PAT as a Bearer header). Check `Program.cs` / `PRism.GitHub/ServiceCollectionExtensions.cs` for `AddHttpMessageHandler`. Record the result as a named acceptance criterion (no Authorization-header logging).
- [ ] **Step 3: Documentation maintenance** — per `.ai/docs/documentation-maintenance.md`, flip the spec's Phase 2 status and update any feature doc/README activity-rail entry to "Implemented (Phase 2)".
- [ ] **Step 4: Final whole-branch code review** (subagent-driven-development final reviewer).
- [ ] **Step 5: B1 visual sign-off (GATED).** Post the Phase 2 rail render (Activity two-source + Watching) on the PR for owner B1 review. **Do NOT merge without owner approval** — gated (B1 + B2) issue.

---

## Acceptance criteria (from spec § P2)

- [ ] Activity panel renders merged notifications + received_events (24h), actor-present and actor-absent phrasing both correct (every verb has an actorless fallback; no `null` in accessible names).
- [ ] Merge engine passes all merge cases: comment-notification→event merge, distinct actors, genuine same-verb 3-way, duplicate-notification collapse, no-counterpart non-merge, visible-window slot reservation (≥`MinEventSlots` events in the top-12 under a fresh-notification flood).
- [ ] Watching panel renders real `/user/subscriptions` repos; `count` = in-window (pre-cap) feed items incl. notification-only repos; `idle` at 0; section absent when empty-and-not-degraded.
- [ ] `ActivityResponse` / `ActivityDegradation` grown additively; cache invalidated on every token-commit path (replace incl. same-login rotation, connect, connect/commit); `Reset()` non-blocking.
- [ ] Wire values are kebab-case end to end (`review-requested`, `mentioned`, `notification`); frontend unions/maps match.
- [ ] Classic `repo` covers notifications + subscriptions (verified live); FG Notifications/Metadata read documented + graceful-degrade; no Authorization-header logging.

---

## Residual risks / accepted (from machine review)

- **Out-of-band PAT rotation** (editing the credential store directly, not via any `/api/auth/*` endpoint) is not detectable by the process; the stale-feed window is bounded to the 60s TTL. Accepted for the single-user localhost threat model.
- **Notification pagination:** `per_page=100` is not paginated. A user with >100 unread in-window PR notifications gets a truncated feed (and a possibly-undercounted Watching count) with no truncation signal. Accepted bound for v1; revisit if it bites in dogfood.
- **Notification volume (`all=true`):** owner chose read-decoupled `all=true&since=24h`, which is noisier than unread-only (returns all subscribed activity in-window). Bounded by `per_page=100` + the 24h window + the visible-12 cap; the broader organization of that volume is #315's job (group-by-repo + scroll).
- **GHES host:** owner chose to keep the host configurable. URLs use the configured GitHub host (default `github.com`), so Watching/notification links stay correct on a GHES instance.
