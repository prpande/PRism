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
picker. The controls carry **inconsistent label semantics** today: `diffMode`
shows the *current* mode, `wholeFile`'s label *flips* with state (which the code
comment at `FilesTab.tsx:469-471` notes contradicts `aria-pressed` for assistive
tech), `lineWrap` is a stable label.

**On scaling — this is a forward investment, not present-pain relief.** At three
controls on PRism's fixed wide desktop viewport, the toolbar is *not* crowded
today. The consolidation pre-pays for the anticipated control set (#184 proposes a
Source ↔ Rendered-Markdown toggle, "more coming") — a deliberate bet that room
later is worth one extra click now (see Accepted tradeoffs). The maintainer chose
this direction during brainstorming after seeing GitHub's actual model.

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
   toggles). The product rationale is **reviewer familiarity** — PRism's audience
   lives in GitHub's Files-changed view, so mirroring that chrome transfers
   muscle-memory and lowers cognitive load. It also scales: a future control
   becomes one more menu row instead of another toolbar button.
2. Make **"Show full file" view-wide** — toggle once, every eligible file shows
   its full file on selection; no per-file re-toggling.
3. Preserve every existing accessibility and disabled-state guarantee; fix the
   label/`aria-pressed` inconsistency along the way.

### Non-goals / scope boundary

- **3 current controls only.** #184's markdown-diff toggle is "leave room for"
  (one future menu row), not built here. **No placeholder props, disabled rows,
  or comment stubs for #184** belong in this PR — that row is purely additive
  when #184 lands.
- **No backend/disk persistence.** The global "Show full file" preference is
  in-memory component state, exactly like `diffMode` and `lineWrap`. Precise
  persistence boundary: it persists across file switches **within one PR-detail
  session** (the Files tab is keep-alive) and **resets on a fresh mount** — i.e.
  navigating to a different PR, or remounting PR-detail, resets it to off.
  Cross-PR / cross-session persistence is explicitly out of scope (it would creep
  into the preferences surface).
- **No abstract inline icon-toggle buttons.** Rejected in favour of GitHub's
  actual gear-dropdown model (see Alternatives).
- **No shared popover hook in this PR.** Mirror the open/close mechanics in
  `DiffSettingsMenu` directly. Two consumers (the commit picker + this) is not a
  mandate to extract a `useDisclosure`/`usePopover` hook; defer extraction until a
  third consumer exists.

## Reference: what GitHub actually does

On the PR **Files changed** view, GitHub does **not** place inline icon-toggle
buttons in the toolbar. Every view control collapses into a single **⚙ "Diff
settings"** gear button. Its dropdown contains Unified / Split as illustrated
radio tiles (small pictures of each layout), a Hide-whitespace checkbox, and an
"Apply and reload" button (GitHub re-renders server-side).

We adopt the gear-dropdown model. We **diverge** where PRism differs: our toggles
are instant client-side state, so there is **no "Apply and reload"** — changes
apply immediately. Our control set is Diff view + Show full file + Wrap long lines
(not whitespace).

## Approach

### Components

**`DiffSettingsMenu`** (new, `frontend/src/components/PrDetail/FilesTab/`) — a
self-contained disclosure popover: a gear trigger button + a panel of form
controls. It owns only its open/close interaction; all setting values and change
handlers are props. FilesTab renders it in place of the three toolbar buttons.

**Reuse boundary (corrected).** `CommitMultiSelectPicker.tsx` is a useful
*reference* for the disclosure **shell only** — controlled `open` state,
`aria-expanded`/`aria-haspopup`/`aria-controls` wiring, `Escape`-to-close with
focus return to the trigger, and focus-into-panel on open. It does **not**
implement two mechanics this menu needs, which are therefore **net-new work, not a
copy-paste**:

1. **Outside-click close** — the picker has no document/window listener at all.
   `DiffSettingsMenu` must add a `mousedown` (or `pointerdown`) document listener
   with a `ref.contains` guard and proper cleanup on unmount/close.
2. **Focus return on *every* close path** — the picker returns focus to its
   trigger only on Escape. This menu must restore focus to the gear on Escape,
   outside-click, and re-click-to-close alike.

Also note the picker's **interior** is a `role="combobox"`/`listbox`/`option`
widget with `aria-activedescendant` roving — none of that transfers. This menu's
interior is native form controls (below). Only the disclosure shell is shared in
spirit. These dismiss/focus mechanics are first-class plan tasks with their own
tests.

**Props (shape, finalized in the plan):**

| Prop | Type | Source in FilesTab |
|------|------|--------------------|
| `diffMode` | `'side-by-side' \| 'unified'` | `effectiveDiffMode` |
| `onDiffModeChange` | `(mode) => void` | sets `diffMode` directly (radio selects a mode, not a toggle) |
| `splitDisabled` | `boolean` | `viewportWidth < 900` |
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
explanatory note). They were conflated in an earlier draft.

### Panel contents & accessibility

The panel holds **native form controls** — settings, not commands — so we do
**not** use `role="menu"`. Native controls give correct AT keyboarding for free.

- **Trigger:** a `<button>` with `aria-haspopup="true"`, `aria-expanded`,
  `aria-controls` → panel id, accessible name "Diff settings", and a `title`
  tooltip. Gear glyph is `aria-hidden`. **Minimum hit target ≥ 24×24px (WCAG
  2.5.8); target ~32×32px** visible via padding.
- **Active-state indicator (required).** Because settings are instant and silent
  and survive keep-alive, the collapsed gear must signal when **any** setting
  deviates from default (Split selected, Show-full-file on, or Wrap on — the
  forced-unified-below-900px case does *not* count, it isn't a user choice). Treat
  this as a small dot/badge on the gear plus an accessible-name change (e.g.
  `aria-label="Diff settings (modified)"` or a visually-hidden suffix), so
  screen-reader users get the same signal. Exact visual is a B1-gate detail.
- **Panel:** a labelled container (`aria-label="Diff settings"`), `position:
  absolute`. Small fixed content (3 rows); set a `max-height` + `overflow-y:auto`
  as a guard, no flip-to-top logic needed at PRism's viewport.
  - **Diff view:** a `radiogroup` (group label "Diff view") with **Unified** and
    **Split** radios. The checked radio is the current mode; both options always
    visible convey the action target. Split is `disabled` + helper text when
    `splitDisabled` (viewport < 900px). *Visual treatment: see "Diff-view control"
    below — pending your gate decision (illustrated tiles vs labeled radios).*
  - **Show full file:** a native `<input type="checkbox">` with the **stable**
    label "Show full file". (Native checkbox over `role="switch"`: most robust AT
    support, conventional in a settings menu, no custom `aria-checked`/key
    handling.) State via `checked`. `aria-describedby` → the inert note when
    `fullFileInertHere`, or the block reason when `fullFileViewBlocked`.
  - **Wrap long lines:** native checkbox, stable label "Wrap long lines".

This removes today's label/`aria-pressed` contradiction: all three controls are
stable label + control state.

**Keyboard contract.** Gear → `Tab` → first radio; `Arrow` keys move within the
radiogroup; `Tab` → Show-full-file checkbox → `Tab` → Wrap checkbox. `Space`
toggles a checkbox / selects a radio; labels never change. **`Escape` from any
control closes the panel and returns focus to the gear.** Tab past the last
control follows native focus order (does not trap); the panel stays open until
Escape, outside-click, or gear re-click — those three are the close paths and all
restore focus to the gear.

### Diff-view control — gate decision (illustrated tiles vs labeled radios)

Two reviewers plus scope-guardian flagged the GitHub-style illustrated tiles as
optional polish with real cost (SVG authoring, dark/light theming, visual-baseline
risk). **Recommendation: ship labeled radios with a small inline layout icon**
(Unified = stacked rows glyph; Split = two-columns glyph), themed via existing CSS
custom properties. This meets the entire stated goal with zero bespoke-illustration
risk and is consistent with the text-labeled checkboxes beside it.

If illustrated tiles are chosen at the gate, they are specified as: ~48×32px tile
per option; **Unified** = three full-width horizontal bars; **Split** = two
columns each with two half-width bars; selected state = `2px solid var(--accent)`
border (no fill swap); hover = subtle surface change on the unselected tile;
disabled (Split <900px) = greyed thumbnail + greyed label; all strokes/fills use
theme CSS variables (never hardcoded) so they switch with dark/light. The radios
remain real `<input type="radio">` under the tiles for semantics.

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
  **false → true** (a deliberate "retry" affordance — see direction note below).
- **Effective whole-file for the current file** — the value named
  `wholeFileEnabled`, drives the menu's checkbox state **and is the prop passed to
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
- `handleToggleWholeFile` → toggles the `showFullFile` boolean. The "clear
  `wholeFileFailedPaths` on enable" step is **direction-sensitive**: it fires only
  on the false → true transition, not on every call. Implement as
  `onShowFullFileChange(next)` where `next === true` clears the set.
- `handleWholeFileFailed(path)` → adds `path` to `wholeFileFailedPaths` (was:
  removed the path from the old set).

**Fetch cost (load-bearing, was unstated).** Whole-file content stays **lazily
fetched by the single mounted `DiffPane` for the selected file only**
(`useWholeFileContent`, `enabled = wholeFileEnabled`). Going view-wide changes
*which* files are eligible, **not how many fetch** — exactly one fetch per
file-selection, never a batch. A 200-file PR does not fetch 200 whole files. This
also refutes any "clear-failed-paths causes a fetch storm" concern: only the
current file can refetch.

Switching to another eligible file now shows its full file automatically;
ineligible files render normally while the global preference stays on.

### Disabled / helper-text — gating reclassified by scope

- **View-level gate** — non-'all' iteration view (`!iterationGatePermits`, which
  also covers the low-quality commit-multi-select path where `selectedCommits !==
  null`): the Show-full-file control is **disabled** with inline helper text
  "Whole-file view available only on the 'all' iteration view." Genuinely
  unavailable for the whole view.
- **Per-file ineligibility** — current file is `added`/`removed`/`renamed` (not
  `modified`) or has no hunks, while `showFullFile` is on: the global control
  stays **enabled** (it is a global preference that applies elsewhere), and a
  **mandatory** inline note (`fullFileInertReason`, e.g. "Not available for this
  file (no modified hunks) — still on for other files") renders, wired via
  `aria-describedby`. This is *not* optional: without it, a checked toggle that
  produces hunks is a silent control-vs-outcome mismatch. The note must also
  render after an SSE-driven auto-select (`FilesTab.tsx:122-127`) lands on an
  ineligible first file with the preference on.
- **Split below 900px**: Split radio disabled with helper text (preserves the
  existing `viewportWidth < 900` rule that forces unified).

All prior `title=` explanations survive as inline helper text wired via
`aria-describedby`.

### Positioning (corrected)

`.filesTabContent` and `.filesTabDiff` are `overflow:hidden`, but they are
**siblings** of `.filesTabToolbar` under `.filesTab`, **not ancestors** of the
gear — so they cannot clip a panel anchored in the toolbar. The panel is
`position:absolute` on a `position:relative` wrapper around the gear, right-
aligned, with a `z-index` above the sibling diff content; that is the only real
requirement. The genuine watch-item is that `.filesTabToolbar` has
`flex-wrap:wrap`, so at narrow widths the gear can wrap to a second row and shift
the anchor — verify the panel still aligns to the gear. A React portal is a
**remote contingency** only (not a co-equal path); the absolute-on-relative
approach is expected to work, mindful of the #197-class abspos page-scroll bug
(keep the panel inside a positioned ancestor so it cannot escape clipping into
page scroll).

## Testing

### Chrome-refactor tests (DiffSettingsMenu + FilesTab toolbar)

- Gear opens the panel (click) and closes it (click again, `Escape`,
  **outside-click**); **focus returns to the gear on each close path** (explicitly
  including outside-click and re-click, the two the reference picker lacks).
- `aria-expanded`/`aria-haspopup`/`aria-controls` wired; panel labelled.
- Active-state indicator appears when a setting is non-default, clears at default.
- Radiogroup reflects `diffMode` and fires `onDiffModeChange`; Split disabled +
  helper text when `splitDisabled`.
- Checkboxes reflect/toggle with **stable labels** (assert no label flip,
  `checked` carries state); keyboard contract (Tab order, Escape-from-any-control
  closes + restores focus).

### Behavior-change tests ("Show full file" view-wide — scrutinize independently)

*(Grouped separately because this is a deliberately-bundled behavior change, not
chrome — reviewers should review it on its own merits.)*

- **Global full-file persists across file switches** — toggle on, select another
  eligible file, assert still whole-file (the core new behavior); assert
  `wholeFileEnabled` (not raw `showFullFile`) flows to `DiffPane`.
- Ineligible current file: `showFullFile` on, file is added/no-hunks →
  `wholeFileEnabled` false, control stays enabled, **mandatory inert note renders**
  (incl. after auto-select lands on an ineligible file).
- Per-file failure: `handleWholeFileFailed(path)` falls back to hunks for that
  path only; global preference and other files unaffected.
- **Retry affordance:** toggling `showFullFile` false → true clears
  `wholeFileFailedPaths`, so a previously-failed path attempts whole-file again;
  toggling within the same `true` state does *not* clear it.
- View-level disable + helper text when not on the 'all' iteration view (incl. the
  `selectedCommits !== null` low-quality path).

### Playwright e2e + B1 visual proof

- Open gear → choose Split → assert two-column diff; toggle Wrap; toggle Show full
  file → switch files → still full file.
- Light + dark screenshots of the closed toolbar (incl. active-indicator state)
  and the open panel, embedded on the PR for the visual-assert gate.

## Accepted tradeoffs (decisions to own, surfaced from review)

- **Two-click cost on hot-path controls.** `diffMode` and `lineWrap` are instant
  client-side toggles a reviewer may flip repeatedly; behind the gear they cost an
  extra click. GitHub tolerates this because its diff-view toggle triggers a heavy
  server reload (infrequent), whereas PRism's are cheap (frequent). Full
  consolidation is the maintainer's explicit call; the cost is accepted in
  exchange for a toolbar that scales to the #184-and-beyond control set. *A hybrid
  (keep Split/Unified inline, gear the long tail) was raised in review and is the
  alternative if the hot-path cost proves annoying.*
- **Directional surprise of global full-file.** Turn it on once and every eligible
  file opens full until toggled off — the intended relief from per-file
  re-toggling. Blast radius is one PR-detail session (non-persistent; resets on
  fresh mount).
- **Retry-failure is silent.** If a re-enabled retry fails again,
  `wholeFileFailedPaths` repopulates and the file shows hunks with no toast — the
  inert note is the only signal. Acceptable for a view preference.

## Alternatives considered

- **Inline icon-toggle buttons** (3 compact icon buttons in the toolbar). The
  issue's literal title but **not** what GitHub's PR view does. Rejected: abstract
  icons are less discoverable (a concern the issue itself raises), reclaim less
  space than one gear, and don't scale (every new control is another button).
- **Responsive collapse** (text at full width, icons below a breakpoint). Lower
  discoverability cost, but rejected on **cost-of-divergence**: it doesn't match
  the GitHub model the maintainer chose for reviewer-familiarity, and adds
  breakpoint complexity for a desktop-bound app.
- **Hybrid (keep Split/Unified inline, gear the rest).** Preserves the hot path
  while still relieving scaling pressure. Not chosen (maintainer wants full
  GitHub-style consolidation); recorded as the fallback under Accepted tradeoffs.
- **Per-file "Show full file" kept as-is.** Rejected at the maintainer's explicit
  request — the per-file model forces re-toggling on every file.
- **On-failure flip the global preference off** (simpler than a failed-paths set).
  Rejected: a one-file network blip would silently kill whole-file for *all*
  files, reintroducing exactly the friction this change removes.
- **Persisting the global preference to the preferences backend.** Rejected as
  scope creep into a different surface; in-memory matches `diffMode`/`lineWrap`.

## Documented deviation

The global "Show full file" behavior expands #185 beyond its stated "no change to
diff behavior itself / reuse existing toggle-state wiring" scope. Authorized
explicitly by the maintainer during brainstorming; bundled consciously with the
chrome refactor (test suites are split so each is reviewed on its own merits).
Recorded here and to be restated in the PR `## Proof`.
