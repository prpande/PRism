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

**Wiring (corrected — the factory must live in `PRism.Web`, not in `AddPrismClaudeCode`).**
At `Program.cs:85` the options are built by value (`new ClaudeCodeProviderOptions { … }`) and passed to
`AddPrismClaudeCode`, which registers them via `services.AddSingleton(options)` — a pre-built singleton
*instance*, before `app.Build()`. There is no `IServiceProvider`/`configStore` local to close over at
that site, and `ClaudeCodeProviderOptions` is a sealed class (so `with` does not apply).

Critically, the factory closure **cannot live inside `AddPrismClaudeCode`**: that method is in
`PRism.AI.ClaudeCode`, which references only `PRism.AI.Contracts` + `PRism.Core.Contracts` and therefore
cannot see `IConfigStore` (in `PRism.Core`) or `AiConfigBounds` (in `PRism.Core`). Putting the closure
there would be the exact layering inversion that rejected-alternative (C) forbids. The factory must live
in `Program.cs` (which references `PRism.Core` and has `llmCwd`, `IConfigStore`, `AiConfigBounds` in
scope), precedented by `AddPrismAi`'s `ILlmAvailabilityProbe` registration in
`PRism.Web/Composition/ServiceCollectionExtensions.cs` (resolves a service inside an `sp =>` delegate):

```csharp
// in Program.cs (PRism.Web), via a new factory overload of AddPrismClaudeCode:
services.AddSingleton(sp => new ClaudeCodeProviderOptions
{
    WorkingDirectory = llmCwd,
    Timeout          = TimeSpan.FromSeconds(240),               // static fallback (default-construction path)
    TimeoutProvider  = () => TimeSpan.FromSeconds(
        AiConfigBounds.ClampTimeout(
            sp.GetRequiredService<IConfigStore>().Current.Ui.Ai.ProviderTimeoutSeconds)),
});
```

**Concretely:** add a new overload
`AddPrismClaudeCode(this IServiceCollection, Func<IServiceProvider, ClaudeCodeProviderOptions> optionsFactory, string usageDir)`
that does `services.AddSingleton(optionsFactory)` + the existing provider/probe registrations. Keep the
existing instance overload `AddPrismClaudeCode(…, ClaudeCodeProviderOptions options, …)` delegating to
the factory overload via `_ => options`, so the 3 instance-overload test call sites
(`ServiceRegistrationTests.cs:16`, `StreamingServiceRegistrationTests.cs:20` + `:33`) compile unchanged.
`Program.cs` calls the new factory overload. (Note: the `() => Timeout` default on `TimeoutProvider`
protects the *direct-constructor* test sites — `ClaudeCodeLlmProviderTests`, `…AvailabilityProbeTests`,
`…StreamingProviderTests` — NOT the `AddPrismClaudeCode(options, …)` sites; do not conflate the two.)
Those instance-overload tests do not register `IConfigStore`, so their options carry the static
`() => Timeout` default and never resolve the store — only the `Program.cs` factory path resolves it.
Reading `Current` inside the lambda gives hot-reload: a `PATCH` takes effect on the next AI request with
no restart.

Rejected alternatives:
- **(B) Thread a per-call timeout through `ILlmProvider.CompleteAsync`** and every seam call site —
  larger blast radius across all four AI seams for one knob; the timeout is a provider concern, not a
  per-request one. (The timeout-*reason* surfacing in Phase 1 covers three seams; draft-suggestions is
  deferred — see the AiEndpoints component note.)
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
    public const int MinTimeout = 30, MaxTimeout = 600, MinCap = 1, MaxCap = 50, DefaultCap = 10;
    public static int ClampTimeout(int seconds) => Math.Clamp(seconds, MinTimeout, MaxTimeout);
    public static int ClampCap(int cap) => Math.Clamp(cap, MinCap, MaxCap);
}
```
Single-sourcing means the write-clamp and the read-clamp cannot drift. **Both knobs must clamp on
write AND on every read** for the "defends a hand-edited config" guarantee to hold (a value written
directly to `config.json`, bypassing `PatchAsync`, lands in `Current` unclamped — `ReadFromDiskAsync`
does not normalize). The read-clamp sites are:
- timeout: the `Program.cs` `TimeoutProvider` lambda (already shown), `ClampTimeout`;
- cap: `ClaudeCodeHunkAnnotator.cs:120-121`. The annotator already has a `cap <= 0 → DefaultCap` floor
  (legacy/missing → 10, pinned by `Nonpositive_cap_clamps_to_ten`). **Keep that floor** (≤0 is "absent",
  not "out of range" — it must default to 10, not the min 1), and add the upper bound after it:
  `if (cap <= 0) cap = AiConfigBounds.DefaultCap; cap = Math.Min(cap, AiConfigBounds.MaxCap);`. The
  annotator is in `PRism.Web`, which can see `AiConfigBounds`. (`ClampCap`'s symmetric `[1,50]` is the
  *write*-path clamp, where a user explicitly typed a value so the min is 1.)
- both: the GET `BuildResponse` DTO (below), so the *displayed* value equals the *effective* value.

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
  — a non-integer JSON number (e.g. `3.5`) **or one outside Int32 range** (e.g. `99999999999`) makes
  `TryGetInt32` return false → `null`, which the `ConfigFieldType.Int` guard rejects as 400 (consistent
  with the existing null-on-unsupported-kind path). Both cases → 400 (not clamp).
- GET `BuildResponse` → `UiPreferencesDto`: add `HunkAnnotationCap` and `ProviderTimeoutSeconds`,
  **clamped for display** so the shown value equals the effective value even after a hand-edited config:
  `ProviderTimeoutSeconds: AiConfigBounds.ClampTimeout(ui.Ai.ProviderTimeoutSeconds)` and
  `HunkAnnotationCap: AiConfigBounds.ClampCap(ui.Ai.HunkAnnotationCap)`. (The only residual discrepancy
  is the cap's legacy-`0` corner — GET shows `ClampCap(0)=1` while the annotator floors `≤0→10`; a
  persisted literal `0` is vanishingly rare since an absent key binds to the constructor default `10`.)

**`PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs`**
- Add `public Func<TimeSpan> TimeoutProvider { get; init; }` defaulting to `() => Timeout`.

**`PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs`**
- `Timeout: options.Timeout` → `Timeout: options.TimeoutProvider()` (evaluated once at the top of
  `CompleteAsync`).

**`PRism.AI.ClaudeCode/LlmProviderException.cs`**
- Add `public bool TimedOut { get; }`; thread an optional `bool timedOut = false` through the 3-arg
  failure ctor; set `true` only at the timeout throw site. The CA1032 ctors inherit `false`.

**`PRism.Web/Program.cs` + `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs`**
- Add a factory overload `AddPrismClaudeCode(this IServiceCollection, Func<IServiceProvider,
  ClaudeCodeProviderOptions>, string usageDir)` that does `services.AddSingleton(optionsFactory)` plus
  the existing provider/probe registrations. Keep the existing instance overload delegating to it
  (`_ => options`) so the 3 instance-overload test sites compile unchanged. The factory closure
  (resolving `IConfigStore` + `AiConfigBounds`) lives in **`Program.cs`** (PRism.Web), NOT inside
  `AddPrismClaudeCode` (PRism.AI.ClaudeCode can't see those symbols — that would be inversion (C)). See
  the Architecture wiring section for the full reconciliation and the test-compatibility analysis.

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
- **ARIA / accessible name:** the **spinbutton container** carries `role="spinbutton"` with
  `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and **`aria-valuetext`** (so screen readers announce
  units, not a bare number): `"{n} seconds"` for the timeout, `"{n} annotations"` for the cap. The
  container is named via `aria-labelledby` pointing at a visible `<label>` element rendered adjacent to
  the control (sighted users need the unit too). The decrement/increment buttons are pointer/touch
  affordances only — `aria-hidden="true"` with `tabIndex={-1}`; the **container** receives focus and
  handles all keyboard events (the standard spinbutton model, since no codebase example exists to copy).
- **Keyboard:** ArrowUp/Down = ±step, PageUp/Down = ±step, Home/End = min/max (standard spinbutton).
- **Boundary:** at min the decrement button is `disabled`; at max the increment button is `disabled`
  (no silent no-op clicks). A disabled boundary button is not focusable and is skipped by AT (it's
  `aria-hidden` regardless). Step arithmetic snaps to the step grid from the current value.
- **Write model:** apply-on-success, matching `usePreferences().set` (`PreferencesContext` is
  apply-on-success: the POST response's value lands directly, no GET round-trip). The displayed value
  reflects the server-echoed (clamped) value, so a clamp self-corrects without a flicker — and because
  the bounded stepper can't produce an out-of-range value via the UI, the clamp path is unreachable from
  the control anyway (the GET-on-mount value is also clamped — see `BuildResponse`).
- Props: `{ label, value, min, max, step, unit, onChange }` (`label` becomes the visible `<label>`
  referenced by `aria-labelledby`).

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
- **Double-Escape note (parity-only, pre-existing — out of scope to "fix"):** the consent-modal
  interaction is transplanted verbatim, and it **already exists today** — `AppearancePane.tsx:232`
  renders `EgressConsentModal` inside `SettingsModal`. Moving it to `AiPane` introduces nothing new. The
  implementer verifies *parity* (pressing Escape on the outer `SettingsModal` while the inner
  `EgressConsentModal` is open behaves exactly as it does in Appearance today — the `abortRef` cleanup on
  unmount is the existing guard). Any change to the `Modal.tsx`/`SettingsModal.tsx` document-level Escape
  propagation is a **separate pre-existing concern, explicitly out of this phase's scope** — do not
  expand a settings-tab PR into a modal-event-handling refactor; file a follow-up if real misbehavior is
  observed.

**`frontend/src/components/Settings/panes/AppearancePane.tsx`**
- Remove the AI-mode section (now in `AiPane`), its constants, and update the subtitle (drop "…and AI
  mode"). Appearance keeps theme/accent/density/content-scale.

**`frontend/src/contexts/PreferencesContext.tsx` + preferences types**
- Extend the preferences shape (the GET DTO type) with `providerTimeoutSeconds: number` and
  `hunkAnnotationCap: number`.
- **`set('ui.ai.…', n)` requires three coupled edits** (without them it won't typecheck and, worse,
  `writeKey`'s `inbox.sections.${id}` fall-through would mis-slice an AI key and silently corrupt state):
  (1) add `'ui.ai.providerTimeoutSeconds' | 'ui.ai.hunkAnnotationCap'` to the `PreferenceKey` union;
  (2) add both to the `InboxSectionKey` `Exclude<…>` list; (3) add explicit `readKey`/`writeKey` branches
  for both **before** the inbox-sections fall-through. These are load-bearing for apply-on-success
  correctness, not optional polish.

**`frontend/src/api/aiSummary.ts`, `aiFileFocus.ts`, `aiHunkAnnotations.ts`, `aiDraftSuggestions.ts`**
- On a 503, surface `ApiError.body.reason` (`'timeout' | 'provider-error'`, default `'provider-error'`)
  on the returned failure shape so the hooks can pass it to `report`.

**`frontend/src/components/Ai/aiFailure.tsx`** — the `anyTimedOut` value needs an explicit prop-chain
(none of these exist today):
- `FailureEntry` gains `reason?: AiFailureReason` (`'timeout' | 'provider-error'`); `report(prRef, seam,
  opts)` (opts already an object) carries it; the registry stores it per seam.
- `AiFailureApi` exposes a derived `anyTimedOut: boolean` (computed parallel to `activeFailedSeams`/
  `dismissed`): true when any active failed seam's reason is `'timeout'`.
- `AiFailureContainer` reads `anyTimedOut` from `useAiFailure()` and passes it to `AiFailureToast`;
  `AiFailureToast`'s `Props` gains `anyTimedOut: boolean`.
- **The dismissal fingerprint does NOT incorporate `reason`** — a reason change for the same set of
  failed seams does not un-dismiss the toast. A retry already clears the dismissal
  (`setDismissedFingerprint(null)` in `retryAll`), which is the intended un-dismiss path.

**`frontend/src/components/Ai/AiFailureContainer.tsx`**
- Destructure `anyTimedOut` from `useAiFailure()` and forward it to `AiFailureToast`.
- The `sr-only` polite live region stays **generic** ("AI generation failed.") regardless of reason — it
  fires once on appearance to announce *that* a failure occurred; the reason-specific copy and actions
  live in the toast's focus order, which the user reaches for detail. (Documented choice, not an oversight.)

**`frontend/src/components/Ai/AiFailureToast.tsx`**
- When `anyTimedOut`, render timeout copy ("AI generation timed out.") plus an **"Adjust timeout"**
  secondary action (alongside the existing Retry-all). Otherwise the existing generic line + Retry-all.
- The action calls `navigate('/settings/ai', { state: { backgroundLocation: location } })` — the
  `backgroundLocation` state is **required** so the settings modal opens *over* the current PR; without
  it, `App.tsx`'s `isSettingsPath` fallback (`{ pathname: '/' }`) tears the PR down and the user lands on
  the Inbox with the failure context lost. After the user adjusts the timeout and closes Settings, the PR
  remounts, the failed seams remain in the registry, and the toast re-appears so the user can Retry with
  the new timeout.
- **Post-adjust copy state (decided — option A):** after returning from Settings, the toast still shows
  "AI generation timed out." with the same "Adjust timeout" link. This is accurate — the seam *did* time
  out and has not been retried — and **Retry-all is co-located on the same toast** as the path to
  progress, so this is not a dead-end loop. The "Adjust timeout" label does NOT change after first use
  (it remains a re-entry to tweak further); the link is not auto-hidden or relabeled. Adjusting the
  timeout does **not** auto-retry on Settings-close — the user explicitly clicks Retry. (Auto-retry-on-
  close and a "Retry with the new timeout" copy hint were considered and deferred as a future polish.)

---

## Validation & error handling

| Input | Rule | On violation |
|-------|------|--------------|
| `ui.ai.providerTimeoutSeconds` | integer in Int32 range, clamp to `[30,600]` on write | non-integer **or out-of-Int32-range** number → 400 (`TryGetInt32` fails on both); in-range out-of-bounds → clamped |
| `ui.ai.hunkAnnotationCap` | integer in Int32 range, clamp to `[1,50]` on write | non-integer **or out-of-Int32-range** number → 400; in-range out-of-bounds → clamped |
| AI seam 503 | body `{ reason }` set from `ex.TimedOut` | missing reason on FE → `provider-error` |

**Clamp-not-reject rationale.** The control is a bounded `NumberStepper`, so the UI can never emit an
out-of-range value — the clamp path is unreachable from the real user flow. Server-side clamp is the
authoritative backstop on **write AND read** (defends a direct API call or a hand-edited config — both
write-clamp in `PatchAsync` and read-clamp at every consumption site, see `AiConfigBounds`), and because
`set` is apply-on-success the POST response returns the post-clamp value directly (no GET round-trip, no
visible flicker); the GET-on-mount value is clamped too, so the displayed value always equals the
effective value. Clamp-not-reject is scoped to these **bounded-numeric** knobs only; future free-form
AI settings (model IDs, prompts in #485 phases 2–3) should reject-with-message rather than silently
rewrite a user-typed value. Distinction: an absurd JSON *number type* (non-integer / Int32 overflow) is
**rejected** (400) at the parse boundary; an in-range integer that's merely out of the knob's bounds is
**clamped**.

---

## Testing

**Backend (xUnit + FluentAssertions):**
- `ConfigStore` patch: numeric timeout/cap accepted (new `Int` field type); out-of-range clamped to
  bounds; non-integer (`null` from the endpoint) → `ConfigPatchException`.
- `PreferencesEndpoints`: `JsonValueKind.Number` patch round-trips; GET DTO exposes both values, **clamped**
  (write a hand-edited out-of-range `Current`, assert GET returns the clamped value); `3.5` → 400 and an
  Int32-overflow number (`99999999999`) → 400.
- `ClaudeCodeLlmProvider`: `TimeoutProvider` is evaluated per call (changing the backing value between
  calls changes the `ProcessSpec.Timeout`); default still `() => Timeout`.
- DI factory: the new factory overload's `ClaudeCodeProviderOptions.TimeoutProvider` reads
  `IConfigStore.Current` (patch the store, resolve options, assert the provider sees the new value). The
  existing instance-overload registration tests (which do NOT register `IConfigStore`) keep passing on
  the `() => Timeout` default — confirm they don't resolve the store.
- `ClaudeCodeHunkAnnotator`: existing `Nonpositive_cap_clamps_to_ten` still passes (floor preserved); add
  a case that a hand-edited cap above the max (e.g. 999) is upper-clamped to 50 on read.
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
