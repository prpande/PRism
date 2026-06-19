# AI Settings — per-feature on/off toggles (#536)

**Issue:** #536 — completes the deferred **Phase 1** bullet of the #485 AI Settings tab epic.
**Branch:** off `origin/V2` (`feature/536-ai-feature-toggles`). The whole AI Settings tab lives on
V2; `main` has diverged and does not carry it.
**Tier:** **T3** — slice-sized, net-new user-facing behavior (a per-feature toggle surface), cross-cutting
backend config + frontend gate. **Sibling parity:** #496 / #525 were both T3.
**Risk:** **B1 (UI-visual)** — adds a visible toggle accordion and changes the AI pane's information
architecture (progressive disclosure). A human must eyeball the result. **Not B2:** no auth / token /
consent change (the Live-flip egress-consent path is untouched), no persisted-schema migration
(`AiFeaturesConfig` already exists in the config shape), no reviewer-atomic surface, no architectural
invariant. Net egress can only *decrease* (a disabled seam does no work), never increase.

**Terminology (used precisely throughout):**
- **features** — the per-seam *user-enablement* flags this slice adds (persisted at `ui.ai.features`,
  surfaced on the wire as `ui.features`). The thing the toggles set.
- **capabilities** — the existing mode-derived `AiCapabilities` (`useCapabilities`): what the current AI
  mode makes available. The gate is `capability && feature-enabled`.

---

## Problem

The AI Settings pane exposes one global **AI mode** (Off / Preview / Live) plus three numeric knobs
(provider timeout, annotation cap, summary length). There is no way to enable/disable an **individual**
AI feature. A user who wants summaries but not hunk annotations, or the inbox kind-of-change chip but
not file-focus hotspots, has no control short of turning *all* AI off.

## Existing substrate (the reframe — most of the backend already ships on V2)

This is **not** a greenfield build. Earlier phases landed the entire per-feature **enforcement engine**
as forward-compat scaffolding:

- **`AiFeaturesConfig`** (`PRism.Core/Config/AiFeaturesConfig.cs`) — persisted at `ui.ai.features`, keyed
  by the nine `AiCapabilities` names, default every-feature-on (`AllOn`, frozen dict).
- **`AiFeatureState`** (`PRism.Core/Ai/AiFeatureState.cs`) — synchronous hot mirror, **fail-open**
  (unknown key → `true`). Already seeded **and** hot-updated on config change
  (`ServiceCollectionExtensions.cs:69-74`: `config.Changed += (_, args) => state.Set(args.Config.Ui.Ai.Features)`).
  `ConfigStore.PatchAsync` raises `Changed` after a write, so the mirror updates with no restart.
- **`AiSeamFeatureKeys`** — maps all nine seam interfaces → feature key.
- **`AiSeamSelector` + `AiCapabilityResolver`** — every seam resolution already gates on
  `_features.IsEnabled(key)`. The selector encodes the Preview decision the issue flagged as *open*:
  `Preview → Placeholder unless the feature is user-disabled, then Noop` (no sample). So
  **"off = no affordance in Preview *or* Live" is already settled in code**, not a question this slice
  re-opens.

What is **missing** — the actual scope of #536:

| Layer | Gap |
|-------|-----|
| Backend | No `ui.ai.features.*` keys in the `ConfigStore` allowlist / patch switch → a user cannot *set* a flag. `PreferencesDtos` does not project `features` → the frontend cannot *read* the flags. |
| Frontend | `AiPane` has no toggle UI. `useCapabilities` still derives capabilities purely from `aiMode` (the long-deferred "D112" per-flag read). `PreferencesContext` `readKey`/`writeKey` have no branches for the new keys. |

## Live vs. dormant seams (authoritative source)

The `realSeams` dictionary (`PRism.Web/Composition/ServiceCollectionExtensions.cs:191-194`) — read by
both the selector and the capability resolver — holds exactly **four** real implementations:

| Seam | Feature key | Real impl | Visible affordance |
|------|-------------|-----------|--------------------|
| `IPrSummarizer` | `summary` | `ClaudeCodeSummarizer` | PR summary card |
| `IFileFocusRanker` | `fileFocus` | `ClaudeCodeFileFocusRanker` | File hotspots / focus |
| `IHunkAnnotator` | `hunkAnnotations` | `ClaudeCodeHunkAnnotator` | Diff hunk annotations |
| `IInboxItemEnricher` | `inboxEnrichment` | `ClaudeCodeInboxItemEnricher` | Inbox kind-of-change chip |

The other five (`preSubmitValidators`, `composerAssist`, `draftSuggestions`, `draftReconciliation`,
`inboxRanking`) have **only** Noop + Placeholder implementations — they produce nothing in Live.
**Important asymmetry to be honest about:** three of those five — `composerAssist`, `preSubmitValidators`,
`draftSuggestions` — *do* have live frontend consumers that render visible **Preview samples**
(`AiComposerAssistant`, `AskAiPullTab`, `PrHeader` validators, `UnresolvedPanel`). So a Preview user sees
more sample surfaces than the four this slice makes settable. Surfacing toggles for seams that do nothing
in Live would read as broken (D1), so those three stay non-settable **this slice** and gain rows when
their real impls land. `inboxRanking` is fully dormant (no FE consumer; its old activity-rail consumer was
decoupled onto the non-AI `inbox.showActivityRail` flag in #283).
**Enrichment vs. ranking:** enrichment *annotates* each item (the chip), order unchanged; ranking would
*reorder* the list, content unchanged — only enrichment is live.

## Decisions (owner-confirmed)

- **D1 — Surface the four live seams only.** Toggle rows for `summary`, `fileFocus`,
  `hunkAnnotations`, `inboxEnrichment` — exactly the issue's list and exactly the live seams. The other
  five stay default-on and are **not** user-settable (no allowlist key, no UI), including the three that
  render Preview-only samples (acknowledged above). Promoting one to a row later is a one-line addition
  when its real impl lands.
- **D2 — Toggles live in a collapsed accordion.** A disclosure labeled **"AI features"** inside the AI
  pane, **collapsed by default**, expanding to the four `Switch` rows.
- **D3 — Progressive disclosure, gated on Live (with a discoverability affordance in Preview).** The
  detail knobs reveal only in Live; the toggle accordion is *editable* only in Live but *discoverable* in
  Preview. Concretely, by mode:
  - **Off:** only the **AI mode** segmented control.
  - **Preview:** the AI mode control **plus** the collapsed "AI features" header rendered **disabled**,
    with the hint *"Switch to Live to turn individual features on or off."* It does not expand. This makes
    the feature discoverable and gives a disabled-then-Preview state a visible explanation (see D4). The
    three numeric knobs stay hidden (they are genuinely inert in Preview).
  - **Live:** the AI mode control, the three numeric knobs (provider timeout, annotation cap, summary
    length), and the **enabled** "AI features" accordion.

  This is a deliberate, owner-confirmed change to the visibility of the three controls #496/#525 already
  shipped (today they render in every mode). *Rationale:* AI mode is the master switch; the detail knobs
  are Live-effective only, so revealing them only in Live removes clutter and makes the hierarchy legible
  — while the one disabled Preview row keeps the headline feature from being undiscoverable until a user
  commits to egress.
- **D4 — The toggle *value* is mode-independent; only the *editor* is Live-gated.** A flag persists and
  takes effect in every mode (a feature disabled in Live stays disabled in Preview, its sample suppressed
  via the existing backend Noop). The editor is Live-only, so a user in Preview cannot change a feature —
  but the disabled Preview header (D3) tells them why a sample is missing and where to restore it.
  Re-enabling happens in Live.
- **D5 — Defaults all-on.** Reuses `AiFeaturesConfig.AllOn`. New installs and existing configs alike:
  every live seam on, so behavior is unchanged until a user opts a feature off. Backfill on load already
  exists (`ConfigStore` nested `Features ??` default).
- **D6 — No new enforcement, no re-opened Preview decision.** This slice adds only the set-path,
  wire projection, FE read, and UI. The selector's Preview-Noop-for-disabled behavior is pre-existing.
- **D7 — No committed visual baseline.** Mirrors #525. `settings-modal-visual.spec.ts` does not shoot
  the AI pane, and adding a baseline carries cross-platform regen cost. B1 proof = Playwright
  screenshots in the PR (Live pane, accordion collapsed + expanded; Preview pane showing the disabled
  header; both themes).

## Architecture

### Backend (`PRism.Core`, `PRism.Web`)

1. **`AiFeaturesConfig.With(string key, bool value)`** — returns a new `AiFeaturesConfig` with one key
   updated, all others preserved, backed by a fresh `FrozenDictionary`. Immutable.
2. **`ConfigStore._allowedFields`** — add four `Bool` entries:
   `ui.ai.features.summary`, `ui.ai.features.fileFocus`, `ui.ai.features.hunkAnnotations`,
   `ui.ai.features.inboxEnrichment`.
3. **`ConfigStore.PatchAsync`** — a handler for the `ui.ai.features.` prefix: extract the seam suffix,
   confirm it is one of the four settable keys, and apply
   `_current with { Ui = ui with { Ai = ui.Ai with { Features = ui.Ai.Features.With(seam, (bool)value) } } }`.
   A `ui.ai.features.<unsettable>` (e.g. `inboxRanking`) never reaches the allowlist → rejected with the
   standard `ConfigPatchException` ("unknown field").
4. **`PreferencesDtos` + `PreferencesEndpoints`** — project `ui.Ai.Features` onto the GET wire as a
   `features` object carrying **all nine** camelCase booleans (fail-open: a missing stored key → `true`,
   matching `AiFeatureState`). **Wire path is pinned at `ui.features`** (flat under `ui`, NOT
   `ui.ai.features` on the wire) — this matches the existing flatten where config `ui.ai.mode` →
   wire `ui.aiMode` and `ui.ai.providerTimeoutSeconds` → wire `ui.providerTimeoutSeconds`. The persisted
   config path and the POST patch keys remain `ui.ai.features.*`; only the GET projection flattens. *Impl
   note:* `UiPreferencesDto` is a **positional `record`**, so adding `features` touches the constructor,
   the `BuildResponse` call site, **and** every test that constructs a `UiPreferencesDto` /
   `PreferencesResponse` directly — grep `new UiPreferencesDto(` before declaring the backend done.
5. **No DI/hot-reload change** — `AiFeatureState` seeding + `Changed` mirror already exist; the POST
   path already runs through `PatchAsync` (which raises `Changed`).

### Frontend (`frontend/src`)

6. **`api/types.ts`** — `UiPreferences.features: AiFeatures`, where `AiFeatures` is the nine-key boolean
   shape (structurally identical to `AiCapabilities` but a distinct named type, per the terminology
   split). Add to the GET response mapping. Export the key list as a single shared constant so the DTO
   projection contract and the `useCapabilities` read site reference the same shape (guards the wire-path
   pin in step 4).
7. **`contexts/PreferencesContext.tsx`** — extend the `PreferenceKey` union with the four settable
   dotted keys, **and add matching `readKey`/`writeKey` branches** that read/optimistically-write nested
   into `ui.features.<seam>` (mirroring the existing `ui.ai.*` numeric-knob branches). Without the
   `writeKey` branch the optimistic update has no path and the switch throws / lags until the refetch.
8. **`hooks/useCapabilities.ts`** — mask the mode-derived capabilities by the user feature flags:
   `capability[k] = base[k] && (preferences.ui.features?.[k] ?? true)` (fail-open). This makes a
   disabled feature gate off in **both** Preview and Live — mirroring the backend Noop — and is the
   minimal "D112" adoption (mask locally; full switch to the backend per-flag wire stays deferred).
   `useAiGate`'s `&& aiMode !== 'off'` second factor is left unchanged (now redundant-but-harmless).
   The existing `null`-guard when `!preferences?.ui` is preserved.
9. **`components/Settings/panes/AiPane.tsx`**
   - **Live:** wrap the provider-timeout, annotation-cap, summary-length rows **and** the enabled
     accordion in `{resolvedMode === 'live' && ( … )}`.
   - **Preview:** render the "AI features" disclosure row **disabled** (`disabled` / `aria-disabled`,
     non-expanding) with the hint help text, gated on `{resolvedMode === 'preview' && ( … )}`.
   - **Accordion (Live):** a disclosure button with `aria-expanded` and `aria-controls="ai-features-region"`,
     labeled "AI features", collapsed by default, with a caret consistent with the existing inbox
     disclosure pattern (`InboxSection` / `RepoGroupAccordion`). The controlled region is
     `<div id="ai-features-region" role="group" aria-label="AI features">` (a `group`, not a landmark
     `region`, to avoid AT landmark noise inside the modal) holding four `Switch` rows. Each row follows
     the **InboxPane pattern**: a `<label className={pane.label} htmlFor="ai-feat-<key>">` paired with
     `<Switch id="ai-feat-<key>" checked={preferences.ui.features.<key>} onChange={(next) => set('ui.ai.features.<key>', next)} describedById="ai-feat-<key>-help" />`
     and a help paragraph. **Per-row help copy:**
     - Summary — *"When off, the AI summary card is hidden on pull requests."*
     - File focus — *"When off, AI file hotspots are not shown in the Files tab."*
     - Hunk annotations — *"When off, inline AI annotations are not added to diffs."*
     - Inbox enrichment — *"When off, the AI kind-of-change chip is removed from inbox rows."*
   - **Subtitle:** update the stale pane subtitle (currently *"AI mode, provider timeout, annotation, and
     summary settings."*, which promises controls hidden outside Live) to *"Choose how AI runs. Provider,
     summary, and per-feature settings appear in Live mode."*

### Data flow (disable `summary` in Live)

```
Switch off → set('ui.ai.features.summary', false)
  → writeKey optimistic update into ui.features.summary (PreferencesContext)
  → POST /api/preferences { "ui.ai.features.summary": false }
  → ConfigStore.PatchAsync: allowlist ✓ → Features = Features.With("summary", false) → write config.json
  → Changed event → AiFeatureState.Set(newFeatures)        [synchronous, no restart]
       ↳ next AiSeamSelector.Resolve<IPrSummarizer>() → Noop   (server stops doing the work)
  → prefs store refetch (GET → ui.features) → useCapabilities masks summary=false → AiSummaryCard unmounts
```

## Wire contract

- **GET `/api/preferences`** → `ui.features: { summary, fileFocus, hunkAnnotations, preSubmitValidators,
  composerAssist, draftSuggestions, draftReconciliation, inboxEnrichment, inboxRanking }` (all boolean,
  always present, default `true`). Flat under `ui` (see step 4). Additive — existing consumers ignore it.
- **POST `/api/preferences`** — settable keys: `ui.ai.features.{summary,fileFocus,hunkAnnotations,inboxEnrichment}`
  (Bool). Any other `ui.ai.features.*` key is rejected.

## Accessibility

- Disclosure button: `aria-expanded` reflects state, `aria-controls="ai-features-region"` matches the
  controlled region's `id`; togglable via Enter/Space. In Preview the button is `disabled` /
  `aria-disabled` and the hint is associated via `aria-describedby`.
- The region is `role="group"` with `aria-label="AI features"`.
- Each `Switch` (`controls/Switch.tsx`, `role="switch"`) gets its accessible name from a paired
  `<label htmlFor>` (InboxPane pattern) and its help via `aria-describedby`. Switches enter the tab order
  only when the accordion is expanded.
- The Live-flip reveal reuses the existing `AiPane` focus handling (the consent-modal focus logic); the
  newly revealed controls do not steal focus.

## Testing

**Backend — `PRism.Core.Tests`:** `AiFeaturesConfig.With` updates one key / preserves the rest /
immutable; `ConfigStore` patch for each of the four keys updates `Features` and persists to disk; a
`ui.ai.features.inboxRanking` (and any unknown) patch is rejected; `AiFeatureState` reflects the new
value after the `Changed` event. **`PRism.Web.Tests`:** GET projects `ui.features` (all nine, default
true); POST `ui.ai.features.summary=false` round-trips and the runtime `AiFeatureState` follows
synchronously. The selector's per-feature gating is already covered (`AiSeamSelectorGateTests`,
`AiCapabilityResolverTests`) — no new gate logic to test.

**Frontend — vitest:** `useCapabilities` masks a disabled feature off in **both** Preview and Live, and
fails open when `features` is undefined; `AiPane` shows **only** the mode control in Off, the mode
control + **disabled** "AI features" header (with hint, non-expanding) in Preview, and the mode control +
three knobs + **enabled** accordion in Live; expanding the accordion reveals four switches; toggling a
switch calls `set` with the correct key; persisted state renders as the switch's checked state.
**Re-seed the shipped stepper tests:** the three existing `AiPane.test.tsx` cases that assert the
provider-timeout / annotation-cap / summary-length steppers run under the `beforeEach` default
`aiMode='off'`; under D3 those steppers no longer render in Off, so move them under a
`describe('detail controls (Live mode)')` (or set `prefs.aiMode='live'` per case) or they fail at
`getByRole('spinbutton', …)`.

**e2e:** audit **every** `ai-settings-tab.spec.ts` test that reaches a now-Live-gated stepper — the
toggle-persist test **and** the timeout-503 deep-link test (`:381`) — confirming each runs in (or
switches to) Live; the shared `makeAiPreferences()` already seeds `aiMode:'live'`, so most survive, but
each must be verified, not assumed. Add accordion-expand + toggle-persist coverage, and the Preview
disabled-header assertion. **Real-wire gate test:** one e2e (or integration) test that disables a feature
via the real POST and asserts the consumer affordance unmounts through the **actual serialized GET
response** — not a hand-mocked `features` object — so a wire-path regression (`ui.features` projection
landing off-path → mask silently fails open) is caught.

**Visual (B1):** Playwright screenshots in the PR — Live pane (accordion collapsed + expanded), Preview
pane (disabled "AI features" header), light + dark.

## Out of scope / deferrals

- Toggle rows for the five dormant seams — added when each gains a real implementation.
- Full FE adoption of the backend per-flag capability wire (the original "D112") — this slice masks
  locally and leaves that swap deferred, exactly as `useCapabilities` documents.
- Any change to the egress-consent flow, AI mode semantics, or the numeric-knob bounds.
- Accordion expand/Live-reveal animation — current disclosures render without a height transition; any
  motion polish is a separate concern, surfaced at the B1 review if jarring.

## Risk classification

**T3, B1 (UI-visual).** Human gate = a visual assert on the Live pane + accordion (and the Preview
disabled header) after green-and-ready. No B2 surface: the consent/egress path, persisted-schema shape,
reviewer-atomic pipeline, and architectural invariants are all untouched; per-feature disablement can
only reduce egress. Secrets scan over the diff is clean (config booleans + UI only).
