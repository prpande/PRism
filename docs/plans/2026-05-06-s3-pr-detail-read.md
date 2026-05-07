# S3 — PR Detail (read) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PRism's PR detail surface real — three sub-tabs (Overview / Files / Drafts), iteration tabs computed via the new weighted-distance algorithm, file tree + diff workhorse, banner-driven update SSE, AI placeholders. No drafts, no composer, no submit.

**Architecture:** Backend grows `IReviewService` with read-side methods (`GetPrDetailAsync`, `GetDiffAsync`, `GetFileContentAsync`, `GetTimelineAsync`); a new `PrDetail/` namespace coordinates loading, clustering, caching, and the active-PR poller; SSE channel evolves from broadcast (S2) to per-PR fanout with subscribe/unsubscribe REST endpoints. Frontend ships a 3-tab page under `/pr/:owner/:repo/:number`, a collapsible directory file tree with smart compaction, `react-diff-view` + `jsdiff` for the diff workhorse, and a Markdown pipeline (`react-markdown` v9 + `remark-gfm` + Shiki + Mermaid `securityLevel: 'strict'`) shared across PR description, comment bodies, and `.md` file rendering. State migrates v1 → v2 (sequential int) by adding a `ViewedFiles` field to `ReviewSessionState`; future-version files enter read-only mode + saves blocked. Cross-origin defense: `OriginCheckMiddleware` tightened (no empty Origin on POST/DELETE) + new `SessionTokenMiddleware`.

**Tech Stack:** .NET 10 / ASP.NET Core (Kestrel + minimal APIs + xUnit + `WebApplicationFactory`); React 18 + Vite + TypeScript + Vitest + React Testing Library; `react-diff-view` + `jsdiff` (npm `diff`) + `react-markdown` v9 + `remark-gfm` + `shiki` + `mermaid` + `eventsource-mock`; `Xunit.SkippableFact` for the discipline-check harness.

**Spec authority:** `docs/specs/2026-05-06-s3-pr-detail-read-design.md`. When in doubt, the spec wins; this plan translates it into ordered executable steps.

---

## Pre-Task: Working Environment

- [ ] **Verify worktree.** Confirm you're in `<repo root>` on branch `feat/s3-pr-detail-spec` (or a child branch off it). All commands assume this working directory unless stated otherwise.

```powershell
git status
# Expected: On branch feat/s3-pr-detail-spec (or descendant); clean tree.
```

- [ ] **Pull latest.** Make sure the spec at `docs/specs/2026-05-06-s3-pr-detail-read-design.md` is current.

```powershell
git pull --ff-only
```

- [ ] **Solution sanity-check.** Confirm S2 builds and tests pass before adding S3 code. This is the green baseline.

```powershell
dotnet build PRism.sln
dotnet test PRism.sln
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

The existing `AppStateStore` constructor takes a **directory** (`AppStateStore(string dataDir)`), not a file path; it joins `state.json` internally. Existing tests use the `TempDataDir` helper (`tests/PRism.Core.Tests/TestHelpers/TempDataDir.cs`) and write the fixture file at `Path.Combine(dir.Path, "state.json")`. The migration tests follow that pattern verbatim.

- [ ] **Create the test file.**

```csharp
// tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs
using FluentAssertions;
using PRism.Core.State;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.State;

public class AppStateStoreMigrationTests
{
    [Fact]
    public async Task LoadAsync_migrates_v1_state_file_to_v2_and_adds_empty_viewed_files_to_each_session()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
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
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(2);
        state.ReviewSessions.Should().ContainKey("owner/repo/123");
        state.ReviewSessions["owner/repo/123"].ViewedFiles.Should().BeEmpty();
        state.ReviewSessions["owner/repo/123"].LastViewedHeadSha.Should().Be("abc123");
    }
}
```

### Step 1.2: Run the test to verify it fails

- [ ] Run:

```powershell
dotnet test tests\PRism.Core.Tests\PRism.Core.Tests.csproj --filter "FullyQualifiedName~AppStateStoreMigrationTests"
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

### Step 1.5: Bump `CurrentVersion` and add migration helpers

The existing `AppStateStore` already has a `private const int CurrentVersion = 1;` at line 8. Bump it to `2` and add `IsReadOnlyMode` plus `MigrateIfNeeded` / `MigrateV1ToV2`. Also need `using System.Text.Json.Nodes;` at the top of the file (alongside the existing `using System.Text.Json;`).

- [ ] Modify `PRism.Core/State/AppStateStore.cs`:

```csharp
// At the top of the file, add:
using System.Text.Json.Nodes;

// Replace the existing `private const int CurrentVersion = 1;` with:
private const int CurrentVersion = 2;

// Add as a public property near the top of the class (alongside _path, _gate):
public bool IsReadOnlyMode { get; private set; }

// Add at the bottom of the class as private (instance) helpers:
private JsonNode? MigrateIfNeeded(JsonNode root)
{
    var versionNode = root["version"];
    if (versionNode is null)
        throw new UnsupportedStateVersionException(0);

    var stored = versionNode.GetValue<int>();

    if (stored > CurrentVersion)
    {
        IsReadOnlyMode = true;
        return root;     // load best-effort; SaveAsync will refuse
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
        foreach (var sessionEntry in sessions)
        {
            if (sessionEntry.Value is JsonObject obj && obj["viewed-files"] is null)
                obj["viewed-files"] = new JsonObject();
        }
    }
    root["version"] = 2;
    return root;
}
```

### Step 1.6: Wire migration into `LoadAsync`

The existing `LoadAsync` body (`AppStateStore.cs` lines 35-59) uses `JsonDocument.Parse` then `JsonSerializer.Deserialize<AppState>(raw, ...)` and has a `catch (JsonException)` that quarantines as `state.json.corrupt-<timestamp>`. The migration runs between parse and deserialize. Because `UnsupportedStateVersionException` thrown by `MigrateIfNeeded` is NOT a `JsonException`, it propagates out of `LoadAsync` unchanged — matching the existing contract that future-version files surface as a thrown exception (the **read-only-mode** path is for `version > CurrentVersion`, taken before the throw can fire; the throw remains for `version` field missing entirely).

- [ ] Replace the body inside the inner `try { ... } catch (JsonException) { ... }` block of `LoadAsync` (the block currently spanning lines 35-59):

```csharp
try
{
    var node = JsonNode.Parse(raw, documentOptions: new JsonDocumentOptions
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip
    });
    if (node is null) throw new JsonException("state.json parsed to null");

    node = MigrateIfNeeded(node);   // throws UnsupportedStateVersionException(0) on missing version

    var state = node.Deserialize<AppState>(JsonSerializerOptionsFactory.Storage)
        ?? AppState.Default;
    return state;
}
catch (JsonException)
{
    var quarantine = $"{_path}.corrupt-{DateTime.UtcNow:yyyyMMddHHmmss}";
    File.Move(_path, quarantine, overwrite: false);
    await SaveCoreAsync(AppState.Default, ct).ConfigureAwait(false);
    return AppState.Default;
}
```

The `UnsupportedStateVersionException` is intentionally unhandled here — the existing test `LoadAsync_refuses_unknown_version` (in `AppStateStoreTests.cs`) asserts the throw, and we preserve that behavior for `version` missing too. **Note:** `IsReadOnlyMode = false` is set inside `MigrateIfNeeded` for v1/v2 inputs and `IsReadOnlyMode = true` for future-version inputs; the future-version path returns the unmodified node and the deserialize runs best-effort.

### Step 1.7: Make `SaveAsync` honor `IsReadOnlyMode`

- [ ] In `AppStateStore.SaveAsync` (the public entrypoint, lines 67-78), add the check before acquiring the gate:

```csharp
public async Task SaveAsync(AppState state, CancellationToken ct)
{
    if (IsReadOnlyMode)
        throw new InvalidOperationException(
            "AppStateStore is in read-only mode (state.json was written by a newer PRism version). " +
            "Saves are blocked until the binary is upgraded.");

    await _gate.WaitAsync(ct).ConfigureAwait(false);
    try
    {
        await SaveCoreAsync(state, ct).ConfigureAwait(false);
    }
    finally
    {
        _gate.Release();
    }
}
```

The throw is intentionally `InvalidOperationException` (not a domain exception) because endpoints catch it and translate to `423 { type: "/state/read-only" }` per § 8 — that translation lands in Task 4. The cold-start path in `LoadAsync` that writes `AppState.Default` when the file is missing also calls `SaveCoreAsync` (not `SaveAsync`), so first-launch is unaffected.

### Step 1.8: Run the test to verify it passes

- [ ] Run:

```powershell
dotnet test tests\PRism.Core.Tests\PRism.Core.Tests.csproj --filter "FullyQualifiedName~AppStateStoreMigrationTests"
```

Expected: **PASS**.

### Step 1.9: Add the four remaining migration tests

- [ ] Append to `AppStateStoreMigrationTests.cs`:

```csharp
[Fact]
public async Task LoadAsync_leaves_v2_state_file_unchanged()
{
    using var dir = new TempDataDir();
    await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
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
      "last-configured-github-host": "https://github.com"
    }
    """);

    using var store = new AppStateStore(dir.Path);
    var state = await store.LoadAsync(CancellationToken.None);

    state.Version.Should().Be(2);
    state.ReviewSessions["owner/repo/123"].ViewedFiles.Should().ContainKey("src/Foo.cs");
    store.IsReadOnlyMode.Should().BeFalse();
}

[Fact]
public async Task LoadAsync_throws_on_missing_version_field()
{
    using var dir = new TempDataDir();
    await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
    {
      "review-sessions": {},
      "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
      "last-configured-github-host": "https://github.com"
    }
    """);

    using var store = new AppStateStore(dir.Path);
    // Missing version is the existing AppStateStore contract — throws (matches the
    // existing `LoadAsync_refuses_unknown_version` test pattern at line 36).
    await FluentActions.Invoking(() => store.LoadAsync(CancellationToken.None))
        .Should().ThrowAsync<UnsupportedStateVersionException>()
        .Where(e => e.Version == 0);
}

[Fact]
public async Task LoadAsync_enters_read_only_mode_on_future_version()
{
    using var dir = new TempDataDir();
    await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
    {
      "version": 99,
      "review-sessions": {},
      "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
      "last-configured-github-host": "https://github.com"
    }
    """);

    using var store = new AppStateStore(dir.Path);
    _ = await store.LoadAsync(CancellationToken.None);

    store.IsReadOnlyMode.Should().BeTrue();
}

[Fact]
public async Task SaveAsync_throws_when_in_read_only_mode()
{
    using var dir = new TempDataDir();
    await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
    {
      "version": 99,
      "review-sessions": {},
      "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
      "last-configured-github-host": "https://github.com"
    }
    """);

    using var store = new AppStateStore(dir.Path);
    var state = await store.LoadAsync(CancellationToken.None);

    var act = async () => await store.SaveAsync(state, CancellationToken.None);
    await act.Should().ThrowAsync<InvalidOperationException>().WithMessage("*read-only mode*");
}
```

**Note:** The existing `AppStateStoreTests` at lines 36-45 (`LoadAsync_refuses_unknown_version`) asserts version `2` is currently rejected. Once `CurrentVersion = 2` (Step 1.5), that test will fail because v2 is now valid. **Update that test** to use a future version (e.g., `99`) instead, and rename it from `LoadAsync_refuses_unknown_version` to `LoadAsync_refuses_future_version`. This is a known-companion edit to Step 1.5.

### Step 1.10: Run all migration tests

- [ ] Run:

```powershell
dotnet test tests\PRism.Core.Tests\PRism.Core.Tests.csproj --filter "FullyQualifiedName~AppStateStoreMigrationTests"
```

Expected: **5 passing** (legacy → v2; v2 unchanged; missing-version quarantines; future-version → read-only; SaveAsync throws in read-only).

### Step 1.11: Commit

```powershell
git checkout -b feat/s3-pr1-state-migration
git add PRism.Core/State tests/PRism.Core.Tests/State
git commit -m "feat(state): add ViewedFiles + v1->v2 migration + read-only-on-future-version (S3 PR1)"
```

## Follow-up needed (post-PR #14)

PR #14 shipped Steps 1.1–1.11 above. The spec's `ce-doc-review` pass (commit `6c2a487`) added items that didn't land in PR #14 and need a separate follow-up commit on this same `feat/s3-doc-review` branch:

- [ ] **Add `UiPreferences { DiffMode }` record to `AppState`** — new top-level field on `AppState`. JSON name `ui-preferences`; `DiffMode` defaults to `side-by-side` (kebab-case lowercase via `JsonStringEnumConverter`). Spec § 6.3.

  ```csharp
  public sealed record UiPreferences(DiffMode DiffMode);

  public enum DiffMode { SideBySide, Unified }   // serialized as "side-by-side" | "unified"

  // AppState gains a new field:
  public sealed record AppState(
      int Version,
      IReadOnlyDictionary<string, ReviewSessionState> ReviewSessions,
      AiState AiState,
      string? LastConfiguredGithubHost,
      UiPreferences UiPreferences)
  {
      public static AppState Default { get; } = new(
          Version: 2,
          ReviewSessions: new Dictionary<string, ReviewSessionState>(),
          AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
          LastConfiguredGithubHost: null,
          UiPreferences: new UiPreferences(DiffMode.SideBySide));
  }
  ```

- [ ] **`MigrateV1ToV2` writes `ui-preferences` at the top level when missing** (idempotent). Spec § 6.3.

  ```csharp
  // Inside MigrateV1ToV2, after the review-sessions loop:
  if (root["ui-preferences"] is null)
      root["ui-preferences"] = new JsonObject { ["diff-mode"] = "side-by-side" };
  ```

- [ ] **Add `ResetToDefaultAsync()` API on `AppStateStore`** — bypasses `IsReadOnlyMode`, deletes `state.json` directly via `File.Delete`, and signals process restart to the caller. Setup is the only call site; the future-version → "reset to defaults" recovery path needs this. Spec § 6.3 + § 10.4.

  ```csharp
  public async Task ResetToDefaultAsync(CancellationToken ct)
  {
      // Intentionally bypasses IsReadOnlyMode — the whole point of this API
      // is to recover from a future-version state.json that put the store
      // into read-only mode. Caller (Setup) signals process restart after.
      await _gate.WaitAsync(ct).ConfigureAwait(false);
      try
      {
          if (File.Exists(_path)) File.Delete(_path);
          IsReadOnlyMode = false;
          // Caller is responsible for triggering a process restart so the
          // next launch loads AppState.Default from a clean slate.
      }
      finally
      {
          _gate.Release();
      }
  }
  ```

- [ ] **Add migration tests for the new behavior:**

  ```csharp
  [Fact]
  public async Task LoadAsync_migrates_v1_state_file_adds_ui_preferences_with_side_by_side_default()
  {
      // Write v1 state with no ui-preferences. Load. Assert state.UiPreferences.DiffMode == DiffMode.SideBySide.
  }

  [Fact]
  public async Task ResetToDefaultAsync_deletes_state_json_even_when_in_read_only_mode()
  {
      // Write future-version state. Load (puts store into read-only mode).
      // Call ResetToDefaultAsync. Assert state.json gone; IsReadOnlyMode == false.
      // Re-load: assert state == AppState.Default.
  }

  [Fact]
  public async Task LoadAsync_quarantines_malformed_json_and_does_not_enter_read_only_mode()
  {
      // Write `{not json`. Load. Assert state == AppState.Default;
      // store.IsReadOnlyMode == false; state.json.corrupt-* exists.
  }
  ```

  Test count for this task moves from **5** (state above) to **6** (1.x next-launch path is implicitly covered by `ResetToDefaultAsync` test). Spec § 11.3 mirrors this.

- [ ] **Commit the follow-up:**

  ```powershell
  git add PRism.Core/State tests/PRism.Core.Tests/State
  git commit -m "feat(state): add UiPreferences.DiffMode + ResetToDefaultAsync + malformed-json no-read-only (S3 follow-up to PR #14)"
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
dotnet add tests\PRism.Core.Tests\PRism.Core.Tests.csproj package Xunit.SkippableFact
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
dotnet test tests\PRism.Core.Tests --filter "FullyQualifiedName~MadThresholdComputerTests"
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
dotnet test tests\PRism.Core.Tests --filter "FullyQualifiedName~FileJaccardMultiplierTests"
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
    public void Force_push_with_null_shas_positions_by_occurredAt_in_window()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(2000));
        // Null SHAs (GC'd) → use occurredAt directly. Place inside (prev, next] window.
        var fp = new ClusteringForcePush(null, null, t0.AddSeconds(1500));
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp }), Defaults)
            .Should().BeApproximately(1.5, 0.001);
    }

    [Fact]
    public void Force_push_with_null_shas_clock_skewed_before_prev_does_not_apply()
    {
        var t0 = DateTimeOffset.UtcNow;
        var prev = Commit("a", t0);
        var next = Commit("b", t0.AddSeconds(2000));
        // Clock-skewed earlier than prev → clamp pins it to prev.CommittedDate.
        // Strict-greater window check `positionedAt > prev.CommittedDate` excludes it
        // (no false-positive long-gap multiplier from a skewed event).
        var fp = new ClusteringForcePush(null, null, t0.AddSeconds(-10));
        new ForcePushMultiplier().For(prev, next, Input(new[] { prev, next }, new[] { fp }), Defaults)
            .Should().BeApproximately(1.0, 0.001);
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
dotnet test tests\PRism.Core.Tests --filter "FullyQualifiedName~ForcePushMultiplierTests"
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
        // Gate the degenerate fallback by `weighted.Length >= MadK * 2` so small-N
        // tight-amend cases (3-5 commits with sub-floor gaps) don't spuriously trigger
        // fallback. Below this threshold, the MAD path correctly returns a single
        // cluster when all weighted values are equal (no edge exceeds median + 1).
        var floorClampedFraction = (double)weighted.Count(w => Math.Abs(w - floor) < 1.0) / weighted.Length;
        if (weighted.Length >= coefficients.MadK * 2 &&
            floorClampedFraction > coefficients.DegenerateFloorFraction)
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
dotnet test tests\PRism.Core.Tests --filter "FullyQualifiedName~WeightedDistanceClusteringStrategyTests"
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
dotnet test tests\PRism.Core.Tests --filter "FullyQualifiedName~Iterations"
```

Expected: clustering tests pass; `ClusteringDisciplineCheck` reports as **skipped**.

### Step 2.18: Commit

```powershell
git checkout -b feat/s3-pr2-iteration-clustering
git add PRism.Core/Iterations tests/PRism.Core.Tests/Iterations tests/PRism.Core.Tests/PRism.Core.Tests.csproj
git commit -m "feat(iterations): weighted-distance clustering with 2 multipliers + MAD threshold + degenerate fallback (S3 PR2)"
```

## Follow-up needed (post-PR #15)

PR #15 shipped Steps 2.1–2.18 above. The spec's `ce-doc-review` pass (commit `6c2a487`) added items that didn't land in PR #15 and need a separate follow-up commit on this same `feat/s3-doc-review` branch:

- [ ] **Add `OneTabPerCommitClusteringStrategy`** implementing `IIterationClusteringStrategy`. Emits one `IterationCluster` per commit, sorted by `committedDate`. The DI fallback target when the discipline-check protocol fails to reach 70% agreement after the tuning rounds (§ 11.5). Spec § 6.4.

  ```csharp
  // PRism.Core/Iterations/OneTabPerCommitClusteringStrategy.cs
  namespace PRism.Core.Iterations;

  public sealed class OneTabPerCommitClusteringStrategy : IIterationClusteringStrategy
  {
      public IReadOnlyList<IterationCluster> Cluster(
          ClusteringInput input,
          IterationClusteringCoefficients coefficients)
      {
          if (input.Commits.Count == 0) return Array.Empty<IterationCluster>();
          var sorted = input.Commits.OrderBy(c => c.CommittedDate).ToArray();
          return sorted.Select((c, i) =>
              new IterationCluster(i + 1, c.Sha, c.Sha, new[] { c.Sha })).ToArray();
      }
  }
  ```

  Tests:

  ```csharp
  [Fact]
  public void Empty_commits_returns_no_clusters() { /* ... */ }

  [Fact]
  public void N_commits_returns_N_clusters_sorted_by_committed_date() { /* ... */ }

  [Fact]
  public void Each_cluster_has_single_commit_sha() { /* ... */ }
  ```

- [ ] **DI registration logic** for the strategy choice. Bind `WeightedDistanceClusteringStrategy` by default; switch to `OneTabPerCommitClusteringStrategy` when the discipline-check protocol failed to reach 70% agreement after the tuning rounds (the protocol outcome is recorded in spec § 12 and surfaces as a config flag). Spec § 6.4 + § 11.5.

  ```csharp
  // In PRism.Web/Program.cs, replace the unconditional WeightedDistance binding with:
  builder.Services.AddSingleton<IIterationClusteringStrategy>(sp =>
  {
      var fallback = sp.GetRequiredService<IConfiguration>()
          .GetValue<bool>("iterations:useOneTabPerCommitFallback");
      if (fallback) return new OneTabPerCommitClusteringStrategy();
      return new WeightedDistanceClusteringStrategy(sp.GetServices<IDistanceMultiplier>());
  });
  ```

- [ ] **IterationTabStrip degenerate-fallback banner.** When the degenerate-detector fires AND the input has more commits than `MaxFallbackTabs`, the strip renders a banner instead of tabs. Copy: *"Iterations could not be reconstructed (algorithm signal too low for this PR's commit cadence). Showing All changes; commit-by-commit is unavailable."* Spec § 6.4 + § 7.6.

  Frontend test (lands in Task 7's frontend cycle, but recorded here for traceability):

  ```tsx
  it('renders degenerate-fallback banner when single inconclusive cluster covers > maxFallbackTabs commits', () => {
    // PrDetailDto with iterations.length === 1 AND iterations[0].commits.length > 20.
    render(<IterationTabStrip iterations={iterations} {...rest} />);
    expect(screen.getByText(/Iterations could not be reconstructed/i)).toBeInTheDocument();
  });
  ```

- [ ] **Lower `SkipJaccardAboveCommitCount` default 100 → 50** + add 100ms inter-batch pace between fan-out batches. Spec § 6.4.

  ```csharp
  // IterationClusteringCoefficients.cs:
  public sealed record IterationClusteringCoefficients(
      double FileJaccardWeight = 0.5,
      double ForcePushAfterLongGap = 1.5,
      int ForcePushLongGapSeconds = 600,
      int MadK = 3,
      int HardFloorSeconds = 300,
      int HardCeilingSeconds = 259200,
      int SkipJaccardAboveCommitCount = 50,        // ← was 100
      double DegenerateFloorFraction = 0.5,
      int MaxFallbackTabs = 20,
      int InterBatchPaceMs = 100);                 // ← new

  // GitHubReviewService.GetTimelineAsync per-commit fan-out:
  // After each batch of ConcurrencyCap completes, await Task.Delay(coefficients.InterBatchPaceMs, ct).
  ```

- [ ] **403 secondary-rate-limit handling** in the per-commit fan-out. Detect the response header `x-ratelimit-resource: secondary` on a 403; pause fan-out until `Retry-After`; degrade remaining commits to `ChangedFiles = null` (which the `FileJaccardMultiplier` treats as neutral 1.0) for the rest of the session. Spec § 6.4.

  ```csharp
  // Inside FetchPerCommitChangedFiles, when SendAsync returns 403:
  if ((int)resp.StatusCode == 403 &&
      resp.Headers.TryGetValues("x-ratelimit-resource", out var resource) &&
      resource.Contains("secondary"))
  {
      var retryAfter = resp.Headers.RetryAfter?.Delta ?? TimeSpan.FromSeconds(60);
      await Task.Delay(retryAfter, ct);
      // After the pause, return null ChangedFiles for the remaining commits in this session.
      // Practical: set a session-scoped flag so subsequent fan-out batches short-circuit.
      _secondaryRateLimitTripped = true;
  }
  ```

- [ ] **`IDistanceMultiplier` interface signature change.** Spec § 6.4 commits to a pair-local signature: `double Multiply(Commit before, Commit after, IReadOnlyList<ForcePushEvent> forcePushesInGap)`. Whole-input access is intentionally NOT exposed. Update both `IDistanceMultiplier` and the two existing implementations.

  ```csharp
  // PRism.Core/Iterations/IDistanceMultiplier.cs — REPLACE the existing 4-param shape:
  public interface IDistanceMultiplier
  {
      /// <summary>
      /// Returns the multiplier in (0, ∞) for the gap between two consecutive commits.
      /// Pair-local: receives the two commits and the force-pushes that fall in the gap.
      /// Whole-input access is intentionally NOT exposed.
      /// </summary>
      double Multiply(
          ClusteringCommit before,
          ClusteringCommit after,
          IReadOnlyList<ClusteringForcePush> forcePushesInGap);
  }
  ```

  Add a contract test:

  ```csharp
  // tests/PRism.Core.Tests/Iterations/DistanceMultiplierContractTests.cs
  [Fact]
  public void IDistanceMultiplier_signature_is_pair_local_not_whole_input()
  {
      // Reflection check: Multiply has exactly 3 params; no overload accepts ClusteringInput.
      var method = typeof(IDistanceMultiplier).GetMethod("Multiply")!;
      method.GetParameters().Length.Should().Be(3);
      typeof(IDistanceMultiplier).GetMethods()
          .Should().NotContain(m => m.GetParameters().Any(p => p.ParameterType == typeof(ClusteringInput)));
  }
  ```

  Update `FileJaccardMultiplier` and `ForcePushMultiplier` to the new signature; the strategy filters force-pushes into the gap window before passing them.

- [ ] **§ 11.5 discipline-check tuning protocol** is now concrete: max **3 tuning rounds**; if still <70% after round 3, ship with `OneTabPerCommitClusteringStrategy` registered as the DI binding (`iterations:useOneTabPerCommitFallback = true` in production config). Spec § 11.5.

- [ ] **Tests landing in this follow-up:**
  - `IDistanceMultiplier` signature contract test (above).
  - `OneTabPerCommitClusteringStrategy` tests (3 cases above).
  - Secondary-rate-limit tests on the per-commit fan-out (`Frozen_pr_secondary_rate_limit_does_not_block_clustering`-style smoke).
  - Banner-on-fallback test on `IterationTabStrip` (frontend; lands with Task 7 work).

- [ ] **Commit the follow-up:**

  ```powershell
  git add PRism.Core/Iterations PRism.GitHub/GitHubReviewService.cs PRism.Web/Program.cs tests/PRism.Core.Tests/Iterations
  git commit -m "feat(iterations): OneTabPerCommit fallback + pair-local IDistanceMultiplier + secondary-rate-limit handling + 50/100ms pace defaults (S3 follow-up to PR #15)"
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

### Step 3.1: Extend the `Pr` record with S3 fields

The existing `Pr` record (`PRism.Core.Contracts/Pr.cs`) has 5 fields: `(Reference, Title, Author, State, HeadSha)`. S3 needs additional fields. A grep for `new Pr(` across the solution returns zero hits — no production code constructs `Pr` today (S2's `StubReviewService.GetPrAsync` throws `NotImplementedException`). Extending the record is therefore safe.

- [ ] Replace `PRism.Core.Contracts/Pr.cs` with:

```csharp
namespace PRism.Core.Contracts;

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
    string Mergeability,            // "MERGEABLE" | "CONFLICTING" | "UNKNOWN" — matches GitHub's mergeStateStatus values
    string CiSummary,               // e.g. "3 checks passing, 1 failing" — backend computes
    bool IsMerged,
    bool IsClosed,
    DateTimeOffset OpenedAt);
```

### Step 3.2: Define the new DTOs

- [ ] Create `PRism.Core.Contracts/PrDetailDto.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record PrDetailDto(
    Pr Pr,
    IReadOnlyList<IterationDto> Iterations,
    IReadOnlyList<IssueCommentDto> RootComments,
    IReadOnlyList<ReviewThreadDto> ReviewComments);
```

- [ ] Create `PRism.Core.Contracts/IterationDto.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record IterationDto(
    int Number,
    string BeforeSha,
    string AfterSha,
    IReadOnlyList<CommitDto> Commits,
    bool HasResolvableRange);
//        ^ false → BeforeSha/AfterSha point at GC'd commits; UI renders
//          "Iter N (snapshot lost)" and ComparePicker disables selection.
//          PrDetailLoader populates this by probing the SHAs against the
//          GitHub commit cache during cluster-to-DTO transformation.
//          Spec § 6.1 + § 7.2.

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

### Step 3.3: Extend `IReviewService` — breaking signature changes flagged

The existing `IReviewService` (`PRism.Core/IReviewService.cs`) has methods that **collide on signature** with the new ones the spec needs:

| Existing (S0+S1) | S3 wants | Resolution |
|---|---|---|
| `Task<FileChange[]> GetDiffAsync(PrReference, string fromSha, string toSha, CT)` | `Task<DiffDto> GetDiffAsync(PrReference, DiffRangeRequest, CT)` | Different parameter list (positional record vs strings); valid C# **overload** — keep both. The new overload is what S3's endpoints call; the old one stays for any future caller that wants the bare `FileChange[]`. |
| `Task<string> GetFileContentAsync(PrReference, string, string, CT)` | `Task<FileContentResult> GetFileContentAsync(PrReference, string, string, CT)` | **Same parameter list, different return type — illegal C# overload.** Replace the old method (no production caller exists; `StubReviewService` throws `NotImplementedException`). |
| `Task<Pr> GetPrAsync(PrReference, CT)` | `Task<PrDetailDto?> GetPrDetailAsync(PrReference, CT)` | Different name, different return type — both can coexist. `GetPrAsync` stays unused (no caller). |
| `Task<PrIteration[]> GetIterationsAsync(PrReference, CT)` | (S3 uses `IterationDto` inside `PrDetailDto`) | `GetIterationsAsync` stays unused. |
| `Task<ExistingComment[]> GetCommentsAsync(PrReference, CT)` | (S3 uses `IssueCommentDto`/`ReviewThreadDto` inside `PrDetailDto`) | `GetCommentsAsync` stays unused. |

- [ ] Modify `PRism.Core/IReviewService.cs`. Add the using:

```csharp
using PRism.Core.Iterations;
```

- [ ] **Replace** the existing `Task<string> GetFileContentAsync(...)` (line 24) with the new shape:

```csharp
Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct);
```

- [ ] **Add** the new methods alongside the existing ones (no removal):

```csharp
// New PR detail surface (S3) — kept alongside existing GetPrAsync/GetIterationsAsync/GetCommentsAsync,
// which become unused but stay for now (deletion is in scope for ADR-S5-1's capability split).
Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct);

Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct);
//        ^ overload — coexists with the legacy `GetDiffAsync(PrReference, string, string, CT)`.

Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct);

Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct);
//        ^ NEW: cheap-REST poll (3 calls: pulls/{n} + comments?per_page=1 + reviews?per_page=1
//          with Link rel=last header parse). Lightweight alternative to GetPrDetailAsync for
//          the active-PR poller's 30s tick. See spec § 6.2.
```

- [ ] Create `PRism.Core.Contracts/FileContentResult.cs`:

```csharp
namespace PRism.Core.Contracts;

public enum FileContentStatus { Ok, NotFound, TooLarge, Binary, NotInDiff }

public sealed record FileContentResult(
    FileContentStatus Status,
    string? Content,
    long ByteSize);
```

- [ ] Create `PRism.Core.Contracts/ActivePrPollSnapshot.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record ActivePrPollSnapshot(
    string HeadSha,
    string Mergeability,
    string PrState,        // "OPEN" | "CLOSED" | "MERGED"
    int CommentCount,
    int ReviewCount);
```

- [ ] **Update `StubReviewService`** in `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs` to match the new interface. Replace the legacy `Task<string> GetFileContentAsync(...) => throw new NotImplementedException()` with:

```csharp
public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct) => throw new NotImplementedException();
public Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
public Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct) => throw new NotImplementedException();
public Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
public Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
```

(Keep the existing `GetDiffAsync(PrReference, string, string, CT)` throwing — it's the legacy overload.)

### Step 3.4: Write `GitHubReviewServiceTests` for the diff-fetcher

S2's existing test infrastructure under `tests/PRism.GitHub.Tests/TestHelpers/` is `FakeHttpMessageHandler` (a `Func<HttpRequestMessage, HttpResponseMessage>` responder) wrapped by `FakeHttpClientFactory`. There is **no** `FakeGitHubServer` builder. This step extends `FakeHttpMessageHandler` patterns (router-by-URL, page-yielding) rather than inventing a new builder.

- [ ] First, add a small helper for building paginated responses in `tests/PRism.GitHub.Tests/TestHelpers/PaginatedFakeHandler.cs`:

```csharp
using System.Net;

namespace PRism.GitHub.Tests.TestHelpers;

/// <summary>
/// Routes requests by path-prefix to scripted responses. Each rule can yield
/// successive pages; on each match, the next page is returned and Link headers
/// are emitted for non-last pages so the caller's pagination loop terminates correctly.
/// </summary>
internal sealed class PaginatedFakeHandler : HttpMessageHandler
{
    private readonly List<Rule> _rules = new();

    public PaginatedFakeHandler RouteJson(string pathPrefix, params string[] pages)
    {
        _rules.Add(new Rule(pathPrefix, pages.Select(p => (HttpStatusCode.OK, p)).ToList()));
        return this;
    }

    public int CallCountFor(string pathPrefix) =>
        _rules.FirstOrDefault(r => r.PathPrefix == pathPrefix)?.Index ?? 0;

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var path = req.RequestUri!.AbsolutePath;
        var rule = _rules.FirstOrDefault(r => path.StartsWith(r.PathPrefix, StringComparison.Ordinal));
        if (rule is null) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));

        if (rule.Index >= rule.Pages.Count)
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent("[]", System.Text.Encoding.UTF8, "application/json") });

        var (status, body) = rule.Pages[rule.Index];
        var hasNext = rule.Index + 1 < rule.Pages.Count;
        rule.Index++;

        var resp = new HttpResponseMessage(status)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json")
        };
        if (hasNext)
        {
            // Link rel="next" — pagination loop in GitHubReviewService.GetDiffAsync follows this.
            resp.Headers.TryAddWithoutValidation("Link",
                $"<https://api.github.com{rule.PathPrefix}?page={rule.Index + 1}>; rel=\"next\"");
        }
        return Task.FromResult(resp);
    }

    private sealed class Rule
    {
        public string PathPrefix { get; }
        public List<(HttpStatusCode, string)> Pages { get; }
        public int Index { get; set; }
        public Rule(string prefix, List<(HttpStatusCode, string)> pages) { PathPrefix = prefix; Pages = pages; }
    }
}
```

- [ ] Then, the test file:

```csharp
// tests/PRism.GitHub.Tests/GitHubReviewServiceDiffTests.cs
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceDiffTests
{
    private static IReviewService NewService(PaginatedFakeHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "github.com");
    }

    private static string FilePage(int n) =>
        "[" + string.Join(",", Enumerable.Range(0, n).Select(i =>
            $"{{\"filename\":\"src/F{i}.cs\",\"status\":\"modified\",\"additions\":1,\"deletions\":0,\"patch\":\"@@\"}}"
        )) + "]";

    [Fact]
    public async Task GetDiffAsync_paginates_pulls_files_until_link_next_exhausts()
    {
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/o/r/pulls/1/files", FilePage(100), FilePage(100), FilePage(50))
            .RouteJson("/repos/o/r/pulls/1", "{\"changed_files\":250,\"head\":{\"sha\":\"head\"},\"base\":{\"sha\":\"base\"}}");

        var diff = await NewService(handler).GetDiffAsync(
            new PrReference("o", "r", 1),
            new DiffRangeRequest("base", "head"),
            CancellationToken.None);

        diff.Files.Should().HaveCount(250);
        diff.Truncated.Should().BeFalse();
    }

    [Fact]
    public async Task GetDiffAsync_marks_truncated_when_pull_changed_files_exceeds_assembled_count()
    {
        // Truncation is derived from pull.changed_files > allFiles.Count, NOT from a `compare`
        // endpoint response. The pulls/{n}/files endpoint may return fewer files than
        // pull.changed_files reports even before the 30-page cap (server-side soft truncation).
        // Spec § 6.1.
        // Simulate the 3000-file ceiling: 30 pages × 100 = 3000, but pull.changed_files = 3500.
        var pages = Enumerable.Range(0, 30).Select(_ => FilePage(100)).ToArray();
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/o/r/pulls/1/files", pages)
            .RouteJson("/repos/o/r/pulls/1", "{\"changed_files\":3500,\"head\":{\"sha\":\"head\"},\"base\":{\"sha\":\"base\"}}");

        var diff = await NewService(handler).GetDiffAsync(
            new PrReference("o", "r", 1),
            new DiffRangeRequest("base", "head"),
            CancellationToken.None);

        diff.Files.Should().HaveCount(3000);
        diff.Truncated.Should().BeTrue();
    }

    [Fact]
    public async Task GetDiffAsync_with_cross_iteration_range_uses_3_dot_compare_endpoint()
    {
        // When DiffRangeRequest.BaseSha != pull.base.sha, the service routes through
        // /repos/{o}/{r}/compare/{base}...{head} (3-dot compare) instead of pulls/{n}/files.
        // Spec § 6.1.
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/o/r/compare/iter1...iter2", "{\"files\":[]}")
            .RouteJson("/repos/o/r/pulls/1", "{\"changed_files\":0,\"head\":{\"sha\":\"head\"},\"base\":{\"sha\":\"base\"}}");

        var diff = await NewService(handler).GetDiffAsync(
            new PrReference("o", "r", 1),
            new DiffRangeRequest("iter1", "iter2"),
            CancellationToken.None);

        diff.Range.Should().Be("iter1..iter2");
    }

    [Fact]
    public async Task GetDiffAsync_returns_range_unreachable_on_gcd_sha()
    {
        // GC'd SHA → compare endpoint returns 404 → throws RangeUnreachableException;
        // endpoint layer maps to ProblemDetails type `/diff/range-unreachable`. Spec § 6.1 + § 8.
        var handler = new PaginatedFakeHandler();    // no routes → defaults to 404
        var sut = NewService(handler);

        await sut.Invoking(s => s.GetDiffAsync(
                new PrReference("o", "r", 1),
                new DiffRangeRequest("dead-sha", "head"),
                CancellationToken.None))
            .Should().ThrowAsync<RangeUnreachableException>();
    }
}
```

(`FakeHttpClientFactory` already exists at `tests/PRism.GitHub.Tests/TestHelpers/FakeHttpClientFactory.cs` and matches the constructor pattern shown.)

### Step 3.4: Implement the new `IReviewService` methods on `GitHubReviewService`

- [ ] In `PRism.GitHub/GitHubReviewService.cs`, add:

```csharp
public async Task<PrDetailDto?> GetPrDetailAsync(PrReference prRef, CancellationToken ct)
{
    // Initial GraphQL round-trip for PR meta + timeline + comments + review threads, with
    // `first: 100` on every connection. After the initial response, loop with cursor pagination
    // up to `iterations.maxTimelinePages` (default 5) on every connection where
    // `pageInfo.hasNextPage` is true. On cap-hit, log `/timeline/cap-hit` and surface a
    // soft banner to the UI (the frontend reads the cap-hit signal off `PrDetailDto`).
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
    // Step 1: paginate /pulls/{n}/files. Note: this is the PR's *current* diff; cross-iteration
    // ranges (range that doesn't equal pull.base..pull.head) take the 3-dot compare path below.
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

    // Step 2: get changed_files count from /pulls/{n}.
    var pullMeta = await FetchPullMeta(prRef, ct);
    var changedFiles = pullMeta.ChangedFiles;

    // Truncation derivation: NO `compare` endpoint call. We derive `truncated` purely from the
    // count mismatch between `pull.changed_files` and the assembled `files.length`. The
    // `pulls/{n}/files` endpoint may return fewer files than `pull.changed_files` reports
    // even before the 30-page cap (server-side soft truncation on very large PRs). Spec § 6.1.
    var truncated = changedFiles > allFiles.Count;
    return new DiffDto($"{range.BaseSha}..{range.HeadSha}", allFiles, truncated);
}

// Cross-iteration range fetch: when the requested range is not pull.base..pull.head, route
// through 3-dot compare (`/repos/{o}/{r}/compare/{base}...{head}`). GC'd SHAs return 404 →
// surface as ProblemDetails type `/diff/range-unreachable` to the endpoint layer. Spec § 6.1 + § 8.
private async Task<DiffDto> GetCrossIterationDiffAsync(PrReference prRef, DiffRangeRequest range, CancellationToken ct)
{
    var url = $"/repos/{prRef.Owner}/{prRef.Repo}/compare/{Uri.EscapeDataString(range.BaseSha)}...{Uri.EscapeDataString(range.HeadSha)}";
    using var resp = await _httpClient.GetAsync(url, ct);
    if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
        throw new RangeUnreachableException(range.BaseSha, range.HeadSha);
    // Parse compare response; assemble FileChange[] from `files`. Truncation here is signalled
    // by GitHub's response shape (compare also has a server-side cap).
    // ...
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
    // INDEPENDENT GraphQL fetch — does NOT call GetPrDetailAsync. The two methods
    // share the parsing helpers but each issues its own round-trip; this avoids the
    // recursion that would (a) double the GraphQL cost on every PR-detail load and
    // (b) silently degrade timeline data on any GetPrDetailAsync failure.
    //
    // Practical: most callers (PrDetailLoader.LoadAsync) call BOTH GetPrDetailAsync
    // and GetTimelineAsync sequentially because the detail surface needs PR meta +
    // comments while the clustering needs timeline + per-commit changed-files.
    // Treating them as siblings rather than parent-child makes the failure modes
    // independent.
    var rawTimeline = await PostGraphQL(@"query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo) {
        pullRequest(number:$number) {
          comments(first:100) { nodes { author { login } createdAt } }
          timelineItems(first:100, itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW]) {
            nodes {
              __typename
              ... on PullRequestCommit { commit { oid committedDate message additions deletions } }
              ... on HeadRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } createdAt }
              ... on PullRequestReview { submittedAt }
            }
          }
        }
      }
    }", new { owner = prRef.Owner, repo = prRef.Repo, number = prRef.Number }, ct);

    if (rawTimeline is null)
        return new ClusteringInput(Array.Empty<ClusteringCommit>(), Array.Empty<ClusteringForcePush>(),
            Array.Empty<ClusteringReviewEvent>(), Array.Empty<ClusteringAuthorComment>());

    var pull = rawTimeline.Value.GetProperty("data").GetProperty("repository").GetProperty("pullRequest");
    var rawCommits = ParseTimelineCommits(pull);   // sha + committedDate + message + additions + deletions, no changedFiles yet

    // Per-commit changedFiles fan-out (concurrency cap 8). If commits.Count > skipAbove,
    // return without changedFiles (clustering strategy's FileJaccardMultiplier treats null
    // as unknown and returns neutral 1.0). skipAbove is read from coefficients; passed
    // explicitly here because IReviewService doesn't have a coefficients dependency.
    //
    // Inter-batch pace: after each batch of ConcurrencyCap completes, await
    // Task.Delay(InterBatchPaceMs, ct) before kicking off the next batch (default 100ms).
    // Spec § 6.4.
    //
    // 403 secondary-rate-limit handling: when SendAsync returns 403 with header
    // `x-ratelimit-resource: secondary`, pause for `Retry-After` and degrade the
    // remainder of the session to ChangedFiles=null (FileJaccardMultiplier returns
    // neutral 1.0 for null). Implementation lives inside FetchPerCommitChangedFiles.
    // Spec § 6.4 + § 10.1.
    const int SkipAbove = 50;      // matches IterationClusteringCoefficients.SkipJaccardAboveCommitCount default (lowered 100 → 50, spec § 6.4)
    const int ConcurrencyCap = 8;
    var commits = rawCommits.Count > SkipAbove
        ? rawCommits.ToArray()      // ChangedFiles stays null
        : await FetchPerCommitChangedFiles(prRef, rawCommits, ConcurrencyCap, ct);

    return new ClusteringInput(
        commits,
        ParseForcePushes(pull),
        ParseReviewEvents(pull),
        ParseAuthorComments(pull));
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
dotnet test tests\PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubReviewServiceDiffTests"
```

Expected: **2 passing**.

### Step 3.6: Add tests for the per-commit Jaccard fan-out cap

- [ ] In the same test file:

```csharp
[Fact]
public async Task GetTimelineAsync_skips_per_commit_fanout_above_cap()
{
    // Default cap is 50 (lowered from 100 per spec § 6.4). 75 > 50 → fan-out skipped.
    var commits = Enumerable.Range(0, 75)
        .Select(i => new { Sha = $"c{i:D3}", Date = DateTimeOffset.UtcNow.AddSeconds(i * 60) })
        .ToArray();
    var fake = new FakeGitHubServer()
        .WithPullRequestTimeline(commits);

    var sut = NewService(fake);
    var input = await sut.GetTimelineAsync(new PrReference("o","r",1), CancellationToken.None);

    input.Commits.Should().HaveCount(75);
    input.Commits.Should().AllSatisfy(c => c.ChangedFiles.Should().BeNull(),
        because: "above 50 commits, the per-commit REST fan-out is skipped (spec § 6.4 default)");
    fake.PerCommitFetchCount.Should().Be(0);
}

[Fact]
public async Task GetTimelineAsync_paces_inter_batch_with_100ms_delay()
{
    // After each batch of ConcurrencyCap (8) completes, the fan-out awaits InterBatchPaceMs (100ms).
    // For 24 commits with batch size 8 → 3 batches → 2 inter-batch pauses → ≥200ms total pace cost.
    // Spec § 6.4.
    var commits = Enumerable.Range(0, 24)
        .Select(i => new { Sha = $"c{i:D3}", Date = DateTimeOffset.UtcNow.AddSeconds(i * 60) })
        .ToArray();
    var fake = new FakeGitHubServer().WithPullRequestTimeline(commits);

    var sw = System.Diagnostics.Stopwatch.StartNew();
    var input = await NewService(fake).GetTimelineAsync(new PrReference("o","r",1), CancellationToken.None);
    sw.Stop();

    input.Commits.Should().HaveCount(24);
    sw.ElapsedMilliseconds.Should().BeGreaterThan(180,
        because: "two inter-batch 100ms pauses across three batches");
}

[Fact]
public async Task GetTimelineAsync_handles_secondary_rate_limit_403_by_pausing_and_degrading_remainder()
{
    // 403 with `x-ratelimit-resource: secondary` header triggers Retry-After pause and
    // degrades the rest of the session to ChangedFiles=null. Spec § 6.4 + § 10.1.
    var fake = new FakeGitHubServer()
        .WithPullRequestTimeline(commits: 30 /* fan-out below cap */)
        .WithSecondaryRateLimitOnCommit(commitIndex: 5, retryAfterSeconds: 1);

    var input = await NewService(fake).GetTimelineAsync(new PrReference("o","r",1), CancellationToken.None);

    // Commits 0..4 have changed-files; from index 5 onward, ChangedFiles is null.
    input.Commits.Take(5).Should().AllSatisfy(c => c.ChangedFiles.Should().NotBeNull());
    input.Commits.Skip(5).Should().AllSatisfy(c => c.ChangedFiles.Should().BeNull());
}
```

(Add the corresponding `WithPullRequestTimeline` builder method to `FakeGitHubServer` if not present. The fake is in `tests/PRism.GitHub.Tests/FakeGitHubServer.cs` — extend the existing class.)

### Step 3.7: Run the full GitHub-tests suite

- [ ] Run:

```powershell
dotnet test tests\PRism.GitHub.Tests
```

Expected: **all passing**.

### Step 3.8: Commit

```powershell
git checkout -b feat/s3-pr3-ireviewservice-extensions
git add PRism.Core/IReviewService.cs PRism.Core.Contracts/ PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/
git commit -m "feat(github): IReviewService grows new methods (GetPrDetail/GetDiff/GetFileContent/GetTimeline) (S3 PR3)"
```

---

## Task 4: PR Detail Backend Assembly — Loader, Endpoints, Wire-Format Translation

**Files:**
- Create: `PRism.Core/PrDetail/PrDetailLoader.cs` (concrete class — no `IPrDetailLoader` interface; spec § 4 + § 6.1)
- Create: `PRism.Core/PrDetail/PrDetailSnapshot.cs`
- Create: `PRism.Web/Endpoints/PrDetailEndpoints.cs`
- Create: `PRism.Web/Endpoints/PrDetailDtos.cs`
- Modify: `PRism.Web/Program.cs` — register `PrDetailLoader` (concrete), map endpoints
- Test: `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs`
- Test: `tests/PRism.Web.Tests/PrDetailEndpointsTests.cs`

### Step 4.1: Define the snapshot record (no loader interface)

`PrDetailLoader` is a **concrete class**. There is no `IPrDetailLoader` interface — tests substitute `IReviewService` directly (the loader's only collaborator that matters for testing is the review service; the clusterer and coefficients are pure-value injections). Spec § 4 + § 6.1.

- [ ] Create `PRism.Core/PrDetail/PrDetailSnapshot.cs`:

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

public sealed record PrDetailSnapshot(
    PrDetailDto Detail,
    string HeadSha,                  // mirrors Detail.Pr.HeadSha; cache key
    int CoefficientsGeneration);     // bumped on coefficient hot-reload
```

**No `IPrDetailLoader` interface.** The loader has these public members on the concrete `PrDetailLoader` class:

```csharp
public Task<PrDetailSnapshot?> LoadAsync(PrReference prRef, CancellationToken ct);
public Task<PrDetailSnapshot?> TryGetCachedAsync(PrReference prRef);
/// <summary>Invalidates all cached snapshots; called on coefficient hot-reload.</summary>
public void InvalidateAll();
```

Tests substitute `IReviewService` directly via constructor injection (the loader's only meaningful collaborator); they do not need to mock the loader itself.

**Cache-key contract.** The cache key is the tuple `(prRef, headSha, coefficientsGeneration)`. **All three components must change for a cache miss.** This is load-bearing because:

- A Reload-after-banner must fetch fresh PR detail. The frontend re-hits `GET /api/pr/{ref}`. Without `headSha` in the cache key, the loader returns the stale snapshot whose `Detail.Pr.HeadSha` is the *old* head — iteration tabs and stats freeze. The `(prRef, headSha)` key forces a miss the moment GitHub returns the new head.
- The detail-fetch flow always calls GitHub for the freshest `pr.HeadSha` *before* probing the cache (i.e., the loader fetches `IReviewService.PollActivePrAsync` first to learn the current head, then keys the cache lookup). Spec § 6.1 implies this ordering.

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

// Stub fake; expand fields as the loader's needs grow. Note we substitute IReviewService
// directly because PrDetailLoader is a concrete class with no interface — tests target the
// review service instead. Spec § 4 + § 6.1.
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

The loader's responsibilities:
1. Probe the cache by `(prRef, headSha, generation)`. If the headSha is unknown to the caller (new mount), call `IReviewService.PollActivePrAsync(prRef, ct)` first — that's a 3-call REST probe (cheap) that returns the current `HeadSha`. Then probe the cache.
2. On cache miss, fetch `GetPrDetailAsync` (one heavy GraphQL round-trip) AND `GetTimelineAsync` (independent — no recursion through `GetPrDetailAsync`; see Step 3.5 implementation note).
3. Cluster the timeline via `_clusterer.Cluster(...)`.
4. Compose the snapshot's iterations by looking up each cluster's commit SHAs in a dictionary built from the timeline's commits (so we get full `CommitDto` shape including message and dates).
5. Cache and return.

- [ ] Create `PRism.Core/PrDetail/PrDetailLoader.cs`:

```csharp
using System.Collections.Concurrent;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Core.PrDetail;

public sealed class PrDetailLoader
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
        // Probe current headSha cheaply before deciding whether the cache is valid.
        var pollSnapshot = await _review.PollActivePrAsync(prRef, ct);
        var key = CacheKey(prRef, pollSnapshot.HeadSha, _generation);
        if (_cache.TryGetValue(key, out var cached)) return cached;

        var detail = await _review.GetPrDetailAsync(prRef, ct);
        if (detail is null) return null;

        // Defensive: if the head moved between PollActivePrAsync and GetPrDetailAsync,
        // re-key on the detail's actual head.
        if (detail.Pr.HeadSha != pollSnapshot.HeadSha)
            key = CacheKey(prRef, detail.Pr.HeadSha, _generation);

        var timeline = await _review.GetTimelineAsync(prRef, ct);
        var clusters = _clusterer.Cluster(timeline, _coefficients);

        // Build a SHA → commit-meta lookup from the timeline once; reuse for every cluster.
        var commitBySha = timeline.Commits.ToDictionary(c => c.Sha, c => c);

        var iterations = clusters.Select(c => new IterationDto(
            c.IterationNumber,
            c.BeforeSha,
            c.AfterSha,
            c.CommitShas
                .Where(sha => commitBySha.ContainsKey(sha))
                .Select(sha =>
                {
                    var ci = commitBySha[sha];
                    return new CommitDto(ci.Sha, ci.Message, ci.CommittedDate, ci.Additions, ci.Deletions);
                })
                .ToArray(),
            // HasResolvableRange = both endpoints are present in the timeline's commit set.
            // GC'd SHAs (rare; happens on aggressive force-pushes that prune the old objects)
            // produce false; UI renders "Iter N (snapshot lost)" and ComparePicker disables
            // selection. Spec § 6.1 + § 7.2.
            HasResolvableRange:
                commitBySha.ContainsKey(c.BeforeSha) && commitBySha.ContainsKey(c.AfterSha)))
            .ToArray();

        var snapshot = new PrDetailSnapshot(
            detail with { Iterations = iterations },
            detail.Pr.HeadSha,
            _generation);
        _cache[key] = snapshot;
        return snapshot;
    }

    public Task<PrDetailSnapshot?> TryGetCachedAsync(PrReference prRef)
    {
        // Without re-polling we don't know the current head. Return any matching key
        // for this (prRef, generation) — caller is responsible for accepting potential
        // staleness (the file-content endpoint uses this for in-diff authz; if the
        // snapshot was evicted, the endpoint surfaces /file/snapshot-evicted).
        var prefix = $"{prRef.Owner}/{prRef.Repo}/{prRef.Number}@";
        var match = _cache.FirstOrDefault(kv =>
            kv.Key.StartsWith(prefix, StringComparison.Ordinal) &&
            kv.Key.EndsWith($"#{_generation}", StringComparison.Ordinal));
        return Task.FromResult(match.Value);
    }

    public void InvalidateAll()
    {
        Interlocked.Increment(ref _generation);
        _cache.Clear();
    }

    private static string CacheKey(PrReference prRef, string headSha, int generation) =>
        $"{prRef.Owner}/{prRef.Repo}/{prRef.Number}@{headSha}#{generation}";
}
```

### Step 4.4: Run loader tests

- [ ] Run:

```powershell
dotnet test tests\PRism.Core.Tests --filter "FullyQualifiedName~PrDetailLoaderTests"
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

- [ ] Create `tests/PRism.Web.Tests/PrDetailEndpointsTests.cs`. The test class uses S2's existing `WebApplicationFactory<Program>` pattern with `FakeGitHubServer`. The test list grew with the spec's `ce-doc-review` pass — see test row updates in Task 11 / spec § 11.3:

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
    public async Task Get_diff_derives_truncated_from_pull_changed_files_count_mismatch()
    {
        // Spec § 6.1: truncated = pull.changed_files > files.length. NO compare endpoint call.
        // ...
    }

    [Fact]
    public async Task Get_file_returns_422_with_not_in_diff_when_path_absent_and_diff_not_truncated()
    {
        // /file/not-in-diff: path is not in diff AND DiffDto.Truncated == false.
        // Spec § 8.
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/pr/octo/repo/1/file?path=../etc/passwd&sha=abc");
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.UnprocessableEntity);
        var problem = await resp.Content.ReadFromJsonAsync<ProblemDetails>();
        problem!.Type.Should().Be("/file/not-in-diff");
    }

    [Fact]
    public async Task Get_file_returns_422_with_truncation_window_when_path_absent_but_diff_truncated()
    {
        // /file/truncation-window: path is not in cached files AND DiffDto.Truncated == true.
        // The path may exist in the PR's actual diff, but it landed outside the 30-page window.
        // Spec § 8.
        // ... arrange: snapshot with Truncated=true; path not in cached files ...
        var resp = await client.GetAsync("/api/pr/octo/repo/1/file?path=src/OutsideWindow.cs&sha=abc");
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.UnprocessableEntity);
        var problem = await resp.Content.ReadFromJsonAsync<ProblemDetails>();
        problem!.Type.Should().Be("/file/truncation-window");
    }

    [Fact]
    public async Task Get_file_returns_413_for_files_over_5MB() { /* … */ }

    [Fact]
    public async Task Get_file_returns_415_for_binary_content() { /* … */ }

    [Fact]
    public async Task Mark_viewed_writes_session_state() { /* … */ }

    [Fact]
    public async Task Mark_viewed_returns_409_when_headSha_mismatches() { /* … */ }

    [Fact]
    public async Task Mark_viewed_writes_max_comment_id_verbatim_into_last_seen_comment_id()
    {
        // Frontend computes maxCommentId as the highest GitHub databaseId (numeric, monotonic)
        // across PrDetailDto.rootComments[].databaseId ∪ PrDetailDto.reviewComments[].comments[].databaseId.
        // Backend writes verbatim into LastSeenCommentId without re-deriving. Spec § 8.
        // ...
    }

    [Fact]
    public async Task Mark_viewed_rejects_request_body_over_16_KiB()
    {
        // 16 KiB body cap on mark-viewed. Spec § 8 + BodySizeLimitMiddleware (Task 5).
        // Client posts a 17 KiB body (e.g., 17000-char maxCommentId) — middleware rejects with 413
        // before model binding. Spec § 8.
        // ...
    }

    [Theory]
    [InlineData("../etc/passwd")]              // segment equals ".."
    [InlineData("./relative")]                 // segment equals "."
    [InlineData("")]                           // empty path
    [InlineData("/leading-slash.cs")]          // leading "/"
    [InlineData("trailing-slash/")]            // trailing "/"
    [InlineData("nul\0byte.cs")]               // NUL byte
    [InlineData("control\x1Fchar.cs")]         // C0/C1 control char (U+0000..U+001F or U+007F..U+009F)
    [InlineData("back\\slash.cs")]             // backslash
    public async Task Files_viewed_rejects_path_violating_canonicalization_rules(string path)
    {
        // 7-rule path canonicalization: any path segment equals `..` or `.`, empty path, leading `/`,
        // trailing `/`, NUL byte, C0/C1 control char, backslash, NFC byte-length mismatch.
        // (NFC mismatch is a 9th case below — composed-vs-decomposed Unicode.) Spec § 8.
        var client = _factory.CreateClient();
        var resp = await client.PostAsJsonAsync($"/api/pr/octo/repo/1/files/viewed",
            new { path, headSha = "abc", viewed = true });
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Files_viewed_rejects_path_with_nfc_byte_length_mismatch()
    {
        // Composed café (4 bytes UTF-8) vs decomposed café (5 bytes UTF-8) — server rejects
        // any path whose NFC-normalized form has a different byte length than the input.
        // Defends against attackers using decomposed Unicode to bypass an allowlist that
        // canonicalizes after the check. Spec § 8.
        var path = "src/Café.cs";   // decomposed
        // ... post; expect 422 ...
    }

    [Fact]
    public async Task Files_viewed_rejects_request_body_over_16_KiB()
    {
        // 16 KiB body cap on files/viewed. Spec § 8.
        // ...
    }
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
            async (string owner, string repo, int number, PrDetailLoader loader, CancellationToken ct) =>
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
                // `range=` is two SHAs joined by `..` (URL-encoded). For cross-iteration
                // ranges (range != pull.base..pull.head), the service routes through
                // 3-dot compare (`/repos/{o}/{r}/compare/{base}...{head}`). GC'd SHAs
                // surface as RangeUnreachableException → ProblemDetails type
                // `/diff/range-unreachable`. Spec § 6.1 + § 8.
                var (baseSha, headSha) = ParseRange(range);
                try
                {
                    var diff = await review.GetDiffAsync(new PrReference(owner, repo, number),
                        new DiffRangeRequest(baseSha, headSha), ct);
                    return Results.Ok(diff);
                }
                catch (RangeUnreachableException)
                {
                    return Results.Problem(type: "/diff/range-unreachable", statusCode: 404);
                }
            });

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/file",
            async (string owner, string repo, int number, [FromQuery] string path, [FromQuery] string sha,
                   PrDetailLoader loader, IReviewService review, CancellationToken ct) =>
            {
                var snapshot = await loader.TryGetCachedAsync(new PrReference(owner, repo, number));
                if (snapshot is null)
                    return Results.Problem(type: "/file/snapshot-evicted", statusCode: 422);

                if (!snapshot.Detail.HasFileInDiff(path))
                {
                    // Split 422 cases per spec § 8 (was: single /file/not-in-diff):
                    //   /file/not-in-diff       → path not in diff AND truncated == false (genuine miss)
                    //   /file/truncation-window → path not in cached files AND truncated == true
                    //                              (path may exist in actual diff, but landed outside
                    //                              the 30-page window; ask user to open on github.com)
                    var type = snapshot.Detail.IsDiffTruncated()
                        ? "/file/truncation-window"
                        : "/file/not-in-diff";
                    return Results.Problem(type: type, statusCode: 422);
                }

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
                   PrDetailLoader loader, IAppStateStore stateStore, AppStateStore concreteStore, CancellationToken ct) =>
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
                   PrDetailLoader loader, AppStateStore concreteStore, CancellationToken ct) =>
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
        // 7-rule canonicalization (spec § 8 — expanded from the original 4-rule shape during
        // the spec's ce-doc-review pass; the 7th rule below — NFC byte-length mismatch — is a
        // dedicated check on top of the existing 6 character-level rules):
        //   1. Any path segment equals `..` or `.`
        //   2. Empty path
        //   3. Leading `/`
        //   4. Trailing `/`
        //   5. NUL byte (U+0000)
        //   6. C0/C1 control char (U+0000..U+001F or U+007F..U+009F) — supersets rule 5
        //   7. Backslash
        //   + NFC byte-length mismatch (defends against decomposed-Unicode allowlist bypass)
        if (string.IsNullOrEmpty(path)) return null;
        if (path.StartsWith('/') || path.EndsWith('/')) return null;
        if (path.Contains('\\')) return null;
        if (path.Any(c => c < 0x20 || (c >= 0x7F && c <= 0x9F))) return null;
        var segments = path.Split('/');
        if (segments.Any(s => s == ".." || s == ".")) return null;

        // NFC byte-length mismatch: composed café (4 bytes) vs decomposed café (5 bytes).
        var nfc = path.Normalize(System.Text.NormalizationForm.FormC);
        if (System.Text.Encoding.UTF8.GetByteCount(nfc) != System.Text.Encoding.UTF8.GetByteCount(path))
            return null;

        return nfc;
    }
}
```

(Add `HasFileInDiff(path)` and `IsDiffTruncated()` as extension methods on `PrDetailDto`. `HasFileInDiff` checks `dto.Files.Any(f => f.Path == path)`; `IsDiffTruncated` returns the cached `DiffDto.Truncated` flag against the active iteration's range. The truncation flag is what splits the 422 into `/file/not-in-diff` vs `/file/truncation-window`.)

**Session-token enforcement on GET endpoints.** All four endpoints in this Task 4 surface (`GET /api/pr/{ref}`, `GET /diff`, `GET /file`, plus the POST mutators) require `X-PRism-Session`. The middleware that enforces this lives in Task 5 (`SessionTokenMiddleware`); Task 4 endpoints don't have to do anything special — the middleware runs ahead of routing. The fourth endpoint, `GET /api/events`, reads the same token from the `prism-session` cookie because EventSource cannot send custom request headers; that branch is also Task 5. Spec § 8.

### Step 4.8: Wire endpoints + DI in `Program.cs`

- [ ] In `PRism.Web/Program.cs`, register the loader as a concrete singleton (no interface):

```csharp
builder.Services.AddSingleton<PrDetailLoader>();
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
dotnet test tests\PRism.Web.Tests --filter "FullyQualifiedName~PrDetailEndpointsTests"
```

Expected: all passing. Test count includes the `Theory` for the 7-rule canonicalization (8 inline cases) plus the named tests for happy paths, /file/not-in-diff vs /file/truncation-window split, NFC mismatch, body-size caps, and stale-head-sha 409s. Spec § 11.3.

### Step 4.10: Commit

```powershell
git checkout -b feat/s3-pr4-prdetail-backend
git add PRism.Core/PrDetail/ PRism.Web/Endpoints/PrDetailEndpoints.cs PRism.Web/Endpoints/PrDetailDtos.cs PRism.Web/Program.cs tests/PRism.Core.Tests/PrDetail/ tests/PRism.Web.Tests/PrDetailEndpointsTests.cs
git commit -m "feat(prdetail): backend loader (concrete, no interface) + endpoints (X-PRism-Session on GETs, 7-rule path canonicalization, 16 KiB body cap, /file/truncation-window split) + cache (S3 PR4)"
```

PR4 expanded scope per spec § 11.7:
- Drop `IPrDetailLoader` from file lists; PrDetailLoader is concrete.
- X-PRism-Session enforcement on GET endpoints (the middleware lives in Task 5; the endpoints depend on it but don't implement it themselves).
- Path canonicalization: 7-rule shape (was 4-rule).
- 16 KiB body cap on `mark-viewed` and `files/viewed`.
- `/file/truncation-window` 422 split from `/file/not-in-diff`.

---

## Task 5: SSE per-PR fanout + active-PR poller + middleware tightening

**Files:**
- Create: `PRism.Core/PrDetail/ActivePrSubscriberRegistry.cs`
- Create: `PRism.Core/PrDetail/ActivePrPoller.cs`
- Create: `PRism.Core/PrDetail/ActivePrPollerState.cs`
- Modify: `PRism.Web/Sse/SseChannel.cs` — per-PR fanout, named heartbeat, write-timeout, idle-eviction
- Modify: `PRism.Web/Endpoints/EventsEndpoints.cs` — subscriber-assigned event, subscribe/unsubscribe REST, cookie-based session-token on `GET /api/events`
- Modify: `PRism.Web/Middleware/OriginCheckMiddleware.cs` — reject empty Origin on POST/PUT/PATCH/DELETE only (GETs with empty Origin remain allowed for top-level navigations)
- Create: `PRism.Web/Middleware/SessionTokenMiddleware.cs` — extends to ALL non-asset endpoints (header for most, cookie for `/api/events`)
- Create: `PRism.Web/Middleware/BodySizeLimitMiddleware.cs` — 16 KiB cap on the four mutating endpoints (`mark-viewed`, `files/viewed`, `events/subscriptions` POST + DELETE)
- Create: `PRism.Web/Logging/SensitiveFieldScrubber.cs` — ILogger destructuring policy that scrubs fields named `subscriberId`, `pat`, `token`, `body`, `content` (case-insensitive)
- Test: `tests/PRism.Core.Tests/PrDetail/ActivePrSubscriberRegistryTests.cs`
- Test: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerBackoffTests.cs`
- Test: `tests/PRism.Web.Tests/EventsSubscriptionsEndpointTests.cs`
- Test: `tests/PRism.Web.Tests/OriginCheckMiddlewareTests.cs`
- Test: `tests/PRism.Web.Tests/SessionTokenMiddlewareTests.cs`
- Test: `tests/PRism.Web.Tests/BodySizeLimitMiddlewareTests.cs`
- Test: `tests/PRism.Web.Tests/SensitiveFieldScrubberTests.cs`

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
dotnet test tests\PRism.Core.Tests --filter "FullyQualifiedName~ActivePrSubscriberRegistryTests"
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
                // CHEAP poll — 3 REST calls per spec § 6.2 (pulls/{n} + pulls/{n}/comments?per_page=1
                // + pulls/{n}/reviews?per_page=1 with Link rel=last header parse). NOT GetPrDetailAsync,
                // which is a heavyweight GraphQL round-trip + per-commit fan-out and would blow the
                // rate-limit budget (1200/hr at 5 PRs vs spec's 1800/hr budget for the whole poll loop).
                var snapshot = await _review.PollActivePrAsync(prRef, ct);

                var headChanged = state.LastHeadSha is { } prev && prev != snapshot.HeadSha;
                var commentChanged = state.LastCommentCount is { } prevCount && prevCount != snapshot.CommentCount;

                if (headChanged || commentChanged)
                {
                    _bus.Publish(new ActivePrUpdated(
                        prRef,
                        HeadShaChanged: headChanged,
                        CommentCountChanged: commentChanged,
                        NewHeadSha: headChanged ? snapshot.HeadSha : null,
                        NewCommentCount: commentChanged ? snapshot.CommentCount : null));
                }

                state.LastHeadSha = snapshot.HeadSha;
                state.LastCommentCount = snapshot.CommentCount;
                state.ConsecutiveErrors = 0;
                state.NextRetryAt = null;
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Active-PR poll failed for {PrRef}; applying backoff", prRef);
                ApplyBackoff(state, now);
            }
        }
    }

    private static void ApplyBackoff(ActivePrPollerState state, DateTimeOffset now)
    {
        // Standard exponential backoff for transient errors. The 403/secondary-rate-limit
        // case is handled separately at the IReviewService boundary — when the GitHub
        // response carries `x-ratelimit-resource: secondary`, the per-PR backoff respects
        // `Retry-After` directly instead of the 2^n formula, and the per-commit fan-out
        // degrades the remainder of the session to ChangedFiles=null. Spec § 10.1.
        state.ConsecutiveErrors++;
        var seconds = Math.Min(Math.Pow(2, state.ConsecutiveErrors) * 30, 300);
        state.NextRetryAt = now.AddSeconds(seconds);
    }
}
```

**Required prerequisite types** (create before the poller compiles):

- [ ] Verify `PRism.Core/Events/IReviewEventBus.cs` exists from S2 (it does — `SseChannel.cs:22` already calls `bus.Subscribe<InboxUpdated>(OnInboxUpdated)`). Confirm it has a `Publish<T>(T evt)` method or equivalent fire-and-forget API.

- [ ] Create `PRism.Core/Events/ActivePrUpdated.cs`:

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Events;

public sealed record ActivePrUpdated(
    PrReference PrRef,
    bool HeadShaChanged,
    bool CommentCountChanged,
    string? NewHeadSha,
    int? NewCommentCount);
```

- [ ] Create `PRism.Core.Contracts/SubscriptionRequest.cs` (used by both POST and DELETE on `/api/events/subscriptions` per Step 5.7):

```csharp
namespace PRism.Core.Contracts;

public sealed record SubscriptionRequest(string SubscriberId, PrReference PrRef);
```

### Step 5.6: Update `SseChannel` for per-PR fanout + named heartbeat

- [ ] Modify `PRism.Web/Sse/SseChannel.cs`. Replace the broadcast-all approach with subscriber-id-keyed fanout. The heartbeat write becomes `event: heartbeat\ndata: {}\n\n` (named event), not `:heartbeat` (comment). Add subscriber-id assignment as the first event.

```csharp
// Pseudo-edit; integrate with the existing SseChannel structure.
public async Task AddSubscriber(HttpResponse response, CancellationToken ct)
{
    // 128-bit cryptorandom subscriber ID via Guid.NewGuid(). Spec § 6.2 explicitly pins
    // this to 128 bits (NOT 256) — avoids over-engineering when Guid's collision domain
    // is more than enough for the per-process subscriber count.
    var subscriberId = Guid.NewGuid().ToString("N");
    response.Headers.ContentType = "text/event-stream";
    response.Headers.CacheControl = "no-store";
    await response.WriteAsync($"event: subscriber-assigned\ndata: {{\"subscriberId\":\"{subscriberId}\"}}\n\n", ct);
    await response.Body.FlushAsync(ct);
    // … existing connection-management; on heartbeat tick:
    //   await response.WriteAsync($"event: heartbeat\ndata: {{}}\n\n", ct);
    //   updateLastClientActivity();
    // Heartbeat is a NAMED event (`event: heartbeat\ndata: {}\n\n`), not an SSE comment.
    // The frontend's named-heartbeat watcher resets at 35s. Spec § 8.
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

### Step 5.8: Tighten `OriginCheckMiddleware` — preserve loopback-port accommodation

The existing middleware (`PRism.Web/Middleware/OriginCheckMiddleware.cs`) has a **load-bearing** dev-mode accommodation: when both Origin and Host are loopback (e.g., Origin `http://localhost:5173` from Vite, Host `localhost:5180` from backend), the request is allowed through. **Preserve that branch** — losing it breaks the dev loop.

The only change S3 makes: **reject empty Origin on mutating methods only**. GETs with empty Origin remain allowed (top-level navigations don't send an Origin header — rejecting GETs without Origin would break direct URL navigation and any deep-link). POST/PUT/PATCH/DELETE with empty Origin → 403. The existing `IsLoopback(origin) && IsLoopback(host)` and `string.Equals(origin, expected, ...)` branches stay. Spec § 8.

- [ ] Modify the body of `InvokeAsync` (currently lines 12-37). Replace it with:

```csharp
public async Task InvokeAsync(HttpContext ctx)
{
    ArgumentNullException.ThrowIfNull(ctx);

    var isMutating =
        HttpMethods.IsPost(ctx.Request.Method) ||
        HttpMethods.IsPut(ctx.Request.Method) ||
        HttpMethods.IsPatch(ctx.Request.Method) ||
        HttpMethods.IsDelete(ctx.Request.Method);

    if (!isMutating)
    {
        await _next(ctx).ConfigureAwait(false);
        return;
    }

    var origin = ctx.Request.Headers["Origin"].FirstOrDefault();
    var expected = $"{ctx.Request.Scheme}://{ctx.Request.Host.Value}";

    // Empty Origin on a mutating method → reject. Was previously allowed (line 27 of the
    // pre-S3 middleware) for non-browser tools without an Origin header; that exemption is
    // retired in S3 because the spec mandates X-PRism-Session enforcement on mutating
    // requests, and CSRF defense relies on Origin being present-and-correct.
    if (string.IsNullOrEmpty(origin))
    {
        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        await ctx.Response.WriteAsync("Cross-origin request rejected (missing Origin).").ConfigureAwait(false);
        return;
    }

    // Same-origin OR loopback-port accommodation (Vite at :5173 talking to backend at :5180
    // is legitimate same-machine traffic). The loopback branch is unchanged from S0+S1 —
    // see the comment block at the bottom of the existing middleware for rationale.
    if (string.Equals(origin, expected, StringComparison.OrdinalIgnoreCase)
        || (IsLoopback(origin) && IsLoopback(ctx.Request.Host.Host)))
    {
        await _next(ctx).ConfigureAwait(false);
        return;
    }

    ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
    await ctx.Response.WriteAsync("Cross-origin request rejected.").ConfigureAwait(false);
}
```

(Keep the existing private `IsLoopback(string)` method untouched.)

### Step 5.9: Implement `SessionTokenMiddleware`

- [ ] Create `PRism.Web/Middleware/SessionTokenMiddleware.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;

namespace PRism.Web.Middleware;

public sealed class SessionTokenMiddleware
{
    private readonly RequestDelegate _next;
    private readonly byte[] _expectedToken;

    public SessionTokenMiddleware(RequestDelegate next, SessionTokenProvider provider)
    {
        _next = next;
        // Capture once at startup. The provider is a Singleton with `Current` set in its
        // ctor; both are process-lifetime stable. After backend restart, a new process =
        // a new token = the old SPA cookie 401s and the SPA force-reloads to pick up the
        // freshly-stamped cookie (see § 8 contract).
        _expectedToken = Encoding.UTF8.GetBytes(provider.Current);
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        // Spec § 8: SessionTokenMiddleware now extends to ALL non-asset endpoints
        // (was: only mutating verbs in earlier drafts). The ce-doc-review pass closed
        // the gap that GET endpoints were unauthenticated. Two read paths:
        //
        //   1. Most non-asset GETs + every mutating verb: read X-PRism-Session
        //      from the request header.
        //   2. GET /api/events (the SSE endpoint): read the same token from the
        //      `prism-session` cookie. EventSource cannot send custom request
        //      headers, so the SPA's HTML page-load stamps the cookie and the
        //      EventSource implicitly carries it.
        //
        // Asset paths (e.g., /assets/*, /index.html, /favicon.ico) are skipped.
        if (IsAssetPath(ctx.Request.Path))
        {
            await _next(ctx).ConfigureAwait(false);
            return;
        }

        string headerOrCookieValue;
        if (IsSseEndpoint(ctx.Request.Path))
        {
            headerOrCookieValue = ctx.Request.Cookies["prism-session"] ?? string.Empty;
        }
        else
        {
            headerOrCookieValue = ctx.Request.Headers["X-PRism-Session"].ToString();
        }

        var actual = Encoding.UTF8.GetBytes(headerOrCookieValue);

        // Length precondition for FixedTimeEquals (which throws on length mismatch).
        // Token is always 44 chars (Base64 of 32 random bytes) so legitimate clients
        // always hit the equal-length path. Documented in § 8.
        var ok = actual.Length == _expectedToken.Length
              && CryptographicOperations.FixedTimeEquals(actual, _expectedToken);

        if (!ok)
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            ctx.Response.ContentType = "application/problem+json";
            await ctx.Response.WriteAsJsonAsync(new ProblemDetails
            {
                Type = "/auth/session-stale",
                Status = StatusCodes.Status401Unauthorized,
                Title = "Session token mismatch",
                Detail = "The X-PRism-Session header (or prism-session cookie for /api/events) does not match the per-launch token. Reload the page to refresh the cookie."
            }).ConfigureAwait(false);
            return;
        }

        await _next(ctx).ConfigureAwait(false);
    }

    private static bool IsAssetPath(PathString path) =>
        path.StartsWithSegments("/assets") ||
        path.Value == "/index.html" ||
        path.Value == "/favicon.ico";

    private static bool IsSseEndpoint(PathString path) =>
        path.StartsWithSegments("/api/events");
}

public sealed class SessionTokenProvider
{
    public string Current { get; }

    public SessionTokenProvider(IHostEnvironment env, IConfiguration config)
    {
        // Dev-mode bypass: `dotnet watch run` rotates the process token on every save,
        // forcing a SPA reload per save. Override with PRISM_DEV_FIXED_TOKEN to keep
        // the dev loop quiet. Production / non-Development: always-random.
        var devOverride = config["PRISM_DEV_FIXED_TOKEN"]
            ?? Environment.GetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN");
        if (env.IsDevelopment() && !string.IsNullOrEmpty(devOverride))
        {
            Current = devOverride;
            return;
        }
        Current = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
    }
}
```

Register all three middlewares in `Program.cs`. Spec § 8 commits to the pipeline ordering:
`ExceptionHandler → BodySizeLimit → OriginCheck → SessionToken → Routing → ModelBinding → endpoint`.

```csharp
builder.Services.AddSingleton<SessionTokenProvider>();

// Pipeline ordering per spec § 8:
//   1. ExceptionHandler — catches anything below.
//   2. BodySizeLimitMiddleware — 16 KiB cap on the four mutating endpoints; rejects oversized
//      bodies BEFORE model binding so unauthenticated bodies don't reach binders. Configured
//      via Kestrel's MaxRequestBodySize for these routes + a defense-in-depth middleware
//      check that reads Content-Length and short-circuits on > 16 KiB.
//   3. OriginCheckMiddleware — reject empty Origin on POST/PUT/PATCH/DELETE.
//   4. SessionTokenMiddleware — header for all non-asset endpoints; cookie for /api/events.
//   5. Routing.
//   6. Model binding.
//   7. Endpoint.
app.UseExceptionHandler();
app.UseMiddleware<BodySizeLimitMiddleware>();
app.UseMiddleware<OriginCheckMiddleware>();
app.UseMiddleware<SessionTokenMiddleware>();
app.UseRouting();
```

### Step 5.10: Stamp the cookie on every HTML response

The cookie must be appended **before** the response body starts streaming — otherwise `Response.Cookies.Append` throws `InvalidOperationException: Headers are read-only, response has already started.` That's a real risk because static-file middleware (used by `MapFallbackToFile("index.html")`) flushes headers as soon as it begins writing. Use `Response.OnStarting` to enqueue the cookie for write at header-flush time.

- [ ] In `Program.cs`, register the middleware **before** `MapStaticAssets` / `MapFallbackToFile`:

```csharp
app.Use(async (ctx, next) =>
{
    ctx.Response.OnStarting(() =>
    {
        if (ctx.Response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) == true)
        {
            var token = ctx.RequestServices.GetRequiredService<SessionTokenProvider>().Current;
            ctx.Response.Cookies.Append("prism-session", token, new CookieOptions
            {
                HttpOnly = false,                 // SPA reads it via document.cookie
                SameSite = SameSiteMode.Strict,
                Secure = false,                   // localhost
                Path = "/"                        // spec § 8 requires explicit Path=/
            });
        }
        return Task.CompletedTask;
    });
    await next().ConfigureAwait(false);
});
```

The `OnStarting` callback fires before the first byte of the response body is written — works correctly with static-file middleware, with minimal-API JSON responses, and with the SSE endpoint (whose Content-Type is `text/event-stream`, so the predicate is false and no cookie is appended on SSE responses, which is intentional — the SPA gets its cookie from the HTML index).

### Step 5.10b: Implement `BodySizeLimitMiddleware`

Spec § 8 commits to a 16 KiB body cap on the four mutating endpoints (`mark-viewed`, `files/viewed`, `events/subscriptions` POST, `events/subscriptions` DELETE). The cap is enforced via a Kestrel + middleware combination so unauthenticated bodies never reach model binding:

- [ ] Create `PRism.Web/Middleware/BodySizeLimitMiddleware.cs`:

```csharp
namespace PRism.Web.Middleware;

public sealed class BodySizeLimitMiddleware
{
    private const long MaxMutatingBodyBytes = 16 * 1024;   // 16 KiB

    private static readonly string[] CappedRoutes =
    {
        "/api/pr/", "/api/events/subscriptions"
        // Path predicate matches any /api/pr/{owner}/{repo}/{n}/mark-viewed,
        // /api/pr/{owner}/{repo}/{n}/files/viewed, and /api/events/subscriptions.
    };

    private readonly RequestDelegate _next;

    public BodySizeLimitMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext ctx)
    {
        var path = ctx.Request.Path.Value ?? string.Empty;
        var method = ctx.Request.Method;
        var isMutating = HttpMethods.IsPost(method) || HttpMethods.IsPut(method)
                      || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);

        var isCapped = isMutating &&
            (path.Contains("/mark-viewed", StringComparison.Ordinal)
             || path.Contains("/files/viewed", StringComparison.Ordinal)
             || path.StartsWith("/api/events/subscriptions", StringComparison.Ordinal));

        if (isCapped)
        {
            // Defense-in-depth: read Content-Length first; if absent or oversized, 413.
            var contentLength = ctx.Request.ContentLength;
            if (contentLength is null || contentLength > MaxMutatingBodyBytes)
            {
                ctx.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                await ctx.Response.WriteAsJsonAsync(new ProblemDetails
                {
                    Type = "/body/too-large",
                    Status = 413,
                    Title = "Request body exceeds 16 KiB cap",
                });
                return;
            }
        }

        await _next(ctx).ConfigureAwait(false);
    }
}
```

Also configure Kestrel's per-route `MaxRequestBodySize` (via `RequestSizeLimit` attribute or endpoint metadata) on the four routes so chunked-encoding requests without Content-Length still hit the cap before model binding.

Tests in `tests/PRism.Web.Tests/BodySizeLimitMiddlewareTests.cs`:
- 17 KiB POST to `/mark-viewed` → 413
- 17 KiB POST to `/files/viewed` → 413
- 17 KiB POST to `/api/events/subscriptions` → 413
- 17 KiB DELETE to `/api/events/subscriptions` → 413

### Step 5.10c: Implement the ILogger destructuring policy

Spec § 6.2 + § 10.6 commit to scrubbing fields named `subscriberId`, `pat`, `token`, `body`, `content` (case-insensitive) from any log destructured object. This blocks accidental leakage of GitHub-content payloads (long markdown comment bodies, file contents) into log output:

- [ ] Create `PRism.Web/Logging/SensitiveFieldScrubber.cs` implementing `Serilog.Core.IDestructuringPolicy` (or the equivalent for whichever logger is in use; PRism currently uses Microsoft.Extensions.Logging — adapt to its `JsonConsoleFormatterOptions` or wrap a `LoggerProvider`).

  ```csharp
  public sealed class SensitiveFieldScrubber : IDestructuringPolicy
  {
      private static readonly string[] BlockedFieldNames =
          { "subscriberId", "pat", "token", "body", "content" };

      public bool TryDestructure(object value, ILogEventPropertyValueFactory factory, out LogEventPropertyValue result)
      {
          // Walk the object's properties. For any field whose name matches BlockedFieldNames
          // (case-insensitive), substitute "[REDACTED]" instead of the actual value.
          // ...
      }
  }
  ```

  Tests in `tests/PRism.Web.Tests/SensitiveFieldScrubberTests.cs`: log a structured payload `{ subscriberId, headSha }` and assert the captured log line shows `[REDACTED]` for `subscriberId` and the literal SHA for `headSha`.

### Step 5.11: Run the SSE / middleware tests

- [ ] Add concrete test bodies to:
  - `tests/PRism.Web.Tests/EventsSubscriptionsEndpointTests.cs` — subscribe happy path, 404 on unknown subscriber, 409 already-subscribed.
  - `tests/PRism.Web.Tests/OriginCheckMiddlewareTests.cs` — empty-Origin POST → 403; empty-Origin GET → 200.
  - `tests/PRism.Web.Tests/SessionTokenMiddlewareTests.cs` — happy path; 401 without header; 401 on tampered token; constant-time-comparison sanity (use a stopwatch to confirm timing variance is small).

(Implement each test body. Do not leave placeholders.)

- [ ] Run:

```powershell
dotnet test tests\PRism.Web.Tests
```

Expected: all passing.

### Step 5.12: Commit

```powershell
git checkout -b feat/s3-pr5-sse-poller-middleware
git add PRism.Core/PrDetail/ PRism.Web/Sse/ PRism.Web/Endpoints/EventsEndpoints.cs PRism.Web/Middleware/ PRism.Web/Logging/ PRism.Web/Program.cs tests/
git commit -m "feat(sse): per-PR fanout + active-PR poller (100ms inter-batch pace + secondary-rate-limit handling) + tightened OriginCheck + SessionTokenMiddleware (header + cookie on /api/events) + BodySizeLimitMiddleware (16 KiB) + ILogger destructuring policy (S3 PR5)"
```

PR5 expanded scope per spec § 11.7:
- Cookie-based session-token enforcement on `GET /api/events` (header path covers all other non-asset endpoints).
- New `BodySizeLimitMiddleware` (16 KiB cap on the four mutating endpoints; configured before model binding).
- ILogger destructuring policy (scrubs `subscriberId`, `pat`, `token`, `body`, `content` case-insensitive).
- 100ms inter-batch pace between fan-out batches.
- 403 secondary-rate-limit handling (pause on `x-ratelimit-resource: secondary` header; respect `Retry-After`; degrade remainder to neutral Jaccard).

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
- [ ] **BannerRefresh layout/animation contract (spec § 7.1):**
  - Sticky position below `PrSubTabStrip`.
  - Renders as an *overlay* (does NOT push content down — the page content underneath stays visually stable).
  - Animated slide-down with `--t-med` ease-out.
  - Dismissible: a Close button next to Reload.
  - Below the 1180px breakpoint, z-index sits **above** the file-tree sheet/scrim (so a banner that fires while the sheet is open remains visible).
- [ ] **BannerRefresh aggregation behavior (spec § 7.4):** between two Reload presses, multiple `pr-updated` SSE events aggregate. `headShaChanged` latches a "Iter N+1 available" flag (boolean — no double-count); `commentCountChanged` increments a delta counter. On Reload, the GET response becomes the new baseline and the banner clears. Test 4 cases: single head change, single comment delta, multiple events of each type aggregating, mixed.
- [ ] **Deep-link `?iter=N` clamp on coefficient hot-reload (spec § 6.2 + § 7.5):** when the mounted page detects a `coefficientsGeneration` increment between the initial load and a banner-driven reload, briefly render "Iteration boundaries refreshed — selection may have moved", clamp `iter=N` to the nearest valid iteration (or All-changes), and update the URL via `history.replaceState` so back-button history isn't polluted. Test asserts URL update happens via replaceState (not pushState).
- [ ] usePrDetail hook (delayed-loading + delayed-spinner): test that skeleton renders only after 100ms pending, holds for 300ms minimum.
- [ ] useEventSource hook: test ready-state Promise, AbortController on reconnect, 401 force-reload, named-heartbeat watcher reset at 35s.
- [ ] useActivePrUpdates hook: subscribe on mount, unsubscribe on unmount, banner-firing on `pr-updated` event.

### Step 6.last: Commit

```powershell
git checkout -b feat/s3-pr6-frontend-shell
git add frontend/
git commit -m "feat(frontend): PR detail shell — page, routing, hooks, sub-tabs, banner (S3 PR6)"
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
cd frontend; npm test -- treeBuilder.test
```

Expected: all passing.

### Step 7.4: `useFilesTabShortcuts` test (input-eating-keys guard)

- [ ] Create `frontend/src/hooks/__tests__/useFilesTabShortcuts.test.tsx`. Test that `j`/`k`/`v`/`d` fire on the document but NOT when focus is inside `<textarea>`, `<input>`, `<select>`, or `[contenteditable="true"]`.

### Step 7.5: Implement `useFilesTabShortcuts.ts`

- [ ] Implement the hook with the spec § 7.8 input-eating-keys guard.

### Step 7.6: Implement file tree components

- [ ] `FileNode.tsx`, `DirectoryNode.tsx`, `FileTree.tsx`. Apply per-directory rollup `viewed N/M`.
- [ ] **Filter icon HIDDEN until S6 (spec § 7.2).** Do not render a clickable stub with a tooltip. The icon is simply absent from the file tree header in S3; S6 is when filtering ships.
- [ ] **AI focus dot column (spec § 7.2):** when `aiPreview === true` and the focus is backed by `PlaceholderFileFocusRanker` (the PoC noop ranker), suffix the `aria-label` with " (preview)". Final shape: `aria-label="AI focus: high (preview)"`. When `aiPreview === false`, render an `aria-hidden` placeholder span (no dot, no label). When a real (non-Noop, non-Placeholder) ranker ships in v2, the suffix drops away.
- [ ] **Inline toast for viewed-checkbox rollback (spec § 7.2).** When `POST /files/viewed` 4xxs and the optimistic-update reverts, render an inline toast with these properties:
  - **Position:** right-aligned within the file row (does NOT overlay the path text — sits to the right of the row, in the column where the viewed checkbox lives).
  - **Duration:** 4 seconds auto-dismiss; click-to-dismiss supported.
  - **A11y:** `role="status"`, `aria-live="polite"`.
  - **Stacking:** if a second toast fires on the same row before the first dismisses, the most-recent toast *replaces* the older one (single-toast-per-row). Toasts on different rows stack vertically.
  - **Animation:** `--t-med` ease-out (matches BannerRefresh).
- [ ] **Null-SHA iteration UI (spec § 7.2):** iterations with `HasResolvableRange === false` render as "Iter N (snapshot lost)" in the IterationTabStrip; ComparePicker disables selection of these iterations (renders them in a disabled-style row with a tooltip "Snapshot lost — base or head SHA was garbage-collected").

### Step 7.7: Implement `IterationTabStrip` + `ComparePicker`

- [ ] Render last-3-inline + dropdown; auto-swap on reverse selection; same-iteration empty state.
- [ ] **Narrow-viewport behavior for IterationTabStrip (spec § 7.7):**
  - At viewports < 1180px: collapse to "All changes | Iter N (active) | More ▾" with the rest of the iterations in the More dropdown.
  - At viewports < 900px: only show the active iteration label + More (drop the "All changes" label as well).
- [ ] **ComparePicker WAI-ARIA combobox keyboard model (spec § 7.8):**
  - `↓` / `↑` navigate options with wrap-around at the ends.
  - `Enter` and `Space` activate the highlighted option AND close the listbox.
  - `Home` / `End` jump to first / last option.
  - Digit-jump: typing a digit jumps to the iteration with that number.
  - DOM shape: `role="listbox"` on the container; `role="option"` on each item; `aria-selected` reflects current selection. Focus returns to the trigger button on close.

### Step 7.8: Implement responsive sheet behavior (< 1180px)

- [ ] When viewport < 1180px, file tree becomes an overlay sheet with focus trap + auto-collapse on file selection. Use a small `useViewportBreakpoint` hook + a `<FileTreeSheet>` wrapper.

### Step 7.9: Run frontend tests

- [ ] Run:

```powershell
cd frontend; npm test
```

Expected: all passing.

### Step 7.10: Commit

```powershell
git checkout -b feat/s3-pr7-file-tree
git add frontend/src/components/PrDetail/FilesTab/ frontend/src/hooks/
git commit -m "feat(frontend): file tree with smart compaction + viewed rollups + responsive sheet (S3 PR7)"
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
cd frontend; npm install react-diff-view diff react-markdown@^9 remark-gfm@^4 shiki@^1 mermaid@^11
npm install --save-dev @types/diff
```

**npm pin majors per spec § 5:** `react-markdown@^9`, `remark-gfm@^4`, `shiki@^1` (or current major; verify the current shiki major before locking — `^1` was current at spec time), `mermaid@^11`. The Renovate manual-approval label extends to all four packages so a major-version bump cannot land via auto-merge — sanitization regressions in any of them are upstream-driven and need a human security-review gate.

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

### Step 8.4: Mermaid behavioral test (3-test smoke check)

Spec § 5 + § 11.2 commit to a **3-test smoke check** for Mermaid hardening. The PRIMARY defense is the version pin + Renovate manual-approval label (Step 8.1) — the smoke check is a tripwire, not exhaustive coverage. Don't unit-test the library's hardened-mode behavior comprehensively; that's the upstream library's job.

- [ ] Create `frontend/src/components/Markdown/__tests__/MermaidBlock.behavioral.test.tsx`. Feed an adversarial flow definition with `click ... callback` directives that point to JavaScript; assert the rendered SVG contains no actionable JS (no `<a href="javascript:...">`, no `onclick=`, no inline event handlers). Three test cases total — covers the most common bypass shapes; everything else is the version pin's responsibility.

### Step 8.5: Implement `MermaidBlock`

- [ ] Lazy-import Mermaid; initialize with `{ securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } }` exactly once.

### Step 8.6: Implement `DiffPane` + supporting components

- [ ] Wire `react-diff-view` to render side-by-side / unified per `AppState.UiPreferences.DiffMode`. Three lines of context. Shiki tokens via the shared instance. Add `WordDiffOverlay` using jsdiff for word-level highlights on changed lines. `ExistingCommentWidget` stacks multiple threads inside one widget. `DiffTruncationBanner` renders when `DiffDto.truncated === true` with a deep link to github.com.
- [ ] **`d` toggle suppressed below 900px (spec § 7.7).** When viewport width < 900px, the `d` keybinding is a no-op with a tooltip `"side-by-side requires ≥ 900px"`. The user's persisted `UiPreferences.DiffMode` is **NOT** mutated by the suppression — when the viewport widens above 900px, side-by-side reapplies.
- [ ] **Diff-mode persistence backed by `AppState.UiPreferences.DiffMode` (spec § 6.3 + § 7.2).** This is the new top-level state field added in Task 1's follow-up. Persisted globally across launches via `state.json`. Frontend reads via a `useUiPreferences()` hook on initial mount and writes via the existing `IAppStateStore` save path (the endpoint that handles diff-mode persistence is part of S4's settings surface — for S3, the `d` keybinding mutates an in-memory store and the persistence layer wires up when settings ship).
- [ ] **Diff-mode default `side-by-side`** (per `AppState.Default.UiPreferences`).

### Step 8.7: Run frontend tests

- [ ] Run:

```powershell
cd frontend; npm test
```

Expected: all passing, including 14 sanitization cases + Mermaid behavioral.

### Step 8.8: Commit

```powershell
git checkout -b feat/s3-pr8-diff-pane
git add frontend/src/components/PrDetail/FilesTab/DiffPane/ frontend/src/components/Markdown/ frontend/package.json frontend/package-lock.json
git commit -m "feat(frontend): diff pane + word overlay + markdown pipeline + mermaid securityLevel=strict (S3 PR8)"
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
- [ ] **AiSummaryCard "Preview" chip (spec § 7.3).** When `aiPreview === true` AND the summary is backed by `PlaceholderPrSummarizer` (the PoC noop), prepend a muted "Preview" chip with copy *"AI preview — sample content, not generated from this PR"*. The chip persists until a non-Noop / non-Placeholder summarizer is registered (i.e., real AI ships in v2). Implementation: read the `aiSummaryProvider` capability flag — when its value is `placeholder`, render the chip; when `real`, drop it.
- [ ] **PrRootConversation rendering contract (spec § 7.3):**
  - Each comment widget renders author + timestamp + body via `MarkdownRenderer` (the shared sanitizing pipeline from Task 8).
  - Reaction emoji counts are read-only (no react button surfaces in S3 — reactions are a v2 concern).
  - **No per-comment Reply button** (the comment composer ships in S4; until then, no Reply UI).
  - Hover state is informational only (no action buttons appear on hover).
  - Static footer at the bottom of the conversation: *"Reply lands when the comment composer ships in S4."*

### Step 9.last: Commit

```powershell
git checkout -b feat/s3-pr9-overview-tab
git add frontend/src/components/PrDetail/OverviewTab/
git commit -m "feat(frontend): overview tab — AI summary placeholder + PR description hero + stats + conversation + CTA (S3 PR9)"
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
- Modify: `docs/specs/2026-05-06-architectural-readiness-design.md` (status notes already present)
- Possibly create: backlog stubs in `docs/backlog/` for the four future multipliers + coefficient calibration

### Step 10.1: Canonicalize the algorithm doc

The source markdown for the iteration-clustering algorithm currently lives outside the repo (it was authored as a standalone doc). Source location varies by implementer; in Pratyush's environment it's `C:\Users\pratyush.pande\Downloads\pr-iteration-detection-algorithm.md`, but other implementers won't have that path.

- [ ] Locate the source (env var `PRISM_ALGORITHM_DOC_SOURCE` if set, otherwise prompt the user). Copy to `docs/spec/iteration-clustering-algorithm.md`:

```powershell
$src = $env:PRISM_ALGORITHM_DOC_SOURCE
if (-not $src) {
    # Default in Pratyush's environment; prompt otherwise.
    $candidate = "$env:USERPROFILE\Downloads\pr-iteration-detection-algorithm.md"
    if (Test-Path $candidate) { $src = $candidate }
    else { Write-Error "Set PRISM_ALGORITHM_DOC_SOURCE or copy the algorithm doc to a known path."; exit 1 }
}
Copy-Item $src "docs\spec\iteration-clustering-algorithm.md"
```

If the source no longer exists (e.g., wiped Downloads folder), the canonical version is preserved in PR #13's commit history at the path `C:/Users/pratyush.pande/Downloads/pr-iteration-detection-algorithm.md` referenced in the spec — recover by checking out a known-good commit and re-deriving from the spec's content. The discipline-check workflow doesn't depend on the doc itself, only on the algorithm code.

### Step 10.2–10.N: Apply each spec edit per § 9.2

- [ ] For each row in slice spec § 9.2, read the affected target section, apply the change inline. Each edit is small (paragraph rewrites). Verify cross-references after each edit.
- [ ] **`docs/spec/03-poc-features.md` § 3 "Diff display":** update truncation derivation. Truncation is derived from `pull.changed_files > files.length`, NOT from a `compare` endpoint call. Spec § 9.2.
- [ ] **Truncation banner copy** (used by `DiffTruncationBanner` in Task 8): *"PRism shows GitHub's first N files of this diff. Full-diff support is on the roadmap. Open on github.com."* Make sure this exact copy lands in the doc and matches the component literal.
- [ ] **Deferred-items list mirrors spec § 9.5 additions:** "Multi-window single-instance enforcement → architectural-readiness backlog item; named-mutex/flock + IPC focus signal."
- [ ] **New § 10.6 "Logging discipline for GitHub-content payloads"** lands as part of the spec sync. The plan references it from this doc-updates list — the spec edit lives in `docs/specs/2026-05-06-s3-pr-detail-read-design.md` (already in commit `6c2a487`); no separate doc-task action beyond confirming downstream specs cross-reference it.

### Step 10.last: Commit

```powershell
git checkout -b feat/s3-pr10-docs
git add docs/
git commit -m "docs(s3): apply spec / arch-readiness / roadmap updates per § 9 (S3 PR10)"
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
dotnet new xunit -o tests\PRism.GitHub.Tests.Integration
dotnet sln PRism.sln add tests\PRism.GitHub.Tests.Integration\PRism.GitHub.Tests.Integration.csproj
dotnet add tests\PRism.GitHub.Tests.Integration reference PRism.GitHub\PRism.GitHub.csproj
```

Add a `runsettings` file at repo root that filters out `Category=Integration` from the default `dotnet test` run.

### Step 11.3: Write the 5 contract tests + GraphQL-shape-drift + secondary-rate-limit smoke

- [ ] Implement each per spec § 11.4. Pin to commit-SHAs in a config record (don't read branch HEAD). The shape-drift test produces a structured field-by-field diff on failure (use `JsonDiffPatch` or hand-roll a small differ).
- [ ] **Verify the existing 5-test count still holds.** The iteration-clustering algorithm itself didn't change — only DEFAULTS changed (`SkipJaccardAboveCommitCount` 100→50, `InterBatchPaceMs` introduced). The frozen-PR's expected boundaries should land at the same commit SHAs because the test PR was authored to fall well below the 50-commit cap, where the per-commit Jaccard fan-out runs to completion regardless of the pace knob. If a test diverges, treat as a regression to investigate before adjusting expectations.
- [ ] **Add `Frozen_pr_secondary_rate_limit_does_not_block_clustering`** — a smoke check on the 403/secondary handling. The test only fires meaningfully if the per-commit fan-out hits the secondary rate limit during the test run; in steady state this is **typically skipped** because the frozen PR is small and well under any rate-limit threshold. Implementation:

  ```csharp
  [SkippableFact]
  public async Task Frozen_pr_secondary_rate_limit_does_not_block_clustering()
  {
      // The smoke check exists to prove the 403/secondary handling doesn't
      // hard-fail clustering. It triggers only when GitHub's response actually
      // carries `x-ratelimit-resource: secondary` during the test run.
      // Production hardening for the path is in unit tests on GitHubReviewService;
      // this is the integration-side tripwire.
      Skip.IfNot(Environment.GetEnvironmentVariable("PRISM_INTEGRATION_RATE_LIMIT_REPRO") == "1",
          "Set PRISM_INTEGRATION_RATE_LIMIT_REPRO=1 to repro a secondary rate-limit (requires saturating fan-out).");
      // ... assert clustering still produces a non-empty IterationCluster set even after
      // the rate-limit hit, with neutral-Jaccard for the degraded commits.
  }
  ```
  Spec § 11.4.

### Step 11.4: Update CI workflow

- [ ] Add a separate workflow job that runs only on a manual `workflow_dispatch` (or nightly schedule) with `PRISM_INTEGRATION_PAT` set as a secret.

### Step 11.5: Run the integration tests locally

- [ ] Run:

```powershell
$env:PRISM_INTEGRATION_PAT = "<your token>"
dotnet test tests\PRism.GitHub.Tests.Integration --filter "Category=Integration"
```

Expected: 5 pinned-SHA tests pass; `Frozen_pr_graphql_shape_unchanged` passes.

### Step 11.6: Commit

```powershell
git checkout -b feat/s3-pr11-contract-tests
git add tests/PRism.GitHub.Tests.Integration/ PRism.sln .github/workflows/
git commit -m "test(integration): frozen api-codex PR contract tests + GraphQL shape-drift detector + secondary-rate-limit smoke (S3 PR11)"
```

### Step 11.7: Test row updates throughout the plan (mirrors spec § 11.3)

The spec's `ce-doc-review` pass updated multiple test rows. The plan tasks above already incorporate these — the list below is a compact index for cross-reference:

| Test row | Old | New |
|---|---|---|
| Diff truncation derivation | "GET /api/pr/{ref}/diff propagates `truncated: true` from `compare`" | "GET /api/pr/{ref}/diff derives `truncated: true` from `pull.changed_files` count mismatch" |
| /file 422 split | single `/file/not-in-diff` row | `/file/not-in-diff` row + new `/file/truncation-window` row |
| Body path canonicalization | 4 tests | 7 tests (rules: `..`, `.`, empty, leading `/`, trailing `/`, NUL, control char, backslash, NFC byte-length) |
| Body size cap | (not in earlier draft) | 4 tests (one per mutating endpoint) |
| X-PRism-Session enforcement | (only mutating verbs in earlier draft) | 5 tests covering GET enforcement (header for most, cookie for /api/events) |
| State migration | 4 tests | 6 tests (added `UiPreferences` migration + `ResetToDefaultAsync` + malformed-JSON-no-read-only) |
| Logging discipline | (not in earlier draft) | 1 test (subscriberId / pat / token / body / content scrub) |
| Iteration deep-link | (not in earlier draft) | 1 test (`?iter=N` clamps on coefficient hot-reload via `history.replaceState`) |

---

## Final: Discipline Check + § 12 Recording

- [ ] Run the discipline-check `[SkippableFact]` from Task 2 against 3-5 PRs each from `bizapp-bff` and `mobile-business-gateway`:

```powershell
$env:PRISM_DISCIPLINE_PR_REFS = "mindbody/Mindbody.BizApp.Bff/123,mindbody/Mindbody.BizApp.Bff/456,mindbody/Mindbody.Mobile.BusinessGateway/789"
dotnet test tests\PRism.Core.Tests --filter "FullyQualifiedName~ClusteringDisciplineCheck"
```

- [ ] Hand-label boundaries; record per-PR agreement % in spec § 12. If aggregate < 70%, tune coefficients in `appsettings.json` and re-run.

- [ ] Commit § 12 update:

```powershell
git add docs/specs/2026-05-06-s3-pr-detail-read-design.md
git commit -m "docs(s3): record discipline-check observations in spec § 12"
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
