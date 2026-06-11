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
frame provides surface/border/radius/shadow/overflow). The frame's existing
descendant rules (`.composer-frame .composer-actions` → footer strip;
`.composer-frame .composer-textarea` → neutralized inner border) deliver the rest
for free, because `PrRootBodyEditor`'s textarea already uses the bare
`.composer-textarea` global and the action row already uses `.composer-actions`.

`.postError` (in the same module) keeps its own padding/background/radius so it
reads as an inset banner inside the framed, `overflow:hidden` control.

**Verification (not a code change):** confirm the `previewMode` path
(`ComposerMarkdownPreview`) and the `postError` row render correctly inside the
frame — no clipping from `overflow:hidden`, correct spacing above the footer strip.

## U2 — Input well on the shared `.composer-frame .composer-textarea`

Today the shared rule strips the inner textarea to borderless/transparent so the
frame is the sole visual element. Change it to a recessed **input well** so the
typing area is clearly delineated (owner decision 4):

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
```

The well floats inside the frame's `--surface-1` (the `margin` reveals the frame
surface as a gutter around it), sits above the footer strip, and keeps the
suppressed focus outline so `:focus-within` still paints exactly one accent ring
on the whole control. This applies to **both** `InlineCommentComposer` (diff) and
`PrRootReplyComposer` (Overview), preserving parity.

## U3 — `.composer-badge` becomes a pill with capitalized labels

The badge already carries correct per-state colors (`--saved` green / `--saving`
blue / `--unsaved` amber / `--rejected` red). Two changes:

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

   Apply it at **all four** `.composer-badge` text render sites:
   - `ComposerActionsBar.tsx` (`{badge}` → `{badgeLabel(badge)}`)
   - `PrRootBodyEditor.tsx` (`{badge}` → `{badgeLabel(badge)}`)
   - `PrRootReplyComposer.tsx` (`{badge}` → `{badgeLabel(badge)}`)
   - `CollapsedComposerAffordance.tsx` (static `saved` text → `Saved`; this one is
     hardcoded to the `--saved` variant, so a literal `Saved` is sufficient — it
     does not need the helper).

   The `data-testid="composer-badge"` attributes are unchanged. Any test asserting
   on the lowercase badge **text** (not the testid) must update to the capitalized
   label; tests asserting the `composer-badge--<state>` class or the testid are
   unaffected.

## U4 — #326 rider: missing `React` type import

`PrRootReplyComposer.tsx` references `React.KeyboardEvent<HTMLDivElement>` in its
`handleKeyDown` signature but never imports `React`, relying on the UMD global.
Add `import type React from 'react';` (flagged by `claude[bot]` on PR #365 / #326).

## U5 — #354: Drafts card shell via `composes:`

In `DraftListItem.module.css`, share the comment-card shell instead of the bespoke
box. Using CSS Modules `composes:` (already used in `Header.module.css`):

```css
.draftListItem {
  composes: card from '../Comment/CommentCard.module.css';
  /* keep nothing surface/border/radius-related here — the composed `.card`
     provides surface-1 / border-1 / radius-3 / shadow-2 / overflow:hidden */
}
```

Remove the copied `background`/`border`/`border-radius`/`padding` from
`.draftListItem`. `CommentCard.tsx` is **not** modified; its 3 consumers
(`PrRootConversation`, `ExistingCommentWidget`, `FilesTab`) are untouched.

The single-consumer chip variants `:global(.chip-status-moved)` /
`:global(.chip-status-draft)` stay in `DraftListItem.module.css` (still
single-consumer; no reason to promote them to shared tokens this slice).

## U6 — #354: Drafts card band + body + footer

`DraftListItem.tsx` restructures into the CommentCard family's three regions:

- **Band** (CommentCard-style header: `surface-2`, `border-bottom`, padding):
  the existing status chip(s) — `Draft` / `Stale` / `Moved` / the
  `User-overridden (was Stale)` chip — followed by `path · line` rendered in mono
  (`--font-mono`) when the draft is file-anchored. For PR-root draft comments
  (`filePath === null`) and replies (no file anchor), the band shows the chip(s)
  only. The band reuses `CommentCard.module.css`'s `.band` rule via `composes:`
  (or a local rule with identical tokens — see Open question O1).

- **Body** (composes `.body` from `CommentCard.module.css`): drop the 80-char
  `previewBody`/`PREVIEW_CHARS` clamp — render the full `bodyMarkdown` through
  `MarkdownRenderer`, exactly as a posted comment renders. The discard-confirm
  `Modal` keeps a short truncation (it is a confirmation prompt, not the primary
  display), so `previewBody` is retained solely for the modal.

- **Footer** (action strip mirroring `.composer-frame .composer-actions`:
  `border-top`, `surface-2`, right-aligned): **Edit** + **Discard**. Rename the
  current "Delete" button to **Discard** for consistency with the composer family
  (`PrRootReplyComposer` already says "Discard"). `onEdit` keeps the existing
  navigate-to-anchor behavior (`handleEdit` in `DraftsTab.tsx`). No "Post now", no
  in-place edit. The `readOnly` path still hides the footer.

## Files

- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx`
  (U1 frame class, U3 badge label, U4 React import)
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.module.css`
  (U1 strip box props)
- Modify: `frontend/src/styles/tokens.css` (U2 input well, U3 pill radius)
- Modify: `frontend/src/hooks/useComposerAutoSave.ts` (U3 `badgeLabel` helper)
- Modify: `frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx` (U3)
- Modify: `frontend/src/components/PrDetail/Composer/PrRootBodyEditor.tsx` (U3)
- Modify: `frontend/src/components/PrDetail/Composer/CollapsedComposerAffordance.tsx` (U3 static label)
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftListItem.tsx` (U6 band/body/footer)
- Modify: `frontend/src/components/PrDetail/DraftsTab/DraftListItem.module.css` (U5 composes, U6 band/footer rules)
- Tests: `DraftListItem.test.tsx` (new/updated), composer badge-label assertions in existing composer tests, visual baselines below.

## Test plan

**Unit / vitest:**

1. `DraftListItem` renders the **full** body (no 80-char clamp) — assert a body
   longer than 80 chars renders in full through `MarkdownRenderer`.
2. `DraftListItem` band shows the status chip + `path · line` for a file-anchored
   draft, and chip-only for a PR-root/reply draft (`filePath === null`).
3. `DraftListItem` footer shows **Edit** + **Discard**; `readOnly` hides the footer.
4. `badgeLabel` maps each state to its capitalized label; a composer renders
   `Saved`/`Unsaved` text for the corresponding state.
5. `PrRootReplyComposer` wrapper carries the `composer-frame` class.

**Visual baselines (Playwright, regen):**

- `pr-detail-drafts.png` (linux + win32) — #354 card restyle.
- `pr-detail-overview.png` (linux + win32) — #352 frame + U2 well + U3 pill on the
  Overview composer.
- Enumerate any additional baseline that captures an **open** inline composer or a
  collapsed-composer badge during implementation; regen those too. (Known set
  above; confirm with a full `--update-snapshots` diff before committing.)

Linux baselines regen from the CI artifact; win32 locally (established practice).

**B1 visual sign-off (gated):** verify in the running app against the **real token
store**, both themes:
- Overview composer: collapsed → open, resting → focused (single ring), Preview
  mode, and a `postError` state — side-by-side with the diff composer for parity.
- Drafts tab: a file-anchored draft, a PR-root draft, a reply draft, a
  stale/overridden draft, and a long-body draft — side-by-side with a real comment
  card for parity.

## Out of scope

- `StaleDraftRow` (UnresolvedPanel) shares `DraftLike` but is a different surface;
  left as-is. Possible consistency follow-up (file an issue if it now looks
  divergent next to the restyled Drafts tab).
- `SubmitDialog` stays frameless (per #287's carve-out).
- `CommentCard.tsx` API (no new `band`/`footer` slots — decision 2).
- Composer decomposition #327 (separate refactor).

## Risks

- **Shared-rule blast radius (U2/U3).** The input well and pill changes touch every
  `.composer-frame` / `.composer-badge` consumer (diff inline composer, Overview
  composer, collapsed affordance, submit-dialog badge). This is intended (parity),
  but means the visual diff is wider than the two named surfaces — hence the
  "enumerate all baselines" step. Mitigated by the B1 both-composers-side-by-side
  check.
- **`composes:` resolution (U5).** `composes: card from '../Comment/CommentCard.module.css'`
  couples `DraftListItem` to `CommentCard`'s module. That coupling is the point
  (single source of truth), but a future rename of `.card` would need both updated.
  Acceptable — it is the DRY the issue asks for, and `composes:` already exists in
  the repo.
- **Badge text assertions.** Capitalizing the label may break tests that assert on
  the lowercase badge **text**; these must migrate to the new label (or assert on
  the unchanged class/testid). Enumerate during implementation.

## Open questions (resolve before/while planning)

- **O1 — band reuse mechanism.** The draft band wants `CommentCard`'s `.band`
  look. Either `composes: band from CommentCard.module.css` (shares the rule, same
  upside/risk as U5) or a local `.draftBand` rule with identical tokens. Prefer
  `composes:` for consistency with U5 unless the band's content differences
  (chip+lineref vs avatar+author+time) make the composed paddings wrong — confirm
  the `.band` padding (`var(--s-2) var(--s-4)`) suits the chip row during
  implementation.
