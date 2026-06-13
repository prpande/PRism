# #349 — Shared themed `Select` component

**Issue:** [#349](https://github.com/prpande/PRism/issues/349) — Dropdowns (Settings + inbox sort) use native `<select>`; the open list looks blocky and bolted-on.
**Milestone:** Phase 6 — Primary-Surface UX (Inbox & Settings)
**Classification:** Gated (UI-visual). Human B1 visual review required before merge.
**Date:** 2026-06-13

## Problem

Every dropdown in the app is a native `<select>`. This produces two distinct, confirmed problems:

1. **The open option list is unthemeable.** A native `<select>`'s popup is rendered by the OS/UA and cannot be styled with CSS — opening any dropdown shows OS chrome (square corners, system font metrics, system highlight, system scrollbar) that shares none of the app's surface tokens. This is the report's *core* symptom and affects every `<select>`, including ones whose closed state is already themed.
2. **The closed controls are styled inconsistently.** The four sites disagree:

| Site | Closed-state styling |
|---|---|
| Inbox sort — `FilterBar.tsx:102` (`.sortSelect`) | Fully themed: `appearance: none`, surface tokens, custom caret + leading sort-glyph |
| Settings → Default sort — `InboxPane.tsx:166` | **Unstyled native** — only `font/color: inherit`; raw OS chrome |
| PR-detail compare ×2 — `ComparePicker.tsx:44,65` | `className`'d but **no `appearance: none`** → partial native chrome |

## Decision: replace native `<select>` with a shared custom themed `Select`

Chosen over closed-state-only unification because only a custom control can theme the *open list*, which is the issue's core complaint. This also matches the project's established taste (custom design-system controls over native widgets) and is de-risked by an existing in-house listbox pattern (`CommitMultiSelectPicker`).

### Non-goals (YAGNI)

- **No headless UI dependency** (Radix/downshift/Headless UI). The project has zero UI dependencies and already owns a working listbox pattern; a dependency is unjustified weight.
- **No viewport-flip / portal in this slice.** The popup renders in-flow (see §Open-list rendering). Portal is the documented upgrade path, not built now.
- **No multi-select.** This `Select` is single-select only; `CommitMultiSelectPicker` remains the multi-select control.

## Component

New `src/components/controls/Select.tsx` (+ `Select.module.css`, `Select.test.tsx`), alongside the existing shared controls (`Switch`, `SegmentedControl`, `RefreshButton`). Generic over the value type so it serves both `SortKey` (string) and iteration `number`.

```ts
interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SelectProps<T extends string | number> {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  id?: string;              // for label htmlFor association (Settings)
  'aria-label'?: string;    // inbox sort, ComparePicker
  leadingIcon?: ReactNode;  // inbox sort's sort-glyph; omitted elsewhere
  disabled?: boolean;
  className?: string;       // extra class on the trigger (per-site tweaks)
}
```

`leadingIcon` is the single concession needed to preserve the inbox sort's existing leading sort-glyph (#300/#345) without re-layering an external glyph over a custom trigger.

### Internal structure (the "clean seam")

The component is built so an in-flow → portal migration is a **single-file, contained change** with no rework tax. To guarantee that:

- The popup is rendered behind **one internal seam** — an internal `Listbox` subcomponent (or `renderPopup()` helper) that owns its own positioning. Swapping in-flow → portal touches only this seam + its CSS (`absolute` → `fixed` + rect computation) + the net-new reposition/flip logic.
- **Consumers only ever pass `options/value/onChange`** (+ aria/id/icon). No positioning concern leaks into call sites.
- **Tests assert behavior, not in-flow DOM structure** — role/keyboard/selection queries (which work transparently across a future portal), never "popup is a sibling of trigger".

These three properties are requirements, not nice-to-haves: they are what make the portal door cheap to open later.

## Behavior (Core + type-ahead)

Modeled on `CommitMultiSelectPicker`'s combobox/listbox pattern, simplified to single-select.

- **Trigger:** `<button role="combobox" aria-haspopup="listbox" aria-expanded aria-controls>` rendering the selected option's label + a caret (+ optional `leadingIcon`).
- **Popup:** `role="listbox"` with `aria-activedescendant`; each option `role="option"` + `aria-selected`. `max-height` + `overflow-y: auto` for long lists (mirrors `CommitMultiSelectPicker`, which handles many items this way).
- **Keyboard:**
  - Closed: ArrowDown / ArrowUp / Enter / Space open the list (focus lands on the selected option).
  - Open: ArrowUp/ArrowDown move the active option **skipping `disabled` options**; Home/End jump to first/last enabled; Enter/Space select the active option and close + refocus the trigger; Escape closes + refocuses the trigger without changing value; Tab closes.
  - **Type-ahead:** printable keystrokes accumulate into a buffer (reset after ~500ms idle); the active option advances to the first option whose label starts with the buffer (matching enabled options). Single repeated character cycles among matches.
- **Dismiss:** click/pointerdown outside the trigger+popup, or Escape.
- **Disabled options:** not selectable, not focusable via keyboard nav, visibly muted (ComparePicker "snapshot lost").
- **Selection commit:** `onChange(value)` fires only on an actual selection change.

## Open-list rendering (§4 decision: in-flow)

The popup renders **in-flow**: `position: absolute; top: calc(100% + gap); left: 0; z-index` on a `position: relative` root, with `max-height` + `overflow-y: auto`. No portal, no viewport flip.

**Rationale and known limitations (documented deliberately):**

- The only **live** clipping risk is the **Settings default-sort** select, which sits inside `SettingsModal`'s `overflow-y: auto` body. The list is **4 short options (~120px)** opened from a mid-pane row, so it is expected to fit. **This must be validated live in the built Settings modal** (see Testing). If it clips at the modal's bottom edge, the documented fallback is to portal *that case* — a contained change thanks to the clean seam.
- **ComparePicker is currently not mounted** anywhere in the live app (no `.tsx` imports it). It is migrated for consistency/correctness but cannot be visually validated in the running app; it carries no live clipping risk today.
- **Inbox sort** opens into open list area below the toolbar; no clipping ancestor.
- **Structural limitation accepted:** as a shared control, in-flow `Select` is **not drop-in-safe inside an arbitrary future scroll/overflow container**, and has **no viewport-edge flip**. Portal is the named upgrade path; the modal has no persistent `transform` (its `modalIn` animation has no `forwards` fill), so a future portal will cleanly escape it.

## Styling

Reuse the existing token vocabulary; introduce no new color values.

- **Trigger** reuses the `.sortSelect` treatment: `--surface-inset` background, `1px solid var(--border-2)`, `--radius-2`, `--text-sm`, and the focus-border-swap to `var(--accent)` with `outline: none` (matches `.sortSelect:focus-visible`).
- **Popup** reuses the `CommitMultiSelectPicker` listbox surface: `--surface-1` background, `1px solid var(--border-1)`, `--radius-3`, `var(--shadow-2)`, `--s-2` padding.
- **Options — accent-driven selection/hover (per design refinement):**
  - **Hover** (mouse) and **keyboard-active** (`aria-activedescendant`) option: accent-tinted background `var(--accent-soft)` with `var(--accent)` text — so the option the user is about to choose reads in the accent, not a neutral grey. Hover and keyboard-active share one visual treatment so mouse and keyboard agree.
  - **Selected** option (`aria-selected`): a persistent accent affordance (e.g. `var(--accent)` check/indicator or accent text) distinct from the transient active/hover state.
  - Resting option: `transparent` background, `--text-1`.
- Verified live in **both light and dark themes** (accent tokens are theme-asymmetric: `--accent-soft` is a light tint in light theme, a dark tint in dark theme — confirm legibility in both).

## Migrations

Replace all four `<select>` sites with `Select`:

1. **Inbox sort** — `FilterBar.tsx`. `options={SORT_OPTIONS.map(...)}`, `value={f.sort}`, `onChange={f.setSort}`, `aria-label="Sort"`, `leadingIcon={<sort glyph>}`. The existing `.sort` wrapper, external caret SVG, and `.sortSelect` rules are removed/absorbed into `Select`.
2. **Settings default sort** — `InboxPane.tsx`. `id="inbox-default-sort"` (preserves the `<label htmlFor>` association), `options={SORT_OPTIONS.map(...)}`, `value={defaultSort}`, `onChange={(v) => set('inbox.defaultSort', v)}`.
3. **ComparePicker ×2** — `ComparePicker.tsx`. Numeric values; `disabled` set from `!iter.hasResolvableRange`; labels `Iter N` / `Iter N (snapshot lost)`; `aria-label="From iteration"` / `"To iteration"`. The from/to swap logic in `handleFromChange`/`handleToChange` is preserved.

`SORT_OPTIONS` (`applyInboxFilters.ts`) is reused as-is.

## Testing

- **Unit (`Select.test.tsx`):** open/close via mouse + keyboard; ArrowUp/Down/Home/End navigation; disabled-option skip; type-ahead (prefix match + idle reset + cycle); Enter/Space selection + close + trigger refocus; Escape closes without value change; click-outside dismiss; ARIA attributes (`role`, `aria-expanded`, `aria-activedescendant`, `aria-selected`); `onChange` fires only on change.
- **Site tests:** update existing `FilterBar` / `InboxPane` / `ComparePicker` tests and any e2e selectors that targeted native `<select>`/`<option>` to the new combobox/listbox roles.
- **Visual baselines:** regenerate affected inbox + settings baselines from CI; verify accent hover/active and both themes.
- **Live validation (gating):** in the **built** app, confirm (a) the Settings default-sort open list does **not** clip inside the modal, and (b) accent selection/hover legibility in both themes against the real token store.

## Risks

- **Settings clipping** (mitigated: 4 short options + documented portal fallback).
- **Type-ahead correctness** across rapid keystrokes (covered by unit tests).
- **a11y parity vs native** — keyboard + screen-reader behavior must not regress; validated against the `CommitMultiSelectPicker` pattern and unit-tested ARIA.
- **Baseline churn** — a shared trigger restyle touches several snapshots; regenerate from CI.
