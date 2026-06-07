# Font-size control for PR-detail content — design

- **Issue:** [#135](https://github.com/prpande/PRism/issues/135) — Settings: font-size control for PR-detail content (comments, description, overview, diffs)
- **Date:** 2026-06-07
- **Tier / Risk:** T3 (cross-cutting backend + frontend + CSS vertical slice) / **B1** (UI-visual — human visual sign-off before merge)
- **Status:** Design — approved by owner (scope = all data, Option 2: chrome fixed), pending spec review gate

## Problem

PR-detail data renders at one fixed size. Readers who want larger or denser text have
no control. The ask: a Settings control that scales **all the data displayed across
the PR-detail tabs** (Overview / Files / Drafts), while the interactive and
navigational **chrome stays fixed** (owner decision — "Option 2"). Everything outside
PR-detail (Inbox, Settings, welcome/setup, app header/nav) is untouched.

## Scope

The rule: **content/data text inside the PR-detail tab panels scales; chrome does
not.** "Chrome" = interactive or navigational UI *around* the data (tab strips,
toolbars, pickers, menus, buttons, file-tree controls, the PR header, banners).

In scope — these data surfaces scale, per tab:

**Overview tab** (`OverviewTab`)
- PR title + description (`PrDescription`)
- AI summary text (`AiSummaryCard` / `.aiSummaryBody`)
- Stats-tile values + labels (`StatsTiles`)
- Root / conversation comments incl. author + timestamp metadata (`PrRootConversation`)

**Files tab** (`FilesTab`)
- Diff code text (the `.diffTable` body — code lines + gutter line numbers)
- Inline diff comments incl. metadata (`ExistingCommentWidget`)
- AI hunk annotations (`AiHunkAnnotation`)
- Rendered markdown file view (`MarkdownFileView`)

**Drafts tab** (`DraftsTab`)
- Draft bodies + composer preview (`DraftListItem`, `ComposerMarkdownPreview`)

**Submit flow** (modal, but PR content authored via `MarkdownRenderer`)
- Submit-dialog PR-root body preview (`SubmitDialog`)
- Pre-submit validator messages (`PreSubmitValidatorCard`)

Explicitly **out** of scope — chrome stays fixed at all settings:

- Inbox, Settings, the welcome/setup flows, the app header/nav (outside PR-detail)
- **`PrHeader`** (the PR-detail title bar / metadata strip above the tabs) — it is the
  view's header chrome, not tab data. (Note: the PR *title* also appears in-tab via
  `PrDescription`; the in-tab copy scales, the header copy does not.)
- All chrome *inside* the tab panels: `PrSubTabStrip`, file tree (`FileTree`),
  `ComparePicker`, `DiffSettingsMenu`, `DiffViewToggle`, `IterationTabStrip`,
  `CommitMultiSelectPicker`, the Files toolbar, drafts-tab headers/buttons
  (`DiscardAllStaleButton`, `MarkAllReadButton`, `ReviewFilesCta`), the diff-pane
  header/path label, and `@@` hunk-header markers

**Boundary cases flagged for the review + B1 sign-off** (defaults below; reviewer to
pressure-test, owner to confirm at the visual gate):
- *File-tree file names* — data, but live in a navigation pane. **Default: fixed**
  (treated as chrome, like a sidebar).
- *Comment author / timestamp metadata* — **Default: scales** with its comment (it's
  part of the comment's data block, not a global control).
- *Stats-tile labels* (e.g. "Files", "Threads") vs values — **Default: both scale**
  (the whole tile is overview data).

> **Note — issue body has stale paths.** #135 references
> `frontend/src/components/Settings/AppearanceSection.tsx` and
> `frontend/src/styles/applyTheme.ts`, neither of which exists. The real files are
> `frontend/src/components/Settings/panes/AppearancePane.tsx` and
> `frontend/src/utils/applyTheme.ts`. The plan must use the real paths.

## Why a surgical multiplier (not a region-wide token override)

Two mechanisms could deliver Option 2 ("data scales, chrome fixed"):

1. **Region token override + freeze chrome** — redefine the `--text-*` size tokens on
   the PR-detail tab-panel container so everything under it scales, then *reset* the
   tokens back to base on every chrome component. Rejected: chrome and content share
   the `--text-*` tokens, and CSS custom-property inheritance computes a var's value at
   the element that *sets* it — so "un-scaling" chrome means re-declaring the full
   `--text-*` set on each chrome root, not just flipping the multiplier. That is
   verbose, and any chrome added to a tab later silently scales until someone freezes it.

2. **Surgical multiplier (chosen)** — a dedicated `--content-scale` variable consumed
   *only* by the enumerated content text hooks. Chrome uses the bare `--text-*` tokens
   and therefore **stays fixed for free** — there is nothing to freeze, and new chrome
   never accidentally scales. The maintenance cost (a content surface must opt in via a
   hook) is small because `.markdown-body` is a single universal hook covering *all*
   rendered prose across every tab; only a handful of non-markdown data surfaces
   (AI summary, stats tiles, AI hunk annotations, diff code) need their own hook.

The residual risk of mechanism 2 is **missing a data surface** (it won't scale until
hooked) — which is exactly what the adversarial doc-review pass and the per-surface B1
assertions are charged with catching.

## Architecture

A single CSS custom property `--content-scale` (default `1`) drives all scaling.
A `data-content-scale` attribute on `<html>` selects the multiplier; content hooks
multiply their font-size by it. The middle step writes **no attribute**, so it
resolves to `1` — i.e. today's exact rendering, and existing visual baselines are
untouched.

This mirrors the existing `density` mechanism end-to-end (`data-density` attribute on
`<html>`, applied by `applyDensityToDocument`, synced by `AppearanceSync`, persisted
as a `ui.*` string), so every layer has a proven sibling to copy.

### CSS content hooks

The multiplier var is global; each content surface multiplies its own font-size by it.
All other elements keep the bare token and stay fixed.

```css
/* tokens.css — selector + multiplier mapping (single source of truth) */
:root { --content-scale: 1; }
[data-content-scale="xs"] { --content-scale: 0.8; }
[data-content-scale="s"]  { --content-scale: 0.9; }
[data-content-scale="l"]  { --content-scale: 1.2; }
[data-content-scale="xl"] { --content-scale: 1.4; }
/* "m" (Default) → no attribute → falls through to :root → 1 (no-op) */

/* Prose hook — single global class wrapping ALL rendered prose (description,
   comments, drafts, file view, submit preview, validator). It carries no font-size
   today (inherits), so 1em == today's inherited size: scale 1 is a true no-op, and
   each context keeps its base. Covers the majority of in-scope surfaces in one rule. */
.markdown-body { font-size: calc(1em * var(--content-scale)); }
```

The non-markdown data surfaces each get a one-line multiply, `calc(<token> *
var(--content-scale))`, so scale 1 is a no-op. **The hook must be the element that
actually carries the `font-size` today** — several of these pin on a container whose
children inherit, so hook the container (children scale for free). Exact targets,
verified against the module CSS:

| Surface | Element to hook (carries the pin) | Token → scaled | Notes |
|---------|-----------------------------------|----------------|-------|
| Diff code (lines + gutter) | `DiffPane.module.css` `.diffTable` | `var(--text-sm)` | `.diffContent`/`.diffGutter` inherit → code + line numbers scale together |
| AI summary body | `AiSummaryCard.module.css` `.aiSummaryCard` | `var(--text-sm)` | body has no own pin → inherits from the card → scales |
| AI summary category | `AiSummaryCard.module.css` `.aiSummaryCategory` | `var(--text-xs)` | own pin (data) → scale it separately. The `.aiSummaryChip` ("AI preview — sample…") is a disclaimer label and **stays fixed by design** |
| Stats tile value | `StatsTiles.module.css` `.statsTileValue` | `var(--text-2xl)` | two separate pins → two edits |
| Stats tile label | `StatsTiles.module.css` `.statsTileLabel` | `var(--text-xs)` | |
| AI hunk annotation | `AiHunkAnnotation.module.css` `.aiHunk` (root) | `var(--text-xs)` | body `<div>` is classless and inherits from `.aiHunk`; hook the root. The severity `.chip` ("Behavior change") keeps its own fixed size (status indicator) — **intentionally fixed** |
| In-tab PR title | `PrDescription.module.css` `.prDescriptionTitle` | `var(--text-md)` | **renders only when `aiPreview=false`** — see Per-surface contract |
| Raw markdown file view | `MarkdownFileView.module.css` `.markdownRaw` | `var(--text-sm)` | the Rendered path uses `.markdown-body`; the Raw `<pre>` is a separate pin (raw source = file data, scales like code) |
| Root-comment metadata (author/time) | `PrRootConversation.module.css` `.band` | `var(--text-xs)` | **⚠ PENDING owner decision (I-A):** scaling this de-aligns the accent rail node (`--rail-node-y` is tuned to the fixed 24px avatar center). If "scale," `--rail-node-y` must become scale-aware; if "fixed," drop this row. |
| Inline-comment metadata (author/time) | `ExistingCommentWidget.module.css` `.commentMeta` | `var(--text-xs)` | **⚠ PENDING owner decision (I-A):** sibling of `.commentBody`; pairs with the row above |

Chrome (`.diffPaneHeader`, `.diffPanePath`, `.diffHunkHeader`, tab strip, toolbars,
file-tree controls, `PrHeader`) pins its own tokens and is **not** in this list, so it
stays fixed with zero extra work.

**Steps (5, Default centered):** `xs 0.8× · s 0.9× · m 1.0× (Default) · l 1.2× · xl 1.4×`.
The down-steps (0.1 apart) are gentler than the up-steps (0.2 apart) **intentionally**:
enlarging is the common need, so the upward range reaches further (+40%) while the
downward range stays conservative (−20%) to keep small text legible. Do not "correct"
this to a uniform spread.

### Per-surface scaling contract (cascade caveats)

`.markdown-body` is composed onto its element by `MarkdownRenderer.tsx:130` as
`markdown-body ${className}`. Whether `calc(1em * var(--content-scale))` is a true
no-op at scale 1 depends on **where** each consumer pins its font-size:

- **Parent-pinned (correct as-is):** `PrRootConversation` (`.body` 13px),
  `ExistingCommentWidget` (`.commentBody var(--text-sm)`), `MarkdownFileView` (rendered
  path), drafts/composer set font-size on a **parent** of the markdown-body element.
  `1em` resolves against that parent base → scale 1 reproduces today's size and the
  multiply scales correctly. **The parent re-pin is load-bearing**: e.g.
  `.commentBody { font-size: var(--text-sm) }` resets the cascade (these comments sit
  *inside* `.diffTable`, which is itself scaled) so `.markdown-body`'s single multiply
  is the *only* scaling applied — do not remove it during any cleanup.

- **Same-element collision (must fix — C1):** `PrDescription.tsx:31` passes
  `className={styles.prDescriptionBody}`, and `.prDescriptionBody` pins
  `font-size: var(--text-sm)` on the **same element** as `.markdown-body`. Equal
  specificity (0,1,0); the CSS-module rule is injected after `tokens.css` (documented
  in `AiSummaryCard.module.css:6-7`) so it **wins** and `.markdown-body`'s multiply is
  overridden — the description would not scale.
  **Fix (revised):** rather than relocating the pin to a parent (PrDescription's only
  wrapper is a `<section class="overview-card pr-description">` with no module class and
  a sibling title — awkward), make the **winning** rule itself scale:
  `.prDescriptionBody { font-size: calc(var(--text-sm) * var(--content-scale)); }`.
  It already wins on that element, so it carries the scale directly — no parent-move, no
  new wrapper class, scale-1 no-op preserved (`var(--text-sm)`). **Apply this same
  "scale the winning consumer class" recipe to any other same-element collision**, e.g.
  verify `ComposerMarkdownPreview` (`.composerMarkdownPreview var(--text-sm)`, M-B): if
  its class is composed onto the markdown-body element, scale that class; if it wraps a
  separate `<MarkdownRenderer>`, it's parent-pinned and needs nothing.

- **In-tab PR title (must hook — I-D):** `.prDescriptionTitle` pins `var(--text-md)` and
  is a **sibling** of the body (not under `.markdown-body`), so it needs its own multiply:
  `calc(var(--text-md) * var(--content-scale))`. It renders **only when
  `aiPreview=false`** (`PrDescription.tsx:27`); when AI preview is on, the title shows
  only in `PrHeader` (out of scope, fixed). The B1 title assertion must use an
  `aiPreview=false` fixture.

- **Inline `code` inside prose (must fix — I1):** `.prDescriptionBody code` (literal
  `12px`), `.body code` (literal `12px`), and `.draftListItemPreview code`
  (`var(--text-xs)`, M-A) all pin an absolute size, so inline code would stay fixed while
  surrounding prose scales. Change all three to a **relative** `font-size: 0.92em` so
  inline code tracks the scaled prose. (Corrects the earlier "no pinned px" assumption.)

### Persistence (mirrors `density`)

New `ui.contentScale` — a string enum `'xs' | 's' | 'm' | 'l' | 'xl'`, default `'m'`.

| Layer | File | Change |
|-------|------|--------|
| Domain record | `PRism.Core/Config/AppConfig.cs` | `UiConfig` += `string ContentScale = "m"`; update default ctor |
| Patch store | `PRism.Core/Config/ConfigStore.cs` | register `contentScale` → `ConfigFieldType.String` in the field-type map; add `with { Ui = ui with { ContentScale = (string)value! } }` patch case |
| Wire DTO | `PRism.Web/Endpoints/PreferencesDtos.cs` | `UiPreferencesDto` += `string ContentScale` |
| Endpoint map | `PRism.Web/Endpoints/PreferencesEndpoints.cs` | include `ui.ContentScale` in the GET projection |
| FE types | `frontend/src/api/types.ts` | add `ContentScale` type alias + `UiPreferences.contentScale` field |

Validation is **type-only** (String), not enum-membership — matching `density`
(plan Deviation 6 precedent). An out-of-band `config.json` edit could yield an
arbitrary string; the applier (below) is defensive against that.

### Apply path (mirrors `applyDensityToDocument`)

New `applyContentScaleToDocument(value: ContentScale)` in `applyTheme.ts`:

```ts
export function applyContentScaleToDocument(value: ContentScale): void {
  if (typeof document === 'undefined') return; // SSR/test guard
  // 'm' (and any unrecognized string) → remove attribute → :root default (1×).
  if (value === 'xs' || value === 's' || value === 'l' || value === 'xl') {
    document.documentElement.setAttribute('data-content-scale', value);
  } else {
    document.documentElement.removeAttribute('data-content-scale');
  }
}
```

`AppearanceSync` (the headless on-load/on-change applier) calls it from its
`[preferences]` effect alongside theme/density. This keeps the multiplier mapping
as a single source of truth **in CSS** — the applier only sets the selector.

### Control widget — `FontSizeSlider` (new control primitive)

A new component in `frontend/src/components/controls/FontSizeSlider.tsx`, added as a
new row in `AppearancePane` under Density.

- A native `<input type="range" min="0" max="4" step="1">` — gives keyboard
  (arrow keys), drag, and focus handling for free.
- Beneath the track, **five "a" glyphs as tick marks, growing left → right** as the
  visual size legend. No text labels.
- A11y: `aria-label="Content font size"`; `aria-valuetext` set to the step's human
  name (`Extra small · Small · Default · Large · Extra large`) so screen readers
  announce a meaningful value rather than a bare `0–4`.

**Enum ↔ index binding.** A single ordered constant is the source of truth for both
directions — the slider is controlled by the index of the current enum value, and
`onChange` maps the index back to the enum. The component never holds its own state:

```ts
const SCALE_ORDER = ['xs', 's', 'm', 'l', 'xl'] as const; // index 0–4, 'm' at center (2)

// controlled value:
value={SCALE_ORDER.indexOf(props.value)}
// onChange:
onChange={(e) => props.onChange(SCALE_ORDER[Number(e.target.value)])}
```

**PATCH-per-drag is acceptable — no debounce.** A range input fires `onChange` on every
step crossing, but with `step=1` over a 5-position range a full drag crosses at most
~4 integer boundaries → ~4 `PATCH /api/preferences` calls worst case. That matches the
existing **undebounced** `SegmentedControl` density path (a few clicks = a few PATCHes),
so no debounce machinery is added. Keyboard arrow steps are one PATCH each, same as today.

`AppearancePane` wires it with the established optimistic-apply-with-rollback pattern,
capturing the prior value *before* the optimistic write (mirrors the density handler at
`AppearancePane.tsx:35-41`, including the defensive coercion of an off-enum persisted value):

```ts
const contentScale: ContentScale = SCALE_ORDER.includes(preferences.ui.contentScale)
  ? preferences.ui.contentScale
  : 'm';
const onContentScale = (value: ContentScale) => {
  const prior = contentScale; // captured before the optimistic DOM write
  applyContentScaleToDocument(value);
  void set('contentScale', value).catch(() => applyContentScaleToDocument(prior));
};
```

## Data flow

```
User drags slider (AppearancePane)
  → applyContentScaleToDocument(value)          // optimistic: set data-content-scale on <html>
  → set('contentScale', value)                  // PATCH /api/preferences
        ↓ success                                   ↓ failure
   ConfigStore persists ui.contentScale         catch → applyContentScaleToDocument(prior)  // rollback
   (config.json)                                + usePreferences reverts its own state + toast

On load / any preference change:
  AppearanceSync effect → applyContentScaleToDocument(preferences.ui.contentScale)

CSS: data-content-scale → --content-scale → content hooks (.markdown-body, .diffTable,
     .aiSummaryBody, StatsTiles, AiHunkAnnotation, PR title) multiply font-size; chrome
     uses bare --text-* tokens and stays fixed
```

## Error handling

- **Failed PATCH:** optimistic DOM write is rolled back to the prior scale; the
  shared `usePreferences.set` reverts its own state and surfaces an error toast
  (same as theme/accent/density).
- **Unrecognized persisted value** (hand-edited config): `applyContentScaleToDocument`
  removes the attribute → renders at Default (1×), keeping the visible state coherent.
- **Backend backward-compat:** a `config.json` written before this field exists loads
  with the record default `"m"` — no migration needed (covered by a load-default test).

## Testing

- **Backend (`tests/PRism.Core.Tests/Config/...`):** clone the `density` patch tests —
  round-trip each valid `contentScale` string; reject null/bool/int (type validation);
  back-compat default load yields `"m"`.
- **`applyContentScaleToDocument` unit test:** sets `data-content-scale` for the four
  off-default values; removes it for `'m'` and for an unrecognized string; SSR guard.
- **`FontSizeSlider` component test:** renders 5 steps + 5 "a" glyphs; `onChange` fires
  the mapped enum on slider input; keyboard arrows move steps; `aria-label` /
  `aria-valuetext` present.
- **`AppearancePane` test:** slider row present and bound to `preferences.ui.contentScale`;
  change calls `set('contentScale', …)`; optimistic apply + rollback on rejected set.
- **Playwright B1 visual proof (all three tabs):** at XS / Default / XL, assert each
  in-scope data surface's computed font-size actually changes, *per surface* (a single
  "content scaled" eyeball would hide a missed hook like C1):
  - Overview: PR title (use an `aiPreview=false` fixture — title only renders then) +
    description (C1 site), AI summary block, a stats tile (value **and** label), a root
    comment **including its author/timestamp metadata** (`.band`)
  - Files: diff code, an inline comment **incl. its `.commentMeta`**, AI hunk annotation,
    a markdown file in **both Rendered and Raw** views
  - Drafts: a draft body
  And assert chrome stays **fixed**: tab strip, Files toolbar, file-tree names (boundary
  default = fixed), diff-pane header/path, `@@` hunk markers, `PrHeader` title/metadata.
  **Verify the split-diff synthetic h-scrollbar (`useLockedPaneScroll`) still tracks
  correctly at non-default scales** — font-size changes line widths, and the scrollbar
  spacer must recompute. Screenshot the slider at all five steps; confirm the thumb sits
  over each "a" glyph.

## Risks / open verification

1. **Overview description same-element collision (C1)** — `.prDescriptionBody` wins the
   equal-specificity cascade over `.markdown-body`, so the fix scales *that* class
   directly (see Per-surface contract). The B1 proof asserts the description's computed
   size changes, so a silent regression here can't ship.
2. **Diff h-scroll at scale ≠ 1** — `useLockedPaneScroll` measures real `scrollWidth`,
   so it *should* adapt; flagged as an explicit B1 check rather than assumed.
3. **Inline `code` is pinned** in `.prDescriptionBody code` / `.body code` (literal 12px)
   and `.draftListItemPreview code` (`var(--text-xs)`) — all converted to relative
   `0.92em` so code tracks scaled prose (see Per-surface contract). Markdown headings
   carry no pinned px (confirmed: no `.markdown-body h1{font-size:…}` in tokens.css), so
   they scale via the `1em` multiply already.
4. **Slider thumb ↔ glyph alignment** — native range UA end-padding means the thumb
   center doesn't reach the track's pixel edges; the five glyphs are a legend beneath
   the track, so alignment is approximate. B1 polish item — pad the glyph row to the
   thumb's reachable range if it drifts.
5. **Line-height** — `.diffTable` line-height is unitless (`1.55`), so it scales with
   font-size automatically; no separate adjustment needed.
6. **Comment rail-node alignment (I-A) — PENDING owner decision.** If comment
   author/time metadata scales (`.band` / `.commentMeta`), the band's optical center
   shifts relative to the fixed-px avatar, so `--rail-node-y`
   (`PrRootConversation.module.css:49`, tuned to the 24px avatar) would need to become
   scale-aware, and B1 must verify the accent node still centers on the band at XS/XL.
   If metadata stays fixed, this risk is void. See the Open question below.

## Open question for owner (I-A)

**Should comment author/timestamp metadata scale, or stay fixed?** It's data, but it sits
in a fixed-24px-avatar identity row, and scaling it (a) mismatches the unscaled avatar and
(b) de-aligns the accent rail node (`--rail-node-y` is tuned to the avatar center; the CSS
warns against changing `--text-xs` there). **Recommendation: keep metadata fixed** — scale
the comment *body* (the content you read) but treat the author/avatar/time as a fixed
identity header (like the avatar itself). This avoids both the visual mismatch and the
rail-node re-tuning. If you'd rather it scale, the plan makes `--rail-node-y` scale-aware
and B1 verifies node alignment at every step.

## Out of scope (YAGNI)

- Per-surface independent sizing (one global content scale only).
- A reset button (Default is the centered step — drag back to it).
- Syncing scale across devices/accounts (config.json is local, like all `ui.*`).
- Scaling chrome (tab strip, toolbars, header) — owner chose Option 2 (data only).
