# First-run AI onboarding overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-time, first-run dialog overlaid on the loading inbox that introduces the three AI modes (Off / Preview / Live) and lets a fresh user choose — Preview kept, Live opted into (with the full egress disclosure inline), or AI turned Off — while the GitHub inbox fetches behind it.

**Architecture:** A thin presentation layer over existing V2 machinery (the `AiMode` tri-state, `AiConsentState` egress gate, and the consent API) plus exactly one new persisted flag, `OnboardingSeen`. Backend adds the flag, its patch path, its DTO projection, and a one-time key-absence backfill. Frontend extracts the egress callout into a shared `EgressDisclosureBody`, builds a new `AiOnboardingDialog` (pending-selection commit model, adaptive button, inline Live disclosure state machine), and mounts it inside `InboxPage`.

**Tech Stack:** .NET 10 minimal API + records (`PRism.Core`, `PRism.Web`), xUnit + FluentAssertions; React 18 + Vite + TypeScript, vitest + @testing-library + userEvent, Playwright (prod project). CSS modules + `styles/tokens.css` (oklch, `[data-theme]`).

## Global Constraints

- **Branch base is `V2`.** This worktree (`feat/ai-onboarding-overlay`) is already cut from `origin/V2`. All work lands here; raise the PR with `--base V2`. Never push to `V2` directly (protected branch).
- **`OnboardingSeen` is a UX-suppression flag ONLY.** It MUST NEVER be read by any AI seam, capability resolver, or gate, and MUST NEVER be used as a consent or egress predicate. `AiConsentState.IsConsented(providerId, currentDisclosureVersion)` remains the **sole** authoritative egress gate. Add a code comment to that effect on the field.
- **No navigate-path may ever commit Live without explicit version-matched consent.** Only the adaptive primary button commits a mode; `Manage AI settings →` and Esc commit nothing.
- **The server-side egress gate is the seam selector, not the mode preference — and it already exists.** `AiSeamSelector` resolves `Live → real impl` only when `_consent.IsConsented(AiProviderIds.Claude, AiDisclosure.CurrentVersion)` is true, otherwise `Noop` (verified: `PRism.Core/Ai/AiSeamSelector.cs:45-51`; `AiCapabilityResolver.cs:56` mirrors it). So `ui.ai.mode = live` persisted **without** a current-version consent record produces **zero egress** — the seam falls back to Noop. This feature relies on that pre-existing, unbypassable gate and must not weaken it. (A write-layer guard rejecting `ui.ai.mode=live` at `POST /api/preferences` when not consented is defense-in-depth, **out of scope** here — it belongs to the AI-consent epic, and the egress gate does not depend on it.)
- **Disclosure content is fixed** by `PRism.Web/Endpoints/EgressDisclosure.cs` (`Recipient = "Anthropic, via the Claude Code CLI"`; categories = PR diff / Title / Description; `CurrentVersion = "1"`). Never paraphrase it; render it from `getEgressDisclosure`.
- **Egress provider + version constants:** `AiProviderIds.Claude = "claude-code"`; `AiDisclosure.CurrentVersion = "1"`.
- **Preference write semantics:** apply-on-success (no optimistic write). `POST /api/preferences` patches exactly one field per call.
- **Pre-push checklist (`.ai/docs/development-process.md`) runs verbatim before any push.** Backend: `dotnet build` + `dotnet test`. Frontend: `npm run lint` (includes `prettier --check`), `tsc -b` (NOT `tsc --noEmit` — vacuous here), the local vitest binary (NOT `npx vitest`), and the Playwright prod project via `.bin/playwright`.
- **Copy is provisional** and may be tightened during implementation; the disclosure content is the one exception (fixed above).

---

## File structure

**Backend (create: none — all modifications):**
- `PRism.Core/Config/AppConfig.cs` — add `bool? OnboardingSeen` to the `AiConfig` record.
- `PRism.Core/Config/ConfigStore.cs` — allowlist entry, patch arm, one-time backfill.
- `PRism.Web/Endpoints/PreferencesDtos.cs` — add `OnboardingSeen` to `UiPreferencesDto`.
- `PRism.Web/Endpoints/PreferencesEndpoints.cs` — add the projection field.

**Backend tests:**
- `tests/PRism.Core.Tests/Config/ConfigStoreOnboardingSeenTests.cs` — **create** (backfill + patch + no-recompute).
- `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` — modify (patch round-trip + DTO serialization).

**Frontend (create):**
- `frontend/src/components/Settings/EgressDisclosureBody.tsx` — extracted callout + skeleton.
- `frontend/src/components/Settings/EgressDisclosureBody.module.css` — moved callout/skeleton CSS.
- `frontend/src/components/Ai/AiOnboardingDialog.tsx` — the dialog.
- `frontend/src/components/Ai/AiOnboardingDialog.module.css` — color-coded segments + legend.
- `frontend/src/components/Ai/AiOnboardingDialog.test.tsx` — component tests.
- `frontend/src/components/Settings/EgressDisclosureBody.test.tsx` — shared-body tests.
- `frontend/tests/e2e/ai-onboarding.spec.ts` (or the repo's e2e dir convention) — E2E + visual.

**Frontend (modify):**
- `frontend/src/components/Settings/EgressConsentModal.tsx` (+ `.module.css`) — consume the shared body.
- `frontend/src/components/controls/SegmentedControl.tsx` — add `selectedDataRole?` prop.
- `frontend/src/api/types.ts` — add `onboardingSeen` to the `UiPreferences` interface.
- `frontend/src/contexts/PreferencesContext.tsx` — add `'ui.ai.onboardingSeen'` to the `PreferenceKey` union (it is a **closed** union and lives here, not in `types.ts`; the edit is mandatory or `set('ui.ai.onboardingSeen', …)` is a TS error).
- `frontend/src/pages/InboxPage.tsx` — mount the overlay + gate.

---

## Task 1: Backend — `OnboardingSeen` field, allowlist, patch arm, DTO projection

**Files:**
- Modify: `PRism.Core/Config/AppConfig.cs:91-97` (the `AiConfig` record)
- Modify: `PRism.Core/Config/ConfigStore.cs:33-65` (allowlist), `:223-258` (patch switch)
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs:24-26` (`UiPreferencesDto`)
- Modify: `PRism.Web/Endpoints/PreferencesEndpoints.cs:71-89` (projection)
- Test: `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs`

**Interfaces:**
- Produces: `AiConfig.OnboardingSeen` of type `bool?` (null = "not yet determined / key absent on disk"); allowlist key `"ui.ai.onboardingSeen"` (`ConfigFieldType.Bool`); `UiPreferencesDto.OnboardingSeen` of type `bool` (serializes camelCase `onboardingSeen`, flat under `ui`).
- Consumed by: Task 2 (backfill reads/sets the nullable field); the frontend (`preferences.ui.onboardingSeen` read; `ui.ai.onboardingSeen` patch).

**Design note (why `bool?`):** STJ deserializes a missing `onboardingSeen` to the constructor default, indistinguishable from an explicit value. Making the field `bool?` with the record default `null` lets the backfill (Task 2) detect "key absent on disk" as `OnboardingSeen is null`, exactly mirroring the existing `Consent is null` / `Features is null` backfill idiom in `ReadFromDiskAsync`. The DTO projects `?? false` so the wire value is always a concrete bool.

- [ ] **Step 1: Write the failing endpoint test (patch round-trip)**

Add to `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` (mirror the existing dotted-path test at `:118-137`):

```csharp
[Fact]
public async Task POST_ui_ai_onboardingSeen_is_allowlisted_and_round_trips()
{
    using var factory = new PRismWebApplicationFactory();
    var client = factory.CreateClient();
    var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);
    using var content = new StringContent(
        """{ "ui.ai.onboardingSeen": true }""",
        System.Text.Encoding.UTF8,
        "application/json");
    using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/preferences", UriKind.Relative))
    {
        Content = content,
    };
    req.Headers.Add("Origin", origin);
    var resp = await client.SendAsync(req);

    resp.StatusCode.Should().Be(HttpStatusCode.OK); // NOT 400 — proves the dotted path is in the allowlist
    var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
    body.GetProperty("ui").GetProperty("onboardingSeen").GetBoolean().Should().BeTrue();
}
```

- [ ] **Step 2: Run it; verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~POST_ui_ai_onboardingSeen_is_allowlisted_and_round_trips"`
Expected: FAIL — `ConfigPatchException: unknown field: ui.ai.onboardingSeen` → 400, assertion on OK fails (and `onboardingSeen` is absent from the DTO).

- [ ] **Step 3: Add the field to `AiConfig`**

In `PRism.Core/Config/AppConfig.cs`, extend the `AiConfig` record (the field order is positional; append as a trailing-defaulted param like the existing numeric tuning fields):

```csharp
public sealed record AiConfig(
    AiMode Mode,
    AiConsentConfig Consent,
    AiFeaturesConfig Features,
    int HunkAnnotationCap = 10,
    int ProviderTimeoutSeconds = 240,
    int SummaryMaxChars = 1000,
    // UX-suppression flag for the first-run AI onboarding overlay ONLY.
    // null = key absent on disk (pre-feature config) → Task-2 backfill computes it once.
    // MUST NOT be read by any AI seam, capability resolver, or egress gate.
    // AiConsentState.IsConsented(...) remains the sole authoritative egress gate.
    bool? OnboardingSeen = null);
```

Confirm `AppConfig.Default` does not pass `OnboardingSeen` (leaves it `null` = undetermined; a fresh no-file install therefore shows the dialog via the DTO's `?? false`). If `AppConfig.Default` constructs `AiConfig` with named args, do not add `OnboardingSeen` there.

- [ ] **Step 4: Add the allowlist entry**

In `ConfigStore.cs`, inside `_allowedFields` (after the `ui.ai.summaryMaxChars` line at `:64`):

```csharp
["ui.ai.onboardingSeen"]             = ConfigFieldType.Bool,
```

- [ ] **Step 5: Add the patch switch arm**

In `ConfigStore.PatchAsync`'s `key switch` (`:223-258`), add an arm (next to `ui.ai.mode`):

```csharp
"ui.ai.onboardingSeen" =>
    _current with { Ui = ui with { Ai = ui.Ai with { OnboardingSeen = (bool)value! } } },
```

- [ ] **Step 6: Add the DTO field**

In `PRism.Web/Endpoints/PreferencesDtos.cs`, append `bool OnboardingSeen` to `UiPreferencesDto`:

```csharp
internal sealed record UiPreferencesDto(
    string Theme, string Accent, bool AiPreview, string AiMode, string Density, string ContentScale,
    int ProviderTimeoutSeconds, int HunkAnnotationCap, int SummaryMaxChars, bool OnboardingSeen);
```

- [ ] **Step 7: Add the projection**

In `PreferencesEndpoints.cs`, the `UiPreferencesDto(...)` construction (`:71-89`), append as the final positional argument (after the `SummaryMaxChars` line):

```csharp
        OnboardingSeen: ui.Ai.OnboardingSeen ?? false),
```

- [ ] **Step 8: Run the test; verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~POST_ui_ai_onboardingSeen_is_allowlisted_and_round_trips"`
Expected: PASS.

- [ ] **Step 9: Add a DTO-serialization unit test**

Add to the same endpoints test file — assert the default `GET /api/preferences` response carries `ui.onboardingSeen` as a camelCase bool:

```csharp
[Fact]
public async Task GET_preferences_serializes_onboardingSeen_camelCase_under_ui()
{
    using var factory = new PRismWebApplicationFactory();
    var client = factory.CreateClient();
    var body = await client.GetFromJsonAsync<JsonElement>("/api/preferences");
    body.GetProperty("ui").TryGetProperty("onboardingSeen", out var seen).Should().BeTrue();
    seen.ValueKind.Should().BeOneOf(JsonValueKind.True, JsonValueKind.False);
}
```

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~onboardingSeen"`
Expected: PASS (both tests).

- [ ] **Step 10: Commit**

```bash
git add PRism.Core/Config/AppConfig.cs PRism.Core/Config/ConfigStore.cs PRism.Web/Endpoints/PreferencesDtos.cs PRism.Web/Endpoints/PreferencesEndpoints.cs tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs
git commit -m "feat(ai): persist OnboardingSeen flag + preferences patch path (#485)"
```

---

## Task 2: Backend — one-time key-absence backfill + consent-conflation guard

**Files:**
- Modify: `PRism.Core/Config/ConfigStore.cs` (`ReadFromDiskAsync` backfill block, near `:387-405`; uses the existing `rewritten` write-back flag)
- Create: `tests/PRism.Core.Tests/Config/ConfigStoreOnboardingSeenTests.cs`

**Interfaces:**
- Consumes: `AiConfig.OnboardingSeen` (`bool?`, from Task 1); `AiProviderIds.Claude`, `AiDisclosure.CurrentVersion`; `AiConsentState.IsConsented(string, string)`.
- Produces: a config whose `Ui.Ai.OnboardingSeen` is non-null after load (computed once on key-absence, then authoritative).

**Backfill rule (spec §8.1):** applied **only when `OnboardingSeen is null`** (key absent on disk). Once present, never recomputed.

```
OnboardingSeen = IsConsented(Claude, CurrentVersion)  ||  (Mode == Off)
```
- consent recorded (valid, current version) → `true`
- `Mode == Off` → `true`
- `Mode == Preview` → `false` (fresh-style; show the dialog once)
- `Mode == Live` but no valid consent → `false` (**security correction** — show the dialog so the egress gate is re-established; never silently leave Live ungated)

- [ ] **Step 1: Write the failing backfill tests**

Create `tests/PRism.Core.Tests/Config/ConfigStoreOnboardingSeenTests.cs` (mirror `ConfigStoreAiBackfillTests.cs` setup — `TempDataDir`, write a `config.json`, `new ConfigStore(dir.Path)`, `InitAsync`):

```csharp
using System.IO;
using System.Threading;
using FluentAssertions;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStoreOnboardingSeenTests
{
    private static async Task<ConfigStore> LoadAsync(string json)
    {
        var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), json);
        var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);
        return store; // TempDataDir is intentionally leaked to the test process lifetime; mirror the sibling tests' disposal pattern if they dispose.
    }

    [Fact]
    public async Task KeyAbsent_modePreview_backfillsFalse()
    {
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"preview" },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(false);
    }

    [Fact]
    public async Task KeyAbsent_modeOff_backfillsTrue()
    {
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"off" },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(true);
    }

    [Fact]
    public async Task KeyAbsent_consentRecordedCurrentVersion_backfillsTrue()
    {
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"live","consent": { "providerId":"claude-code","disclosureVersion":"1","acknowledgedAt":"2026-01-01T00:00:00+00:00" } },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(true);
    }

    [Fact]
    public async Task KeyAbsent_modeLive_withoutValidConsent_backfillsFalse()
    {
        // Security correction: mode=live but no consent record → show the dialog (do NOT suppress).
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"live" },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(false);
    }

    [Fact]
    public async Task KeyAbsent_modeLive_staleConsentVersion_backfillsFalse()
    {
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"live","consent": { "providerId":"claude-code","disclosureVersion":"0","acknowledgedAt":"2026-01-01T00:00:00+00:00" } },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(false);
    }

    [Fact]
    public async Task KeyPresentFalse_isLeftUntouched_noRecompute()
    {
        // mode=off would backfill TRUE, but the explicit stored false must win (no recompute once present).
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"off","onboardingSeen":false },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(false);
    }

    [Fact]
    public async Task KeyPresentTrue_isLeftUntouched()
    {
        using var store = await LoadAsync(
            """{ "ui": { "theme":"system","accent":"indigo","ai": { "mode":"preview","onboardingSeen":true },"density":"comfortable" } }""");
        store.Current.Ui.Ai.OnboardingSeen.Should().Be(true);
    }
}
```

> Note: confirm the on-disk consent JSON shape (`providerId` / `disclosureVersion` / `acknowledgedAt`) against `AiConsentConfig` and an existing consent-fixture test before running; adjust property names if the serialized casing differs.

- [ ] **Step 2: Run them; verify they fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStoreOnboardingSeenTests"`
Expected: FAIL — `OnboardingSeen` is `null` after load (no backfill yet) on every case.

- [ ] **Step 3: Construct the consent state via its real surface (verified)**

`AiConsentState` has **only a parameterless constructor** plus a `Set(AiConsentConfig)` method and a `Current` getter — there is NO constructor taking an `AiConsentConfig` (verified: every call site, e.g. `ServiceCollectionExtensions.cs:64-65`, uses `new AiConsentState()` then `.Set(consent)`). Constructing it any other way is a CS1729 build break. Use `new AiConsentState(); state.Set(consent); state.IsConsented(...)` everywhere in this task so the egress predicate is the canonical one (never re-implemented inline).

- [ ] **Step 4: Add the backfill block**

In `ConfigStore.ReadFromDiskAsync`, after the existing `Consent`/`Features` nested backfill (the `else { var ai = parsed.Ui.Ai; ... }` block near `:387-405`), add a key-absence backfill that sets `rewritten = true` so the computed value is written back once:

```csharp
// One-time onboarding backfill (spec §8.1). Runs ONLY when the key is absent on disk
// (OnboardingSeen is null). Once present, the stored value is authoritative — never
// recomputed (a per-load recompute would re-show the overlay forever to a Preview-keeper
// whose seen-write didn't persist). Mirrors the Consent/Features key-absence backfills above.
if (parsed.Ui.Ai is not null && parsed.Ui.Ai.OnboardingSeen is null)
{
    var ai = parsed.Ui.Ai;
    var consent = new AiConsentState();
    consent.Set(ai.Consent ?? AppConfig.Default.Ui.Ai.Consent);
    var seen = consent.IsConsented(AiProviderIds.Claude, AiDisclosure.CurrentVersion)
               || ai.Mode == AiMode.Off;
    parsed = parsed with { Ui = parsed.Ui with { Ai = ai with { OnboardingSeen = seen } } };
    rewritten = true;
}
```

Add `using PRism.Core.Ai;` if not already present.

- [ ] **Step 5: Run the backfill tests; verify they pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStoreOnboardingSeenTests"`
Expected: PASS (all 7).

- [ ] **Step 6: Add the bidirectional consent-conflation guard test**

Prove `OnboardingSeen` does not flow through the consent gate in **either** direction (a `false` flag must not gate Live off when consent is valid; a `true` flag must not gate Live on when consent is absent). Add to the same test file (note the `new AiConsentState(); .Set(...)` construction — there is no config-taking ctor):

```csharp
private static AiConsentState Gate(AiConsentConfig consent)
{
    var s = new AiConsentState();
    s.Set(consent);
    return s;
}

[Fact]
public async Task OnboardingSeen_false_doesNotGateLiveOff_whenConsented()
{
    var json = """{ "ui": { "ai": { "mode":"live","consent": { "providerId":"claude-code","disclosureVersion":"1","acknowledgedAt":"2026-01-01T00:00:00+00:00" },"onboardingSeen":false } } }""";
    using var store = await LoadAsync(json);
    Gate(store.Current.Ui.Ai.Consent).IsConsented("claude-code", "1").Should().BeTrue();
}

[Fact]
public async Task OnboardingSeen_true_doesNotGateLiveOn_whenNotConsented()
{
    // The critical inverse: a UX flag of true with NO consent record must never enable egress.
    var json = """{ "ui": { "ai": { "mode":"live","onboardingSeen":true } } }""";
    using var store = await LoadAsync(json);
    Gate(store.Current.Ui.Ai.Consent).IsConsented("claude-code", "1").Should().BeFalse();
}
```

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~OnboardingSeen"`
Expected: PASS.

- [ ] **Step 7: Add a fresh-no-file round-trip test (absence-detection regression pin)**

A brand-new install hits the `!File.Exists` branch, which writes `AppConfig.Default` (with `OnboardingSeen` null) **before** the post-deserialize backfill runs — so the first on-disk `config.json` carries an explicit `null`, and the value resolves to `false` only on the *next* load's backfill. Pin that chain so a future serializer change (e.g. adding `DefaultIgnoreCondition`) can't silently break absence-detection:

```csharp
[Fact]
public async Task FreshNoFileInstall_roundTrips_toSeenFalse_onReload()
{
    using var dir = new TempDataDir();
    // First init: no file → writes Default (OnboardingSeen null on disk).
    using (var first = new ConfigStore(dir.Path))
        await first.InitAsync(CancellationToken.None);
    // Second init: re-reads the written file; key absent/null → backfill computes false (mode=Preview default).
    using var second = new ConfigStore(dir.Path);
    await second.InitAsync(CancellationToken.None);
    second.Current.Ui.Ai.OnboardingSeen.Should().Be(false);
}
```

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~FreshNoFileInstall_roundTrips"`
Expected: PASS. (If `AppConfig.Default.Ui.Ai.Mode` is not `Preview`, adjust the expected value to match the backfill rule.)

- [ ] **Step 8: Full backend build + test**

Run: `dotnet build` then `dotnet test` (timeout ≥ 300000ms, foreground).
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Config/ConfigStoreOnboardingSeenTests.cs
git commit -m "feat(ai): one-time onboardingSeen backfill (consent OR mode==Off) (#485)"
```

---

## Task 3: Frontend — extract `EgressDisclosureBody` + `EgressDisclosureSkeleton`

**Files:**
- Create: `frontend/src/components/Settings/EgressDisclosureBody.tsx`
- Create: `frontend/src/components/Settings/EgressDisclosureBody.module.css`
- Create: `frontend/src/components/Settings/EgressDisclosureBody.test.tsx`
- Modify: `frontend/src/components/Settings/EgressConsentModal.tsx`, `EgressConsentModal.module.css`

**Interfaces:**
- Produces:
  - `EgressDisclosureBody({ disclosure }: { disclosure: EgressDisclosure })` — renders the amber callout (warning glyph + "Sent off your device to **{recipient}**:" + the `dataCategories` bullet list). No lead sentence (each host supplies its own).
  - `EgressDisclosureSkeleton()` — the loading-state skeleton rows (≈2 lead + 3 callout) used by both hosts.
- Consumed by: `EgressConsentModal` (this task) and `AiOnboardingDialog` (Tasks 6–7).

- [ ] **Step 1: Write the failing shared-body test**

Create `frontend/src/components/Settings/EgressDisclosureBody.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EgressDisclosureBody } from './EgressDisclosureBody';
import type { EgressDisclosure } from '../../api/aiConsent';

const disclosure: EgressDisclosure = {
  recipient: 'Anthropic, via the Claude Code CLI',
  dataCategories: ['Pull request diff (changed files and their contents)', 'Title', 'Description'],
  disclosureVersion: '1',
  alreadyConsented: false,
};

describe('EgressDisclosureBody', () => {
  it('renders the recipient and every data category', () => {
    render(<EgressDisclosureBody disclosure={disclosure} />);
    expect(screen.getByText('Anthropic, via the Claude Code CLI')).toBeInTheDocument();
    for (const c of disclosure.dataCategories) {
      expect(screen.getByText(c)).toBeInTheDocument();
    }
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run the local vitest binary (NOT `npx vitest`):
`./frontend/node_modules/.bin/vitest run src/components/Settings/EgressDisclosureBody.test.tsx` (from `frontend/`)
Expected: FAIL — module not found.

- [ ] **Step 3: Create the CSS module**

Create `frontend/src/components/Settings/EgressDisclosureBody.module.css` with the callout + skeleton rules moved verbatim from `EgressConsentModal.module.css`:

```css
.callout {
  margin: var(--s-3) 0;
  padding: var(--s-4);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-left: 3px solid var(--warning);
  border-radius: var(--radius-3);
}
.calloutHead {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  color: var(--text-1);
  line-height: 1.5;
}
.calloutIcon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--warning-fg);
}
.recipient {
  font-weight: 600;
}
.dataList {
  list-style: none;
  margin: var(--s-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}
.dataItem {
  position: relative;
  padding-left: var(--s-4);
  color: var(--text-2);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.dataItem::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0.62em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-3);
}
.skeletonCallout {
  margin: var(--s-3) 0;
  padding: var(--s-4);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-left: 3px solid var(--border-2);
  border-radius: var(--radius-3);
}
```

- [ ] **Step 4: Create the component**

Create `frontend/src/components/Settings/EgressDisclosureBody.tsx` (move the `WarningTriangleIcon` glyph here verbatim from `EgressConsentModal.tsx:16-36`; it is part of the callout):

```tsx
import { Skeleton } from '../Skeleton/Skeleton';
import type { EgressDisclosure } from '../../api/aiConsent';
import styles from './EgressDisclosureBody.module.css';

// Decorative inline glyph (aria-hidden) — no central icon set in this repo.
function WarningTriangleIcon({ className }: { className?: string }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" className={className}>
      <path d="M8 1.75 14.5 13.5H1.5L8 1.75Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.25V9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.85" fill="currentColor" />
    </svg>
  );
}

export function EgressDisclosureBody({ disclosure }: { disclosure: EgressDisclosure }) {
  return (
    <div className={styles.callout}>
      <div className={styles.calloutHead}>
        <WarningTriangleIcon className={styles.calloutIcon} />
        <span>
          Sent off your device to <strong className={styles.recipient}>{disclosure.recipient}</strong>:
        </span>
      </div>
      <ul className={styles.dataList}>
        {disclosure.dataCategories.map((c) => (
          <li key={c} className={styles.dataItem}>
            {c}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EgressDisclosureSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only" aria-live="polite">
        Loading data-sharing disclosure…
      </span>
      <Skeleton height={14} />
      <Skeleton height={14} width="70%" />
      <div className={styles.skeletonCallout}>
        <Skeleton height={14} width="55%" />
        <Skeleton height={12} width="80%" />
        <Skeleton height={12} width="45%" />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the shared-body test; verify it passes**

Run: `./frontend/node_modules/.bin/vitest run src/components/Settings/EgressDisclosureBody.test.tsx`
Expected: PASS.

- [ ] **Step 6: Refactor `EgressConsentModal` to consume the shared body**

In `EgressConsentModal.tsx`: remove the local `WarningTriangleIcon` and the inline callout/skeleton JSX; import and use the shared pieces. The lead `<p>` stays (modal-specific copy). Replace the loaded-state block (`:135-157`) with the shared body and the skeleton block (`:122-134`) with the shared skeleton:

```tsx
import { EgressDisclosureBody, EgressDisclosureSkeleton } from './EgressDisclosureBody';
// ...
{failed ? (
  <ErrorBox message="Couldn't load the data-sharing disclosure. Close and try again." />
) : !disclosure ? (
  <EgressDisclosureSkeleton />
) : (
  <div>
    <p className={styles.lead}>
      Live AI generates a real, diff-grounded summary of this pull request.
    </p>
    <EgressDisclosureBody disclosure={disclosure} />
  </div>
)}
```

Remove the now-unused `.callout`, `.calloutHead`, `.calloutIcon`, `.recipient`, `.dataList`, `.dataItem`, `.skeletonCallout` rules and the `Skeleton` import from `EgressConsentModal` (keep `.lead`, `.errBox`, `.errIcon`, `.declineBtn`, `.enableBtn`). Run eslint to confirm no `no-unused-vars`.

- [ ] **Step 7: Run the existing `EgressConsentModal` tests; verify no regression**

Run: `./frontend/node_modules/.bin/vitest run src/components/Settings/EgressConsentModal.test.tsx`
Expected: PASS (behavior unchanged — same rendered recipient + categories).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/Settings/EgressDisclosureBody.tsx frontend/src/components/Settings/EgressDisclosureBody.module.css frontend/src/components/Settings/EgressDisclosureBody.test.tsx frontend/src/components/Settings/EgressConsentModal.tsx frontend/src/components/Settings/EgressConsentModal.module.css
git commit -m "refactor(ai): extract shared EgressDisclosureBody from consent modal (#485)"
```

---

## Task 4: Frontend — `SegmentedControl` `selectedDataRole` prop

**Files:**
- Modify: `frontend/src/components/controls/SegmentedControl.tsx:9-17` (props), `:59-82` (option render)
- Test: co-located `frontend/src/components/controls/SegmentedControl.test.tsx` (create if absent; check first)

**Interfaces:**
- Produces: optional prop `selectedDataRole?: string` on `SegmentedControlProps`. When set, the **selected** radio (and only it) renders `data-modal-role={selectedDataRole}`. Lets a `Modal` host designate the selected segment as the `defaultFocus` target without `SegmentedControl` knowing about Modal.
- Consumed by: `AiOnboardingDialog` (Task 6) passes `selectedDataRole="cancel"`.

- [ ] **Step 1: Write the failing test**

Add to `SegmentedControl.test.tsx` (create the file with the standard vitest + testing-library imports if it does not exist):

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SegmentedControl } from './SegmentedControl';

const opts = [
  { value: 'off', label: 'Off' },
  { value: 'preview', label: 'Preview' },
  { value: 'live', label: 'Live' },
] as const;

describe('SegmentedControl selectedDataRole', () => {
  it('marks only the selected radio with data-modal-role', () => {
    render(
      <SegmentedControl
        label="AI mode"
        options={opts}
        value="preview"
        onChange={vi.fn()}
        selectedDataRole="cancel"
      />,
    );
    expect(screen.getByRole('radio', { name: 'Preview' })).toHaveAttribute('data-modal-role', 'cancel');
    expect(screen.getByRole('radio', { name: 'Off' })).not.toHaveAttribute('data-modal-role');
  });

  it('adds no attribute when the prop is omitted', () => {
    render(<SegmentedControl label="AI mode" options={opts} value="preview" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Preview' })).not.toHaveAttribute('data-modal-role');
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `./frontend/node_modules/.bin/vitest run src/components/controls/SegmentedControl.test.tsx`
Expected: FAIL — attribute absent.

- [ ] **Step 3: Add the prop + render the attribute**

In `SegmentedControl.tsx`, add to `SegmentedControlProps`:

```tsx
  /** When set, the selected radio carries data-modal-role={value} (lets a Modal host focus it on open). */
  selectedDataRole?: string;
```

Destructure `selectedDataRole` in the component signature, and in the option `<button>` (`:62-78`) add the attribute conditionally on the selected radio:

```tsx
      data-modal-role={selected ? selectedDataRole : undefined}
```

(`selected` is already computed at `:60`.)

- [ ] **Step 4: Run the test; verify it passes**

Run: `./frontend/node_modules/.bin/vitest run src/components/controls/SegmentedControl.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/controls/SegmentedControl.tsx frontend/src/components/controls/SegmentedControl.test.tsx
git commit -m "feat(controls): SegmentedControl selectedDataRole for modal focus (#485)"
```

---

## Task 5: Frontend — `AiOnboardingDialog` shell (Off / Preview, exits)

**Files:**
- Create: `frontend/src/components/Ai/AiOnboardingDialog.tsx`
- Create: `frontend/src/components/Ai/AiOnboardingDialog.module.css`
- Create: `frontend/src/components/Ai/AiOnboardingDialog.test.tsx`
- Modify: `frontend/src/api/types.ts` (add `onboardingSeen` to `UiPreferences`)
- Modify: `frontend/src/contexts/PreferencesContext.tsx` (add `'ui.ai.onboardingSeen'` to the closed `PreferenceKey` union)

**Interfaces:**
- Consumes: `Modal`, `SparkIcon`, `SegmentedControl` (+ `selectedDataRole`), `usePreferences().set`, `useNavigate`/`useLocation` (react-router), `preferences.ui.aiMode`.
- Produces: `AiOnboardingDialog({ onDismiss }: { onDismiss: () => void })` — self-contained dialog. Owns local `open` state (closes itself on any exit, independent of the async seen-write). Calls `onDismiss()` after it closes so the host can stop mounting it. This task implements Off/Preview selection, the adaptive button for Off/Preview, the legend, the `Manage AI settings →` link, and Esc. **Live is stubbed** (selecting Live shows a placeholder region; the full state machine is Task 6) — but the Live segment is present so layout/color are testable.

**Pending-selection model (spec §6):** local `pending: AiMode` state, initialized to the persisted `aiMode`. The segmented control sets `pending`; only the adaptive button commits. The button label/style/action track `pending`.

**Self-dismissal (spec §6.1):** a committing exit sets local `open=false` immediately (so the dialog closes even if the async `seen`-write later fails), then fires the writes in the background (`set(...).catch(() => {})`), then calls `onDismiss()`.

**Exit table (spec §6):**

| Exit | Commits mode? | Sets `seen`? | Closes |
|---|---|---|---|
| Adaptive button (Off) | `set('ui.ai.mode','off')` | yes | yes |
| Adaptive button (Preview) | no | yes | yes |
| `Manage AI settings →` | no | yes | yes (navigates to `/settings/ai`) |
| Esc (`Modal.onClose`) | no | **no** | yes (re-shows next launch) |

- [ ] **Step 1: Add the frontend types**

Two edits, in two files:
1. In `frontend/src/api/types.ts`, add `onboardingSeen: boolean;` to the `UiPreferences` interface (`:18-30`).
2. In `frontend/src/contexts/PreferencesContext.tsx`, add `| 'ui.ai.onboardingSeen'` to the `PreferenceKey` union. This is **required, not conditional** — `PreferenceKey` is a closed string-literal union (re-exported via `usePreferences.ts`), so without this member every `set('ui.ai.onboardingSeen', …)` call is a `tsc -b` error.

- [ ] **Step 2: Write the failing shell tests**

Create `frontend/src/components/Ai/AiOnboardingDialog.test.tsx`. Mock `usePreferences` (mutable `vi.hoisted` fixture, per the `AiPane.test.tsx` pattern) and `react-router-dom`'s `useNavigate`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiOnboardingDialog } from './AiOnboardingDialog';

const set = vi.fn().mockResolvedValue(undefined);
const navigate = vi.fn();
const prefs = vi.hoisted(() => ({ aiMode: 'preview' as 'off' | 'preview' | 'live' }));

vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: { ui: { aiMode: prefs.aiMode, onboardingSeen: false } },
    set,
  }),
}));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/', state: null }),
}));

const onDismiss = vi.fn();
beforeEach(() => {
  set.mockClear();
  navigate.mockClear();
  onDismiss.mockClear();
  prefs.aiMode = 'preview';
});

describe('AiOnboardingDialog shell', () => {
  it('opens on Preview with a "Maybe later" button and no mode write on click', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    const btn = screen.getByRole('button', { name: 'Maybe later' });
    await user.click(btn);
    // Preview kept → only the seen-write, no mode write.
    expect(set).toHaveBeenCalledWith('ui.ai.onboardingSeen', true);
    expect(set).not.toHaveBeenCalledWith('ui.ai.mode', expect.anything());
    expect(onDismiss).toHaveBeenCalled();
  });

  it('selecting Off changes the button to "Turn off AI" and commits off + seen', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Off/ }));
    const btn = screen.getByRole('button', { name: 'Turn off AI' });
    await user.click(btn);
    expect(set).toHaveBeenCalledWith('ui.ai.mode', 'off');
    expect(set).toHaveBeenCalledWith('ui.ai.onboardingSeen', true);
  });

  it('Manage AI settings sets seen, navigates, and does NOT write a mode (pending Off)', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Off/ })); // pending = off
    // Rendered as a <button class="btn btn-link"> (matches the existing settings opener), so query by button.
    await user.click(screen.getByRole('button', { name: /Manage AI settings/ }));
    expect(set).toHaveBeenCalledWith('ui.ai.onboardingSeen', true);
    expect(set).not.toHaveBeenCalledWith('ui.ai.mode', expect.anything());
    expect(navigate).toHaveBeenCalledWith('/settings/ai', expect.anything());
  });

  it('Esc does NOT set seen and does not commit', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.keyboard('{Escape}');
    expect(set).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled(); // closes, but seen stays false → re-shows next launch
  });
});
```

- [ ] **Step 3: Run them; verify they fail**

Run: `./frontend/node_modules/.bin/vitest run src/components/Ai/AiOnboardingDialog.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 4: Create the CSS module**

Create `frontend/src/components/Ai/AiOnboardingDialog.module.css`. Color-code the selected segment and style the legend with the AI-surface idiom. Use only `var(--…)` tokens:

```css
/* Selected-segment tints (soft, not loud). Applied via data-pending on the control wrapper.
   IMPORTANT: do NOT target SegmentedControl's `.segOn` class — it is CSS-modules-hashed
   (e.g. `_segOn_x1y2`) so a literal `:global(.segOn)` selector matches nothing and the tint
   silently no-ops. Target the STABLE ARIA attribute the selected radio already carries:
   `[aria-checked='true']` (rendered by SegmentedControl on the selected button). No SegmentedControl
   change is needed for the tint. Verify the tint renders live in BOTH themes before generating
   the Task 8 visual baseline (a passing-but-untinted baseline would bake in the bug). */
.control[data-pending='off'] [role='radio'][aria-checked='true'] {
  background: var(--surface-3);
  color: var(--text-1);
}
.control[data-pending='preview'] [role='radio'][aria-checked='true'] {
  background: var(--accent-soft);
  color: var(--accent);
}
.control[data-pending='live'] [role='radio'][aria-checked='true'] {
  background: var(--success-soft);
  color: var(--success-fg);
}

.legend {
  margin-top: var(--s-3);
  padding: var(--s-4);
  border: 1px solid var(--accent);
  border-radius: var(--radius-3);
  background:
    linear-gradient(var(--surface-1), var(--surface-1)) padding-box,
    var(--ai-tint-gradient, linear-gradient(135deg, var(--accent-soft), transparent)) border-box;
}
.legendRow {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  padding: var(--s-1) 0;
}
.dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 0.45em;
}
.dotOff { background: var(--text-3); }
.dotPreview { background: var(--accent); }
.dotLive { background: var(--success-fg); }
.currentPill {
  margin-left: var(--s-2);
  padding: 0 var(--s-2);
  font-size: var(--text-xs);
  border-radius: var(--radius-2);
  background: var(--accent-soft);
  color: var(--accent);
}
.lead { margin: 0 0 var(--s-3); line-height: 1.55; }
.actions { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); margin-top: var(--s-4); }
.offBtn { color: var(--danger-fg); } /* secondary chrome + danger-fg text, NOT a red fill */
```

> Verify the exact token names (`--accent-soft`, `--success-soft`, `--success-fg`, `--danger-fg`, `--text-xs`, `--radius-2`) against `styles/tokens.css`; the design was validated in a real-token mock, but confirm before relying on any. If `--ai-tint-gradient` isn't a real token, use the `.ai-tint` class pattern from the existing AI surfaces instead.

- [ ] **Step 5: Create the dialog (shell — Live stubbed)**

Create `frontend/src/components/Ai/AiOnboardingDialog.tsx`:

```tsx
import { useId, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Modal } from '../Modal/Modal';
import { SparkIcon } from './SparkIcon';
import { SegmentedControl } from '../controls/SegmentedControl';
import { usePreferences } from '../../hooks/usePreferences';
import type { AiMode } from '../../api/types';
import styles from './AiOnboardingDialog.module.css';

const OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'preview', label: 'Preview' },
  { value: 'live', label: 'Live' },
] as const;

const BUTTON: Record<AiMode, { label: string; className: string }> = {
  off: { label: 'Turn off AI', className: `btn btn-secondary ${styles.offBtn}` },
  preview: { label: 'Maybe later', className: 'btn btn-ghost' },
  live: { label: 'Enable Live AI', className: 'btn btn-success' },
};

export function AiOnboardingDialog({ onDismiss }: { onDismiss: () => void }) {
  const { preferences, set } = usePreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const current = preferences?.ui.aiMode ?? 'preview';
  const [pending, setPending] = useState<AiMode>(current);
  const [open, setOpen] = useState(true);
  const regionId = useId();

  const close = () => {
    setOpen(false);
    onDismiss();
  };

  // Esc: no commit, no seen. Re-shows next launch.
  const onEsc = () => close();

  // Manage AI settings: seen, navigate, NO mode commit. (Mirrors the existing settings opener —
  // grep for the toolbar/header settings entry and match its navigate + backgroundLocation shape.)
  const onManage = () => {
    void set('ui.ai.onboardingSeen', true).catch(() => {});
    close();
    navigate('/settings/ai', { state: { backgroundLocation: location } });
  };

  // Commit a mode (or keep Preview = no mode write), then mark seen. close() fires FIRST so the
  // dialog never blocks on the writes (and onboardingDismissed in InboxPage gates re-mount, so no
  // flash). seen is chained AFTER the mode write *succeeds* — so a failed mode write does not burn
  // the one-shot (the dialog re-shows and the user retries) and never leaves the Live split-brain
  // "consent recorded / mode still Preview". For Preview (no mode change) the seen-write is direct.
  // This preserves spec §6.1's "seen last" while closing the mode-write-fails gap.
  const commitMode = (mode: AiMode) => {
    close();
    if (mode === current) {
      void set('ui.ai.onboardingSeen', true).catch(() => {});
    } else {
      void set('ui.ai.mode', mode)
        .then(() => set('ui.ai.onboardingSeen', true))
        .catch(() => {});
    }
  };

  // Adaptive primary button.
  const onCommit = () => {
    if (pending === 'live') return; // Task 6 replaces this with the Live state machine.
    commitMode(pending);
  };

  // Concise SR status (announces the mode/region change without re-reading the whole legend card).
  const liveStatus =
    pending === 'live'
      ? 'Live selected. Review the data-sharing disclosure below.'
      : pending === 'off'
        ? 'Off selected.'
        : 'Preview selected.';

  const btn = BUTTON[pending];

  return (
    <Modal
      open={open}
      title="Set up AI for your reviews"
      titleIcon={<SparkIcon />}
      align="center"
      onClose={onEsc}
      defaultFocus="cancel"
      role="dialog"
    >
      <p className={styles.lead}>
        {pending === 'live'
          ? 'Live AI generates real, diff-grounded summaries of your pull requests using a real model.'
          : 'PRism is already running AI in Preview — sample output, clearly labeled, nothing sent off your device. Pick how much AI you want; you can change it any time in Settings.'}
      </p>

      <div className={styles.control} data-pending={pending}>
        <SegmentedControl
          label="AI mode"
          options={OPTIONS}
          value={pending}
          onChange={(v) => setPending(v)}
          selectedDataRole="cancel"
          describedById={regionId}
        />
      </div>

      {/* Live-region status node holds ONLY the concise change announcement, so segment changes
          don't re-read the entire legend. The legend/disclosure region below is NOT a live region;
          it is wired to the control via describedById for on-focus description. */}
      <span className="sr-only" role="status" aria-live="polite">
        {liveStatus}
      </span>

      <div id={regionId}>
        {pending === 'live' ? (
          <div /* Task 6: inline egress disclosure state machine */ />
        ) : (
          <div className={styles.legend}>
            <div className={styles.legendRow}>
              <span className={`${styles.dot} ${styles.dotOff}`} aria-hidden="true" />
              <span><strong>Off</strong> — no AI anywhere.</span>
            </div>
            <div className={styles.legendRow}>
              <span className={`${styles.dot} ${styles.dotPreview}`} aria-hidden="true" />
              <span>
                <strong>Preview</strong> — sample output, nothing leaves your device.
                {current === 'preview' && <span className={styles.currentPill}>Current</span>}
              </span>
            </div>
            <div className={styles.legendRow}>
              <span className={`${styles.dot} ${styles.dotLive}`} aria-hidden="true" />
              <span><strong>Live</strong> — real model summaries of your PRs (shares the diff; you'll confirm first).</span>
            </div>
          </div>
        )}
      </div>

      <div className={styles.actions}>
        <button type="button" className="btn btn-link" onClick={onManage}>
          Manage AI settings →
        </button>
        <button type="button" className={btn.className} data-modal-role="primary" onClick={onCommit}>
          {btn.label}
        </button>
      </div>
    </Modal>
  );
}
```

> **Resolved (was a fork):** render `Manage AI settings →` as a `<button class="btn btn-link" onClick={onManage}>`, not a `<Link>`. Rationale: it mirrors the existing settings opener (an imperative `navigate('/settings/…', { state: { backgroundLocation } })`), and a native `<button>` accepts `disabled` directly — so Task 6's "disable Manage during the consent POST" needs no `aria-disabled`/`tabIndex` workaround a `<Link>` would require. The shell test queries `getByRole('button', { name: /Manage AI settings/ })` accordingly. Before writing `onManage`, grep for the existing `/settings` navigation (e.g. the header/toolbar gear) and match its `backgroundLocation` state shape exactly so the AI pane opens as a modal over the inbox.

- [ ] **Step 6: Run the shell tests; verify they pass**

Run: `./frontend/node_modules/.bin/vitest run src/components/Ai/AiOnboardingDialog.test.tsx`
Expected: PASS (4 shell tests). Adjust the Manage-link query/impl per the note above until green.

- [ ] **Step 7: Verify the short-viewport scroll constraint (spec §13)**

The spec commits to: at a 480px viewport height the lead copy + `SegmentedControl` stay visible without scrolling; only the legend/disclosure below scrolls. Confirm `.modal-dialog` (in `styles/tokens.css`) already has `max-height: calc(100vh - var(--s-16))` + `overflow-y: auto`. If either is absent, add a scoped override on the dialog root in `AiOnboardingDialog.module.css`:

```css
.dialogBody { /* if needed — apply to a wrapper inside .modal-body */
  max-height: calc(100vh - var(--s-16));
  overflow-y: auto;
}
```

This is verified visually in Task 8 (a 480px-height viewport capture), not by a unit test.

- [ ] **Step 8: Typecheck**

Run (from `frontend/`): `./node_modules/.bin/tsc -b`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/contexts/PreferencesContext.tsx frontend/src/components/Ai/AiOnboardingDialog.tsx frontend/src/components/Ai/AiOnboardingDialog.module.css frontend/src/components/Ai/AiOnboardingDialog.test.tsx
git commit -m "feat(ai): onboarding dialog shell (Off/Preview, adaptive button, exits) (#485)"
```

---

## Task 6: Frontend — `AiOnboardingDialog` Live inline state machine

**Files:**
- Modify: `frontend/src/components/Ai/AiOnboardingDialog.tsx`
- Modify: `frontend/src/components/Ai/AiOnboardingDialog.test.tsx`

**Interfaces:**
- Consumes: `getEgressDisclosure(signal?)`, `postAiConsent(version)`, `EgressDisclosureBody`/`EgressDisclosureSkeleton` (Task 3), `Spinner`.
- Produces: the Live segment's full §7.1 behavior inside the dialog.

**State machine (spec §7.1) — copy the mechanics from `AiPane.onAiMode` (`:60-96`) and `EgressConsentModal.accept` (`:95-108`):**

1. Select Live → start `getEgressDisclosure(ac.signal)` with a fresh `AbortController` stored in a ref; region shows `EgressDisclosureSkeleton`; **primary button disabled** while in flight.
2. Resolves `alreadyConsented === true` → button enabled; clicking commits `ui.ai.mode='live'` **without** a consent POST.
3. Resolves not consented → render `EgressDisclosureBody`; button enabled (`Enable Live AI`).
4. Click → `postAiConsent(disclosureVersion)`; button shows `Spinner` + "Enabling…"; **disable button + segmented control + Manage link** for the duration. On success → commit `ui.ai.mode='live'`, set seen, close.
5. Fail closed: disclosure fetch error OR consent POST error/409 → `role="alert"` error, **no commit**, retry allowed.
6. Abort on change: picking Off/Preview before resolve → `ac.abort()`, revert region; a late resolve must not render Live's disclosure.
7. Teardown guard: a `cancelled` flag + `AbortController` so Esc/navigation unmount mid-GET/mid-POST **never** commits Live and never `setState`s after unmount. **No Live commit after dismissal.**

No-op guard: clicking the already-selected segment is a no-op (no re-fetch) — guard against `pending`.

- [ ] **Step 1: Write the failing Live tests**

Extend `AiOnboardingDialog.test.tsx` — mock `../../api/aiConsent` (`vi.mock`), reuse the `disclosure(alreadyConsented)` factory from the `AiPane.test.tsx` pattern:

```tsx
import * as consentApi from '../../api/aiConsent';
import type { EgressDisclosure } from '../../api/aiConsent';
vi.mock('../../api/aiConsent');

const disclosure = (alreadyConsented: boolean): EgressDisclosure => ({
  recipient: 'Anthropic, via the Claude Code CLI',
  dataCategories: ['Pull request diff (changed files and their contents)', 'Title', 'Description'],
  disclosureVersion: '1',
  alreadyConsented,
});

// in beforeEach:
vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(false));
vi.mocked(consentApi.postAiConsent).mockResolvedValue();

describe('AiOnboardingDialog Live path', () => {
  it('shows skeleton + disabled button while disclosure loads, then enables', async () => {
    let resolve!: (d: EgressDisclosure) => void;
    vi.mocked(consentApi.getEgressDisclosure).mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    expect(screen.getByRole('button', { name: 'Enable Live AI' })).toBeDisabled();
    resolve(disclosure(false));
    await screen.findByText('Anthropic, via the Claude Code CLI');
    expect(screen.getByRole('button', { name: 'Enable Live AI' })).toBeEnabled();
  });

  it('Enable Live: posts consent then commits mode=live + seen', async () => {
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await screen.findByText('Anthropic, via the Claude Code CLI');
    await user.click(screen.getByRole('button', { name: 'Enable Live AI' }));
    expect(consentApi.postAiConsent).toHaveBeenCalledWith('1');
    expect(set).toHaveBeenCalledWith('ui.ai.mode', 'live');
    expect(set).toHaveBeenCalledWith('ui.ai.onboardingSeen', true);
  });

  it('alreadyConsented short-circuits the POST', async () => {
    vi.mocked(consentApi.getEgressDisclosure).mockResolvedValue(disclosure(true));
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await user.click(await screen.findByRole('button', { name: 'Enable Live AI' }));
    expect(consentApi.postAiConsent).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith('ui.ai.mode', 'live');
  });

  it('fails closed when the consent POST rejects (no commit)', async () => {
    vi.mocked(consentApi.postAiConsent).mockRejectedValue(new Error('409'));
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await screen.findByText('Anthropic, via the Claude Code CLI');
    await user.click(screen.getByRole('button', { name: 'Enable Live AI' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(set).not.toHaveBeenCalledWith('ui.ai.mode', 'live');
  });

  it('aborting Live (pick Preview) drops the in-flight disclosure', async () => {
    const abortSpy = vi.fn();
    vi.mocked(consentApi.getEgressDisclosure).mockImplementation((signal) => {
      signal?.addEventListener('abort', abortSpy);
      return new Promise(() => {}); // never resolves
    });
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await user.click(screen.getByRole('radio', { name: /Preview/ }));
    expect(abortSpy).toHaveBeenCalled();
  });

  it('POST failure shows enable-specific copy, not the load-failure copy', async () => {
    vi.mocked(consentApi.postAiConsent).mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await screen.findByText('Anthropic, via the Claude Code CLI'); // disclosure loaded
    await user.click(screen.getByRole('button', { name: 'Enable Live AI' }));
    expect(await screen.findByText(/Couldn't enable Live AI/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load the data-sharing disclosure/)).not.toBeInTheDocument();
  });

  it('disables the Manage button while the consent POST is in flight', async () => {
    let resolvePost!: () => void;
    vi.mocked(consentApi.postAiConsent).mockReturnValue(new Promise((r) => (resolvePost = r)));
    const user = userEvent.setup();
    render(<AiOnboardingDialog onDismiss={onDismiss} />);
    await user.click(screen.getByRole('radio', { name: /Live/ }));
    await screen.findByText('Anthropic, via the Claude Code CLI');
    await user.click(screen.getByRole('button', { name: 'Enable Live AI' }));
    expect(screen.getByRole('button', { name: /Manage AI settings/ })).toBeDisabled();
    resolvePost();
  });
});
```

- [ ] **Step 2: Run them; verify they fail**

Run: `./frontend/node_modules/.bin/vitest run src/components/Ai/AiOnboardingDialog.test.tsx`
Expected: FAIL — Live path is the stub (button does nothing; no skeleton; no disclosure).

- [ ] **Step 3: Implement the Live state machine**

Replace the stubbed Live branch and `onCommit` Live handling. Add state + refs mirroring `AiPane`:

```tsx
import { useEffect, useRef } from 'react';
import { getEgressDisclosure, postAiConsent, type EgressDisclosure } from '../../api/aiConsent';
import { EgressDisclosureBody, EgressDisclosureSkeleton } from '../Settings/EgressDisclosureBody';
import { Spinner } from '../Spinner';

// inside the component — note TWO distinct error states (a disclosure FETCH failure vs a consent
// POST failure render different copy; mirrors EgressConsentModal's `failed` vs `submitError`):
const [disclosure, setDisclosure] = useState<EgressDisclosure | null>(null);
const [liveLoading, setLiveLoading] = useState(false);
const [fetchError, setFetchError] = useState(false);   // getEgressDisclosure failed
const [submitError, setSubmitError] = useState(false); // postAiConsent failed (disclosure was already shown)
const [submitting, setSubmitting] = useState(false);
const abortRef = useRef<AbortController | null>(null);
const cancelledRef = useRef(false);
useEffect(() => () => { cancelledRef.current = true; abortRef.current?.abort(); }, []);

// Replace Task 5's plain setPending(v) onChange with this (adds the Live fetch + no-op guard + abort):
const onSelect = (next: AiMode) => {
  if (next === pending) return; // no-op guard: re-selecting the same segment never re-fetches
  setPending(next);
  setFetchError(false);
  setSubmitError(false);
  if (next !== 'live') {
    abortRef.current?.abort();
    setLiveLoading(false);
    setDisclosure(null);
    return;
  }
  setDisclosure(null);
  setLiveLoading(true);
  const ac = new AbortController();
  abortRef.current = ac;
  getEgressDisclosure(ac.signal)
    .then((d) => { if (!ac.signal.aborted && !cancelledRef.current) { setDisclosure(d); setLiveLoading(false); } })
    .catch(() => { if (!ac.signal.aborted && !cancelledRef.current) { setFetchError(true); setLiveLoading(false); } });
};

// UPDATE Task 5's commitMode: add the cancelledRef teardown guard as the first line. The chained
// seen-after-mode-success ordering from Task 5 stays unchanged (so a failed mode write never burns
// the one-shot, and the Live split-brain "consent recorded / mode still Preview" cannot persist).
const commitMode = (mode: AiMode) => {
  if (cancelledRef.current) return; // dismissed/unmounted mid-flow — never commit
  close();
  if (mode === current) {
    void set('ui.ai.onboardingSeen', true).catch(() => {});
  } else {
    void set('ui.ai.mode', mode).then(() => set('ui.ai.onboardingSeen', true)).catch(() => {});
  }
};

const onCommit = async () => {
  if (pending !== 'live') {
    commitMode(pending);
    return;
  }
  if (!disclosure) return;
  if (disclosure.alreadyConsented) { commitMode('live'); return; }
  setSubmitting(true);
  setSubmitError(false);
  try {
    await postAiConsent(disclosure.disclosureVersion);
    if (cancelledRef.current) return; // dismissed mid-POST — never commit Live
    commitMode('live');
  } catch {
    if (!cancelledRef.current) setSubmitError(true); // POST failed — disclosure stays, distinct copy below
  } finally {
    if (!cancelledRef.current) setSubmitting(false);
  }
};
```

Wire `SegmentedControl`'s `onChange={onSelect}` and `disabled={submitting}`. The Manage button is a native `<button>`, so add `disabled={submitting}` directly (no `aria-disabled` needed). Extend `liveStatus` (Task 5) to also reflect `liveLoading` / `fetchError`. Render the Live region with **distinct** error copy for fetch vs POST:

```tsx
{pending === 'live' ? (
  fetchError ? (
    <div role="alert" className={styles.legend}>Couldn't load the data-sharing disclosure. Try again.</div>
  ) : liveLoading || !disclosure ? (
    <EgressDisclosureSkeleton />
  ) : (
    <>
      <EgressDisclosureBody disclosure={disclosure} />
      {submitError && (
        <div role="alert" className={styles.legend}>Couldn't enable Live AI. Try again.</div>
      )}
    </>
  )
) : ( /* legend, as in Task 5 */ )}
```

Primary button: `disabled={pending === 'live' && (liveLoading || submitting || (!disclosure && !fetchError))}`; when `submitting`, render `<Spinner size="sm" decorative /> Enabling…`. Change `onClick={() => void onCommit()}`.

- [ ] **Step 4: Run the Live tests; verify they pass**

Run: `./frontend/node_modules/.bin/vitest run src/components/Ai/AiOnboardingDialog.test.tsx`
Expected: PASS (shell + Live).

- [ ] **Step 5: Typecheck + lint**

Run (from `frontend/`): `./node_modules/.bin/tsc -b` then `npm run lint`.
Expected: clean (prettier --check passes — run `./node_modules/.bin/prettier --write` on new files first).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Ai/AiOnboardingDialog.tsx frontend/src/components/Ai/AiOnboardingDialog.test.tsx
git commit -m "feat(ai): onboarding Live inline disclosure state machine (#485)"
```

---

## Task 7: Frontend — mount in `InboxPage` (overlay + gate + auto-dismiss)

**Files:**
- Modify: `frontend/src/pages/InboxPage.tsx:24-160`
- Test: `frontend/src/pages/InboxPage.test.tsx` (create if absent; check first) or co-located convention

**Interfaces:**
- Consumes: `AiOnboardingDialog` (Tasks 5–6), `usePreferences().preferences`.
- Produces: the overlay shows iff `preferences` is loaded AND `preferences.ui.onboardingSeen === false`. Authed by construction (InboxPage renders only under the App `/` route guard). Renders over the loading skeleton **and** the loaded inbox; **not** over the inbox-load-error modal.

**Gate + self-dismissal:** the dialog manages its own visibility once mounted (Task 5 `open` state); `InboxPage` decides whether to mount it. To keep the dialog gone after a successful seen-write without depending on the dialog's local state, track a local `dismissed` flag set by the dialog's `onDismiss`. Auto-dismiss (spec §13 multi-window): if `preferences.ui.onboardingSeen` flips to `true` externally, stop mounting (the gate handles this automatically since it reads `onboardingSeen`).

- [ ] **Step 1: Write the failing gate tests**

Create/extend `frontend/src/pages/InboxPage.test.tsx`. Mock `useInbox` (return a loaded fixture), `usePreferences`, and stub `AiOnboardingDialog` to a sentinel so the test asserts *mounting*, not its internals:

```tsx
vi.mock('../components/Ai/AiOnboardingDialog', () => ({
  AiOnboardingDialog: () => <div data-testid="onboarding-dialog" />,
}));
// usePreferences mock with mutable onboardingSeen + aiMode fixture (vi.hoisted)

it('mounts the onboarding overlay when onboardingSeen is false', () => {
  prefs.onboardingSeen = false;
  render(<InboxPage />, { wrapper: RouterWrapper });
  expect(screen.getByTestId('onboarding-dialog')).toBeInTheDocument();
});

it('does NOT mount the overlay when onboardingSeen is true', () => {
  prefs.onboardingSeen = true;
  render(<InboxPage />, { wrapper: RouterWrapper });
  expect(screen.queryByTestId('onboarding-dialog')).not.toBeInTheDocument();
});

it('does NOT mount the overlay until preferences resolve (preferences null)', () => {
  prefs.value = null; // usePreferences returns { preferences: null }
  render(<InboxPage />, { wrapper: RouterWrapper });
  expect(screen.queryByTestId('onboarding-dialog')).not.toBeInTheDocument();
});

it('auto-dismisses when onboardingSeen flips to true externally (multi-window)', () => {
  prefs.onboardingSeen = false;
  const { rerender } = render(<InboxPage />, { wrapper: RouterWrapper });
  expect(screen.getByTestId('onboarding-dialog')).toBeInTheDocument();
  // Simulate the focus-refetch in another window resolving onboardingSeen=true.
  prefs.onboardingSeen = true;
  rerender(<InboxPage />);
  expect(screen.queryByTestId('onboarding-dialog')).not.toBeInTheDocument();
});
```

(Mirror the `usePreferences` shape returned by the existing InboxPage code path — `preferences?.inbox.defaultSort` is read, so the fixture needs `inbox`. Reuse the project's existing InboxPage test fixtures if present.)

- [ ] **Step 2: Run them; verify they fail**

Run: `./frontend/node_modules/.bin/vitest run src/pages/InboxPage.test.tsx`
Expected: FAIL — no overlay mounted.

- [ ] **Step 3: Restructure `InboxPage` to render the overlay over every non-error state**

The component early-returns the loading skeleton and the error modal before the success JSX. To overlay the dialog on the loading skeleton too (spec §4/§13), compute the overlay once and include it in the loading and success returns (not the error return):

```tsx
const { preferences } = usePreferences();
const [onboardingDismissed, setOnboardingDismissed] = useState(false);
const showOnboarding =
  !onboardingDismissed && preferences != null && preferences.ui.onboardingSeen === false;
const onboarding = showOnboarding ? (
  <AiOnboardingDialog onDismiss={() => setOnboardingDismissed(true)} />
) : null;

if (isLoading && !data)
  return (
    <>
      {onboarding}
      <LoadingBar active data-testid="inbox-loading-bar" />
      <InboxSkeleton showRail={showRail} />
    </>
  );
if (error && !data) return (<ErrorModal open title="Couldn't load inbox" /* … */ />); // no overlay over the error modal
if (!data) return null;

return (
  <>
    {onboarding}
    <LoadingBar active={isLoading || isRefreshing} data-testid="inbox-loading-bar" />
    <main /* … existing … */>{/* … */}</main>
  </>
);
```

Add the `AiOnboardingDialog` import and the `useState` import. (`preferences` is already destructured at `InboxPage.tsx:31`.)

> The `showRail` computation may sit below the early loading return; if `onboarding` references nothing that's computed later, place its definition right after `preferences` is read. Verify ordering compiles.

- [ ] **Step 4: Run the gate tests; verify they pass**

Run: `./frontend/node_modules/.bin/vitest run src/pages/InboxPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Confirm multi-window auto-dismiss works (no follow-up needed)**

Spec §13 multi-window auto-dismiss relies on `preferences` revalidating on window focus. **This already exists** — `PreferencesContext.tsx` registers a `window.addEventListener('focus', …)` refetch (verified, lines 171-179). So: window B commits → server `onboardingSeen=true` → window A refetches on focus → the gate's `preferences.ui.onboardingSeen === false` turns false → `showOnboarding` is false → the stale overlay unmounts **without** committing window A's pending selection. No new code and **no deferral** — there is no gap to record. (If a future refactor removes the focus refetch, this auto-dismiss regresses; the test in Step 1 pins it.)

- [ ] **Step 6: Typecheck + full frontend test run**

Run (from `frontend/`): `./node_modules/.bin/tsc -b` then `./node_modules/.bin/vitest run`.
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/InboxPage.tsx frontend/src/pages/InboxPage.test.tsx
git commit -m "feat(ai): mount first-run onboarding overlay on the inbox (#485)"
```

---

## Task 8: E2E + visual coverage (Playwright, prod project)

**Files:**
- Create: an onboarding e2e spec under the repo's e2e dir (match the existing naming/location — grep for an existing `*.spec.ts` that drives the inbox).
- Test hooks: reuse the existing `/test/*` harness endpoints (the dev Vite proxy serves only `/api`, so scenario specs run under the **prod** project only — never the dev project).

**Interfaces:**
- Consumes: the full stack (backend flag + backfill from Tasks 1–2, the mounted dialog from Task 7).

- [ ] **Step 1: Grep existing inbox visual/parity baselines for perturbation risk**

Run a content search for inbox baseline specs and snapshot names (e.g. `getByTestId('inbox-page')`, `inbox` baseline PNGs). The overlay renders over the inbox on first run; any existing inbox visual/parity spec that boots a **fresh** profile could now capture the overlay and break. For each, ensure its fixture sets `onboardingSeen=true` (returning user) so it is unaffected — or that it uses a profile where the backfill resolves to seen. Document which baselines you checked.

- [ ] **Step 2: Write the fresh-user E2E (TDD: write, watch it drive the new UI)**

A prod-project spec: boot a fresh data dir (a config that backfills to `onboardingSeen=false` — e.g. `mode=preview`, no consent), authenticate via the test harness, land on `/`:

```ts
// pseudocode — adapt to the repo's Playwright fixtures/harness
test('fresh user sees onboarding over loading inbox, enables Live, lands on inbox', async ({ page }) => {
  await gotoFreshInbox(page); // harness: fresh profile, authed
  const dialog = page.getByRole('dialog', { name: 'Set up AI for your reviews' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: /Live/ }).click();
  await expect(dialog.getByText('Anthropic, via the Claude Code CLI')).toBeVisible();
  await dialog.getByRole('button', { name: 'Enable Live AI' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('inbox-page')).toBeVisible();
  // Reload → no overlay (seen persisted).
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Set up AI for your reviews' })).toHaveCount(0);
});

test('returning user (seen=true) sees no overlay', async ({ page }) => {
  await gotoInboxWithSeen(page); // harness: profile with onboardingSeen=true
  await expect(page.getByRole('dialog', { name: 'Set up AI for your reviews' })).toHaveCount(0);
  await expect(page.getByTestId('inbox-page')).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e (prod project) via the repo's binary**

Run the Playwright prod project using `.bin/playwright` (NOT `npx playwright`), the single scenario spec.
Expected: PASS (fresh → Live enabled → inbox; returning → no overlay).

- [ ] **Step 4: Author the visual spec (both themes, three states, 480px height) — spec only, NO baselines yet**

Add a **separate** visual spec (its own baseline directory) capturing the dialog in Off / Preview / Live-expanded for light and dark. Include **one 480px-viewport-height capture** to verify the short-viewport scroll constraint (spec §13 / Task 5 Step 7): the lead + `SegmentedControl` visible without scrolling. While authoring, confirm live (in a running app, both themes) that:
- the color-coded selected segment actually renders the tint (the `[aria-checked='true']` fix from Task 5 — a no-op tint would otherwise bake into the baseline), and
- `--danger-fg` on the Off button meets WCAG AA (4.5:1) on `--surface-1` in both themes; if it fails in either, add `border-color: var(--danger-fg)` to `.offBtn` as a non-color signal (spec §10 "color is never the sole signal").

Do **not** generate or commit baseline PNGs in this step. Do **not** fold these into inbox baselines.

- [ ] **Step 5: Commit the spec; then generate Linux-CI baselines in a SEPARATE commit**

Windows-local baselines will not match CI (known repo gotcha — PNGs differ pixel-wise). Split into two commits:

```bash
# Commit 1 — spec(s) only, no baselines. Pushing this triggers a CI run that produces the actual PNGs.
git add <e2e spec> <visual spec>
git commit -m "test(ai): e2e + visual specs for first-run onboarding overlay (#485)"
```

Then download the CI-produced `actual` PNGs (per the repo's `regen Linux parity baseline via CI artifact` workflow), copy them in as the baselines, and:

```bash
# Commit 2 — Linux-generated baselines only.
git add <visual baseline dir>
git commit -m "test(ai): add Linux-CI visual baselines for onboarding overlay (#485)"
```

---

## Task 9: /simplify pass + pre-push gate + PR

- [ ] **Step 1: Run `superpowers:code-review` / `/simplify` over the diff**

Invoke the project's simplify pass (per the standing rule: run `/simplify` before raising any PR). Apply edits that hold up; this runs **before** the verify gate because it edits the tree.

- [ ] **Step 2: Run the full pre-push checklist verbatim (`.ai/docs/development-process.md`)**

Backend: `dotnet build` + `dotnet test` (foreground, timeout ≥ 300000ms). Frontend (from `frontend/`): `npm run lint`, `./node_modules/.bin/tsc -b`, `./node_modules/.bin/vitest run`, and the Playwright prod project via `.bin/playwright`. All green.

- [ ] **Step 3: Sync `V2` before pushing**

Fetch `origin/V2`; if the branch is behind, merge it in and re-run the affected gate (per the sync-before-push rule). Re-verify the merged tree compiles + tests pass (a clean merge can still hide an interface break).

- [ ] **Step 4: Raise the PR with `--base V2`**

Use the pr-autopilot skill (fallback: `gh pr create --base V2`). Title: `feat(ai): first-run AI onboarding overlay (#485)`. In the PR body's `## Proof` section, record: the spec + plan ce-doc-review dispositions; the egress-gate fact (server-side `AiSeamSelector` gates Live on `IsConsented` independently of the mode preference, so `mode=live` without consent = Noop = zero egress — see Global Constraints); the backfill security correction (mode=Live-without-consent ⇒ re-show) and the bidirectional conflation-guard test; that multi-window auto-dismiss is covered by the existing focus-refetch (no follow-up); and the live Playwright run. Body ends with the Claude Code generated-with footer.

---

## Self-review

**Spec coverage** (each §, mapped to a task):
- §4 trigger/placement → Task 7 (mount, overlay over loading, gate-until-preferences-resolve).
- §5 dialog body / 5.1 lead / 5.2 adaptive button / 5.3 Manage link → Tasks 5 (Off/Preview, legend, button, link) + 6 (Live lead/disclosure).
- §6 commit/exit semantics + 6.1 seen-write ordering → Task 5 (exit table, self-dismissal, seen-last) + 6 (Live commit ordering: consent → mode → seen).
- §7 / 7.1 Live inline state machine → Task 6 (fetch/abort/submit/fail-closed/teardown/no-op).
- §8 persistence + 8.1 backfill → Tasks 1 (field/patch/DTO) + 2 (key-absence backfill + conflation guard).
- §9 components/wiring → Tasks 3 (`EgressDisclosureBody`), 4 (`SegmentedControl`), 5–6 (dialog), 7 (InboxPage).
- §10 accessibility → Task 4 (`selectedDataRole` → focus the selected radio) + 5/6 (`aria-live` region, `describedById`, decorative glyphs, `role="alert"`).
- §11 visual → Task 5 CSS module (tokens, color-coded segments, legend) + Task 8 visual spec.
- §12 testing → Tasks 1–2 (backend), 5–7 (frontend), 8 (e2e/visual).
- §13 edge cases → Task 6 (disclosure-unreachable, 409, mid-fetch/POST teardown) + Task 7 (preferences-not-known, reload-mid-dialog via no-commit, multi-window auto-dismiss — confirmed working via the existing focus-refetch). Narrow/short viewport → Task 5 Step 7 (verify/add `.modal-dialog` max-height+overflow) + Task 8 Step 4 (480px capture).
- §14 out-of-scope → not implemented (per-feature toggles, version-bump re-onboarding, inbox stale-consent affordance, atomic multi-field patch). The inbox stale-consent affordance remains a spec-level follow-up (tracked in the spec §14), not introduced or resolved here.

**Type consistency:** `bool? OnboardingSeen` (Task 1) ↔ DTO `bool` via `?? false` (Task 1) ↔ TS `onboardingSeen: boolean` (Task 5). `set('ui.ai.onboardingSeen', true)` and `set('ui.ai.mode', mode)` use the verified `set(key, value)` signature. `getEgressDisclosure(signal?)` / `postAiConsent(version: string)` / `EgressDisclosure` fields match `aiConsent.ts`. `EgressDisclosureBody({ disclosure })` / `EgressDisclosureSkeleton()` signatures consistent across Tasks 3, 6. `selectedDataRole?: string` consistent across Tasks 4–5. `AiOnboardingDialog({ onDismiss })` consistent across Tasks 5–7.

**Resolved during plan-review (ce-doc-review round 1):**
- `AiConsentState` has **no** config-taking constructor → use `new AiConsentState(); .Set(consent)` (Task 2/3 fixed).
- `PreferenceKey` is a **closed** union in `PreferencesContext.tsx` (not `types.ts`) → the edit is mandatory (Task 5 Step 1 fixed).
- `PreferencesContext` **already** refetches on window focus → multi-window auto-dismiss works, no follow-up (Task 7 Step 5 fixed).
- Color-coded tints must target `[aria-checked='true']`, not CSS-modules-hashed `:global(.segOn)` (Task 5 CSS fixed).
- Live error copy split into fetch-vs-POST; `aria-live` narrowed to a status node; commit chains seen-after-mode-success; Manage stays a `<button>` (native `disabled`); narrow-viewport + Off-button-contrast now have explicit steps.
- Server-side egress gate (`AiSeamSelector`) confirmed independent of the mode preference (Global Constraints).

**Residual verification flags for the implementer** (resolve by reading, not guessing): exact token names in the CSS module (`--accent-soft`, `--success-soft`, `--success-fg`, `--danger-fg`, `--text-xs`, `--radius-2`, `--ai-tint-gradient`); the `/settings/ai` open pattern (`backgroundLocation` state) used by the existing settings entry point; the consent JSON on-disk casing in the backfill fixtures; the repo's e2e spec dir/fixtures; whether `.modal-dialog` already carries `max-height`+`overflow-y`.
