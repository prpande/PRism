# Diff-view comment typography parity with Overview (#522 + #564 symptom)

**Date:** 2026-06-20
**Issues:** [#522](https://github.com/prpande/PRism/issues/522) (comment bodies wrap early / wasted space), plus the aesthetic ask: make Files-tab inline comments render as polished as the Overview tab. Root-cause boundary tracked separately in [#564](https://github.com/prpande/PRism/issues/564).
**Status:** Design — approved (Approach A), pending written-spec review.

## Problem

Inline review comments in the **Files / diff view** read as "out of place" versus the same comments on the **Overview tab**, in two compounding ways:

1. **Monospace prose (the dominant cause).** The diff renders as a real `<table>`, and `.diffTable` sets `font-family: var(--font-mono)` (`DiffPane.module.css:79`). Inline comments render through `ExistingCommentWidget → CommentCard → MarkdownRenderer` inside a full-colspan `<tr>` in that table. `CommentCard`'s `.body` and the global `.markdown-body` never reset `font-family`, so **the comment's markdown prose inherits monospace**. The identical card on Overview (outside the table) renders in the sans body font — hence "the Overview md render is much prettier." (`AiHunkAnnotation` already resets `font-family: var(--font-sans)` ad-hoc to escape this same cascade — precedent that the leak is real.)

2. **Cramped, unbounded box (#522).** The diff card uses `density="compact"` (tighter padding, lighter shadow) and stretches to the full width of the diff pane with no reading-width measure. Combined with `white-space: pre-wrap`, a comment authored with fixed-column (~65-char) wrapping renders those source newlines as hard breaks, leaving a large empty band on the right and extra vertical height. Overview reads well because it is a **bounded, comfortably-padded reading column** (`.overviewGrid { max-width: 920px }`, `density="comfortable"`).

Both surfaces use the **same `CommentCard` + `MarkdownRenderer`**; the only deltas are font cascade context, density, and width.

## Goal

Make Files-tab inline comments visually match Overview comments: sans body font, comfortable padding/shadow, and a bounded reading-width column — resolving #522's wasted space without losing GitHub-parity on authored line breaks.

## Non-goals

- The **systemic** diff-table cascade fix (scoping mono to code cells so no component needs a defensive reset) is **out of scope** — tracked in #564. This spec applies the **local** reset on the comment card only.
- Reflowing prose / dropping `white-space: pre-wrap`. Decided: **preserve authored breaks** (GitHub-parity) and bound the measure instead.
- Any change to code-cell diff rendering, the #135 content-scale control, or the #554 gutter sizing.

## Design (Approach A — full comfortable parity + bounded measure)

Three changes. The **sans reset** and the **bounded measure** live on a diff-context wrapper inside `ExistingCommentWidget` (the diff is the only place that needs them — Overview must not change). The **density flip** is a prop change. This mirrors the existing `AiHunkAnnotation` precedent of a diff-scoped sans root (`AiHunkAnnotation.module.css:20`).

### 1. Escape the mono cascade (diff-context sans root)
In `ExistingCommentWidget.module.css`, set `font-family: var(--font-sans)` on the inline-comment wrapper (`.commentWidget` — the outer container around all threads). The whole inline-comment subtree (cards, band, body, reply affordance/composer) then renders in the sans body font, escaping `.diffTable`'s `var(--font-mono)`. This is the dominant fix for the "prettier" gap, and it also gives the `ch` measure (change 3) a **sans** context so `1ch` resolves to a sans character, not a mono one.

Code stays monospace via the **global** `code, pre, .mono { font-family: var(--font-mono) }` rule (`tokens.css:393`, a direct element-rule that beats inherited sans regardless of specificity) plus the inline-code chip rule `.body code` (`CommentCard.module.css:78`). No change needed there.

> Why the wrapper, not bare `.card`: a `max-width` on `.card` would also narrow Overview (70ch ≈ 500px sits under Overview's 920px grid — see change 3), and the reply composer/affordance are **siblings** of the cards inside the thread (`ExistingCommentWidget.tsx:140-175`), not children of `.card` — so a card-level reset/measure would leave them mono and full-width, misaligned under the bounded cards. Scoping both to the diff wrapper keeps Overview byte-identical and bounds the whole column uniformly. The systemic "no component needs a defensive reset" fix is #564; this is the diff-local version and does **not** block #564.

### 2. Full comfortable parity (density)
`ExistingCommentWidget` switches **both** `CommentCard`s (real, `:118`, and optimistic, `:135`) from `density="compact"` to `density="comfortable"`, so padding (`--s-3`/`--s-4`), band padding, and shadow (`--shadow-2`) match Overview. Three compact-gated behaviors change with the flip and must be handled explicitly (not silently dropped):

- **Avatar `sm`→`md`** (`CommentCard.tsx:44` switches on density). This is **intended** parity — Overview uses `md`. Called out so it's expected in screenshot review, not flagged as a regression.
- **`.body img { max-width: 100% }`** is currently compact-only (`CommentCard.module.css:64-66`) and would be lost. Move it to a density-independent global `.markdown-body img { max-width: 100% }` (`tokens.css`) so wide images can't blow out the column in any context.
- **`overflow-x: auto` on `.body`** is currently compact-only. Make it **unconditional** on the base `.body` rule so wide code/tables still scroll inside the card under comfortable density. `auto` only shows a scrollbar on actual overflow, so it is inert on Overview when content fits — verify in the Overview regression pass.

### 3. Bounded reading-width measure (#522)
On the same diff-context wrapper (change 1), add `max-width: calc(70ch * var(--content-scale))`, left-anchored:

- **70ch**, reusing the prose measure already in the codebase (`PrHeader.module.css:27`) rather than inventing a new literal — within the 45–90ch readable range.
- **`* var(--content-scale)`** so the column tracks the #135 content-scale control. A bare `ch` cap is anchored to the unscaled element `font-size`, but the markdown text is scaled by `--content-scale` (`.markdown-body`, `tokens.css:420`); at `xl` (1.4) a fixed cap would wrap at an effective ~50ch — too tight. Scaling the cap keeps the character measure constant across scales. Matches how `AiHunkAnnotation.module.css:21` expresses scale-aware sizing.
- Bounding the **wrapper** (not each card) means the stacked cards, the reply affordance (`width:100%`), and the composer all share one column and stay aligned — fixing #522's empty band without the composer-wider-than-cards misalignment a card-level cap would cause.
- The cap is an **upper** bound: in a narrow split-view pane the wrapper simply takes the available width. `white-space: pre-wrap` stays, so intentional breaks survive (GitHub-parity); the fixed-column comment's right gap collapses to a normal ragged edge. Trade-off: a narrower column means wide code fences scroll-in-card sooner than at full pane width — acceptable per #522's goal, confirmed in live validation.

## Components & boundaries

- **`ExistingCommentWidget.module.css`** — the diff-context home for both the sans reset and the bounded `calc(70ch * var(--content-scale))` measure on `.commentWidget`. Diff-only by construction, so Overview is untouched.
- **`ExistingCommentWidget.tsx`** — flips `density="compact"` → `"comfortable"` on both the real and optimistic `CommentCard`s.
- **`CommentCard.module.css`** — make `overflow-x: auto` on `.body` unconditional (was compact-only); remove the compact-only `.body img` rule (moved to global). Keep `.body code` mono.
- **`tokens.css`** — add `.markdown-body img { max-width: 100% }` (density-independent image cap).
- **`CommentCard.tsx`** — no logic change; density is already a prop.
- **No backend / no wire change.**

## Open questions (resolve in planning/implementation)

- **O3 — exact `ch` value.** 70ch is the starting target (reused from `PrHeader`); finalize against live screenshots (both themes, Unified + Split) during the live-validation pass before the PR is opened. O1 (overflow-x retention) and O2 (where the reset/measure live) are now resolved in the Design above.

## Testing & verification

- **Unit (vitest):** `ExistingCommentWidget` renders inline cards with `density="comfortable"` (update existing `ExistingCommentWidget.test.tsx` expectations). Assert the inline-comment wrapper carries the sans-reset class (the comment subtree is not left to inherit mono). Keep the existing "one CommentCard per comment" and resolved-thread assertions green.
- **Overview regression:** existing Overview / `PrRootConversation` tests stay green, and Overview comment width/typography is unchanged (the reset + measure are diff-scoped). Verify the now-unconditional `.body { overflow-x: auto }` is inert on Overview when content fits.
- **Live validation (required before "done"):** run the app against the real token store, open a PR with inline review comments that include (a) a fixed-column-wrapped prose comment and (b) a comment with a code fence / inline code. Capture **before/after** screenshots in **both themes** and **both Unified and Split** modes. Confirm each:
  - Prose renders in sans; inline + fenced code stays mono.
  - No empty right band; no page-level horizontal scrollbar (coordinate with #514).
  - Wide code/tables/images still scroll/cap inside the card; confirm the narrower 70ch column doesn't make common code fences scroll that previously fit.
  - **Left-anchor alignment:** the bounded card's left edge aligns with the code column, not stuck to the sticky-viewport left edge — checked in wide Unified mode (where `.diffStickyViewport` is active) and in Split.
  - **Composer/affordance alignment:** the reply affordance and `ReplyComposer` share the bounded column width with the cards above them (no wider-than-cards row).
  - **Resolved-thread treatment:** a multi-comment resolved thread's `opacity: 0.72` dimming still reads correctly at comfortable density in both themes (it's heavier now); hover-to-restore behavior intact.
  - **Content-scale:** sanity-check the column at a non-default `--content-scale` (e.g. `xl`) — the measure scales and prose isn't over-tight.
  - Overview comment rendering unchanged.
- **e2e:** check `frontend/e2e` for any visual/parity baseline that snapshots an inline comment card; regenerate the Linux baseline via the CI-artifact path if the typography change shifts it.

## Coordination

- **#514** (comment box overflowing *wider* than the diff → page horizontal scrollbar) is the opposite symptom in the same area. Bounding the measure here should help, not hurt it; verify this change doesn't reintroduce a page-level horizontal scrollbar.
- **#564** is the root-cause follow-up; this spec deliberately does the local card reset and leaves the systemic table-scoping to #564.
