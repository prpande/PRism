# Font-size control for PR-detail content — design

- **Issue:** [#135](https://github.com/prpande/PRism/issues/135) — Settings: font-size control for PR-detail content (comments, description, overview, diffs)
- **Date:** 2026-06-07
- **Tier / Risk:** T3 (cross-cutting backend + frontend + CSS vertical slice) / **B1** (UI-visual — human visual sign-off before merge)
- **Status:** Design — approved by owner, pending spec review gate

## Problem

PR-detail content (the Overview description, root comments, inline comments, draft
bodies, and the diff code text) renders at one fixed size. Readers who want larger
or denser text have no control. The ask: a Settings control that scales **only the
PR-detail content text**, leaving every other surface (Inbox, Settings itself,
navigation, and all chrome) untouched.

## Scope

In scope — these surfaces scale:

- Overview description (`PrDescription`)
- Root / conversation comments (`PrRootConversation`)
- Inline diff comments (`ExistingCommentWidget`)
- Draft bodies and composer preview (`DraftListItem`, `ComposerMarkdownPreview`)
- Markdown file view (`MarkdownFileView`)
- **Diff code text** (the `.diffTable` body — code lines + gutter line numbers)

Also scales (content authored/previewed in the Submit flow, all via `MarkdownRenderer`):

- Submit-dialog PR-root body preview (`SubmitDialog` → `MarkdownRenderer`, no className)
- Pre-submit validator messages (`PreSubmitValidatorCard`, renders `.markdown-body`)

These live in the Submit modal but are PR *content*, not chrome — the B1 reviewer
should expect them to scale and not flag a scaled Submit preview as a regression.

Explicitly **out** of scope — these stay fixed at all settings:

- Inbox, Settings, the welcome/setup flows, the app header/nav
- All chrome *inside* PR-detail: file tree, compare picker, diff-settings menu,
  iteration tab strip, commit multi-select, drafts-tab headers/buttons, toolbars,
  the diff-pane header/path label, and `@@` hunk-header markers
- **AI summary / hotspot text** (`AiSummaryCard`) — renders plain text (not
  `MarkdownRenderer`) and inherits `var(--text-sm)` with no `--content-scale` hook.
  This is an AI-preview feature on a parallel track, outside the owner's enumerated
  scope (overview/comments/diffs). Left fixed deliberately; can be folded in later
  with a one-line hook on `.aiSummaryBody` if desired. **(Open question — see below.)**

> **Note — issue body has stale paths.** #135 references
> `frontend/src/components/Settings/AppearanceSection.tsx` and
> `frontend/src/styles/applyTheme.ts`, neither of which exists. The real files are
> `frontend/src/components/Settings/panes/AppearancePane.tsx` and
> `frontend/src/utils/applyTheme.ts`. The plan must use the real paths.

## Why surgical scaling (not a region-wide token override)

The obvious-but-wrong approach is to redefine the `--text-*` size tokens on a
PR-detail wrapper (`[data-content-scale] { --text-sm: …; }`). That fails because
**chrome inside PR-detail consumes the same `--text-*` tokens as content** — the
file tree, toolbars, pickers, and tab strip would all grow/shrink with the content.
The scaling must therefore be **surgical**: a dedicated multiplier variable consumed
*only* by the enumerated content text hooks, never by chrome.

## Architecture

A single CSS custom property `--content-scale` (default `1`) drives all scaling.
A `data-content-scale` attribute on `<html>` selects the multiplier; content hooks
multiply their font-size by it. The middle step writes **no attribute**, so it
resolves to `1` — i.e. today's exact rendering, and existing visual baselines are
untouched.

This mirrors the existing `density` mechanism end-to-end (`data-density` attribute on
`<html>`, applied by `applyDensityToDocument`, synced by `AppearanceSync`, persisted
as a `ui.*` string), so every layer has a proven sibling to copy.

### CSS (tokens.css + DiffPane.module.css)

```css
/* tokens.css */
:root { --content-scale: 1; }
[data-content-scale="xs"] { --content-scale: 0.8; }
[data-content-scale="s"]  { --content-scale: 0.9; }
[data-content-scale="l"]  { --content-scale: 1.2; }
[data-content-scale="xl"] { --content-scale: 1.4; }
/* "m" (Default) → no attribute → falls through to :root → 1 (no-op) */

/* Prose hook — single global class wrapping ALL rendered prose. It carries no
   font-size today (inherits), so 1em == today's inherited size: scale 1 is a
   true no-op, and each context (comment card, overview, draft) keeps its base. */
.markdown-body { font-size: calc(1em * var(--content-scale)); }
```

```css
/* DiffPane.module.css — .diffTable already pins font-size: var(--text-sm) and
   every code cell (.diffContent) + gutter inherits from it. One multiply scales
   the whole diff body; chrome (header/path/hunk-header) keeps its own tokens. */
.diffTable { font-size: calc(var(--text-sm) * var(--content-scale)); }
```

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
  `ExistingCommentWidget` (`.commentBody var(--text-sm)`), `MarkdownFileView`,
  drafts/composer all set font-size on a **parent** of the markdown-body element.
  `1em` resolves against that parent base → scale 1 reproduces today's size and the
  multiply scales correctly. **The parent re-pin is load-bearing**: e.g.
  `.commentBody { font-size: var(--text-sm) }` resets the cascade (these comments sit
  *inside* `.diffTable`, which is itself scaled) so `.markdown-body`'s single multiply
  is the *only* scaling applied — do not remove it during any cleanup.

- **Same-element collision (must fix — C1):** `PrDescription.tsx:31` passes
  `className={styles.prDescriptionBody}`, and `.prDescriptionBody` pins
  `font-size: var(--text-sm)` on the **same element** as `.markdown-body`. Equal
  specificity (0,1,0); the CSS-module rule is injected after `tokens.css` (documented
  in `AiSummaryCard.module.css:6-7`) so it **wins** and the description would not scale.
  **Fix:** move `font-size: var(--text-sm)` off `.prDescriptionBody` onto PrDescription's
  parent wrapper, so the element carries only `.markdown-body` and `1em` resolves
  against the wrapper's `var(--text-sm)` (scale-1 no-op preserved, scaling restored).
  This makes PrDescription match the parent-pinned pattern the other five already use.

- **Inline `code` inside prose (must fix — I1):** `.prDescriptionBody code` and
  `.body code` pin a literal `font-size: 12px`, so inline code would stay fixed while
  surrounding prose scales. Change these to a **relative** `font-size: 0.92em` so inline
  code tracks the scaled prose. (Corrects the earlier "no pinned px" assumption.)

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

CSS: data-content-scale → --content-scale → .markdown-body / .diffTable multiply font-size
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
- **Playwright B1 visual proof:** PR-detail at XS / Default / XL — assert content scales
  while chrome (file tree, toolbars, tab strip, diff header, `@@` hunk markers) stays
  fixed. Cover each in-scope surface *individually* so a same-element collision can't
  hide: **assert the Overview description's computed font-size actually changes** (the C1
  regression site) — not just the comments — plus a comment, a draft, and the diff code.
  **Verify the split-diff synthetic h-scrollbar (`useLockedPaneScroll`) still tracks
  correctly at non-default scales** — font-size changes line widths, and the scrollbar
  spacer must recompute. Screenshot the slider at all five steps and confirm the thumb
  visually sits over each "a" glyph.

## Risks / open verification

1. **Overview description same-element collision (C1)** — `.prDescriptionBody` pins
   font-size on the same element as `.markdown-body` and wins the equal-specificity
   cascade. Fixed by moving the pin to the parent wrapper (see Per-surface contract).
   The B1 proof asserts the description's computed size changes, so a silent regression
   here can't ship.
2. **Diff h-scroll at scale ≠ 1** — `useLockedPaneScroll` measures real `scrollWidth`,
   so it *should* adapt; flagged as an explicit B1 check rather than assumed.
3. **Inline `code` is pinned to literal 12px** in `.prDescriptionBody code` / `.body code`
   — converted to relative `0.92em` so it tracks scaled prose (see Per-surface contract).
   Markdown headings carry no pinned px (confirmed: no `.markdown-body h1{font-size:…}`
   in tokens.css), so they scale via the `1em` multiply already.
4. **Slider thumb ↔ glyph alignment** — native range UA end-padding means the thumb
   center doesn't reach the track's pixel edges; the five glyphs are a legend beneath
   the track, so alignment is approximate. B1 polish item — pad the glyph row to the
   thumb's reachable range if it drifts.
5. **Line-height** — `.diffTable` line-height is unitless (`1.55`), so it scales with
   font-size automatically; no separate adjustment needed.

## Open question for owner

- **Should AI summary / hotspot text scale too?** It's PR-detail content but renders via
  `AiSummaryCard` (plain text, not `MarkdownRenderer`) and was not in the enumerated scope.
  Current design leaves it fixed. Including it is a one-line CSS hook on `.aiSummaryBody`
  if the owner wants it in. **Default: leave fixed unless told otherwise.**

## Out of scope (YAGNI)

- Per-surface independent sizing (one global content scale only).
- A reset button (Default is the centered step — drag back to it).
- Syncing scale across devices/accounts (config.json is local, like all `ui.*`).
