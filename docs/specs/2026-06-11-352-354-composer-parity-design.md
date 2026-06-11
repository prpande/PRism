---
title: "#352 + #354 — composer-frame parity for the Overview composer and the Drafts tab card"
type: refactor
origin: none
issue: 352, 354
tier: T3
risk: UI-visual (shared composer globals + Drafts tab + Overview composer)
date: 2026-06-11
---

# Slice 2 — composer-frame parity (#352) + Drafts card (#354)

Second slice of the comment-composer trio (Slice 1 = #353, shipped in PR #370).
Both issues are **visual-consistency** tech-debt: two PR-detail surfaces predate
the shared comment/composer UI introduced in #287 and read as out of place.

- **#352** — the Overview-tab reply composer (`PrRootReplyComposer`) never adopted
  the `.composer-frame` shell the diff composer (`InlineCommentComposer`) uses, so
  it looks like a plainer, double-bordered box.
- **#354** — the Drafts tab renders each draft with a bespoke `DraftListItem` card
  ("derived from handoff `.stale-row`") that doesn't belong to the `CommentCard`
  family, and clips the body to 80 chars.

This slice also folds in two small riders surfaced during the trio's reviews:
a global **input-affordance + badge-pill** refinement to the shared composer
shell (owner-requested during brainstorming), and the leftover **#326** missing
`React` type import on `PrRootReplyComposer`.

All visual decisions in this spec were validated against **real PRism tokens in
both themes** via the brainstorming visual companion before this doc was written.

## Shared-shell consumer inventory (the real blast radius)

The U2/U3 global changes touch **every** `.composer-frame` / `.composer-badge`
consumer. The complete list (verified by grep) — implementers and the B1 pass
must treat all of these as in scope:

| Consumer | `.composer-frame` | `.composer-textarea` | badge source |
|---|---|---|---|
| `InlineCommentComposer` (diff, open) | yes | direct child | `ComposerActionsBar` |
| `ReplyComposer` (Files-tab thread reply) | yes | direct child | `ComposerActionsBar` |
| `PrRootReplyComposer` (Overview reply) | **yes (added in U1)** | nested (via `PrRootBodyEditor`) | footer badge (see U3) |
| `PrRootBodyEditor` (inside Overview + `SubmitDialog`) | n/a | — | inner badge (see U3) |
| `CollapsedComposerAffordance` | no | no | static `--saved` badge |
| `SubmitDialog` | no (frameless, #287 carve-out) | via `PrRootBodyEditor` | `PrRootBodyEditor` inner badge |

`ReplyComposer` requires **no source edit** — it inherits the global rule changes —
but it IS a visually affected surface, so it appears in the B1 checklist and the
baseline discussion below.

## Owner decisions (locked in brainstorming)

1. **#354 draft band = draft-native** (status chip + `path · line`), NOT a
   synthesized comment-style band. A draft DTO carries no author, avatar, or
   `createdAt`, and the frontend exposes no viewer identity, so a literal
   `CommentCard` band (avatar · author · timestamp) cannot be populated honestly.
2. **#354 shell reuse = `composes:`** the `.card`/`.body` rules from
   `CommentCard.module.css` — share the CSS, do **not** modify `CommentCard.tsx`
   or render `<CommentCard>` with new slots (keeps its 3 consumers untouched).
3. **#354 actions = Edit + Discard only.** No "Post now", no in-place editing.
   Edit keeps today's navigate-to-anchor behavior.
4. **#352 input affordance = inset well.** Rather than the diff composer's fully
   borderless textarea, the shared frame's textarea becomes a recessed input well
   (so it's obvious where to type). Applied to the **shared** rule, so the diff
   composer keeps parity.
5. **Badge + well changes are global** (apply to every `.composer-frame` /
   `.composer-badge` consumer), owner-approved.

## U1 — #352: `PrRootReplyComposer` adopts `.composer-frame`

`PrRootReplyComposer`'s wrapper currently uses only its module box class. Add the
shared frame class alongside it, mirroring how `InlineCommentComposer` composes
`inline-comment-composer composer-frame <module>`:

```tsx
// PrRootReplyComposer wrapper <div role="form" …>
className={`composer-frame ${styles.prRootReplyComposer}`}
```

Then strip the now-redundant box properties from `.prRootReplyComposer` in
`PrRootReplyComposer.module.css` — remove `padding`, `background`, `border-radius`,
`border`; **keep** `display: flex; flex-direction: column; gap: var(--s-2)` (the
frame provides surface/border/radius/shadow/overflow).

**`postError` layout (was a bare "verify" — now pinned).** `.postError` renders
between the editor block and `.composer-actions` inside the framed,
`overflow:hidden` control. After U2 gives the textarea a `var(--s-2)` gutter,
`.postError` (which has padding/background/radius but no margin) would abut the
footer strip with no gap. Add `margin: 0 var(--s-2) var(--s-2)` to `.postError` so
it shares the well's side gutter and keeps a consistent gap above the footer strip.
The error state is a **required B1 screenshot**, not just a prose check.

**Preview path.** `previewMode` swaps the editor for `ComposerMarkdownPreview`. To
keep the framed box from jumping between Edit and Preview, give the preview pane the
same gutter (see U2). Verify the preview renders inside the frame with no clipping.

## U2 — Input well on the shared `.composer-frame` textarea + preview pane

Today the shared rule strips the inner textarea to borderless/transparent. Change
it to a recessed **input well** so the typing area is clearly delineated:

```css
.composer-frame .composer-textarea {
  margin: var(--s-2);
  background: var(--surface-inset);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
}
.composer-frame .composer-textarea:focus-visible {
  outline: none; /* unchanged — the frame's :focus-within ring is the sole focus indicator */
}
/* Keep Edit↔Preview from shifting the content box: the preview pane gets the
   same gutter as the well. */
.composer-frame .composer-markdown-preview {
  margin: var(--s-2);
}
```

**Cross-consumer parity caveat (must verify, not assume).** The textarea sits at
**different DOM depths** across consumers: in `InlineCommentComposer` and
`ReplyComposer` it is a **direct flex child** of `.composer-frame`; in the Overview
composer it is nested two levels down (`<div hidden>` → `PrRootBodyEditor`'s
`.editor` div, which itself sets `display:flex; gap:var(--s-2)`). The descendant
selector still matches everywhere, so the well paints — but the **effective inset
can compound** with the inner `.editor` gap in the Overview path. The B1 pass MUST
place the Overview composer **side-by-side** with the diff and reply composers and
confirm the well's gutter is visually identical. If the Overview path insets
differently, neutralize the inner `.editor` gap (it is redundant with the well's
margin) rather than special-casing the selector.

**Dark-theme note.** In dark, `--surface-inset` (`oklch(0.20 …)`) sits only ~0.01 L
from the frame's `--surface-1` (`oklch(0.21 …)`) — below the ~0.03 perceptible step
the codebase calls out for dark surfaces (#347). The well's **`--border-1` hairline**
(ΔL ≈ 0.09 from surface-1) is what carries the "input here" affordance in dark; the
recessed fill is essentially a light-mode nicety. This is acceptable (the border
delineates the field in both themes), but B1 must confirm the well reads as an input
in **dark** too; if it reads flat, add a scoped dark value
(`html[data-theme='dark'] .composer-frame .composer-textarea { background: oklch(0.17 0.009 250); }`).

## U3 — `.composer-badge` pill, capitalized labels, and one canonical badge

The badge already carries correct per-state colors (`--saved` green / `--saving`
blue / `--unsaved` amber / `--rejected` red). Three changes:

1. **Pill shape** — in `.composer-badge` (`tokens.css`), change
   `border-radius: var(--radius-1)` → `border-radius: 999px`.

2. **Capitalized labels** — the badge currently prints the raw lowercase state
   (`{badge}`). Add a `badgeLabel` helper co-located with the `ComposerSaveBadge`
   type in `useComposerAutoSave.ts` and export it:

   ```ts
   export function badgeLabel(badge: ComposerSaveBadge): string {
     switch (badge) {
       case 'saved': return 'Saved';
       case 'saving': return 'Saving…';
       case 'unsaved': return 'Unsaved';
       case 'rejected': return 'Save failed';
     }
   }
   ```

   (`Save failed` is the first non-raw copy for the `rejected`/422 state — a minor
   product-copy choice flagged here for the human-review gate.) Apply at the
   dynamic render sites: `ComposerActionsBar.tsx`, `PrRootBodyEditor.tsx`,
   `PrRootReplyComposer.tsx` (`{badge}` → `{badgeLabel(badge)}`). For
   `CollapsedComposerAffordance.tsx`, replace the static lowercase `saved` text with
   a literal `Saved` (it is hardcoded to the `--saved` variant; no helper needed).

3. **One canonical badge in the Overview composer (fixes a real duplication).**
   `PrRootBodyEditor` renders a `composer-badge` unconditionally, and
   `PrRootReplyComposer` renders its **own** badge in `.composer-actions`. Today
   that is two stacked lowercase badges; once U1 frames the surface and the labels
   become pills, the Overview composer would show **two "Saved" pills** in one
   control, and any `getByTestId('composer-badge')` query on this surface hits a
   strict-mode duplicate match. Resolve it: add a `showBadge?: boolean` prop to
   `PrRootBodyEditor` (default `true`). `PrRootReplyComposer` passes
   `showBadge={false}` and keeps its **footer** badge as the canonical one (matching
   the diff composer, whose single badge lives in `ComposerActionsBar`'s footer).
   `SubmitDialog` (the other `PrRootBodyEditor` consumer, frameless) keeps the
   default `true`, so its badge is unaffected.

   **Test impact (known, named — not "enumerate later"):**
   `CollapsedComposerAffordance.test.tsx` asserts `getByText('saved')` → update to
   `getByText('Saved')`. Any composer test asserting the lowercase badge text
   migrates to the capitalized label; tests on the `composer-badge--<state>` class
   or the `data-testid` are unaffected. After U3.3, the Overview composer has a
   single `composer-badge` testid (no strict-mode dup).

## U4 — #326 rider: missing `React` type import

`PrRootReplyComposer.tsx` references `React.KeyboardEvent<HTMLDivElement>` in its
`handleKeyDown` signature but never imports `React`, relying on the UMD global.
Add `import type React from 'react';` (flagged by `claude[bot]` on PR #365 / #326).

## U5 — #354: Drafts card shell via `composes:`

In `DraftListItem.module.css`, share the comment-card shell instead of the bespoke
box, using CSS Modules `composes:`:

```css
.draftListItem {
  composes: card from '../Comment/CommentCard.module.css';
  /* the composed `.card` provides surface-1 / border-1 / radius-3 / shadow-2 /
     overflow:hidden — keep nothing surface/border/radius-related here */
}
```

Remove the copied `background`/`border`/`border-radius`/`padding` from
`.draftListItem`. `CommentCard.tsx` is **not** modified; its 3 consumers
(`PrRootConversation`, `ExistingCommentWidget`, `FilesTab`) are untouched.

**Precedent correction + verification (the prior draft overstated this).** This is
**cross-file** `composes: … from`. The repo's only existing `composes:` is
`composes: tab;` in `Header.module.css` — **same-file** local composition, a
different and better-supported feature. Cross-file composes IS supported by Vite's
CSS-modules pipeline but has **no precedent in this codebase**, so the first
implementation step for U5 is a throwaway build/smoke (`npm run build`) confirming
the cross-file compose resolves and that `CommentCard`'s `.card[data-density='compact']`
variant rules do **not** leak onto the draft card (the draft card sets no
`data-density`, so the compact variant should not match — confirm). If the build
rejects cross-file composes, the documented fallback is a **local `.draftListItem`
rule with the same tokens** as `.card` (surface-1 / border-1 / radius-3 / shadow-2 /
overflow-hidden). The single-consumer chip variants `:global(.chip-status-moved)` /
`:global(.chip-status-draft)` stay local to `DraftListItem.module.css`.

## U6 — #354: Drafts card band + body + footer

`DraftListItem.tsx` restructures into the CommentCard family's three regions:

- **Band — a LOCAL `.draftBand` rule (O1 resolved).** The draft band's content
  (status chip + optional `path · line`) differs from a comment band
  (avatar + author + time), and `CommentCard`'s `.band` padding
  (`var(--s-2) var(--s-4)`, sized for a three-element row) leaves excessive
  vertical whitespace on a chip-only row (the PR-root/reply case). So the band is a
  **local `.draftBand`** rule — NOT composed — carrying the CommentCard band tokens
  (`background: var(--surface-2); border-bottom: 1px solid var(--border-1);
  display:flex; align-items:center; gap:var(--s-2); font-size: var(--text-xs)`) with
  padding tuned for the chip row (`padding: var(--s-1) var(--s-3)`, matching
  CommentCard's compact-density band). It holds the existing status chip(s) —
  `Draft` / `Stale` / `Moved` / the `User-overridden (was Stale)` chip — followed by
  `path · line` in mono (`--font-mono`) when file-anchored. For PR-root draft
  comments (`filePath === null`) and replies (no file anchor), the band shows the
  chip(s) only. (Using a local rule also sidesteps the unproven cross-file-band
  compose — only the U5 shell takes the cross-file compose risk.)

- **Body** (composes `.body` from `CommentCard.module.css`): drop the 80-char
  `previewBody`/`PREVIEW_CHARS` clamp — render the full `bodyMarkdown` through
  `MarkdownRenderer`, exactly as a posted comment renders. **Full body, no
  height cap** is the intended behavior (parity with comment cards); a long draft or
  a code-block/table draft is a required B1 surface so reviewers don't read it as a
  regression. The discard-confirm `Modal` keeps a short truncation (it is a
  confirmation prompt, not the primary display), so `previewBody` is retained solely
  for the modal.

- **Footer** (action strip mirroring `.composer-frame .composer-actions`:
  `border-top: 1px solid var(--border-1)`, `background: var(--surface-2)`,
  right-aligned, `padding: var(--s-2) var(--s-3)`): **Edit** + **Discard**. The two
  buttons **keep their existing `btn` classes** — `btn btn-secondary btn-sm` (Edit)
  and `btn btn-danger btn-sm` (Discard) — which already carry `:disabled` styling
  (`.composer-discard` has only `:hover`, so do NOT switch to it). Only the **label**
  changes (Delete → Discard) and the row gains the footer-strip styling. `onEdit`
  keeps the existing navigate-to-anchor behavior (`handleEdit` in `DraftsTab.tsx`).
  No "Post now", no in-place edit. The `readOnly` path still hides the footer.

  **Test impact:** any unit/e2e selector querying the button by accessible name
  "Delete" migrates to "Discard".

## Files

- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx`
  (U1 frame class, U3 badge label + `showBadge={false}`, U4 React import)
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.module.css`
  (U1 strip box props + `.postError` margin)
- Modify: `frontend/src/styles/tokens.css` (U2 well + preview gutter, U3 pill radius)
- Modify: `frontend/src/hooks/useComposerAutoSave.ts` (U3 `badgeLabel` helper)
- Modify: `frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx` (U3 label)
- Modify: `frontend/src/components/PrDetail/Composer/PrRootBodyEditor.tsx`
  (U3 label + `showBadge` prop)
- Modify: `frontend/src/components/PrDetail/Composer/CollapsedComposerAffordance.tsx` (U3 static label)
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftListItem.tsx` (U6 band/body/footer)
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftListItem.module.css`
  (U5 composes shell, U6 `.draftBand` + footer rules)
- Tests: `DraftListItem.test.tsx` (new/updated), `CollapsedComposerAffordance.test.tsx`
  (badge text), composer badge-label assertions, visual baselines below.
- No source edit, but visually affected: `ReplyComposer` (inherits the global
  well/pill).

## Test plan

**Unit / vitest:**

1. `DraftListItem` renders the **full** body (no 80-char clamp) — assert a body
   longer than 80 chars renders in full through `MarkdownRenderer`.
2. `DraftListItem` band shows the status chip + `path · line` for a file-anchored
   draft, and chip-only for a PR-root/reply draft (`filePath === null`).
3. `DraftListItem` footer shows **Edit** + **Discard**; `readOnly` hides the footer;
   both buttons disable during an in-flight discard.
4. `badgeLabel` maps each state to its capitalized label; a composer renders
   `Saved`/`Unsaved` text for the corresponding state.
5. `PrRootReplyComposer` wrapper carries the `composer-frame` class **and renders a
   single `composer-badge`** (regression guard for the U3.3 dedup — assert
   `getAllByTestId('composer-badge')` has length 1 on the open Overview composer).
6. `SubmitDialog` still renders its `PrRootBodyEditor` badge (regression guard that
   `showBadge` defaults true).

**Visual baselines (Playwright):**

- Regen `pr-detail-drafts.png` (linux + win32) — #354 card restyle.
- Regen `pr-detail-overview.png` (linux + win32) — #352 frame + U2 well + U3 pill +
  single-badge on the Overview composer.
- **Add a new baseline that opens the diff `InlineCommentComposer`** (resting +
  focused) — it is the most-changed surface (well + pill) and currently has **zero**
  pixel coverage (`pr-detail-files-diff.png` screenshots the diff pane with no
  composer open). This closes the gap the prior draft left to "enumerate later".
- `ReplyComposer` (open thread reply) and the collapsed-affordance badge are covered
  by **B1 manual sign-off** (adding a baseline for each is optional follow-up); this
  is an explicit, recorded coverage decision — not a silent gap.
- Run a full `--update-snapshots` diff and inspect every changed PNG before
  committing. Linux baselines regen from the CI artifact; win32 locally.

**B1 visual sign-off (gated), real token store, both themes:**
- Overview composer: collapsed → open, resting → focused (single ring, single
  badge), Preview mode, and a `postError` state — **side-by-side with the diff AND
  reply composers** to confirm the well gutter is identical across all three (the
  DOM-depth parity check from U2).
- Dark-theme well legibility (U2 dark note).
- Drafts tab: a file-anchored draft, a PR-root draft, a reply draft, a
  stale/overridden draft, and a **long-body + code-block draft** — side-by-side with
  a real comment card for parity.

## Out of scope

- `StaleDraftRow` (UnresolvedPanel) shares `DraftLike` but is a different surface;
  left as-is. Possible consistency follow-up.
- `SubmitDialog` stays frameless (per #287's carve-out).
- `CommentCard.tsx` API (no new `band`/`footer` slots — decision 2).
- Composer decomposition #327 (separate refactor).

## Risks

- **Shared-rule blast radius (U2/U3).** The well and pill changes touch every
  consumer in the inventory table above (diff inline composer, **reply composer**,
  Overview composer, collapsed affordance, submit-dialog badge). Intended (parity),
  but the visual diff is wider than the two named surfaces — hence the full
  consumer inventory, the added diff-composer baseline, and the three-composer B1
  side-by-side.
- **Cross-file `composes:` is unproven here (U5).** Mitigated by the U5 build-smoke
  step and the documented local-rule fallback. The band (U6) deliberately uses a
  local rule, so only the shell takes this risk.
- **`composes:` coupling.** A future rename of `.card`/`.body` in
  `CommentCard.module.css` breaks `DraftListItem`'s compiled CSS at build time (not
  caught by TypeScript). Acceptable — it is the DRY the issue asks for — but there is
  no test guard; the build will surface it.
- **Test migrations.** Capitalizing the badge breaks lowercase-text assertions
  (named: `CollapsedComposerAffordance.test.tsx`); renaming Delete→Discard breaks
  accessible-name selectors. Both are named above, not deferred.

## Resolved during review (was "Open questions")

- **O1 (band reuse) — resolved:** the band is a **local `.draftBand`** rule (U6),
  not a composed `.band`, because the chip-row content differs from a comment band
  and the composed padding leaves excess whitespace on the chip-only (PR-root/reply)
  case. The cross-file compose risk is therefore confined to the U5 shell.
