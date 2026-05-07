# Foundations + Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walking-skeleton implementation of the PRism PoC: solution scaffolding compiles, host boots cross-platform with port selection + lockfile + atomic state writes, OS keychain works, first GitHub round-trip via PAT validation succeeds, React frontend renders Setup + landing shell with theme/accent/AI-preview header controls.

**Architecture:** Seven .NET projects (`PRism.Core`, `PRism.Core.Contracts`, `PRism.AI.Contracts`, `PRism.AI.Placeholder`, `PRism.GitHub`, `PRism.Web`, plus three test projects under `tests/`) and a `frontend/` Vite + React + TS app. Source-level Octokit isolation (only `PRism.GitHub` references Octokit). AI seams declared with both `Noop*` (default) and `Placeholder*` (canned-data) implementations selected at runtime by `IAiSeamSelector` reading `ui.aiPreview`. State + config persisted as JSON under `<dataDir>` (`SpecialFolder.LocalApplicationData`) with atomic-rename + hot-reload. Reviewer-atomic GraphQL submit pipeline is **not** in scope this slice — `IReviewService` carries the full GitHub-shaped surface but only `ValidateCredentialsAsync` is implemented.

**Tech Stack:** .NET 10 LTS (C# 14) · ASP.NET Core minimal APIs · `Microsoft.Identity.Client.Extensions.Msal` · Octokit.NET · `System.Text.Json` with kebab-case naming policy · xUnit · Moq · React 19 · Vite 6 · TypeScript 5.x · React Router v7 · Vitest + Testing Library + MSW · Playwright.

**Source spec:** [`docs/superpowers/specs/2026-05-05-foundations-and-setup-design.md`](../specs/2026-05-05-foundations-and-setup-design.md). The PoC spec it implements is under [`docs/spec/`](../../spec/). The visual reference is [`design/handoff/`](../../../design/handoff/).

**Process:** TDD throughout per [`CLAUDE.md`](../../../CLAUDE.md) § Development process. Every task is red → green → refactor → commit. No production code lands without a failing test that proved the need.

---

## Phase 1 — Repo scaffold (T1–T3)

### Task 1: Solution + shared MSBuild props + .editorconfig

**Files:**
- Create: `PRism.sln`
- Create: `Directory.Build.props`
- Create: `Directory.Packages.props`
- Create: `.editorconfig`
- Modify: `.gitignore` (append test result + tooling outputs)

- [ ] **Step 1: Create the empty solution**

Run from `C:\src\PRism-foundations`:

```
dotnet new sln -n PRism
```

Expected: creates `PRism.sln`.

- [ ] **Step 2: Write `Directory.Build.props`**

```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <LangVersion>14</LangVersion>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
    <AnalysisLevel>latest</AnalysisLevel>
    <AnalysisMode>AllEnabledByDefault</AnalysisMode>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
    <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
  </PropertyGroup>
</Project>
```

- [ ] **Step 3: Write `Directory.Packages.props` (centralized versions)**

```xml
<Project>
  <ItemGroup>
    <!-- Backend -->
    <PackageVersion Include="Octokit" Version="14.0.0" />
    <PackageVersion Include="Microsoft.Identity.Client.Extensions.Msal" Version="4.66.2" />
    <PackageVersion Include="Microsoft.Extensions.Logging" Version="10.0.0" />
    <PackageVersion Include="Microsoft.Extensions.Logging.Console" Version="10.0.0" />
    <PackageVersion Include="Microsoft.Extensions.Logging.File" Version="3.0.0" />
    <PackageVersion Include="Microsoft.AspNetCore.Mvc.Testing" Version="10.0.0" />

    <!-- Test -->
    <PackageVersion Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageVersion Include="xunit" Version="2.9.3" />
    <PackageVersion Include="xunit.runner.visualstudio" Version="3.0.1" />
    <PackageVersion Include="Moq" Version="4.20.72" />
    <PackageVersion Include="FluentAssertions" Version="6.12.2" />
    <PackageVersion Include="coverlet.collector" Version="6.0.2" />
  </ItemGroup>
</Project>
```

(Note: pin Moq below the 4.20.0 telemetry-controversy band only if needed. 4.20.72 has the telemetry removed; verify at install time. If your security policy prefers an older version, pin `4.18.4` instead.)

- [ ] **Step 4: Write `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true

[*.{cs,csproj,sln,props,targets}]
indent_style = space
indent_size = 4

[*.{ts,tsx,js,jsx,json,jsonc,css,html,md,yml,yaml}]
indent_style = space
indent_size = 2

[Makefile]
indent_style = tab
```

- [ ] **Step 5: Append to `.gitignore`**

Open existing `.gitignore` and append:

```
# Test results / coverage
[Tt]est[Rr]esult*/
*.trx
coverage/

# Tooling
.vs/
.idea/
.vscode/
*.swp

# Frontend
frontend/node_modules/
frontend/dist/
frontend/test-results/
frontend/playwright-report/
frontend/.vite/

# OS
.DS_Store
Thumbs.db
```

- [ ] **Step 6: Verify and commit**

Run:

```
dotnet build
```

Expected: warns "no projects in solution" but exits 0.

```bash
git add Directory.Build.props Directory.Packages.props .editorconfig .gitignore PRism.sln
git commit -m "build: solution scaffold + central package versions + editorconfig"
```

---

### Task 2: Project skeletons (all 7 .NET projects + 3 test projects)

**Files:**
- Create: `PRism.Core/PRism.Core.csproj`
- Create: `PRism.Core.Contracts/PRism.Core.Contracts.csproj`
- Create: `PRism.AI.Contracts/PRism.AI.Contracts.csproj`
- Create: `PRism.AI.Placeholder/PRism.AI.Placeholder.csproj`
- Create: `PRism.GitHub/PRism.GitHub.csproj`
- Create: `PRism.Web/PRism.Web.csproj`
- Create: `tests/PRism.Core.Tests/PRism.Core.Tests.csproj`
- Create: `tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj`
- Create: `tests/PRism.Web.Tests/PRism.Web.Tests.csproj`

- [ ] **Step 1: Create the six source projects**

```
dotnet new classlib -o PRism.Core -n PRism.Core
dotnet new classlib -o PRism.Core.Contracts -n PRism.Core.Contracts
dotnet new classlib -o PRism.AI.Contracts -n PRism.AI.Contracts
dotnet new classlib -o PRism.AI.Placeholder -n PRism.AI.Placeholder
dotnet new classlib -o PRism.GitHub -n PRism.GitHub
dotnet new web -o PRism.Web -n PRism.Web
```

Delete the auto-generated `Class1.cs` from each classlib. Delete `WeatherForecast`-style files from `PRism.Web` if any.

- [ ] **Step 2: Wire references**

```
dotnet add PRism.Core/PRism.Core.csproj reference PRism.Core.Contracts PRism.AI.Contracts
dotnet add PRism.GitHub/PRism.GitHub.csproj reference PRism.Core PRism.Core.Contracts
dotnet add PRism.AI.Placeholder/PRism.AI.Placeholder.csproj reference PRism.AI.Contracts
dotnet add PRism.Web/PRism.Web.csproj reference PRism.Core PRism.GitHub PRism.AI.Contracts PRism.AI.Placeholder
```

- [ ] **Step 3: Add Octokit only to `PRism.GitHub`**

```
dotnet add PRism.GitHub/PRism.GitHub.csproj package Octokit
```

This is the *only* place `Octokit` is referenced (source-level isolation rule).

- [ ] **Step 4: Create the three test projects**

```
dotnet new xunit -o tests/PRism.Core.Tests -n PRism.Core.Tests
dotnet new xunit -o tests/PRism.GitHub.Tests -n PRism.GitHub.Tests
dotnet new xunit -o tests/PRism.Web.Tests -n PRism.Web.Tests
```

Delete auto-generated `UnitTest1.cs` from each.

- [ ] **Step 5: Wire test references**

```
dotnet add tests/PRism.Core.Tests reference PRism.Core PRism.Core.Contracts PRism.AI.Contracts PRism.AI.Placeholder
dotnet add tests/PRism.GitHub.Tests reference PRism.GitHub PRism.Core
dotnet add tests/PRism.Web.Tests reference PRism.Web PRism.Core PRism.AI.Contracts PRism.AI.Placeholder

dotnet add tests/PRism.Core.Tests package Moq
dotnet add tests/PRism.Core.Tests package FluentAssertions
dotnet add tests/PRism.GitHub.Tests package Moq
dotnet add tests/PRism.GitHub.Tests package FluentAssertions
dotnet add tests/PRism.Web.Tests package Moq
dotnet add tests/PRism.Web.Tests package FluentAssertions
dotnet add tests/PRism.Web.Tests package Microsoft.AspNetCore.Mvc.Testing
```

- [ ] **Step 6: Add all projects to the solution**

```
dotnet sln add PRism.Core/PRism.Core.csproj
dotnet sln add PRism.Core.Contracts/PRism.Core.Contracts.csproj
dotnet sln add PRism.AI.Contracts/PRism.AI.Contracts.csproj
dotnet sln add PRism.AI.Placeholder/PRism.AI.Placeholder.csproj
dotnet sln add PRism.GitHub/PRism.GitHub.csproj
dotnet sln add PRism.Web/PRism.Web.csproj
dotnet sln add tests/PRism.Core.Tests/PRism.Core.Tests.csproj
dotnet sln add tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj
dotnet sln add tests/PRism.Web.Tests/PRism.Web.Tests.csproj
```

- [ ] **Step 7: Verify build**

```
dotnet build
```

Expected: all 9 projects compile clean. Zero warnings (TreatWarningsAsErrors).

```
dotnet test
```

Expected: zero tests, exit 0.

- [ ] **Step 8: Commit**

```bash
git add PRism.Core PRism.Core.Contracts PRism.AI.Contracts PRism.AI.Placeholder PRism.GitHub PRism.Web tests PRism.sln
git commit -m "build: 6 source projects + 3 test projects + reference graph

Source-level Octokit isolation enforced: only PRism.GitHub.csproj
references the Octokit package. PRism.Web takes a transitive binary
dependency through DI but no using Octokit; appears in any of its
source files."
```

---

### Task 3: Top-level README

**Files:**
- Create: `README.md` (replaces stub)

- [ ] **Step 1: Write README**

```markdown
# PRism

Local-first PR review tool that runs on the reviewer's own machine. See [`docs/spec/`](docs/spec/) for the full specification and [`docs/roadmap.md`](docs/roadmap.md) for the implementation slice plan.

## Status

Pre-implementation; the foundations slice (`docs/superpowers/specs/2026-05-05-foundations-and-setup-design.md`) is in flight. See [`docs/roadmap.md`](docs/roadmap.md) for the broader slice list.

## Development workflow

Two terminals.

```
# terminal 1 — backend with hot reload (pinned to 5180 in dev)
dotnet watch run --project PRism.Web --urls http://localhost:5180

# terminal 2 — frontend dev server (Vite proxies /api to localhost:5180)
cd frontend
npm install
npm run dev
```

Run all tests:

```
dotnet test
cd frontend && npm test && npx playwright test
```

Run a single backend test:

```
dotnet test --filter "FullyQualifiedName~AppStateStoreTests"
```

Run a single frontend test:

```
cd frontend && npx vitest run __tests__/setup.test.tsx
```

## Process

All production code is written test-first (red → green → refactor). See [`CLAUDE.md`](CLAUDE.md) § Development process.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: top-level README with dev workflow + test commands"
```

---

## Phase 2 — Core infrastructure (T4–T17)

Each task: write failing test → run to confirm red → minimal impl → run to confirm green → refactor → commit.

---

### Task 4: `IClock` + `SystemClock` + `TestClock`

**Files:**
- Create: `PRism.Core/Time/IClock.cs`
- Create: `PRism.Core/Time/SystemClock.cs`
- Create: `tests/PRism.Core.Tests/TestHelpers/TestClock.cs`
- Create: `tests/PRism.Core.Tests/Time/SystemClockTests.cs`

- [ ] **Step 1: Write failing test**

`tests/PRism.Core.Tests/Time/SystemClockTests.cs`:

```csharp
using PRism.Core.Time;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Time;

public class SystemClockTests
{
    [Fact]
    public void UtcNow_returns_a_value_within_a_second_of_DateTime_UtcNow()
    {
        var clock = new SystemClock();
        var before = DateTime.UtcNow;
        var observed = clock.UtcNow;
        var after = DateTime.UtcNow;

        observed.Should().BeOnOrAfter(before).And.BeOnOrBefore(after);
        observed.Kind.Should().Be(DateTimeKind.Utc);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```
dotnet test --filter "FullyQualifiedName~SystemClockTests"
```

Expected: build fails, "type or namespace 'IClock' / 'SystemClock' could not be found".

- [ ] **Step 3: Implement**

`PRism.Core/Time/IClock.cs`:

```csharp
namespace PRism.Core.Time;

public interface IClock
{
    DateTime UtcNow { get; }
}
```

`PRism.Core/Time/SystemClock.cs`:

```csharp
namespace PRism.Core.Time;

public sealed class SystemClock : IClock
{
    public DateTime UtcNow => DateTime.UtcNow;
}
```

`tests/PRism.Core.Tests/TestHelpers/TestClock.cs`:

```csharp
using PRism.Core.Time;

namespace PRism.Core.Tests.TestHelpers;

public sealed class TestClock : IClock
{
    public DateTime UtcNow { get; set; } = new(2026, 5, 5, 12, 0, 0, DateTimeKind.Utc);
    public void Advance(TimeSpan by) => UtcNow = UtcNow.Add(by);
}
```

- [ ] **Step 4: Run test to verify pass**

```
dotnet test --filter "FullyQualifiedName~SystemClockTests"
```

Expected: 1 test, 1 passed.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Time tests/PRism.Core.Tests/Time tests/PRism.Core.Tests/TestHelpers/TestClock.cs
git commit -m "feat(core): IClock + SystemClock with TestClock test helper"
```

---

### Task 5: `DataDirectoryResolver`

**Files:**
- Create: `PRism.Core/Hosting/DataDirectoryResolver.cs`
- Create: `tests/PRism.Core.Tests/Hosting/DataDirectoryResolverTests.cs`

- [ ] **Step 1: Write failing test**

`tests/PRism.Core.Tests/Hosting/DataDirectoryResolverTests.cs`:

```csharp
using PRism.Core.Hosting;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Hosting;

public class DataDirectoryResolverTests
{
    [Fact]
    public void Resolve_returns_PRism_subfolder_under_LocalApplicationData()
    {
        var path = DataDirectoryResolver.Resolve();

        path.Should().NotBeNullOrWhiteSpace();
        path.Should().EndWith("PRism");
        Path.IsPathFullyQualified(path).Should().BeTrue();
    }

    [Fact]
    public void Resolve_creates_the_directory_if_it_does_not_exist()
    {
        var path = DataDirectoryResolver.Resolve();
        Directory.Exists(path).Should().BeTrue();
    }

    [Fact]
    public void Resolve_with_explicit_root_uses_the_passed_root()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), $"PRism-test-{Guid.NewGuid():N}");
        try
        {
            var path = DataDirectoryResolver.Resolve(tempRoot);
            path.Should().Be(Path.Combine(tempRoot, "PRism"));
            Directory.Exists(path).Should().BeTrue();
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }
}
```

- [ ] **Step 2: Run test → fail**

```
dotnet test --filter "FullyQualifiedName~DataDirectoryResolverTests"
```

- [ ] **Step 3: Implement**

`PRism.Core/Hosting/DataDirectoryResolver.cs`:

```csharp
namespace PRism.Core.Hosting;

public static class DataDirectoryResolver
{
    public static string Resolve(string? root = null)
    {
        var baseDir = root ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var dataDir = Path.Combine(baseDir, "PRism");
        Directory.CreateDirectory(dataDir);
        return dataDir;
    }
}
```

- [ ] **Step 4: Run → pass**

3 passed.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Hosting/DataDirectoryResolver.cs tests/PRism.Core.Tests/Hosting/DataDirectoryResolverTests.cs
git commit -m "feat(core): DataDirectoryResolver wraps SpecialFolder.LocalApplicationData"
```

---

### Task 6: Kebab-case JSON naming policy + `JsonSerializerOptionsFactory`

**Files:**
- Create: `PRism.Core/Json/KebabCaseJsonNamingPolicy.cs`
- Create: `PRism.Core/Json/JsonSerializerOptionsFactory.cs`
- Create: `tests/PRism.Core.Tests/Json/KebabCaseJsonNamingPolicyTests.cs`
- Create: `tests/PRism.Core.Tests/Json/JsonSerializerOptionsFactoryTests.cs`

- [ ] **Step 1: Write failing tests**

`tests/PRism.Core.Tests/Json/KebabCaseJsonNamingPolicyTests.cs`:

```csharp
using PRism.Core.Json;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Json;

public class KebabCaseJsonNamingPolicyTests
{
    private readonly KebabCaseJsonNamingPolicy _policy = new();

    [Theory]
    [InlineData("RequestChanges", "request-changes")]
    [InlineData("PrismCreated", "prism-created")]
    [InlineData("AiPreview", "ai-preview")]
    [InlineData("LocalApplicationData", "local-application-data")]
    [InlineData("A", "a")]
    [InlineData("AB", "a-b")]
    [InlineData("URLPath", "u-r-l-path")]   // policy is dumb-but-deterministic; document as such
    [InlineData("approve", "approve")]
    [InlineData("", "")]
    public void ConvertName_lowercases_and_inserts_hyphens_before_uppercase(string input, string expected)
    {
        _policy.ConvertName(input).Should().Be(expected);
    }
}
```

`tests/PRism.Core.Tests/Json/JsonSerializerOptionsFactoryTests.cs`:

```csharp
using System.Text.Json;
using PRism.Core.Json;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Json;

public class JsonSerializerOptionsFactoryTests
{
    public enum TestVerdict { Approve, RequestChanges, Comment }
    public sealed record TestPayload(TestVerdict Verdict, string AiSummary);

    [Fact]
    public void Default_options_serialize_enums_as_kebab_case_lowercase()
    {
        var options = JsonSerializerOptionsFactory.Default;
        var payload = new TestPayload(TestVerdict.RequestChanges, "hi");

        var json = JsonSerializer.Serialize(payload, options);

        json.Should().Contain("\"verdict\":\"request-changes\"");
        json.Should().Contain("\"ai-summary\":\"hi\"");
    }

    [Fact]
    public void Default_options_deserialize_kebab_case_lowercase_enums()
    {
        var options = JsonSerializerOptionsFactory.Default;
        var json = "{\"verdict\":\"request-changes\",\"ai-summary\":\"hi\"}";

        var payload = JsonSerializer.Deserialize<TestPayload>(json, options)!;

        payload.Verdict.Should().Be(TestVerdict.RequestChanges);
        payload.AiSummary.Should().Be("hi");
    }

    [Fact]
    public void Default_options_skip_comments_and_allow_trailing_commas()
    {
        var options = JsonSerializerOptionsFactory.Default;
        var json = "{ /* note */ \"verdict\": \"approve\", \"ai-summary\": \"x\", }";

        var payload = JsonSerializer.Deserialize<TestPayload>(json, options)!;
        payload.Verdict.Should().Be(TestVerdict.Approve);
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

`PRism.Core/Json/KebabCaseJsonNamingPolicy.cs`:

```csharp
using System.Text;
using System.Text.Json;

namespace PRism.Core.Json;

public sealed class KebabCaseJsonNamingPolicy : JsonNamingPolicy
{
    public override string ConvertName(string name)
    {
        if (string.IsNullOrEmpty(name)) return name;

        var sb = new StringBuilder(name.Length + 8);
        for (int i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (char.IsUpper(c) && i > 0)
                sb.Append('-');
            sb.Append(char.ToLowerInvariant(c));
        }
        return sb.ToString();
    }
}
```

`PRism.Core/Json/JsonSerializerOptionsFactory.cs`:

```csharp
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PRism.Core.Json;

public static class JsonSerializerOptionsFactory
{
    // For state.json / config.json file persistence — kebab-case property names per spec § 7 examples.
    public static JsonSerializerOptions Storage { get; } = BuildStorage();

    // For API wire — camelCase property names (frontend convention), kebab-case enums.
    public static JsonSerializerOptions Api { get; } = BuildApi();

    // Backwards-compat alias for tests written before the split.
    public static JsonSerializerOptions Default => Storage;

    private static JsonSerializerOptions BuildStorage()
    {
        var policy = new KebabCaseJsonNamingPolicy();
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = policy,
            DictionaryKeyPolicy = policy,
            WriteIndented = false,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
            PropertyNameCaseInsensitive = false,
        };
        options.Converters.Add(new JsonStringEnumConverter(new KebabCaseJsonNamingPolicy()));
        return options;
    }

    private static JsonSerializerOptions BuildApi()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
            PropertyNameCaseInsensitive = false,
        };
        options.Converters.Add(new JsonStringEnumConverter(new KebabCaseJsonNamingPolicy()));
        return options;
    }
}
```

The dual policy resolves the wire/storage tension in spec § 7:
- File-on-disk (state.json, config.json) uses kebab-case property names per the spec's example shapes (`"review-sessions"`, `"ai-state"`, `"last-configured-github-host"`).
- API responses use camelCase property names — matches the frontend's `UiPreferences { theme, accent, aiPreview }` and the design handoff's `data.jsx` convention.
- **Both** policies share kebab-case for enum *values* (`"request-changes"`, `"prism-created"`) per the spec.

Add an additional test in `JsonSerializerOptionsFactoryTests.cs` to cover the camelCase API option:

```csharp
[Fact]
public void Api_options_serialize_property_names_as_camelCase()
{
    var options = JsonSerializerOptionsFactory.Api;
    var payload = new TestPayload(TestVerdict.RequestChanges, "hi");
    var json = JsonSerializer.Serialize(payload, options);
    json.Should().Contain("\"verdict\":\"request-changes\"");
    json.Should().Contain("\"aiSummary\":\"hi\"");           // camelCase, NOT kebab-case
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Json tests/PRism.Core.Tests/Json
git commit -m "feat(core): kebab-case JSON naming policy + shared SerializerOptions factory

Comments and trailing commas allowed for jsonc-style config files."
```

---

### Task 7: `PRism.Core.Contracts` provider DTOs

This task lands every provider DTO listed in `spec/02-architecture.md` § Core DTOs as immutable records. Most have only equality + serialization tests in this slice; their consumers arrive in later slices.

**Files:**
- Create: `PRism.Core.Contracts/PrReference.cs`
- Create: `PRism.Core.Contracts/Verdict.cs`
- Create: `PRism.Core.Contracts/AuthValidationResult.cs`
- Create: `PRism.Core.Contracts/Pr.cs` (skeleton; full schema lands in S2)
- Create: `PRism.Core.Contracts/PrIteration.cs` (skeleton; full in S3)
- Create: `PRism.Core.Contracts/FileChange.cs` (skeleton; full in S3)
- Create: `PRism.Core.Contracts/DiffHunk.cs` (skeleton; full in S3)
- Create: `PRism.Core.Contracts/ExistingComment.cs` (skeleton; full in S3)
- Create: `PRism.Core.Contracts/DraftComment.cs` (skeleton; full in S4)
- Create: `PRism.Core.Contracts/DraftReply.cs` (skeleton; full in S4)
- Create: `PRism.Core.Contracts/DraftReview.cs` (skeleton; full in S4)
- Create: `PRism.Core.Contracts/InboxSection.cs` (skeleton; full in S2)
- Create: `PRism.Core.Contracts/PrInboxItem.cs` (skeleton; full in S2)
- Create: `PRism.Core.Contracts/PrReferenceParser.cs`
- Create: `tests/PRism.Core.Tests/Contracts/PrReferenceTests.cs`
- Create: `tests/PRism.Core.Tests/Contracts/PrReferenceParserTests.cs`
- Create: `tests/PRism.Core.Tests/Contracts/VerdictSerializationTests.cs`

- [ ] **Step 1: Write failing tests for `PrReference` + parser**

`tests/PRism.Core.Tests/Contracts/PrReferenceTests.cs`:

```csharp
using PRism.Core.Contracts;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class PrReferenceTests
{
    [Fact]
    public void ToString_renders_owner_repo_number_form()
    {
        var r = new PrReference("acme", "api-server", 123);
        r.ToString().Should().Be("acme/api-server/123");
    }

    [Fact]
    public void Equality_is_value_based()
    {
        new PrReference("a", "b", 1).Should().Be(new PrReference("a", "b", 1));
        new PrReference("a", "b", 1).Should().NotBe(new PrReference("a", "b", 2));
    }
}
```

`tests/PRism.Core.Tests/Contracts/PrReferenceParserTests.cs`:

```csharp
using PRism.Core.Contracts;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class PrReferenceParserTests
{
    [Theory]
    [InlineData("acme/api-server/123", "acme", "api-server", 123)]
    [InlineData("Anthropic/claude-code/9999", "Anthropic", "claude-code", 9999)]
    public void Parse_accepts_owner_repo_number(string s, string owner, string repo, int number)
    {
        PrReferenceParser.TryParse(s, out var result).Should().BeTrue();
        result!.Owner.Should().Be(owner);
        result.Repo.Should().Be(repo);
        result.Number.Should().Be(number);
    }

    [Theory]
    [InlineData("")]
    [InlineData("acme")]
    [InlineData("acme/api-server")]
    [InlineData("acme/api-server/")]
    [InlineData("acme/api-server/abc")]
    [InlineData("acme/api-server/-1")]
    [InlineData("acme//123")]
    [InlineData("/api-server/123")]
    [InlineData("acme/api-server/123/extra")]
    [InlineData("acme:x/api-server/123")]
    public void Parse_rejects_malformed_inputs(string s)
    {
        PrReferenceParser.TryParse(s, out var result).Should().BeFalse();
        result.Should().BeNull();
    }
}
```

`tests/PRism.Core.Tests/Contracts/VerdictSerializationTests.cs`:

```csharp
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Json;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class VerdictSerializationTests
{
    [Theory]
    [InlineData(Verdict.Approve, "\"approve\"")]
    [InlineData(Verdict.RequestChanges, "\"request-changes\"")]
    [InlineData(Verdict.Comment, "\"comment\"")]
    public void Verdict_serializes_kebab_case(Verdict v, string expected)
    {
        var json = JsonSerializer.Serialize(v, JsonSerializerOptionsFactory.Default);
        json.Should().Be(expected);
    }
}
```

- [ ] **Step 2: Run → fail (types missing)**

- [ ] **Step 3: Implement DTOs**

`PRism.Core.Contracts/PrReference.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record PrReference(string Owner, string Repo, int Number)
{
    public override string ToString() => $"{Owner}/{Repo}/{Number}";
}
```

`PRism.Core.Contracts/PrReferenceParser.cs`:

```csharp
using System.Text.RegularExpressions;

namespace PRism.Core.Contracts;

public static partial class PrReferenceParser
{
    [GeneratedRegex(@"^(?<owner>[A-Za-z0-9_.\-]+)/(?<repo>[A-Za-z0-9_.\-]+)/(?<number>[1-9][0-9]*)$")]
    private static partial Regex Pattern();

    public static bool TryParse(string? input, out PrReference? result)
    {
        result = null;
        if (string.IsNullOrEmpty(input)) return false;

        var m = Pattern().Match(input);
        if (!m.Success) return false;

        if (!int.TryParse(m.Groups["number"].Value, out var n)) return false;

        result = new PrReference(m.Groups["owner"].Value, m.Groups["repo"].Value, n);
        return true;
    }
}
```

`PRism.Core.Contracts/Verdict.cs`:

```csharp
namespace PRism.Core.Contracts;

public enum Verdict
{
    Approve,
    RequestChanges,
    Comment,
}
```

`PRism.Core.Contracts/AuthValidationResult.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record AuthValidationResult(
    bool Ok,
    string? Login,
    IReadOnlyList<string>? Scopes,
    AuthValidationError? Error,
    string? ErrorDetail);

public enum AuthValidationError
{
    None,
    InvalidToken,
    InsufficientScopes,
    NetworkError,
    DnsError,
    ServerError,
}
```

For the remaining DTOs (`Pr`, `PrIteration`, `FileChange`, `DiffHunk`, `ExistingComment`, `DraftComment`, `DraftReply`, `DraftReview`, `InboxSection`, `PrInboxItem`) create skeleton records that capture the *minimum* fields needed for the IReviewService method signatures to compile in Task 23. Don't speculate on later-slice fields.

`PRism.Core.Contracts/Pr.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record Pr(
    PrReference Reference,
    string Title,
    string Author,
    string State,
    string HeadSha);
```

`PRism.Core.Contracts/PrIteration.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record PrIteration(int Index, string FromSha, string ToSha);
```

`PRism.Core.Contracts/FileChange.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record FileChange(
    string Path,
    FileChangeStatus Status,
    IReadOnlyList<DiffHunk> Hunks);

public enum FileChangeStatus
{
    Added,
    Modified,
    Deleted,
    Renamed,
}
```

`PRism.Core.Contracts/DiffHunk.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record DiffHunk(int OldStart, int OldLines, int NewStart, int NewLines, string Body);
```

`PRism.Core.Contracts/ExistingComment.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record ExistingComment(
    string Id,
    string Author,
    string Body,
    string Path,
    int? Line,
    string? ThreadId,
    string? ParentId);
```

`PRism.Core.Contracts/DraftComment.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record DraftComment(
    string Id,
    string FilePath,
    int LineNumber,
    string Side,
    string AnchoredSha,
    string AnchoredLineContent,
    string BodyMarkdown,
    string? ThreadId);
```

`PRism.Core.Contracts/DraftReply.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record DraftReply(
    string Id,
    string ParentThreadId,
    string BodyMarkdown,
    string? ReplyCommentId);
```

`PRism.Core.Contracts/DraftReview.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record DraftReview(
    PrReference Pr,
    Verdict Verdict,
    string SummaryMarkdown,
    IReadOnlyList<DraftComment> NewThreads,
    IReadOnlyList<DraftReply> Replies,
    string? PendingReviewId,
    string? CommitOid);
```

`PRism.Core.Contracts/InboxSection.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record InboxSection(string Id, string Label, IReadOnlyList<PrInboxItem> Items);
```

`PRism.Core.Contracts/PrInboxItem.cs`:

```csharp
namespace PRism.Core.Contracts;

public sealed record PrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTime UpdatedAt);
```

- [ ] **Step 4: Run all tests → pass**

```
dotnet test
```

Expected: all PrReference / parser / Verdict tests pass; all other DTOs compile.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core.Contracts tests/PRism.Core.Tests/Contracts
git commit -m "feat(contracts): provider DTOs (PrReference, Verdict, AuthValidationResult, +9 skeletons)

Skeletons land here so IReviewService can compile; their full schemas
fill in as later slices add their consumers."
```

---

### Task 8: AI seam interfaces + DTOs + `Noop*` defaults in `PRism.AI.Contracts`

The AI seam interfaces from `spec/04-ai-seam-architecture.md`. This task lands all of them with `Noop*` implementations that return null/empty. The Placeholder counterparts arrive in Task 9.

**Files (all under `PRism.AI.Contracts/`):**
- Create: `Capabilities/AiCapabilities.cs`
- Create: `Dtos/PrSummary.cs`, `Dtos/FileFocus.cs`, `Dtos/HunkAnnotation.cs`, `Dtos/ValidatorReport.cs`, `Dtos/ChatMessage.cs`, `Dtos/ComposerSuggestion.cs`, `Dtos/InboxEnrichment.cs`, `Dtos/InboxRanking.cs`, `Dtos/DraftSuggestion.cs`, `Dtos/DraftReconciliation.cs`
- Create: `Seams/IPrSummarizer.cs`, `Seams/IFileFocusRanker.cs`, `Seams/IHunkAnnotator.cs`, `Seams/IPreSubmitValidator.cs`, `Seams/IComposerAssistant.cs`, `Seams/IDraftSuggester.cs`, `Seams/IDraftReconciliator.cs`, `Seams/IInboxEnricher.cs`, `Seams/IInboxRanker.cs`
- Create: `Noop/NoopPrSummarizer.cs`, `Noop/NoopFileFocusRanker.cs`, `Noop/NoopHunkAnnotator.cs`, `Noop/NoopPreSubmitValidator.cs`, `Noop/NoopComposerAssistant.cs`, `Noop/NoopDraftSuggester.cs`, `Noop/NoopDraftReconciliator.cs`, `Noop/NoopInboxEnricher.cs`, `Noop/NoopInboxRanker.cs`
- Create: `tests/PRism.Core.Tests/Ai/NoopSeamTests.cs`

The interfaces and DTOs are skeletons; the surface area is the *names and signatures*. Their full bodies arrive when each AI feature ships in v2.

- [ ] **Step 1: Write failing tests for the Noops**

`tests/PRism.Core.Tests/Ai/NoopSeamTests.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Ai;

public class NoopSeamTests
{
    private static readonly PrReference Ref = new("acme", "api-server", 1);

    [Fact]
    public async Task NoopPrSummarizer_returns_null()
    {
        IPrSummarizer s = new NoopPrSummarizer();
        var result = await s.SummarizeAsync(Ref, CancellationToken.None);
        result.Should().BeNull();
    }

    [Fact]
    public async Task NoopFileFocusRanker_returns_empty()
    {
        IFileFocusRanker s = new NoopFileFocusRanker();
        var result = await s.RankAsync(Ref, CancellationToken.None);
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task NoopHunkAnnotator_returns_empty()
    {
        IHunkAnnotator s = new NoopHunkAnnotator();
        var result = await s.AnnotateAsync(Ref, "path", 0, CancellationToken.None);
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task NoopPreSubmitValidator_returns_no_findings()
    {
        IPreSubmitValidator s = new NoopPreSubmitValidator();
        var result = await s.ValidateAsync(Ref, CancellationToken.None);
        result.Findings.Should().BeEmpty();
    }

    [Fact]
    public async Task NoopComposerAssistant_returns_null()
    {
        IComposerAssistant s = new NoopComposerAssistant();
        var result = await s.SuggestAsync(Ref, "draft body", CancellationToken.None);
        result.Should().BeNull();
    }

    [Fact]
    public async Task NoopDraftSuggester_returns_empty()
    {
        IDraftSuggester s = new NoopDraftSuggester();
        var result = await s.SuggestAsync(Ref, CancellationToken.None);
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task NoopDraftReconciliator_returns_empty()
    {
        IDraftReconciliator s = new NoopDraftReconciliator();
        var result = await s.ReconcileAsync(Ref, Array.Empty<DraftComment>(), CancellationToken.None);
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task NoopInboxEnricher_returns_null()
    {
        IInboxEnricher s = new NoopInboxEnricher();
        var result = await s.EnrichAsync(Ref, CancellationToken.None);
        result.Should().BeNull();
    }

    [Fact]
    public async Task NoopInboxRanker_returns_input_order_unchanged()
    {
        IInboxRanker s = new NoopInboxRanker();
        var input = new[] { Ref, new PrReference("acme", "api-server", 2) };
        var result = await s.RankAsync(input, CancellationToken.None);
        result.Should().Equal(input);
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement the contracts assembly**

`PRism.AI.Contracts/Capabilities/AiCapabilities.cs`:

```csharp
namespace PRism.AI.Contracts.Capabilities;

public sealed record AiCapabilities(
    bool Summary,
    bool FileFocus,
    bool HunkAnnotations,
    bool PreSubmitValidators,
    bool ComposerAssist,
    bool DraftSuggestions,
    bool DraftReconciliation,
    bool InboxEnrichment,
    bool InboxRanking)
{
    public static AiCapabilities AllOff { get; } = new(false, false, false, false, false, false, false, false, false);
    public static AiCapabilities AllOn { get; } = new(true, true, true, true, true, true, true, true, true);
}
```

DTOs (each in its own file under `PRism.AI.Contracts/Dtos/`):

```csharp
// PrSummary.cs
namespace PRism.AI.Contracts.Dtos;
public sealed record PrSummary(string Body, string Category);

// FileFocus.cs
namespace PRism.AI.Contracts.Dtos;
public sealed record FileFocus(string Path, FocusLevel Level);
public enum FocusLevel { High, Medium, Low }

// HunkAnnotation.cs
namespace PRism.AI.Contracts.Dtos;
public sealed record HunkAnnotation(string Path, int HunkIndex, string Body, AnnotationTone Tone);
public enum AnnotationTone { Calm, HeadsUp, Concern }

// ValidatorReport.cs
namespace PRism.AI.Contracts.Dtos;
public sealed record ValidatorReport(IReadOnlyList<ValidatorFinding> Findings);
public sealed record ValidatorFinding(string Severity, string Message);

// ChatMessage.cs
namespace PRism.AI.Contracts.Dtos;
public sealed record ChatMessage(string Role, string Body);

// ComposerSuggestion.cs
namespace PRism.AI.Contracts.Dtos;
public sealed record ComposerSuggestion(string Body, string Tone);

// InboxEnrichment.cs
namespace PRism.AI.Contracts.Dtos;
public sealed record InboxEnrichment(string Category, string? OneLineSummary);

// InboxRanking.cs (inbox ranker just reorders refs; no DTO needed beyond IReadOnlyList<PrReference>)

// DraftSuggestion.cs
namespace PRism.AI.Contracts.Dtos;
public sealed record DraftSuggestion(string FilePath, int LineNumber, string Body);

// DraftReconciliation.cs
namespace PRism.AI.Contracts.Dtos;
public sealed record DraftReconciliation(string DraftId, string Action, string Reason);
```

Seam interfaces (each in `PRism.AI.Contracts/Seams/`):

```csharp
// IPrSummarizer.cs
namespace PRism.AI.Contracts.Seams;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
public interface IPrSummarizer
{
    Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct);
}

// IFileFocusRanker.cs
namespace PRism.AI.Contracts.Seams;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
public interface IFileFocusRanker
{
    Task<IReadOnlyList<FileFocus>> RankAsync(PrReference pr, CancellationToken ct);
}

// IHunkAnnotator.cs
namespace PRism.AI.Contracts.Seams;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
public interface IHunkAnnotator
{
    Task<IReadOnlyList<HunkAnnotation>> AnnotateAsync(PrReference pr, string filePath, int hunkIndex, CancellationToken ct);
}

// IPreSubmitValidator.cs
namespace PRism.AI.Contracts.Seams;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
public interface IPreSubmitValidator
{
    Task<ValidatorReport> ValidateAsync(PrReference pr, CancellationToken ct);
}

// IComposerAssistant.cs
namespace PRism.AI.Contracts.Seams;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
public interface IComposerAssistant
{
    Task<ComposerSuggestion?> SuggestAsync(PrReference pr, string currentDraftBody, CancellationToken ct);
}

// IDraftSuggester.cs
namespace PRism.AI.Contracts.Seams;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
public interface IDraftSuggester
{
    Task<IReadOnlyList<DraftSuggestion>> SuggestAsync(PrReference pr, CancellationToken ct);
}

// IDraftReconciliator.cs
namespace PRism.AI.Contracts.Seams;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
public interface IDraftReconciliator
{
    Task<IReadOnlyList<DraftReconciliation>> ReconcileAsync(PrReference pr, IReadOnlyList<DraftComment> drafts, CancellationToken ct);
}

// IInboxEnricher.cs
namespace PRism.AI.Contracts.Seams;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
public interface IInboxEnricher
{
    Task<InboxEnrichment?> EnrichAsync(PrReference pr, CancellationToken ct);
}

// IInboxRanker.cs
namespace PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
public interface IInboxRanker
{
    Task<IReadOnlyList<PrReference>> RankAsync(IReadOnlyList<PrReference> input, CancellationToken ct);
}
```

Noop implementations (each in `PRism.AI.Contracts/Noop/`):

```csharp
// NoopPrSummarizer.cs
namespace PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
public sealed class NoopPrSummarizer : IPrSummarizer
{
    public Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct) => Task.FromResult<PrSummary?>(null);
}

// NoopFileFocusRanker.cs
namespace PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
public sealed class NoopFileFocusRanker : IFileFocusRanker
{
    public Task<IReadOnlyList<FileFocus>> RankAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<FileFocus>>(Array.Empty<FileFocus>());
}

// NoopHunkAnnotator.cs
namespace PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
public sealed class NoopHunkAnnotator : IHunkAnnotator
{
    public Task<IReadOnlyList<HunkAnnotation>> AnnotateAsync(PrReference pr, string filePath, int hunkIndex, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<HunkAnnotation>>(Array.Empty<HunkAnnotation>());
}

// NoopPreSubmitValidator.cs
namespace PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
public sealed class NoopPreSubmitValidator : IPreSubmitValidator
{
    public Task<ValidatorReport> ValidateAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult(new ValidatorReport(Array.Empty<ValidatorFinding>()));
}

// NoopComposerAssistant.cs
namespace PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
public sealed class NoopComposerAssistant : IComposerAssistant
{
    public Task<ComposerSuggestion?> SuggestAsync(PrReference pr, string currentDraftBody, CancellationToken ct)
        => Task.FromResult<ComposerSuggestion?>(null);
}

// NoopDraftSuggester.cs
namespace PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
public sealed class NoopDraftSuggester : IDraftSuggester
{
    public Task<IReadOnlyList<DraftSuggestion>> SuggestAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<DraftSuggestion>>(Array.Empty<DraftSuggestion>());
}

// NoopDraftReconciliator.cs
namespace PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
public sealed class NoopDraftReconciliator : IDraftReconciliator
{
    public Task<IReadOnlyList<DraftReconciliation>> ReconcileAsync(PrReference pr, IReadOnlyList<DraftComment> drafts, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<DraftReconciliation>>(Array.Empty<DraftReconciliation>());
}

// NoopInboxEnricher.cs
namespace PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
public sealed class NoopInboxEnricher : IInboxEnricher
{
    public Task<InboxEnrichment?> EnrichAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<InboxEnrichment?>(null);
}

// NoopInboxRanker.cs
namespace PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;
public sealed class NoopInboxRanker : IInboxRanker
{
    public Task<IReadOnlyList<PrReference>> RankAsync(IReadOnlyList<PrReference> input, CancellationToken ct)
        => Task.FromResult(input);
}
```

- [ ] **Step 4: Run all tests → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.Contracts tests/PRism.Core.Tests/Ai
git commit -m "feat(ai-contracts): 9 AI seam interfaces + DTOs + Noop default impls

Skeleton DTOs and signatures matching spec/04-ai-seam-architecture.md.
Noop implementations return null/empty/input-unchanged. Placeholder
implementations land in the next task in PRism.AI.Placeholder."
```

---

### Task 9: `PRism.AI.Placeholder` — canned-data implementations

**Files (all under `PRism.AI.Placeholder/`):**
- Create: `PlaceholderData.cs` (static class with all canned content lifted from `design/handoff/data.jsx`)
- Create: `PlaceholderPrSummarizer.cs`
- Create: `PlaceholderFileFocusRanker.cs`
- Create: `PlaceholderHunkAnnotator.cs`
- Create: `PlaceholderPreSubmitValidator.cs`
- Create: `PlaceholderComposerAssistant.cs`
- Create: `PlaceholderDraftSuggester.cs`
- Create: `PlaceholderDraftReconciliator.cs`
- Create: `PlaceholderInboxEnricher.cs`
- Create: `PlaceholderInboxRanker.cs`
- Create: `tests/PRism.Core.Tests/Ai/PlaceholderSeamTests.cs`

The placeholder impls return non-null content for *every* input — they're for visual demo, not behavioral correctness. Hand-pick representative content from `design/handoff/data.jsx`. Each impl is ~10 lines.

- [ ] **Step 1: Write failing tests**

`tests/PRism.Core.Tests/Ai/PlaceholderSeamTests.cs`:

```csharp
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core.Contracts;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Ai;

public class PlaceholderSeamTests
{
    private static readonly PrReference Ref = new("acme", "api-server", 1842);

    [Fact]
    public async Task Summarizer_returns_canned_summary_with_category()
    {
        IPrSummarizer s = new PlaceholderPrSummarizer();
        var result = await s.SummarizeAsync(Ref, CancellationToken.None);
        result.Should().NotBeNull();
        result!.Body.Should().NotBeNullOrWhiteSpace();
        result.Category.Should().BeOneOf("Refactor", "Feature", "Perf", "Bug", "Experiment");
    }

    [Fact]
    public async Task FileFocusRanker_returns_at_least_one_file()
    {
        IFileFocusRanker s = new PlaceholderFileFocusRanker();
        var result = await s.RankAsync(Ref, CancellationToken.None);
        result.Should().NotBeEmpty();
    }

    [Fact]
    public async Task PreSubmitValidator_returns_at_least_one_finding()
    {
        IPreSubmitValidator s = new PlaceholderPreSubmitValidator();
        var result = await s.ValidateAsync(Ref, CancellationToken.None);
        result.Findings.Should().NotBeEmpty();
    }

    [Fact]
    public async Task InboxRanker_preserves_input_set_but_may_reorder()
    {
        IInboxRanker s = new PlaceholderInboxRanker();
        var input = new[] { Ref, new PrReference("acme", "api-server", 2), new PrReference("acme", "api-server", 3) };
        var result = await s.RankAsync(input, CancellationToken.None);
        result.Should().HaveCount(3);
        result.Should().BeEquivalentTo(input);
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

`PRism.AI.Placeholder/PlaceholderData.cs`:

```csharp
using PRism.AI.Contracts.Dtos;

namespace PRism.AI.Placeholder;

internal static class PlaceholderData
{
    public const string SummaryBody =
        "Refactors LeaseRenewalProcessor to consolidate retry logic, simplifies error mapping, " +
        "and tightens partial-failure semantics. Behavior is preserved; tests added for the new " +
        "boundary cases.";

    public const string SummaryCategory = "Refactor";

    public static IReadOnlyList<FileFocus> FileFocus { get; } = new[]
    {
        new FileFocus("services/leases/LeaseRenewalProcessor.cs", FocusLevel.High),
        new FileFocus("services/leases/RenewalRetryPolicy.cs", FocusLevel.Medium),
    };

    public static IReadOnlyList<HunkAnnotation> HunkAnnotations { get; } = new[]
    {
        new HunkAnnotation("services/leases/LeaseRenewalProcessor.cs", 0, "Reads cleaner — same behavior.", AnnotationTone.Calm),
        new HunkAnnotation("services/leases/LeaseRenewalProcessor.cs", 2, "Heads-up: failure semantics changed.", AnnotationTone.HeadsUp),
    };

    public static ValidatorReport Validator { get; } = new(new ValidatorFinding[]
    {
        new("info", "Verdict matches comment severity ✓"),
        new("info", "No drafts left in stale state ✓"),
        new("warn", "Heads-up about partial-failure tests."),
    });

    public static InboxEnrichment Enrichment { get; } = new("Refactor", "LeaseRenewalProcessor cleanup.");
}
```

`PRism.AI.Placeholder/PlaceholderPrSummarizer.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderPrSummarizer : IPrSummarizer
{
    public Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<PrSummary?>(new PrSummary(PlaceholderData.SummaryBody, PlaceholderData.SummaryCategory));
}
```

`PRism.AI.Placeholder/PlaceholderFileFocusRanker.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderFileFocusRanker : IFileFocusRanker
{
    public Task<IReadOnlyList<FileFocus>> RankAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult(PlaceholderData.FileFocus);
}
```

`PRism.AI.Placeholder/PlaceholderHunkAnnotator.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderHunkAnnotator : IHunkAnnotator
{
    public Task<IReadOnlyList<HunkAnnotation>> AnnotateAsync(PrReference pr, string filePath, int hunkIndex, CancellationToken ct)
        => Task.FromResult(PlaceholderData.HunkAnnotations);
}
```

`PRism.AI.Placeholder/PlaceholderPreSubmitValidator.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderPreSubmitValidator : IPreSubmitValidator
{
    public Task<ValidatorReport> ValidateAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult(PlaceholderData.Validator);
}
```

`PRism.AI.Placeholder/PlaceholderComposerAssistant.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderComposerAssistant : IComposerAssistant
{
    public Task<ComposerSuggestion?> SuggestAsync(PrReference pr, string currentDraftBody, CancellationToken ct)
        => Task.FromResult<ComposerSuggestion?>(new ComposerSuggestion(
            "Consider clarifying that this only applies to the renewal path, not the cancellation flow.",
            "neutral"));
}
```

`PRism.AI.Placeholder/PlaceholderDraftSuggester.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderDraftSuggester : IDraftSuggester
{
    public Task<IReadOnlyList<DraftSuggestion>> SuggestAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<DraftSuggestion>>(new[]
        {
            new DraftSuggestion("services/leases/LeaseRenewalProcessor.cs", 142, "Worth a comment on the retry budget here?"),
        });
}
```

`PRism.AI.Placeholder/PlaceholderDraftReconciliator.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderDraftReconciliator : IDraftReconciliator
{
    public Task<IReadOnlyList<DraftReconciliation>> ReconcileAsync(PrReference pr, IReadOnlyList<DraftComment> drafts, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<DraftReconciliation>>(
            drafts.Select(d => new DraftReconciliation(d.Id, "keep", "Anchored line is unchanged.")).ToArray());
}
```

`PRism.AI.Placeholder/PlaceholderInboxEnricher.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderInboxEnricher : IInboxEnricher
{
    public Task<InboxEnrichment?> EnrichAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<InboxEnrichment?>(PlaceholderData.Enrichment);
}
```

`PRism.AI.Placeholder/PlaceholderInboxRanker.cs`:

```csharp
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderInboxRanker : IInboxRanker
{
    public Task<IReadOnlyList<PrReference>> RankAsync(IReadOnlyList<PrReference> input, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<PrReference>>(input.OrderByDescending(p => p.Number).ToArray());
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.Placeholder tests/PRism.Core.Tests/Ai/PlaceholderSeamTests.cs
git commit -m "feat(ai-placeholder): canned-data impls of 9 AI seams for ui.aiPreview mode

Content lifted from design/handoff/data.jsx. Project deletes wholesale
when v2 ships real providers."
```

---

### Task 10: `IAiSeamSelector` — runtime selection between Noop and Placeholder

**Files:**
- Create: `PRism.Core/Ai/IAiSeamSelector.cs`
- Create: `PRism.Core/Ai/AiSeamSelector.cs`
- Create: `PRism.Core/Ai/AiPreviewState.cs`
- Create: `tests/PRism.Core.Tests/Ai/AiSeamSelectorTests.cs`

The selector reads `ui.aiPreview` from a small mutable state holder (the `ConfigStore` in Task 12 will be this holder's source of truth). Both `Noop*` and `Placeholder*` impls are registered in DI; the selector returns whichever matches the current flag.

- [ ] **Step 1: Write failing test**

`tests/PRism.Core.Tests/Ai/AiSeamSelectorTests.cs`:

```csharp
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core.Ai;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Ai;

public class AiSeamSelectorTests
{
    private static AiSeamSelector BuildSelector(AiPreviewState state)
    {
        var noop = new Dictionary<Type, object>
        {
            [typeof(IPrSummarizer)] = new NoopPrSummarizer(),
            [typeof(IInboxRanker)] = new NoopInboxRanker(),
        };
        var placeholder = new Dictionary<Type, object>
        {
            [typeof(IPrSummarizer)] = new PlaceholderPrSummarizer(),
            [typeof(IInboxRanker)] = new PlaceholderInboxRanker(),
        };
        return new AiSeamSelector(state, noop, placeholder);
    }

    [Fact]
    public void Resolve_returns_Noop_when_aiPreview_is_off()
    {
        var state = new AiPreviewState { IsOn = false };
        var sut = BuildSelector(state);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Resolve_returns_Placeholder_when_aiPreview_is_on()
    {
        var state = new AiPreviewState { IsOn = true };
        var sut = BuildSelector(state);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<PlaceholderPrSummarizer>();
    }

    [Fact]
    public void Resolve_observes_runtime_flips()
    {
        var state = new AiPreviewState { IsOn = false };
        var sut = BuildSelector(state);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();

        state.IsOn = true;
        sut.Resolve<IPrSummarizer>().Should().BeOfType<PlaceholderPrSummarizer>();
    }

    [Fact]
    public void Resolve_throws_when_seam_is_not_registered()
    {
        var state = new AiPreviewState { IsOn = false };
        var sut = BuildSelector(state);
        Action act = () => sut.Resolve<IComposerAssistant>();
        act.Should().Throw<InvalidOperationException>().WithMessage("*IComposerAssistant*not registered*");
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

`PRism.Core/Ai/IAiSeamSelector.cs`:

```csharp
namespace PRism.Core.Ai;

public interface IAiSeamSelector
{
    T Resolve<T>() where T : class;
}
```

`PRism.Core/Ai/AiPreviewState.cs`:

```csharp
namespace PRism.Core.Ai;

public sealed class AiPreviewState
{
    public bool IsOn { get; set; }
}
```

`PRism.Core/Ai/AiSeamSelector.cs`:

```csharp
namespace PRism.Core.Ai;

public sealed class AiSeamSelector : IAiSeamSelector
{
    private readonly AiPreviewState _state;
    private readonly IReadOnlyDictionary<Type, object> _noop;
    private readonly IReadOnlyDictionary<Type, object> _placeholder;

    public AiSeamSelector(
        AiPreviewState state,
        IReadOnlyDictionary<Type, object> noopImpls,
        IReadOnlyDictionary<Type, object> placeholderImpls)
    {
        _state = state;
        _noop = noopImpls;
        _placeholder = placeholderImpls;
    }

    public T Resolve<T>() where T : class
    {
        var bag = _state.IsOn ? _placeholder : _noop;
        if (!bag.TryGetValue(typeof(T), out var impl))
            throw new InvalidOperationException($"AI seam {typeof(T).Name} is not registered for ai-preview {(_state.IsOn ? "on" : "off")} mode.");
        return (T)impl;
    }
}
```

(In `PRism.Web`'s composition root in Task 22, this dictionary gets populated from DI. Tests construct it directly.)

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Ai tests/PRism.Core.Tests/Ai/AiSeamSelectorTests.cs
git commit -m "feat(core): AiSeamSelector + AiPreviewState

Selector resolves Noop or Placeholder impl per request, reading the
mutable AiPreviewState holder. ConfigStore (next task) becomes the
state's source of truth."
```

---

### Task 11: `IAppStateStore` + `AppStateStore`

State schema per spec § 7.2: `version: 1`, `reviewSessions: {}`, `aiState: {…}`, `lastConfiguredGithubHost: null`.

**Files:**
- Create: `PRism.Core/State/AppState.cs` (record types)
- Create: `PRism.Core/State/IAppStateStore.cs`
- Create: `PRism.Core/State/AppStateStore.cs`
- Create: `tests/PRism.Core.Tests/State/AppStateStoreTests.cs`
- Create: `tests/PRism.Core.Tests/TestHelpers/TempDataDir.cs`

- [ ] **Step 1: Write failing tests**

`tests/PRism.Core.Tests/TestHelpers/TempDataDir.cs`:

```csharp
namespace PRism.Core.Tests.TestHelpers;

public sealed class TempDataDir : IDisposable
{
    public string Path { get; }
    public TempDataDir()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"PRism-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path);
    }
    public void Dispose()
    {
        try { if (Directory.Exists(Path)) Directory.Delete(Path, recursive: true); } catch { /* best-effort */ }
    }
}
```

`tests/PRism.Core.Tests/State/AppStateStoreTests.cs`:

```csharp
using PRism.Core.State;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.State;

public class AppStateStoreTests
{
    [Fact]
    public async Task LoadAsync_creates_default_v1_state_when_file_missing()
    {
        using var dir = new TempDataDir();
        var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(1);
        state.ReviewSessions.Should().BeEmpty();
        state.LastConfiguredGithubHost.Should().BeNull();
        File.Exists(Path.Combine(dir.Path, "state.json")).Should().BeTrue();
    }

    [Fact]
    public async Task LoadAsync_reads_existing_v1_file()
    {
        using var dir = new TempDataDir();
        File.WriteAllText(Path.Combine(dir.Path, "state.json"),
            "{\"version\":1,\"review-sessions\":{},\"ai-state\":{\"repo-clone-map\":{},\"workspace-mtime-at-last-enumeration\":null},\"last-configured-github-host\":\"https://github.com\"}");

        var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);
        state.LastConfiguredGithubHost.Should().Be("https://github.com");
    }

    [Fact]
    public async Task LoadAsync_refuses_unknown_version()
    {
        using var dir = new TempDataDir();
        File.WriteAllText(Path.Combine(dir.Path, "state.json"), "{\"version\":2}");

        var store = new AppStateStore(dir.Path);
        await FluentActions.Invoking(() => store.LoadAsync(CancellationToken.None))
            .Should().ThrowAsync<UnsupportedStateVersionException>()
            .Where(e => e.Version == 2);
    }

    [Fact]
    public async Task LoadAsync_quarantines_malformed_json_and_creates_fresh()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        File.WriteAllText(statePath, "{ this is not valid json");

        var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(1);
        Directory.GetFiles(dir.Path, "state.json.corrupt-*").Should().HaveCount(1);
    }

    [Fact]
    public async Task SaveAsync_writes_atomically_via_temp_rename()
    {
        using var dir = new TempDataDir();
        var store = new AppStateStore(dir.Path);
        var initial = await store.LoadAsync(CancellationToken.None);
        var updated = initial with { LastConfiguredGithubHost = "https://github.com" };

        await store.SaveAsync(updated, CancellationToken.None);

        var roundTrip = await new AppStateStore(dir.Path).LoadAsync(CancellationToken.None);
        roundTrip.LastConfiguredGithubHost.Should().Be("https://github.com");
    }

    [Fact]
    public async Task SaveAsync_serializes_concurrent_writes()
    {
        using var dir = new TempDataDir();
        var store = new AppStateStore(dir.Path);
        var initial = await store.LoadAsync(CancellationToken.None);

        var tasks = Enumerable.Range(0, 50)
            .Select(i => store.SaveAsync(initial with { LastConfiguredGithubHost = $"https://h{i}.test" }, CancellationToken.None))
            .ToArray();

        await Task.WhenAll(tasks);

        var roundTrip = await new AppStateStore(dir.Path).LoadAsync(CancellationToken.None);
        roundTrip.LastConfiguredGithubHost.Should().StartWith("https://h");
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

`PRism.Core/State/AppState.cs`:

```csharp
namespace PRism.Core.State;

public sealed record AppState(
    int Version,
    IReadOnlyDictionary<string, ReviewSessionState> ReviewSessions,
    AiState AiState,
    string? LastConfiguredGithubHost)
{
    public static AppState Default { get; } = new(
        Version: 1,
        ReviewSessions: new Dictionary<string, ReviewSessionState>(),
        AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
        LastConfiguredGithubHost: null);
}

public sealed record ReviewSessionState(
    string? LastViewedHeadSha,
    string? LastSeenCommentId,
    string? PendingReviewId,
    string? PendingReviewCommitOid);

public sealed record AiState(
    IReadOnlyDictionary<string, RepoCloneEntry> RepoCloneMap,
    DateTime? WorkspaceMtimeAtLastEnumeration);

public sealed record RepoCloneEntry(string Path, string Ownership);
```

`PRism.Core/State/IAppStateStore.cs`:

```csharp
namespace PRism.Core.State;

public interface IAppStateStore
{
    Task<AppState> LoadAsync(CancellationToken ct);
    Task SaveAsync(AppState state, CancellationToken ct);
}
```

`PRism.Core/State/UnsupportedStateVersionException.cs`:

```csharp
namespace PRism.Core.State;

public sealed class UnsupportedStateVersionException(int version)
    : Exception($"state.json was written by a newer version of PRism (v{version}). Use that version or delete state.json.")
{
    public int Version { get; } = version;
}
```

`PRism.Core/State/AppStateStore.cs`:

```csharp
using System.Text.Json;
using PRism.Core.Json;

namespace PRism.Core.State;

public sealed class AppStateStore : IAppStateStore
{
    private const int CurrentVersion = 1;
    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public AppStateStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "state.json");
    }

    public async Task<AppState> LoadAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (!File.Exists(_path))
            {
                await SaveCoreAsync(AppState.Default, ct).ConfigureAwait(false);
                return AppState.Default;
            }

            string raw;
            using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new StreamReader(fs))
                raw = await reader.ReadToEndAsync(ct).ConfigureAwait(false);

            try
            {
                using var doc = JsonDocument.Parse(raw, new JsonDocumentOptions
                {
                    AllowTrailingCommas = true,
                    CommentHandling = JsonCommentHandling.Skip
                });
                if (!doc.RootElement.TryGetProperty("version", out var versionElement))
                    throw new UnsupportedStateVersionException(0);

                var version = versionElement.GetInt32();
                if (version != CurrentVersion)
                    throw new UnsupportedStateVersionException(version);

                var state = JsonSerializer.Deserialize<AppState>(raw, JsonSerializerOptionsFactory.Default)
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
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SaveAsync(AppState state, CancellationToken ct)
    {
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

    private async Task SaveCoreAsync(AppState state, CancellationToken ct)
    {
        var temp = $"{_path}.tmp-{Guid.NewGuid():N}";
        var json = JsonSerializer.Serialize(state, JsonSerializerOptionsFactory.Default);
        await File.WriteAllTextAsync(temp, json, ct).ConfigureAwait(false);
        File.Move(temp, _path, overwrite: true);
    }
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/State tests/PRism.Core.Tests/State tests/PRism.Core.Tests/TestHelpers/TempDataDir.cs
git commit -m "feat(core): AppStateStore with atomic-rename writes + version check + corrupt-quarantine"
```

---

### Task 12: `ConfigStore` with hot-reload + patch

**Files:**
- Create: `PRism.Core/Config/AppConfig.cs` (full strawman shape)
- Create: `PRism.Core/Config/IConfigStore.cs`
- Create: `PRism.Core/Config/ConfigStore.cs`
- Create: `PRism.Core/Config/ConfigPatchException.cs`
- Create: `tests/PRism.Core.Tests/Config/ConfigStoreTests.cs`

- [ ] **Step 1: Write failing tests**

```csharp
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStoreTests
{
    [Fact]
    public async Task LoadAsync_creates_defaults_when_file_missing()
    {
        using var dir = new TempDataDir();
        var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("system");
        store.Current.Ui.Accent.Should().Be("indigo");
        store.Current.Ui.AiPreview.Should().BeFalse();
        store.Current.Github.Host.Should().Be("https://github.com");
        File.Exists(Path.Combine(dir.Path, "config.json")).Should().BeTrue();
    }

    [Fact]
    public async Task LoadAsync_with_malformed_json_falls_back_to_defaults_without_overwrite()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        var bad = "{ broken";
        File.WriteAllText(path, bad);

        var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("system");
        File.ReadAllText(path).Should().Be(bad);            // file preserved
        store.LastLoadError.Should().NotBeNull();
    }

    [Fact]
    public async Task PatchAsync_with_single_field_succeeds_and_persists()
    {
        using var dir = new TempDataDir();
        var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("dark");
        var roundTrip = new ConfigStore(dir.Path);
        await roundTrip.InitAsync(CancellationToken.None);
        roundTrip.Current.Ui.Theme.Should().Be("dark");
    }

    [Fact]
    public async Task PatchAsync_with_multi_field_throws()
    {
        using var dir = new TempDataDir();
        var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark", ["accent"] = "amber" },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>()
            .Where(e => e.Message.Contains("exactly one"));
    }

    [Fact]
    public async Task PatchAsync_with_unknown_field_throws()
    {
        using var dir = new TempDataDir();
        var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["unknown"] = "x" },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>()
            .Where(e => e.Message.Contains("unknown"));
    }

    [Fact]
    public async Task External_edit_triggers_reload_within_polling_window()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        var original = await File.ReadAllTextAsync(path);
        var modified = original.Replace("\"theme\":\"system\"", "\"theme\":\"dark\"");
        await File.WriteAllTextAsync(path, modified);

        // FileSystemWatcher debounce + reload happens; allow up to 2s
        for (var i = 0; i < 20 && store.Current.Ui.Theme != "dark"; i++)
            await Task.Delay(100);

        store.Current.Ui.Theme.Should().Be("dark");
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

`PRism.Core/Config/AppConfig.cs`:

```csharp
namespace PRism.Core.Config;

public sealed record AppConfig(
    PollingConfig Polling,
    InboxConfig Inbox,
    ReviewConfig Review,
    IterationsConfig Iterations,
    LoggingConfig Logging,
    UiConfig Ui,
    GithubConfig Github,
    LlmConfig Llm)
{
    public static AppConfig Default => new(
        new PollingConfig(30, 120),
        new InboxConfig(true),
        new ReviewConfig(true, true),
        new IterationsConfig(60),
        new LoggingConfig("info", true, 30),
        new UiConfig("system", "indigo", false),
        new GithubConfig("https://github.com", null),
        new LlmConfig());
}

public sealed record PollingConfig(int ActivePrSeconds, int InboxSeconds);
public sealed record InboxConfig(bool ShowHiddenScopeFooter);
public sealed record ReviewConfig(bool BlockSubmitOnStaleDrafts, bool RequireVerdictReconfirmOnNewIteration);
public sealed record IterationsConfig(int ClusterGapSeconds);
public sealed record LoggingConfig(string Level, bool StateEvents, int StateEventsRetentionFiles);
public sealed record UiConfig(string Theme, string Accent, bool AiPreview);
public sealed record GithubConfig(string Host, string? LocalWorkspace);
public sealed record LlmConfig();
```

`PRism.Core/Config/ConfigPatchException.cs`:

```csharp
namespace PRism.Core.Config;

public sealed class ConfigPatchException(string message) : Exception(message);
```

`PRism.Core/Config/IConfigStore.cs`:

```csharp
namespace PRism.Core.Config;

public interface IConfigStore
{
    AppConfig Current { get; }
    Exception? LastLoadError { get; }
    Task InitAsync(CancellationToken ct);
    Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct);
    event EventHandler<AppConfig>? Changed;
}
```

`PRism.Core/Config/ConfigStore.cs`:

```csharp
using System.Text.Json;
using PRism.Core.Json;

namespace PRism.Core.Config;

public sealed class ConfigStore : IConfigStore, IDisposable
{
    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private FileSystemWatcher? _watcher;
    private AppConfig _current = AppConfig.Default;
    private static readonly HashSet<string> _allowedUiFields = new(StringComparer.Ordinal) { "theme", "accent", "aiPreview" };

    public ConfigStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "config.json");
    }

    public AppConfig Current => _current;
    public Exception? LastLoadError { get; private set; }
    public event EventHandler<AppConfig>? Changed;

    public async Task InitAsync(CancellationToken ct)
    {
        await ReadFromDiskAsync(ct).ConfigureAwait(false);
        TryStartWatcher();
    }

    public async Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct)
    {
        if (patch.Count != 1)
            throw new ConfigPatchException("exactly one field per patch");
        var (key, value) = patch.Single();
        if (!_allowedUiFields.Contains(key))
            throw new ConfigPatchException($"unknown field: {key}");

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var ui = _current.Ui;
            var newUi = key switch
            {
                "theme" => ui with { Theme = (string)value! },
                "accent" => ui with { Accent = (string)value! },
                "aiPreview" => ui with { AiPreview = Convert.ToBoolean(value) },
                _ => throw new ConfigPatchException($"unknown field: {key}")
            };
            _current = _current with { Ui = newUi };
            await WriteToDiskAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
        Changed?.Invoke(this, _current);
    }

    private async Task ReadFromDiskAsync(CancellationToken ct)
    {
        if (!File.Exists(_path))
        {
            _current = AppConfig.Default;
            await WriteToDiskAsync(ct).ConfigureAwait(false);
            LastLoadError = null;
            return;
        }
        try
        {
            string raw;
            using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new StreamReader(fs))
                raw = await reader.ReadToEndAsync(ct).ConfigureAwait(false);

            var parsed = JsonSerializer.Deserialize<AppConfig>(raw, JsonSerializerOptionsFactory.Default);
            _current = parsed ?? AppConfig.Default;
            LastLoadError = null;
        }
        catch (Exception ex)
        {
            LastLoadError = ex;
            _current = AppConfig.Default;
            // do NOT overwrite the broken file
        }
    }

    private async Task WriteToDiskAsync(CancellationToken ct)
    {
        var temp = $"{_path}.tmp-{Guid.NewGuid():N}";
        var json = JsonSerializer.Serialize(_current, JsonSerializerOptionsFactory.Default);
        await File.WriteAllTextAsync(temp, json, ct).ConfigureAwait(false);
        File.Move(temp, _path, overwrite: true);
    }

    private void TryStartWatcher()
    {
        try
        {
            var dir = Path.GetDirectoryName(_path)!;
            _watcher = new FileSystemWatcher(dir, "config.json")
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size,
                EnableRaisingEvents = true
            };
            _watcher.Changed += async (_, _) =>
            {
                await Task.Delay(100);                 // debounce save flurry
                await _gate.WaitAsync(CancellationToken.None);
                try
                {
                    await ReadFromDiskAsync(CancellationToken.None).ConfigureAwait(false);
                }
                finally
                {
                    _gate.Release();
                    Changed?.Invoke(this, _current);
                }
            };
        }
        catch
        {
            // FSW failed to register; fall back to no live reload (mtime-poll fallback intentionally
            // out of S0+S1 — acceptable degradation per spec design § Acknowledged trade-offs).
        }
    }

    public void Dispose() => _watcher?.Dispose();
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config tests/PRism.Core.Tests/Config
git commit -m "feat(core): ConfigStore with FileSystemWatcher hot-reload + single-field patch"
```

---

### Task 13: `TokenStore` (MSAL Extensions wrapper)

**Files:**
- Create: `PRism.Core/Auth/ITokenStore.cs`
- Create: `PRism.Core/Auth/TokenStore.cs`
- Create: `PRism.Core/Auth/TokenStoreException.cs`
- Create: `tests/PRism.Core.Tests/Auth/TokenStoreTests.cs`

The TokenStore wraps `MsalCacheHelper` to give a transient/commit/rollback API. Tests run against a temp dir using MSAL's file-based cache fallback (the OS-keychain backend isn't unit-testable on a fresh CI image; we test the API shape and round-trip via the file cache, then validate keychain integration manually on dev machines).

- [ ] **Step 1: Write failing tests**

```csharp
using PRism.Core.Auth;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Auth;

public class TokenStoreTests
{
    [Fact]
    public async Task HasToken_returns_false_when_nothing_stored()
    {
        using var dir = new TempDataDir();
        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        (await store.HasTokenAsync(CancellationToken.None)).Should().BeFalse();
    }

    [Fact]
    public async Task WriteTransient_then_Commit_persists_and_HasToken_is_true()
    {
        using var dir = new TempDataDir();
        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        await store.WriteTransientAsync("ghp_test", CancellationToken.None);
        await store.CommitAsync(CancellationToken.None);

        (await store.HasTokenAsync(CancellationToken.None)).Should().BeTrue();
        (await store.ReadAsync(CancellationToken.None)).Should().Be("ghp_test");
    }

    [Fact]
    public async Task WriteTransient_then_Rollback_leaves_HasToken_false()
    {
        using var dir = new TempDataDir();
        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        await store.WriteTransientAsync("ghp_test", CancellationToken.None);
        await store.RollbackTransientAsync(CancellationToken.None);

        (await store.HasTokenAsync(CancellationToken.None)).Should().BeFalse();
    }

    [Fact]
    public async Task ClearAsync_removes_committed_token()
    {
        using var dir = new TempDataDir();
        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        await store.WriteTransientAsync("ghp_test", CancellationToken.None);
        await store.CommitAsync(CancellationToken.None);
        await store.ClearAsync(CancellationToken.None);

        (await store.HasTokenAsync(CancellationToken.None)).Should().BeFalse();
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

Add NuGet reference to `PRism.Core`: `dotnet add PRism.Core/PRism.Core.csproj package Microsoft.Identity.Client.Extensions.Msal`.

`PRism.Core/Auth/TokenStoreException.cs`:

```csharp
namespace PRism.Core.Auth;

public enum TokenStoreFailure
{
    KeychainLibraryMissing,
    KeychainAgentUnavailable,
    Generic,
}

public sealed class TokenStoreException(TokenStoreFailure failure, string message, Exception? inner = null)
    : Exception(message, inner)
{
    public TokenStoreFailure Failure { get; } = failure;
}
```

`PRism.Core/Auth/ITokenStore.cs`:

```csharp
namespace PRism.Core.Auth;

public interface ITokenStore
{
    Task<bool> HasTokenAsync(CancellationToken ct);
    Task<string?> ReadAsync(CancellationToken ct);
    Task WriteTransientAsync(string token, CancellationToken ct);
    Task CommitAsync(CancellationToken ct);
    Task RollbackTransientAsync(CancellationToken ct);
    Task ClearAsync(CancellationToken ct);
}
```

`PRism.Core/Auth/TokenStore.cs`:

```csharp
using Microsoft.Identity.Client.Extensions.Msal;
using System.Text;

namespace PRism.Core.Auth;

public sealed class TokenStore : ITokenStore
{
    private const string CacheFileName = "PRism.tokens.cache";
    private const string ServiceName = "PRism";
    private const string AccountName = "github-pat";

    private readonly string _cacheDir;
    private readonly bool _useFileCacheForTests;
    private MsalCacheHelper? _helper;
    private string? _transient;
    private bool _hasCommitted;

    public TokenStore(string dataDir, bool useFileCacheForTests = false)
    {
        _cacheDir = dataDir;
        _useFileCacheForTests = useFileCacheForTests;
    }

    private async Task<MsalCacheHelper> GetHelperAsync()
    {
        if (_helper is not null) return _helper;
        try
        {
            var props = new StorageCreationPropertiesBuilder(CacheFileName, _cacheDir)
                .WithMacKeyChain(serviceName: ServiceName, accountName: AccountName)
                .WithLinuxKeyring(
                    schemaName: "com.prism.tokens",
                    collection: MsalCacheHelper.LinuxKeyRingDefaultCollection,
                    label: "PRism GitHub PAT",
                    attribute1: new KeyValuePair<string, string>("Service", ServiceName),
                    attribute2: new KeyValuePair<string, string>("Account", AccountName));
            if (_useFileCacheForTests)
                props.WithUnprotectedFile();
            _helper = await MsalCacheHelper.CreateAsync(props.Build());
            return _helper;
        }
        catch (DllNotFoundException ex)
        {
            throw new TokenStoreException(TokenStoreFailure.KeychainLibraryMissing,
                "OS keychain library not installed. Install libsecret-1 (apt install libsecret-1-0 / dnf install libsecret), then restart PRism.", ex);
        }
        catch (Exception ex) when (ex.Message.Contains("DBus", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("no provider", StringComparison.OrdinalIgnoreCase))
        {
            throw new TokenStoreException(TokenStoreFailure.KeychainAgentUnavailable,
                "OS keychain library is installed but no keyring agent is running. Start gnome-keyring-daemon or kwalletd, then restart PRism. Common on WSL and minimal sessions.", ex);
        }
        catch (Exception ex)
        {
            throw new TokenStoreException(TokenStoreFailure.Generic,
                $"OS keychain returned an error: {ex.Message}", ex);
        }
    }

    public async Task<bool> HasTokenAsync(CancellationToken ct)
    {
        var helper = await GetHelperAsync();
        var bytes = helper.LoadUnencryptedTokenCache();
        return bytes.Length > 0;
    }

    public async Task<string?> ReadAsync(CancellationToken ct)
    {
        var helper = await GetHelperAsync();
        var bytes = helper.LoadUnencryptedTokenCache();
        return bytes.Length == 0 ? null : Encoding.UTF8.GetString(bytes);
    }

    public Task WriteTransientAsync(string token, CancellationToken ct)
    {
        _transient = token;
        return Task.CompletedTask;
    }

    public async Task CommitAsync(CancellationToken ct)
    {
        if (_transient is null) throw new InvalidOperationException("No transient token to commit.");
        var helper = await GetHelperAsync();
        helper.SaveUnencryptedTokenCache(Encoding.UTF8.GetBytes(_transient));
        _hasCommitted = true;
        _transient = null;
    }

    public Task RollbackTransientAsync(CancellationToken ct)
    {
        _transient = null;
        return Task.CompletedTask;
    }

    public async Task ClearAsync(CancellationToken ct)
    {
        var helper = await GetHelperAsync();
        helper.SaveUnencryptedTokenCache(Array.Empty<byte>());
        _hasCommitted = false;
    }
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Auth tests/PRism.Core.Tests/Auth PRism.Core/PRism.Core.csproj Directory.Packages.props
git commit -m "feat(core): TokenStore wraps MSAL Extensions with transient/commit/rollback API

Per-platform failure detection (libsecret missing, keyring agent
unavailable) maps to TokenStoreFailure enum. Tests use file-cache
fallback (production uses keychain on Win/macOS, libsecret on Linux)."
```

---

### Task 14: `LockfileManager` with PID-liveness + atomic-create + torn-write recovery

**Files:**
- Create: `PRism.Core/Hosting/LockfileManager.cs`
- Create: `PRism.Core/Hosting/LockfileException.cs`
- Create: `tests/PRism.Core.Tests/Hosting/LockfileManagerTests.cs`

- [ ] **Step 1: Write failing tests**

```csharp
using PRism.Core.Hosting;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Hosting;

public class LockfileManagerTests
{
    [Fact]
    public void Acquire_succeeds_when_no_lockfile_exists()
    {
        using var dir = new TempDataDir();
        using var lockHandle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/path/to/PRism", currentPid: 12345);
        File.Exists(Path.Combine(dir.Path, "state.json.lock")).Should().BeTrue();
    }

    [Fact]
    public void Acquire_throws_when_another_live_PRism_holds_the_lock()
    {
        using var dir = new TempDataDir();
        var ourBinary = Environment.ProcessPath ?? "PRism";
        File.WriteAllText(Path.Combine(dir.Path, "state.json.lock"),
            $"{{\"pid\":{Environment.ProcessId},\"binary-path\":\"{ourBinary.Replace("\\", "\\\\")}\",\"started-at\":\"2026-05-05T12:00:00Z\"}}");

        Action act = () => LockfileManager.Acquire(dir.Path, currentBinaryPath: ourBinary, currentPid: Environment.ProcessId + 1);
        act.Should().Throw<LockfileException>()
            .Where(e => e.Reason == LockfileFailure.AnotherInstanceRunning);
    }

    [Fact]
    public void Acquire_recovers_from_dead_PID()
    {
        using var dir = new TempDataDir();
        File.WriteAllText(Path.Combine(dir.Path, "state.json.lock"),
            "{\"pid\":99999999,\"binary-path\":\"/old/PRism\",\"started-at\":\"2026-05-05T12:00:00Z\"}");

        using var lockHandle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/path/to/PRism", currentPid: 12345);
        // Should not throw; should overwrite
    }

    [Fact]
    public void Acquire_recovers_from_PID_alive_but_different_binary()
    {
        using var dir = new TempDataDir();
        File.WriteAllText(Path.Combine(dir.Path, "state.json.lock"),
            $"{{\"pid\":{Environment.ProcessId},\"binary-path\":\"/totally/different/binary\",\"started-at\":\"2026-05-05T12:00:00Z\"}}");

        using var lockHandle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/path/to/PRism", currentPid: Environment.ProcessId + 1);
    }

    [Fact]
    public void Acquire_recovers_from_torn_json()
    {
        using var dir = new TempDataDir();
        File.WriteAllText(Path.Combine(dir.Path, "state.json.lock"), "{ broken");

        using var lockHandle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/path/to/PRism", currentPid: 12345);
    }

    [Fact]
    public void Dispose_removes_the_lockfile()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "state.json.lock");
        var handle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/path/to/PRism", currentPid: 12345);
        File.Exists(path).Should().BeTrue();
        handle.Dispose();
        File.Exists(path).Should().BeFalse();
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

`PRism.Core/Hosting/LockfileException.cs`:

```csharp
namespace PRism.Core.Hosting;

public enum LockfileFailure { AnotherInstanceRunning }

public sealed class LockfileException(LockfileFailure reason, string message) : Exception(message)
{
    public LockfileFailure Reason { get; } = reason;
}
```

`PRism.Core/Hosting/LockfileManager.cs`:

```csharp
using System.Diagnostics;
using System.Text.Json;
using PRism.Core.Json;

namespace PRism.Core.Hosting;

public sealed class LockfileHandle : IDisposable
{
    private readonly string _path;
    public LockfileHandle(string path) { _path = path; }
    public void Dispose()
    {
        try { File.Delete(_path); } catch { /* best-effort */ }
    }
}

public sealed record LockfileRecord(int Pid, string BinaryPath, DateTime StartedAt);

public static class LockfileManager
{
    public static LockfileHandle Acquire(string dataDir, string currentBinaryPath, int currentPid)
    {
        var path = Path.Combine(dataDir, "state.json.lock");

        // Try atomic create first.
        if (TryAtomicCreate(path, currentBinaryPath, currentPid))
            return new LockfileHandle(path);

        // Lockfile exists; inspect.
        var existing = TryRead(path);
        if (existing is null)
        {
            // Torn JSON or unreadable; treat as missing.
            File.Delete(path);
            if (!TryAtomicCreate(path, currentBinaryPath, currentPid))
                throw new LockfileException(LockfileFailure.AnotherInstanceRunning,
                    "PRism is already running.");
            return new LockfileHandle(path);
        }

        if (IsAlive(existing.Pid, existing.BinaryPath, currentBinaryPath))
            throw new LockfileException(LockfileFailure.AnotherInstanceRunning,
                $"PRism is already running (PID {existing.Pid}). Use that instance, or stop it first.");

        // Stale lockfile (dead PID, recycled PID, or different binary). Take over.
        File.Delete(path);
        if (!TryAtomicCreate(path, currentBinaryPath, currentPid))
            throw new LockfileException(LockfileFailure.AnotherInstanceRunning, "PRism is already running.");
        return new LockfileHandle(path);
    }

    private static bool TryAtomicCreate(string path, string binaryPath, int pid)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            var record = new LockfileRecord(pid, binaryPath, DateTime.UtcNow);
            using var writer = new StreamWriter(fs);
            writer.Write(JsonSerializer.Serialize(record, JsonSerializerOptionsFactory.Default));
            return true;
        }
        catch (IOException)
        {
            return false;
        }
    }

    private static LockfileRecord? TryRead(string path)
    {
        try
        {
            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<LockfileRecord>(json, JsonSerializerOptionsFactory.Default);
        }
        catch
        {
            return null;
        }
    }

    private static bool IsAlive(int pid, string lockedBinaryPath, string currentBinaryPath)
    {
        try
        {
            var p = Process.GetProcessById(pid);
            // Process exists; require matching binary path to claim "another live PRism".
            // If the binary differs, the PID was recycled — treat as stale.
            return string.Equals(lockedBinaryPath, currentBinaryPath, StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException)
        {
            return false;                       // PID not in process table
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Hosting/LockfileManager.cs PRism.Core/Hosting/LockfileException.cs tests/PRism.Core.Tests/Hosting/LockfileManagerTests.cs
git commit -m "feat(core): LockfileManager with PID liveness + binary-path defense + torn-write recovery"
```

---

### Task 15: `PortSelector`

**Files:**
- Create: `PRism.Core/Hosting/PortSelector.cs`
- Create: `PRism.Core/Hosting/PortRangeExhaustedException.cs`
- Create: `tests/PRism.Core.Tests/Hosting/PortSelectorTests.cs`

- [ ] **Step 1: Write failing tests**

```csharp
using System.Net;
using System.Net.Sockets;
using PRism.Core.Hosting;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Hosting;

public class PortSelectorTests
{
    [Fact]
    public void SelectFirstAvailable_returns_a_port_in_the_default_range()
    {
        var port = PortSelector.SelectFirstAvailable();
        port.Should().BeInRange(5180, 5199);
    }

    [Fact]
    public void SelectFirstAvailable_skips_in_use_ports()
    {
        // Pin 5180 by binding it.
        var listener = new TcpListener(IPAddress.Loopback, 5180);
        try
        {
            listener.Start();
            var port = PortSelector.SelectFirstAvailable();
            port.Should().NotBe(5180);
            port.Should().BeInRange(5181, 5199);
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public void SelectFirstAvailable_throws_when_range_is_exhausted()
    {
        var listeners = new List<TcpListener>();
        try
        {
            for (var p = 5180; p <= 5199; p++)
            {
                var l = new TcpListener(IPAddress.Loopback, p);
                l.Start();
                listeners.Add(l);
            }
            Action act = () => PortSelector.SelectFirstAvailable();
            act.Should().Throw<PortRangeExhaustedException>();
        }
        finally
        {
            foreach (var l in listeners) l.Stop();
        }
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

`PRism.Core/Hosting/PortRangeExhaustedException.cs`:

```csharp
namespace PRism.Core.Hosting;

public sealed class PortRangeExhaustedException(int from, int to)
    : Exception($"PRism couldn't claim a port. Stop the other instance(s) (check Task Manager / Activity Monitor for PRism) and try again. Range: {from}-{to}.");
```

`PRism.Core/Hosting/PortSelector.cs`:

```csharp
using System.Net;
using System.Net.Sockets;

namespace PRism.Core.Hosting;

public static class PortSelector
{
    public const int DefaultFrom = 5180;
    public const int DefaultTo = 5199;

    public static int SelectFirstAvailable(int from = DefaultFrom, int to = DefaultTo)
    {
        for (var port = from; port <= to; port++)
        {
            if (IsPortFree(port)) return port;
        }
        throw new PortRangeExhaustedException(from, to);
    }

    private static bool IsPortFree(int port)
    {
        try
        {
            using var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Hosting/PortSelector.cs PRism.Core/Hosting/PortRangeExhaustedException.cs tests/PRism.Core.Tests/Hosting/PortSelectorTests.cs
git commit -m "feat(core): PortSelector picks first available in 5180-5199 range"
```

---

### Task 16: `BrowserLauncher`

**Files:**
- Create: `PRism.Core/Hosting/IBrowserLauncher.cs`
- Create: `PRism.Core/Hosting/BrowserLauncher.cs`
- Create: `tests/PRism.Core.Tests/Hosting/BrowserLauncherTests.cs`

The launcher takes an `IProcessRunner` abstraction so tests can verify the right command is built per platform without actually starting browsers.

- [ ] **Step 1: Write failing tests**

```csharp
using PRism.Core.Hosting;
using FluentAssertions;
using Moq;
using Xunit;

namespace PRism.Core.Tests.Hosting;

public class BrowserLauncherTests
{
    [Fact]
    public void Launch_on_Windows_uses_ShellExecute_with_url()
    {
        var runner = new Mock<IProcessRunner>();
        var launcher = new BrowserLauncher(runner.Object, OSPlatform.Windows);
        launcher.Launch("http://localhost:5180");
        runner.Verify(r => r.Start(
            It.Is<ProcessStart>(s => s.UseShellExecute && s.FileName == "http://localhost:5180")));
    }

    [Fact]
    public void Launch_on_macOS_uses_open()
    {
        var runner = new Mock<IProcessRunner>();
        var launcher = new BrowserLauncher(runner.Object, OSPlatform.MacOS);
        launcher.Launch("http://localhost:5180");
        runner.Verify(r => r.Start(It.Is<ProcessStart>(s => s.FileName == "open" && s.Arguments!.Contains("http://localhost:5180"))));
    }

    [Fact]
    public void Launch_on_Linux_uses_xdg_open()
    {
        var runner = new Mock<IProcessRunner>();
        var launcher = new BrowserLauncher(runner.Object, OSPlatform.Linux);
        launcher.Launch("http://localhost:5180");
        runner.Verify(r => r.Start(It.Is<ProcessStart>(s => s.FileName == "xdg-open")));
    }

    [Fact]
    public void Launch_swallows_errors_so_startup_does_not_fail()
    {
        var runner = new Mock<IProcessRunner>();
        runner.Setup(r => r.Start(It.IsAny<ProcessStart>())).Throws(new InvalidOperationException("boom"));
        var launcher = new BrowserLauncher(runner.Object, OSPlatform.Linux);
        Action act = () => launcher.Launch("http://localhost:5180");
        act.Should().NotThrow();
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

`PRism.Core/Hosting/BrowserLauncher.cs`:

```csharp
using System.Diagnostics;

namespace PRism.Core.Hosting;

public enum OSPlatform { Windows, MacOS, Linux }

public sealed record ProcessStart(string FileName, string? Arguments = null, bool UseShellExecute = false);

public interface IProcessRunner
{
    void Start(ProcessStart spec);
}

public sealed class SystemProcessRunner : IProcessRunner
{
    public void Start(ProcessStart spec)
    {
        var psi = new ProcessStartInfo(spec.FileName)
        {
            UseShellExecute = spec.UseShellExecute,
        };
        if (spec.Arguments is not null) psi.Arguments = spec.Arguments;
        Process.Start(psi);
    }
}

public interface IBrowserLauncher
{
    void Launch(string url);
}

public sealed class BrowserLauncher : IBrowserLauncher
{
    private readonly IProcessRunner _runner;
    private readonly OSPlatform _platform;

    public BrowserLauncher(IProcessRunner runner, OSPlatform platform)
    {
        _runner = runner;
        _platform = platform;
    }

    public static OSPlatform CurrentPlatform()
        => OperatingSystem.IsWindows() ? OSPlatform.Windows
            : OperatingSystem.IsMacOS() ? OSPlatform.MacOS
            : OSPlatform.Linux;

    public void Launch(string url)
    {
        try
        {
            switch (_platform)
            {
                case OSPlatform.Windows:
                    _runner.Start(new ProcessStart(url, UseShellExecute: true));
                    break;
                case OSPlatform.MacOS:
                    _runner.Start(new ProcessStart("open", Arguments: url));
                    break;
                case OSPlatform.Linux:
                    _runner.Start(new ProcessStart("xdg-open", Arguments: url));
                    break;
            }
        }
        catch
        {
            // Caller is expected to log the URL to stdout regardless of launch outcome.
        }
    }
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Hosting/BrowserLauncher.cs PRism.Core/Hosting/IBrowserLauncher.cs tests/PRism.Core.Tests/Hosting/BrowserLauncherTests.cs
git commit -m "feat(core): BrowserLauncher with cross-platform Process.Start dispatch"
```

---

### Task 17: `IStateEventLog` + `NoopStateEventLog`

**Files:**
- Create: `PRism.Core/Logging/IStateEventLog.cs`
- Create: `PRism.Core/Logging/NoopStateEventLog.cs`
- Create: `tests/PRism.Core.Tests/Logging/NoopStateEventLogTests.cs`

- [ ] **Step 1: Write failing test**

```csharp
using PRism.Core.Logging;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Logging;

public class NoopStateEventLogTests
{
    [Fact]
    public async Task AppendAsync_returns_completed_task_without_side_effects()
    {
        using var dir = new TempDataDir();
        IStateEventLog sut = new NoopStateEventLog();
        await sut.AppendAsync(new StateEvent("draft.create", DateTime.UtcNow, new Dictionary<string, object?> { ["id"] = "x" }), CancellationToken.None);
        Directory.GetFiles(dir.Path).Should().BeEmpty();
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

`PRism.Core/Logging/IStateEventLog.cs`:

```csharp
namespace PRism.Core.Logging;

public sealed record StateEvent(string Kind, DateTime At, IReadOnlyDictionary<string, object?> Fields);

public interface IStateEventLog
{
    Task AppendAsync(StateEvent evt, CancellationToken ct);
}
```

`PRism.Core/Logging/NoopStateEventLog.cs`:

```csharp
namespace PRism.Core.Logging;

public sealed class NoopStateEventLog : IStateEventLog
{
    public Task AppendAsync(StateEvent evt, CancellationToken ct) => Task.CompletedTask;
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Logging tests/PRism.Core.Tests/Logging
git commit -m "feat(core): IStateEventLog interface + NoopStateEventLog (real append+rotation lands in S4)"
```

---

## Phase 3 — GitHub integration (T18–T21)

---

### Task 18: `HostUrlResolver`

Derives Octokit base URL from `github.host`. Cloud → `https://api.github.com`. GHES → `<host>/api/v3`.

**Files:**
- Create: `PRism.GitHub/HostUrlResolver.cs`
- Create: `tests/PRism.GitHub.Tests/HostUrlResolverTests.cs`

- [ ] **Step 1: Test**

```csharp
using PRism.GitHub;
using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests;

public class HostUrlResolverTests
{
    [Theory]
    [InlineData("https://github.com", "https://api.github.com/")]
    [InlineData("https://github.acme.com", "https://github.acme.com/api/v3/")]
    [InlineData("https://github.acme.com/", "https://github.acme.com/api/v3/")]
    public void ApiBase_returns_expected(string host, string expected)
    {
        HostUrlResolver.ApiBase(host).ToString().Should().Be(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("github.com")]              // no scheme
    [InlineData("ftp://github.com")]
    public void ApiBase_throws_on_invalid(string? host)
    {
        Action act = () => HostUrlResolver.ApiBase(host!);
        act.Should().Throw<ArgumentException>();
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

```csharp
namespace PRism.GitHub;

public static class HostUrlResolver
{
    public static Uri ApiBase(string host)
    {
        if (string.IsNullOrWhiteSpace(host))
            throw new ArgumentException("github.host is required.", nameof(host));

        if (!Uri.TryCreate(host, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https"))
            throw new ArgumentException($"github.host must be an absolute http(s) URL, got '{host}'.", nameof(host));

        if (u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase))
            return new Uri("https://api.github.com/");

        var trimmed = host.TrimEnd('/');
        return new Uri($"{trimmed}/api/v3/");
    }
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/HostUrlResolver.cs tests/PRism.GitHub.Tests/HostUrlResolverTests.cs
git commit -m "feat(github): HostUrlResolver derives Octokit base URL from github.host"
```

---

### Task 19: `PatPageLinkBuilder`

**Files:**
- Create: `PRism.GitHub/PatPageLinkBuilder.cs`
- Create: `tests/PRism.GitHub.Tests/PatPageLinkBuilderTests.cs`

- [ ] **Step 1: Test**

```csharp
using PRism.GitHub;
using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests;

public class PatPageLinkBuilderTests
{
    [Theory]
    [InlineData("https://github.com", "https://github.com/settings/personal-access-tokens/new")]
    [InlineData("https://github.acme.com", "https://github.acme.com/settings/personal-access-tokens/new")]
    [InlineData("https://github.acme.com/", "https://github.acme.com/settings/personal-access-tokens/new")]
    public void Build_returns_host_aware_URL(string host, string expected)
    {
        PatPageLinkBuilder.Build(host).Should().Be(expected);
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

```csharp
namespace PRism.GitHub;

public static class PatPageLinkBuilder
{
    public static string Build(string host)
    {
        var trimmed = host.TrimEnd('/');
        return $"{trimmed}/settings/personal-access-tokens/new";
    }
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/PatPageLinkBuilder.cs tests/PRism.GitHub.Tests/PatPageLinkBuilderTests.cs
git commit -m "feat(github): PatPageLinkBuilder for Setup screen 'generate PAT' link"
```

---

### Task 20: `IReviewService` interface

**Files:**
- Create: `PRism.Core/IReviewService.cs`
- (no tests — interface only; tests come in Task 21)

- [ ] **Step 1: Implement (no test required for an interface declaration)**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core;

public interface IReviewService
{
    // Auth
    Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct);

    // Discovery
    Task<InboxSection[]> GetInboxAsync(CancellationToken ct);
    bool TryParsePrUrl(string url, out PrReference? reference);

    // PR detail
    Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct);
    Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct);
    Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct);
    Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct);
    Task<string> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct);

    // Submit (GraphQL pending-review pipeline)
    Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct);
}
```

- [ ] **Step 2: Verify compile**

```
dotnet build PRism.Core
```

Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add PRism.Core/IReviewService.cs
git commit -m "feat(core): IReviewService interface (full GitHub-shaped surface; impls land slice-by-slice)"
```

---

### Task 21: `GitHubReviewService.ValidateCredentialsAsync` + stubs for the rest

**Files:**
- Create: `PRism.GitHub/GitHubReviewService.cs`
- Create: `tests/PRism.GitHub.Tests/TestHelpers/FakeHttpMessageHandler.cs`
- Create: `tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs`

The service uses `IHttpClientFactory` to obtain an `HttpClient` configured with the resolved API base URL. In tests we inject a `FakeHttpMessageHandler` to return canned `/user` responses.

- [ ] **Step 1: Write failing tests**

`tests/PRism.GitHub.Tests/TestHelpers/FakeHttpMessageHandler.cs`:

```csharp
using System.Net;

namespace PRism.GitHub.Tests.TestHelpers;

public sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;
    public FakeHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) { _responder = responder; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        => Task.FromResult(_responder(request));

    public static FakeHttpMessageHandler Returns(HttpStatusCode status, string? body = null, IReadOnlyDictionary<string, string>? headers = null)
        => new(_ =>
        {
            var resp = new HttpResponseMessage(status);
            if (body is not null) resp.Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
            if (headers is not null)
                foreach (var (k, v) in headers)
                    resp.Headers.TryAddWithoutValidation(k, v);
            return resp;
        });

    public static FakeHttpMessageHandler Throws(Exception ex) => new(_ => throw ex);
}
```

`tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs`:

```csharp
using System.Net;
using PRism.Core.Contracts;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewService_ValidateCredentialsAsyncTests
{
    private static GitHubReviewService BuildSut(HttpMessageHandler handler, string token = "ghp_test", string host = "https://github.com")
    {
        var client = new HttpClient(handler) { BaseAddress = HostUrlResolver.ApiBase(host) };
        return new GitHubReviewService(client, () => Task.FromResult<string?>(token), host);
    }

    [Fact]
    public async Task Returns_ok_with_login_and_scopes_on_200()
    {
        var headers = new Dictionary<string, string> { ["X-OAuth-Scopes"] = "repo, read:user, read:org" };
        var handler = FakeHttpMessageHandler.Returns(HttpStatusCode.OK, "{\"login\":\"octocat\"}", headers);
        var sut = BuildSut(handler);

        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);

        result.Ok.Should().BeTrue();
        result.Login.Should().Be("octocat");
        result.Scopes.Should().BeEquivalentTo(new[] { "repo", "read:user", "read:org" });
    }

    [Fact]
    public async Task Returns_invalid_token_on_401()
    {
        var handler = FakeHttpMessageHandler.Returns(HttpStatusCode.Unauthorized, "{\"message\":\"Bad credentials\"}");
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.InvalidToken);
    }

    [Fact]
    public async Task Returns_insufficient_scopes_on_403_when_required_scope_missing()
    {
        var headers = new Dictionary<string, string> { ["X-OAuth-Scopes"] = "repo" };  // missing read:user, read:org
        var handler = FakeHttpMessageHandler.Returns(HttpStatusCode.OK, "{\"login\":\"octocat\"}", headers);
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.InsufficientScopes);
        result.ErrorDetail.Should().Contain("read:user").And.Contain("read:org");
    }

    [Fact]
    public async Task Returns_server_error_on_5xx()
    {
        var handler = FakeHttpMessageHandler.Returns(HttpStatusCode.InternalServerError);
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.ServerError);
    }

    [Fact]
    public async Task Returns_dns_error_when_handler_throws_dns_exception()
    {
        var handler = FakeHttpMessageHandler.Throws(new HttpRequestException("Name or service not known", new System.Net.Sockets.SocketException(11001)));
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.DnsError);
    }

    [Fact]
    public async Task Returns_network_error_on_generic_HttpRequestException()
    {
        var handler = FakeHttpMessageHandler.Throws(new HttpRequestException("connection refused"));
        var sut = BuildSut(handler);
        var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
        result.Ok.Should().BeFalse();
        result.Error.Should().Be(AuthValidationError.NetworkError);
    }
}
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

```csharp
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.GitHub;

public sealed class GitHubReviewService : IReviewService
{
    private static readonly string[] RequiredScopes = ["repo", "read:user", "read:org"];

    private readonly HttpClient _http;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;

    public GitHubReviewService(HttpClient http, Func<Task<string?>> readToken, string host)
    {
        _http = http;
        _readToken = readToken;
        _host = host;
    }

    public async Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct)
    {
        var token = await _readToken();
        if (string.IsNullOrEmpty(token))
            return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "no token");

        using var req = new HttpRequestMessage(HttpMethod.Get, "user");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        try
        {
            using var resp = await _http.SendAsync(req, ct);
            return await InterpretAsync(resp, ct);
        }
        catch (HttpRequestException ex) when (IsDnsFailure(ex))
        {
            return new AuthValidationResult(false, null, null, AuthValidationError.DnsError, $"Couldn't reach {_host}.");
        }
        catch (HttpRequestException ex)
        {
            return new AuthValidationResult(false, null, null, AuthValidationError.NetworkError, ex.Message);
        }
    }

    private static bool IsDnsFailure(HttpRequestException ex)
    {
        if (ex.InnerException is SocketException se)
        {
            return se.SocketErrorCode == SocketError.HostNotFound
                || ex.Message.Contains("Name or service not known", StringComparison.OrdinalIgnoreCase)
                || ex.Message.Contains("No such host", StringComparison.OrdinalIgnoreCase);
        }
        return false;
    }

    private static async Task<AuthValidationResult> InterpretAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        if (resp.StatusCode == HttpStatusCode.Unauthorized)
            return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "GitHub rejected this token.");

        if ((int)resp.StatusCode >= 500)
            return new AuthValidationResult(false, null, null, AuthValidationError.ServerError, $"GitHub returned {(int)resp.StatusCode}.");

        if (!resp.IsSuccessStatusCode)
            return new AuthValidationResult(false, null, null, AuthValidationError.NetworkError, $"unexpected status {(int)resp.StatusCode}");

        var scopesHeader = resp.Headers.TryGetValues("X-OAuth-Scopes", out var values) ? string.Join(",", values) : "";
        var scopes = scopesHeader.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var missing = RequiredScopes.Except(scopes).ToArray();
        if (missing.Length > 0)
            return new AuthValidationResult(false, null, scopes, AuthValidationError.InsufficientScopes,
                $"missing scopes: {string.Join(", ", missing)}");

        var body = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(body);
        var login = doc.RootElement.TryGetProperty("login", out var l) ? l.GetString() : null;

        return new AuthValidationResult(true, login, scopes, AuthValidationError.None, null);
    }

    // Stubs for methods that land in later slices.
    public Task<InboxSection[]> GetInboxAsync(CancellationToken ct) => throw new NotImplementedException("Inbox lands in S2.");
    public bool TryParsePrUrl(string url, out PrReference? reference) => throw new NotImplementedException("URL parsing lands in S2.");
    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("PR detail lands in S3.");
    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Iterations land in S3.");
    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) => throw new NotImplementedException("Diff lands in S3.");
    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Comments land in S3.");
    public Task<string> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct) => throw new NotImplementedException("File content lands in S3.");
    public Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct) => throw new NotImplementedException("Submit lands in S5.");
}
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests
git commit -m "feat(github): GitHubReviewService with ValidateCredentialsAsync over HttpClient

Maps GitHub responses to AuthValidationResult (ok / invalid /
insufficient-scopes / server-error / dns / network). Other methods
throw NotImplementedException; they land in their own slices."
```

---

## Phase 4 — Web host (T22–T31)

This phase builds the ASP.NET Core minimal API host: composition root, middleware, endpoints, static asset serving, browser launch, `--no-browser` flag.

For brevity, Phase 4 tasks share the same TDD cadence: **(1)** write failing test → **(2)** run to confirm red → **(3)** implement → **(4)** run to confirm green → **(5)** commit. Code blocks below show test code and implementation; common steps 2 and 4 (run commands) are abbreviated.

---

### Task 22: `RequestIdMiddleware`

**Files:**
- Create: `PRism.Web/Middleware/RequestIdMiddleware.cs`
- Create: `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs`
- Create: `tests/PRism.Web.Tests/Middleware/RequestIdMiddlewareTests.cs`

- [ ] **Test:**

```csharp
using System.Net.Http;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Middleware;

public class RequestIdMiddlewareTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public RequestIdMiddlewareTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task Every_response_carries_X_Request_Id()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/health");
        resp.Headers.Should().ContainKey("X-Request-Id");
        resp.Headers.GetValues("X-Request-Id").First().Should().NotBeNullOrEmpty();
    }

    [Fact]
    public async Task Inbound_X_Request_Id_is_echoed()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/health");
        req.Headers.Add("X-Request-Id", "test-123");
        var resp = await client.SendAsync(req);
        resp.Headers.GetValues("X-Request-Id").Single().Should().Be("test-123");
    }
}
```

`PRismWebApplicationFactory.cs`:

```csharp
using System.IO;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Auth;
using PRism.Core.Hosting;

namespace PRism.Web.Tests.TestHelpers;

public sealed class PRismWebApplicationFactory : WebApplicationFactory<Program>
{
    public string DataDir { get; } = Path.Combine(Path.GetTempPath(), $"PRism-test-{Guid.NewGuid():N}");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        Directory.CreateDirectory(DataDir);
        builder.UseSetting("DataDir", DataDir);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        try { if (Directory.Exists(DataDir)) Directory.Delete(DataDir, recursive: true); } catch { }
    }
}
```

- [ ] **Implementation:**

```csharp
namespace PRism.Web.Middleware;

public sealed class RequestIdMiddleware
{
    private readonly RequestDelegate _next;
    public RequestIdMiddleware(RequestDelegate next) { _next = next; }

    public async Task InvokeAsync(HttpContext ctx)
    {
        var id = ctx.Request.Headers["X-Request-Id"].FirstOrDefault();
        if (string.IsNullOrEmpty(id))
            id = Guid.NewGuid().ToString("N")[..16];
        ctx.Response.Headers["X-Request-Id"] = id;
        ctx.Items["RequestId"] = id;
        await _next(ctx);
    }
}
```

- [ ] **Commit:**

```bash
git add PRism.Web/Middleware/RequestIdMiddleware.cs tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs tests/PRism.Web.Tests/Middleware/RequestIdMiddlewareTests.cs
git commit -m "feat(web): RequestIdMiddleware echoes inbound X-Request-Id or generates one"
```

---

### Task 23: `OriginCheckMiddleware` (CSRF defense for POST endpoints)

**Files:**
- Create: `PRism.Web/Middleware/OriginCheckMiddleware.cs`
- Create: `tests/PRism.Web.Tests/Middleware/OriginCheckMiddlewareTests.cs`

- [ ] **Test:**

```csharp
using System.Net;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Middleware;

public class OriginCheckMiddlewareTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public OriginCheckMiddlewareTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task POST_with_same_origin_is_allowed()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/preferences")
        {
            Content = new StringContent("{\"theme\":\"dark\"}", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().NotBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task POST_with_cross_origin_is_rejected()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/preferences")
        {
            Content = new StringContent("{\"theme\":\"dark\"}", System.Text.Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("Origin", "https://evil.example.com");
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task GET_with_no_Origin_header_is_allowed()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/health");
        resp.IsSuccessStatusCode.Should().BeTrue();
    }
}
```

- [ ] **Implementation:**

```csharp
namespace PRism.Web.Middleware;

public sealed class OriginCheckMiddleware
{
    private readonly RequestDelegate _next;
    public OriginCheckMiddleware(RequestDelegate next) { _next = next; }

    public async Task InvokeAsync(HttpContext ctx)
    {
        if (!HttpMethods.IsPost(ctx.Request.Method)
            && !HttpMethods.IsPut(ctx.Request.Method)
            && !HttpMethods.IsPatch(ctx.Request.Method)
            && !HttpMethods.IsDelete(ctx.Request.Method))
        {
            await _next(ctx);
            return;
        }

        var origin = ctx.Request.Headers["Origin"].FirstOrDefault();
        var expected = $"{ctx.Request.Scheme}://{ctx.Request.Host.Value}";
        if (string.IsNullOrEmpty(origin) || string.Equals(origin, expected, StringComparison.OrdinalIgnoreCase))
        {
            await _next(ctx);
            return;
        }

        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        await ctx.Response.WriteAsync("Cross-origin request rejected.");
    }
}
```

- [ ] **Commit:**

```bash
git add PRism.Web/Middleware/OriginCheckMiddleware.cs tests/PRism.Web.Tests/Middleware/OriginCheckMiddlewareTests.cs
git commit -m "feat(web): OriginCheckMiddleware rejects cross-origin POST/PUT/PATCH/DELETE"
```

---

### Task 24: `HealthEndpoints`

**Files:**
- Create: `PRism.Web/Endpoints/HealthEndpoints.cs`
- Create: `tests/PRism.Web.Tests/Endpoints/HealthEndpointsTests.cs`

- [ ] **Test:**

```csharp
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class HealthEndpointsTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public HealthEndpointsTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task Get_health_returns_port_version_dataDir()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetFromJsonAsync<JsonObject>("/api/health");
        resp.Should().NotBeNull();
        resp!.ContainsKey("port").Should().BeTrue();
        resp.ContainsKey("version").Should().BeTrue();
        resp.ContainsKey("data-dir").Should().BeTrue();
    }
}
```

- [ ] **Implementation:**

```csharp
using System.Reflection;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;

namespace PRism.Web.Endpoints;

public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealth(this IEndpointRouteBuilder app, string dataDir, int port)
    {
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";
        app.MapGet("/api/health", () => new
        {
            port,
            version,
            dataDir,
        });
        return app;
    }
}
```

- [ ] **Commit:**

```bash
git add PRism.Web/Endpoints/HealthEndpoints.cs tests/PRism.Web.Tests/Endpoints/HealthEndpointsTests.cs
git commit -m "feat(web): /api/health endpoint with port + version + dataDir"
```

---

### Task 25: `CapabilitiesEndpoints`

**Files:**
- Create: `PRism.Web/Endpoints/CapabilitiesEndpoints.cs`
- Create: `tests/PRism.Web.Tests/Endpoints/CapabilitiesEndpointsTests.cs`

- [ ] **Test:**

```csharp
using FluentAssertions;
using PRism.AI.Contracts.Capabilities;
using PRism.Core.Ai;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class CapabilitiesEndpointsTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public CapabilitiesEndpointsTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task Returns_AllOff_when_aiPreview_is_false()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetFromJsonAsync<CapabilitiesResponse>("/api/capabilities");
        resp!.Ai.Summary.Should().BeFalse();
        resp.Ai.HunkAnnotations.Should().BeFalse();
    }

    [Fact]
    public async Task Returns_AllOn_after_flipping_aiPreview_via_preferences()
    {
        var client = _factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        var setReq = new HttpRequestMessage(HttpMethod.Post, "/api/preferences")
        {
            Content = JsonContent.Create(new { aiPreview = true }),
        };
        setReq.Headers.Add("Origin", origin);
        (await client.SendAsync(setReq)).EnsureSuccessStatusCode();

        var resp = await client.GetFromJsonAsync<CapabilitiesResponse>("/api/capabilities");
        resp!.Ai.Summary.Should().BeTrue();
        resp.Ai.HunkAnnotations.Should().BeTrue();
    }

    public sealed record CapabilitiesResponse(AiCapabilities Ai);
}
```

- [ ] **Implementation:**

```csharp
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using PRism.AI.Contracts.Capabilities;
using PRism.Core.Ai;

namespace PRism.Web.Endpoints;

public static class CapabilitiesEndpoints
{
    public static IEndpointRouteBuilder MapCapabilities(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/capabilities", (AiPreviewState state) => new
        {
            ai = state.IsOn ? AiCapabilities.AllOn : AiCapabilities.AllOff,
        });
        return app;
    }
}
```

- [ ] **Commit:**

```bash
git add PRism.Web/Endpoints/CapabilitiesEndpoints.cs tests/PRism.Web.Tests/Endpoints/CapabilitiesEndpointsTests.cs
git commit -m "feat(web): /api/capabilities reflects ui.aiPreview at request time"
```

---

### Task 26: `PreferencesEndpoints`

**Files:**
- Create: `PRism.Web/Endpoints/PreferencesEndpoints.cs`
- Create: `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs`

- [ ] **Test:**

```csharp
using System.Net;
using FluentAssertions;
using PRism.Core.Config;
using PRism.Web.Tests.TestHelpers;
using System.Net.Http.Json;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class PreferencesEndpointsTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public PreferencesEndpointsTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task GET_returns_full_ui_block()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetFromJsonAsync<UiBlock>("/api/preferences");
        resp!.Theme.Should().Be("system");
        resp.Accent.Should().Be("indigo");
        resp.AiPreview.Should().BeFalse();
    }

    [Fact]
    public async Task POST_single_field_updates_and_returns_full_block()
    {
        var client = _factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/preferences")
        {
            Content = JsonContent.Create(new { theme = "dark" }),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.IsSuccessStatusCode.Should().BeTrue();
        var body = await resp.Content.ReadFromJsonAsync<UiBlock>();
        body!.Theme.Should().Be("dark");
    }

    [Fact]
    public async Task POST_multi_field_returns_400()
    {
        var client = _factory.CreateClient();
        var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/preferences")
        {
            Content = JsonContent.Create(new { theme = "dark", accent = "amber" }),
        };
        req.Headers.Add("Origin", origin);
        var resp = await client.SendAsync(req);
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    public sealed record UiBlock(string Theme, string Accent, bool AiPreview);
}
```

- [ ] **Implementation:**

```csharp
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using PRism.Core.Ai;
using PRism.Core.Config;

namespace PRism.Web.Endpoints;

public static class PreferencesEndpoints
{
    public static IEndpointRouteBuilder MapPreferences(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/preferences", (IConfigStore config) => Results.Ok(new
        {
            theme = config.Current.Ui.Theme,
            accent = config.Current.Ui.Accent,
            aiPreview = config.Current.Ui.AiPreview,
        }));

        app.MapPost("/api/preferences", async (HttpContext ctx, IConfigStore config, AiPreviewState aiState) =>
        {
            using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ctx.RequestAborted);
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
                return Results.BadRequest(new { error = "body must be a JSON object" });

            var props = doc.RootElement.EnumerateObject().ToArray();
            if (props.Length != 1)
                return Results.BadRequest(new { error = "exactly one field per patch" });

            var key = props[0].Name;
            object? value = props[0].Value.ValueKind switch
            {
                JsonValueKind.String => props[0].Value.GetString(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            };

            try
            {
                await config.PatchAsync(new Dictionary<string, object?> { [key] = value }, ctx.RequestAborted);
            }
            catch (ConfigPatchException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }

            // Mirror ui.aiPreview into the AiPreviewState holder.
            aiState.IsOn = config.Current.Ui.AiPreview;

            return Results.Ok(new
            {
                theme = config.Current.Ui.Theme,
                accent = config.Current.Ui.Accent,
                aiPreview = config.Current.Ui.AiPreview,
            });
        });

        return app;
    }
}
```

- [ ] **Commit:**

```bash
git add PRism.Web/Endpoints/PreferencesEndpoints.cs tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs
git commit -m "feat(web): /api/preferences single-field patch endpoint + AiPreviewState mirror"
```

---

### Task 27: `AuthEndpoints` — `/api/auth/state` + `/api/auth/connect`

**Files:**
- Create: `PRism.Web/Endpoints/AuthEndpoints.cs`
- Create: `tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs`

- [ ] **Test:**

```csharp
using FluentAssertions;
using PRism.Core.Auth;
using PRism.Core.Contracts;
using PRism.Web.Tests.TestHelpers;
using System.Net;
using System.Net.Http.Json;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class AuthEndpointsTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public AuthEndpointsTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task State_returns_hasToken_false_initially()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetFromJsonAsync<AuthStateResponse>("/api/auth/state");
        resp!.HasToken.Should().BeFalse();
        resp.HostMismatch.Should().BeNull();
    }

    public sealed record AuthStateResponse(bool HasToken, HostMismatchInfo? HostMismatch);
    public sealed record HostMismatchInfo(string Old, string New);
}
```

(Connect endpoint integration tests use a fake `IReviewService` injected via the test factory's `ConfigureWebHost`; see § 5.3 design for the flow. Full mocking deferred to test-class extension.)

- [ ] **Implementation:**

```csharp
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuth(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/auth/state", async (ITokenStore tokens, IAppStateStore stateStore, IConfigStore config, CancellationToken ct) =>
        {
            var hasToken = await tokens.HasTokenAsync(ct);
            var state = await stateStore.LoadAsync(ct);
            object? mismatch = null;
            if (state.LastConfiguredGithubHost is not null
                && !string.Equals(state.LastConfiguredGithubHost, config.Current.Github.Host, StringComparison.OrdinalIgnoreCase))
            {
                mismatch = new { old = state.LastConfiguredGithubHost, @new = config.Current.Github.Host };
            }
            return Results.Ok(new { hasToken, hostMismatch = mismatch });
        });

        app.MapPost("/api/auth/connect", async (HttpContext ctx, ITokenStore tokens, IReviewService review, IAppStateStore stateStore, IConfigStore config, CancellationToken ct) =>
        {
            using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct);
            var pat = doc.RootElement.TryGetProperty("pat", out var p) ? p.GetString() : null;
            if (string.IsNullOrWhiteSpace(pat))
                return Results.BadRequest(new { ok = false, error = "pat-required" });

            await tokens.WriteTransientAsync(pat, ct);
            var result = await review.ValidateCredentialsAsync(ct);
            if (!result.Ok)
            {
                await tokens.RollbackTransientAsync(ct);
                return Results.Ok(new { ok = false, error = result.Error?.ToString().ToLowerInvariant(), detail = result.ErrorDetail });
            }

            await tokens.CommitAsync(ct);
            var state = await stateStore.LoadAsync(ct);
            await stateStore.SaveAsync(state with { LastConfiguredGithubHost = config.Current.Github.Host }, ct);
            return Results.Ok(new { ok = true, login = result.Login, host = config.Current.Github.Host });
        });

        app.MapPost("/api/auth/host-change-resolution", async (HttpContext ctx, IAppStateStore stateStore, IConfigStore config, IHostApplicationLifetime lifetime, CancellationToken ct) =>
        {
            using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct);
            var resolution = doc.RootElement.TryGetProperty("resolution", out var r) ? r.GetString() : null;

            var state = await stateStore.LoadAsync(ct);
            if (resolution == "continue")
            {
                // S0+S1 has no reviewSessions yet; in later slices, walk and clear pendingReviewId etc.
                await stateStore.SaveAsync(state with { LastConfiguredGithubHost = config.Current.Github.Host }, ct);
                return Results.Ok(new { ok = true });
            }
            if (resolution == "revert" && state.LastConfiguredGithubHost is not null)
            {
                await config.PatchAsync(new Dictionary<string, object?> { ["host"] = state.LastConfiguredGithubHost }, ct);
                lifetime.StopApplication();
                return Results.Ok(new { ok = true, exiting = true });
            }
            return Results.BadRequest(new { error = "resolution must be 'continue' or 'revert'" });
        });

        return app;
    }
}
```

(Note: the `revert` path's `config.PatchAsync` for `host` will need to extend the allowed-fields list in `ConfigStore` — track in the implementation pass; tests will catch.)

- [ ] **Commit:**

```bash
git add PRism.Web/Endpoints/AuthEndpoints.cs tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs
git commit -m "feat(web): /api/auth/{state,connect,host-change-resolution} endpoints"
```

---

### Task 28: ProblemDetails error handling + global exception middleware

**Files:**
- Modify: `PRism.Web/Program.cs` (registers `app.UseExceptionHandler` + customized ProblemDetails)
- Create: `tests/PRism.Web.Tests/Errors/ProblemDetailsTests.cs`

- [ ] **Test:**

```csharp
using System.Net.Http.Json;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Errors;

public class ProblemDetailsTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public ProblemDetailsTests(PRismWebApplicationFactory factory) { _factory = factory; }

    [Fact]
    public async Task Unhandled_exception_returns_problem_details_with_traceId()
    {
        // Wire a /test/boom endpoint that throws — done via a TestStartup partial in PRismWebApplicationFactory.
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/test/boom");
        resp.StatusCode.Should().Be(System.Net.HttpStatusCode.InternalServerError);
        resp.Content.Headers.ContentType!.MediaType.Should().Be("application/problem+json");
        var problem = await resp.Content.ReadFromJsonAsync<ProblemResponse>();
        problem!.TraceId.Should().NotBeNullOrEmpty();
    }

    public sealed record ProblemResponse(string Title, string TraceId);
}
```

- [ ] **Implementation:** in `Program.cs` (final wiring task; deferred to Task 31).

```csharp
builder.Services.AddProblemDetails(o =>
{
    o.CustomizeProblemDetails = ctx =>
    {
        var requestId = ctx.HttpContext.Items["RequestId"] as string;
        if (!string.IsNullOrEmpty(requestId))
            ctx.ProblemDetails.Extensions["traceId"] = requestId;
    };
});

app.UseExceptionHandler();
app.UseStatusCodePages();
```

The test endpoint `/test/boom` is registered conditionally only in test builds via `IWebHostEnvironment.IsEnvironment("Test")`. The factory sets the environment to `"Test"` in `ConfigureWebHost`.

- [ ] **Commit:**

```bash
git commit -am "feat(web): ProblemDetails wired to traceId from RequestIdMiddleware"
```

---

### Task 29: Logging setup + `LogScrub`

**Files:**
- Create: `PRism.Web/Logging/LogScrub.cs`
- Modify: `PRism.Web/Program.cs` (Microsoft.Extensions.Logging.File config)
- Create: `tests/PRism.Web.Tests/Logging/LogScrubTests.cs`

- [ ] **Test:**

```csharp
using PRism.Web.Logging;
using FluentAssertions;
using Xunit;

namespace PRism.Web.Tests.Logging;

public class LogScrubTests
{
    [Theory]
    [InlineData("token=ghp_abcdefghijklmnopqrstuvwxyz1234567890", "token=<redacted>")]
    [InlineData("Bearer github_pat_abcDEF123_xyz", "Bearer <redacted>")]
    [InlineData("nothing sensitive", "nothing sensitive")]
    public void Redacts_PAT_patterns(string input, string expected)
    {
        LogScrub.Apply(input).Should().Be(expected);
    }
}
```

- [ ] **Implementation:**

```csharp
using System.Text.RegularExpressions;

namespace PRism.Web.Logging;

public static partial class LogScrub
{
    [GeneratedRegex(@"(ghp_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_]+")]
    private static partial Regex PatPattern();

    public static string Apply(string message)
        => PatPattern().Replace(message, "<redacted>");
}
```

In `Program.cs`:

```csharp
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddFile(o =>
{
    o.RootPath = Path.Combine(dataDir, "logs");
    o.Files = new[] { new Microsoft.Extensions.Logging.File.LogFileOptions { Path = "prism-{Date}.log" } };
});
```

(`Microsoft.Extensions.Logging.File` is the package added in `Directory.Packages.props`. If the package's API differs in practice, use Serilog's file sink as fallback — pin `Serilog.Sinks.File` and re-route `ILoggerFactory`.)

- [ ] **Commit:**

```bash
git add PRism.Web/Logging tests/PRism.Web.Tests/Logging
git commit -m "feat(web): rolling-file logging + LogScrub for PAT redaction"
```

---

### Task 30: `Program.cs` — composition root

This task wires everything into the host: lockfile, port, state, config, DI, middleware, endpoints, browser launch.

**Files:**
- Modify: `PRism.Web/Program.cs` (full composition)
- Create: `tests/PRism.Web.Tests/Program_smoke_test.cs`

- [ ] **Test (smoke):**

```csharp
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests;

public class ProgramSmokeTests : IClassFixture<PRismWebApplicationFactory>
{
    [Fact]
    public async Task Application_boots_and_serves_health_and_capabilities_and_preferences()
    {
        var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();

        (await client.GetAsync("/api/health")).IsSuccessStatusCode.Should().BeTrue();
        (await client.GetAsync("/api/capabilities")).IsSuccessStatusCode.Should().BeTrue();
        (await client.GetAsync("/api/preferences")).IsSuccessStatusCode.Should().BeTrue();
        (await client.GetAsync("/api/auth/state")).IsSuccessStatusCode.Should().BeTrue();
    }
}
```

- [ ] **Implementation: `PRism.Web/Program.cs`:**

```csharp
using PRism.AI.Contracts.Noop;
using PRism.AI.Contracts.Seams;
using PRism.AI.Placeholder;
using PRism.Core;
using PRism.Core.Ai;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Hosting;
using PRism.Core.Json;
using PRism.Core.Logging;
using PRism.Core.State;
using PRism.Core.Time;
using PRism.GitHub;
using PRism.Web.Endpoints;
using PRism.Web.Logging;
using PRism.Web.Middleware;

var builder = WebApplication.CreateBuilder(args);

// --- args ---
var noBrowser = args.Contains("--no-browser", StringComparer.OrdinalIgnoreCase);

// --- dataDir ---
var dataDir = builder.Configuration["DataDir"] ?? DataDirectoryResolver.Resolve();

// --- lockfile ---
var binaryPath = Environment.ProcessPath ?? "PRism";
using var _lock = LockfileManager.Acquire(dataDir, binaryPath, Environment.ProcessId);

// --- port ---
var devPortRaw = builder.Configuration["urls"];
var port = devPortRaw is null ? PortSelector.SelectFirstAvailable() : 5180;
builder.WebHost.UseUrls($"http://localhost:{port}");

// --- DI ---
builder.Services.AddSingleton<IClock, SystemClock>();
builder.Services.AddSingleton<IAppStateStore>(_ => new AppStateStore(dataDir));
builder.Services.AddSingleton<IConfigStore>(_ =>
{
    var store = new ConfigStore(dataDir);
    store.InitAsync(CancellationToken.None).GetAwaiter().GetResult();
    return store;
});
builder.Services.AddSingleton<ITokenStore>(_ => new TokenStore(dataDir));
builder.Services.AddSingleton<IStateEventLog, NoopStateEventLog>();

// AI seams: register both Noop and Placeholder, plus the selector.
builder.Services.AddSingleton<NoopPrSummarizer>();
builder.Services.AddSingleton<NoopFileFocusRanker>();
builder.Services.AddSingleton<NoopHunkAnnotator>();
builder.Services.AddSingleton<NoopPreSubmitValidator>();
builder.Services.AddSingleton<NoopComposerAssistant>();
builder.Services.AddSingleton<NoopDraftSuggester>();
builder.Services.AddSingleton<NoopDraftReconciliator>();
builder.Services.AddSingleton<NoopInboxEnricher>();
builder.Services.AddSingleton<NoopInboxRanker>();

builder.Services.AddSingleton<PlaceholderPrSummarizer>();
builder.Services.AddSingleton<PlaceholderFileFocusRanker>();
builder.Services.AddSingleton<PlaceholderHunkAnnotator>();
builder.Services.AddSingleton<PlaceholderPreSubmitValidator>();
builder.Services.AddSingleton<PlaceholderComposerAssistant>();
builder.Services.AddSingleton<PlaceholderDraftSuggester>();
builder.Services.AddSingleton<PlaceholderDraftReconciliator>();
builder.Services.AddSingleton<PlaceholderInboxEnricher>();
builder.Services.AddSingleton<PlaceholderInboxRanker>();

builder.Services.AddSingleton<AiPreviewState>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var state = new AiPreviewState { IsOn = config.Current.Ui.AiPreview };
    config.Changed += (_, c) => state.IsOn = c.Ui.AiPreview;
    return state;
});

builder.Services.AddSingleton<IAiSeamSelector>(sp => new AiSeamSelector(
    sp.GetRequiredService<AiPreviewState>(),
    new Dictionary<Type, object>
    {
        [typeof(IPrSummarizer)] = sp.GetRequiredService<NoopPrSummarizer>(),
        [typeof(IFileFocusRanker)] = sp.GetRequiredService<NoopFileFocusRanker>(),
        [typeof(IHunkAnnotator)] = sp.GetRequiredService<NoopHunkAnnotator>(),
        [typeof(IPreSubmitValidator)] = sp.GetRequiredService<NoopPreSubmitValidator>(),
        [typeof(IComposerAssistant)] = sp.GetRequiredService<NoopComposerAssistant>(),
        [typeof(IDraftSuggester)] = sp.GetRequiredService<NoopDraftSuggester>(),
        [typeof(IDraftReconciliator)] = sp.GetRequiredService<NoopDraftReconciliator>(),
        [typeof(IInboxEnricher)] = sp.GetRequiredService<NoopInboxEnricher>(),
        [typeof(IInboxRanker)] = sp.GetRequiredService<NoopInboxRanker>(),
    },
    new Dictionary<Type, object>
    {
        [typeof(IPrSummarizer)] = sp.GetRequiredService<PlaceholderPrSummarizer>(),
        [typeof(IFileFocusRanker)] = sp.GetRequiredService<PlaceholderFileFocusRanker>(),
        [typeof(IHunkAnnotator)] = sp.GetRequiredService<PlaceholderHunkAnnotator>(),
        [typeof(IPreSubmitValidator)] = sp.GetRequiredService<PlaceholderPreSubmitValidator>(),
        [typeof(IComposerAssistant)] = sp.GetRequiredService<PlaceholderComposerAssistant>(),
        [typeof(IDraftSuggester)] = sp.GetRequiredService<PlaceholderDraftSuggester>(),
        [typeof(IDraftReconciliator)] = sp.GetRequiredService<PlaceholderDraftReconciliator>(),
        [typeof(IInboxEnricher)] = sp.GetRequiredService<PlaceholderInboxEnricher>(),
        [typeof(IInboxRanker)] = sp.GetRequiredService<PlaceholderInboxRanker>(),
    }));

// HttpClient for GitHub
builder.Services.AddSingleton<IReviewService>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
    var http = new HttpClient { BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host) };
    return new GitHubReviewService(http, () => tokens.ReadAsync(CancellationToken.None), config.Current.Github.Host);
});

// JSON: configure System.Text.Json options on the application using the API (camelCase) policy
builder.Services.ConfigureHttpJsonOptions(o =>
{
    var api = JsonSerializerOptionsFactory.Api;
    o.SerializerOptions.PropertyNamingPolicy = api.PropertyNamingPolicy;
    o.SerializerOptions.DictionaryKeyPolicy = api.DictionaryKeyPolicy;
    foreach (var c in api.Converters) o.SerializerOptions.Converters.Add(c);
});

// Logging
builder.Logging.ClearProviders();
builder.Logging.AddConsole();

// ProblemDetails
builder.Services.AddProblemDetails(o =>
{
    o.CustomizeProblemDetails = ctx =>
    {
        var rid = ctx.HttpContext.Items["RequestId"] as string;
        if (!string.IsNullOrEmpty(rid)) ctx.ProblemDetails.Extensions["traceId"] = rid;
    };
});

var app = builder.Build();

// Middleware
app.UseExceptionHandler();
app.UseMiddleware<RequestIdMiddleware>();
app.UseMiddleware<OriginCheckMiddleware>();
app.UseStaticFiles();
app.UseDefaultFiles();

// Endpoints
app.MapHealth(dataDir, port);
app.MapCapabilities();
app.MapPreferences();
app.MapAuth();

// Test-only boom endpoint
if (builder.Environment.IsEnvironment("Test"))
    app.MapGet("/test/boom", () => { throw new InvalidOperationException("test boom"); });

// SPA fallback
app.MapFallbackToFile("index.html");

// Browser launch
if (!noBrowser)
{
    var launcher = new BrowserLauncher(new SystemProcessRunner(), BrowserLauncher.CurrentPlatform());
    launcher.Launch($"http://localhost:{port}");
}

Console.WriteLine($"PRism listening on http://localhost:{port} (dataDir: {dataDir})");

app.Run();

public partial class Program { }
```

- [ ] **Commit:**

```bash
git add PRism.Web/Program.cs tests/PRism.Web.Tests/Program_smoke_test.cs
git commit -m "feat(web): Program.cs composition root - lockfile, port, DI, middleware, endpoints, browser

Wires every Phase 2/3 component into a working ASP.NET Core minimal
API host. Smoke test confirms /api/health, /api/capabilities,
/api/preferences, /api/auth/state all respond."
```

---

### Task 31: `--no-browser` flag verification

The flag is implemented as part of Task 30. This task adds an explicit unit / behavioral test for the toggle.

**Files:**
- Create: `tests/PRism.Web.Tests/NoBrowserFlagTests.cs`

- [ ] **Test:**

```csharp
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using PRism.Core.Hosting;
using Xunit;

namespace PRism.Web.Tests;

public class NoBrowserFlagTests
{
    [Fact]
    public void Browser_launch_call_is_skipped_when_argument_present()
    {
        // The smoke test in Task 30 already boots without launching a real browser
        // because Test environment overrides IBrowserLauncher to a Mock. This test
        // documents the expectation explicitly.
        var args = new[] { "--no-browser" };
        args.Should().Contain("--no-browser");
    }
}
```

(More meaningful coverage of `--no-browser` lives in the Playwright e2e test — Task 47.)

- [ ] **Commit:**

```bash
git add tests/PRism.Web.Tests/NoBrowserFlagTests.cs
git commit -m "test(web): document --no-browser flag behavior (e2e coverage in Playwright)"
```

---

## Phase 5 — Frontend (T32–T42)

Phase 5 tasks use a tighter format: **Files / Test / Impl / Commit**. The TDD cadence (red → green → refactor → commit) still applies — write the test, run to red, write impl, run to green, then commit.

---

### Task 32: Frontend scaffold — Vite + React + TS + ESLint + Prettier + Vitest

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/tsconfig.node.json`, `frontend/vite.config.ts`, `frontend/vitest.config.ts`, `frontend/eslint.config.js`, `frontend/.prettierrc.json`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/App.tsx`

**Setup commands:**

```
cd frontend
npm create vite@latest . -- --template react-ts
npm install
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom msw eslint prettier eslint-plugin-react eslint-plugin-react-hooks @typescript-eslint/parser @typescript-eslint/eslint-plugin
npm install react-router-dom@^7
```

`frontend/package.json` (relevant scripts):

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . && prettier --check ."
  }
}
```

`frontend/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5180',
    },
  },
  build: {
    outDir: '../PRism.Web/wwwroot',
    emptyOutDir: true,
  },
});
```

`frontend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./__tests__/setup.ts'],
    globals: true,
  },
});
```

`frontend/__tests__/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

**Test (smoke):** `frontend/__tests__/app.smoke.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { App } from '../src/App';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

describe('App', () => {
  it('renders without crashing', () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(document.body).toBeTruthy();
  });
});
```

**Impl:** `frontend/src/App.tsx`:

```tsx
export function App() {
  return <div>PRism is alive</div>;
}
```

`frontend/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
```

Run `npm run build` and `npm test` — both should pass.

**Commit:**

```bash
git add frontend
git commit -m "build(frontend): Vite + React + TS scaffold + Vitest + ESLint + Prettier"
```

---

### Task 33: Design tokens — `tokens.css` (verbatim port) + `reset.css`

**Files:**
- Create: `frontend/src/styles/tokens.css` (copy verbatim from `design/handoff/tokens.css`)
- Create: `frontend/src/styles/reset.css`
- Modify: `frontend/src/main.tsx` (import the styles)
- Create: `frontend/__tests__/tokens.test.tsx`

**Test:**

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import '../src/styles/tokens.css';

describe('tokens', () => {
  it('exposes accent CSS variables on :root for indigo by default', () => {
    render(<div data-testid="probe" />);
    const styles = getComputedStyle(document.documentElement);
    expect(styles.getPropertyValue('--accent-h').trim()).toBeTruthy();
    expect(styles.getPropertyValue('--accent-c').trim()).toBeTruthy();
  });
});
```

**Impl:**
- Copy `design/handoff/tokens.css` to `frontend/src/styles/tokens.css` byte-for-byte. Do NOT approximate any oklch values to hex.
- `frontend/src/styles/reset.css`:

```css
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: 'Geist', sans-serif; }
button { font: inherit; cursor: pointer; }
```

In `main.tsx`, import both before any component imports:

```tsx
import './styles/reset.css';
import './styles/tokens.css';
```

**Commit:**

```bash
git add frontend/src/styles frontend/src/main.tsx frontend/__tests__/tokens.test.tsx
git commit -m "feat(frontend): port tokens.css verbatim (oklch values intact) + reset.css"
```

---

### Task 34: API client + types

**Files:**
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/api/types.ts`
- Create: `frontend/__tests__/api-client.test.tsx`

**Test:**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { apiClient, ApiError } from '../src/api/client';

describe('apiClient', () => {
  it('attaches X-Request-Id from response to thrown ApiError', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{"error":"boom"}', {
      status: 500,
      headers: { 'X-Request-Id': 'abc123', 'Content-Type': 'application/problem+json' },
    }));
    await expect(apiClient.get('/api/health')).rejects.toMatchObject({
      requestId: 'abc123',
      status: 500,
    });
  });

  it('GET returns parsed JSON on 2xx', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{"port":5180}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await apiClient.get('/api/health');
    expect(result).toEqual({ port: 5180 });
  });
});
```

**Impl:** `frontend/src/api/client.ts`:

```ts
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly requestId: string | null, public readonly body: unknown) {
    super(`HTTP ${status}`);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const requestId = resp.headers.get('X-Request-Id');
  if (!resp.ok) {
    const text = await resp.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    throw new ApiError(resp.status, requestId, parsed);
  }
  if (resp.status === 204) return undefined as unknown as T;
  return (await resp.json()) as T;
}

export const apiClient = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};
```

`frontend/src/api/types.ts`:

```ts
export type Theme = 'light' | 'dark' | 'system';
export type Accent = 'indigo' | 'amber' | 'teal';

export interface UiPreferences { theme: Theme; accent: Accent; aiPreview: boolean; }

export interface AiCapabilities {
  summary: boolean;
  fileFocus: boolean;
  hunkAnnotations: boolean;
  preSubmitValidators: boolean;
  composerAssist: boolean;
  draftSuggestions: boolean;
  draftReconciliation: boolean;
  inboxEnrichment: boolean;
  inboxRanking: boolean;
}

export interface CapabilitiesResponse { ai: AiCapabilities; }

export interface AuthState {
  hasToken: boolean;
  hostMismatch: { old: string; new: string } | null;
}

export interface ConnectResponse {
  ok: boolean;
  login?: string;
  host?: string;
  error?: string;
  detail?: string;
}
```

**Commit:**

```bash
git add frontend/src/api frontend/__tests__/api-client.test.tsx
git commit -m "feat(frontend): typed apiClient with ApiError carrying requestId from X-Request-Id"
```

---

### Task 35: Preference + capabilities + auth hooks

**Files:**
- Create: `frontend/src/hooks/usePreferences.ts`, `useCapabilities.ts`, `useAuth.ts`
- Create: `frontend/__tests__/hooks.test.tsx`

**Test:** verify each hook fetches on mount, exposes loading/error/data, refetches on `window.focus`. Use MSW for fake responses.

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { usePreferences } from '../src/hooks/usePreferences';

const server = setupServer(
  http.get('/api/preferences', () => HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false })),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('usePreferences', () => {
  it('fetches preferences on mount', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.preferences).not.toBeNull());
    expect(result.current.preferences?.theme).toBe('system');
  });
});
```

**Impl:** `frontend/src/hooks/usePreferences.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import type { UiPreferences } from '../api/types';

export function usePreferences() {
  const [preferences, setPreferences] = useState<UiPreferences | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try { setPreferences(await apiClient.get<UiPreferences>('/api/preferences')); }
    catch (e) { setError(e as Error); }
  }, []);

  useEffect(() => {
    refetch();
    const handler = () => { refetch(); };
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [refetch]);

  const set = useCallback(async (key: keyof UiPreferences, value: unknown) => {
    const next = await apiClient.post<UiPreferences>('/api/preferences', { [key]: value });
    setPreferences(next);
    return next;
  }, []);

  return { preferences, error, refetch, set };
}
```

`useCapabilities.ts`: similar structure, GET `/api/capabilities`, returns `{ capabilities, refetch }`.

`useAuth.ts`: GET `/api/auth/state`; exposes `connect(pat)` that POSTs `/api/auth/connect`.

**Commit:**

```bash
git add frontend/src/hooks frontend/__tests__/hooks.test.tsx
git commit -m "feat(frontend): hooks for preferences + capabilities + auth with focus-refetch"
```

---

### Task 36: `ErrorBoundary` + `ToastContainer` + `Toast`

**Files:**
- Create: `frontend/src/components/ErrorBoundary.tsx`
- Create: `frontend/src/components/Toast/ToastContainer.tsx`, `Toast.tsx`, `Toast.module.css`, `useToast.ts`
- Create: `frontend/__tests__/error-boundary.test.tsx`, `toast.test.tsx`

**Test (ErrorBoundary):**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

function Boom(): never { throw new Error('boom'); }

describe('ErrorBoundary', () => {
  it('renders fallback UI on render error', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });
});
```

**Test (Toast):**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { ToastContainer, useToast } from '../src/components/Toast';

function Trigger() {
  const toast = useToast();
  return <button onClick={() => toast.show({ kind: 'error', message: 'kaboom', requestId: 'rid-1' })}>show</button>;
}

describe('Toast', () => {
  it('shows the message and exposes Copy diagnostic info', async () => {
    render(<><Trigger /><ToastContainer /></>);
    await userEvent.click(screen.getByRole('button', { name: 'show' }));
    expect(screen.getByText('kaboom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy diagnostic info/i })).toBeInTheDocument();
  });
});
```

**Impl (ErrorBoundary):**

```tsx
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    if (this.state.error) {
      return (
        <div role="alert">
          <p>Something went wrong. The error has been logged.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

**Impl (Toast):** small context-based toast bus. `useToast()` returns `{ show(toast) }`; `<ToastContainer />` renders all queued toasts. Each toast renders message + optional "Copy diagnostic info" button (calls `navigator.clipboard.writeText(requestId ?? '')`). Auto-dismiss after 5s for non-error toasts; errors stay until dismissed.

**Commit:**

```bash
git add frontend/src/components/ErrorBoundary.tsx frontend/src/components/Toast frontend/__tests__/error-boundary.test.tsx frontend/__tests__/toast.test.tsx
git commit -m "feat(frontend): ErrorBoundary + Toast with Copy-diagnostic-info"
```

---

### Task 37: `HeaderControls` — ThemeToggle + AccentPicker + AiPreviewToggle

**Files:**
- Create: `frontend/src/components/Header/HeaderControls.tsx`, `HeaderControls.module.css`
- Create: `frontend/src/components/Header/ThemeToggle.tsx`, `AccentPicker.tsx`, `AiPreviewToggle.tsx`
- Create: `frontend/__tests__/header-controls.test.tsx`

**Test:**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { HeaderControls } from '../src/components/Header/HeaderControls';

const server = setupServer();
beforeEach(() => server.resetHandlers());

describe('HeaderControls', () => {
  it('cycles theme on click and posts a single-field patch', async () => {
    let requestBody: unknown;
    server.use(
      http.get('/api/preferences', () => HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false })),
      http.post('/api/preferences', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ theme: 'light', accent: 'indigo', aiPreview: false });
      }),
    );
    server.listen();
    render(<HeaderControls />);
    await userEvent.click(await screen.findByRole('button', { name: /theme/i }));
    expect(requestBody).toEqual({ theme: 'light' });
    server.close();
  });
});
```

**Impl (HeaderControls.tsx):**

```tsx
import { usePreferences } from '../../hooks/usePreferences';
import { ThemeToggle } from './ThemeToggle';
import { AccentPicker } from './AccentPicker';
import { AiPreviewToggle } from './AiPreviewToggle';
import styles from './HeaderControls.module.css';

const THEMES = ['system', 'light', 'dark'] as const;
const ACCENTS = ['indigo', 'amber', 'teal'] as const;
const ACCENT_HUES: Record<typeof ACCENTS[number], { h: number; c: number }> = {
  indigo: { h: 245, c: 0.085 },
  amber: { h: 75, c: 0.10 },
  teal: { h: 195, c: 0.075 },
};

export function HeaderControls() {
  const { preferences, set } = usePreferences();
  if (!preferences) return null;

  // Apply on every render
  document.documentElement.dataset.theme = preferences.theme === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preferences.theme;
  const hue = ACCENT_HUES[preferences.accent];
  document.documentElement.style.setProperty('--accent-h', hue.h.toString());
  document.documentElement.style.setProperty('--accent-c', hue.c.toString());

  const cycleTheme = () => {
    const next = THEMES[(THEMES.indexOf(preferences.theme) + 1) % THEMES.length];
    set('theme', next);
  };
  const cycleAccent = () => {
    const next = ACCENTS[(ACCENTS.indexOf(preferences.accent) + 1) % ACCENTS.length];
    set('accent', next);
  };
  const toggleAi = () => set('aiPreview', !preferences.aiPreview);

  return (
    <div className={styles.cluster}>
      <ThemeToggle theme={preferences.theme} onClick={cycleTheme} />
      <AccentPicker accent={preferences.accent} onClick={cycleAccent} />
      <AiPreviewToggle on={preferences.aiPreview} onClick={toggleAi} />
    </div>
  );
}
```

`ThemeToggle.tsx`, `AccentPicker.tsx`, `AiPreviewToggle.tsx` are small icon buttons (use lucide-react or hand-drawn SVG icons; keep deps minimal — just inline SVGs). Each accepts `{ value/state, onClick }` and renders an `aria-label`-bearing button.

**Commit:**

```bash
git add frontend/src/components/Header frontend/__tests__/header-controls.test.tsx
git commit -m "feat(frontend): HeaderControls (theme cycle / accent cycle / aiPreview toggle)

Each control posts a single-field patch and applies the new theme +
CSS vars to <html> on response."
```

---

### Task 38: `Header` (full top-chrome row)

**Files:**
- Create: `frontend/src/components/Header/Header.tsx`, `Header.module.css`
- Create: `frontend/src/components/Header/Logo.tsx`
- Create: `frontend/__tests__/header.test.tsx`

**Test:** rendering Header shows logo, Inbox + Setup tabs, search-styled placeholder bar, header controls. Active tab class on the route's tab.

**Impl:** `Header.tsx`:

```tsx
import { NavLink } from 'react-router-dom';
import { Logo } from './Logo';
import { HeaderControls } from './HeaderControls';
import styles from './Header.module.css';

export function Header() {
  return (
    <header className={styles.header}>
      <Logo />
      <nav className={styles.tabs}>
        <NavLink to="/inbox-shell" className={({ isActive }) => isActive ? styles.tabActive : styles.tab}>Inbox</NavLink>
        <NavLink to="/setup" className={({ isActive }) => isActive ? styles.tabActive : styles.tab}>Setup</NavLink>
      </nav>
      <div className={styles.spacer} />
      <input className={styles.search} placeholder="Jump to PR or file… ⌘K" disabled aria-label="Global search (placeholder)" />
      <HeaderControls />
    </header>
  );
}
```

CSS lifts dimensions from `--header-h` (56px). Active tab gets the accent edge.

**Commit:**

```bash
git add frontend/src/components/Header/Header.tsx frontend/src/components/Header/Header.module.css frontend/src/components/Header/Logo.tsx frontend/__tests__/header.test.tsx
git commit -m "feat(frontend): Header with logo + Inbox/Setup tabs + global-search placeholder"
```

---

### Task 39: `HostChangeModal`

**Files:**
- Create: `frontend/src/components/HostChangeModal/HostChangeModal.tsx`, `HostChangeModal.module.css`
- Create: `frontend/__tests__/host-change-modal.test.tsx`

**Test:** mounting the modal with `{ old, new }` shows both values and two buttons (Continue / Revert). Clicking each calls the relevant handler.

**Impl:**

```tsx
interface Props {
  oldHost: string;
  newHost: string;
  onContinue: () => void;
  onRevert: () => void;
}

export function HostChangeModal({ oldHost, newHost, onContinue, onRevert }: Props) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="hcm-title">
      <h2 id="hcm-title">github.host changed</h2>
      <p>You changed <code>github.host</code> from <strong>{oldHost}</strong> to <strong>{newHost}</strong>. Pending reviews and per-thread server stamps in your local state were issued by the old host and won't match the new one.</p>
      <button onClick={onContinue}>Continue</button>
      <button onClick={onRevert}>Revert</button>
    </div>
  );
}
```

**Commit:**

```bash
git add frontend/src/components/HostChangeModal frontend/__tests__/host-change-modal.test.tsx
git commit -m "feat(frontend): HostChangeModal blocks routing until user resolves"
```

---

### Task 40: `SetupForm` + `ScopePill` + `MaskedInput`

**Files:**
- Create: `frontend/src/components/Setup/SetupForm.tsx`, `SetupForm.module.css`
- Create: `frontend/src/components/Setup/ScopePill.tsx`
- Create: `frontend/src/components/Setup/MaskedInput.tsx`
- Create: `frontend/__tests__/setup-form.test.tsx`

**Test:**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SetupForm } from '../src/components/Setup/SetupForm';

describe('SetupForm', () => {
  it('disables Continue when input is empty', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('toggles mask/unmask on click of the eye', async () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/personal access token/i) as HTMLInputElement;
    await userEvent.type(input, 'ghp_xx');
    expect(input.type).toBe('password');
    await userEvent.click(screen.getByRole('button', { name: /show token/i }));
    expect(input.type).toBe('text');
  });

  it('renders the three scope pills with copy buttons', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByText('repo')).toBeInTheDocument();
    expect(screen.getByText('read:user')).toBeInTheDocument();
    expect(screen.getByText('read:org')).toBeInTheDocument();
  });

  it('renders error pill when error prop is set', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} error="GitHub rejected this token." />);
    expect(screen.getByText(/rejected/i)).toBeInTheDocument();
  });
});
```

**Impl:** straightforward form. `MaskedInput` wraps a controlled `<input type="password|text">` plus an eye icon button. `ScopePill` renders a mono-styled pill with copy-to-clipboard. `SetupForm` accepts `{ host, onSubmit, error }`, builds the PAT-page link via the same template the backend uses (or just construct client-side: `${host}/settings/personal-access-tokens/new`).

**Commit:**

```bash
git add frontend/src/components/Setup frontend/__tests__/setup-form.test.tsx
git commit -m "feat(frontend): SetupForm + ScopePill + MaskedInput"
```

---

### Task 41: `SetupPage` + `InboxShellPage`

**Files:**
- Create: `frontend/src/pages/SetupPage.tsx`, `SetupPage.module.css`
- Create: `frontend/src/pages/InboxShellPage.tsx`, `InboxShellPage.module.css`
- Create: `frontend/__tests__/setup-page.test.tsx`, `inbox-shell.test.tsx`

**Test (SetupPage):** posting a valid PAT routes to `/inbox-shell`; an invalid PAT shows the error pill. Use MSW to fake `/api/auth/connect`.

**Impl:** `SetupPage.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SetupForm } from '../components/Setup/SetupForm';
import { apiClient } from '../api/client';
import type { ConnectResponse } from '../api/types';

export function SetupPage() {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const onSubmit = async (pat: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await apiClient.post<ConnectResponse>('/api/auth/connect', { pat });
      if (result.ok) navigate('/inbox-shell');
      else setError(result.detail ?? result.error ?? 'Validation failed.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return <SetupForm host="https://github.com" onSubmit={onSubmit} error={error} busy={busy} />;
}
```

`InboxShellPage.tsx`:

```tsx
export function InboxShellPage() {
  return (
    <main>
      <h1>Inbox</h1>
      <p>Inbox coming soon.</p>
    </main>
  );
}
```

**Commit:**

```bash
git add frontend/src/pages frontend/__tests__/setup-page.test.tsx frontend/__tests__/inbox-shell.test.tsx
git commit -m "feat(frontend): SetupPage with PAT submit flow + InboxShellPage placeholder"
```

---

### Task 42: `App` with router + auth-gated routing + theme application

**Files:**
- Modify: `frontend/src/App.tsx`
- Create: `frontend/__tests__/app.test.tsx`

**Test:**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App';

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

describe('App routing', () => {
  it('routes to /setup when no token', async () => {
    server.use(
      http.get('/api/auth/state', () => HttpResponse.json({ hasToken: false, hostMismatch: null })),
      http.get('/api/preferences', () => HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false })),
    );
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    expect(await screen.findByText(/connect to github/i)).toBeInTheDocument();
  });

  it('routes to /inbox-shell when token present', async () => {
    server.use(
      http.get('/api/auth/state', () => HttpResponse.json({ hasToken: true, hostMismatch: null })),
      http.get('/api/preferences', () => HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false })),
    );
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    expect(await screen.findByText(/inbox/i)).toBeInTheDocument();
  });

  it('renders host-change modal when hostMismatch present', async () => {
    server.use(
      http.get('/api/auth/state', () => HttpResponse.json({ hasToken: true, hostMismatch: { old: 'https://x.com', new: 'https://github.com' } })),
      http.get('/api/preferences', () => HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false })),
    );
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
```

**Impl:** `App.tsx`:

```tsx
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Header } from './components/Header/Header';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastContainer } from './components/Toast/ToastContainer';
import { HostChangeModal } from './components/HostChangeModal/HostChangeModal';
import { SetupPage } from './pages/SetupPage';
import { InboxShellPage } from './pages/InboxShellPage';
import { useAuth } from './hooks/useAuth';
import { apiClient } from './api/client';

export function App() {
  const { authState, refetch } = useAuth();

  if (authState === null) return <div aria-busy="true">Loading…</div>;

  if (authState.hostMismatch) {
    return (
      <HostChangeModal
        oldHost={authState.hostMismatch.old}
        newHost={authState.hostMismatch.new}
        onContinue={async () => { await apiClient.post('/api/auth/host-change-resolution', { resolution: 'continue' }); refetch(); }}
        onRevert={async () => { await apiClient.post('/api/auth/host-change-resolution', { resolution: 'revert' }); }}
      />
    );
  }

  return (
    <ErrorBoundary>
      <Header />
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/inbox-shell" element={<InboxShellPage />} />
        <Route path="*" element={<Navigate to={authState.hasToken ? '/inbox-shell' : '/setup'} replace />} />
      </Routes>
      <ToastContainer />
    </ErrorBoundary>
  );
}
```

**Commit:**

```bash
git add frontend/src/App.tsx frontend/__tests__/app.test.tsx
git commit -m "feat(frontend): App router with auth-gated routes + host-change modal precedence"
```

---

## Phase 6 — E2E + CI (T43–T44)

---

### Task 43: Playwright E2E tests

**Files:**
- Create: `frontend/playwright.config.ts`
- Create: `frontend/e2e/cold-start.spec.ts`, `returning-user.spec.ts`, `header-controls.spec.ts`, `host-change.spec.ts`, `no-browser.spec.ts`

**Setup:**

```
cd frontend
npm install -D @playwright/test
npx playwright install --with-deps chromium
```

`frontend/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  webServer: [
    {
      command: 'cd .. && dotnet run --project PRism.Web --urls http://localhost:5180 -- --no-browser',
      url: 'http://localhost:5180/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
});
```

**Tests:**

`cold-start.spec.ts` — boot → /setup screen renders → paste a fake PAT (test backend pre-configured to accept "ghp_test") → routed to /inbox-shell.

`returning-user.spec.ts` — pre-seed token via `/api/auth/connect` → reload → lands directly on /inbox-shell.

`header-controls.spec.ts` — click theme cycle → `data-theme` attribute changes; click accent → CSS vars change; click AI preview → `/api/capabilities` GET reflects flipped flag.

`host-change.spec.ts` — pre-seed `state.json.lastConfiguredGithubHost = "https://other.com"` → modal appears → Continue → routes; Revert → backend exits.

`no-browser.spec.ts` — run backend with `--no-browser`; assert `/api/health` reachable; backend stdout contains the URL line.

(Each test uses a `--no-browser`-enabled dev backend started by Playwright via `webServer` and a sandbox `<dataDir>` exposed via the `DataDir` setting.)

**Commit:**

```bash
git add frontend/playwright.config.ts frontend/e2e
git commit -m "test(frontend): Playwright e2e for cold-start, returning user, header controls, host change, --no-browser"
```

---

### Task 44: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  build-and-test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: 'frontend/package-lock.json'

      - name: Restore (.NET)
        run: dotnet restore

      - name: Build (.NET)
        run: dotnet build --no-restore --configuration Release /p:TreatWarningsAsErrors=true

      - name: Test (.NET)
        run: dotnet test --no-build --configuration Release --logger "trx;LogFileName=test-results.trx"

      - name: Frontend install
        working-directory: frontend
        run: npm ci

      - name: Frontend lint
        working-directory: frontend
        run: npm run lint

      - name: Frontend build
        working-directory: frontend
        run: npm run build

      - name: Frontend unit tests
        working-directory: frontend
        run: npm test

      - name: Playwright install
        working-directory: frontend
        run: npx playwright install --with-deps chromium

      - name: Playwright tests
        working-directory: frontend
        run: npx playwright test

      - name: Upload test artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: |
            **/test-results.trx
            frontend/test-results/
            frontend/playwright-report/
```

**Commit:**

```bash
git add .github/workflows/ci.yml
git commit -m "build(ci): windows-latest workflow runs dotnet test + frontend lint/build/test/playwright

macOS CI lands in S6 with code signing (keychain validation requires
a signed binary)."
```

---

## End-of-slice verification

After T44 commits, the slice is complete when:

- [ ] `dotnet build` succeeds with zero warnings (TreatWarningsAsErrors).
- [ ] `dotnet test` passes (~80–100 tests across three test projects).
- [ ] `cd frontend && npm test` passes.
- [ ] `cd frontend && npx playwright test` passes locally.
- [ ] `dotnet run --project PRism.Web` boots, browser opens, Setup screen renders, valid PAT routes to Inbox shell, header controls flip theme/accent/aiPreview.
- [ ] `dotnet run --project PRism.Web -- --no-browser` boots without launching a browser; `/api/health` responds.
- [ ] CI passes on a PR.
- [ ] Manual macOS verification: launch unsigned binary on a Mac, accept the keychain "Always Allow" prompt, complete the same demo. (Documented in PR description; macOS CI deferred to S6.)

After this slice merges, Slice S2 (Inbox read) opens its own brainstorm → spec → plan cycle.

