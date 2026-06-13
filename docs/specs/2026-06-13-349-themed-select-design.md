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

Chosen over closed-state-only unification because only a custom control can theme the *open list*, which is the issue's core complaint. This also matches the project's established taste (custom design-system controls over native widgets).

**What we give up by leaving native `<select>`, and the honest risk rating.** A native `<select>` carries decades of screen-reader heuristics and (on touch platforms) an OS picker, for free. PRism is a **desktop-only app** (Electron + desktop browser); there is no mobile/touch surface, so abandoning the native touch picker costs nothing here. The screen-reader tradeoff is real and must be validated manually (see Testing), not assumed.

`CommitMultiSelectPicker` provides a **reusable scaffold** — the `combobox` trigger + `role=listbox` popup + `role=option` markup and the arrow/Home/End key handling — but it is **not** a full de-risk: it has no type-ahead, no disabled-option skipping, no click-outside dismiss, no focus-on-selected-when-opening, and it focuses the listbox element directly rather than using the `aria-activedescendant`-on-trigger model this `Select` uses. Those behaviors are **net-new with no in-repo precedent**, so the a11y-parity risk is real and rests on this slice's own unit tests + manual SR check, not on a proven pattern.

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

**Caller contracts:**

- **Labeling:** the trigger must have an accessible name — callers pass either `id` (with an external `<label htmlFor>`) or `aria-label`. In dev builds, the component warns (e.g. `console.warn`) if neither is supplied, so an unlabeled combobox (WCAG 1.3.1 / 4.1.2 failure) is caught early.
- **`disabled`:** disables the whole control. The trigger uses the native `disabled` attribute (removed from tab order, not merely `aria-disabled`); the popup cannot open.
- **Empty `options`:** the trigger renders disabled (no popup can open). No empty-state label is rendered inside the listbox in this slice.
- **`value` not in `options`:** treated as a caller error. It is not a live concern because all four sites always pass a `value` that is in range; the component does not add defensive UI for it in this slice.

### Internal structure (the "clean seam")

The component is built so an in-flow → portal migration is **contained — no rework tax at the call sites or in the tests**. To be precise about what that buys (and what it does not): the seam guarantees the four consumers and the behavior-level tests do not change when positioning changes. It does **not** make the portal free — the portal's own internals (trigger-rect computation, `absolute` → `fixed`, reposition-on-scroll/resize, viewport flip, focus management across the portal boundary) are genuine net-new work whether done now or later. The seam's value is that deferring that work costs nothing extra later, not that the work is zero.

- The popup is rendered behind **one internal seam** — an internal `Listbox` subcomponent (or `renderPopup()` helper) that owns its own positioning. Swapping in-flow → portal touches only this seam + its CSS + the net-new reposition/flip logic above.
- **Consumers only ever pass `options/value/onChange`** (+ aria/id/icon). No positioning concern leaks into call sites.
- **Tests assert behavior, not in-flow DOM structure** — role/keyboard/selection queries (which work transparently across a future portal), never "popup is a sibling of trigger".

These three properties are requirements, not nice-to-haves: they are what make the portal door cheap to open later.

## Behavior (Core + type-ahead)

Modeled on `CommitMultiSelectPicker`'s combobox/listbox pattern, simplified to single-select.

- **Trigger:** `<button role="combobox" aria-haspopup="listbox" aria-expanded aria-controls>` rendering the selected option's label + a caret (+ optional `leadingIcon`).
- **Popup:** `role="listbox"` with `aria-activedescendant`; each option `role="option"` + `aria-selected`. `max-height` + `overflow-y: auto` for long lists (mirrors `CommitMultiSelectPicker`, which handles many items this way).
- **Keyboard:**
  - Closed: ArrowDown / ArrowUp / Enter / Space open the list, with the **active option initialized to the currently selected option**.
  - Open: ArrowUp/ArrowDown move the active option **skipping `disabled` options** (and stopping at the first/last enabled option rather than wrapping past disabled neighbors indefinitely); Home/End jump to first/last *enabled*; Enter/Space select the active option and close + refocus the trigger; Escape closes + refocuses the trigger **without changing value**.
  - **Tab:** closes the popup and lets focus move to the next focusable element in natural DOM order — the handler does **not** `preventDefault` or refocus the trigger (otherwise a keyboard user could never Tab past an open Select in the Settings form).
  - **Type-ahead:** printable keystrokes accumulate into a buffer that resets after ~500ms idle; matching is **case-insensitive** against enabled options. When the buffer is a **single repeated character** (e.g. "nnn"), the active option **cycles** among enabled options whose label starts with that character; otherwise the active option jumps to the first enabled option whose label **starts with the accumulated prefix**. If nothing matches, the active option **does not change**.
- **Dismiss:** click/pointerdown outside the trigger+popup, or Escape.
- **Disabled options:** not selectable and skipped by keyboard nav. The label text itself is supplied by the caller (e.g. ComparePicker passes `Iter N (snapshot lost)`); "disabled" is a separate styling/behavior concern from the label and is rendered visibly muted (reduced-contrast text).
- **Single-option list:** renders and opens normally — the trigger is not auto-disabled for a one-item list. The component applies no list-length business logic.
- **Selection commit:** `onChange(value)` fires **only when the chosen value differs from the current `value`**. Re-selecting the already-selected option closes the popup but does **not** fire `onChange`.

## Open-list rendering (§4 decision: in-flow)

The popup renders **in-flow**: `position: absolute; top: calc(100% + gap); left: 0; z-index` on a `position: relative` root, with `max-height` + `overflow-y: auto`. No portal, no viewport flip.

**Rationale and known limitations (documented deliberately):**

- The only **live** clipping risk is the **Settings default-sort** select, which sits inside `SettingsModal`'s `overflow-y: auto` body. The list is 4 short options (~120px). Because the modal body *scrolls*, "mid-pane" is not a fixed distance from the bottom edge — a user can scroll the sort row arbitrarily close to the bottom. So the in-flow bet must be validated against the **worst case, not the nominal case**: at the **shortest supported viewport height**, with the modal scrolled so the sort row sits as low as it can, open the list and confirm no clipping. **This is a gating live check** (see Testing). If it clips in any supported viewport, the fallback is to portal the Settings case — contained at the call-site/test level thanks to the seam, though the portal internals are net-new work (see Internal structure). The in-flow default holds because that retrofit is cheap and deferring it costs nothing extra; we are not betting the architecture on the nominal case fitting.
- **ComparePicker is currently not mounted** anywhere in the live app (no `.tsx` imports it). It is migrated for consistency/correctness but cannot be visually validated in the running app; it carries no live clipping risk today.
- **Inbox sort** opens into open list area below the toolbar; no clipping ancestor.
- **Structural limitation accepted:** as a shared control, in-flow `Select` is **not drop-in-safe inside an arbitrary future scroll/overflow container**, and has **no viewport-edge flip**. Portal is the named upgrade path; the modal has no persistent `transform` (its `modalIn` animation has no `forwards` fill), so a future portal will cleanly escape it.

## Styling

Reuse the existing token vocabulary; introduce no new color values.

- **Trigger** reuses the `.sortSelect` treatment: `--surface-inset` background, `1px solid var(--border-2)`, `--radius-2`, `--text-sm`, and the focus-border-swap to `var(--accent)` (matches `.sortSelect:focus-visible`).
  - **Focus indicator on open:** the border-swap renders both on `:focus-visible` **and** whenever the popup is open (`[aria-expanded="true"]`), regardless of input modality — so opening via mouse click still shows which trigger owns the open list and keyboard users keep orientation.
  - **Disabled trigger:** `opacity: 0.5; cursor: not-allowed` (matching `SegmentedControl`'s disabled treatment), native `disabled` attribute, popup cannot open.
  - **Label width:** the trigger sizes to its container (width controlled by the caller via `className`; no min-width imposed and it does **not** grow to the longest option). The selected label truncates with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`, so a long label (or the two side-by-side ComparePicker triggers) never breaks surrounding layout.
- **Popup** reuses the `CommitMultiSelectPicker` listbox surface: `--surface-1` background, `1px solid var(--border-1)`, `--radius-3`, `var(--shadow-2)`, `--s-2` padding. It shows/hides **instantly** (conditional render, no CSS transition), so no `@media (prefers-reduced-motion)` guard is required; if a future design adds an open/close animation, the guard must be added then.
- **Options — accent-driven selection/hover (per design refinement):**
  - **Hover** (mouse) and **keyboard-active** (`aria-activedescendant`) option share **one** treatment: accent-tinted background `var(--accent-soft)` with `var(--accent)` text — so mouse and keyboard agree, and the option about to be chosen reads in the accent, not neutral grey.
  - **Selected** option (`aria-selected="true"`) carries a **persistent leading checkmark glyph** in `var(--accent)` plus `var(--accent)` text. **All** options reserve the same leading gutter (whether or not selected) so labels do not shift horizontally when the selection changes. This is distinct from the transient active/hover background.
  - Resting option: `transparent` background, `--text-1`.
- Verified live in **both light and dark themes** (accent tokens are theme-asymmetric: `--accent-soft` is a light tint in light theme, a dark tint in dark theme — confirm the accent-on-accent-soft text and the muted-disabled text stay legible in both).

## Migrations

Replace all four `<select>` sites with `Select`:

1. **Inbox sort** — `FilterBar.tsx`. `options={SORT_OPTIONS.map(...)}`, `value={f.sort}`, `onChange={f.setSort}`, `aria-label="Sort"`, `leadingIcon={<sort glyph>}`. The existing `.sort` wrapper, external caret SVG, and `.sortSelect` rules are removed/absorbed into `Select`.
2. **Settings default sort** — `InboxPane.tsx`. `id="inbox-default-sort"` (preserves the `<label htmlFor>` association), `options={SORT_OPTIONS.map(...)}`, `value={defaultSort}`, `onChange={(v) => set('inbox.defaultSort', v)}`.
3. **ComparePicker ×2** — `ComparePicker.tsx`. Numeric values; `disabled` set from `!iter.hasResolvableRange`; labels `Iter N` / `Iter N (snapshot lost)`; `aria-label="From iteration"` / `"To iteration"`. Only the two `<select>` elements are swapped for `Select`; the from/to swap logic in `handleFromChange`/`handleToChange` is preserved verbatim (so behavior is unchanged and the existing `ComparePicker` tests still hold).

   **ComparePicker is unmounted dead code today** (no live `.tsx` imports it). It is migrated anyway so a future re-mount does not silently reintroduce an unthemed native dropdown — but it is therefore **unit-tested only and explicitly outside the B1 visual gate** (it cannot be opened in the running app). Reviewers flagged this as zero-live-value scope; it is kept deliberately, with the validation gap stated rather than hidden.

`SORT_OPTIONS` (`applyInboxFilters.ts`) is reused as-is.

## Testing

- **Unit (`Select.test.tsx`):** open/close via mouse + keyboard; active-option initialized to selected on open; ArrowUp/Down/Home/End navigation; **disabled-option skip + boundary stop** (no infinite skip when neighbors are disabled); type-ahead (case-insensitive prefix match, idle reset, single-repeated-char cycle, **no-match leaves active unchanged**); Enter/Space selection + close + trigger refocus; **Escape closes without value change**; **Tab closes without preventing default focus move**; **re-selecting the current value closes but does not fire `onChange`**; click-outside dismiss; **empty `options` → disabled trigger**; **single-option list opens normally**; ARIA attributes (`role`, `aria-expanded`, `aria-haspopup`, `aria-controls`, `aria-activedescendant`, `aria-selected`); dev warning when neither `id` nor `aria-label` is supplied.
- **Site tests:** update existing `FilterBar` / `InboxPane` tests, the `ComparePicker` test (unit-only, unmounted component), and any e2e selectors that targeted native `<select>`/`<option>` to the new combobox/listbox roles.
- **Visual baselines:** regenerate affected inbox + settings baselines from CI; verify accent hover/active and both themes.
- **Manual screen-reader check (gating, a11y-parity):** with NVDA + Chrome on the built app, confirm the trigger announces its label and `expanded` state, and that the **re-focused trigger announces the newly selected value** after commit (the close+refocus is the announcement mechanism; no separate live region). This is the parity check the net-new behaviors require, since no existing pattern validates them.
- **Live validation (gating):** in the **built** app, confirm (a) the Settings default-sort open list does **not** clip inside the modal **at the shortest supported viewport with the row scrolled to its lowest position** (worst case, per §Open-list rendering), and (b) accent selection/hover legibility in both themes against the real token store.

## Risks

- **a11y parity vs native (highest risk).** Type-ahead, disabled-skip nav, click-outside dismiss, focus-on-selected, and the `aria-activedescendant` focus model are **net-new with no in-repo precedent** — they are *not* validated by `CommitMultiSelectPicker`, which lacks all of them. Parity rests entirely on this slice's unit tests + the manual NVDA check. A native-`<select>` screen-reader regression is the most likely way this slice degrades real behavior while looking fine visually.
- **Settings clipping** (mitigated: 4 short options + worst-case live gate + documented portal fallback).
- **Type-ahead correctness** across rapid keystrokes and the prefix-vs-cycle disambiguation (covered by unit tests; net-new logic).
- **Baseline churn** — a shared trigger restyle touches several snapshots; regenerate from CI and **inspect**, don't blindly accept.
