# Shared themed `Select` component — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four native `<select>` dropdowns (inbox sort, Settings default-sort, ComparePicker ×2) with one shared accessible themed `Select` whose open option list is styled with the app's design tokens.

**Architecture:** A single generic `Select<T>` control in `frontend/src/components/controls/`, built as a `role="combobox"` trigger + in-flow `role="listbox"` popup, modeled on the existing `CommitMultiSelectPicker`/`DiffSettingsMenu` patterns (single internal seam for a future portal). Keyboard nav, type-ahead, click-outside dismiss, and accent-driven option states are net-new. In-flow positioning (no portal/flip) per the spec.

**Tech Stack:** React 19 + TypeScript, CSS Modules, Vitest + Testing Library + `@testing-library/user-event`. No new dependencies.

**Spec:** `docs/specs/2026-06-13-349-themed-select-design.md`

**Conventions for every task below:**
- All commands run from the `frontend/` directory.
- Single-file test run: `npm test -- <path>` (this is `vitest run <path>`).
- Commit messages use the issue scope `(#349)`. Co-author trailer per repo convention.

---

## File Structure

- **Create** `frontend/src/components/controls/Select.tsx` — the generic control (trigger + listbox + keyboard + type-ahead). One responsibility: a single-select themed dropdown.
- **Create** `frontend/src/components/controls/Select.module.css` — all visual treatment (trigger, popup, option states).
- **Create** `frontend/src/components/controls/Select.test.tsx` — unit tests.
- **Modify** `frontend/src/components/Inbox/filters/FilterBar.tsx` — inbox sort migration.
- **Modify** `frontend/src/components/Inbox/filters/filters.module.css` — remove the now-dead `.sort` / `.sortGlyph` / `.sortCaret` / `.sortSelect` rules.
- **Modify** `frontend/src/components/Settings/panes/InboxPane.tsx` — Settings default-sort migration.
- **Modify** `frontend/src/components/PrDetail/FilesTab/ComparePicker.tsx` — ComparePicker ×2 migration (unmounted; unit-tested only).
- **Modify** `frontend/src/components/PrDetail/FilesTab/ComparePicker.module.css` — remove the now-dead `.comparePickerSelect` rule.
- **Update** affected site tests + any e2e selectors that targeted native `<select>`/`<option>`.

---

## Task 1: `Select` core — render, click-to-open, click-to-select, outside-click, ARIA

**Files:**
- Create: `frontend/src/components/controls/Select.module.css`
- Create: `frontend/src/components/controls/Select.tsx`
- Test: `frontend/src/components/controls/Select.test.tsx`

- [ ] **Step 1: Write the CSS module** (no test gates CSS; create it first so the component renders styled)

Create `frontend/src/components/controls/Select.module.css`:

```css
.root {
  position: relative;
  display: inline-flex;
}

/* ===== Trigger (closed control) — mirrors filters .sortSelect tokens ===== */
.trigger {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  height: 28px;
  padding: 0 var(--s-2);
  font: inherit;
  font-size: var(--text-sm);
  color: var(--text-1);
  background: var(--surface-inset);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-2);
  cursor: pointer;
}
/* Focus-border swap on keyboard focus AND whenever the popup is open, so a
   mouse-click-open still shows which trigger owns the list. */
.trigger:focus-visible,
.trigger[data-open] {
  border-color: var(--accent);
  outline: none;
}
.trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.leading {
  display: inline-flex;
  color: var(--text-3);
}
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.caret {
  display: inline-flex;
  color: var(--text-3);
}

/* ===== Popup (open list) — mirrors CommitMultiSelectPicker listbox ===== */
.listbox {
  position: absolute;
  top: calc(100% + var(--s-1));
  left: 0;
  z-index: 10;
  min-width: 100%;
  max-height: 280px;
  overflow-y: auto;
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  box-shadow: var(--shadow-2);
  padding: var(--s-1);
  display: flex;
  flex-direction: column;
}
.option {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-1) var(--s-2);
  border-radius: var(--radius-1);
  font-size: var(--text-sm);
  color: var(--text-1);
  cursor: pointer;
  white-space: nowrap;
}
/* Hover (mouse) and keyboard-active share ONE accent treatment. */
.optionActive {
  background: var(--accent-soft);
  color: var(--accent);
}
.optionDisabled {
  color: var(--text-3);
  cursor: not-allowed;
}
/* Persistent selected affordance: accent check + accent label. The gutter is
   reserved on EVERY option so labels don't shift when selection changes. */
.check {
  flex: 0 0 1rem;
  display: inline-flex;
  justify-content: center;
  color: var(--accent);
}
.option[aria-selected='true'] .optionLabel {
  color: var(--accent);
}
.optionLabel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 2: Write the failing core tests**

Create `frontend/src/components/controls/Select.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Select } from './Select';

const OPTS = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'pushed', label: 'Recently pushed' },
  { value: 'diff', label: 'Largest diff' },
  { value: 'comments', label: 'Most comments' },
];

describe('Select — core', () => {
  it('renders a combobox showing the selected label, list closed', () => {
    render(<Select aria-label="Sort" options={OPTS} value="pushed" onChange={() => {}} />);
    const trigger = screen.getByRole('combobox', { name: 'Sort' });
    expect(trigger).toHaveTextContent('Recently pushed');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens the listbox on trigger click and renders all options', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={() => {}} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Sort' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(screen.getByRole('option', { name: 'Recently updated' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('selecting an option fires onChange and closes the list', async () => {
    const onChange = vi.fn();
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={onChange} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Sort' }));
    await userEvent.click(screen.getByRole('option', { name: 'Largest diff' }));
    expect(onChange).toHaveBeenCalledWith('diff');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('clicking outside closes the list without firing onChange', async () => {
    const onChange = vi.fn();
    render(
      <div>
        <Select aria-label="Sort" options={OPTS} value="updated" onChange={onChange} />
        <button>outside</button>
      </div>,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Sort' }));
    await userEvent.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('sets combobox/listbox ARIA wiring', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={() => {}} />);
    const trigger = screen.getByRole('combobox', { name: 'Sort' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
  });
});
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `npm test -- src/components/controls/Select.test.tsx`
Expected: FAIL — `Select` is not exported / module not found.

- [ ] **Step 4: Implement the core component**

Create `frontend/src/components/controls/Select.tsx`:

```tsx
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import styles from './Select.module.css';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string | number> {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  id?: string;
  'aria-label'?: string;
  leadingIcon?: ReactNode;
  disabled?: boolean;
  className?: string;
}

const CARET = (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
    <path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.94l3.72-3.72a.749.749 0 0 1 1.06 0Z" />
  </svg>
);

export function Select<T extends string | number>({
  options,
  value,
  onChange,
  id,
  'aria-label': ariaLabel,
  leadingIcon,
  disabled = false,
  className,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const instanceId = useId();
  const listboxId = `${instanceId}-listbox`;

  const isDisabled = disabled || options.length === 0;
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : '';

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    // Defer focus so it lands after the click-sequence that closed us
    // (mirrors DiffSettingsMenu).
    if (refocus) setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const openList = useCallback(() => {
    if (isDisabled) return;
    const enabledSelected = selectedIndex >= 0 && !options[selectedIndex].disabled;
    setActiveIndex(enabledSelected ? selectedIndex : firstEnabled(options));
    setOpen(true);
  }, [isDisabled, options, selectedIndex]);

  const commit = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt || opt.disabled) return;
      if (opt.value !== value) onChange(opt.value);
      close(true);
    },
    [options, value, onChange, close],
  );

  // Outside-click dismiss (net-new vs CommitMultiSelectPicker).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const activeId = open && activeIndex >= 0 ? `${instanceId}-opt-${activeIndex}` : undefined;

  return (
    <div ref={rootRef} className={`${styles.root}${className ? ` ${className}` : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        disabled={isDisabled}
        className={styles.trigger}
        data-open={open || undefined}
        onClick={() => (open ? close(true) : openList())}
      >
        {leadingIcon && (
          <span className={styles.leading} aria-hidden="true">
            {leadingIcon}
          </span>
        )}
        <span className={styles.label}>{selectedLabel}</span>
        <span className={styles.caret}>{CARET}</span>
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={activeId}
          tabIndex={-1}
          className={styles.listbox}
        >
          {options.map((o, i) => (
            <div
              key={String(o.value)}
              id={`${instanceId}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={[
                styles.option,
                i === activeIndex ? styles.optionActive : '',
                o.disabled ? styles.optionDisabled : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onPointerEnter={() => !o.disabled && setActiveIndex(i)}
              onClick={() => commit(i)}
            >
              <span className={styles.check} aria-hidden="true">
                {o.value === value ? '✓' : ''}
              </span>
              <span className={styles.optionLabel}>{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Option-index helpers (module scope; shared with keyboard nav) =====

function firstEnabled<T extends string | number>(options: SelectOption<T>[]): number {
  return options.findIndex((o) => !o.disabled);
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npm test -- src/components/controls/Select.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/controls/Select.tsx frontend/src/components/controls/Select.module.css frontend/src/components/controls/Select.test.tsx
git commit -m "feat(#349): add Select core (combobox + listbox, click + outside-click)"
```

---

## Task 2: Keyboard navigation

**Files:**
- Modify: `frontend/src/components/controls/Select.tsx`
- Test: `frontend/src/components/controls/Select.test.tsx`

- [ ] **Step 1: Add the failing keyboard tests**

Append to `Select.test.tsx` (new `describe` block):

```tsx
describe('Select — keyboard', () => {
  const DIS = [
    { value: 1, label: 'Iter 1' },
    { value: 2, label: 'Iter 2 (snapshot lost)', disabled: true },
    { value: 3, label: 'Iter 3' },
  ];

  it('opens on ArrowDown with the selected option active', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="pushed" onChange={() => {}} />);
    const trigger = screen.getByRole('combobox', { name: 'Sort' });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Recently pushed' })).toHaveClass(/optionActive/);
  });

  it('Arrow keys skip disabled options and stop at the boundary (no wrap)', async () => {
    render(<Select aria-label="Iter" options={DIS} value={1} onChange={() => {}} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // 1 -> skip disabled 2 -> 3
    expect(screen.getByRole('option', { name: 'Iter 3' })).toHaveClass(/optionActive/);
    await userEvent.keyboard('{ArrowDown}'); // at last enabled -> stays
    expect(screen.getByRole('option', { name: 'Iter 3' })).toHaveClass(/optionActive/);
  });

  it('Enter selects the active option and closes', async () => {
    const onChange = vi.fn();
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={onChange} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}{Enter}'); // updated -> pushed
    expect(onChange).toHaveBeenCalledWith('pushed');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape closes without changing value', async () => {
    const onChange = vi.fn();
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={onChange} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Home/End jump to first/last enabled', async () => {
    render(<Select aria-label="Iter" options={DIS} value={3} onChange={() => {}} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // open
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('option', { name: 'Iter 1' })).toHaveClass(/optionActive/);
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('option', { name: 'Iter 3' })).toHaveClass(/optionActive/);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -- src/components/controls/Select.test.tsx`
Expected: FAIL — `Select — keyboard` cases fail (no key handling yet; list never opens via keyboard).

- [ ] **Step 3: Add the nav helpers**

In `Select.tsx`, replace the helper section at the bottom (currently only `firstEnabled`) with:

```tsx
// ===== Option-index helpers (module scope; shared with keyboard nav) =====

function firstEnabled<T extends string | number>(options: SelectOption<T>[]): number {
  return options.findIndex((o) => !o.disabled);
}

function lastEnabled<T extends string | number>(options: SelectOption<T>[]): number {
  for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
  return -1;
}

// Move `delta` from `current`, skipping disabled options. Clamp at the first/last
// enabled option — do NOT wrap (spec: stop at boundary).
function nextEnabled<T extends string | number>(
  options: SelectOption<T>[],
  current: number,
  delta: number,
): number {
  let i = current;
  for (;;) {
    const candidate = i + delta;
    if (candidate < 0 || candidate >= options.length) return i; // boundary: stay
    i = candidate;
    if (!options[i].disabled) return i;
  }
}
```

- [ ] **Step 4: Add the key handler**

In `Select.tsx`, add this `onKeyDown` callback inside the component, after the `commit` definition:

```tsx
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isDisabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((cur) => nextEnabled(options, cur, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((cur) => nextEnabled(options, cur, -1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(firstEnabled(options));
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(lastEnabled(options));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        // Close, but let focus move on naturally — no preventDefault, no refocus,
        // so a keyboard user can Tab past an open Select in the Settings form.
        close(false);
        break;
    }
  };
```

Then attach it to the root `<div>` (so it fires whether focus is on the trigger or the listbox):

```tsx
    <div ref={rootRef} className={`${styles.root}${className ? ` ${className}` : ''}`} onKeyDown={onKeyDown}>
```

- [ ] **Step 5: Run, verify pass**

Run: `npm test -- src/components/controls/Select.test.tsx`
Expected: PASS (all core + keyboard tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/controls/Select.tsx frontend/src/components/controls/Select.test.tsx
git commit -m "feat(#349): keyboard nav for Select (arrows skip-disabled, Home/End, Enter, Escape, Tab)"
```

---

## Task 3: Type-ahead

**Files:**
- Modify: `frontend/src/components/controls/Select.tsx`
- Test: `frontend/src/components/controls/Select.test.tsx`

- [ ] **Step 1: Add the failing type-ahead tests**

Append to `Select.test.tsx`:

```tsx
describe('Select — type-ahead', () => {
  it('jumps to the first option matching the accumulated prefix (case-insensitive)', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={() => {}} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // open
    await userEvent.keyboard('la'); // "Largest diff"
    expect(screen.getByRole('option', { name: 'Largest diff' })).toHaveClass(/optionActive/);
  });

  it('cycles among matches when the same character repeats', async () => {
    const opts = [
      { value: 'a', label: 'Apple' },
      { value: 'b', label: 'Apricot' },
      { value: 'c', label: 'Cherry' },
    ];
    render(<Select aria-label="Fruit" options={opts} value="a" onChange={() => {}} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // open, active = Apple
    await userEvent.keyboard('a'); // next A-match after Apple -> Apricot
    expect(screen.getByRole('option', { name: 'Apricot' })).toHaveClass(/optionActive/);
    await userEvent.keyboard('a'); // cycle back to Apple
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveClass(/optionActive/);
  });

  it('leaves the active option unchanged when nothing matches', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={() => {}} />);
    screen.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}'); // active = Recently updated
    await userEvent.keyboard('zzz');
    expect(screen.getByRole('option', { name: 'Recently updated' })).toHaveClass(/optionActive/);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -- src/components/controls/Select.test.tsx`
Expected: FAIL — printable keys are not yet handled (active option does not move).

- [ ] **Step 3: Add the type-ahead matcher helper**

In `Select.tsx`, append to the helper section:

```tsx
// Type-ahead match. Single-repeated-character buffer (e.g. "a", "aa") cycles
// among enabled options whose label starts with that character, advancing past
// `activeIndex`; any other buffer jumps to the first enabled prefix match.
// Returns -1 when nothing matches (caller keeps the current active option).
function matchTypeahead<T extends string | number>(
  options: SelectOption<T>[],
  buffer: string,
  activeIndex: number,
): number {
  const enabled = options
    .map((o, i) => ({ label: o.label.toLowerCase(), i, disabled: o.disabled }))
    .filter((x) => !x.disabled);
  const allSame = [...buffer].every((c) => c === buffer[0]);
  if (allSame) {
    const matches = enabled.filter((x) => x.label.startsWith(buffer[0]));
    if (matches.length === 0) return -1;
    return (matches.find((m) => m.i > activeIndex) ?? matches[0]).i;
  }
  const match = enabled.find((x) => x.label.startsWith(buffer));
  return match ? match.i : -1;
}
```

- [ ] **Step 4: Wire type-ahead into the component**

In `Select.tsx`, add a type-ahead buffer ref alongside the other refs:

```tsx
  const typeahead = useRef({ buffer: '', timer: 0 });
```

Then in `onKeyDown`, add a `default` arm to the open-state `switch` (after the `Tab` case):

```tsx
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          const ta = typeahead.current;
          window.clearTimeout(ta.timer);
          ta.timer = window.setTimeout(() => (ta.buffer = ''), 500);
          ta.buffer += e.key.toLowerCase();
          const match = matchTypeahead(options, ta.buffer, activeIndex);
          if (match >= 0) setActiveIndex(match);
        }
```

- [ ] **Step 5: Run, verify pass**

Run: `npm test -- src/components/controls/Select.test.tsx`
Expected: PASS (all suites).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/controls/Select.tsx frontend/src/components/controls/Select.test.tsx
git commit -m "feat(#349): type-ahead for Select (prefix jump + single-char cycle)"
```

---

## Task 4: Consumer contracts — disabled, empty options, single option, labeling warn, no-op re-select

**Files:**
- Modify: `frontend/src/components/controls/Select.tsx`
- Test: `frontend/src/components/controls/Select.test.tsx`

- [ ] **Step 1: Add the failing contract tests**

Append to `Select.test.tsx`:

```tsx
describe('Select — contracts', () => {
  it('renders a disabled trigger when `disabled` is set; cannot open', async () => {
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={() => {}} disabled />);
    const trigger = screen.getByRole('combobox', { name: 'Sort' });
    expect(trigger).toBeDisabled();
    await userEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('disables the trigger when options is empty', () => {
    render(<Select aria-label="Sort" options={[]} value={'x' as string} onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Sort' })).toBeDisabled();
  });

  it('a single-option list opens normally', async () => {
    render(
      <Select aria-label="Sort" options={[{ value: 'updated', label: 'Recently updated' }]} value="updated" onChange={() => {}} />,
    );
    await userEvent.click(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('re-selecting the current value closes the list but does not fire onChange', async () => {
    const onChange = vi.fn();
    render(<Select aria-label="Sort" options={OPTS} value="updated" onChange={onChange} />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Recently updated' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('warns in dev when neither id nor aria-label is provided', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Select options={OPTS} value="updated" onChange={() => {}} />);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Select'));
    warn.mockRestore();
  });
});
```

Note: the disabled-trigger, empty-options, single-option, and no-op-reselect behaviors are **already implemented** by Task 1's `isDisabled`/`commit` logic — these tests lock them in. Only the dev-warn is new code.

- [ ] **Step 2: Run, verify which fail**

Run: `npm test -- src/components/controls/Select.test.tsx`
Expected: only the **dev-warn** test fails (`console.warn` never called); the other four pass.

- [ ] **Step 3: Add the dev-only labeling guard**

In `Select.tsx`, add immediately after `const isDisabled = ...`:

```tsx
  if (import.meta.env.DEV && !id && !ariaLabel) {
    console.warn(
      'Select: provide either `id` (with a <label htmlFor>) or `aria-label` for an accessible name.',
    );
  }
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -- src/components/controls/Select.test.tsx`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/controls/Select.tsx frontend/src/components/controls/Select.test.tsx
git commit -m "test(#349): lock Select contracts + dev labeling guard"
```

---

## Task 5: Migrate the inbox sort control (live site)

**Files:**
- Modify: `frontend/src/components/Inbox/filters/FilterBar.tsx:88-124`
- Modify: `frontend/src/components/Inbox/filters/filters.module.css`
- Test: `frontend/src/components/Inbox/filters/FilterBar.test.tsx` (locate the sort test; if no dedicated test exists, the InboxPage-level tests exercise it)

- [ ] **Step 1: Update the FilterBar test for the new combobox role**

Find the existing sort assertion. Native `<select aria-label="Sort">` exposes `role="combobox"` already, so a `getByRole('combobox', { name: 'Sort' })` query still resolves. The behavior change: selecting is now two interactions (open, then click option) instead of `selectOptions`. Replace any `userEvent.selectOptions(sortSelect, 'diff')` with:

```tsx
await userEvent.click(screen.getByRole('combobox', { name: 'Sort' }));
await userEvent.click(screen.getByRole('option', { name: 'Largest diff' }));
```

If `FilterBar.test.tsx` has no sort-specific test, add one:

```tsx
it('changes sort via the themed Select', async () => {
  // ...render FilterBar with its required props (mirror existing tests in this file)...
  await userEvent.click(screen.getByRole('combobox', { name: 'Sort' }));
  await userEvent.click(screen.getByRole('option', { name: 'Most comments' }));
  // assert the onState/result reflects the 'comments' sort per this file's existing pattern
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -- src/components/Inbox/filters/FilterBar.test.tsx`
Expected: FAIL — `getByRole('option', ...)` finds nothing (native `<option>`s are not in the a11y tree until the native popup opens; with the native `<select>` still in place, the two-click interaction does not surface listbox options).

- [ ] **Step 3: Replace the native sort `<select>` with `Select`**

In `FilterBar.tsx`, add the import:

```tsx
import { Select } from '../../controls/Select';
```

Replace the entire `<span className={styles.sort}>...</span>` block (the leading glyph `<svg>`, the `<select className={styles.sortSelect}>`, and the trailing caret `<svg>`) with:

```tsx
          <Select
            className={styles.sort}
            aria-label="Sort"
            value={f.sort}
            onChange={(v) => f.setSort(v)}
            options={SORT_OPTIONS.map((s) => ({ value: s.key, label: s.label }))}
            leadingIcon={
              <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
                <path d="M0 4.25c0-.414.336-.75.75-.75h11.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 4.25Zm2 4a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 2 8.25Zm2 4a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75Z" />
              </svg>
            }
          />
```

`f.setSort` already accepts a `SortKey`; the `as SortKey` cast from the old `e.target.value` handler is no longer needed because `Select`'s `onChange` is typed `(value: SortKey) => void` via inference from `value={f.sort}`.

- [ ] **Step 4: Remove the now-dead CSS rules**

In `filters.module.css`, delete the `.sort` block's now-unused inner pieces and the dead rules. Keep `.sort` only if it still carries useful layout (inline-flex/gap); since `Select` now owns the control, simplify `.sort` to a thin layout wrapper or remove it and drop the `className={styles.sort}` prop. Delete `.sortGlyph`, `.sortCaret`, `.sortSelect`, and `.sortSelect:focus-visible`. Verify no other file references them:

Run: `git grep -nE "sortGlyph|sortCaret|sortSelect" frontend/src`
Expected: no matches after the edit.

- [ ] **Step 5: Run the relevant suites, verify pass**

Run: `npm test -- src/components/Inbox`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Inbox/filters/FilterBar.tsx frontend/src/components/Inbox/filters/filters.module.css frontend/src/components/Inbox/filters/FilterBar.test.tsx
git commit -m "feat(#349): migrate inbox sort to themed Select"
```

---

## Task 6: Migrate the Settings default-sort control (live site)

**Files:**
- Modify: `frontend/src/components/Settings/panes/InboxPane.tsx:161-177`
- Test: `frontend/src/components/Settings/panes/InboxPane.test.tsx`

- [ ] **Step 1: Update the InboxPane test**

Find the default-sort assertion (likely `userEvent.selectOptions(...)` against `getByLabelText('Default sort')`). The label association is preserved via `id="inbox-default-sort"`, so `getByRole('combobox', { name: 'Default sort' })` resolves. Replace the selection interaction:

```tsx
await userEvent.click(screen.getByRole('combobox', { name: 'Default sort' }));
await userEvent.click(screen.getByRole('option', { name: 'Largest diff' }));
// assert set('inbox.defaultSort', 'diff') was called, per this file's existing mock pattern
```

- [ ] **Step 2: Run, verify failure**

Run: `npm test -- src/components/Settings/panes/InboxPane.test.tsx`
Expected: FAIL — listbox options not present while the native `<select>` is still in place.

- [ ] **Step 3: Replace the native `<select>` with `Select`**

In `InboxPane.tsx`, add the import:

```tsx
import { Select } from '../../controls/Select';
```

Replace the `<select id="inbox-default-sort" ...>...</select>` block with:

```tsx
        <Select
          id="inbox-default-sort"
          value={defaultSort}
          onChange={(v) => set('inbox.defaultSort', v).catch(() => {})}
          options={SORT_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
        />
```

The external `<label htmlFor="inbox-default-sort">Default sort</label>` row stays unchanged and provides the accessible name.

- [ ] **Step 4: Run, verify pass**

Run: `npm test -- src/components/Settings/panes/InboxPane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Settings/panes/InboxPane.tsx frontend/src/components/Settings/panes/InboxPane.test.tsx
git commit -m "feat(#349): migrate Settings default-sort to themed Select"
```

---

## Task 7: Migrate ComparePicker ×2 (unmounted; unit-tested only)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/ComparePicker.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/ComparePicker.module.css`
- Test: `frontend/src/components/PrDetail/FilesTab/ComparePicker.test.tsx`

- [ ] **Step 1: Update the ComparePicker test**

Replace any `userEvent.selectOptions` interactions targeting the From/To selects with the open-then-click pattern, keyed on the `aria-label`s `From iteration` / `To iteration`:

```tsx
await userEvent.click(screen.getByRole('combobox', { name: 'From iteration' }));
await userEvent.click(screen.getByRole('option', { name: 'Iter 2' }));
// assert onCompare reflects the from/to swap logic per the existing test's expectations
```

Keep any assertions about disabled options — they now assert `aria-disabled="true"` on the `role="option"` (or that the option is not selectable), instead of a disabled native `<option>`.

- [ ] **Step 2: Run, verify failure**

Run: `npm test -- src/components/PrDetail/FilesTab/ComparePicker.test.tsx`
Expected: FAIL — listbox options not present while native `<select>`s remain.

- [ ] **Step 3: Replace both native `<select>`s with `Select` and adapt the handlers**

In `ComparePicker.tsx`, add the import:

```tsx
import { Select } from '../../../controls/Select';
```

Change the two change handlers to take a numeric value directly (the `Select` `onChange` gives `value: number`, not an event):

```tsx
  const handleFromChange = (newFrom: number) => {
    if (newFrom > effectiveTo) {
      onCompare(effectiveTo, newFrom);
    } else {
      onCompare(newFrom, effectiveTo);
    }
  };

  const handleToChange = (newTo: number) => {
    if (effectiveFrom > newTo) {
      onCompare(newTo, effectiveFrom);
    } else {
      onCompare(effectiveFrom, newTo);
    }
  };
```

Build a shared option list from `iterations`:

```tsx
  const iterOptions = iterations.map((iter) => ({
    value: iter.number,
    label: iter.hasResolvableRange ? `Iter ${iter.number}` : `Iter ${iter.number} (snapshot lost)`,
    disabled: !iter.hasResolvableRange,
  }));
```

Replace the first `<select aria-label="From iteration" ...>...</select>` with:

```tsx
        <Select
          aria-label="From iteration"
          value={effectiveFrom}
          onChange={handleFromChange}
          options={iterOptions}
        />
```

Replace the second `<select aria-label="To iteration" ...>...</select>` with:

```tsx
        <Select
          aria-label="To iteration"
          value={effectiveTo}
          onChange={handleToChange}
          options={iterOptions}
        />
```

- [ ] **Step 4: Remove the dead CSS rule**

In `ComparePicker.module.css`, delete the `.comparePickerSelect` rule (and any `:focus`/`appearance` variants). Verify:

Run: `git grep -nE "comparePickerSelect|compare-picker-select" frontend/src`
Expected: no matches.

- [ ] **Step 5: Run, verify pass**

Run: `npm test -- src/components/PrDetail/FilesTab/ComparePicker.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/ComparePicker.tsx frontend/src/components/PrDetail/FilesTab/ComparePicker.module.css frontend/src/components/PrDetail/FilesTab/ComparePicker.test.tsx
git commit -m "feat(#349): migrate ComparePicker to themed Select (unit-tested only)"
```

---

## Task 8: Sweep e2e selectors, full verification, baseline note

**Files:**
- Modify: any `frontend/e2e/**` specs selecting native `<select>`/`<option>` for sort/compare.

- [ ] **Step 1: Find native-select selectors in e2e**

Run: `git grep -nE "selectOption|<select|getByRole\('option'|locator\('select" frontend/e2e`
Inspect each hit touching inbox sort, Settings default-sort, or compare. Native Playwright `selectOption()` will no longer work against the custom `Select` — replace with click-the-trigger then click-the-option:

```ts
await page.getByRole('combobox', { name: 'Sort' }).click();
await page.getByRole('option', { name: 'Largest diff' }).click();
```

Leave unrelated `<select>` usages (if any outside these three sites) untouched. If there are no matching e2e selectors, record that and move on.

- [ ] **Step 2: Typecheck + full unit suite**

Run: `npm run build` (this runs `tsc -b` then vite build — catches type regressions in the generic `Select` and the migrated call sites)
Expected: PASS, no TS errors.

Run: `npm test`
Expected: PASS (entire frontend unit suite).

- [ ] **Step 3: Lint + format (bypass the rtk proxy for prettier)**

Run: `npm run lint`
If prettier reports clean here but you are unsure (the rtk proxy can mask prettier exit codes), confirm with the real binary:
Run: `npx prettier --check "src/components/controls/Select*"`
Expected: both clean. Fix with `npx prettier --write` if needed.

- [ ] **Step 4: Visual baselines + live validation (deferred to PR / human gate)**

Record in the PR `## Proof` that the following are pending the B1 visual gate (do NOT fabricate baselines locally):
- Regenerate inbox + settings visual baselines from CI after the run.
- Live check (built app, real token store): inbox sort + Settings default-sort open list themed in **both** light and dark themes; accent hover/active legible; **Settings list does not clip at the shortest supported viewport with the sort row scrolled to its lowest position** (per spec §Open-list rendering).
- Manual NVDA + Chrome check: trigger announces label + expanded; re-focused trigger announces the newly selected value after commit.
- ComparePicker is unmounted → **outside** the visual gate; unit tests only.

- [ ] **Step 5: Commit any e2e/selector changes**

```bash
git add frontend/e2e
git commit -m "test(#349): update e2e selectors for themed Select"
```

---

## Self-Review (completed during planning)

**Spec coverage:** Component/API → Task 1. Keyboard (open-keys, skip-disabled+boundary, Home/End, Enter/Space, Escape, Tab) → Task 2. Type-ahead (prefix, single-char cycle, no-match) → Task 3. Contracts (disabled, empty, single-option, no-op re-select, labeling warn) → Task 4. Styling (trigger tokens, open-state ring, disabled, truncation, instant popup, accent hover/active, checkmark gutter) → Task 1 CSS. Migrations (inbox sort + glyph via `leadingIcon`, Settings id/label, ComparePicker swap-logic preserved) → Tasks 5–7. Testing (unit cases, site tests, e2e, manual SR + worst-case clip gate, baselines) → Tasks 1–4, 8. In-flow positioning → Task 1 CSS (`.listbox` absolute). Clean seam → the `.listbox` lives in one render branch with token-only positioning; behavior tests query roles, not DOM structure.

**Placeholder scan:** none — every code step shows the actual code/command.

**Type consistency:** `SelectOption<T>`/`SelectProps<T>` defined in Task 1 are referenced consistently; helpers `firstEnabled`/`lastEnabled`/`nextEnabled`/`matchTypeahead` introduced before use (Tasks 2–3); `commit`/`close(refocus)`/`openList` signatures stable across tasks; migrations map `{ key, label }` → `{ value, label }` consistently and ComparePicker handlers are re-typed to `(value: number)`.
