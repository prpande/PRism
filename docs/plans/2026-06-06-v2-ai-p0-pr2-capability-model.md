# v2 AI — P0 PR2: Capability Model (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the binary AI on/off model with a tri-state per-feature capability model — `AiMode {Off, Preview, Live}`, per-flag `/api/capabilities`, a provider availability/disabled-state path, a minimal provider capability descriptor, and the `ui.aiPreview`→`ui.ai.mode` config migration — wiring in PR1's (dark) provider substrate, while staying **backend-only and dark** (no real AI output, no frontend changes).

**Architecture:** The runtime flag `AiPreviewState { bool IsOn }` becomes `AiModeState { AiMode Mode }`, sourced from a new nested `ui.ai.mode` config field (migrated from the legacy `ui.aiPreview` bool). `AiSeamSelector.Resolve<T>()` goes from `IsOn ? placeholder : noop` to a tri-state, per-feature switch: `Off→Noop`, `Preview→Placeholder`, `Live→real impl iff registered AND available, else Noop` (truthful-by-default: never Placeholder dressed as Live). `/api/capabilities` stops returning `AiCapabilities.AllOn/AllOff` and instead computes each of the 9 flags independently via a new `AiCapabilityResolver`, surfaces the current mode + the active disabled reason (from PR1's `ILlmAvailabilityProbe`), and exposes the provider's disabled-state descriptor for PR3. PR1's `AddPrismClaudeCode` (today called only in a unit test) is wired into the live host so the probe is resolvable. **The frontend is untouched:** the `ai` capabilities envelope + its 9 camelCase keys are preserved, and `ui.aiPreview` survives as a derived/translated wire field until PR3 migrates the UI to `mode`.

**Tech Stack:** .NET 10 / C# 14 (`Nullable`, `ImplicitUsings`, file-scoped namespaces, `TreatWarningsAsErrors`, `AnalysisMode=AllEnabledByDefault`), `System.Text.Json` (BCL), xUnit 2.9 + FluentAssertions 6.12 + `Microsoft.AspNetCore.Mvc.Testing` (WebApplicationFactory). Central package management — no new packages.

**Spec:** `docs/specs/2026-06-05-v2-ai-roadmap-design.md` (§1.1 seams, §1.2 exists-vs-net-new, §2.3 provider descriptor, §4 the three modes + disabled states, §6 foundations, §7 P0). **Sibling plan:** `docs/plans/2026-06-05-v2-ai-p0-foundations.md` (PR1; this is PR2, scoped at its line 1471 / table row line 95).

---

## Authoritative context (grep-verified against the V2 worktree)

PR1 shipped the provider substrate **dark**: `AddPrismClaudeCode(services, options, usageDir)` (in `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs`) registers `ILlmProvider`, `ILlmAvailabilityProbe`, `ITokenUsageTracker`, `ICliProcessRunner` — but it is **called only in `tests/PRism.AI.ClaudeCode.Tests/ServiceRegistrationTests.cs`, never in the web host.** The live `/api/capabilities` never consults the probe.

Key PR1 types PR2 consumes (do **not** modify their contracts):
- `PRism.AI.Contracts/Provider/ILlmAvailabilityProbe.cs`: `Task<LlmAvailability> ProbeAsync(CancellationToken ct)`.
- `PRism.AI.Contracts/Provider/LlmAvailability.cs`: `record LlmAvailability(bool Available, string ReasonCode, string? ReasonMessage)` with `static LlmAvailability Ok` (ReasonCode `"none"`) and `static LlmAvailability Unavailable(string reasonCode, string? message = null)`. **`ReasonCode` is a provider-supplied STRING — there is NO `AiDisabledReason` enum in Contracts (round-2 resolution D5).**
- `PRism.AI.ClaudeCode/ClaudeReasonCodes.cs`: `public const string CliNotInstalled = "cli-not-installed"; NotLoggedIn = "not-logged-in"; IdentityMismatch = "identity-mismatch"; Unknown = "unknown";`. **The credit states (not-opted-in / exhausted) from spec §4 are NOT implemented — the probe folds them into `Unknown` (deferred to post-June-15 per §11.2). Do not invent them.**
- `PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs`: `ClaudeExecutable = "claude"`, `required string WorkingDirectory`, `Timeout = 60s`, `ProbeTimeout = 10s`.

### The FE-compat invariant (non-negotiable — PR2 is backend-only)

The frontend (PR3 owns its rewrite) reads two shapes PR2 **must not break**:
1. **`GET /api/capabilities`** — `frontend/src/hooks/useCapabilities.ts` reads `resp.ai`; `frontend/src/hooks/useAiGate.ts` reads `capabilities?.[key]` for the 9 camelCase keys (`summary, fileFocus, hunkAnnotations, preSubmitValidators, composerAssist, draftSuggestions, draftReconciliation, inboxEnrichment, inboxRanking`). **PR2 keeps the `ai` envelope key and all 9 keys; new fields (`mode`, `disabledReason`) are ADDED alongside — the FE ignores unknown JSON.** Playwright fixtures (`frontend/e2e/ai-gating-sweep.spec.ts`, `a11y-audit.spec.ts`) hardcode `{ ai: { ...9 bools } }` — additive fields keep them green; renaming/nesting breaks them.
2. **`GET/POST /api/preferences`** — `frontend/src/api/types.ts` `UiPreferences.aiPreview: boolean`; `useAiGate` ANDs `capabilities[key] && preferences.ui.aiPreview`; the Settings toggle POSTs `{ "aiPreview": bool }`. **PR2 keeps `aiPreview` working: GET derives it (`aiPreview = mode != Off`); POST translates it (`true→Preview`, `false→Off`).** A new `aiMode` field is added alongside for PR3. No frontend file changes in this PR.

**Discharges the D112 reopener.** The codebase carries a D112 note that fires "when backend `AiCapabilities` decouples from `AiPreviewState.IsOn`" — which is exactly what Task 9's per-flag resolver does. D112 flags that `useAiGate('composerAssist')` (AskAi button) and `useAiGate('inboxRanking')` (activity rail) are coupled-by-name to imprecise keys. **PR2 discharges it without new keys:** because Preview still returns all-9-flags-true, the coupling-by-name stays valid (no dedicated `askAi`/`activityRail` capability keys are needed yet). PR3 revisits if it adds finer-grained surfaces. This confirmation is recorded so the reopener is explicitly closed, not silently inherited.

### Hard constraints from the codebase map
- **Hot-reload:** `AiSeamSelector` reads the mode-state singleton **fresh on every `Resolve`** (asserted by `AiSeamSelectorTests.Resolve_observes_runtime_flips`). The new `AiModeState` must stay a mutable shared singleton.
- **Dual sync path:** the runtime flag is written in **two** places — the `config.Changed` subscription in `AddPrismCore` (`PRism.Core/ServiceCollectionExtensions.cs`) **and** the synchronous mirror in `PreferencesEndpoints.cs` (so the POST response is consistent). Both must move to `Mode`.
- **No versioned migration framework:** config evolution is an **ad-hoc JsonNode rewrite before deserialize** (`TryRewriteLegacyGithubShape`) + a **null-backfill block after deserialize**, both in `ConfigStore.ReadFromDiskAsync`. There is **no `schemaVersion`** — do not invent one. On disk the key is **kebab** (`ai-preview`), on the wire it is **camel** (`aiPreview`).
- **Defensive migration:** the legacy rewrite must NOT throw `InvalidOperationException` on a mistyped value (pinned by `ConfigStoreMigrationTests` after PR #53) — read via `TryGetValue<bool>` and let bad shapes fall through to the `LastLoadError`/`Default` path.
- **`ConfigFieldType` has only `String`/`Bool`** — a `ui.ai.mode` string patch validates the enum value inside the patch arm and throws `ConfigPatchException` on an unknown value.
- **`TreatWarningsAsErrors` + `AnalysisMode=AllEnabledByDefault`:** every `switch` over `AiMode` must be exhaustive (or have a `_` arm) or the build fails (CS8509).
- **`ProbeAsync` shells out** (`claude --version`, bounded by `ProbeTimeout`) and is **identity-first** (returns `IdentityMismatch` without spawning if the OS-user assert fails). The capabilities endpoint must become **async** and only probe in **Live** mode.
- **No `BuildServiceProvider` DI-test idiom exists** in Core/Web tests — verify DI via the `AiSeamSelector` hand-built-bag unit test or via `WebApplicationFactory` endpoint tests. (The `ServiceRegistrationTests` `BuildServiceProvider` idiom lives only in `PRism.AI.ClaudeCode.Tests` and is the model for Task 8's host-resolvability assertion.)

---

## Key Technical Decisions (resolve at the human-review gate)

**KTD-1 — Live-without-capability resolves to `Noop`, never `Placeholder`.** Spec §4 "truthful-by-default" prohibits sample data in a Live slot. In P0 no real impl is registered, so `Live` resolves to `Noop` (null/empty → 204) for every seam; the *reason* surfaces on `/api/capabilities`, and PR3 renders forced-resolution. **Alternative rejected:** falling back to Placeholder (fabricates findings as real — prohibited).

**KTD-2 — Keep the provider-supplied STRING `ReasonCode`; do NOT reintroduce an `AiDisabledReason` enum in Contracts.** Honors §2.3/D5 (disabled states are provider-supplied). The classifier passes the `ReasonCode` string through to the wire (`"none"` = not-disabled). **Alternative rejected:** a fixed enum — it would have dead branches (the Claude vocabulary lacks credit states) and re-couple Contracts to one provider.

**KTD-3 — Nested `ui.ai.mode` via a new `AiConfig(AiMode Mode)` record under `UiConfig`** (matches the spec's `ui.ai.mode` path and the existing dotted-path patch convention, e.g. `inbox.sections.*`). `UiConfig.AiPreview` (bool) is **removed** from the record; `aiPreview` survives only as a wire projection/translation. **Alternative rejected:** a flat `ui.ai-mode` (doesn't match the spec path) or keeping both fields (dual source-of-truth desync risk).
> **Known asymmetry (ce-doc-review, adversarial):** the legacy `aiPreview` toggle can only express Off/Preview (`true→Preview`), so a config already in **Live** that is touched by the legacy toggle silently **downgrades to Preview**. This is acceptable in P0 because Live is not reachable from any shipped FE surface (the toggle is the only AI control; `ui.ai.mode=live` requires a dotted-path POST or a config-file edit). PR3's mode selector replaces the toggle. A hard guard (reject the `aiPreview` patch when the current mode is `Live`) is **deferred to PR3** when the selector makes Live FE-reachable — flagged here so it is an informed deferral, not a silent gap.

**KTD-4 — No probe caching in PR2 (probe-per-call, only in Live mode).** §6 says the two-tier cache is "built at first real consumer (P1)." In P0 the shipped FE never enters Live (the toggle only sends `aiPreview`→Preview/Off), so the probe path is cold; an unbounded-but-`ProbeTimeout`-bounded await on the rare Live `/api/capabilities` call is acceptable. A `// P1: cache per §6 (invalidate via event bus, not key)` note marks the seam. **Alternative considered:** a short-TTL memo now — deferred as premature (YAGNI) and flagged for the reviewer.
> **Informed deferral (ce-doc-review, adversarial):** `frontend/src/hooks/useCapabilities.ts` refetches `/api/capabilities` on every window **focus** event. So if a config is ever in Live (config edit), each refocus is a fresh ~10s `claude --version` shell-out — not a one-time cost. This is accepted **only** because Live is not FE-reachable in PR2's window; **P1 MUST add the cache before shipping a Live selector**, or the focus-refetch becomes a per-refocus host hang.

**KTD-5 — Wire `AddPrismClaudeCode` into the host now (mandated by the §7 P0 exit condition).** The exit requires `/api/capabilities` to report the correct disabled reason when the CLI is absent, which needs the probe registered. `Program.cs` constructs `ClaudeCodeProviderOptions { WorkingDirectory = <dataDir>/llm-cwd }` (a stable, **non-git** dir) + `usageDir = <dataDir>/llm-usage`.

**KTD-6 — Minimal descriptor (disabled-states + a `SupportsStructuredOutput` stub), built + registered but not wire-surfaced in PR2.** Per §2.3 "P0 builds the descriptor with those two [axes]": the disabled-states axis (P0 consumer = PR3 Settings→AI) and the structured-output stub (P2 consumer) are modeled; cost/auth/caching/model-id are documented-but-omitted. PR2 **builds + DI-registers** the descriptor so PR3 can project its `DisabledStates[]` list; PR2 does **not** put that list on the wire (no PR2 consumer — scope finding). The one provider-supplied string PR2 *does* surface, the active `disabledReason`, is **length-capped, plain-text** (§2.3 trust-boundary rule). *(Note: a scope reviewer flagged the structured-output stub as P2-only; kept because §2.3 explicitly says "P0 builds the descriptor with those two" — disabled-states AND structured-output.)*

**KTD-7 — Wire-value strings are mapped explicitly** (`mode.ToString().ToLowerInvariant()` → `"off"/"preview"/"live"`), not left to the JSON enum converter, so the wire contract is deterministic regardless of how minimal-API anonymous objects pick up `JsonStringEnumConverter`. On disk, `AiConfig.Mode` relies on the **confirmed** kebab `JsonStringEnumConverter` (registered in both `Storage` and `Api` options) → `"off"/"preview"/"live"` — symmetric with the wire.

**KTD-8 — PR2 is large (13 tasks); sequenced green-at-every-commit, split recommended.** Tasks 2–3 (config + migration) keep `AiPreviewState` (binary, now sourced from the tri-state config) so the build stays green; **Task 4** does the `AiPreviewState→AiModeState` rename cascade atomically; **Tasks 5–12** are additive. **Recommendation (ce-doc-review scope finding):** split into two `V2`-targeted PRs — **PR2a = Tasks 1–4** (AiMode, config + migration, selector tri-state — a coherent, independently-testable "capability-model core" that leaves `AllOn`/`AllOff` in place) and **PR2b = Tasks 5–12** (provider wiring, descriptor, resolver, `/api/capabilities` rewrite, preferences round-trip, gate). Each is green-at-every-commit and reviewable in one sitting. If kept as one PR, Task 4 Step 6's interim `CapabilitiesEndpoints` (still `AllOn`/`AllOff`, now off `mode`) is the only deliberately-transitional state.

---

## File Structure

**New files:**

| File | Responsibility |
|------|----------------|
| `PRism.Core/Ai/AiMode.cs` | `enum AiMode { Off, Preview, Live }` (the tri-state) |
| `PRism.Core/Ai/AiModeState.cs` | Mutable singleton `{ AiMode Mode }` — replaces `AiPreviewState` |
| `PRism.Core/Ai/AiCapabilityResolver.cs` | Pure per-flag projection: `(AiMode, LlmAvailability) → AiCapabilities` + active disabled reason; holds the live-capable-seam set (empty in P0) |
| `PRism.AI.Contracts/Provider/ProviderCapabilityDescriptor.cs` | Neutral descriptor: `DisabledStates` list + `SupportsStructuredOutput` stub (rest documented-deferred) |
| `PRism.AI.ClaudeCode/ClaudeProviderDescriptor.cs` | The CLI provider's descriptor instance (its 4 reason codes + plain-text labels) |
| `tests/PRism.Core.Tests/Ai/AiCapabilityResolverTests.cs` | Per-flag + disabled-reason unit tests across modes |
| `tests/PRism.Core.Tests/Config/AiModeMigrationTests.cs` | `ai-preview`→`ai.mode` migration (true→Preview, false→Off, non-bool-doesn't-crash) |

**Modified files:**

| File | Change |
|------|--------|
| `PRism.Core/Ai/AiPreviewState.cs` | **Deleted** (replaced by `AiModeState`) |
| `PRism.Core/Ai/AiSeamSelector.cs` | Binary → tri-state per-feature `Resolve<T>()` (consumes `AiModeState` + noop/placeholder/real bags + `Func<bool> liveAvailable`) |
| `PRism.Core/Config/AppConfig.cs` | `UiConfig`: drop `bool AiPreview`, add `AiConfig Ai`; add `record AiConfig(AiMode Mode)`; update `AppConfig.Default` |
| `PRism.Core/Config/ConfigStore.cs` | `_allowedFields` (translate `aiPreview`→mode; add `ui.ai.mode`); patch arms; `TryRewriteLegacyAiPreviewShape`; nested `Ai` null-backfill guard |
| `PRism.Core/ServiceCollectionExtensions.cs` | `AddPrismCore`: register `AiModeState` (seed + `config.Changed` from `Ui.Ai.Mode`) instead of `AiPreviewState` |
| `PRism.Web/Composition/ServiceCollectionExtensions.cs` | `AddPrismAi`: build the 3-bag tri-state selector + register `AiCapabilityResolver`; doc-comment update |
| `PRism.Web/Program.cs` | Call `AddPrismClaudeCode(options, usageDir)` (stable non-git cwd + usage dir under dataDir) |
| `PRism.Web/Endpoints/CapabilitiesEndpoints.cs` | Async per-flag projection via resolver + probe + descriptor; keep `ai` envelope; add `mode`/`disabledReason`/`disabledStates` |
| `PRism.Web/Endpoints/PreferencesEndpoints.cs` | Mirror → `Mode`; `BuildResponse` derives `aiPreview` from mode + adds `aiMode` |
| `PRism.Web/Endpoints/PreferencesDtos.cs` | `UiPreferencesDto`: keep `AiPreview` (derived) + add `string AiMode` |
| `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs` | `AddPrismClaudeCode`: also register the `ProviderCapabilityDescriptor` |
| `PRism.AI.Contracts/Capabilities/AiCapabilities.cs` | Remove `AllOn`/`AllOff` statics (after the endpoint stops using them) |
| `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs` | Add an `ILlmAvailabilityProbe` override hook (RemoveAll + AddSingleton) |
| `tests/PRism.Core.Tests/Ai/AiSeamSelectorTests.cs` | Rewrite for tri-state (`AiModeState`/`AiMode`) + the Live-not-capable-in-P0 case |
| `tests/PRism.Web.Tests/Endpoints/CapabilitiesEndpointsTests.cs` | Per-flag-per-mode + `disabledReason` assertions (with probe override) |
| `tests/PRism.Web.Tests/Endpoints/Ai*EndpointTests.cs` | `GetRequiredService<AiPreviewState>().IsOn = true` → `<AiModeState>().Mode = AiMode.Preview` |
| `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` | `aiPreview` round-trip via mode + `aiMode` field |
| `tests/PRism.Core.Tests/Config/ConfigStoreTests.cs` | `Ui.AiPreview` default assertion → `Ui.Ai.Mode == AiMode.Off`; new ui-field backfill |

> The `AiEndpoints` four endpoints, `InboxRefreshOrchestrator`, the 9 seam interfaces, and the Noop/Placeholder impls + `AddNoopSeams`/`AddPlaceholderSeams` are **unchanged** — they call `Resolve<T>()` and get an impl exactly as before. Only the selection logic behind `Resolve` changes.

---

## Tasks

### Task 1: `AiMode` enum

**Files:**
- Create: `PRism.Core/Ai/AiMode.cs`

- [ ] **Step 1: Create the enum**

```csharp
// PRism.Core/Ai/AiMode.cs
namespace PRism.Core.Ai;

/// <summary>
/// The three AI modes (spec §4). Off = no AI (Noop seams); Preview = canned sample data
/// (Placeholder seams), unmistakably labeled; Live = real provider output, gated by the
/// availability probe. The migration target for the legacy <c>ui.aiPreview</c> bool
/// (true → Preview, false → Off). Serializes kebab ("off"/"preview"/"live") via the
/// registered <see cref="System.Text.Json.Serialization.JsonStringEnumConverter"/>.
/// </summary>
public enum AiMode
{
    Off,
    Preview,
    Live,
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `dotnet build PRism.Core/PRism.Core.csproj -c Debug`
Expected: `Build succeeded. 0 Warning(s) 0 Error(s)`.

- [ ] **Step 3: Commit**

```powershell
git add PRism.Core/Ai/AiMode.cs
git commit -m "feat(ai): add AiMode tri-state enum (Off/Preview/Live)"
```

---

### Task 2: Config model — `AiConfig` + `ui.ai.mode` (replace `UiConfig.AiPreview`)

Replace the binary config field with the nested tri-state. `AiPreviewState` (still binary for now — Task 7 renames it) is re-sourced from the mode so the build stays green. The wire `aiPreview` is preserved as a derived/translated field.

**Files:**
- Modify: `PRism.Core/Config/AppConfig.cs`
- Modify: `PRism.Core/Config/ConfigStore.cs`
- Modify: `PRism.Core/ServiceCollectionExtensions.cs`
- Modify: `PRism.Web/Endpoints/PreferencesEndpoints.cs`
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs`
- Test: `tests/PRism.Core.Tests/Config/ConfigStoreTests.cs`

- [ ] **Step 1: Update the failing config test first (TDD)**

In `tests/PRism.Core.Tests/Config/ConfigStoreTests.cs`, change the default assertion(s) and add a patch round-trip. **There are TWO `store.Current.Ui.AiPreview.Should().BeFalse();` occurrences** — the default-config fact (~line 21) and the partial-config-fills-from-defaults fact (~line 170, which exercises the nested-`Ai` backfill added in Task 2 Step 4). Replace **both** with:

```csharp
store.Current.Ui.Ai.Mode.Should().Be(AiMode.Off);
```

Add (near the other `PatchAsync` round-trip facts), using the dotted-path key:

```csharp
[Fact]
public async Task PatchAsync_ui_ai_mode_persists_and_round_trips()
{
    using var dir = new TempDataDir();
    using var store = new ConfigStore(dir.Path);
    await store.InitAsync(CancellationToken.None);

    await store.PatchAsync(new Dictionary<string, object?> { ["ui.ai.mode"] = "live" }, CancellationToken.None);
    store.Current.Ui.Ai.Mode.Should().Be(AiMode.Live);

    using var roundTrip = new ConfigStore(dir.Path);
    await roundTrip.InitAsync(CancellationToken.None);
    roundTrip.Current.Ui.Ai.Mode.Should().Be(AiMode.Live);
}

[Fact]
public async Task PatchAsync_legacy_aiPreview_true_maps_to_Preview_mode()
{
    using var dir = new TempDataDir();
    using var store = new ConfigStore(dir.Path);
    await store.InitAsync(CancellationToken.None);

    await store.PatchAsync(new Dictionary<string, object?> { ["aiPreview"] = true }, CancellationToken.None);
    store.Current.Ui.Ai.Mode.Should().Be(AiMode.Preview);
}

[Fact]
public async Task PatchAsync_ui_ai_mode_rejects_unknown_value()
{
    using var dir = new TempDataDir();
    using var store = new ConfigStore(dir.Path);
    await store.InitAsync(CancellationToken.None);

    var act = async () => await store.PatchAsync(
        new Dictionary<string, object?> { ["ui.ai.mode"] = "bogus" }, CancellationToken.None);
    await act.Should().ThrowAsync<ConfigPatchException>();
}
```

Add `using PRism.Core.Ai;` to the test file if not present.

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStoreTests"`
Expected: FAIL — `Ui.Ai` does not exist; `ui.ai.mode` not an allowed field.

- [ ] **Step 3: Add `AiConfig` + `UiConfig.Ai` (drop `AiPreview`)**

In `PRism.Core/Config/AppConfig.cs`, add `using PRism.Core.Ai;` and change `UiConfig`:

```csharp
// before:
// public sealed record UiConfig(string Theme, string Accent, bool AiPreview, string Density = "comfortable");
public sealed record UiConfig(string Theme, string Accent, AiConfig Ai, string Density = "comfortable");

/// <summary>AI mode config (spec §4). Persisted at <c>ui.ai.mode</c>.</summary>
public sealed record AiConfig(AiMode Mode);
```

In `AppConfig.Default`, change the `UiConfig` construction (was `new UiConfig("system", "indigo", false, "comfortable")`):

```csharp
new UiConfig("system", "indigo", new AiConfig(AiMode.Off), "comfortable"),
```

- [ ] **Step 4: Update `ConfigStore` allowlist + patch arms**

In `PRism.Core/Config/ConfigStore.cs`, in `_allowedFields`, **replace** the `["aiPreview"] = ConfigFieldType.Bool` entry's behavior and **add** the dotted-path key. Keep `aiPreview` in the allowlist (FE compat) but add `ui.ai.mode`:

```csharp
["aiPreview"]   = ConfigFieldType.Bool,    // legacy FE toggle — translated to ui.ai.mode below
["ui.ai.mode"]  = ConfigFieldType.String,  // tri-state (off|preview|live)
```

In `PatchAsync`'s switch, **replace** the `aiPreview` arm and **add** the mode arm:

```csharp
"aiPreview" => _current with { Ui = ui with { Ai = ui.Ai with { Mode = value is bool on ? (on ? AiMode.Preview : AiMode.Off) : throw new ConfigPatchException("aiPreview must be a boolean.") } } },
"ui.ai.mode" => _current with { Ui = ui with { Ai = ui.Ai with { Mode = value is string modeStr ? ParseAiMode(modeStr) : throw new ConfigPatchException("ui.ai.mode must be a string (off|preview|live).") } } },
```

> **Defensive cast (ce-doc-review, security + feasibility).** `PreferencesEndpoints` maps any JSON value that is not a string/`true`/`false` to `null` (its `_ => null` arm). A bare `(string)value!` / `(bool)value!` on `null` throws `NullReferenceException`/`InvalidCastException` — an unhandled **500** instead of the controlled `ConfigPatchException` → **400**. The `value is …` pattern keeps the clean-400 path for `{ "ui.ai.mode": 42 }` / `{ "aiPreview": "yes" }`. Add a `PatchAsync_ui_ai_mode_rejects_non_string_value` fact to Step 1 alongside the unknown-value reject.

Add the parser as a `private static` method on `ConfigStore` (throws `ConfigPatchException` per the `ConfigFieldType`-only-String/Bool gotcha):

```csharp
private static AiMode ParseAiMode(string value) => value.ToLowerInvariant() switch
{
    "off" => AiMode.Off,
    "preview" => AiMode.Preview,
    "live" => AiMode.Live,
    _ => throw new ConfigPatchException($"Invalid ui.ai.mode value '{value}' (expected off|preview|live)."),
};
```

Add `using PRism.Core.Ai;` to `ConfigStore.cs`.

> **Backfill guard (nested record):** in `ReadFromDiskAsync`'s null-backfill block, the existing `Ui = parsed.Ui ?? AppConfig.Default.Ui` guards a whole-null `Ui`, but an old config with `ui` present and no `ai` key deserializes `Ui.Ai` to `null` (NRE at the `AiModeState` seed). Add a nested guard mirroring the `Inbox.Sections` pattern, immediately after the existing backfill:
> ```csharp
> if (parsed.Ui.Ai is null)
>     parsed = parsed with { Ui = parsed.Ui with { Ai = AppConfig.Default.Ui.Ai } };
> ```
> (Adjust to match the exact local variable name used by the existing backfill block.)

- [ ] **Step 5: Re-source `AiPreviewState` from the mode (keep it binary for now)**

In `PRism.Core/ServiceCollectionExtensions.cs`, the `AiPreviewState` factory currently reads `config.Current.Ui.AiPreview`. Re-source from the mode so it still compiles and behaves identically (`IsOn` ⇔ mode ≠ Off). Add `using PRism.Core.Ai;`:

```csharp
services.AddSingleton<AiPreviewState>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var state = new AiPreviewState { IsOn = config.Current.Ui.Ai.Mode != AiMode.Off };
    config.Changed += (_, args) => state.IsOn = args.Config.Ui.Ai.Mode != AiMode.Off;
    return state;
});
```

- [ ] **Step 6: Update the preferences DTO + endpoint (derive `aiPreview`, add `aiMode`)**

In `PRism.Web/Endpoints/PreferencesDtos.cs`:

```csharp
// before: internal sealed record UiPreferencesDto(string Theme, string Accent, bool AiPreview, string Density);
internal sealed record UiPreferencesDto(string Theme, string Accent, bool AiPreview, string AiMode, string Density);
```

In `PRism.Web/Endpoints/PreferencesEndpoints.cs`, update the `BuildResponse` projection (was `new UiPreferencesDto(ui.Theme, ui.Accent, ui.AiPreview, ui.Density)`) — derive `aiPreview` and emit the lowercase mode string (KTD-7):

```csharp
Ui: new UiPreferencesDto(
        ui.Theme,
        ui.Accent,
        AiPreview: ui.Ai.Mode != AiMode.Off,
        AiMode: ui.Ai.Mode.ToString().ToLowerInvariant(),
        ui.Density),
```

Update the synchronous mirror (was `aiState.IsOn = config.Current.Ui.AiPreview;`):

```csharp
aiState.IsOn = config.Current.Ui.Ai.Mode != AiMode.Off;
```

Add `using PRism.Core.Ai;` to `PreferencesEndpoints.cs`.

- [ ] **Step 7: Run the config tests**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStoreTests"`
Expected: PASS (including the 3 new facts). Then build the web project: `dotnet build PRism.Web/PRism.Web.csproj -c Debug` → 0 warnings/errors.

- [ ] **Step 8: Commit**

```powershell
git add PRism.Core/Config/AppConfig.cs PRism.Core/Config/ConfigStore.cs PRism.Core/ServiceCollectionExtensions.cs PRism.Web/Endpoints/PreferencesEndpoints.cs PRism.Web/Endpoints/PreferencesDtos.cs tests/PRism.Core.Tests/Config/ConfigStoreTests.cs
git commit -m "feat(ai): add ui.ai.mode tri-state config; keep aiPreview as derived/translated wire field"
```

---

### Task 3: Legacy config migration (`ui.ai-preview` → `ui.ai.mode`)

Rewrite existing on-disk configs (kebab `ai-preview` bool) into the new nested `ai.mode` shape, following the `TryRewriteLegacyGithubShape` idiom exactly (defensive, persist-back).

**Files:**
- Modify: `PRism.Core/Config/ConfigStore.cs`
- Test: `tests/PRism.Core.Tests/Config/AiModeMigrationTests.cs`

- [ ] **Step 1: Write the failing migration tests**

```csharp
// tests/PRism.Core.Tests/Config/AiModeMigrationTests.cs
using System.Threading;
using FluentAssertions;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public sealed class AiModeMigrationTests
{
    [Fact]
    public async Task InitAsync_migrates_legacy_ai_preview_true_to_preview_mode()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "ui": { "theme": "light", "accent": "indigo", "ai-preview": true } }
        """, CancellationToken.None);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.Mode.Should().Be(AiMode.Preview);

        var rewritten = await File.ReadAllTextAsync(Path.Combine(dir.Path, "config.json"), CancellationToken.None);
        rewritten.Should().Contain("\"ai\"").And.Contain("\"mode\"");
        rewritten.Should().NotContain("ai-preview");
    }

    [Fact]
    public async Task InitAsync_migrates_legacy_ai_preview_false_to_off_mode()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "ui": { "theme": "light", "accent": "indigo", "ai-preview": false } }
        """, CancellationToken.None);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Ai.Mode.Should().Be(AiMode.Off);
    }

    [Fact]
    public async Task InitAsync_does_not_crash_when_legacy_ai_preview_is_non_bool()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "ui": { "theme": "light", "accent": "indigo", "ai-preview": "yes-please" } }
        """, CancellationToken.None);

        using var store = new ConfigStore(dir.Path);
        var act = async () => await store.InitAsync(CancellationToken.None);

        await act.Should().NotThrowAsync();
        store.Current.Ui.Ai.Mode.Should().Be(AiMode.Off); // falls back to Default
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AiModeMigrationTests"`
Expected: FAIL — no migration yet; `ai-preview` deserializes to nothing / `Ai` stays default `Off` only by accident, and the non-bool case may throw or the disk isn't rewritten.

- [ ] **Step 3: Implement `TryRewriteLegacyAiPreviewShape`**

In `PRism.Core/Config/ConfigStore.cs`, add the static rewrite (model it on `TryRewriteLegacyGithubShape`; use `System.Text.Json.Nodes`):

```csharp
/// <summary>
/// Migrates the pre-v2 <c>ui.ai-preview</c> (bool) into the v2 <c>ui.ai.mode</c> nested shape
/// (true → "preview", false → "off"). Defensive per PR #53: a non-bool value is left untouched
/// so Deserialize/backfill handles it (never throws InvalidOperationException out of the catch).
/// Returns true if it rewrote the node (caller persists back).
/// </summary>
private static bool TryRewriteLegacyAiPreviewShape(JsonNode? rootNode)
{
    if (rootNode is not JsonObject root) return false;
    if (root["ui"] is not JsonObject ui) return false;
    if (ui["ai-preview"] is not JsonValue legacy) return false;
    if (ui["ai"] is JsonObject) { ui.Remove("ai-preview"); return true; } // already migrated to the nested shape; drop the stale key
    if (!legacy.TryGetValue<bool>(out var on)) return false;             // non-bool → leave for the Default fallback
    // A present-but-malformed ui["ai"] (e.g. a JSON string, not an object) is NOT short-circuited above —
    // it falls through to the overwrite below and is rebuilt from the legacy bool, so a corrupt `ai` value
    // cannot silently discard the user's ai-preview intent (ce-doc-review, adversarial edge case).

    ui["ai"] = new JsonObject { ["mode"] = on ? "preview" : "off" };
    ui.Remove("ai-preview");
    return true;
}
```

Wire it into `ReadFromDiskAsync` alongside the existing github rewrite — **OR the flags** so either rewrite triggers the re-serialize + persist-back (per the coupling gotcha):

```csharp
// where the code currently has: bool rewritten = TryRewriteLegacyGithubShape(rootNode);
bool rewritten = TryRewriteLegacyGithubShape(rootNode);
rewritten |= TryRewriteLegacyAiPreviewShape(rootNode);
// ... the existing `if (rewritten) { raw = rootNode!.ToJsonString(); }` and persist-back stay as-is.
```

- [ ] **Step 4: Run to verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AiModeMigrationTests"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```powershell
git add PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Config/AiModeMigrationTests.cs
git commit -m "feat(ai): migrate legacy ui.ai-preview bool to ui.ai.mode (defensive JsonNode rewrite)"
```

---

### Task 4: `AiModeState` holder + `AiSeamSelector` tri-state refactor (the rename cascade)

Replace `AiPreviewState` with `AiModeState` and rewrite the selector to tri-state per-feature resolution. This is the atomic cascade (KTD-8) — all `AiPreviewState` references move at once.

**Files:**
- Create: `PRism.Core/Ai/AiModeState.cs`
- Delete: `PRism.Core/Ai/AiPreviewState.cs`
- Modify: `PRism.Core/Ai/AiSeamSelector.cs`
- Modify: `PRism.Core/ServiceCollectionExtensions.cs`
- Modify: `PRism.Web/Composition/ServiceCollectionExtensions.cs`
- Modify: `PRism.Web/Endpoints/CapabilitiesEndpoints.cs` (interim — keep AllOn/AllOff off mode until Task 9)
- Modify: `PRism.Web/Endpoints/PreferencesEndpoints.cs`
- Test: `tests/PRism.Core.Tests/Ai/AiSeamSelectorTests.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/Ai*EndpointTests.cs`, `CapabilitiesEndpointsTests.cs`, `PreferencesEndpointsTests.cs`

- [ ] **Step 1: Rewrite the selector unit tests for tri-state (TDD)**

Replace `tests/PRism.Core.Tests/Ai/AiSeamSelectorTests.cs`'s `BuildSelector` helper and facts:

```csharp
// tests/PRism.Core.Tests/Ai/AiSeamSelectorTests.cs
using System;
using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Noop;          // adjust to the real Noop namespace
using PRism.AI.Contracts.Seams;          // adjust to the real seam-interface namespace
using PRism.AI.Placeholder;              // adjust to the real Placeholder namespace
using PRism.Core.Ai;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiSeamSelectorTests
{
    private static AiSeamSelector BuildSelector(AiModeState state, bool liveAvailable = false, bool withRealSummarizer = false)
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
        var real = new Dictionary<Type, object>();
        if (withRealSummarizer) real[typeof(IPrSummarizer)] = new PlaceholderPrSummarizer(); // stand-in "real" for the test
        return new AiSeamSelector(state, noop, placeholder, real, () => liveAvailable);
    }

    [Fact]
    public void Off_resolves_Noop()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Off });
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Preview_resolves_Placeholder()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Preview });
        sut.Resolve<IPrSummarizer>().Should().BeOfType<PlaceholderPrSummarizer>();
    }

    [Fact]
    public void Live_with_no_real_impl_resolves_Noop_never_Placeholder()
    {
        // P0 reality: no real impl registered → Live must NOT fabricate (truthful-by-default §4).
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Live }, liveAvailable: true);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Live_with_real_impl_but_unavailable_resolves_Noop()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Live }, liveAvailable: false, withRealSummarizer: true);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
    }

    [Fact]
    public void Live_with_real_impl_and_available_resolves_real()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Live }, liveAvailable: true, withRealSummarizer: true);
        // the stand-in "real" impl is a PlaceholderPrSummarizer instance registered in the real bag
        sut.Resolve<IPrSummarizer>().Should().BeOfType<PlaceholderPrSummarizer>();
    }

    [Fact]
    public void Resolve_observes_runtime_mode_flips()
    {
        var state = new AiModeState { Mode = AiMode.Off };
        var sut = BuildSelector(state);
        sut.Resolve<IPrSummarizer>().Should().BeOfType<NoopPrSummarizer>();
        state.Mode = AiMode.Preview;
        sut.Resolve<IPrSummarizer>().Should().BeOfType<PlaceholderPrSummarizer>();
    }

    [Fact]
    public void Resolve_throws_when_seam_is_not_registered()
    {
        var sut = BuildSelector(new AiModeState { Mode = AiMode.Off });
        Action act = () => sut.Resolve<IComposerAssistant>();
        act.Should().Throw<InvalidOperationException>().WithMessage("*IComposerAssistant*not registered*");
    }
}
```

> The implementer must replace the placeholder `using` namespaces above with the real ones (grep the existing test's `using` block — it already imports the Noop/Placeholder/seam types). The "real" bag uses a `Placeholder*` instance only as a distinguishable stand-in; production P0 keeps the real bag empty.

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AiSeamSelectorTests"`
Expected: FAIL — `AiModeState` does not exist; `AiSeamSelector` ctor has the old shape.

- [ ] **Step 3: Create `AiModeState`, delete `AiPreviewState`, rewrite the selector**

```csharp
// PRism.Core/Ai/AiModeState.cs
namespace PRism.Core.Ai;

/// <summary>
/// Mutable, hot-reloaded singleton carrying the current <see cref="AiMode"/>. Read fresh on every
/// <see cref="AiSeamSelector.Resolve{T}"/> call so config flips take effect immediately. Replaces
/// the binary AiPreviewState. Seeded + synced from <c>ui.ai.mode</c> in AddPrismCore.
/// </summary>
public sealed class AiModeState
{
    public AiMode Mode { get; set; }
}
```

Delete `PRism.Core/Ai/AiPreviewState.cs`.

Rewrite `PRism.Core/Ai/AiSeamSelector.cs`:

```csharp
// PRism.Core/Ai/AiSeamSelector.cs
using System;
using System.Collections.Generic;

namespace PRism.Core.Ai;

/// <summary>
/// Tri-state, per-feature seam selector. For the requested seam T it resolves by the current mode:
/// Off → Noop; Preview → Placeholder; Live → the real impl IFF one is registered for T AND the
/// provider is available, otherwise Noop (truthful-by-default §4 — never Placeholder in a Live slot).
/// In P0 the real bag is empty, so Live collapses to Noop for every seam.
/// </summary>
public sealed class AiSeamSelector : IAiSeamSelector
{
    private readonly AiModeState _state;
    private readonly IReadOnlyDictionary<Type, object> _noop;
    private readonly IReadOnlyDictionary<Type, object> _placeholder;
    private readonly IReadOnlyDictionary<Type, object> _real;
    private readonly Func<bool> _liveAvailable;

    public AiSeamSelector(
        AiModeState state,
        IReadOnlyDictionary<Type, object> noop,
        IReadOnlyDictionary<Type, object> placeholder,
        IReadOnlyDictionary<Type, object> real,
        Func<bool> liveAvailable)
    {
        _state = state;
        _noop = noop;
        _placeholder = placeholder;
        _real = real;
        _liveAvailable = liveAvailable;
    }

    public T Resolve<T>() where T : class
    {
        var bag = _state.Mode switch
        {
            AiMode.Off => _noop,
            AiMode.Preview => _placeholder,
            AiMode.Live => _real.ContainsKey(typeof(T)) && _liveAvailable() ? _real : _noop,
            _ => _noop,
        };
        if (!bag.TryGetValue(typeof(T), out var impl))
            throw new InvalidOperationException(
                $"AI seam {typeof(T).Name} is not registered for AI mode {_state.Mode}.");
        return (T)impl;
    }
}
```

- [ ] **Step 4: Update `AddPrismCore` to register `AiModeState`**

In `PRism.Core/ServiceCollectionExtensions.cs`, replace the `AiPreviewState` factory:

```csharp
services.AddSingleton<AiModeState>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var state = new AiModeState { Mode = config.Current.Ui.Ai.Mode };
    config.Changed += (_, args) => state.Mode = args.Config.Ui.Ai.Mode;
    return state;
});
```

Update the XML doc comment on the method (it referenced "AiPreviewState (which mirrors the live ui.aiPreview config flag)") to "AiModeState (which mirrors the live ui.ai.mode config value)".

- [ ] **Step 5: Update `AddPrismAi` to build the 3-bag selector**

In `PRism.Web/Composition/ServiceCollectionExtensions.cs`, change the selector registration (add `using System.Linq;` if needed for later tasks; here we just add the real bag + liveAvailable):

```csharp
services.AddSingleton<IAiSeamSelector>(sp => new AiSeamSelector(
    sp.GetRequiredService<AiModeState>(),
    noop: new Dictionary<Type, object>
    {
        [typeof(IPrSummarizer)] = sp.GetRequiredService<NoopPrSummarizer>(),
        [typeof(IFileFocusRanker)] = sp.GetRequiredService<NoopFileFocusRanker>(),
        [typeof(IHunkAnnotator)] = sp.GetRequiredService<NoopHunkAnnotator>(),
        [typeof(IPreSubmitValidator)] = sp.GetRequiredService<NoopPreSubmitValidator>(),
        [typeof(IComposerAssistant)] = sp.GetRequiredService<NoopComposerAssistant>(),
        [typeof(IDraftSuggester)] = sp.GetRequiredService<NoopDraftSuggester>(),
        [typeof(IDraftReconciliator)] = sp.GetRequiredService<NoopDraftReconciliator>(),
        [typeof(IInboxItemEnricher)] = sp.GetRequiredService<NoopInboxItemEnricher>(),
        [typeof(IInboxRanker)] = sp.GetRequiredService<NoopInboxRanker>(),
    },
    placeholder: new Dictionary<Type, object>
    {
        [typeof(IPrSummarizer)] = sp.GetRequiredService<PlaceholderPrSummarizer>(),
        [typeof(IFileFocusRanker)] = sp.GetRequiredService<PlaceholderFileFocusRanker>(),
        [typeof(IHunkAnnotator)] = sp.GetRequiredService<PlaceholderHunkAnnotator>(),
        [typeof(IPreSubmitValidator)] = sp.GetRequiredService<PlaceholderPreSubmitValidator>(),
        [typeof(IComposerAssistant)] = sp.GetRequiredService<PlaceholderComposerAssistant>(),
        [typeof(IDraftSuggester)] = sp.GetRequiredService<PlaceholderDraftSuggester>(),
        [typeof(IDraftReconciliator)] = sp.GetRequiredService<PlaceholderDraftReconciliator>(),
        [typeof(IInboxItemEnricher)] = sp.GetRequiredService<PlaceholderInboxItemEnricher>(),
        [typeof(IInboxRanker)] = sp.GetRequiredService<PlaceholderInboxRanker>(),
    },
    real: new Dictionary<Type, object>(),    // P0: no real seam impls yet (Live → Noop everywhere)
    liveAvailable: () => false));            // P0: no live features; P1 wires the cached probe-availability
```

Update the `AddPrismAi` doc-comment from "picks ... based on AiPreviewState.IsOn" to "tri-state per-feature resolution off AiModeState (Off→Noop, Preview→Placeholder, Live→real-iff-registered-and-available)".

- [ ] **Step 6: Update the two interim consumers + endpoint tests**

In `PRism.Web/Endpoints/CapabilitiesEndpoints.cs` (interim — full per-flag rewrite is Task 9), keep it compiling off the mode:

```csharp
app.MapGet("/api/capabilities", (AiModeState state) => new
{
    ai = state.Mode == AiMode.Off ? AiCapabilities.AllOff : AiCapabilities.AllOn,
});
```

In `PRism.Web/Endpoints/PreferencesEndpoints.cs`, the mirror line written in Task 2 referenced `aiState.IsOn` on `AiPreviewState`; change the injected param + mirror to `AiModeState`:

```csharp
// signature: ... AiModeState aiState) =>
aiState.Mode = config.Current.Ui.Ai.Mode;
```

In every `tests/PRism.Web.Tests/Endpoints/Ai*EndpointTests.cs` and `CapabilitiesEndpointsTests.cs`, replace the seam-enable line:

```csharp
// before: factory.Services.GetRequiredService<AiPreviewState>().IsOn = true;
factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
```

Add `using PRism.Core.Ai;` to those test files. In `PreferencesEndpointsTests.cs`, update any `AiPreview`/`IsOn` assertions to the new mode/derived-`aiPreview` shape.

- [ ] **Step 7: Run the affected suites**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AiSeamSelectorTests"`
Expected: PASS (7 tests).
Then: `dotnet build PRism.sln -c Debug` → 0 warnings/errors (confirms the cascade is complete).

- [ ] **Step 8: Commit**

```powershell
git add PRism.Core/Ai/ PRism.Core/ServiceCollectionExtensions.cs PRism.Web/Composition/ServiceCollectionExtensions.cs PRism.Web/Endpoints/CapabilitiesEndpoints.cs PRism.Web/Endpoints/PreferencesEndpoints.cs tests/PRism.Core.Tests/Ai/AiSeamSelectorTests.cs tests/PRism.Web.Tests/Endpoints/
git commit -m "feat(ai): replace AiPreviewState with tri-state AiModeState + per-feature AiSeamSelector"
```

> **Note:** `git add PRism.Core/Ai/` stages the deletion of `AiPreviewState.cs` and the two new files. Verify with `git status` that `AiPreviewState.cs` shows as deleted and no stray files are staged.

---

### Task 5: Wire `AddPrismClaudeCode` into the host

Make PR1's probe/provider resolvable in the live container (KTD-5) so the rewritten capabilities endpoint can inject `ILlmAvailabilityProbe`.

**Files:**
- Modify: `PRism.Web/Program.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/CapabilitiesEndpointsTests.cs` (a host-resolvability assertion is added in Task 9; here we just verify startup)

- [ ] **Step 1: Construct options + wire the registration**

In `PRism.Web/Program.cs`, after `AddPrismCore` / before `AddPrismAi` (the probe must be registered before the capabilities endpoint resolves it), add — using the existing `dataDir` local:

```csharp
var llmCwd = Path.Combine(dataDir, "llm-cwd");      // stable, NON-git working dir (§2.1 inv. 4)
var llmUsageDir = Path.Combine(dataDir, "llm-usage");
Directory.CreateDirectory(llmCwd);                  // probe needs a stable cwd to exist before it can spawn; idempotent, owner-scoped
// Do NOT eagerly create llmUsageDir — JsonlTokenUsageTracker creates it lazily (owner-only) on first RecordAsync,
// which nothing calls in P0. Creating it here litters an empty dir for every user who never touches AI.
builder.Services.AddPrismClaudeCode(
    new ClaudeCodeProviderOptions { WorkingDirectory = llmCwd },
    llmUsageDir);
```

Add `using PRism.AI.ClaudeCode;` to `Program.cs`.

> **No egress reachable in PR2 (ce-doc-review, security + adversarial).** Nothing touches the real `claude` binary at startup — the probe shells out only when `ProbeAsync` is called (a Live-mode `/api/capabilities` request), and even then only `claude --version`. **No PR content can leave the device in PR2:** in Live mode the selector's `liveAvailable` is `false` over an empty real bag, so every seam still resolves to `Noop`. The §4 per-provider egress-consent gate is therefore **PR3's** responsibility (it ships the first egressing Live call + the consent UI); PR2 deliberately adds no server-side consent enforcement because no consent-requiring call is reachable. **Call this out in the PR body so PR3 owns the gate.**

- [ ] **Step 2: Verify the host still starts (build + the existing capabilities test)**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~CapabilitiesEndpointsTests"`
Expected: PASS — the existing test still passes (Off-mode path does not call the probe). This proves `AddPrismClaudeCode` registers cleanly in the test host.

- [ ] **Step 3: Commit**

```powershell
git add PRism.Web/Program.cs
git commit -m "feat(ai): wire AddPrismClaudeCode into the host (probe resolvable; stable non-git cwd under dataDir)"
```

---

### Task 6: Provider capability descriptor (minimal: disabled-states + structured-output stub)

Build the §2.3 minimal descriptor (KTD-6). Neutral shape in Contracts; CLI instance in the provider; registered via `AddPrismClaudeCode`.

**Files:**
- Create: `PRism.AI.Contracts/Provider/ProviderCapabilityDescriptor.cs`
- Create: `PRism.AI.ClaudeCode/ClaudeProviderDescriptor.cs`
- Modify: `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeProviderDescriptorTests.cs`

- [ ] **Step 1: Write the failing descriptor test**

```csharp
// tests/PRism.AI.ClaudeCode.Tests/ClaudeProviderDescriptorTests.cs
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;
using Xunit;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeProviderDescriptorTests
{
    [Fact]
    public void Descriptor_lists_the_providers_disabled_states_with_plain_text_labels()
    {
        var d = ClaudeProviderDescriptor.Create();

        d.DisabledStates.Should().Contain(s => s.ReasonCode == ClaudeReasonCodes.CliNotInstalled);
        d.DisabledStates.Should().Contain(s => s.ReasonCode == ClaudeReasonCodes.NotLoggedIn);
        d.DisabledStates.Should().Contain(s => s.ReasonCode == ClaudeReasonCodes.IdentityMismatch);
        d.DisabledStates.Should().Contain(s => s.ReasonCode == ClaudeReasonCodes.Unknown);
        d.DisabledStates.Should().OnlyContain(s => !string.IsNullOrWhiteSpace(s.DisplayLabel) && s.DisplayLabel.Length <= 200);
        d.SupportsStructuredOutput.Should().BeTrue(); // CLI has --json-schema
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --filter "FullyQualifiedName~ClaudeProviderDescriptorTests"`
Expected: FAIL — types undefined.

- [ ] **Step 3: Define the neutral descriptor + CLI instance**

```csharp
// PRism.AI.Contracts/Provider/ProviderCapabilityDescriptor.cs
using System.Collections.Generic;

namespace PRism.AI.Contracts.Provider;

/// <summary>One provider-supplied disabled state. <paramref name="DisplayLabel"/> is plain text,
/// length-capped at the wire boundary (§2.3 — a provider assembly is a runtime trust boundary;
/// never HTML/markdown).</summary>
public sealed record ProviderDisabledState(string ReasonCode, string DisplayLabel);

/// <summary>
/// The §2.3 minimal P0 provider capability descriptor. Only the two axes with a v2 consumer are
/// modeled: <see cref="DisabledStates"/> (P0 — the Settings → AI section, PR3) and
/// <see cref="SupportsStructuredOutput"/> (P2 — the parse-validate-retry harness). The cost,
/// auth-credential, prompt-caching, and model-identifier axes are deliberately NOT modeled until a
/// second provider lands (premature generalization to avoid; see §2.3 "Minimal P0 descriptor").
/// </summary>
public sealed record ProviderCapabilityDescriptor(
    IReadOnlyList<ProviderDisabledState> DisabledStates,
    bool SupportsStructuredOutput);
```

```csharp
// PRism.AI.ClaudeCode/ClaudeProviderDescriptor.cs
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

/// <summary>The Claude Code CLI provider's instance of the §2.3 capability descriptor.
/// DisabledStates mirror <see cref="ClaudeReasonCodes"/> (the credit states from spec §4 are
/// undocumented and folded into <see cref="ClaudeReasonCodes.Unknown"/> — not invented here).</summary>
public static class ClaudeProviderDescriptor
{
    public static ProviderCapabilityDescriptor Create() => new(
        DisabledStates: new[]
        {
            new ProviderDisabledState(ClaudeReasonCodes.CliNotInstalled, "Claude Code CLI is not installed."),
            new ProviderDisabledState(ClaudeReasonCodes.NotLoggedIn, "Not logged in to Claude Code."),
            new ProviderDisabledState(ClaudeReasonCodes.IdentityMismatch, "AI is disabled: the app is running as a different OS user than the Claude login."),
            new ProviderDisabledState(ClaudeReasonCodes.Unknown, "AI is unavailable for an unknown reason."),
        },
        SupportsStructuredOutput: true);
}
```

- [ ] **Step 4: Register the descriptor in `AddPrismClaudeCode`**

In `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs`, add (next to the other registrations):

```csharp
services.AddSingleton(ClaudeProviderDescriptor.Create());
```

- [ ] **Step 5: Run to verify pass**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --filter "FullyQualifiedName~ClaudeProviderDescriptorTests"`
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add PRism.AI.Contracts/Provider/ProviderCapabilityDescriptor.cs PRism.AI.ClaudeCode/ClaudeProviderDescriptor.cs PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeProviderDescriptorTests.cs
git commit -m "feat(ai): add minimal provider capability descriptor (disabled-states + structured-output stub)"
```

---

### Task 7: `AiCapabilityResolver` — per-flag projection + disabled reason

The pure logic that replaces `AllOn`/`AllOff`. Testable without the web host.

**Files:**
- Create: `PRism.Core/Ai/AiCapabilityResolver.cs`
- Test: `tests/PRism.Core.Tests/Ai/AiCapabilityResolverTests.cs`

- [ ] **Step 1: Write the failing tests**

```csharp
// tests/PRism.Core.Tests/Ai/AiCapabilityResolverTests.cs
using System;
using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Provider;
using PRism.AI.Contracts.Seams;   // adjust to the real seam-interface namespace
using PRism.Core.Ai;
using Xunit;

namespace PRism.Core.Tests.Ai;

public sealed class AiCapabilityResolverTests
{
    private static readonly AiCapabilityResolver EmptyP0 = new(new HashSet<Type>());

    [Fact]
    public void Off_all_flags_false_reason_none()
    {
        var caps = EmptyP0.Resolve(AiMode.Off, LlmAvailability.Ok);
        caps.Summary.Should().BeFalse();
        caps.InboxRanking.Should().BeFalse();
        AiCapabilityResolver.DisabledReason(AiMode.Off, LlmAvailability.Ok).Should().Be("none");
    }

    [Fact]
    public void Preview_all_flags_true_reason_none()
    {
        var caps = EmptyP0.Resolve(AiMode.Preview, LlmAvailability.Ok);
        caps.Summary.Should().BeTrue();
        caps.HunkAnnotations.Should().BeTrue();
        caps.InboxRanking.Should().BeTrue();
        AiCapabilityResolver.DisabledReason(AiMode.Preview, LlmAvailability.Ok).Should().Be("none");
    }

    [Fact]
    public void Live_in_P0_all_flags_false_and_surfaces_probe_reason()
    {
        var unavailable = LlmAvailability.Unavailable("cli-not-installed");
        var caps = EmptyP0.Resolve(AiMode.Live, unavailable);
        caps.Summary.Should().BeFalse(); // no real impl registered in P0
        AiCapabilityResolver.DisabledReason(AiMode.Live, unavailable).Should().Be("cli-not-installed");
    }

    [Fact]
    public void Live_with_a_registered_live_seam_and_available_lights_only_that_flag()
    {
        var resolver = new AiCapabilityResolver(new HashSet<Type> { typeof(IPrSummarizer) });
        var caps = resolver.Resolve(AiMode.Live, LlmAvailability.Ok);
        caps.Summary.Should().BeTrue();
        caps.FileFocus.Should().BeFalse();
        AiCapabilityResolver.DisabledReason(AiMode.Live, LlmAvailability.Ok).Should().Be("none");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AiCapabilityResolverTests"`
Expected: FAIL — `AiCapabilityResolver` undefined.

- [ ] **Step 3: Implement the resolver**

```csharp
// PRism.Core/Ai/AiCapabilityResolver.cs
using System;
using System.Collections.Generic;
using PRism.AI.Contracts.Capabilities;
using PRism.AI.Contracts.Provider;
using PRism.AI.Contracts.Seams;   // adjust to the real seam-interface namespace

namespace PRism.Core.Ai;

/// <summary>
/// Projects (mode, availability) → the 9 per-flag <see cref="AiCapabilities"/> (replacing the
/// AllOn/AllOff binary). Off → all false; Preview → all true (Placeholder covers every seam);
/// Live → a flag is true only when a real impl is registered for that seam AND the provider is
/// available. In P0 the live-seam set is empty, so Live yields all-false + the probe's reason.
/// </summary>
public sealed class AiCapabilityResolver
{
    private readonly IReadOnlySet<Type> _liveCapableSeams;

    public AiCapabilityResolver(IReadOnlySet<Type> liveCapableSeams) => _liveCapableSeams = liveCapableSeams;

    public AiCapabilities Resolve(AiMode mode, LlmAvailability liveAvailability)
    {
        bool Capable(Type seam) => mode switch
        {
            AiMode.Off => false,
            AiMode.Preview => true,
            AiMode.Live => _liveCapableSeams.Contains(seam) && liveAvailability.Available,
            _ => false,
        };

        return new AiCapabilities(
            Summary: Capable(typeof(IPrSummarizer)),
            FileFocus: Capable(typeof(IFileFocusRanker)),
            HunkAnnotations: Capable(typeof(IHunkAnnotator)),
            PreSubmitValidators: Capable(typeof(IPreSubmitValidator)),
            ComposerAssist: Capable(typeof(IComposerAssistant)),
            DraftSuggestions: Capable(typeof(IDraftSuggester)),
            DraftReconciliation: Capable(typeof(IDraftReconciliator)),
            InboxEnrichment: Capable(typeof(IInboxItemEnricher)),
            InboxRanking: Capable(typeof(IInboxRanker)));
    }

    /// <summary>The active disabled reason for the wire: the provider's ReasonCode when Live is
    /// unavailable, else "none" (Off/Preview are not "disabled" — they are deliberate modes).</summary>
    public static string DisabledReason(AiMode mode, LlmAvailability liveAvailability)
        => mode == AiMode.Live && !liveAvailability.Available ? liveAvailability.ReasonCode : "none";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AiCapabilityResolverTests"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```powershell
git add PRism.Core/Ai/AiCapabilityResolver.cs tests/PRism.Core.Tests/Ai/AiCapabilityResolverTests.cs
git commit -m "feat(ai): add AiCapabilityResolver (per-flag projection + disabled-reason)"
```

---

### Task 8: Register the resolver + the live-seam set in `AddPrismAi`

Make the resolver a singleton sharing the (empty-in-P0) live-seam set with the selector.

**Files:**
- Modify: `PRism.Web/Composition/ServiceCollectionExtensions.cs`

- [ ] **Step 1: Share one live-seam set between selector and resolver**

In `AddPrismAi`, hoist the real bag and register the resolver from its keys (add `using System.Linq;`):

```csharp
var realSeams = new Dictionary<Type, object>();   // P0: empty; P1 adds the first real impl here
services.AddSingleton(new AiCapabilityResolver(realSeams.Keys.ToHashSet()));
services.AddSingleton<IAiSeamSelector>(sp => new AiSeamSelector(
    sp.GetRequiredService<AiModeState>(),
    noop: /* the 9-entry noop dictionary from Task 4 */,
    placeholder: /* the 9-entry placeholder dictionary from Task 4 */,
    real: realSeams,
    liveAvailable: () => false));
```

> Keep the noop/placeholder dictionaries exactly as written in Task 4 Step 5; only `real` and the resolver registration are added. The resolver and selector now share the same `realSeams` key set — when P1 registers the first real impl, both light up consistently.

- [ ] **Step 2: Build to verify**

Run: `dotnet build PRism.Web/PRism.Web.csproj -c Debug`
Expected: `Build succeeded. 0 Warning(s) 0 Error(s)`.

- [ ] **Step 3: Commit**

```powershell
git add PRism.Web/Composition/ServiceCollectionExtensions.cs
git commit -m "feat(ai): register AiCapabilityResolver sharing the live-seam set with the selector"
```

---

### Task 9: Rewrite `GET /api/capabilities` (per-flag + mode + disabled reason + descriptor)

The payoff. Async, probe-in-Live-only, FE-compat-preserving.

**Files:**
- Modify: `PRism.Web/Endpoints/CapabilitiesEndpoints.cs`
- Modify: `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/CapabilitiesEndpointsTests.cs`

- [ ] **Step 1: Add an `ILlmAvailabilityProbe` override to the factory**

In `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs`, mirror the existing override hooks (`ReviewServiceOverride` etc.). Add a settable property and apply it in `ConfigureWebHost` via `RemoveAll` + `AddSingleton`:

```csharp
public ILlmAvailabilityProbe? AvailabilityProbeOverride { get; set; }

// inside ConfigureWebHost's services-configuration delegate, alongside the other overrides:
if (AvailabilityProbeOverride is not null)
{
    services.RemoveAll<ILlmAvailabilityProbe>();
    services.AddSingleton(AvailabilityProbeOverride);
}
```

Add `using PRism.AI.Contracts.Provider;` and `using Microsoft.Extensions.DependencyInjection.Extensions;` to the factory. Also add a tiny test double in the test-helpers (or inline in the test file):

```csharp
public sealed class StubAvailabilityProbe : ILlmAvailabilityProbe
{
    private readonly LlmAvailability _result;
    public StubAvailabilityProbe(LlmAvailability result) => _result = result;
    public Task<LlmAvailability> ProbeAsync(CancellationToken ct) => Task.FromResult(_result);
}
```

- [ ] **Step 2: Write the failing endpoint tests**

In `tests/PRism.Web.Tests/Endpoints/CapabilitiesEndpointsTests.cs`: **replace** the existing `public sealed record CapabilitiesResponse(AiCapabilities Ai);` with the expanded record below (do **not** declare a second — that is a CS0101 duplicate-type error), **remove the `IClassFixture<PRismWebApplicationFactory>` interface and the `_factory` field**, and **delete the old `Returns_AllOff_when_aiPreview_is_false` test** (its assertion is subsumed by the new `Off_mode_...` fact). Every new fact below uses a per-test `using var factory` — these mutate `AiModeState` / set the probe override, so a shared class fixture would leak state across tests:

```csharp
public sealed record CapabilitiesResponse(AiCapabilities Ai, string Mode, string DisabledReason);

[Fact]
public async Task Off_mode_reports_all_false_mode_off_reason_none()
{
    using var factory = new PRismWebApplicationFactory();
    factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Off;
    var client = factory.CreateClient();

    var resp = await client.GetFromJsonAsync<CapabilitiesResponse>(new Uri("/api/capabilities", UriKind.Relative));

    resp!.Ai.Summary.Should().BeFalse();
    resp.Mode.Should().Be("off");
    resp.DisabledReason.Should().Be("none");
}

[Fact]
public async Task Preview_mode_reports_all_true_keeps_ai_envelope()
{
    using var factory = new PRismWebApplicationFactory();
    factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Preview;
    var client = factory.CreateClient();

    var resp = await client.GetAsync(new Uri("/api/capabilities", UriKind.Relative));
    var raw = await resp.Content.ReadAsStringAsync();

    raw.Should().Contain("\"ai\"").And.Contain("\"summary\"");          // FE-compat envelope intact
    raw.Should().Contain("\"mode\":\"preview\"");
    using var doc = JsonDocument.Parse(raw);                             // System.Text.Json
    doc.RootElement.GetProperty("ai").GetProperty("summary").GetBoolean().Should().BeTrue();
}

[Fact]
public async Task Live_mode_with_unavailable_provider_reports_all_false_and_the_reason()
{
    using var factory = new PRismWebApplicationFactory
    {
        AvailabilityProbeOverride = new StubAvailabilityProbe(LlmAvailability.Unavailable("cli-not-installed")),
    };
    factory.Services.GetRequiredService<AiModeState>().Mode = AiMode.Live;
    var client = factory.CreateClient();

    var resp = await client.GetFromJsonAsync<CapabilitiesResponse>(new Uri("/api/capabilities", UriKind.Relative));

    resp!.Ai.Summary.Should().BeFalse();
    resp.Mode.Should().Be("live");
    resp.DisabledReason.Should().Be("cli-not-installed");
}
```

> `AvailabilityProbeOverride` must be applied before the host is built; setting it via the object initializer (before the first `CreateClient()`/`Services` access) ensures `ConfigureWebHost` sees it. If the factory builds the host lazily on first `Services` access, set the override first (as above) — do not call `factory.Services` before setting it.

- [ ] **Step 2b: Run to verify failure**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~CapabilitiesEndpointsTests"`
Expected: FAIL — endpoint still returns the interim `{ ai }` shape (no `mode`/`disabledReason`).

- [ ] **Step 3: Rewrite the endpoint**

```csharp
// PRism.Web/Endpoints/CapabilitiesEndpoints.cs
using PRism.AI.Contracts.Provider;
using PRism.Core.Ai;

// ...
app.MapGet("/api/capabilities", async (
    AiModeState state,
    AiCapabilityResolver resolver,
    ILlmAvailabilityProbe probe,
    CancellationToken ct) =>
{
    var mode = state.Mode;
    // Probe ONLY in Live mode (Off/Preview never touch the provider). KTD-4: no cache in P0.
    var availability = mode == AiMode.Live ? await probe.ProbeAsync(ct).ConfigureAwait(false) : LlmAvailability.Ok;

    return Results.Ok(new
    {
        ai = resolver.Resolve(mode, availability),                      // FE-compat: the `ai` envelope + 9 keys
        mode = mode.ToString().ToLowerInvariant(),                      // "off" | "preview" | "live"
        // §2.3 trust boundary: the provider-supplied reason string is length-capped, plain text, never HTML.
        disabledReason = Cap(AiCapabilityResolver.DisabledReason(mode, availability)),
    });

    static string Cap(string s) => s.Length <= 200 ? s : s[..200];
});
// NOTE (ce-doc-review scope finding): the descriptor's full DisabledStates[] list is intentionally NOT
// surfaced on the wire in PR2 — its only consumer is PR3's Settings → AI guidance. ProviderCapabilityDescriptor
// stays built + DI-registered (Task 6) so PR3 can project it then. PR2 surfaces only the ACTIVE disabledReason.
```

(If the endpoint file uses a `MapCapabilities` extension wrapper, keep that wrapper signature; only the lambda body/registration changes. The endpoint is mapped at `Program.cs` via `app.MapCapabilities()`. The `ProviderCapabilityDescriptor` is no longer injected here — it is still registered for PR3.)

- [ ] **Step 4: Run to verify pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~CapabilitiesEndpointsTests"`
Expected: PASS (Off/Preview/Live facts).

- [ ] **Step 5: Commit**

```powershell
git add PRism.Web/Endpoints/CapabilitiesEndpoints.cs tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs tests/PRism.Web.Tests/Endpoints/CapabilitiesEndpointsTests.cs
git commit -m "feat(ai): per-flag /api/capabilities with mode + disabled reason + descriptor (FE envelope preserved)"
```

---

### Task 10: Remove `AiCapabilities.AllOn`/`AllOff`

Now dead (the endpoint computes per-flag). Remove to prevent the binary projection regressing.

**Files:**
- Modify: `PRism.AI.Contracts/Capabilities/AiCapabilities.cs`

- [ ] **Step 1: Delete the statics**

```csharp
// PRism.AI.Contracts/Capabilities/AiCapabilities.cs
public sealed record AiCapabilities(
    bool Summary,
    bool FileFocus,
    bool HunkAnnotations,
    bool PreSubmitValidators,
    bool ComposerAssist,
    bool DraftSuggestions,
    bool DraftReconciliation,
    bool InboxEnrichment,
    bool InboxRanking);
// AllOff / AllOn removed — capabilities are computed per-flag by AiCapabilityResolver.
```

- [ ] **Step 2: Build the solution to confirm no remaining references**

Run: `dotnet build PRism.sln -c Debug`
Expected: `Build succeeded. 0 Warning(s) 0 Error(s)`. (If a stray `AllOn`/`AllOff` reference remains, the compiler names the file — fix it.)

- [ ] **Step 3: Commit**

```powershell
git add PRism.AI.Contracts/Capabilities/AiCapabilities.cs
git commit -m "refactor(ai): drop AiCapabilities.AllOn/AllOff (per-flag computation replaces the binary projection)"
```

---

### Task 11: Preferences round-trip test (mode ⇄ aiPreview compat)

Lock the FE-compat contract: the legacy `aiPreview` POST still drives the mode, and GET reflects both `aiPreview` (derived) and `aiMode`.

**Files:**
- Test: `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs`

- [ ] **Step 1: Add the round-trip facts**

```csharp
[Fact]
public async Task POST_legacy_aiPreview_true_sets_mode_preview_and_GET_reflects_both()
{
    using var factory = new PRismWebApplicationFactory();
    var client = factory.CreateClient();

    var post = await client.PostAsync(new Uri("/api/preferences", UriKind.Relative),
        JsonContent.Create(new { aiPreview = true }));
    post.IsSuccessStatusCode.Should().BeTrue();

    var prefs = await client.GetAsync(new Uri("/api/preferences", UriKind.Relative));
    var body = await prefs.Content.ReadFromJsonAsync<JsonElement>();
    var ui = body.GetProperty("ui");
    ui.GetProperty("aiPreview").GetBoolean().Should().BeTrue();   // FE still reads this
    ui.GetProperty("aiMode").GetString().Should().Be("preview");  // new field for PR3

    // and the runtime state followed the POST synchronously:
    factory.Services.GetRequiredService<AiModeState>().Mode.Should().Be(AiMode.Preview);
}

[Fact]
public async Task POST_ui_ai_mode_live_sets_mode_and_derives_aiPreview_true()
{
    using var factory = new PRismWebApplicationFactory();
    var client = factory.CreateClient();

    // dotted/kebab key isn't a valid C# identifier → raw StringContent (existing idiom)
    var post = await client.PostAsync(new Uri("/api/preferences", UriKind.Relative),
        new StringContent("""{ "ui.ai.mode": "live" }""", Encoding.UTF8, "application/json"));
    post.IsSuccessStatusCode.Should().BeTrue();

    var prefs = await client.GetAsync(new Uri("/api/preferences", UriKind.Relative));
    var body = await prefs.Content.ReadFromJsonAsync<JsonElement>();
    body.GetProperty("ui").GetProperty("aiMode").GetString().Should().Be("live");
    body.GetProperty("ui").GetProperty("aiPreview").GetBoolean().Should().BeTrue();
}
```

Add `using System.Text;`, `using PRism.Core.Ai;` if missing.

- [ ] **Step 2: Run to verify pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PreferencesEndpointsTests"`
Expected: PASS.

- [ ] **Step 3: Commit**

```powershell
git add tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs
git commit -m "test(ai): lock aiPreview<->ui.ai.mode round-trip (FE-compat) on /api/preferences"
```

---

### Task 12: Full-suite gate + docs sync

**Files:**
- Modify (if needed): `.ai/docs/` and any AI-gating doc that names `AiPreviewState`/`aiPreview` semantics
- Verify: whole solution

- [ ] **Step 1: Full build (Release) + full test suite**

Run: `dotnet build PRism.sln -c Release`
Expected: `0 Warning(s) 0 Error(s)`.
Then: `dotnet test PRism.sln --no-build -c Release` (≥300000ms timeout; foreground; one at a time).
Expected: all green. If the flaky SSE test (#209/#152) surfaces, re-run that single test once and note it — it is unrelated to PR2.

- [ ] **Step 2: Frontend sanity (no FE changes expected; prove nothing broke)**

Run the frontend unit + typecheck per `.ai/docs/development-process.md` (e.g. `npm --prefix frontend run test` and `npm --prefix frontend run build`).
Expected: green — PR2 added only fields the FE ignores; the `ai` envelope + `aiPreview` are intact. If a Playwright `ai-gating-sweep`/`a11y-audit` fixture fails, the additive-only contract was violated — fix the endpoint, not the fixture.

- [ ] **Step 3: Documentation sync (per CLAUDE.md / documentation-maintenance.md)**

Scan `.ai/docs/` (and any architecture note) for statements that describe AI gating as a single `aiPreview` bool / `AiPreviewState`; update to the tri-state `AiMode`/`ui.ai.mode` model. Include the doc edit in this PR. If no such doc exists, note "no doc references the binary gate" in the PR body.

- [ ] **Step 4: Commit (if docs changed)**

```powershell
git add .ai/docs/
git commit -m "docs(ai): update AI-gating description to the tri-state capability model"
```

---

## Self-Review

**1. Spec coverage (P0 doc line 1471 + spec §2.3/§4/§6/§7):**
- `AiSeamSelector` binary → tri-state per-feature → **Task 4**. ✅
- Replace `AllOn`/`AllOff` with per-flag computation → **Tasks 7, 9, 10**. ✅
- Minimal provider capability descriptor (disabled-states + structured-output stub; rest stubbed §2.3) → **Task 6**. ✅
- Disabled-state classifier (provider failures → reason; unknown safe bucket via `ClaudeReasonCodes.Unknown`) → **Tasks 7, 9** (consumes PR1's probe ReasonCode). ✅
- `ui.aiPreview` → `ui.ai.mode` config + migration via the existing framework; `AiModeState` replacing `AiPreviewState`; synced in `AddPrismCore` → **Tasks 2, 3, 4**. ✅
- `GET /api/capabilities` returns per-flag booleans + current mode + active disabled reason → **Task 9**. ✅
- §7 P0 exit ("per-flag false + correct disabled-state reason when the CLI is absent; reasons via the provider-supplied-list mechanism + unknown safe bucket") → **Tasks 6, 9** (probe wired Task 5; descriptor list **built + DI-registered** Task 6 for PR3; active `disabledReason` on the wire Task 9). ✅
- Stays dark / backend-only (FE-compat invariant) → **Tasks 2, 9, 11** (derived `aiPreview`, preserved `ai` envelope). ✅

**2. Placeholder scan:** every code step carries real code or exact commands. The two `// adjust to the real namespace` notes are concrete instructions (the implementer greps the existing test's `using` block — the namespaces are deterministic, not invented). No TBD/TODO.

**3. Type consistency:** `AiMode {Off,Preview,Live}`, `AiModeState{Mode}`, `AiConfig(AiMode Mode)` under `UiConfig.Ai`, `AiSeamSelector(AiModeState, noop, placeholder, real, Func<bool>)`, `AiCapabilityResolver(IReadOnlySet<Type>)` with `Resolve(AiMode, LlmAvailability)` + static `DisabledReason(AiMode, LlmAvailability)`, `ProviderCapabilityDescriptor(IReadOnlyList<ProviderDisabledState>, bool)`, `ProviderDisabledState(string ReasonCode, string DisplayLabel)`, wire fields `{ ai, mode, disabledReason }`, preferences `{ aiPreview (derived), aiMode }` — all used consistently across tasks. `ParseAiMode` (ConfigStore) and the wire string mapping (`ToString().ToLowerInvariant()`) agree on `"off"/"preview"/"live"`.

**4. Open decisions for the human-review gate:**
- **(a) Split (SC4):** KTD-8 recommends two `V2` PRs — PR2a = Tasks 1–4, PR2b = Tasks 5–12. Decide split vs. one PR.
- **(b) Live-axis machinery (SC3):** a scope reviewer argued the selector's `real` bag + `liveAvailable` Func and the resolver's `liveCapableSeams` set are speculative in P0 (zero real impls) and could collapse to `Live→Noop` / `Live→all-false` until P1. **Kept** because the spec mandates per-feature Live resolution as a P0 deliverable and the unit tests validate the mechanism — but it is a legitimate build-now-vs-defer call worth your sign-off.
- **(c) Accepted-for-P0 with documented deferrals:** KTD-4 (no probe cache; focus-refetch noted) and KTD-3 (legacy-toggle `Live→Preview` downgrade; hard guard deferred to PR3).

---

## Execution Handoff

After review-gate approval, execute via **superpowers:subagent-driven-development** (fresh subagent per task, two-stage review). Tasks 2 and 4 are the highest-risk (cross-cutting cascade) — give those a standard-or-better model; Tasks 1, 5, 6, 7, 8, 10 are mechanical. Target `V2` for the PR (never `main`).
