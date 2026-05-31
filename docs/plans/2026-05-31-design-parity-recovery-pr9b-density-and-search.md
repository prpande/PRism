# PR9b-density + PR9b-search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two of the three PR9b sub-PR slots in one bundled code PR — wire the density-mode toggle (D97 closure) and stub the global-search input with a forward-looking tooltip (D101 closure). The third PR9b sub-PR (`PR9b-ai-gating`, D87) remains separate.

**Bundling rationale:** Density and search share zero source files, zero call sites, and zero risk surface — Header.tsx is touched only by search; the density path never touches Header.tsx. The bundle is justified on **operational cost**, not cohesion: a standalone PR for a 1-line attribute + 1 test would burn a full pr-autopilot loop (preflight + Copilot + claude[bot] iterations + CI gate + report) for no review-coverage gain. Rollback granularity is acceptable: the search change has no failure modes that could force a revert independent of density. If density's Playwright e2e flakes on CI and search is fine, both wait — accepted trade.

**Architecture:** Density follows the same backend-prefs pattern as theme/accent — `UiConfig.Density` field + `ConfigStore.PatchAsync` allowlist entry + `UiPreferencesDto.Density` + `usePreferences.set('density', value)` + `applyDensityToDocument` shared util mirroring `applyThemeToDocument`, called from both `HeaderControls` mount-effect (boot apply) and the `AppearanceSection` density picker (immediate visible apply). Density flip is **intentionally instant-snap** — no CSS transition on `[data-density="compact"]` layout tokens (`tokens.css:215-222`). Rationale: layout-height transitions require explicit `height` on every affected container and are visually distracting on a setting that is set once. Search bundles in trivially: the disabled `<input>` at `Header.tsx:66-71` already has `cursor: not-allowed` from `Header.module.css:39-42`; only the `title="Search palette — v1.1"` attribute is missing.

**Tech Stack:** .NET 10 (PRism.Core/Web) + System.Text.Json records, React 19.2.5 + TypeScript + Vite + CSS modules, Vitest + jsdom + @testing-library/react, Playwright e2e.

---

## Spec drift & plan deviations

**Deviation 1 — Density persistence: backend prefs, NOT localStorage.** Spec § 4.9.2 line 453 names the precedent as `prism.densityPreference` localStorage. Implementation found this misnames the actual code precedent at `frontend/src/utils/applyTheme.ts` + `frontend/src/components/Settings/AppearanceSection.tsx` + `frontend/src/hooks/usePreferences.ts` — theme/accent persist through `POST /api/preferences` → `ConfigStore.PatchAsync` → on-disk `config.json`, NOT through `window.localStorage`. Three plausible localStorage rationales were considered before declaring the spec line a slip:

- **FOUC (flash-of-unstyled-content) on cold load.** Backend prefs reach the DOM via the SPA's mount lifecycle: React mounts → `usePreferences` GET resolves → `HeaderControls` `useEffect` calls `applyDensityToDocument`. localStorage would give a synchronous read in the initial render before React mounts, eliminating the one-frame `comfortable` interval. **Rejected because:** the cold-load default IS `comfortable` (no attribute, base CSS values apply). The one-frame interval renders the correct default state, not a flicker. A user who has set density to compact sees `comfortable` for one frame on reload — visually equivalent to the page paint sequence we already have on boot.

- **Offline survival of the .NET tray.** Backend prefs require the tray running. If the tray crashes and the user reopens the SPA before restart, density resets to comfortable. localStorage survives. **Rejected because:** the tray IS PRism — tray-down means GitHub fetches, submit, and every interactive surface fail. Density reverting is the least-worst surface in that state.

- **Per-machine vs per-account variance.** A user wanting compact on a 13" laptop and comfortable on a 27" external would be served by localStorage (per-machine). **Rejected because:** PRism's `UiConfig` (theme, accent, aiPreview) is already machine-wide via the single per-instance `config.json`. Multi-instance per-monitor splitting is an unsupported deployment shape. If the cohort signals this matters later, the migration is additive (add a `--density-override` env var or local config file).

**Decision:** follow the actual code precedent (backend prefs) and consistency with `UiConfig`'s existing fields. The spec text gets corrected in the same PR (PR9b-density+search closure) — see Task 12. Rollback semantics: a revert of this PR re-introduces the localStorage misnomer in the spec text; accepted because PRism is single-user and rollback is local-only.

**Density is cross-account.** Per S6 PR0 multi-account scaffold (PR #53) — `UiConfig` lives at the top of `config.json` as a peer to `github.accounts[]`, not inside an account entry. Theme, accent, aiPreview, and now density are intentionally machine-wide preferences shared across whichever GitHub account is active. If per-account density is wanted later, the migration is non-trivial (config schema bump) — flagging here so the question is on the record.

**Deviation 2 — Search input already exists; only `title` attribute is new; `title` attribute is invisible on touch.** Spec § 4.9.2 line 454 implies the work is "stub-with-tooltip" as if the input itself needs adding. Implementation found the input is already at `frontend/src/components/Header/Header.tsx:66-71` with `disabled` + `aria-label`; CSS `.search:disabled { cursor: not-allowed }` already at `Header.module.css:39-42`. The only delta is one HTML attribute + a smoke vitest. **Touch-device caveat:** HTML `title` attribute requires hover; touch devices show no tooltip. PRism is desktop-first in v1, so this is accepted. If touch cohort signal emerges later, swap to a focus-visible `<span>` rendered next to the input on focus. This is acknowledged scope-shrink + an accepted accessibility trade, not a deviation requiring its own sidecar entry.

**Deviation 3 — `applyDensityToDocument` as a separate export, NOT a renamed `applyTheme.ts`.** Spec is silent on file naming. Implementation keeps `applyTheme.ts` as the file and adds `applyDensityToDocument(density)` alongside `applyThemeToDocument(theme, accent)` rather than renaming the file to `applyAppearance.ts` or building a combined `applyAppearance(theme, accent, density)`. Reason: `HeaderControls.tsx:38-39` and the rollback path in `AppearanceSection.tsx:31-42` already work key-by-key (theme alone, accent alone, fail → re-apply prior `(theme, accent)` pair). A combined function would force every caller to thread the full tuple even when changing one key. Two separate functions match the existing key-scoped usage shape.

**Deviation 4 — `density` allowlist entry is a bare key, NOT a dotted-path.** `ConfigStore._allowedFields` has bare keys for `theme` / `accent` / `aiPreview` (S0+S1 wire shape) and dotted-path keys for `inbox.sections.*` (S6 PR1). Density follows the bare-key pattern because it lives in `ui.*` alongside theme/accent/aiPreview. The on-disk shape is `config.json#ui.density`; the wire shape is `{ "density": "compact" }`. This matches the existing precedent without inventing a third key class.

**Deviation 5 — `Density` field added with C# parameter default for backward compat.** Existing on-disk `config.json` files lack a `density` field. `UiConfig` gains the parameter as `string Density = "comfortable"`, so STJ deserialization of an old file produces `UiConfig { Theme = ..., Accent = ..., AiPreview = ..., Density = "comfortable" }` automatically. This is well-defined .NET 7+ STJ behavior — see `IterationsConfig(int ClusterGapSeconds, bool ClusteringDisabled = false)` at `AppConfig.cs:48` which already exercises the same mechanism in production. A test in Task 4 asserts the default-on-missing behavior.

**Deviation 6 — Backend allowlist accepts arbitrary `density` strings (acknowledged gap).** `ConfigStore._allowedFields` validates field TYPE only (string vs bool), not enum membership. After this PR ships, `POST /api/preferences {"density": "WTF"}` succeeds and persists `ui.density: "WTF"`. The frontend `applyDensityToDocument` defensively treats any non-`compact` value as `comfortable` (removes the attribute), so the user-visible state is correct even on out-of-band edits to `config.json`. The same gap exists today for theme (`'system'|'light'|'dark'`) and accent (`'indigo'|'amber'|'teal'`) — this PR does not introduce the gap, just inherits it. **Deferred to a follow-up:** server-side enum validation for all closed-union string fields (theme, accent, density). Logged as a known follow-on rather than expanded into this PR's scope.

---

## File map

**Backend (`PRism.Core` + `PRism.Web`):**
- Modify `PRism.Core/Config/AppConfig.cs:50` — extend `UiConfig` record with `string Density = "comfortable"`.
- Modify `PRism.Core/Config/AppConfig.cs:24` — update `AppConfig.Default` to pass the 4th arg explicitly (`"comfortable"`).
- Modify `PRism.Core/Config/ConfigStore.cs:30-41` — add `["density"] = ConfigFieldType.String` to `_allowedFields`.
- Modify `PRism.Core/Config/ConfigStore.cs:132-148` — add `"density" => _current with { Ui = ui with { Density = (string)value! } }` to PatchAsync switch.
- Modify `PRism.Web/Endpoints/PreferencesDtos.cs:24` — add `Density` to `UiPreferencesDto`.
- Modify `PRism.Web/Endpoints/PreferencesEndpoints.cs:62-63` — extend `UiPreferencesDto` construction in `BuildResponse` to include density.

**Backend tests:**
- Modify `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs` — add 3 new tests: (1) density valid string round-trips, (2) density bool value is rejected (per type-validation contract), (3) loading config.json without density defaults to `"comfortable"`.
- Modify `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` — add 2 new tests: (1) GET /api/preferences returns `ui.density` field, (2) POST /api/preferences with `{ "density": "compact" }` round-trips and 200s. Use the existing `PRismWebApplicationFactory` and FluentAssertions style already in this file.

**Frontend (`frontend/src`):**
- Modify `frontend/src/api/types.ts` — extend `UiPreferences` with `density: Density`. Add `export type Density = 'comfortable' | 'compact';`.
- Modify `frontend/src/hooks/usePreferences.ts` — add `'density'` to `PreferenceKey` union, update `readKey` + `writeKey`.
- Modify `frontend/src/utils/applyTheme.ts` — add `export function applyDensityToDocument(density: Density): void` (sets `data-density="compact"` attr or removes it for `'comfortable'` or any non-compact value).
- Modify `frontend/src/components/Header/HeaderControls.tsx:18-20` — also call `applyDensityToDocument(preferences.ui.density)` in the mount useEffect.
- Modify `frontend/src/components/Settings/AppearanceSection.tsx` — add Density picker `<div className={styles.row}>` with `<label htmlFor="appearance-density">` + `<select>` mirroring Theme. **IA placement:** insert between Accent and AI preview (visual chrome controls first — Theme, Accent, Density; functional capability toggle — AI preview — last). Add `onDensity` handler with rollback parity.
- Modify `frontend/src/components/Header/Header.tsx:66-71` — add `title="Search palette — v1.1"` to the disabled `<input>`.

**Frontend tests:**
- Create `frontend/__tests__/applyDensity.test.ts` (or extend `frontend/__tests__/applyTheme.test.ts` if present) — `applyDensityToDocument` tests: compact sets the attribute; comfortable removes it; backend-string-typed out-of-union value removes the attribute (defensive on string-typed wire). All tests under the repo's canonical `frontend/__tests__/` directory — colocated `src/**/__tests__/` is NOT the repo convention.
- Modify `frontend/__tests__/Settings/AppearanceSection.test.tsx` (or create if absent — check whether `frontend/__tests__/Settings/` already has an AppearanceSection test) — assert density picker renders between Accent and AI preview, options are comfortable+compact, change calls `set('density', value)` + `applyDensityToDocument(value)`, POST failure re-applies prior. Use `waitFor` (not fixed setTimeout) per the Windows-CI-flake memory note.
- Modify `frontend/__tests__/header.test.tsx` (lowercase, existing file with MSW setup) — append one new `it()` to the existing `describe('Header', …)` block asserting the disabled search `<input>` carries `title="Search palette — v1.1"`. Use the file's existing render helper + `hasToken` prop convention.

**Playwright e2e:**
- Create `frontend/e2e/specs/density-toggle.spec.ts` — happy-path: open Settings → toggle density to compact → assert `<html data-density="compact">` → reload → assert attribute persisted → toggle back to comfortable → assert attribute removed.
- Create `frontend/e2e/specs/density-cross-tab.spec.ts` — open two tabs both at `/settings` → toggle in tab A → focus tab B (triggers `focus` event → `usePreferences` refetch) → assert tab B's `<html>` data-density attribute updates within 5s.
- Create `frontend/e2e/specs/density-failure.spec.ts` (or fold into density-toggle.spec.ts as a second `test()`) — register a route interceptor that 500s `POST /api/preferences` → toggle to compact → assert attribute is set transiently → after rollback, assert attribute returns to comfortable AND a toast appears.

**Parity baseline:**
- Recapture `frontend/e2e/__screenshots__/win32/settings-page.png` — adding the Density row drifts the Settings page parity baseline. Capture in Task 11 Step 4.

**Documentation:**
- Modify `docs/specs/2026-05-29-design-parity-recovery-design.md:453` — correct the persistence reference from "localStorage" to "backend prefs (via `/api/preferences`, mirrors theme/accent precedent)".
- Modify `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` — append D105 (PR9b-density+search shipped) with closure cross-refs to D97 + D101 + the spec-line correction + a backward link from line 453 to D105 + a one-line update to D104 noting the spec line was corrected.

---

## Task plan

### Task 1: Verify baseline state

**Files:**
- Read: `git status`, `npm run lint`, `npm test`, `dotnet test`

- [ ] **Step 1: Confirm worktree state**

Run: `git rev-parse HEAD && git status`
Expected: HEAD is `50ce6bf` (PR9a merge); worktree clean.

- [ ] **Step 2: Run baseline backend tests**

Run: `dotnet test --configuration Debug --no-restore`
Expected: All green. Note the test count for the post-implementation diff.

- [ ] **Step 3: Run baseline frontend tests**

Run: `cd frontend && npm test -- --run` (vitest one-shot)
Expected: All green. Note the test count.

- [ ] **Step 4: Run baseline lint + prettier**

Run: `cd frontend && npm run lint`
Expected: 0 errors. (Includes `prettier --check`.)

---

### Task 2: Backend `UiConfig.Density` field

**Files:**
- Modify: `PRism.Core/Config/AppConfig.cs:24,50`
- Test: indirect via Task 4's `ConfigStorePatchAsyncDottedPathTests.cs` default-on-missing test

- [ ] **Step 1: Write the failing test (defer to Task 4 since it covers Default + load behavior)**

This task is a mechanical record extension. The behavioral assertion lives in Task 4.

- [ ] **Step 2: Extend `UiConfig`**

Edit `PRism.Core/Config/AppConfig.cs:50`:
```csharp
public sealed record UiConfig(string Theme, string Accent, bool AiPreview, string Density = "comfortable");
```

- [ ] **Step 3: Update `AppConfig.Default`**

Edit `PRism.Core/Config/AppConfig.cs:24`:
```csharp
new UiConfig("system", "indigo", false, "comfortable"),
```

(Explicit 4th arg even though the parameter default would make it optional — matches the convention for the other UiConfig args and surfaces param-shift breakage at the seed site.)

- [ ] **Step 4: Confirm build**

Run: `dotnet build --configuration Debug --no-restore`
Expected: Build succeeds. No new warnings.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/AppConfig.cs
git commit -m "feat(pr9b): UiConfig.Density field with comfortable default"
```

---

### Task 3: Backend `ConfigStore` allowlist + patch

**Files:**
- Modify: `PRism.Core/Config/ConfigStore.cs:30-41,132-148`
- Test: `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs`

- [ ] **Step 1: Write the failing test — valid density string round-trips**

Edit `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs` — add (match the file's existing FluentAssertions / xUnit style):
```csharp
[Theory]
[InlineData("comfortable")]
[InlineData("compact")]
public async Task PatchAsync_DensityValidString_PersistsAndReadsBack(string value)
{
    using var tempDir = TempDir.New();
    var store = new ConfigStore(tempDir.Path);
    await store.InitAsync(CancellationToken.None);

    await store.PatchAsync(
        new Dictionary<string, object?> { ["density"] = value },
        CancellationToken.None);

    store.Current.Ui.Density.Should().Be(value);
}
```

(Match the file's actual `FluentAssertions` vs `Assert.Equal` convention — check the file head before committing the snippet.)

- [ ] **Step 2: Write the failing test — wrong type is rejected**

Same file, add:
```csharp
[Fact]
public async Task PatchAsync_DensityWrongType_ThrowsConfigPatchException()
{
    using var tempDir = TempDir.New();
    var store = new ConfigStore(tempDir.Path);
    await store.InitAsync(CancellationToken.None);

    Func<Task> act = () => store.PatchAsync(
        new Dictionary<string, object?> { ["density"] = true },
        CancellationToken.None);
    var ex = await act.Should().ThrowAsync<ConfigPatchException>();
    ex.Which.Message.Should().Contain("density").And.Contain("string");
}
```

- [ ] **Step 3: Run tests to confirm they fail**

Run: `dotnet test --configuration Debug --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests" --no-restore`
Expected: 2 FAIL — `unknown field: density`.

- [ ] **Step 4: Add density to the allowlist**

Edit `PRism.Core/Config/ConfigStore.cs:30-41`, insert after `aiPreview`:
```csharp
            ["density"]                          = ConfigFieldType.String,
```

- [ ] **Step 5: Add density arm to PatchAsync switch**

Edit `PRism.Core/Config/ConfigStore.cs:132-148`, insert after `"aiPreview"`:
```csharp
                "density"   => _current with { Ui = ui with { Density = (string)value! } },
```

- [ ] **Step 6: Run tests to confirm they pass**

Run: `dotnet test --configuration Debug --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests" --no-restore`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs
git commit -m "feat(pr9b): density allowlist entry + PatchAsync arm"
```

---

### Task 4: Backend default-on-missing test

**Files:**
- Test: `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs` (or sibling load-tests file)

- [ ] **Step 1: Write the failing test — old config.json without density loads with default**

Edit the test file:
```csharp
[Fact]
public async Task InitAsync_LegacyConfigWithoutDensity_DefaultsToComfortable()
{
    using var tempDir = TempDir.New();
    var path = Path.Combine(tempDir.Path, "config.json");
    // Legacy shape — pre-PR9b config without ui.density
    await File.WriteAllTextAsync(path, """
        {
          "ui": { "theme": "dark", "accent": "amber", "aiPreview": true }
        }
        """);
    var store = new ConfigStore(tempDir.Path);
    await store.InitAsync(CancellationToken.None);

    store.Current.Ui.Density.Should().Be("comfortable");
    store.Current.Ui.Theme.Should().Be("dark");
    store.Current.Ui.Accent.Should().Be("amber");
    store.Current.Ui.AiPreview.Should().BeTrue();
}
```

- [ ] **Step 2: Run the test to confirm it passes**

Run: `dotnet test --configuration Debug --filter "FullyQualifiedName~InitAsync_LegacyConfigWithoutDensity" --no-restore`
Expected: PASS (because UiConfig's `Density = "comfortable"` default applies via STJ parameter-default — same mechanism `IterationsConfig.ClusteringDisabled` already uses at `AppConfig.cs:48`).

If the test FAILS, investigate STJ deserialization behavior for record positional parameter defaults under .NET 10. The fallback (less elegant) is to make `Density` nullable + post-deserialization fixup in `ReadFromDiskAsync`. The plan assumes the parameter-default path works under .NET 10 STJ; the `IterationsConfig` precedent makes this high-confidence.

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs
git commit -m "test(pr9b): legacy config.json without density defaults to comfortable"
```

---

### Task 5: Backend DTO + endpoint projection

**Files:**
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs:24`
- Modify: `PRism.Web/Endpoints/PreferencesEndpoints.cs:62-63`
- Test: `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs`

- [ ] **Step 1: Write the failing tests — GET returns density, POST sets density**

Edit `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` — add (use the existing `PRismWebApplicationFactory` + FluentAssertions style + `Uri(..., UriKind.Relative)` already used in this file):
```csharp
[Fact]
public async Task GetPreferences_IncludesDensity_DefaultComfortable()
{
    using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();

    var resp = await client.GetAsync(new Uri("/api/preferences", UriKind.Relative));
    resp.EnsureSuccessStatusCode();
    var doc = await resp.Content.ReadFromJsonAsync<JsonElement>();

    doc.GetProperty("ui").GetProperty("density").GetString().Should().Be("comfortable");
}

[Fact]
public async Task PostPreferences_SetsDensity_RoundTrips()
{
    using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();

    var post = await client.PostAsJsonAsync(
        new Uri("/api/preferences", UriKind.Relative),
        new { density = "compact" });
    post.EnsureSuccessStatusCode();
    var body = await post.Content.ReadFromJsonAsync<JsonElement>();
    body.GetProperty("ui").GetProperty("density").GetString().Should().Be("compact");

    var get = await client.GetAsync(new Uri("/api/preferences", UriKind.Relative));
    var getBody = await get.Content.ReadFromJsonAsync<JsonElement>();
    getBody.GetProperty("ui").GetProperty("density").GetString().Should().Be("compact");
}
```

(Verify the factory class name + assertion-library style by reading the head of `PreferencesEndpointsTests.cs` before pasting. If the file uses xUnit `Assert.Equal`, conform to that style.)

- [ ] **Step 2: Run tests to confirm they fail**

Run: `dotnet test --configuration Debug --filter "FullyQualifiedName~PreferencesEndpointsTests" --no-restore`
Expected: 2 FAIL — `density` property missing.

- [ ] **Step 3: Extend `UiPreferencesDto`**

Edit `PRism.Web/Endpoints/PreferencesDtos.cs:24`:
```csharp
internal sealed record UiPreferencesDto(string Theme, string Accent, bool AiPreview, string Density);
```

- [ ] **Step 4: Extend `BuildResponse`**

Edit `PRism.Web/Endpoints/PreferencesEndpoints.cs:62-63`:
```csharp
            Ui: new UiPreferencesDto(ui.Theme, ui.Accent, ui.AiPreview, ui.Density),
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `dotnet test --configuration Debug --filter "FullyQualifiedName~PreferencesEndpointsTests" --no-restore`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/PreferencesDtos.cs PRism.Web/Endpoints/PreferencesEndpoints.cs tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs
git commit -m "feat(pr9b): UiPreferencesDto.Density + GET/POST endpoint projection"
```

---

### Task 6: Frontend types + hook

**Files:**
- Modify: `frontend/src/api/types.ts` (UiPreferences interface)
- Modify: `frontend/src/hooks/usePreferences.ts:10-51`

- [ ] **Step 1: Extend `UiPreferences` type**

Edit `frontend/src/api/types.ts` — add `Density` union + extend `UiPreferences`:
```ts
export type Density = 'comfortable' | 'compact';

export interface UiPreferences {
  theme: Theme;
  accent: Accent;
  aiPreview: boolean;
  density: Density;
}
```

(Preserve the existing field order + the `Theme`/`Accent` declarations above. Add `Density` near `Theme`/`Accent` for locality.)

- [ ] **Step 2: Extend `PreferenceKey` union**

Edit `frontend/src/hooks/usePreferences.ts:10-19`:
```ts
export type PreferenceKey =
  | 'theme'
  | 'accent'
  | 'aiPreview'
  | 'density'
  | `inbox.sections.${
      | 'review-requested'
      | 'awaiting-author'
      | 'authored-by-me'
      | 'mentioned'
      | 'ci-failing'}`;
```

- [ ] **Step 3: Extend `InboxSectionKey` exclusion**

Edit `frontend/src/hooks/usePreferences.ts:21`:
```ts
type InboxSectionKey = Exclude<PreferenceKey, 'theme' | 'accent' | 'aiPreview' | 'density'>;
```

- [ ] **Step 4: Extend `readKey`**

Edit `frontend/src/hooks/usePreferences.ts:23-29`:
```ts
function readKey(prefs: PreferencesResponse, key: PreferenceKey): unknown {
  if (key === 'theme') return prefs.ui.theme;
  if (key === 'accent') return prefs.ui.accent;
  if (key === 'aiPreview') return prefs.ui.aiPreview;
  if (key === 'density') return prefs.ui.density;
  const id = key.slice('inbox.sections.'.length) as keyof PreferencesResponse['inbox']['sections'];
  return prefs.inbox.sections[id];
}
```

- [ ] **Step 5: Extend `writeKey`**

Edit `frontend/src/hooks/usePreferences.ts:31-51` — add the `density` arm BEFORE the `inbox.sections.*` fallback:
```ts
  if (key === 'density')
    return { ...prefs, ui: { ...prefs.ui, density: value as PreferencesResponse['ui']['density'] } };
```

- [ ] **Step 6: Run typecheck + lint**

Run: `cd frontend && npm run lint`
Expected: 0 errors. (TypeScript will surface any missed call sites that destructure `ui.*` and need updating — see the mock-fixture sweep in Task 13 Step 0.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/hooks/usePreferences.ts
git commit -m "feat(pr9b): Density type + usePreferences density key"
```

---

### Task 7: `applyDensityToDocument` util + test

**Files:**
- Modify: `frontend/src/utils/applyTheme.ts`
- Create (or extend existing): `frontend/__tests__/applyDensity.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/__tests__/applyDensity.test.ts` (canonical project convention is `frontend/__tests__/` — colocated `src/**/__tests__/` is NOT used in this repo):
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { Density } from '../src/api/types';
import { applyDensityToDocument } from '../src/utils/applyTheme';

describe('applyDensityToDocument', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-density');
  });

  it('sets data-density="compact" when value is compact', () => {
    applyDensityToDocument('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });

  it('removes data-density when value is comfortable', () => {
    document.documentElement.setAttribute('data-density', 'compact');
    applyDensityToDocument('comfortable');
    expect(document.documentElement.hasAttribute('data-density')).toBe(false);
  });

  // The backend response is typed `string` (UiPreferencesDto.Density at PreferencesDtos.cs)
  // and `ConfigStore._allowedFields` validates type=String only, NOT enum membership
  // (Deviation 6). An out-of-band edit to config.json or a future allowlist extension
  // could yield a string the frontend Density union claims is impossible. The defensive
  // else-branch absorbs that.
  it('removes data-density for any non-compact string (wire-shape defense)', () => {
    document.documentElement.setAttribute('data-density', 'compact');
    applyDensityToDocument('weird-value' as unknown as Density);
    expect(document.documentElement.hasAttribute('data-density')).toBe(false);
  });
});
```

(If `frontend/__tests__/applyTheme.test.ts` already exists, append the new `describe` block to it instead of creating a new file.)

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd frontend && npm test -- --run __tests__/applyDensity.test.ts`
Expected: FAIL — `applyDensityToDocument` is not exported.

- [ ] **Step 3: Add `applyDensityToDocument`**

Edit `frontend/src/utils/applyTheme.ts` — append:
```ts
import type { Density } from '../api/types';

// AppearanceSection's density picker and HeaderControls' mount-effect each
// call this so the visible `data-density` attribute on <html> updates without
// waiting for a focus refetch. Mirrors applyThemeToDocument's
// independent-effect pattern: each ui.* key has a key-scoped DOM applier so
// rollbacks on one key don't have to thread the full appearance tuple.
//
// Defensive on any non-`compact` string. The wire shape (`UiPreferencesDto.Density`)
// is `string`, validated by ConfigStore for type only, not enum membership
// (plan Deviation 6) — an out-of-band config.json edit could yield an arbitrary
// string. Treating non-`compact` as comfortable keeps the visible state correct.
export function applyDensityToDocument(density: Density): void {
  if (typeof document === 'undefined') return;
  if (density === 'compact') {
    document.documentElement.setAttribute('data-density', 'compact');
  } else {
    document.documentElement.removeAttribute('data-density');
  }
}
```

(Uses `setAttribute`/`removeAttribute` over `dataset.density =`/`delete dataset.density` for stylistic clarity — both behaviors are equivalent on WHATWG DOMStringMap.)

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd frontend && npm test -- --run __tests__/applyDensity.test.ts`
Expected: All PASS.

- [ ] **Step 5: Prettier-write before staging**

Run: `cd frontend && npx prettier --write src/utils/applyTheme.ts __tests__/applyDensity.test.ts`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/utils/applyTheme.ts frontend/__tests__/applyDensity.test.ts
git commit -m "feat(pr9b): applyDensityToDocument shared util"
```

---

### Task 8: HeaderControls boot effect

**Files:**
- Modify: `frontend/src/components/Header/HeaderControls.tsx:7,18-20`

- [ ] **Step 1: Update the import**

Edit `frontend/src/components/Header/HeaderControls.tsx:7`:
```ts
import { applyThemeToDocument, applyDensityToDocument } from '../../utils/applyTheme';
```

- [ ] **Step 2: Extend the mount effect**

Edit `frontend/src/components/Header/HeaderControls.tsx:18-20`:
```ts
  useEffect(() => {
    if (preferences) {
      applyThemeToDocument(preferences.ui.theme, preferences.ui.accent);
      applyDensityToDocument(preferences.ui.density);
    }
  }, [preferences]);
```

- [ ] **Step 3: Run vitest for HeaderControls (catch broken mocks)**

Run: `cd frontend && npm test -- --run __tests__/HeaderControls`
Expected: All PASS. If any mocked `preferences.ui` fixtures break for lack of `density`, extend them with `density: 'comfortable'` — Task 13 Step 0 has the global sweep.

- [ ] **Step 4: Prettier-write + commit**

```bash
cd frontend && npx prettier --write src/components/Header/HeaderControls.tsx
cd D:/src/PRism/.claude/worktrees/design-parity-pr9b-density-search
git add frontend/src/components/Header/HeaderControls.tsx
git commit -m "feat(pr9b): HeaderControls boot effect applies density"
```

---

### Task 9: AppearanceSection density picker

**Files:**
- Modify: `frontend/src/components/Settings/AppearanceSection.tsx`
- Modify (or create): `frontend/__tests__/Settings/AppearanceSection.test.tsx`

- [ ] **Step 1: Write the failing test**

Edit (or create at the canonical path `frontend/__tests__/Settings/AppearanceSection.test.tsx`):
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppearanceSection } from '../../src/components/Settings/AppearanceSection';
import { usePreferences } from '../../src/hooks/usePreferences';
import { applyDensityToDocument } from '../../src/utils/applyTheme';
import type { PreferencesResponse } from '../../src/api/types';

vi.mock('../../src/hooks/usePreferences');
vi.mock('../../src/hooks/useCapabilities', () => ({
  useCapabilities: () => ({ refetch: vi.fn() }),
}));
vi.mock('../../src/utils/applyTheme', () => ({
  applyThemeToDocument: vi.fn(),
  applyDensityToDocument: vi.fn(),
}));

function mockPrefs(density: 'comfortable' | 'compact' = 'comfortable'): PreferencesResponse {
  return {
    ui: { theme: 'system', accent: 'indigo', aiPreview: false, density },
    inbox: {
      sections: {
        'review-requested': true,
        'awaiting-author': true,
        'authored-by-me': true,
        mentioned: true,
        'ci-failing': true,
      },
    },
    github: { host: 'https://github.com', configPath: '', logsPath: '' },
  } as PreferencesResponse;
}

describe('AppearanceSection density picker', () => {
  const mockSet = vi.fn();
  beforeEach(() => {
    vi.mocked(usePreferences).mockReturnValue({
      preferences: mockPrefs('comfortable'),
      error: null,
      refetch: vi.fn(),
      set: mockSet,
    });
    mockSet.mockReset();
    mockSet.mockResolvedValue(undefined);
    vi.mocked(applyDensityToDocument).mockReset();
  });

  it('renders the density picker with comfortable + compact options between Accent and AI preview', () => {
    render(<AppearanceSection />);
    const select = screen.getByLabelText('Density') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['comfortable', 'compact']);
  });

  it('changing density calls applyDensityToDocument + set("density", value)', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    const select = screen.getByLabelText('Density');
    await user.selectOptions(select, 'compact');

    expect(applyDensityToDocument).toHaveBeenCalledWith('compact');
    expect(mockSet).toHaveBeenCalledWith('density', 'compact');
  });

  it('POST failure re-applies prior density', async () => {
    mockSet.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    render(<AppearanceSection />);
    const select = screen.getByLabelText('Density');
    await user.selectOptions(select, 'compact');

    // Poll the observable condition instead of a fixed setTimeout — Windows CI
    // runners flake on sub-second sleeps (memory: feedback_windows_ci_fixed_delay_flake).
    await waitFor(() =>
      expect(applyDensityToDocument).toHaveBeenCalledWith('comfortable'),
    );
    expect(applyDensityToDocument).toHaveBeenCalledWith('compact'); // optimistic apply
    expect(applyDensityToDocument).toHaveBeenCalledWith('comfortable'); // rollback
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd frontend && npm test -- --run __tests__/Settings/AppearanceSection.test.tsx`
Expected: FAIL — no Density picker rendered.

- [ ] **Step 3: Add the density row + handler**

Edit `frontend/src/components/Settings/AppearanceSection.tsx`:
1. Extend the existing import line `import { applyThemeToDocument } from '../../utils/applyTheme';` to: `import { applyThemeToDocument, applyDensityToDocument } from '../../utils/applyTheme';`
2. Extend the existing type import line (currently `import type { Accent, Theme } from '../../api/types';`) to include `Density`: `import type { Accent, Density, Theme } from '../../api/types';`
3. Add the constant near the existing `THEMES`/`ACCENTS` constants:
   ```ts
   const DENSITIES: readonly Density[] = ['comfortable', 'compact'] as const;
   ```
4. Inside the component, add the handler near the existing `onTheme`/`onAccent`:
   ```ts
   const onDensity = (value: Density) => {
     const priorDensity = preferences.ui.density;
     applyDensityToDocument(value);
     void set('density', value).catch(() => applyDensityToDocument(priorDensity));
   };
   ```
5. Add the JSX row **between the Accent fieldset and the AI preview row** (visual chrome controls — Theme, Accent, Density — first; functional toggle — AI preview — last):
   ```tsx
   <div className={styles.row}>
     <label htmlFor="appearance-density">Density</label>
     <select
       id="appearance-density"
       value={preferences.ui.density}
       onChange={(e) => onDensity(e.target.value as Density)}
     >
       {DENSITIES.map((d) => (
         <option key={d} value={d}>
           {d.charAt(0).toUpperCase() + d.slice(1)}
         </option>
       ))}
     </select>
   </div>
   ```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd frontend && npm test -- --run __tests__/Settings/AppearanceSection.test.tsx`
Expected: All PASS.

- [ ] **Step 5: Run the rest of the frontend suite to confirm no fixture drift**

Run: `cd frontend && npm test -- --run`
Expected: All PASS. Failing mocks → see Task 13 Step 0 enumerated sweep.

- [ ] **Step 6: Prettier-write + commit**

```bash
cd frontend && npx prettier --write src/components/Settings/AppearanceSection.tsx __tests__/Settings/AppearanceSection.test.tsx
cd D:/src/PRism/.claude/worktrees/design-parity-pr9b-density-search
git add frontend/src/components/Settings/AppearanceSection.tsx frontend/__tests__/Settings/AppearanceSection.test.tsx
git commit -m "feat(pr9b): AppearanceSection density picker between Accent and AI preview"
```

---

### Task 10: Header search tooltip

**Files:**
- Modify: `frontend/src/components/Header/Header.tsx:66-71`
- Modify: `frontend/__tests__/header.test.tsx` (lowercase — existing file with MSW setup; do NOT create a new `Header.test.tsx`)

- [ ] **Step 1: Read the existing test file head**

Open `frontend/__tests__/header.test.tsx` and confirm the MSW setup + render helper + how `hasToken` is passed in the existing tests. The new assertion needs to use the same helper/pattern.

- [ ] **Step 2: Write the failing test**

Append one new `it()` inside the existing `describe('Header', …)` block, using the file's established render helper and `hasToken` convention. Approximate shape (adapt to the actual helper in the file):
```tsx
it('disabled search input carries the v1.1 tooltip', () => {
  // Use the file's existing render helper (likely `renderAt` or a localized
  // `renderHeader({ hasToken: true })`).
  renderAt('/'); // or whatever the file uses
  const input = screen.getByLabelText(/global search/i);
  expect(input).toBeDisabled();
  expect(input).toHaveAttribute('title', 'Search palette — v1.1');
});
```

- [ ] **Step 3: Run tests to confirm they fail**

Run: `cd frontend && npm test -- --run __tests__/header.test.tsx`
Expected: FAIL — no title attribute.

- [ ] **Step 4: Add the tooltip**

Edit `frontend/src/components/Header/Header.tsx:66-71`:
```tsx
      <input
        className={styles.search}
        placeholder="Jump to PR or file… ⌘K"
        title="Search palette — v1.1"
        disabled
        aria-label="Global search (placeholder)"
      />
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `cd frontend && npm test -- --run __tests__/header.test.tsx`
Expected: All PASS.

- [ ] **Step 6: Prettier-write + commit**

```bash
cd frontend && npx prettier --write src/components/Header/Header.tsx __tests__/header.test.tsx
cd D:/src/PRism/.claude/worktrees/design-parity-pr9b-density-search
git add frontend/src/components/Header/Header.tsx frontend/__tests__/header.test.tsx
git commit -m "feat(pr9b): global-search stub gets v1.1 tooltip (D101 closure)"
```

---

### Task 11: Playwright e2e — happy path + cross-tab + POST failure + baseline recapture

**Files:**
- Create: `frontend/e2e/specs/density-toggle.spec.ts` (happy path + POST-failure fold-in)
- Create: `frontend/e2e/specs/density-cross-tab.spec.ts` (focus-refetch sync)
- Re-capture: `frontend/e2e/__screenshots__/win32/settings-page.png`

- [ ] **Step 1: Write the happy-path spec**

Create `frontend/e2e/specs/density-toggle.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test.describe('Density mode toggle', () => {
  test('toggling density in Settings flips data-density attribute and persists across reload', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/settings');

    // Baseline: no attribute (comfortable is the default).
    await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/);

    // Toggle to compact.
    const select = page.getByLabel('Density');
    await select.selectOption('compact');
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');

    // Reload and confirm persistence (backend pref → config.json on disk).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact', { timeout: 10_000 });

    // Toggle back to comfortable and confirm attribute removed.
    await page.getByLabel('Density').selectOption('comfortable');
    await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/);
  });

  test('POST failure reverts the picker and surfaces a toast', async ({ page }) => {
    test.setTimeout(60_000);

    // Intercept the POST and fail it once. The second POST (the rollback re-set)
    // is not issued — usePreferences rolls back local state only on the failing
    // POST, so we only need the one-shot interceptor.
    await page.route('**/api/preferences', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 500, body: '{"error":"forced"}', contentType: 'application/json' });
      } else {
        await route.continue();
      }
    });

    await page.goto('/settings');
    await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/);

    await page.getByLabel('Density').selectOption('compact');

    // After the POST rejection, the rollback re-applies comfortable (attribute removed).
    await expect(page.locator('html')).not.toHaveAttribute('data-density', /.+/, { timeout: 10_000 });

    // Toast surfaces the failure (existing usePreferences error-toast contract).
    await expect(page.getByText(/Couldn't save preference/i)).toBeVisible({ timeout: 5_000 });
  });
});
```

- [ ] **Step 2: Write the cross-tab spec**

Create `frontend/e2e/specs/density-cross-tab.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test.describe('Density cross-tab sync', () => {
  test('toggling density in tab A propagates to tab B on focus refetch', async ({ browser }) => {
    test.setTimeout(90_000);

    const context = await browser.newContext();
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    await tabA.goto('/settings');
    await tabB.goto('/settings');

    // Baseline both tabs.
    await expect(tabA.locator('html')).not.toHaveAttribute('data-density', /.+/);
    await expect(tabB.locator('html')).not.toHaveAttribute('data-density', /.+/);

    // Toggle in tab A.
    await tabA.getByLabel('Density').selectOption('compact');
    await expect(tabA.locator('html')).toHaveAttribute('data-density', 'compact');

    // Focus tab B → usePreferences' window-focus listener refetches → HeaderControls'
    // useEffect on preferences fires → applyDensityToDocument flips the attribute.
    await tabB.bringToFront();
    await expect(tabB.locator('html')).toHaveAttribute('data-density', 'compact', { timeout: 10_000 });

    await context.close();
  });
});
```

- [ ] **Step 3: Run the specs**

Run: `cd frontend && npx playwright test specs/density-toggle.spec.ts specs/density-cross-tab.spec.ts`
Expected: All PASS. (Playwright's webServer config auto-starts backend + Vite per the project pattern.)

- [ ] **Step 4: Recapture the Settings page parity baseline**

The Settings page gains the Density row — `settings-page.png` will drift. Recapture:

Run: `cd frontend && npx playwright test --update-snapshots specs/parity-baselines.spec.ts -g "settings"`

(Adapt the `-g` filter to the actual baseline-test name. If `parity-baselines.spec.ts` does not have a `settings-page` test, locate the spec that captures `settings-page.png` and update it. Confirm the resulting `frontend/e2e/__screenshots__/win32/settings-page.png` shows Theme → Accent → Density → AI preview in order, with the density row legible.)

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/specs/density-toggle.spec.ts frontend/e2e/specs/density-cross-tab.spec.ts frontend/e2e/__screenshots__/win32/settings-page.png
git commit -m "test(pr9b): playwright e2e — density happy/failure/cross-tab + settings baseline recapture"
```

---

### Task 12: Documentation — spec correction + deferrals sidecar

**Files:**
- Modify: `docs/specs/2026-05-29-design-parity-recovery-design.md:453`
- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`

- [ ] **Step 1: Correct the spec persistence reference**

Grep for the literal string `prism.densityPreference` in `docs/specs/2026-05-29-design-parity-recovery-design.md` to confirm the line number (expect 453). Edit that line — replace `persistence (`prism.densityPreference` localStorage)` with `persistence (backend prefs via `/api/preferences`, mirrors theme/accent precedent; see deferrals sidecar D105 for rationale)`.

- [ ] **Step 2: Update D104 to note the line was corrected**

Grep for `D104` in `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`. Add a one-line note to D104 stating: "Spec line referenced in D104's rationale was amended to backend-prefs precedent under D105; the wording-pressure-test verdict is unchanged."

- [ ] **Step 3: Append D105 closure entry to deferrals sidecar**

Append to `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`:
```markdown
### D105 — PR9b-density+search SHIPPED

**Source:** PR9b-density+search implementation (2026-05-31).
**Spec position:** § 4.9.2 (PR9b family); closes D97 + D101 + spec § 4.9.2 line-453 persistence correction.
**Covers:**
- D97 (density mode toggle wiring) — SHIPPED via `UiConfig.Density` backend field + `applyDensityToDocument` util + `AppearanceSection` density picker + Playwright e2e (happy / failure / cross-tab) + recaptured `settings-page.png` parity baseline.
- D101 (global search bar stub-with-tooltip) — SHIPPED via `title="Search palette — v1.1"` on the disabled `<input>` at `Header.tsx:66-71`.
- Spec correction — § 4.9.2 line 453 updated from `prism.densityPreference` localStorage → backend prefs via `/api/preferences`. The spec's localStorage reference misnamed its own precedent (`applyThemeToDocument` + `usePreferences.set` already use backend prefs). See plan Deviation 1 for the rationale of why localStorage was rejected (FOUC / offline-survival / per-machine analysis).

**Verdict rationale:** Backend-prefs persistence chosen over localStorage because (a) all other `ui.*` prefs use backend prefs; (b) cross-tab + cross-account-instance sync via the existing focus-refetch contract is free; (c) one DTO field + one allowlist entry + one type-union extension is paved infrastructure. Backend allowlist accepts arbitrary `density` strings (theme/accent share this gap — see plan Deviation 6); deferred to a follow-up that adds enum validation across all closed-union string fields.

**Status:** SHIPPED in PR9b-density+search.
**Cross-refs:** D97, D101, D104; spec § 4.9.2 line 453; `applyTheme.ts`; `usePreferences.ts`; `ConfigStore._allowedFields`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-05-29-design-parity-recovery-design.md docs/specs/2026-05-29-design-parity-recovery-deferrals.md
git commit -m "docs(pr9b): spec correction + D105 closure entry (D97 + D101 shipped)"
```

---

### Task 13: Pre-push checklist + mock-fixture sweep + PR-body deviation paragraph

**Files:**
- All previously-committed changes; sweep across `frontend/__tests__/`.

- [ ] **Step 0: Mock-fixture sweep**

Extending `UiPreferences` with a required `density: Density` field will break every test fixture that constructs a `ui: { theme, accent, aiPreview }` object literal. Run the sweep:

```bash
cd frontend && grep -rn "ui: { theme" __tests__/ src/
```

Known sites to update (add `density: 'comfortable'`):
- `frontend/__tests__/header.test.tsx`
- `frontend/__tests__/HeaderControls.test.tsx`
- `frontend/__tests__/Settings/SettingsPage.test.tsx`
- `frontend/__tests__/Settings/ConnectionSection.test.tsx`
- `frontend/__tests__/Settings/AuthSection.test.tsx` (if present — grep)
- `frontend/__tests__/Settings/AppearanceSection.test.tsx` (already added in Task 9)

Append the field to each fixture. Order: after `aiPreview`, value `'comfortable'`.

Commit the fixture sweep:
```bash
git add frontend/__tests__
git commit -m "test(pr9b): extend ui mock fixtures with density field"
```

- [ ] **Step 1: Run `dotnet test` full suite**

Run: `dotnet test --configuration Debug --no-restore`
Expected: All green. Diff the test count vs Task 1 baseline — should be +5 (Tasks 3+4+5 added 5 backend tests).

- [ ] **Step 2: Run `npm test` full vitest suite**

Run: `cd frontend && npm test -- --run`
Expected: All green. Diff vs Task 1 baseline — should be +6 to +8 (Task 7 +3, Task 9 +3, Task 10 +1, possibly +1 for fixture extensions).

- [ ] **Step 3: Run `npm run lint` (includes prettier --check)**

Run: `cd frontend && npm run lint`
Expected: 0 errors.

- [ ] **Step 4: Run `npm run build`**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no warnings.

- [ ] **Step 5: Run Playwright suite**

Run: `cd frontend && npx playwright test`
Expected: All green. Diff vs Task 1 baseline — should be +3 specs (density-toggle.spec.ts has 2 tests, density-cross-tab.spec.ts has 1).

- [ ] **Step 6: Final commit if anything moved**

If lint or build surfaced any drift not caught by per-task tests, fix in-place and commit:
```bash
git add <files>
git commit -m "fix(pr9b): pre-push checklist cleanup"
```

- [ ] **Step 7: Draft the PR-body Deviation 1 paragraph**

Before pushing, draft the PR body's deviation paragraph so pr-autopilot's preflight subagent + Copilot + claude[bot] each see the same stable rationale for the spec-line correction landing in the same PR. Paragraph for the PR body's "Deviations from spec" section:

> **Deviation 1 — Density persistence: backend prefs, not localStorage.** Spec § 4.9.2 line 453 named the precedent as `prism.densityPreference` localStorage. This misnames the actual code precedent: `applyThemeToDocument` + `usePreferences.set` already persist `ui.*` keys (theme, accent, aiPreview) through `/api/preferences` → `ConfigStore.PatchAsync` → on-disk `config.json`. Three plausible localStorage rationales (FOUC on cold load, tray-down survival, per-machine variance) were considered and rejected (see plan Deviation 1). The spec line is corrected to backend-prefs language in this same PR (Task 12) so a future reader does not chase a misnamed precedent. Rollback semantics: a revert of this PR re-introduces the localStorage misnomer in the spec text — accepted because PRism is single-user and rollback is local-only.

Keep this paragraph stable; do not paraphrase between iterations.

- [ ] **Step 8: Push for pr-autopilot pickup**

```bash
git push -u origin design-parity-recovery-pr9b-density-and-search
```

(`pr-autopilot` then handles Phase 1-5 per its own workflow. Include the Step 7 paragraph in the PR body.)

---

## Self-review checklist (run before declaring the plan ready)

1. **Spec coverage** — Every D97 + D101 closure criterion has a corresponding Task. ✅
2. **Placeholder scan** — Search for "TBD", "TODO", "implement later", "fill in details". Should find zero. ✅
3. **Type consistency** — `Density` type used consistently as `'comfortable' | 'compact'`; `applyDensityToDocument` signature stable across Task 7 + 8 + 9; `usePreferences.set('density', value)` shape stable across Task 6 + 9. ✅
4. **TDD ordering** — Every code-introducing task has a "write failing test" step BEFORE the implementation step. ✅
5. **Commit cadence** — One commit per task with a focused message. ✅
6. **No silent fallbacks** — Density default-on-missing is explicitly tested in Task 4. Spec correction is explicitly documented in Task 12 + Deviation 1 + D105 entry. ✅
7. **`comfortable` literal duplication** — appears in 4 places (UiConfig param default, AppConfig.Default seed, Task 4 legacy-config assertion, Playwright baseline assertion). Matches the theme/accent precedent of hardcoded defaults; not factored into a const. Acceptable for v1. ✅
8. **Pre-push checklist** — Task 13 hits dotnet test, npm test, npm run lint, npm run build, npx playwright test per project CLAUDE.md `.ai/docs/development-process.md` pattern. ✅
9. **Vitest path convention** — All new test files at `frontend/__tests__/`, not colocated `src/**/__tests__/`. ✅
10. **Test factory name** — `PRismWebApplicationFactory` (not `PRismTestFactory`); FluentAssertions style aligned with existing `PreferencesEndpointsTests.cs`. ✅
11. **IA order in AppearanceSection** — Theme → Accent → Density → AI preview (visual chrome controls grouped before functional toggle). ✅

## Open follow-ons (NOT in PR9b-density+search scope)

- **PR9b-ai-gating** (D87 — covers D24, D28, D32a, D48) — separate sub-PR, requires its own brainstorm pass because the per-file focus-dot data path doesn't exist in `PrSummary` yet.
- **Backend enum validation** for closed-union string fields (theme, accent, density) — see Deviation 6. Gap is inherited from the existing theme/accent allowlist shape. A small follow-up adds allowed-values to `ConfigFieldType` + per-key validation in `PatchAsync`.
- **PreferencesContext deferral from S6 PR #71** — 4× parallel GETs per focus on `/settings` (each `usePreferences()` consumer triggers an independent fetch). Adding density's boot-effect adds zero new fetch sites (HeaderControls was already a consumer for theme+accent); the existing 4× problem is unchanged. Refactor remains open but is not gated on this PR.
- **`Search palette — v1.1` tooltip refresh** — if v1.1 scope shifts and the search-palette wiring is deferred to v1.2, the tooltip needs updating. Revisit before the v1.1 cut.
- **First publish.yml workflow_dispatch with tag v0.1.0** — carried from PR #82.
- **`pr-detail-overview` baseline regression investigation** — surfaced during PR9a Task 11.
- **D85 a11y bundle** — roving-tabindex + Backspace/Delete close for PrTabStrip; resolves D43/D44/D45/D104 and unmasks `continue-on-error: true` in ci.yml.
