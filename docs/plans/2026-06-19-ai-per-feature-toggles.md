# AI Per-Feature Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user enable/disable individual AI features (summary, file focus, hunk annotations, inbox enrichment) from the AI Settings pane, independently of the global AI mode.

**Architecture:** The backend per-feature enforcement engine already ships on V2 (`AiFeaturesConfig` / `AiFeatureState` / `AiSeamSelector` gate, hot-reload wired). This plan adds the missing plumbing: four `ui.ai.features.*` `ConfigStore` patch keys, a `ui.features` GET projection, a frontend per-flag read (`useCapabilities` masks mode-derived capabilities by the user flags), and the `AiPane` accordion UI with Live-gated progressive disclosure.

**Tech Stack:** .NET 10 (PRism.Core, PRism.Web; xUnit + FluentAssertions), React + Vite + TypeScript (vitest + Testing Library), Playwright (e2e).

**Design spec:** `docs/specs/2026-06-19-ai-per-feature-toggles-design.md` (read it; decisions D1–D7 are referenced by number below).

## Global Constraints

- **Branch base: `origin/V2`** (worktree `feature/536-ai-feature-toggles`). Not `main`. Verify every cited type against the worktree, never `D:\src\PRism`.
- **Live seams = the four settable features:** `summary`, `fileFocus`, `hunkAnnotations`, `inboxEnrichment`. The other five capability keys stay default-on and are NOT user-settable.
- **Wire-path split:** config + POST keys are `ui.ai.features.*`; the GET projection is flat at **`ui.features`** (camelCase object), mirroring `ui.ai.mode`→`ui.aiMode`.
- **Fail-open everywhere:** a missing feature key reads as `true` (backend `AiFeatureState` and every FE read site: `preferences.ui.features?.[k] ?? true`).
- **Defaults all-on** (`AiFeaturesConfig.AllOn`); behavior is unchanged until a user opts a feature off.
- **`set` is apply-on-success, not optimistic.** The only required `PreferencesContext` change for function is extending the `PreferenceKey` union.
- **Backend builds 0-warning** (TreatWarningsAsErrors). Run `dotnet build PRism.sln -c Release` to verify before each backend commit.
- **Frontend toolchain:** run vitest via the local binary from `frontend/` (`node_modules/.bin/vitest run <file>` — never `npx vitest`). Before staging FE files, `node_modules/.bin/prettier --write` them and `node_modules/.bin/eslint .`. Typecheck with `node_modules/.bin/tsc -b` (not `--noEmit`). The worktree needs `npm ci` in `frontend/` before FE tests run.
- **Per-row Switch help copy (verbatim):** Summary — "When off, the AI summary card is hidden on pull requests." File focus — "When off, AI file hotspots are not shown in the Files tab." Hunk annotations — "When off, inline AI annotations are not added to diffs." Inbox enrichment — "When off, the AI kind-of-change chip is removed from inbox rows."
- **Preview disabled-button hint (verbatim):** any feature off → "Some AI features are turned off. Switch to Live to change them."; else → "Switch to Live to turn individual features on or off."

---

### Task 1: `AiFeaturesConfig.With(key, value)` immutable single-key updater

**Files:**
- Modify: `PRism.Core/Config/AiFeaturesConfig.cs`
- Test: `tests/PRism.Core.Tests/Config/AiFeaturesConfigTests.cs` (create if absent)

**Interfaces:**
- Produces: `AiFeaturesConfig AiFeaturesConfig.With(string key, bool value)` — returns a new config with `key` set to `value`, all other keys preserved, backed by a fresh `FrozenDictionary` built with `StringComparer.Ordinal`.

- [ ] **Step 1: Write the failing test**

```csharp
using System.Collections.Generic;
using FluentAssertions;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public class AiFeaturesConfigTests
{
    [Fact]
    public void With_updates_one_key_and_preserves_the_rest()
    {
        var updated = AiFeaturesConfig.AllOn.With("summary", false);

        updated.Enabled["summary"].Should().BeFalse();
        updated.Enabled["fileFocus"].Should().BeTrue();
        updated.Enabled["inboxEnrichment"].Should().BeTrue();
        updated.Enabled.Count.Should().Be(AiFeaturesConfig.AllOn.Enabled.Count);
    }

    [Fact]
    public void With_does_not_mutate_the_source()
    {
        var source = AiFeaturesConfig.AllOn;
        _ = source.With("summary", false);
        source.Enabled["summary"].Should().BeTrue();
    }

    [Fact]
    public void With_uses_ordinal_comparer_so_casing_is_distinct()
    {
        var updated = AiFeaturesConfig.AllOn.With("summary", false);
        // Ordinal: "Summary" is a different key, so the original lower-case stays false-set
        // and the differently-cased lookup misses (would throw KeyNotFound on indexer).
        updated.Enabled.ContainsKey("Summary").Should().BeFalse();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~AiFeaturesConfigTests"`
Expected: FAIL — `AiFeaturesConfig` has no `With` method (compile error).

- [ ] **Step 3: Add the `With` method**

Append inside the `AiFeaturesConfig` record body in `PRism.Core/Config/AiFeaturesConfig.cs`:

```csharp
    /// <summary>Returns a new config with <paramref name="key"/> set to <paramref name="value"/>,
    /// all other keys preserved. Rebuilds the frozen dict with <see cref="StringComparer.Ordinal"/>
    /// (matching the stored comparer) so a casing drift cannot silently no-op the update.</summary>
    public AiFeaturesConfig With(string key, bool value)
    {
        var next = new Dictionary<string, bool>(Enabled, StringComparer.Ordinal) { [key] = value };
        return new AiFeaturesConfig(next.ToFrozenDictionary(StringComparer.Ordinal));
    }
```

Ensure the file has `using System;` and `using System.Collections.Generic;` (in addition to the existing `using System.Collections.Frozen;`).

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~AiFeaturesConfigTests"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/AiFeaturesConfig.cs tests/PRism.Core.Tests/Config/AiFeaturesConfigTests.cs
git commit -m "feat(ai): AiFeaturesConfig.With single-key updater (#536)"
```

---

### Task 2: `ConfigStore` allowlist + four exact patch arms for `ui.ai.features.*`

**Files:**
- Modify: `PRism.Core/Config/ConfigStore.cs` (allowlist dict ~line 33-65; patch `key switch` ~line 223-258)
- Test: `tests/PRism.Core.Tests/Config/ConfigStoreFeatureToggleTests.cs` (create)

**Interfaces:**
- Consumes: `AiFeaturesConfig.With` (Task 1).
- Produces: POST-settable keys `ui.ai.features.{summary,fileFocus,hunkAnnotations,inboxEnrichment}` (Bool) that update `_current.Ui.Ai.Features` and persist; any other `ui.ai.features.*` rejected with `ConfigPatchException`.

- [ ] **Step 1: Write the failing test**

```csharp
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;   // TempDataDir — confirm the namespace from a neighbor's usings
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStoreFeatureToggleTests
{
    [Fact]
    public async Task Patch_summary_feature_off_updates_config()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.features.summary"] = false }, CancellationToken.None);

        store.Current.Ui.Ai.Features.Enabled["summary"].Should().BeFalse();
        store.Current.Ui.Ai.Features.Enabled["fileFocus"].Should().BeTrue();
    }

    [Fact]
    public async Task Patch_unsettable_feature_key_is_rejected()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        var act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["ui.ai.features.inboxRanking"] = false }, CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>();
    }
}
```

> Note: this mirrors `ConfigStoreHunkAnnotationCapTests` verbatim — `new ConfigStore(dir.Path)` then `await store.InitAsync(CancellationToken.None)` (there is NO `CreateForTests` factory). Confirm the `TempDataDir` namespace and that `ConfigStore`/`TempDataDir` are `IDisposable` from that neighbor's `using`s before copying.

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ConfigStoreFeatureToggleTests"`
Expected: FAIL — `ui.ai.features.summary` hits the allowlist's "unknown field" rejection.

- [ ] **Step 3: Add the four allowlist entries**

In `PRism.Core/Config/ConfigStore.cs`, inside the `_allowedFields` initializer (after the `ui.ai.summaryMaxChars` line):

```csharp
            ["ui.ai.features.summary"]           = ConfigFieldType.Bool,
            ["ui.ai.features.fileFocus"]         = ConfigFieldType.Bool,
            ["ui.ai.features.hunkAnnotations"]   = ConfigFieldType.Bool,
            ["ui.ai.features.inboxEnrichment"]   = ConfigFieldType.Bool,
```

- [ ] **Step 4: Add the four exact patch arms**

In the `key switch` in `PatchAsync` (after the `"ui.ai.summaryMaxChars"` arm, before the `_ => throw` default):

```csharp
                "ui.ai.features.summary" =>
                    _current with { Ui = ui with { Ai = ui.Ai with { Features = ui.Ai.Features.With("summary", (bool)value!) } } },
                "ui.ai.features.fileFocus" =>
                    _current with { Ui = ui with { Ai = ui.Ai with { Features = ui.Ai.Features.With("fileFocus", (bool)value!) } } },
                "ui.ai.features.hunkAnnotations" =>
                    _current with { Ui = ui with { Ai = ui.Ai with { Features = ui.Ai.Features.With("hunkAnnotations", (bool)value!) } } },
                "ui.ai.features.inboxEnrichment" =>
                    _current with { Ui = ui with { Ai = ui.Ai with { Features = ui.Ai.Features.With("inboxEnrichment", (bool)value!) } } },
```

(`ui.ai.features.inboxRanking` and the other dormant keys are absent from the allowlist, so they are rejected at the type-validation step before the switch — no arm needed.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ConfigStoreFeatureToggleTests"`
Expected: PASS (2 tests).

- [ ] **Step 6: Verify the build is 0-warning, then commit**

Run: `dotnet build PRism.sln -c Release` → 0 warnings.

```bash
git add PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Config/ConfigStoreFeatureToggleTests.cs
git commit -m "feat(ai): ConfigStore patch keys for ui.ai.features.* (#536)"
```

---

### Task 3: Hot-mirror round-trip + `ui.features` GET projection

**Files:**
- Create: `PRism.Web/Endpoints/` → add `AiFeaturesDto` to `PRism.Web/Endpoints/PreferencesDtos.cs`
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs` (`UiPreferencesDto`), `PRism.Web/Endpoints/PreferencesEndpoints.cs` (`BuildResponse`)
- Test: `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` (add cases), `tests/PRism.Core.Tests/Ai/AiFeatureStateHotReloadTests.cs` (create)

**Interfaces:**
- Consumes: Task 2 patch keys.
- Produces: GET `/api/preferences` → `ui.features: { summary, fileFocus, hunkAnnotations, preSubmitValidators, composerAssist, draftSuggestions, draftReconciliation, inboxEnrichment, inboxRanking }` (all bool, default true).

- [ ] **Step 1: Write the failing hot-mirror test (Core)**

```csharp
using System.Collections.Generic;
using System.Threading;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Ai;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Ai;

public class AiFeatureStateHotReloadTests
{
    [Fact]
    public async Task Patching_a_feature_off_flips_the_runtime_AiFeatureState()
    {
        var dir = Directory.CreateTempSubdirectory("prism-feat-").FullName;
        var services = new ServiceCollection().AddPrismCore(dir).BuildServiceProvider();
        var config = services.GetRequiredService<IConfigStore>();
        var state = services.GetRequiredService<AiFeatureState>();

        state.IsEnabled("summary").Should().BeTrue();
        await config.PatchAsync(new Dictionary<string, object?> { ["ui.ai.features.summary"] = false }, CancellationToken.None);
        state.IsEnabled("summary").Should().BeFalse();
    }
}
```

> `AddPrismCore(dir)` is correct as-is — the signature is `AddPrismCore(string dataDir, bool useUnprotectedTokenCache = false)`, so the second arg defaults. Resolving `AiFeatureState` needs neither `AddPrismGitHub` nor `AddPrismAi`: its DI factory only depends on `IConfigStore` (`ServiceCollectionExtensions.cs:69-75`). (Do NOT look to `AiStateHolderSeedTests` for a DI pattern — it constructs `new AiFeatureState(AiFeaturesConfig.AllOn)` directly, no `ServiceCollection`.)

- [ ] **Step 2: Run it — expect PASS already (verifies the existing wiring), or FAIL if seam isn't reachable**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~AiFeatureStateHotReloadTests"`
Expected: PASS — `ServiceCollectionExtensions.cs:73` already subscribes `state.Set` to `Changed`. (This test pins that the Task-2 patch path drives the mirror; keep it as a regression guard.)

- [ ] **Step 3: Write the failing GET-projection test (Web)**

Add to `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` (mirror the existing `aiMode` projection tests in that file):

```csharp
[Fact]
public async Task Get_preferences_projects_all_nine_features_default_true()
{
    using var factory = new PRismWebApplicationFactory();   // the real factory name in this file (capital R)
    var client = factory.CreateClient();

    var body = await client.GetFromJsonAsync<JsonElement>("/api/preferences");
    var features = body.GetProperty("ui").GetProperty("features");

    features.GetProperty("summary").GetBoolean().Should().BeTrue();
    features.GetProperty("fileFocus").GetBoolean().Should().BeTrue();
    features.GetProperty("inboxRanking").GetBoolean().Should().BeTrue();
    features.EnumerateObject().Count().Should().Be(9);
}

[Fact]
public async Task Post_feature_off_round_trips_through_get()
{
    using var factory = new PrismWebFactory();
    var client = factory.CreateClient();

    var resp = await client.PostAsJsonAsync("/api/preferences",
        new Dictionary<string, object> { ["ui.ai.features.summary"] = false });
    resp.EnsureSuccessStatusCode();

    var body = await client.GetFromJsonAsync<JsonElement>("/api/preferences");
    body.GetProperty("ui").GetProperty("features").GetProperty("summary").GetBoolean().Should().BeFalse();
}
```

> Use the exact factory + JSON helpers already imported in `PreferencesEndpointsTests.cs` (it already constructs the factory and reads `ui.aiMode`).

- [ ] **Step 4: Run it to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~PreferencesEndpointsTests"`
Expected: FAIL — `ui.features` is absent.

- [ ] **Step 5: Add `AiFeaturesDto` and wire it into the DTO + `BuildResponse`**

In `PRism.Web/Endpoints/PreferencesDtos.cs`, add the record (camelCase serializes natively — no `[JsonPropertyName]`):

```csharp
internal sealed record AiFeaturesDto(
    bool Summary, bool FileFocus, bool HunkAnnotations, bool PreSubmitValidators,
    bool ComposerAssist, bool DraftSuggestions, bool DraftReconciliation,
    bool InboxEnrichment, bool InboxRanking);
```

Append `AiFeaturesDto Features` to `UiPreferencesDto`:

```csharp
internal sealed record UiPreferencesDto(
    string Theme, string Accent, bool AiPreview, string AiMode, string Density, string ContentScale,
    int ProviderTimeoutSeconds, int HunkAnnotationCap, int SummaryMaxChars, AiFeaturesDto Features);
```

In `PRism.Web/Endpoints/PreferencesEndpoints.cs` `BuildResponse`, just before constructing `UiPreferencesDto` add a fail-open local, then pass `Features`:

```csharp
        var feat = ui.Ai.Features.Enabled;
        bool On(string k) => !feat.TryGetValue(k, out var v) || v;   // fail-open: missing → true
```

Add as the final `UiPreferencesDto` argument (after `SummaryMaxChars: …`):

```csharp
                    Features: new AiFeaturesDto(
                        Summary:             On("summary"),
                        FileFocus:           On("fileFocus"),
                        HunkAnnotations:     On("hunkAnnotations"),
                        PreSubmitValidators: On("preSubmitValidators"),
                        ComposerAssist:      On("composerAssist"),
                        DraftSuggestions:    On("draftSuggestions"),
                        DraftReconciliation: On("draftReconciliation"),
                        InboxEnrichment:     On("inboxEnrichment"),
                        InboxRanking:        On("inboxRanking"))),
```

> `UiPreferencesDto` is positional — grep `new UiPreferencesDto(` across the test projects and update any direct constructions to pass the new `Features` arg (likely none outside `BuildResponse`, but verify).

- [ ] **Step 6: Run tests to verify they pass**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~PreferencesEndpointsTests"`
Expected: PASS.

- [ ] **Step 7: Verify the build is 0-warning, then commit**

Run: `dotnet build PRism.sln -c Release` → 0 warnings.

```bash
git add PRism.Web/Endpoints/PreferencesDtos.cs PRism.Web/Endpoints/PreferencesEndpoints.cs tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs tests/PRism.Core.Tests/Ai/AiFeatureStateHotReloadTests.cs
git commit -m "feat(ai): project ui.features on GET /api/preferences (#536)"
```

---

### Task 4: Frontend `AiFeatures` type + `UiPreferences.features` + shared key constant

**Files:**
- Modify: `frontend/src/api/types.ts`

**Interfaces:**
- Produces: `export interface AiFeatures { … nine booleans … }`; `UiPreferences.features: AiFeatures`; `export const AI_FEATURE_KEYS = [...] as const` (nine names).

- [ ] **Step 1: Add the type, the field, and the shared constant**

In `frontend/src/api/types.ts`, after the `AiCapabilities` interface, add:

```typescript
// Per-feature user-enablement flags (#536). Structurally identical to AiCapabilities
// but a distinct concept: `features` = what the user turned on/off; `capabilities` =
// what the AI mode makes available. The gate is capability && feature-enabled.
export interface AiFeatures {
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

export const AI_FEATURE_KEYS = [
  'summary', 'fileFocus', 'hunkAnnotations', 'preSubmitValidators', 'composerAssist',
  'draftSuggestions', 'draftReconciliation', 'inboxEnrichment', 'inboxRanking',
] as const satisfies readonly (keyof AiFeatures)[];
```

Add `features` to `UiPreferences`:

```typescript
export interface UiPreferences {
  // …existing fields…
  features: AiFeatures;
}
```

- [ ] **Step 2: Typecheck**

Run (from `frontend/`): `node_modules/.bin/tsc -b`
Expected: errors ONLY where existing fixtures construct `UiPreferences` without `features` — those are fixed in Tasks 7/8 (Task 5 adds type support only; it does not touch fixtures). If `tsc -b` is clean (fixtures use partials), proceed.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(ai): AiFeatures type + ui.features wire field (#536)"
```

---

### Task 5: `PreferenceKey` union + type-hygiene (`InboxSectionKey`, `readKey`/`writeKey`)

**Files:**
- Modify: `frontend/src/contexts/PreferencesContext.tsx`
- Test: `frontend/src/contexts/PreferencesContext.test.tsx` (add cases if the file exists; else fold the read/write assertions into Task 6's test)

**Interfaces:**
- Consumes: `AiFeatures` (Task 4).
- Produces: `set('ui.ai.features.<seam>', boolean)` type-checks; `readKey`/`writeKey` handle the four keys (test-only helpers, kept consistent).

- [ ] **Step 1: Extend the `PreferenceKey` union**

In `frontend/src/contexts/PreferencesContext.tsx`, add to the `PreferenceKey` union (after `'ui.ai.summaryMaxChars'`):

```typescript
  | `ui.ai.features.${'summary' | 'fileFocus' | 'hunkAnnotations' | 'inboxEnrichment'}`
```

Add the same line to the `Exclude<PreferenceKey, …>` list in `InboxSectionKey` so the new keys stay out of the inbox-section bucket.

- [ ] **Step 2: Add `readKey`/`writeKey` branches (type-hygiene)**

In `readKey`, before the `inbox.sections.` slice fallthrough:

```typescript
  if (key.startsWith('ui.ai.features.'))
    return prefs.ui.features?.[key.slice('ui.ai.features.'.length) as keyof PreferencesResponse['ui']['features']];
```

In `writeKey`, before the `inbox.sections.` slice fallthrough:

```typescript
  if (key.startsWith('ui.ai.features.')) {
    const seam = key.slice('ui.ai.features.'.length) as keyof PreferencesResponse['ui']['features'];
    return { ...prefs, ui: { ...prefs.ui, features: { ...prefs.ui.features, [seam]: value as boolean } } };
  }
```

- [ ] **Step 3: Typecheck**

Run (from `frontend/`): `node_modules/.bin/tsc -b`
Expected: PASS (the `set` call sites in Task 7 will now type-check).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/contexts/PreferencesContext.tsx
git commit -m "feat(ai): PreferenceKey union for ui.ai.features.* (#536)"
```

---

### Task 6: `useCapabilities` masks capabilities by the user feature flags

**Files:**
- Modify: `frontend/src/hooks/useCapabilities.ts`
- Test: `frontend/src/hooks/useCapabilities.test.ts` (add cases; mirror its existing mode-derivation tests)

**Interfaces:**
- Consumes: `UiPreferences.features` (Task 4).
- Produces: a capability is on only when `base[k] && (features?.[k] ?? true)`.

> The current `useCapabilities.ts` exports only the hook (no pure helper) and derives from `usePreferences()` internally. Rather than wrestle `renderHook`, **extract a pure `deriveCapabilities(aiMode, features)` helper** and test it directly; the hook then calls it.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/hooks/useCapabilities.test.ts`:

```typescript
import { deriveCapabilities } from './useCapabilities';
import type { AiFeatures } from '../api/types';

const allOn: AiFeatures = {
  summary: true, fileFocus: true, hunkAnnotations: true, preSubmitValidators: true,
  composerAssist: true, draftSuggestions: true, draftReconciliation: true,
  inboxEnrichment: true, inboxRanking: true,
};

it('masks a disabled feature off in Live', () => {
  const caps = deriveCapabilities('live', { ...allOn, summary: false });
  expect(caps?.summary).toBe(false);
  expect(caps?.hunkAnnotations).toBe(true); // unaffected
});

it('masks a disabled feature off in Preview', () => {
  const caps = deriveCapabilities('preview', { ...allOn, fileFocus: false });
  expect(caps?.fileFocus).toBe(false);
});

it('fails open when features is undefined', () => {
  const caps = deriveCapabilities('live', undefined);
  expect(caps?.summary).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `frontend/`): `node_modules/.bin/vitest run src/hooks/useCapabilities.test.ts`
Expected: FAIL — `deriveCapabilities` is not exported yet.

- [ ] **Step 3: Extract the pure helper and mask by features**

In `frontend/src/hooks/useCapabilities.ts`, add the exported helper (it folds the existing `ALL_OFF`/`LIVE_CAPABILITIES`/`ALL_ON` selection plus the new mask) and have the hook call it:

```typescript
import type { AiCapabilities, AiFeatures, AiMode } from '../api/types';

export function deriveCapabilities(
  aiMode: AiMode | undefined,
  features: AiFeatures | undefined,
): AiCapabilities | null {
  const base =
    aiMode === undefined
      ? null
      : aiMode === 'off'
        ? ALL_OFF
        : aiMode === 'live'
          ? LIVE_CAPABILITIES
          : ALL_ON;
  if (base === null) return null;
  return Object.fromEntries(
    (Object.keys(base) as (keyof AiCapabilities)[]).map((k) => [k, base[k] && (features?.[k] ?? true)]),
  ) as AiCapabilities;
}

export function useCapabilities() {
  const { preferences, error } = usePreferences();
  const capabilities = !preferences?.ui
    ? null
    : deriveCapabilities(preferences.ui.aiMode, preferences.ui.features);
  return { capabilities, error, refetch: noopRefetch };
}
```

Keep the existing `ALL_OFF` / `LIVE_CAPABILITIES` / `ALL_ON` / `noopRefetch` definitions; only the `useCapabilities` body and the new `deriveCapabilities` export change. (`aiMode === undefined → null` mirrors the prior `!preferences?.ui → null` guard.)

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `node_modules/.bin/vitest run src/hooks/useCapabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useCapabilities.ts frontend/src/hooks/useCapabilities.test.ts
git commit -m "feat(ai): mask capabilities by user feature flags (#536)"
```

---

### Task 7: `AiPane` — Live-gated knobs, "AI features" accordion, Preview disabled button

**Files:**
- Modify: `frontend/src/components/Settings/panes/AiPane.tsx`
- Test: `frontend/src/components/Settings/panes/AiPane.test.tsx`
- Modify: `frontend/src/components/Settings/panes/Pane.module.css` — add a `.disclosureBtn` class resetting button chrome so the trigger reads as a row label, not a default button: `appearance: none; background: none; border: none; padding: 0; cursor: pointer; text-align: left; font: inherit; color: inherit;`. Both the Live accordion trigger and the Preview button compose it with `pane.label`. (`.row` is `display:flex; align-items:center`, which is why each row nests label+help inside a `<div>` so the help renders as a sub-line.)

**Interfaces:**
- Consumes: `set('ui.ai.features.<seam>', boolean)` (Task 5), `preferences.ui.features` (Task 4).

- [ ] **Step 1: Re-seed the three existing stepper tests + add the `features` mock field**

In `frontend/src/components/Settings/panes/AiPane.test.tsx`: add `features` to the hoisted `prefs` mock and the mocked `ui` object, and set Live mode in the three stepper tests (they default to `aiMode='off'` via `beforeEach`).

Add to the `prefs` hoisted object (line ~9):

```typescript
  features: {
    summary: true, fileFocus: true, hunkAnnotations: true, preSubmitValidators: true,
    composerAssist: true, draftSuggestions: true, draftReconciliation: true,
    inboxEnrichment: true, inboxRanking: true,
  },
```

(All nine keys, matching the `AiFeatures` type and the e2e fixtures — no loose `Record` cast.) Add to the mocked `ui` object (line ~27): `features: prefs.features,`

In each of the three stepper tests (`renders the provider-timeout stepper …`, `… hunk-annotation-cap …`, `… summary-length …`), add `prefs.aiMode = 'live';` as the first line of the test body (before `render(<AiPane />)`).

- [ ] **Step 2: Write the failing new tests**

Append inside `describe('AiPane', …)`:

```typescript
it('hides detail controls in Off and Preview', () => {
  prefs.aiMode = 'preview';
  render(<AiPane />);
  expect(screen.queryByRole('spinbutton', { name: 'Provider timeout' })).toBeNull();
  // Preview shows the disabled, non-expanding "AI features" button.
  expect(screen.getByRole('button', { name: /AI features/ })).toHaveAttribute('aria-disabled', 'true');
});

it('shows four feature switches in Live and toggles one', async () => {
  prefs.aiMode = 'live';
  render(<AiPane />);
  await userEvent.click(screen.getByRole('button', { name: /AI features/ }));
  const summary = screen.getByRole('switch', { name: 'Summary' });
  expect(summary).toBeChecked();
  await userEvent.click(summary);
  await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.features.summary', false));
});
```

- [ ] **Step 3: Run them to verify they fail**

Run (from `frontend/`): `node_modules/.bin/vitest run src/components/Settings/panes/AiPane.test.tsx`
Expected: FAIL — no Live-gate, no accordion, no Preview button.

- [ ] **Step 4: Implement the UI in `AiPane.tsx`**

1. Update the subtitle `<p className={pane.sub}>` to: `Choose how AI runs. Provider, summary, and per-feature settings appear in Live mode.`
2. Wrap the three existing `NumberStepper` rows (provider timeout, annotation cap, summary length) in `{resolvedMode === 'live' && ( … )}`.
3. Inside that same Live block, after the steppers, render the accordion. Add `const [featuresOpen, setFeaturesOpen] = useState(false);` near the other hooks. Use the four-row helper:

```tsx
{resolvedMode === 'live' && (
  <>
    {/* …the three NumberStepper rows… */}
    <div className={pane.row}>
      <button
        type="button"
        className={`${pane.label} ${pane.disclosureBtn}`}
        aria-expanded={featuresOpen}
        aria-controls="ai-features-region"
        onClick={() => setFeaturesOpen((o) => !o)}
      >
        AI features
      </button>
    </div>
    {featuresOpen && (
      <div id="ai-features-region" role="group" aria-label="AI features">
        {FEATURE_ROWS.map(({ key, label, help }) => (
          <div key={key} className={pane.row}>
            <div>
              <label className={pane.label} htmlFor={`ai-feat-${key}`}>{label}</label>
              <p id={`ai-feat-${key}-help`} className={pane.help}>{help}</p>
            </div>
            <div className={pane.spring} />
            <Switch
              id={`ai-feat-${key}`}
              label={label}
              describedById={`ai-feat-${key}-help`}
              checked={preferences.ui.features?.[key] ?? true}
              onChange={(next) => void set(`ui.ai.features.${key}`, next).catch(() => {})}
            />
          </div>
        ))}
      </div>
    )}
  </>
)}
```

4. Add the Preview disabled button:

```tsx
{resolvedMode === 'preview' && (
  <div className={pane.row}>
    <div>
      <button
        type="button"
        className={`${pane.label} ${pane.disclosureBtn}`}
        style={{ opacity: 0.5 }}
        aria-disabled="true"
        aria-describedby="ai-features-preview-hint"
      >
        AI features
      </button>
      <p id="ai-features-preview-hint" className={pane.help}>
        {Object.values(preferences.ui.features ?? {}).some((v) => v === false)
          ? 'Some AI features are turned off. Switch to Live to change them.'
          : 'Switch to Live to turn individual features on or off.'}
      </p>
    </div>
  </div>
)}
```

5. Define the row config near the top of the module:

```tsx
const FEATURE_ROWS = [
  { key: 'summary' as const, label: 'Summary', help: 'When off, the AI summary card is hidden on pull requests.' },
  { key: 'fileFocus' as const, label: 'File focus', help: 'When off, AI file hotspots are not shown in the Files tab.' },
  { key: 'hunkAnnotations' as const, label: 'Hunk annotations', help: 'When off, inline AI annotations are not added to diffs.' },
  { key: 'inboxEnrichment' as const, label: 'Inbox enrichment', help: 'When off, the AI kind-of-change chip is removed from inbox rows.' },
];
```

Import `Switch` from `../../controls/Switch` and `useState` from `react`.

- [ ] **Step 5: Run tests to verify they pass**

Run (from `frontend/`): `node_modules/.bin/vitest run src/components/Settings/panes/AiPane.test.tsx`
Expected: PASS (existing mode + steppers re-seeded; new Off/Preview/Live cases green).

- [ ] **Step 6: Lint/format/typecheck, then commit**

Run (from `frontend/`): `node_modules/.bin/prettier --write src/components/Settings/panes/AiPane.tsx src/components/Settings/panes/AiPane.test.tsx && node_modules/.bin/eslint . && node_modules/.bin/tsc -b`

```bash
git add frontend/src/components/Settings/panes/AiPane.tsx frontend/src/components/Settings/panes/AiPane.test.tsx
git commit -m "feat(ai): AI features accordion + Live-gated AiPane (#536)"
```

---

### Task 8: e2e — Live-gating audit, accordion persist, real-wire gate, fixtures

**Files:**
- Modify: `frontend/e2e/ai-settings-tab.spec.ts`, `frontend/e2e/fixtures/preferences.ts` (and any `makeAiPreferences()` / `makeDefaultPreferences()` source)
- Possibly modify: other e2e specs that assert the steppers (grep first)

**Interfaces:**
- Consumes: the full stack (Tasks 1–7).

- [ ] **Step 1: Add `features` to the shared preference fixtures**

In `frontend/e2e/fixtures/preferences.ts` (and wherever `makeAiPreferences()` builds the `ui`), add a `features` object with all nine keys `true` so fixture GET responses match the new wire shape.

- [ ] **Step 2: Audit stepper-touching specs**

Run (from repo root): `git grep -n "spinbutton" frontend/e2e` and `git grep -n "Provider timeout\|Annotation cap\|Summary length" frontend/e2e`. For each hit, confirm the test seeds `aiMode: 'live'` (the shared `makeAiPreferences()` already does) before reaching the stepper — including the timeout-503 deep-link test in `ai-settings-tab.spec.ts`. Fix any that don't.

- [ ] **Step 3: Add the accordion + Preview + real-wire tests**

In `frontend/e2e/ai-settings-tab.spec.ts` add (using the file's existing route/store harness):
- A Live test: open `/settings/ai`, expand "AI features", toggle "Summary" off, assert the POST `{ "ui.ai.features.summary": false }` fired and the persisted store reflects it.
- A Preview test: seed `aiMode: 'preview'`, assert the steppers are absent and the disabled "AI features" button is visible with `aria-disabled="true"`.
- **Real-wire gate test:** with the real preferences store (not a hand-mocked `features`), POST `ui.ai.features.summary=false`, navigate to a PR, and assert the summary card affordance is absent — proving the `ui.features` projection drives the mask through the actual serialized response.

- [ ] **Step 4: Run the affected e2e specs**

Run (from `frontend/`): `node_modules/.bin/playwright test e2e/ai-settings-tab.spec.ts --project=prod`
Expected: PASS. (Use `--project=prod` — `playwright.config.ts` defines only the prod project; there is no dev project to select.)

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e
git commit -m "test(ai): e2e for per-feature toggles + Live-gating audit (#536)"
```

---

## Self-Review

**Spec coverage:**
- D1 four live-seam toggles → Tasks 2/3/7. D2 collapsed accordion → Task 7. D3 progressive disclosure (Off/Preview/Live) → Task 7 (+ stepper re-seed). D4 mode-independent value, editor Live-gated → Tasks 6/7. D5 defaults all-on → reuses `AiFeaturesConfig.AllOn` (Tasks 1/3, fail-open). D6 no new enforcement → no selector change (verified, none planned). D7 no visual baseline → Task 8 + PR screenshots (B1 proof, done at PR time).
- Backend `With` (Task 1), allowlist+patch (Task 2), DTO projection + hot-mirror regression (Task 3). FE types (4), union (5), mask (6), UI (7), e2e (8).

**Placeholder scan:** every code step carries real code; test factories/harnesses reference the existing neighbors verbatim (explicitly flagged where the implementer must copy the established setup rather than invent one).

**Type consistency:** `AiFeatures` (FE) ↔ `AiFeaturesDto` (BE) ↔ `AiFeaturesConfig.Enabled` keys — all nine camelCase names identical; settable subset `{summary,fileFocus,hunkAnnotations,inboxEnrichment}` consistent across allowlist, patch arms, `PreferenceKey` union, and `FEATURE_ROWS`. `With(string,bool)` signature stable across Tasks 1→2.

## Execution note

The four backend tasks (1–3) and the FE tasks (4–8) each end on a green, committed, independently-reviewable deliverable. Run `npm ci` in `frontend/` before Task 4. Hold the B1 visual screenshots (Live accordion collapsed/expanded + Preview disabled button, both themes) for the PR `## Proof`.
