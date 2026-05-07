# S2 — Inbox (read) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working five-section GitHub inbox with a 120s background poller, SSE-driven update banner, URL-paste escape hatch (routing to a temporary S3 stub), AI category chips, and a hand-canned activity rail — implementing the design at [`docs/superpowers/specs/2026-05-06-inbox-read-design.md`](../specs/2026-05-06-inbox-read-design.md).

**Architecture:** Backend pipeline of small components — `ISectionQueryRunner` → per-PR fan-out filters (`IAwaitingAuthorFilter`, `ICiFailingDetector`) → `IInboxDeduplicator` → `IInboxItemEnricher` (drift-corrected AI seam) — wired by `InboxRefreshOrchestrator` and driven by an `InboxPoller : BackgroundService` gated on SSE subscriber count. SSE delivered via `/api/events`. Frontend mirrors the design handoff: collapsible sections, paste-URL input, banner, hand-canned activity rail.

**Tech Stack:** .NET 10 + ASP.NET Core minimal APIs (xUnit + FluentAssertions + Moq) · React 19 + Vite 6 + TypeScript 5 (Vitest + Testing Library + MSW) · Playwright E2E · `windows-latest` CI.

---

## Pre-flight: environment

The repo targets `net10.0`. Confirm a .NET 10 SDK is on `PATH` before starting; on this machine only 8 + 9 are installed and tests will refuse to run.

- [ ] **Step 0.1: Verify .NET SDK**

Run: `dotnet --list-sdks`
Expected: a `10.0.x` entry exists.
If missing: install via `winget install Microsoft.DotNet.SDK.10` (Windows) or download from https://dotnet.microsoft.com/download/dotnet/10.0.

- [ ] **Step 0.2: Verify baseline green**

Run from worktree root:
```
npm --prefix frontend ci
npm --prefix frontend run build
dotnet test
```
Expected: frontend build clean; all existing .NET tests pass. If anything fails: stop and investigate before any feature work.

---

## Phase 1 — AI seam drift correction (one commit)

The existing `IInboxEnricher` has a single-PR signature; the spec mandates a batched signature. No consumer exists yet, so this is mechanical. Reconcile in one commit before any S2 consumer wires up.

### Task 1.1: Rename interface + DTO + impls + DI + the one existing test

**Files:**
- Delete: `PRism.AI.Contracts/Seams/IInboxEnricher.cs`
- Delete: `PRism.AI.Contracts/Dtos/InboxEnrichment.cs`
- Delete: `PRism.AI.Contracts/Noop/NoopInboxEnricher.cs`
- Delete: `PRism.AI.Placeholder/PlaceholderInboxEnricher.cs`
- Create: `PRism.AI.Contracts/Seams/IInboxItemEnricher.cs`
- Create: `PRism.AI.Contracts/Dtos/InboxItemEnrichment.cs`
- Create: `PRism.AI.Contracts/Noop/NoopInboxItemEnricher.cs`
- Create: `PRism.AI.Placeholder/PlaceholderInboxItemEnricher.cs`
- Modify: `PRism.AI.Placeholder/PlaceholderData.cs` (replace `Enrichment` field)
- Modify: `PRism.Web/Program.cs` (DI registrations)
- Modify: `tests/PRism.Core.Tests/Ai/NoopSeamTests.cs` (update the one existing test)

- [ ] **Step 1: Update existing test to fail-as-expected for the new shape**

Edit `tests/PRism.Core.Tests/Ai/NoopSeamTests.cs` — replace the existing `NoopInboxEnricher_returns_null` test with:

```csharp
[Fact]
public async Task NoopInboxItemEnricher_returns_empty_array()
{
    IInboxItemEnricher s = new NoopInboxItemEnricher();
    var input = new[]
    {
        new PrInboxItem(
            Ref, "Title", "author", "acme/api",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
            1, 0, 0, 0, "abc", CiStatus.None, null, null),
    };
    var result = await s.EnrichAsync(input, CancellationToken.None);
    result.Should().BeEmpty();
}
```

(`PrInboxItem` and `CiStatus` are defined in Phase 2 — this test compiles only after Phase 2. Run order: do Phase 2 first if compile-driven; or temporarily simplify the test to call `EnrichAsync(Array.Empty<PrInboxItem>(), ...)` once `PrInboxItem` is renamed but old shape, then expand after Phase 2. Easiest path: do steps 2–7 first to keep the old `PrInboxItem` shape, then update this test in Phase 2 alongside the record expansion.)

- [ ] **Step 2: Run test — expect compile error (interface doesn't exist yet)**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter NoopInboxItemEnricher`
Expected: build fails — `IInboxItemEnricher` not found.

- [ ] **Step 3: Create the new interface**

`PRism.AI.Contracts/Seams/IInboxItemEnricher.cs`:
```csharp
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IInboxItemEnricher
{
    Task<IReadOnlyList<InboxItemEnrichment>> EnrichAsync(
        IReadOnlyList<PrInboxItem> items, CancellationToken ct);
}
```

- [ ] **Step 4: Create the new DTO**

`PRism.AI.Contracts/Dtos/InboxItemEnrichment.cs`:
```csharp
namespace PRism.AI.Contracts.Dtos;

public sealed record InboxItemEnrichment(string PrId, string? CategoryChip, string? HoverSummary);
```

- [ ] **Step 5: Create the Noop impl**

`PRism.AI.Contracts/Noop/NoopInboxItemEnricher.cs`:
```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopInboxItemEnricher : IInboxItemEnricher
{
    public Task<IReadOnlyList<InboxItemEnrichment>> EnrichAsync(
        IReadOnlyList<PrInboxItem> items, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<InboxItemEnrichment>>(Array.Empty<InboxItemEnrichment>());
}
```

- [ ] **Step 6: Create the Placeholder impl**

`PRism.AI.Placeholder/PlaceholderInboxItemEnricher.cs`:
```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderInboxItemEnricher : IInboxItemEnricher
{
    public Task<IReadOnlyList<InboxItemEnrichment>> EnrichAsync(
        IReadOnlyList<PrInboxItem> items, CancellationToken ct)
    {
        var result = items
            .Select(i => new InboxItemEnrichment(
                $"{i.Reference.Owner}/{i.Reference.Repo}#{i.Reference.Number}",
                PlaceholderData.SummaryCategory,
                PlaceholderData.SummaryBody))
            .ToArray();
        return Task.FromResult<IReadOnlyList<InboxItemEnrichment>>(result);
    }
}
```

- [ ] **Step 7: Update `PlaceholderData.Enrichment` property to match new DTO shape**

Edit `PRism.AI.Placeholder/PlaceholderData.cs` — replace the line
```csharp
public static InboxEnrichment Enrichment { get; } = new("Refactor", "LeaseRenewalProcessor cleanup.");
```
with: (delete it — `PlaceholderInboxItemEnricher` no longer uses a single static instance; it projects per item.)

- [ ] **Step 8: Delete the four old files**

```
git rm PRism.AI.Contracts/Seams/IInboxEnricher.cs
git rm PRism.AI.Contracts/Dtos/InboxEnrichment.cs
git rm PRism.AI.Contracts/Noop/NoopInboxEnricher.cs
git rm PRism.AI.Placeholder/PlaceholderInboxEnricher.cs
```

- [ ] **Step 9: Update DI in `PRism.Web/Program.cs`**

Replace every occurrence:
- `NoopInboxEnricher` → `NoopInboxItemEnricher`
- `PlaceholderInboxEnricher` → `PlaceholderInboxItemEnricher`
- `typeof(IInboxEnricher)` → `typeof(IInboxItemEnricher)`

There are exactly 6 references (3 type names × 2 — one in Noop dictionary, one in Placeholder dictionary, one in `AddSingleton`).

- [ ] **Step 10: Build + run the renamed test**

```
dotnet build
dotnet test --filter NoopInboxItemEnricher
```
Expected: green.

- [ ] **Step 11: Commit**

```
git add -A
git commit -m "refactor(ai-seam): rename IInboxEnricher → IInboxItemEnricher (batched)

Aligns the seam with spec/04-ai-seam-architecture.md § Per-feature service
interfaces. Batched signature is materially better at v2 time (one LLM call
for N PRs vs N calls for N PRs); locking the worse shape was a drift bug.
DTO renames InboxEnrichment → InboxItemEnrichment with PrId / CategoryChip /
HoverSummary fields. Noop returns empty list; Placeholder projects per item.
Updates the one existing test (NoopSeamTests) to assert the new shape."
```

---

## Phase 2 — Contracts expansion + config schema growth (one commit)

Expand `PrInboxItem` with the fields the design-handoff row needs; add `CiStatus`; expand `InboxConfig` with `Deduplicate` + `Sections`. The S0+S1 test that constructs a `PrInboxItem` (none today) will need updating — only `Phase 1` referenced it.

### Task 2.1: Add `CiStatus` enum

**Files:** Create `PRism.Core.Contracts/CiStatus.cs`.

- [ ] **Step 1: Create the enum**

```csharp
namespace PRism.Core.Contracts;

public enum CiStatus
{
    None,
    Pending,
    Failing,
}
```

### Task 2.2: Expand `PrInboxItem`

**Files:** Modify `PRism.Core.Contracts/PrInboxItem.cs`.

- [ ] **Step 1: Replace the record with the expanded shape**

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
    long? LastSeenCommentId);
```

- [ ] **Step 2: Build — fix any compile errors at call sites**

Run: `dotnet build`.
Expected: errors only at call sites that constructed the old 5-arg shape. There should be **none** in production code (the type is reserved for S2's first usage); the one test (`NoopSeamTests` from Phase 1) needs the longer constructor — already specified in Phase 1 Step 1.

### Task 2.3: Expand `InboxConfig`

**Files:** Modify `PRism.Core/Config/AppConfig.cs`.

- [ ] **Step 1: Replace `InboxConfig` and update the `Default` factory**

Replace the existing `InboxConfig` record + its `Default` line in `AppConfig`:

```csharp
public sealed record InboxConfig(
    bool Deduplicate,
    InboxSectionsConfig Sections,
    bool ShowHiddenScopeFooter);

public sealed record InboxSectionsConfig(
    bool ReviewRequested,
    bool AwaitingAuthor,
    bool AuthoredByMe,
    bool Mentioned,
    bool CiFailing);
```

In `AppConfig.Default`, replace `new InboxConfig(true)` with:
```csharp
new InboxConfig(true, new InboxSectionsConfig(true, true, true, true, true), true),
```

- [ ] **Step 2: Build**

`dotnet build`.
Expected: clean.

### Task 2.4: Add a `ConfigStore` test for the new defaults

**Files:** Modify `tests/PRism.Core.Tests/Config/ConfigStoreTests.cs` (or add new test file if not present).

- [ ] **Step 1: Locate the existing tests**

`Grep` for `ConfigStore` test file under `tests/PRism.Core.Tests/Config/`. If `ConfigStoreTests.cs` exists, append; otherwise create it.

- [ ] **Step 2: Add test for the inbox defaults**

```csharp
[Fact]
public async Task Default_inbox_config_has_dedupe_on_all_sections_visible_footer_on()
{
    var dir = TempDir.Create();
    var store = new ConfigStore(dir);
    await store.InitAsync(CancellationToken.None);

    store.Current.Inbox.Deduplicate.Should().BeTrue();
    store.Current.Inbox.ShowHiddenScopeFooter.Should().BeTrue();
    store.Current.Inbox.Sections.ReviewRequested.Should().BeTrue();
    store.Current.Inbox.Sections.AwaitingAuthor.Should().BeTrue();
    store.Current.Inbox.Sections.AuthoredByMe.Should().BeTrue();
    store.Current.Inbox.Sections.Mentioned.Should().BeTrue();
    store.Current.Inbox.Sections.CiFailing.Should().BeTrue();
}
```

- [ ] **Step 3: Run + commit**

```
dotnet test --filter Default_inbox_config
git add -A
git commit -m "feat(contracts): expand PrInboxItem; add CiStatus; grow InboxConfig

PrInboxItem grows fields needed for the design-handoff row (PushedAt,
IterationNumber, CommentCount, Additions, Deletions, HeadSha, Ci,
LastViewedHeadSha, LastSeenCommentId). CiStatus enum joins Core.Contracts.
InboxConfig grows Deduplicate (default true) + per-section visibility
(default all true), matching spec/03-poc-features.md § 2."
```

---

## Phase 3 — `IInboxDeduplicator` (pure logic, TDD heavy)

The deduplicator is the cleanest place to start TDD: pure function, no I/O, the spec rule is exact.

### Task 3.1: Interface + tests + impl

**Files:**
- Create: `PRism.Core/Inbox/IInboxDeduplicator.cs`
- Create: `PRism.Core/Inbox/InboxDeduplicator.cs`
- Create: `tests/PRism.Core.Tests/Inbox/InboxDeduplicatorTests.cs`

- [ ] **Step 1: Write the interface**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public interface IInboxDeduplicator
{
    IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> Deduplicate(
        IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> sectionsById,
        bool deduplicate);
}
```

Section IDs are the kebab strings (`"review-requested"`, `"awaiting-author"`, `"authored-by-me"`, `"mentioned"`, `"ci-failing"`).

- [ ] **Step 2: Write the failing tests**

`tests/PRism.Core.Tests/Inbox/InboxDeduplicatorTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxDeduplicatorTests
{
    private static PrInboxItem Pr(int n, string repo = "acme/api") => new(
        new PrReference(repo.Split('/')[0], repo.Split('/')[1], n),
        $"PR #{n}", "author", repo,
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
        1, 0, 0, 0, $"sha{n}", CiStatus.None, null, null);

    private readonly IInboxDeduplicator _sut = new InboxDeduplicator();

    [Fact]
    public void When_dedupe_off_returns_input_unchanged()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["mentioned"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: false);

        result["review-requested"].Should().HaveCount(1);
        result["mentioned"].Should().HaveCount(1);
    }

    [Fact]
    public void Pr_in_section_1_and_4_appears_only_in_section_1()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["mentioned"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().ContainSingle(p => p.Reference.Number == 1);
        result["mentioned"].Should().BeEmpty();
    }

    [Fact]
    public void Pr_in_section_3_and_5_appears_only_in_section_5()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["authored-by-me"] = new[] { Pr(1) },
            ["ci-failing"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["authored-by-me"].Should().BeEmpty();
        result["ci-failing"].Should().ContainSingle(p => p.Reference.Number == 1);
    }

    [Fact]
    public void Pr_in_unrelated_pair_is_not_deduplicated()
    {
        // section 1 + section 3 is NOT a dedupe pair
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["authored-by-me"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().HaveCount(1);
        result["authored-by-me"].Should().HaveCount(1);
    }

    [Fact]
    public void Pr_in_all_four_dedupe_groups_resolves_per_pair()
    {
        // PR 1 is in 1+4 (resolves to 1) AND in 3+5 (resolves to 5)
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["authored-by-me"] = new[] { Pr(1) },
            ["mentioned"] = new[] { Pr(1) },
            ["ci-failing"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().ContainSingle();
        result["mentioned"].Should().BeEmpty();
        result["authored-by-me"].Should().BeEmpty();
        result["ci-failing"].Should().ContainSingle();
    }

    [Fact]
    public void Empty_input_returns_empty()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>();
        var result = _sut.Deduplicate(input, deduplicate: true);
        result.Should().BeEmpty();
    }

    [Fact]
    public void Section_ordering_preserved()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = Array.Empty<PrInboxItem>(),
            ["awaiting-author"] = Array.Empty<PrInboxItem>(),
            ["authored-by-me"] = Array.Empty<PrInboxItem>(),
            ["mentioned"] = Array.Empty<PrInboxItem>(),
            ["ci-failing"] = Array.Empty<PrInboxItem>(),
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result.Keys.Should().ContainInOrder(
            "review-requested", "awaiting-author", "authored-by-me", "mentioned", "ci-failing");
    }

    [Fact]
    public void Two_distinct_prs_unchanged_by_dedupe()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
            ["mentioned"] = new[] { Pr(2) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().HaveCount(1);
        result["mentioned"].Should().HaveCount(1);
    }

    [Fact]
    public void Hidden_section_in_dedupe_pair_is_no_op()
    {
        // mentioned section is hidden => dropped from input. PR 1 stays in review-requested.
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        result["review-requested"].Should().HaveCount(1);
        result.ContainsKey("mentioned").Should().BeFalse();
    }

    [Fact]
    public void No_pr_appears_in_two_sections_after_dedupe()
    {
        var input = new Dictionary<string, IReadOnlyList<PrInboxItem>>
        {
            ["review-requested"] = new[] { Pr(1), Pr(2) },
            ["awaiting-author"] = new[] { Pr(3) },
            ["authored-by-me"] = new[] { Pr(4), Pr(5) },
            ["mentioned"] = new[] { Pr(1), Pr(6) },
            ["ci-failing"] = new[] { Pr(4) },
        };

        var result = _sut.Deduplicate(input, deduplicate: true);

        var allRefs = result.Values.SelectMany(v => v).Select(p => p.Reference).ToList();
        allRefs.Should().OnlyHaveUniqueItems();
    }
}
```

- [ ] **Step 3: Run — expect compile failure (`InboxDeduplicator` doesn't exist)**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter InboxDeduplicator`
Expected: build fails — `InboxDeduplicator` not found.

- [ ] **Step 4: Implement**

`PRism.Core/Inbox/InboxDeduplicator.cs`:

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public sealed class InboxDeduplicator : IInboxDeduplicator
{
    // Dedupe pair: when both sections appear, the "winner" keeps the PR.
    private static readonly (string Winner, string Loser)[] Pairs =
    {
        ("review-requested", "mentioned"), // 1 wins over 4
        ("ci-failing", "authored-by-me"),  // 5 wins over 3
    };

    public IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> Deduplicate(
        IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> sectionsById,
        bool deduplicate)
    {
        if (!deduplicate || sectionsById.Count == 0)
            return sectionsById;

        // Collect PR-numbers held by each "winner" section
        var result = sectionsById.ToDictionary(
            kv => kv.Key,
            kv => (IReadOnlyList<PrInboxItem>)kv.Value.ToList());

        foreach (var (winner, loser) in Pairs)
        {
            if (!result.ContainsKey(winner) || !result.ContainsKey(loser)) continue;
            var winnerRefs = new HashSet<PrReference>(result[winner].Select(p => p.Reference));
            result[loser] = result[loser].Where(p => !winnerRefs.Contains(p.Reference)).ToList();
        }
        return result;
    }
}
```

- [ ] **Step 5: Run — expect green**

```
dotnet test --filter InboxDeduplicator
```
Expected: 10 tests pass.

- [ ] **Step 6: Commit**

```
git add -A
git commit -m "feat(inbox): IInboxDeduplicator + symmetric dedupe rule

Pairs: review-requested vs mentioned (1 wins), ci-failing vs authored-by-me
(5 wins). Pure function, no I/O. Tests cover all matrix cells: empty input,
distinct PRs, pair-overlap, all-four-overlap, unrelated overlap, hidden
section, ordering preservation, uniqueness post-dedupe."
```

---

## Phase 4 — `IReviewService.TryParsePrUrl` real implementation

S0+S1 stubbed `TryParsePrUrl` with `NotImplementedException`. Implement the URL-parser + host-match in `GitHubReviewService`.

### Task 4.1: TryParsePrUrl tests + impl

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.cs` (replace the stub)
- Create: `tests/PRism.GitHub.Tests/PrUrlParsingTests.cs`

- [ ] **Step 1: Tests first**

```csharp
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public sealed class PrUrlParsingTests
{
    private static IReviewService Make(string host) =>
        new GitHubReviewService(new HttpClient(), () => Task.FromResult<string?>("token"), host);

    [Theory]
    [InlineData("https://github.com/foo/bar/pull/42", "https://github.com", "foo", "bar", 42)]
    [InlineData("https://github.com/foo/bar/pull/42/files", "https://github.com", "foo", "bar", 42)]
    [InlineData("https://github.com/foo/bar/pull/42#discussion_r1", "https://github.com", "foo", "bar", 42)]
    [InlineData("https://ghe.acme.com/foo/bar/pull/7", "https://ghe.acme.com", "foo", "bar", 7)]
    public void Valid_pr_url_for_configured_host_parses(
        string url, string host, string owner, string repo, int n)
    {
        var sut = Make(host);
        sut.TryParsePrUrl(url, out var r).Should().BeTrue();
        r!.Owner.Should().Be(owner);
        r.Repo.Should().Be(repo);
        r.Number.Should().Be(n);
    }

    [Fact]
    public void Pr_url_on_wrong_host_returns_false()
    {
        var sut = Make("https://ghe.acme.com");
        sut.TryParsePrUrl("https://github.com/foo/bar/pull/42", out var r).Should().BeFalse();
        r.Should().BeNull();
    }

    [Theory]
    [InlineData("https://github.com/foo/bar/issues/1")]   // not a PR
    [InlineData("https://github.com/foo")]                // not a PR URL
    [InlineData("not a url at all")]
    [InlineData("")]
    [InlineData("ftp://github.com/foo/bar/pull/1")]       // wrong scheme
    public void Non_pr_or_malformed_input_returns_false(string url)
    {
        var sut = Make("https://github.com");
        sut.TryParsePrUrl(url, out var r).Should().BeFalse();
        r.Should().BeNull();
    }

    [Fact]
    public void Trailing_slash_on_host_tolerated()
    {
        var sut = Make("https://github.com/");
        sut.TryParsePrUrl("https://github.com/foo/bar/pull/9", out var r).Should().BeTrue();
        r!.Number.Should().Be(9);
    }

    [Fact]
    public void Host_compare_is_case_insensitive()
    {
        var sut = Make("https://GitHub.com");
        sut.TryParsePrUrl("https://github.com/foo/bar/pull/9", out var r).Should().BeTrue();
    }
}
```

- [ ] **Step 2: Run — expect failure (NotImplementedException)**

Run: `dotnet test tests/PRism.GitHub.Tests --filter PrUrlParsing`
Expected: tests throw `NotImplementedException`.

- [ ] **Step 3: Implement**

In `PRism.GitHub/GitHubReviewService.cs`, replace the `TryParsePrUrl` stub:

```csharp
public bool TryParsePrUrl(string url, out PrReference? reference)
{
    reference = null;
    if (string.IsNullOrWhiteSpace(url)) return false;
    if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
    if (u.Scheme != "https" && u.Scheme != "http") return false;

    if (!Uri.TryCreate(_host, UriKind.Absolute, out var h)) return false;
    if (!string.Equals(u.Host, h.Host, StringComparison.OrdinalIgnoreCase)) return false;

    var segs = u.AbsolutePath.Trim('/').Split('/');
    if (segs.Length < 4) return false;
    if (!string.Equals(segs[2], "pull", StringComparison.Ordinal)) return false;
    if (!int.TryParse(segs[3], out var n) || n <= 0) return false;

    reference = new PrReference(segs[0], segs[1], n);
    return true;
}
```

- [ ] **Step 4: Run + commit**

```
dotnet test --filter PrUrlParsing
git add -A
git commit -m "feat(github): implement IReviewService.TryParsePrUrl

Parses cloud + GHES PR URLs with case-insensitive host-match against the
configured github.host. Tolerates trailing slash and ?#fragments. Rejects
issues, commits, malformed URLs, wrong-scheme URLs."
```

---

## Phase 5 — Section query runner

### Task 5.1: `ISectionQueryRunner` + GitHub impl + tests

**Files:**
- Create: `PRism.Core/Inbox/ISectionQueryRunner.cs`
- Create: `PRism.Core/Inbox/RawPrInboxItem.cs`
- Create: `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs`
- Create: `tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs`
- Create: `tests/PRism.GitHub.Tests/Inbox/FakeHttpMessageHandler.cs` (if not already extracted in S0+S1)

- [ ] **Step 1: Define `RawPrInboxItem`** — the pre-fan-out shape with only Search-API-derivable fields.

`PRism.Core/Inbox/RawPrInboxItem.cs`:
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
    int IterationNumberApprox);
```

- [ ] **Step 2: Define interface**

`PRism.Core/Inbox/ISectionQueryRunner.cs`:
```csharp
namespace PRism.Core.Inbox;

public interface ISectionQueryRunner
{
    Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
        IReadOnlySet<string> visibleSectionIds,
        CancellationToken ct);
}
```

- [ ] **Step 3: Tests against a fake handler**

`tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs`:

```csharp
using System.Net;
using System.Text;
using FluentAssertions;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class GitHubSectionQueryRunnerTests
{
    private const string SearchResponseOnePr = """
    {
      "items": [
        {
          "number": 42,
          "title": "Test PR",
          "user": { "login": "amelia" },
          "repository_url": "https://api.github.com/repos/acme/api",
          "updated_at": "2026-05-06T10:00:00Z",
          "comments": 3,
          "pull_request": { "html_url": "https://github.com/acme/api/pull/42" }
        }
      ]
    }
    """;

    [Fact]
    public async Task Queries_each_visible_section_with_correct_search_q()
    {
        var calls = new List<string>();
        var handler = new FakeHttpMessageHandler((req) =>
        {
            calls.Add(req.RequestUri!.Query);
            return Respond(HttpStatusCode.OK, SearchResponseOnePr);
        });
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubSectionQueryRunner(http, () => Task.FromResult<string?>("t"));

        await sut.QueryAllAsync(new HashSet<string>
        {
            "review-requested", "awaiting-author", "authored-by-me", "mentioned", "ci-failing"
        }, default);

        calls.Should().Contain(q => q.Contains("review-requested%3A%40me", StringComparison.Ordinal));
        calls.Should().Contain(q => q.Contains("reviewed-by%3A%40me", StringComparison.Ordinal));
        calls.Should().Contain(q => q.Contains("author%3A%40me", StringComparison.Ordinal));
        calls.Should().Contain(q => q.Contains("mentions%3A%40me", StringComparison.Ordinal));
        calls.Should().HaveCount(5);
    }

    [Fact]
    public async Task Hidden_section_skipped()
    {
        var calls = new List<string>();
        var handler = new FakeHttpMessageHandler((req) =>
        {
            calls.Add(req.RequestUri!.Query);
            return Respond(HttpStatusCode.OK, SearchResponseOnePr);
        });
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubSectionQueryRunner(http, () => Task.FromResult<string?>("t"));

        await sut.QueryAllAsync(new HashSet<string> { "review-requested" }, default);

        calls.Should().HaveCount(1);
    }

    [Fact]
    public async Task Section_failure_records_empty_for_that_section_others_succeed()
    {
        var handler = new FakeHttpMessageHandler((req) =>
        {
            var q = req.RequestUri!.Query;
            return q.Contains("ci-failing") || q.Contains("author%3A%40me")
                ? Respond(HttpStatusCode.OK, SearchResponseOnePr)
                : Respond(HttpStatusCode.InternalServerError, "{}");
        });
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") };
        var sut = new GitHubSectionQueryRunner(http, () => Task.FromResult<string?>("t"));

        var result = await sut.QueryAllAsync(new HashSet<string>
        {
            "review-requested", "authored-by-me", "ci-failing"
        }, default);

        result["authored-by-me"].Should().HaveCount(1);
        result["review-requested"].Should().BeEmpty();
    }

    private static HttpResponseMessage Respond(HttpStatusCode code, string body) => new(code)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };
}
```

- [ ] **Step 4: FakeHttpMessageHandler**

`tests/PRism.GitHub.Tests/Inbox/FakeHttpMessageHandler.cs`:

```csharp
namespace PRism.GitHub.Tests.Inbox;

public sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;
    public FakeHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
    {
        _responder = responder;
    }
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
        => Task.FromResult(_responder(request));
}
```

- [ ] **Step 5: Implement**

`PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs`:

```csharp
using System.Net.Http.Headers;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed class GitHubSectionQueryRunner : ISectionQueryRunner
{
    private static readonly Dictionary<string, string> SectionQueries = new()
    {
        ["review-requested"] = "is:open is:pr review-requested:@me archived:false",
        ["awaiting-author"]  = "is:open is:pr reviewed-by:@me archived:false",
        ["authored-by-me"]   = "is:open is:pr author:@me archived:false",
        ["mentioned"]        = "is:open is:pr mentions:@me archived:false",
        // ci-failing starts as "authored-by-me"; per-PR detector filters
        ["ci-failing"]       = "is:open is:pr author:@me archived:false",
    };

    private readonly HttpClient _http;
    private readonly Func<Task<string?>> _readToken;

    public GitHubSectionQueryRunner(HttpClient http, Func<Task<string?>> readToken)
    {
        _http = http;
        _readToken = readToken;
    }

    public async Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
        IReadOnlySet<string> visibleSectionIds, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        var tasks = SectionQueries
            .Where(kv => visibleSectionIds.Contains(kv.Key))
            .Select(async kv =>
            {
                try
                {
                    var items = await SearchAsync(kv.Value, token, ct).ConfigureAwait(false);
                    return (kv.Key, (IReadOnlyList<RawPrInboxItem>)items);
                }
                catch
                {
                    return (kv.Key, (IReadOnlyList<RawPrInboxItem>)Array.Empty<RawPrInboxItem>());
                }
            })
            .ToList();
        var done = await Task.WhenAll(tasks).ConfigureAwait(false);
        return done.ToDictionary(t => t.Key, t => t.Item2);
    }

    private async Task<List<RawPrInboxItem>> SearchAsync(string q, string? token, CancellationToken ct)
    {
        var url = $"search/issues?q={Uri.EscapeDataString(q)}&per_page=50";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);

        var result = new List<RawPrInboxItem>();
        if (!doc.RootElement.TryGetProperty("items", out var items)) return result;

        foreach (var item in items.EnumerateArray())
        {
            var prUrl = item.GetProperty("pull_request").GetProperty("html_url").GetString() ?? "";
            var path = new Uri(prUrl).AbsolutePath.Trim('/').Split('/');
            if (path.Length < 4 || path[2] != "pull") continue;
            if (!int.TryParse(path[3], out var n)) continue;

            var repo = $"{path[0]}/{path[1]}";
            var login = item.GetProperty("user").GetProperty("login").GetString() ?? "";
            var title = item.GetProperty("title").GetString() ?? "";
            var updated = item.GetProperty("updated_at").GetDateTimeOffset();
            var comments = item.TryGetProperty("comments", out var c) ? c.GetInt32() : 0;

            result.Add(new RawPrInboxItem(
                new PrReference(path[0], path[1], n),
                title, login, repo,
                updated, updated, // pushed-at not in Search API; use updated as approx (refined in fan-out)
                comments,
                0, 0, // additions/deletions not in Search API; refined in fan-out
                "",   // head_sha not in Search API; refined in fan-out
                1));  // iteration approx
        }
        return result;
    }
}
```

- [ ] **Step 6: Run + commit**

```
dotnet test --filter GitHubSectionQueryRunner
git add -A
git commit -m "feat(inbox): GitHubSectionQueryRunner — Search API for the 5 sections

Hidden sections are not queried (saves rate limit). Per-section failures
return empty for that section without aborting the others. Search API
queries are exact spec text. Pushed-at / additions / deletions / head_sha
are placeholders here (Search API doesn't carry them); the per-PR fan-out
filters refine them in subsequent phases."
```

---

## Phase 6 — `IAwaitingAuthorFilter` (per-PR `pulls/{n}/reviews` fan-out)

### Task 6.1: Interface + impl + tests

**Files:**
- Create: `PRism.Core/Inbox/IAwaitingAuthorFilter.cs`
- Create: `PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs`
- Create: `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`

- [ ] **Step 1: Interface**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public interface IAwaitingAuthorFilter
{
    /// <summary>
    /// For each candidate (which came from "is:open is:pr reviewed-by:@me"),
    /// fetches pulls/{n}/reviews and keeps only the ones with newer commits
    /// than the user's last review submission. Caches the lookup keyed on
    /// (prRef, headSha). Concurrency capped at 8.
    /// </summary>
    Task<IReadOnlyList<RawPrInboxItem>> FilterAsync(
        string viewerLogin,
        IReadOnlyList<RawPrInboxItem> candidates,
        CancellationToken ct);
}
```

- [ ] **Step 2: Tests**

The test list (write each as a [Fact] in `GitHubAwaitingAuthorFilterTests.cs`):

| Test | Setup | Expectation |
|---|---|---|
| `Includes_pr_with_newer_commits_than_last_review` | reviews response: viewer's last review at `commit_id: old`; PR `head_sha: new` | PR appears in result |
| `Excludes_pr_where_viewer_review_matches_head_sha` | reviews response: viewer's last review at `commit_id: head` | PR excluded |
| `Pr_404_filters_silently` | handler returns 404 for `pulls/{n}/reviews` | PR excluded; no exception |
| `Cache_hit_skips_http` | call once; check call count; call again same `(prRef, headSha)` | second call: same call count |
| `Cache_invalidates_on_head_sha_change` | call once with sha A; call again with same prRef but sha B | two calls observed |
| `Concurrency_capped_at_eight` | feed 20 candidates; instrument handler with semaphore counter | max 8 in-flight at any time |

(Each test follows the standard arrange / act / assert pattern; the sample fixture pattern is the same as Phase 5's `GitHubSectionQueryRunnerTests`.)

- [ ] **Step 3: Implementation skeleton**

`PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs`:

```csharp
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed class GitHubAwaitingAuthorFilter : IAwaitingAuthorFilter
{
    private const int ConcurrencyCap = 8;
    private readonly HttpClient _http;
    private readonly Func<Task<string?>> _readToken;
    private readonly ConcurrentDictionary<(PrReference, string), string?> _lastReviewShaCache = new();

    public GitHubAwaitingAuthorFilter(HttpClient http, Func<Task<string?>> readToken)
    {
        _http = http;
        _readToken = readToken;
    }

    public async Task<IReadOnlyList<RawPrInboxItem>> FilterAsync(
        string viewerLogin, IReadOnlyList<RawPrInboxItem> candidates, CancellationToken ct)
    {
        if (candidates.Count == 0) return Array.Empty<RawPrInboxItem>();
        var token = await _readToken().ConfigureAwait(false);
        using var sem = new SemaphoreSlim(ConcurrencyCap);

        var probed = await Task.WhenAll(candidates.Select(async c =>
        {
            await sem.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (string.IsNullOrEmpty(c.HeadSha)) return null; // not enriched; skip
                var key = (c.Reference, c.HeadSha);
                if (_lastReviewShaCache.TryGetValue(key, out var cached))
                    return cached != null && cached != c.HeadSha ? c : null;

                var lastReviewSha = await FetchLastReviewShaAsync(c.Reference, viewerLogin, token, ct)
                    .ConfigureAwait(false);
                _lastReviewShaCache[key] = lastReviewSha;
                return lastReviewSha != null && lastReviewSha != c.HeadSha ? c : null;
            }
            finally { sem.Release(); }
        })).ConfigureAwait(false);

        return probed.Where(p => p != null).Select(p => p!).ToList();
    }

    private async Task<string?> FetchLastReviewShaAsync(
        PrReference pr, string viewerLogin, string? token, CancellationToken ct)
    {
        var url = $"repos/{pr.Owner}/{pr.Repo}/pulls/{pr.Number}/reviews?per_page=100";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        string? best = null;
        foreach (var review in doc.RootElement.EnumerateArray())
        {
            var login = review.GetProperty("user").GetProperty("login").GetString();
            if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;
            var sha = review.TryGetProperty("commit_id", out var s) ? s.GetString() : null;
            if (sha != null) best = sha; // last in the array = most recent
        }
        return best;
    }
}
```

(Note: the filter assumes upstream code has already enriched each candidate with `HeadSha`. The orchestrator does this between sections — see Phase 8.)

- [ ] **Step 4: Run + commit**

```
dotnet test --filter GitHubAwaitingAuthorFilter
git add -A
git commit -m "feat(inbox): GitHubAwaitingAuthorFilter — pulls/{n}/reviews fan-out

(prRef, headSha) cache; concurrency cap of 8 via SemaphoreSlim. 404 filters
the PR silently (token doesn't cover repo). Cache invalidates naturally on
headSha change. Last-review-sha extracted from the reviews array's final
viewer entry."
```

---

## Phase 7 — `ICiFailingDetector` (per-PR Checks + statuses fan-out)

### Task 7.1: Interface + impl + tests

**Files:**
- Create: `PRism.Core/Inbox/ICiFailingDetector.cs`
- Create: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs`
- Create: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs`

- [ ] **Step 1: Interface**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public interface ICiFailingDetector
{
    /// <summary>
    /// For each authored PR, queries Checks API and legacy combined-statuses;
    /// returns the items whose CI is failing (any failing check-run OR any
    /// error/failure status). Annotates each input with its CiStatus along
    /// the way (returns the *full* list with Ci populated; orchestrator
    /// filters down to ci-failing rows separately).
    /// </summary>
    Task<IReadOnlyList<(RawPrInboxItem Item, CiStatus Ci)>> DetectAsync(
        IReadOnlyList<RawPrInboxItem> authoredItems,
        CancellationToken ct);
}
```

- [ ] **Step 2: Tests** (in `GitHubCiFailingDetectorTests.cs` — same fake-handler pattern)

| Test | Checks API response | Combined statuses | Expected Ci |
|---|---|---|---|
| `Failing_check_run_marks_failing` | one `conclusion: "failure"` | all `state: "success"` | `Failing` |
| `Failure_status_marks_failing` | all `conclusion: "success"` | one `state: "failure"` | `Failing` |
| `Error_status_marks_failing` | all `conclusion: "success"` | one `state: "error"` | `Failing` |
| `All_passing_marks_none` | all success | all success | `None` |
| `All_pending_marks_pending` | one `status: "in_progress"` | all `state: "pending"` | `Pending` |
| `Cache_hit_skips_http` | identical key returned cached | — | second call: zero HTTP calls |
| `Cache_invalidates_on_head_sha_change` | sha A then sha B | — | both calls hit HTTP |
| `Concurrency_capped_at_eight` | 20 inputs | — | max 8 in-flight |
| `Empty_input_returns_empty` | — | — | `[]` |

- [ ] **Step 3: Implementation**

`PRism.GitHub/Inbox/GitHubCiFailingDetector.cs`:

```csharp
using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed class GitHubCiFailingDetector : ICiFailingDetector
{
    private const int ConcurrencyCap = 8;
    private readonly HttpClient _http;
    private readonly Func<Task<string?>> _readToken;
    private readonly ConcurrentDictionary<(PrReference, string), CiStatus> _cache = new();

    public GitHubCiFailingDetector(HttpClient http, Func<Task<string?>> readToken)
    {
        _http = http;
        _readToken = readToken;
    }

    public async Task<IReadOnlyList<(RawPrInboxItem, CiStatus)>> DetectAsync(
        IReadOnlyList<RawPrInboxItem> authoredItems, CancellationToken ct)
    {
        if (authoredItems.Count == 0) return Array.Empty<(RawPrInboxItem, CiStatus)>();
        var token = await _readToken().ConfigureAwait(false);
        using var sem = new SemaphoreSlim(ConcurrencyCap);

        var done = await Task.WhenAll(authoredItems.Select(async c =>
        {
            await sem.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (string.IsNullOrEmpty(c.HeadSha)) return (c, CiStatus.None);
                var key = (c.Reference, c.HeadSha);
                if (_cache.TryGetValue(key, out var cached)) return (c, cached);

                var ci = await ProbeAsync(c.Reference, c.HeadSha, token, ct).ConfigureAwait(false);
                _cache[key] = ci;
                return (c, ci);
            }
            finally { sem.Release(); }
        })).ConfigureAwait(false);

        return done;
    }

    private async Task<CiStatus> ProbeAsync(PrReference pr, string headSha, string? token, CancellationToken ct)
    {
        var checksTask = FetchChecksAsync(pr, headSha, token, ct);
        var statusesTask = FetchCombinedStatusAsync(pr, headSha, token, ct);
        var (checks, statuses) = (await checksTask.ConfigureAwait(false),
                                  await statusesTask.ConfigureAwait(false));
        if (checks == CiStatus.Failing || statuses == CiStatus.Failing) return CiStatus.Failing;
        if (checks == CiStatus.Pending || statuses == CiStatus.Pending) return CiStatus.Pending;
        return CiStatus.None;
    }

    private async Task<CiStatus> FetchChecksAsync(PrReference pr, string sha, string? token, CancellationToken ct)
    {
        var url = $"repos/{pr.Owner}/{pr.Repo}/commits/{sha}/check-runs?per_page=100";
        using var resp = await SendAsync(url, token, ct).ConfigureAwait(false);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return CiStatus.None;
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("check_runs", out var runs)) return CiStatus.None;
        var anyFailing = false; var anyPending = false;
        foreach (var r in runs.EnumerateArray())
        {
            var status = r.GetProperty("status").GetString();
            var conclusion = r.TryGetProperty("conclusion", out var cn) ? cn.GetString() : null;
            if (status != "completed") { anyPending = true; continue; }
            if (conclusion is "failure" or "timed_out" or "cancelled") anyFailing = true;
        }
        return anyFailing ? CiStatus.Failing : (anyPending ? CiStatus.Pending : CiStatus.None);
    }

    private async Task<CiStatus> FetchCombinedStatusAsync(PrReference pr, string sha, string? token, CancellationToken ct)
    {
        var url = $"repos/{pr.Owner}/{pr.Repo}/commits/{sha}/status";
        using var resp = await SendAsync(url, token, ct).ConfigureAwait(false);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return CiStatus.None;
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        var state = doc.RootElement.TryGetProperty("state", out var s) ? s.GetString() : "success";
        return state switch
        {
            "failure" or "error" => CiStatus.Failing,
            "pending" => CiStatus.Pending,
            _ => CiStatus.None,
        };
    }

    private async Task<HttpResponseMessage> SendAsync(string url, string? token, CancellationToken ct)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        return await _http.SendAsync(req, ct).ConfigureAwait(false);
    }
}
```

- [ ] **Step 4: Run + commit**

```
dotnet test --filter GitHubCiFailingDetector
git add -A
git commit -m "feat(inbox): GitHubCiFailingDetector — Checks + combined statuses

Inclusion rule: any failing check-run OR any error/failure status. Pending
state surfaces when any check is in_progress / queued or any status is
pending. Cache keyed on (prRef, headSha); concurrency cap 8."
```

---

## Phase 8 — Orchestrator + per-PR enrichment + Snapshot

### Task 8.1: Per-PR enrichment helper

The Search API doesn't return `head_sha`, `additions`, `deletions`, or `pushed_at`. Before sections 2 and 5 can run their per-PR fan-out, every PR needs `head_sha` populated. Add a small `IPrEnricher` that issues `pulls/{n}` per PR (concurrency cap 8, cache by `(prRef, updatedAt)`).

**Files:**
- Create: `PRism.Core/Inbox/IPrEnricher.cs`
- Create: `PRism.GitHub/Inbox/GitHubPrEnricher.cs`
- Create: `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs`

- [ ] **Step 1: Interface**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public interface IPrEnricher
{
    /// <summary>Adds head_sha, additions, deletions, pushed_at, iterationNumber from pulls/{n}.</summary>
    Task<IReadOnlyList<RawPrInboxItem>> EnrichAsync(
        IReadOnlyList<RawPrInboxItem> items, CancellationToken ct);
}
```

- [ ] **Step 2: Tests** (key cases)

| Test | Setup | Expected |
|---|---|---|
| `Adds_head_sha_and_diff_stats` | `pulls/{n}` returns `{ head: { sha: "abc" }, additions: 5, deletions: 2, commits: 3 }` | result has `HeadSha = "abc"`, `Additions = 5`, `Deletions = 2`, `IterationNumberApprox = 3` |
| `Cache_keyed_on_pr_and_updated` | first call caches; second call same `(ref, updatedAt)` | only one HTTP call |
| `Cache_invalidates_on_updated_change` | first call sha A; second call updatedAt advanced | two HTTP calls |
| `404_drops_pr` | `pulls/{n}` returns 404 | PR not in result |
| `Concurrency_capped_at_eight` | 20 PRs | max 8 in-flight |

- [ ] **Step 3: Implementation**

```csharp
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed class GitHubPrEnricher : IPrEnricher
{
    private const int ConcurrencyCap = 8;
    private readonly HttpClient _http;
    private readonly Func<Task<string?>> _readToken;
    private readonly ConcurrentDictionary<(PrReference, DateTimeOffset), RawPrInboxItem> _cache = new();

    public GitHubPrEnricher(HttpClient http, Func<Task<string?>> readToken)
    {
        _http = http;
        _readToken = readToken;
    }

    public async Task<IReadOnlyList<RawPrInboxItem>> EnrichAsync(
        IReadOnlyList<RawPrInboxItem> items, CancellationToken ct)
    {
        if (items.Count == 0) return Array.Empty<RawPrInboxItem>();
        var token = await _readToken().ConfigureAwait(false);
        using var sem = new SemaphoreSlim(ConcurrencyCap);

        var done = await Task.WhenAll(items.Select(async raw =>
        {
            await sem.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var key = (raw.Reference, raw.UpdatedAt);
                if (_cache.TryGetValue(key, out var cached)) return cached;
                var enriched = await FetchAsync(raw, token, ct).ConfigureAwait(false);
                if (enriched != null) _cache[key] = enriched;
                return enriched;
            }
            finally { sem.Release(); }
        })).ConfigureAwait(false);

        return done.Where(p => p != null).Select(p => p!).ToList();
    }

    private async Task<RawPrInboxItem?> FetchAsync(RawPrInboxItem raw, string? token, CancellationToken ct)
    {
        var url = $"repos/{raw.Reference.Owner}/{raw.Reference.Repo}/pulls/{raw.Reference.Number}";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        var head = doc.RootElement.GetProperty("head").GetProperty("sha").GetString() ?? "";
        var additions = doc.RootElement.TryGetProperty("additions", out var a) ? a.GetInt32() : 0;
        var deletions = doc.RootElement.TryGetProperty("deletions", out var d) ? d.GetInt32() : 0;
        var commits = doc.RootElement.TryGetProperty("commits", out var c) ? c.GetInt32() : 1;
        var pushedAt = doc.RootElement.TryGetProperty("updated_at", out var u)
            ? u.GetDateTimeOffset() : raw.UpdatedAt;

        return raw with
        {
            HeadSha = head, Additions = additions, Deletions = deletions,
            IterationNumberApprox = commits, PushedAt = pushedAt,
        };
    }
}
```

- [ ] **Step 4: Run + commit**

```
dotnet test --filter GitHubPrEnricher
git add -A
git commit -m "feat(inbox): GitHubPrEnricher — pulls/{n} per PR for diff stats / head_sha

Cache keyed on (prRef, updatedAt); 404 drops the PR; concurrency cap 8.
Adds the fields the Search API doesn't carry."
```

### Task 8.2: `InboxSnapshot` + `InboxRefreshOrchestrator`

**Files:**
- Create: `PRism.Core/Inbox/InboxSnapshot.cs`
- Create: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`
- Create: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`

- [ ] **Step 1: Snapshot record**

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public sealed record InboxSnapshot(
    IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> Sections,
    IReadOnlyDictionary<string, InboxItemEnrichment> Enrichments,
    DateTimeOffset LastRefreshedAt)
{
    public static InboxSnapshot Empty => new(
        new Dictionary<string, IReadOnlyList<PrInboxItem>>(),
        new Dictionary<string, InboxItemEnrichment>(),
        DateTimeOffset.MinValue);
}
```

- [ ] **Step 2: Orchestrator interface**

`PRism.Core/Inbox/IInboxRefreshOrchestrator.cs`:
```csharp
namespace PRism.Core.Inbox;

public interface IInboxRefreshOrchestrator
{
    InboxSnapshot? Current { get; }
    Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct);
    Task RefreshAsync(CancellationToken ct);
}
```

- [ ] **Step 3: Orchestrator implementation**

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.State;

namespace PRism.Core.Inbox;

public sealed class InboxRefreshOrchestrator : IInboxRefreshOrchestrator
{
    private readonly IConfigStore _config;
    private readonly ISectionQueryRunner _sections;
    private readonly IPrEnricher _enricher;
    private readonly IAwaitingAuthorFilter _awaitingFilter;
    private readonly ICiFailingDetector _ciDetector;
    private readonly IInboxDeduplicator _dedupe;
    private readonly IAiSeamSelector _aiSelector;
    private readonly IReviewEventBus _events;
    private readonly IAppStateStore _stateStore;
    private readonly Func<string> _viewerLoginProvider; // resolves at runtime via /user

    private InboxSnapshot? _current;
    private TaskCompletionSource _firstSnapshotTcs = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly SemaphoreSlim _writerLock = new(1, 1);

    public InboxRefreshOrchestrator(
        IConfigStore config,
        ISectionQueryRunner sections,
        IPrEnricher enricher,
        IAwaitingAuthorFilter awaitingFilter,
        ICiFailingDetector ciDetector,
        IInboxDeduplicator dedupe,
        IAiSeamSelector aiSelector,
        IReviewEventBus events,
        IAppStateStore stateStore,
        Func<string> viewerLoginProvider)
    {
        _config = config; _sections = sections; _enricher = enricher;
        _awaitingFilter = awaitingFilter; _ciDetector = ciDetector;
        _dedupe = dedupe; _aiSelector = aiSelector; _events = events;
        _stateStore = stateStore; _viewerLoginProvider = viewerLoginProvider;
    }

    public InboxSnapshot? Current => _current;

    public async Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct)
    {
        if (_current != null) return true;
        var task = _firstSnapshotTcs.Task;
        var completed = await Task.WhenAny(task, Task.Delay(timeout, ct)).ConfigureAwait(false);
        return completed == task;
    }

    public async Task RefreshAsync(CancellationToken ct)
    {
        await _writerLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var visible = ResolveVisibleSections();
            var raw = await _sections.QueryAllAsync(visible, ct).ConfigureAwait(false);

            // Enrich every PR across all sections (one HTTP call per PR, deduplicated by ref)
            var allRawDistinct = raw.Values.SelectMany(v => v)
                .GroupBy(p => p.Reference).Select(g => g.First()).ToList();
            var enriched = await _enricher.EnrichAsync(allRawDistinct, ct).ConfigureAwait(false);
            var byRef = enriched.ToDictionary(p => p.Reference);

            var rawWithEnrichment = raw.ToDictionary(
                kv => kv.Key,
                kv => (IReadOnlyList<RawPrInboxItem>)kv.Value
                    .Select(r => byRef.TryGetValue(r.Reference, out var e) ? e : r)
                    .Where(r => !string.IsNullOrEmpty(r.HeadSha))
                    .ToList());

            // Section 2 fan-out
            if (rawWithEnrichment.TryGetValue("awaiting-author", out var rawSec2))
            {
                var filtered = await _awaitingFilter
                    .FilterAsync(_viewerLoginProvider(), rawSec2, ct).ConfigureAwait(false);
                rawWithEnrichment["awaiting-author"] = filtered;
            }

            // Section 5 fan-out (CI status decoration on the authored superset)
            var ciByRef = new Dictionary<PrReference, CiStatus>();
            if (rawWithEnrichment.TryGetValue("authored-by-me", out var rawSec3))
            {
                var probed = await _ciDetector.DetectAsync(rawSec3, ct).ConfigureAwait(false);
                foreach (var (item, ci) in probed) ciByRef[item.Reference] = ci;

                if (visible.Contains("ci-failing"))
                {
                    rawWithEnrichment["ci-failing"] = probed
                        .Where(t => t.Ci == CiStatus.Failing).Select(t => t.Item).ToList();
                }
            }

            // Convert RawPrInboxItem → PrInboxItem (with state.json reads + CI annotation)
            var state = await _stateStore.LoadAsync(ct).ConfigureAwait(false);
            var sectionsAsItems = rawWithEnrichment.ToDictionary(
                kv => kv.Key,
                kv => (IReadOnlyList<PrInboxItem>)kv.Value
                    .Select(r => MaterialPrInboxItem(r, ciByRef, state))
                    .ToList());

            // Dedupe
            var deduped = _dedupe.Deduplicate(sectionsAsItems, _config.Current.Inbox.Deduplicate);

            // AI enrichment
            var allItems = deduped.Values.SelectMany(v => v).ToList();
            var enricher = _aiSelector.Resolve<IInboxItemEnricher>();
            var enrichments = await enricher.EnrichAsync(allItems, ct).ConfigureAwait(false);
            var enrichmentMap = enrichments.ToDictionary(e => e.PrId);

            // Build snapshot + diff
            var newSnap = new InboxSnapshot(deduped, enrichmentMap, DateTimeOffset.UtcNow);
            var diff = ComputeDiff(_current, newSnap);
            _current = newSnap;

            if (!_firstSnapshotTcs.Task.IsCompleted) _firstSnapshotTcs.TrySetResult();

            if (diff.Changed)
            {
                _events.Publish(new InboxUpdated(
                    diff.ChangedSectionIds.ToArray(),
                    diff.NewOrUpdatedPrCount));
            }
        }
        finally { _writerLock.Release(); }
    }

    private HashSet<string> ResolveVisibleSections()
    {
        var s = _config.Current.Inbox.Sections;
        var v = new HashSet<string>();
        if (s.ReviewRequested) v.Add("review-requested");
        if (s.AwaitingAuthor) v.Add("awaiting-author");
        if (s.AuthoredByMe || s.CiFailing) v.Add("authored-by-me"); // ci-failing depends on authored
        if (s.Mentioned) v.Add("mentioned");
        if (s.CiFailing) v.Add("ci-failing");
        return v;
    }

    private static PrInboxItem MaterialPrInboxItem(
        RawPrInboxItem r,
        IReadOnlyDictionary<PrReference, CiStatus> ciByRef,
        AppState state)
    {
        var ci = ciByRef.TryGetValue(r.Reference, out var c) ? c : CiStatus.None;
        var sessionKey = $"{r.Reference.Owner}/{r.Reference.Repo}#{r.Reference.Number}";
        string? lastViewedHeadSha = null;
        long? lastSeenCommentId = null;
        if (state.ReviewSessions.TryGetValue(sessionKey, out var session))
        {
            lastViewedHeadSha = session.LastViewedHeadSha;
            lastSeenCommentId = session.LastSeenCommentId;
        }
        return new PrInboxItem(
            r.Reference, r.Title, r.Author, r.Repo,
            r.UpdatedAt, r.PushedAt,
            r.IterationNumberApprox, r.CommentCount,
            r.Additions, r.Deletions, r.HeadSha, ci,
            lastViewedHeadSha, lastSeenCommentId);
    }

    private static (bool Changed, IReadOnlyList<string> ChangedSectionIds, int NewOrUpdatedPrCount)
        ComputeDiff(InboxSnapshot? prior, InboxSnapshot next)
    {
        if (prior is null) return (true, next.Sections.Keys.ToList(), CountAll(next));
        var changed = new List<string>();
        var newOrUpdated = 0;
        foreach (var kv in next.Sections)
        {
            var oldItems = prior.Sections.TryGetValue(kv.Key, out var v) ? v : Array.Empty<PrInboxItem>();
            var oldByRef = oldItems.ToDictionary(p => p.Reference);
            var sectionChanged = false;
            foreach (var n in kv.Value)
            {
                if (!oldByRef.TryGetValue(n.Reference, out var o))
                {
                    newOrUpdated++; sectionChanged = true; continue;
                }
                if (o.HeadSha != n.HeadSha || o.CommentCount != n.CommentCount || o.Ci != n.Ci)
                {
                    newOrUpdated++; sectionChanged = true;
                }
            }
            if (oldItems.Count != kv.Value.Count) sectionChanged = true;
            if (sectionChanged) changed.Add(kv.Key);
        }
        return (changed.Count > 0, changed, newOrUpdated);
    }

    private static int CountAll(InboxSnapshot s) => s.Sections.Values.Sum(v => v.Count);
}
```

(Note: the `IReviewEventBus` interface, `InboxUpdated` event, and `IAiSeamSelector` already exist from S0+S1. The `viewerLoginProvider` is wired in DI from the cached `/user` response — see Phase 11.)

- [ ] **Step 4: Tests** (orchestrator with full fakes)

Key cases (each as `[Fact]` in `InboxRefreshOrchestratorTests.cs`):

| Test | Setup | Expectation |
|---|---|---|
| `First_refresh_completes_TCS_and_publishes_event` | empty prior, fakes return 5 sections of 2 PRs | `Current != null`; `WaitForFirstSnapshotAsync(short)` → true; bus saw `InboxUpdated` |
| `Identical_followup_refresh_publishes_nothing` | second refresh with identical inputs | bus has only the first event |
| `Headsha_change_publishes_event_with_correct_count` | second refresh: one PR's headSha changed | `newOrUpdatedPrCount == 1` |
| `Hidden_section_is_not_queried` | config sets `mentioned: false` | section query runner gets 4 sections, not 5 |
| `Aipreview_off_returns_empty_enrichments` | `AiSeamSelector` resolves to Noop | snapshot's enrichment map is empty |
| `Aipreview_on_returns_per_pr_enrichments` | `AiSeamSelector` resolves to Placeholder | one entry per PR |
| `Section_query_failure_does_not_abort_refresh` | one section's query throws; others succeed | snapshot still produced; failed section is empty |

- [ ] **Step 5: Run + commit**

```
dotnet test --filter InboxRefreshOrchestrator
git add -A
git commit -m "feat(inbox): InboxSnapshot + InboxRefreshOrchestrator

Wires the pipeline: section queries → PR enrichment → fan-out filters →
CI annotation → state.json reads → dedupe → AI enrichment seam → diff vs
prior → publish InboxUpdated. Single-writer (semaphore-guarded). The first
refresh signals a TaskCompletionSource so /api/inbox can block-then-serve."
```

### Task 8.3: `InboxSubscriberCount` + `InboxPoller`

**Files:**
- Create: `PRism.Core/Inbox/InboxSubscriberCount.cs`
- Create: `PRism.Core/Inbox/InboxPoller.cs`
- Create: `tests/PRism.Core.Tests/Inbox/InboxSubscriberCountTests.cs`
- Create: `tests/PRism.Core.Tests/Inbox/InboxPollerTests.cs`

- [ ] **Step 1: SubscriberCount**

```csharp
namespace PRism.Core.Inbox;

public sealed class InboxSubscriberCount
{
    private int _count;
    private TaskCompletionSource _hasSubscribers = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public int Current => Volatile.Read(ref _count);

    public void Increment()
    {
        if (Interlocked.Increment(ref _count) == 1)
            _hasSubscribers.TrySetResult();
    }

    public void Decrement()
    {
        if (Interlocked.Decrement(ref _count) == 0)
            Interlocked.Exchange(ref _hasSubscribers,
                new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
    }

    public Task WaitForSubscriberAsync(CancellationToken ct)
    {
        var t = Volatile.Read(ref _hasSubscribers).Task;
        return t.IsCompleted ? Task.CompletedTask : t.WaitAsync(ct);
    }
}
```

- [ ] **Step 2: SubscriberCount tests** — increment/decrement under contention, `WaitForSubscriberAsync` completes on first increment, blocks again after drop-to-zero.

- [ ] **Step 3: InboxPoller**

```csharp
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Config;
using PRism.Core.Time;

namespace PRism.Core.Inbox;

public sealed class InboxPoller : BackgroundService
{
    private readonly IInboxRefreshOrchestrator _orchestrator;
    private readonly InboxSubscriberCount _subs;
    private readonly IConfigStore _config;
    private readonly IClock _clock;
    private readonly ILogger<InboxPoller> _log;

    public InboxPoller(
        IInboxRefreshOrchestrator orchestrator,
        InboxSubscriberCount subs,
        IConfigStore config,
        IClock clock,
        ILogger<InboxPoller> log)
    {
        _orchestrator = orchestrator; _subs = subs; _config = config;
        _clock = clock; _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await _subs.WaitForSubscriberAsync(stoppingToken).ConfigureAwait(false);
            try
            {
                await _orchestrator.RefreshAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Inbox refresh tick failed; will retry next cadence");
            }

            var cadence = TimeSpan.FromSeconds(_config.Current.Polling.InboxSeconds);
            try
            {
                await Task.Delay(cadence, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { return; }
        }
    }
}
```

(Note: `IClock` already exists from S0+S1. The poller uses `Task.Delay` directly so test injection requires either letting the test drive faster cadence via the config, or using `TestScheduler`. Pragmatic: tests set `config.polling.inboxSeconds` to a small value and assert via `Stopwatch`.)

- [ ] **Step 4: Poller tests** — fake orchestrator records refresh-call count; assertions per design § 12 (subscriber-count gating, cadence, exception swallowing, cancellation).

- [ ] **Step 5: Run + commit**

```
dotnet test --filter InboxPoller
git add -A
git commit -m "feat(inbox): InboxSubscriberCount + InboxPoller

Poller awaits at least one SSE subscriber before each refresh tick; runs
the orchestrator; sleeps config.polling.inboxSeconds; loops. Exceptions
inside a tick are logged at Warning and the next tick still runs."
```

---

## Phase 9 — SSE channel + `/api/events` endpoint

### Task 9.1: `IReviewEventBus` (if not present) + `InboxUpdated` event

Check whether `IReviewEventBus` already exists from S0+S1. If yes, only add the `InboxUpdated` record. If no, declare the in-process bus.

**Files:**
- Modify or create: `PRism.Core/Events/IReviewEventBus.cs` + `ReviewEventBus.cs`
- Modify: `PRism.AI.Contracts/Dtos/InboxUpdated.cs` (or `PRism.Core/Events/InboxUpdated.cs`)

- [ ] **Step 1: Look for existing bus**

```
grep -r "IReviewEventBus" PRism.Core PRism.AI.Contracts PRism.Web
```
If no match: create a minimal bus.

- [ ] **Step 2: Minimal in-process bus** (only if absent)

`PRism.Core/Events/IReviewEventBus.cs`:
```csharp
namespace PRism.Core.Events;

public interface IReviewEvent { }
public interface IReviewEventBus
{
    void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent;
    IDisposable Subscribe<TEvent>(Action<TEvent> handler) where TEvent : IReviewEvent;
}
```

`PRism.Core/Events/ReviewEventBus.cs`:
```csharp
namespace PRism.Core.Events;

public sealed class ReviewEventBus : IReviewEventBus
{
    private readonly Dictionary<Type, List<Delegate>> _handlers = new();
    private readonly object _gate = new();

    public void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent
    {
        Delegate[] snapshot;
        lock (_gate)
        {
            if (!_handlers.TryGetValue(typeof(TEvent), out var list)) return;
            snapshot = list.ToArray();
        }
        foreach (var d in snapshot) ((Action<TEvent>)d)(evt);
    }

    public IDisposable Subscribe<TEvent>(Action<TEvent> handler) where TEvent : IReviewEvent
    {
        lock (_gate)
        {
            if (!_handlers.TryGetValue(typeof(TEvent), out var list))
                _handlers[typeof(TEvent)] = list = new List<Delegate>();
            list.Add(handler);
        }
        return new Subscription(() =>
        {
            lock (_gate)
            {
                if (_handlers.TryGetValue(typeof(TEvent), out var list)) list.Remove(handler);
            }
        });
    }

    private sealed class Subscription : IDisposable
    {
        private readonly Action _onDispose;
        public Subscription(Action onDispose) { _onDispose = onDispose; }
        public void Dispose() => _onDispose();
    }
}
```

- [ ] **Step 3: `InboxUpdated` event**

`PRism.Core/Events/InboxUpdated.cs`:
```csharp
namespace PRism.Core.Events;

public sealed record InboxUpdated(
    IReadOnlyList<string> ChangedSectionIds,
    int NewOrUpdatedPrCount) : IReviewEvent;
```

(Use `string[]` if generation is simpler.)

### Task 9.2: `SseChannel`

**Files:**
- Create: `PRism.Web/Sse/SseChannel.cs`
- Create: `tests/PRism.Web.Tests/SseChannelTests.cs`

- [ ] **Step 1: Implementation**

```csharp
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.Json;

namespace PRism.Web.Sse;

public sealed class SseChannel : IDisposable
{
    private readonly InboxSubscriberCount _subs;
    private readonly ILogger<SseChannel> _log;
    private readonly List<SseSubscriber> _writers = new();
    private readonly object _gate = new();
    private readonly IDisposable _busSub;

    public SseChannel(IReviewEventBus bus, InboxSubscriberCount subs, ILogger<SseChannel> log)
    {
        _subs = subs; _log = log;
        _busSub = bus.Subscribe<InboxUpdated>(OnInboxUpdated);
    }

    public async Task RunSubscriberAsync(HttpResponse response, CancellationToken ct)
    {
        response.Headers["Content-Type"] = "text/event-stream";
        response.Headers["Cache-Control"] = "no-store";
        response.Headers["Connection"] = "keep-alive";

        var sub = new SseSubscriber(response);
        lock (_gate) _writers.Add(sub);
        _subs.Increment();

        try
        {
            // Heartbeat loop until client disconnects
            while (!ct.IsCancellationRequested)
            {
                await response.WriteAsync(":heartbeat\n\n", ct).ConfigureAwait(false);
                await response.Body.FlushAsync(ct).ConfigureAwait(false);
                await Task.Delay(TimeSpan.FromSeconds(25), ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { /* normal */ }
        finally
        {
            lock (_gate) _writers.Remove(sub);
            _subs.Decrement();
        }
    }

    private void OnInboxUpdated(InboxUpdated evt)
    {
        var json = JsonSerializer.Serialize(evt, JsonSerializerOptionsFactory.Api);
        var frame = $"event: inbox-updated\ndata: {json}\n\n";
        SseSubscriber[] snapshot;
        lock (_gate) snapshot = _writers.ToArray();
        foreach (var s in snapshot)
        {
            try { _ = s.WriteAsync(frame); }
            catch (Exception ex) { _log.LogDebug(ex, "SSE write failed; subscriber will be evicted on next loop"); }
        }
    }

    public void Dispose() => _busSub.Dispose();

    private sealed class SseSubscriber
    {
        private readonly HttpResponse _response;
        public SseSubscriber(HttpResponse response) { _response = response; }
        public async Task WriteAsync(string frame)
        {
            await _response.WriteAsync(frame).ConfigureAwait(false);
            await _response.Body.FlushAsync().ConfigureAwait(false);
        }
    }
}
```

- [ ] **Step 2: SseChannel tests** — verify subscribe / publish / heartbeat / disconnect via integration with `WebApplicationFactory<Program>` (since SseChannel binds tightly to `HttpResponse`). Pragmatic test: register an in-memory bus, hit `GET /api/events`, observe count++ + heartbeat frame in body.

### Task 9.3: `EventsEndpoints` mapping

**Files:**
- Create: `PRism.Web/Endpoints/EventsEndpoints.cs`
- Create: `tests/PRism.Web.Tests/EventsEndpointsTests.cs`

- [ ] **Step 1: Endpoint**

```csharp
using PRism.Web.Sse;

namespace PRism.Web.Endpoints;

internal static class EventsEndpoints
{
    public static IEndpointRouteBuilder MapEvents(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapGet("/api/events", async (HttpContext ctx, SseChannel channel) =>
        {
            await channel.RunSubscriberAsync(ctx.Response, ctx.RequestAborted);
        });
        return app;
    }
}
```

- [ ] **Step 2: Tests** — open EventSource via `HttpClient` (manual, since Test SSE clients are scarce); read raw response bytes; assert `text/event-stream` content-type and at least one heartbeat frame after the connection.

- [ ] **Step 3: Commit**

```
dotnet test --filter Events
git add -A
git commit -m "feat(events): SseChannel + GET /api/events

In-process IReviewEventBus subscriber relays InboxUpdated events as
'event: inbox-updated\\ndata: ...\\n\\n' frames to all connected SSE
clients. Heartbeat ':heartbeat\\n\\n' every 25s. Subscriber count is
incremented on connect, decremented on disconnect, gating the
inbox poller's tick loop."
```

---

## Phase 10 — `/api/inbox` + `/api/inbox/parse-pr-url` endpoints

### Task 10.1: `InboxResponse` wire DTO

**Files:** Create `PRism.Web/Endpoints/InboxDtos.cs`

- [ ] **Step 1: DTOs**

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.Web.Endpoints;

public sealed record InboxResponse(
    IReadOnlyList<InboxSectionDto> Sections,
    IReadOnlyDictionary<string, InboxItemEnrichment> Enrichments,
    DateTimeOffset LastRefreshedAt,
    bool TokenScopeFooterEnabled);

public sealed record InboxSectionDto(
    string Id,
    string Label,
    IReadOnlyList<PrInboxItem> Items);

public sealed record ParsePrUrlRequest(string? Url);
public sealed record ParsePrUrlResponse(bool Ok, PrReference? Ref, string? Error,
                                        string? ConfiguredHost, string? UrlHost);
```

### Task 10.2: `InboxEndpoints` mapping

**Files:** Create `PRism.Web/Endpoints/InboxEndpoints.cs`, plus `tests/PRism.Web.Tests/InboxEndpointsTests.cs` and `tests/PRism.Web.Tests/ParseUrlEndpointTests.cs`.

- [ ] **Step 1: Section labels constant**

In `InboxEndpoints.cs`:
```csharp
private static readonly Dictionary<string, string> Labels = new()
{
    ["review-requested"] = "Review requested",
    ["awaiting-author"] = "Awaiting author",
    ["authored-by-me"]  = "Authored by me",
    ["mentioned"]       = "Mentioned",
    ["ci-failing"]      = "CI failing on my PRs",
};
```

- [ ] **Step 2: Endpoints**

```csharp
using PRism.Core;
using PRism.Core.Config;
using PRism.Core.Inbox;

namespace PRism.Web.Endpoints;

internal static class InboxEndpoints
{
    private static readonly Dictionary<string, string> Labels = new()
    {
        ["review-requested"] = "Review requested",
        ["awaiting-author"] = "Awaiting author",
        ["authored-by-me"]  = "Authored by me",
        ["mentioned"]       = "Mentioned",
        ["ci-failing"]      = "CI failing on my PRs",
    };

    public static IEndpointRouteBuilder MapInbox(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/inbox", async (
            IInboxRefreshOrchestrator orch,
            IConfigStore config,
            CancellationToken ct) =>
        {
            if (orch.Current == null)
            {
                if (!await orch.WaitForFirstSnapshotAsync(TimeSpan.FromSeconds(10), ct))
                {
                    _ = orch.RefreshAsync(CancellationToken.None); // kick on-demand
                    if (!await orch.WaitForFirstSnapshotAsync(TimeSpan.FromSeconds(10), ct))
                        return Results.Problem(
                            title: "Inbox initializing",
                            statusCode: 503,
                            type: "/inbox/initializing");
                }
            }
            var snap = orch.Current!;
            var sections = snap.Sections
                .Select(kv => new InboxSectionDto(kv.Key, Labels[kv.Key], kv.Value))
                .ToList();
            return Results.Ok(new InboxResponse(
                sections, snap.Enrichments, snap.LastRefreshedAt,
                config.Current.Inbox.ShowHiddenScopeFooter));
        });

        app.MapPost("/api/inbox/parse-pr-url", async (
            HttpContext ctx,
            IReviewService review,
            IConfigStore config,
            CancellationToken ct) =>
        {
            ParsePrUrlRequest? body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<ParsePrUrlRequest>(ct);
            }
            catch (System.Text.Json.JsonException)
            {
                return Results.BadRequest(new { error = "invalid-json" });
            }
            if (body is null || string.IsNullOrWhiteSpace(body.Url))
                return Results.BadRequest(new { error = "url-required" });

            var configuredHost = config.Current.Github.Host;
            if (review.TryParsePrUrl(body.Url, out var prRef))
            {
                return Results.Ok(new ParsePrUrlResponse(
                    Ok: true, Ref: prRef, Error: null, ConfiguredHost: null, UrlHost: null));
            }

            // distinguish host-mismatch vs malformed vs not-a-pr
            if (!Uri.TryCreate(body.Url, UriKind.Absolute, out var u))
                return Results.Ok(new ParsePrUrlResponse(false, null, "malformed", configuredHost, null));

            if (!Uri.TryCreate(configuredHost, UriKind.Absolute, out var h)
                || !string.Equals(u.Host, h.Host, StringComparison.OrdinalIgnoreCase))
            {
                return Results.Ok(new ParsePrUrlResponse(
                    false, null, "host-mismatch", configuredHost, u.Host));
            }
            return Results.Ok(new ParsePrUrlResponse(false, null, "not-a-pr-url", null, null));
        });

        return app;
    }
}
```

- [ ] **Step 3: Tests** — happy `GET /api/inbox`; 503 path when orchestrator never produces a snapshot; hidden section omitted; tokenScopeFooterEnabled flag round-trip; parse-pr-url for cloud + GHES happy / malformed / host-mismatch / non-pr / empty body / invalid JSON.

- [ ] **Step 4: Commit**

```
dotnet test --filter Inbox
git add -A
git commit -m "feat(api): GET /api/inbox + POST /api/inbox/parse-pr-url

Inbox returns the latest orchestrator snapshot; on first call before any
snapshot exists, blocks up to 10s on TaskCompletionSource and kicks an
on-demand refresh as the deadlock-avoidance path. Parse-pr-url returns
structured success/error JSON with separate cases for host-mismatch,
not-a-pr-url, and malformed."
```

---

## Phase 11 — DI wiring (Program.cs)

### Task 11.1: Register Inbox + SSE singletons

**Files:** Modify `PRism.Web/Program.cs`.

- [ ] **Step 1: Register all the new singletons** (insert after the existing `IReviewService` registration block):

```csharp
// Inbox: HTTP-bound pipeline pieces
builder.Services.AddSingleton<ISectionQueryRunner>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
#pragma warning disable CA2000
    var http = new HttpClient { BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host) };
#pragma warning restore CA2000
    return new GitHubSectionQueryRunner(http, () => tokens.ReadAsync(CancellationToken.None));
});
builder.Services.AddSingleton<IPrEnricher>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
#pragma warning disable CA2000
    var http = new HttpClient { BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host) };
#pragma warning restore CA2000
    return new GitHubPrEnricher(http, () => tokens.ReadAsync(CancellationToken.None));
});
builder.Services.AddSingleton<IAwaitingAuthorFilter>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
#pragma warning disable CA2000
    var http = new HttpClient { BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host) };
#pragma warning restore CA2000
    return new GitHubAwaitingAuthorFilter(http, () => tokens.ReadAsync(CancellationToken.None));
});
builder.Services.AddSingleton<ICiFailingDetector>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
#pragma warning disable CA2000
    var http = new HttpClient { BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host) };
#pragma warning restore CA2000
    return new GitHubCiFailingDetector(http, () => tokens.ReadAsync(CancellationToken.None));
});

// Inbox: pure pieces + orchestration
builder.Services.AddSingleton<IInboxDeduplicator, InboxDeduplicator>();
builder.Services.AddSingleton<IReviewEventBus, ReviewEventBus>();
builder.Services.AddSingleton<InboxSubscriberCount>();
builder.Services.AddSingleton<IInboxRefreshOrchestrator>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
    // Cache viewer login from a one-time /user call after token validates.
    // For S2 simplicity: re-resolve from a cached field in TokenStore (see Note).
    var loginCache = sp.GetRequiredService<IViewerLoginProvider>();
    return new InboxRefreshOrchestrator(
        config,
        sp.GetRequiredService<ISectionQueryRunner>(),
        sp.GetRequiredService<IPrEnricher>(),
        sp.GetRequiredService<IAwaitingAuthorFilter>(),
        sp.GetRequiredService<ICiFailingDetector>(),
        sp.GetRequiredService<IInboxDeduplicator>(),
        sp.GetRequiredService<IAiSeamSelector>(),
        sp.GetRequiredService<IReviewEventBus>(),
        sp.GetRequiredService<IAppStateStore>(),
        loginCache.Get);
});
builder.Services.AddHostedService<InboxPoller>(sp =>
    new InboxPoller(
        sp.GetRequiredService<IInboxRefreshOrchestrator>(),
        sp.GetRequiredService<InboxSubscriberCount>(),
        sp.GetRequiredService<IConfigStore>(),
        sp.GetRequiredService<IClock>(),
        sp.GetRequiredService<ILogger<InboxPoller>>()));

// SSE
builder.Services.AddSingleton<SseChannel>();
```

- [ ] **Step 2: Endpoint registrations** — append after existing `app.MapAuth();`:

```csharp
app.MapInbox();
app.MapEvents();
```

- [ ] **Step 3: `IViewerLoginProvider`** (small interface caching login from `/user`)

`PRism.Core/Auth/IViewerLoginProvider.cs`:
```csharp
namespace PRism.Core.Auth;

public interface IViewerLoginProvider { string Get(); void Set(string login); }
public sealed class ViewerLoginProvider : IViewerLoginProvider
{
    private string _login = "";
    public string Get() => _login;
    public void Set(string login) => _login = login;
}
```

Wire `ViewerLoginProvider` as a singleton; the existing `/api/auth/connect` handler calls `.Set(result.Login!)` after a successful PAT validation.

- [ ] **Step 4: Build + commit**

```
dotnet build
git add -A
git commit -m "wire(di): register S2 inbox + SSE pipeline in Program.cs

Adds ISectionQueryRunner / IPrEnricher / IAwaitingAuthorFilter /
ICiFailingDetector / IInboxDeduplicator / IReviewEventBus /
InboxSubscriberCount / IInboxRefreshOrchestrator / InboxPoller /
SseChannel + IViewerLoginProvider. /api/auth/connect now caches the
authenticated login for the inbox awaiting-author filter."
```

---

## Phase 12 — Frontend types + API client + hooks

### Task 12.1: Extend types

**Files:** Modify `frontend/src/api/types.ts`.

- [ ] **Step 1: Append**

```ts
export type CiStatus = 'none' | 'pending' | 'failing';

export interface PrReference {
  owner: string;
  repo: string;
  number: number;
}

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
}

export interface InboxSection {
  id: string;
  label: string;
  items: PrInboxItem[];
}

export interface InboxItemEnrichment {
  prId: string;
  categoryChip: string | null;
  hoverSummary: string | null;
}

export interface InboxResponse {
  sections: InboxSection[];
  enrichments: Record<string, InboxItemEnrichment>;
  lastRefreshedAt: string;
  tokenScopeFooterEnabled: boolean;
}

export interface ParsePrUrlResponse {
  ok: boolean;
  ref: PrReference | null;
  error: 'host-mismatch' | 'not-a-pr-url' | 'malformed' | null;
  configuredHost: string | null;
  urlHost: string | null;
}

export interface InboxUpdatedEvent {
  changedSectionIds: string[];
  newOrUpdatedPrCount: number;
}
```

### Task 12.2: API client wrappers

**Files:**
- Create: `frontend/src/api/inbox.ts`
- Create: `frontend/src/api/events.ts`

- [ ] **Step 1: `api/inbox.ts`**

```ts
import { apiClient } from './client';
import type { InboxResponse, ParsePrUrlResponse } from './types';

export const inboxApi = {
  get: () => apiClient.get<InboxResponse>('/api/inbox'),
  parsePrUrl: (url: string) =>
    apiClient.post<ParsePrUrlResponse>('/api/inbox/parse-pr-url', { url }),
};
```

- [ ] **Step 2: `api/events.ts`**

```ts
import type { InboxUpdatedEvent } from './types';

export type EventListeners = {
  onInboxUpdated?: (e: InboxUpdatedEvent) => void;
};

export function openEventStream(listeners: EventListeners): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('inbox-updated', (raw) => {
    try {
      const data = JSON.parse((raw as MessageEvent).data) as InboxUpdatedEvent;
      listeners.onInboxUpdated?.(data);
    } catch {
      // malformed event payload — ignore (server bug, not user-facing)
    }
  });
  return () => es.close();
}
```

### Task 12.3: `useInbox` hook

**Files:** Create `frontend/src/hooks/useInbox.ts`.

- [ ] **Step 1**

```ts
import { useCallback, useEffect, useState } from 'react';
import { inboxApi } from '../api/inbox';
import type { InboxResponse } from '../api/types';

export function useInbox() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    setIsLoading(true);
    try {
      setData(await inboxApi.get());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  return { data, error, isLoading, reload };
}
```

### Task 12.4: `useInboxUpdates` hook

**Files:** Create `frontend/src/hooks/useInboxUpdates.ts`.

- [ ] **Step 1**

```ts
import { useEffect, useState } from 'react';
import { openEventStream } from '../api/events';

export function useInboxUpdates() {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [summary, setSummary] = useState('');

  useEffect(() => {
    const close = openEventStream({
      onInboxUpdated: (e) => {
        setHasUpdate(true);
        setSummary(`${e.newOrUpdatedPrCount} new updates`);
      },
    });
    return close;
  }, []);

  return { hasUpdate, summary, dismiss: () => setHasUpdate(false) };
}
```

- [ ] **Step 2: Hook tests** (Vitest + jsdom; `EventSource` polyfill required — install `eventsource` from npm or write 30-line fake).

`frontend/__tests__/useInboxUpdates.test.tsx`:

```tsx
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useInboxUpdates } from '../src/hooks/useInboxUpdates';

class FakeEventSource {
  static instance: FakeEventSource;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  constructor() { FakeEventSource.instance = this; }
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() { this.closed = true; }
  dispatch(type: string, data: unknown) {
    this.listeners[type]?.forEach((cb) =>
      cb({ data: JSON.stringify(data) } as MessageEvent));
  }
}
beforeEach(() => { (globalThis as any).EventSource = FakeEventSource; });

describe('useInboxUpdates', () => {
  it('shows banner on inbox-updated event', async () => {
    const { result } = renderHook(() => useInboxUpdates());
    expect(result.current.hasUpdate).toBe(false);
    act(() => FakeEventSource.instance.dispatch('inbox-updated',
      { changedSectionIds: ['awaiting-author'], newOrUpdatedPrCount: 3 }));
    await waitFor(() => expect(result.current.hasUpdate).toBe(true));
    expect(result.current.summary).toContain('3 new updates');
  });

  it('dismiss clears banner', async () => {
    const { result } = renderHook(() => useInboxUpdates());
    act(() => FakeEventSource.instance.dispatch('inbox-updated',
      { changedSectionIds: [], newOrUpdatedPrCount: 1 }));
    act(() => result.current.dismiss());
    expect(result.current.hasUpdate).toBe(false);
  });
});
```

- [ ] **Step 3: Run + commit**

```
npm --prefix frontend test -- --run
git add -A
git commit -m "feat(frontend): inbox API client + hooks

api/inbox.ts wraps GET /api/inbox + POST /api/inbox/parse-pr-url.
api/events.ts opens an EventSource and fans out typed inbox-updated
callbacks. useInbox / useInboxUpdates hooks consume them."
```

---

## Phase 13 — Frontend small atoms (DiffBar, InboxRow, InboxSection)

### Task 13.1: `DiffBar`

**Files:**
- Create: `frontend/src/components/Inbox/DiffBar.tsx`
- Create: `frontend/__tests__/DiffBar.test.tsx`

- [ ] **Step 1: Component**

Mirror the design-handoff `DiffBar` (see `design/handoff/screens.jsx` lines 7-22). Props: `additions: number`, `deletions: number`, `max: number`. Renders three nested `<span>`s with width calculations:

```tsx
import styles from './DiffBar.module.css';

export function DiffBar({ additions, deletions, max }: { additions: number; deletions: number; max: number; }) {
  const total = additions + deletions;
  if (!total) return null;
  const widthPct = Math.min(100, (total / max) * 100);
  const addPct = (additions / total) * 100;
  return (
    <span className={styles.diffbar} title={`+${additions} −${deletions}`}>
      <span className={styles.diffbarTrack}>
        <span className={styles.diffbarFill} style={{ width: `${widthPct}%` }}>
          <span className={styles.diffbarAdd} style={{ width: `${addPct}%` }} />
          <span className={styles.diffbarDel} style={{ width: `${100 - addPct}%` }} />
        </span>
      </span>
    </span>
  );
}
```

CSS lifted from `design/handoff/screens.css` for `.diffbar*` classes (move them to `DiffBar.module.css` with class-name updates).

- [ ] **Step 2: Tests** — render with `additions=10,deletions=5,max=20`; assert `style.width` on the fill (`75%`) and the inner add (`66%-ish`); render with both 0 → returns null.

### Task 13.2: `InboxRow`

**Files:**
- Create: `frontend/src/components/Inbox/InboxRow.tsx`
- Create: `frontend/src/components/Inbox/InboxRow.module.css`
- Create: `frontend/__tests__/InboxRow.test.tsx`

- [ ] **Step 1: Component** (matches `design/handoff/screens.jsx` `InboxRow` lines 32-88; key changes: TypeScript types from `api/types.ts`; click navigates via React Router; category chip is gated):

```tsx
import { useNavigate } from 'react-router-dom';
import type { PrInboxItem, InboxItemEnrichment } from '../../api/types';
import { DiffBar } from './DiffBar';
import styles from './InboxRow.module.css';

interface Props {
  pr: PrInboxItem;
  enrichment?: InboxItemEnrichment;
  showCategoryChip: boolean;
  maxDiff: number;
}

function freshness(updatedAt: string): 'fresh' | 'today' | 'older' {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  if (ageMs < 30 * 60 * 1000) return 'fresh';
  if (ageMs < 24 * 60 * 60 * 1000) return 'today';
  return 'older';
}

function formatAge(updatedAt: string): string {
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function InboxRow({ pr, enrichment, showCategoryChip, maxDiff }: Props) {
  const navigate = useNavigate();
  const fr = freshness(pr.updatedAt);
  const isFirstVisit = pr.lastViewedHeadSha == null;
  const onClick = () =>
    navigate(`/pr/${pr.reference.owner}/${pr.reference.repo}/${pr.reference.number}`);

  return (
    <button className={`${styles.row} ${styles[`row${fr[0].toUpperCase()}${fr.slice(1)}`]}`} onClick={onClick}>
      <span className={styles.status}>
        {pr.ci === 'failing'
          ? <span className={`${styles.dot} ${styles.dotDanger}`} title="CI failing" />
          : isFirstVisit
            ? <span className={styles.newChip}>New</span>
            : <span className={styles.dot} style={{ opacity: 0 }} />}
      </span>
      <span className={styles.main}>
        <span className={styles.title}>{pr.title}</span>
        <span className={styles.meta}>
          <span className={styles.mono}>{pr.repo}</span>
          <span className={styles.dotsep}>·</span>
          <span>{pr.author}</span>
          <span className={styles.dotsep}>·</span>
          <span className={styles.mono}>iter {pr.iterationNumber}</span>
          <span className={styles.dotsep}>·</span>
          <span>{formatAge(pr.updatedAt)} ago</span>
        </span>
      </span>
      <span className={styles.tail}>
        {showCategoryChip && enrichment?.categoryChip && (
          <span className={styles.chip}>{enrichment.categoryChip}</span>
        )}
        <DiffBar additions={pr.additions} deletions={pr.deletions} max={maxDiff} />
        <span className={styles.counts}>
          <span className={styles.add}>+{pr.additions}</span>
          <span className={styles.del}>−{pr.deletions}</span>
        </span>
        {pr.commentCount > 0 && <span className={styles.comments}>{pr.commentCount}</span>}
      </span>
    </button>
  );
}
```

- [ ] **Step 2: Tests** — title/repo/author render; `lastViewedHeadSha == null` → New chip; `ci: 'failing'` → danger dot; `showCategoryChip=true` + enrichment → chip rendered; `showCategoryChip=false` → no chip; click → router `navigate` called with right path (use a `MemoryRouter` + spy).

### Task 13.3: `InboxSection`

**Files:**
- Create: `frontend/src/components/Inbox/InboxSection.tsx`
- Create: `frontend/src/components/Inbox/InboxSection.module.css`
- Create: `frontend/__tests__/InboxSection.test.tsx`

- [ ] **Step 1: Component**

```tsx
import { useState } from 'react';
import type { InboxSection as InboxSectionDto, InboxItemEnrichment, PrInboxItem } from '../../api/types';
import { InboxRow } from './InboxRow';
import styles from './InboxSection.module.css';

const EmptyCopy: Record<string, string> = {
  'review-requested': 'No reviews requested right now.',
  'awaiting-author':  'Nothing waiting on the author.',
  'authored-by-me':   "You haven't opened any PRs.",
  'mentioned':        "You aren't @-mentioned on any open PRs.",
  'ci-failing':       'No CI failures on your PRs — nice.',
};

interface Props {
  section: InboxSectionDto;
  enrichments: Record<string, InboxItemEnrichment>;
  showCategoryChip: boolean;
  maxDiff: number;
}

function prId(pr: PrInboxItem): string {
  return `${pr.reference.owner}/${pr.reference.repo}#${pr.reference.number}`;
}

export function InboxSection({ section, enrichments, showCategoryChip, maxDiff }: Props) {
  const [open, setOpen] = useState(true);
  return (
    <section className={styles.section}>
      <button className={styles.header} onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'}</span>
        <span className={styles.label}>{section.label}</span>
        <span className={styles.count}>{section.items.length}</span>
      </button>
      {open && (
        <div className={styles.body}>
          {section.items.length === 0
            ? <div className={styles.empty}>{EmptyCopy[section.id] ?? 'Nothing here.'}</div>
            : section.items.map((pr) => (
                <InboxRow
                  key={prId(pr)}
                  pr={pr}
                  enrichment={enrichments[prId(pr)]}
                  showCategoryChip={showCategoryChip}
                  maxDiff={maxDiff}
                />
              ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Tests** — toggle open/closed; section-specific empty copy by id; count rendered; rows render N items.

- [ ] **Step 3: Commit**

```
npm --prefix frontend test -- --run
git add -A
git commit -m "feat(frontend): DiffBar / InboxRow / InboxSection components

Mirror the design-handoff with TypeScript types and React Router navigation.
Per-section empty-state copy. First-visit semantics: New chip when
lastViewedHeadSha is null. CI-failing dot. Category chip gated by
showCategoryChip prop (consumer decides via useCapabilities)."
```

---

## Phase 14 — Frontend toolbars + banner + footer

### Task 14.1: `PasteUrlInput`

**Files:** Create `frontend/src/components/Inbox/PasteUrlInput.tsx` + tests.

- [ ] **Step 1: Component**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { inboxApi } from '../../api/inbox';
import styles from './PasteUrlInput.module.css';

export function PasteUrlInput() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (raw: string) => {
    setError(null);
    if (!raw.trim()) return;
    try {
      const resp = await inboxApi.parsePrUrl(raw.trim());
      if (resp.ok && resp.ref) {
        navigate(`/pr/${resp.ref.owner}/${resp.ref.repo}/${resp.ref.number}`);
        setValue('');
        return;
      }
      switch (resp.error) {
        case 'host-mismatch':
          setError(`This PR is on ${resp.urlHost}, but PRism is configured for ${resp.configuredHost}.`);
          break;
        case 'not-a-pr-url':
          setError("That doesn't look like a PR link.");
          break;
        default:
          setError("Couldn't parse that URL.");
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
  };

  return (
    <div className={styles.wrap}>
      <input
        className={styles.input}
        type="text"
        placeholder="Paste a PR URL to open it…"
        value={value}
        onChange={(e) => { setValue(e.target.value); setError(null); }}
        onPaste={(e) => {
          // Defer to onChange-fired-after-paste; submit immediately on the new value.
          const pasted = e.clipboardData.getData('text');
          setValue(pasted);
          void submit(pasted);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(value); }}
      />
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Tests** — happy paste navigates; host-mismatch shows pill; not-a-pr-url shows pill; clear-on-edit; Enter submits typed value.

### Task 14.2: `InboxBanner` + `InboxFooter` + `EmptyAllSections` + `InboxToolbar`

**Files:**
- Create: `frontend/src/components/Inbox/InboxBanner.tsx` + tests
- Create: `frontend/src/components/Inbox/InboxFooter.tsx`
- Create: `frontend/src/components/Inbox/EmptyAllSections.tsx`
- Create: `frontend/src/components/Inbox/InboxToolbar.tsx`

- [ ] **Step 1: `InboxBanner`**

```tsx
import styles from './InboxBanner.module.css';

interface Props { summary: string; onReload: () => void; onDismiss: () => void; }
export function InboxBanner({ summary, onReload, onDismiss }: Props) {
  return (
    <div className={styles.banner} role="status">
      <span className={styles.summary}>{summary} — </span>
      <button className={styles.reload} onClick={onReload}>Reload</button>
      <button className={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}
```

- [ ] **Step 2: `InboxFooter`**

```tsx
import styles from './InboxFooter.module.css';

export function InboxFooter() {
  return (
    <div className={styles.footer}>
      Some PRs may be hidden — paste a PR URL above to access ones not in your inbox.
    </div>
  );
}
```

- [ ] **Step 3: `EmptyAllSections`**

```tsx
import styles from './EmptyAllSections.module.css';

export function EmptyAllSections() {
  return (
    <div className={styles.hint}>
      Nothing in your inbox right now. Try pasting a PR URL above to jump to a specific PR, or wait for a review request.
    </div>
  );
}
```

- [ ] **Step 4: `InboxToolbar`**

```tsx
import { PasteUrlInput } from './PasteUrlInput';
import styles from './InboxToolbar.module.css';

export function InboxToolbar() {
  return (
    <div className={styles.toolbar}>
      <PasteUrlInput />
    </div>
  );
}
```

- [ ] **Step 5: Tests** — `InboxBanner` shows summary + click Reload + click Dismiss callbacks fire; rest are render-only smoke tests.

- [ ] **Step 6: Commit**

```
npm --prefix frontend test -- --run
git add -A
git commit -m "feat(frontend): toolbars + banner + footer + empty hint"
```

---

## Phase 15 — Activity rail (hand-canned)

### Task 15.1: Canned data + component

**Files:**
- Create: `frontend/src/components/ActivityRail/activityData.ts`
- Create: `frontend/src/components/ActivityRail/ActivityRail.tsx`
- Create: `frontend/src/components/ActivityRail/ActivityRail.module.css`
- Create: `frontend/__tests__/ActivityRail.test.tsx`

- [ ] **Step 1: Canned data** (lifted verbatim from `design/handoff/screens.jsx` lines 117-180)

```ts
export interface ActivityItem {
  who: string;
  what: string;
  pr: string;
  when: string;
  isSystem?: boolean;
}

export interface WatchedRepo { repo: string; count: number; }

export const activityItems: ActivityItem[] = [
  { who: 'amelia.cho', what: 'pushed iter 3 to', pr: '#1842', when: '12m' },
  { who: 'noah.s',     what: 'commented on',     pr: '#1810', when: '1h' },
  { who: 'jules.t',    what: 'force-pushed',     pr: '#1827', when: '3h' },
  { who: 'rohan.k',    what: 'opened',           pr: '#1839', when: '1h' },
  { who: 'amelia.cho', what: 'replied to your comment on', pr: '#1842', when: '2h' },
  { who: 'ci-bot',     what: 'marked CI failing on', pr: '#1827', when: '3h', isSystem: true },
];

export const watchedRepos: WatchedRepo[] = [
  { repo: 'platform/billing-svc', count: 2 },
  { repo: 'platform/tenants-api', count: 1 },
  { repo: 'platform/web-edge',    count: 0 },
];
```

- [ ] **Step 2: Component**

```tsx
import { activityItems, watchedRepos } from './activityData';
import styles from './ActivityRail.module.css';

export function ActivityRail() {
  return (
    <aside className={styles.rail} aria-label="Activity">
      <section className={styles.section}>
        <header className={styles.head}>
          <span className={styles.title}>Activity</span>
          <span className={styles.muted}>last 24h</span>
        </header>
        <ol className={styles.list}>
          {activityItems.map((it, i) => (
            <li key={i} className={styles.item}>
              <span className={styles.actor}>{it.who}</span>
              {' '}{it.what}{' '}
              <span className={styles.pr}>{it.pr}</span>
              <span className={styles.when}> · {it.when} ago</span>
            </li>
          ))}
        </ol>
      </section>
      <section className={styles.section}>
        <header className={styles.head}><span className={styles.title}>Watching</span></header>
        <ul className={styles.list}>
          {watchedRepos.map((r) => (
            <li key={r.repo} className={styles.item}>
              <span className={styles.repo}>{r.repo}</span>
              {r.count > 0 ? <span className={styles.count}>{r.count}</span> : <span className={styles.muted}>idle</span>}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
```

- [ ] **Step 3: CSS — include the 1180px responsive rule**

`ActivityRail.module.css`:
```css
.rail { /* desktop styling lifted from design handoff */ }
@media (max-width: 1179px) { .rail { display: none; } }
```

- [ ] **Step 4: Tests** — renders all activity items; 1180px hide is a CSS test (skipped — covered by Playwright viewport test instead).

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "feat(frontend): hand-canned ActivityRail (no AI seam)

Items lifted verbatim from design/handoff/screens.jsx ActivityFeed.
Gated on aiPreview at the parent level (see InboxPage). 1180px @media
rule hides the rail on smaller viewports per the handoff README."
```

---

## Phase 16 — Pages, routing, gating

### Task 16.1: `S3StubPrPage`

**Files:** Create `frontend/src/pages/S3StubPrPage.tsx` + test.

- [ ] **Step 1: Component**

```tsx
import { Link, useParams } from 'react-router-dom';

export function S3StubPrPage() {
  const { owner, repo, number } = useParams();
  return (
    <main>
      <h1>PR detail lands in S3</h1>
      <p>Parsed reference: <code>{owner}/{repo}#{number}</code></p>
      <Link to="/">Back to Inbox</Link>
    </main>
  );
}
```

- [ ] **Step 2: Test** — render with route params; assert reference shown; assert Back link navigates `/`.

### Task 16.2: `InboxPage` (rename + full implementation)

**Files:**
- Delete: `frontend/src/pages/InboxShellPage.tsx`
- Create: `frontend/src/pages/InboxPage.tsx`

- [ ] **Step 1: Implementation**

```tsx
import { useMemo } from 'react';
import { useInbox } from '../hooks/useInbox';
import { useInboxUpdates } from '../hooks/useInboxUpdates';
import { useCapabilities } from '../hooks/useCapabilities';
import { usePreferences } from '../hooks/usePreferences';
import { InboxBanner } from '../components/Inbox/InboxBanner';
import { InboxToolbar } from '../components/Inbox/InboxToolbar';
import { InboxSection } from '../components/Inbox/InboxSection';
import { InboxFooter } from '../components/Inbox/InboxFooter';
import { EmptyAllSections } from '../components/Inbox/EmptyAllSections';
import { ActivityRail } from '../components/ActivityRail/ActivityRail';
import styles from './InboxPage.module.css';

export function InboxPage() {
  const { data, error, isLoading, reload } = useInbox();
  const updates = useInboxUpdates();
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();

  const showCategoryChip = capabilities?.inboxEnrichment === true;
  const showActivityRail = preferences?.aiPreview === true;
  const sections = data?.sections ?? [];
  const allEmpty = sections.length > 0 && sections.every((s) => s.items.length === 0);

  const maxDiff = useMemo(() => {
    let m = 1;
    for (const s of sections) for (const p of s.items) {
      const t = p.additions + p.deletions;
      if (t > m) m = t;
    }
    return m;
  }, [sections]);

  if (isLoading && !data) return <main aria-busy="true">Loading…</main>;
  if (error && !data) return (
    <main role="alert">
      <p>Couldn't load inbox.</p>
      <button onClick={() => void reload()}>Try again</button>
    </main>
  );
  if (!data) return null;

  const onReload = async () => { await reload(); updates.dismiss(); };

  return (
    <main className={styles.page}>
      {updates.hasUpdate && (
        <InboxBanner summary={updates.summary} onReload={onReload} onDismiss={updates.dismiss} />
      )}
      <InboxToolbar />
      <div className={styles.grid}>
        <div className={styles.sections}>
          {allEmpty && <EmptyAllSections />}
          {sections.map((s) => (
            <InboxSection
              key={s.id}
              section={s}
              enrichments={data.enrichments}
              showCategoryChip={showCategoryChip}
              maxDiff={maxDiff}
            />
          ))}
          {data.tokenScopeFooterEnabled && <InboxFooter />}
        </div>
        {showActivityRail && <ActivityRail />}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Tests** — render with MSW returning a fixture inbox; rows visible; banner appears on simulated SSE event; `aiPreview: false` → no rail; `inboxEnrichment: false` → no chips.

### Task 16.3: App.tsx routing

**Files:** Modify `frontend/src/App.tsx`.

- [ ] **Step 1: Replace routes block**

Replace the lines:
```tsx
<Route path="/setup" element={<SetupPage />} />
<Route path="/inbox-shell" element={<InboxShellPage />} />
<Route path="*" element={<Navigate to={authState.hasToken ? '/inbox-shell' : '/setup'} replace />} />
```
with:
```tsx
<Route path="/setup" element={<SetupPage />} />
<Route path="/" element={<InboxPage />} />
<Route path="/pr/:owner/:repo/:number" element={<S3StubPrPage />} />
<Route path="*" element={<Navigate to={authState.hasToken ? '/' : '/setup'} replace />} />
```

Update imports — replace the `InboxShellPage` import with:
```tsx
import { InboxPage } from './pages/InboxPage';
import { S3StubPrPage } from './pages/S3StubPrPage';
```

- [ ] **Step 2: Build + commit**

```
npm --prefix frontend run build
npm --prefix frontend test -- --run
git add -A
git commit -m "feat(frontend): InboxPage + S3StubPrPage + routing

InboxPage replaces InboxShellPage placeholder. Routes / → InboxPage,
/pr/:owner/:repo/:number → S3StubPrPage (deleted in S3). Banner / rail
gating wired via useCapabilities + usePreferences."
```

---

## Phase 17 — Playwright E2E + final verification

### Task 17.1: E2E tests

**Files:** Create / extend tests under `frontend/e2e/`.

- [ ] **Step 1: Cold-start happy path**

```ts
// frontend/e2e/inbox-cold-start.spec.ts
import { test, expect } from '@playwright/test';

test('cold start → setup → inbox loads with stub PRs', async ({ page }) => {
  // The test build runs the backend with a fixture-backed fake GitHub.
  await page.goto('/');
  // (Setup flow is shared with S0+S1 e2e — paste PAT, submit, await redirect)
  await page.getByPlaceholder(/personal access token/i).fill('ghp_test');
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page.getByRole('heading', { name: /review requested/i })).toBeVisible();
});
```

- [ ] **Step 2: URL paste happy + error**

```ts
test('URL paste → S3 stub', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/paste a pr url/i).fill('https://github.com/foo/bar/pull/9');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/PR detail lands in S3/i)).toBeVisible();
  await expect(page.getByText('foo/bar#9')).toBeVisible();
});

test('URL paste host mismatch → inline error', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/paste a pr url/i).fill('https://ghe.acme.com/foo/bar/pull/9');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/configured for https:\/\/github\.com/i)).toBeVisible();
});
```

- [ ] **Step 3: SSE banner → reload**

```ts
test('SSE banner appears → reload clears', async ({ page, request }) => {
  await page.goto('/');
  // poke a backend test endpoint that publishes an InboxUpdated event
  await request.post('/test/inbox/publish', { data: { newOrUpdatedPrCount: 3 } });
  await expect(page.getByText(/3 new updates/i)).toBeVisible();
  await page.getByRole('button', { name: /reload/i }).click();
  await expect(page.getByText(/3 new updates/i)).not.toBeVisible();
});
```

(The `/test/inbox/publish` endpoint exists only when `IsEnvironment("Test")`, mirroring the S0+S1 `/test/boom` pattern.)

- [ ] **Step 4: AI preview toggles activity rail + chips**

```ts
test('AI preview toggle flips chips and activity rail', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: /activity/i })).not.toBeVisible();
  await page.getByRole('button', { name: /ai preview/i }).click();
  await expect(page.getByRole('complementary', { name: /activity/i })).toBeVisible();
});
```

- [ ] **Step 5: Run + commit**

```
npm --prefix frontend run build
dotnet test
npm --prefix frontend exec -- playwright install --with-deps
npm --prefix frontend exec -- playwright test
git add -A
git commit -m "test(e2e): inbox cold-start, URL paste, SSE banner, AI preview toggle"
```

---

## Phase 18 — End-of-slice verification

- [ ] **Step 1: Run full suite from worktree root**

```
dotnet test
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix frontend test -- --run
npm --prefix frontend exec -- playwright test
```
Expected: all green.

- [ ] **Step 2: Manual smoke test** (optional but recommended)

```
dotnet run --project PRism.Web
```
- Browser opens at `http://localhost:5180–5199`.
- Enter a real fine-grained PAT → inbox loads with five sections.
- Toggle AI preview in header → category chips + activity rail appear.
- Paste a real PR URL → routes to S3 stub.
- Wait 120s after a teammate pushes/comments → banner appears → click Reload.

- [ ] **Step 3: Open the PR**

Push the worktree branch, open a PR against `main`, request review. Two `@claude` workflows will run automatically (`claude-code-review.yml` + `claude.yml`).

---

## Self-review checklist

After producing this plan, the writer ran the checklist:

**1. Spec coverage** — every section/requirement from `docs/superpowers/specs/2026-05-06-inbox-read-design.md` § 2 (In scope) maps to at least one task:

| Spec item | Task |
|---|---|
| Pipeline (5 components) | Phases 3–8 |
| 5 sections + Search API queries | Phase 5 |
| Backend dedup | Phase 3 |
| Per-PR fan-out + caches + concurrency cap 8 | Phases 6–7 (+ enricher in 8.1) |
| InboxPoller (subscriber-gated) | Phase 8.3 |
| `/api/events` SSE | Phase 9 |
| `/api/inbox` GET (with 503 path) | Phase 10 |
| `/api/inbox/parse-pr-url` POST | Phase 10 |
| PrInboxItem expansion | Phase 2 |
| AI seam drift correction | Phase 1 |
| Inbox view per design handoff | Phases 13–16 |
| URL-paste escape hatch | Phases 14, 16 |
| S3StubPrPage | Phase 16 |
| Activity rail (hand-canned) | Phase 15 |
| Inbox banner | Phases 14, 16 |
| AI category chips | Phases 13, 16 |
| Token-scope footer | Phases 14, 16 |
| 1180px responsive collapse | Phase 15 |

**2. Placeholder scan** — no "TBD", "TODO", "implement later" strings in the plan.

**3. Type consistency** — `IInboxItemEnricher` / `InboxItemEnrichment` names match throughout. Section ID kebab-strings used in C# dict keys, JSON field values, React selectors. `CiStatus` enum identical in C# / TS (`'none' | 'pending' | 'failing'`).

**4. Ambiguity check** — section labels are explicit constants; SSE frame format is explicit; error JSON shapes are explicit. The `viewerLogin` injection (Phase 8 / 11) is the one slightly soft point — `IViewerLoginProvider` interface is defined in Phase 11 and consumed in Phase 8; ordering is fine because Phase 11 lands before any consumer runs at the orchestrator's `RefreshAsync`.

---

## Decisions deferred from the design (resolved here)

- **SSE polyfill in Vitest tests**: 30-line in-house `FakeEventSource` (Phase 12.4 Step 2). No npm dep added.
- **`activityData.ts` shape**: TS constants (Phase 15.1). No JSON import.
- **Banner summary copy**: `${count} new updates` (Phase 14.2 Step 1). The handoff's "PRs have updates since you last loaded" is wordier; the spec wording is shorter and matches the spec's own example.
- **AI seam drift commit grouping**: rolled into the S2 PR (Phase 1, single commit before any consumer wires up).
- **`InboxContext` shape**: not introduced — `InboxPage` reads the hooks directly and passes via props (Phase 16.2). Context-provider can be added if a deep child needs it; in S2 the tree is shallow.
- **`IInboxRanker` invocation point**: skipped entirely — the Noop returns identity, and there is no consumer to drive the call. Slot is reserved by `IAiSeamSelector`. v2 wires the call when a real ranker exists.






