# v2 AI P0 PR3a — Frontend mode migration & sample-data treatment — design

- **Roadmap:** [`docs/specs/2026-06-05-v2-ai-roadmap-design.md`](2026-06-05-v2-ai-roadmap-design.md) §4 (the three AI modes), §7 (P0 exit). Builds directly on PR2 [`docs/plans/2026-06-06-v2-ai-p0-pr2-capability-model.md`](../plans/2026-06-06-v2-ai-p0-pr2-capability-model.md).
- **Date:** 2026-06-07
- **Tier / Risk:** T2 · gated **B1 (UI-visual)** — a user-visible Settings control change + new labeling on every AI surface.
- **Branch / Base:** `feat/v2-ai-pr3a-fe-mode-migration` → **`V2`** (never `main`).
- **Status:** Design (awaiting human spec review) · revised after ce-doc-review (2 passes).

---

## 1. Problem & context

PR2 shipped the **tri-state capability model** on the backend, dark: `AiMode {Off, Preview, Live}` is now the source of truth (`config: ui.ai.mode`), `GET /api/preferences` emits `ui.aiMode` (`"off"|"preview"|"live"`) alongside a derived `ui.aiPreview` bool, and `POST /api/preferences` accepts the `ui.ai.mode` key. The frontend still speaks the **legacy binary** vocabulary: a boolean `aiPreview` toggle (`Settings → Appearance`) whose state is mirrored into a locally-derived `ALL_ON`/`ALL_OFF` capability set.

Two gaps follow from that mismatch:

1. **The FE vocabulary doesn't match the model it sits on.** The backend has three modes; the FE has a checkbox. The checkbox already distinguishes off from on-as-preview, so PR3a's mode migration is mostly *vocabulary correction* (making "Off" vs "Preview" explicit and naming the source of truth `aiMode`) plus the foundation PR3b builds Live on — not a new reachable state. The genuinely new user-facing functional state (Live) stays deferred to PR3b; the user-visible payoff of *this* slice is concentrated in gap #2.
2. **Preview content renders inconsistently labeled — a truthfulness gap that exists today.** With the toggle on, some surfaces carry an ad-hoc hardcoded string ("AI preview — sample content, not generated from this PR" on `AiSummaryCard` and `PreSubmitValidatorCard`; "AI preview — composer suggestions appear here" on `AiComposerAssistant`), while others render canned content with **no marker at all** (hunk annotations, draft suggestions, inbox category chips, the Activity rail, file-focus hints). The roadmap's **truthful-by-default** constraint (§4) requires Preview content to be *unmistakably and consistently* labeled as sample.

PR3a closes both gaps on the frontend, replaces the scattered ad-hoc labels with one consistent marker, and brings the architecture doc current with the tri-state reality PR2 shipped.

## 2. Scope & non-goals

**This is a frontend + docs change. There is zero backend code change** — PR2 already accepts `ui.ai.mode` on POST and emits `aiMode` on GET, so the wire contract PR3a consumes already exists.

**In scope (PR3a):**
- Migrate the FE source of truth from `ui.aiPreview` (bool) to `ui.aiMode` (tri-state string).
- Replace the binary `Switch` with an **`Off | Preview`** segmented selector (Live plumbed in the type but not rendered).
- Define-once **sample-data treatment** (`SampleBadge`) and wire it into **every** AI surface that renders content today (see §5 for the audited, code-derived list), replacing the existing ad-hoc hardcoded sample strings.
- Update [`.ai/docs/architectural-invariants.md`](../../.ai/docs/architectural-invariants.md) to describe the tri-state gating model and the truthful-by-default (SampleBadge-on-every-Preview-surface) invariant.

**Out of scope — deferred to PR3b (lands with P1's first real seam):**
- The **Live** segment in the selector.
- Per-provider **egress-consent** gate before the first Live call.
- The four **disabled-state** guidance messages (provider descriptor).
- Restoring a real `GET /api/capabilities` fetch and the **probe caching** it requires (roadmap KTD-4). *Off/Preview need no probe — capabilities are deterministic — so PR3a does not touch this.*

**Sequencing dependency (must hold across PRs).** PR3a adds **no** server-side guard blocking Live seam calls when consent is unrecorded. Its only defenses are (a) the real-seam bag is empty in P0 (every seam resolves to Noop) and (b) the selector does not expose Live. Because the backend already accepts `POST /api/preferences {"ui.ai.mode":"live"}` via a direct API/config edit, **PR3b's egress-consent gate MUST land before any P1 work registers a real Live seam.** If a real seam ships first, a hand-edited Live config could egress PR content (diffs, titles, descriptions) to the provider with no consent. **This dependency must stay visible across PRs:** PR3a's PR body must call it out explicitly. Filing a dedicated GitHub tracking issue is **deferred to PR3b planning** (maintainer decision, 2026-06-07) — the PR-body callout is the interim record, and the issue is created when PR3b planning begins. The actual server-side guard (block/refuse Live seam calls without a recorded consent) is **PR3b's** to build — it is backend code, out of PR3a's FE-only scope.

**Rationale for the split.** In P0 no live-capable seams are registered, so selecting Live resolves to *all nine capability flags false* even with the CLI installed and authenticated. A Live option would be a dead end that only ever renders "unavailable", and exposing it forces the probe-caching work (KTD-4) forward for no user payoff. Off/Preview, by contrast, has value today (honest relabeling, the sample-data fix, and it dissolves KTD-3 — see §4). PR3b ships Live when P1 makes it mean something.

## 3. Decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Scope shape | Split: PR3a (Off/Preview + sample label + doc) now; Live → PR3b | Live is a no-op in P0; avoids pulling KTD-4 forward |
| D2 | Selector control | Reuse `SegmentedControl` (the Theme/Density primitive), in-place in `AppearancePane` | Established pattern; no new control to design/test |
| D3 | Live in selector | **Hidden** (two segments) — plumbed in the type, not rendered | No dead control, no "coming soon" copy debt |
| D4 | Segment label | **"Off" / "Preview"** | Matches the `AiMode` enum + spec vocabulary across backend→config→UI |
| D5 | Sample marker placement | **Header badge** beside an AI label for card surfaces; a **region-level** marker on the section header for label-less ambient surfaces (file-focus, inbox) | Composes onto any surface; unmissable without per-item noise |
| D6 | Sample marker tone/word | **Dashed-accent pill**, uppercase **"Sample"** (solid-fill inline variant inside the already-dashed hunk-annotation container) | Reads as "provisional/placeholder", on-brand, calm per PRism's sparing-accent aesthetic |
| D7 | Capability source | Keep deriving locally from mode (`preview→ALL_ON`, else `ALL_OFF`); **do not** fetch `/api/capabilities` | Preserves the existing reactive re-render architecture + its regression test; Off/Preview are deterministic |

## 4. Architecture & data flow

**Source of truth.** `preferences.ui.aiMode: AiMode` replaces `preferences.ui.aiPreview: boolean` as the value the FE reads. The selector writes the mode via the existing single-field POST: `set('ui.ai.mode', mode)`. The POST body is the **literal flat key** `{"ui.ai.mode":"preview"}` (not nested JSON) — this is exactly what the backend's `ConfigStore.PatchAsync` dotted-path allowlist already handles (PR2), so no endpoint change is needed.

```
Settings selector  ──set('ui.ai.mode','preview')──▶  POST /api/preferences  {"ui.ai.mode":"preview"}
        ▲                                                      │
        │ reads preferences.ui.aiMode                          ▼
PreferencesContext  ◀──GET /api/preferences { ui:{ aiMode } }──┘
        │
        ├─▶ useCapabilities()  =  mode==='preview' ? ALL_ON : ALL_OFF   (derived, no fetch)
        │
        └─▶ useAiGate(key)     =  capabilities[key] && mode !== 'off'
                                         │
                                         ▼
                 AI surfaces render (gated) + SampleBadge when mode==='preview'
```

**Capabilities stay derived, not fetched.** `useCapabilities()` continues to compute `ALL_ON`/`ALL_OFF` locally — re-keyed from `aiPreview` onto `mode === 'preview'`. This keeps the instant cross-component reactivity (and the `useAiGate.reactivity` regression test, including its assertion that **no** `/api/capabilities` call happens). Fetching real capabilities only becomes necessary in Live (where the nine flags depend on a provider probe), which is PR3b.

**Two-factor gate, preserved.** `useAiGate(key)` keeps its `capabilities[key] && <user-opted-in>` shape; factor-2 moves from `aiPreview` to `mode !== 'off'`. In PR3a both factors trace to the same source (mode), so the gate reduces to `mode === 'preview'` — but the two-factor *shape* is retained deliberately as the forward-compat seam (D112): when PR3b sources capabilities from the backend, `capabilities[key]` (backend-allowed) and `mode !== 'off'` (user intent) decouple cleanly. §8 adds a test that locks the shape so a later refactor cannot quietly collapse it.

**KTD-3 dissolves for free.** PR2 documented a known asymmetry: the legacy boolean toggle, applied to a Live-mode config, silently downgrades it to Preview (the toggle only knows Off/Preview). PR3a stops writing the legacy bool entirely — it writes `ui.ai.mode` — so the FE can no longer cause that downgrade. No explicit guard needed.

## 5. Components & files

All paths under `frontend/src` unless noted.

**Types & state**
- `api/types.ts` — add `export type AiMode = 'off' | 'preview' | 'live';`. Add `aiMode: AiMode` to `UiPreferences`. **Remove the `aiPreview` field** (no FE reader remains after this PR; the backend still emits it for other consumers, but the FE type need not model a field it ignores). Removing it makes every straggler reader a compile error — intended (see §8 for the test fixtures this forces).
- `contexts/PreferencesContext.tsx` — **the `readKey`/`writeKey` helpers are explicit per-key `if`-chains, not a generic path resolver** (they handle `theme`/`accent`/`aiPreview`/`density` and then slice the literal `inbox.sections.` prefix). A new `ui.ai.mode` key would fall through to that slice (`'ui.ai.mode'.slice(15)` → `''`), read `prefs.inbox.sections['']` (undefined — rollback silently skipped) and corrupt `inbox.sections` on a failed-POST revert. Required changes:
  - Add `| 'ui.ai.mode'` to the `PreferenceKey` union; **remove** `'aiPreview'` from the union. Update the `InboxSectionKey` alias to `Exclude<PreferenceKey, 'theme' | 'accent' | 'density' | 'ui.ai.mode'>` (drop `'aiPreview'`, **add** `'ui.ai.mode'`) — otherwise `'ui.ai.mode'` stays a valid `InboxSectionKey` and the `(key as InboxSectionKey)` cast in `writeKey` silently accepts any future `ui.*` key that lacks an explicit arm, re-opening the slice-fallthrough hazard at compile-time-invisible cost.
  - Add an explicit arm to `readKey`: `if (key === 'ui.ai.mode') return prefs.ui.aiMode;` and **delete** the `aiPreview` arm.
  - Add an explicit arm to `writeKey`: `if (key === 'ui.ai.mode') return { ...prefs, ui: { ...prefs.ui, aiMode: value as AiMode } };` and **delete** the `aiPreview` arm.
  - Note the read/write asymmetry: this is the first key whose POST wire name (`ui.ai.mode`) differs from its response-field path (`ui.aiMode`); the explicit arms bridge it. The generic `inbox.sections.*` fallthrough does **not** cover `ui.*` keys.

**Hooks**
- `hooks/useCapabilities.ts` — derive from `preferences.ui.aiMode === 'preview'` (was `aiPreview`). `ALL_ON`/`ALL_OFF` constants unchanged.
- `hooks/useAiGate.ts` — factor-2 becomes `(preferences?.ui.aiMode ?? 'off') !== 'off'`. Add `export function useIsSampleMode(): boolean` returning `preferences?.ui.aiMode === 'preview'` — the single predicate the sample treatment keys on.

**Selector**
- `components/Settings/panes/AppearancePane.tsx` — replace the `<Switch>` row with a `<SegmentedControl>`:
  - `label="AI mode"`, help text `"Off · no AI. Preview · sample output, clearly labeled."`
  - `options={[{value:'off',label:'Off'},{value:'preview',label:'Preview'}]}` → `SegmentedControl<T>` infers `T = 'off' | 'preview'`.
  - `value={(preferences.ui.aiMode === 'live' ? 'preview' : preferences.ui.aiMode) as 'off' | 'preview'}` — the cast is **required**: the bare ternary infers `AiMode` (its else-branch is `AiMode`), which is not assignable to the inferred `T='off'|'preview'` and would fail the build under strict TS. The cast is sound because the only non-`'off'|'preview'` value (`'live'`) is mapped to `'preview'` first. This is defensive only: if a config already carries `live`, the control displays Preview and **does not write back**, so it never downgrades a Live config (PR3b adds the third segment).
  - `onChange={(v) => set('ui.ai.mode', v).catch(() => {})}` — keep the existing optimistic-set + rollback-on-failure pattern.

**Sample-data treatment**
- New `components/Ai/SampleBadge.tsx` — renders a "Sample" pill only when `useIsSampleMode()` is true (returns `null` otherwise). Accessible: `aria-label="Sample data — illustrative, not real AI output"`. Two placement variants (one component, a `variant` prop):
  - `inline` (default) — a dashed-accent pill sized for an AI label row (card surfaces). Inside the already-dashed `AiHunkAnnotation` container, the inline variant uses a **solid** `accent-soft` fill (no dashed border) so it stays legible against the container's dashed stroke.
  - `region` — the same pill placed on a section header, for label-less ambient surfaces.
- Styling lives in a colocated `SampleBadge.module.css` reusing the existing `.chip` geometry and `--accent`/`--accent-soft` tokens (`color-mix(in oklch, …)` is already used in `tokens.css`). It is a single self-contained component — no global-token lift applies.
- **Wire the badge into every content-rendering AI surface.** The list below is derived mechanically from the current `useAiGate` consumer set **plus the components those consumers gate** (the inbox gates are read in `InboxPage` but the content renders in `ActivityRail`/`InboxRow`, so the badge lives in the rendered component, not the gate site). Each surface is classified content-rendering (needs badge) or trigger-only (no badge):
  - **Replace** the existing hardcoded "AI preview — …" string with `<SampleBadge />` (inline) on: `components/PrDetail/OverviewTab/AiSummaryCard.tsx` (`summary`, the chip at the card label), `components/PrDetail/SubmitDialog/PreSubmitValidatorCard.tsx` (`preSubmitValidators` — note the card renders in `SubmitDialog`, while `PrHeader.tsx` only computes the gated `validatorResults`), `components/Ai/AiComposerAssistant.tsx` (`composerAssist` — replace the `AI preview —` prefix; keep the descriptive remainder).
  - **Add** `<SampleBadge />` (inline) beside the existing AI label (no current sample marker): `components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx` (`hunkAnnotations`, solid-fill variant), `components/PrDetail/Reconciliation/StaleDraftRow.tsx` (`draftSuggestions` — the AI content renders here inside the `{aiSuggestion && (…)}` block beside its `ai-summary-label`, **not** in `UnresolvedPanel`).
  - **Region-level** `<SampleBadge variant="region" />` for label-less surfaces (these render fabricated content gated on an AI flag today and are currently unmarked). Note these two inbox surfaces do **not** call `useAiGate` themselves — the gates `inboxEnrichment`/`inboxRanking` are read in `pages/InboxPage.tsx` (lines 19-20) and threaded down as props, so the badge is placed in the rendered components, not the gate site:
    - File-tree focus area — `components/PrDetail/FilesTab/FileTree.tsx` (`fileFocus` dots, one marker on the tree/focus region header, not per-dot).
    - Inbox enrichment — placed in `pages/InboxPage.tsx` adjacent to the AI-gated rows region (`inboxEnrichment`, one marker, **not** inside the per-row `InboxRow.tsx`).
    - Activity rail — `components/ActivityRail/ActivityRail.tsx`, one marker beside the rail's "Activity" section header (`inboxRanking`; the rail is shown only under the gate and its activity list is entirely canned — the "Watching" section is the same gated, canned block).
  - **Trigger-only, intentionally excluded:** `components/PrDetail/AskAiButton.tsx` (`composerAssist`) renders a button, not sample content; the `AskAiDrawer` it opens renders honest "AI isn't available right now" copy (`askAiUnavailableResponses.ts`), not fabricated output, so it needs no badge. If PR3b makes the drawer emit canned replies, it joins the list.
  - Surfaces not yet rendering content (`draftReconciliation`) inherit `<SampleBadge />` when they light up in P1+.

**Re-sourced direct read**
- Only `OverviewTab.tsx` reads `preferences?.ui.aiPreview` directly (line 19, for `PrDescription`'s layout prop). Removing the type field forces re-sourcing it — re-source it to the **`useAiGate('summary')` value already computed in `OverviewTab` as `aiOn`** (pass `aiPreview={aiOn}`), not to a bare `aiMode !== 'off'` check. `PrDescription`'s AI-layout (tinted card, hidden title) exists *because* `AiSummaryCard` shows the title/summary instead, so the prop must track summary-card visibility. Sourcing it from `useAiGate('summary')` keeps the two in lockstep today **and** under PR3b's capability decoupling; a mode-only source would diverge (a Live config with `summary` capability false would render the AI description layout with no summary card → an overview with no title). `FilesTab.tsx` does **not** read the preference directly — it passes the `useAiGate('fileFocus')` result into `FileTree`'s `aiPreview` prop, so it inherits the migration automatically. The boolean prop names on `FileTree`/`PrDescription` stay (rename out of scope).

## 6. The sample-data treatment (`SampleBadge`)

One component, one predicate, every content-rendering surface. `SampleBadge` is the canonical "this is illustrative" marker the roadmap requires be defined once in P0 and inherited by all P1+ AI surfaces. It is gated solely on `useIsSampleMode()` (`mode === 'preview'`), so it appears in Preview and is absent in Off (nothing renders) and in future Live (real output — no marker). It also **consolidates** today's three different hardcoded sample strings into one consistent marker. Placement: the `inline` variant pins beside a surface's AI label (card surfaces); the `region` variant sits on a section header for label-less ambient surfaces (file-focus, inbox chips, Activity rail) where per-item badging would be noise.

The marker is also a **positioning lever**, not only an anti-noise device: Preview doubles as the demo surface that shows a user what AI looks like before they configure it (roadmap §4). Truthful-by-default is non-negotiable and wins regardless, but the copy/tone should stay enticing while unmistakable — the calm "Sample" wording and the region-level placement on ambient surfaces already lean that way. Treat the copy/prominence choice (implementation-review visual check) as a demo-appeal-vs-unmistakability balance, not purely a crowding concern.

## 7. Architectural-invariants doc update

Rewrite the binary-gate language in [`.ai/docs/architectural-invariants.md`](../../.ai/docs/architectural-invariants.md) (currently ~line 7) to describe the tri-state model PR2 shipped:
- The gate is `AiMode {Off, Preview, Live}` (config `ui.ai.mode`), not a boolean. **Off** → Noop seams (no AI); **Preview** → Placeholder seams (canned sample data, *unmistakably labeled* — truthful-by-default); **Live** → real provider output, gated by the availability probe.
- `GET /api/capabilities` returns the nine `ai.*` flags resolved from mode (Off → all false; Preview → all true; Live → true only where a real seam is registered *and* the provider probe succeeds).
- Note the `aiPreview` → `ui.ai.mode` migration so a reader who encounters either name in code understands the relationship (`aiPreview` survives only as a derived/translated wire field for back-compat).
- **Add the truthful-by-default invariant:** every AI surface that renders Preview/sample content MUST render `SampleBadge`. This documents the rule that the §8 coverage test enforces for current surfaces and that every future (P1+) surface must follow.

This is the doc update deliberately deferred from PR2 (PR2 was dark; the observable contract was preserved). No other invariant changes.

## 8. Testing strategy (TDD)

- **Re-key `hooks/useAiGate.reactivity.test.tsx`** onto mode — this test currently threads `aiPreview` through five places, all of which must migrate:
  - `state` hoisted object: `{ aiPreview }` → `{ aiMode }`.
  - mock prefs factory `ui: { …, aiPreview }` → `ui: { …, aiMode }`.
  - mock POST handler `if ('aiPreview' in body) state.aiPreview = …` → `if ('ui.ai.mode' in body) state.aiMode = body['ui.ai.mode']`.
  - `Toggler` `set('aiPreview', true)` → `set('ui.ai.mode', 'preview')`.
  - **Keep** the assertion that no `/api/capabilities` request is made, and the `ALL_ON`/`ALL_OFF`/`null` derivation assertion (re-keyed on mode).
- **Migrate the unit-test mock factories** that construct `aiPreview` (drop it, add `aiMode`). These live under `src/` and **are** type-checked, so the type removal surfaces them as compile errors. `AppearancePane.test.tsx` needs two changes, not one: re-key its mock `ui` (`aiPreview` → `aiMode`), **and** rewrite its load-bearing assertion `getByRole('switch', { name: /AI preview/i })` (line 25) to `getByRole('radiogroup', { name: 'AI mode' })` plus assertions that the `Off` and `Preview` radios are present — the `role=switch` query is a runtime failure the compiler will *not* catch. (`FileTree.test.tsx`'s `aiPreview` is a component prop, not the preference — leave it.)
- **Selector** (`AppearancePane`): renders exactly two segments (Off, Preview) and no Live; selecting Preview POSTs `{"ui.ai.mode":"preview"}`.
- **Defensive invariant** (replaces a user-facing claim — Live is not UI-reachable in PR3a): a **hand-seeded `live` config** renders as Preview and the selector issues **no** POST until the user picks a segment.
- **Two-factor seam lock:** mock `capabilities[key] = false` while `mode !== 'off'` and assert the gate is `false` — locks the D112 shape so a future refactor cannot collapse the gate to a single factor without a failing test.
- **Gating**: with `mode==='preview'`, an AI surface and its `SampleBadge` both render; with `mode==='off'`, neither renders.
- **`SampleBadge`**: renders only when `mode==='preview'`; returns `null` for `off`/`live`; exposes its `aria-label`; both `inline` and `region` variants render.
- **Coverage guard**: a test enumerates the content-rendering `useAiGate` consumer set (the §5 list) and asserts each renders a `SampleBadge` in Preview — the structural backstop for the truthful-by-default guarantee.
- **e2e — the compile-error safety net does NOT reach here.** The Playwright specs are not bound to `api/types` (they infer shapes from local `makeDefaultPreferences()` via `ReturnType<…>`, and `e2e/` is outside the app `tsconfig`'s `include`), so removing `aiPreview` from `UiPreferences` produces **zero** e2e compile errors. The implementer MUST `rg aiPreview frontend/e2e/` and migrate every occurrence by hand. Two failure modes if missed: a `role=switch` locator times out (red), or a mock POST handler that only recognizes `aiPreview` ignores the new `{"ui.ai.mode":…}` POST so the GET returns stale state (silent **false-green** — the worst case, since it hollows out the truthful-by-default coverage).
  - **Mock-driven specs to migrate** (switch→`role=radio` locator + `else if (key === 'ui.ai.mode')` POST branch + `aiMode` in the GET `ui` block): `settings-flow.spec.ts` (inline `makeDefaultPreferences` + POST handler + switch), `settings-modal-visual.spec.ts` (shared fixture + POST handler + switch), `inbox.spec.ts` (inline `defaultPreferences` + stateful POST + GET + switch locator ~L358), and **`ai-gating-sweep.spec.ts`** — the primary cross-surface AI-gating sweep (stateful POST ~L198-200 + GET `ui` ~L209 + two switch locators ~L375/L436); leaving it on `aiPreview` runs the whole sweep in the off-state while asserting on-state surfaces.
  - **Shared fixtures/helpers to migrate** (add `aiMode` alongside/ replacing `aiPreview`): `e2e/fixtures/preferences.ts`, `e2e/helpers/replace-mocks.ts`, and the static AI-off GET fixture in `a11y-audit.spec.ts` (add `aiMode: 'off'` for clarity even though an absent field coerces to off).
  - **Deliberately left unchanged** (they POST the legacy `{aiPreview:…}` shape *directly to the real backend*, which PR2 still accepts — note this so they read as intentional, not forgotten): `ask-ai-drawer.spec.ts`, `parity-baselines.spec.ts`, `helpers/s4-setup.ts`.
  - After migration, assert the two options render and that toggling to Preview surfaces sample-labeled AI content.

## 9. Alternatives considered

- **Full roadmap-PR3 in one slice** (Live + consent + disabled-states + probe caching). Rejected (D1): ships a dead Live mode and pulls a P1 dependency forward for no P0 payoff.
- **Show Live disabled** in the selector (greyed third segment). Rejected (D3): dead control + "coming soon" copy is a sliver of the disabled-state UX we're deferring.
- **Footer caption** / **top strip** for the sample marker. Rejected (D5): the footer is easy to miss and awkward on inline surfaces; the strip is card-shaped chrome that won't compose onto inline surfaces and grows noisy when repeated.
- **Restore a real `/api/capabilities` fetch + `CapabilitiesContext`** now. Rejected (D7): unnecessary for deterministic Off/Preview, and it would re-introduce the focus-refetch/probe-hang risk (KTD-4) that only needs solving for Live (PR3b).
- **Lint-enforced badge presence** (an ESLint rule flagging any `useAiGate` call in a file that does not import `SampleBadge`). Deferred as future hardening: it would false-positive on legitimate trigger-only consumers (`AskAiButton`) and on the gate-without-render cases. PR3a relies on the §8 coverage test plus the §7 documented invariant; a lint rule or a combined `useAiSurface(key)` hook can harden this in a later PR.

## 10. Risks & open questions

- **Sample-badge surface coverage.** The badge must reach *every* surface that renders Preview content, or the truthful-by-default guarantee has a hole — and pass-1 review already found two surfaces (`inboxEnrichment` chips, `inboxRanking` Activity rail) the first draft mis-classified as "not yet rendering". Mitigation: the §5 list is now derived from the `useAiGate` consumer set **plus the components those consumers gate**, and the §8 coverage test asserts badge presence at the **rendered-output level** (render the surface in Preview and assert a `SampleBadge` appears), not per-`useAiGate`-call-site — because for the inbox surfaces the gate (`InboxPage`) and the rendered content (`ActivityRail`/`InboxRow`) live in different files. §7 documents the invariant for future surfaces.
- **Structural enforcement is convention + test, not a compiler guarantee.** A future P1+ surface could still render gated content without the badge if a developer also omits it from the coverage test. The §7 invariant is the documented rule; the lint/`useAiSurface` hardening (§9) is the durable fix, deferred.
- **`SampleBadge` on dense/inline surfaces.** The pill must not crowd the diff (hunk annotation) or the file tree. Mitigation: the inline variant uses a solid fill inside the already-dashed hunk container; label-less surfaces (file-focus, inbox) use the region variant at the section level, not per-item. Visual check in compact density.
- **Egress-consent sequencing (cross-PR).** See §2 — PR3b's consent gate must land before any P1 real Live seam is registered, or a hand-edited Live config could egress PR content without consent. Bounded today by the empty real-seam bag and the locally-bound sidecar (host/origin/session middleware limits the surface to the local user). The interim enforcement record is the **PR3a PR-body callout** (§2); a dedicated tracking issue is deferred to PR3b planning (maintainer decision), and the durable server-side guard is PR3b's to build.
- **Open:** exact `SampleBadge` copy/`aria-label` wording — proposed "Sample" (pill) / "Sample data — illustrative, not real AI output" (aria) — confirm during implementation review against the roadmap §4 "unmistakably labeled" bar, especially on dense hunk annotations.
- **Deferred to PR3b planning:** whether PR3b actually decouples the two gate factors (sourcing `capabilities` from the backend) or also derives both from mode. If the latter, the two-factor shape stays cosmetic and the §4 forward-compat justification should be revisited.

## 11. Acceptance criteria

1. `Settings → Appearance` shows an `Off | Preview` segmented control; the legacy switch is gone.
2. Selecting **Preview** renders AI sample content across all surfaces, each carrying a `SampleBadge` (inline on card surfaces; region-level on file-focus, inbox chips, and the Activity rail); selecting **Off** hides all AI content and badges.
3. The FE reads/writes `ui.aiMode` / `ui.ai.mode`; it no longer reads or writes `aiPreview` (the field is removed from `UiPreferences` and the `PreferenceKey` union).
4. No `GET /api/capabilities` request is issued (capabilities remain derived).
5. **Defensive invariant:** a hand-seeded `live` config renders as Preview, and the selector issues no POST until the user picks a segment (the `live` state is reachable only via config edit / PR3b, not via PR3a's UI).
6. No ad-hoc hardcoded "AI preview — sample content…" strings remain; all sample marking flows through `SampleBadge`.
7. `.ai/docs/architectural-invariants.md` describes the tri-state gating model and the SampleBadge truthful-by-default invariant.
8. Frontend lint/build/test + the full e2e suite (settings, inbox, and the AI-gating sweep) are green; backend is untouched.
