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
  by the nine `AiCapabilities` names (`StringComparer.Ordinal`), default every-feature-on (`AllOn`,
  frozen dict).
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
| Frontend | `AiPane` has no toggle UI. `useCapabilities` still derives capabilities purely from `aiMode` (the long-deferred "D112" per-flag read). The `PreferenceKey` union has no entries for the new keys. |

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
  - **Preview:** the AI mode control **plus** a single **disabled disclosure button** labeled "AI
    features" (`aria-disabled`, non-expanding — see below). Its hint is *dynamic*: when one or more
    features are currently off it reads *"Some AI features are turned off. Switch to Live to change
    them."*; otherwise *"Switch to Live to turn individual features on or off."* The three numeric knobs
    stay hidden (they are genuinely inert in Preview).
  - **Live:** the AI mode control, the three numeric knobs (provider timeout, annotation cap, summary
    length), and the **enabled** "AI features" accordion.

  This is a deliberate, owner-confirmed change to the visibility of the three controls #496/#525 already
  shipped (today they render in every mode). *Rationale:* AI mode is the master switch; the detail knobs
  are Live-effective only, so revealing them only in Live removes clutter and makes the hierarchy legible
  — while the one disabled Preview button keeps the headline feature from being undiscoverable until a
  user commits to egress.
- **D4 — The toggle *value* is mode-independent; only the *editor* is Live-gated.** A flag persists and
  takes effect in every mode (a feature disabled in Live stays disabled in Preview, its sample suppressed
  via the existing backend Noop). The editor is Live-only, so a user in Preview cannot change a feature,
  and the **per-feature on/off state is not *shown* in Preview** (the disabled button does not expand —
  there is no read-only switch list). What the Preview button *does* provide: discoverability (the
  feature exists) plus, via the dynamic hint, the signal that *some* feature is currently off and where to
  change it (Live). It does not name which feature — that diagnosis lives in Live, where the user goes to
  inspect and restore.
- **D5 — Defaults all-on.** Reuses `AiFeaturesConfig.AllOn`. New installs and existing configs alike:
  every live seam on, so behavior is unchanged until a user opts a feature off. Backfill on load already
  exists (`ConfigStore` nested `Features ??` default).
- **D6 — No new enforcement, no re-opened Preview decision.** This slice adds only the set-path,
  wire projection, FE read, and UI. The selector's Preview-Noop-for-disabled behavior is pre-existing.
- **D7 — No committed visual baseline.** Mirrors #525. `settings-modal-visual.spec.ts` does not shoot
  the AI pane, and adding a baseline carries cross-platform regen cost. B1 proof = Playwright
  screenshots in the PR (Live pane, accordion collapsed + expanded; Preview pane showing the disabled
  button; both themes).

## Architecture

### Backend (`PRism.Core`, `PRism.Web`)

1. **`AiFeaturesConfig.With(string key, bool value)`** — returns a new `AiFeaturesConfig` with one key
   updated, all others preserved, backed by a fresh `FrozenDictionary` built with **`StringComparer.Ordinal`**
   (matching the existing comparer, so a casing drift between the patch key and the stored key cannot
   silently no-op the update). Immutable.
2. **`ConfigStore._allowedFields`** — add four exact `Bool` entries:
   `ui.ai.features.summary`, `ui.ai.features.fileFocus`, `ui.ai.features.hunkAnnotations`,
   `ui.ai.features.inboxEnrichment`.
3. **`ConfigStore.PatchAsync`** — add **four exact `key switch` arms** (one per settable key), mirroring
   the existing `inbox.sections.*` precedent (literal entries, not a prefix parser):
   `"ui.ai.features.summary" => _current with { Ui = ui with { Ai = ui.Ai with { Features = ui.Ai.Features.With("summary", (bool)value!) } } }`,
   and likewise for the other three. No prefix/suffix extraction — the exact allowlist from step 2 is the
   gate, so a `ui.ai.features.<unsettable>` (e.g. `inboxRanking`) is rejected with the standard
   `ConfigPatchException` ("unknown field") before the switch.
4. **`PreferencesDtos` + `PreferencesEndpoints`** — project `ui.Ai.Features` onto the GET wire as a
   nested `features` object carrying **all nine** camelCase booleans (fail-open: a missing stored key →
   `true`, matching `AiFeatureState`). **Wire path is pinned at `ui.features`** (flat under `ui`, NOT
   `ui.ai.features` on the wire) — consistent with how config `ui.ai.mode` → wire `ui.aiMode` and
   `ui.ai.providerTimeoutSeconds` → wire `ui.providerTimeoutSeconds`. *Note:* unlike those scalar
   flattenings, `features` is the one AI field projected as a **nested object** — the existing scalar
   precedent does not by itself prove the object lands at the right path, which is why the real-wire test
   (Testing) exercises the actual serialized shape. The persisted config path and the POST patch keys
   remain `ui.ai.features.*`. *Impl note:* `UiPreferencesDto` is a **positional `record`**, so adding
   `features` touches the constructor, the `BuildResponse` call site, **and** every test that constructs
   a `UiPreferencesDto` / `PreferencesResponse` directly — grep `new UiPreferencesDto(` before declaring
   the backend done.
5. **No DI/hot-reload change** — `AiFeatureState` seeding + `Changed` mirror already exist; the POST
   path already runs through `PatchAsync` (which raises `Changed`).

### Frontend (`frontend/src`)

6. **`api/types.ts`** — `UiPreferences.features: AiFeatures`, where `AiFeatures` is the nine-key boolean
   shape (structurally identical to `AiCapabilities` but a distinct named type, per the terminology
   split). Add to the GET response mapping. Export the nine key names as a single shared constant used by
   both the read site and the (mirrored) projection contract — this **guards key-set agreement** (both
   sides iterate the same nine names); it does **not** guard the wire *path* (that the object lands at
   `ui.features`), which only the real-wire test catches. Treat `features` as **possibly-absent at
   runtime** (stale cache, additive-rollout window, a test fixture omitting it) — all read sites fail
   open (see below).
7. **`contexts/PreferencesContext.tsx`** — the **only** required change is extending the `PreferenceKey`
   union with the four settable dotted keys, so `set('ui.ai.features.<seam>', …)` type-checks. `set` is
   **apply-on-success** (`POST /api/preferences` → `setPreferences(next)` from the server response — it
   is *not* optimistic); the switch reflects the new value once the round-trip resolves, exactly like the
   numeric knobs. The `readKey`/`writeKey` helpers have **no non-test callers** and need no change for
   correctness.
8. **`hooks/useCapabilities.ts`** — mask the mode-derived capabilities by the user feature flags:
   `capability[k] = base[k] && (preferences.ui.features?.[k] ?? true)` (fail-open). This makes a
   disabled feature gate off in **both** Preview and Live — mirroring the backend Noop — and is the
   minimal "D112" adoption (mask locally; full switch to the backend per-flag wire stays deferred).
   `useAiGate`'s `&& aiMode !== 'off'` second factor is left unchanged (now redundant-but-harmless).
   The existing `null`-guard when `!preferences?.ui` is preserved.
9. **`components/Settings/panes/AiPane.tsx`**
   - **Live:** wrap the provider-timeout, annotation-cap, summary-length rows **and** the enabled
     accordion in `{resolvedMode === 'live' && ( … )}`.
   - **Preview:** render the single disabled "AI features" disclosure button in
     `{resolvedMode === 'preview' && ( … )}`. Use **`aria-disabled="true"`** (not the native `disabled`
     attribute) so the button stays in the tab order and AT announces the hint; suppress activation
     explicitly (no `onClick`, or an early return) since `aria-disabled` does not block clicks. Give it a
     muted visual treatment (`opacity: 0.5` on the button, matching the existing disabled-control look);
     the hint paragraph renders at full opacity since it is the explanation. The button does **not**
     expand (no region).
   - **Accordion (Live):** a disclosure button with `aria-expanded` and `aria-controls="ai-features-region"`,
     labeled "AI features", collapsed by default, with a caret consistent with the existing inbox
     disclosure pattern (`InboxSection` / `RepoGroupAccordion`). The controlled region is
     `<div id="ai-features-region" role="group" aria-label="AI features">` (a `group`, not a landmark
     `region`, to avoid AT landmark noise inside the modal) holding four `Switch` rows. Each row follows
     the **InboxPane pattern** — a visible `<label className={pane.label} htmlFor="ai-feat-<key>">` for
     sighted text + click-to-toggle, **and** the `Switch`'s required `label` prop set to the *same text*
     (it renders as the input's `aria-label`, which is the AT accessible name) so AT and sighted names
     agree:
     `<Switch id="ai-feat-<key>" label="<Visible label>" checked={preferences.ui.features?.<key> ?? true} onChange={(next) => set('ui.ai.features.<key>', next).catch(() => {})} describedById="ai-feat-<key>-help" />`.
     Note the fail-open `?? true` on `checked` (matching `useCapabilities`) and the `.catch(() => {})`
     (matching every InboxPane switch — `set` rejects on POST failure). **Visible labels + per-row help
     copy:**
     - Summary — *"When off, the AI summary card is hidden on pull requests."*
     - File focus — *"When off, AI file hotspots are not shown in the Files tab."*
     - Hunk annotations — *"When off, inline AI annotations are not added to diffs."*
     - Inbox enrichment — *"When off, the AI kind-of-change chip is removed from inbox rows."*
   - **Subtitle:** update the stale pane subtitle (currently *"AI mode, provider timeout, annotation, and
     summary settings."*, which promises controls hidden outside Live) to *"Choose how AI runs. Provider,
     summary, and per-feature settings appear in Live mode."* (The per-feature read-only/disabled
     explanation is carried by the Preview button's hint, not the subtitle.)

### Data flow (disable `summary` in Live)

```
Switch off → set('ui.ai.features.summary', false)
  → POST /api/preferences { "ui.ai.features.summary": false }
  → ConfigStore.PatchAsync: allowlist ✓ → Features = Features.With("summary", false) → write config.json
  → Changed event → AiFeatureState.Set(newFeatures)        [synchronous, no restart]
       ↳ next AiSeamSelector.Resolve<IPrSummarizer>() → Noop   (server stops doing the work)
  → POST resolves → setPreferences(next) from the GET-shaped response (apply-on-success; ui.features.summary=false)
  → useCapabilities masks summary=false → AiSummaryCard unmounts (affordance gone)
```

## Wire contract

- **GET `/api/preferences`** → `ui.features: { summary, fileFocus, hunkAnnotations, preSubmitValidators,
  composerAssist, draftSuggestions, draftReconciliation, inboxEnrichment, inboxRanking }` (all boolean,
  always present, default `true`). Flat under `ui` (see step 4). **All nine are projected** (the five
  non-settable seams are read-only); **only the four named in D1 are POST-settable**. Additive — existing
  consumers ignore the new key.
- **POST `/api/preferences`** — settable keys: `ui.ai.features.{summary,fileFocus,hunkAnnotations,inboxEnrichment}`
  (Bool). Any other `ui.ai.features.*` key (including the five non-settable seams) is rejected.

## Accessibility

- **Live accordion button:** `aria-expanded` reflects state, `aria-controls="ai-features-region"` matches
  the controlled region's `id`; togglable via Enter/Space. Region is `role="group"`,
  `aria-label="AI features"`.
- **Preview disabled button:** `aria-disabled="true"` (stays focusable, so the dynamic hint, associated
  via `aria-describedby`, is announced to AT); activation suppressed in JS.
- **Switch name:** each `Switch`'s accessible name comes from its required `label` prop (rendered as
  `aria-label`), set to the *same text* as the visible `<label htmlFor>` in the row (which supplies the
  sighted text and click-to-toggle). This is the InboxPane convention; passing only a `<label htmlFor>`
  without the `label` prop would not compile and would not name the switch. Switches enter the tab order
  only when the accordion is expanded.
- **Live-reveal:** when flipping to Live, the knobs + accordion appear immediately after the mode control
  in reading order. **Decision: no live-region announcement** — the controls are reachable by normal
  forward navigation from the mode control; the existing `AiPane` consent-modal focus handling is reused
  and the new controls do not steal focus. (If the B1 review finds the silent reveal confusing, an
  `aria-live` note is a cheap follow-up.)
- **Layout:** the settings modal clips-and-scrolls its content pane, so the Off/Preview/Live height
  differences shift the scroll boundary rather than abruptly resizing the modal — **confirm at the B1
  pass** (a watch item, not a blocker).

## Testing

**Backend — `PRism.Core.Tests`:** `AiFeaturesConfig.With` updates one key / preserves the rest /
immutable / preserves the `Ordinal` comparer; `ConfigStore` patch for each of the four keys updates
`Features` and persists to disk; a `ui.ai.features.inboxRanking` (and any unknown) patch is rejected;
`AiFeatureState` reflects the new value after the `Changed` event. **`PRism.Web.Tests`:** GET projects
`ui.features` (all nine, default true); POST `ui.ai.features.summary=false` round-trips and the runtime
`AiFeatureState` follows synchronously. The selector's per-feature gating is already covered
(`AiSeamSelectorGateTests`, `AiCapabilityResolverTests`) — no new gate logic to test.

**Frontend — vitest:** `useCapabilities` masks a disabled feature off in **both** Preview and Live, and
fails open when `features` is undefined; `AiPane` shows **only** the mode control in Off, the mode
control + **disabled** "AI features" button (dynamic hint, non-expanding) in Preview, and the mode
control + three knobs + **enabled** accordion in Live; expanding the accordion reveals four switches;
toggling a switch calls `set` with the correct key (and survives a rejected `set` via `.catch`);
persisted state renders as the switch's checked state; a `features`-less preferences object does not
crash the accordion (fail-open `checked`). **Re-seed the shipped stepper tests:** the three existing
`AiPane.test.tsx` cases that assert the provider-timeout / annotation-cap / summary-length steppers run
under the `beforeEach` default `aiMode='off'`; under D3 those steppers no longer render in Off, so move
them under a `describe('detail controls (Live mode)')` (or set `prefs.aiMode='live'` per case) or they
fail at `getByRole('spinbutton', …)`.

**e2e:** audit **every** `ai-settings-tab.spec.ts` test that reaches a now-Live-gated stepper — the
toggle-persist test **and** the timeout-503 deep-link test (`:381`) — confirming each runs in (or
switches to) Live; the shared `makeAiPreferences()` already seeds `aiMode:'live'`, so most survive, but
each must be verified, not assumed. Update the shared fixtures (`makeAiPreferences()` /
`makeDefaultPreferences()`) to include a `features` object (or rely on the fail-open reads). Add
accordion-expand + toggle-persist coverage, and the Preview disabled-button assertion. **Real-wire gate
test:** one e2e (or integration) test that disables a feature via the real POST and asserts the consumer
affordance unmounts through the **actual serialized GET response** — not a hand-mocked `features` object
— so a wire-path/shape regression (`ui.features` projection landing off-path → mask silently fails open)
is caught.

**Visual (B1):** Playwright screenshots in the PR — Live pane (accordion collapsed + expanded), Preview
pane (disabled "AI features" button), light + dark.

## Out of scope / deferrals

- Toggle rows for the five dormant seams — added when each gains a real implementation.
- Full FE adoption of the backend per-flag capability wire (the original "D112") — this slice masks
  locally and leaves that swap deferred, exactly as `useCapabilities` documents.
- Any change to the egress-consent flow, AI mode semantics, or the numeric-knob bounds.
- Accordion expand / Live-reveal animation — current disclosures render without a height transition; any
  motion polish is a separate concern, surfaced at the B1 review if jarring.

## Risk classification

**T3, B1 (UI-visual).** Human gate = a visual assert on the Live pane + accordion (and the Preview
disabled button) after green-and-ready. No B2 surface: the consent/egress path, persisted-schema shape,
reviewer-atomic pipeline, and architectural invariants are all untouched; per-feature disablement can
only reduce egress. Secrets scan over the diff is clean (config booleans + UI only).
