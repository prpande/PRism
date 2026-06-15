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
  only — not API-patchable and not surfaced in the UI (the deferral logged as #481).

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

**Chosen approach (A): a `Func<TimeSpan>` on the provider options, wired at the composition root.**

- `ClaudeCodeProviderOptions` gains `Func<TimeSpan> TimeoutProvider { get; init; }`, defaulting to
  `() => Timeout` (backward-compatible — existing construction keeps working).
- `ClaudeCodeLlmProvider` evaluates `options.TimeoutProvider()` **per call** instead of reading the
  static `options.Timeout`.
- `Program.cs` wires `TimeoutProvider = () => TimeSpan.FromSeconds(
  ClampTimeout(configStore.Current.Ui.Ai.ProviderTimeoutSeconds))`, reading `Current` on every call so
  a `PATCH` takes effect on the next AI request with no restart.

Rejected alternatives:
- **(B) Thread a per-call timeout through `ILlmProvider.CompleteAsync`** and every seam call site —
  larger blast radius across all four seams for one knob; the timeout is a provider concern, not a
  per-request one.
- **(C) Inject `IConfigStore` into `ClaudeCodeLlmProvider`** — layering violation; the provider is a
  CLI wrapper in `PRism.AI.ClaudeCode` and must not depend on app config.

(A) keeps config-reading in the composition root (which already has `configStore`), leaves the
`ILlmProvider` interface untouched, and gets hot-reload for free.

### Decision: distinguishing timeout from generic provider failure

`LlmProviderException.ExitCode` is `-1` for **both** timeout and spawn-not-found, so exit code is not a
reliable discriminator, and message-string sniffing is fragile (a pattern we've been bitten by before).

**Add a typed discriminator:** `LlmProviderException` gains `public bool TimedOut { get; }`, set `true`
**only** at the timeout throw site (`ClaudeCodeLlmProvider` line: `if (result.TimedOut) throw …`). All
other throw sites leave it `false`. `AiEndpoints` reads `ex.TimedOut` to pick the 503 reason.

### End-to-end flow for the timeout knob

```
User drags the timeout stepper in the AI pane (e.g. 240 → 300)
  → POST /api/preferences { "ui.ai.providerTimeoutSeconds": 300 }
  → PreferencesEndpoints parses JsonValueKind.Number → int
  → ConfigStore.PatchAsync clamps to [30,600], persists, advances Current
  → GET response echoes the clamped value; the pane reflects it
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
    "Adjust timeout" action → navigate('/settings/ai')
```

---

## Components

### Backend

**`PRism.Core/Config/AppConfig.cs` — `AiConfig`**
Add a trailing-defaulted member:
```csharp
public sealed record AiConfig(
    AiMode Mode,
    AiConsentConfig Consent,
    AiFeaturesConfig Features,
    int HunkAnnotationCap = 10,
    int ProviderTimeoutSeconds = 240);
```
Backed by config key `ui.ai.providerTimeoutSeconds`. The cap key `ui.ai.hunkAnnotationCap` already exists.

**`PRism.Core/Config/ConfigStore.cs` — `PatchAsync` (dotted-path patch + validation)**
- Accept the two numeric `ui.ai.*` keys.
- Clamp on write: timeout → `[30, 600]`, cap → `[1, 50]`. Out-of-range values are clamped, not
  rejected (matches the annotator's existing "clamp non-positive cap to 10 on read" leniency and keeps
  the UI's bounded stepper authoritative without a 400 round-trip). A non-integer value for these keys
  → `ConfigPatchException` → 400.

**`PRism.Web/Endpoints/PreferencesEndpoints.cs`**
- POST value parsing currently maps `String/True/False` and folds everything else (incl. numbers) to
  `null`. Add `JsonValueKind.Number => props[0].Value.GetInt32()` (with `TryGetInt32` guard →
  `ConfigPatchException`/400 on a non-integer number like `3.5`).
- GET `BuildResponse` → `UiPreferencesDto`: add `HunkAnnotationCap` and `ProviderTimeoutSeconds` so the
  pane can render current values. These read from `config.Current.Ui.Ai`.

**`PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs`**
- Add `public Func<TimeSpan> TimeoutProvider { get; init; }` defaulting to `() => Timeout`.

**`PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs`**
- `Timeout: options.Timeout` → `Timeout: options.TimeoutProvider()`.

**`PRism.AI.ClaudeCode/LlmProviderException.cs`**
- Add `public bool TimedOut { get; }`; thread an optional `bool timedOut = false` through the 3-arg
  failure ctor; set `true` only at the timeout throw site in the provider.

**`PRism.Web/Program.cs`**
- Replace the baked `Timeout = TimeSpan.FromSeconds(240)` construction with
  `TimeoutProvider = () => TimeSpan.FromSeconds(ClampTimeout(configStore.Current.Ui.Ai.ProviderTimeoutSeconds))`.
  Keep a sensible static `Timeout` default for the non-hot path. `ClampTimeout` is the shared clamp
  helper (also used by `ConfigStore`), single-sourced so write-clamp and read-clamp agree.

**`PRism.Web/Endpoints/AiEndpoints.cs`**
- The three `catch (LlmProviderException)` arms currently return `Results.StatusCode(503)` (no body).
  Change to `Results.Json(new AiFailureBody(ex.TimedOut ? "timeout" : "provider-error"), statusCode: 503)`.
- The `catch (ArgumentException)` (oversized prompt) arms → `reason: "provider-error"`.
- New tiny record `AiFailureBody(string Reason)` (camel-cased on the wire → `{ "reason": "timeout" }`).
- The draft-suggestions endpoint has no try/catch (canned data only) — left unchanged; the frontend
  treats a missing `reason` as `provider-error`.

### Frontend

**`frontend/src/components/Settings/SettingsNav.tsx`**
- Add `{ section: 'ai', label: 'AI' }` to `PRIMARY` (position: after Appearance, before Inbox — TBD by
  visual review, default to after Appearance).

**`frontend/src/components/Settings/SettingsModalRoutes.tsx`**
- Add `<Route path="ai" element={<AiPane />} />`.

**`frontend/src/components/Settings/panes/AiPane.tsx` (new)**
- **AI mode** control (Off / Preview / Live) + `EgressConsentModal` Live-gate wiring, moved verbatim
  from `AppearancePane` (`set('ui.ai.mode', …)` etc.).
- **Provider timeout** stepper (seconds; default 240; range 30–600; step 30). Writes
  `set('ui.ai.providerTimeoutSeconds', n)`.
- **Hunk-annotation cap** stepper (default 10; range 1–50; step 1). Writes
  `set('ui.ai.hunkAnnotationCap', n)`.
- Both steppers are **design-system numeric controls** (custom stepper, not native `<input type=number>`),
  consistent with the repo's custom-controls-over-native-widgets convention. Each reflects the current
  value from `usePreferences()` and the clamped value echoed by the POST response.

**`frontend/src/components/Settings/panes/AppearancePane.tsx`**
- Remove the AI-mode section (now in `AiPane`). Appearance keeps theme/accent/density/content-scale.

**`frontend/src/hooks/usePreferences` + preferences types**
- Extend the preferences shape with `providerTimeoutSeconds: number` and `hunkAnnotationCap: number`
  (read from the GET DTO).

**`frontend/src/api/aiSummary.ts`, `aiFileFocus.ts`, `aiHunkAnnotations.ts`, `aiDraftSuggestions.ts`**
- On a 503, surface `ApiError.body.reason` (`'timeout' | 'provider-error'`, default `'provider-error'`)
  on the returned failure shape so the hooks can pass it to `report`.

**`frontend/src/components/Ai/aiFailure.tsx`**
- `report(seam, …)` extended to carry an optional `reason: AiFailureReason`; the registry tracks it per
  seam; a derived `anyTimedOut` boolean (true when any active failed seam's reason is `'timeout'`).

**`frontend/src/components/Ai/AiFailureToast.tsx`**
- When `anyTimedOut`, render timeout copy ("AI generation timed out.") plus an **"Adjust timeout"**
  secondary action that calls `navigate('/settings/ai')` (alongside the existing Retry-all). Otherwise
  the existing generic line + Retry-all.

---

## Validation & error handling

| Input | Rule | On violation |
|-------|------|--------------|
| `ui.ai.providerTimeoutSeconds` | integer, clamp to `[30,600]` | non-integer → 400; out-of-range → clamped |
| `ui.ai.hunkAnnotationCap` | integer, clamp to `[1,50]` | non-integer → 400; out-of-range → clamped |
| AI seam 503 | body `{ reason }` set from `ex.TimedOut` | missing reason on FE → `provider-error` |

Server-side clamp is authoritative; the stepper enforces bounds client-side as UX, not as the security
boundary. The GET response always echoes the post-clamp value, so a clamped write self-corrects the UI.

---

## Testing

**Backend (xUnit + FluentAssertions):**
- `ConfigStore` patch: numeric timeout/cap accepted; out-of-range clamped to bounds; non-integer → throws.
- `PreferencesEndpoints`: `JsonValueKind.Number` patch round-trips; GET DTO exposes both values; `3.5` → 400.
- `ClaudeCodeLlmProvider`: `TimeoutProvider` is evaluated per call (changing the backing value between
  calls changes the `ProcessSpec.Timeout`); default still `() => Timeout`.
- `LlmProviderException.TimedOut`: `true` only on the timeout path, `false` on exit-code / spawn / parse paths.
- `AiEndpoints`: timeout `LlmProviderException` → 503 `{ reason: "timeout" }`; generic → `provider-error`;
  oversized-prompt `ArgumentException` → `provider-error`.

**Frontend (vitest + Testing Library):**
- `AiPane`: renders the three controls; mode control behaves as it did in Appearance (incl. Live consent
  modal); steppers clamp to bounds and write the right `set(...)` key.
- `AppearancePane`: no longer renders the AI-mode section.
- api clients: 503 with `{reason:'timeout'}` surfaces `reason: 'timeout'`; 503 without a body → `provider-error`.
- `aiFailure`: `anyTimedOut` derives correctly across mixed-reason failures and recovers on clear.
- `AiFailureToast`: timeout copy + "Adjust timeout" deep-link shown iff `anyTimedOut`; deep-link navigates.

**e2e (Playwright):**
- Open Settings → AI tab renders; change the timeout stepper; reload → value persists.
- Force a seam 503 with `{reason:'timeout'}` → toast shows "Adjust timeout" → clicking it lands on the AI tab.

**Visual baselines:** new AI pane (both themes) + Appearance pane with the AI section removed (both themes).

---

## Open questions

- Exact position of the AI tab in the nav (after Appearance vs. end of the primary list) — resolve at
  visual review.
- Whether the timeout stepper step should be 30 s (coarse, fewer detents) or 15 s — default 30 s.
