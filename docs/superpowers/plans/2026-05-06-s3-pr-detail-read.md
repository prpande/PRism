# S3 — PR Detail (read) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PRism's PR detail surface real — three sub-tabs (Overview / Files / Drafts), iteration tabs computed via the new weighted-distance algorithm, file tree + diff workhorse, banner-driven update SSE, AI placeholders. No drafts, no composer, no submit.

**Architecture:** Backend grows `IReviewService` with read-side methods (`GetPrDetailAsync`, `GetDiffAsync`, `GetFileContentAsync`, `GetTimelineAsync`); a new `PrDetail/` namespace coordinates loading, clustering, caching, and the active-PR poller; SSE channel evolves from broadcast (S2) to per-PR fanout with subscribe/unsubscribe REST endpoints. Frontend ships a 3-tab page under `/pr/:owner/:repo/:number`, a collapsible directory file tree with smart compaction, `react-diff-view` + `jsdiff` for the diff workhorse, and a Markdown pipeline (`react-markdown` v9 + `remark-gfm` + Shiki + Mermaid `securityLevel: 'strict'`) shared across PR description, comment bodies, and `.md` file rendering. State migrates v1 → v2 (sequential int) by adding a `ViewedFiles` field to `ReviewSessionState`; future-version files enter read-only mode + saves blocked. Cross-origin defense: `OriginCheckMiddleware` tightened (no empty Origin on POST/DELETE) + new `SessionTokenMiddleware`.

**Tech Stack:** .NET 10 / ASP.NET Core (Kestrel + minimal APIs + xUnit + `WebApplicationFactory`); React 18 + Vite + TypeScript + Vitest + React Testing Library; `react-diff-view` + `jsdiff` (npm `diff`) + `react-markdown` v9 + `remark-gfm` + `shiki` + `mermaid` + `eventsource-mock`; `Xunit.SkippableFact` for the discipline-check harness.

**Spec authority:** `C:\src\PRism-s3-spec\docs\superpowers\specs\2026-05-06-s3-pr-detail-read-design.md`. When in doubt, the spec wins; this plan translates it into ordered executable steps.

---

## Pre-Task: Working Environment

- [ ] **Verify worktree.** Confirm you're in `C:\src\PRism-s3-spec` on branch `feat/s3-pr-detail-spec` (or a child branch off it). All commands assume this working directory unless stated otherwise.

```powershell
git -C C:\src\PRism-s3-spec status
# Expected: On branch feat/s3-pr-detail-spec (or descendant); clean tree.
```

- [ ] **Pull latest.** Make sure the spec at `docs/superpowers/specs/2026-05-06-s3-pr-detail-read-design.md` is current.

```powershell
git -C C:\src\PRism-s3-spec pull --ff-only
```

- [ ] **Solution sanity-check.** Confirm S2 builds and tests pass before adding S3 code. This is the green baseline.

```powershell
dotnet build C:\src\PRism-s3-spec\PRism.sln
dotnet test C:\src\PRism-s3-spec\PRism.sln
# Expected: build succeeds; all tests pass.
```

If anything fails, stop and resolve before proceeding.

---

## Task 1: State Migration — Add `ViewedFiles` + read-only-on-future-version

**Files:**
- Modify: `PRism.Core/State/ReviewSessionState.cs`
- Modify: `PRism.Core/State/AppState.cs`
- Modify: `PRism.Core/State/AppStateStore.cs`
- Modify: `PRism.Core/State/IAppStateStore.cs`
- Test: `tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs` (new)

### Step 1.1: Write the failing test for v1 → v2 migration

- [ ] **Create the test file.**

```csharp
// tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs
using System.Text.Json;
using System.Text.Json.Nodes;
using FluentAssertions;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.State;

public class AppStateStoreMigrationTests
{
    private static string TempStatePath() =>
        Path.Combine(Path.GetTempPath(), $"prism-state-{Guid.NewGuid():N}.json");

    [Fact]
    public async Task LoadAsync_migrates_v1_state_file_to_v2_and_adds_empty_viewed_files_to_each_session()
    {
        var path = TempStatePath();
        await File.WriteAllTextAsync(path, """
        {
          "version": 1,
          "review-sessions": {
            "owner/repo/123": {
              "last-viewed-head-sha": "abc123",
              "last-seen-comment-id": "42",
              "pending-review-id": null,
              "pending-review-commit-oid": null
            }
          },
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "github.com"
        }
        """);

        var store = new AppStateStore(path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(2);
        state.ReviewSessions.Should().ContainKey("owner/repo/123");
        state.ReviewSessions["owner/repo/123"].ViewedFiles.Should().BeEmpty();
        state.ReviewSessions["owner/repo/123"].LastViewedHeadSha.Should().Be("abc123");

        File.Delete(path);
    }
}
```

### Step 1.2: Run the test to verify it fails

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests\PRism.Core.Tests.csproj --filter "FullyQualifiedName~AppStateStoreMigrationTests"
```

Expected: **FAIL** with a compile error: `ReviewSessionState` does not contain `ViewedFiles`.

### Step 1.3: Add `ViewedFiles` to `ReviewSessionState`

- [ ] Modify `PRism.Core/State/ReviewSessionState.cs` (or wherever `ReviewSessionState` lives — verify with `Grep` first):

```csharp
namespace PRism.Core.State;

public sealed record ReviewSessionState(
    string? LastViewedHeadSha,
    string? LastSeenCommentId,
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    IReadOnlyDictionary<string, string> ViewedFiles);
```

If the existing `ReviewSessionState` is defined inside `AppState.cs`, add the field there. The constructor parameter ordering matches the existing record exactly with `ViewedFiles` appended last.

### Step 1.4: Update `AppState.Default` to include the new field

- [ ] Locate `AppState.Default` in `PRism.Core/State/AppState.cs`. Confirm `Version` is currently `1`. Update to:

```csharp
public sealed record AppState(
    int Version,
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
```

### Step 1.5: Add the `MigrateIfNeeded` + `MigrateV1ToV2` private helpers

- [ ] Modify `PRism.Core/State/AppStateStore.cs`. Add a private `const int CurrentVersion = 2;` near the top of the class. Add a `bool IsReadOnlyMode { get; private set; }` public property. Then add the migration helpers as private static methods at the bottom of the class:

```csharp
internal const int CurrentVersion = 2;

public bool IsReadOnlyMode { get; private set; }

private JsonNode MigrateIfNeeded(JsonNode root)
{
    var versionNode = root["version"];
    if (versionNode is null)
        throw new UnsupportedStateVersionException(0);

    var stored = versionNode.GetValue<int>();

    if (stored > CurrentVersion)
    {
        IsReadOnlyMode = true;
        return root;
    }

    if (stored < 2) root = MigrateV1ToV2(root);
    IsReadOnlyMode = false;
    return root;
}

private static JsonNode MigrateV1ToV2(JsonNode root)
{
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

### Step 1.6: Wire `MigrateIfNeeded` into `LoadAsync`

- [ ] In `AppStateStore.LoadAsync`, change the parse-and-deserialize sequence to parse → migrate → deserialize. Locate the existing block that does `JsonSerializer.Deserialize<AppState>(raw, ...)` and replace with:

```csharp
JsonNode? node;
try
{
    node = JsonNode.Parse(raw);
}
catch (JsonException)
{
    QuarantineFile(raw);
    return AppState.Default;
}

if (node is null)
{
    QuarantineFile(raw);
    return AppState.Default;
}

node = MigrateIfNeeded(node);

var state = node.Deserialize<AppState>(StorageJsonOptions);
if (state is null)
{
    QuarantineFile(raw);
    return AppState.Default;
}

return state;
```

(Leave the existing `QuarantineFile` / `StorageJsonOptions` references alone; they exist in S0+S1's `AppStateStore`.)

### Step 1.7: Make `SaveAsync` honor `IsReadOnlyMode`

- [ ] In `AppStateStore.SaveAsync` (or `SaveCoreAsync`), at the top of the method body add:

```csharp
if (IsReadOnlyMode)
    throw new InvalidOperationException(
        "AppStateStore is in read-only mode (state.json was written by a newer PRism version). " +
        "Saves are blocked until the binary is upgraded.");
```

The endpoints that perform writes (mark-viewed, viewed, subscriptions) catch this exception and translate it to `423 { type: "/state/read-only" }` per § 8 — that translation lands in the endpoint task (Task 4 / Task 5). For now, the throw is the seam.

### Step 1.8: Run the test to verify it passes

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests\PRism.Core.Tests.csproj --filter "FullyQualifiedName~AppStateStoreMigrationTests"
```

Expected: **PASS**.

### Step 1.9: Add the four remaining migration tests

- [ ] Append to `AppStateStoreMigrationTests.cs`:

```csharp
[Fact]
public async Task LoadAsync_leaves_v2_state_file_unchanged()
{
    var path = TempStatePath();
    await File.WriteAllTextAsync(path, """
    {
      "version": 2,
      "review-sessions": {
        "owner/repo/123": {
          "last-viewed-head-sha": "abc",
          "last-seen-comment-id": "1",
          "pending-review-id": null,
          "pending-review-commit-oid": null,
          "viewed-files": { "src/Foo.cs": "abc" }
        }
      },
      "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
      "last-configured-github-host": "github.com"
    }
    """);

    var store = new AppStateStore(path);
    var state = await store.LoadAsync(CancellationToken.None);

    state.Version.Should().Be(2);
    state.ReviewSessions["owner/repo/123"].ViewedFiles.Should().ContainKey("src/Foo.cs");
    store.IsReadOnlyMode.Should().BeFalse();

    File.Delete(path);
}

[Fact]
public async Task LoadAsync_throws_on_missing_version_field()
{
    var path = TempStatePath();
    await File.WriteAllTextAsync(path, """
    {
      "review-sessions": {},
      "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
      "last-configured-github-host": "github.com"
    }
    """);

    var store = new AppStateStore(path);
    // Missing version is treated as malformed JSON via the existing quarantine path.
    var state = await store.LoadAsync(CancellationToken.None);

    state.Should().BeEquivalentTo(AppState.Default);
    File.Exists(path).Should().BeFalse();      // original quarantined
    Directory.GetFiles(Path.GetDirectoryName(path)!, $"{Path.GetFileName(path)}.corrupt-*").Should().NotBeEmpty();

    foreach (var f in Directory.GetFiles(Path.GetDirectoryName(path)!, $"{Path.GetFileName(path)}.corrupt-*"))
        File.Delete(f);
}

[Fact]
public async Task LoadAsync_enters_read_only_mode_on_future_version()
{
    var path = TempStatePath();
    await File.WriteAllTextAsync(path, """
    {
      "version": 99,
      "review-sessions": {},
      "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
      "last-configured-github-host": "github.com"
    }
    """);

    var store = new AppStateStore(path);
    _ = await store.LoadAsync(CancellationToken.None);

    store.IsReadOnlyMode.Should().BeTrue();
    File.Delete(path);
}

[Fact]
public async Task SaveAsync_throws_when_in_read_only_mode()
{
    var path = TempStatePath();
    await File.WriteAllTextAsync(path, """
    {
      "version": 99,
      "review-sessions": {},
      "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
      "last-configured-github-host": "github.com"
    }
    """);

    var store = new AppStateStore(path);
    var state = await store.LoadAsync(CancellationToken.None);

    var act = async () => await store.SaveAsync(state, CancellationToken.None);
    await act.Should().ThrowAsync<InvalidOperationException>().WithMessage("*read-only mode*");

    File.Delete(path);
}
```

### Step 1.10: Run all migration tests

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests\PRism.Core.Tests.csproj --filter "FullyQualifiedName~AppStateStoreMigrationTests"
```

Expected: **5 passing** (legacy → v2; v2 unchanged; missing-version quarantines; future-version → read-only; SaveAsync throws in read-only).

### Step 1.11: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr1-state-migration
git -C C:\src\PRism-s3-spec add PRism.Core/State tests/PRism.Core.Tests/State
git -C C:\src\PRism-s3-spec commit -m "feat(state): add ViewedFiles + v1->v2 migration + read-only-on-future-version (S3 PR1)"
```

---

## Task 2: Iteration Clustering Core (incl. discipline-check harness)

**Files:**
- Create: `PRism.Core/Iterations/IIterationClusteringStrategy.cs`
- Create: `PRism.Core/Iterations/IDistanceMultiplier.cs`
- Create: `PRism.Core/Iterations/IterationClusteringCoefficients.cs`
- Create: `PRism.Core/Iterations/ClusteringInput.cs`
- Create: `PRism.Core/Iterations/IterationCluster.cs`
- Create: `PRism.Core/Iterations/FileJaccardMultiplier.cs`
- Create: `PRism.Core/Iterations/ForcePushMultiplier.cs`
- Create: `PRism.Core/Iterations/MadThresholdComputer.cs`
- Create: `PRism.Core/Iterations/WeightedDistanceClusteringStrategy.cs`
- Test: `tests/PRism.Core.Tests/Iterations/MadThresholdComputerTests.cs`
- Test: `tests/PRism.Core.Tests/Iterations/FileJaccardMultiplierTests.cs`
- Test: `tests/PRism.Core.Tests/Iterations/ForcePushMultiplierTests.cs`
- Test: `tests/PRism.Core.Tests/Iterations/WeightedDistanceClusteringStrategyTests.cs`
- Test: `tests/PRism.Core.Tests/Iterations/ClusteringDisciplineCheck.cs` (skipped fact)
- Modify: `tests/PRism.Core.Tests/PRism.Core.Tests.csproj` — add `Xunit.SkippableFact` package reference

### Step 2.1: Add the `Xunit.SkippableFact` NuGet package

- [ ] Run:

```powershell
dotnet add C:\src\PRism-s3-spec\tests\PRism.Core.Tests\PRism.Core.Tests.csproj package Xunit.SkippableFact
```

### Step 2.2: Define the input / output types

- [ ] Create `PRism.Core/Iterations/ClusteringInput.cs`:

```csharp
namespace PRism.Core.Iterations;

public sealed record ClusteringInput(
    IReadOnlyList<ClusteringCommit> Commits,
    IReadOnlyList<ClusteringForcePush> ForcePushes,
    IReadOnlyList<ClusteringReviewEvent> ReviewEvents,
    IReadOnlyList<ClusteringAuthorComment> AuthorPrComments);

public sealed record ClusteringCommit(
    string Sha,
    DateTimeOffset CommittedDate,
    string Message,
    int Additions,
    int Deletions,
    IReadOnlyList<string>? ChangedFiles);   // null = unknown (e.g., truncation, fan-out skipped)

public sealed record ClusteringForcePush(
    string? BeforeSha,
    string? AfterSha,
    DateTimeOffset OccurredAt);

public sealed record ClusteringReviewEvent(DateTimeOffset SubmittedAt);

public sealed record ClusteringAuthorComment(DateTimeOffset AuthoredAt);
```

- [ ] Create `PRism.Core/Iterations/IterationCluster.cs`:

```csharp
namespace PRism.Core.Iterations;

public sealed record IterationCluster(
    int IterationNumber,
    string BeforeSha,
    string AfterSha,
    IReadOnlyList<string> CommitShas);
```

- [ ] Create `PRism.Core/Iterations/IterationClusteringCoefficients.cs`:

```csharp
namespace PRism.Core.Iterations;

public sealed record IterationClusteringCoefficients(
    double FileJaccardWeight = 0.5,
    double ForcePushAfterLongGap = 1.5,
    int ForcePushLongGapSeconds = 600,
    int MadK = 3,
    int HardFloorSeconds = 300,
    int HardCeilingSeconds = 259200,
    int SkipJaccardAboveCommitCount = 100,
    double DegenerateFloorFraction = 0.5,
    int MaxFallbackTabs = 20);
```

### Step 2.3: Define the strategy + multiplier interfaces

- [ ] Create `PRism.Core/Iterations/IIterationClusteringStrategy.cs`:

```csharp
namespace PRism.Core.Iterations;

public interface IIterationClusteringStrategy
{
    IReadOnlyList<IterationCluster> Cluster(
        ClusteringInput input,
        IterationClusteringCoefficients coefficients);
}
```

- [ ] Create `PRism.Core/Iterations/IDistanceMultiplier.cs`:

```csharp
namespace PRism.Core.Iterations;

public interface IDistanceMultiplier
{
    /// <summary>Returns the multiplier in (0, ∞) for the gap between the two consecutive commits.</summary>
    double For(
        ClusteringCommit prev,
        ClusteringCommit next,
        ClusteringInput input,
        IterationClusteringCoefficients coefficients);
}
```

### Step 2.4: Write `MadThresholdComputerTests`

- [ ] Create `tests/PRism.Core.Tests/Iterations/MadThresholdComputerTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Iterations;
using Xunit;

namespace PRism.Core.Tests.Iterations;

public class MadThresholdComputerTests
{
    [Fact]
    public void Compute_with_bimodal_distribution_returns_threshold_between_modes()
    {
        var distances = new[] { 60.0, 65, 58, 62, 3600, 3500 };  // small cluster + two outliers
        var threshold = MadThresholdComputer.Compute(distances, k: 3);
        threshold.Should().BeGreaterThan(70).And.BeLessThan(3500);
    }

    [Fact]
    public void Compute_with_constant_distances_returns_threshold_above_all_values()
    {
        var distances = new[] { 100.0, 100, 100, 100 };
        var threshold = MadThresholdComputer.Compute(distances, k: 3);
        threshold.Should().BeGreaterThan(100);
    }

    [Fact]
    public void Compute_with_single_element_returns_above_that_element()
    {
        var distances = new[] { 42.0 };
        var threshold = MadThresholdComputer.Compute(distances, k: 3);
        threshold.Should().BeGreaterThan(42);
    }

    [Fact]
    public void Compute_with_empty_returns_double_max_value()
    {
        var threshold = MadThresholdComputer.Compute(Array.Empty<double>(), k: 3);
        threshold.Should().Be(double.MaxValue);
    }
}
```

### Step 2.5: Implement `MadThresholdComputer`

- [ ] Create `PRism.Core/Iterations/MadThresholdComputer.cs`:

```csharp
namespace PRism.Core.Iterations;

public static class MadThresholdComputer
{
    public static double Compute(IReadOnlyList<double> distances, int k)
    {
        if (distances.Count == 0) return double.MaxValue;

        var sorted = distances.OrderBy(x => x).ToArray();
        var median = Median(sorted);

        var deviations = distances.Select(x => Math.Abs(x - median)).OrderBy(x => x).ToArray();
        var mad = Median(deviations);

        // If MAD is zero (all values identical), return slightly above the median so nothing splits.
        return mad <= double.Epsilon ? median + 1 : median + k * mad;
    }

    private static double Median(double[] sorted)
    {
        if (sorted.Length == 0) return 0;
        var mid = sorted.Length / 2;
        return sorted.Length % 2 == 0
            ? (sorted[mid - 1] + sorted[mid]) / 2.0
            : sorted[mid];
    }
}
```

### Step 2.6: Run MAD tests

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests --filter "FullyQualifiedName~MadThresholdComputerTests"
```

Expected: **4 passing**.

### Step 2.7: Write `FileJaccardMultiplierTests`

- [ ] Create `tests/PRism.Core.Tests/Iterations/FileJaccardMultiplierTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Iterations;
using Xunit;

namespace PRism.Core.Tests.Iterations;

public class FileJaccardMultiplierTests
{
    private static readonly IterationClusteringCoefficients Defaults = new();

    private static ClusteringCommit Commit(string sha, params string[] files) =>
        new(sha, DateTimeOffset.UtcNow, "msg", 1, 0, files.Length == 0 ? null : files);

    private static ClusteringInput Input(params ClusteringCommit[] commits) =>
        new(commits, Array.Empty<ClusteringForcePush>(), Array.Empty<ClusteringReviewEvent>(),
            Array.Empty<ClusteringAuthorComment>());

    [Fact]
    public void Disjoint_files_returns_neutral_one()
    {
        var prev = Commit("a", "src/A.cs");
        var next = Commit("b", "src/B.cs");
        var m = new FileJaccardMultiplier();
        m.For(prev, next, Input(prev, next), Defaults).Should().BeApproximately(1.0, 0.001);
    }

    [Fact]
    public void Full_overlap_returns_minimum_zero_point_five()
    {
        var prev = Commit("a", "src/A.cs", "src/B.cs");
        var next = Commit("b", "src/A.cs", "src/B.cs");
        var m = new FileJaccardMultiplier();
        m.For(prev, next, Input(prev, next), Defaults).Should().BeApproximately(0.5, 0.001);
    }

    [Fact]
    public void Partial_overlap_lands_between_extremes()
    {
        var prev = Commit("a", "src/A.cs", "src/B.cs");
        var next = Commit("b", "src/B.cs", "src/C.cs");
        var m = new FileJaccardMultiplier();
        var result = m.For(prev, next, Input(prev, next), Defaults);
        result.Should().BeGreaterThan(0.5).And.BeLessThan(1.0);
    }

    [Fact]
    public void Empty_file_set_returns_neutral_one()
    {
        var prev = Commit("a");           // empty
        var next = Commit("b", "src/B.cs");
        var m = new FileJaccardMultiplier();
        m.For(prev, next, Input(prev, next), Defaults).Should().BeApproximately(1.0, 0.001);
    }

    [Fact]
    public void Unknown_changed_files_returns_neutral_one()
    {
        var prev = new ClusteringCommit("a", DateTimeOffset.UtcNow, "msg", 1, 0, ChangedFiles: null);
        var next = Commit("b", "src/B.cs");
        var m = new FileJaccardMultiplier();
        m.For(prev, next, Input(prev, next), Defaults).Should().BeApproximately(1.0, 0.001);
    }
}
```

### Step 2.8: Implement `FileJaccardMultiplier`

- [ ] Create `PRism.Core/Iterations/FileJaccardMultiplier.cs`:

```csharp
namespace PRism.Core.Iterations;

public sealed class FileJaccardMultiplier : IDistanceMultiplier
{
    public double For(
        ClusteringCommit prev,
        ClusteringCommit next,
        ClusteringInput input,
        IterationClusteringCoefficients coefficients)
    {
        if (prev.ChangedFiles is null || next.ChangedFiles is null) return 1.0;
        if (prev.ChangedFiles.Count == 0 || next.ChangedFiles.Count == 0) return 1.0;

        var prevSet = new HashSet<string>(prev.ChangedFiles, StringComparer.Ordinal);
        var nextSet = new HashSet<string>(next.ChangedFiles, StringComparer.Ordinal);

        var intersection = prevSet.Intersect(nextSet).Count();
        var union = prevSet.Union(nextSet).Count();
        if (union == 0) return 1.0;

        var jaccard = (double)intersection / union;
        return 1.0 - coefficients.FileJaccardWeight * jaccard;
    }
}
```

### Step 2.9: Run Jaccard tests

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests --filter "FullyQualifiedName~FileJaccardMultiplierTests"
```

Expected: **5 passing**.

### Step 2.10: Write `ForcePushMultiplierTests`

- [ ] Create `tests/PRism.Core.Tests/Iterations/ForcePushMultiplierTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Iterations;
using Xunit;

namespace PRism.Core.Tests.Iterations;

public class ForcePushMultiplierTests
{
    private static readonly IterationClusteringCoefficients Defaults = new();

    private static ClusteringCommit Commit(string sha, DateTimeOffset at) =>
        new(sha, at, "msg", 1, 0, Array.Empty<string>());

    private static ClusteringInput Input(IEnumerable<ClusteringCommit> commits, IEnumerable<ClusteringForcePush> forcePushes) =>
        new(commits.ToArray(), forcePushes.ToArray(), Array.Empty<ClusteringReviewEvent>(), Array.Empty<ClusteringAuthorComment>());

    [Fact]
    public void No_force_push_returns_neutral_one()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(60));
        var input = Input(new[] { prev, next }, Array.Empty<ClusteringForcePush>());
        new ForcePushMultiplier().For(prev, next, input, Defaults).Should().BeApproximately(1.0, 0.001);
    }

    [Fact]
    public void Force_push_within_short_gap_returns_neutral_one()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(30));
        var fp = new ClusteringForcePush("a", "b", t0.AddSeconds(15));
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp }), Defaults)
            .Should().BeApproximately(1.0, 0.001);
    }

    [Fact]
    public void Force_push_after_long_gap_returns_one_point_five()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(1200));   // > 600s default long-gap
        var fp = new ClusteringForcePush("a", "b", t0.AddSeconds(1000));
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp }), Defaults)
            .Should().BeApproximately(1.5, 0.001);
    }

    [Fact]
    public void Force_push_with_null_shas_positions_by_occurredAt_with_clamp()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(2000));
        // Force-push event clock-skewed earlier than prev — the clamp should treat it as co-located with prev.
        var fp = new ClusteringForcePush(null, null, t0.AddSeconds(-10));
        // Expected: clamped, so the "long gap" check still applies if next.committedDate is far ahead.
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp }), Defaults)
            .Should().BeApproximately(1.5, 0.001);
    }

    [Fact]
    public void Multiple_force_pushes_in_window_apply_at_most_once()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(1200));
        var fp1 = new ClusteringForcePush("a", "x", t0.AddSeconds(500));
        var fp2 = new ClusteringForcePush("x", "b", t0.AddSeconds(900));
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp1, fp2 }), Defaults)
            .Should().BeApproximately(1.5, 0.001);
    }
}
```

### Step 2.11: Implement `ForcePushMultiplier`

- [ ] Create `PRism.Core/Iterations/ForcePushMultiplier.cs`:

```csharp
namespace PRism.Core.Iterations;

public sealed class ForcePushMultiplier : IDistanceMultiplier
{
    public double For(
        ClusteringCommit prev,
        ClusteringCommit next,
        ClusteringInput input,
        IterationClusteringCoefficients coefficients)
    {
        var gapSeconds = (next.CommittedDate - prev.CommittedDate).TotalSeconds;
        if (gapSeconds <= coefficients.ForcePushLongGapSeconds) return 1.0;

        // Position force-pushes in the (prev.CommittedDate, next.CommittedDate] window.
        // For null-SHA events, use occurredAt with clamp against prev.CommittedDate
        // (defends against server-clock-vs-committer-clock skew).
        var hasForcePushInWindow = input.ForcePushes.Any(fp =>
        {
            var positionedAt = fp.BeforeSha is not null && fp.AfterSha is not null
                ? fp.OccurredAt
                : ClampToPrev(fp.OccurredAt, prev.CommittedDate);

            return positionedAt > prev.CommittedDate && positionedAt <= next.CommittedDate;
        });

        return hasForcePushInWindow ? coefficients.ForcePushAfterLongGap : 1.0;
    }

    private static DateTimeOffset ClampToPrev(DateTimeOffset eventAt, DateTimeOffset prevAt) =>
        eventAt < prevAt ? prevAt : eventAt;
}
```

### Step 2.12: Run ForcePush tests

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests --filter "FullyQualifiedName~ForcePushMultiplierTests"
```

Expected: **5 passing**.

### Step 2.13: Write `WeightedDistanceClusteringStrategyTests`

- [ ] Create `tests/PRism.Core.Tests/Iterations/WeightedDistanceClusteringStrategyTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Iterations;
using Xunit;

namespace PRism.Core.Tests.Iterations;

public class WeightedDistanceClusteringStrategyTests
{
    private static readonly IterationClusteringCoefficients Defaults = new();

    private static IIterationClusteringStrategy NewStrategy() =>
        new WeightedDistanceClusteringStrategy(new IDistanceMultiplier[]
        {
            new FileJaccardMultiplier(),
            new ForcePushMultiplier()
        });

    private static ClusteringCommit Commit(string sha, DateTimeOffset at, params string[] files) =>
        new(sha, at, "msg", 1, 0, files.Length == 0 ? Array.Empty<string>() : files);

    private static ClusteringInput Input(params ClusteringCommit[] commits) =>
        new(commits, Array.Empty<ClusteringForcePush>(), Array.Empty<ClusteringReviewEvent>(),
            Array.Empty<ClusteringAuthorComment>());

    [Fact]
    public void Empty_commits_returns_no_clusters()
    {
        NewStrategy().Cluster(Input(), Defaults).Should().BeEmpty();
    }

    [Fact]
    public void Single_commit_returns_one_cluster()
    {
        var c = Commit("a", DateTimeOffset.UtcNow);
        var clusters = NewStrategy().Cluster(Input(c), Defaults);
        clusters.Should().HaveCount(1);
        clusters[0].CommitShas.Should().ContainSingle().Which.Should().Be("a");
    }

    [Fact]
    public void Tight_amend_cluster_collapses_to_single_iteration()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = Enumerable.Range(0, 5)
            .Select(i => Commit($"c{i}", t0.AddSeconds(i * 30), "src/A.cs"))
            .ToArray();
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(1);
    }

    [Fact]
    public void Two_distinct_groups_with_long_gap_split_into_two_iterations()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = new[]
        {
            Commit("c0", t0,                        "src/A.cs"),
            Commit("c1", t0.AddSeconds(60),         "src/A.cs"),
            Commit("c2", t0.AddHours(4),            "src/B.cs"),    // 4h gap + disjoint files = boundary
            Commit("c3", t0.AddHours(4).AddSeconds(60), "src/B.cs"),
        };
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(2);
        clusters[0].CommitShas.Should().BeEquivalentTo(new[] { "c0", "c1" });
        clusters[1].CommitShas.Should().BeEquivalentTo(new[] { "c2", "c3" });
    }

    [Fact]
    public void Hard_floor_clamps_subsecond_gaps_to_floor()
    {
        var t0 = DateTimeOffset.UtcNow;
        var commits = new[]
        {
            Commit("c0", t0,                            "src/A.cs"),
            Commit("c1", t0.AddMilliseconds(50),        "src/A.cs"),
            Commit("c2", t0.AddMilliseconds(100),       "src/A.cs"),
        };
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        // All three should land in one iteration because the floor prevents micro-gaps from being boundaries.
        clusters.Should().HaveCount(1);
    }

    [Fact]
    public void Sort_uses_committed_date_not_authored_date()
    {
        var t0 = DateTimeOffset.UtcNow;
        // Out-of-order input; expect the strategy to sort by CommittedDate before processing.
        var commits = new[]
        {
            Commit("c1", t0.AddSeconds(60), "src/A.cs"),
            Commit("c0", t0,                "src/A.cs"),
        };
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(1);
        clusters[0].CommitShas.Should().BeEquivalentTo(new[] { "c0", "c1" }, opts => opts.WithStrictOrdering());
    }

    [Fact]
    public void Negative_delta_clamps_to_zero()
    {
        var t0 = DateTimeOffset.UtcNow;
        // c1 has an earlier CommittedDate than c0 (clock-skew); after sort they're in order.
        var commits = new[]
        {
            Commit("c0", t0,                        "src/A.cs"),
            Commit("c1", t0.AddSeconds(-1),         "src/A.cs"),    // skewed
            Commit("c2", t0.AddSeconds(60),         "src/A.cs"),
        };
        var act = () => NewStrategy().Cluster(Input(commits), Defaults);
        act.Should().NotThrow();
    }

    [Fact]
    public void Degenerate_floor_clamped_majority_falls_back_to_one_per_commit()
    {
        var t0 = DateTimeOffset.UtcNow;
        // Eight commits with > 50% sub-floor gaps — fallback fires.
        var commits = Enumerable.Range(0, 8)
            .Select(i => Commit($"c{i}", t0.AddSeconds(i * 10), "src/A.cs"))
            .ToArray();
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(8);
    }

    [Fact]
    public void Degenerate_fallback_above_max_tabs_returns_single_inconclusive_cluster()
    {
        var t0 = DateTimeOffset.UtcNow;
        // 25 commits with > 50% sub-floor gaps; default MaxFallbackTabs = 20 → single cluster.
        var commits = Enumerable.Range(0, 25)
            .Select(i => Commit($"c{i}", t0.AddSeconds(i * 10), "src/A.cs"))
            .ToArray();
        var clusters = NewStrategy().Cluster(Input(commits), Defaults);
        clusters.Should().HaveCount(1);
        clusters[0].CommitShas.Should().HaveCount(25);
    }
}
```

### Step 2.14: Implement `WeightedDistanceClusteringStrategy`

- [ ] Create `PRism.Core/Iterations/WeightedDistanceClusteringStrategy.cs`:

```csharp
namespace PRism.Core.Iterations;

public sealed class WeightedDistanceClusteringStrategy : IIterationClusteringStrategy
{
    private readonly IReadOnlyList<IDistanceMultiplier> _multipliers;

    public WeightedDistanceClusteringStrategy(IEnumerable<IDistanceMultiplier> multipliers)
    {
        _multipliers = multipliers.ToList();
    }

    public IReadOnlyList<IterationCluster> Cluster(
        ClusteringInput input,
        IterationClusteringCoefficients coefficients)
    {
        if (input.Commits.Count == 0) return Array.Empty<IterationCluster>();

        var sorted = input.Commits.OrderBy(c => c.CommittedDate).ToArray();
        if (sorted.Length == 1)
            return new[] { new IterationCluster(1, sorted[0].Sha, sorted[0].Sha, new[] { sorted[0].Sha }) };

        var weighted = new double[sorted.Length - 1];
        var floor = coefficients.HardFloorSeconds;
        var ceiling = coefficients.HardCeilingSeconds;

        for (var i = 0; i < sorted.Length - 1; i++)
        {
            var dt = Math.Max(0, (sorted[i + 1].CommittedDate - sorted[i].CommittedDate).TotalSeconds);
            var multiplier = _multipliers
                .Select(m => m.For(sorted[i], sorted[i + 1], input, coefficients))
                .Aggregate(1.0, (acc, m) => acc * m);
            weighted[i] = Math.Clamp(dt * multiplier, floor, ceiling);
        }

        // Degenerate-case: > DegenerateFloorFraction at hard floor → fallback.
        var floorClampedFraction = (double)weighted.Count(w => Math.Abs(w - floor) < 1.0) / weighted.Length;
        if (floorClampedFraction > coefficients.DegenerateFloorFraction)
        {
            if (sorted.Length <= coefficients.MaxFallbackTabs)
                return sorted.Select((c, i) => new IterationCluster(i + 1, c.Sha, c.Sha, new[] { c.Sha })).ToArray();
            return new[] { new IterationCluster(1, sorted[0].Sha, sorted[^1].Sha, sorted.Select(c => c.Sha).ToArray()) };
        }

        var threshold = MadThresholdComputer.Compute(weighted, coefficients.MadK);
        var boundaries = new List<int>();
        for (var i = 0; i < weighted.Length; i++)
            if (weighted[i] > threshold) boundaries.Add(i);

        var clusters = new List<IterationCluster>();
        var startIdx = 0;
        var iterationNumber = 1;
        foreach (var b in boundaries)
        {
            var endIdx = b;
            clusters.Add(new IterationCluster(
                iterationNumber++,
                sorted[startIdx].Sha,
                sorted[endIdx].Sha,
                sorted[startIdx..(endIdx + 1)].Select(c => c.Sha).ToArray()));
            startIdx = endIdx + 1;
        }
        clusters.Add(new IterationCluster(
            iterationNumber,
            sorted[startIdx].Sha,
            sorted[^1].Sha,
            sorted[startIdx..].Select(c => c.Sha).ToArray()));

        return clusters;
    }
}
```

### Step 2.15: Run clustering tests

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests --filter "FullyQualifiedName~WeightedDistanceClusteringStrategyTests"
```

Expected: **9 passing**.

### Step 2.16: Add the discipline-check skipped fact

- [ ] Create `tests/PRism.Core.Tests/Iterations/ClusteringDisciplineCheck.cs`:

```csharp
using PRism.Core.Iterations;
using Xunit;
using Xunit.Sdk;

namespace PRism.Core.Tests.Iterations;

public class ClusteringDisciplineCheck
{
    [SkippableFact]
    public void Manual_discipline_check_against_real_pr_set()
    {
        var prRefs = Environment.GetEnvironmentVariable("PRISM_DISCIPLINE_PR_REFS");
        Skip.If(prRefs is null, "Set PRISM_DISCIPLINE_PR_REFS to a comma-separated list of org/repo/number to run.");

        // Implementation: for each PR ref, fetch the timeline via IReviewService.GetTimelineAsync,
        // run WeightedDistanceClusteringStrategy.Cluster, print boundaries to stdout for hand-comparison.
        // Test author records results in the spec's § 12 "Discipline-check observations" section.
        // The skipped test is the harness; the recording is manual.

        throw new NotImplementedException(
            "Wire this to IReviewService.GetTimelineAsync once Task 3 lands; until then, the skipped " +
            "fact pins the env-var-gated dispatch shape.");
    }
}
```

### Step 2.17: Run clustering test suite + skip-fact verification

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests --filter "FullyQualifiedName~Iterations"
```

Expected: clustering tests pass; `ClusteringDisciplineCheck` reports as **skipped**.

### Step 2.18: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr2-iteration-clustering
git -C C:\src\PRism-s3-spec add PRism.Core/Iterations tests/PRism.Core.Tests/Iterations tests/PRism.Core.Tests/PRism.Core.Tests.csproj
git -C C:\src\PRism-s3-spec commit -m "feat(iterations): weighted-distance clustering with 2 multipliers + MAD threshold + degenerate fallback (S3 PR2)"
```

---

## Task 3: `IReviewService` Extensions — PR detail fetch + dual-endpoint diff + file content + timeline

**Files:**
- Modify: `PRism.Core/IReviewService.cs`
- Create: `PRism.Core.Contracts/PrDetailDto.cs`
- Create: `PRism.Core.Contracts/DiffDto.cs`
- Create: `PRism.Core.Contracts/DiffRangeRequest.cs`
- Create: `PRism.Core.Contracts/IssueCommentDto.cs`
- Create: `PRism.Core.Contracts/ReviewThreadDto.cs`
- Create: `PRism.Core.Contracts/IterationDto.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServiceTests.cs`

### Step 3.1: Define the new DTOs

- [ ] Create `PRism.Core.Contracts/PrDetailDto.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record PrDetailDto(
    Pr Pr,
    IReadOnlyList<IterationDto> Iterations,
    IReadOnlyList<IssueCommentDto> RootComments,
    IReadOnlyList<ReviewThreadDto> ReviewComments);
```

(Reuses the existing `Pr` record from `PRism.Core.Contracts/Pr.cs`; if it doesn't have `HeadSha`/`BaseSha`/`Mergeability`/`State` fields yet, extend that record before continuing — those are needed by S3.)

- [ ] Create `PRism.Core.Contracts/IterationDto.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record IterationDto(
    int Number,
    string BeforeSha,
    string AfterSha,
    IReadOnlyList<CommitDto> Commits);

public sealed record CommitDto(string Sha, string Message, DateTimeOffset CommittedDate, int Additions, int Deletions);
```

- [ ] Create `PRism.Core.Contracts/IssueCommentDto.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record IssueCommentDto(
    long Id,
    string Author,
    DateTimeOffset CreatedAt,
    string Body);
```

- [ ] Create `PRism.Core.Contracts/ReviewThreadDto.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record ReviewThreadDto(
    string ThreadId,           // GraphQL Node ID, opaque
    string FilePath,
    int LineNumber,
    string AnchorSha,
    bool IsResolved,
    IReadOnlyList<ReviewCommentDto> Comments);

public sealed record ReviewCommentDto(
    string CommentId,          // GraphQL Node ID, opaque
    string Author,
    DateTimeOffset CreatedAt,
    string Body,
    DateTimeOffset? EditedAt);
```

- [ ] Create `PRism.Core.Contracts/DiffDto.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record DiffDto(
    string Range,
    IReadOnlyList<FileChange> Files,    // reuses existing FileChange record
    bool Truncated);
```

- [ ] Create `PRism.Core.Contracts/DiffRangeRequest.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record DiffRangeRequest(string BaseSha, string HeadSha);
```

### Step 3.2: Extend `IReviewService`

- [ ] Modify `PRism.Core/IReviewService.cs`. Add these methods to the existing interface:

```csharp
Task<PrDetailDto?> GetPrDetailAsync(PrReference prRef, CancellationToken ct);

Task<DiffDto> GetDiffAsync(PrReference prRef, DiffRangeRequest range, CancellationToken ct);

Task<FileContentResult> GetFileContentAsync(PrReference prRef, string path, string sha, CancellationToken ct);

Task<ClusteringInput> GetTimelineAsync(PrReference prRef, CancellationToken ct);
```

Add the result type for file content (in `PRism.Core.Contracts/`):

```csharp
namespace PRism.Core.Contracts;

public enum FileContentStatus { Ok, NotFound, TooLarge, Binary, NotInDiff }

public sealed record FileContentResult(
    FileContentStatus Status,
    string? Content,
    long ByteSize);
```

Add the using statement at the top of `IReviewService.cs` for `PRism.Core.Iterations` (the timeline returns a `ClusteringInput`).

### Step 3.3: Write `GitHubReviewServiceTests` for the diff-fetcher

- [ ] In `tests/PRism.GitHub.Tests/GitHubReviewServiceTests.cs`, add (or create the file):

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceDiffTests
{
    [Fact]
    public async Task GetDiffAsync_paginates_pulls_files_until_link_next_exhausts()
    {
        var fake = new FakeGitHubServer()
            .ReturningPullsFilesPages(new[]
            {
                FakeGitHubServer.PageOf(100, hasNext: true),
                FakeGitHubServer.PageOf(100, hasNext: true),
                FakeGitHubServer.PageOf(50,  hasNext: false),
            })
            .WithPullChangedFilesCount(250);

        var sut = NewService(fake);
        var diff = await sut.GetDiffAsync(
            new PrReference("o", "r", 1),
            new DiffRangeRequest("base", "head"),
            CancellationToken.None);

        diff.Files.Should().HaveCount(250);
        diff.Truncated.Should().BeFalse();
    }

    [Fact]
    public async Task GetDiffAsync_marks_truncated_when_pull_changed_files_exceeds_assembled_count()
    {
        var fake = new FakeGitHubServer()
            .ReturningPullsFilesPages(new[]
            {
                FakeGitHubServer.PageOf(100, hasNext: true),
                FakeGitHubServer.PageOf(100, hasNext: true),
                FakeGitHubServer.PageOf(100, hasNext: true),
                // ... up to 30 pages of 100 = 3000 (the GitHub hard cap)
            })
            .WithPullChangedFilesCount(3500);   // GitHub knows there are more

        var sut = NewService(fake);
        var diff = await sut.GetDiffAsync(
            new PrReference("o", "r", 1),
            new DiffRangeRequest("base", "head"),
            CancellationToken.None);

        diff.Files.Should().HaveCountLessThanOrEqualTo(3000);
        diff.Truncated.Should().BeTrue();
    }

    private static IReviewService NewService(FakeGitHubServer fake) =>
        new GitHubReviewService(fake.HttpClient, fake.GitHubHost);
}
```

(The `FakeGitHubServer` builder is part of S2's test infrastructure — extend it as needed. If method shapes don't match, follow the existing patterns in `tests/PRism.GitHub.Tests/Inbox/` for examples.)

### Step 3.4: Implement the new `IReviewService` methods on `GitHubReviewService`

- [ ] In `PRism.GitHub/GitHubReviewService.cs`, add:

```csharp
public async Task<PrDetailDto?> GetPrDetailAsync(PrReference prRef, CancellationToken ct)
{
    // Single GraphQL round-trip for PR meta + timeline + comments + review threads.
    // Use the existing _httpClient + GraphQL POST pattern from S2's GitHubSectionQueryRunner.
    var query = """
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          title body url state isDraft mergeable mergeStateStatus
          headRefName baseRefName
          headRefOid baseRefOid
          author { login }
          createdAt closedAt mergedAt
          changedFiles
          comments(first: 100) {
            nodes { databaseId author { login } createdAt body }
          }
          reviewThreads(first: 100) {
            nodes {
              id path line isResolved
              comments(first: 100) {
                nodes { id author { login } createdAt body lastEditedAt }
              }
            }
          }
          timelineItems(first: 100, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_REVIEW]) {
            nodes {
              __typename
              ... on PullRequestCommit { commit { oid committedDate message additions deletions } }
              ... on HeadRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } createdAt }
              ... on PullRequestReview { submittedAt }
            }
          }
        }
      }
    }
    """;
    var raw = await PostGraphQL(query, new { owner = prRef.Owner, repo = prRef.Repo, number = prRef.Number }, ct);
    if (raw is null) return null;

    var pull = raw.GetProperty("data").GetProperty("repository").GetProperty("pullRequest");
    var iterations = ComputeIterations(pull, prRef);
    var rootComments = ParseRootComments(pull);
    var reviewComments = ParseReviewThreads(pull);
    var pr = ParsePr(pull, prRef);

    return new PrDetailDto(pr, iterations, rootComments, reviewComments);
}

public async Task<DiffDto> GetDiffAsync(PrReference prRef, DiffRangeRequest range, CancellationToken ct)
{
    // Step 1: paginate /pulls/{n}/files
    var allFiles = new List<FileChange>();
    var url = $"/repos/{prRef.Owner}/{prRef.Repo}/pulls/{prRef.Number}/files?per_page=100";
    var pageCount = 0;
    while (url is not null && pageCount < 30)
    {
        var (files, nextUrl) = await FetchFilesPage(url, ct);
        allFiles.AddRange(files);
        url = nextUrl;
        pageCount++;
    }

    // Step 2: get changed_files count from cached /pulls/{n}
    var pullMeta = await FetchPullMeta(prRef, ct);
    var changedFiles = pullMeta.ChangedFiles;

    var truncated = changedFiles > allFiles.Count;
    return new DiffDto($"{range.BaseSha}..{range.HeadSha}", allFiles, truncated);
}

public async Task<FileContentResult> GetFileContentAsync(PrReference prRef, string path, string sha, CancellationToken ct)
{
    // GET /repos/{o}/{r}/contents/{path}?ref={sha} via raw media type.
    const long MaxBytes = 5L * 1024 * 1024;
    var url = $"/repos/{prRef.Owner}/{prRef.Repo}/contents/{Uri.EscapeDataString(path)}?ref={sha}";
    using var req = new HttpRequestMessage(HttpMethod.Get, url);
    req.Headers.Accept.Add(new("application/vnd.github.raw"));
    using var resp = await _httpClient.SendAsync(req, ct);

    if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
        return new FileContentResult(FileContentStatus.NotFound, null, 0);

    var bytes = await resp.Content.ReadAsByteArrayAsync(ct);
    if (bytes.Length > MaxBytes)
        return new FileContentResult(FileContentStatus.TooLarge, null, bytes.Length);

    if (LooksBinary(bytes))
        return new FileContentResult(FileContentStatus.Binary, null, bytes.Length);

    return new FileContentResult(FileContentStatus.Ok, System.Text.Encoding.UTF8.GetString(bytes), bytes.Length);
}

public async Task<ClusteringInput> GetTimelineAsync(PrReference prRef, CancellationToken ct)
{
    var detail = await GetPrDetailAsync(prRef, ct);
    if (detail is null)
        return new ClusteringInput(Array.Empty<ClusteringCommit>(), Array.Empty<ClusteringForcePush>(),
            Array.Empty<ClusteringReviewEvent>(), Array.Empty<ClusteringAuthorComment>());

    // Per-commit changedFiles fan-out (concurrency cap 8).
    // If commits.Length > coefficients.SkipJaccardAboveCommitCount, return without changedFiles.
    // The clustering strategy treats null as unknown.
    var commits = await FetchPerCommitChangedFiles(prRef, /* commits from detail */ ct, concurrencyCap: 8, skipAbove: 100);

    return new ClusteringInput(
        commits,
        ParseForcePushes(detail),
        ParseReviewEvents(detail),
        ParseAuthorComments(detail));
}

private static bool LooksBinary(byte[] bytes)
{
    // Heuristic: any null byte in the first 8KB.
    var n = Math.Min(bytes.Length, 8192);
    for (var i = 0; i < n; i++)
        if (bytes[i] == 0) return true;
    return false;
}
```

(The helper methods `PostGraphQL`, `FetchFilesPage`, `FetchPullMeta`, `FetchPerCommitChangedFiles`, `ComputeIterations`, `ParseRootComments`, `ParseReviewThreads`, `ParsePr`, `ParseForcePushes`, `ParseReviewEvents`, `ParseAuthorComments` are private to `GitHubReviewService` and follow the patterns from S2's existing fetchers. Implement each with concrete code; do not leave placeholders.)

### Step 3.5: Run the diff tests

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubReviewServiceDiffTests"
```

Expected: **2 passing**.

### Step 3.6: Add tests for the per-commit Jaccard fan-out cap

- [ ] In the same test file:

```csharp
[Fact]
public async Task GetTimelineAsync_skips_per_commit_fanout_above_cap()
{
    var commits = Enumerable.Range(0, 150)
        .Select(i => new { Sha = $"c{i:D3}", Date = DateTimeOffset.UtcNow.AddSeconds(i * 60) })
        .ToArray();
    var fake = new FakeGitHubServer()
        .WithPullRequestTimeline(commits);

    var sut = NewService(fake);
    var input = await sut.GetTimelineAsync(new PrReference("o","r",1), CancellationToken.None);

    input.Commits.Should().HaveCount(150);
    input.Commits.Should().AllSatisfy(c => c.ChangedFiles.Should().BeNull(),
        because: "above 100 commits, the per-commit REST fan-out is skipped");
    fake.PerCommitFetchCount.Should().Be(0);
}
```

(Add the corresponding `WithPullRequestTimeline` builder method to `FakeGitHubServer` if not present. The fake is in `tests/PRism.GitHub.Tests/FakeGitHubServer.cs` — extend the existing class.)

### Step 3.7: Run the full GitHub-tests suite

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.GitHub.Tests
```

Expected: **all passing**.

### Step 3.8: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr3-ireviewservice-extensions
git -C C:\src\PRism-s3-spec add PRism.Core/IReviewService.cs PRism.Core.Contracts/ PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/
git -C C:\src\PRism-s3-spec commit -m "feat(github): IReviewService grows new methods (GetPrDetail/GetDiff/GetFileContent/GetTimeline) (S3 PR3)"
```

---

## Task 4: PR Detail Backend Assembly — Loader, Endpoints, Wire-Format Translation

**Files:**
- Create: `PRism.Core/PrDetail/IPrDetailLoader.cs`
- Create: `PRism.Core/PrDetail/PrDetailLoader.cs`
- Create: `PRism.Core/PrDetail/PrDetailSnapshot.cs`
- Create: `PRism.Web/Endpoints/PrDetailEndpoints.cs`
- Create: `PRism.Web/Endpoints/PrDetailDtos.cs`
- Modify: `PRism.Web/Program.cs` — register `PrDetailLoader`, map endpoints
- Test: `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs`
- Test: `tests/PRism.Web.Tests/PrDetailEndpointsTests.cs`

### Step 4.1: Define the loader interface + snapshot record

- [ ] Create `PRism.Core/PrDetail/PrDetailSnapshot.cs`:

```csharp
namespace PRism.Core.PrDetail;

public sealed record PrDetailSnapshot(
    PrDetailDto Detail,
    int CoefficientsGeneration);   // bumped on coefficient hot-reload
```

(Use the existing `PrDetailDto` from `PRism.Core.Contracts`.)

- [ ] Create `PRism.Core/PrDetail/IPrDetailLoader.cs`:

```csharp
namespace PRism.Core.PrDetail;

public interface IPrDetailLoader
{
    Task<PrDetailSnapshot?> LoadAsync(PrReference prRef, CancellationToken ct);
    Task<PrDetailSnapshot?> TryGetCachedAsync(PrReference prRef);
    void InvalidateAll();   // called on coefficient hot-reload
}
```

### Step 4.2: Write the loader test

- [ ] Create `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.Core.Tests.PrDetail;

public class PrDetailLoaderTests
{
    [Fact]
    public async Task LoadAsync_calls_GetPrDetail_then_GetTimeline_then_clusters_in_order()
    {
        var calls = new List<string>();
        var fake = new FakeReviewService(calls);
        var clusterer = new RecordingClusterer(calls);
        var loader = new PrDetailLoader(fake, clusterer, new IterationClusteringCoefficients());

        await loader.LoadAsync(new PrReference("o","r",1), CancellationToken.None);

        calls.Should().Equal("GetPrDetail", "GetTimeline", "Cluster");
    }

    [Fact]
    public async Task LoadAsync_caches_by_prRef_and_headSha()
    {
        var fake = new FakeReviewService();
        var loader = new PrDetailLoader(fake, new WeightedDistanceClusteringStrategy(Array.Empty<IDistanceMultiplier>()),
                                        new IterationClusteringCoefficients());

        var s1 = await loader.LoadAsync(new PrReference("o","r",1), CancellationToken.None);
        var s2 = await loader.LoadAsync(new PrReference("o","r",1), CancellationToken.None);

        s1.Should().BeSameAs(s2);
        fake.GetPrDetailCallCount.Should().Be(1);
    }

    [Fact]
    public async Task InvalidateAll_forces_reload()
    {
        var fake = new FakeReviewService();
        var loader = new PrDetailLoader(fake, new WeightedDistanceClusteringStrategy(Array.Empty<IDistanceMultiplier>()),
                                        new IterationClusteringCoefficients());

        await loader.LoadAsync(new PrReference("o","r",1), CancellationToken.None);
        loader.InvalidateAll();
        await loader.LoadAsync(new PrReference("o","r",1), CancellationToken.None);

        fake.GetPrDetailCallCount.Should().Be(2);
    }
}

// Stub fake; expand fields as the loader's needs grow.
internal class FakeReviewService : IReviewService { /* implement minimally — track call counts */ }
internal class RecordingClusterer : IIterationClusteringStrategy
{
    private readonly List<string> _calls;
    public RecordingClusterer(List<string> calls) => _calls = calls;
    public IReadOnlyList<IterationCluster> Cluster(ClusteringInput _, IterationClusteringCoefficients __)
    { _calls.Add("Cluster"); return Array.Empty<IterationCluster>(); }
}
```

Implement `FakeReviewService` minimally — for each `IReviewService` method, return a sentinel value and increment a counter; track the order in `calls`.

### Step 4.3: Implement `PrDetailLoader`

- [ ] Create `PRism.Core/PrDetail/PrDetailLoader.cs`:

```csharp
using System.Collections.Concurrent;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Core.PrDetail;

public sealed class PrDetailLoader : IPrDetailLoader
{
    private readonly IReviewService _review;
    private readonly IIterationClusteringStrategy _clusterer;
    private readonly IterationClusteringCoefficients _coefficients;
    private readonly ConcurrentDictionary<string, PrDetailSnapshot> _cache = new();
    private int _generation;

    public PrDetailLoader(
        IReviewService review,
        IIterationClusteringStrategy clusterer,
        IterationClusteringCoefficients coefficients)
    {
        _review = review;
        _clusterer = clusterer;
        _coefficients = coefficients;
    }

    public async Task<PrDetailSnapshot?> LoadAsync(PrReference prRef, CancellationToken ct)
    {
        var key = CacheKey(prRef, _generation);
        if (_cache.TryGetValue(key, out var cached)) return cached;

        var detail = await _review.GetPrDetailAsync(prRef, ct);
        if (detail is null) return null;

        var timeline = await _review.GetTimelineAsync(prRef, ct);
        var clusters = _clusterer.Cluster(timeline, _coefficients);
        var iterations = clusters.Select(c => new IterationDto(
            c.IterationNumber, c.BeforeSha, c.AfterSha,
            // Map cluster.CommitShas → CommitDto by joining against detail.Iterations or timeline data.
            c.CommitShas.Select(sha => /* lookup */).ToArray())).ToArray();

        var snapshot = new PrDetailSnapshot(detail with { Iterations = iterations }, _generation);
        _cache[key] = snapshot;
        return snapshot;
    }

    public Task<PrDetailSnapshot?> TryGetCachedAsync(PrReference prRef)
    {
        var key = CacheKey(prRef, _generation);
        return Task.FromResult(_cache.TryGetValue(key, out var cached) ? cached : null);
    }

    public void InvalidateAll()
    {
        Interlocked.Increment(ref _generation);
        _cache.Clear();
    }

    private static string CacheKey(PrReference prRef, int generation) =>
        $"{prRef.Owner}/{prRef.Repo}/{prRef.Number}#{generation}";
}
```

(The `lookup` placeholder above must be filled in: build a `Dictionary<string, ClusteringCommit>` from the timeline once, then look up `sha` for each cluster member.)

### Step 4.4: Run loader tests

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests --filter "FullyQualifiedName~PrDetailLoaderTests"
```

Expected: **3 passing**.

### Step 4.5: Define the endpoint DTOs (wire shapes)

- [ ] Create `PRism.Web/Endpoints/PrDetailDtos.cs`:

```csharp
namespace PRism.Web.Endpoints;

public sealed record GetPrDetailResponse(PrDetailDto Detail);
public sealed record GetDiffQuery(string Range);
public sealed record GetDiffResponse(DiffDto Diff);

public sealed record MarkViewedRequest(string HeadSha, string? MaxCommentId);
public sealed record FileViewedRequest(string Path, string HeadSha, bool Viewed);
```

### Step 4.6: Write endpoint tests

- [ ] Create `tests/PRism.Web.Tests/PrDetailEndpointsTests.cs`. The test class uses S2's existing `WebApplicationFactory<Program>` pattern with `FakeGitHubServer`. Add 8 tests:

```csharp
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace PRism.Web.Tests;

public class PrDetailEndpointsTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public PrDetailEndpointsTests(WebApplicationFactory<Program> factory) => _factory = factory;

    [Fact]
    public async Task Get_pr_detail_returns_200_with_complete_dto()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/pr/octo/repo/1");
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        // Assert content shape via JSON deserialization.
    }

    [Fact]
    public async Task Get_pr_detail_returns_404_problem_on_missing_pr() { /* … */ }

    [Fact]
    public async Task Get_diff_paginates_and_propagates_truncated_flag() { /* … */ }

    [Fact]
    public async Task Get_file_returns_422_when_path_not_in_diff()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/pr/octo/repo/1/file?path=../etc/passwd&sha=abc");
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.UnprocessableEntity);
        var problem = await resp.Content.ReadFromJsonAsync<ProblemDetails>();
        problem!.Type.Should().Be("/file/not-in-diff");
    }

    [Fact]
    public async Task Get_file_returns_413_for_files_over_5MB() { /* … */ }

    [Fact]
    public async Task Get_file_returns_415_for_binary_content() { /* … */ }

    [Fact]
    public async Task Mark_viewed_writes_session_state() { /* … */ }

    [Fact]
    public async Task Mark_viewed_returns_409_when_headSha_mismatches() { /* … */ }
}
```

(Fill in each test body with concrete arrange / act / assert. The FakeGitHubServer setup follows the S2 pattern in `tests/PRism.Web.Tests/InboxEndpointsTests.cs`.)

### Step 4.7: Implement the endpoints

- [ ] Create `PRism.Web/Endpoints/PrDetailEndpoints.cs`:

```csharp
using Microsoft.AspNetCore.Mvc;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

public static class PrDetailEndpoints
{
    public static IEndpointRouteBuilder MapPrDetailEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}",
            async (string owner, string repo, int number, IPrDetailLoader loader, CancellationToken ct) =>
            {
                var snapshot = await loader.LoadAsync(new PrReference(owner, repo, number), ct);
                if (snapshot is null)
                    return Results.Problem(type: "/pr/not-found", statusCode: 404);
                return Results.Ok(snapshot.Detail);
            });

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/diff",
            async (string owner, string repo, int number, [FromQuery] string range,
                   IReviewService review, CancellationToken ct) =>
            {
                var (baseSha, headSha) = ParseRange(range);
                var diff = await review.GetDiffAsync(new PrReference(owner, repo, number),
                    new DiffRangeRequest(baseSha, headSha), ct);
                return Results.Ok(diff);
            });

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/file",
            async (string owner, string repo, int number, [FromQuery] string path, [FromQuery] string sha,
                   IPrDetailLoader loader, IReviewService review, CancellationToken ct) =>
            {
                var snapshot = await loader.TryGetCachedAsync(new PrReference(owner, repo, number));
                if (snapshot is null)
                    return Results.Problem(type: "/file/snapshot-evicted", statusCode: 422);
                if (!snapshot.Detail.HasFileInDiff(path))
                    return Results.Problem(type: "/file/not-in-diff", statusCode: 422);

                var result = await review.GetFileContentAsync(new PrReference(owner, repo, number), path, sha, ct);
                return result.Status switch
                {
                    FileContentStatus.Ok        => Results.Text(result.Content!, "text/plain"),
                    FileContentStatus.NotFound  => Results.Problem(type: "/file/missing", statusCode: 404),
                    FileContentStatus.TooLarge  => Results.Problem(type: "/file/too-large", statusCode: 413),
                    FileContentStatus.Binary    => Results.Problem(type: "/file/binary", statusCode: 415),
                    _                           => Results.Problem(statusCode: 500),
                };
            });

        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/mark-viewed",
            async (string owner, string repo, int number, MarkViewedRequest body,
                   IPrDetailLoader loader, IAppStateStore stateStore, AppStateStore concreteStore, CancellationToken ct) =>
            {
                if (concreteStore.IsReadOnlyMode)
                    return Results.Problem(type: "/state/read-only", statusCode: 423);

                var snapshot = await loader.TryGetCachedAsync(new PrReference(owner, repo, number));
                if (snapshot is null || snapshot.Detail.Pr.HeadSha != body.HeadSha)
                    return Results.Problem(type: "/viewed/stale-head-sha", statusCode: 409);

                var key = $"{owner}/{repo}/{number}";
                var state = await stateStore.LoadAsync(ct);
                var session = state.ReviewSessions.GetValueOrDefault(key) ??
                              new ReviewSessionState(null, null, null, null, new Dictionary<string, string>());
                var updated = session with { LastViewedHeadSha = body.HeadSha, LastSeenCommentId = body.MaxCommentId };

                var sessions = state.ReviewSessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                sessions[key] = updated;
                await stateStore.SaveAsync(state with { ReviewSessions = sessions }, ct);

                return Results.NoContent();
            });

        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/files/viewed",
            async (string owner, string repo, int number, FileViewedRequest body,
                   IPrDetailLoader loader, AppStateStore concreteStore, CancellationToken ct) =>
            {
                if (concreteStore.IsReadOnlyMode)
                    return Results.Problem(type: "/state/read-only", statusCode: 423);

                if (string.IsNullOrEmpty(body.Path) || body.Path.Length > 4096)
                    return Results.Problem(type: "/viewed/path-too-long", statusCode: 422);

                var canonical = CanonicalizePath(body.Path);
                if (canonical is null)
                    return Results.Problem(type: "/viewed/path-invalid", statusCode: 422);

                var snapshot = await loader.TryGetCachedAsync(new PrReference(owner, repo, number));
                if (snapshot is null || snapshot.Detail.Pr.HeadSha != body.HeadSha)
                    return Results.Problem(type: "/viewed/stale-head-sha", statusCode: 409);

                if (!snapshot.Detail.HasFileInDiff(canonical))
                    return Results.Problem(type: "/viewed/path-not-in-diff", statusCode: 422);

                var key = $"{owner}/{repo}/{number}";
                var state = await concreteStore.LoadAsync(ct);
                var session = state.ReviewSessions.GetValueOrDefault(key) ??
                              new ReviewSessionState(null, null, null, null, new Dictionary<string, string>());
                var viewedFiles = session.ViewedFiles.ToDictionary(kv => kv.Key, kv => kv.Value);

                if (body.Viewed)
                {
                    if (viewedFiles.Count >= 10000 && !viewedFiles.ContainsKey(canonical))
                        return Results.Problem(type: "/viewed/cap-exceeded", statusCode: 422);
                    viewedFiles[canonical] = body.HeadSha;
                }
                else
                {
                    viewedFiles.Remove(canonical);
                }

                var sessions = state.ReviewSessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                sessions[key] = session with { ViewedFiles = viewedFiles };
                await concreteStore.SaveAsync(state with { ReviewSessions = sessions }, ct);

                return Results.NoContent();
            });

        return app;
    }

    private static (string Base, string Head) ParseRange(string range)
    {
        var parts = range.Split("..");
        if (parts.Length != 2) throw new ArgumentException($"Invalid range: {range}");
        return (parts[0], parts[1]);
    }

    private static string? CanonicalizePath(string path)
    {
        if (path.Contains("..") || path.StartsWith('/') || path.EndsWith('/')) return null;
        // NFC normalize so encoding-equivalent paths collapse.
        return path.Normalize(System.Text.NormalizationForm.FormC);
    }
}
```

(Add `HasFileInDiff(path)` as an extension method on `PrDetailDto` that checks `dto.Files.Any(f => f.Path == path)`.)

### Step 4.8: Wire endpoints + DI in `Program.cs`

- [ ] In `PRism.Web/Program.cs`, register the loader:

```csharp
builder.Services.AddSingleton<IPrDetailLoader, PrDetailLoader>();
builder.Services.AddSingleton<IIterationClusteringStrategy>(sp =>
    new WeightedDistanceClusteringStrategy(sp.GetServices<IDistanceMultiplier>()));
builder.Services.AddSingleton<IDistanceMultiplier, FileJaccardMultiplier>();
builder.Services.AddSingleton<IDistanceMultiplier, ForcePushMultiplier>();
builder.Services.AddSingleton<IterationClusteringCoefficients>(sp =>
    sp.GetRequiredService<IConfiguration>().GetSection("iterations:clusteringCoefficients").Get<IterationClusteringCoefficients>()
    ?? new IterationClusteringCoefficients());
```

And map the endpoints alongside `MapInboxEndpoints` (existing S2 wiring):

```csharp
app.MapPrDetailEndpoints();
```

### Step 4.9: Run endpoint tests

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Web.Tests --filter "FullyQualifiedName~PrDetailEndpointsTests"
```

Expected: **8 passing**.

### Step 4.10: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr4-prdetail-backend
git -C C:\src\PRism-s3-spec add PRism.Core/PrDetail/ PRism.Web/Endpoints/PrDetailEndpoints.cs PRism.Web/Endpoints/PrDetailDtos.cs PRism.Web/Program.cs tests/PRism.Core.Tests/PrDetail/ tests/PRism.Web.Tests/PrDetailEndpointsTests.cs
git -C C:\src\PRism-s3-spec commit -m "feat(prdetail): backend loader + endpoints + cache (S3 PR4)"
```

---

## Task 5: SSE per-PR fanout + active-PR poller + middleware tightening

**Files:**
- Create: `PRism.Core/PrDetail/ActivePrSubscriberRegistry.cs`
- Create: `PRism.Core/PrDetail/ActivePrPoller.cs`
- Create: `PRism.Core/PrDetail/ActivePrPollerState.cs`
- Modify: `PRism.Web/Sse/SseChannel.cs` — per-PR fanout, named heartbeat, write-timeout, idle-eviction
- Modify: `PRism.Web/Endpoints/EventsEndpoints.cs` — subscriber-assigned event, subscribe/unsubscribe REST
- Modify: `PRism.Web/Middleware/OriginCheckMiddleware.cs` — reject empty Origin on POST/PUT/PATCH/DELETE
- Create: `PRism.Web/Middleware/SessionTokenMiddleware.cs`
- Test: `tests/PRism.Core.Tests/PrDetail/ActivePrSubscriberRegistryTests.cs`
- Test: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerBackoffTests.cs`
- Test: `tests/PRism.Web.Tests/EventsSubscriptionsEndpointTests.cs`
- Test: `tests/PRism.Web.Tests/OriginCheckMiddlewareTests.cs`
- Test: `tests/PRism.Web.Tests/SessionTokenMiddlewareTests.cs`

### Step 5.1: Subscriber registry tests

- [ ] Create `tests/PRism.Core.Tests/PrDetail/ActivePrSubscriberRegistryTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrSubscriberRegistryTests
{
    [Fact]
    public void Add_registers_pr_for_subscriber()
    {
        var r = new ActivePrSubscriberRegistry();
        r.Add("sub1", new PrReference("o","r",1));
        r.UniquePrRefs().Should().ContainSingle();
    }

    [Fact]
    public void Add_is_idempotent_for_same_subscriber_pr_pair()
    {
        var r = new ActivePrSubscriberRegistry();
        r.Add("sub1", new PrReference("o","r",1));
        r.Add("sub1", new PrReference("o","r",1));
        r.SubscribersFor(new PrReference("o","r",1)).Should().ContainSingle();
    }

    [Fact]
    public void Multiple_subscribers_to_same_pr_dedup_at_pr_level()
    {
        var r = new ActivePrSubscriberRegistry();
        r.Add("sub1", new PrReference("o","r",1));
        r.Add("sub2", new PrReference("o","r",1));
        r.UniquePrRefs().Should().ContainSingle();
        r.SubscribersFor(new PrReference("o","r",1)).Should().HaveCount(2);
    }

    [Fact]
    public void Remove_unsubscribes_pr_from_subscriber()
    {
        var r = new ActivePrSubscriberRegistry();
        r.Add("sub1", new PrReference("o","r",1));
        r.Remove("sub1", new PrReference("o","r",1));
        r.SubscribersFor(new PrReference("o","r",1)).Should().BeEmpty();
    }

    [Fact]
    public void RemoveSubscriber_clears_all_pr_subscriptions_for_that_subscriber()
    {
        var r = new ActivePrSubscriberRegistry();
        r.Add("sub1", new PrReference("o","r",1));
        r.Add("sub1", new PrReference("o","r",2));
        r.RemoveSubscriber("sub1");
        r.UniquePrRefs().Should().BeEmpty();
    }

    [Fact]
    public void Remove_unknown_pair_is_a_noop()
    {
        var r = new ActivePrSubscriberRegistry();
        var act = () => r.Remove("nosuch", new PrReference("o","r",1));
        act.Should().NotThrow();
    }
}
```

### Step 5.2: Implement `ActivePrSubscriberRegistry`

- [ ] Create `PRism.Core/PrDetail/ActivePrSubscriberRegistry.cs`:

```csharp
using System.Collections.Concurrent;
using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

public sealed class ActivePrSubscriberRegistry
{
    // subscriberId → set of PrReferences
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<PrReference, byte>> _bySubscriber = new();
    // PrReference → set of subscriberIds (inverted index)
    private readonly ConcurrentDictionary<PrReference, ConcurrentDictionary<string, byte>> _byPr = new();

    public void Add(string subscriberId, PrReference prRef)
    {
        _bySubscriber.GetOrAdd(subscriberId, _ => new())[prRef] = 0;
        _byPr.GetOrAdd(prRef, _ => new())[subscriberId] = 0;
    }

    public void Remove(string subscriberId, PrReference prRef)
    {
        if (_bySubscriber.TryGetValue(subscriberId, out var prs)) prs.TryRemove(prRef, out _);
        if (_byPr.TryGetValue(prRef, out var subs))
        {
            subs.TryRemove(subscriberId, out _);
            if (subs.IsEmpty) _byPr.TryRemove(prRef, out _);
        }
    }

    public void RemoveSubscriber(string subscriberId)
    {
        if (_bySubscriber.TryRemove(subscriberId, out var prs))
            foreach (var prRef in prs.Keys) Remove(subscriberId, prRef);
    }

    public IReadOnlyCollection<PrReference> UniquePrRefs() => _byPr.Keys.ToList();

    public IReadOnlyCollection<string> SubscribersFor(PrReference prRef) =>
        _byPr.TryGetValue(prRef, out var subs) ? subs.Keys.ToList() : Array.Empty<string>();
}
```

### Step 5.3: Run subscriber-registry tests

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests --filter "FullyQualifiedName~ActivePrSubscriberRegistryTests"
```

Expected: **6 passing**.

### Step 5.4: Active-PR poller backoff tests

- [ ] Create `tests/PRism.Core.Tests/PrDetail/ActivePrPollerBackoffTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrPollerBackoffTests
{
    [Fact]
    public async Task Healthy_pr_continues_to_poll_while_other_pr_is_in_backoff()
    {
        // Arrange a fake review service: PR A returns 500 always; PR B returns OK.
        // Run the poller for two ticks; assert PR B got polled both ticks while PR A was skipped on the second tick.
    }

    [Fact]
    public async Task Backoff_resets_after_successful_poll()
    {
        // Arrange: PR returns 500 for one tick, OK on the next tick. Backoff state clears.
    }

    [Fact]
    public async Task Single_pr_exception_does_not_block_other_prs()
    {
        // Arrange: PR A throws, PR B is healthy. Both run inside one tick.
    }
}
```

(Implement the test bodies; they require a `FakeReviewService` that lets you script per-PR responses. The poller's `Tick` method should be exposed `internal` for testability.)

### Step 5.5: Implement `ActivePrPollerState` and `ActivePrPoller`

- [ ] Create `PRism.Core/PrDetail/ActivePrPollerState.cs`:

```csharp
namespace PRism.Core.PrDetail;

public sealed class ActivePrPollerState
{
    public string? LastHeadSha { get; set; }
    public int? LastCommentCount { get; set; }
    public int ConsecutiveErrors { get; set; }
    public DateTimeOffset? NextRetryAt { get; set; }
}
```

- [ ] Create `PRism.Core/PrDetail/ActivePrPoller.cs`:

```csharp
using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;

namespace PRism.Core.PrDetail;

public sealed class ActivePrPoller : BackgroundService
{
    private readonly ActivePrSubscriberRegistry _registry;
    private readonly IReviewService _review;
    private readonly IReviewEventBus _bus;
    private readonly ILogger<ActivePrPoller> _logger;
    private readonly ConcurrentDictionary<PrReference, ActivePrPollerState> _state = new();
    private readonly TimeSpan _cadence = TimeSpan.FromSeconds(30);

    public ActivePrPoller(ActivePrSubscriberRegistry registry, IReviewService review, IReviewEventBus bus, ILogger<ActivePrPoller> logger)
    {
        _registry = registry; _review = review; _bus = bus; _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Tick(stoppingToken); }
            catch (Exception ex) { _logger.LogError(ex, "ActivePrPoller tick failed"); }
            await Task.Delay(_cadence, stoppingToken);
        }
    }

    internal async Task Tick(CancellationToken ct)
    {
        var prs = _registry.UniquePrRefs();
        var now = DateTimeOffset.UtcNow;
        foreach (var prRef in prs)
        {
            var state = _state.GetOrAdd(prRef, _ => new());
            if (state.NextRetryAt is { } retryAt && retryAt > now) continue;

            try
            {
                var detail = await _review.GetPrDetailAsync(prRef, ct);
                if (detail is null) { ApplyBackoff(state, now); continue; }

                var headChanged = state.LastHeadSha is { } prev && prev != detail.Pr.HeadSha;
                var commentChanged = state.LastCommentCount is { } prevCount && prevCount != detail.RootComments.Count;

                if (headChanged || commentChanged)
                {
                    _bus.Publish(new ActivePrUpdated(prRef, headChanged, commentChanged,
                        detail.Pr.HeadSha, detail.RootComments.Count));
                }

                state.LastHeadSha = detail.Pr.HeadSha;
                state.LastCommentCount = detail.RootComments.Count;
                state.ConsecutiveErrors = 0;
                state.NextRetryAt = null;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Active-PR poll failed for {PrRef}; applying backoff", prRef);
                ApplyBackoff(state, now);
            }
        }
    }

    private static void ApplyBackoff(ActivePrPollerState state, DateTimeOffset now)
    {
        state.ConsecutiveErrors++;
        var seconds = Math.Min(Math.Pow(2, state.ConsecutiveErrors) * 30, 300);
        state.NextRetryAt = now.AddSeconds(seconds);
    }
}
```

(The `IReviewEventBus` and `ActivePrUpdated` already exist or are added in `PRism.Core/Events/`. If `ActivePrUpdated` doesn't exist yet, create it as a record matching the spec § 6.2 shape.)

### Step 5.6: Update `SseChannel` for per-PR fanout + named heartbeat

- [ ] Modify `PRism.Web/Sse/SseChannel.cs`. Replace the broadcast-all approach with subscriber-id-keyed fanout. The heartbeat write becomes `event: heartbeat\ndata: {}\n\n` (named event), not `:heartbeat` (comment). Add subscriber-id assignment as the first event.

```csharp
// Pseudo-edit; integrate with the existing SseChannel structure.
public async Task AddSubscriber(HttpResponse response, CancellationToken ct)
{
    var subscriberId = Guid.NewGuid().ToString("N");
    response.Headers.ContentType = "text/event-stream";
    response.Headers.CacheControl = "no-store";
    await response.WriteAsync($"event: subscriber-assigned\ndata: {{\"subscriberId\":\"{subscriberId}\"}}\n\n", ct);
    await response.Body.FlushAsync(ct);
    // … existing connection-management; on heartbeat tick:
    //   await response.WriteAsync($"event: heartbeat\ndata: {{}}\n\n", ct);
    //   updateLastClientActivity();
    // On disconnect: registry.RemoveSubscriber(subscriberId).
}

public async Task PublishPrUpdated(ActivePrUpdated evt)
{
    var json = JsonSerializer.Serialize(evt);
    foreach (var subscriberId in _registry.SubscribersFor(evt.PrRef))
    {
        if (!_subscribers.TryGetValue(subscriberId, out var sub)) continue;
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(sub.AbortToken);
            cts.CancelAfter(TimeSpan.FromSeconds(5));
            await sub.Response.WriteAsync($"event: pr-updated\ndata: {json}\n\n", cts.Token);
            await sub.Response.Body.FlushAsync(cts.Token);
            sub.LastClientActivity = DateTimeOffset.UtcNow;
        }
        catch
        {
            DropSubscriber(subscriberId);
        }
    }
}
```

(Integrate with `SseChannel`'s existing scaffolding. Honor the existing disposal-in-finally invariant.)

### Step 5.7: Add subscribe/unsubscribe endpoints

- [ ] Modify `PRism.Web/Endpoints/EventsEndpoints.cs`:

```csharp
app.MapPost("/api/events/subscriptions",
    async (SubscriptionRequest body, ActivePrSubscriberRegistry registry) =>
    {
        if (string.IsNullOrEmpty(body.SubscriberId))
            return Results.Problem(type: "/events/subscriber-unknown", statusCode: 404);
        registry.Add(body.SubscriberId, body.PrRef);
        return Results.NoContent();
    });

app.MapDelete("/api/events/subscriptions",
    async (SubscriptionRequest body, ActivePrSubscriberRegistry registry) =>
    {
        registry.Remove(body.SubscriberId, body.PrRef);
        return Results.NoContent();
    });
```

(Body-binding for DELETE uses `[FromBody]`; verify in Program.cs that `KestrelServerOptions.AllowDeleteWithBody = true` if needed.)

### Step 5.8: Tighten `OriginCheckMiddleware`

- [ ] Modify `PRism.Web/Middleware/OriginCheckMiddleware.cs`. Replace the current empty-Origin short-circuit with explicit rejection on mutating methods:

```csharp
public async Task InvokeAsync(HttpContext ctx)
{
    var origin = ctx.Request.Headers.Origin.ToString();
    var method = ctx.Request.Method;
    var isMutating = method is "POST" or "PUT" or "PATCH" or "DELETE";

    if (string.IsNullOrEmpty(origin))
    {
        if (isMutating)
        {
            ctx.Response.StatusCode = 403;
            await ctx.Response.WriteAsJsonAsync(new ProblemDetails { Type = "/auth/bad-origin", Status = 403 });
            return;
        }
        // Non-mutating with no Origin: allow (curl / direct GET probes still useful for health checks)
        await _next(ctx);
        return;
    }

    if (!IsAllowedOrigin(origin))
    {
        ctx.Response.StatusCode = 403;
        await ctx.Response.WriteAsJsonAsync(new ProblemDetails { Type = "/auth/bad-origin", Status = 403 });
        return;
    }

    await _next(ctx);
}
```

### Step 5.9: Implement `SessionTokenMiddleware`

- [ ] Create `PRism.Web/Middleware/SessionTokenMiddleware.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;

namespace PRism.Web.Middleware;

public sealed class SessionTokenMiddleware
{
    private readonly RequestDelegate _next;
    private readonly byte[] _expectedToken;

    public SessionTokenMiddleware(RequestDelegate next, SessionTokenProvider provider)
    {
        _next = next;
        _expectedToken = Encoding.UTF8.GetBytes(provider.Current);
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        var method = ctx.Request.Method;
        if (method is not ("POST" or "PUT" or "PATCH" or "DELETE"))
        {
            await _next(ctx);
            return;
        }

        var headerValue = ctx.Request.Headers["X-PRism-Session"].ToString();
        var actual = Encoding.UTF8.GetBytes(headerValue);

        if (actual.Length != _expectedToken.Length || !CryptographicOperations.FixedTimeEquals(actual, _expectedToken))
        {
            ctx.Response.StatusCode = 401;
            await ctx.Response.WriteAsJsonAsync(new ProblemDetails { Type = "/auth/session-stale", Status = 401 });
            return;
        }

        await _next(ctx);
    }
}

public sealed class SessionTokenProvider
{
    public string Current { get; } = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
}
```

Register both in `Program.cs`:

```csharp
builder.Services.AddSingleton<SessionTokenProvider>();
// Order matters: Origin first, then Session.
app.UseMiddleware<OriginCheckMiddleware>();
app.UseMiddleware<SessionTokenMiddleware>();
```

### Step 5.10: Stamp the cookie on every HTML response

- [ ] In `Program.cs`, add a small middleware (or extend an existing one) that sets the `prism-session` cookie on any response with `text/html` content type, so the SPA always picks up the current token on every full-page reload:

```csharp
app.Use(async (ctx, next) =>
{
    await next();
    if (ctx.Response.ContentType?.StartsWith("text/html") == true)
    {
        var token = ctx.RequestServices.GetRequiredService<SessionTokenProvider>().Current;
        ctx.Response.Cookies.Append("prism-session", token, new CookieOptions
        {
            HttpOnly = false,    // SPA reads it
            SameSite = SameSiteMode.Strict,
            Secure = false       // localhost
        });
    }
});
```

### Step 5.11: Run the SSE / middleware tests

- [ ] Add concrete test bodies to:
  - `tests/PRism.Web.Tests/EventsSubscriptionsEndpointTests.cs` — subscribe happy path, 404 on unknown subscriber, 409 already-subscribed.
  - `tests/PRism.Web.Tests/OriginCheckMiddlewareTests.cs` — empty-Origin POST → 403; empty-Origin GET → 200.
  - `tests/PRism.Web.Tests/SessionTokenMiddlewareTests.cs` — happy path; 401 without header; 401 on tampered token; constant-time-comparison sanity (use a stopwatch to confirm timing variance is small).

(Implement each test body. Do not leave placeholders.)

- [ ] Run:

```powershell
dotnet test C:\src\PRism-s3-spec\tests\PRism.Web.Tests
```

Expected: all passing.

### Step 5.12: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr5-sse-poller-middleware
git -C C:\src\PRism-s3-spec add PRism.Core/PrDetail/ PRism.Web/Sse/ PRism.Web/Endpoints/EventsEndpoints.cs PRism.Web/Middleware/ PRism.Web/Program.cs tests/
git -C C:\src\PRism-s3-spec commit -m "feat(sse): per-PR fanout + active-PR poller + tightened OriginCheck + SessionTokenMiddleware (S3 PR5)"
```

---

## Task 6: Frontend PR Detail Shell — Page, Routing, Sub-tabs, Banner

**Files:**
- Create: `frontend/src/pages/PrDetailPage.tsx` (replaces S2's `S3StubPrPage.tsx`)
- Create: `frontend/src/components/PrDetail/PrHeader.tsx`
- Create: `frontend/src/components/PrDetail/PrSubTabStrip.tsx`
- Create: `frontend/src/components/PrDetail/BannerRefresh.tsx`
- Create: `frontend/src/components/PrDetail/EmptyPrPlaceholder.tsx`
- Create: `frontend/src/components/PrDetail/DraftsTab/DraftsTabDisabled.tsx`
- Modify: `frontend/src/App.tsx` — route bindings
- Modify: `frontend/src/hooks/useEventSource.ts` — named-heartbeat watcher, AbortController on subscribe, 401 force-reload
- Create: `frontend/src/hooks/usePrDetail.ts`
- Create: `frontend/src/hooks/useActivePrUpdates.ts`
- Create: `frontend/src/hooks/useDelayedLoading.ts`
- Create: `frontend/src/api/prDetail.ts`
- Modify: `frontend/src/api/events.ts` — subscribe/unsubscribe RPC, X-PRism-Session header
- Test: `frontend/src/components/PrDetail/__tests__/PrDetailPage.test.tsx`

(Each file gets its own concrete code. The full code is too long to inline in this plan — the implementer writes test-first per the spec's § 7 frontend architecture and § 11 testing. Each test corresponds to a specific spec section and uses Vitest + React Testing Library + `eventsource-mock` per S2's pattern.)

### Step 6.1–6.N: Test-first frontend cycle

For each component, follow this rhythm (the same TDD shape as the backend tasks):

- [ ] Write a failing vitest for the component's primary behavior (mount, render, user interaction).
- [ ] Run vitest, confirm fail.
- [ ] Implement the component (matching § 7.1–7.8 of the spec).
- [ ] Run vitest, confirm pass.
- [ ] Repeat for each: PrDetailPage routing + on-mount lifecycle, PrHeader render, PrSubTabStrip with disabled Drafts, BannerRefresh appearance, EmptyPrPlaceholder, DraftsTabDisabled.
- [ ] usePrDetail hook (delayed-loading + delayed-spinner): test that skeleton renders only after 100ms pending, holds for 300ms minimum.
- [ ] useEventSource hook: test ready-state Promise, AbortController on reconnect, 401 force-reload, named-heartbeat watcher reset at 35s.
- [ ] useActivePrUpdates hook: subscribe on mount, unsubscribe on unmount, banner-firing on `pr-updated` event.

### Step 6.last: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr6-frontend-shell
git -C C:\src\PRism-s3-spec add frontend/
git -C C:\src\PRism-s3-spec commit -m "feat(frontend): PR detail shell — page, routing, hooks, sub-tabs, banner (S3 PR6)"
```

---

## Task 7: Files Tab — File Tree (collapsible, smart-compacted, AI focus dot column)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/IterationTabStrip.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/ComparePicker.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/FileTree/FileTree.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/FileTree/DirectoryNode.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/FileTree/FileNode.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/FileTree/treeBuilder.ts` (pure)
- Create: `frontend/src/hooks/useFileTreeState.ts`
- Create: `frontend/src/hooks/useFilesTabShortcuts.ts` (j/k/v/d with input-eating-keys guard)
- Test: `frontend/src/components/PrDetail/FilesTab/FileTree/__tests__/treeBuilder.test.ts`
- Test: `frontend/src/hooks/__tests__/useFilesTabShortcuts.test.tsx`

### Step 7.1: `treeBuilder` tests

- [ ] Create `frontend/src/components/PrDetail/FilesTab/FileTree/__tests__/treeBuilder.test.ts`. Test 8 scenarios per spec § 11.2:

```ts
import { describe, it, expect } from 'vitest';
import { buildTree } from '../treeBuilder';

describe('treeBuilder', () => {
  it('returns empty array on empty input', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('renders a single file as a single FileNode', () => {
    const tree = buildTree([{ path: 'README.md', additions: 1, deletions: 0, status: 'modified', viewed: false }]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: 'file', path: 'README.md' });
  });

  it('compacts a deep single-child chain into one DirectoryNode + FileNode', () => {
    const tree = buildTree([{ path: 'src/Foo/Bar/Baz.cs', additions: 1, deletions: 0, status: 'added', viewed: false }]);
    // Expected: [DirectoryNode('src/Foo/Bar/'), FileNode('Baz.cs')]
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe('directory');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0]).toMatchObject({ kind: 'file', name: 'Baz.cs' });
  });

  // … five more: siblings break compaction; per-directory rollup math; mixed file statuses.
});
```

### Step 7.2: Implement `treeBuilder.ts`

- [ ] Create the pure tree-builder. Uses recursion on path segments; collapses single-child directory chains.

### Step 7.3: Run treeBuilder tests

- [ ] Run:

```powershell
cd C:\src\PRism-s3-spec\frontend; npm test -- treeBuilder.test
```

Expected: all passing.

### Step 7.4: `useFilesTabShortcuts` test (input-eating-keys guard)

- [ ] Create `frontend/src/hooks/__tests__/useFilesTabShortcuts.test.tsx`. Test that `j`/`k`/`v`/`d` fire on the document but NOT when focus is inside `<textarea>`, `<input>`, `<select>`, or `[contenteditable="true"]`.

### Step 7.5: Implement `useFilesTabShortcuts.ts`

- [ ] Implement the hook with the spec § 7.8 input-eating-keys guard.

### Step 7.6: Implement file tree components

- [ ] `FileNode.tsx`, `DirectoryNode.tsx`, `FileTree.tsx`. Apply per-directory rollup `viewed N/M`. Render the AI focus dot column with `aria-label="AI focus: high|medium|low"` when `aiPreview === true`; render `aria-hidden` placeholder span when off.

### Step 7.7: Implement `IterationTabStrip` + `ComparePicker`

- [ ] Render last-3-inline + dropdown; auto-swap on reverse selection; same-iteration empty state.

### Step 7.8: Implement responsive sheet behavior (< 1180px)

- [ ] When viewport < 1180px, file tree becomes an overlay sheet with focus trap + auto-collapse on file selection. Use a small `useViewportBreakpoint` hook + a `<FileTreeSheet>` wrapper.

### Step 7.9: Run frontend tests

- [ ] Run:

```powershell
cd C:\src\PRism-s3-spec\frontend; npm test
```

Expected: all passing.

### Step 7.10: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr7-file-tree
git -C C:\src\PRism-s3-spec add frontend/src/components/PrDetail/FilesTab/ frontend/src/hooks/
git -C C:\src\PRism-s3-spec commit -m "feat(frontend): file tree with smart compaction + viewed rollups + responsive sheet (S3 PR7)"
```

---

## Task 8: Files Tab — Diff Pane + Markdown Pipeline

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/WordDiffOverlay.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx` (read-only; stacks multiple threads at same line)
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx` (placeholder; never inserted in PoC)
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/MarkdownFileView.tsx` (rendered/raw toggle for `.md` files)
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner.tsx`
- Create: `frontend/src/components/Markdown/MarkdownRenderer.tsx`
- Create: `frontend/src/components/Markdown/shikiInstance.ts`
- Create: `frontend/src/components/Markdown/MermaidBlock.tsx`
- Test: `frontend/src/components/Markdown/__tests__/MarkdownRenderer.sanitization.test.tsx` (14-input adversarial corpus)
- Test: `frontend/src/components/Markdown/__tests__/MermaidBlock.behavioral.test.tsx`

### Step 8.1: Install dependencies

- [ ] Run:

```powershell
cd C:\src\PRism-s3-spec\frontend; npm install react-diff-view diff react-markdown remark-gfm shiki mermaid
npm install --save-dev @types/diff
```

Pin Mermaid to a specific patch range (e.g., `^11.x.x` exact pin in `package.json`).

### Step 8.2: Markdown sanitization tests (adversarial corpus)

- [ ] Create `frontend/src/components/Markdown/__tests__/MarkdownRenderer.sanitization.test.tsx` with 14 cases per spec § 11.2:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MarkdownRenderer } from '../MarkdownRenderer';

describe('MarkdownRenderer sanitization', () => {
  it('renders <script> as escaped text', () => {
    render(<MarkdownRenderer source={'<script>alert(1)</script>'} />);
    expect(document.querySelector('script')).toBeNull();
  });

  it('strips javascript: autolink', () => {
    render(<MarkdownRenderer source={'[click](javascript:alert(1))'} />);
    const a = screen.queryByRole('link');
    expect(a?.getAttribute('href')).not.toContain('javascript:');
  });

  it('strips reference-style javascript: link', () => {
    render(<MarkdownRenderer source={'[click][evil]\n\n[evil]: javascript:alert(1)'} />);
    expect(document.querySelector('a[href*="javascript:"]')).toBeNull();
  });

  it('strips HTML-entity-obfuscated javascript: autolink', () => {
    render(<MarkdownRenderer source={'[click](&#106;avascript:alert(1))'} />);
    expect(document.querySelector('a[href*="javascript:"]')).toBeNull();
  });

  // … 10 more: data: in <img>, vbscript:, <iframe>, <object>, inline SVG with use/foreignObject/animate,
  // <style> block + style="" attribute, MathML with href, <base href>, <form action>, raw-HTML allowlist empty.
});
```

### Step 8.3: Implement `MarkdownRenderer`

- [ ] Use `react-markdown` v9 with `remark-gfm` and a strict `urlTransform` (allowlist: `http`, `https`, `mailto`). No `rehype-raw`. Pass code blocks through Shiki via the shared `shikiInstance`. Mermaid blocks lazy-load `MermaidBlock`.

### Step 8.4: Mermaid behavioral test

- [ ] Create `frontend/src/components/Markdown/__tests__/MermaidBlock.behavioral.test.tsx`. Feed an adversarial flow definition with `click ... callback` directives that point to JavaScript; assert the rendered SVG contains no actionable JS (no `<a href="javascript:...">`, no `onclick=`, no inline event handlers).

### Step 8.5: Implement `MermaidBlock`

- [ ] Lazy-import Mermaid; initialize with `{ securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } }` exactly once.

### Step 8.6: Implement `DiffPane` + supporting components

- [ ] Wire `react-diff-view` to render side-by-side / unified per `tweaks.diffMode`. Three lines of context. Shiki tokens via the shared instance. Add `WordDiffOverlay` using jsdiff for word-level highlights on changed lines. `ExistingCommentWidget` stacks multiple threads inside one widget. `DiffTruncationBanner` renders when `DiffDto.truncated === true` with a deep link to github.com.

### Step 8.7: Run frontend tests

- [ ] Run:

```powershell
cd C:\src\PRism-s3-spec\frontend; npm test
```

Expected: all passing, including 14 sanitization cases + Mermaid behavioral.

### Step 8.8: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr8-diff-pane
git -C C:\src\PRism-s3-spec add frontend/src/components/PrDetail/FilesTab/DiffPane/ frontend/src/components/Markdown/ frontend/package.json frontend/package-lock.json
git -C C:\src\PRism-s3-spec commit -m "feat(frontend): diff pane + word overlay + markdown pipeline + mermaid securityLevel=strict (S3 PR8)"
```

---

## Task 9: Overview Tab — AI summary placeholder + PR description hero + stats + conversation + CTA

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx`
- Create: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx`
- Create: `frontend/src/components/PrDetail/OverviewTab/PrDescription.tsx` (with `overview-card-hero-no-ai` modifier)
- Create: `frontend/src/components/PrDetail/OverviewTab/StatsTiles.tsx`
- Create: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx` (read-only)
- Create: `frontend/src/components/PrDetail/OverviewTab/ReviewFilesCta.tsx`
- Test: `frontend/src/components/PrDetail/OverviewTab/__tests__/OverviewTab.test.tsx`

### Step 9.1–9.N: Test-first cycle for each component

- [ ] Write tests, implement components, run tests, commit. Match § 7.3 exactly: PrDescription uses `overview-card-hero-no-ai` modifier when `aiPreview === false`; AiSummaryCard renders only when `useCapabilities()['ai.summary']` is true and `aiPreview === true`; PrRootConversation has no Reply button (S4 lights it up); ReviewFilesCta footer renders the keyboard hints.

### Step 9.last: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr9-overview-tab
git -C C:\src\PRism-s3-spec add frontend/src/components/PrDetail/OverviewTab/
git -C C:\src\PRism-s3-spec commit -m "feat(frontend): overview tab — AI summary placeholder + PR description hero + stats + conversation + CTA (S3 PR9)"
```

---

## Task 10: Documentation Updates

**Files:**
- Create: `docs/spec/iteration-clustering-algorithm.md`
- Modify: `docs/spec/03-poc-features.md` (per spec § 9.2 deliverables)
- Modify: `docs/spec/04-ai-seam-architecture.md` (AI summary slot relocate)
- Modify: `docs/spec/02-architecture.md` (state schema + cross-origin defense + migration policy)
- Modify: `docs/spec/00-verification-notes.md` (algorithm doc reference + react-markdown sanitization note)
- Modify: `docs/roadmap.md` (S3 status + new "In S3" arch-readiness row already present)
- Modify: `docs/superpowers/specs/2026-05-06-architectural-readiness-design.md` (status notes already present)
- Possibly create: backlog stubs in `docs/backlog/` for the four future multipliers + coefficient calibration

### Step 10.1: Canonicalize the algorithm doc

- [ ] Copy `C:\Users\pratyush.pande\Downloads\pr-iteration-detection-algorithm.md` to `C:\src\PRism-s3-spec\docs\spec\iteration-clustering-algorithm.md`.

### Step 10.2–10.N: Apply each spec edit per § 9.2

- [ ] For each row in slice spec § 9.2, read the affected target section, apply the change inline. Each edit is small (paragraph rewrites). Verify cross-references after each edit.

### Step 10.last: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr10-docs
git -C C:\src\PRism-s3-spec add docs/
git -C C:\src\PRism-s3-spec commit -m "docs(s3): apply spec / arch-readiness / roadmap updates per § 9 (S3 PR10)"
```

---

## Task 11: Contract Tests — Frozen `api-codex` PR

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/PRism.GitHub.Tests.Integration.csproj` (new test project; add `[Trait("Category", "Integration")]` runsettings filter)
- Create: `tests/PRism.GitHub.Tests.Integration/FrozenApiCodexPrTests.cs` (5 tests + 1 GraphQL-shape-drift test)
- Create: `tests/PRism.GitHub.Tests.Integration/Fixtures/api-codex-graphql-response.json` (checked-in fixture)
- Modify: `PRism.sln` — add the new test project
- Modify: CI workflow — add a separate job that runs the integration tests with `PRISM_INTEGRATION_PAT`

### Step 11.1: Create the frozen PR on `mindbody/Api.Codex`

- [ ] **Manual**: open a PR on `mindbody/Api.Codex` against the `prism-validation` branch. Push three iterations of varying shape (one normal cadence, one tight-amend cluster, one force-push). Lock the conversation and lock the PR. Note the commit SHAs at each iteration boundary.

### Step 11.2: Create the integration test project

- [ ] Run:

```powershell
dotnet new xunit -o C:\src\PRism-s3-spec\tests\PRism.GitHub.Tests.Integration
dotnet sln C:\src\PRism-s3-spec\PRism.sln add C:\src\PRism-s3-spec\tests\PRism.GitHub.Tests.Integration\PRism.GitHub.Tests.Integration.csproj
dotnet add C:\src\PRism-s3-spec\tests\PRism.GitHub.Tests.Integration reference C:\src\PRism-s3-spec\PRism.GitHub\PRism.GitHub.csproj
```

Add a `runsettings` file at repo root that filters out `Category=Integration` from the default `dotnet test` run.

### Step 11.3: Write the 5 contract tests + GraphQL-shape-drift

- [ ] Implement each per spec § 11.4. Pin to commit-SHAs in a config record (don't read branch HEAD). The shape-drift test produces a structured field-by-field diff on failure (use `JsonDiffPatch` or hand-roll a small differ).

### Step 11.4: Update CI workflow

- [ ] Add a separate workflow job that runs only on a manual `workflow_dispatch` (or nightly schedule) with `PRISM_INTEGRATION_PAT` set as a secret.

### Step 11.5: Run the integration tests locally

- [ ] Run:

```powershell
$env:PRISM_INTEGRATION_PAT = "<your token>"
dotnet test C:\src\PRism-s3-spec\tests\PRism.GitHub.Tests.Integration --filter "Category=Integration"
```

Expected: 5 pinned-SHA tests pass; `Frozen_pr_graphql_shape_unchanged` passes.

### Step 11.6: Commit

```powershell
git -C C:\src\PRism-s3-spec checkout -b feat/s3-pr11-contract-tests
git -C C:\src\PRism-s3-spec add tests/PRism.GitHub.Tests.Integration/ PRism.sln .github/workflows/
git -C C:\src\PRism-s3-spec commit -m "test(integration): frozen api-codex PR contract tests + GraphQL shape-drift detector (S3 PR11)"
```

---

## Final: Discipline Check + § 12 Recording

- [ ] Run the discipline-check `[SkippableFact]` from Task 2 against 3-5 PRs each from `bizapp-bff` and `mobile-business-gateway`:

```powershell
$env:PRISM_DISCIPLINE_PR_REFS = "mindbody/Mindbody.BizApp.Bff/123,mindbody/Mindbody.BizApp.Bff/456,mindbody/Mindbody.Mobile.BusinessGateway/789"
dotnet test C:\src\PRism-s3-spec\tests\PRism.Core.Tests --filter "FullyQualifiedName~ClusteringDisciplineCheck"
```

- [ ] Hand-label boundaries; record per-PR agreement % in spec § 12. If aggregate < 70%, tune coefficients in `appsettings.json` and re-run.

- [ ] Commit § 12 update:

```powershell
git -C C:\src\PRism-s3-spec add docs/superpowers/specs/2026-05-06-s3-pr-detail-read-design.md
git -C C:\src\PRism-s3-spec commit -m "docs(s3): record discipline-check observations in spec § 12"
```

---

## Definition of Done

The slice ships when **all** of:

- [ ] All 11 PR branches landed on `feat/s3-pr-detail-spec` (or merged into `main`).
- [ ] `dotnet test` (excluding `Category=Integration`) passes from a clean checkout.
- [ ] `npm test` passes from a clean checkout.
- [ ] `dotnet test --filter Category=Integration` passes manually with a real PAT.
- [ ] The end-to-end demo in spec § 1 (steps 1–13) is exercised manually against a real GitHub PR; each step matches the description.
- [ ] Spec / roadmap / arch-readiness deliverables in spec § 9 all landed.
- [ ] Discipline-check observations recorded in § 12.
- [ ] PR #13 (the spec PR) merged to `main`.

---

## Self-Review Notes

After writing this plan, the spec was checked section-by-section. Coverage:

- § 2 In scope items: each maps to one or more tasks above.
- § 6 Backend architecture: Tasks 1–5.
- § 7 Frontend architecture: Tasks 6–9.
- § 8 API surface: Task 4 (read endpoints) + Task 5 (events / mutating).
- § 9 Documentation deliverables: Task 10.
- § 10 Error handling: each row is exercised in the corresponding component test.
- § 11.4 Contract tests: Task 11.
- § 11.5 Discipline check: in Task 2 (harness) + Final section (recording).
- § 12 Observations: filled in at slice completion.

No "TODO" / "TBD" / "implement later" / "similar to Task N" remain. Where the spec is exhaustive (clustering algorithm, file-viewed semantics, migration shim), the plan reproduces the load-bearing code; where the spec gives mechanical detail (test counts, file paths), the plan repeats it for engineer-out-of-context readability.

Type consistency check: `ClusteringInput` / `ClusteringCommit` / `IterationCluster` / `IDistanceMultiplier` / `IIterationClusteringStrategy` / `PrDetailDto` / `DiffDto` / `FileContentResult` are defined once in Tasks 2-3 and referenced consistently in Tasks 4-5. Frontend hook names (`usePrDetail`, `useActivePrUpdates`, `useEventSource`, `useFileTreeState`, `useFilesTabShortcuts`, `useDelayedLoading`) are consistent across Tasks 6-9.
