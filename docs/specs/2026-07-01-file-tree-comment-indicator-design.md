# File-tree per-file comment indicator (#513)

**Issue:** [#513](https://github.com/prpande/PRism/issues/513) · **Tier:** T2 · **Risk:** B1 UI-visual (`needs-design`) — pure presentation, no backend/DTO/wire change. The human visual gate is satisfied by an approved real-token mockup (both themes) plus a Playwright screenshot pass in `## Proof`.

## Problem

In the PR-detail **Files** view, the file tree gives no signal of which files carry review discussion. A reviewer scanning the tree cannot tell which files already have threads without opening each one. GitHub's "Files changed" tree shows a per-file comment marker for exactly this; PRism does not.

Each file-tree row today has two fixed right-side slots — the AI focus dot (`.file-tree-ai-col`, #492) and the viewed checkbox (`.file-tree-check-col`). There is no comment affordance, and the right gutter is already busy.

## Goal & scope

Add a per-file comment indicator with **three states**, driven entirely off data already loaded in `PrDetailDto.reviewComments`:

| State | Condition | Treatment |
|-------|-----------|-----------|
| **None** | file has zero review threads | blank slot |
| **Unresolved** | file has ≥1 thread with `isResolved === false` | comment glyph, **solid accent** (`var(--accent)`) |
| **Resolved** | file has ≥1 thread, **all** resolved | comment glyph, **dimmed accent** (`var(--accent)` @ `opacity: 0.45`) |

Locked design decisions (owner-approved mockup, 2026-07-01):

- **Glyph:** reuse the inbox PR-row comment glyph (Octicon `comment-16`), extracted to a shared component so the two sites cannot drift.
- **Placement:** a new fixed column on the **left** of the tree — the right gutter (AI + checkbox) is already congested. The rail has **no border/seam**: it reads as one continuous container with the tree.
- **No count.** Three states only; the glyph never renders a number. (Deviation from the issue AC — see *Deviations* below.)
- **No interaction.** Purely informational; the existing row click still selects the file. No click-to-jump.
- **No outdated/anchor logic.** Resolved vs unresolved is the only axis; `anchorSha` is not consulted.

## Data source

`PrDetailDto.reviewComments: ReviewThreadDto[]` is already loaded at the `FilesTab` level (it is filtered by path elsewhere, e.g. `FilesTab.tsx:291`). Each thread carries what we need:

```ts
interface ReviewThreadDto {
  filePath: string;    // group key
  isResolved: boolean; // resolved vs unresolved
  // …threadId, lineNumber, anchorSha, comments — unused here
}
```

No new API, DTO, or fetch. The tree already re-renders off `reviewComments`, so the indicator is reactive for free: posting/resolving a thread updates `reviewComments` → the per-file map recomputes → the glyph state changes.

## Components & data flow

Three small pieces, each independently understandable and testable.

### 1. `CommentGlyph` — shared presentational component

New file `frontend/src/components/shared/CommentGlyph.tsx`. Renders the Octicon `comment-16` SVG at 12×12, `fill="currentColor"`, `aria-hidden`. Color comes from the consumer (the SVG inherits `currentColor`), so the glyph itself is state-agnostic. It accepts an optional `className` prop forwarded to the `<svg>` so a consumer can attach layout/sizing classes.

`InboxRow.tsx` is refactored to consume `CommentGlyph` in place of its inline `<svg>` (`InboxRow.tsx:250-260`), proving the reuse and removing the duplicated path. The inbox's count text and layout are unchanged. **The swap MUST pass the existing class through** — `<CommentGlyph className={styles.commentIcon} />` — because `.commentIcon` `composes: metricPillIcon` (`InboxRow.module.css`), which is load-bearing pill-icon sizing/alignment; dropping it would resize or misalign the inbox glyph. The file-tree consumer passes no such class (it sizes via the rail).

### 2. Per-file comment state — derived in `FilesTab`

A `useMemo` over `prDetail.reviewComments` produces a `Map<string, CommentIndicatorState>` where `CommentIndicatorState = 'unresolved' | 'resolved'` (absent key ⇒ `none`):

```ts
// for each filePath: 'unresolved' if any thread on that path is unresolved,
// else 'resolved' (the path has threads and every one is resolved).
```

A path appears in the map iff it has ≥1 thread. `unresolved` wins over `resolved` when a file mixes both. This map is passed into `<FileTree>` as a new optional prop `commentStateByPath?: Map<string, CommentIndicatorState> | null`. The prop is optional/nullable **only** so non-FilesTab callers (tests, any future embed) can omit it; FilesTab always passes a real Map (possibly empty). Inside `FileTree`, a missing/`null`/empty map coerces to the collapsed state — `data-has-comments='0'` and every slot blank — mirroring how `aiPreview` defaults `false`.

### 3. Fixed left rail in `FileTree`

Mirror the established fixed-column pattern (`.file-tree-ai-col` / `.file-tree-check-col`), but on the **left**, as the first child of `.fileTreeBody` — *outside* `.fileTreeScroll`. This matters because `.fileTreeInner` is shifted by `translateX` from the synthetic scrollbar (#214); anything rendered *inside* the scroller slides off the **left** edge on horizontal scroll. Keeping the rail outside the scroller (exactly as the AI/check columns sit outside it on the right) pins it regardless of scroll position.

- New `.fileTreeCommentCol` (flex column) + `.fileTreeCommentSlot` (row-height, centered), rendered from the **same flat `rows` list** as the other columns so row *i* lines up across all four columns. File rows render a `<CommentSlot>`; directory rows render a bare slot.
- **No border/seam** between the rail and the tree — at rest the rail shares the tree's `--surface-1`, so with no divider it reads as one continuous surface. Like the existing AI/check columns, the rail is a **static gutter**: it does NOT repaint to the row's hover (`--surface-3`) or selected (`accent-soft` wash) background. This is deliberate parity with the right-side columns; the "one container" promise is the at-rest seamlessness the owner asked for, not per-row-state background tracking. (If we later want the gutters to track row state, that's a tree-wide change spanning all three fixed columns, out of scope here.)
- **Width-collapse when empty:** like the AI column's `data-ai-on` gate, the rail collapses to `width: 0` when the PR has **zero** review threads, so PRs with no discussion lose no filename space. Driven by a `data-has-comments` attribute on the `.fileTree` root (set from `commentStateByPath?.size`).
- Column width token `--comment-col-w: calc(12px + 2 * var(--s-1))` (glyph + symmetric padding), declared alongside `--ai-col-w` / `--check-col-w`.
- **Synthetic-hscroll alignment (#214) — requires a matching LEFT spacer.** The `.fileTreeHScrollRow` mirrors `.fileTreeBody`'s column layout so the scrollbar thumb sits under `.fileTreeScroll`. Today that row is `[.fileTreeHScroll (flex:1)] [.fileTreeHScrollSpacerCol (right gutter)]`. Prepending the comment rail shifts `.fileTreeScroll` right by `--comment-col-w`, so the row needs a new **leading** spacer of `--comment-col-w` as its first child, or the bar misaligns left by the rail width. That leading spacer collapses to `0` in lockstep with the rail (same `data-has-comments` gate). The existing right-gutter `.fileTreeHScrollSpacerCol` is unchanged.

Glyph color is set on the slot via a state class:

```css
.fileTreeCommentSlot--unresolved { color: var(--accent); }
.fileTreeCommentSlot--resolved   { color: var(--accent); opacity: 0.45; }
```

## Accessibility

The fixed rail is `aria-hidden="true"` (like `.file-tree-ai-col`) — it is a visual gutter, and the spoken signal belongs in reading order on the row itself. In `FileCell` (the file-row component inside `FileTree.tsx`), after the existing status-word and filename (and before/around the existing sr-only AI-focus text), add an sr-only span when the file has threads:

- unresolved → `" has unresolved comments"`
- resolved → `" comments resolved"`

So screen-reader reading order stays: *status word → filename → AI focus → comment state*. The accent dim on the resolved glyph is decorative; the sr-only text carries the resolved/unresolved distinction non-visually (no color-only signal — WCAG 1.4.1). The unresolved glyph at solid `--accent` clears ≥3:1 against `--surface-1` in both themes (it is the same accent used for the AI dot, already gate-verified); the resolved glyph is supplementary, its meaning mirrored in text.

**Resolved-glyph legibility on row backgrounds (verify at implementation).** The dimmed resolved glyph (`--accent` @ 0.45) was approved against the resting `--surface-1` only. Its worst case is a **selected** row, whose wash is `color-mix(in oklch, accent-soft 40%, surface-2)` — a same-hue accent tint that can swallow a low-opacity accent glyph and make *resolved* visually collapse into the *none* (blank) state, precisely when the reviewer has the row open. The hover background (`--surface-3`) is a milder case. Requirement: the resolved glyph must stay visibly distinguishable from a blank slot on **rest, hover, and selected** rows in **both** themes. Verify live during implementation; if 0.45 fails on the selected wash, raise the floor opacity (or swap the opacity dim for a hue/stroke cue) until it passes. The owner-approved *value* is the at-rest treatment; this requirement guards it, it does not override it.

**Forced-colors / Windows High Contrast (deferred, app-wide).** The only visual difference between unresolved and resolved is opacity on one hue, which forced-colors mode can flatten — leaving sighted high-contrast users without a visual resolved/unresolved distinction (the sr-only text still serves SR users). No PRism component currently handles `forced-colors`, so this is a pre-existing app-wide gap, not unique to this feature; deferred here for a future codebase-wide pass rather than solved one-off.

## Edge cases

- **Optimistic just-posted comment:** a thread that exists only as a local optimistic insert (not yet in `reviewComments`) does not flip the glyph until the refetch lands. Acceptable and consistent with the issue ("updates as `reviewComments` changes"); the diff itself already shows the optimistic card.
- **Thread on a path not in the current file list** (e.g. a thread anchored to a file absent from the selected diff range): it simply has no row to annotate — harmless, the map entry is unused.
- **Deleted file with threads:** renders the glyph normally on the deleted-file row; resolved/unresolved is still meaningful.
- **Mixed resolved + unresolved on one file:** `unresolved` wins (actionable state surfaces).

## Testing plan (TDD)

Unit (vitest + RTL):
1. `CommentGlyph` renders the SVG with `aria-hidden` and inherits `currentColor`.
2. `InboxRow` still renders the comment count + glyph after the swap (no visual/behavior regression).
3. Per-file state derivation: `none` (no threads), `unresolved` (≥1 open), `resolved` (all resolved), mixed ⇒ `unresolved`.
4. `FileTree` renders a glyph slot with the correct state class for each file; directory rows get a bare slot; the four columns stay row-aligned (slot count === file-row count).
5. Rail collapses (`data-has-comments='0'`) when no threads; expands when ≥1.
6. sr-only comment-state text present and in correct reading order; AI-focus and viewed-checkbox slots unchanged (no regression to #492 alignment).
7. Reactivity: re-render with a thread flipped resolved→unresolved updates the class.
8. Synthetic-hscroll (#214, extends `FileTree.scrollbar.test.tsx`): the `.fileTreeHScrollRow` carries a leading spacer of `--comment-col-w` when `data-has-comments='1'` and `0` when `'0'`, so the bar stays aligned under `.fileTreeScroll`.

Playwright (B1 visual proof, both themes): a PR with all three states; screenshots in `## Proof`. Include at least one frame with a **resolved** glyph on a **selected** row (and a hovered row) so the contrast requirement above is visually proven, not just asserted.

## Deviations from issue acceptance criteria

The issue AC says "show a comment indicator … **with the count**." Per owner direction (2026-07-01) the count is **dropped** in favor of three discrete states (none / unresolved / resolved). Rationale: in a narrow left rail a number adds width and noise; the actionable signal is "is there open discussion here," which the solid-vs-dimmed accent conveys without a count. Recorded here and to be reflected in the issue/PR `## Proof`.

## Out of scope (follow-ups)

- **Click-to-jump** to a file's first thread (interaction). Filing as a follow-up if wanted.
- **Outdated-thread** distinction (anchorSha drift).
- **Comment count** numerals, should they ever be wanted back.
