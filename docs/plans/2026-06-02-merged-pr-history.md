# Merged / closed PR history — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsed "Recently closed" inbox section (PRs you authored/commented/were-mentioned-on or reviewed, merged or closed in the last 14 days) and finish the read-only detail view for done PRs.

**Architecture:** Extend the existing inbox pipeline (`InboxRefreshOrchestrator` → `ISectionQueryRunner` → `IPrEnricher`) with a dedicated closed-history branch — two `is:closed` participant searches, unioned, enriched for close-state, sorted/capped, emitted as a new section that skips the open-PR `HeadSha` drop filter. Frontend renders it collapsed-by-default with a text-primary merged/closed badge. The read-only detail view already exists (`prState`/`readOnly`/`isClosedOrMerged`); this finishes three gaps — header status label, a read-only Drafts tab, and a live merge/close transition banner.

**Tech Stack:** .NET 10 minimal API (`PRism.Core` / `PRism.GitHub` / `PRism.Web`), React + Vite + TS frontend, xUnit + FluentAssertions + Moq (backend), vitest (frontend), Playwright (e2e).

**Source spec:** [`docs/specs/2026-06-02-merged-pr-history-design.md`](../specs/2026-06-02-merged-pr-history-design.md). Read it before starting.

**Suggested PR cut** (each phase is independently shippable + green):
- **PR1 — backend close-state plumbing + closed-history section** (Tasks 1–8, incl. 6b): pipeline produces a `recently-closed` section + surfaces the toggle in `/api/preferences`; covered by unit tests; no frontend yet (section returned by `/api/inbox` but the FE just renders it generically). **Task 6b (preferences DTO) must be in PR1** so PR2's Settings toggle has a backend key to bind to.
- **PR2 — frontend section polish** (Tasks 9–12): collapsed-by-default, badge, suppressed urgency cues, truncation hint, settings toggle.
- **PR3 — read-only detail gaps** (Tasks 13–17): header label, read-only Drafts tab, transition banner, diff-renders audit.

---

## File Structure

**Backend (PRism.Core):**
- `Inbox/RawPrInboxItem.cs` — add `MergedAt`/`ClosedAt` (modify)
- `Inbox/ISectionQueryRunner.cs` — add `QueryClosedHistoryAsync` (modify)
- `Inbox/InboxHistoryConstants.cs` — window/cap constants (create)
- `Inbox/InboxRefreshOrchestrator.cs` — dedicated closed-history branch + materialize close-state (modify)
- `Config/AppConfig.cs` — `InboxSectionsConfig.RecentlyClosed` (modify)
- `Config/ConfigStore.cs` — allowlist + patch switch (modify)

**Backend (PRism.Core.Contracts):**
- `PrInboxItem.cs` — add `MergedAt`/`ClosedAt` (modify)
- `Pr.cs` — add `MergedAt`/`ClosedAt` (modify, PR3)

**Backend (PRism.GitHub):**
- `Inbox/GitHubSectionQueryRunner.cs` — implement `QueryClosedHistoryAsync` + clock seam (modify)
- `Inbox/GitHubPrEnricher.cs` — parse `merged_at`/`closed_at` (modify)
- `GitHubReviewService.cs` — surface `closedAt`/`mergedAt` in `ParsePr` (modify, PR3)

**Backend (PRism.GitHub):**
- `ServiceCollectionExtensions.cs` — pass clock seam to `GitHubSectionQueryRunner` (modify)

**Backend (PRism.Web):**
- `Endpoints/InboxEndpoints.cs` — `recently-closed` label (modify)
- `Endpoints/PreferencesDtos.cs` + `Endpoints/PreferencesEndpoints.cs` — surface `RecentlyClosed` in `/api/preferences` (modify)

**Frontend:**
- `api/types.ts` — `PrInboxItem.mergedAt/closedAt`, `InboxSectionsPreferences.recentlyClosed`, `Pr` close timestamps (modify)
- `components/Inbox/InboxSection.tsx` — `defaultOpen` prop + closed-row mode (modify)
- `components/Inbox/InboxRow.tsx` — merged/closed badge + suppressed urgency cues (modify)
- `components/Inbox/RecentlyClosedFooter.tsx` — truncation hint (create)
- `pages/InboxPage.tsx` — pass `defaultOpen={false}` for `recently-closed` (modify)
- `components/Settings/...` — `recently-closed` toggle (modify, PR2)
- `components/PrDetail/PrHeader.tsx` — merged/closed status label (modify, PR3)
- `components/PrDetail/DraftsTab/DraftsTab.tsx` + `DraftListItem.tsx` — read-only mode (modify, PR3)
- `components/PrDetail/BannerTransition.tsx` — transition banner (create, PR3)

---

## Conventions (read once)

- **TDD:** failing test → run-it-fails → minimal impl → run-it-passes → commit. One behavior per test.
- **Wire enums are kebab-case** via the app's `JsonStringEnumConverter`; section id is the literal string `recently-closed`.
- **Run backend tests:** `dotnet test PRism.sln --configuration Release` (timeout ≥ 300000ms; one build/test at a time, foreground).
- **Run a single backend test:** `dotnet test --filter "FullyQualifiedName~InboxRefreshOrchestratorTests.RecentlyClosed"`.
- **Run frontend tests:** `cd frontend && npm test` (vitest). Single file: `npm test -- InboxSection`.
- **Before any push:** run the full pre-push checklist in `.ai/docs/development-process.md` (`npm run lint` includes `prettier --check` and gates CI; `prettier --write` new FE files before staging).
- **No fixed sub-second `Task.Delay` ceilings in tests** (Windows CI flake) — poll the observable condition.

---

# Phase A — Backend (PR1)

### Task 1: Add close-state fields to the raw + projected inbox items

**Files:**
- Modify: `PRism.Core/Inbox/RawPrInboxItem.cs`
- Modify: `PRism.Core.Contracts/PrInboxItem.cs`
- Test: `tests/PRism.Core.Tests/Inbox/RawPrInboxItemTests.cs` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Core.Tests/Inbox/RawPrInboxItemTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.Core.Tests.Inbox;

public sealed class RawPrInboxItemTests
{
    [Fact]
    public void CloseState_DefaultsToNull_OnOpenRows()
    {
        var raw = new RawPrInboxItem(
            new PrReference("acme", "api", 1), "t", "a", "acme/api",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, "sha", 1);

        raw.MergedAt.Should().BeNull();
        raw.ClosedAt.Should().BeNull();
    }

    [Fact]
    public void CloseState_RoundTripsThroughWith()
    {
        var merged = DateTimeOffset.UtcNow;
        var raw = new RawPrInboxItem(
            new PrReference("acme", "api", 1), "t", "a", "acme/api",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, "sha", 1)
            with { MergedAt = merged, ClosedAt = merged };

        raw.MergedAt.Should().Be(merged);
        raw.ClosedAt.Should().Be(merged);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~RawPrInboxItemTests"`
Expected: COMPILE FAIL — `RawPrInboxItem` has no `MergedAt`/`ClosedAt`.

- [ ] **Step 3: Add the fields**

`PRism.Core/Inbox/RawPrInboxItem.cs` — append two nullable params (positional records: add at the end so existing positional call sites are unaffected only if they use named args; the existing call sites in `GitHubSectionQueryRunner` and tests use positional construction, so adding optional-with-default is required). Make them optional:

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public sealed record RawPrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTimeOffset UpdatedAt,
    DateTimeOffset PushedAt,
    int CommentCount,
    int Additions,
    int Deletions,
    string HeadSha,
    int IterationNumberApprox,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null);
```

`PRism.Core.Contracts/PrInboxItem.cs` — same, optional trailing params:

```csharp
namespace PRism.Core.Contracts;

public sealed record PrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTimeOffset UpdatedAt,
    DateTimeOffset PushedAt,
    int IterationNumber,
    int CommentCount,
    int Additions,
    int Deletions,
    string HeadSha,
    CiStatus Ci,
    string? LastViewedHeadSha,
    long? LastSeenCommentId,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null);
```

> Optional trailing params keep every existing positional construction (`GitHubSectionQueryRunner.SearchAsync`, the orchestrator's `MaterializePrInboxItem`, and all current tests) compiling unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~RawPrInboxItemTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Inbox/RawPrInboxItem.cs PRism.Core.Contracts/PrInboxItem.cs tests/PRism.Core.Tests/Inbox/RawPrInboxItemTests.cs
git commit -m "feat(inbox): add nullable MergedAt/ClosedAt to raw + projected inbox items"
```

---

### Task 2: Enricher parses `merged_at` / `closed_at`

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubPrEnricher.cs`
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs` (create or extend)

GitHub's `GET /repos/{o}/{r}/pulls/{n}` returns `merged_at` (null unless merged) and `closed_at` (null unless closed) at the root. The enricher currently ignores them.

- [ ] **Step 1: Write the failing test**

Create/extend `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs`. Use the existing test's stubbed `IHttpClientFactory` pattern (grep the file for `StubHttpClientFactory` / `FakeHandler` if present; otherwise this minimal handler):

```csharp
using System.Net;
using System.Text;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;

namespace PRism.GitHub.Tests.Inbox;

public sealed class GitHubPrEnricherCloseStateTests
{
    private sealed class CannedHandler : HttpMessageHandler
    {
        private readonly string _json;
        public CannedHandler(string json) => _json = json;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent(_json, Encoding.UTF8, "application/json") });
    }

    private sealed class StubFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _h;
        public StubFactory(HttpMessageHandler h) => _h = h;
        public HttpClient CreateClient(string name) => new(_h, disposeHandler: false)
        { BaseAddress = new Uri("https://api.github.com/") };
    }

    private static RawPrInboxItem Raw(int n) => new(
        new PrReference("acme", "api", n), "t", "a", "acme/api",
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, "sha", 1);

    [Fact]
    public async Task Enrich_PopulatesMergedAt_OnMergedPr()
    {
        const string json = """
        {"head":{"sha":"abc"},"additions":1,"deletions":2,"commits":3,
         "merged_at":"2026-05-20T10:00:00Z","closed_at":"2026-05-20T10:00:00Z"}
        """;
        var enricher = new GitHubPrEnricher(new StubFactory(new CannedHandler(json)), () => Task.FromResult<string?>("t"));

        var result = await enricher.EnrichAsync(new[] { Raw(1) }, default);

        result[0].MergedAt.Should().Be(DateTimeOffset.Parse("2026-05-20T10:00:00Z"));
        result[0].ClosedAt.Should().Be(DateTimeOffset.Parse("2026-05-20T10:00:00Z"));
    }

    [Fact]
    public async Task Enrich_LeavesMergedAtNull_OnClosedUnmergedPr()
    {
        const string json = """
        {"head":{"sha":"abc"},"additions":1,"deletions":2,"commits":3,
         "merged_at":null,"closed_at":"2026-05-21T08:00:00Z"}
        """;
        var enricher = new GitHubPrEnricher(new StubFactory(new CannedHandler(json)), () => Task.FromResult<string?>("t"));

        var result = await enricher.EnrichAsync(new[] { Raw(1) }, default);

        result[0].MergedAt.Should().BeNull();
        result[0].ClosedAt.Should().Be(DateTimeOffset.Parse("2026-05-21T08:00:00Z"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~GitHubPrEnricherCloseStateTests"`
Expected: FAIL — `MergedAt`/`ClosedAt` are null (not parsed).

- [ ] **Step 3: Parse the timestamps in `FetchAsync`**

`PRism.GitHub/Inbox/GitHubPrEnricher.cs` — inside `FetchAsync`, after the `pushedAt` block and before the `return raw with`, add:

```csharp
        DateTimeOffset? mergedAt = null;
        if (doc.RootElement.TryGetProperty("merged_at", out var mAt) &&
            mAt.ValueKind == JsonValueKind.String)
            mergedAt = mAt.GetDateTimeOffset();

        DateTimeOffset? closedAt = null;
        if (doc.RootElement.TryGetProperty("closed_at", out var cAt) &&
            cAt.ValueKind == JsonValueKind.String)
            closedAt = cAt.GetDateTimeOffset();
```

Then extend the `return raw with { ... }`:

```csharp
        return raw with
        {
            HeadSha = head, Additions = additions, Deletions = deletions,
            IterationNumberApprox = commits, PushedAt = pushedAt,
            MergedAt = mergedAt, ClosedAt = closedAt,
        };
```

> **Cache caveat (spec § 3.3):** the cache key stays `(Reference, UpdatedAt)`. A close transition normally bumps `updated_at` (cache miss → re-fetch with the new timestamps). The rare no-bump case self-heals on the next 120s tick — accepted, mirroring the § 3.4 non-atomic note. Do **not** add complexity here.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~GitHubPrEnricherCloseStateTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubPrEnricher.cs tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherCloseStateTests.cs
git commit -m "feat(inbox): enricher parses merged_at/closed_at from pulls/{n}"
```

---

### Task 2b: Populate `HeadSha` defensively on the enricher path

The spec (§ 3.3) prefers populating `HeadSha` from `head.sha` (still returned after branch deletion) so the empty-`HeadSha` special case shrinks. The enricher already reads `head.sha`; confirm it does not blank it on merged PRs. No code change expected — this is a **verification step** folded into Task 2's review.

- [ ] **Step 1:** Add an assertion to the Task 2 merged-PR test: `result[0].HeadSha.Should().Be("abc");`. Run it. If it passes (it should — `head.sha` is read unconditionally at `GitHubPrEnricher.cs:68`), no change. If GitHub returns an empty `head.sha` in some merged shape, document it in the spec's deferrals sidecar and rely on the Task 5 filter exemption. Commit any test addition with Task 2.

---

### Task 3: `ISectionQueryRunner.QueryClosedHistoryAsync` + GitHub implementation

**Files:**
- Modify: `PRism.Core/Inbox/ISectionQueryRunner.cs`
- Modify: `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs`
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs` (extend)

Two `is:closed` participant searches, unioned by `PrReference`, with a server-computed `closed:>=<cutoff>` clause. The cutoff comes from an injected clock seam so it is testable.

- [ ] **Step 1: Write the failing test**

Extend `tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs`. Capture the request URIs so we can assert both sub-queries fire with the right cutoff. Use the existing test's handler pattern; this self-contained version works if none exists:

```csharp
[Fact]
public async Task QueryClosedHistory_FiresBothSubQueries_WithCutoff_AndDedupesByRef()
{
    var captured = new List<string>();
    // Search returns one shared PR (#1) in both sub-queries + one unique each (#2 involves, #3 reviewed).
    string Body(int[] numbers) => "{\"items\":[" + string.Join(",", numbers.Select(n =>
        $"{{\"title\":\"PR {n}\",\"user\":{{\"login\":\"a\"}},\"updated_at\":\"2026-05-20T00:00:00Z\",\"comments\":0,\"pull_request\":{{\"html_url\":\"https://github.com/acme/api/pull/{n}\"}}}}")) + "]}";

    var handler = new DelegateHandler(req =>
    {
        captured.Add(req.RequestUri!.ToString());
        var q = Uri.UnescapeDataString(req.RequestUri!.Query);
        var nums = q.Contains("involves:@me") ? new[] { 1, 2 } : new[] { 1, 3 };
        return new HttpResponseMessage(HttpStatusCode.OK)
        { Content = new StringContent(Body(nums), Encoding.UTF8, "application/json") };
    });

    var clock = () => DateTimeOffset.Parse("2026-06-02T00:00:00Z");
    var runner = new GitHubSectionQueryRunner(new StubFactory(handler), () => Task.FromResult<string?>("t"), clock);

    var result = await runner.QueryClosedHistoryAsync(windowDays: 14, default);

    // 3 distinct PRs (#1 deduped from the two searches).
    result.Select(r => r.Reference.Number).Should().BeEquivalentTo(new[] { 1, 2, 3 });
    captured.Should().HaveCount(2);
    captured.Should().Contain(u => u.Contains("involves%3A%40me") || u.Contains("involves:@me"));
    captured.Should().Contain(u => u.Contains("reviewed-by%3A%40me") || u.Contains("reviewed-by:@me"));
    // cutoff = 2026-06-02 − 14d = 2026-05-19
    captured.Should().OnlyContain(u => u.Contains("closed%3A%3E%3D2026-05-19") || u.Contains("closed:>=2026-05-19"));
}
```

Add the `DelegateHandler` + `StubFactory` helpers to the test file if not already present (same shape as Task 2's `CannedHandler`/`StubFactory`, but `DelegateHandler` takes a `Func<HttpRequestMessage, HttpResponseMessage>`).

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~GitHubSectionQueryRunnerTests.QueryClosedHistory"`
Expected: COMPILE FAIL — no `QueryClosedHistoryAsync`, and the constructor takes no clock.

- [ ] **Step 3: Extend the interface**

`PRism.Core/Inbox/ISectionQueryRunner.cs`:

```csharp
namespace PRism.Core.Inbox;

public interface ISectionQueryRunner
{
    Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
        IReadOnlySet<string> visibleSectionIds,
        CancellationToken ct);

    /// <summary>
    /// Runs the closed-history participant searches (involves + reviewed-by, is:closed,
    /// closed:&gt;=today−windowDays), unions + dedupes by PrReference. Returns raw items
    /// WITHOUT close-state — the orchestrator enriches them for MergedAt/ClosedAt.
    /// </summary>
    Task<IReadOnlyList<RawPrInboxItem>> QueryClosedHistoryAsync(int windowDays, CancellationToken ct);
}
```

- [ ] **Step 4: Implement in `GitHubSectionQueryRunner`**

`PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs` — add a clock field + constructor param (the existing ctor takes `(IHttpClientFactory, Func<Task<string?>>, ILogger?)`; insert the clock before the logger — the one production call site in `ServiceCollectionExtensions.cs` is updated in Task 7, and the test `BuildSut` in Step 5). New ctor:

```csharp
    private readonly Func<DateTimeOffset> _clock;

    public GitHubSectionQueryRunner(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        Func<DateTimeOffset> clock,
        ILogger<GitHubSectionQueryRunner>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _clock = clock;
        _log = log ?? NullLogger<GitHubSectionQueryRunner>.Instance;
    }
```

Add the method (reuses the existing private `SearchAsync(string q, string? token, CancellationToken ct)`):

```csharp
    public async Task<IReadOnlyList<RawPrInboxItem>> QueryClosedHistoryAsync(
        int windowDays, CancellationToken ct)
    {
        var cutoff = _clock().UtcDateTime.Date.AddDays(-windowDays)
            .ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        var token = await _readToken().ConfigureAwait(false);

        var queries = new[]
        {
            $"is:pr is:closed involves:@me closed:>={cutoff} archived:false",
            $"is:pr is:closed reviewed-by:@me closed:>={cutoff} archived:false",
        };

        var lists = await Task.WhenAll(queries.Select(async q =>
        {
            try { return (IReadOnlyList<RawPrInboxItem>)await SearchAsync(q, token, ct).ConfigureAwait(false); }
#pragma warning disable CA1031 // per-sub-query isolation, matches QueryAllAsync
            catch (Exception ex) when (ex is not OperationCanceledException && ex is not RateLimitExceededException)
#pragma warning restore CA1031
            {
                Log.SectionQueryFailed(_log, ex, "recently-closed");
                return Array.Empty<RawPrInboxItem>();
            }
        })).ConfigureAwait(false);

        // Union + dedup by reference (a PR matching both sub-queries appears once).
        return lists.SelectMany(l => l)
            .GroupBy(r => r.Reference)
            .Select(g => g.First())
            .ToList();
    }
```

> `SearchAsync` already constructs `RawPrInboxItem` with `MergedAt`/`ClosedAt` defaulting to null (Task 1) — close-state arrives in Task 5's enrichment, not here. Sorting/capping is the orchestrator's job (it needs the enriched timestamps).

- [ ] **Step 5: Run test to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~GitHubSectionQueryRunnerTests.QueryClosedHistory"`
Expected: PASS. (Other `GitHubSectionQueryRunnerTests` may now fail to compile if they construct the runner with the old 3-arg ctor — update those call sites to pass `() => DateTimeOffset.UtcNow` as the clock. Re-run the full file.)

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Inbox/ISectionQueryRunner.cs PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs
git commit -m "feat(inbox): QueryClosedHistoryAsync — two is:closed participant searches with clock-seam cutoff"
```

---

### Task 4: History constants

**Files:**
- Create: `PRism.Core/Inbox/InboxHistoryConstants.cs`
- Test: covered by Task 5 (constants asserted via the section's behavior).

- [ ] **Step 1: Create the constants**

`PRism.Core/Inbox/InboxHistoryConstants.cs`:

```csharp
namespace PRism.Core.Inbox;

/// <summary>
/// Hardcoded bounds for the recently-closed inbox section (spec § 2 — not config:
/// ConfigStore.PatchAsync has no Int type, so these stay constants until one exists).
/// </summary>
public static class InboxHistoryConstants
{
    public const int HistoryWindowDays = 14;
    public const int MaxHistoryRows = 30;
    public const string SectionId = "recently-closed";
}
```

- [ ] **Step 2: Commit**

```bash
git add PRism.Core/Inbox/InboxHistoryConstants.cs
git commit -m "feat(inbox): recently-closed window/cap constants"
```

---

### Task 5: Orchestrator closed-history branch (sort, cap, no HeadSha filter)

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`
- Test: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` (extend)

The branch: when `recently-closed` is enabled, call `QueryClosedHistoryAsync`, fold the items into the shared enrichment pass (so they get `MergedAt`/`ClosedAt`), then build the section — sorted by `MergedAt ?? ClosedAt` desc, capped at `MaxHistoryRows`, materialized **without** the empty-`HeadSha` filter — and append it last.

- [ ] **Step 1: Write the failing tests**

Extend `InboxRefreshOrchestratorTests.cs`. The `FakeSectionQueryRunner` must now also implement `QueryClosedHistoryAsync`; update the fake:

```csharp
private sealed class FakeSectionQueryRunner : ISectionQueryRunner
{
    private readonly Func<IReadOnlySet<string>, IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> _factory;
    private readonly IReadOnlyList<RawPrInboxItem> _closed;
    public FakeSectionQueryRunner(
        Func<IReadOnlySet<string>, IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> factory,
        IReadOnlyList<RawPrInboxItem>? closed = null)
        { _factory = factory; _closed = closed ?? Array.Empty<RawPrInboxItem>(); }
    public Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
        IReadOnlySet<string> v, CancellationToken ct) => Task.FromResult(_factory(v));
    public Task<IReadOnlyList<RawPrInboxItem>> QueryClosedHistoryAsync(int windowDays, CancellationToken ct)
        => Task.FromResult(_closed);
}
```

Add a `RawClosed` helper and tests:

```csharp
private static RawPrInboxItem RawClosed(int n, DateTimeOffset? merged, DateTimeOffset? closed, string headSha = "")
    => new(Ref(n), $"PR #{n}", "author", "acme/api",
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, headSha, 1,
        MergedAt: merged, ClosedAt: closed);

[Fact]
public async Task RecentlyClosed_Enabled_AppendsSection_SortedByCloseDesc()
{
    var older = DateTimeOffset.Parse("2026-05-10T00:00:00Z");
    var newer = DateTimeOffset.Parse("2026-05-20T00:00:00Z");
    var orch = BuildOrchestrator(
        sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(),
        closed: new[] { RawClosed(1, older, older), RawClosed(2, newer, newer) },
        recentlyClosedEnabled: true);

    await orch.RefreshAsync(default);

    var sec = orch.Current!.Sections[InboxHistoryConstants.SectionId];
    sec.Select(i => i.Reference.Number).Should().Equal(2, 1); // newest first
    sec[0].MergedAt.Should().Be(newer);
}

[Fact]
public async Task RecentlyClosed_KeepsMergedPrWithEmptyHeadSha()
{
    var when = DateTimeOffset.Parse("2026-05-20T00:00:00Z");
    var orch = BuildOrchestrator(
        sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(),
        closed: new[] { RawClosed(7, when, when, headSha: "") }, // deleted-branch merged PR
        recentlyClosedEnabled: true);

    await orch.RefreshAsync(default);

    orch.Current!.Sections[InboxHistoryConstants.SectionId]
        .Select(i => i.Reference.Number).Should().Contain(7);
}

[Fact]
public async Task RecentlyClosed_CapsAtMaxRows_KeepingNewest()
{
    var rows = Enumerable.Range(1, InboxHistoryConstants.MaxHistoryRows + 5)
        .Select(i => RawClosed(i,
            merged: DateTimeOffset.Parse("2026-05-01T00:00:00Z").AddMinutes(i),
            closed: DateTimeOffset.Parse("2026-05-01T00:00:00Z").AddMinutes(i)))
        .ToArray();
    var orch = BuildOrchestrator(
        sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(),
        closed: rows, recentlyClosedEnabled: true);

    await orch.RefreshAsync(default);

    var sec = orch.Current!.Sections[InboxHistoryConstants.SectionId];
    sec.Should().HaveCount(InboxHistoryConstants.MaxHistoryRows);
    sec[0].Reference.Number.Should().Be(InboxHistoryConstants.MaxHistoryRows + 5); // newest kept
}

[Fact]
public async Task RecentlyClosed_Disabled_NoSection_AndNoQuery()
{
    var queried = false;
    var orch = BuildOrchestrator(
        sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(),
        closed: new[] { RawClosed(1, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow) },
        recentlyClosedEnabled: false,
        onClosedQueried: () => queried = true);

    await orch.RefreshAsync(default);

    orch.Current!.Sections.Should().NotContainKey(InboxHistoryConstants.SectionId);
    queried.Should().BeFalse();
}
```

You will need a `BuildOrchestrator(...)` helper that wires the fakes with a configurable `InboxSectionsConfig` (use the existing helper if present; add the `recentlyClosedEnabled` + `onClosedQueried` knobs). The config's `Inbox.Sections` must expose `RecentlyClosed` — which Task 6 adds; sequence Task 6 before running these, or stub the config so `RecentlyClosed` is set. **Implementation note for the worker:** do Task 6 and Task 5 together (Task 6 first), since the config field they share couples them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test --filter "FullyQualifiedName~InboxRefreshOrchestratorTests.RecentlyClosed"`
Expected: FAIL — no `recently-closed` section is produced.

- [ ] **Step 3: Implement the branch**

In `RefreshAsync`, after the existing open-section pipeline builds `rawWithEnrichment` and **before** the `MaterializePrInboxItem` projection (so the closed items can be enriched + materialized alongside), add the closed-history fetch into the shared enrichment input. Concretely:

1. Near the top of `RefreshAsync`, after `var raw = await _sections.QueryAllAsync(...)`, fetch closed history when enabled:

```csharp
            IReadOnlyList<RawPrInboxItem> closedRaw = Array.Empty<RawPrInboxItem>();
            if (_config.Current.Inbox.Sections.RecentlyClosed)
            {
                closedRaw = await _sections
                    .QueryClosedHistoryAsync(InboxHistoryConstants.HistoryWindowDays, ct)
                    .ConfigureAwait(false);
            }
```

2. Include `closedRaw` in the dedup-by-ref enrichment input:

```csharp
            var allRawDistinct = raw.Values.SelectMany(v => v).Concat(closedRaw)
                .GroupBy(p => p.Reference).Select(g => g.First()).ToList();
```

3. After `var deduped = _dedupe.Deduplicate(...)` (line 180), build a **new mutable dictionary** with the closed section appended, then thread it through the rest of the method.

> **Why a new dict (feasibility F1):** `IInboxDeduplicator.Deduplicate` returns `IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>>` (`IInboxDeduplicator.cs`), which has no indexer setter — `deduped["recently-closed"] = ...` is a compile error (CS0021). Its `deduplicate == false` / empty paths also return the caller's *input* instance, so casting-and-mutating is unsafe. Copy into a fresh dictionary.

```csharp
            // Append the closed-history section. Disjoint from the open sections, so it
            // bypasses InboxDeduplicator entirely (spec § 3.4) — added AFTER dedup. Copy
            // into a mutable dict because Deduplicate returns IReadOnlyDictionary.
            var sectionsFinal = deduped.ToDictionary(kv => kv.Key, kv => kv.Value);
            if (_config.Current.Inbox.Sections.RecentlyClosed)
            {
                var closedItems = (IReadOnlyList<PrInboxItem>)closedRaw
                    .Select(r => byRef.TryGetValue(r.Reference, out var e) ? e : r)
                    .Select(r => MaterializePrInboxItem(r, ciByRef, state))   // NO HeadSha filter
                    .OrderByDescending(i => i.MergedAt ?? i.ClosedAt ?? DateTimeOffset.MinValue)
                    .Take(InboxHistoryConstants.MaxHistoryRows)
                    .ToList();
                sectionsFinal[InboxHistoryConstants.SectionId] = closedItems;   // appended last
            }
```

4. **Rewire the three downstream consumers** from `deduped` to `sectionsFinal`:
- `var postDedupeTotal = sectionsFinal.Values.Sum(v => v.Count);` (was line 181)
- the AI-enrichment `var allItems = sectionsFinal.Values.SelectMany(v => v).DistinctBy(i => i.Reference).ToList();` (was line 193)
- `var newSnap = new InboxSnapshot(sectionsFinal, enrichmentMap, DateTimeOffset.UtcNow);` (was line 202)

> Appending after the open sections keeps `recently-closed` last in enumeration order (the insertion-order contract at `InboxRefreshOrchestrator.cs:157`). `MaterializePrInboxItem` (Task 7) carries `MergedAt`/`ClosedAt` through. The `DistinctBy(i => i.Reference)` in the AI-enrichment block already guards against any closed∩open collision, so no extra dedup is needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test --filter "FullyQualifiedName~InboxRefreshOrchestratorTests"`
Expected: PASS (all, including the existing open-section + dedup regression tests — confirm `InboxDeduplicator` behavior is untouched).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs
git commit -m "feat(inbox): orchestrator closed-history branch (sort/cap, no HeadSha filter, disjoint from dedup)"
```

---

### Task 6: Config — `RecentlyClosed` section toggle

**Files:**
- Modify: `PRism.Core/Config/AppConfig.cs`
- Modify: `PRism.Core/Config/ConfigStore.cs`
- Test: `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs` (extend)

> Do this **before** Task 5's test run (shared `RecentlyClosed` field).

- [ ] **Step 1: Write the failing test**

Extend the dotted-path patch tests:

```csharp
[Fact]
public async Task PatchAsync_RecentlyClosed_TogglesSection()
{
    var store = NewStoreWithDefaults(); // use the file's existing factory helper
    await store.PatchAsync("inbox.sections.recentlyClosed", false, default);
    store.Current.Inbox.Sections.RecentlyClosed.Should().BeFalse();
}

[Fact]
public void Default_RecentlyClosed_IsTrue()
{
    AppConfig.Default.Inbox.Sections.RecentlyClosed.Should().BeTrue();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests.PatchAsync_RecentlyClosed"`
Expected: COMPILE FAIL — no `RecentlyClosed`.

- [ ] **Step 3: Add the field + allowlist + patch case**

`PRism.Core/Config/AppConfig.cs` — extend the record + default:

```csharp
public sealed record InboxSectionsConfig(
    bool ReviewRequested,
    bool AwaitingAuthor,
    bool AuthoredByMe,
    bool Mentioned,
    bool CiFailing,
    bool RecentlyClosed = true);
```

In `AppConfig.Default` (`AppConfig.cs:20`), pass the sixth arg **explicitly** (don't rely on the param default — that couples `Default`'s correctness to the `= true` default and silently breaks if someone later makes the param required):

```csharp
new InboxConfig(true, new InboxSectionsConfig(true, true, true, true, true, true), true),
```

`PRism.Core/Config/ConfigStore.cs` — add to the expected-type allowlist table (near line 42):

```csharp
            ["inbox.sections.recently-closed"]   = ConfigFieldType.Bool,
```

> **Wire-key spelling:** keep the dotted path kebab-case (`recently-closed`) to match the other section keys and the section id. The test above used `recentlyClosed`; **change the test to `inbox.sections.recently-closed`** to match the allowlist convention (the existing keys are all kebab). Update both the allowlist key and the test to `recently-closed`.

Add to the `PatchAsync` switch (near line 149):

```csharp
                "inbox.sections.recently-closed" =>
                    _current with { Inbox = _current.Inbox with { Sections = sections with { RecentlyClosed = (bool)value! } } },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/AppConfig.cs PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs
git commit -m "feat(config): inbox.sections.recently-closed toggle (default true)"
```

---

### Task 6b: Surface `RecentlyClosed` in the `/api/preferences` DTO (read path)

**Files:**
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs`
- Modify: `PRism.Web/Endpoints/PreferencesEndpoints.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` (extend)

> **Feasibility F3 (blocker):** `/api/preferences` does **not** auto-serialize `InboxSectionsConfig` — it hand-projects into `InboxSectionsDto`, which enumerates exactly five keys with explicit kebab `[JsonPropertyName]`. Without this task, the config field exists but the GET response omits it, and Task 11's Settings toggle reads `undefined` (renders off regardless of the real default, never reflects persisted state). This must land **before** Task 11.

- [ ] **Step 1: Write the failing test**

Extend `PreferencesEndpointsTests` (mirror its existing inbox-sections shape assertion):

```csharp
[Fact]
public async Task GetPreferences_IncludesRecentlyClosed_DefaultTrue()
{
    // GET /api/preferences against a default-config factory
    // assert the JSON has inbox.sections["recently-closed"] == true
    var json = await GetPreferencesJson(); // use the file's existing helper
    json.GetProperty("inbox").GetProperty("sections")
        .GetProperty("recently-closed").GetBoolean().Should().BeTrue();
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~PreferencesEndpointsTests.GetPreferences_IncludesRecentlyClosed"`
Expected: FAIL — key absent (KeyNotFound / property missing).

- [ ] **Step 3: Add the field to the DTO + projection**

`PRism.Web/Endpoints/PreferencesDtos.cs` — add to `InboxSectionsDto` (kebab is **not** the default policy, so the explicit attribute is required):

```csharp
internal sealed record InboxSectionsDto(
    [property: JsonPropertyName("review-requested")] bool ReviewRequested,
    [property: JsonPropertyName("awaiting-author")]  bool AwaitingAuthor,
    [property: JsonPropertyName("authored-by-me")]   bool AuthoredByMe,
    bool Mentioned,
    [property: JsonPropertyName("ci-failing")]       bool CiFailing,
    [property: JsonPropertyName("recently-closed")]  bool RecentlyClosed);
```

`PRism.Web/Endpoints/PreferencesEndpoints.cs` — `BuildResponse` projection (~line 64):

```csharp
            Inbox: new InboxPreferencesDto(new InboxSectionsDto(
                ReviewRequested: sections.ReviewRequested,
                AwaitingAuthor:  sections.AwaitingAuthor,
                AuthoredByMe:    sections.AuthoredByMe,
                Mentioned:       sections.Mentioned,
                CiFailing:       sections.CiFailing,
                RecentlyClosed:  sections.RecentlyClosed)),
```

- [ ] **Step 4: Run to verify it passes + commit**

Run: `dotnet test --filter "FullyQualifiedName~PreferencesEndpointsTests"`
Expected: PASS.

```bash
git add PRism.Web/Endpoints/PreferencesDtos.cs PRism.Web/Endpoints/PreferencesEndpoints.cs tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs
git commit -m "feat(prefs): surface recently-closed in the /api/preferences DTO"
```

---

### Task 7: Carry close-state through `MaterializePrInboxItem` + wire the clock seam

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` (`MaterializePrInboxItem`)
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` (clock seam DI — **not** `Program.cs`)
- Test: covered by Task 5's `sec[0].MergedAt.Should().Be(newer)` assertion.

- [ ] **Step 1: Extend `MaterializePrInboxItem`**

`InboxRefreshOrchestrator.cs` — the `return new PrInboxItem(...)` must pass the close-state through:

```csharp
        return new PrInboxItem(
            r.Reference, r.Title, r.Author, r.Repo,
            r.UpdatedAt, r.PushedAt,
            r.IterationNumberApprox, r.CommentCount,
            r.Additions, r.Deletions, r.HeadSha, ci,
            lastViewedHeadSha, lastSeenCommentId,
            r.MergedAt, r.ClosedAt);
```

- [ ] **Step 2: Wire the clock into `GitHubSectionQueryRunner` registration**

The `ISectionQueryRunner` registration lives in `PRism.GitHub/ServiceCollectionExtensions.cs:56-64` (**not** `Program.cs` — `grep -n "SectionQueryRunner" PRism.Web/Program.cs` returns nothing). Insert the clock as the third arg, before the logger, matching the new ctor order (Task 3):

```csharp
        services.AddSingleton<ISectionQueryRunner>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubSectionQueryRunner(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                () => DateTimeOffset.UtcNow,
                sp.GetRequiredService<ILogger<GitHubSectionQueryRunner>>());
        });
```

> The real `readToken` delegate is `() => tokens.ReadAsync(CancellationToken.None)` — copy it verbatim. The clock is `() => DateTimeOffset.UtcNow` in production; tests inject a fixed clock.

- [ ] **Step 3: Run the full backend suite**

Run: `dotnet test PRism.sln --configuration Release`
Expected: PASS (all). This is the Task-5 assertions going green end-to-end + no regressions.

- [ ] **Step 4: Commit**

```bash
git add PRism.Core/Inbox/InboxRefreshOrchestrator.cs PRism.GitHub/ServiceCollectionExtensions.cs
git commit -m "feat(inbox): thread close-state through materialize + wire clock seam"
```

---

### Task 8: `recently-closed` label in the inbox endpoint

**Files:**
- Modify: `PRism.Web/Endpoints/InboxEndpoints.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/InboxEndpointsTests.cs` (extend, optional)

- [ ] **Step 1: Add the label**

`InboxEndpoints.cs` — add to the `Labels` dictionary:

```csharp
        ["recently-closed"]  = "Recently closed",
```

> `PrInboxItem` serializes `MergedAt`/`ClosedAt` automatically (record properties). No DTO change needed. The section flows through `/api/inbox` as a generic `InboxSectionDto`.

- [ ] **Step 2: Run + commit**

Run: `dotnet test --filter "FullyQualifiedName~InboxEndpointsTests"`
Expected: PASS.

```bash
git add PRism.Web/Endpoints/InboxEndpoints.cs
git commit -m "feat(inbox): label for the recently-closed section"
```

- [ ] **Step 3: PR1 gate — full suite + manual smoke**

Run: `dotnet test PRism.sln --configuration Release` (all green). PR1 is shippable: `/api/inbox` returns a `recently-closed` section the generic FE already renders. Open the PR per `pr-autopilot`.

---

# Phase B — Frontend section (PR2)

### Task 9: Frontend types — close-state + section preference

**Files:**
- Modify: `frontend/src/api/types.ts`
- Test: type-only; covered by Task 10/11 component tests.

- [ ] **Step 1: Extend `PrInboxItem` + `InboxSectionsPreferences`**

`frontend/src/api/types.ts`:

```typescript
export interface PrInboxItem {
  reference: PrReference;
  title: string;
  author: string;
  repo: string;
  updatedAt: string;
  pushedAt: string;
  iterationNumber: number;
  commentCount: number;
  additions: number;
  deletions: number;
  headSha: string;
  ci: CiStatus;
  lastViewedHeadSha: string | null;
  lastSeenCommentId: number | null;
  mergedAt: string | null;
  closedAt: string | null;
}
```

```typescript
export interface InboxSectionsPreferences {
  'review-requested': boolean;
  'awaiting-author': boolean;
  'authored-by-me': boolean;
  mentioned: boolean;
  'ci-failing': boolean;
  'recently-closed': boolean;
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd frontend && npm run build` (tsc). Expected: no type errors. (Existing test mocks of `PrInboxItem` may need `mergedAt: null, closedAt: null` — fix any that fail in Task 10.)

```bash
git add frontend/src/api/types.ts
git commit -m "feat(inbox): frontend types for close-state + recently-closed preference"
```

---

### Task 10: `recently-closed` section UI — collapsed, badge, suppressed urgency, truncation hint

**Files:**
- Modify: `frontend/src/components/Inbox/InboxSection.tsx`
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Create: `frontend/src/components/Inbox/RecentlyClosedFooter.tsx`
- Modify: `frontend/src/pages/InboxPage.tsx`
- Test: `frontend/src/components/Inbox/InboxSection.test.tsx`, `InboxRow.test.tsx` (create/extend)

- [ ] **Step 1: Write the failing tests**

`frontend/src/components/Inbox/InboxRow.test.tsx` (extend or create):

```typescript
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InboxRow } from './InboxRow';
import type { PrInboxItem } from '../../api/types';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';

const base: PrInboxItem = {
  reference: { owner: 'acme', repo: 'api', number: 1 },
  title: 'T', author: 'a', repo: 'acme/api', updatedAt: new Date().toISOString(),
  pushedAt: new Date().toISOString(), iterationNumber: 1, commentCount: 0,
  additions: 0, deletions: 0, headSha: 'sha', ci: 'none',
  lastViewedHeadSha: null, lastSeenCommentId: null, mergedAt: null, closedAt: null,
};

function renderRow(pr: PrInboxItem) {
  return render(
    <MemoryRouter><OpenTabsProvider><InboxRow pr={pr} showCategoryChip={false} maxDiff={1} /></OpenTabsProvider></MemoryRouter>,
  );
}

it('shows a Merged badge for a merged row', () => {
  renderRow({ ...base, mergedAt: '2026-05-20T00:00:00Z', closedAt: '2026-05-20T00:00:00Z' });
  expect(screen.getByText('Merged')).toBeInTheDocument();
});

it('shows a Closed badge for a closed-unmerged row', () => {
  renderRow({ ...base, mergedAt: null, closedAt: '2026-05-21T00:00:00Z' });
  expect(screen.getByText('Closed')).toBeInTheDocument();
});

it('does not show the New chip on a closed row even when never viewed', () => {
  renderRow({ ...base, mergedAt: '2026-05-20T00:00:00Z', closedAt: '2026-05-20T00:00:00Z', lastViewedHeadSha: null });
  expect(screen.queryByText('New')).not.toBeInTheDocument();
});
```

`frontend/src/components/Inbox/InboxSection.test.tsx`:

```typescript
it('recently-closed section is collapsed by default', () => {
  // render InboxSection with section.id='recently-closed' and defaultOpen={false}
  // assert the body (rows / empty copy) is NOT in the document, and aria-expanded is false
});
it('open sections remain expanded by default', () => {
  // render with defaultOpen omitted; assert body IS present
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npm test -- InboxRow InboxSection`
Expected: FAIL — no badge, New chip still shows, no `defaultOpen`.

- [ ] **Step 3: Implement `InboxRow` badge + suppression**

`InboxRow.tsx` — derive done-state, render a text-primary badge, suppress the New chip + force neutral freshness:

```typescript
export function InboxRow({ pr, enrichment, showCategoryChip, maxDiff }: Props) {
  const navigate = useNavigate();
  const { addTab } = useOpenTabs();
  const isDone = pr.mergedAt != null || pr.closedAt != null;
  const fr = isDone ? 'older' : freshness(pr.updatedAt);
  const isFirstVisit = !isDone && pr.lastViewedHeadSha == null;
  // ...onClick unchanged...
  const frClass =
    fr === 'fresh' ? styles.rowFresh : fr === 'today' ? styles.rowToday : styles.rowOlder;
  const doneState = pr.mergedAt != null ? 'merged' : pr.closedAt != null ? 'closed' : null;

  return (
    <button
      className={`${styles.row} ${frClass}`}
      onClick={onClick}
      aria-label={`${pr.title} · ${pr.repo}${doneState ? ` · ${doneState}` : ` · iteration ${pr.iterationNumber}`}`}
    >
      <span className={styles.status}>
        {pr.ci === 'failing' && !isDone ? (
          <span className={`${styles.dot} ${styles.dotDanger}`} title="CI failing" />
        ) : isFirstVisit ? (
          <span className={styles.newChip}>New</span>
        ) : (
          <span className={styles.dot} style={{ opacity: 0 }} aria-hidden="true" />
        )}
      </span>
      {/* main unchanged */}
      <span className={styles.tail}>
        {doneState && (
          <span className={`${styles.stateBadge} ${doneState === 'merged' ? styles.badgeMerged : styles.badgeClosed}`}>
            {doneState === 'merged' ? 'Merged' : 'Closed'}
          </span>
        )}
        {/* category chip / diffbar / counts / comments unchanged */}
      </span>
    </button>
  );
}
```

Add `.stateBadge`, `.badgeMerged`, `.badgeClosed` to `InboxRow.module.css` (text-primary, color is secondary — e.g. merged = purple text, closed = red text, both with a visible word).

- [ ] **Step 4: Implement `InboxSection` `defaultOpen` + empty copy + footer**

`InboxSection.tsx`:

```typescript
const EmptyCopy: Record<string, string> = {
  'review-requested': 'No reviews requested right now.',
  'awaiting-author': 'Nothing waiting on the author.',
  'authored-by-me': "You haven't opened any PRs.",
  mentioned: "You aren't @-mentioned on any open PRs.",
  'ci-failing': 'No CI failures on your PRs — nice.',
  'recently-closed': 'No PRs closed in the last 14 days.',
};

interface Props {
  section: InboxSectionDto;
  enrichments: Record<string, InboxItemEnrichment>;
  showCategoryChip: boolean;
  maxDiff: number;
  defaultOpen?: boolean;
}

export function InboxSection({ section, enrichments, showCategoryChip, maxDiff, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const truncated = section.id === 'recently-closed' && section.items.length >= 30;
  // ...header unchanged...
  // inside the open body, after the rows .map(...), add:
  //   {truncated && <RecentlyClosedFooter />}
}
```

Create `frontend/src/components/Inbox/RecentlyClosedFooter.tsx`:

```typescript
import styles from './InboxSection.module.css';

export function RecentlyClosedFooter() {
  return (
    <div className={styles.truncationHint}>
      Showing the 30 most recent — older closed PRs aren't listed. Paste a URL above to open one.
    </div>
  );
}
```

> The cap is 30 (`InboxHistoryConstants.MaxHistoryRows`); `>= 30` is the truncation signal (the backend never returns more than 30, so `=== 30` means "cap likely hit"). This is an approximation — the backend could legitimately return exactly 30 — accepted per spec § 3.2 (the hint is advisory, not a guarantee).

- [ ] **Step 5: Pass `defaultOpen={false}` for `recently-closed` in `InboxPage`**

`InboxPage.tsx` — in the `sections.map`:

```typescript
            <InboxSection
              key={s.id}
              section={s}
              enrichments={data.enrichments}
              showCategoryChip={showCategoryChip}
              maxDiff={maxDiff}
              defaultOpen={s.id !== 'recently-closed'}
            />
```

- [ ] **Step 6: Run tests + prettier + lint**

Run: `cd frontend && npm test -- InboxRow InboxSection` → PASS.
Run: `npm run prettier --write src/components/Inbox/RecentlyClosedFooter.tsx` (and any other new/changed FE files) before staging.
Run: `npm run lint && npm run build` → clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Inbox/ frontend/src/pages/InboxPage.tsx
git commit -m "feat(inbox): recently-closed section UI — collapsed, merged/closed badge, suppressed urgency, truncation hint"
```

---

### Task 11: Settings toggle for `recently-closed`

> **Depends on Task 6b** (the backend `/api/preferences` must emit `recently-closed`, else this toggle binds to `undefined`). 6b ships in PR1; this is PR2.

**Files:**
- Modify: the Settings inbox-sections component (grep `inbox.sections` under `frontend/src/components/Settings`)
- Modify: `frontend/src/api/types.ts` already done (Task 9)
- Test: extend the existing Settings inbox-sections test.

- [ ] **Step 1: Write the failing test**

Find the Settings test that renders the section toggles (grep `ci-failing` under `frontend/src/components/Settings` + `*.test.tsx`). Add:

```typescript
it('renders a Recently closed toggle and patches inbox.sections.recently-closed', async () => {
  // render the SettingsInboxSections (or equivalent), find the "Recently closed" switch,
  // toggle it, assert the patch helper was called with key 'inbox.sections.recently-closed'.
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- Settings`
Expected: FAIL — no Recently closed toggle.

- [ ] **Step 3: Add the toggle**

In the Settings inbox-sections component, add a row for `recently-closed` mirroring the existing five (label "Recently closed", bound to `preferences.inbox.sections['recently-closed']`, patches `inbox.sections.recently-closed`).

- [ ] **Step 4: Run + prettier + lint + commit**

Run: `cd frontend && npm test -- Settings` → PASS. `npm run lint && npm run build` → clean.

```bash
git add frontend/src/components/Settings/
git commit -m "feat(settings): recently-closed section toggle"
```

- [ ] **Step 5: PR2 gate** — `npm test` (full) + `npm run lint` + `npm run build` all green; backend untouched. Ship PR2.

---

# Phase C — Read-only detail gaps (PR3)

### Task 12: Surface `mergedAt`/`closedAt` on the `Pr` contract

**Files:**
- Modify: `PRism.Core.Contracts/Pr.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs` (`ParsePr`)
- Modify: `frontend/src/api/types.ts` (`Pr`)
- Test: `tests/PRism.GitHub.Tests/...` ParsePr test (extend)

The GraphQL query already selects `closedAt`/`mergedAt` (`GitHubReviewService.cs:25`) but `ParsePr` discards the values. Surface them.

- [ ] **Step 1: Write the failing test**

Find the existing `ParsePr` test (grep `ParsePr` or `IsMerged` under `tests/PRism.GitHub.Tests`). Add an assertion that a merged-PR GraphQL fixture yields `pr.MergedAt != null` and a closed-unmerged fixture yields `pr.ClosedAt != null, pr.MergedAt == null`.

- [ ] **Step 2: Run to verify it fails**

Expected: COMPILE FAIL — `Pr` has no `MergedAt`/`ClosedAt`.

- [ ] **Step 3: Add the fields + parse**

`PRism.Core.Contracts/Pr.cs` — append optional trailing params:

```csharp
public sealed record Pr(
    PrReference Reference,
    string Title,
    string Body,
    string Author,
    string State,
    string HeadSha,
    string BaseSha,
    string HeadBranch,
    string BaseBranch,
    string Mergeability,
    string CiSummary,
    bool IsMerged,
    bool IsClosed,
    DateTimeOffset OpenedAt,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null);
```

`GitHubReviewService.cs` `ParsePr` — add parses (reuse the file's `GetDate`/`TryGetProperty` idiom) and pass them:

```csharp
        DateTimeOffset? mergedAt = pull.TryGetProperty("mergedAt", out var mAt) && mAt.ValueKind != JsonValueKind.Null
            ? mAt.GetDateTimeOffset() : null;
        DateTimeOffset? closedAt = pull.TryGetProperty("closedAt", out var cAt) && cAt.ValueKind != JsonValueKind.Null
            ? cAt.GetDateTimeOffset() : null;
        // ...add to the return new Pr(...): MergedAt: mergedAt, ClosedAt: closedAt
```

`frontend/src/api/types.ts` — add to the `Pr` interface (find it; it has `isMerged`/`isClosed` near line 151):

```typescript
  mergedAt: string | null;
  closedAt: string | null;
```

- [ ] **Step 4: Run + commit**

Run: `dotnet test --filter "FullyQualifiedName~ParsePr"` → PASS. `cd frontend && npm run build` → clean.

```bash
git add PRism.Core.Contracts/Pr.cs PRism.GitHub/GitHubReviewService.cs frontend/src/api/types.ts
git commit -m "feat(pr-detail): surface mergedAt/closedAt on the Pr contract"
```

---

### Task 13: Merged/closed header status label

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`
- Test: `frontend/src/components/PrDetail/PrHeader.test.tsx` (extend)

- [ ] **Step 1: Write the failing test**

```typescript
it('shows a Merged <when> label on a merged PR', () => {
  // render PrHeader with prState='merged' and a pr whose mergedAt is set
  // assert text matching /Merged/ appears
});
it('shows a Closed <when> label on a closed-unmerged PR', () => {
  // prState='closed', closedAt set → /Closed/ appears
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- PrHeader`
Expected: FAIL — no status label.

- [ ] **Step 3: Implement the label**

`PrHeader.tsx` — where `isClosedOrMerged` is computed (~line 112), render a status chip near the title. Use the existing relative-time helper if present (grep `formatAge`/`timeAgo` in the FE); else a minimal inline formatter:

```tsx
{prState === 'merged' && pr.mergedAt && (
  <span className={styles.statusMerged}>Merged {relativeTime(pr.mergedAt)}</span>
)}
{prState === 'closed' && pr.closedAt && (
  <span className={styles.statusClosed}>Closed {relativeTime(pr.closedAt)}</span>
)}
```

Add `.statusMerged`/`.statusClosed` to the header's CSS module (text-primary, consistent with the inbox badge). Thread `pr.mergedAt`/`pr.closedAt` into `PrHeaderProps` if the header doesn't already receive the full `Pr`.

- [ ] **Step 4: Run + prettier + commit**

Run: `cd frontend && npm test -- PrHeader` → PASS. prettier + lint clean.

```bash
git add frontend/src/components/PrDetail/PrHeader.tsx
git commit -m "feat(pr-detail): merged/closed status label in the header"
```

---

### Task 14: Read-only Drafts tab on done PRs

**Files:**
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftsTab.tsx`
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftListItem.tsx`
- Modify: the Drafts route that supplies props (grep `DraftsTab` usage)
- Test: `frontend/src/components/PrDetail/DraftsTab/DraftsTab.test.tsx` (extend)

- [ ] **Step 1: Write the failing test**

```typescript
it('suppresses Edit/Delete and renders selectable body when readOnly', () => {
  // render DraftsTab (or DraftListItem) with readOnly={true} and one draft
  // assert: no "Edit" button, no "Delete" button; the draft body text is present
});
it('renders Edit/Delete when not readOnly (regression)', () => {
  // readOnly omitted/false → buttons present
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- DraftsTab`
Expected: FAIL — buttons render unconditionally.

- [ ] **Step 3: Thread `readOnly` + suppress actions**

Add `readOnly?: boolean` to `DraftsTabProps` and `DraftListItemProps`. In `DraftListItem`, gate the action buttons:

```tsx
{!readOnly && (
  <>
    <button onClick={onEdit}>Edit</button>
    <button onClick={onDelete}>Delete</button>
  </>
)}
```

Render the body as selectable markdown text always (it already is — confirm it's not inside an editable control when `readOnly`). Suppress the "Discard all" affordance in this tab when `readOnly`. Wire `readOnly={prState !== 'open'}` from the Drafts route (it has access to `prDetail.pr` like `FilesTab` does — derive `prState` the same way).

> Per spec § 5.2.2 this is **local-only**: no remote `deletePullRequestReview`. Do not add any mutation here.

- [ ] **Step 4: Run + prettier + commit**

Run: `cd frontend && npm test -- DraftsTab` → PASS. prettier + lint clean.

```bash
git add frontend/src/components/PrDetail/DraftsTab/
git commit -m "feat(pr-detail): read-only Drafts tab on done PRs (local-only, no remote cleanup)"
```

---

### Task 15: Live merge/close transition banner

**Files:**
- Create: `frontend/src/components/PrDetail/BannerTransition.tsx`
- Modify: `frontend/src/pages/PrDetailPage.tsx` (render + supersede `BannerRefresh`)
- Test: `frontend/src/pages/PrDetailPage.transition.test.tsx` (create) or the banner reducer test

- [ ] **Step 1: Write the failing test**

```typescript
it('shows the transition banner and hides BannerRefresh when the PR becomes done', () => {
  // render PrDetailPage with a PrUpdated event flipping prState open→merged
  // assert: transition banner text "merged/closed ... Reload" present;
  //         the "N new updates" reload-banner (data-testid="reload-banner") absent
});
it('transition banner is not dismissible (no dismiss control)', () => {
  // assert no dismiss button on the transition banner
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- PrDetailPage.transition`
Expected: FAIL — no transition banner.

- [ ] **Step 3: Implement the banner + supersession**

Create `BannerTransition.tsx`:

```tsx
interface Props { state: 'merged' | 'closed'; onReload: () => void; }
export function BannerTransition({ state, onReload }: Props) {
  return (
    <div className="banner banner-warning" role="status">
      This PR was just {state}. Unsubmitted drafts can no longer be submitted.{' '}
      <button onClick={onReload}>Reload to read-only view</button>
    </div>
  );
}
```

`PrDetailPage.tsx` — detect the transition (the page already knows `data.pr.isMerged/isClosed` and receives `PrUpdated`; track whether the PR flipped to done since mount). Render `BannerTransition` in the same slot as `BannerRefresh`, and when the transition banner is active, do **not** render `BannerRefresh` (its message is a superset). Reload triggers the existing detail refetch.

> Use the existing `PrUpdated` SSE wiring (grep `PrUpdated` / `useActivePrUpdates` in the FE). Do not add a new poller.

- [ ] **Step 4: Run + prettier + commit**

Run: `cd frontend && npm test -- PrDetailPage` → PASS. prettier + lint clean.

```bash
git add frontend/src/components/PrDetail/BannerTransition.tsx frontend/src/pages/PrDetailPage.tsx
git commit -m "feat(pr-detail): live merge/close transition banner (supersedes reload banner)"
```

---

### Task 16: Diff-renders audit + primary-diff graceful failure

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.cs` (`PaginatePullsFilesAsync` typed failure) — only if the S3 handler is absent
- Test: `tests/PRism.GitHub.Tests/...` diff test (extend); Playwright audit spec

- [ ] **Step 1: Confirm the S3 `RangeUnreachableException` handler status**

Run: `grep -rn "RangeUnreachableException" PRism.Web` and `grep -rn "catch (RangeUnreachableException" PRism.GitHub`. Read the diff endpoint. Per spec § 5.1 / § 9: if a handler already maps it to a user-visible `ProblemDetails`, the cross-iteration path is done — only the primary-diff failure + Playwright assertions are net-new. Document the finding inline in the PR description.

- [ ] **Step 2: Write the failing test (primary diff 404 → typed result, not 500)**

```csharp
[Fact]
public async Task GetDiff_PrimaryFilesPath_404_ReturnsTypedUnavailable_NotThrow()
{
    // arrange a GitHubReviewService whose pulls/{n}/files returns 404
    // act + assert: GetDiffAsync surfaces a typed "diff unavailable" result
    // (or the documented graceful shape), NOT a raw HttpRequestException.
}
```

- [ ] **Step 3: Run to verify it fails, then implement**

If `PaginatePullsFilesAsync` currently calls `EnsureSuccessStatusCode()` on the primary path, map 404/410 to the same typed "unavailable" result the cross-iteration path uses. Keep the change minimal and mirror the existing `RangeUnreachableException` handling shape.

- [ ] **Step 4: Playwright read-only audit spec**

Create `frontend/e2e/recently-closed-readonly.spec.ts` (follow the existing real-flow spec patterns — absolute `http://localhost:5180/test/...` URLs for test hooks; `workers: 1` is already in `playwright.config.ts`):

```typescript
// Open a merged PR and a closed-unmerged PR (via fixtures / test hooks).
// Assert: (i) no inline-draft composer, reply composer, root composer, verdict picker, or Submit;
//         (ii) the diff and threads RENDER (file rows present, no error banner);
//         (iii) if unsubmitted drafts exist, the Drafts tab shows them read-only (no Edit/Delete).
```

> Reuse a frozen-PR fixture (PRs #1/#16/#19/#22/#28) that has an **intact repo + deleted head branch** if available (§ 9). The real-flow mid-view-merge transition e2e is **deferred** (sandbox PR that merges mid-session) — record in the deferrals sidecar.

- [ ] **Step 5: Run + commit**

Run: `dotnet test PRism.sln --configuration Release` → PASS. `cd frontend && npx playwright test recently-closed-readonly` → PASS (or document the deferred transition e2e).

```bash
git add PRism.GitHub/GitHubReviewService.cs frontend/e2e/recently-closed-readonly.spec.ts tests/
git commit -m "feat(pr-detail): primary-diff graceful failure + read-only audit e2e"
```

---

### Task 17: Deferrals sidecar + docs

**Files:**
- Create: `docs/specs/2026-06-02-merged-pr-history-deferrals.md`
- Modify: `docs/specs/README.md` (move the entry to Implemented + PR refs)
- Modify: `docs/roadmap.md` and/or `docs/backlog/05-P4-polish.md` (mark P4-D2 underway/done)

- [ ] **Step 1: Write the deferrals sidecar**

Record every deferred item with status: remote pending-review courtesy cleanup (with the safety requirements from spec § 5.2.2), the `review-requested:@me is:closed` sub-query (pending live verification), the `mergedBy` actor clause, the real-flow mid-view-merge Playwright e2e, and `windowDays`/`maxRows` config promotion. Each as a `[Defer]` entry naming the trigger to revisit.

- [ ] **Step 2: Update the docs index + backlog**

Per `.ai/docs/documentation-maintenance.md`: move the spec's `README.md` entry to the right group with PR references; note P4-D2 as in-progress/shipped in the backlog.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: merged-pr-history deferrals sidecar + index/backlog updates"
```

- [ ] **Step 4: PR3 gate** — full backend suite + frontend test + lint + build + Playwright all green. Ship PR3.

---

## Self-Review (completed during planning)

**Spec coverage:**
- § 3.1 two sub-queries + clock cutoff → Task 3. ✓
- § 3.2 union/dedup/sort/cap + truncation hint → Tasks 3 (union/dedup), 5 (sort/cap), 10 (hint). ✓
- § 3.3 close-state threading + REST enricher + HeadSha exemption + badge + suppressed urgency → Tasks 1, 2, 5, 10. ✓
- § 3.1 REST fan-out (shared semaphore) → existing `GitHubPrEnricher` cap-8 reused (Task 5 routes closed items through the same `EnrichAsync`); no second burst. ✓
- § 3.4 disjoint from `InboxDeduplicator` → Task 5 (appended after dedup) + regression test. ✓
- § 3.5 collapsed-default, load model, empty copy, hide toggle → Tasks 10, 6, 11. ✓
- § 5.1 diff-renders audit + primary/cross-iteration split → Task 16. ✓
- § 5.2.1 header label (timestamp only) → Tasks 12, 13. ✓
- § 5.2.2 read-only Drafts tab, local-only (remote cleanup deferred) → Task 14 + Task 17 deferral. ✓
- § 5.2.3 transition banner supersedes BannerRefresh → Task 15. ✓
- § 8 tests → woven per task; frozen-PR reuse → Task 16. ✓
- Config (bool toggle, constants not int config) → Tasks 4, 6; `/api/preferences` read path → Task 6b (feasibility F3). ✓

**Placeholder scan:** no "TBD"/"handle errors"/"similar to" — each step carries code or an exact command. The few "grep to find X" steps are deliberate (locating an existing call site whose exact line drifts), each with the search command + what to change.

**Type consistency:** `MergedAt`/`ClosedAt` (C# `DateTimeOffset?`) ↔ `mergedAt`/`closedAt` (TS `string | null`); section id `recently-closed` consistent across constant, config key, label, FE; `RecentlyClosed` config field consistent across record/default/allowlist/patch/FE preference; `QueryClosedHistoryAsync(int windowDays, ct)` consistent across interface, impl, fake, orchestrator call.
