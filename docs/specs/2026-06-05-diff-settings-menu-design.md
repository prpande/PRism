# Files-tab Diff Settings menu + global "Show full file" — design

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
picker. As more view controls land (#184 proposes a Source ↔ Rendered-Markdown
diff toggle, "more coming"), the word-labelled row eats horizontal real estate
and crowds the iteration strip / filename, especially at narrower widths. The
controls also carry **inconsistent label semantics** today: `diffMode` shows the
*current* mode, `wholeFile`'s label *flips* with state (which the code comment at
`FilesTab.tsx:469-471` notes contradicts `aria-pressed` for assistive tech),
`lineWrap` is a stable label.

A secondary, separately-reported pain: **"Show full file" is per-file.**
`wholeFilePaths` is a `Set<string>` of individually-toggled paths
(`FilesTab.tsx:65,134`), so switching files drops back to hunks unless that file
was also toggled. By contrast `diffMode` and `lineWrap` are already view-wide
booleans — the comment at `FilesTab.tsx:66` calls line-wrap "a view-wide
preference (like diffMode, not per-file)."

## Goal

1. Consolidate the three toggles behind a single GitHub-style **⚙ "Diff
   settings"** gear → popover, matching GitHub's PR Files-changed view (which
   hides *all* view controls behind one gear icon, not a row of inline icon
   toggles). This reclaims the toolbar and scales: a future control becomes one
   more row in the menu instead of another button.
2. Make **"Show full file" view-wide** — toggle once, every eligible file shows
   its full file on selection; no per-file re-toggling.
3. Preserve every existing accessibility and disabled-state guarantee; fix the
   label/`aria-pressed` inconsistency along the way.

### Non-goals / scope boundary

- **3 current controls only.** #184's markdown-diff toggle is "leave room for"
  (one future menu row), not built here.
- **No backend/disk persistence.** The global "Show full file" preference is
  in-memory component state, exactly like `diffMode` and `lineWrap` — it persists
  while the Files tab stays mounted (keep-alive) and resets on a fresh mount.
  Persisting it would creep into the preferences surface; out of scope.
- **No abstract inline icon-toggle buttons.** Rejected in favour of GitHub's
  actual gear-dropdown model (see Alternatives).

## Reference: what GitHub actually does

On the PR **Files changed** view, GitHub does **not** place inline icon-toggle
buttons in the toolbar. Every view control collapses into a single **⚙ "Diff
settings"** gear button. Its dropdown contains:

- **Diff view** — Unified / Split as **illustrated radio tiles** (small pictures
  of each layout), selection = current state.
- **Hide whitespace** — checkbox.
- **Apply and reload** — GitHub re-renders server-side.

We adopt the gear-dropdown model and the illustrated-tile treatment for the diff
view. We **diverge** where PRism differs: our toggles are instant client-side
state, so there is **no "Apply and reload"** — changes apply immediately. Our
control set is Diff view + Show full file + Wrap long lines (not whitespace).

## Approach

### Components

**`DiffSettingsMenu`** (new, `frontend/src/components/PrDetail/FilesTab/`) — a
self-contained disclosure popover: a gear trigger button + a panel of form
controls. It owns only its open/close interaction; all setting values and change
handlers are props. FilesTab renders it in place of the three toolbar buttons.

It **reuses the open/close interaction already implemented in
`CommitMultiSelectPicker.tsx`** (controlled `open` state, `aria-expanded` /
`aria-haspopup` on the trigger, `Escape`-to-close, outside-click close via a
document listener, focus return to the trigger on close). We follow that proven
pattern rather than inventing new popover a11y plumbing. If, during
implementation, the shared mechanics are worth extracting into a small hook
(`useDisclosure`/`usePopover`), that is a reasonable local refactor; otherwise
mirror the pattern in place.

**Props (shape, finalized in the plan):**

| Prop | Type | Source in FilesTab |
|------|------|--------------------|
| `diffMode` | `'side-by-side' \| 'unified'` | `effectiveDiffMode` |
| `onDiffModeChange` | `(mode) => void` | wraps `handleToggleDiffMode` / sets `diffMode` |
| `splitDisabled` | `boolean` | `viewportWidth < 900` |
| `showFullFile` | `boolean` | new `showFullFile` state |
| `onShowFullFileChange` | `(on: boolean) => void` | new handler |
| `fullFileAvailable` | `boolean` | `iterationGatePermits` (view-level gate) |
| `fullFileUnavailableReason` | `string \| null` | helper text |
| `lineWrap` | `boolean` | `lineWrap` |
| `onLineWrapChange` | `(on: boolean) => void` | wraps `handleToggleLineWrap` |

### Panel contents & accessibility

The panel holds **native form controls** — settings, not commands — so we do
**not** use `role="menu"`. Native controls give correct AT keyboarding for free
(arrow keys within the radiogroup, Tab between controls).

- Trigger: `<button>` with `aria-haspopup="true"`, `aria-expanded`,
  `aria-controls` pointing at the panel, accessible name "Diff settings", and a
  `title` tooltip. Gear glyph is `aria-hidden`.
- Panel: a labelled container (`aria-label="Diff settings"`).
  - **Diff view:** a `radiogroup` (group label "Diff view") with two radios,
    **Unified** and **Split**, each rendered as an illustrated tile (a small
    inline-SVG/CSS thumbnail of the layout) + visible text label. The checked
    radio is the current mode. Split is `disabled` with helper text when
    `splitDisabled` (viewport < 900px).
  - **Show full file:** a single control — a checkbox or `role="switch"` button
    — with the **stable** label "Show full file". State carried by
    `checked`/`aria-checked`, never by a flipping label. `aria-describedby`
    points at helper text when present.
  - **Wrap long lines:** same control type, stable label "Wrap long lines".

This removes today's label/`aria-pressed` contradiction: all three controls are
stable label + control state.

### Behavior change — "Show full file" goes view-wide

State refactor in `FilesTab.tsx`:

- **Remove** `wholeFilePaths: Set<string>`.
- **Add** `showFullFile: boolean` (view-wide preference, default `false`,
  in-memory — sibling to `diffMode`/`lineWrap`).
- **Add** `wholeFileFailedPaths: Set<string>` — paths whose whole-file fetch
  failed, so we fall back to hunks for *that* file without flipping the global
  preference off everywhere. Cleared when the user re-enables the global toggle
  (a deliberate "retry" affordance).
- **Effective whole-file for the current file** (drives the toolbar/menu state
  and the prop passed to `DiffPane`):
  ```
  wholeFileEnabled =
    showFullFile &&
    selectedPath !== null && !wholeFileFailedPaths.has(selectedPath) &&
    iterationGatePermits &&
    selectedFile?.status === 'modified' &&
    selectedFile.hunks.length > 0
  ```
- `handleToggleWholeFile` → toggles the `showFullFile` boolean (+ clears
  `wholeFileFailedPaths` on enable).
- `handleWholeFileFailed(path)` → adds `path` to `wholeFileFailedPaths` (was:
  removed the path from the set).

Switching to another eligible file now shows its full file automatically;
ineligible files render normally while the global preference stays on.

### Disabled / helper-text — gating reclassified

The old single disabled-condition is split by *scope*:

- **View-level gate** — non-'all' iteration view (`!iterationGatePermits`): the
  Show-full-file control is **disabled** with inline helper text "Whole-file view
  available only on the 'all' iteration view." Genuinely unavailable for the
  whole view.
- **Per-file ineligibility** — current file is `added`/`removed`/`renamed` (not
  `modified`) or has no hunks: the global control stays **enabled** (it is a
  global preference that applies to other files); show an optional inline note
  that it does not affect the current file. *(This is more correct than today's
  behavior, which greys out the global intent because of the one file in view.)*
- **Split below 900px**: Split radio disabled with helper text (preserves the
  existing `viewportWidth < 900` rule that forces unified).

All prior `title=` explanations survive as inline helper text wired via
`aria-describedby`.

### Positioning

The panel is `position:absolute`, anchored to a `position:relative` wrapper on
the gear, right-aligned, with a high `z-index`, overlaying the diff content
below. **Clipping risk:** `.filesTabContent` is `overflow:hidden`
(`FilesTab.module.css:22-28`); the toolbar (`.filesTabToolbar`) is not. The panel
anchors inside the toolbar and must escape any clipping ancestor — verified
during implementation, mindful of the recent #197-class abspos-clipping bug. If a
clip is unavoidable, fall back to a React portal anchored by measured rect.

## Testing

**vitest / React Testing Library (`DiffSettingsMenu` + FilesTab):**

- Gear opens the panel (click) and closes it (click again, `Escape`,
  outside-click); focus returns to the gear on close.
- `aria-expanded`/`aria-haspopup`/`aria-controls` wired correctly.
- Radiogroup reflects `diffMode` and fires `onDiffModeChange`; Split disabled +
  helper text when `splitDisabled`.
- Show-full-file and Wrap checkboxes reflect and toggle their values with stable
  labels (assert no label flip, `aria-checked` carries state).
- **Global full-file persists across file switches** — toggle on, select a
  different eligible file, assert still whole-file (the core new behavior).
- Per-file failure: `handleWholeFileFailed(path)` falls back to hunks for that
  path only; global preference and other files unaffected.
- View-level disable + helper text when not on the 'all' iteration view.

**Playwright e2e + B1 visual proof:**

- Open gear → choose Split → assert two-column diff; toggle Wrap; toggle Show
  full file → switch files → still full file.
- Light + dark screenshots of the closed toolbar and the open panel, embedded on
  the PR for the visual-assert gate.

## Alternatives considered

- **Inline icon-toggle buttons** (3 compact icon buttons in the toolbar). This is
  the issue's literal title but **not** what GitHub's PR view does. Rejected:
  abstract icons are less discoverable (a concern the issue itself raises), they
  reclaim less space than a single gear, and they don't scale — every new control
  is another toolbar button. The maintainer chose the GitHub gear-dropdown model.
- **Responsive collapse** (text at full width, icons below a breakpoint). Lower
  discoverability cost, but doesn't match the requested GitHub model and adds
  breakpoint complexity for a desktop-bound app. Rejected.
- **Per-file "Show full file" kept as-is.** Rejected at the maintainer's explicit
  request — the per-file model forces re-toggling on every file.
- **Persisting the global preference to the preferences backend.** Rejected as
  scope creep into a different surface; in-memory matches the `diffMode`/
  `lineWrap` siblings.

## Documented deviation

The global "Show full file" behavior expands #185 beyond its stated "no change to
diff behavior itself / reuse existing toggle-state wiring" scope. Authorized
explicitly by the maintainer during brainstorming; recorded here and to be
restated in the PR `## Proof`.
