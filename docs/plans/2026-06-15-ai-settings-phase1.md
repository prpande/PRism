# AI Settings tab — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the AI Settings tab shell (`/settings/ai`) with two clamped, hot-reloaded, API-patchable knobs (provider timeout + hunk-annotation cap), relocate the AI-mode control from Appearance, and give #484's failure toast timeout-specific copy + an "Adjust timeout" deep-link.

**Architecture:** Backend — a single-sourced `AiConfigBounds` clamp (PRism.Core) used on both write (`ConfigStore.PatchAsync`, new `Int` field type) and every read (the `Program.cs` DI factory for the timeout, `ClaudeCodeHunkAnnotator` for the cap, the GET DTO for display); the provider timeout is read "hot" via a `Func<TimeSpan> TimeoutProvider` on the provider options supplied by a DI factory overload of `AddPrismClaudeCode`; a typed `LlmProviderException.TimedOut` discriminator drives a `{ reason }` 503 body. Frontend — a new `NumberStepper` design-system control, a new `AiPane`, the AI-mode control transplanted verbatim from `AppearancePane`, and a `reason` prop-chain from the api clients through `aiFailure` to a timeout-aware `AiFailureToast`.

**Tech Stack:** .NET 10 (xUnit + FluentAssertions), React 18 + Vite + TypeScript (vitest + Testing Library), Playwright e2e. `TreatWarningsAsErrors` is on. Spec: `docs/specs/2026-06-15-ai-settings-phase1-design.md`.

---

## Conventions for every task

- **Worktree:** all paths are relative to `D:\src\PRism\.claude\worktrees\496-ai-settings-phase1`. The V2 AI code exists ONLY in this worktree — never run git/test from `D:\src\PRism`.
- **Backend tests:** run from the worktree root. `dotnet test --filter "<FullyQualifiedName~Substring>"` with a timeout ≥ 300000 ms. Run only ONE build/test at a time, foreground.
- **Frontend tests:** run from `frontend/`. Use the REAL vitest binary (rtk/npx masks failures): `node ./node_modules/vitest/vitest.mjs run <path>`.
- **Frontend lint/format/typecheck (real binaries, never rtk/npx):**
  - `node ./node_modules/typescript/bin/tsc -b` (from `frontend/`)
  - `node ./node_modules/eslint/bin/eslint.js <path>`
  - `node ./node_modules/prettier/bin/prettier.cjs --write <path>`
- **Commit cadence:** one commit per task (TDD: failing test → impl → green → commit). Use `fix`/`feat` conventional scopes with a bare `#496` reference (V2-targeted PRs do NOT auto-close on `#N`; the issue is closed manually at merge).
- **Two deliberate combined-commit pairs (documented deviation from one-commit-per-task):** Tasks **10+11** and Tasks **12+13** commit together. The type-only change in Task 10 and the `anyTimedOut`/container change in Task 12 leave `tsc` red until their partner task (11 / 13) lands, so each pair is one TDD unit — never commit the first half alone (the tree would not typecheck). Every other task commits on its own.

---

## File Structure (what each unit owns)

**Backend (new):**
- `PRism.Core/Config/AiConfigBounds.cs` — the single-sourced clamp constants + `ClampTimeout`/`ClampCap`.

**Backend (modified):**
- `PRism.Core/Config/AppConfig.cs` — `AiConfig.ProviderTimeoutSeconds` trailing member.
- `PRism.Core/Config/ConfigStore.cs` — `Int` field type, allowlist entries, guard arm, clamp-on-write apply arms.
- `PRism.Web/Endpoints/PreferencesEndpoints.cs` — `JsonValueKind.Number` parse; GET DTO clamped-for-display.
- `PRism.Web/Endpoints/PreferencesDtos.cs` — `UiPreferencesDto` gains two fields.
- `PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs` — `Func<TimeSpan> TimeoutProvider`.
- `PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs` — read `TimeoutProvider()` per call.
- `PRism.AI.ClaudeCode/LlmProviderException.cs` — `bool TimedOut`.
- `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs` — factory overload of `AddPrismClaudeCode`.
- `PRism.Web/Program.cs` — call the factory overload, closing over `IConfigStore` + `AiConfigBounds`.
- `PRism.Web/Ai/ClaudeCodeHunkAnnotator.cs` — upper-clamp on read.
- `PRism.Web/Endpoints/AiEndpoints.cs` — 503 `{ reason }` body + `AiFailureBody` record + draft guardrail comment.

**Frontend (new):**
- `frontend/src/components/controls/NumberStepper.tsx` + `NumberStepper.module.css`.
- `frontend/src/components/Settings/panes/AiPane.tsx` (+ migrated `AiPane.test.tsx`).

**Frontend (modified):**
- `frontend/src/api/types.ts` — `AiFailureReason`, `UiPreferences` fields, `AiSummaryResult` error reason.
- `frontend/src/api/client.ts` — `readFailureReason` helper.
- `frontend/src/api/aiSummary.ts`, `aiFileFocus.ts` — surface reason on the error outcome.
- `frontend/src/hooks/useAiSummary.ts`, `useFileFocusResult.ts`, `useAiHunkAnnotations.ts`, `useAiDraftSuggestions.ts` — pass reason to `report`.
- `frontend/src/components/Ai/aiFailure.tsx` — `FailureEntry.reason`, derived `anyTimedOut`.
- `frontend/src/components/Ai/AiFailureContainer.tsx` — forward `anyTimedOut`.
- `frontend/src/components/Ai/AiFailureToast.tsx` — timeout copy + deep-link.
- `frontend/src/contexts/PreferencesContext.tsx` — `PreferenceKey` union/Exclude/readKey/writeKey.
- `frontend/src/components/Settings/panes/AppearancePane.tsx` (+ test) — remove AI-mode section.
- `frontend/src/components/Settings/SettingsNav.tsx`, `SettingsModalRoutes.tsx` — add the AI tab.

**Design deviation recorded up front (NumberStepper labelling — refined after plan review):** the spec says the spinbutton is named via `aria-labelledby` → a visible label. To satisfy that AND keep the two stepper rows visually consistent with every other Settings row (label + help in the left column, control on the right), `NumberStepper` takes an optional `labelledById` prop: when set, the spinbutton is named by an EXTERNAL `pane.label` element (used in `AiPane`); when omitted, the control renders its own internal `<span>` label (standalone usage / unit tests). So in `AiPane` the rows use the standard `pane.row` pattern with `pane.label` + `pane.help` (range hint + "applies to the next AI request"), and the spinbutton's accessible name resolves to that visible `pane.label`. This is a review-driven refinement of the spec's "NumberStepper renders its own label" detail (design-lens flagged the row inconsistency + the missing range/help text); flagged here for the human-review gate.

---

## Task 1: `AiConfigBounds` — the single-sourced clamp

**Files:**
- Create: `PRism.Core/Config/AiConfigBounds.cs`
- Test: `tests/PRism.Core.Tests/Config/AiConfigBoundsTests.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Core.Tests/Config/AiConfigBoundsTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public class AiConfigBoundsTests
{
    [Theory]
    [InlineData(29, 30)]   // below min → min
    [InlineData(30, 30)]
    [InlineData(240, 240)]
    [InlineData(600, 600)]
    [InlineData(601, 600)] // above max → max
    public void ClampTimeout_clamps_to_30_600(int input, int expected) =>
        AiConfigBounds.ClampTimeout(input).Should().Be(expected);

    [Theory]
    [InlineData(0, 1)]     // below min → min (write-path semantics: 1, not the read-path floor 10)
    [InlineData(1, 1)]
    [InlineData(10, 10)]
    [InlineData(50, 50)]
    [InlineData(999, 50)]  // above max → max
    public void ClampCap_clamps_to_1_50(int input, int expected) =>
        AiConfigBounds.ClampCap(input).Should().Be(expected);

    [Theory]
    [InlineData(-1, 10)]   // legacy/absent → DefaultCap (NOT min 1)
    [InlineData(0, 10)]    // legacy/absent → DefaultCap
    [InlineData(1, 1)]
    [InlineData(10, 10)]
    [InlineData(50, 50)]
    [InlineData(999, 50)]  // over-max → max
    public void ClampCapForRead_floors_nonpositive_to_10_and_caps_at_50(int input, int expected) =>
        AiConfigBounds.ClampCapForRead(input).Should().Be(expected);

    [Fact]
    public void Constants_expose_the_documented_bounds()
    {
        AiConfigBounds.MinTimeout.Should().Be(30);
        AiConfigBounds.MaxTimeout.Should().Be(600);
        AiConfigBounds.MinCap.Should().Be(1);
        AiConfigBounds.MaxCap.Should().Be(50);
        AiConfigBounds.DefaultCap.Should().Be(10);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~AiConfigBoundsTests"`
Expected: FAIL to compile (`AiConfigBounds` does not exist).

- [ ] **Step 3: Create the implementation**

Create `PRism.Core/Config/AiConfigBounds.cs`:

```csharp
namespace PRism.Core.Config;

/// <summary>
/// Single source of truth for the AI numeric-knob bounds (#496). Lives in PRism.Core so both
/// <see cref="ConfigStore"/> (write-clamp) and the PRism.Web composition root (read-clamp in the
/// timeout DI factory + the GET DTO) can reference it without a layering inversion. Both knobs are
/// clamped on write AND on every read so a hand-edited config.json that bypasses PatchAsync cannot
/// land an out-of-range value at a consumption site.
///
/// NOTE the cap asymmetry — two distinct cap-clamp semantics, single-sourced here so they cannot drift:
/// - <see cref="ClampCap"/> is the WRITE path (a user explicitly typed a value in the UI/POST, always
///   &gt;= 1): floors to <see cref="MinCap"/> (1).
/// - <see cref="ClampCapForRead"/> is the READ/DISPLAY path (a RAW persisted value, which a hand-edited
///   config.json can leave at 0 or negative): a non-positive value means "absent / legacy" and defaults
///   to <see cref="DefaultCap"/> (10), NOT the min 1; otherwise upper-bounds to <see cref="MaxCap"/>.
///   Both the annotator (read) and the GET DTO (display) call this so the shown value == the effective
///   value even for the legacy-0 corner.
/// </summary>
public static class AiConfigBounds
{
    public const int MinTimeout = 30;
    public const int MaxTimeout = 600;
    public const int MinCap = 1;
    public const int MaxCap = 50;
    public const int DefaultCap = 10;

    public static int ClampTimeout(int seconds) => Math.Clamp(seconds, MinTimeout, MaxTimeout);
    public static int ClampCap(int cap) => Math.Clamp(cap, MinCap, MaxCap);

    // Read/display semantics: non-positive (absent/legacy) → DefaultCap (10); otherwise cap at MaxCap (50).
    // Single source for the annotator's read-clamp AND the GET DTO's display-clamp so they cannot disagree.
    public static int ClampCapForRead(int cap) => cap <= 0 ? DefaultCap : Math.Min(cap, MaxCap);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~AiConfigBoundsTests"`
Expected: PASS (all cases — ClampTimeout, ClampCap, ClampCapForRead, constants).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/AiConfigBounds.cs tests/PRism.Core.Tests/Config/AiConfigBoundsTests.cs
git commit -m "feat(ai-settings): add AiConfigBounds single-sourced clamp (#496)"
```

---

## Task 2: `AiConfig.ProviderTimeoutSeconds`

**Files:**
- Modify: `PRism.Core/Config/AppConfig.cs:86`
- Test: `tests/PRism.Core.Tests/Config/AppConfigDefaultsTests.cs` (create if absent; otherwise add the cases)

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Core.Tests/Config/AppConfigDefaultsTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public class AppConfigDefaultsTests
{
    [Fact]
    public void Default_ai_provider_timeout_is_240_seconds() =>
        AppConfig.Default.Ui.Ai.ProviderTimeoutSeconds.Should().Be(240);

    [Fact]
    public void Default_ai_hunk_annotation_cap_is_10() =>
        AppConfig.Default.Ui.Ai.HunkAnnotationCap.Should().Be(10);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~AppConfigDefaultsTests"`
Expected: FAIL to compile (`ProviderTimeoutSeconds` does not exist on `AiConfig`).

- [ ] **Step 3: Add the trailing member**

In `PRism.Core/Config/AppConfig.cs`, change the `AiConfig` record (line 86). Update the XML-doc to mention the new member, and append the param:

```csharp
/// <summary>AI mode config (spec §4). Persisted at <c>ui.ai.mode</c>. <paramref name="HunkAnnotationCap"/>
/// (#414) bounds the per-PR hunk-annotation count. <paramref name="ProviderTimeoutSeconds"/> (#496) is the
/// user-configurable Claude CLI provider timeout, read hot per AI call and clamped to
/// <see cref="AiConfigBounds"/>. Both are trailing-defaulted params so existing positional
/// <c>new AiConfig(Mode, Consent, Features)</c> call sites (AppConfig.Default + test fixtures) keep
/// compiling. STJ-net10 honors the constructor default for a missing key (proven by
/// ConfigStoreHunkAnnotationCapTests.Missing_cap_key_binds_to_the_constructor_default). The annotator
/// clamps a non-positive cap to 10 on read.</summary>
public sealed record AiConfig(
    AiMode Mode,
    AiConsentConfig Consent,
    AiFeaturesConfig Features,
    int HunkAnnotationCap = 10,
    int ProviderTimeoutSeconds = 240);
```

(No change to `AppConfig.Default` — its `new AiConfig(AiMode.Preview, AiConsentConfig.None, AiFeaturesConfig.AllOn)` call inherits both defaults.)

- [ ] **Step 4: Run it to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~AppConfigDefaultsTests"`
Expected: PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/AppConfig.cs tests/PRism.Core.Tests/Config/AppConfigDefaultsTests.cs
git commit -m "feat(ai-settings): add AiConfig.ProviderTimeoutSeconds (default 240) (#496)"
```

---

## Task 3: `ConfigStore.PatchAsync` — `Int` field type + both knobs

**Files:**
- Modify: `PRism.Core/Config/ConfigStore.cs` (enum line 31; `_allowedFields` 33-58; type switch 173-181; apply switch 213-242)
- Test: `tests/PRism.Core.Tests/Config/ConfigStoreAiNumericPatchTests.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Core.Tests/Config/ConfigStoreAiNumericPatchTests.cs`:

```csharp
using System.IO;
using FluentAssertions;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStoreAiNumericPatchTests : IDisposable
{
    private readonly string _dir =
        Path.Combine(Path.GetTempPath(), "prism-cfg-" + Guid.NewGuid().ToString("N"));

    private ConfigStore NewStore()
    {
        Directory.CreateDirectory(_dir);
        var store = new ConfigStore(_dir);
        store.InitAsync(CancellationToken.None).GetAwaiter().GetResult();
        return store;
    }

    [Fact]
    public async Task Patch_provider_timeout_in_range_persists_value()
    {
        var store = NewStore();
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = 300 }, default);
        store.Current.Ui.Ai.ProviderTimeoutSeconds.Should().Be(300);
    }

    [Fact]
    public async Task Patch_provider_timeout_above_max_clamps_to_600()
    {
        var store = NewStore();
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = 5000 }, default);
        store.Current.Ui.Ai.ProviderTimeoutSeconds.Should().Be(600);
    }

    [Fact]
    public async Task Patch_provider_timeout_below_min_clamps_to_30()
    {
        var store = NewStore();
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = 1 }, default);
        store.Current.Ui.Ai.ProviderTimeoutSeconds.Should().Be(30);
    }

    [Fact]
    public async Task Patch_cap_in_range_persists_value()
    {
        var store = NewStore();
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.hunkAnnotationCap"] = 20 }, default);
        store.Current.Ui.Ai.HunkAnnotationCap.Should().Be(20);
    }

    [Fact]
    public async Task Patch_cap_above_max_clamps_to_50()
    {
        var store = NewStore();
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.hunkAnnotationCap"] = 999 }, default);
        store.Current.Ui.Ai.HunkAnnotationCap.Should().Be(50);
    }

    [Fact]
    public async Task Patch_numeric_key_with_non_integer_value_throws()
    {
        var store = NewStore();
        var act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = null }, default);
        await act.Should().ThrowAsync<ConfigPatchException>()
            .WithMessage("*expects an integer*");
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best-effort */ }
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~ConfigStoreAiNumericPatchTests"`
Expected: FAIL — `unknown field: ui.ai.providerTimeoutSeconds` (keys not yet in the allowlist).

- [ ] **Step 3: Add `Int` to the field-type enum**

In `PRism.Core/Config/ConfigStore.cs:31`:

```csharp
    private enum ConfigFieldType { String, Bool, Int }
```

- [ ] **Step 4: Add both keys to `_allowedFields`**

In the `_allowedFields` initializer (after the `inbox.groupByRepo` entry, before the closing `};` at line 58):

```csharp
            ["inbox.groupByRepo"]                = ConfigFieldType.Bool,
            // #496 AI Settings tab — user-configurable numeric knobs. Clamped on write
            // (AiConfigBounds) in the apply switch below; surfaced + read-clamped in PRism.Web.
            ["ui.ai.providerTimeoutSeconds"]     = ConfigFieldType.Int,
            ["ui.ai.hunkAnnotationCap"]          = ConfigFieldType.Int,
```

- [ ] **Step 5: Add the `Int` guard arm to the pre-gate type switch**

In the `switch (expectedType)` block (lines 173-181), add a third arm:

```csharp
            case ConfigFieldType.Bool when value is not bool:
                throw new ConfigPatchException(
                    $"field '{key}' expects a bool value (got {DescribeValue(value)})");
            case ConfigFieldType.Int when value is not int:
                throw new ConfigPatchException(
                    $"field '{key}' expects an integer value (got {DescribeValue(value)})");
```

- [ ] **Step 6: Add the two clamp-on-write apply arms**

In the apply `switch` (before the `_ => throw …` default at line 241), add:

```csharp
                "ui.ai.providerTimeoutSeconds" =>
                    _current with { Ui = ui with { Ai = ui.Ai with { ProviderTimeoutSeconds = AiConfigBounds.ClampTimeout((int)value!) } } },
                "ui.ai.hunkAnnotationCap" =>
                    _current with { Ui = ui with { Ai = ui.Ai with { HunkAnnotationCap = AiConfigBounds.ClampCap((int)value!) } } },
```

- [ ] **Step 7: Run it to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~ConfigStoreAiNumericPatchTests"`
Expected: PASS (7 cases).

- [ ] **Step 8: Guard against regressions in the existing cap suite**

Run: `dotnet test --filter "FullyQualifiedName~ConfigStoreHunkAnnotationCapTests"`
Expected: PASS (the `Missing_cap_key_binds_to_the_constructor_default` test still holds).

- [ ] **Step 9: Commit**

```bash
git add PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Config/ConfigStoreAiNumericPatchTests.cs
git commit -m "feat(ai-settings): allow + clamp ui.ai numeric patches in ConfigStore (#496)"
```

---

## Task 4: `PreferencesEndpoints` — Number parse + clamped GET DTO

**Files:**
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs:24`
- Modify: `PRism.Web/Endpoints/PreferencesEndpoints.cs` (POST parse 31-37; GET `BuildResponse` 66-74)
- Test: `tests/PRism.Web.Tests/Endpoints/PreferencesAiNumericTests.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Web.Tests/Endpoints/PreferencesAiNumericTests.cs`. (Uses the existing `PRismWebApplicationFactory` + authenticated-client harness — match the namespace/helper used by the other `PreferencesEndpoints` tests in `tests/PRism.Web.Tests/Endpoints/`; adapt the using/fixture names to the sibling file's pattern if they differ.)

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PRism.Web.Tests.TestHelpers;   // CreateAuthenticatedClient is an extension here (NOT a factory member)
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// NOTE the wire shape: UiPreferencesDto is FLAT — providerTimeoutSeconds/hunkAnnotationCap sit directly
// under `ui` (alongside theme/accent/aiMode), NOT under a `ui.ai` sub-object. So the assertion path is
// json.GetProperty("ui").GetProperty("providerTimeoutSeconds"). camelCase is the Api JSON policy.
public class PreferencesAiNumericTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public PreferencesAiNumericTests(PRismWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task Post_integer_timeout_round_trips_and_is_echoed()
    {
        var client = _factory.CreateAuthenticatedClient();
        var resp = await client.PostAsJsonAsync("/api/preferences",
            new Dictionary<string, object> { ["ui.ai.providerTimeoutSeconds"] = 300 });
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var json = await resp.Content.ReadFromJsonAsync<JsonElement>();
        json.GetProperty("ui").GetProperty("providerTimeoutSeconds").GetInt32().Should().Be(300);
    }

    [Fact]
    public async Task Post_non_integer_number_is_rejected_400()
    {
        var client = _factory.CreateAuthenticatedClient();
        var resp = await client.PostAsJsonAsync("/api/preferences",
            new Dictionary<string, object> { ["ui.ai.providerTimeoutSeconds"] = 3.5 });
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Post_number_outside_int32_range_is_rejected_400()
    {
        var client = _factory.CreateAuthenticatedClient();
        var resp = await client.PostAsJsonAsync("/api/preferences",
            new Dictionary<string, object> { ["ui.ai.providerTimeoutSeconds"] = 99999999999L });
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Get_exposes_both_ai_numeric_values()
    {
        var client = _factory.CreateAuthenticatedClient();
        var json = await client.GetFromJsonAsync<JsonElement>("/api/preferences");
        var ui = json.GetProperty("ui");
        ui.GetProperty("providerTimeoutSeconds").ValueKind.Should().Be(JsonValueKind.Number);
        ui.GetProperty("hunkAnnotationCap").ValueKind.Should().Be(JsonValueKind.Number);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~PreferencesAiNumericTests"`
Expected: FAIL — the POST folds the number to `null` → 400 even for a valid `300`; GET has no `providerTimeoutSeconds` property.

- [ ] **Step 3: Add the two DTO fields**

In `PRism.Web/Endpoints/PreferencesDtos.cs:24`, append the two members to `UiPreferencesDto`:

```csharp
internal sealed record UiPreferencesDto(
    string Theme, string Accent, bool AiPreview, string AiMode, string Density, string ContentScale,
    int ProviderTimeoutSeconds, int HunkAnnotationCap);
```

- [ ] **Step 4: Parse `JsonValueKind.Number` in the POST**

In `PRism.Web/Endpoints/PreferencesEndpoints.cs`, extend the value switch (lines 31-37):

```csharp
            object? value = props[0].Value.ValueKind switch
            {
                JsonValueKind.String => props[0].Value.GetString(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                // #496: a FRACTIONAL JSON number (e.g. 3.5) OR one outside Int32 range (e.g. 99999999999)
                // makes TryGetInt32 return false → null, which ConfigStore's Int guard rejects as 400
                // (consistent with the existing null-on-unsupported-kind path). NOTE TryGetInt32 ACCEPTS
                // an integer-valued decimal like 300.0 / 3e2 (returns 300) — harmless, since the value is
                // then clamped and the bounded UI never emits decimals; do NOT add a test asserting 300.0→400.
                JsonValueKind.Number => props[0].Value.TryGetInt32(out var n) ? n : (object?)null,
                _ => null,
            };
```

- [ ] **Step 5: Expose both values (clamped for display) in `BuildResponse`**

In `BuildResponse`, the `UiPreferencesDto(...)` construction (lines 66-74) gains the two trailing args, clamped via `AiConfigBounds` so the displayed value equals the effective value even after a hand-edited config. Add `using PRism.Core.Config;` at the top of the file if not present (it already imports `PRism.Core.Ai` and `PRism.Core.Config`).

```csharp
            Ui: new UiPreferencesDto(
                    ui.Theme,
                    ui.Accent,
                    AiPreview: ui.Ai.Mode != AiMode.Off,
#pragma warning disable CA1308 // lowercase mode names (off|preview|live) are the wire contract surfaced to the renderer. ToLowerInvariant()==kebab holds only while every AiMode member is a single word; in lockstep with ConfigStore.ParseAiMode + KebabCaseJsonNamingPolicy. A future multi-word member (e.g. LiveReadOnly) must move this to the kebab serializer so wire ("live-read-only") and parse stay aligned.
                    AiMode: ui.Ai.Mode.ToString().ToLowerInvariant(),
#pragma warning restore CA1308
                    ui.Density,
                    ui.ContentScale,
                    // #496: clamp for display so the shown value == the effective value even after a
                    // hand-edited config.json that bypassed PatchAsync (ReadFromDiskAsync does not normalize).
                    // The cap uses ClampCapForRead (NOT ClampCap) so the display matches the annotator's
                    // read semantics exactly — including the legacy `<=0 → 10` corner. Using ClampCap here
                    // would show 1 for a persisted 0 while the annotator uses 10, breaking shown==effective.
                    ProviderTimeoutSeconds: AiConfigBounds.ClampTimeout(ui.Ai.ProviderTimeoutSeconds),
                    HunkAnnotationCap: AiConfigBounds.ClampCapForRead(ui.Ai.HunkAnnotationCap)),
```

- [ ] **Step 6: Run it to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~PreferencesAiNumericTests"`
Expected: PASS (4 cases).

- [ ] **Step 7: Commit**

```bash
git add PRism.Web/Endpoints/PreferencesDtos.cs PRism.Web/Endpoints/PreferencesEndpoints.cs tests/PRism.Web.Tests/Endpoints/PreferencesAiNumericTests.cs
git commit -m "feat(ai-settings): accept numeric prefs + expose clamped AI knobs in GET (#496)"
```

---

## Task 5: `ClaudeCodeProviderOptions.TimeoutProvider` + per-call read

**Files:**
- Modify: `PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs`
- Modify: `PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs:53`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeLlmProviderTimeoutTests.cs`

> Look at `tests/PRism.AI.ClaudeCode.Tests/` for the existing fake `ICliProcessRunner` used by `ClaudeCodeLlmProviderTests` (it captures the `ProcessSpec` and returns a canned `ProcessResult`). Reuse that capturing fake; the snippet below names it `CapturingRunner` — rename to match the existing helper if one exists.

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeLlmProviderTimeoutTests.cs`:

```csharp
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;
using Xunit;

namespace PRism.AI.ClaudeCode.Tests;

public class ClaudeCodeLlmProviderTimeoutTests
{
    private sealed class CapturingRunner : ICliProcessRunner
    {
        public ProcessSpec? Last;
        public Task<ProcessResult> RunAsync(ProcessSpec spec, CancellationToken ct)
        {
            Last = spec;
            // Minimal valid envelope so CompleteAsync returns without throwing.
            return Task.FromResult(new ProcessResult(
                ExitCode: 0,
                Stdout: "{\"result\":\"ok\",\"total_cost_usd\":0}",
                Stderr: "",
                TimedOut: false));
        }
    }

    private static LlmRequest Req() => new(Model: "claude-x", SystemPrompt: "s", UserContent: "u", JsonSchema: null);

    [Fact]
    public async Task TimeoutProvider_is_evaluated_per_call()
    {
        var seconds = 100;
        var runner = new CapturingRunner();
        var options = new ClaudeCodeProviderOptions
        {
            WorkingDirectory = Path.GetTempPath(),
            TimeoutProvider = () => TimeSpan.FromSeconds(seconds),
        };
        var provider = new ClaudeCodeLlmProvider(runner, options);

        await provider.CompleteAsync(Req(), default);
        runner.Last!.Timeout.Should().Be(TimeSpan.FromSeconds(100));

        seconds = 300; // change the backing value between calls
        await provider.CompleteAsync(Req(), default);
        runner.Last!.Timeout.Should().Be(TimeSpan.FromSeconds(300));
    }

    [Fact]
    public async Task Default_TimeoutProvider_returns_static_Timeout()
    {
        var runner = new CapturingRunner();
        var options = new ClaudeCodeProviderOptions
        {
            WorkingDirectory = Path.GetTempPath(),
            Timeout = TimeSpan.FromSeconds(77),
            // no TimeoutProvider supplied → defaults to () => Timeout
        };
        var provider = new ClaudeCodeLlmProvider(runner, options);

        await provider.CompleteAsync(Req(), default);
        runner.Last!.Timeout.Should().Be(TimeSpan.FromSeconds(77));
    }
}
```

> If `LlmRequest`/`ProcessResult` constructor shapes differ from the snippet, match them to the records in `PRism.AI.Contracts/Provider/` — read them before writing the fake.

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~ClaudeCodeLlmProviderTimeoutTests"`
Expected: FAIL to compile (`TimeoutProvider` does not exist).

- [ ] **Step 3: Add `TimeoutProvider` to the options**

In `PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs`, after the `Timeout` property (line 19):

```csharp
    /// <summary>Hard wall-clock ceiling per call.</summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>Hot source of the per-call timeout (#496). Defaults to the static <see cref="Timeout"/>
    /// so direct-constructor call sites and tests are unaffected. The Web composition root supplies a
    /// factory that reads (and clamps) the user-configured value from IConfigStore on each call, giving
    /// hot-reload with no restart. Evaluated once at the top of each <see cref="ClaudeCodeLlmProvider"/>
    /// completion.</summary>
    public Func<TimeSpan> TimeoutProvider { get; init; }

    public ClaudeCodeProviderOptions() => TimeoutProvider = () => Timeout;
```

> `ClaudeCodeProviderOptions` is a `sealed class` (reference type) with `init` properties and a `required WorkingDirectory` — confirmed in the source. That matters: the explicit parameterless ctor assigning `TimeoutProvider = () => Timeout` satisfies the non-nullable `init` field (no CS8618 under TreatWarningsAsErrors), object-initializer assignments (`new ClaudeCodeProviderOptions { Timeout = … }`) run AFTER the constructor, and the lambda closes over `this` — so `() => Timeout` reads `this.Timeout`'s FINAL initialized value, not the ctor-time default. Verified by the `Default_TimeoutProvider_returns_static_Timeout` test (sets `Timeout = 77` via initializer, expects 77). Were the type a `record struct`, the `this`-capture reasoning would not hold — but it is not.

- [ ] **Step 4: Read `TimeoutProvider()` once per call**

In `PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs`, at the top of `CompleteAsync` (after the `ArgumentNullException.ThrowIfNull(request);` at line 30) and in the `ProcessSpec` construction (line 53):

```csharp
        ArgumentNullException.ThrowIfNull(request);

        // #496: evaluate the hot timeout ONCE per call, before building the spec, and use it
        // synchronously within this call — no read-stale split.
        var timeout = options.TimeoutProvider();
```

```csharp
        var spec = new ProcessSpec(
            FileName: options.ClaudeExecutable,
            Arguments: args,
            Environment: ClaudeCliEnvironment.BuildAllowlisted(),
            WorkingDirectory: options.WorkingDirectory,
            StdinText: request.UserContent,
            Timeout: timeout);
```

- [ ] **Step 5: Run it to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~ClaudeCodeLlmProviderTimeoutTests"`
Expected: PASS (2 cases).

- [ ] **Step 6: Guard the existing provider suite**

Run: `dotnet test --filter "FullyQualifiedName~ClaudeCodeLlmProviderTests"`
Expected: PASS (the default-constructor path is unchanged).

- [ ] **Step 7: Commit**

```bash
git add PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeLlmProviderTimeoutTests.cs
git commit -m "feat(ai-settings): read provider timeout hot via TimeoutProvider (#496)"
```

---

## Task 6: `LlmProviderException.TimedOut`

**Files:**
- Modify: `PRism.AI.ClaudeCode/LlmProviderException.cs`
- Modify: `PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs:70` (timeout throw site)
- Test: `tests/PRism.AI.ClaudeCode.Tests/LlmProviderExceptionTimedOutTests.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.AI.ClaudeCode.Tests/LlmProviderExceptionTimedOutTests.cs`:

```csharp
using FluentAssertions;
using PRism.AI.ClaudeCode;
using Xunit;

namespace PRism.AI.ClaudeCode.Tests;

public class LlmProviderExceptionTimedOutTests
{
    [Fact]
    public void Three_arg_ctor_defaults_TimedOut_false() =>
        new LlmProviderException("msg", stderr: "", exitCode: 1).TimedOut.Should().BeFalse();

    [Fact]
    public void Timed_out_flag_is_settable_true() =>
        new LlmProviderException("timed out", stderr: "", exitCode: -1, timedOut: true)
            .TimedOut.Should().BeTrue();

    [Fact]
    public void Framework_ctors_default_TimedOut_false()
    {
        new LlmProviderException().TimedOut.Should().BeFalse();
        new LlmProviderException("m").TimedOut.Should().BeFalse();
        new LlmProviderException("m", new Exception()).TimedOut.Should().BeFalse();
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~LlmProviderExceptionTimedOutTests"`
Expected: FAIL to compile (`TimedOut` / the `timedOut:` parameter do not exist).

- [ ] **Step 3: Add `TimedOut` to the exception**

In `PRism.AI.ClaudeCode/LlmProviderException.cs`, add the property and thread an optional `timedOut` flag through the 3-arg ctor (the CA1032 framework ctors inherit the CLR default `false` — no change needed there):

```csharp
    /// <summary>Process exit code (-1 for timeout / spawn failure).</summary>
    public int ExitCode { get; }

    /// <summary>True ONLY when the CLI call exceeded its wall-clock timeout (#496). False on
    /// exit-code, spawn (Win32Exception), and JSON-parse failures. Used by AiEndpoints to pick the
    /// 503 reason. ExitCode is -1 for BOTH timeout and spawn-not-found, so it is not a reliable
    /// discriminator — this flag is.</summary>
    public bool TimedOut { get; }

    public LlmProviderException(string message, string stderr, int exitCode, Exception? innerException = null, bool timedOut = false)
        : base(message, innerException)
    {
        Stderr = Redact(stderr);
        ExitCode = exitCode;
        TimedOut = timedOut;
    }
```

- [ ] **Step 4: Set `timedOut: true` at the timeout throw site only**

In `PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs:70`:

```csharp
        if (result.TimedOut)
            throw new LlmProviderException("claude -p timed out.", result.Stderr, -1, timedOut: true);
```

(Leave the spawn-failure throw at line 64-66, the exit-code throw at 72, and the JSON-parse throws at 75/77 unchanged — they keep the default `false`.)

- [ ] **Step 5: Run it to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~LlmProviderExceptionTimedOutTests"`
Expected: PASS (3 cases).

- [ ] **Step 6: Commit**

```bash
git add PRism.AI.ClaudeCode/LlmProviderException.cs PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs tests/PRism.AI.ClaudeCode.Tests/LlmProviderExceptionTimedOutTests.cs
git commit -m "feat(ai-settings): add LlmProviderException.TimedOut discriminator (#496)"
```

---

## Task 7: DI factory overload of `AddPrismClaudeCode` + Program.cs wiring

**Files:**
- Modify: `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs`
- Modify: `PRism.Web/Program.cs:78-86`
- Test: `tests/PRism.Web.Tests/Ai/ProviderTimeoutWiringTests.cs`
- Verify-only: `tests/PRism.AI.ClaudeCode.Tests/ServiceRegistrationTests.cs`, `StreamingServiceRegistrationTests.cs` (must still compile + pass — they use the instance overload)

- [ ] **Step 1: Write the failing test (production wiring reads IConfigStore)**

Create `tests/PRism.Web.Tests/Ai/ProviderTimeoutWiringTests.cs`. It exercises the full Web composition (so `Program.cs`'s factory is the one under test) via `PRismWebApplicationFactory`, patches the config store, and asserts the resolved `ClaudeCodeProviderOptions.TimeoutProvider()` reflects the new value.

```csharp
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.AI.ClaudeCode;
using PRism.Core.Config;
using Xunit;

namespace PRism.Web.Tests.Ai;

public class ProviderTimeoutWiringTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public ProviderTimeoutWiringTests(PRismWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task TimeoutProvider_reflects_a_config_patch_clamped()
    {
        using var scope = _factory.Services.CreateScope();
        var sp = scope.ServiceProvider;
        var store = sp.GetRequiredService<IConfigStore>();
        var options = sp.GetRequiredService<ClaudeCodeProviderOptions>();

        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = 300 }, default);
        options.TimeoutProvider().Should().Be(TimeSpan.FromSeconds(300));

        // This test's job is HOT-RELOAD: a patch is reflected by TimeoutProvider() with no restart.
        // The 600 here comes from ConfigStore's WRITE-clamp (Task 3); the TimeoutProvider lambda ALSO
        // clamps (ClampTimeout) but on a value the store already clamped, so this does not independently
        // exercise the lambda's read-clamp. The read-clamp (defending a config.json hand-edited to bypass
        // PatchAsync) is covered by AiConfigBoundsTests.ClampTimeout — there is no test backdoor to seed an
        // unclamped IConfigStore.Current here, and adding one is not worth it for a one-line Math.Clamp.
        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.providerTimeoutSeconds"] = 5000 }, default);
        options.TimeoutProvider().Should().Be(TimeSpan.FromSeconds(600));
    }
}
```

> If `PRismWebApplicationFactory.Services` resolution of a singleton `ClaudeCodeProviderOptions` differs (e.g. the factory swaps the provider in Test env), resolve from the root provider instead and skip-guard on a Test-only stub — but the options singleton itself is not swapped by the e2e fake-review hooks, so this should resolve cleanly.

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~ProviderTimeoutWiringTests"`
Expected: FAIL — today `Program.cs` builds the options by value with the static 240, so `TimeoutProvider()` returns 240 regardless of the patch.

- [ ] **Step 3: Add the factory overload**

In `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs`, refactor so the existing instance overload delegates to a new factory overload. Replace the body of the class:

```csharp
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddPrismClaudeCode(
        this IServiceCollection services, ClaudeCodeProviderOptions options, string usageDir)
    {
        ArgumentNullException.ThrowIfNull(options);
        // Delegate to the factory overload so there is ONE registration code path. The instance
        // overload protects the 3 instance-overload test call sites (ServiceRegistrationTests,
        // StreamingServiceRegistrationTests x2), which do NOT register IConfigStore.
        return services.AddPrismClaudeCode(_ => options, usageDir);
    }

    // #496: factory overload. The composition root (PRism.Web/Program.cs) supplies a factory that
    // closes over IServiceProvider so ClaudeCodeProviderOptions.TimeoutProvider can resolve
    // IConfigStore (in PRism.Core) and clamp via AiConfigBounds (in PRism.Core) on each call —
    // those symbols are NOT visible here (PRism.AI.ClaudeCode references only PRism.AI.Contracts +
    // PRism.Core.Contracts), which is exactly why the closure must live in Program.cs, not here.
    public static IServiceCollection AddPrismClaudeCode(
        this IServiceCollection services, Func<IServiceProvider, ClaudeCodeProviderOptions> optionsFactory, string usageDir)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(optionsFactory);
        ArgumentException.ThrowIfNullOrEmpty(usageDir);

        services.AddSingleton(optionsFactory);
        services.AddSingleton<ICliProcessRunner, SystemCliProcessRunner>();
        services.AddSingleton<ILlmProvider, ClaudeCodeLlmProvider>();
        services.AddSingleton<IStreamingCliProcessFactory, SystemStreamingCliProcessFactory>();
        services.AddSingleton<IStreamingLlmProvider>(sp => new ClaudeCodeStreamingProvider(
            sp.GetRequiredService<IStreamingCliProcessFactory>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            sp.GetRequiredService<ILoggerFactory>()));   // inject a real logger so drift-guard warnings reach a sink
        services.AddSingleton<ITokenUsageTracker>(_ => new JsonlTokenUsageTracker(usageDir));
        // Register the concrete type so Web's AddPrismAi can resolve it directly when
        // wrapping it with CachedLlmAvailabilityProbe. The interface forwarding below keeps
        // all other consumers (and test-factory RemoveAll<ILlmAvailabilityProbe>) unchanged.
        services.AddSingleton(sp => new ClaudeCodeAvailabilityProbe(
            sp.GetRequiredService<ICliProcessRunner>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            identityMatches: ClaudeIdentity.SameOsUserAsCredentialStore));
        services.AddSingleton<ILlmAvailabilityProbe>(
            sp => sp.GetRequiredService<ClaudeCodeAvailabilityProbe>());
        services.AddSingleton(ClaudeProviderDescriptor.Create());
        return services;
    }
}
```

- [ ] **Step 4: Wire the factory in `Program.cs`**

In `PRism.Web/Program.cs`, replace the `builder.Services.AddPrismClaudeCode(new ClaudeCodeProviderOptions { … }, llmUsageDir);` call (lines 78-86) with the factory form. Add `using PRism.Core.Config;` to the file's usings if not already present.

```csharp
builder.Services.AddPrismClaudeCode(
    // #496: factory so the per-call timeout is read HOT from IConfigStore (no restart). The static
    // Timeout below is the default-construction fallback only; TimeoutProvider is the live source.
    sp => new ClaudeCodeProviderOptions
    {
        WorkingDirectory = llmCwd,
        // Hard wall-clock ceiling per provider call (annotation is the slowest seam; 240s interim —
        // see docs/specs/2026-06-14-ai-hunk-annotator-keystone-design.md). Static fallback for the
        // direct-construction path; the live value comes from TimeoutProvider.
        Timeout = TimeSpan.FromSeconds(240),
        TimeoutProvider = () => TimeSpan.FromSeconds(
            AiConfigBounds.ClampTimeout(
                sp.GetRequiredService<IConfigStore>().Current.Ui.Ai.ProviderTimeoutSeconds)),
    },
    llmUsageDir);
```

- [ ] **Step 5: Run the new wiring test**

Run: `dotnet test --filter "FullyQualifiedName~ProviderTimeoutWiringTests"`
Expected: PASS (1 test, 2 assertions).

- [ ] **Step 6: Confirm the instance-overload tests still pass**

Run: `dotnet test --filter "FullyQualifiedName~ServiceRegistrationTests|FullyQualifiedName~StreamingServiceRegistrationTests|FullyQualifiedName~AvailabilityProbeRegistrationTests"`
Expected: PASS — they call the instance overload, which now delegates to the factory overload; behavior is identical and they do not register `IConfigStore` (their options carry the `() => Timeout` default and never resolve the store).

- [ ] **Step 7: Commit**

```bash
git add PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Ai/ProviderTimeoutWiringTests.cs
git commit -m "feat(ai-settings): wire hot provider-timeout DI factory in Program.cs (#496)"
```

---

## Task 8: `ClaudeCodeHunkAnnotator` upper-clamp on read

**Files:**
- Modify: `PRism.Web/Ai/ClaudeCodeHunkAnnotator.cs:120-121`
- Test: `tests/PRism.Web.Tests/Ai/ClaudeCodeHunkAnnotatorTests.cs` (add a case alongside the existing `Nonpositive_cap_clamps_to_ten`)

- [ ] **Step 1: Write the failing test**

Add to the existing `ClaudeCodeHunkAnnotatorTests` class (match its fixture/helper pattern for constructing the annotator with a stubbed `IConfigStore` whose `Current.Ui.Ai.HunkAnnotationCap` is settable — the existing `Nonpositive_cap_clamps_to_ten` test already does this; mirror it):

```csharp
    [Fact]
    public async Task Cap_above_max_is_clamped_to_50_on_read()
    {
        // Arrange: a hand-edited config persisted an out-of-range cap (bypassed PatchAsync).
        // The annotator must upper-clamp on read so the prompt never asks for >50 annotations.
        var cap = await CapPassedToCompleteAsync(configuredCap: 999);
        cap.Should().Be(50);
    }
```

> `CapPassedToCompleteAsync(int configuredCap)` is the helper the existing nonpositive test uses to drive one annotate call and capture the `cap` argument reaching `CompleteAndParseAsync`/the prompt builder. If the existing test inlines this instead, inline the new case the same way: set the stub store's cap to 999, run `AnnotateAsync`, and assert the prompt/`cap` reflects 50. Read the existing test body first and follow its exact mechanism.

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~ClaudeCodeHunkAnnotatorTests"`
Expected: FAIL — `Cap_above_max_is_clamped_to_50_on_read` sees 999 (no upper bound today).

- [ ] **Step 3: Add the upper-clamp after the existing floor**

In `PRism.Web/Ai/ClaudeCodeHunkAnnotator.cs:120-121`, replace the two-line read with the single-sourced `ClampCapForRead` (which encodes both the `<=0 → 10` floor AND the upper bound, so the annotator and the GET DTO cannot drift — see Task 1/Task 4). Add `using PRism.Core.Config;` to the file if not present.

```csharp
        // #496: ClampCapForRead = legacy/absent (<=0) → 10 (NOT min 1), else cap at MaxCap (50). Single
        // source shared with the GET DTO's display-clamp so shown == effective. Preserves the prior
        // <=0 → 10 floor (pinned by Nonpositive_cap_clamps_to_ten).
        var cap = AiConfigBounds.ClampCapForRead(_configStore.Current.Ui.Ai.HunkAnnotationCap);
```

> The annotator's local `internal const int DefaultCap = 10;` (line 36) is now unused by this read path. Leave it if any other code/test references it; otherwise remove it (an unused `const` is a Hidden-severity diagnostic, not a TWAE build break — but prefer removing dead state). Run `dotnet build` and let the compiler/analyzers tell you whether anything still references it before deleting.

- [ ] **Step 4: Run it to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~ClaudeCodeHunkAnnotatorTests"`
Expected: PASS — both `Nonpositive_cap_clamps_to_ten` (≤0→10 floor preserved) and the new `Cap_above_max_is_clamped_to_50_on_read`.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Ai/ClaudeCodeHunkAnnotator.cs tests/PRism.Web.Tests/Ai/ClaudeCodeHunkAnnotatorTests.cs
git commit -m "feat(ai-settings): upper-clamp hunk-annotation cap on read (#496)"
```

---

## Task 9: `AiEndpoints` — 503 `{ reason }` body + draft guardrail

**Files:**
- Modify: `PRism.Web/Endpoints/AiEndpoints.cs` (the three `catch` blocks in `ResolveSummaryAsync`, `ResolveFileFocusAsync`, `ResolveHunkAnnotationsAsync`; the draft-suggestions endpoint comment)
- Test: `tests/PRism.Web.Tests/Endpoints/AiEndpointsFailureReasonTests.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Web.Tests/Endpoints/AiEndpointsFailureReasonTests.cs`. **Reaching a throwing seam is the part the test most easily gets wrong, so use the existing proven harness rather than hand-rolling DI overrides.** `AiSeamSelector` in Preview returns a `_placeholder` dict built ONCE at construction from the *concrete* `sealed PlaceholderPrSummarizer` — it never reads the `IPrSummarizer` interface registration, and the sealed placeholder cannot be subclassed to throw. So a `RemoveAll<IPrSummarizer>()` swap is inert (→ 200, never 503). The reliable route is the **Live seam over a throwing `ILlmProvider`**, which is exactly what `AiSummaryTestContext` already wires: it constructs the real `ClaudeCodeSummarizer` over a provider you supply, and exposes `ModeState`, `SeedConsent()`, `subscribeAll`, and an authenticated `CreateClient()`. Pass a provider whose `CompleteAsync` throws, set `Mode = Live`, seed consent, subscribe — the summarizer propagates the `LlmProviderException` to `ResolveSummaryAsync`'s catch → 503 `{ reason }`.

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PRism.AI.ClaudeCode;             // LlmProviderException
using PRism.AI.Contracts.Provider;     // ILlmProvider, LlmRequest, LlmResult
using PRism.Core.Ai;                   // AiMode
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class AiEndpointsFailureReasonTests
{
    // A provider that always throws — stands in for a timeout (timedOut:true) or a generic failure
    // (timedOut:false). The real ClaudeCodeSummarizer calls CompleteAsync and lets this propagate; the
    // endpoint's catch maps it to 503 { reason }. (Mirror the real ILlmProvider signature exactly.)
    private sealed class ThrowingLlmProvider(bool timedOut) : ILlmProvider
    {
        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct) =>
            throw new LlmProviderException("boom", stderr: "", exitCode: -1, timedOut: timedOut);
    }

    private static async Task<JsonElement> SummaryFailureBody(bool timedOut)
    {
        // AiSummaryTestContext lights up the REAL ClaudeCodeSummarizer over our throwing provider (the
        // proven pattern from AiSummaryGateTests). Live + consent + subscribed = the seam is reached.
        using var ctx = new AiSummaryTestContext(new ThrowingLlmProvider(timedOut), subscribeAll: true);
        ctx.ModeState.Mode = AiMode.Live;
        ctx.SeedConsent();
        using var client = ctx.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/ai/summary", UriKind.Relative));
        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        return await resp.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task Timeout_failure_returns_503_with_reason_timeout() =>
        (await SummaryFailureBody(timedOut: true)).GetProperty("reason").GetString().Should().Be("timeout");

    [Fact]
    public async Task Generic_provider_failure_returns_503_with_reason_provider_error() =>
        (await SummaryFailureBody(timedOut: false)).GetProperty("reason").GetString().Should().Be("provider-error");
}
```

> **Why this harness, confirmed against source:** `AiSummaryTestContext` (`tests/PRism.Web.Tests/Endpoints/AiSummaryTestContext.cs`) takes `(ILlmProvider provider, bool subscribeAll)`, builds the real `ClaudeCodeSummarizer` over `provider`, and its `CreateClient()` already injects the session token + Origin (no `AddPrismSessionHeaders` needed — that helper requires a `token` arg and would not compile zero-arg). `SeedConsent()` sets `AiConsentState` for `AiProviderIds.Claude`/`AiDisclosure.CurrentVersion`, which the `AiSeamSelector` Live branch REQUIRES (without it Live falls back to Noop → 204). Confirm `ClaudeCodeSummarizer.SummarizeAsync` propagates `LlmProviderException` (does not swallow it) before relying on the 503 — the `FakeOk…Provider` gate tests prove the provider is actually reached. This route also exercises the real HTTP pipeline, so it verifies the camelCase `reason` wire shape, not just the value.

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~AiEndpointsFailureReasonTests"`
Expected: FAIL — today the catch returns `Results.StatusCode(503)` with no body, so `reason` is absent.

- [ ] **Step 3: Add the `AiFailureBody` record**

At the bottom of `PRism.Web/Endpoints/AiEndpoints.cs` (outside the `AiEndpoints` static class, same namespace):

```csharp
// #496: 503 body so the frontend can distinguish a provider timeout (→ "Adjust timeout" deep-link)
// from a generic provider failure. Serialized camelCase by the Api JSON policy → { "reason": "timeout" }.
internal sealed record AiFailureBody(string Reason);
```

- [ ] **Step 4: Replace the three `LlmProviderException` catches + the ArgumentException catches**

In each of `ResolveSummaryAsync`, `ResolveFileFocusAsync`, `ResolveHunkAnnotationsAsync`, change the catch arms:

```csharp
        catch (LlmProviderException ex)
        {
            return Results.Json(new AiFailureBody(ex.TimedOut ? "timeout" : "provider-error"),
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
        catch (ArgumentException)
        {
            // PromptSanitizer.WrapAsData throws when diff-derived content exceeds the 2 MB cap. It is a
            // provider-side failure (attacker-influenceable input), mapped to 503 "provider-error" — never
            // 500 — preserving the "provider failure → 503" contract. Not a timeout.
            return Results.Json(new AiFailureBody("provider-error"),
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
```

(Keep each method's existing explanatory comment above its `catch (ArgumentException)`; the snippet condenses it — preserve the per-seam wording already there.)

- [ ] **Step 5: Add the draft-suggestions guardrail comment**

In the `MapGet(".../ai/draft-suggestions", …)` lambda (lines 57-66), keep the body unchanged but add a guardrail comment above the handler (mirroring the existing D111 IsSubscribed guardrail):

```csharp
        // #496 GUARDRAIL: draft-suggestions has NO try/catch because PlaceholderDraftSuggester is canned
        // and cannot throw. When a real draft-suggestions seam is swapped in, it MUST add the
        // `catch (LlmProviderException ex) → Results.Json(new AiFailureBody(ex.TimedOut ? "timeout" :
        // "provider-error"), statusCode: 503)` arm (mirroring the other three seams). Without it, a
        // provider timeout here surfaces as a 500 and bypasses the reason mechanism — the "Adjust timeout"
        // deep-link will never fire for this seam. The frontend treats a missing reason as "provider-error".
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/draft-suggestions",
```

- [ ] **Step 6: Run it to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~AiEndpointsFailureReasonTests"`
Expected: PASS (2 cases).

- [ ] **Step 7: Confirm no AI-endpoint regressions**

Run: `dotnet test --filter "FullyQualifiedName~AiEndpoints"`
Expected: PASS (the existing 503/204/200 behavior tests still hold — status is unchanged; only a body was added).

- [ ] **Step 8: Commit**

```bash
git add PRism.Web/Endpoints/AiEndpoints.cs tests/PRism.Web.Tests/Endpoints/AiEndpointsFailureReasonTests.cs
git commit -m "feat(ai-settings): 503 { reason } body for AI seam failures (#496)"
```

---

## Task 10: Frontend types — `AiFailureReason`, `UiPreferences` fields, error reason

**Files:**
- Modify: `frontend/src/api/types.ts`
- Test: covered by Tasks 11-13 (this task is type-only; tsc is the gate)

> Deviation note: the spec text places `AiFailureReason` in `aiFailure.tsx`. It is declared in `types.ts` (the api layer) instead, so the api clients can import it without a component→api layering cycle; `aiFailure.tsx` re-exports it for component consumers. Functionally identical.

- [ ] **Step 1: Add `AiFailureReason` + extend `UiPreferences` + `AiSummaryResult`**

In `frontend/src/api/types.ts`:

Add near the top type aliases (after `ContentScale`, line 5):

```typescript
// #496: why an AI seam failed, surfaced via the 503 body { reason }. Drives the timeout-specific
// toast copy + "Adjust timeout" deep-link. A missing/unknown reason defaults to 'provider-error'.
export type AiFailureReason = 'timeout' | 'provider-error';
```

Extend `UiPreferences` (lines 14-20):

```typescript
export interface UiPreferences {
  theme: Theme;
  accent: Accent;
  aiMode: AiMode;
  density: Density;
  contentScale: ContentScale;
  // #496 AI Settings tab — clamped, hot-reloaded knobs. The GET DTO already clamps these for display.
  providerTimeoutSeconds: number;
  hunkAnnotationCap: number;
}
```

Extend the `AiSummaryResult` error variant (lines 243-247):

```typescript
export type AiSummaryResult =
  | { kind: 'ok'; summary: PrSummary }
  | { kind: 'absent' }
  | { kind: 'auth' }
  | { kind: 'error'; reason: AiFailureReason };
```

- [ ] **Step 2: Typecheck**

Run (from `frontend/`): `node ./node_modules/typescript/bin/tsc -b`
Expected: errors at `aiSummary.ts` (the `{ kind: 'error' }` returns now lack `reason`) and anywhere constructing `UiPreferences` mocks without the two fields. These are fixed in Tasks 11/16/17 — that is expected mid-stream. Do NOT commit yet; fold this type change into Task 11's commit so the tree never has a broken typecheck checkpoint.

> Because this task leaves tsc red on its own, it is NOT independently committed. Proceed directly to Task 11 and commit them together.

---

## Task 11: api clients + hooks surface the failure reason

**Files:**
- Modify: `frontend/src/api/client.ts` (add `readFailureReason`)
- Modify: `frontend/src/api/aiSummary.ts`, `frontend/src/api/aiFileFocus.ts`
- Modify: `frontend/src/hooks/useAiSummary.ts`, `useFileFocusResult.ts`, `useAiHunkAnnotations.ts`, `useAiDraftSuggestions.ts`
- Test: `frontend/src/api/aiSummary.reason.test.ts` (new), plus the existing hook tests must stay green

- [ ] **Step 1: Write the failing test**

Create `frontend/src/api/aiSummary.reason.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAiSummaryResult } from './aiSummary';
import { ApiError } from './client';

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return { ...actual, apiClient: { get: vi.fn(), post: vi.fn() } };
});
import { apiClient } from './client';

describe('getAiSummaryResult reason', () => {
  beforeEach(() => vi.clearAllMocks());

  it('surfaces reason "timeout" from a 503 body', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new ApiError(503, null, { reason: 'timeout' }));
    const r = await getAiSummaryResult({ owner: 'o', repo: 'r', number: 1 });
    expect(r).toEqual({ kind: 'error', reason: 'timeout' });
  });

  it('defaults to "provider-error" when the 503 body has no reason', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new ApiError(503, null, {}));
    const r = await getAiSummaryResult({ owner: 'o', repo: 'r', number: 1 });
    expect(r).toEqual({ kind: 'error', reason: 'provider-error' });
  });

  it('maps 401 to auth (unchanged)', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new ApiError(401, null, null));
    const r = await getAiSummaryResult({ owner: 'o', repo: 'r', number: 1 });
    expect(r).toEqual({ kind: 'auth' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/api/aiSummary.reason.test.ts`
Expected: FAIL — `getAiSummaryResult` returns `{ kind: 'error' }` with no `reason`.

- [ ] **Step 3: Add the `readFailureReason` helper**

In `frontend/src/api/client.ts`, after the `ApiError` class (line 14), add:

```typescript
import type { AiFailureReason } from './types';

// #496: extract the AI-failure reason from a 503 body ({ reason }). Defaults to 'provider-error' for
// a missing/unknown reason or a non-ApiError throw (network failure), so callers never branch on null.
export function readFailureReason(body: unknown): AiFailureReason {
  if (body && typeof body === 'object' && 'reason' in body) {
    const r = (body as { reason?: unknown }).reason;
    if (r === 'timeout' || r === 'provider-error') return r;
  }
  return 'provider-error';
}
```

> Place the `import type { AiFailureReason }` with the file's other imports at the top (the example shows it inline for clarity).

- [ ] **Step 4: Surface reason in `aiSummary.ts`**

In `frontend/src/api/aiSummary.ts`, update `resolveSummary`'s catch:

```typescript
import { apiClient, ApiError, readFailureReason } from './client';
```

```typescript
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { kind: 'auth' };
    return { kind: 'error', reason: err instanceof ApiError ? readFailureReason(err.body) : 'provider-error' };
  }
```

- [ ] **Step 5: Surface reason in `aiFileFocus.ts`**

In `frontend/src/api/aiFileFocus.ts`, widen the error variant and populate it:

```typescript
import { apiClient, ApiError, readFailureReason } from './client';
import type { PrReference, FileFocusResult, AiFailureReason } from './types';

export type AiFileFocusOutcome =
  | { kind: 'ok'; result: FileFocusResult }
  | { kind: 'no-content' }
  | { kind: 'auth' }
  | { kind: 'error'; reason: AiFailureReason };
```

```typescript
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { kind: 'auth' };
    return { kind: 'error', reason: err instanceof ApiError ? readFailureReason(err.body) : 'provider-error' };
  }
```

- [ ] **Step 6: Pass reason to `report` in the four hooks**

`useAiSummary.ts` — both `report` calls (lines 57 and 107) become:

```typescript
        report(prRef, 'summary', { retry: regenerate, reason: r.reason });
```

(Both the regenerate-path `else if (r.kind === 'error')` and the initial-fetch `else if (r.kind === 'error')` have an `r` of the error shape, so `r.reason` is available.)

`useFileFocusResult.ts` — the in-`then` error branch (line 55):

```typescript
        } else if (outcome.kind === 'error') {
          setState({ status: 'error', entries: [] });
          report(prRef, 'file-focus', { retry, reason: outcome.reason });
```

and the defensive `.catch` (lines 69-73), which has no outcome, defaults the reason:

```typescript
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'error', entries: [] });
          report(prRef, 'file-focus', { retry, reason: 'provider-error' });
        }
      });
```

`useAiHunkAnnotations.ts` — the `.catch((err) => …)` (lines 29-34) reads the reason off the ApiError. Add the import and pass it:

```typescript
import { ApiError, readFailureReason } from '../api/client';
```

```typescript
      .catch((err) => {
        if (cancelled) return;
        setEntries(null);
        if (err instanceof ApiError && err.status === 401) clear(prRef, 'hunk-annotations');
        else
          report(prRef, 'hunk-annotations', {
            retry,
            reason: err instanceof ApiError ? readFailureReason(err.body) : 'provider-error',
          });
      });
```

`useAiDraftSuggestions.ts` — symmetric to hunk-annotations (the backend draft endpoint cannot emit a timeout reason in Phase 1, so this resolves to 'provider-error' in practice, but the plumbing is uniform):

```typescript
import { ApiError, readFailureReason } from '../api/client';
```

```typescript
      .catch((err) => {
        if (cancelled) return;
        setEntries(null);
        if (err instanceof ApiError && err.status === 401) clear(prRef, 'draft-suggestions');
        else
          report(prRef, 'draft-suggestions', {
            retry,
            reason: err instanceof ApiError ? readFailureReason(err.body) : 'provider-error',
          });
      });
```

> `FailureEntry.reason` does not exist yet (Task 12 adds it). To keep this task's tsc green, this task depends on Task 12 being applied first OR you add the `reason?` field to `FailureEntry` here. **Decision:** add the `reason?: AiFailureReason` field to `FailureEntry` as the FIRST edit of this task (it is a one-line type widening; the derived `anyTimedOut` consumer is Task 12). See Step 6a.

- [ ] **Step 6a: Widen `FailureEntry` (minimal, to keep tsc green)**

In `frontend/src/components/Ai/aiFailure.tsx`, add the import and the optional field now (the derived `anyTimedOut` is added in Task 12):

```typescript
import type { PrReference, AiFailureReason } from '../../api/types';
```

```typescript
interface FailureEntry {
  retry: () => void;
  // #496: why the seam failed; drives the timeout-aware toast. Optional so older callers/tests compile.
  reason?: AiFailureReason;
}
```

- [ ] **Step 6b: Patch the type-checked test files that build a `PreferencesResponse` (REQUIRED — they break `tsc` otherwise)**

Widening `UiPreferences` with two REQUIRED fields breaks every test file that constructs a `: PreferencesResponse`-annotated object without them. These three are confirmed (each has a `(): PreferencesResponse` / `function …(): PreferencesResponse` helper) and are NOT touched by any other task — add `providerTimeoutSeconds: 240,` and `hunkAnnotationCap: 10,` to their `ui` object literal:
- `frontend/src/components/AppearanceSync.test.tsx`
- `frontend/src/hooks/useAiGate.reactivity.test.tsx`
- `frontend/src/contexts/PreferencesContext.aimode.test.tsx`

Then sweep for any other type-checked constructor: content-search `frontend/src/**/*.test.tsx` (and `.ts`) for `: PreferencesResponse` and for `UiPreferences`-typed `ui` literals, and add the two fields wherever the object is type-annotated. Loose `vi.mock` object literals that are NOT type-annotated do not break `tsc` — leave those to Tasks 16/17, which already touch them. The `tsc -b` in Step 8 is the backstop: it must be green before committing.

- [ ] **Step 7: Run the new + existing affected tests**

Run (from `frontend/`):
```
node ./node_modules/vitest/vitest.mjs run src/api/aiSummary.reason.test.ts src/hooks/useAiSummary.test.tsx src/hooks/useFileFocusResult.test.tsx src/hooks/useAiHunkAnnotations.test.tsx src/hooks/useAiDraftSuggestions.test.tsx src/components/AppearanceSync.test.tsx src/hooks/useAiGate.reactivity.test.tsx src/contexts/PreferencesContext.aimode.test.tsx
```
Expected: PASS. (The existing hook tests assert `report` was called; the added `reason` arg is additive and should not break them. If a hook test asserts the exact `report` args with `toHaveBeenCalledWith({ retry: … })`, update it to include `reason: expect.any(String)` or the specific value.)

- [ ] **Step 8: Typecheck**

Run (from `frontend/`): `node ./node_modules/typescript/bin/tsc -b`
Expected: PASS for the api/hooks layer. (Pane/mocks fixed in later tasks — if tsc still flags `UiPreferences` mocks missing the two new fields in test files, those belong to Tasks 16/17; note them and proceed. The api+hooks source must be clean.)

- [ ] **Step 9: Commit (folds Task 10)**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/api/aiSummary.ts frontend/src/api/aiFileFocus.ts frontend/src/hooks/useAiSummary.ts frontend/src/hooks/useFileFocusResult.ts frontend/src/hooks/useAiHunkAnnotations.ts frontend/src/hooks/useAiDraftSuggestions.ts frontend/src/components/Ai/aiFailure.tsx frontend/src/api/aiSummary.reason.test.ts frontend/src/components/AppearanceSync.test.tsx frontend/src/hooks/useAiGate.reactivity.test.tsx frontend/src/contexts/PreferencesContext.aimode.test.tsx
git commit -m "feat(ai-settings): thread AI failure reason from 503 body to report() (#496)"
```

---

## Task 12: `aiFailure` derived `anyTimedOut` + container forwarding

**Files:**
- Modify: `frontend/src/components/Ai/aiFailure.tsx`
- Modify: `frontend/src/components/Ai/AiFailureContainer.tsx`
- Test: `frontend/src/components/Ai/aiFailure.anyTimedOut.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/Ai/aiFailure.anyTimedOut.test.tsx`. It renders a probe inside `AiFailureProvider`, reports failures with mixed reasons for the active PR route, and asserts `anyTimedOut`. Match the route-mocking the existing `aiFailure.test.tsx` uses (it stubs `useEffectiveLocation`/route to make a PR "active"); read that file first and reuse its harness.

```typescript
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AiFailureProvider, useAiFailure } from './aiFailure';
import type { PrReference } from '../../api/types';

// NOTE: reuse the active-PR route setup from aiFailure.test.tsx (mock useEffectiveLocation to a
// /pr/o/r/1 route so prRef o/r/1 is the active key). The block below assumes that mock is in place.

const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };

function Probe() {
  const api = useAiFailure();
  return (
    <div>
      <span data-testid="any-timed-out">{String(api.anyTimedOut)}</span>
      <button onClick={() => api.report(PR, 'summary', { retry: () => {}, reason: 'timeout' })}>t</button>
      <button onClick={() => api.report(PR, 'file-focus', { retry: () => {}, reason: 'provider-error' })}>p</button>
      <button onClick={() => api.clearPr(PR)}>c</button>
    </div>
  );
}

describe('anyTimedOut', () => {
  it('is false with no failures, true when any active failed seam timed out, false after clear', async () => {
    render(
      <AiFailureProvider>
        <Probe />
      </AiFailureProvider>,
    );
    expect(screen.getByTestId('any-timed-out').textContent).toBe('false');
    await act(async () => screen.getByText('p').click()); // provider-error only
    expect(screen.getByTestId('any-timed-out').textContent).toBe('false');
    await act(async () => screen.getByText('t').click()); // add a timeout
    expect(screen.getByTestId('any-timed-out').textContent).toBe('true');
    await act(async () => screen.getByText('c').click()); // clear the PR
    expect(screen.getByTestId('any-timed-out').textContent).toBe('false');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/Ai/aiFailure.anyTimedOut.test.tsx`
Expected: FAIL — `api.anyTimedOut` is `undefined` (not on the API yet).

- [ ] **Step 3: Add `anyTimedOut` to the API, NOOP, derivation, and value**

In `frontend/src/components/Ai/aiFailure.tsx`:

Add to `AiFailureApi` (after `dismissed`, line 32):

```typescript
  dismissed: boolean; // user dismissed the current failure-set fingerprint
  // #496: true when any ACTIVE failed seam's reason is 'timeout' — drives the timeout-aware toast copy
  // + "Adjust timeout" deep-link. Derived, not a setter. NOT part of the dismissal fingerprint.
  anyTimedOut: boolean;
```

Add to `NOOP` (after `dismissed: false`, line 43):

```typescript
  dismissed: false,
  anyTimedOut: false,
```

Derive it next to `activeFailedSeams` (after the `activeFailedSeams` useMemo, ~line 130):

```typescript
  const anyTimedOut = useMemo<boolean>(() => {
    if (!activeKey) return false;
    const forPr = failures[activeKey];
    if (!forPr) return false;
    return SEAM_ORDER.some((s) => forPr[s]?.reason === 'timeout');
  }, [activeKey, failures]);
```

Add it to the value object + deps (the `useMemo<AiFailureApi>` at lines 152-174):

```typescript
      activeFailedSeams,
      retrying: retryingKey !== null && retryingKey === activeKey,
      dismissed,
      anyTimedOut,
    }),
    [
      report,
      clear,
      clearPr,
      retryAll,
      dismiss,
      activeFailedSeams,
      retryingKey,
      activeKey,
      dismissed,
      anyTimedOut,
    ],
```

> **Documented edge case (dismissal fingerprint excludes reason):** the fingerprint stays `${activeKey}:${activeFailedSeams.join(',')}` (reason-free, per the spec's deliberate "a reason change for the same seam set does not un-dismiss" decision). Consequence to note: if a user dismisses a `provider-error` toast and the SAME seam later escalates to `timeout` WITHOUT a retry (e.g. a remount/base-change re-`report()`s), the fingerprint is unchanged so the toast stays dismissed — the "Adjust timeout" affordance will not re-surface until a retry (which clears the dismissal) or a seam-set change. `anyTimedOut` itself recomputes correctly (it reads the live map); only the dismissal gate hides it. This is an accepted Phase-1 trade-off (a retry is the normal next action and un-dismisses); do NOT add reason to the fingerprint without the owner's call, as that reverses the spec's documented decision.

- [ ] **Step 4: Forward `anyTimedOut` from the container**

In `frontend/src/components/Ai/AiFailureContainer.tsx`, destructure and pass it (the toast prop is added in Task 13; this leaves tsc red until then — fold Tasks 12+13 into one commit, OR add the toast prop now). **Decision:** apply Task 13's `AiFailureToast` change immediately after this step and commit both together. For now:

```typescript
  const { activeFailedSeams, retrying, dismissed, anyTimedOut, retryAll, dismiss } = useAiFailure();
```

```tsx
      {visible && (
        <AiFailureToast
          seams={activeFailedSeams}
          retrying={retrying}
          anyTimedOut={anyTimedOut}
          onRetry={retryAll}
          onDismiss={dismiss}
        />
      )}
```

- [ ] **Step 5: Run the new test (toast change pending)**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/Ai/aiFailure.anyTimedOut.test.tsx`
Expected: PASS (the derivation is exercised through the Probe, independent of the toast). If tsc/the container fails to compile because `AiFailureToast` has no `anyTimedOut` prop yet, proceed to Task 13 before running the full typecheck.

- [ ] **Step 6: Commit after Task 13 (combined)**

Do not commit yet — Task 13 completes the toast prop and copy. Commit both together at the end of Task 13.

---

## Task 13: `AiFailureToast` — timeout copy + "Adjust timeout" deep-link

**Files:**
- Modify: `frontend/src/components/Ai/AiFailureToast.tsx`
- Modify: `frontend/src/components/Ai/AiFailureToast.module.css` (add an `.adjust` action style)
- Test: `frontend/src/components/Ai/AiFailureToast.test.tsx` (extend; if it doesn't exist, create)

- [ ] **Step 1: Write the failing test**

Create/extend `frontend/src/components/Ai/AiFailureToast.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { AiFailureToast } from './AiFailureToast';

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="loc">{`${loc.pathname}|${JSON.stringify(loc.state)}`}</span>;
}

function renderToast(anyTimedOut: boolean) {
  return render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <Routes>
        <Route
          path="/pr/o/r/1"
          element={
            <AiFailureToast
              seams={['summary']}
              retrying={false}
              anyTimedOut={anyTimedOut}
              onRetry={vi.fn()}
              onDismiss={vi.fn()}
            />
          }
        />
        <Route path="/settings/ai" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AiFailureToast timeout copy', () => {
  it('shows generic copy and no Adjust-timeout when not timed out', () => {
    renderToast(false);
    expect(screen.getByText(/the provider failed or timed out|AI couldn't generate/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /adjust timeout/i })).toBeNull();
  });

  it('shows timeout copy + Adjust-timeout deep-link when timed out', async () => {
    renderToast(true);
    expect(screen.getByText(/timed out/i)).toBeInTheDocument();
    const adjust = screen.getByRole('button', { name: /adjust timeout/i });
    await userEvent.click(adjust);
    // Navigated to /settings/ai with backgroundLocation state (so the PR is not torn down).
    const loc = screen.getByTestId('loc').textContent ?? '';
    expect(loc).toContain('/settings/ai');
    expect(loc).toContain('backgroundLocation');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/Ai/AiFailureToast.test.tsx`
Expected: FAIL — no `anyTimedOut` prop / no "Adjust timeout" button.

- [ ] **Step 3: Implement the timeout-aware toast**

Replace `frontend/src/components/Ai/AiFailureToast.tsx`:

```tsx
import { useNavigate, useLocation } from 'react-router-dom';
import styles from './AiFailureToast.module.css';
import type { AiSeam } from './aiFailure';

const DISPLAY_NAME: Record<AiSeam, string> = {
  summary: 'summary',
  'file-focus': 'hotspots',
  'hunk-annotations': 'annotations',
  'draft-suggestions': 'draft suggestions',
};

interface Props {
  seams: AiSeam[];
  retrying: boolean;
  // #496: when true (any failed seam timed out) the toast shows timeout copy + an "Adjust timeout"
  // deep-link to /settings/ai. Otherwise the existing generic line.
  anyTimedOut: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}

export function AiFailureToast({ seams, retrying, anyTimedOut, onRetry, onDismiss }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const names = seams.map((s) => DISPLAY_NAME[s]).join(', ');

  const adjustTimeout = () => {
    // backgroundLocation is REQUIRED: it makes the settings modal open OVER the current PR. Without
    // it, App.tsx's isSettingsPath fallback ({ pathname: '/' }) tears the PR down and the failure
    // context is lost. After the user closes Settings the PR remounts, the failed seams remain in the
    // registry, and this toast re-appears so the user can Retry with the new timeout.
    navigate('/settings/ai', { state: { backgroundLocation: location } });
  };

  return (
    <div className={styles.toast} role="group" aria-label="AI generation failure">
      <span className={styles.message}>
        {anyTimedOut
          ? 'AI generation timed out.'
          : `AI couldn't generate: ${names} — the provider failed or timed out.`}
      </span>
      {/* Retry is the primary recovery path → first in DOM/tab order. "Adjust timeout" is the
          supplementary escape hatch, then Dismiss. (design-lens: primary action first.) */}
      <button type="button" className={styles.retry} onClick={onRetry} disabled={retrying}>
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
      {anyTimedOut && (
        <button type="button" className={styles.adjust} onClick={adjustTimeout}>
          Adjust timeout
        </button>
      )}
      <button type="button" className={styles.dismiss} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Add the `.adjust` style**

In `frontend/src/components/Ai/AiFailureToast.module.css`, add `.adjust` to the shared button rule:

```css
.retry,
.dismiss,
.adjust {
  flex: none;
  background: none;
  border: 1px solid var(--border-1);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--text-1);
}
```

- [ ] **Step 5: Run the toast test**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/Ai/AiFailureToast.test.tsx`
Expected: PASS (2 cases).

- [ ] **Step 6: Full typecheck + the Ai suite**

Run (from `frontend/`):
```
node ./node_modules/typescript/bin/tsc -b
node ./node_modules/vitest/vitest.mjs run src/components/Ai
```
Expected: tsc clean for the Ai layer; the Ai test directory green. (Any `AiFailureToast` render in `AiFailureContainer.test.tsx` that doesn't pass `anyTimedOut` will fail to typecheck — update those renders to pass `anyTimedOut={false}` and wrap in a `MemoryRouter` if the toast now needs router context. The container test renders the container, which supplies the prop; only direct-toast renders need updating.)

- [ ] **Step 7: Format + lint the changed files**

Run (from `frontend/`):
```
node ./node_modules/prettier/bin/prettier.cjs --write src/components/Ai src/hooks src/api
node ./node_modules/eslint/bin/eslint.js src/components/Ai src/hooks src/api
```
Expected: clean.

- [ ] **Step 8: Commit (folds Task 12)**

```bash
git add frontend/src/components/Ai/aiFailure.tsx frontend/src/components/Ai/AiFailureContainer.tsx frontend/src/components/Ai/AiFailureToast.tsx frontend/src/components/Ai/AiFailureToast.module.css frontend/src/components/Ai/aiFailure.anyTimedOut.test.tsx frontend/src/components/Ai/AiFailureToast.test.tsx
git commit -m "feat(ai-settings): timeout-aware AI failure toast + Adjust-timeout deep-link (#496)"
```

---

## Task 14: `NumberStepper` design-system control

**Files:**
- Create: `frontend/src/components/controls/NumberStepper.tsx`, `NumberStepper.module.css`
- Test: `frontend/src/components/controls/NumberStepper.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/controls/NumberStepper.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { NumberStepper } from './NumberStepper';

function setup(value = 240, onChange = vi.fn()) {
  render(
    <NumberStepper
      label="Provider timeout"
      value={value}
      min={30}
      max={600}
      step={30}
      unit="seconds"
      onChange={onChange}
    />,
  );
  return onChange;
}

describe('NumberStepper', () => {
  it('renders a spinbutton with aria-valuetext including the unit', () => {
    setup(240);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    expect(sb).toHaveAttribute('aria-valuenow', '240');
    expect(sb).toHaveAttribute('aria-valuemin', '30');
    expect(sb).toHaveAttribute('aria-valuemax', '600');
    expect(sb).toHaveAttribute('aria-valuetext', '240 seconds');
  });

  it('ArrowUp / ArrowDown compound off the optimistic display value', async () => {
    const onChange = setup(240);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    sb.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith(270);
    // The displayed value advanced optimistically to 270 (the `value` prop is still 240 — the mock
    // doesn't echo). ArrowDown therefore steps from 270, NOT from the stale prop: 270 → 240.
    await userEvent.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith(240);
  });

  it('PageUp / PageDown use a large step (10×)', async () => {
    const onChange = setup(240);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    sb.focus();
    await userEvent.keyboard('{PageUp}'); // 240 + 300 (=step*10) = 540, on the step grid
    expect(onChange).toHaveBeenLastCalledWith(540);
  });

  it('Home / End jump to min / max', async () => {
    const onChange = setup(240);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    sb.focus();
    await userEvent.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith(30);
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith(600);
  });

  it('reconciles the displayed value when the value prop changes (server echo)', () => {
    const { rerender } = render(
      <NumberStepper label="L" value={240} min={30} max={600} step={30} unit="seconds" onChange={vi.fn()} />,
    );
    expect(screen.getByRole('spinbutton', { name: 'L' })).toHaveAttribute('aria-valuenow', '240');
    rerender(
      <NumberStepper label="L" value={300} min={30} max={600} step={30} unit="seconds" onChange={vi.fn()} />,
    );
    expect(screen.getByRole('spinbutton', { name: 'L' })).toHaveAttribute('aria-valuenow', '300');
  });

  it('disables decrement at min and increment at max', () => {
    const { rerender } = render(
      <NumberStepper label="L" value={30} min={30} max={600} step={30} unit="seconds" onChange={vi.fn()} />,
    );
    // Buttons are aria-hidden (AT-invisible) and carry no accessible name — query by their glyph text.
    expect(screen.getByText('−')).toBeDisabled();
    expect(screen.getByText('+')).not.toBeDisabled();
    rerender(
      <NumberStepper label="L" value={600} min={30} max={600} step={30} unit="seconds" onChange={vi.fn()} />,
    );
    expect(screen.getByText('+')).toBeDisabled();
  });

  it('does not fire onChange when stepping past the boundary', async () => {
    const onChange = setup(600);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    sb.focus();
    await userEvent.keyboard('{ArrowUp}'); // already at max → snap clamps to 600 == display → no-op
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

> The −/+ buttons are `aria-hidden="true"` (AT skips them; the spinbutton container is the single AT-exposed control, per the APG spinbutton pattern) and carry NO `aria-label` (an `aria-label` on an `aria-hidden` node is inert — it would be a misleading accessibility claim). The disabled-state tests therefore query by glyph text (`getByText('−')` / `getByText('+')`), which is a DOM query unaffected by `aria-hidden`. The `−` is U+2212 (minus sign) — keep it byte-identical between the component and the test.

- [ ] **Step 2: Run it to verify it fails**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/controls/NumberStepper.test.tsx`
Expected: FAIL to resolve the module (`NumberStepper` does not exist).

- [ ] **Step 3: Implement `NumberStepper`**

Create `frontend/src/components/controls/NumberStepper.tsx`:

```tsx
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import styles from './NumberStepper.module.css';

export interface NumberStepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  // When provided, the spinbutton is named via aria-labelledby pointing at this EXTERNAL label id (used
  // inside a Settings row that renders its own pane.label, so the row stays visually consistent with the
  // others). When omitted, the control renders its OWN visible label (standalone usage / unit tests).
  labelledById?: string;
}

// Accessible numeric stepper (spec §). The CONTAINER is the spinbutton (focusable, owns all keyboard
// events); the −/+ buttons are pointer affordances only (aria-hidden, tabIndex -1, no aria-label — the
// spinbutton is the single AT-exposed control, APG pattern). Apply-on-success: onChange is wired to
// usePreferences().set by the consumer, which echoes the server-clamped value back through `value`.
export function NumberStepper({ label, value, min, max, step, unit, onChange, labelledById }: NumberStepperProps) {
  const internalLabelId = useId();

  // Optimistic display: seed from `value`, advance INSTANTLY on each step so rapid presses COMPOUND
  // (rather than recomputing from a `value` prop that is stale until the apply-on-success POST echoes),
  // and reconcile whenever the server-echoed `value` changes. Without this, two quick presses both read
  // the pre-POST value and the second press is lost.
  const [display, setDisplay] = useState(value);
  useEffect(() => setDisplay(value), [value]);

  const pageStep = step * 10; // large step for PageUp/PageDown (snap() re-clamps to range)

  // Snap to the step grid (relative to min) and clamp to [min,max]. The control can therefore never
  // emit an out-of-range value, so the server clamp is an unreachable backstop from this path.
  const snap = (n: number) => {
    const clamped = Math.min(max, Math.max(min, n));
    const snapped = min + Math.round((clamped - min) / step) * step;
    return Math.min(max, Math.max(min, snapped));
  };
  const commit = (next: number) => {
    const v = snap(next);
    if (v !== display) {
      setDisplay(v);
      onChange(v);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowUp':   next = display + step; break;
      case 'ArrowDown': next = display - step; break;
      case 'PageUp':    next = display + pageStep; break;
      case 'PageDown':  next = display - pageStep; break;
      case 'Home':      next = min; break;
      case 'End':       next = max; break;
      default: return;
    }
    e.preventDefault();
    commit(next);
  };

  const atMin = display <= min;
  const atMax = display >= max;

  return (
    <div className={styles.wrap}>
      {labelledById ? null : (
        <span id={internalLabelId} className={styles.label}>
          {label}
        </span>
      )}
      <div
        role="spinbutton"
        tabIndex={0}
        aria-labelledby={labelledById ?? internalLabelId}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={display}
        aria-valuetext={`${display} ${unit}`}
        className={styles.stepper}
        onKeyDown={onKeyDown}
      >
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          className={styles.btn}
          disabled={atMin}
          onClick={() => commit(display - step)}
        >
          −
        </button>
        <span className={styles.value}>
          {display}
          <span className={styles.unit}> {unit}</span>
        </span>
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          className={styles.btn}
          disabled={atMax}
          onClick={() => commit(display + step)}
        >
          +
        </button>
      </div>
    </div>
  );
}
```

> **Error-revert is out of scope for Phase 1 (documented limitation):** if the apply-on-success POST fails, `usePreferences().set` shows a "Couldn't save preference." toast and `value` does not change, so the optimistic `display` stays on the attempted value until the next successful interaction or remount reconciles it. The bounded control cannot produce an out-of-range value, so this never persists a bad value — it is purely a transient display/server mismatch on a failed save. A full pending/rollback state (matching AppearancePane's contentScale rollback) is a deferred polish, not a Phase-1 requirement.

- [ ] **Step 4: Create the styles**

Create `frontend/src/components/controls/NumberStepper.module.css` (mirrors the SegmentedControl token usage):

```css
/* inline-flex (NOT width:100%) so the control sits inside a pane.spring (row mode, external label) AND
   renders "label  [stepper]" inline in standalone mode without stretching the row. */
.wrap {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
.label {
  font-size: var(--text-sm);
  color: var(--text-1);
}
.stepper {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: var(--surface-inset);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  padding: 2px;
}
.stepper:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 2px;
}
.btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  width: 28px;
  height: 26px;
  border-radius: var(--radius-1);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  background: var(--surface-3);
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.value {
  min-width: 84px;
  text-align: center;
  font-size: var(--text-sm);
  color: var(--text-1);
}
.unit {
  color: var(--text-3);
}
```

- [ ] **Step 5: Run it to verify it passes**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/controls/NumberStepper.test.tsx`
Expected: PASS (ArrowUp/Down compound, PageUp/Down large-step, Home/End, prop reconcile, boundary-disabled, no-op-at-boundary).

- [ ] **Step 6: Format + lint + typecheck**

Run (from `frontend/`):
```
node ./node_modules/prettier/bin/prettier.cjs --write src/components/controls/NumberStepper.tsx
node ./node_modules/eslint/bin/eslint.js src/components/controls/NumberStepper.tsx
node ./node_modules/typescript/bin/tsc -b
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/controls/NumberStepper.tsx frontend/src/components/controls/NumberStepper.module.css frontend/src/components/controls/NumberStepper.test.tsx
git commit -m "feat(ai-settings): add accessible NumberStepper control (#496)"
```

---

## Task 15: `PreferencesContext` — wire the two AI keys

**Files:**
- Modify: `frontend/src/contexts/PreferencesContext.tsx`
- Test: `frontend/src/contexts/PreferencesContext.aiNumeric.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/contexts/PreferencesContext.aiNumeric.test.tsx` — a NEW file for the numeric readKey/writeKey behavior. This is distinct from the pre-existing `PreferencesContext.aimode.test.tsx` (which Task 11 Step 6b only patches to add the two new required fields); the two coexist and are committed by their respective tasks.

```typescript
import { describe, it, expect } from 'vitest';
import { readKey, writeKey } from './PreferencesContext';
import type { PreferencesResponse } from '../api/types';

function base(): PreferencesResponse {
  return {
    ui: {
      theme: 'dark',
      accent: 'indigo',
      aiMode: 'preview',
      density: 'comfortable',
      contentScale: 'm',
      providerTimeoutSeconds: 240,
      hunkAnnotationCap: 10,
    },
    inbox: {
      sections: {
        'review-requested': true,
        'awaiting-author': true,
        'authored-by-me': true,
        mentioned: true,
        'recently-closed': true,
      },
      defaultSort: 'updated',
      sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned',
      showActivityRail: false,
      groupByRepo: true,
    },
    github: { host: 'https://github.com', configPath: 'c', logsPath: 'l' },
  };
}

describe('PreferencesContext AI numeric keys', () => {
  it('readKey returns the two AI numeric values', () => {
    expect(readKey(base(), 'ui.ai.providerTimeoutSeconds')).toBe(240);
    expect(readKey(base(), 'ui.ai.hunkAnnotationCap')).toBe(10);
  });

  it('writeKey updates providerTimeoutSeconds without touching inbox sections', () => {
    const next = writeKey(base(), 'ui.ai.providerTimeoutSeconds', 300);
    expect(next.ui.providerTimeoutSeconds).toBe(300);
    expect(next.inbox.sections['review-requested']).toBe(true); // not corrupted by the fall-through
  });

  it('writeKey updates hunkAnnotationCap', () => {
    const next = writeKey(base(), 'ui.ai.hunkAnnotationCap', 25);
    expect(next.ui.hunkAnnotationCap).toBe(25);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/contexts/PreferencesContext.aiNumeric.test.tsx`
Expected: FAIL to typecheck/run — the keys aren't in `PreferenceKey`, and `writeKey` would fall through to the `inbox.sections` slice (corrupting state).

- [ ] **Step 3: Extend the `PreferenceKey` union**

In `frontend/src/contexts/PreferencesContext.tsx`, add both keys to the union (lines 18-33):

```typescript
export type PreferenceKey =
  | 'theme'
  | 'accent'
  | 'ui.ai.mode'
  | 'ui.ai.providerTimeoutSeconds'
  | 'ui.ai.hunkAnnotationCap'
  | 'density'
  | 'contentScale'
  | 'inbox.defaultSort'
  | 'inbox.sectionOrder'
  | 'inbox.showActivityRail'
  | 'inbox.groupByRepo'
  | `inbox.sections.${
      | 'review-requested'
      | 'awaiting-author'
      | 'authored-by-me'
      | 'mentioned'
      | 'recently-closed'}`;
```

- [ ] **Step 4: Exclude both from `InboxSectionKey`**

Update the `Exclude<…>` (lines 35-46):

```typescript
type InboxSectionKey = Exclude<
  PreferenceKey,
  | 'theme'
  | 'accent'
  | 'ui.ai.mode'
  | 'ui.ai.providerTimeoutSeconds'
  | 'ui.ai.hunkAnnotationCap'
  | 'density'
  | 'contentScale'
  | 'inbox.defaultSort'
  | 'inbox.sectionOrder'
  | 'inbox.showActivityRail'
  | 'inbox.groupByRepo'
>;
```

- [ ] **Step 5: Add explicit `readKey` / `writeKey` branches BEFORE the fall-through**

In `readKey`, after the `ui.ai.mode` branch (line 51):

```typescript
  if (key === 'ui.ai.mode') return prefs.ui.aiMode;
  if (key === 'ui.ai.providerTimeoutSeconds') return prefs.ui.providerTimeoutSeconds;
  if (key === 'ui.ai.hunkAnnotationCap') return prefs.ui.hunkAnnotationCap;
```

In `writeKey`, after the `ui.ai.mode` branch (line 71):

```typescript
  if (key === 'ui.ai.mode') return { ...prefs, ui: { ...prefs.ui, aiMode: value as AiMode } };
  if (key === 'ui.ai.providerTimeoutSeconds')
    return { ...prefs, ui: { ...prefs.ui, providerTimeoutSeconds: value as number } };
  if (key === 'ui.ai.hunkAnnotationCap')
    return { ...prefs, ui: { ...prefs.ui, hunkAnnotationCap: value as number } };
```

- [ ] **Step 6: Run it to verify it passes**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/contexts/PreferencesContext.aiNumeric.test.tsx`
Expected: PASS (3 cases).

- [ ] **Step 7: Typecheck + format + lint**

Run (from `frontend/`):
```
node ./node_modules/typescript/bin/tsc -b
node ./node_modules/prettier/bin/prettier.cjs --write src/contexts/PreferencesContext.tsx
node ./node_modules/eslint/bin/eslint.js src/contexts/PreferencesContext.tsx
```
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/contexts/PreferencesContext.tsx frontend/src/contexts/PreferencesContext.aiNumeric.test.tsx
git commit -m "feat(ai-settings): wire ui.ai numeric keys through PreferencesContext (#496)"
```

---

## Task 16: `AiPane` — AI mode relocate + two steppers (+ migrate AI-mode tests)

**Files:**
- Create: `frontend/src/components/Settings/panes/AiPane.tsx`
- Create: `frontend/src/components/Settings/panes/AiPane.test.tsx` (migrate the ~13 AI-mode cases from `AppearancePane.test.tsx`)
- Reference: `frontend/src/components/Settings/panes/AppearancePane.tsx` (the verbatim AI-mode source)

- [ ] **Step 1: Create `AiPane.test.tsx` (migrated AI-mode cases + new stepper cases)**

Create `frontend/src/components/Settings/panes/AiPane.test.tsx`. Move the AI-mode cases (the radiogroup render, the Live two-phase commit cases B/C/D, already-consented short-circuit, no-advance-while-pending, Accept focus-to-Live, Decline focus-restore, abort-on-downgrade) AND the `vi.hoisted` prefs harness + `aiConsent` mock from `AppearancePane.test.tsx` into this file, retargeting the component to `AiPane`. Extend the mocked `usePreferences` to include the new fields + a `set` that resolves the snapshot. Add stepper cases:

```typescript
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiPane } from './AiPane';
import * as consentApi from '../../../api/aiConsent';
import type { EgressDisclosure } from '../../../api/aiConsent';

const set = vi.fn().mockResolvedValue(undefined);
const prefs = vi.hoisted(() => ({
  aiMode: 'off' as 'off' | 'preview' | 'live',
  providerTimeoutSeconds: 240,
  hunkAnnotationCap: 10,
}));
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: {
        theme: 'dark',
        accent: 'indigo',
        density: 'comfortable',
        contentScale: 'm',
        aiMode: prefs.aiMode,
        providerTimeoutSeconds: prefs.providerTimeoutSeconds,
        hunkAnnotationCap: prefs.hunkAnnotationCap,
      },
      inbox: { sections: {} },
      github: {},
    },
    set,
  }),
}));
vi.mock('../../../api/aiConsent');

const disclosure = (alreadyConsented: boolean): EgressDisclosure => ({
  recipient: 'Anthropic, via the Claude Code CLI',
  dataCategories: ['Pull request diff', 'Title', 'Description'],
  disclosureVersion: '1',
  alreadyConsented,
});

beforeEach(() => {
  set.mockClear();
  prefs.aiMode = 'off';
  prefs.providerTimeoutSeconds = 240;
  prefs.hunkAnnotationCap = 10;
  vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
  vi.mocked(consentApi.postAiConsent).mockResolvedValue();
});

describe('AiPane', () => {
  it('renders the AI mode control', () => {
    render(<AiPane />);
    expect(screen.getByRole('radiogroup', { name: 'AI mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Live' })).toBeInTheDocument();
  });

  it('writes ui.ai.mode on selecting Preview', async () => {
    render(<AiPane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'preview'));
  });

  // ... migrate the remaining AI-mode cases verbatim (B/C/D, no-advance-while-pending,
  // Accept focus-to-Live, Decline focus-restore, abort-on-downgrade) ...

  it('renders the provider-timeout stepper and writes on step', async () => {
    render(<AiPane />);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    sb.focus();
    await userEvent.keyboard('{ArrowUp}'); // 240 -> 270
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.providerTimeoutSeconds', 270));
  });

  it('renders the hunk-annotation-cap stepper and writes on step', async () => {
    render(<AiPane />);
    const sb = screen.getByRole('spinbutton', { name: 'Annotation cap' });
    sb.focus();
    await userEvent.keyboard('{ArrowUp}'); // 10 -> 11
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.hunkAnnotationCap', 11));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/Settings/panes/AiPane.test.tsx`
Expected: FAIL to resolve `./AiPane`.

- [ ] **Step 3: Implement `AiPane`**

Create `frontend/src/components/Settings/panes/AiPane.tsx`. Transplant the AI-mode logic verbatim from `AppearancePane.tsx` (the `AI_MODES`/`AI_MODE_LABELS` constants, the `aiGroupRef`/`focusTargetRef`/`abortRef`/`pendingLive`/`modalOpen` state, the `modalOpen`-keyed focus-restoration effect, the unmount `abortRef.abort()` cleanup, `onAiMode`/`onModalAccept`/`onModalDecline`, and the `EgressConsentModal`), then add the two steppers:

```tsx
import { useEffect, useRef, useState } from 'react';
import { usePreferences } from '../../../hooks/usePreferences';
import type { AiMode } from '../../../api/types';
import { SegmentedControl } from '../../controls/SegmentedControl';
import { NumberStepper } from '../../controls/NumberStepper';
import { getEgressDisclosure } from '../../../api/aiConsent';
import { EgressConsentModal } from '../EgressConsentModal';
import pane from './Pane.module.css';

const AI_MODES = [
  { value: 'off' as AiMode, label: 'Off' },
  { value: 'preview' as AiMode, label: 'Preview' },
  { value: 'live' as AiMode, label: 'Live' },
];
const AI_MODE_LABELS: Record<AiMode, string> = { off: 'Off', preview: 'Preview', live: 'Live' };

export function AiPane() {
  const { preferences, set } = usePreferences();
  const aiGroupRef = useRef<HTMLDivElement | null>(null);
  const focusTargetRef = useRef<AiMode | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [pendingLive, setPendingLive] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Move focus to the intended segment once the modal closes (parent effect wins over the Modal's
  // own focus-restoration; keyed on modalOpen). Transplanted verbatim from AppearancePane.
  useEffect(() => {
    if (modalOpen) return;
    const target = focusTargetRef.current;
    if (!target) return;
    focusTargetRef.current = null;
    const label = AI_MODE_LABELS[target];
    const radios = aiGroupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.forEach((r) => {
      if (r.textContent === label) r.focus();
    });
  }, [modalOpen]);

  // Abort any in-flight Live disclosure fetch on unmount (existing guard).
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!preferences) return null;

  const resolvedMode: AiMode = preferences.ui.aiMode;

  const onAiMode = (next: AiMode) => {
    if (next === resolvedMode && !pendingLive) return;
    if (next !== 'live') {
      abortRef.current?.abort();
      setPendingLive(false);
      setModalOpen(false);
      void set('ui.ai.mode', next).catch(() => {});
      return;
    }
    setPendingLive(true);
    const ac = new AbortController();
    abortRef.current = ac;
    getEgressDisclosure(ac.signal)
      .then((d) => {
        if (ac.signal.aborted) return;
        if (d.alreadyConsented) {
          setPendingLive(false);
          void set('ui.ai.mode', 'live').catch(() => {});
        } else {
          setModalOpen(true);
        }
      })
      .catch(() => {
        if (!ac.signal.aborted) setPendingLive(false);
      });
  };

  const onModalAccept = () => {
    setModalOpen(false);
    setPendingLive(false);
    focusTargetRef.current = 'live';
    void set('ui.ai.mode', 'live').catch(() => {});
  };
  const onModalDecline = () => {
    setModalOpen(false);
    setPendingLive(false);
    focusTargetRef.current = resolvedMode;
  };

  return (
    <section aria-labelledby="ai-heading">
      <div className={pane.head}>
        <div>
          <h2 id="ai-heading" className={pane.title}>
            AI
          </h2>
          <p className={pane.sub}>AI mode, provider timeout, and annotation settings.</p>
        </div>
      </div>

      <div className={pane.row}>
        <div>
          <div className={pane.label}>AI mode</div>
          <div className={pane.help} id="ai-mode-help">
            Off · no AI. Preview · sample output, clearly labeled. Live · real AI, sends PR content to
            the provider.
          </div>
        </div>
        <div className={pane.spring} ref={aiGroupRef}>
          <SegmentedControl
            label="AI mode"
            describedById="ai-mode-help"
            options={AI_MODES}
            value={resolvedMode}
            onChange={onAiMode}
          />
        </div>
      </div>

      <div className={pane.row}>
        <div>
          <div className={pane.label} id="ai-timeout-label">Provider timeout</div>
          <div className={pane.help}>30–600 seconds. Applies to the next AI request — no restart.</div>
        </div>
        <div className={pane.spring}>
          <NumberStepper
            label="Provider timeout"
            labelledById="ai-timeout-label"
            value={preferences.ui.providerTimeoutSeconds}
            min={30}
            max={600}
            step={30}
            unit="seconds"
            onChange={(n) => void set('ui.ai.providerTimeoutSeconds', n).catch(() => {})}
          />
        </div>
      </div>

      <div className={pane.row}>
        <div>
          <div className={pane.label} id="ai-cap-label">Annotation cap</div>
          <div className={pane.help}>1–50 hunk annotations per PR. Higher values cost more and add latency.</div>
        </div>
        <div className={pane.spring}>
          <NumberStepper
            label="Annotation cap"
            labelledById="ai-cap-label"
            value={preferences.ui.hunkAnnotationCap}
            min={1}
            max={50}
            step={1}
            unit="annotations"
            onChange={(n) => void set('ui.ai.hunkAnnotationCap', n).catch(() => {})}
          />
        </div>
      </div>

      <EgressConsentModal open={modalOpen} onAccept={onModalAccept} onDecline={onModalDecline} />
    </section>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/Settings/panes/AiPane.test.tsx`
Expected: PASS (all migrated AI-mode cases + 2 stepper cases).

- [ ] **Step 5: Format + lint + typecheck**

Run (from `frontend/`):
```
node ./node_modules/prettier/bin/prettier.cjs --write src/components/Settings/panes/AiPane.tsx src/components/Settings/panes/AiPane.test.tsx
node ./node_modules/eslint/bin/eslint.js src/components/Settings/panes/AiPane.tsx src/components/Settings/panes/AiPane.test.tsx
node ./node_modules/typescript/bin/tsc -b
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Settings/panes/AiPane.tsx frontend/src/components/Settings/panes/AiPane.test.tsx
git commit -m "feat(ai-settings): add AiPane with AI mode + timeout + cap steppers (#496)"
```

---

## Task 17: Remove AI mode from `AppearancePane`

**Files:**
- Modify: `frontend/src/components/Settings/panes/AppearancePane.tsx`
- Modify: `frontend/src/components/Settings/panes/AppearancePane.test.tsx`

- [ ] **Step 1: Update the AppearancePane test (drop AI-mode, assert removed)**

In `frontend/src/components/Settings/panes/AppearancePane.test.tsx`:
- Remove the `aiConsent` mock (lines 5-6, 26, 28-33, 38-39) and all AI-mode cases (the `ui.ai.mode`, Live two-phase, focus, abort cases).
- Update the first render test to assert the AI-mode group is GONE, and drop `aiMode` from the mocked prefs `ui` (the pane no longer reads it).

```typescript
  it('renders theme/accent/density controls and NOT the AI-mode control', () => {
    render(<AppearancePane />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Content font size' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'AI mode' })).toBeNull();
  });
```

Keep the contentScale tests (write + rollback) unchanged.

- [ ] **Step 2: Run it to verify it fails**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/Settings/panes/AppearancePane.test.tsx`
Expected: FAIL — the AI-mode group still renders, so `queryByRole('radiogroup', { name: 'AI mode' })` is non-null.

- [ ] **Step 3: Strip the AI-mode section from `AppearancePane.tsx`**

Remove, in `frontend/src/components/Settings/panes/AppearancePane.tsx`:
- The `AI_MODES` / `AI_MODE_LABELS` constants (lines 16-21).
- The `getEgressDisclosure` + `EgressConsentModal` imports (lines 12-13).
- `aiGroupRef`, `focusTargetRef`, `abortRef`, `pendingLive`, `modalOpen` state (lines 37-45).
- The `modalOpen`-keyed focus effect (lines 47-61) and the `abortRef` unmount effect (lines 63-66).
- `resolvedMode`, `onAiMode`, `onModalAccept`, `onModalDecline` (lines 99-154).
- The AI-mode `<div className={pane.row}>…</div>` block (lines 212-231) and the `<EgressConsentModal … />` (line 232).

Update the subtitle (line 163) to drop AI mode:

```tsx
          <p className={pane.sub}>Theme, accent color, density, and content size</p>
```

The trimmed pane keeps `useEffect` import only if still used — after removal, `AppearancePane` no longer needs `useEffect`/`useRef`/`useState`. Update the React import to what remains (likely none from `react`; the handlers use `usePreferences` + the apply helpers). Let tsc/eslint flag unused imports and remove them.

- [ ] **Step 4: Run it to verify it passes**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/Settings/panes/AppearancePane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Format + lint + typecheck (unused-import gate)**

Run (from `frontend/`):
```
node ./node_modules/prettier/bin/prettier.cjs --write src/components/Settings/panes/AppearancePane.tsx src/components/Settings/panes/AppearancePane.test.tsx
node ./node_modules/eslint/bin/eslint.js src/components/Settings/panes/AppearancePane.tsx src/components/Settings/panes/AppearancePane.test.tsx
node ./node_modules/typescript/bin/tsc -b
```
Expected: clean (no unused `useEffect`/`useRef`/`useState`/`getEgressDisclosure`/`EgressConsentModal`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Settings/panes/AppearancePane.tsx frontend/src/components/Settings/panes/AppearancePane.test.tsx
git commit -m "refactor(ai-settings): move AI mode out of AppearancePane into AiPane (#496)"
```

---

## Task 18: Add the AI tab to nav + routes

**Files:**
- Modify: `frontend/src/components/Settings/SettingsNav.tsx`
- Modify: `frontend/src/components/Settings/SettingsModalRoutes.tsx`
- Test: `frontend/src/components/Settings/SettingsModalRoutes.test.tsx` (extend if present; otherwise add a focused test)

- [ ] **Step 1: Write the failing test**

Add to (or create) `frontend/src/components/Settings/SettingsModalRoutes.test.tsx` a test that navigating to `/settings/ai` renders the AI pane heading. Follow the existing routes test harness (it renders `SettingsModalRoutes` inside a `MemoryRouter` with `isAuthed`); read it first and mirror its setup + any required provider mocks (PreferencesProvider, etc.).

```typescript
  it('renders the AI pane at /settings/ai', async () => {
    renderRoutes({ isAuthed: true, initialEntries: ['/settings/ai'] });
    expect(await screen.findByRole('heading', { name: 'AI' })).toBeInTheDocument();
  });
```

> `renderRoutes` is the existing helper in that test file; if there isn't one, render `<MemoryRouter initialEntries={['/settings/ai']}><SettingsModalRoutes isAuthed unauthedTarget="/setup" /></MemoryRouter>` with the same provider wrappers the sibling tests use.

- [ ] **Step 2: Run it to verify it fails**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/Settings/SettingsModalRoutes.test.tsx`
Expected: FAIL — `/settings/ai` hits the catch-all `<Navigate to="/settings/appearance">`, so the heading is "Appearance", not "AI".

- [ ] **Step 3: Add the nav item**

In `frontend/src/components/Settings/SettingsNav.tsx`, add the AI entry to `PRIMARY` (after Appearance — see the spec's open question on final placement, defaulting to after Appearance):

```typescript
const PRIMARY: NavItem[] = [
  { section: 'appearance', label: 'Appearance' },
  // TODO(#496 visual-review): final AI-tab position is unresolved (spec §Open Questions —
  // display-preference-adjacent vs feature-config-at-end). Defaulting to after Appearance.
  { section: 'ai', label: 'AI' },
  { section: 'inbox', label: 'Inbox' },
  { section: 'github-connection', label: 'GitHub Connection' },
];
```

- [ ] **Step 4: Add the route**

In `frontend/src/components/Settings/SettingsModalRoutes.tsx`, import `AiPane` and add the route (before the catch-all):

```typescript
import { AppearancePane } from './panes/AppearancePane';
import { AiPane } from './panes/AiPane';
```

```tsx
        <Route path="appearance" element={<AppearancePane />} />
        <Route path="ai" element={<AiPane />} />
        <Route path="inbox" element={<InboxPane />} />
```

- [ ] **Step 5: Run it to verify it passes**

Run (from `frontend/`): `node ./node_modules/vitest/vitest.mjs run src/components/Settings/SettingsModalRoutes.test.tsx`
Expected: PASS.

- [ ] **Step 6: Format + lint + typecheck**

Run (from `frontend/`):
```
node ./node_modules/prettier/bin/prettier.cjs --write src/components/Settings/SettingsNav.tsx src/components/Settings/SettingsModalRoutes.tsx src/components/Settings/SettingsModalRoutes.test.tsx
node ./node_modules/eslint/bin/eslint.js src/components/Settings/SettingsNav.tsx src/components/Settings/SettingsModalRoutes.tsx
node ./node_modules/typescript/bin/tsc -b
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Settings/SettingsNav.tsx frontend/src/components/Settings/SettingsModalRoutes.tsx frontend/src/components/Settings/SettingsModalRoutes.test.tsx
git commit -m "feat(ai-settings): add AI tab to settings nav + routes (#496)"
```

---

## Task 19: e2e + visual baselines

**Files:**
- Create/modify: an e2e spec under `frontend/e2e/` (match the existing settings e2e file naming/harness — read a sibling spec first)
- Visual baselines: regenerate via the CI artifact workflow (do NOT hand-author Linux baselines locally — they are taken in CI; see the project's e2e baseline process)

- [ ] **Step 1: Add the e2e scenarios**

In a new or existing settings e2e spec, add:

1. **Tab + persistence:** open Settings → click the AI nav item → assert the AI pane renders (heading "AI", the two spinbuttons) → step the provider-timeout stepper up → reload the page → reopen Settings → AI tab → assert the stepper shows the new value (persisted through the backend config).
2. **Timeout toast deep-link:** force a seam 503 with `{ reason: 'timeout' }` (use the e2e fake-review backend's seam-failure hook, mirroring the #484 e2e setup) on a PR view → assert the toast shows "Adjust timeout" → click it → assert the URL is `/settings/ai` AND the PR is still mounted behind the modal (the PR DOM is present, not torn down to the Inbox).

> Read the #484 AI-failure e2e spec and the existing Settings e2e spec to reuse their fake-review wiring, route helpers, and the `setupBaseRoutes`/preferences scaffolding. Do not invent a new harness.
>
> **Verify the seam-failure injection can emit a 503 BODY before relying on it.** The #484 e2e harness predates Task 9 — its AI-seam failure hook may return a bare 503 with NO body (the pre-Task-9 production behavior). Scenario 2 needs the stub to return `503 { "reason": "timeout" }`. If the fake-review backend's AI-seam stub cannot be configured to emit that body, adding the body to the stub is part of THIS task (or Task 9) — not a "read the spec" deferral. Confirm by reading the fake-review AI-seam stub; if it only sets a status code, extend it to also write the `AiFailureBody` JSON.

- [ ] **Step 2: Run the e2e suite locally (functional pass only)**

Run the repo's e2e command for the new spec (per `.ai/docs/parallel-agent-testing.md` — a private `(port, dataDir)`). Expected: the functional assertions pass. Visual snapshots will MISS on the new AI pane + the changed Appearance pane until baselines are regenerated in CI — that is expected; do not commit local Linux baselines.

- [ ] **Step 3: Capture the visual-baseline TODO for CI**

Record in the PR body (`## Proof`) that new/changed visual baselines are required:
- AI pane (light + dark)
- Appearance pane with the AI-mode section removed (light + dark)

These are regenerated from the CI artifact after the e2e job runs (per the repo baseline process). Do not block the functional commit on them.

- [ ] **Step 4: Commit the e2e spec**

```bash
git add frontend/e2e/
git commit -m "test(ai-settings): e2e for AI tab persistence + timeout deep-link (#496)"
```

---

## Final verification (before /simplify + PR)

- [ ] **Backend full suite:** `dotnet test` (whole solution, foreground, timeout ≥ 300000 ms). Expected: all green.
- [ ] **Frontend full suite:** from `frontend/`, `node ./node_modules/vitest/vitest.mjs run`. Expected: all green.
- [ ] **Typecheck:** from `frontend/`, `node ./node_modules/typescript/bin/tsc -b`. Expected: clean.
- [ ] **Format + lint (whole frontend, real binaries):**
  - `node ./node_modules/prettier/bin/prettier.cjs --check src` (then `--write` if needed)
  - `node ./node_modules/eslint/bin/eslint.js src`
- [ ] **Run the repo pre-push checklist verbatim** (`.ai/docs/development-process.md`) — it mirrors CI.
- [ ] **Run `/simplify`** on the branch diff before opening the PR (quality pass; it edits the tree, so run it before the final verify gate).
- [ ] **Open the PR via `pr-autopilot` (base=V2).** #496/#485 are UI-visual → **gated**: do NOT enable auto-merge; the owner merges. Record every `ce-doc-review`/bot finding's disposition in `## Proof`. The visual baselines (CI-regenerated) and the owner's NVDA/keyboard pass on the AI pane + the relocated consent flow are the human-gate items.

---

## Self-review (plan vs. spec)

**Spec coverage:**
- Goal 1 (AI tab + `/settings/ai`): Tasks 16, 18. ✓
- Goal 2 (configurable, hot-reloaded, clamped timeout): Tasks 1, 2, 3, 5, 7 (+ read-clamp in the Program.cs factory). ✓
- Goal 3 (API-patchable + UI cap, closes #481): Tasks 3, 4, 8, 16. ✓
- Goal 4 (relocate AI mode + consent): Tasks 16, 17. ✓
- Goal 5 (#484 timeout copy + deep-link): Tasks 6, 9, 10-13. ✓
- Validation table (clamp-on-write/read; non-integer & Int32-overflow → 400; missing reason → provider-error): Tasks 3, 4, 8, 9, 11. ✓
- `AiConfigBounds` single-source on write + every read (factory, annotator, GET DTO): Tasks 1, 3, 4, 7, 8. ✓
- Wiring reconciliation (factory overload in PRism.AI.ClaudeCode; closure in Program.cs; 3 instance-overload tests compile): Task 7. ✓
- `LlmProviderException.TimedOut` true only at timeout site: Task 6. ✓
- NumberStepper a11y (spinbutton container, aria-valuetext, keyboard, boundary-disabled, apply-on-success): Task 14. ✓
- PreferenceKey union/Exclude/readKey/writeKey (3 coupled edits): Task 15. ✓
- aiFailure reason prop-chain + anyTimedOut + dismissal-fingerprint excludes reason: Tasks 11, 12 (the existing fingerprint in `aiFailure.tsx` is built from `activeFailedSeams` only — unchanged, so reason is correctly excluded). ✓
- Toast deep-link with `backgroundLocation`; post-adjust copy unchanged (option A, no auto-retry): Task 13. ✓
- Double-Escape parity-only (Modal.tsx out of scope): the consent flow is transplanted verbatim in Task 16; no Modal.tsx change is made. ✓
- draft-suggestions guardrail comment (out of timeout-reason scope): Task 9. ✓
- GET DTO clamped-for-display, with the cap legacy-0 residual ELIMINATED via the shared `AiConfigBounds.ClampCapForRead` used by both the annotator (read) and the DTO (display): Tasks 1, 4, 8. ✓

**Open question (nav placement)** is deferred to visual review; Task 18 defaults to after Appearance per the spec.

**Type consistency:** `AiFailureReason` (`'timeout' | 'provider-error'`), `providerTimeoutSeconds`/`hunkAnnotationCap` (number), `ProviderTimeoutSeconds`/`HunkAnnotationCap` (int), `TimeoutProvider` (`Func<TimeSpan>`), `AiFailureBody(string Reason)`, `AiConfigBounds.ClampTimeout`/`ClampCap` — used consistently across all tasks.

**Placeholder scan:** none — every code step shows the actual code; reviewer/harness-pattern callouts (the few "match the existing test harness" notes) point at concrete sibling files to read, not unspecified work.
