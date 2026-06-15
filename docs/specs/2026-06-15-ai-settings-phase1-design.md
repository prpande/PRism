---
title: AI Settings tab — Phase 1 (timeout + cap + #484 timeout copy)
issue: 496
parent: 485
epic: 423
milestone: v2 — AI
status: design
date: 2026-06-15
---

# AI Settings tab — Phase 1

## Problem

Two AI knobs are baked into code today and cannot be changed without a rebuild:

- The Claude CLI provider timeout is hard-wired to 240 s at DI registration
  (`PRism.Web/Program.cs`, passed into `ClaudeCodeProviderOptions.Timeout` and read in
  `ClaudeCodeLlmProvider.CompleteAsync`). #414's live validation showed real annotator latency
  near the prior 60 s edge, forcing the 240 s bump; there is no way for a user on a slow box or a
  slow network to raise it further.
- The hunk-annotation cap (`AiConfig.HunkAnnotationCap`, default 10) is config-file + hot-reload
  only — its *read* key exists in `AiConfig` but it is **not** in the `ConfigStore.PatchAsync`
  allowlist (not API-patchable) and not surfaced in the UI (the deferral logged as #481).

Separately, #484 shipped the AI-failure toast but deferred timeout-specific copy: when a seam fails
because the provider timed out, the user sees the generic "AI generation failed" line with no lever
to do anything about it, because no timeout lever existed.

There is also no home in Settings for AI configuration. The global **AI mode** (Off / Preview /
Live) currently lives inside the **Appearance** pane, which is the wrong altitude — it is not an
appearance concern, and the upcoming AI surface (#485 phases 2–3: model/tool selection, prompt
view/edit, per-feature toggles) has nowhere to land.

This is **Phase 1 of #485** (a multi-phase container). It establishes the AI Settings tab shell and
ships the two configurable knobs plus the #484 timeout copy. Later phases fill the tab in.

## Goals

1. A dedicated **AI** settings tab (4th primary pane) with a stable route (`/settings/ai`).
2. Make the **provider timeout** user-configurable, hot-reloaded (no restart), and clamped.
3. Make the **hunk-annotation cap** API-patchable and surfaced in the UI (closes #481's deferral).
4. Relocate the **AI mode** control (and its consent flow) from Appearance into the AI tab.
5. Give #484's failure toast **timeout-specific copy** plus an **"Adjust timeout"** deep-link to the
   AI tab, shown whenever at least one failed seam timed out.

Goal 4 is included in Phase 1 (rather than deferred to Phase 2) to avoid a transient state where AI
mode appears in two Settings panes simultaneously during development. If Phase 1 scope is ever
trimmed, Goal 4 is the first candidate to defer — but it should land before the tab is announced.

## Non-goals (deferred to later #485 phases / other issues)

- Per-feature AI toggles (`AiFeaturesConfig.Enabled` already has backend support — UI deferred).
- Model / tool selection (#485 phase 2), prompt view/edit (#485 phase 3).
- Consent management beyond the existing `EgressConsentModal` Live-gate flow (#429 / #427).
- Rate limiting (#438), configurable Claude CLI path (#490).

---

## Architecture

### Decision: how the configurable timeout is read "hot"

The cap is read fresh per call from `_configStore.Current.Ui.Ai.HunkAnnotationCap` in the **Web-layer**
seam (`ClaudeCodeHunkAnnotator`). The timeout is different: it is consumed deep in
`PRism.AI.ClaudeCode.ClaudeCodeLlmProvider.CompleteAsync` (`Timeout: options.Timeout`), a low-level
CLI wrapper that has no business knowing about `IConfigStore`.

**Chosen approach (A): a `Func<TimeSpan>` on the provider options, supplied by a DI factory.**

- `ClaudeCodeProviderOptions` gains `Func<TimeSpan> TimeoutProvider { get; init; }`, defaulting to
  `() => Timeout` (backward-compatible — existing construction and the 4 test call sites keep working).
- `ClaudeCodeLlmProvider` evaluates `options.TimeoutProvider()` **per call** instead of reading the
  static `options.Timeout`. It is evaluated once at the top of `CompleteAsync`, before `RunAsync`, and
  the resulting `TimeSpan` is used synchronously within that same call — no read-stale split.

**Wiring (corrected — the options are *not* constructible with `configStore` in scope today).**
At `Program.cs:85` the options are built by value (`new ClaudeCodeProviderOptions { … }`) and registered
by `AddPrismClaudeCode` via `services.AddSingleton(options)` — a pre-built singleton *instance*, before
`app.Build()`. There is no `IServiceProvider`/`configStore` local to close over at that site, and
`ClaudeCodeProviderOptions` is a sealed class (so `with` does not apply). The fix, precedented by the
`ClaudeCodeHunkAnnotator` registration in `PRism.Web/Composition/ServiceCollectionExtensions.cs` (which
resolves `IConfigStore` inside an `sp =>` delegate), is to register the options through a **factory**:

```csharp
services.AddSingleton(sp => new ClaudeCodeProviderOptions
{
    WorkingDirectory = llmCwd,
    Timeout          = TimeSpan.FromSeconds(240),               // static fallback
    TimeoutProvider  = () => TimeSpan.FromSeconds(
        AiConfigBounds.ClampTimeout(
            sp.GetRequiredService<IConfigStore>().Current.Ui.Ai.ProviderTimeoutSeconds)),
});
```

`AddPrismClaudeCode` changes from taking a pre-built `options` instance to registering it via this
factory (the 4 test call sites that pass a literal options object keep compiling because
`TimeoutProvider` defaults to `() => Timeout`). Reading `Current` inside the lambda gives hot-reload:
a `PATCH` takes effect on the next AI request with no restart.

Rejected alternatives:
- **(B) Thread a per-call timeout through `ILlmProvider.CompleteAsync`** and every seam call site —
  larger blast radius across all four seams for one knob; the timeout is a provider concern, not a
  per-request one.
- **(C) Inject `IConfigStore` into `ClaudeCodeLlmProvider`** — layering violation; the provider is a
  CLI wrapper in `PRism.AI.ClaudeCode` and must not depend on app config.

(A) keeps config-reading in the composition root (where `sp`/`IConfigStore` is reachable via the
factory), leaves the `ILlmProvider` interface untouched, and gets hot-reload for free.

### Decision: distinguishing timeout from generic provider failure

`LlmProviderException.ExitCode` is `-1` for **both** timeout and spawn-not-found, so exit code is not a
reliable discriminator, and message-string sniffing is fragile (a pattern we've been bitten by before).

**Add a typed discriminator:** `LlmProviderException` gains `public bool TimedOut { get; }`, set `true`
**only** at the timeout throw site (`ClaudeCodeLlmProvider`'s `if (result.TimedOut) throw …`). All
other throw sites (exit-code, spawn `Win32Exception`, JSON-parse) leave it `false`. The three CA1032
framework constructors do not set `TimedOut`; they inherit the CLR default `false`, which is correct.
`AiEndpoints` reads `ex.TimedOut` to pick the 503 reason.

This is reliable because the runner (`SystemCliProcessRunner`) enforces the user-facing timeout with a
linked CTS (`timeoutCts.CancelAfter(spec.Timeout)`) and explicitly separates the two cancellation
sources: a timeout returns `ProcessResult(TimedOut: true)`, whereas caller-`ct` cancellation rethrows
`OperationCanceledException`. No seam wraps the provider call in its own CTS, so the provider's own
timeout reliably surfaces as `TimedOut: true`. (Out of scope: a genuine client disconnect at ~timeout
fires `ct` → `OperationCanceledException`, which propagates past the `catch (LlmProviderException)` arm
as a generic abort with no reason. That is a client-abort, not a provider timeout, and pre-exists this
spec; the reason mechanism deliberately does not cover it.)

### End-to-end flow for the timeout knob

```
User adjusts the timeout stepper in the AI pane (e.g. 240 → 300)
  → POST /api/preferences { "ui.ai.providerTimeoutSeconds": 300 }
  → PreferencesEndpoints parses JsonValueKind.Number → int
  → ConfigStore.PatchAsync clamps to [30,600], persists, advances Current
  → the POST response (apply-on-success) echoes the clamped value; the pane reflects it
Next AI request:
  → ClaudeCodeLlmProvider.CompleteAsync calls options.TimeoutProvider()
  → reads configStore.Current.Ui.Ai.ProviderTimeoutSeconds (= 300), clamps, uses it
```

### End-to-end flow for the #484 timeout copy

```
Provider times out
  → ClaudeCodeLlmProvider throws LlmProviderException(TimedOut: true)
  → AiEndpoints catch → 503 with body { "reason": "timeout" }
  → frontend api client (e.g. aiSummary.ts) reads ApiError.body.reason
  → the seam hook reports { seam, reason: 'timeout' } to AiFailureProvider
  → AiFailureToast: if any failed seam reason === 'timeout', show timeout copy +
    "Adjust timeout" action → navigate('/settings/ai', { state: { backgroundLocation: location } })
```

---

## Components

### Backend

**`PRism.Core/Config/AppConfig.cs` — `AiConfig`**
Add a trailing-defaulted member (STJ-net10 honors constructor defaults for missing keys — proven by the
existing `ConfigStoreHunkAnnotationCapTests.Missing_cap_key_binds_to_the_constructor_default`):
```csharp
public sealed record AiConfig(
    AiMode Mode,
    AiConsentConfig Consent,
    AiFeaturesConfig Features,
    int HunkAnnotationCap = 10,
    int ProviderTimeoutSeconds = 240);
```
Backed by config key `ui.ai.providerTimeoutSeconds`. The cap *read* key already exists; this slice adds
both to the patch allowlist.

**`PRism.Core/Config/AiConfigBounds.cs` (new) — the single-sourced clamp**
A static helper in **PRism.Core** (referenced by both `ConfigStore` and the `Program.cs` factory, which
`PRism.Web` can reach since it references `PRism.Core` — placing it in `PRism.Web` would be a layering
violation for `ConfigStore`):
```csharp
public static class AiConfigBounds
{
    public static int ClampTimeout(int seconds) => Math.Clamp(seconds, 30, 600);
    public static int ClampCap(int cap) => Math.Clamp(cap, 1, 50);
}
```
Single-sourcing means the write-clamp (in `PatchAsync`) and the read-clamp (in the `TimeoutProvider`
lambda) cannot drift.

**`PRism.Core/Config/ConfigStore.cs` — `PatchAsync` (the patch path is String/Bool-only today)**
The validator models only `ConfigFieldType { String, Bool }` and every apply-arm casts `(string)`/`(bool)`.
Numeric keys cannot just be "accepted" — extend the type table:
- Add `Int` to the `ConfigFieldType` enum.
- Add `["ui.ai.providerTimeoutSeconds"] = ConfigFieldType.Int` and `["ui.ai.hunkAnnotationCap"] =
  ConfigFieldType.Int` to `_allowedFields`.
- Add a guard arm in the pre-gate type switch: `case ConfigFieldType.Int when value is not int: throw
  new ConfigPatchException($"field '{key}' expects an integer value (got {DescribeValue(value)})");`
- Add the two apply-switch arms, clamping on write via `AiConfigBounds`:
  `"ui.ai.providerTimeoutSeconds" => _current with { Ui = ui with { Ai = ui.Ai with {
  ProviderTimeoutSeconds = AiConfigBounds.ClampTimeout((int)value!) } } }` (and the cap arm with
  `ClampCap`). Out-of-range values are **clamped, not rejected** (see Validation rationale below). A
  non-integer value for these keys → `ConfigPatchException` → 400.

**`PRism.Web/Endpoints/PreferencesEndpoints.cs`**
- POST value parsing currently maps `String/True/False` and folds everything else (incl. numbers) to
  `null`. Add `JsonValueKind.Number` handling: `props[0].Value.TryGetInt32(out var n) ? n : (object?)null`
  — a non-integer JSON number (e.g. `3.5`) falls through to `null`, which the `ConfigFieldType.Int` guard
  rejects as 400 (consistent with the existing null-on-unsupported-kind path).
- GET `BuildResponse` → `UiPreferencesDto`: add `HunkAnnotationCap` and `ProviderTimeoutSeconds`
  (from `config.Current.Ui.Ai`) so the pane can render current values.

**`PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs`**
- Add `public Func<TimeSpan> TimeoutProvider { get; init; }` defaulting to `() => Timeout`.

**`PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs`**
- `Timeout: options.Timeout` → `Timeout: options.TimeoutProvider()` (evaluated once at the top of
  `CompleteAsync`).

**`PRism.AI.ClaudeCode/LlmProviderException.cs`**
- Add `public bool TimedOut { get; }`; thread an optional `bool timedOut = false` through the 3-arg
  failure ctor; set `true` only at the timeout throw site. The CA1032 ctors inherit `false`.

**`PRism.Web/Program.cs` + `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs`**
- Register `ClaudeCodeProviderOptions` via the DI factory shown in the Architecture section so the
  `TimeoutProvider` closure can defer-resolve `IConfigStore`. `AddPrismClaudeCode`'s signature changes
  from "takes a pre-built options instance" to "registers via the factory"; the 4 test call sites keep
  compiling via the `() => Timeout` default.

**`PRism.Web/Endpoints/AiEndpoints.cs`**
- The three `catch (LlmProviderException)` arms currently return `Results.StatusCode(503)` (no body).
  Change to `Results.Json(new AiFailureBody(ex.TimedOut ? "timeout" : "provider-error"), statusCode: 503)`.
- The `catch (ArgumentException)` (oversized prompt) arms → `reason: "provider-error"`.
- New tiny record `AiFailureBody(string Reason)` (camel-cased on the wire → `{ "reason": "timeout" }`).
- **draft-suggestions asymmetry (explicit Phase-1 scope decision):** the draft-suggestions endpoint has
  no try/catch (canned `PlaceholderDraftSuggester`, cannot throw), so it is intentionally **out of the
  timeout-reason scope** for Phase 1. Add a guardrail comment mirroring the existing IsSubscribed
  guardrail: *the PR that swaps in a real draft-suggestions seam MUST add the
  `catch (LlmProviderException) → 503 { reason }` arm, or a provider timeout there will surface as a 500
  and bypass the reason mechanism (the "Adjust timeout" deep-link will never fire for that seam).* The
  frontend treats a missing `reason` as `provider-error`.

### Frontend

**`frontend/src/components/controls/NumberStepper.tsx` (new) — the design-system numeric control**
No numeric stepper exists in `controls/` today; it must be built. Spec:
- **ARIA:** `role="spinbutton"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and
  **`aria-valuetext`** (so screen readers announce units, not a bare number): `"{n} seconds"` for the
  timeout, `"{n} annotations"` for the cap. A visible unit label is rendered adjacent to the value
  (sighted users need the unit too), matching the label/`describedById` pattern of `SegmentedControl`.
- **Keyboard:** ArrowUp/Down = ±step, PageUp/Down = ±step, Home/End = min/max (standard spinbutton).
- **Boundary:** at min the decrement button is `disabled`; at max the increment button is `disabled`
  (no silent no-op clicks). Step arithmetic snaps to the step grid from the current value.
- **Write model:** apply-on-success, matching `usePreferences().set` (`PreferencesContext` is
  apply-on-success: the POST response's value lands directly, no GET round-trip). The displayed value
  reflects the server-echoed (clamped) value, so a clamp self-corrects without a flicker — and because
  the bounded stepper can't produce an out-of-range value via the UI, the clamp path is unreachable from
  the control anyway.
- Props: `{ label, value, min, max, step, unit, onChange }`.

**`frontend/src/components/Settings/SettingsNav.tsx`**
- Add `{ section: 'ai', label: 'AI' }` to `PRIMARY`. Default position: after Appearance (see Open
  questions for the IA criterion).

**`frontend/src/components/Settings/SettingsModalRoutes.tsx`**
- Add `<Route path="ai" element={<AiPane />} />`. The `RedirectToAppearance` default + catch-all stay
  pointed at Appearance.

**`frontend/src/components/Settings/panes/AiPane.tsx` (new)**
- Subtitle (`.sub`): "AI mode, provider timeout, and annotation settings."
- Row order (priority): **AI mode → provider timeout → hunk-annotation cap.**
- **AI mode** control (Off / Preview / Live) + `EgressConsentModal` Live-gate wiring, moved verbatim
  from `AppearancePane` — including the `AI_MODES`/`AI_MODE_LABELS` constants, the `pendingLive`/
  `abortRef`/`focusTargetRef` two-phase consent state, the `modalOpen`-keyed focus-restoration effect,
  and the `useEffect(() => () => abortRef.current?.abort(), [])` unmount cleanup. (See the double-Escape
  note below.)
- **Provider timeout** `NumberStepper` (unit "seconds"; default 240; min 30; max 600; step 30) →
  `set('ui.ai.providerTimeoutSeconds', n)`.
- **Hunk-annotation cap** `NumberStepper` (unit "annotations"; default 10; min 1; max 50; step 1) →
  `set('ui.ai.hunkAnnotationCap', n)`.
- No Phase-2 placeholder row — ship the three rows; the tab is intentionally a shell for later phases.
- **Double-Escape note:** the consent-modal interaction is transplanted verbatim. The implementer must
  verify that pressing Escape on the outer `SettingsModal` while the inner `EgressConsentModal` is open
  aborts the in-flight disclosure fetch and leaves no orphaned state — the `abortRef` cleanup on
  `AiPane` unmount is the intended guard. This is a live-test verification, not a code change.

**`frontend/src/components/Settings/panes/AppearancePane.tsx`**
- Remove the AI-mode section (now in `AiPane`), its constants, and update the subtitle (drop "…and AI
  mode"). Appearance keeps theme/accent/density/content-scale.

**`frontend/src/hooks/usePreferences` + preferences types**
- Extend the preferences shape with `providerTimeoutSeconds: number` and `hunkAnnotationCap: number`
  (read from the GET DTO).

**`frontend/src/api/aiSummary.ts`, `aiFileFocus.ts`, `aiHunkAnnotations.ts`, `aiDraftSuggestions.ts`**
- On a 503, surface `ApiError.body.reason` (`'timeout' | 'provider-error'`, default `'provider-error'`)
  on the returned failure shape so the hooks can pass it to `report`.

**`frontend/src/components/Ai/aiFailure.tsx`**
- `report(prRef, seam, opts)` (opts already an object) extended to carry an optional
  `reason: AiFailureReason`; the registry tracks it per seam; a derived `anyTimedOut` memo (parallel to
  `activeFailedSeams`) is true when any active failed seam's reason is `'timeout'`.
- **The dismissal fingerprint does NOT incorporate `reason`** — a reason change for the same set of
  failed seams does not un-dismiss the toast. A retry already clears the dismissal
  (`setDismissedFingerprint(null)` in `retryAll`), which is the intended un-dismiss path.

**`frontend/src/components/Ai/AiFailureToast.tsx`**
- When `anyTimedOut`, render timeout copy ("AI generation timed out.") plus an **"Adjust timeout"**
  secondary action (alongside the existing Retry-all). Otherwise the existing generic line + Retry-all.
- The action calls `navigate('/settings/ai', { state: { backgroundLocation: location } })` — the
  `backgroundLocation` state is **required** so the settings modal opens *over* the current PR; without
  it, `App.tsx`'s `isSettingsPath` fallback (`{ pathname: '/' }`) tears the PR down and the user lands on
  the Inbox with the failure context lost. After the user adjusts the timeout and closes Settings, the PR
  remounts, the failed seams remain in the registry, and the toast re-appears so the user can Retry with
  the new timeout.

---

## Validation & error handling

| Input | Rule | On violation |
|-------|------|--------------|
| `ui.ai.providerTimeoutSeconds` | integer, clamp to `[30,600]` on write | non-integer → 400; out-of-range → clamped |
| `ui.ai.hunkAnnotationCap` | integer, clamp to `[1,50]` on write | non-integer → 400; out-of-range → clamped |
| AI seam 503 | body `{ reason }` set from `ex.TimedOut` | missing reason on FE → `provider-error` |

**Clamp-not-reject rationale.** The control is a bounded `NumberStepper`, so the UI can never emit an
out-of-range value — the clamp path is unreachable from the real user flow. Server-side clamp is the
authoritative backstop (defends a direct API call or a hand-edited config), and because `set` is
apply-on-success the POST response returns the post-clamp value directly (no GET round-trip, no
visible flicker). Clamp-not-reject is scoped to these **bounded-numeric** knobs only; future free-form
AI settings (model IDs, prompts in #485 phases 2–3) should reject-with-message rather than silently
rewrite a user-typed value.

---

## Testing

**Backend (xUnit + FluentAssertions):**
- `ConfigStore` patch: numeric timeout/cap accepted (new `Int` field type); out-of-range clamped to
  bounds; non-integer (`null` from the endpoint) → `ConfigPatchException`.
- `PreferencesEndpoints`: `JsonValueKind.Number` patch round-trips; GET DTO exposes both values; `3.5` → 400.
- `ClaudeCodeLlmProvider`: `TimeoutProvider` is evaluated per call (changing the backing value between
  calls changes the `ProcessSpec.Timeout`); default still `() => Timeout`.
- DI factory: the registered `ClaudeCodeProviderOptions.TimeoutProvider` reads `IConfigStore.Current`
  (patch the store, resolve options, assert the provider sees the new value).
- `LlmProviderException.TimedOut`: `true` only on the timeout path, `false` on exit-code / spawn / parse paths.
- `AiEndpoints`: timeout `LlmProviderException` → 503 `{ reason: "timeout" }`; generic → `provider-error`;
  oversized-prompt `ArgumentException` → `provider-error`.

**Frontend (vitest + Testing Library):**
- `NumberStepper`: renders spinbutton with `aria-valuetext`; keyboard ±step / Home / End; decrement
  disabled at min, increment disabled at max; `onChange` fires with the stepped value.
- **Migrate the ~13 AI-mode cases** (radiogroup render, Live two-phase commit cases, already-consented
  short-circuit, focus-to-Live-on-Accept, focus-restore-on-Decline, abort-on-downgrade, no-advance-
  while-pending) **and their `vi.hoisted` prefs harness + `aiConsent` mocks** from
  `AppearancePane.test.tsx` to `AiPane.test.tsx`. `AppearancePane.test.tsx` loses its AI cases and the
  `aiConsent` mock and asserts the section is gone.
- api clients: 503 with `{reason:'timeout'}` surfaces `reason: 'timeout'`; 503 without a body → `provider-error`.
- `aiFailure`: `anyTimedOut` derives correctly across mixed-reason failures and recovers on clear; a
  reason change for the same seam set does NOT un-dismiss.
- `AiFailureToast`: timeout copy + "Adjust timeout" deep-link shown iff `anyTimedOut`; the action
  navigates with `backgroundLocation` state.

**e2e (Playwright):**
- Open Settings → AI tab renders; change the timeout stepper; reload → value persists.
- Force a seam 503 with `{reason:'timeout'}` → toast shows "Adjust timeout" → clicking it opens the AI
  tab over the PR (PR not torn down).

**Visual baselines:** new AI pane (both themes) + Appearance pane with the AI section removed (both themes).

---

## Open questions

- Position of the AI tab in the nav. Criterion for visual review: is AI mode + provider config more like
  a *display preference* (keep adjacent to Appearance) or a *feature configuration* (move to the end of
  the PRIMARY list, before the System divider)? Default to after Appearance pending that call.
