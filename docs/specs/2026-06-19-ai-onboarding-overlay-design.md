# First-run AI onboarding overlay — design

- **Date:** 2026-06-19
- **Branch base:** `V2` (the AI-dev integration branch)
- **Status:** Design — awaiting human review before planning
- **Surfaces touched:** `InboxPage` (overlay host), new `AiOnboardingDialog`, extracted `EgressDisclosureBody`, `AiConfig`/preferences (`ui.ai.onboardingSeen`)

## 1. Problem

A brand-new user connects their GitHub token and lands on the inbox. AI is **already on in Preview** by default (`AppConfig.Default` → `AiMode.Preview`, consent `None`, all feature gates on, zero egress). Two gaps follow:

1. **Discovery** — the user sees clearly-labeled AI sample output but has no signal that it *is* AI, why it looks like placeholder data, or that a real-model ("Live") mode exists. The AI can read as a half-built placeholder.
2. **Setup** — the one thing actually "off" for a fresh user is **Live** (real model output), which requires an explicit, versioned egress consent. There is currently no moment that introduces that choice; the user must stumble into Settings.

This feature adds a one-time, first-run dialog that surfaces the AI modes and lets the user choose Off / Preview / Live (with consent) right after token entry — while the inbox loads behind it.

## 2. Goals / non-goals

**Goals**
- Introduce the three AI modes on first run, in the app's native visual language.
- Let the user keep Preview, opt into Live (with the full egress disclosure), or turn AI Off — in a single screen.
- Never gate the user out of the product: the inbox loads in parallel, behind the dialog.
- Resolve to "seen" on any **explicit** action (a button or the settings link) and never re-show after that; never nag. An Esc dismissal is treated as "not now" and may re-show (§6) — only explicit engagement is permanent.

**Non-goals (already exist on V2 — this feature consumes them, does not build them)**
- The Off/Preview/Live tri-state (`AiMode`, `AiModeState`), mode persistence (`ui.ai.mode`), and capability gating (`useCapabilities`/`useAiGate`).
- The egress consent record + gate (`AiConsentState`, `AiConsentConfig`, `AiProviderIds.Claude`, disclosure version) and its API (`getEgressDisclosure`, `postAiConsent`).
- The full AI settings pane (`AiPane`) and the standalone `EgressConsentModal` (kept as-is for the Settings path).
- Any new model/provider/tuning configuration.

This is a **presentation layer** over existing V2 machinery, plus **one** new persisted flag.

## 3. Existing machinery (reference)

| Concern | Where (V2) |
|---|---|
| Mode enum + hot state | `PRism.Core/Ai/AiMode.cs`, `AiModeState.cs` |
| Consent record + predicate | `PRism.Core/Ai/AiConsentState.cs`, `Config/AiConsentConfig.cs` |
| Disclosure content | `PRism.Web/Endpoints/EgressDisclosure.cs` (recipient = "Anthropic, via the Claude Code CLI"; categories = PR diff, Title, Description; version "1") |
| Consent API | `GET /api/ai/egress-disclosure`, `POST /api/ai/consent` (`frontend/src/api/aiConsent.ts`) |
| Settings mode UI | `frontend/src/components/Settings/panes/AiPane.tsx` |
| Standalone consent modal | `frontend/src/components/Settings/EgressConsentModal.tsx` |
| Mode preference wire | `UiPreferencesDto.AiMode`, `POST /api/preferences` dotted-path patch `ui.ai.mode` |
| Base modal chrome | `frontend/src/components/Modal/Modal.tsx` (+ `.modal-*` in `styles/tokens.css`) |

## 4. Trigger & placement (form-factor B)

- On landing at `/` (`InboxPage`), if **`preferences.ui.onboardingSeen === false`** and the user is authed, render `AiOnboardingDialog` as an overlay (the existing `Modal`, `align="center"`) **on top of** the inbox.
- `useInbox()` (and the activity rail) fire on mount exactly as today — the inbox loads **behind** the dialog. By the time the user resolves the dialog, the inbox is warm. The dialog is **never** a gate in front of the inbox, and it does **not** sit between `/setup` and `/`.
- Returning users (`onboardingSeen === true`) render the inbox directly, no overlay.

## 5. The dialog — single screen, progressive disclosure

One `Modal` titled **"Set up AI for your reviews"** with the AI `SparkIcon` (accent-colored) as `titleIcon`.

### 5.1 Body
- **Lead copy** (Off/Preview state): *"PRism is already running AI in **Preview** — sample output, clearly labeled, nothing sent off your device. Pick how much AI you want; you can change it any time in Settings."*
  - In the **Live** state the lead switches to: *"Live AI generates real, diff-grounded summaries of **your pull requests** using a real model."* (The existing `EgressConsentModal` lead — "…of this pull request" — is PR-detail-specific and is **not** reused verbatim.)
- **AI-mode control** — the existing `SegmentedControl` (Off / Preview / Live), `role="radiogroup"`. Color-coded by selected segment (soft fills, not loud):
  - Off → neutral (`--surface-3`)
  - Preview → accent (`--accent-soft` bg + `--accent` text)
  - Live → success (`--success-soft` bg + `--success-fg` text)
- **Contextual region below the control:**
  - **Off / Preview:** a three-row legend (Off / Preview / Live, each with a matching dot — neutral / accent / success) describing each mode. Preview carries a "Current" pill. This is the discovery surface. The legend card wears the app's AI-surface idiom (`.ai-tint` accent gradient + accent border).
  - **Live:** the legend is **replaced** by the **inline egress disclosure** — the existing amber `callout` showing *"Sent off your device to **{recipient}**:"* and the data-category list, rendered by the shared `EgressDisclosureBody` (see §7) and sourced from `getEgressDisclosure` (identical content to `EgressConsentModal`). The loading / error / commit states of this region are specified in §7.1.

### 5.2 Adaptive primary button
The single primary button's **label, color, and action track the selected segment** (it replaces the redundant "Maybe later" + "Done" pair):

| Selected | Button label | Style | Action on click |
|---|---|---|---|
| Off | `Turn off AI` | secondary chrome + `--danger-fg` text (the `EgressConsentModal.declineBtn` idiom — cautionary, not an alarming red fill) | commit `ui.ai.mode = off`; set `seen`; close |
| Preview (current) | `Maybe later` | quiet (`btn-ghost`) | no mode change (keep Preview); set `seen`; close |
| Live | `Enable Live AI` | `btn-success` (green; theme-aware fg) | reveal disclosure → record consent → commit `ui.ai.mode = live`; set `seen`; close (full state machine in §7.1) |

While a Live consent `POST` is in flight, the button shows a spinner + "Enabling…" and is disabled, along with the segmented control and `Manage AI settings →` (§7.1, step 4).

> Note (D2, resolved): the label stays **`Maybe later`**. Review flagged that it implies a re-prompt that the once-only flag doesn't deliver; accepted as a minor wording tradeoff. Mitigated in practice by D1 — an Esc (the likeliest reflexive dismissal) does *not* burn the one-shot, so "later" is partly real for the most common bail-out path. No in-product re-entry affordance is added in this feature.

### 5.3 Secondary affordance
- **`Manage AI settings →`** (`btn-link`) on every state — deep-links to `/settings/ai`. See §6 for its (no-commit) semantics. It teaches where the controls live and is the escape hatch to the full `AiPane`.

## 6. Commit & exit semantics (the safety contract)

**Rule: the segmented control sets a *pending* selection; only the adaptive primary button commits.** This differs deliberately from `AiPane`, which commits on each segment change.

Three exits. **Explicit** exits (button, link) set `onboardingSeen = true`; **Esc does not** (D1, resolved):

| Exit | Commits the pending mode? | Sets `seen`? | Notes |
|---|---|---|---|
| Adaptive primary button | **Yes** (Off/Preview/Live, Live only after consent) | **Yes** | the only commit path |
| `Manage AI settings →` | **No** — abandons the pending selection | **Yes** | navigates to `/settings/ai`; persisted mode stays as it was (Preview default) |
| Esc (`Modal.onClose`) | **No** | **No** | keeps current mode; closes; **re-shows next launch** (nothing was committed, so an accidental Esc on the overlay doesn't burn the one-shot) |

Only an explicit choice burns the once-only token. "Never nag" (§2) governs explicit dismissals; a user who repeatedly Escs is re-shown until they engage via a button or the link — by design, since Esc here is "not now," not "never."

Consequences the user explicitly asked about:
- **Live pending → `Manage AI settings`:** Live is **not** enabled — no consent was recorded (the green button *is* the consent action). Mode stays Preview. The user re-chooses Live in Settings via the normal `EgressConsentModal` gate.
- **Off pending → `Manage AI settings`:** Off is **not** applied. Mode stays Preview; the user sets Off explicitly in Settings.

**Rationale:** Live must be reachable *only* through an explicit consent acknowledgment — a navigate-path that committed Live would bypass the egress gate (a privacy hole). Making "nothing commits except the primary button" uniform guarantees one consent path with no edge-case bypass, and avoids silent persisted side-effects on navigation.

### 6.1 Seen-write ordering & failure

`POST /api/preferences` patches a **single field**, so committing exits issue sequential writes, not one atomic patch. Ordering, on a committing exit:

1. (Live only) `postAiConsent(version)` → 2. `set('ui.ai.mode', <mode>)` → 3. `set('ui.ai.onboardingSeen', true)`.

The `seen`-write is **last** so that if it fails (apply-on-success → no local write, no rollback), the durable state is still correct (the chosen mode / consent persisted) and the only consequence is **at most one** extra showing of the dialog on the next launch — never a lost mode choice or an ungated Live. A failed `seen`-write is swallowed (the standard preference error toast applies); the dialog does not block on it. Folding mode + seen into a single multi-field patch would remove the re-show window but requires a backend endpoint change — deferred (§14).

## 7. Live consent — inline, shared content

Selecting **Live** triggers `getEgressDisclosure` and renders the disclosure **inline** (no second modal for the onboarding path). Clicking **Enable Live AI** runs the same commit sequence the consent modal uses: `postAiConsent(disclosureVersion)` → on success set `ui.ai.mode = live`.

To prevent the disclosure drifting between two places:
- **Extract `EgressDisclosureBody`** — a presentational component rendering the amber callout (recipient + data-category list) from an `EgressDisclosure`. Consumed by **both** `AiOnboardingDialog` (inline) and `EgressConsentModal` (Settings path). Each caller supplies its own lead sentence.
- The **consent API** (`getEgressDisclosure` / `postAiConsent`) is reused. The race / fail-closed guards are reused **in spirit**, but adapted to this surface's dismissal model (see §7.1) — the `EgressConsentModal`'s `openRef` guard keys off an `open` prop flipping to `false`, whereas this dialog can also be torn down by a **router navigation** (`Manage AI settings →`), which unmounts the component rather than toggling a prop.

> Commit *timing* differs between the two surfaces (onboarding defers to the button; `AiPane` commits on change), so a single shared `useAiModeSelection` hook is **not** assumed here. The guaranteed shared units are `EgressDisclosureBody` + the consent API usage. Whether the Live-consent orchestration is further factored into a shared hook is a planning-time decision.

### 7.1 Live inline state machine

Selecting the **Live** segment drives the contextual region through these states (the mechanics mirror `AiPane.tsx`'s `onAiMode` + `EgressConsentModal.tsx`, which are the canonical implementations to copy):

1. **Fetch.** On selecting Live, start `getEgressDisclosure(signal)` with a fresh `AbortController`. While in flight, the region renders the **loading state** — skeleton rows matching `EgressConsentModal` (≈2 lead + 3 callout skeletons), container `aria-busy="true"` with an `aria-live="polite"` "Loading data-sharing disclosure…" message — and the **adaptive primary button is disabled**.
2. **Already-consented short-circuit.** If the disclosure resolves with `alreadyConsented === true` (a valid current-version record already on file), **skip the consent POST** and commit `ui.ai.mode = live` directly on the button click (matching `AiPane`). The button label may still read `Enable Live AI`; no second acknowledgment is required because consent is already valid.
3. **Disclosure loaded (not consented).** Render `EgressDisclosureBody`; enable the button (`Enable Live AI`).
4. **Submitting.** On button click, `postAiConsent(disclosureVersion)`; show a spinner + "Enabling…" on the button and **disable the button + segmented control + `Manage AI settings →`** for the duration (mirrors `EgressConsentModal`'s submitting state). On success → commit `ui.ai.mode = live`, set `seen`, close.
5. **Fail closed.** Disclosure fetch error, or consent `POST` 409 / failure → render an error (`role="alert"`); **do not commit**; leave mode unchanged; allow retry (the POST is idempotent at the current version).
6. **Abort on change.** If the user picks Off/Preview before the fetch resolves, **abort** the in-flight `getEgressDisclosure` and revert the region to that segment's content. A late resolution must not render Live's disclosure for a no-longer-selected segment.
7. **Teardown guard.** A `cancelled`-flag / `AbortController` (not just an `open`-prop ref) guards the **navigation-unmount** path: if `Manage AI settings →` (or Esc) tears the dialog down while a consent `POST` or disclosure `GET` is in flight, the late resolution must **not** commit `ui.ai.mode = live` and must not `setState` on the unmounted component. **No Live commit may ever fire after the dialog has been dismissed.**

**No-op-segment guard.** Clicking the already-selected segment must be a no-op (no re-fetch, no state churn) — `AiPane.tsx` guards this with `if (next === resolvedMode && !pendingLive) return`; the dialog applies the equivalent guard against its *pending* selection.

## 8. Persistence

- New boolean **`OnboardingSeen`** (default `false`) on `AiConfig`. It is a flat field on `UiPreferencesDto`, **read** by the frontend at `preferences.ui.onboardingSeen` and **patched** via the dotted config path `ui.ai.onboardingSeen` — exactly the read-shape-vs-patch-path split the existing `aiMode` already uses (`preferences.ui.aiMode` read; `ui.ai.mode` patch). §4's read reference and §9's patch reference are therefore both correct and refer to the same field by its two access paths.
- The dotted path **`ui.ai.onboardingSeen` must be added to the `ConfigStore` patch allowlist** (`_allowedFields`); otherwise `POST /api/preferences` with that key returns 400 and every exit's seen-write silently fails.
- Writes use **apply-on-success** semantics (no optimistic write), like every other preference.
- **`OnboardingSeen` is purely a UX suppression flag.** It MUST NOT be read by any AI seam, capability resolver, or gate, and MUST NEVER be used as a consent or egress predicate. `AiConsentState.IsConsented(provider, currentVersion)` remains the *sole* authoritative egress gate. (Add a code comment on the field stating this — it lives next to the consent record in `AiConfig`, so the conflation hazard is real.)

### 8.1 Migration / backfill (one-time, key-absence-gated)

The backfill is a **one-time upgrade migration for pre-existing configs**, applied **only when the `onboardingSeen` key is absent** from a loaded config. Once the key exists on disk, its stored value is authoritative and the backfill **never recomputes or overwrites it**. (A per-load recompute would re-show the overlay forever to a Preview-keeper whose `seen`-write didn't persist — see §6.1.)

On key-absence, set:

```
onboardingSeen = AiConsentState.IsConsented(provider, currentVersion)  ||  (mode == Off)
```

- **Consent recorded (valid, current version)** → `true`. They've consented; no need to introduce Live.
- **mode == Off** → `true`. They've explicitly disengaged from AI; don't re-introduce it.
- **mode == Preview** (default, untouched) → `false`. Fresh-style state; show the dialog once.
- **mode == Live but no valid consent** (e.g., a hand-edited config, or consent invalidated by a version bump) → `false`. Show the dialog so the egress consent gate is (re-)established via the inline Live path. *This is the security-critical correction: the earlier "mode ≠ Preview ⇒ seen" rule would have suppressed the dialog for a `mode=live`-without-consent user, silently leaving Live ungated at the UI.*

Implemented in the `ConfigStore` AI-backfill path (`ReadFromDiskAsync`) alongside the existing `ui.ai` backfills, persisted through the same `if (rewritten)` write-back so the computed value is stored once and not recomputed on subsequent loads.

## 9. Components & wiring

| Unit | What it does | Depends on |
|---|---|---|
| `AiOnboardingDialog` (new) | the dialog: pending-mode state, color-coded `SegmentedControl`, legend ↔ inline disclosure, adaptive button, `Manage AI settings →`, exit/seen handling | `Modal`, `SparkIcon`, `SegmentedControl`, `EgressDisclosureBody`, `usePreferences`, `getEgressDisclosure`/`postAiConsent`, router |
| `EgressDisclosureBody` (extracted) | amber callout (recipient + data list) from an `EgressDisclosure` | tokens only |
| `EgressConsentModal` (modified) | now renders `EgressDisclosureBody` instead of inline markup; behavior unchanged | `EgressDisclosureBody` |
| `InboxPage` (modified) | mounts `AiOnboardingDialog` when `!onboardingSeen && authed`; inbox fetch unchanged | `usePreferences` |
| `AiConfig` / `ConfigStore` / `UiPreferencesDto` (modified) | add `onboardingSeen` + backfill | — |

## 10. Accessibility

- Reuse `Modal`'s focus trap, Esc handling, focus restore, `aria-modal`, `aria-labelledby` (title).
- **Initial focus:** set `defaultFocus="cancel"` and mark the **`SegmentedControl`'s selected radio** as the `data-modal-role="cancel"` target, so the dialog opens with focus on the neutral mode-picker — **not** on the adaptive primary button (which, depending on pending mode, is the dismissive `Maybe later` or the cautionary `Turn off AI`). Mirrors `EgressConsentModal`'s `defaultFocus="cancel"` rationale (don't land a keyboard user on a consequential button before they've read the dialog).
- `SegmentedControl` already implements `role="radiogroup"` + roving-tabindex radios + arrow-key navigation. Wire its `describedById` to the id of the **contextual region** (legend / disclosure) so screen-reader users hear the region's description on focus; when the region content swaps (legend → disclosure), the description updates with it.
- **Announce the region swap.** The contextual region carries `aria-live="polite"` so switching to Live — and the disclosure subsequently loading then resolving — is announced without the user having to Tab into the region to discover the change. The loading state sets `aria-busy="true"` (§7.1).
- All glyphs (`SparkIcon`, warning triangle) are decorative (`aria-hidden`, `focusable="false"`).
- Live error / consent states use `role="alert"` (mirror `EgressConsentModal.ErrorBox`).
- Color is never the sole signal: each mode has a text label; the legend pairs dots with text; the Off button pairs danger-fg with the word "off".

## 11. Visual design

- Built entirely from `styles/tokens.css` (`var(--…)`) — both themes flip via `[data-theme]`. Validated in a real-token mock (light + dark) for all three states before this spec was written.
- Chrome: `.modal-dialog` (480px, `--surface-1`, `--radius-4`, modal shadow). AI-surface accents via `.ai-tint`. Buttons via the global `.btn*` classes. Amber egress callout via the existing `.callout`/`.dataList` idiom.

## 12. Testing

**Frontend (vitest)**
- Overlay shows iff `onboardingSeen === false` and authed; hidden otherwise.
- Segment selection updates pending mode + adaptive button label/style; legend ↔ inline disclosure swap on Live.
- Adaptive button commits: Off → `ui.ai.mode=off`; Preview → no mode write, `seen` set; Live → `postAiConsent` then `ui.ai.mode=live`.
- `Manage AI settings →` sets `seen`, navigates, and does **not** write `ui.ai.mode` (assert no commit for pending Off and pending Live).
- Esc does **not** set `seen` and does not commit (assert no `onboardingSeen` write on Esc; overlay would re-show on next mount with `seen=false`).
- Live state machine (§7.1): loading skeleton + disabled button while disclosure in flight; `alreadyConsented` ⇒ commit without POST; submitting state disables controls; fail-closed on fetch/POST error → no commit; abort on segment-change away from Live → no stale disclosure; **no Live commit after navigation-unmount** mid-POST.
- No-op guard: clicking the already-selected segment triggers no fetch / no state churn.
- `EgressDisclosureBody`: renders recipient + categories; shared by both consumers (snapshot/structure parity).

**Backend (xUnit)**
- `ConfigStore` patch of `ui.ai.onboardingSeen` (and that the dotted path is in the allowlist — a patch with it returns 200, not 400).
- Backfill (key-absent only): consent-recorded ⇒ `seen=true`; `mode=Off` ⇒ `true`; `mode=Preview` ⇒ `false`; **`mode=Live` without valid consent ⇒ `false`** (the security correction); key-present configs are left untouched (no recompute).
- `UiPreferencesDto` serializes `onboardingSeen` (camelCase, flat under `ui`).
- No AI seam / capability resolver reads `OnboardingSeen` (guard against consent-conflation).

**E2E (Playwright, `prod` project)**
- Fresh user → overlay appears over loading inbox → choose Live → inline disclosure → Enable → consent recorded, Live active, inbox visible.
- Returning user (`seen=true`) → no overlay.
- Grep existing visual/parity specs for inbox baselines that the overlay could perturb; add a dedicated onboarding visual spec rather than letting it bleed into inbox baselines.

## 13. Edge cases

- **Disclosure unreachable** when Live picked → fail closed (cannot enable Live), error in the inline region, mode unchanged (§7.1.5).
- **Consent POST 409** (version mismatch) → retryable error, no commit.
- **Navigate / Esc mid-fetch or mid-POST** → no late commit; the `cancelled`/`AbortController` teardown guard (§7.1.7) covers the router-unmount case the `openRef` prop-toggle guard does not.
- **Preferences not yet known** on first paint → render **no dialog** until the preferences response resolves (`onboardingSeen` unknown ⇒ overlay withheld). No flash: the inbox's own loading skeleton covers the window, and PreferencesProvider mounts above the route, so the decision is made once `preferences` is present.
- **Reload mid-dialog** before any exit → nothing committed, `seen` never set → overlay re-shows next launch. Intended (no partial state to recover).
- **Multi-window** (desktop shell + a second window): both can render the overlay on first run. On window focus, preferences refetch; if `onboardingSeen` has flipped to `true` (resolved in the other window), **auto-dismiss the overlay without committing the local pending selection**, so a stale second overlay can't overwrite the first window's choice.
- **Narrow / short viewport** → the dialog scrolls within `.modal-dialog` (`max-height: calc(100vh - var(--s-16))`, `overflow-y:auto`). Constraint: at a minimum tested height of **480px**, the lead copy + `SegmentedControl` must be visible without scrolling (the mode picker is the load-bearing control); only the body/legend below scrolls. Verify in the visual pass.

## 14. Out of scope / deferred

- Independent per-feature AI toggles (the `AiFeaturesConfig` map) — owned by the AI Settings epic (#485 / #536–538).
- Any re-show / "what's new" re-onboarding after a disclosure-version bump (onboarding is strictly first-run).
- **Inbox-level signal/affordance when an existing Live consent goes stale** (post version-bump, `mode=live` but `IsConsented` now false → `AiSeamSelector` drops Live to Noop). Today the only re-consent surface is the Settings `EgressConsentModal`. Surfacing a "Live paused — re-confirm" affordance from the inbox is a real gap the security review flagged, but it concerns *ongoing* consent staleness, not first-run onboarding — it belongs with AI-failure-surfacing, not this feature. Tracked as a follow-up; **not** addressed here.
- A single multi-field preferences patch (mode + seen atomically) — needs a backend endpoint change (§6.1).
- Provider/model selection and tuning knobs (live in `AiPane`).

## 15. Resolved decisions & residual notes

- **D1 — Esc does *not* set `seen`** (resolved). A reflexive Esc on the overlay re-shows next launch; only an explicit button or the `Manage AI settings →` link burns the one-shot. (§6.)
- **D2 — `Maybe later` label kept** (resolved). The "implies a later that never comes" wording concern is accepted as a minor tradeoff, partly mitigated by D1 (Esc — the common reflexive bail — preserves a real "later"). No in-product re-entry affordance is built here. (§5.2.)

**Product-lens premise (informational).** The review challenged the first-run-modal premise itself: discovery might be better served by an in-context "this is AI Preview — go Live?" affordance *on the AI surface the user sees*, and the Live-upgrade need is asserted, not evidenced. This was a deliberate, user-directed choice (a guided first-run dialog, form-factor B), so it stands. An in-product re-entry to Live (a follow-up, not in this feature) would hedge the "dismiss and never find Live again" failure mode if usage data later shows heavy `Maybe later` use.

Copy is provisional and may be tightened during implementation; the disclosure content is fixed by `EgressDisclosure.cs` and must not be paraphrased.
