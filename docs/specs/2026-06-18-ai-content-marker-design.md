# Universal AI-content marker (`AiMarker`) — design

- **Issue:** #489 ([AI] Universal AI-content marker (sparkle icon) across all AI-generated surfaces)
- **Date:** 2026-06-18
- **Base branch:** `V2` (every v2/AI PR bases on `V2`, never `main`)
- **Tier / Risk:** T3 (cross-cutting design-system + AI work) · **gated B1** (`design`/`needs-design`; correctness is "looks right", a human must eyeball both themes)

## 1. Problem

PRism renders AI-generated content alongside real PR/GitHub data in several places, with **no consistent visual signal** for which is which. Worse, a sparkle `✨` glyph is *already* scattered across the app as raw emoji (Ask-AI pull-tab, Ask-AI drawer header, hunk annotations, stale-draft row) with no shared component, no shared sizing, and no accessibility contract. Emoji is itself the inconsistency: it is multicolour (ignores `--accent`, won't tint per theme) and **renders differently per OS**, which is a concrete baseline-flake risk because the Playwright visual baselines are platform-split (`linux/` vs `win32/`).

This slice ships **one shared, accessible, theme-stable AI marker** and applies it consistently to every surface where AI generates text — replacing every raw emoji with it.

## 2. Goals / Non-goals

**Goals**
- A single design-system component (`AiMarker`) as the one source of truth for the AI sparkle.
- Applied to every current AI **text** surface (provenance) and used as the AI **identity** glyph in AI nav/entry-points.
- Replace **every** existing raw `✨` emoji usage with the component.
- Theme-consistent (`currentColor`/`--accent`) and cross-platform pixel-stable (monochrome SVG).
- Always-on for AI content (truthfulness); no user toggle.

**Non-goals**
- No new backend; purely frontend.
- No change to `SampleBadge`'s behaviour or to the AI gating model.
- No settings toggle or icon-style picker (deferred to #485 if ever wanted).
- No marker on non-text AI signals (the file-tree focus dots from #492 stay as-is).
- Not de-duplicating the Preview-mode sparkle-vs-"Sample" overlap — #463 owns that.

## 3. Decisions (resolved in brainstorming)

1. **Relationship to `SampleBadge`: coexist / layered.** The sparkle signals **provenance** ("this is AI-generated"), always-on in both Preview and Live. `SampleBadge` remains a separate **data-quality** qualifier ("and this content is illustrative"), Preview-only. In Preview a content surface shows both; in Live it shows only the sparkle. They answer different questions, so layering is honest. Disposition of the overlap is #463's job, not this slice's.
2. **Glyph: the existing welcome-screen `SparkIcon`** (`frontend/src/pages/welcomeIcons.tsx:79`) — a monochrome 4-point sparkle SVG, `currentColor`, `aria-hidden`, 18×18 viewBox. Reused, not reinvented. Relocated to a shared module (§5).
3. **Placement: per-region, superscript, on text only.** The marker marks the *boundary of an AI region* (a card label, a tab, a chip, an annotation), not every item inside it. It is **not** placed on dot/colour-only signals (file-tree focus dots). Rendered as a small superscript adjacent to a text boundary, or as an inline glyph in a button/nav slot.
4. **Two roles, one glyph.** *Provenance* (labelled "AI-generated") on generated content; *identity* (decorative, no label) on AI nav/entry-points where adjacent text already says "AI." The component supports both.
5. **Scope: migrate everywhere.** All existing raw `✨` emoji usages are swapped to the component in this slice.
6. **Configurability: always-on, no toggle.** A truthfulness signal must not be user-hideable; a style picker is gold-plating.

## 4. Component API

New pure-presentational component `frontend/src/components/Ai/AiMarker.tsx` + `AiMarker.module.css`.

```tsx
export interface AiMarkerProps {
  /** Visual geometry. 'superscript' (default) sits raised beside a text label;
   *  'inline' is a normal-baseline glyph for buttons / nav / headers. */
  variant?: 'superscript' | 'inline';
  /** Identity use (default false = provenance). When true, the marker is purely
   *  decorative: no screen-reader label and no tooltip, because adjacent visible
   *  text ("AI", "AI Settings") already conveys it. */
  decorative?: boolean;
  /** Optional extra class for spacing at a specific call site. */
  className?: string;
}
```

Rendering:
- **Provenance** (`decorative` falsy): a wrapper `<span>` containing the decorative `SparkIcon` (`aria-hidden`) **plus** a visually-hidden `<span class="sr-only">AI-generated</span>`, with `title="AI-generated"` on the wrapper for a sighted-user hover tooltip. Carries `data-ai-marker=""` and `data-testid="ai-marker"`.
- **Identity** (`decorative` true): just the wrapper + `SparkIcon`, `aria-hidden`, no sr-only text, no tooltip.

**No hooks inside `AiMarker`.** Unlike `SampleBadge` (which self-checks `useIsSampleMode()`), `AiMarker` does not gate itself. Every host surface already renders only under its own AI gate (`useAiGate(...)` / mode checks), so the marker inherits that gating by being mounted there. This keeps the component trivially pure and testable, and avoids a second, drifting copy of the gating logic.

## 5. Glyph relocation

`SparkIcon` currently lives in `frontend/src/pages/welcomeIcons.tsx` alongside `LockIcon`/`PanelsIcon` (page-local benefit-row icons). Move **`SparkIcon` only** to the shared `frontend/src/components/Ai/` module (e.g. `SparkIcon.tsx`), and have `welcomeIcons.tsx` re-import/re-export it so `/welcome` is visually unchanged. `LockIcon`/`PanelsIcon` stay put (page-local, not AI). The icon is `currentColor` + viewBox-scaled, so the consuming wrapper controls colour and size — the same source serves both the 18×18 welcome row and the ~11–12px superscript.

## 6. Per-surface integration

| # | Surface | File (current) | Variant / role | a11y |
|---|---|---|---|---|
| 1 | AI Summary card label ("AI Summary") | `components/PrDetail/OverviewTab/AiSummaryCard.tsx` | superscript / provenance | sr-only "AI-generated" |
| 2 | Hotspots tab — single marker at the tab/region boundary (not per row) | `components/PrDetail/HotspotsTab/HotspotsTab.tsx` | superscript / provenance | sr-only "AI-generated" |
| 3 | Hunk annotation — **replaces** the raw `✨`; keeps the existing visible "AI" text label | `components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx` | inline / **decorative** | adjacent "AI" text |
| 4 | Inbox AI category chip — **replaces** the literal "AI" text in `.chipMarker` | `components/Inbox/InboxRow.tsx` | superscript / provenance | sr-only "AI-generated" |
| 5 | AI Settings tab label | `/settings/ai` pane / `Settings` nav (from #496) | inline / **decorative** | tab text says "AI" |
| 6 | Ask-AI pull-tab — **replaces** the raw `✨` | `AskAiPullTab.tsx` | inline / **decorative** | adjacent "Ask AI" label |
| 7 | Ask-AI drawer header — **replaces** the raw `✨` | `AskAiDrawer.tsx` | inline / **decorative** | adjacent header text |
| 8 | Stale-draft suggestion row — **replaces** the raw `✨` | `StaleDraftRow.tsx` | inline / **decorative** | adjacent label |
| — | File-tree focus dots (#492) | `components/PrDetail/FilesTab/FileTree.tsx` | **untouched** | dot is the signal |

**Placement rule:** where a visible "AI" / "AI Summary" / "AI Settings" word already sits beside the glyph → `decorative` (avoid a redundant "AI-generated" announcement); where the sparkle stands alone (the chip, which replaces the only "AI" word; the summary/hotspots labels) → labelled provenance.

**Inbox-chip note:** the chip renders **today only in Preview** (placeholder enricher data; `inboxEnrichment` is not in `LIVE_CAPABILITIES` and has no real impl yet — #410). Per owner decision, we mark it in Preview now anyway — the marker lives in `InboxRow` and will already be in place when #410 lights up Live. No wait on #410.

## 7. Coexistence with `SampleBadge` (no change)

`SampleBadge` keeps self-gating on `useIsSampleMode()` and its current mounts (AiSummaryCard, AiHunkAnnotation `solid`). The new marker is mounted independently. Net effect in Preview: a content surface shows the sparkle (always) **and** the "Sample" pill (Preview only). This redundancy is intentional and acknowledged; reconciling it is #463's scope.

## 8. Theming & visual (B1)

- Colour from `currentColor`/`--accent`; accent tokens are theme-symmetric (no per-theme override needed, unlike surface tokens per #347), but **both themes are mocked from real tokens before hardening** (B1 requirement).
- `superscript`: ~11–12px, `vertical-align` raised, sits flush against the trailing/leading edge of its text label.
- `inline`: ~16–18px glyph; identity slots may reuse the existing global `.ai-icon` box styling.
- **Visual gate:** the B1 human assert happens after green-and-ready (per the issue-resolution workflow). Affected Playwright baselines to regenerate: `pr-detail-overview`, `pr-detail-files-diff`, `pr-detail-drafts`, `ask-ai-drawer`, `inbox` (Preview), and the settings AI pane. **`pr-detail-files-tree` is NOT affected** (no marker there). Linux baselines regen from the CI `e2e-results` artifact (exact render); win32 via local `--update-snapshots`.

## 9. Testing

- Co-located `AiMarker.test.tsx`: renders the sparkle; provenance variant exposes the sr-only "AI-generated" + `title`; `decorative` variant has neither; `superscript`/`inline` apply the right class; `data-testid="ai-marker"` present.
- `SparkIcon` relocation: a render test that it still mounts from the shared path; `/welcome` benefit-row test unaffected.
- Update each migrated surface's existing test to assert the marker is present (and that the old emoji is gone, where applicable). Surfaces that stub `SampleBadge` keep doing so; add the analogous `AiMarker` handling where a test needs it.
- **Both test trees:** co-located `src/**/*.test.tsx` **and** the legacy `frontend/__tests__/` mirror must be updated where a mirror exists. A change that touches only one leaves the other stale.
- Type + build: run `npm run build` / `tsc -b` after the shared-component move (test run strips types).

## 10. Forward-compounding: future AI-text surfaces

Several AI surfaces we discussed are **not yet built**. When each is picked up it must render its AI-generated **text** behind the shared `AiMarker`. A pointer comment will be posted on each so the wiring isn't forgotten:

- **#411** composer assistant ("Refine with AI") output
- **#409 / #410** inbox ranker / enricher (the Live category chip; the marker is already wired into `InboxRow`, so #410 inherits it — note kept for confirmation)
- **#415 / #416** draft reconciliation / draft suggester output
- **#420** per-hunk risk scores (if surfaced as text/label, not a bare number/dot)

(Dot/numeric-only signals do not get the marker, per Decision 3.)

## 11. Acceptance criteria

- [ ] `AiMarker` component exists with the API in §4; pure (no hooks); provenance vs decorative a11y verified by tests.
- [ ] `SparkIcon` relocated to the shared module; `/welcome` visually unchanged.
- [ ] All 8 surfaces in §6 render the shared marker as specified; the file-tree is untouched.
- [ ] **Zero** raw `✨` emoji remain in `frontend/src` (grep-clean), all replaced by the component.
- [ ] `SampleBadge` behaviour unchanged; Preview shows both signals.
- [ ] Always-on: no settings toggle introduced.
- [ ] Both themes mocked from real tokens; affected baselines regenerated (`files-tree` excluded); B1 human visual assert obtained.
- [ ] FE lint/build/test green in both test trees; full pre-push checklist passes.
- [ ] Pointer comments posted on #411/#409/#410/#415/#416/#420.

## 12. Risks / deferrals

- **Preview visual redundancy** (sparkle + "Sample" pill on the same surface). Accepted; #463 owns reconciliation.
- **Baseline churn** across several screenshots. Mitigated by the exact-regen-from-artifact workflow; `files-tree` explicitly excluded.
- **Superscript metrics** (alignment against varying label sizes) is the main visual-fidelity risk → resolved at the B1 mock/assert, both themes.
- **Inbox chip is Preview-only today.** Marking it now is intentional and future-proof; not blocked on #410.
