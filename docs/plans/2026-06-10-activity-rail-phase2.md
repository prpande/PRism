# Activity Rail Phase 2 — notifications merge + Watching panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the second Activity source (`/notifications`) merged into the existing received_events feed via a two-stage cross-feed merge, plus the Watching panel from `/user/subscriptions`, behind a ~60s TTL cache invalidated on identity/token change.

**Architecture:** Extends the merged Phase 1 code (`PRism.Core/Activity`, `PRism.GitHub/Activity`, `PRism.Web`, frontend `ActivityRail`/`useActivity`). Contracts grow **additively** (no breaking wire changes). The merge engine — the only place two feeds combine — lives in `ActivityFeedBuilder`. The provider gains a TTL cache + non-blocking `Reset()`. The rail gains actorless verb phrasing and the Watching `<section>`.

**Tech Stack:** .NET 10 (PRism.Core pure logic / PRism.GitHub adapters / PRism.Web endpoints), React + Vite + TypeScript frontend, xUnit + FluentAssertions (backend), Vitest + Testing Library (frontend), Playwright (e2e visual parity, CI-only).

**Spec:** `docs/specs/2026-06-09-activity-rail-real-data-design.md` (Phase 2 section, lines 489–667).

**Worktree:** `D:/src/PRism-137-activity-rail-phase2`, branch `feature/137-activity-rail-phase2` (cut from `main` @ `b1fe5252`, which has Phase 1 merged). This is a **gated (B1 visual + B2 auth/PAT) issue** — do NOT merge without owner B1 visual sign-off (final task).

> **Wire-casing invariant (read before any frontend task):** PRism serializes all enums **kebab-case** via `JsonStringEnumConverter(KebabCaseJsonNamingPolicy)` (see `PRism.Core/Json/JsonSerializerOptionsFactory` + `PRism.Core/Json/KebabCaseJsonNamingPolicy`, and the existing `ActivitySource` wire value `"received-event"`). So `ActivityVerb.ReviewRequested` goes on the wire as `"review-requested"`, `ActivityVerb.Mentioned` as `"mentioned"`, `ActivitySource.Notification` as `"notification"`. **Frontend unions, phrase maps, and tests MUST key on the kebab-case wire values, never the C# PascalCase or camelCase.** Task 10 pins this with an explicit wire-value assertion before the frontend mirrors it.

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
- Modify `ActivityProvider.cs` — inject notifications + watched readers + `TimeProvider` + `IConfigStore` (sources host + extra-bots per cache-miss rebuild); TTL cache; **non-blocking** `Reset()` (generation counter); aggregate degradation.

**Backend (PRism.Core/Config):**
- Modify `AppConfig.cs` — add `InboxConfig.KnownBots = ""` (additive activity-rail bot list).
- Modify `ConfigStore.cs` — register the `inbox.knownBots` scalar key + apply-on-patch. (Settings UI deferred to a separate issue.)

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

Keep the P1 single-source `Build(events, now)` as a thin delegate to the new overload (empty notifications/watched, default host, **empty `extraBotLogins`**) so Phase 1 tests stay green.

> **Additive bot detection (#137 owner decision 2026-06-10).** Phase 1 hardcodes `KnownBots = { "Copilot" }`. Keep that set as the **always-on built-in baseline** (rename to `BuiltInBots` for clarity) — a user can never accidentally un-detect Copilot. The new `extraBotLogins` param is ADDITIVE on top. At the top of `Build`, compute the effective set once: `var bots = new HashSet<string>(BuiltInBots, StringComparer.OrdinalIgnoreCase); bots.UnionWith(extraBotLogins);` and change `IsBot` to take it: `static bool IsBot(string login, HashSet<string> bots) => login.EndsWith("[bot]", StringComparison.OrdinalIgnoreCase) || bots.Contains(login);`. The `[bot]`-suffix auto-detection is unchanged and independent of config. (Settings UI to edit the list is deferred to **#316**; this phase wires only the config value + builder plumbing.)

New signature:

```csharp
public static ActivityBuildResult Build(
    IReadOnlyList<RawReceivedEvent> events,
    IReadOnlyList<RawNotification> notifications,
    IReadOnlyList<string> watchedRepos,
    string host,                 // FULL configured GitHub host URL incl. scheme, e.g. "https://github.com" — NOT a bare hostname. `config.Current.Github.Host` is a full URL (AppConfig default "https://github.com"); pass it `TrimEnd('/')`. Construct URLs as $"{host}/..." — do NOT prepend "https://".
    IReadOnlyCollection<string> extraBotLogins,  // user-configured extra bot logins (inbox.knownBots); ADDITIVE — see bot-detection note below
    DateTimeOffset now)
```

`ActivityBuildResult` grows to carry `IReadOnlyList<WatchedRepoActivity> Watching` (keeps `Items`, `DroppedRecognized`).

**Constants:** `MaxActivityItems = 12` (the **visible** cap), `MaxRawItems = 50` (server ceiling / client bot-filter headroom), `MinEventSlots = 4`, `MaxWatchingRows = 8`.

**Pipeline:**
1. **Events** — window-filter + map → `ActivityItem` (`Source = ReceivedEvent`), event-`id` dedup (existing P1 logic). Events with null/empty `HtmlUrl`, null `ActorLogin`, or null `PrNumber` are dropped (existing P1 guard — fixtures MUST set these).
2. **Notifications** — window-filter + normalize → `ActivityItem` (`Source = Notification`, `ActorLogin = null`, `ActorAvatarUrl = null`, **`ActorIsBot = false`** (a notification has no actor — it is NEVER bot-flagged regardless of `extraBotLogins`; do NOT pass its null/empty login through `IsBot`, which is non-nullable and would otherwise hide every actorless `review-requested`/`mentioned` row under the default `!actorIsBot` filter), `Verb = NotificationReasonMap.ToVerb(reason)`, `Url = $"{host}/{repo}/pull/{pr}"` (host is the full base URL incl. scheme — see signature note), `Title`, `Timestamp = updated_at`).
3. **Two-stage cross-feed merge** keyed on `(Repo, PrNumber, Verb)`:
   - **Stage A — group** all items by that key.
   - **Stage B — within each group:**
     - All event items survive (distinct actors are never collapsed — the actor detail is the payoff).
     - **Notifications within a group are first deduped to the most-recent one** (GitHub re-emits the same `(repo, reason, PR)`; without this, two `comment` notifications on one PR render as two identical actorless rows).
     - The deduped notification: if **you-relevant** (`ReviewRequested`/`Mentioned`) → it stays its **own actorless row**. (By construction this is *always* the case for you-relevant notifications: their verbs have no event counterpart, so they are alone in their group. This is correct and intended — "you were asked to review" is actor-independent and must not be welded onto whichever actor happened to act; see `NotificationReasonMap`.) If **not you-relevant** and the group already has ≥1 event → **drop the notification** (it folds into the most-recent matching event, no new row). If not you-relevant and the group has 0 events → keep it as the (single, deduped) actorless row.
4. **Sort** merged desc by `Timestamp`.
5. **Slot-reserved ordering for the VISIBLE cap (`MaxActivityItems` = 12).** The client takes the first `MaxActivityItems` of the server's order (after bot-filter) **without re-sorting** — so the reservation must be baked into the server's ordering, not applied against the 50-item ceiling (reserving against 50 is a no-op: a fresh-notification flood still fills the visible top-12 and starves events). Build the ordered list so the first `MaxActivityItems` positions contain **at least `MinEventSlots` (4) NON-BOT event items when that many exist**: take the top `MaxActivityItems - MinEventSlots` (8) items by timestamp, then ensure the next slots up to 12 include the most-recent non-bot events not already chosen (promote non-bot events ahead of notifications to fill the reserved 4), then append the remainder by timestamp up to `MaxRawItems`. Document that the client must preserve server order (it already does: `slice(0, MAX_VISIBLE)` with no re-sort). **The slot reservation is only correct while the client's `MAX_VISIBLE` (ActivityRail.tsx, currently `12`) equals the server's `MaxActivityItems` (`12`)** — they are two independent literals. Add a cross-reference comment at BOTH sites (`// must match ActivityFeedBuilder.MaxActivityItems` beside `MAX_VISIBLE`, and `// must match frontend MAX_VISIBLE` beside `MaxActivityItems`) so a future change to one surfaces the coupling; if they ever drift, the reservation silently breaks at the client's slice boundary.

   > **Reserve NON-BOT events, not all events.** The client strips bots *before* slicing — `all.filter((i) => showBots || !i.actorIsBot).slice(0, MAX_VISIBLE)` (ActivityRail.tsx:78). If the reserved 4 slots are filled by bot events (Copilot reviews are frequent in live data), they vanish client-side and notifications shift up to starve human events — the exact failure the reservation prevents. The builder already has an `IsBot` helper; reserve against `Source==ReceivedEvent && !IsBot`. The slot-reservation test below MUST include bot events occupying would-be reserved slots and assert ≥`MinEventSlots` non-bot events survive the client's post-filter visible 12.
6. **Watching.** `Count` = windowed merged items (the full pre-cap merged set) whose `Repo` matches (count is computed BEFORE the cap so a repo above the 12-cap never shows `idle`). Sort `Count` desc then name; `Count>0` first, pad with `idle` watched repos up to `MaxWatchingRows`; `Url = $"{host}/{repo}"` (host is the full base URL incl. scheme).

- [ ] **Step 1: Write failing tests**

Fixture helpers MUST set the fields the P1 guard requires (`HtmlUrl`, `ActorLogin`, `PrNumber`; `IsPullRequestComment=true` for `IssueCommentEvent`) — mirror the existing `ActivityProviderTests.Review()` helper, which passes a real `HtmlUrl`. Otherwise every event is silently dropped and merge assertions fail against an empty feed (a fixture bug masquerading as a merge bug):

```csharp
private const string Host = "https://github.com";  // full URL incl. scheme — matches config.Current.Github.Host shape; URLs build as $"{Host}/..."
// NOTE: HtmlUrl is REQUIRED — builder drops events with null/empty HtmlUrl. ActorLogin is REQUIRED too.
// Use NAMED arguments — the real record order is (Id, Type, ActorLogin, ActorAvatarUrl, Repo, Action,
// PrNumber, Title, HtmlUrl, Merged, IsPullRequestComment, CreatedAt) (verified in RawReceivedEvent.cs).
// Positional construction silently mis-slots fields (action→ActorLogin) and drops every event; named
// args make a future reorder a compile error instead of an empty-feed merge "bug".
private static RawReceivedEvent Ev(string id, string actor, string type, string action,
    string repo, int pr, DateTimeOffset ts, bool merged = false) =>
    new(Id: id, Type: type, ActorLogin: actor, ActorAvatarUrl: $"https://avatars/{actor}",
        Repo: repo, Action: action, PrNumber: pr, Title: $"PR #{pr}",
        HtmlUrl: $"https://github.com/{repo}/pull/{pr}", Merged: merged,
        IsPullRequestComment: type == "IssueCommentEvent", CreatedAt: ts);
private static RawNotification Nf(string reason, string repo, int pr, DateTimeOffset ts) =>
    new(repo, reason, pr, $"PR #{pr}", $"https://api.github.com/repos/{repo}/pulls/{pr}", ts);

private static ActivityBuildResult Build(RawReceivedEvent[] ev, RawNotification[] nf, string[] watched, DateTimeOffset now, string[]? extraBots = null)
    => ActivityFeedBuilder.Build(ev, nf, watched, Host, extraBots ?? [], now);

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

[Fact] // BOT events must NOT consume reserved slots (client strips bots before slicing)
public void Slot_reservation_reserves_non_bot_events_under_bot_and_notification_pressure()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var humans = Enumerable.Range(1, 5)                                // OLDER human events
        .Select(i => Ev(i.ToString(), $"u{i}", "PullRequestReviewEvent", "", "acme/api", i, now.AddMinutes(-30 - i)))
        .ToList();
    var bots = Enumerable.Range(50, 6)                                 // fresh BOT events (Copilot-style)
        .Select(i => Ev(i.ToString(), "Copilot", "PullRequestReviewEvent", "", "acme/api", i, now.AddMinutes(-2)))
        .ToList();
    var notifs = Enumerable.Range(100, 40)                             // fresh you-relevant flood
        .Select(i => Nf("review_requested", "acme/api", i, now.AddMinutes(-1)))
        .ToList();
    var r = Build([.. humans, .. bots], [.. notifs], [], now);
    // simulate the client's pre-slice bot filter, then take the visible window
    r.Items.Where(i => !i.ActorIsBot).Take(ActivityFeedBuilder.MaxActivityItems)
        .Count(i => i.Source == ActivitySource.ReceivedEvent)
        .Should().BeGreaterThanOrEqualTo(ActivityFeedBuilder.MinEventSlots);  // >=4 HUMAN events survive client filter
}

[Fact] // ADDITIVE bot config: a configured extra bot login is flagged ActorIsBot
public void Configured_extra_bot_login_is_flagged_as_bot()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var ev = Ev("1", "acme-ci", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-5));
    var item = Build([ev], [], [], now, extraBots: ["acme-ci"]).Items.Should().ContainSingle().Subject;
    item.ActorIsBot.Should().BeTrue();
}

[Fact] // built-in baseline always applies, even with empty config
public void Builtin_copilot_flagged_with_empty_extra_bots()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var ev = Ev("1", "Copilot", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-5));
    Build([ev], [], [], now).Items.Should().ContainSingle().Subject.ActorIsBot.Should().BeTrue();
}

[Fact] // a human login not in any list is NOT a bot (extra-bots matching is exact, case-insensitive)
public void Human_login_not_in_lists_is_not_bot()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var ev = Ev("1", "noah.s", "PullRequestReviewEvent", "", "acme/api", 10, now.AddMinutes(-5));
    Build([ev], [], [], now, extraBots: ["acme-ci"]).Items.Should().ContainSingle().Subject.ActorIsBot.Should().BeFalse();
}

[Fact] // notification items are NEVER bot-flagged (no actor), even with adversarial extra-bots config
public void Notification_item_is_never_bot_flagged()
{
    var now = DateTimeOffset.UnixEpoch.AddHours(48);
    var nf = Nf("review_requested", "acme/api", 10, now.AddMinutes(-3));   // actorless, you-relevant → own row
    var item = Build([], [nf], [], now, extraBots: ["review_requested", ""]).Items.Should().ContainSingle().Subject;
    item.ActorLogin.Should().BeNull();
    item.ActorIsBot.Should().BeFalse();   // must survive the default !actorIsBot filter
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
- Modify: `PRism.Core/Config/AppConfig.cs` — add `string KnownBots = ""` to `InboxConfig` (the new activity-rail bot list; the rail already lives under `inbox.`).
- Modify: `PRism.Core/Config/ConfigStore.cs` — register the `inbox.knownBots` scalar key + apply it on patch.
- Add package: `Directory.Packages.props` + `tests/PRism.Core.Tests/PRism.Core.Tests.csproj`
- Test: `tests/PRism.Core.Tests/Activity/ActivityProviderTests.cs`, and the dotted-path patch test file (follow the existing convention — `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs`) for the `inbox.knownBots` round-trip

- [ ] **Step 0: Add the FakeTimeProvider test package** (central package management — both edits required, or Task 7 tests won't compile):
  - `Directory.Packages.props`: add `<PackageVersion Include="Microsoft.Extensions.Time.Testing" Version="10.0.0" />` (match the existing `Microsoft.Extensions.*` 10.0.0 line).
  - `tests/PRism.Core.Tests/PRism.Core.Tests.csproj`: add `<PackageReference Include="Microsoft.Extensions.Time.Testing" />` (versionless, per CPM).
  - Verify: `dotnet restore` succeeds.

- [ ] **Step 0.5: Add the `inbox.knownBots` config (additive bot list, file- and API-configurable; Settings UI deferred to #316).**
  - `PRism.Core/Config/AppConfig.cs` — append `string KnownBots = ""` as the LAST `InboxConfig` parameter (mirrors how `ShowActivityRail` was appended last so positional `new InboxConfig(true, …, 14)` defaults stay valid). Doc comment: "#137 additive extra bot logins for the activity rail, comma-separated, matched case-insensitively on top of the built-in `{Copilot}` baseline and the `[bot]` suffix. Default empty. Settings UI tracked separately in #316."
  - `PRism.Core/Config/ConfigStore.cs` — add `["inbox.knownBots"] = ConfigFieldType.String` to the field-type map (next to `inbox.sectionOrder`), and in the patch-apply switch add `"inbox.knownBots" => current with { Inbox = current.Inbox with { KnownBots = (value ?? "").Trim() } }` (no strict validation — logins are free-form; unlike `sectionOrder` there is no permutation constraint).
  - Test (`ConfigStorePatchAsyncDottedPathTests`, the existing dotted-path convention): patch `inbox.knownBots` = `"acme-ci, security-scanner"` then read back; assert `Inbox.KnownBots` round-trips. (No UI, no frontend change this phase.)
  - Verify: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStore"` → PASS.

Inject the three readers + `TimeProvider` (prod registers `TimeProvider.System`) + `IConfigStore` (sources host + extra-bots per cache-miss rebuild — see below). Cache = an instance field `(ActivityResponse Response, DateTimeOffset At)?` guarded by a `SemaphoreSlim` for the *fetch*. **`Reset()` must be non-blocking** (it is called from the auth/replace request thread and must never wait on an in-flight 3-call GitHub fetch): use a generation counter. `Reset()` increments the generation and nulls the cache field **without taking the fetch gate**; `GetActivityAsync` captures the generation before fetching and discards its result (does not cache it) if the generation moved while it was fetching — so a token rotation mid-fetch is never cached.

Host + extra-bots for the builder: **inject `IConfigStore`** (the established Core pattern — `InboxPoller`/`PrDetailLoader` already take it) and read both values **fresh on each cache-miss rebuild** inside `GetActivityAsync` (the read is on the fetch path, *after* the TTL check — a cache HIT serves the prior build unchanged, it does not re-read config). Because the client poll interval (`POLL_MS = 90_000` = 90s, `useActivity.ts`) exceeds the 60s cache TTL, the cache is always expired by the next scheduled poll, so a config change to the bot list/host is reflected on the **next poll (~90s worst case)** without a restart. There is intentionally **no** config-change→`Reset()` wiring — the cache is reset only on token-commit paths; an off-cadence fetch within a single TTL window may briefly serve the prior list, which is acceptable for a rare power-user config (`IConfigStore.Changed` exists if tighter freshness is ever wanted):
- **Host:** `_config.Current.Github.Host.TrimEnd('/')` — a **full URL incl. scheme** (`"https://github.com"`; `GithubConfig.Host` delegates to the default account). The builder constructs `$"{host}/..."`, so it must receive the full base URL, NOT a bare hostname (re-prepending `https://` produces `https://https://github.com/...` — see Task 6 signature note).
- **Extra bots:** `_config.Current.Inbox.KnownBots` (new comma-string key `inbox.knownBots`, default `""` — see Task 8) parsed via a private `ParseExtraBots(string)` helper: `split(',') → Trim() → drop empties → distinct (OrdinalIgnoreCase)`. ADDITIVE on top of the builder's built-in `{ "Copilot" }` baseline.

Pass both into `ActivityFeedBuilder.Build(..., host, extraBots, now)`. This replaces the earlier captured-`string host` ctor param — one `IConfigStore` dependency now sources both config-derived values.

- [ ] **Step 1: Write failing tests** (seed `FakeTimeProvider` explicitly in **every** test — an unseeded fake starts at an arbitrary epoch and will window-filter real-timestamp fixtures unpredictably):

```csharp
[Fact]
public async Task Caches_within_ttl_then_refetches_after()
{
    var clock = new FakeTimeProvider(DateTimeOffset.UnixEpoch.AddYears(56)); // ~2026, matches fixtures
    var ev = new CountingReceivedEventsReader();
    var p = new ActivityProvider(ev, new EmptyNotifReader(), new EmptyWatchReader(), clock, Config(), NullLogger<ActivityProvider>.Instance);
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
    var p = new ActivityProvider(ev, new EmptyNotifReader(), new EmptyWatchReader(), clock, Config(), NullLogger<ActivityProvider>.Instance);
    await p.GetActivityAsync(default); p.Reset(); await p.GetActivityAsync(default);
    ev.Calls.Should().Be(2);
}

[Fact]
public async Task Reset_during_inflight_fetch_discards_that_result()
{
    var clock = new FakeTimeProvider(DateTimeOffset.UnixEpoch.AddYears(56));
    var release = new TaskCompletionSource();                       // gates the reader mid-fetch
    var ev = new GatedReceivedEventsReader(release.Task);           // ReadAsync awaits release.Task, counts calls
    var p = new ActivityProvider(ev, new EmptyNotifReader(), new EmptyWatchReader(), clock, Config(), NullLogger<ActivityProvider>.Instance);

    var inflight = p.GetActivityAsync(default);                     // starts fetch #1, blocks on release
    await ev.Entered.Task;                                          // ensure fetch #1 is inside ReadAsync
    p.Reset();                                                      // rotate token mid-fetch (bumps generation)
    release.SetResult();                                            // let fetch #1 complete
    await inflight;                                                 // fetch #1 returns its result but must NOT cache it

    await p.GetActivityAsync(default);                             // fetch #2: cache was discarded → refetch
    ev.Calls.Should().Be(2);                                        // the reset-mid-fetch result was never cached
}

[Fact]
public async Task Aggregates_degradation_from_three_sources()
{
    var clock = new FakeTimeProvider(DateTimeOffset.UnixEpoch.AddYears(56));
    var p = new ActivityProvider(new DegradedReceivedEventsReader(), new DegradedNotifReader(), new DegradedWatchReader(), clock, Config(), NullLogger<ActivityProvider>.Instance);
    (await p.GetActivityAsync(default)).Degraded.Should().Be(new ActivityDegradation(true, true, true));
}
```

Also **update the two existing P1 `ActivityProviderTests` constructions** (`new ActivityProvider(reader, NullLogger...)`) to the new 6-arg ctor (pass `EmptyNotifReader`/`EmptyWatchReader`/seeded `FakeTimeProvider`/`Config()`). Add a **`Config(string knownBots = "")` helper** returning an `IConfigStore` whose `Current` is `AppConfig.Default` (a static property — no parens; already has `Github.Host = "https://github.com"`) with `Inbox.KnownBots` overridden by the `knownBots` arg (default `""`), so `Config()` gives the empty default and `Config("acme-ci")` exercises the configured-bot path; a tiny stub or a real `ConfigStore` seeded with the default both work — use whichever the existing Core tests already use for `IConfigStore`. Add the small fake readers (`Counting*`, `Empty*`, `Degraded*`, and `GatedReceivedEventsReader` — exposes an `Entered` `TaskCompletionSource` signalled when `ReadAsync` is first entered, awaits the injected `release` task, and increments `Calls`) and `since`-aware notif fakes as nested classes. Add a test that a configured extra bot (`Inbox.KnownBots = "acme-ci"` via `Config(knownBots: "acme-ci")`) flows through to the builder and flags an `acme-ci` event as a bot (the provider→builder bot wiring, distinct from the Task 6 pure-builder test).

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
    private readonly IConfigStore _config;
    private readonly ILogger<ActivityProvider> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private volatile CacheEntry? _cache;   // volatile reference: atomic publish/clear on every CLR (no torn struct read)
    private int _generation;

    private sealed record CacheEntry(ActivityResponse Response, DateTimeOffset At, int Generation);

    public ActivityProvider(IReceivedEventsReader events, INotificationsReader notifs,
        IWatchedReposReader watched, TimeProvider clock, IConfigStore config, ILogger<ActivityProvider> log)
    { _events = events; _notifs = notifs; _watched = watched; _clock = clock; _config = config; _log = log; }

    private static IReadOnlyCollection<string> ParseExtraBots(string csv) =>
        csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
           .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

    public async Task<ActivityResponse> GetActivityAsync(CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        var gen = Volatile.Read(ref _generation);
        // Cache-hit read is generation-checked, not just TTL-checked: a token rotation bumps the
        // generation, so an entry stamped under the old generation is rejected even within its 60s TTL
        // (closes the cache-HIT race where a reader captures a pre-reset entry and serves a stale feed).
        if (_cache is { } hit && hit.Generation == gen && now - hit.At < Ttl) return hit.Response;
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            gen = Volatile.Read(ref _generation);                      // re-read under the gate
            if (_cache is { } c && c.Generation == gen && now - c.At < Ttl) return c.Response;

            var evT = _events.ReadAsync(ct);
            var nfT = _notifs.ReadAsync(now.AddHours(-24), ct);
            var wtT = _watched.ReadAsync(ct);
            await Task.WhenAll(evT, nfT, wtT).ConfigureAwait(false);
            var ev = evT.Result; var nf = nfT.Result; var wt = wtT.Result;

            var cfg = _config.Current;                                 // read host + bots fresh per fetch
            var host = cfg.Github.Host.TrimEnd('/');
            var extraBots = ParseExtraBots(cfg.Inbox.KnownBots);
            var built = ActivityFeedBuilder.Build(ev.Events, nf.Notifications, wt.Repos, host, extraBots, now);
            if (built.DroppedRecognized > 0) Log.DroppedRecognized(_log, built.DroppedRecognized);

            var resp = new ActivityResponse(built.Items, now,
                new ActivityDegradation(ev.Degraded, nf.Degraded, wt.Degraded), built.Watching);

            if (Volatile.Read(ref _generation) == gen) _cache = new CacheEntry(resp, now, gen);  // discard if reset mid-fetch
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

> **Why `_cache` is a `volatile CacheEntry?` reference (not a `(…)?` value tuple) — unconditional, not gated on "if static analysis objects":** `Reset()` writes `_cache = null` outside the fetch gate, on the auth-request thread. A `Nullable<(ActivityResponse, DateTimeOffset)>` is a multi-word struct whose write is NOT guaranteed atomic — a concurrent reader could see a torn value that passes the `is { }` guard with a zero-initialized `Response`. A `volatile` reference to a `sealed record CacheEntry` makes both the publish (`new CacheEntry(...)`) and the clear (`null`) single atomic reference stores on every CLR. The `Generation` stamp on the entry additionally closes the cache-HIT race: a reader that captured a pre-reset entry within its TTL rejects it because `hit.Generation != gen` after a rotation.

- [ ] **Step 4: Verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add Directory.Packages.props tests/PRism.Core.Tests/PRism.Core.Tests.csproj PRism.Core/Activity/IActivityProvider.cs PRism.Core/Activity/ActivityProvider.cs PRism.Core/Config/AppConfig.cs PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Activity/ActivityProviderTests.cs tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs
git commit -m "feat(#137): ActivityProvider multi-source + 60s TTL cache + non-blocking Reset() + inbox.knownBots (additive, config-sourced host+bots)"
```

---

## Task 8: DI registration + cache invalidation on ALL token-commit paths

**Files:**
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` — register `INotificationsReader`/`IWatchedReposReader` (mirror the received-events reader registration: same `IHttpClientFactory` + `readToken` Func; drop `readLogin` — these endpoints are self-scoped).
- Modify: `PRism.Web/Program.cs` — register `builder.Services.AddSingleton(TimeProvider.System)` (not currently registered). **Keep** the line 73 generic registration `AddSingleton<IActivityProvider, ActivityProvider>()` as-is: because host + bots are now sourced from the injected `IConfigStore` (not a `string` param), **every** `ActivityProvider` ctor param is DI-resolvable — `IReceivedEventsReader` (P1), `INotificationsReader`/`IWatchedReposReader` (registered in `PRism.GitHub` below), `TimeProvider` (registered here), `IConfigStore` (already registered), `ILogger` (DI built-in). No factory lambda is needed; just ensure all five services are registered before the app builds — a missing one throws `Unable to resolve service…` at startup. (The Test-env override at Program.cs:106-107 — `RemoveAll<IActivityProvider>()` + `AddSingleton<…, FakeActivityProvider>()` — is unaffected; the Fake has a parameterless ctor.)
- Modify: `PRism.Web/Endpoints/AuthEndpoints.cs` — inject `IActivityProvider`; call `Reset()` on **every** successful token-commit path.
- Test: `tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs`.

**Which paths reset, and why every path (not just identityChanged):** the cache holds private-repo feed data gated by the *current* token's scope. Three handlers commit a token and must invalidate it:
- `/api/auth/replace` — including the **same-login token rotation** case (`identityChanged == false`), which the existing reset block at `AuthEndpoints.cs:364-367` does NOT cover. Place the `Reset()` call **outside** the `if (identityChanged)` block, immediately before the success `return Results.Ok(...)`, so it fires on every successful replace regardless of login change.
- `/api/auth/connect` (`AuthEndpoints.cs:~88`, **only** after the `tokens.CommitAsync` success branch — NOT on the soft-warning early return at `AuthEndpoints.cs:~81-85`, which stashes a transient login and commits no token; resetting there needlessly evicts a still-valid cache and forces a wasteful 3-call refetch for a no-op).
- `/api/auth/connect/commit` (`AuthEndpoints.cs:~102`, after `tokens.CommitAsync`).

`/api/auth/connect` is the first-real-session path after a token-clear, so omitting it leaks a prior token's cached feed on the very next session once Task 7's cache lands. (In P1 the provider has no cache, so the call is a harmless no-op until Task 7 makes it load-bearing.)

**Why imperative Reset() and NOT bus-subscribe (spec's deferred decision §566-570):** the `IdentityChanged` bus message is published *only inside the `identityChanged` branch*. Subscribing `ActivityProvider` to it would reproduce exactly the same-login-rotation gap we're closing. An unconditional imperative `Reset()` at each commit site covers all branches; subscription does not. Recorded here per the spec's request to weigh the tradeoff.

- [ ] **Step 1: Write failing test (MANDATORY — this is the regression guard for the same-login-rotation gap, the core security rationale).** Inject a **spy `IActivityProvider`** that counts `Reset()` calls (chosen over "assert a fresh fetch" — it's a pure unit assertion with no fetch plumbing and pins the exact contract). Drive `/api/auth/replace` with the **same** login + a new token and assert `Reset()` was called exactly once. This test MUST be RED if `Reset()` is placed inside the `if (identityChanged)` block — that is the one-line mistake it exists to catch. Add the equivalent same-provider spy assertion for `/api/auth/connect/commit` and `/api/auth/connect`.

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
  - **Standalone actorless `verb:'commented'` row** (`actorLogin:null`, `source:'notification'`, no matching event) → "New comment on #N". (Without this test the `commented` phrase-map entry is dead code: every other test path either folds or drops the comment notification, so the entry could be deleted and the suite stays green.)
  - Watching `<section>` renders rows: `repo` + count; muted "idle" at `count:0`; the row link's `aria-label` includes the repo and "opens on GitHub".
  - **Both `<section>` landmarks are named:** `getByRole('region', { name: /activity/i })` and `getByRole('region', { name: /watching/i })` both resolve. (A `<section>` without an accessible name is not a landmark — without `aria-label` neither panel appears in screen-reader landmark navigation, the exact path a user takes to jump to "Watching".)
  - **Degraded gating is SPLIT, not unioned** (the Activity-list "unavailable" state must NOT fire on a watching-only failure):
    - `degraded.watching === true` while `degraded.receivedEvents` and `degraded.notifications` are both false AND `items.length > 0` → the Activity list still renders its rows (NOT "Activity unavailable").
    - `degraded.receivedEvents || degraded.notifications` true → the Activity "unavailable" note shows.
  - Watching states: **absent** when `watching.length === 0 && !degraded.watching`; when `watching.length === 0 && degraded.watching` → the Watching header is omitted and an inline note shows; **when `watching.length > 0 && degraded.watching`** → the Watching rows render normally PLUS a muted inline "Subscription list may be incomplete" note below them (show what returned, flag the gap — mirrors the Activity "show what you have" approach; never hide partial data).
  - **Server order is preserved (no client re-sort):** pass `items` intentionally out of timestamp order and assert the rendered DOM row order matches the input array order, not a timestamp sort. (The builder's slot reservation is baked into server order; a future client-side sort before `slice` would silently defeat it.)
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
  - **Section landmarks are named:** add `aria-label="Watching"` to the new Watching `<section>` and `aria-label="Activity"` to the existing Activity `<section>` (ActivityRail.tsx:89, currently unlabeled) so both register as named region landmarks.
  - **Watching `<section>`** after the Activity section: same `.section` card chrome, but the section title uses a **lighter weight** (`.watchTitle`, font-weight 500 — matching the repo-group-header precedent from #272) so Activity reads as the primary panel. Each row: repo name (owner stripped for display, full name in `title`) + count pill (or muted `.idle` at 0), linking to `w.url` externally with `aria-label` `` `${repo} — ${count} recent ${count === 1 ? 'item' : 'items'}, opens on GitHub` `` (count>0) / `` `${repo} — no recent activity, opens on GitHub` `` (idle); external icon `aria-hidden`.
  - **Watching degraded states** (gated on `watchingDegraded`, independent of the Activity note): when `watching.length === 0 && watchingDegraded` → omit the Watching header, show a single inline note; when `watching.length > 0 && watchingDegraded` → render the rows normally and append a muted inline `.watchIncomplete` note "Subscription list may be incomplete" below them (never hide the partial list); when `watching.length === 0 && !watchingDegraded` → render nothing.
  - **Degraded gating — SPLIT into two flags (do NOT union all three).** The existing `const degraded = data?.degraded.receivedEvents ?? false` (ActivityRail.tsx:82) feeds `showDegraded` (line 83), which at line 109 replaces the *entire* Activity list with "Activity unavailable". Unioning `watching` into it would blank a perfectly good Activity list whenever only `/user/subscriptions` failed — the most common partial failure producing the most damaging render. Replace with:
    ```typescript
    const activityDegraded = data ? (data.degraded.receivedEvents || data.degraded.notifications) : !!error;
    const watchingDegraded = data?.degraded.watching ?? false;
    const showDegraded = (!data && error) || activityDegraded;   // gates ONLY the Activity list
    ```
    The Activity "unavailable" note fires on `showDegraded`; `watchingDegraded` gates only the Watching section's own inline note (below). The generic note copy is unchanged.
  - **`allHiddenAreBots` copy — leave unchanged.** The existing "turn on Show bots…" empty-state copy stays as-is even when the hidden rows are configured `inbox.knownBots` logins (not `[bot]`-suffixed): the Show-bots toggle surfaces all `actorIsBot:true` items from both sources, so the instruction remains accurate. Do not branch the copy on bot-source — one disposition, no implementer guess.
  - Add the `.watchTitle`, `.idle`, `.watchIncomplete` (muted inline note), and any Watching row classes to the CSS module.

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
- [ ] **Step 2: Header-redaction verification (security) — automated, not manual-only.** The two new readers send the PAT as a Bearer header; a future contributor adding a diagnostic logging `DelegatingHandler` (the pattern already exists via `RealTransportFailureInjector`/`TestFailureInjectionHandler`) could leak it with nothing to catch the regression. (a) Confirm the `"github"` named `HttpClient` pipeline has no header-logging `DelegatingHandler` (grep `AddHttpMessageHandler` in `Program.cs` / `PRism.GitHub/ServiceCollectionExtensions.cs`); AND (b) add a **unit test** that drives a request through the real `"github"` pipeline via a capturing handler and asserts no `Authorization` header value appears in captured log output at Warning-or-below (mirror the existing `GitHubReviewService` auth-header test pattern if present). This promotes "no Authorization-header logging" from a manual note to a CI gate.
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
- [ ] Activity-rail bot list is human-configurable via `inbox.knownBots` (file + PATCH API), **additive** on top of the built-in `{Copilot}` baseline and `[bot]`-suffix detection; configured logins flow through to `ActorIsBot`. Settings UI for it is deferred to **#316** (not in this PR).

---

## Residual risks / accepted (from machine review)

- **Out-of-band PAT rotation** (editing the credential store directly, not via any `/api/auth/*` endpoint) is not detectable by the process; the stale-feed window is bounded to the 60s TTL. Accepted for the single-user localhost threat model.
- **Notification pagination:** `per_page=100` is not paginated. A user with >100 unread in-window PR notifications gets a truncated feed (and a possibly-undercounted Watching count) with no truncation signal. Accepted bound for v1; revisit if it bites in dogfood.
- **Notification volume (`all=true`):** owner chose read-decoupled `all=true&since=24h`, which is noisier than unread-only (returns all subscribed activity in-window). Bounded by `per_page=100` + the 24h window + the visible-12 cap; the broader organization of that volume is #315's job (group-by-repo + scroll).
- **GHES host:** owner chose to keep the host configurable. URLs use `config.Current.Github.Host` (a full URL incl. scheme, default `"https://github.com"`) `TrimEnd('/')` and build as `$"{host}/..."`, so Watching/notification links stay correct on a GHES instance. **PAT-egress trust chain:** the same host value also sets the `"github"` `HttpClient` BaseAddress, and the PAT is only committed *after* GitHub at that host accepts it via `/api/auth/connect`'s `ValidateCredentialsAsync` — so the new readers never send the PAT to an unvalidated host. No additional host-validation step is needed; this is the existing posture for every other GitHub adapter. The builder's display URLs (`$"{host}/.."`) are built from the same validated host without re-running `HostUrlResolver`'s scheme check, but the Electron shell independently enforces https-only at the open-external layer (`isOpenableUrl` / `windowOpenDecision`), so a malformed host can't produce an executable non-https link — accepted under the single-user localhost threat model.
- **Cache-read race (closed):** the cache-HIT read path is generation-checked (not just TTL-checked), and `_cache` is a `volatile CacheEntry?` reference — so a concurrent request can never serve a pre-rotation feed after `Reset()`, and there is no torn-struct read. See Task 7.
