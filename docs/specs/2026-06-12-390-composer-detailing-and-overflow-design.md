# #390 — Comment-composer detailing + composer overflow fix

- **Issue:** [#390](https://github.com/prpande/PRism/issues/390)
- **Date:** 2026-06-12
- **Tier / Risk:** T3 (cross-cutting visual restructure across 3 composer components + diff-pane layout change) · **B1 — UI-visual gated** (`design` label; visual correctness asserted live in both themes).
- **Status:** design approved (collaborative live-app iteration); spec for review.
- **Ships as:** one combined PR.

## 1. Problem

Two problems on the PR-detail comment composer, tracked together because they share the surface.

**Problem 1 — detailing (visual).** The #287 → #326 → #352 "unification" flattened the composer into a single bordered frame with a recessed inset textarea well and a tinted footer "tray." The result reads poorly: the whole frame (not the textarea) carries the focus ring; the footer buttons are spread across the bottom rather than grouped; several buttons inherit the diff's **monospace** font; Preview/Discard render as bare text (no button affordance) and Discard underlines on hover; the merged-PR note clutters the footer. This affects the **inline**, **reply**, and **Overview** comment composers.

**Problem 2 — overflow (functional).** On a **unified-mode** diff whose code lines are wider than the viewport, the composer/comment cell (`<td colSpan>`) inherits the table's intrinsic width (as wide as the widest line), pushing the footer and submit button off-screen to the right. The user must horizontally scroll the diff to reach the submit button.

## 2. Goals / non-goals

**Goals**
- Restore a clean composer look where the **textarea owns the focus highlight** and the footer is a flat, grouped action bar — applied consistently to the inline, reply, and Overview composers.
- Keep the composer (and existing-comment widget) **pinned to the visible diff width** on wide unified-mode files.

**Non-goals**
- No change to draft / autosave / post / submit **behavior** — this is purely visual + layout.
- **Read-only posted-comment card visual styling** (`CommentCard` chrome, comment author/body/meta) is out of scope. Note: `ExistingCommentWidget` **rows** are still wrapped by the Problem 2 viewport pin (§4) — that is a structural layout fix to the over-wide cell, not a change to the card's visual styling.
- The **SubmitDialog** review composer (frameless `PrRootBodyEditor`) is out of scope; all new composer styles are **scoped under `.composer-frame`** so it is untouched (verified: `SubmitDialog`'s `PrRootBodyEditor` is wrapped in `.submit-dialog__pr-root-body`, not a `.composer-frame`).

## 3. Problem 1 — approved composer detailing

The design was settled interactively against the running app (real token store, both themes). Final decisions:

### 3.1 Composer body
- The **textarea is a bordered input** that **owns the focus highlight**. All selectors below are **scoped under `.composer-frame`**:
  - Resting `.composer-frame .composer-textarea`: `background: var(--surface-inset)`, `border: 1px solid var(--border-2)`, `border-radius: var(--radius-2)`.
  - Focus `.composer-frame .composer-textarea:focus-visible` (use `:focus-visible`, not bare `:focus`, so a deliberate click-to-type still rings but the ring follows the platform focus-visible heuristic): `outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring)` — **on the textarea**.
- The **frame is no longer the focus indicator**: drop the accent ring from `.composer-frame:focus-within` (keep only its resting border + `--shadow-1`). Removing the frame ring while adding it to the textarea keeps exactly one element ringed at a time — it does **not** reintroduce the double-ring that #287 solved (which removed the textarea's own ring in favor of the frame's); this is the symmetric inverse.
- **Tight gutter:** textarea `margin: var(--s-1)` (4px) with `width: calc(100% - 2 * var(--s-1))`; markdown-preview pane gets the same `margin: var(--s-1)` so toggling Write/Preview doesn't shift edges.

### 3.2 Footer (action bar)
All CSS below is **scoped under `.composer-frame`** (so `SubmitDialog`'s frameless footer is untouched).
- **No tray:** `.composer-frame .composer-actions` becomes `background: transparent; border-top: none` — this **changes** the current `background: var(--surface-2); border-top: 1px solid var(--border-1)` tray (tokens.css:1068–1072).
- **More bottom padding:** `padding: var(--s-2) var(--s-2) var(--s-3)` (extra breathing room below the buttons).
- **Grouped left/right:** left group = Preview → AI assistant (when present) → save-badge; right group = Discard → primary action → immediate-post. This **changes** the current `justify-content: space-between` (tokens.css:1017) to `justify-content: flex-start; gap: var(--s-2)` plus a **single flex spacer** (`flex: 1`) inserted in the JSX between the two groups.
  - **DOM order must equal visual order** (re-order the JSX children; do **not** use CSS `order:`) so the keyboard tab sequence matches left→right: Preview → AI → Discard → primary → immediate-post. (WCAG 2.4.3.)
- **Consistent font + uniform size:** `.composer-frame .composer-actions button { font-family: var(--font-sans); height: 28px; padding: 0 12px; display: inline-flex; align-items: center; line-height: 1; box-sizing: border-box }`. Specificity (0,2,1) intentionally beats `.btn-sm` (0,1,0, height 26px) and `.composer-post-now` (0,1,0) so the primary matches the secondaries. (Buttons are text-only, so the 28px bump cannot clip an icon; `AiComposerAssistant` renders a non-`<button>`, so this rule does not touch it.)

### 3.3 Buttons
- **Preview & Discard = real bordered secondary buttons** (`.composer-frame .composer-preview-toggle`, `.composer-frame .composer-discard`): `border: 1px solid var(--border-2); background: var(--surface-1); border-radius: var(--radius-2)`. Preview text `--text-1`; Discard text `--danger-fg`.
  - **Hover = fill, not underline.** Preview hover: `background: var(--surface-3); border-color: var(--border-strong)`. Discard hover: `background: var(--danger-soft); border-color: var(--danger); color: var(--danger-fg)` (the red text on hover is a **non-color-redundant** reinforcement so the danger/success hovers aren't distinguished by hue alone — WCAG 1.4.1). Add `.composer-frame .composer-discard:hover { text-decoration: none }` to **override** the global underline rule (tokens.css:961) within the frame — do not delete the global rule (it may serve frameless consumers).
- **Primary action = filled** (`--accent` fill, `--accent-text`, `font-weight: 500`, hover `--accent-hover`):
  - Inline composer: **"Add to review"** (already `.btn .btn-primary .btn-sm` — keep, now height-normalized to 28px by the footer-button rule).
  - Overview composer: **"Post"** (`.composer-post`) becomes the filled primary. `.composer-post` has **no current rule** (it's styled today purely by inherited globals), so this introduces a **new** selector: `.composer-frame .composer-post { background: var(--accent); color: var(--accent-text); border: 1px solid var(--accent); font-weight: 500 }` + `:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover) }`.
- **Immediate-post secondary** ("Comment", `.composer-post-now`, inline/reply): bordered secondary with **green hover** (`background: var(--success-soft); border-color: var(--success); color: var(--success-fg)`), mirroring Discard's red.
- **Interaction states** (specify so the two footer implementations don't diverge):
  - Preview is a toggle (`aria-pressed`): when `aria-pressed=true` (preview shown) it latches to the hover look — `background: var(--surface-3); border-color: var(--border-strong)` — so the active state is visible.
  - The primary button while posting keeps its fill at `opacity: 0.5` (inherits `.btn:disabled` for "Add to review"; add the same to `.composer-frame .composer-post:disabled`) and shows label "Posting…" (existing behavior).
  - `.composer-frame .composer-discard:disabled { opacity: 0.5; cursor: not-allowed }` (Discard is not a `.btn`, so it needs its own disabled rule).
- **Merged/closed PRs:** the "PR is merged — comments post immediately" `.composer-merged-note` exists **only in `ComposerActionsBar`** (inline/reply); **hide** it there. The `closedBanner` gate that already omits "Add to review" **must be preserved** — only the note span is removed, not the gate. To keep the "this posts immediately" cue without the inline note, add `title`/`aria-label="Posts directly to this {merged|closed} PR"` to the immediate-post ("Comment") button when `prState !== 'open'`. `PrRootReplyComposer` has no merged-note today, so no change there.

### 3.4 Where it lives (per-component plan)

All three target composers render `.composer-frame`, so the body + button **CSS** (scoped under `.composer-frame` in `tokens.css`) reaches all of them. The **footer JSX grouping** lives in two places:

| Component | Frame? | Footer | Changes |
|---|---|---|---|
| `InlineCommentComposer` | ✓ | `ComposerActionsBar` | CSS via frame; grouping + merged-note removal in `ComposerActionsBar` |
| `ReplyComposer` | ✓ | `ComposerActionsBar` | same as above (shared bar) |
| `PrRootReplyComposer` (Overview) | ✓ | own inline footer | CSS via frame; grouping + button-class + **Post → primary** in this component |
| `PrRootBodyEditor` | — (frameless editor) | n/a | no change; inside a frame it inherits the textarea treatment, inside `SubmitDialog` it stays bare |
| `SubmitDialog` | — | bare globals | **untouched** (styles scoped under `.composer-frame`) |

**Files:** `frontend/src/styles/tokens.css` (composer-frame body + footer + button rules); `frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx` (grouping spacer, drop merged-note); `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx` (grouping spacer, button classes, Post→primary).

## 4. Problem 2 — viewport overflow pin

**Mechanism (confirmed):** in unified mode the diff `<table>` is auto-layout with `white-space: pre` content cells, so it grows to the widest line; the full-span comment/composer `<td colSpan={3}>` inherits that over-wide width. (Split mode is `table-layout: fixed` + a synthetic lockstep scrollbar, and wrap mode soft-wraps — both already keep the table at viewport width, so they're immune.)

**Approach (chosen): sticky wrapper + ResizeObserver-fed CSS var** (GitHub-style pinning).

- **New hook** `frontend/src/hooks/useDiffViewportWidthVar.ts`: a `ResizeObserver` on the diff body (`.diffPaneBody`) writes its `clientWidth` to a CSS custom property `--diff-viewport-w` on that element; guarded with `typeof ResizeObserver !== 'undefined'` (jsdom-safe, mirroring `useLockedPaneScroll`); cleans the property up on unmount. **Dep key** must include `selectedPath`, `diffMode`, and `lineWrap` so the var re-measures when switching *into* a wide file (not only on container resize). Kept as a hook (not inlined) for parity with the existing single-call-site `useLockedPaneScroll` and to avoid growing `DiffPane.tsx` (already ~37 KB).
- **DiffPane wrapping:** wrap the content of **every** full-span comment/composer `<td colSpan>` cell in `<div className={styles.diffStickyViewport}>`. These cells are emitted from **four** sites — all must be wrapped or unified-mode composers stay unpinned (the exact target case):
  1. split `emitWidgetAndComposerRows` → `ExistingCommentWidget` cell,
  2. split `emitWidgetAndComposerRows` → composer (`renderComposerForLine`) cell,
  3. unified inline `ExistingCommentWidget` `<tr>` in `DiffLineRow` (~DiffPane.tsx:800),
  4. unified `ComposerSlot` cell (~DiffPane.tsx:807 / 1062).
  (Verify exact line numbers at implementation; the spec names the call sites, not line-pins.)
- **CSS** (`DiffPane.module.css`): `.diffStickyViewport { position: sticky; left: 0; width: var(--diff-viewport-w, 100%); box-sizing: border-box; }` — pins the composer to the left visible edge at viewport width regardless of the table's intrinsic width. The `100%` fallback covers the first paint before the first measure (acceptable — the cell is viewport-width until horizontal overflow exists).

Applied uniformly across modes: it's a no-op in split/wrap (the cell is already viewport-width, so `width: var(--diff-viewport-w)` + `sticky left:0` resolve to the same box). The sticky wrapper wraps the cell *content*, which is **not** a `.diffContent > *`, so it is untouched by split mode's `translateX` lockstep shift. Verify split-mode inertness at the B1 gate.

### 4.1 Alternatives considered
- **Pure-CSS container query** (`container-type: inline-size` on `.diffPaneBody` + `width: 100cqi` on the wrapper) — rejected. `container-type` applies `contain: layout` to the scroll container, making it a containing block for abspos descendants (e.g. `.diffCommentAffordance`) and adding size containment to the element that also drives the split-mode lockstep scroll. That is a subtle global change to a complex, already-load-bearing scroll container; the regression surface outweighs the "no JS" benefit for a B1 change. The ResizeObserver→CSS-var path keeps the blast radius off the scroll container's box model.
- **Restructure comment rows out of the table** (absolute/overlay positioning anchored by line) — rejected as over-engineering; the inline-row anchoring is the entire reason these are table rows.

**Files:** `frontend/src/hooks/useDiffViewportWidthVar.ts` (new); `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` (call hook + wrap cells); `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css` (`.diffStickyViewport`).

## 5. Testing

- **Problem 1 (TDD, component):** red→green tests asserting structural/class outcomes that jsdom can observe — footer renders left/right groups (spacer present); Preview & Discard carry the bordered-button class; the merged-note is **not** rendered for a merged PR; Overview "Post" carries the primary class; the immediate-post button gains the merged/closed `title`/`aria-label`. Pure-CSS effects (focus ring location, hover fills, font) are **not** jsdom-observable → covered by the B1 live assert.
- **Existing tests to update (will red otherwise):**
  - `ComposerActionsBar.test.tsx` (~:34–37) currently asserts the merged note **shows** when `closedBanner` — **invert** it to assert the note is **absent** (and that "Add to review" is still gated out).
  - `ComposerActionsBar.test.tsx` (~:32) asserts the flat button order `['Preview','Discard','Add to review','Comment']` — keep it green by **preserving DOM source order** across the new group wrappers / spacer (the spacer is a non-button node, so `getAllByRole('button')` order is unchanged); update only if the order actually changes.
- **Problem 2:** a structural regression test that the comment/composer cell content is wrapped in `.diffStickyViewport` (reds on `main`, greens after); a hook test that it no-ops without `ResizeObserver`. Pixel pinning behavior is verified at the B1 gate (unified-mode file with lines wider than the viewport).
- **B1 visual assert (the human gate):** live verification against the real token store, both themes, of the inline + reply + Overview composers (resting + focused + hover) and the Problem 2 wide-file behavior. The approved iteration screenshots are the reference.
- **Regression:** full FE suite (`vitest`) + existing composer e2e green; existing visual baselines regenerated where the composer appears.

## 6. Risks & mitigations

- **Scope leakage onto SubmitDialog / PrRootBodyEditor-bare:** mitigated by scoping all new button + body rules under `.composer-frame`. Verify SubmitDialog visually unchanged.
- **Uniform 28px overriding `.btn-sm` (26px)** for "Add to review": intended; double-check the primary button isn't clipped and aligns with the 28px secondaries.
- **Sticky inside a table cell:** `position: sticky` on a `<div>` inside `<td>` within the scroll container is well-supported in the Electron Chromium; verify live that horizontal scroll keeps the composer pinned and vertical scroll is unaffected.
- **`--diff-viewport-w` unset on first paint:** the `width: var(--diff-viewport-w, 100%)` fallback keeps the composer at the cell width until the first measure — acceptable (one frame), and the cell is viewport-width on initial load before horizontal overflow matters.
- **Two footer implementations** (`ComposerActionsBar` vs `PrRootReplyComposer`'s inline footer) must be kept in visual lockstep. **`ComposerActionsBar` is the reference shape**; `PrRootReplyComposer`'s footer must produce structurally identical grouping/button output. A future cleanup could unify them onto `ComposerActionsBar`, but that refactor is out of scope here.
- **`closedBanner` gate must be preserved.** It currently gates *both* the merged-note span and the "Add to review" hide. Remove only the note span — keep the gate, or merged/closed PRs would regain an "Add to review" button that doesn't apply.
- **WCAG AA contrast on the filled primary** (`--accent` fill + `--accent-text`, resting + `--accent-hover`) must be verified at the B1 gate in **both** themes — the Overview "Post" button is newly promoted to the filled-primary treatment.

## 7. Open questions

None blocking. The visual design is approved; remaining verification is the B1 live assert at green-and-ready.
