# Configurable summary length cap (#525)

**Issue:** #525 — fold-in of the #485 AI Settings tab epic. **Branch:** off `origin/V2`.
**Tier:** **T3** (escalated from T2 — beyond the #496-style config plumbing, this changes the `PrSummary`
seam contract and adds cross-tier "summary is stale vs. the current cap" behavior). **Risk:** gated
**B1 (UI-visual)** — adds a visible Settings control, changes the rendered shape of every Live AI summary,
and surfaces an "Out of date" → Regenerate offer; a human eyeballs the result at the visual-assert gate.
(Tier deviation documented per behavioral-guidelines: bumped mid-design when the owner chose the
active-Regenerate offer, which requires the contract change.)

## Problem

`ClaudeCodeSummarizer` sometimes returns overly long summaries that defeat scannability. There is no
length guidance in the prompt and no user control. Phase 1 (#496) established the pattern for a
configurable, hot-reloaded, clamped AI numeric knob (provider timeout, annotation cap); this adds a
third knob of the same shape — a **summary character cap** — and feeds it into the summarizer prompt.

## Decisions (owner-confirmed)

- **D1 — Enforcement: best-effort prompt nudge only.** Inject "keep the summary within about N
  characters" into the system prompt. **No server-side truncation.** Rationale: the summary renders as
  markdown (#465 — bullets, fenced code, a leading `CATEGORY:` line); a hard chop risks breaking markdown
  mid-structure, and summary output tokens are tiny so this is a *scannability* nudge, not a cost lever.
  Any residual visual overflow is a display-layer concern (CSS), not a server-truncation concern. The cap
  is a soft target the model aims for.
- **D2 — Bounds.** `Min = 500`, `Max = 5000`, `Default = 1000` characters. Step 100 in the stepper.
  The cap targets the **summary body** (the markdown after the `CATEGORY:` line), which is what the user
  reads. The count is over the body's **raw markdown** and is **approximate** — structural syntax
  (`- `, `###`, code fences) counts toward the budget, and the model only *aims* for the target (it
  cannot exactly self-count). The prompt and help copy frame it as approximate so the control doesn't
  read as a precise readable-character guarantee.
- **D3 — Format guidance (prompt rewrite).** Instruct a **bulleted** summary that **groups related
  bullets under short markdown subheadings** (`###` / h3) **when the PR has enough distinct themes to
  warrant grouping** — for a trivial PR a flat short bullet list is fine (do not force subheadings onto
  one or two bullets). The model **chooses** bullet count and groupings; we do **not** prescribe a fixed
  count or fixed subheading set. Heading level is pinned to `###` so the model doesn't emit arbitrary
  levels; the `.ai-markdown` CSS already flattens heading *sizes*, so we do **not** add a renderer
  heading-remap layer (best-effort; YAGNI).
- **D4 — Placeholder shape.** The Preview placeholder reflects the new grouped shape at a representative
  length via a new `PlaceholderData` constant used only by `PlaceholderPrSummarizer`; the existing
  short `SummaryBody` (shared with the #410 inbox enricher) is left unchanged. It targets the
  **default 1000-char** shape and includes **at least one `###` subheading group** so Preview
  demonstrates the new format — this is the reference shape for the B1 gate. The placeholder is a fixed
  illustrative sample — it does **not** dynamically react to the live cap value. (At the 500-char floor,
  subheadings may collapse to a flat bulleted list — that is acceptable.)
- **D5 — Overflow / card footprint.** **No new CSS.** The summary card has no `max-height` today and
  grows within the existing PR-detail scroll container; uncapped summaries already do this, so the cap
  only *reduces* average height. We do **not** introduce a clip/scroll boundary (consistent with D1:
  footprint is a layout concern the existing container already absorbs). The B1 gate checks the
  default-cap shape; spot-check that the max (5000) renders without breaking the page.
- **D6 — Cap-change staleness offer (owner-confirmed).** When the live cap differs from the cap the
  *displayed* summary was generated under, the card marks the summary **stale** and surfaces the existing
  Live-only **"Out of date" chip + Regenerate** button — same affordance and copy as base-SHA drift,
  reused (no new component). "Out of date" is intentionally generic — it means "generated under conditions
  that no longer hold," true for both diff-drift and a cap change. Honest detection (offer only when
  *actually* stale, never a blunt nag) requires the summary to carry its generation-time cap:
  - **Stamp.** `PrSummary` gains a trailing additive `int? GeneratedMaxChars = null` (keeps the existing
    `new PrSummary(body, category)` sites compiling — only `ClaudeCodeSummarizer` + `PlaceholderPrSummarizer`
    construct it). The real summarizer stamps **`ClampSummaryCharsForRead(raw)`** — the *identical* clamp
    the GET DTO projects into `configuredMaxChars`, so stamp and displayed cap are equal by construction.
    **Not** the write-clamp `ClampSummaryChars` (its Min floor would diverge from the read-clamp for a
    hand-edited sub-500 config and pin a summary permanently stale). Cached *with* the summary, so a cache
    hit returns the original gen-time cap. `PlaceholderPrSummarizer` stamps `DefaultSummaryChars`;
    absent/legacy → `null` → never stale.
  - **Detection.** `useAiSummary` ORs `capChanged` into staleness:
    `isStale = (baseShaChanged && !staleCleared) || capChanged`, where
    `capChanged = summary.generatedMaxChars != null && configuredMaxChars != null && summary.generatedMaxChars !== configuredMaxChars`.
    The `configuredMaxChars != null` guard suppresses a false-stale flicker while `preferences` is still
    loading (the summary GET can resolve before the preferences GET); `OverviewTab` passes
    `preferences?.ui.summaryMaxChars ?? null`. `capChanged` is a **pure render-time comparison** — it must
    **NOT** be added to the fetch-effect dependency array (mirrors the deliberate `baseShaChanged`-omitted
    token discipline; otherwise a cap change would auto-refetch every open PR, contradicting the Caching
    nuance). It is **self-clearing**: a Regenerate restamps the current cap → `capChanged` false. When base
    drift and cap-change are both true, a single Regenerate clears both (the new summary restamps the cap
    *and* the regenerate handler sets `staleCleared`).
  - **Announce.** The card's existing `aria-live` region only announces *post-mount mutations*. The primary
    flow here is cross-page (change cap in Settings → return to the PR), where the card remounts with the
    chip already present → silent for AT. Add a small on-mount effect: when `isStale` is true on mount,
    push a polite announcement (reusing the existing `announce` state that already says "Summary updated").
    This also covers the pre-existing base-drift stale-on-mount case.
  - **Live-only:** `showStale = live && isStale` already gates Preview/Off out, so Preview never shows the
    chip regardless of the placeholder's stamped value. The chip stays visible during an in-flight
    regenerate (inherited behavior; the spinner is the in-progress cue).

## Acceptance criteria

- [ ] `ui.ai.summaryMaxChars` exists end-to-end: persisted in `AiConfig`, clamped on write
      (`AiConfigBounds.ClampSummaryChars`) and on read/display (`ClampSummaryCharsForRead`), patchable
      via the `ConfigStore` dotted-path allowlist, surfaced in the GET `/api/preferences` DTO, and
      editable via a `NumberStepper` in `AiPane`.
- [ ] The clamped, hot-read cap is injected into `ClaudeCodeSummarizer`'s system prompt on every call
      (read fresh from `IConfigStore` inside `SummarizeCoreAsync`, mirroring the annotator's cap read).
- [ ] The system prompt instructs: bulleted markdown, grouped under subheadings, within ~N chars,
      model-chosen bullet count.
- [ ] Default 1000 / min 500 / max 5000, clamped both directions; a non-positive persisted value reads
      as the default (legacy/hand-edit safety), matching `ClampCapForRead` semantics.
- [ ] `PlaceholderPrSummarizer` returns a grouped, representative-length sample; the #410 inbox-enricher
      placeholder is unaffected.
- [ ] `PrSummary` carries the generation-time cap; the real summarizer stamps `ClampSummaryCharsForRead(raw)`
      — the same value the GET DTO projects (verified equal for a hand-edited sub-500 config).
- [ ] Changing the cap marks an already-open PR's summary "Out of date" and offers Regenerate (Live mode);
      regenerating clears it. Detection is precise — a summary already at the live cap is **not** stale, a
      `null` gen-cap (legacy) is never stale, and an unloaded `configuredMaxChars` (null) is never stale
      (no false-stale flicker during the preferences-load window).

## Plumbing (mirrors the #496 seams)

> Naming: the new clamps are `ClampSummaryChars` / `ClampSummaryCharsForRead` — feature-specific, following
> `ClampTimeout` (not the generically-named `ClampCap`). Same structure as #496; the descriptive name is
> deliberate.

| Layer | File | Change |
|-------|------|--------|
| Bounds | `PRism.Core/Config/AiConfigBounds.cs` | `MinSummaryChars=500`, `MaxSummaryChars=5000`, `DefaultSummaryChars=1000`; `ClampSummaryChars` (write, floor→Min), `ClampSummaryCharsForRead` (≤0→Default, else `Min(v,Max)`). |
| Config record | `PRism.Core/Config/AppConfig.cs` | `AiConfig` gains trailing `int SummaryMaxChars = 1000` (keeps positional ctors compiling; STJ-net10 honors the ctor default for a missing key). |
| Patch | `PRism.Core/Config/ConfigStore.cs` | allowlist `["ui.ai.summaryMaxChars"] = Int`; apply-switch arm clamps via `ClampSummaryChars`. |
| GET DTO | `PRism.Web/Endpoints/PreferencesDtos.cs` | `UiPreferencesDto` gains `int SummaryMaxChars`. |
| GET projection | `PRism.Web/Endpoints/PreferencesEndpoints.cs` | `BuildResponse` surfaces `ClampSummaryCharsForRead(...)`. |
| FE type | `frontend/src/api/types.ts` | `UiPreferences` gains `summaryMaxChars: number`. |
| FE patch | `frontend/src/contexts/PreferencesContext.tsx` | add `'ui.ai.summaryMaxChars'` to both key unions, `readKey`, `writeKey`. |
| FE UI | `frontend/src/components/Settings/panes/AiPane.tsx` | new `NumberStepper` row (label "Summary length", min 500/max 5000/step 100, unit "characters"). Help copy: **"500–5000 characters. Applies to newly generated summaries; use Regenerate to re-apply on an already-open PR."** Update the pane subtitle "AI mode, provider timeout, and annotation settings." → "AI mode, provider timeout, annotation, and summary settings." Mirror the bounds-comment. |
| Summarizer | `PRism.Web/Ai/ClaudeCodeSummarizer.cs` | inject `IConfigStore`; replace `const SystemPromptV1` with `BuildSystemPrompt(int maxChars)`; read `ClampSummaryCharsForRead(_configStore.Current.Ui.Ai.SummaryMaxChars)` fresh per call; pass to the `LlmRequest` **and** stamp it onto the result (`new PrSummary(body, category, cap)`). Egress allowlist + injection-defense lines preserved verbatim. |
| DI | `PRism.Web/Composition/ServiceCollectionExtensions.cs` | pass `sp.GetRequiredService<IConfigStore>()` to the summarizer ctor. |
| Placeholder | `PRism.AI.Placeholder/PlaceholderData.cs` + `PlaceholderPrSummarizer.cs` | new grouped-format constant for the summarizer; stamp `GeneratedMaxChars = DefaultSummaryChars`; `SummaryBody` (enricher) unchanged. |
| Contract | `PRism.AI.Contracts/Dtos/PrSummary.cs` | add trailing `int? GeneratedMaxChars = null` (additive; serializes as `generatedMaxChars`). Only `ClaudeCodeSummarizer` + `PlaceholderPrSummarizer` construct `PrSummary` (no Noop/parser site); the additive default keeps them compiling. |
| FE summary type | `frontend/src/api/types.ts` | `PrSummary` gains **optional** `generatedMaxChars?: number \| null` (optional so the ~20 existing `{ body, category }` test literals keep typechecking — mirrors the C# trailing-default; the `capChanged` null-guard already treats absent as not-stale). |
| FE staleness | `frontend/src/hooks/useAiSummary.ts` | new `configuredMaxChars` param; OR `capChanged` into `isStale` (null-guarded, self-clearing on regenerate); **do not add `configuredMaxChars` to the fetch-effect deps** (render-time compare only, not a refetch trigger). On-mount polite announce when `isStale`. |
| FE wiring | `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx` | pass `preferences?.ui.summaryMaxChars ?? null` into `useAiSummary` (null while preferences load). |

## Caching nuance (resolved by D6)

Summaries are cached per `(prRef, baseSha, headSha)`. Changing the cap does **not** invalidate the cache.
**Unlike the timeout** (invisible — a user never sees a per-PR before/after), the cap changes the *visible*
summary shape, so a reopened PR would otherwise show the byte-identical cached summary and read as a broken
control. **D6 resolves this**: the stamped gen-time cap lets the card detect the mismatch and surface
"Out of date" + Regenerate, and the AiPane help copy names Regenerate explicitly. Cache *invalidation* on
cap-change is still deliberately **not** added — the per-PR Regenerate offer is the chosen mechanism;
force-regenerating every open PR's summary on a settings change would be a costly, surprising re-spend.

Two edges, both **self-healing** (no special handling): (1) a cap change *during* an in-flight summarize
stamps the pre-change cap; the cached result is then detected as `capChanged` on next display and offers
Regenerate. (2) A server restart drops the in-memory cache; the next GET re-summarizes at the *current*
cap and stamps it, so nothing is ever falsely stale post-restart.

## Tests (mirror existing suites)

- `AiConfigBoundsTests` — clamp/read-clamp for the new bounds incl. the ≤0→Default corner.
- `ConfigStoreAiNumericPatchTests` — patch `ui.ai.summaryMaxChars` clamps write; missing key → ctor default.
- `PreferencesAiNumericTests` — POST clamps; GET surfaces read-clamped value.
- `ClaudeCodeSummarizerTests` — the system prompt sent to the provider **contains the configured cap**
  and the bulleted/subheading instruction; a stub `IConfigStore` drives the value (assert hot-read). Also
  assert the returned `PrSummary.GeneratedMaxChars` == the clamped configured cap.
- `useAiSummary` (FE) — `capChanged` staleness: a summary whose `generatedMaxChars` ≠ `configuredMaxChars`
  is `isStale`; a matching one is not; a `null` gen-cap is never stale; a **`null`/unloaded
  `configuredMaxChars` is never stale** (no false-stale flicker); Regenerate clears it.
- `PrSummary` serialization — `generatedMaxChars` round-trips on the wire and is `null`-safe (legacy).
- **Stamp == display:** assert the summarizer's stamped `GeneratedMaxChars` equals the GET DTO's projected
  `summaryMaxChars` for a hand-edited **sub-500** config (both route through `ClampSummaryCharsForRead`) —
  guards against the write-clamp regression that would pin a summary permanently stale.
- **Construction-site sweep:** adding a required `IConfigStore` ctor param breaks every direct
  `new ClaudeCodeSummarizer(...)`. Known sites: `ClaudeCodeSummarizerTests.cs` **and**
  `AiSummaryTestContext.cs` (the latter backs `AiSummaryGateTests`/`AiSummaryRegenerateTests`). Pass a
  stub `IConfigStore` (a `ConfigStore` over a `TempDataDir`, or one returning `AppConfig.Default`).
  `grep "new ClaudeCodeSummarizer("` to confirm no other site is missed.
- FE: `PreferencesContext.aiNumeric.test.tsx` (read/write round-trip) + `AiPane.test.tsx` (stepper renders,
  bounds, `set` called with `'ui.ai.summaryMaxChars'`).
- e2e: `ai-settings-tab.spec.ts` — the new control is present and mutable. (Visual baselines for the
  Settings page regenerate — AiPane gains a row.)

## Known limitations (best-effort, accepted)

- **Effectiveness unverified.** No AC asserts summaries actually get *shorter* — the summarizer test
  asserts the prompt *contains* the cap, not output length (an LLM-output-length assertion would be
  non-deterministic). Overflow may persist and is absorbed by the existing layout (D5). The existing
  `AiInteractionRecord.ResponseChars` already captures response length, so the nudge's real-world effect
  can be spot-checked post-rollout without new instrumentation.
- **Approximate budget.** The cap is a soft target over raw markdown (D2/D3); the model aims for it and
  may overshoot.
- **Multi-tab.** Two tabs on the same PR both show stale after a cap change; regenerating in tab A
  evicts+restamps the shared backend cache, but tab B keeps its old React state (old summary + old stamp)
  and stays stale until it refetches — there is no SSE for cap-change. Acceptable under the per-PR
  Regenerate model.

## Out of scope

Per-feature model/tool selection, prompt view/edit, per-feature toggles (later #485 phases). Server-side
truncation (D1). Dynamic cap-reactive Preview (D4).
