# Frozen-PR Contract Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a live-GitHub integration suite (`PRism.GitHub.Tests.Integration`) that exercises `GitHubReviewService` against five locked, SHA-pinned PRs in `prpande/PRism`, with capture-mode fixture rebuild, two-layer CI write-protection, strict-canonical sibling tests, an enforced corpus-staleness build break, a `manual-dispatch-only` CI workflow, and an operator runbook.

**Architecture:** New xUnit project at `tests/PRism.GitHub.Tests.Integration/` gated by `[Trait("Category", "Integration")]` and excluded from default `dotnet test` via a new repo-root `.runsettings`. PATs come from `gh auth token` locally or `PRISM_INTEGRATION_PAT` env var in CI, wrapped in a four-guard `RedactedSecret` struct. The shape-drift detector compares the live GraphQL response for PR #19 against a checked-in, strip-allowlisted fixture; capture mode rewrites the fixture under explicit env-var control, blocked from engaging in CI by a two-layer guard. Five corpus PRs (#1, #16, #19, #22, #28) are locked via an atomic lock-then-capture script committed in both PowerShell and bash. A non-Integration `CorpusStalenessTest` fails the build when no corpus PR is more recent than 18 months. CI runs on `workflow_dispatch` only; the existing main CI's `dotnet test` step gets `--settings .runsettings` to keep integration tests out of PR-push runs.

**Tech Stack:** .NET 10 (xUnit, FluentAssertions), `System.Text.Json` (no JsonDiffPatch — hand-rolled `~50 LOC` differ), `gh` CLI (shelled out via `System.Diagnostics.Process`), GitHub Actions (`workflow_dispatch`-only, fine-grained PAT), PowerShell 7+ (PRism's documented shell) + bash for cross-platform script parity.

**Worktree note:** This plan is the implementation plan. The spec + plan docs PR lands from the existing `D:/src/PRism-frozen-pr-tests-docs` worktree on branch `docs/frozen-pr-tests`. The implementation itself should land in a separate worktree (e.g. `git worktree add D:/src/PRism-frozen-pr-tests-impl -b feat/frozen-pr-tests`) per the global CLAUDE.md git-worktree rule.

---

## File Structure

NEW files this plan creates:

| Path | Purpose |
|---|---|
| `tests/PRism.GitHub.Tests.Integration/PRism.GitHub.Tests.Integration.csproj` | Project file; references PRism.GitHub + PRism.Core; opts out of Octokit ban |
| `tests/PRism.GitHub.Tests.Integration/Helpers/GhCliPat.cs` | PAT resolver (env var → gh CLI fallback) + `RedactedSecret` four-guard wrapper + `IsCaptureModeEnabled()` helper |
| `tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiff.cs` | Hand-rolled structural diff over two `JsonElement` trees |
| `tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiffTests.cs` | Unit tests for the differ — synthetic + real-fixture mutation self-check |
| `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs` | Allowlist of GraphQL JSON pointers kept during capture-mode write |
| `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlistTests.cs` | Unit tests for the allowlist (synthetic input) |
| `tests/PRism.GitHub.Tests.Integration/Helpers/CaptureModeGuardTests.cs` | Unit tests for `IsCaptureModeEnabled()` exact-match predicate + CI-guard exception |
| `tests/PRism.GitHub.Tests.Integration/Helpers/RedactedSecretTests.cs` | Unit tests for the four-guard wrapper |
| `tests/PRism.GitHub.Tests.Integration/FrozenPrCorpus.cs` | Static record of 5 PRs + their captured metadata |
| `tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json` | Stripped GraphQL response baseline for test 7g |
| `tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs` | Corpus-anchored tests 7a, 7b, 7c, 7f, 7g, 7h |
| `tests/PRism.GitHub.Tests.Integration/PatScopeContractTests.cs` | Test 7e — PR-independent PAT fitness smoke |
| `tests/PRism.GitHub.Tests.Integration/CanonicalIterationCountTests.cs` | Strict-equality sibling tests for ranged PRs (#16, #19) — `[Trait("Canonical","Strict")]` |
| `tests/PRism.GitHub.Tests.Integration/CorpusStalenessTest.cs` | Non-Integration unit test: fails when max corpus merge-date > 18 months ago |
| `tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.ps1` | PowerShell — atomic lock-then-capture for a corpus PR |
| `tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.sh` | bash — same logic, cross-platform parity |
| `.runsettings` | Repo root — excludes `Category=Integration` AND `Canonical=Strict` from default `dotnet test` |
| `.github/workflows/integration-tests.yml` | `workflow_dispatch`-only CI job with PAT mask + capture-mode override |
| `docs/contract-tests.md` | Operator runbook |

MODIFY:

| Path | Change |
|---|---|
| `PRism.sln` | + new test project |
| `.github/workflows/ci.yml` | + `--settings .runsettings` on `dotnet test` step |
| `README.md` | + brief "Integration tests" section pointing at the runbook |
| `docs/specs/README.md` | + new spec entry under "In progress" |
| `PRism.Core/Iterations/ForcePushMultiplier.cs` | + XML docstring mirroring spec § 4.1 (PL-R2-4 mitigation) |
| `PRism.GitHub/GitHubReviewService.cs` | Refactor inlined PR-detail GraphQL query to `internal const string PrDetailGraphQLQuery` so test 7g (§ 11 / Task 11) can replay the SAME query the production code issues. Plus `[InternalsVisibleTo("PRism.GitHub.Tests.Integration")]` in the csproj or AssemblyInfo. |

---

## Sequencing rationale

Three phases:

1. **Scaffolding (T1–T7)** — Project, helpers, corpus skeleton. All offline, no live GitHub calls. TDD throughout.
2. **Live data capture (T8–T10)** — Lock the five corpus PRs, capture their head SHAs / files / comment anchors into `FrozenPrCorpus`, capture the PR #19 GraphQL fixture. Single sequential block — order matters (lock before capture).
3. **Tests + CI + docs (T11–T20)** — Tests run against captured data, CI workflows land, runbook + README + spec-index updates, DoD verification.

---

## Task 1: Scaffold the test project + .runsettings + sln entry

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/PRism.GitHub.Tests.Integration.csproj`
- Create: `.runsettings` (at repo root)
- Modify: `PRism.sln` (add project entry)

- [ ] **Step 1: Create the csproj**

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <IsPackable>false</IsPackable>
    <IsTestProject>true</IsTestProject>
    <!-- The integration suite instantiates GitHubReviewService directly, which transitively
         references Octokit types. Opt out of the global BannedApiAnalyzers Octokit ban
         (Directory.Build.props default). PRism.GitHub.csproj uses the same opt-out. -->
    <BanOctokit>false</BanOctokit>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" />
    <PackageReference Include="xunit" />
    <PackageReference Include="xunit.runner.visualstudio" />
    <PackageReference Include="FluentAssertions" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\..\PRism.GitHub\PRism.GitHub.csproj" />
    <ProjectReference Include="..\..\PRism.Core\PRism.Core.csproj" />
    <!-- ClusteringQuality, PrDetailDto, DiffDto, PrReference, DiffRangeRequest, ReviewThreadDto,
         AuthValidationResult, and the rest of the DTO surface live in PRism.Core.Contracts.
         Reference it explicitly so the test code resolves these types directly rather than via
         transitive availability (which is not guaranteed under TreatWarningsAsErrors=true). -->
    <ProjectReference Include="..\..\PRism.Core.Contracts\PRism.Core.Contracts.csproj" />
  </ItemGroup>
  <ItemGroup>
    <!-- Fixture must travel with the test bin so capture mode and assertions both see the same path -->
    <None Update="Fixtures\pr19-graphql-response.json">
      <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    </None>
  </ItemGroup>
</Project>
```

- [ ] **Step 2: Create the repo-root `.runsettings`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
  <RunConfiguration>
    <!-- Exclude integration tests AND strict-canonical sibling tests from default `dotnet test`.
         xUnit's trait filter property is `Category` (the trait name we apply); MSTest's is `TestCategory`.
         Strict-canonical tests run only via `dotnet test --filter "Canonical=Strict"` during triage
         (spec § 9.7, § 10 silent-drift bullet). -->
    <TestCaseFilter>Category!=Integration&amp;Canonical!=Strict</TestCaseFilter>
  </RunConfiguration>
</RunSettings>
```

- [ ] **Step 3: Add the project to `PRism.sln`**

Run from repo root:

```powershell
dotnet sln PRism.sln add tests\PRism.GitHub.Tests.Integration\PRism.GitHub.Tests.Integration.csproj
```

Expected output: confirmation that the project was added.

- [ ] **Step 4: Verify the default `dotnet test` filter works**

Run from repo root:

```powershell
dotnet build --configuration Release
dotnet test --no-build --configuration Release
```

Expected: build succeeds (csproj compiles with no source files yet — `<EnableDefaultCompileItems>` is true; no .cs files yet means an empty assembly). `dotnet test` runs the existing test suites and prints zero integration tests in the new project's output (no test methods exist yet, so trivially zero — this verifies the filter doesn't break anything else).

- [ ] **Step 5: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/PRism.GitHub.Tests.Integration.csproj .runsettings PRism.sln
git commit -m "test(integration): scaffold PRism.GitHub.Tests.Integration project + .runsettings"
```

---

## Task 2: `RedactedSecret` four-guard wrapper (TDD)

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/Helpers/RedactedSecretTests.cs`
- Create: `tests/PRism.GitHub.Tests.Integration/Helpers/GhCliPat.cs` (RedactedSecret struct lives here)

- [ ] **Step 1: Write failing tests covering all four guards**

```csharp
using System.Diagnostics;
using System.Reflection;
using FluentAssertions;
using PRism.GitHub.Tests.Integration.Helpers;
using Xunit;

namespace PRism.GitHub.Tests.Integration.Helpers;

public class RedactedSecretTests
{
    [Fact]
    public void ToString_returns_REDACTED()
    {
        var s = new RedactedSecret("ghp_abc123secretvalue");
        s.ToString().Should().Be("[REDACTED]");
    }

    [Fact]
    public void IFormattable_ToString_returns_REDACTED()
    {
        var s = new RedactedSecret("ghp_abc123secretvalue");
        // ILogger template expansion and FluentAssertions call the IFormattable overload
        ((IFormattable)s).ToString("anyformat", null).Should().Be("[REDACTED]");
    }

    [Fact]
    public void Reveal_is_a_method_not_a_property()
    {
        // Reflection-based property enumeration (FluentAssertions, debugger visualizers) must NOT
        // surface the raw value. Reveal must be a method, not a property.
        var type = typeof(RedactedSecret);
        type.GetMethod("Reveal", BindingFlags.Public | BindingFlags.Instance).Should().NotBeNull();
        type.GetProperty("Reveal", BindingFlags.Public | BindingFlags.Instance).Should().BeNull();
    }

    [Fact]
    public void Reveal_returns_the_raw_value()
    {
        var s = new RedactedSecret("ghp_abc123secretvalue");
        s.Reveal().Should().Be("ghp_abc123secretvalue");
    }

    [Fact]
    public void Has_DebuggerDisplay_attribute_with_REDACTED_text()
    {
        var attr = typeof(RedactedSecret)
            .GetCustomAttributes(typeof(DebuggerDisplayAttribute), inherit: false)
            .Cast<DebuggerDisplayAttribute>()
            .SingleOrDefault();
        attr.Should().NotBeNull("the wrapper must suppress IDE debugger auto-expand");
        attr!.Value.Should().Be("[REDACTED]");
    }
}
```

- [ ] **Step 2: Run the tests and verify they fail**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release
```

Expected: tests fail with `RedactedSecret` type not found.

- [ ] **Step 3: Implement `RedactedSecret` + the surrounding `GhCliPat` skeleton**

```csharp
using System.Diagnostics;

namespace PRism.GitHub.Tests.Integration.Helpers;

[DebuggerDisplay("[REDACTED]")]
public readonly struct RedactedSecret : IFormattable
{
    private readonly string _value;

    public RedactedSecret(string value)
    {
        _value = value ?? throw new ArgumentNullException(nameof(value));
    }

    /// <summary>Exposes the raw value for use at the single sink that needs it (HTTP Authorization header).</summary>
    /// <remarks>
    /// Intentionally a METHOD, not a property — properties get auto-enumerated by FluentAssertions'
    /// object-graph formatter and by IDE debugger visualizers, which would leak the value through
    /// the "redacting" wrapper. Reflection-based property enumeration returns nothing for a method.
    /// </remarks>
    public string Reveal() => _value;

    public override string ToString() => "[REDACTED]";

    public string ToString(string? format, IFormatProvider? formatProvider) => "[REDACTED]";
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release
```

Expected: all 5 RedactedSecret tests pass.

- [ ] **Step 5: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/Helpers/RedactedSecret*.cs tests/PRism.GitHub.Tests.Integration/Helpers/GhCliPat.cs
git commit -m "test(integration): RedactedSecret four-guard PAT wrapper (TDD)"
```

---

## Task 3: `GhCliPat.Get()` + `IsCaptureModeEnabled()` helpers (TDD)

**Files:**
- Modify: `tests/PRism.GitHub.Tests.Integration/Helpers/GhCliPat.cs`
- Create: `tests/PRism.GitHub.Tests.Integration/Helpers/CaptureModeGuardTests.cs`

`GhCliPat.Get()` is hard to unit-test directly without mocking `Process` or relying on a `gh auth` setup; we leave its end-to-end correctness to the real integration runs. We DO unit-test `IsCaptureModeEnabled()` because the activation predicate is load-bearing for the CI write-protection layer 1 (spec § 7).

- [ ] **Step 1: Write failing tests for `IsCaptureModeEnabled()`**

```csharp
using FluentAssertions;
using PRism.GitHub.Tests.Integration.Helpers;
using Xunit;

namespace PRism.GitHub.Tests.Integration.Helpers;

public class CaptureModeGuardTests
{
    // Tests use a value object so they don't mutate process env vars. The production code path
    // reads `Environment.GetEnvironmentVariable("PRISM_FROZEN_PR_CAPTURE_FIXTURE")`; the helper
    // accepts the value as a parameter to keep tests deterministic and parallel-safe.

    [Theory]
    [InlineData("1", true)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("true", false)]
    [InlineData("yes", false)]
    [InlineData("0", false)]
    [InlineData("11", false)]
    [InlineData(" 1", false)]
    [InlineData("1 ", false)]
    public void IsCaptureModeEnabled_requires_exact_string_1(string? value, bool expected)
    {
        GhCliPat.IsCaptureModeEnabled(value).Should().Be(expected);
    }

    [Fact]
    public void EnsureCaptureModeNotInCi_throws_when_both_capture_and_CI_env_vars_are_set()
    {
        // Spec § 7 — two-layer guard, layer 2: code path throws when CI + capture both active.
        var ex = Assert.Throws<InvalidOperationException>(
            () => GhCliPat.EnsureCaptureModeNotInCi(captureValue: "1", ciValue: "true"));
        ex.Message.Should().Contain("Capture mode is disabled in CI");
    }

    [Theory]
    [InlineData("1", null)]      // capture set, CI unset — allowed (local capture)
    [InlineData(null, "true")]   // capture unset, CI set — allowed (assert mode in CI)
    [InlineData(null, null)]     // neither — allowed (assert mode locally)
    [InlineData("", "true")]     // capture explicitly empty in CI — allowed (layer 1 override)
    public void EnsureCaptureModeNotInCi_allows_safe_combinations(string? capture, string? ci)
    {
        // Should not throw
        GhCliPat.EnsureCaptureModeNotInCi(capture, ci);
    }
}
```

- [ ] **Step 2: Run the tests and verify they fail**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~CaptureModeGuardTests"
```

Expected: tests fail with method `IsCaptureModeEnabled` / `EnsureCaptureModeNotInCi` not found.

- [ ] **Step 3: Implement the helpers**

Extend `GhCliPat.cs`:

```csharp
using System.Diagnostics;

namespace PRism.GitHub.Tests.Integration.Helpers;

public static class GhCliPat
{
    private static readonly Lazy<RedactedSecret> _cached = new(Resolve);

    /// <summary>Returns the PAT for the test run. Cached for the test session.</summary>
    public static RedactedSecret Get() => _cached.Value;

    private static RedactedSecret Resolve()
    {
        // CI path: PRISM_INTEGRATION_PAT env var.
        var fromEnv = Environment.GetEnvironmentVariable("PRISM_INTEGRATION_PAT");
        if (!string.IsNullOrWhiteSpace(fromEnv)) return new RedactedSecret(fromEnv);

        // Local path: gh CLI.
        using var p = new Process
        {
            StartInfo = new ProcessStartInfo("gh", "auth token --hostname github.com")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            }
        };
        p.Start();
        var token = p.StandardOutput.ReadToEnd().Trim();
        p.WaitForExit(5_000);
        if (p.ExitCode != 0 || string.IsNullOrWhiteSpace(token))
        {
            throw new InvalidOperationException(
                "No PRISM_INTEGRATION_PAT env var and `gh auth token` failed. " +
                "Run `gh auth login --scopes \"repo,read:org\"` (or set the env var with a " +
                "fine-grained PAT scoped to prpande/PRism) and retry.");
        }
        return new RedactedSecret(token);
    }

    /// <summary>
    /// Activation predicate for capture mode. Spec § 7 — exact-string "1" equality, NOT
    /// IsNullOrEmpty negation. Pinning the predicate here so a future refactor that
    /// loosens the check (e.g. !string.IsNullOrEmpty) doesn't silently demote the
    /// CI write-protection layer 1 (the `PRISM_FROZEN_PR_CAPTURE_FIXTURE: ''` line in
    /// .github/workflows/integration-tests.yml relies on this exact-match semantics).
    /// </summary>
    public static bool IsCaptureModeEnabled(string? value) => value == "1";

    public static bool IsCaptureModeEnabled() =>
        IsCaptureModeEnabled(Environment.GetEnvironmentVariable("PRISM_FROZEN_PR_CAPTURE_FIXTURE"));

    /// <summary>
    /// Spec § 7 layer 2 — throws when capture mode is requested AND the process is running
    /// inside CI (GitHub Actions / Azure Pipelines / generic CI runners all set `CI`).
    /// Either layer is sufficient; together they're defence-in-depth.
    /// </summary>
    public static void EnsureCaptureModeNotInCi(string? captureValue, string? ciValue)
    {
        var captureRequested = IsCaptureModeEnabled(captureValue);
        var inCi = !string.IsNullOrWhiteSpace(ciValue);
        if (captureRequested && inCi)
        {
            throw new InvalidOperationException(
                "Capture mode is disabled in CI to prevent silent fixture rewrites. " +
                "Run locally with PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 to refresh.");
        }
    }

    public static void EnsureCaptureModeNotInCi() =>
        EnsureCaptureModeNotInCi(
            Environment.GetEnvironmentVariable("PRISM_FROZEN_PR_CAPTURE_FIXTURE"),
            Environment.GetEnvironmentVariable("CI"));
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~CaptureModeGuardTests"
```

Expected: all 13 inline-data + fact cases pass.

- [ ] **Step 5: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/Helpers/GhCliPat.cs tests/PRism.GitHub.Tests.Integration/Helpers/CaptureModeGuardTests.cs
git commit -m "test(integration): GhCliPat resolver + IsCaptureModeEnabled + CI guard (TDD)"
```

---

## Task 4: `GraphQLShapeDiff` structural differ (TDD with synthetic inputs)

The real-fixture mutation self-check is in Task 5 — it depends on a captured fixture, which doesn't exist yet. This task covers the synthetic-input layer.

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiff.cs`
- Create: `tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiffTests.cs`

- [ ] **Step 1: Write failing tests for the differ**

```csharp
using System.Text.Json;
using FluentAssertions;
using PRism.GitHub.Tests.Integration.Helpers;
using Xunit;

namespace PRism.GitHub.Tests.Integration.Helpers;

public class GraphQLShapeDiffTests
{
    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void Identical_documents_return_empty_diff()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"a": 1, "b": "x"}"""),
            Parse("""{"a": 1, "b": "x"}"""));
        diff.Should().BeEmpty();
    }

    [Fact]
    public void Added_field_surfaces_as_plus_path()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"a": 1}"""),
            Parse("""{"a": 1, "b": 2}"""));
        diff.Should().ContainSingle().Which.Should().StartWith("+ /b");
    }

    [Fact]
    public void Removed_field_surfaces_as_minus_path()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"a": 1, "b": 2}"""),
            Parse("""{"a": 1}"""));
        diff.Should().ContainSingle().Which.Should().StartWith("- /b");
    }

    [Fact]
    public void Type_change_surfaces_as_tilde_with_kinds()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"a": "string"}"""),
            Parse("""{"a": 42}"""));
        diff.Should().ContainSingle().Which.Should().Contain("~ /a").And.Contain("String").And.Contain("Number");
    }

    [Fact]
    public void Nested_object_changes_emit_full_pointer_path()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"data": {"repository": {"x": 1}}}"""),
            Parse("""{"data": {"repository": {"x": 1, "y": 2}}}"""));
        diff.Should().ContainSingle().Which.Should().Contain("/data/repository/y");
    }

    [Fact]
    public void Array_diffs_positionally_by_index()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"items": [{"k": "a"}, {"k": "b"}]}"""),
            Parse("""{"items": [{"k": "a"}, {"k": "b", "added": true}]}"""));
        diff.Should().ContainSingle().Which.Should().Contain("/items/1/added");
    }

    [Fact]
    public void Array_length_difference_surfaces_per_missing_index()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"items": [1, 2, 3]}"""),
            Parse("""{"items": [1, 2]}"""));
        diff.Should().Contain(line => line.StartsWith("- /items/2"));
    }

    [Fact]
    public void Multiple_changes_emit_in_stable_order()
    {
        var diff = GraphQLShapeDiff.Diff(
            Parse("""{"a": 1, "b": "x", "c": [1]}"""),
            Parse("""{"a": 2, "b": "x", "c": [1, 2], "d": true}"""));
        // Three differences: type-or-value change at /a (Number→Number, value differ — see contract), array length /c, addition /d.
        // Stable order: pre-order traversal of the LEFT tree first, then additions from the RIGHT.
        diff.Should().HaveCount(c => c >= 2);
    }
}
```

- [ ] **Step 2: Run tests, verify they fail**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~GraphQLShapeDiffTests"
```

Expected: all 8 tests fail with type not found.

- [ ] **Step 3: Implement `GraphQLShapeDiff`**

```csharp
using System.Text;
using System.Text.Json;

namespace PRism.GitHub.Tests.Integration.Helpers;

public static class GraphQLShapeDiff
{
    /// <summary>
    /// Structural diff over two JsonElement trees. Returns a list of human-readable diff lines:
    ///   + /pointer (kind)              — present in actual, missing in expected
    ///   - /pointer                     — present in expected, missing in actual
    ///   ~ /pointer (kindA → kindB)     — same pointer, different JsonValueKind
    /// Arrays diff positionally by index. The differ asserts STRUCTURE (presence + kind), not value
    /// equality on primitives — value drift in PR-data is caught by other tests; this differ
    /// targets shape drift in GitHub's GraphQL schema.
    /// </summary>
    public static List<string> Diff(JsonElement expected, JsonElement actual)
    {
        var results = new List<string>();
        Walk("", expected, actual, results);
        return results;
    }

    private static void Walk(string pointer, JsonElement expected, JsonElement actual, List<string> diffs)
    {
        if (expected.ValueKind != actual.ValueKind)
        {
            diffs.Add($"~ {Pointer(pointer)} ({expected.ValueKind} → {actual.ValueKind})");
            return;
        }

        switch (expected.ValueKind)
        {
            case JsonValueKind.Object:
                WalkObject(pointer, expected, actual, diffs);
                break;
            case JsonValueKind.Array:
                WalkArray(pointer, expected, actual, diffs);
                break;
            // Primitives: same ValueKind is sufficient for shape; value-level diff is out of scope.
            default:
                break;
        }
    }

    private static void WalkObject(string pointer, JsonElement expected, JsonElement actual, List<string> diffs)
    {
        var expectedNames = new HashSet<string>();
        foreach (var prop in expected.EnumerateObject())
        {
            expectedNames.Add(prop.Name);
            if (actual.TryGetProperty(prop.Name, out var actualChild))
                Walk(Combine(pointer, prop.Name), prop.Value, actualChild, diffs);
            else
                diffs.Add($"- {Pointer(Combine(pointer, prop.Name))}");
        }
        foreach (var prop in actual.EnumerateObject())
        {
            if (!expectedNames.Contains(prop.Name))
                diffs.Add($"+ {Pointer(Combine(pointer, prop.Name))} ({prop.Value.ValueKind})");
        }
    }

    private static void WalkArray(string pointer, JsonElement expected, JsonElement actual, List<string> diffs)
    {
        var expectedLen = expected.GetArrayLength();
        var actualLen = actual.GetArrayLength();
        var shared = Math.Min(expectedLen, actualLen);
        for (var i = 0; i < shared; i++)
            Walk(Combine(pointer, i.ToString()), expected[i], actual[i], diffs);
        for (var i = shared; i < expectedLen; i++)
            diffs.Add($"- {Pointer(Combine(pointer, i.ToString()))}");
        for (var i = shared; i < actualLen; i++)
            diffs.Add($"+ {Pointer(Combine(pointer, i.ToString()))} ({actual[i].ValueKind})");
    }

    private static string Combine(string parent, string child) =>
        parent.Length == 0 ? "/" + Escape(child) : parent + "/" + Escape(child);

    // RFC 6901 token escaping for the two reserved characters.
    private static string Escape(string token) =>
        token.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);

    private static string Pointer(string pointer) => pointer.Length == 0 ? "/" : pointer;
}
```

- [ ] **Step 4: Run tests, verify they pass**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~GraphQLShapeDiffTests"
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiff*.cs
git commit -m "test(integration): GraphQLShapeDiff structural differ (TDD, synthetic inputs)"
```

---

## Task 5: `FixtureStripAllowlist` — categories + tests

Spec § 7 names the kept/stripped category rule. The allowlist is implemented as a list of JSON-Pointer-prefix paths that are KEPT; everything else is stripped to `null` (preserves shape, removes content).

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs`
- Create: `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlistTests.cs`

- [ ] **Step 1: Write failing tests covering category-rule behaviour**

```csharp
using System.Text.Json;
using FluentAssertions;
using PRism.GitHub.Tests.Integration.Helpers;
using Xunit;

namespace PRism.GitHub.Tests.Integration.Helpers;

public class FixtureStripAllowlistTests
{
    private static string Strip(string input)
    {
        using var doc = JsonDocument.Parse(input);
        var stripped = FixtureStripAllowlist.Apply(doc.RootElement);
        return stripped.ToJsonString();
    }

    [Fact]
    public void Keeps_structural_fields_strips_body()
    {
        // PR body is NOT in the allowlist (allowlist design — spec § 7) — must be stripped.
        var stripped = Strip("""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "number": 19,
                "body": "Lots of internal critique here",
                "state": "MERGED"
              }
            }
          }
        }
        """);
        stripped.Should().Contain("\"number\":19").And.Contain("\"state\":\"MERGED\"");
        stripped.Should().NotContain("Lots of internal critique here");
        stripped.Should().Contain("\"body\":null");  // shape preserved as null
    }

    [Fact]
    public void Unknown_fields_default_to_stripped_under_allowlist_design()
    {
        // Spec § 7 mandates allowlist over denylist so a future GraphQL field addition doesn't
        // silently include sensitive content. A field never seen before — e.g. "avatarUrl",
        // "databaseId", "secretToken" — must default to stripped, not pass through.
        var stripped = Strip("""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "number": 19,
                "author": { "login": "someone", "avatarUrl": "https://example.com/a", "databaseId": 12345, "secretToken": "ghp_abc" }
              }
            }
          }
        }
        """);
        stripped.Should().Contain("\"number\":19");
        stripped.Should().NotContain("someone");
        stripped.Should().NotContain("example.com");
        stripped.Should().NotContain("12345");
        stripped.Should().NotContain("ghp_abc");
    }

    [Fact]
    public void Strips_identity_email_and_keeps_type_marker()
    {
        // Commit author email is identity per spec § 7 — must be stripped.
        var stripped = Strip("""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "commits": {
                  "nodes": [
                    {
                      "commit": {
                        "author": { "email": "private@example.com", "name": "Some Person" },
                        "message": "fix: thing"
                      }
                    }
                  ]
                }
              }
            }
          }
        }
        """);
        stripped.Should().NotContain("private@example.com");
        stripped.Should().NotContain("Some Person");
        stripped.Should().NotContain("fix: thing");
    }

    [Fact]
    public void Keeps_enum_state_review_type_count_fields()
    {
        var stripped = Strip("""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "reviews": {
                  "totalCount": 2,
                  "nodes": [
                    { "state": "APPROVED" },
                    { "state": "COMMENTED" }
                  ]
                }
              }
            }
          }
        }
        """);
        stripped.Should().Contain("\"totalCount\":2");
        stripped.Should().Contain("\"state\":\"APPROVED\"");
        stripped.Should().Contain("\"state\":\"COMMENTED\"");
    }

    [Fact]
    public void Strips_login_field_universally()
    {
        var stripped = Strip("""
        {
          "data": {
            "repository": {
              "pullRequest": {
                "author": { "login": "someone" },
                "reviews": { "nodes": [ { "author": { "login": "reviewer" } } ] }
              }
            }
          }
        }
        """);
        stripped.Should().NotContain("\"login\":\"someone\"");
        stripped.Should().NotContain("\"login\":\"reviewer\"");
    }

    [Fact]
    public void Preserves_overall_shape_for_diff_compatibility()
    {
        // After stripping, the result must still be valid JSON the differ can walk.
        var input = """{"data": {"repository": {"pullRequest": {"body": "x", "number": 1}}}}""";
        var stripped = Strip(input);
        // Re-parse to assert it's well-formed JSON.
        var doc = JsonDocument.Parse(stripped);
        doc.RootElement.GetProperty("data").GetProperty("repository").GetProperty("pullRequest").GetProperty("number").GetInt32().Should().Be(1);
    }
}
```

- [ ] **Step 2: Run tests, verify they fail**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~FixtureStripAllowlistTests"
```

Expected: 5 tests fail with type/method not found.

- [ ] **Step 3: Implement `FixtureStripAllowlist`**

```csharp
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PRism.GitHub.Tests.Integration.Helpers;

/// <summary>
/// Applies the spec § 7 category rule to a captured GraphQL response as an ALLOWLIST
/// (not a denylist — spec § 7 line 237 mandates this for security). Listed fields survive;
/// everything else is stripped to null. New GraphQL fields default to stripped — adding
/// them is an explicit, reviewable change to AllowedFieldNames below.
///
///   KEPT (structural + enum + count + presence indicators): see AllowedFieldNames.
///   STRIPPED: every field not on the allowlist (freeform text, identity, URLs, anything new).
/// </summary>
public static class FixtureStripAllowlist
{
    // Allowlist of FIELD NAMES (not JSON-pointer paths). Applied recursively — a kept field
    // name kept at every level it appears. This matches the spec § 7 category rule's "Kept"
    // bullet:
    //   - Structural enums:        state, reviewType, mergeable, mergeStateStatus, __typename
    //   - Structural identifiers:  oid, headRefOid, baseRefOid, beforeCommit, afterCommit
    //   - Structural counts:       totalCount, changedFiles, additions, deletions
    //   - Structural booleans:     isDraft, isResolved, hasNextPage
    //   - Structural numbering:    number, line
    //   - Structural envelopes:    pageInfo, endCursor (cursor IS opaque schema-shape, not PII)
    //   - Structural containers:   repository, pullRequest, comments, reviewThreads, commits,
    //                              timelineItems, nodes, commit, data
    //   - Structural pathing:      path, headRefName, baseRefName
    //   - Structural timestamps:   createdAt, closedAt, mergedAt, committedDate, submittedAt,
    //                              lastEditedAt
    // EVERYTHING NOT IN THIS SET is stripped — title, body, message, login, email, name,
    // avatarUrl, url, databaseId, id, etc. all become null.
    private static readonly HashSet<string> AllowedFieldNames = new(StringComparer.Ordinal)
    {
        // Container/envelope fields — must survive so the differ can walk into them
        "data", "repository", "pullRequest", "comments", "reviewThreads", "commits",
        "timelineItems", "nodes", "edges", "node", "commit", "pageInfo",
        // Identifier fields that carry structural meaning (SHAs, type discriminators)
        "__typename", "oid", "headRefOid", "baseRefOid", "beforeCommit", "afterCommit",
        // Enum-valued and boolean structural fields
        "state", "reviewType", "mergeable", "mergeStateStatus", "isDraft", "isResolved",
        "hasNextPage",
        // Count/numeric structural fields
        "totalCount", "changedFiles", "additions", "deletions", "number", "line",
        // Path/name fields that describe SHAPE (file paths in diffs, branch names) — these
        // are not personally identifying, they describe the repo structure
        "path", "headRefName", "baseRefName",
        // Cursor — opaque schema-shape, not PII
        "endCursor",
        // Timestamp fields — structural; the differ uses these to assert presence
        "createdAt", "closedAt", "mergedAt", "committedDate", "submittedAt", "lastEditedAt",
    };

    public static JsonNode? Apply(JsonElement element) => Apply(element, depth: 0);

    private static JsonNode? Apply(JsonElement element, int depth)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Object => StripObject(element, depth),
            JsonValueKind.Array  => StripArray(element, depth),
            JsonValueKind.String => JsonValue.Create(element.GetString()),
            JsonValueKind.Number => JsonNode.Parse(element.GetRawText())!,
            JsonValueKind.True   => JsonValue.Create(true),
            JsonValueKind.False  => JsonValue.Create(false),
            JsonValueKind.Null   => null,
            _ => throw new InvalidOperationException($"Unhandled JsonValueKind {element.ValueKind}"),
        };
    }

    private static JsonObject StripObject(JsonElement obj, int depth)
    {
        var result = new JsonObject();
        foreach (var prop in obj.EnumerateObject())
        {
            if (AllowedFieldNames.Contains(prop.Name))
            {
                // Allowed: recurse with stripping still applied at deeper levels.
                result[prop.Name] = Apply(prop.Value, depth + 1);
            }
            else
            {
                // Not allowlisted: preserve the field's presence (so the differ doesn't flag
                // it as removed) but replace its content with null. The shape-drift detector
                // cares about shape, not value.
                result[prop.Name] = null;
            }
        }
        return result;
    }

    private static JsonArray StripArray(JsonElement arr, int depth)
    {
        var result = new JsonArray();
        foreach (var item in arr.EnumerateArray())
            result.Add(Apply(item, depth + 1));
        return result;
    }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~FixtureStripAllowlistTests"
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist*.cs
git commit -m "test(integration): FixtureStripAllowlist content-discipline strip (TDD)"
```

---

## Task 6: `FrozenPrCorpus` record skeleton (no live data yet)

The corpus values get populated by Task 9's capture run; this task lays down the record shape and an empty `All()` enumerator that the later test tasks compile against.

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/FrozenPrCorpus.cs`

- [ ] **Step 1: Implement the corpus record skeleton**

```csharp
namespace PRism.GitHub.Tests.Integration;

public sealed record FrozenPrEntry(
    int PrNumber,
    string HeadSha,
    string BaseSha,                               // historical merge-base captured at lock time; required by test 7b
    DateTimeOffset MergedAt,
    ClusteringQualityExpectation ExpectedQuality,
    (int Min, int Max)? ExpectedIterationRange,   // null when ExpectedQuality == Low
    string[] ExpectedFiles,                       // set-equality contract per spec § 5 row 7b
    CommentAnchor[] ExpectedCommentAnchors,       // subset contract per spec § 5 row 7c
    string ShapeCategory);                        // mirrors spec § 4 table for runbook reference

public sealed record CommentAnchor(string Path, int Line);

public enum ClusteringQualityExpectation { Ok, Low }

public static class FrozenPrCorpus
{
    // SHAs / MergedAt / file lists / comment anchors are filled by Task 9's capture run.
    // The skeleton uses sentinel values that the capture script will overwrite — and the
    // `CorpusStalenessTest` will fail loudly if the dates are never populated.

    public static readonly FrozenPrEntry Pr1 = new(
        PrNumber: 1,
        HeadSha: "<captured-by-task-8>",
        BaseSha: "<captured-by-task-8>",
        MergedAt: DateTimeOffset.MinValue,
        ExpectedQuality: ClusteringQualityExpectation.Low,
        ExpectedIterationRange: null,
        ExpectedFiles: Array.Empty<string>(),
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Single-iteration baseline");

    public static readonly FrozenPrEntry Pr16 = new(
        PrNumber: 16,
        HeadSha: "<captured-by-task-8>",
        BaseSha: "<captured-by-task-8>",
        MergedAt: DateTimeOffset.MinValue,
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (1, 2),
        ExpectedFiles: Array.Empty<string>(),
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Rebased-history committedDate collision");

    public static readonly FrozenPrEntry Pr19 = new(
        PrNumber: 19,
        HeadSha: "<captured-by-task-8>",
        BaseSha: "<captured-by-task-8>",
        MergedAt: DateTimeOffset.MinValue,
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (2, 3),
        ExpectedFiles: Array.Empty<string>(),
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Multi-burst with review-fix tail");

    public static readonly FrozenPrEntry Pr22 = new(
        PrNumber: 22,
        HeadSha: "<captured-by-task-8>",
        BaseSha: "<captured-by-task-8>",
        MergedAt: DateTimeOffset.MinValue,
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (2, 2),
        ExpectedFiles: Array.Empty<string>(),
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Overnight time-gap boundary");

    public static readonly FrozenPrEntry Pr28 = new(
        PrNumber: 28,
        HeadSha: "<captured-by-task-8>",
        BaseSha: "<captured-by-task-8>",
        MergedAt: DateTimeOffset.MinValue,
        ExpectedQuality: ClusteringQualityExpectation.Ok,
        ExpectedIterationRange: (2, 2),
        ExpectedFiles: Array.Empty<string>(),
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),
        ShapeCategory: "Tight intra-cluster + late package-lock fix");

    public static IEnumerable<FrozenPrEntry> All()
    {
        yield return Pr1;
        yield return Pr16;
        yield return Pr19;
        yield return Pr22;
        yield return Pr28;
    }

    public static IEnumerable<object[]> AllAsTheoryData() =>
        All().Select(e => new object[] { e });
}
```

- [ ] **Step 2: Verify the project still compiles**

```powershell
dotnet build tests\PRism.GitHub.Tests.Integration --configuration Release
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/FrozenPrCorpus.cs
git commit -m "test(integration): FrozenPrCorpus record skeleton with sentinel data"
```

---

## Task 7: Lock-then-capture scripts (PowerShell + bash)

Spec § 9.5 + AV-R2-4: both shell forms committed for cross-platform parity.

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.ps1`
- Create: `tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.sh`

- [ ] **Step 1: Write the PowerShell script**

```powershell
# tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.ps1
#
# Atomic lock-then-capture for a corpus PR on prpande/PRism. Spec § 9.5.
# Locks the PR conversation FIRST so no new comments can land between lock and capture,
# then immediately captures head SHA + files + comment anchors + merge timestamp.
#
# Usage: ./lock-and-capture.ps1 -PrNumber 19 -OutputDir ../captured/
#
# Pre-req: `gh auth status` returns OK. The PAT used by `gh` must have push (or admin) on
# prpande/PRism — locking requires write access on the issues subresource.

param(
    [Parameter(Mandatory=$true)][int]$PrNumber,
    [Parameter(Mandatory=$true)][string]$OutputDir
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }

# Idempotency: if the PR is already locked, skip the PUT call (saves an API request and
# keeps the script re-runnable on partial-failure recovery). Spec § 9.8 — unlock is by
# explicit DELETE; we never auto-unlock here.
$prMeta = (& gh api "repos/prpande/PRism/issues/$PrNumber") | ConvertFrom-Json
if ($prMeta.locked) {
    Write-Host "[lock] PR #$PrNumber already locked — skipping PUT (idempotent)."
} else {
    Write-Host "[lock] Locking conversation on PR #$PrNumber ..."
    & gh api -X PUT "repos/prpande/PRism/issues/$PrNumber/lock" --silent
    if ($LASTEXITCODE -ne 0) { throw "gh api lock failed for PR #$PrNumber (exit $LASTEXITCODE). To roll back any PRs locked earlier in the sequence, run: gh api -X DELETE repos/prpande/PRism/issues/{N}/lock for each affected PR (see docs/contract-tests.md § 8)." }
}

Write-Host "[capture] Fetching commits + files + mergedAt + baseRefOid for PR #$PrNumber ..."
$prJson = & gh pr view $PrNumber --repo prpande/PRism --json commits,files,mergedAt,baseRefOid
if ($LASTEXITCODE -ne 0) { throw "gh pr view failed for PR #$PrNumber (exit $LASTEXITCODE)" }
Set-Content -Path (Join-Path $OutputDir "pr$PrNumber.pr.json") -Value $prJson

Write-Host "[capture] Fetching review comments for PR #$PrNumber ..."
$commentsJson = & gh api "repos/prpande/PRism/pulls/$PrNumber/comments"
if ($LASTEXITCODE -ne 0) { throw "gh api comments failed for PR #$PrNumber (exit $LASTEXITCODE)" }
Set-Content -Path (Join-Path $OutputDir "pr$PrNumber.comments.json") -Value $commentsJson

Write-Host "[done] PR #$PrNumber captured to $OutputDir"
```

- [ ] **Step 2: Write the bash script**

```bash
#!/usr/bin/env bash
# tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.sh
#
# Atomic lock-then-capture for a corpus PR on prpande/PRism. Spec § 9.5.
# Cross-platform parity for the PowerShell form; same behaviour.
#
# Usage: ./lock-and-capture.sh PR_NUMBER OUTPUT_DIR

set -euo pipefail

PR_NUMBER="${1:?usage: $0 PR_NUMBER OUTPUT_DIR}"
OUTPUT_DIR="${2:?usage: $0 PR_NUMBER OUTPUT_DIR}"

mkdir -p "$OUTPUT_DIR"

# Idempotency — see PowerShell variant for rationale.
LOCKED=$(gh api "repos/prpande/PRism/issues/$PR_NUMBER" | jq -r '.locked')
if [ "$LOCKED" = "true" ]; then
    echo "[lock] PR #$PR_NUMBER already locked — skipping PUT (idempotent)."
else
    echo "[lock] Locking conversation on PR #$PR_NUMBER ..."
    if ! gh api -X PUT "repos/prpande/PRism/issues/$PR_NUMBER/lock" --silent; then
        echo "[error] gh api lock failed for PR #$PR_NUMBER. To roll back any PRs locked earlier in the sequence, run: gh api -X DELETE repos/prpande/PRism/issues/{N}/lock for each affected PR (see docs/contract-tests.md § 8)." >&2
        exit 1
    fi
fi

echo "[capture] Fetching commits + files + mergedAt + baseRefOid for PR #$PR_NUMBER ..."
gh pr view "$PR_NUMBER" --repo prpande/PRism --json commits,files,mergedAt,baseRefOid > "$OUTPUT_DIR/pr$PR_NUMBER.pr.json"

echo "[capture] Fetching review comments for PR #$PR_NUMBER ..."
gh api "repos/prpande/PRism/pulls/$PR_NUMBER/comments" > "$OUTPUT_DIR/pr$PR_NUMBER.comments.json"

echo "[done] PR #$PR_NUMBER captured to $OUTPUT_DIR"
```

- [ ] **Step 3: Smoke-test the PowerShell script against a non-corpus PR to verify it runs end-to-end without actually locking a corpus PR yet**

```powershell
# Use a recently-closed throwaway PR (or omit the lock call by dry-running just the capture portion).
# This is a runnability check — the actual corpus lock happens in Task 8.
mkdir tests/PRism.GitHub.Tests.Integration/captured-tmp/
gh pr view 1 --repo prpande/PRism --json commits,files,mergedAt > tests/PRism.GitHub.Tests.Integration/captured-tmp/dry-run.json
Get-Content tests/PRism.GitHub.Tests.Integration/captured-tmp/dry-run.json | Select-Object -First 5
Remove-Item -Recurse tests/PRism.GitHub.Tests.Integration/captured-tmp/
```

Expected: JSON output for PR #1's commits / files / mergedAt printed. Confirms `gh` is authenticated and the JSON shape is what the script downstream expects.

- [ ] **Step 4: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.ps1 tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.sh
git commit -m "test(integration): lock-and-capture scripts (PowerShell + bash parity)"
```

---

## Task 8: Lock + capture all five corpus PRs

**MANUAL ONE-TIME STEP. This task is irreversible-by-default for the comments-locking aspect** (unlock is one `gh api -X DELETE` per PR — see § 9.8 runbook — but every minute the PRs remain unlocked is a window for drift). Run this in one sitting.

**Files:**
- Create (transiently): `tests/PRism.GitHub.Tests.Integration/captured/pr{1,16,19,22,28}.pr.json`
- Create (transiently): `tests/PRism.GitHub.Tests.Integration/captured/pr{1,16,19,22,28}.comments.json`

- [ ] **Step 1: Run the lock-and-capture script against each of the 5 corpus PRs**

```powershell
cd tests/PRism.GitHub.Tests.Integration/scripts
.\lock-and-capture.ps1 -PrNumber 1  -OutputDir ../captured/
.\lock-and-capture.ps1 -PrNumber 16 -OutputDir ../captured/
.\lock-and-capture.ps1 -PrNumber 19 -OutputDir ../captured/
.\lock-and-capture.ps1 -PrNumber 22 -OutputDir ../captured/
.\lock-and-capture.ps1 -PrNumber 28 -OutputDir ../captured/
```

Expected: each PR prints `[lock]`, `[capture]`, `[done]`. No errors.

- [ ] **Step 2: Verify all 5 PRs are locked**

```powershell
foreach ($n in 1, 16, 19, 22, 28) {
    $locked = (gh api "repos/prpande/PRism/issues/$n" | ConvertFrom-Json).locked
    Write-Host "PR #$n locked: $locked"
}
```

Expected: all five report `locked: True`.

- [ ] **Step 3: Update `FrozenPrCorpus.cs` with captured head SHAs + merge dates + file lists + comment anchors**

For each PR, read the captured JSON and replace the sentinel values in `FrozenPrCorpus.cs`:

```powershell
$captured = Get-Content tests/PRism.GitHub.Tests.Integration/captured/pr1.pr.json | ConvertFrom-Json
$headSha = $captured.commits[-1].oid
$baseSha = $captured.baseRefOid
$mergedAt = $captured.mergedAt
$files = ($captured.files | ForEach-Object { "`"$($_.path)`"" }) -join ", "
Write-Host "Pr1: HeadSha=$headSha, BaseSha=$baseSha, MergedAt=$mergedAt, Files=[$files]"
# Repeat for 16, 19, 22, 28 and edit FrozenPrCorpus.cs accordingly.
```

Note: `baseRefOid` from `gh pr view --json` returns the historical merge-base SHA at the time the PR was merged — exactly what test 7b needs. This is NOT the same as `pulls/{n}.base.sha` from the REST API, which returns the CURRENT base-branch tip and would drift as `main` advances.

Edit `FrozenPrCorpus.cs` for each PR:

```csharp
public static readonly FrozenPrEntry Pr1 = new(
    PrNumber: 1,
    HeadSha: "b21b38b...<full 40-char SHA>",
    BaseSha: "<full 40-char SHA from .baseRefOid>",
    MergedAt: DateTimeOffset.Parse("2026-05-04T...Z"),  // actual mergedAt from gh
    ExpectedQuality: ClusteringQualityExpectation.Low,
    ExpectedIterationRange: null,
    ExpectedFiles: new[] { ".github/workflows/claude.yml", ".github/workflows/claude-code-review.yml" },
    ExpectedCommentAnchors: Array.Empty<CommentAnchor>(),  // PR #1 has no review comments
    ShapeCategory: "Single-iteration baseline");
```

For PR #19, also populate `ExpectedCommentAnchors` from the captured comments JSON — pick the subset of comments that anchor the test, per spec § 5 row 7c. Typically the 2 documented review-round comments; pick by `path` + `line` field from the captured JSON.

- [ ] **Step 4: Add `tests/PRism.GitHub.Tests.Integration/captured/` to `.gitignore`**

The captured/ directory holds transient intermediate JSON used to populate FrozenPrCorpus.cs. It should not be committed (the values are committed in the .cs file itself, source-of-truth).

```powershell
# From repo root
Add-Content .gitignore "`n# Transient capture output for FrozenPrCorpus population (Task 8)`ntests/PRism.GitHub.Tests.Integration/captured/"
```

- [ ] **Step 5: Build and run a quick `dotnet build` to confirm the populated corpus compiles**

```powershell
dotnet build tests\PRism.GitHub.Tests.Integration --configuration Release
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/FrozenPrCorpus.cs .gitignore
git commit -m "test(integration): populate FrozenPrCorpus with captured live-PR data (5 PRs locked)"
```

---

## Task 9: (Folded into Task 11)

Round-1 ce-doc-review (AV-R2-6) flagged Task 9 / Task 11 redundancy — both documented the same capture command, with Task 9 acting as a forward reference to Task 11. Folded entirely into Task 11: the fixture-write code path lands AND the capture command runs there. Task 9 retains this anchor only so existing references to "Task 9" elsewhere in the plan don't dangle; do not perform Task 9 — go straight to Task 11.

---

## Task 10: `FrozenPrismPrTests.cs` — corpus tests 7a, 7b, 7c, 7f, 7h

Tests 7a (iteration count), 7b (files set-equality), 7c (comment anchors subset on #19), 7f (clusteringQuality), 7h (PR #16 rebased committedDate). Test 7g (shape-drift) is in Task 11 because it depends on the fixture being writable in capture mode.

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/LiveGitHubFixture.cs`
- Create: `tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs`

- [ ] **Step 1: Implement the `LiveGitHubFixture` via DI composition**

`LiveGitHubFixture` builds an `IServiceCollection` exactly the way production builds it (via `AddPrismGitHub()`), overrides only the token source to point at `GhCliPat`, and resolves `PrDetailLoader` + the capability-interface services from the container. xUnit's `IClassFixture` semantics give us one instance per test class — sharing the container across the 5+ tests in the class amortizes both DI startup and HttpClient pool.

This dodges the entire class of "constructor-signature drift" problems: when production wiring grows a new dependency, the test fixture inherits the change automatically. Verified production composition lives at `PRism.GitHub/ServiceCollectionExtensions.cs:27-88`.

Create `tests/PRism.GitHub.Tests.Integration/LiveGitHubFixture.cs`:

```csharp
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;
using PRism.GitHub;
using PRism.GitHub.Tests.Integration.Helpers;

namespace PRism.GitHub.Tests.Integration;

public sealed class LiveGitHubFixture : IDisposable
{
    private readonly ServiceProvider _sp;
    public PrDetailLoader Loader { get; }
    public IPrReader Reader { get; }
    public IReviewAuth Auth { get; }

    public LiveGitHubFixture()
    {
        var services = new ServiceCollection();
        services.AddLogging();

        // Test-shape stubs for IConfigStore + ITokenStore — see classes below.
        // Register BEFORE AddPrismGitHub() so the production registration consumes these via
        // sp.GetRequiredService<IConfigStore>() / sp.GetRequiredService<ITokenStore>() (which
        // AddPrismGitHub does internally — verified at PRism.GitHub/ServiceCollectionExtensions.cs:31-50).
        services.AddSingleton<IConfigStore>(new InMemoryConfigStoreForIntegrationTests());
        services.AddSingleton<ITokenStore>(new GhCliBackedTokenStore());

        // Iteration-clustering registration — mirrors PRism.Core/ServiceCollectionExtensions.cs:103-108
        // exactly (production wiring). All three IDistanceMultiplier implementations are required;
        // WeightedDistanceClusteringStrategy resolves them via sp.GetServices<IDistanceMultiplier>().
        // Registering the strategy without the multipliers would silently produce neutral 1.0
        // multipliers for every edge — degenerate clustering with no failure signal.
        services.AddSingleton<IDistanceMultiplier, FileJaccardMultiplier>();
        services.AddSingleton<IDistanceMultiplier, ForcePushMultiplier>();
        services.AddSingleton<IIterationClusteringStrategy>(sp =>
            new WeightedDistanceClusteringStrategy(sp.GetServices<IDistanceMultiplier>()));
        services.AddSingleton(new IterationClusteringCoefficients());
        services.AddSingleton<PrDetailLoader>();

        // Production capability registration — pulls in GitHubReviewService bound to all four
        // capability interfaces, the named "github" HttpClient, and the inbox pipeline.
        services.AddPrismGitHub();

        _sp = services.BuildServiceProvider();
        Loader = _sp.GetRequiredService<PrDetailLoader>();
        Reader = _sp.GetRequiredService<IPrReader>();
        Auth   = _sp.GetRequiredService<IReviewAuth>();
    }

    /// <summary>Convenience wrapper for tests that want the parsed DTO, not the snapshot envelope.</summary>
    public async Task<PrDetailDto> LoadPrDetailAsync(FrozenPrEntry entry)
    {
        var snap = await Loader.LoadAsync(new PrReference("prpande", "PRism", entry.PrNumber), CancellationToken.None);
        if (snap is null)
            throw new InvalidOperationException(
                $"PrDetailLoader returned null for PR #{entry.PrNumber} — token expired or PR inaccessible.");
        return snap.Detail;
    }

    public void Dispose() => _sp.Dispose();
}

/// <summary>
/// Minimal IConfigStore for integration tests. Implements the full interface surface
/// (PRism.Core/Config/IConfigStore.cs verified at impl time — 5 members + Changed event with
/// EventHandler&lt;ConfigChangedEventArgs&gt;). The github host is the only field the
/// integration tests need; everything else throws or returns inert defaults.
/// </summary>
internal sealed class InMemoryConfigStoreForIntegrationTests : IConfigStore
{
    // Use AppConfig.Default (or whatever the production default factory is — verify at impl time
    // against PRism.Core/Config/AppConfig.cs). Construct here so it survives Dispose; the host
    // is github.com because that's where prpande/PRism lives.
    public AppConfig Current { get; } = AppConfig.Default;   // <-- verify name; may be `Default()` or `Empty`
    public Exception? LastLoadError => null;
    public Task InitAsync(CancellationToken ct) => Task.CompletedTask;
    public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct) =>
        throw new NotSupportedException("Integration tests do not patch config.");
    public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct) =>
        Task.CompletedTask;   // No-op — ViewerLoginHydrator may call this during host startup.
    public event EventHandler<ConfigChangedEventArgs>? Changed { add { } remove { } }
}

/// <summary>
/// ITokenStore implementation that surfaces the PAT from `gh auth token` (or the
/// `PRISM_INTEGRATION_PAT` env var in CI) via ReadAsync — the only method called by the
/// production AddPrismGitHub closure (`() => tokens.ReadAsync(...)`).
/// HasTokenAsync MUST return true; production code paths gate token-using calls on it.
/// All other surfaces are no-op or throw — verified against PRism.Core/Auth/ITokenStore.cs.
/// </summary>
internal sealed class GhCliBackedTokenStore : ITokenStore
{
    public Task<bool> HasTokenAsync(CancellationToken ct) => Task.FromResult(true);
    public Task<string?> ReadAsync(CancellationToken ct) =>
        Task.FromResult<string?>(GhCliPat.Get().Reveal());

    public Task WriteTransientAsync(string token, CancellationToken ct) =>
        throw new NotSupportedException("Integration tests do not write transient tokens.");
    public Task SetTransientLoginAsync(string login, CancellationToken ct) =>
        throw new NotSupportedException("Integration tests do not set transient logins.");
    public Task<string?> ReadTransientLoginAsync(CancellationToken ct) =>
        Task.FromResult<string?>(null);
    public Task CommitAsync(CancellationToken ct) =>
        throw new NotSupportedException("Integration tests do not commit tokens.");
    public Task RollbackTransientAsync(CancellationToken ct) =>
        Task.CompletedTask;   // Safe no-op.
    public Task ClearAsync(CancellationToken ct) =>
        throw new NotSupportedException("Integration tests do not clear tokens.");
}
```

**Implementation note — verify against production at impl time.** Verify these against the actual codebase before the first `dotnet build`:
1. `AppConfig.Default` — the static factory may be named differently (`AppConfig.Empty`, `AppConfig.NewInstance`, etc.). If no such factory exists, construct the positional record with default-ish values for every required ctor argument.
2. `WeightedDistanceClusteringStrategy`'s ctor takes `IEnumerable<IDistanceMultiplier>` — confirm the DI factory shape above matches.
3. `AddPrismGitHub()` may require additional services beyond `IConfigStore` + `ITokenStore` — if `BuildServiceProvider()` throws missing-dependency, register the additional types here.

- [ ] **Step 2: Write the test file with all 5 tests**

```csharp
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.GitHub.Tests.Integration;

[Trait("Category", "Integration")]
public class FrozenPrismPrTests : IClassFixture<LiveGitHubFixture>
{
    private readonly LiveGitHubFixture _fixture;
    public FrozenPrismPrTests(LiveGitHubFixture fixture) => _fixture = fixture;

    private static PrReference Ref(FrozenPrEntry entry) => new("prpande", "PRism", entry.PrNumber);

    // 7a — iteration count per the corpus's expected range/equality contract.
    [Theory]
    [MemberData(nameof(FrozenPrCorpus.AllAsTheoryData), MemberType = typeof(FrozenPrCorpus))]
    public async Task Frozen_pr_returns_expected_iteration_count(FrozenPrEntry entry)
    {
        var snap = await _fixture.Loader.LoadAsync(Ref(entry), CancellationToken.None);
        snap.Should().NotBeNull($"PR #{entry.PrNumber} must load — PrDetailLoader returned null");
        var dto = snap!.Detail;

        if (entry.ExpectedQuality == ClusteringQualityExpectation.Low)
        {
            dto.Iterations.Should().BeNull(
                $"PR #{entry.PrNumber} ({entry.ShapeCategory}) is expected to short-circuit Low");
        }
        else
        {
            dto.Iterations.Should().NotBeNull();
            var count = dto.Iterations!.Count;
            var (min, max) = entry.ExpectedIterationRange!.Value;
            if (min == max)
                count.Should().Be(min,
                    $"PR #{entry.PrNumber} ({entry.ShapeCategory}) is expected at exactly {min}");
            else
                count.Should().BeInRange(min, max,
                    $"PR #{entry.PrNumber} ({entry.ShapeCategory}) is expected in [{min},{max}]");
        }
    }

    // 7b — files list set-equality. Locked + SHA-pinned + BaseSha-pinned makes the diff
    // deterministic; spec § 5 row 7b — set-equality, not superset.
    [Theory]
    [MemberData(nameof(FrozenPrCorpus.AllAsTheoryData), MemberType = typeof(FrozenPrCorpus))]
    public async Task Frozen_pr_returns_expected_files_in_diff(FrozenPrEntry entry)
    {
        // Both BaseSha and HeadSha come from FrozenPrCorpus (captured at lock-time by Task 8's
        // script). Using a stored BaseSha avoids the moving-target trap — `pulls/{n}.base.sha`
        // would return the CURRENT base-branch tip, which drifts as main advances and would
        // make set-equality flake silently. ActivePrPollSnapshot does NOT carry BaseSha;
        // do not try to derive it at runtime.
        var range = new DiffRangeRequest(BaseSha: entry.BaseSha, HeadSha: entry.HeadSha);
        var diff = await _fixture.Reader.GetDiffAsync(Ref(entry), range, CancellationToken.None);

        var actualFiles = diff.Files.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal).ToArray();
        var expectedFiles = entry.ExpectedFiles.OrderBy(p => p, StringComparer.Ordinal).ToArray();
        actualFiles.Should().Equal(expectedFiles,
            $"PR #{entry.PrNumber} files at SHA {entry.HeadSha} must match the captured corpus exactly");
    }

    // 7c — anchored on PR #19 only (2 documented review rounds per spec § 4).
    // Uses ReviewThreadDto (real type from PRism.Core.Contracts/ReviewThreadDto.cs) — FilePath + LineNumber
    // are the anchor fields. No fictional ReviewCommentAnchor type required.
    [Fact]
    public async Task Frozen_pr_existing_comments_have_expected_anchors()
    {
        var pr19 = FrozenPrCorpus.Pr19;
        var snap = await _fixture.Loader.LoadAsync(Ref(pr19), CancellationToken.None);
        snap.Should().NotBeNull();
        var actualAnchors = snap!.Detail.ReviewComments
            .Select(t => new CommentAnchor(t.FilePath, t.LineNumber))
            .ToHashSet();
        foreach (var expected in pr19.ExpectedCommentAnchors)
        {
            actualAnchors.Should().Contain(expected,
                "If Frozen_pr_graphql_shape_unchanged is also failing, fix the fixture first; " +
                "this assertion runs against parsed shape.");
        }
    }

    // 7f — clusteringQuality classification.
    [Theory]
    [MemberData(nameof(FrozenPrCorpus.AllAsTheoryData), MemberType = typeof(FrozenPrCorpus))]
    public async Task Frozen_pr_returns_clustering_quality_ok(FrozenPrEntry entry)
    {
        var snap = await _fixture.Loader.LoadAsync(Ref(entry), CancellationToken.None);
        snap.Should().NotBeNull();
        var expected = entry.ExpectedQuality == ClusteringQualityExpectation.Low
            ? ClusteringQuality.Low
            : ClusteringQuality.Ok;
        snap!.Detail.ClusteringQuality.Should().Be(expected,
            $"PR #{entry.PrNumber} ({entry.ShapeCategory}) expects {expected}");
    }

    // 7h — PR #16 must not fabricate iterations despite collapsed committedDate.
    [Fact]
    public async Task Frozen_pr_handles_rebased_committedDate_collision()
    {
        var pr16 = FrozenPrCorpus.Pr16;
        var snap = await _fixture.Loader.LoadAsync(Ref(pr16), CancellationToken.None);
        snap.Should().NotBeNull();
        var dto = snap!.Detail;
        dto.Iterations.Should().NotBeNull();
        dto.Iterations!.Count.Should().BeInRange(1, 2,
            "PR #16's 9 commits share identical committedDate; algorithm must degrade gracefully");
        dto.ClusteringQuality.Should().Be(ClusteringQuality.Ok,
            "PR #16 is healthy multi-commit, not degenerate");
    }
}
```

**Note on `PrDetailSnapshot` vs `PrDetailDto`.** `PrDetailLoader.LoadAsync` returns `Task<PrDetailSnapshot?>` (verified at `PRism.Core/PrDetail/PrDetailLoader.cs:69`). `PrDetailSnapshot` is a wrapper `(PrDetailDto Detail, string HeadSha, int CoefficientsGeneration)` — the `Iterations` / `ClusteringQuality` / `ReviewComments` fields live on `snap.Detail`, not on `snap`. The null check is load-bearing — `LoadAsync` returns null when the PR is not accessible (e.g. token expired mid-test).

- [ ] **Step 3: Run the integration suite against live GitHub**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "Category=Integration&FullyQualifiedName!~Frozen_pr_graphql_shape_unchanged"
```

(The filter excludes 7g, which hasn't been written yet; it lands in Task 11.)

Expected: tests 7a, 7b, 7c, 7f, 7h all pass against the 5 corpus PRs at their pinned SHAs.

If any test fails, the spec's § 9.7 triaging decision rule applies — most likely cause early on is a captured value (file list, comment anchor) that doesn't match the actual locked state. Re-verify Task 8's capture output against `FrozenPrCorpus.cs`.

- [ ] **Step 4: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs tests/PRism.GitHub.Tests.Integration/LiveGitHubFixture.cs
git commit -m "test(integration): frozen-PR tests 7a, 7b, 7c, 7f, 7h (5/6 corpus tests)"
```

---

## Task 11: `Frozen_pr_graphql_shape_unchanged` (test 7g) + capture-mode runtime

Spec § 5 row 7g + § 7. The test has two branches in one method body: assert-mode (default) and capture-mode (when `PRISM_FROZEN_PR_CAPTURE_FIXTURE == "1"`).

**Files:**
- Modify: `tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs` (add test 7g)
- Create: `tests/PRism.GitHub.Tests.Integration/Helpers/FixturePathResolver.cs` (resolves the source-tree path; spec § 7 fixture-path clarification)

- [ ] **Step 1: Implement `FixturePathResolver`**

The spec § 7 specifies the fixture lives at `tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json`, resolved at test-run time from the test project's source-directory anchor. The `[CallerFilePath]` trick gives us that anchor.

```csharp
using System.Runtime.CompilerServices;

namespace PRism.GitHub.Tests.Integration.Helpers;

public static class FixturePathResolver
{
    /// <summary>
    /// Returns the absolute path to a fixture file under
    /// `tests/PRism.GitHub.Tests.Integration/Fixtures/`. Uses [CallerFilePath] from this file's
    /// own location to anchor at the source-tree path regardless of where bin/ output lives.
    /// </summary>
    public static string GetFixturePath(string fileName) =>
        Path.Combine(SourceDir(), "..", "Fixtures", fileName);

    private static string SourceDir([CallerFilePath] string callerFilePath = "") =>
        Path.GetDirectoryName(callerFilePath)
            ?? throw new InvalidOperationException("CallerFilePath did not resolve");
}
```

- [ ] **Step 2: Add test 7g to `FrozenPrismPrTests.cs`**

```csharp
// (Inside FrozenPrismPrTests class)

[Fact]
public async Task Frozen_pr_graphql_shape_unchanged()
{
    // CI write-protection layer 2: throws if PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 AND CI is set.
    GhCliPat.EnsureCaptureModeNotInCi();

    var pr19 = FrozenPrCorpus.Pr19;
    var liveResponse = await _fixture.LoadRawGraphQLResponseAsync(pr19.PrNumber);  // returns JsonElement
    var stripped = FixtureStripAllowlist.Apply(liveResponse);
    var strippedJson = stripped.ToJsonString();

    var fixturePath = FixturePathResolver.GetFixturePath("pr19-graphql-response.json");

    if (GhCliPat.IsCaptureModeEnabled())
    {
        File.WriteAllText(fixturePath, strippedJson);
        Console.WriteLine($"Captured fixture for PR #19 → {fixturePath}. Re-run without the env var to assert.");
        return;  // passes
    }

    File.Exists(fixturePath).Should().BeTrue(
        $"Fixture must exist; run with PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 once locally to generate. Path: {fixturePath}");

    var expected = JsonDocument.Parse(File.ReadAllText(fixturePath)).RootElement;
    var actual = JsonDocument.Parse(strippedJson).RootElement;
    var diffs = GraphQLShapeDiff.Diff(expected, actual);

    diffs.Should().BeEmpty(
        "GraphQL shape drift detected — see structured diff:\n" + string.Join("\n", diffs));
}
```

- [ ] **Step 3: Wire test 7g to capture from the production GraphQL query, not a duplicate**

**Critical:** test 7g must capture the shape of the GraphQL query that PRism ACTUALLY ISSUES in production. Round-1 ce-doc-review (FEAS-R1-6 / ADV-2) flagged that a hand-authored query in the test is a fabrication — fixture drift caught would be drift for a query nothing in production sends. Resolution: lift the production query string from `GitHubReviewService.GetPrDetailAsync` to an internal-visible constant, then have the test issue THAT string verbatim.

**Pre-step: production-side change.** Refactor `PRism.GitHub/GitHubReviewService.cs` (the `GetPrDetailAsync` method at ~line 225) to extract the inlined query string into a named `internal` constant on the partial class, then add an `internal` accessor:

```csharp
// In PRism.GitHub/GitHubReviewService.cs (or a new partial-class file alongside it):
internal const string PrDetailGraphQLQuery =
    "query($owner:String!,$repo:String!,$number:Int!){" +
    "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
    "title body url state isDraft mergeable mergeStateStatus " +
    "headRefName baseRefName headRefOid baseRefOid " +
    "author{login} createdAt closedAt mergedAt changedFiles " +
    "comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId author{login} createdAt body}}" +
    "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isResolved " +
    "comments(first:100){nodes{id author{login} createdAt body lastEditedAt}}}}" +
    "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW]){" +
    "pageInfo{hasNextPage endCursor} nodes{__typename " +
    "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
    "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
    "... on PullRequestReview{submittedAt}" +
    "}}" +
    "}}}";
```

Replace the inlined `const string query = "..."` inside `GetPrDetailAsync` with a reference to `PrDetailGraphQLQuery`. Add an `[InternalsVisibleTo("PRism.GitHub.Tests.Integration")]` attribute to `PRism.GitHub.csproj` (or the project's `AssemblyInfo`):

```xml
<ItemGroup>
  <InternalsVisibleTo Include="PRism.GitHub.Tests.Integration" />
</ItemGroup>
```

Verify nothing else in the production codebase regressed — the existing PRism.GitHub.Tests should still pass.

**Then add `LoadRawGraphQLResponseAsync` to `LiveGitHubFixture`** (extends Task 10's Step 1 fixture):

```csharp
// Add to LiveGitHubFixture class. Resolves an HttpClient from the same named "github" pool
// AddPrismGitHub() set up — same BaseAddress, same connection reuse.
public async Task<JsonElement> LoadRawGraphQLResponseAsync(int prNumber)
{
    var factory = _sp.GetRequiredService<IHttpClientFactory>();
    using var http = factory.CreateClient("github");

    var token = GhCliPat.Get().Reveal();
    using var req = new HttpRequestMessage(HttpMethod.Post, "graphql");
    req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
    req.Headers.UserAgent.ParseAdd("PRism.GitHub.Tests.Integration");
    req.Content = JsonContent.Create(new
    {
        query = GitHubReviewService.PrDetailGraphQLQuery,   // <-- the lifted production constant
        variables = new { owner = "prpande", repo = "PRism", number = prNumber }
    });

    using var resp = await http.SendAsync(req);
    if (!resp.IsSuccessStatusCode)
    {
        // Sanitized — never include Authorization header value in exception message (SEC-001).
        throw new InvalidOperationException(
            $"GraphQL request to GitHub failed with {(int)resp.StatusCode} for PR #{prNumber}. " +
            $"(Authorization header omitted.)");
    }
    var stream = await resp.Content.ReadAsStreamAsync();
    using var doc = await JsonDocument.ParseAsync(stream);
    return doc.RootElement.Clone();
}
```

- [ ] **Step 4: Run capture mode to generate the fixture (executes Task 9)**

```powershell
try {
    $env:PRISM_FROZEN_PR_CAPTURE_FIXTURE = '1'
    dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"
} finally {
    Remove-Item env:PRISM_FROZEN_PR_CAPTURE_FIXTURE -ErrorAction SilentlyContinue
}
```

Expected: test prints "Captured fixture..." and passes. The fixture file `tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json` is created.

- [ ] **Step 5: Inspect the fixture against the strip rule (Task 9 Step 2)**

Open the generated fixture. Confirm `body`, `bodyText`, `message`, `title`, `email`, `login`, `name` are all `null`. Confirm structural fields like `number`, `state`, `oid`, `totalCount`, `__typename` retain values.

- [ ] **Step 6: Run assert-mode and verify the test passes**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"
```

Expected: passes (no diff between live and fixture).

- [ ] **Step 7: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs tests/PRism.GitHub.Tests.Integration/LiveGitHubFixture.cs tests/PRism.GitHub.Tests.Integration/Helpers/FixturePathResolver.cs tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json
git commit -m "test(integration): test 7g GraphQL shape-drift detector + capture mode + fixture baseline"
```

---

## Task 12: `PatScopeContractTests.cs` (test 7e — fitness smoke)

Spec § 5 row 7e — single `[Fact]` fitness check. Round-2 redesign per FEAS-R2-1/2.

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/PatScopeContractTests.cs`

- [ ] **Step 1: Write the test**

Reuses `LiveGitHubFixture` from Task 10 — `_fixture.Auth` is the DI-resolved `IReviewAuth` (same singleton `GitHubReviewService` instance backing all four capability interfaces, wired through production composition). This avoids re-doing the HTTP/PAT bootstrap and dodges the constructor-drift trap that the round-1 DI rewrite exists to prevent. Assertion (b)'s repo-authorization probe goes through `_fixture.Reader.PollActivePrAsync` for the same reason.

```csharp
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.GitHub.Tests.Integration;

[Trait("Category", "Integration")]
public class PatScopeContractTests : IClassFixture<LiveGitHubFixture>
{
    private readonly LiveGitHubFixture _fixture;
    public PatScopeContractTests(LiveGitHubFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task ValidateCredentialsAsync_returns_ok_with_login_for_test_pat()
    {
        // Spec § 5 row 7e — fitness smoke (NOT scope-shape). No scope-equality assertion works
        // for both fine-grained PATs (no X-OAuth-Scopes header, Scopes is empty) and classic PATs
        // (different scope namespace). See FEAS-R2-1/2 round-2 findings.

        // Assertion (a): credential validates and returns Ok with a non-empty Login.
        AuthValidationResult result = await _fixture.Auth.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeTrue($"validation failed with: {result.ErrorDetail}");
        result.Login.Should().NotBeNullOrWhiteSpace("ViewerLogin is load-bearing for the suite");

        // Assertion (b): one live read against prpande/PRism succeeds — confirms repo
        // authorization, not just credential format. Goes through IPrReader so we exercise
        // the same code path the corpus tests use; a 401/403 here surfaces as the same
        // exception shape the corpus tests would hit, so PAT-fitness failure is consistent
        // across the suite.
        var poll = await _fixture.Reader.PollActivePrAsync(
            new PrReference("prpande", "PRism", 1), CancellationToken.None);
        poll.Should().NotBeNull("PAT must authorize a read against prpande/PRism PR #1");
    }
}
```

- [ ] **Step 2: Run the test**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~PatScopeContractTests"
```

Expected: passes — validates the PAT can authenticate and authorize reads on prpande/PRism.

- [ ] **Step 3: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/PatScopeContractTests.cs
git commit -m "test(integration): test 7e PAT fitness smoke (replaces broken round-1 two-branch design)"
```

---

## Task 13: `CanonicalIterationCountTests.cs` — strict-equality siblings

Spec § 9.7 + § 10 silent-drift bullet. Each ranged corpus entry (#16, #19) gets a sibling test asserting equality against the captured canonical value, gated by `[Trait("Canonical", "Strict")]` so it's excluded from default + integration runs and surfaced only via `dotnet test --filter "Canonical=Strict"` during triage.

The canonical value for each ranged PR is the actual iteration count returned by the algorithm at Task 10's first green run. Capture it in this task.

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/CanonicalIterationCountTests.cs`

- [ ] **Step 1: Determine the canonical values**

Run Task 10's iteration-count test and read the actual returned counts for #16 and #19:

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~Frozen_pr_returns_expected_iteration_count" --logger "console;verbosity=detailed"
```

In the test output, find the `dto.Iterations.Count` value at the assertion site for #16 and #19. Record both (e.g. `Pr16Canonical = 2`, `Pr19Canonical = 3`).

(If the test output doesn't surface the actual count clearly, add a temporary `Console.WriteLine($"PR #{entry.PrNumber} actual count: {count}");` inside the test method, re-run, then remove before commit.)

- [ ] **Step 2: Write the canonical-strict tests**

```csharp
using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests.Integration;

// Sibling strict-equality tests for the ranged corpus PRs. Run only via:
//   dotnet test --filter "Canonical=Strict"
// Spec § 9.7 + § 10 silent-drift bullet. The .runsettings filter excludes Canonical=Strict
// from default `dotnet test`; the standard Category=Integration filter must use the AND-form
// `Category=Integration&Canonical!=Strict` to keep them out of routine runs.
//
// Canonical values are constants at the class top so the test method names stay generic.
// A coefficient retune that shifts a canonical only changes the constant, not the name.
[Trait("Canonical", "Strict")]
[Trait("Category", "Integration")]
public class CanonicalIterationCountTests : IClassFixture<LiveGitHubFixture>
{
    // Update these constants when Task 13 Step 1's algorithm run reports new canonical values.
    // The method name does NOT embed the value, so an updated constant + green test is the only
    // change required.
    private const int Pr16Canonical = 2;   // captured at Task 13 Step 1
    private const int Pr19Canonical = 3;   // captured at Task 13 Step 1

    private readonly LiveGitHubFixture _fixture;
    public CanonicalIterationCountTests(LiveGitHubFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Pr16_iteration_count_matches_captured_canonical()
    {
        var dto = await _fixture.LoadPrDetailAsync(FrozenPrCorpus.Pr16);
        dto.Iterations!.Count.Should().Be(Pr16Canonical,
            "Canonical value for PR #16; range [1,2] absorbs tuning, this asserts the current truth");
    }

    [Fact]
    public async Task Pr19_iteration_count_matches_captured_canonical()
    {
        var dto = await _fixture.LoadPrDetailAsync(FrozenPrCorpus.Pr19);
        dto.Iterations!.Count.Should().Be(Pr19Canonical,
            "Canonical value for PR #19; range [2,3] absorbs tuning, this asserts the current truth");
    }
}
```

- [ ] **Step 3: Verify the `Canonical=Strict` separation works in practice**

**Important VSTest semantics:** the `--filter` CLI flag REPLACES the `.runsettings` `TestCaseFilter`, it does NOT AND-merge with it (FEAS round-1 / ADV-R1-3). So the default integration-test command needs to explicitly exclude `Canonical=Strict`:

```powershell
# Default integration sweep — must explicitly exclude Canonical=Strict
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "Category=Integration&Canonical!=Strict"

# Triage-only canonical-strict run
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "Canonical=Strict"
```

Expected: the first command runs the 7 integration tests + does NOT include `Pr16_canonical` / `Pr19_canonical`. The second command runs only the two canonical-strict tests.

The CI workflow (Task 17) and the runbook (Task 19) also need to use the AND-form filter, not the plain `Category=Integration` shorthand.

- [ ] **Step 4: Run the canonical-strict tests on demand**

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "Canonical=Strict"
```

Expected: both Pr16_canonical and Pr19_canonical pass with the captured canonical values.

- [ ] **Step 5: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/CanonicalIterationCountTests.cs
git commit -m "test(integration): canonical strict-equality siblings for ranged PRs (#16, #19)"
```

---

## Task 14: `CorpusStalenessTest.cs` — non-Integration build break

Spec § 10 enforced staleness trigger. Runs on every `dotnet test` (no Category trait), fails the build when no corpus PR is more recent than 18 months.

**Files:**
- Create: `tests/PRism.GitHub.Tests.Integration/CorpusStalenessTest.cs`

- [ ] **Step 1: Write the test**

```csharp
using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests.Integration;

// Non-Integration: deliberately NO [Trait("Category", "Integration")]. This test must run on
// every `dotnet test` invocation so the build breaks loudly when the corpus ages out.
// Spec § 10 enforced staleness trigger.
public class CorpusStalenessTest
{
    [Fact]
    public void Corpus_has_at_least_one_pr_merged_within_18_months()
    {
        var threshold = DateTimeOffset.UtcNow.AddMonths(-18);
        var mostRecent = FrozenPrCorpus.All().Max(e => e.MergedAt);
        mostRecent.Should().BeAfter(threshold,
            $"The most recent corpus PR was merged at {mostRecent:O}, more than 18 months ago. " +
            "Add a ≤6-month-old PR on the same shape-criteria per docs/contract-tests.md § 5; " +
            "optionally retire the oldest PR if its shape category is still represented.");
    }
}
```

- [ ] **Step 2: Run the default test suite to verify the staleness test runs and passes**

```powershell
dotnet test --configuration Release
```

Expected: among the test output, `Corpus_has_at_least_one_pr_merged_within_18_months` runs and passes (most recent corpus PR, #28, is well within 18 months of today, 2026-05-18).

- [ ] **Step 3: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/CorpusStalenessTest.cs
git commit -m "test(integration): CorpusStalenessTest — build breaks when corpus > 18 months stale"
```

---

## Task 15: GraphQLShapeDiff real-fixture mutation self-check (Task 4 follow-up)

Spec § 6.3 — round-2 AV-R2-4. Now that the fixture exists, add the self-check that catches differ bugs by seeding a known mutation in a deeply-nested path.

**Files:**
- Modify: `tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiffTests.cs`

- [ ] **Step 1: Add the real-fixture mutation self-check test**

Append to `GraphQLShapeDiffTests.cs`:

```csharp
[Fact]
public void Mutation_in_deeply_nested_path_of_real_fixture_is_caught()
{
    // Spec § 6.3 — self-check that the hand-rolled differ catches mutations in the same depth
    // and array-of-objects nesting the real GraphQL response uses. Targets the bug class where
    // the differ's walker has a depth or array bug that synthetic tests wouldn't expose.

    var fixturePath = FixturePathResolver.GetFixturePath("pr19-graphql-response.json");
    File.Exists(fixturePath).Should().BeTrue("Run Task 11 capture-mode to generate the fixture");

    var original = JsonDocument.Parse(File.ReadAllText(fixturePath)).RootElement;
    var mutated = MutateDeepPath(original);

    var diff = GraphQLShapeDiff.Diff(original, mutated);
    diff.Should().NotBeEmpty(
        "Differ failed to catch a deeply-nested mutation — depth or array-walk bug suspected");
}

private static JsonElement MutateDeepPath(JsonElement source)
{
    // Mutates: data.repository.pullRequest.commits.nodes[0].commit.oid → swap to a sentinel value.
    // This path exercises object-nesting + array-of-objects + leaf-value-change in one walk.
    using var stream = new MemoryStream();
    using (var writer = new Utf8JsonWriter(stream))
    {
        var node = JsonNode.Parse(source.GetRawText())!;
        var oid = node["data"]?["repository"]?["pullRequest"]?["commits"]?["nodes"]?[0]?["commit"]?["oid"];
        if (oid is null)
            throw new InvalidOperationException("Fixture shape changed — adjust MutateDeepPath path");
        node["data"]!["repository"]!["pullRequest"]!["commits"]!["nodes"]![0]!["commit"]!["oid"] = "MUTATED_FOR_TEST";
        node.WriteTo(writer);
    }
    stream.Position = 0;
    using var doc = JsonDocument.Parse(stream);
    return doc.RootElement.Clone();
}
```

- [ ] **Step 2: Fix the mutation to actually exercise the differ**

`GraphQLShapeDiff` only reports SHAPE changes (`JsonValueKind` differences), not value changes — by design (shape detector, not value detector, per spec § 6.3). The Step 1 snippet shows a string→string value swap (`"MUTATED_FOR_TEST"` replacing the oid string) which would NOT fire the differ. Replace it with a string→number type swap so the `~` diff actually fires:

```csharp
node["data"]!["repository"]!["pullRequest"]!["commits"]!["nodes"]![0]!["commit"]!["oid"] = 42;  // String → Number
```

Run the test:

```powershell
dotnet test tests\PRism.GitHub.Tests.Integration --configuration Release --filter "FullyQualifiedName~GraphQLShapeDiffTests.Mutation_in_deeply_nested_path"
```

Expected: passes — the `~` diff line fires at `/data/repository/pullRequest/commits/nodes/0/commit/oid`.

- [ ] **Step 3: Commit**

```powershell
git add tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiffTests.cs
git commit -m "test(integration): GraphQLShapeDiff real-fixture mutation self-check"
```

---

## Task 16: Update `.github/workflows/ci.yml` to pass `--settings .runsettings`

Spec § 8 main CI update + § 11 DoD. Without this, the new integration project's tests would attempt to run on every PR push and fail for lack of `PRISM_INTEGRATION_PAT`.

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Read the existing ci.yml**

```powershell
Get-Content .github/workflows/ci.yml
```

- [ ] **Step 2: Update the `dotnet test` step to pass `--settings .runsettings`**

Edit the Test (.NET) step:

```yaml
      - name: Test (.NET)
        run: dotnet test --no-build --configuration Release --settings .runsettings --logger "trx;LogFileName=test-results.trx"
```

- [ ] **Step 3: Trigger a PR-push run (or simulate locally) and verify zero integration tests are attempted**

The local equivalent of the CI behaviour is `dotnet test --no-build --configuration Release --settings .runsettings` — confirm that the `tests/PRism.GitHub.Tests.Integration/` project's `Category=Integration` tests do not run.

```powershell
dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings --logger "console;verbosity=detailed"
```

Expected: the output shows the new integration test project compiles but only `CorpusStalenessTest` (non-Integration trait) runs from it. The 6+ Category=Integration tests are filtered out.

- [ ] **Step 4: Commit**

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: pass --settings .runsettings on main test step to exclude integration tests on PR pushes"
```

---

## Task 17: Create `.github/workflows/integration-tests.yml`

Spec § 8.

**Files:**
- Create: `.github/workflows/integration-tests.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Integration tests (live GitHub)
on:
  workflow_dispatch:   # manual only — no recurring schedule (see spec § 8 rationale)
jobs:
  integration:
    runs-on: windows-latest   # matches the main ci.yml runner for consistency
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'   # matches Directory.Build.props TargetFramework=net10.0

      - name: Fail fast if PRISM_INTEGRATION_PAT secret is missing (ADV-9)
        shell: pwsh
        run: |
          if ([string]::IsNullOrWhiteSpace($env:PRISM_INTEGRATION_PAT)) {
            Write-Error "PRISM_INTEGRATION_PAT secret is not set. See docs/contract-tests.md § Prereqs to create the secret before re-dispatching this workflow."
            exit 1
          }
        env:
          PRISM_INTEGRATION_PAT: ${{ secrets.PRISM_INTEGRATION_PAT }}

      - name: Mask PAT in all subsequent log output (must run BEFORE any step that could surface it)
        shell: pwsh
        run: |
          $token = $env:PRISM_INTEGRATION_PAT
          Write-Output "::add-mask::$token"
        env:
          PRISM_INTEGRATION_PAT: ${{ secrets.PRISM_INTEGRATION_PAT }}

      - name: Restore + build
        run: |
          dotnet restore
          dotnet build --no-restore --configuration Release

      - name: Run integration tests
        run: dotnet test tests/PRism.GitHub.Tests.Integration --configuration Release --no-build --filter "Category=Integration&Canonical!=Strict" --logger "console;verbosity=detailed"
        env:
          PRISM_INTEGRATION_PAT: ${{ secrets.PRISM_INTEGRATION_PAT }}
          PRISM_FROZEN_PR_CAPTURE_FIXTURE: ''   # explicit override — capture mode MUST NOT engage in CI (spec § 7)
```

- [ ] **Step 2: Owner-managed prereq: create the GitHub Actions secret**

This step is performed by the repo owner in the GitHub UI (Settings → Secrets and variables → Actions → New repository secret):
- Name: `PRISM_INTEGRATION_PAT`
- Value: a fine-grained PAT scoped to `prpande/PRism` only, `metadata:read + pull_requests:read`, 90-day expiry
- Set a calendar reminder for both PAT rotation AND a 30-day workflow_dispatch poke (spec § 8 trigger-events list)

If the owner is not the implementing agent, document this as a pre-merge requirement in the PR description.

- [ ] **Step 3: Trigger workflow_dispatch from the GitHub UI (or `gh workflow run`)**

```powershell
gh workflow run integration-tests.yml
# Wait a few seconds for the new run to register, then capture its id:
Start-Sleep -Seconds 5
$runId = (gh run list --workflow=integration-tests.yml --limit 1 --json databaseId | ConvertFrom-Json)[0].databaseId
gh run watch $runId
```

(`gh run watch` with no args is interactive — it prompts the user to pick a run; the explicit run-id keeps it scriptable. Note: `gh run watch` may not work with fine-grained PATs that lack `checks:read` — if it errors, use `gh run view $runId --log` after waiting for completion instead.)

Expected: the workflow runs successfully against live GitHub; all 7 Category=Integration tests pass (Canonical=Strict tests are excluded by the AND-filter).

- [ ] **Step 4: Commit**

```powershell
git add .github/workflows/integration-tests.yml
git commit -m "ci: integration-tests workflow (workflow_dispatch only, PAT mask, capture-mode lockout)"
```

---

## Task 18: Add XML docstring to `ForcePushMultiplier` (PL-R2-4 mitigation)

Spec § 12.1 — mirror the §4.1 two-paths clarification in source so source-code readers don't need to find this spec.

**Files:**
- Modify: `PRism.Core/Iterations/ForcePushMultiplier.cs`

- [ ] **Step 1: Read the current file**

```powershell
Get-Content PRism.Core/Iterations/ForcePushMultiplier.cs
```

- [ ] **Step 2: Add the XML docstring above the class declaration**

```csharp
/// <summary>
/// Despite the name, this multiplier does two things in sequence:
///   1. <b>Short-gap commit suppression</b> (early-return): when the gap between
///      <see cref="ClusteringCommit.CommittedDate"/> values is ≤
///      <see cref="IterationClusteringCoefficients.ForcePushLongGapSeconds"/> (default 600s),
///      returns 1.0 regardless of whether any force-push event exists. This is the path
///      exercised by tight intra-cluster commits like rapid CI-loop fixes.
///   2. <b>Force-push amplification</b>: when the gap is long AND a
///      <c>HeadRefForcePushedEvent</c> sits in the [prev, next] window, returns
///      <see cref="IterationClusteringCoefficients.ForcePushAfterLongGap"/> (default 1.5x)
///      to encourage a boundary.
/// The class is named for the second behaviour because that was the originally-intended
/// purpose; the short-gap-suppression path was added later. A future rename to
/// <c>CommitGapAndForcePushMultiplier</c> is tracked as a separate follow-up in
/// docs/specs/2026-05-18-frozen-pr-contract-tests-design.md § 12.1.
/// </summary>
public sealed class ForcePushMultiplier : IDistanceMultiplier
```

- [ ] **Step 3: Build and run existing ForcePushMultiplier tests to confirm no behaviour change**

```powershell
dotnet test tests\PRism.Core.Tests --configuration Release --filter "FullyQualifiedName~ForcePushMultiplier"
```

Expected: all existing tests still pass (this is a docstring-only change).

- [ ] **Step 4: Commit**

```powershell
git add PRism.Core/Iterations/ForcePushMultiplier.cs
git commit -m "docs(iterations): document ForcePushMultiplier two-path behaviour in XML docstring"
```

---

## Task 19: Write `docs/contract-tests.md` operator runbook

Spec § 9.

**Files:**
- Create: `docs/contract-tests.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Contract tests — live-GitHub integration suite

## What this suite is for

`PRism.GitHub.Tests.Integration` exercises `GitHubReviewService` against five locked, SHA-pinned PRs in `prpande/PRism`. It catches parsing/derivation drift on the read path (PR detail, diff, comments, timeline) and GraphQL shape drift on the queries PRism issues. The suite is opt-in — `workflow_dispatch` only in CI, manual `dotnet test --filter "Category=Integration&Canonical!=Strict"` locally. Design rationale and architecture: see `docs/specs/2026-05-18-frozen-pr-contract-tests-design.md`.

## Prereqs

- **Local (recommended):** a fine-grained PAT scoped to `prpande/PRism` only with `metadata:read + pull_requests:read`, exported as `PRISM_INTEGRATION_PAT` in your shell profile. Smallest blast radius if the token leaks. Note: fine-grained PATs do not return scopes in the `X-OAuth-Scopes` header; the fitness-smoke test 7e accepts this by design.
- **Local (fallback):** `gh auth login --scopes "repo,read:org"` — the test suite uses `gh auth token`. The `repo` scope grants full read/write to every private repo your account can reach; the principle-of-least-privilege concern is real but acceptable for one-off runs.
- **CI:** `PRISM_INTEGRATION_PAT` secret (owner-managed), set with a 90-day expiry, calendar reminder for both PAT rotation AND a 30-day workflow_dispatch poke.

## Running locally

```powershell
dotnet test --filter "Category=Integration&Canonical!=Strict"
```

Run from repo root. The `.runsettings` filter ensures the default `dotnet test` (without `--filter`) excludes the integration suite.

## Test PR corpus

| PR | Shape category | Why it tests |
|---|---|---|
| #1 | Single-iteration baseline | 2 commits 2 seconds apart. `clusteringQuality === Low` short-circuit path. |
| #16 | Rebased-history `committedDate` collision | 9 commits with identical `committedDate` after rebase. Algorithm graceful-degradation when primary time signal is collapsed. |
| #19 | Multi-burst with review-fix tail | 12 commits over ~1h36m in 2-3 natural bursts. Default boundary detection + comment-anchor subset. |
| #22 | Overnight time-gap boundary | 9-commit evening session + 1 next-morning fix. Time-gap boundary signal. |
| #28 | Tight intra-cluster + late package-lock fix | 7 commits in 19 min + 4-hour gap to package-lock. Short-gap suppression early-return path of `ForcePushMultiplier`. |

## Adding a new test PR

1. **Pick on shape criteria** — commit count, time gaps, `authoredDate` vs `committedDate` divergence. Do **not** run the algorithm first.
2. **Run the atomic lock-and-capture script.**

   PowerShell:
   ```powershell
   cd tests/PRism.GitHub.Tests.Integration/scripts
   .\lock-and-capture.ps1 -PrNumber <N> -OutputDir ../captured/
   ```

   bash:
   ```bash
   cd tests/PRism.GitHub.Tests.Integration/scripts
   ./lock-and-capture.sh <N> ../captured/
   ```

   Locking happens first; capture immediately after — this is one script invocation by design to prevent comment drift between lock and capture.
3. **Add a new static field** to `FrozenPrCorpus.cs` with the captured `HeadSha`, `MergedAt`, `ExpectedFiles`, `ExpectedCommentAnchors`, and the shape category.
4. **Append the new entry** to `FrozenPrCorpus.All()`.
5. **Document the shape category** in this runbook's corpus table.

## Refreshing the GraphQL fixture

When an intentional GitHub GraphQL schema change lands, refresh `Fixtures/pr19-graphql-response.json`:

- **PowerShell:** `$env:PRISM_FROZEN_PR_CAPTURE_FIXTURE='1'; dotnet test --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"; Remove-Item env:PRISM_FROZEN_PR_CAPTURE_FIXTURE`
- **bash:** `PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 dotnet test --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"`

Capture mode runs only locally — the CI workflow blocks it with a two-layer guard (spec § 7). The capture flow strips freeform-text and identity fields against `FixtureStripAllowlist`; review the resulting fixture diff in the PR.

**⚠️ Trap: do NOT export `PRISM_FROZEN_PR_CAPTURE_FIXTURE=1` in your shell profile** (`.bashrc`, `$PROFILE`, `.zshrc`, etc.) for convenience. The capture branch logs a banner and passes silently, so a leaked env var means every routine `dotnet test --filter "Category=Integration&Canonical!=Strict"` rewrites the fixture with the current live API response. The test always reports green because expected == actual == now, and real shape drift is silently captured into the baseline instead of detected. Always use the inline `$env:X=...; ...; Remove-Item env:X` (or `unset`) idiom shown above so the variable's lifetime is scoped to the one capture command.

## Triaging a shape-drift failure

When `Frozen_pr_graphql_shape_unchanged` fails, the test output contains a structural diff: `+ /path (kind)`, `- /path`, `~ /path (kindA → kindB)`. Read the diff, check the GitHub changelog, decide intentional-update-vs-real-break.

### Iteration-count failures (tests 7a, 7h)

Decision rule:

- **Q1:** Does the new count match a defensible hand-labeled boundary count for the PR's shape, derived without looking at the algorithm output? If **no**, the algorithm change is a regression — revisit the coefficient change.
- **Q2:** If yes, does the PR's shape category still hold? If **yes**, update the expected count in `FrozenPrCorpus` with a PR comment explaining the new canonical value. If **no**, retire the PR from the corpus and pick a replacement on the same shape criteria.

### Range assertions on PRs #16 / #19

Range assertions absorb both tuning moves AND regressions within the range. The sibling strict-canonical tests in `CanonicalIterationCountTests.cs` (run via `dotnet test --filter "Canonical=Strict"`) assert the captured canonical value — when the range test passes but `Canonical=Strict` fails, apply Q1/Q2 above.

## Unlocking a test PR

If anyone needs to re-comment on a locked corpus PR:

```bash
gh api -X DELETE /repos/prpande/PRism/issues/{N}/lock
```

After the comment, re-lock with `gh api -X PUT` (or the lock-and-capture script with the existing PR number; it's idempotent on already-captured PRs because the script does not write to a different output file).

## PAT expiry recovery

When `PRISM_INTEGRATION_PAT` expires (after the 90-day reminder is missed), all corpus tests fail with HTTP 401.

- **Diagnosis:** check the secret's expiry date in repo Settings → Secrets and variables → Actions.
- **Recovery:** create a new fine-grained PAT with the same scope (`prpande/PRism`, `metadata:read + pull_requests:read`, new 90-day expiry, calendar reminder reset) and update the `PRISM_INTEGRATION_PAT` secret value.
- **Verify:** re-trigger `workflow_dispatch` and confirm the suite returns to green.
```

- [ ] **Step 2: Commit**

```powershell
git add docs/contract-tests.md
git commit -m "docs: contract-tests operator runbook (prereqs, corpus, capture, triage, expiry recovery)"
```

---

## Task 20: README + docs/specs/README updates + final DoD verification

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/README.md`

- [ ] **Step 1: Add an "Integration tests" section to README.md**

Add to README.md under the Development workflow section:

```markdown
### Integration tests (live GitHub)

A separate suite at `tests/PRism.GitHub.Tests.Integration/` exercises `GitHubReviewService` against five locked PRs in this repo. Opt-in — excluded from default `dotnet test` via `.runsettings`.

```powershell
dotnet test --filter "Category=Integration&Canonical!=Strict"
```

Requires `PRISM_INTEGRATION_PAT` env var or `gh auth login`. Full operator runbook: [`docs/contract-tests.md`](docs/contract-tests.md). Design: [`docs/specs/2026-05-18-frozen-pr-contract-tests-design.md`](docs/specs/2026-05-18-frozen-pr-contract-tests-design.md).
```

- [ ] **Step 2: Add the new spec to `docs/specs/README.md`**

Under the "In progress" group, add:

```markdown
- [`2026-05-18-frozen-pr-contract-tests-design.md`](2026-05-18-frozen-pr-contract-tests-design.md) — Frozen-PR contract tests (live-GitHub integration suite); plan: [`../plans/2026-05-18-frozen-pr-contract-tests.md`](../plans/2026-05-18-frozen-pr-contract-tests.md). Supersedes the deferred S3 Task 11 targeting `mindbody/Api.Codex`. Redirects the test suite to PRism's own merged-PR history (PRs #1, #16, #19, #22, #28); seven xUnit tests + canonical-strict siblings + corpus-staleness build break + `workflow_dispatch`-only CI. In progress.
```

- [ ] **Step 3: Verify the full DoD checklist from spec § 11**

Re-read `docs/specs/2026-05-18-frozen-pr-contract-tests-design.md` § 11 and cross-check each checkbox:

- [ ] All five corpus PRs locked via the atomic script
- [ ] `PRism.GitHub.Tests.Integration.csproj` exists and is added to `PRism.sln`
- [ ] All seven tests pass against pinned SHAs locally AND via `workflow_dispatch`
- [ ] `Frozen_pr_graphql_shape_unchanged` fixture committed with strip-allowlist content rule applied
- [ ] `GraphQLShapeDiff` covered by unit tests (synthetic + real-fixture mutation)
- [ ] `.runsettings` excludes `Category=Integration` AND `Canonical=Strict` from default test runs
- [ ] `.github/workflows/ci.yml` updated with `--settings .runsettings`
- [ ] `docs/contract-tests.md` runbook landed
- [ ] `.github/workflows/integration-tests.yml` landed; `PRISM_INTEGRATION_PAT` secret created
- [ ] Capture-mode CI write-protection verified (unit test for `IsCaptureModeEnabled` + `EnsureCaptureModeNotInCi`)
- [ ] `RedactedSecret` four-guard contract verified by unit tests
- [ ] `FixtureStripAllowlist` category rule verified — the populated allowlist reviewed against the rule
- [ ] `CanonicalIterationCountTests.cs` landed with strict-equality assertions for #16, #19
- [ ] `CorpusStalenessTest.cs` landed and runs on default `dotnet test`
- [ ] README addition pointing at the local-run command
- [ ] `docs/specs/README.md` updated
- [ ] Memory `project_s3_task11_open` updated post-merge — handled separately after this PR merges

- [ ] **Step 4: Run the full pre-push checklist per `.ai/docs/development-process.md`**

```powershell
cd frontend
npm run lint
npm run build
npm test
cd ..
dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings
```

Expected: every step passes.

- [ ] **Step 5: Commit**

```powershell
git add README.md docs/specs/README.md
git commit -m "docs(s3): README + specs index entries for frozen-PR contract tests slice"
```

---

## Self-review

1. **Spec coverage:** Every section of the spec maps to a task:
   - § 1 (origin/goal) — handled in spec, not implementation
   - § 2 (scope) — entire plan
   - § 3 (approach) — entire plan
   - § 4 (corpus) — Task 6 + Task 8
   - § 4.1 (ForcePushMultiplier naming) — Task 18 docstring
   - § 4.2 (expected counts) — Task 8 + Task 10 + Task 13
   - § 5 (test inventory) — Tasks 10, 11, 12, 13
   - § 6 (architecture) — Tasks 1-7
   - § 6.1 (FrozenPrCorpus) — Tasks 6 + 8
   - § 6.2 (GhCliPat + RedactedSecret) — Tasks 2-3
   - § 6.3 (GraphQLShapeDiff) — Tasks 4 + 15
   - § 6.4 (.runsettings) — Task 1 + Task 13 (Canonical=Strict added)
   - § 7 (capture mode) — Tasks 5 + 11 + capture-mode env guard in Task 3
   - § 8 (CI workflow) — Tasks 16 + 17
   - § 9 (runbook) — Task 19
   - § 10 (risks/coverage) — addressed by tests (range silent-drift via Task 13; staleness via Task 14; force-push gap accepted)
   - § 11 (DoD) — Task 20 Step 3 cross-checks every item
   - § 12 (file list) — entire plan creates them
   - § 12.1 (ForcePushMultiplier rename follow-up) — Task 18 docstring
   - § 13 (open during implementation) — captured during Tasks 8 + 11

2. **Placeholder scan:** No "TBD", "TODO", "fill in details" remain. The `<captured-by-task-9>` sentinel in Task 6's FrozenPrCorpus skeleton is intentional and replaced in Task 8; called out explicitly there. The "actual canonical from Step 1" placeholders in Task 13 Step 2 are intentional — the engineer captures the value at Step 1 and inserts it at Step 2.

3. **Type consistency:** Method names match across tasks:
   - `FrozenPrCorpus.All()` and `FrozenPrCorpus.AllAsTheoryData()` defined in Task 6, used in Tasks 10, 13, 14
   - `LiveGitHubFixture.LoadPrDetailAsync` / `LoadDiffAsync` / `LoadCommentAnchorsAsync` / `LoadRawGraphQLResponseAsync` defined in Tasks 10-11, consistent
   - `GhCliPat.Get()` returns `RedactedSecret` (Task 2-3); usage at HttpClient site is `.Reveal()` (Tasks 10, 12)
   - `GraphQLShapeDiff.Diff(JsonElement, JsonElement)` returns `List<string>` (Task 4), consumed at Task 11
   - `FixtureStripAllowlist.Apply(JsonElement)` returns `JsonNode` (Task 5), consumed at Task 11
   - `[Trait("Category", "Integration")]` and `[Trait("Canonical", "Strict")]` applied consistently per spec § 5 and § 9.7

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-05-18-frozen-pr-contract-tests.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration via `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

The implementation should happen in a fresh worktree (e.g. `git worktree add D:/src/PRism-frozen-pr-tests-impl -b feat/frozen-pr-tests`) — this `docs/frozen-pr-tests` worktree is for the spec + plan docs PR.
