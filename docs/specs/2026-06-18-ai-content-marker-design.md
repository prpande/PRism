# Universal AI-content marker (`AiMarker`) — design

- **Issue:** #489 ([AI] Universal AI-content marker (sparkle icon) across all AI-generated surfaces)
- **Date:** 2026-06-18
- **Base branch:** `V2` (every v2/AI PR bases on `V2`, never `main`)
- **Tier / Risk:** T3 (cross-cutting design-system + AI work) · **gated B1** (`design`/`needs-design`; correctness is "looks right", a human must eyeball both themes)

## 1. Problem

PRism renders AI-generated content alongside real PR/GitHub data in several places, with **no consistent visual signal** for which is which. Worse, a sparkle `✨` glyph is *already* scattered across the app as raw emoji (Ask-AI pull-tab, Ask-AI drawer ×3, hunk annotations, stale-draft row — 6 occurrences in 4 files) with no shared component, no shared sizing, and no accessibility contract. Emoji is itself the inconsistency: it is multicolour (ignores `--accent`, won't tint per theme) and **renders differently per OS**, which is a concrete baseline-flake risk because the Playwright visual baselines are platform-split (`linux/` vs `win32/`).

This slice ships **one shared, accessible, theme-stable AI marker** and applies it to every surface where AI generates text — replacing every raw sparkle emoji with it and adding the marker on AI surfaces that have no glyph today.

## 2. Goals / Non-goals

**Goals**
- A single design-system component (`AiMarker`) as the one source of truth for the AI sparkle.
- **Two kinds of work, both in scope:** (a) *migrate* — replace every existing raw `✨` emoji with the component; (b) *add* — place the marker on AI-text/identity surfaces that have no glyph today (AI summary, Hotspots, AI settings tab).
- Provenance marking on genuinely AI-generated **text**; identity marking on AI nav/entry-points.
- Theme-consistent (`currentColor`/`--accent`) and cross-platform pixel-stable (monochrome SVG, static — no animation).
- Always-on for AI content (truthfulness); no user toggle.

**Non-goals**
- No new backend; purely frontend.
- No change to `SampleBadge`'s behaviour or to the AI gating model.
- No settings toggle or icon-style picker (deferred to #485 if ever wanted).
- No marker on non-text AI signals (the file-tree focus dots from #492 stay as-is).
- **Non-`✨` emoji are out of scope** (`✕`, `⌘ ⏎`, etc. are not AI markers and are untouched). The grep gate (§11) is scoped to `✨` in `frontend/src` deliberately.
- Not de-duplicating the Preview-mode sparkle-vs-"Sample" overlap — #463 owns that.

## 3. Decisions (resolved in brainstorming + doc-review)

1. **Relationship to `SampleBadge`: coexist / layered.** The sparkle signals **provenance** ("this is AI-generated"), always-on wherever real AI content renders. `SampleBadge` remains a separate **data-quality** qualifier ("and this content is illustrative"), Preview-only. They answer different questions, so layering is honest. Disposition of the overlap is #463's job. To keep the layered pair legible, the sparkle and the "Sample" pill are **co-located as one adjacent cluster** so Preview reads as a single "AI · illustrative" unit rather than two competing badges.
2. **Glyph: the existing welcome-screen `SparkIcon`** (`frontend/src/pages/welcomeIcons.tsx`) — a monochrome 4-point sparkle SVG, `currentColor`. Reused, not reinvented. Relocated to a shared module and made size-overridable (§5).
3. **Placement granularity: mark each standalone AI artifact; mark grouped/streamed AI regions once at their boundary.** A standalone AI artifact (a summary, a hunk annotation) gets one provenance marker. A *grouped AI region* — the Hotspots ranked list, or the Ask-AI chat transcript — is marked **once at its boundary/header**, not once per row or per reply; per-item marking inside such a region is noise (owner call: per-reply chat provenance is overkill). The marker is **never** placed on dot/colour-only signals (file-tree focus dots).
4. **Two roles, one glyph.** *Provenance* (labelled "AI-generated") on generated content; *identity* (decorative, no label) on AI nav/entry-points where adjacent text already says "AI." The same visible glyph deliberately serves both — this is an intentional **recognition** tradeoff (one learnable AI mark everywhere), accepted with eyes open even though sighted users can't distinguish the two roles (the distinction lives only in the a11y layer).
5. **Scope: migrate every `✨` AND add markers to the un-glyphed AI surfaces** (§6). All six raw `✨` occurrences are swapped to the component in this slice.
6. **Configurability: always-on, no toggle.** A truthfulness signal must not be user-hideable; a style picker is gold-plating.
7. **Provenance attaches to present AI content, not to "the AI feature is on."** The marker is placed on the success-content boundary — never on app-authored loading skeletons or error copy, and never on a surface that only ever shows placeholder data (see §4 and the inbox-chip decision in §6).

## 4. Component API

A new pure-presentational component `frontend/src/components/Ai/AiMarker.tsx` + `AiMarker.module.css`.

```tsx
export interface AiMarkerProps {
  /** Visual geometry. 'superscript' (default) sits raised beside a text label;
   *  'inline' is a normal-baseline glyph for buttons / nav / headers. */
  variant?: 'superscript' | 'inline';
  /** Identity use (default false = provenance). When true, the marker is purely
   *  decorative: no screen-reader label, because adjacent visible text
   *  ("AI", "AI Settings") already conveys it. */
  decorative?: boolean;
  /** Optional extra class for spacing at a specific call site. */
  className?: string;
}
```

Rendering:
- **Provenance** (`decorative` falsy): a wrapper `<span>` containing the decorative `SparkIcon` (`aria-hidden`) **plus** a visually-hidden `<span class="sr-only">{AI_PROVENANCE_LABEL}</span>`. **No `title` attribute** — a native `title` can double-announce with the sr-only text in some screen readers, and a hover-only tooltip is no help to keyboard/touch users; the sr-only text serves AT and the adjacent visible content serves sighted users.
- **Identity** (`decorative` true): just the wrapper + `SparkIcon`, `aria-hidden`, no sr-only text.
- **Both variants** carry `data-ai-marker=""` and `data-testid="ai-marker"` (the only rendering difference between them is the sr-only span).
- The accessible string is a single shared constant `AI_PROVENANCE_LABEL = 'AI-generated'` (in a shared a11y-strings module), referenced everywhere, so a future rename touches one place.

**The marker is non-interactive** — not focusable, no tab stop, no tooltip. Provenance is exposed via the sr-only text; there is no keyboard/touch affordance to design.

**No hooks inside `AiMarker`.** Unlike `SampleBadge` (which self-checks `useIsSampleMode()`), `AiMarker` does not gate itself — but the host is responsible for mounting it **only where real AI content is present** (Decision 7), i.e. after a surface's loading/error/empty early-returns, never on app-authored fallback copy. "AI feature enabled" ≠ "AI content present"; the host must mount the marker on the success branch.

**Animation:** the marker is **static** (no pulse/shimmer). If animation is ever added later it must be gated behind `prefers-reduced-motion: no-preference`.

## 5. Glyph relocation

`SparkIcon` currently lives in `frontend/src/pages/welcomeIcons.tsx` alongside `LockIcon`/`PanelsIcon` (page-local benefit-row icons) and hard-codes `width/height = 18` via `SVG_PROPS`. Move **`SparkIcon` only** to the shared `frontend/src/components/Ai/` module (e.g. `SparkIcon.tsx`), have `welcomeIcons.tsx` re-import/re-export it so `/welcome` is visually unchanged, and **make its size overridable** (accept a `size`/`className` or drop the fixed `width/height` so a CSS rule / `em`-based sizing can scale it). The fixed 18px attributes resist the ~11–12px superscript size otherwise. `LockIcon`/`PanelsIcon` stay put (page-local, not AI).

## 6. Per-surface integration

"Kind" = **R** (replace an existing `✨`) or **A** (additive — no glyph today).

| # | Surface | File | Kind | Variant / role | a11y |
|---|---|---|---|---|---|
| 1 | AI Summary card — add a visible "AI Summary" label (wire up the currently-unused `.aiSummaryLabel` class), marker beside it | `components/PrDetail/OverviewTab/AiSummaryCard.tsx` | **A** | superscript / **decorative** | visible "AI Summary" text announces it |
| 2 | Hotspots **tab label** in the sub-tab strip (the bar where you switch Overview/Files/Hotspots/Drafts) — superscript sparkle **after the "Hotspots" text** (owner B1 decision: on the tab itself, not in the tab body) | `components/PrDetail/PrSubTabStrip.tsx` | **A** | superscript / **decorative** | tab announces "Hotspots, …"; sparkle is a visual AI cue (the Hotspots tab is AI-gated via `showHotspots`/fileFocus, so the marker shows only when the AI tab shows) |
| 3 | Hunk annotation — replaces the raw `✨`; keeps the existing visible "AI" text label | `components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx` | **R** | inline / **decorative** | adjacent "AI" text |
| 4 | Inbox AI category chip — icon **replaces** the literal "AI" text in `.chipMarker` | `components/Inbox/InboxRow.tsx` | **R** | inline / **decorative** (visual) | provenance via the **row `aria-label`** — see note (owner override + caveat) |
| 5 | AI Settings tab label | `/settings/ai` pane / `Settings` nav (from #496) | **A** | inline / **decorative** | tab text says "AI" |
| 6 | Ask-AI pull-tab — replaces the raw `✨` | `components/AskAiDrawer/AskAiPullTab.tsx` | **R** | inline / **decorative** | adjacent "Ask AI" label |
| 7a | Ask-AI drawer **header** (line 87) — replaces the raw `✨` | `components/AskAiDrawer/AskAiDrawer.tsx` | **R** | inline / **decorative** | adjacent header text |
| 7b | Ask-AI drawer **per-AI-message** glyph (line 112) — replaces the raw `✨` | `components/AskAiDrawer/AskAiDrawer.tsx` | **R** | inline / **decorative** | drawer is one AI region; the header (7a) marks it — per-reply provenance is overkill (owner call) |
| 7c | Ask-AI drawer **typing indicator** (line 121) — replaces the raw `✨` | `components/AskAiDrawer/AskAiDrawer.tsx` | **R** | inline / **decorative** | no generated text yet |
| 8 | Stale-draft suggestion row — replaces the raw `✨` | `components/PrDetail/Reconciliation/StaleDraftRow.tsx` | **R** | inline / **decorative** | adjacent label |
| — | File-tree focus dots (#492) | `components/PrDetail/FilesTab/FileTree.tsx` | — | **untouched** | dot is the signal |

**Placement rule (governed by available space + how AI is announced):**
- **Trailing a text label** → **superscript decorative**: the "AI Summary" heading and the **Hotspots tab label** carry a small raised sparkle after the text. The adjacent text ("AI Summary", "Hotspots") is the visible anchor; the sparkle is a visual AI cue.
- **Beside a visible "AI…" word** → **inline decorative**: hunk annotation, stale-draft, AI Settings tab, the Ask-AI surfaces. The visible "AI" word announces AI; an sr-only label would double-announce.
- **Inbox chip** (compact, no text room) → **inline decorative** (visual only) **plus** "AI-generated" composed into the **row `aria-label`**. The chip lives inside a `<button>` whose `aria-label` overrides descendant text, so an sr-only span on the marker would be swallowed — the aria-label is the working AT channel.

So the **inbox chip** is the one surface that announces AI to AT via a dedicated channel (row aria-label); every other surface is decorative beside/after visible text. The Ask-AI chat drawer is one AI region marked once at its header (Decision 3); its per-message/typing glyphs are decorative. **The provenance variant (sr-only on the marker) has no current consumer but is retained + unit-tested** for the future AI-text surfaces in §10 (composer output, etc.) that render generated text with no adjacent label. **a11y note (Hotspots tab):** the tab marker is decorative, so screen readers hear just "Hotspots"; if an audible AI cue is wanted there, switch to a labelled variant — deferred unless the owner asks.

**Surface #1 (AI Summary) details:** the card renders no "AI Summary" text today, only `SampleBadge` → optional Live status head → optional category chip → body, with error/loading branches *before* `if (!summary) return null`. Add a visible "AI Summary" label (wiring the unused `.aiSummaryLabel` class) with a decorative superscript marker beside it, in the **success branch** (after that early-return — never on the loading/error copy). Placement must respect the existing `.aiSummaryCard [data-sample-badge] + *` margin selector (§7) — don't make the label/marker the unintended `+ *` target.

**Surface #4 (inbox chip) — provenance (owner decision, overriding the earlier truthfulness reservation).** The chip has no room for a text label, so the icon replaces the literal "AI" text and the sr-only "AI-generated" is the only AI announcement. Two caveats the implementer must handle: (1) the chip renders **today only in Preview** with placeholder data (`inboxEnrichment` off in Live until #410) — the owner accepts marking it now regardless (the adjacent `SampleBadge` "Sample" pill still qualifies it as illustrative for sighted users); (2) the existing `.chipMarker` is deliberately `aria-hidden` and an in-code comment notes the row is a `<button>` whose `aria-label` omits descendants ("the button swallows descendant labels"). The implementer **must verify the sr-only "AI-generated" actually reaches AT** (e.g. via a test asserting it in the row's accessible name); if the button swallows it, compose "AI-generated" into the row's `aria-label` instead of relying on a descendant sr-only span.

## 7. Coexistence with `SampleBadge` (no behavioural change)

`SampleBadge` keeps self-gating on `useIsSampleMode()` and its current mounts (AiSummaryCard, AiHunkAnnotation `solid`). The new marker is mounted independently. Net effect in Preview: a content surface shows the sparkle (always) **and** the "Sample" pill (Preview only), co-located as one cluster (Decision 1). Reconciling the redundancy is #463's scope.

**CSS coupling to mind:** `AiSummaryCard.module.css` has a live `.aiSummaryCard [data-sample-badge] + *` margin rule. In Preview, `SampleBadge` renders, so whatever element sits immediately after it inherits that margin. The marker/label placement on surface #1 must not silently become that `+ *` target (the file already documents this constraint in-code); either place the label so the existing target is preserved or update the selector deliberately.

## 8. Theming & visual (B1)

- Colour from `currentColor`/`--accent`; accent tokens are theme-symmetric, but **both themes are mocked from real tokens before hardening** (B1 requirement). Verify the glyph clears WCAG AA non-text contrast (≥3:1) against the surfaces it sits on in **both** themes.
- `superscript`: ~11–12px, raised, against the trailing edge of its text label. **Used only on the "AI Summary" heading.** Icon-only markers (inbox chip, Hotspots tab) are **inline**, not superscript — a raised glyph inside the chip's `overflow:hidden` pill would be clipped at the top edge (the #492 long-name-hiding-the-dot trap). Give `.aiSummaryLabel` a flex baseline context so the superscript aligns predictably.
- `inline`: ~16–18px glyph. The existing global `.ai-icon` slot wraps emoji in a tinted rounded box — a monochrome SVG may need that box's background/border-radius dropped or adjusted, so reusing `.ai-icon` is a starting point, not a guarantee; verify per identity site.
- **Visual gate:** the B1 human assert happens after green-and-ready. Affected Playwright baselines to regenerate: `pr-detail-overview`, `pr-detail-hotspots`, `pr-detail-files-diff`, `pr-detail-drafts`, `ask-ai-drawer`, `inbox` (Preview), and the settings AI pane. **`pr-detail-files-tree` is NOT affected.** Linux baselines regen from the CI `e2e-results` artifact (exact render); win32 via local `--update-snapshots`.

## 9. Testing

- Co-located `AiMarker.test.tsx`: sparkle renders; provenance variant exposes the sr-only `AI_PROVENANCE_LABEL` (and **no** `title`); `decorative` variant has neither sr-only nor title; both variants carry `data-testid="ai-marker"`; `superscript`/`inline` apply the right class.
- `SparkIcon` relocation: renders from the shared path and accepts a size override; `/welcome` benefit-row test unaffected.
- Update each migrated surface's test to assert the marker is present and the old emoji is gone. For the AI-summary surface, assert the marker mounts on the **success** branch only (absent in loading/error renders).
- **Both test trees:** co-located `src/**/*.test.tsx` **and** the legacy `frontend/__tests__/` mirror where a mirror exists.
- Type + build: run `npm run build` / `tsc -b` after the shared-component move (test run strips types).

## 10. Forward-compounding: future AI-text surfaces

Several AI surfaces we discussed are **not yet built**. When each is picked up it must render its AI-generated **text** behind the shared `AiMarker`. Pointer comments will be posted on each (this is a *before-closing follow-up task*, not an implementation acceptance criterion — see §11):

- **#411** composer assistant ("Refine with AI") output
- **#409 / #410** inbox ranker / enricher (the Live category chip; the marker is already wired into `InboxRow`, so #410 inherits it — note kept for confirmation)
- **#415 / #416** draft reconciliation / draft suggester output
- **#420** per-hunk risk scores (only if surfaced as text/label, not a bare number/dot)

(Dot/numeric-only signals do not get the marker, per Decision 3.)

**Durability of the zero-emoji invariant (in scope — owner pulled in):** pointer comments are reminders, not enforcement — a future surface could ship raw-emoji text and silently erode the marker invariant with no test/lint catching it. This slice adds a lightweight ESLint `no-restricted-syntax` (or equivalent) rule banning the literal `✨` in `frontend/src`, with a clear message pointing at `AiMarker`, so "single source of truth" is durable. The rule must land green (it presupposes the grep-clean migration is complete).

## 11. Acceptance criteria

- [ ] `AiMarker` component exists with the API in §4; pure (no hooks); non-interactive; provenance vs decorative a11y (sr-only present/absent, no `title`) verified by tests.
- [ ] `SparkIcon` relocated to the shared module and size-overridable; `/welcome` visually unchanged.
- [ ] All surfaces in §6 render the shared marker as specified (rows 1, 2, 5 additive; 3, 4, 6, 7a–c, 8 replacements); the file-tree is untouched.
- [ ] AI-summary marker mounts on the success branch only — absent on the loading skeleton and error copy.
- [ ] The **Hotspots tab label** (sub-tab strip) carries a superscript decorative marker after "Hotspots"; it is **not** in the tab body; it shows only when the AI-gated Hotspots tab shows. A tab-strip test asserts the Hotspots tab has the marker and the other tabs don't.
- [ ] The **inbox chip** announces AI via the row `aria-label` ("AI-generated" composed in when the chip shows); a test asserts it reaches the accessible name. Every other surface is decorative beside/after visible text. The provenance (sr-only) variant is unit-tested but has no current surface consumer.
- [ ] **Zero** raw `✨` emoji remain in `frontend/src` (grep-clean) — all six occurrences replaced. Non-`✨` glyphs are intentionally untouched.
- [ ] An ESLint rule bans the literal `✨` in `frontend/src` (message points at `AiMarker`) and passes green.
- [ ] `SampleBadge` behaviour unchanged; in Preview the sparkle + "Sample" pill render as one co-located cluster.
- [ ] Always-on: no settings toggle introduced.
- [ ] Both themes mocked from real tokens; affected baselines regenerated (incl. `pr-detail-hotspots`; `files-tree` excluded); B1 human visual assert obtained.
- [ ] FE lint/build/test green in both test trees; full pre-push checklist passes.

**Before-closing follow-up (not a merge gate):** pointer comments posted on #411/#409/#410/#415/#416/#420.

## 12. Risks / deferrals

- **Preview visual redundancy** (sparkle + "Sample" pill). Accepted; co-located per Decision 1; #463 owns reconciliation. The stacked layout is validated at the B1 assert.
- **Two-roles-one-glyph** is visually indistinguishable to sighted users and correctness is partly unobservable (only an SR audit catches a wrong variant). Accepted as the recognition tradeoff (Decision 4); the named constant + per-surface table + tests reduce drift.
- **Additive labels (#1, #2)** change layout/baselines and need the B1 eyeball; the exact label position is a B1 decision within the constraints in §6/§7.
- **`.ai-icon` box vs monochrome SVG** — the inline identity sites may need the tinted box adjusted; verify per site at B1.
- **Baseline churn** across several screenshots. Mitigated by exact-regen-from-artifact; `files-tree` excluded.
