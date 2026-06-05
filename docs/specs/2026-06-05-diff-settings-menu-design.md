# Files-tab Diff Settings menu + inline diff-view tiles + global "Show full file" — design

**Issue:** [#185](https://github.com/prpande/PRism/issues/185) — _Files tab: convert
diff-toolbar text toggles to compact icon-based controls (toolbar real estate
doesn't scale as features grow)_

**Tier / Risk:** T3 — gated **B1 (UI-visual)**. Pure frontend view state; no B2
risk surface (no auth/PAT, submit pipeline, persisted schema, cross-tab stamp,
desktop sidecar, or security surface).

## Problem

The Files-tab diff toolbar (`frontend/src/components/PrDetail/FilesTab/FilesTab.tsx:427-473`)
renders three full-text toggle buttons:

- **Side-by-side ↔ Unified** (`diffMode`)
- **Show full file ↔ Hunks only** (`wholeFileEnabled`)
- **Wrap long lines** (`lineWrap`)

…right-aligned (`margin-left:auto`) next to the iteration tab strip / commit
picker. The controls carry **inconsistent label semantics** today: `diffMode`
shows the *current* mode, `wholeFile`'s label *flips* with state (which the code
comment at `FilesTab.tsx:469-471` notes contradicts `aria-pressed` for assistive
tech), `lineWrap` is a stable label.

**On scaling — this is a forward investment, not present-pain relief.** At three
controls on PRism's fixed wide desktop viewport, the toolbar is *not* crowded
today. The consolidation pre-pays for the anticipated control set (#184 proposes a
Source ↔ Rendered-Markdown toggle, "more coming") — a deliberate bet that room
later is worth the chrome change now.

A secondary, separately-reported pain: **"Show full file" is per-file.**
`wholeFilePaths` is a `Set<string>` of individually-toggled paths
(`FilesTab.tsx:65,134`), so switching files drops back to hunks unless that file
was also toggled. By contrast `diffMode` and `lineWrap` are already view-wide
booleans — the comment at `FilesTab.tsx:66` calls line-wrap "a view-wide
preference (like diffMode, not per-file)."

## Goal — hybrid layout

The maintainer's chosen shape (evolved during review from "hide everything in the
gear" once the hot-path ergonomics surfaced):

1. **Diff view (Split/Unified) stays inline** as a compact **two-tile segmented
   toggle** — always visible, one click. It is the most frequently flipped control
   in a review session; PRism's toggles are *instant client-side* state (unlike
   GitHub's, which trigger a server reload), so the hot path must not be buried.
   The tiles are GitHub-style illustrated thumbnails (the maintainer prefers the
   tile aesthetic), and are *more* compact than today's text buttons.
2. **A single ⚙ "Diff settings" gear → popover** holds the long-tail / set-and-
   forget controls — **Show full file** and **Wrap long lines** today, plus room
   for #184 and beyond. This is the growth valve that keeps the toolbar from
   accreting buttons, and a clean home for Show-full-file's several disabled/inert
   states (messy as a greyed toolbar button).
3. **"Show full file" becomes view-wide** — toggle once, every eligible file shows
   its full file on selection; no per-file re-toggling.
4. Preserve every existing accessibility and disabled-state guarantee; fix the
   label/`aria-pressed` inconsistency along the way.

Resulting toolbar: `[iteration strip / commit picker] … [Unified|Split tiles] [⚙]`.

### Non-goals / scope boundary

- **3 current controls only.** #184's markdown-diff toggle is "leave room for"
  (one future gear row), not built here. **No placeholder props, disabled rows,
  or comment stubs for #184** belong in this PR.
- **No backend/disk persistence.** Both the inline `diffMode` and the gear's
  `showFullFile`/`lineWrap` are in-memory component state. Precise boundary: they
  persist across file switches **within one PR-detail session** (the Files tab is
  keep-alive) and **reset on a fresh mount** — navigating to a different PR or
  remounting PR-detail resets them. Cross-PR / cross-session persistence is out of
  scope (it would creep into the preferences surface).
- **No full row of abstract inline icon-toggle buttons.** We keep exactly one
  inline control (the diff-view *illustrative* tiles, a labelled radiogroup), not
  a cluster of opaque icon buttons — the rejected reading of the issue title.
- **No shared popover hook in this PR.** Mirror the open/close mechanics in
  `DiffSettingsMenu` directly. Two consumers (the commit picker + this) is not a
  mandate to extract a `useDisclosure`/`usePopover` hook; defer until a third.

## Reference: what GitHub actually does

On the PR **Files changed** view, GitHub hides all view controls behind a single
**⚙ "Diff settings"** gear; its dropdown shows Unified / Split as illustrated radio
tiles, a Hide-whitespace checkbox, and "Apply and reload" (server re-render). We
take the **illustrated-tile aesthetic** and the **gear-as-growth-valve** idea, but
**diverge deliberately**: (a) PRism's toggles are instant, so there is no "Apply
and reload"; (b) because the diff-view toggle is instant and hot, we keep it
*inline* rather than inside the gear (GitHub can bury it because its toggle is a
heavy, infrequent reload). The gear holds the cheaper, set-and-forget controls.

## Approach

### Components

Two small, independently-testable components in
`frontend/src/components/PrDetail/FilesTab/`:

**`DiffViewToggle`** (inline) — a compact segmented `radiogroup` of two
illustrated tiles, **Unified** and **Split**. Always visible in the toolbar. Props:
`diffMode`, `onDiffModeChange(mode)` (sets the mode directly — a radio selects,
it does not toggle), `splitDisabled` (`viewportWidth < 900`),
`splitDisabledReason` (helper text/tooltip). Replaces the current `diffMode` text
button.

**`DiffSettingsMenu`** (gear popover) — a disclosure: gear trigger + a panel of
native checkboxes. Owns only its open/close interaction; values + handlers are
props. Replaces the current `wholeFile` and `lineWrap` text buttons.

**Reuse boundary (corrected).** `CommitMultiSelectPicker.tsx` is a *reference* for
the disclosure **shell only** — controlled `open` state,
`aria-expanded`/`aria-haspopup`/`aria-controls` wiring, `Escape`-to-close with
focus return to the trigger, and focus-into-panel on open. It does **not**
implement two mechanics this menu needs, which are therefore **net-new work, not a
copy-paste**:

1. **Outside-click close** — the picker has no document/window listener at all.
   `DiffSettingsMenu` must add a `mousedown`/`pointerdown` document listener with a
   `ref.contains` guard and cleanup on unmount/close.
2. **Focus return on *every* close path** — the picker returns focus to its
   trigger only on Escape. This menu must restore focus to the gear on Escape,
   outside-click, and re-click-to-close alike.

The picker's *interior* is a `role="combobox"`/`listbox`/`option` widget with
`aria-activedescendant` roving — none of that transfers; this menu's interior is
native checkboxes. These dismiss/focus mechanics are first-class plan tasks with
their own tests.

**Props — `DiffSettingsMenu`:**

| Prop | Type | Source in FilesTab |
|------|------|--------------------|
| `showFullFile` | `boolean` | new `showFullFile` state (the user preference) |
| `onShowFullFileChange` | `(on: boolean) => void` | new handler |
| `fullFileViewBlocked` | `boolean` | `!iterationGatePermits` — view-level gate that **disables** the control |
| `fullFileViewBlockedReason` | `string \| null` | helper text when view-blocked |
| `fullFileInertHere` | `boolean` | `showFullFile && currentFileIneligible` — control stays **enabled**, note shown |
| `fullFileInertReason` | `string \| null` | the mandatory "doesn't affect this file" note |
| `lineWrap` | `boolean` | `lineWrap` |
| `onLineWrapChange` | `(on: boolean) => void` | wraps `handleToggleLineWrap` |

The two full-file concepts are deliberately **separate props**: a *view-level
block* (disables the control) versus *current-file inertness* (control enabled,
explanatory note).

### Inline diff-view control (`DiffViewToggle`)

A horizontal segmented `radiogroup` (group label "Diff view") of two real
`<input type="radio">` inputs, each visually rendered as an **illustrated tile +
label**:

- Tile ~48×32px. **Unified** = three full-width horizontal bars; **Split** = two
  columns each with two half-width bars. All strokes/fills use **theme CSS
  variables** (never hardcoded) so they switch with dark/light.
- **Selected** = `2px solid var(--accent)` border (no fill swap); **hover** =
  subtle surface change on the unselected tile; **Split disabled** (viewport
  < 900px) = greyed thumbnail + greyed label + helper text/tooltip "Side-by-side
  needs a wider window."
- Checked radio = current mode; both tiles always visible convey the action target
  (two-state legibility). `Arrow` keys move within the radiogroup (native).
- Minimum clickable area per tile ≥ 24×24px (WCAG 2.5.8); the ~48×32 tile clears
  this.

### Gear popover (`DiffSettingsMenu`) contents & accessibility

Native form controls — settings, not commands — so **no** `role="menu"`.

- **Trigger:** a `<button>` with `aria-haspopup="true"`, `aria-expanded`,
  `aria-controls` → panel id, accessible name "Diff settings", `title` tooltip.
  Gear glyph `aria-hidden`. **Hit target ≥ 24×24px (WCAG 2.5.8); ~32×32px** visible
  via padding.
- **Active-state indicator (required).** Because the gear's settings are instant,
  silent, and survive keep-alive, the collapsed gear must signal when **Show full
  file or Wrap** is non-default (the inline diff-view tiles show their own state,
  so they are *not* part of this indicator; the forced-unified-below-900px case
  never counts). A small dot/badge on the gear **plus** an accessible-name change
  (e.g. `aria-label="Diff settings (modified)"` or a visually-hidden suffix) so
  screen-reader users get the same signal. Exact visual is a B1-gate detail.
- **Panel:** labelled container (`aria-label="Diff settings"`), `position:
  absolute`. Small fixed content (2 rows now); set `max-height` + `overflow-y:auto`
  as a guard, no flip-to-top needed at PRism's viewport.
  - **Show full file:** native `<input type="checkbox">`, **stable** label "Show
    full file". (Native checkbox over `role="switch"`: most robust AT support,
    conventional in a settings menu, no custom `aria-checked`/key handling.) State
    via `checked`. `aria-describedby` → the inert note when `fullFileInertHere`, or
    the block reason when `fullFileViewBlocked`.
  - **Wrap long lines:** native checkbox, stable label "Wrap long lines".

This removes today's label/`aria-pressed` contradiction: every control is a stable
label + control state.

**Keyboard contract (gear).** Gear → `Tab` → Show-full-file → `Tab` → Wrap.
`Space` toggles. **`Escape` from any control closes the panel and returns focus to
the gear.** Tab follows native focus order (no trap); the panel stays open until
Escape, outside-click, or gear re-click — those three close paths all restore
focus to the gear.

### Behavior change — "Show full file" goes view-wide

State refactor in `FilesTab.tsx`:

- **Remove** `wholeFilePaths: Set<string>`.
- **Add** `showFullFile: boolean` (view-wide preference, default `false`,
  in-memory — sibling to `diffMode`/`lineWrap`).
- **Add** `wholeFileFailedPaths: Set<string>` — paths whose whole-file fetch
  failed, so we fall back to hunks for *that* file without flipping the global
  preference off everywhere. *Why a per-file set rather than just flipping the
  global off on failure:* a transient fetch error on one file must not silently
  discard the user's global intent for every other file (that is the exact
  per-file friction this change removes). Cleared when `showFullFile` transitions
  **false → true** (a deliberate "retry" affordance).
- **Effective whole-file for the current file** — the value named
  `wholeFileEnabled`, drives the menu checkbox state **and is the prop passed to
  `DiffPane`** (replacing the current `wholeFileEnabled={...}` at
  `FilesTab.tsx:536`; raw `showFullFile` is *never* passed to `DiffPane`):
  ```
  wholeFileEnabled =
    showFullFile &&
    selectedPath !== null && !wholeFileFailedPaths.has(selectedPath) &&
    iterationGatePermits &&
    selectedFile?.status === 'modified' &&
    selectedFile.hunks.length > 0
  ```
- `handleToggleWholeFile` → toggles `showFullFile`. The "clear
  `wholeFileFailedPaths`" step is **direction-sensitive** — only on false → true.
- `handleWholeFileFailed(path)` → adds `path` to `wholeFileFailedPaths` (was:
  removed the path from the old set).

**Fetch cost (load-bearing).** Whole-file content stays **lazily fetched by the
single mounted `DiffPane` for the selected file only** (`useWholeFileContent`,
`enabled = wholeFileEnabled`). Going view-wide changes *which* files are eligible,
**not how many fetch** — exactly one fetch per file-selection, never a batch. A
200-file PR does not fetch 200 whole files. This also refutes any
"clear-failed-paths → fetch storm" concern: only the current file can refetch.

Switching to another eligible file now shows its full file automatically;
ineligible files render normally while the global preference stays on.

### Disabled / helper-text — gating reclassified by scope

- **View-level gate** — non-'all' iteration view (`!iterationGatePermits`, which
  also covers the low-quality commit-multi-select path, `selectedCommits !== null`):
  the Show-full-file control is **disabled** with helper text "Whole-file view
  available only on the 'all' iteration view."
- **Per-file ineligibility** — current file is `added`/`removed`/`renamed` or has
  no hunks, while `showFullFile` is on: the global control stays **enabled** and a
  **mandatory** inline note (`fullFileInertReason`, e.g. "Not available for this
  file — still on for other files") renders, wired via `aria-describedby`. Not
  optional: without it, a checked toggle that produces hunks is a silent
  control-vs-outcome mismatch. Must also render after an SSE-driven auto-select
  (`FilesTab.tsx:122-127`) lands on an ineligible first file with the preference on.
- **Split below 900px**: handled on the inline `DiffViewToggle` (Split tile
  disabled + helper text), preserving the existing `viewportWidth < 900` rule.

### Positioning (gear panel)

`.filesTabContent` and `.filesTabDiff` are `overflow:hidden`, but they are
**siblings** of `.filesTabToolbar` under `.filesTab`, **not ancestors** of the
gear — so they cannot clip a panel anchored in the toolbar. The panel is
`position:absolute` on a `position:relative` wrapper around the gear, right-
aligned, `z-index` above the sibling diff content; that is the only real
requirement. Genuine watch-item: `.filesTabToolbar` has `flex-wrap:wrap`, so at
narrow widths the gear can wrap to a second row and shift the anchor — verify the
panel still aligns to the gear. A React portal is a **remote contingency** only;
keep the panel inside a positioned ancestor so it cannot escape clipping into page
scroll (the #197-class bug).

## Testing

### Inline diff-view tests (`DiffViewToggle`)

- Renders two tiles; checked tile reflects `diffMode`; selecting Split fires
  `onDiffModeChange('side-by-side')` / Unified fires `'unified'`.
- Arrow-key navigation moves selection within the radiogroup.
- Split disabled + helper text/tooltip when `splitDisabled`; dark + light tile
  rendering.

### Gear-refactor tests (`DiffSettingsMenu` + FilesTab toolbar)

- Gear opens (click) and closes (click again, `Escape`, **outside-click**);
  **focus returns to the gear on each close path** (explicitly incl. outside-click
  and re-click, the two the reference picker lacks).
- `aria-expanded`/`aria-haspopup`/`aria-controls` wired; panel labelled.
- Active-state indicator appears when Show-full-file or Wrap is non-default, clears
  at default.
- Checkboxes reflect/toggle with **stable labels** (assert no label flip);
  keyboard contract (Tab order, Escape-from-any-control closes + restores focus).

### Behavior-change tests ("Show full file" view-wide — scrutinize independently)

*(Grouped separately because this is a deliberately-bundled behavior change, not
chrome.)*

- **Global full-file persists across file switches** — toggle on, select another
  eligible file, assert still whole-file; assert `wholeFileEnabled` (not raw
  `showFullFile`) flows to `DiffPane`.
- Ineligible current file: `showFullFile` on, file added/no-hunks →
  `wholeFileEnabled` false, control enabled, **mandatory inert note renders** (incl.
  after auto-select lands on an ineligible file).
- Per-file failure: `handleWholeFileFailed(path)` falls back to hunks for that path
  only; global preference and other files unaffected.
- **Retry affordance:** `showFullFile` false → true clears `wholeFileFailedPaths`
  so a previously-failed path retries; toggling within the same `true` state does
  not clear it.
- View-level disable + helper text off the 'all' iteration view (incl.
  `selectedCommits !== null`).

### Playwright e2e + B1 visual proof

- Inline tiles → choose Split → assert two-column diff; open gear → toggle Wrap;
  toggle Show full file → switch files → still full file.
- Light + dark screenshots of the toolbar (inline tiles + gear, incl. the gear's
  active-indicator state) and the open panel, embedded on the PR for the
  visual-assert gate.

## Accepted tradeoffs (decisions to own)

- **Hot path preserved.** Keeping `diffMode` inline resolves the two-click concern
  on the most-flipped control. `lineWrap` lives in the gear (two clicks) as a
  set-and-forget preference; if it proves too buried it can move inline later.
- **Directional surprise of global full-file.** Turn it on once and every eligible
  file opens full until toggled off — the intended relief from per-file
  re-toggling. Blast radius is one PR-detail session (non-persistent).
- **Retry-failure is silent.** A failed retry repopulates `wholeFileFailedPaths`
  and the file shows hunks with no toast — the inert note is the only signal.
  Acceptable for a view preference.

## Alternatives considered

- **Full consolidation (everything in the gear).** The maintainer's initial pick,
  changed during review: burying the instant, frequently-flipped diff-view toggle
  two clicks deep is a real hot-path cost GitHub avoids only because its toggle is
  a heavy reload. Resolved by the hybrid above.
- **Inline icon-toggle buttons** (a row of compact icon buttons). The issue's
  literal title; rejected — abstract icons are less discoverable, reclaim less
  than a gear, and don't scale. The one inline control we keep is an *illustrative
  tile* radiogroup, not an abstract icon cluster.
- **Labeled radios instead of illustrated tiles.** Lower build cost (no SVG/theming
  /baseline), but the maintainer prefers the tile aesthetic; tiles chosen, themed
  via CSS variables, covered by the B1 visual gate.
- **Per-file "Show full file" kept as-is.** Rejected at the maintainer's explicit
  request — forces re-toggling on every file.
- **On-failure flip the global preference off** (simpler than a failed-paths set).
  Rejected: a one-file network blip would silently kill whole-file for *all* files,
  reintroducing the friction this change removes.
- **Persisting the global preference to the backend.** Rejected as scope creep;
  in-memory matches `diffMode`/`lineWrap`.

## Documented deviation

The global "Show full file" behavior expands #185 beyond its stated "no change to
diff behavior itself / reuse existing toggle-state wiring" scope. Authorized
explicitly by the maintainer during brainstorming; bundled consciously with the
chrome refactor (test suites are split so each is reviewed on its own merits).
Recorded here and restated in the PR `## Proof`.
