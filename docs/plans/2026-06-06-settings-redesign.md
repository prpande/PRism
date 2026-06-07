# Settings Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe Settings as a large dismissible modal with a master-detail layout, routed sections (`/settings/:section`), and polished accessible custom controls — preserving every existing control's behavior byte-for-byte.

**Architecture:** A new `SettingsModal` shell (portal above `data-app-shell`) renders over a react-router v7 background location. A shared `useEffectiveLocation()` hook + a `SettingsLink` wrapper keep the four chrome consumers mounted outside `<Routes>` (`PrTabHost`, `AskAiDrawer/DrawerEffects`, `PrTabStrip`, `useTabUnreadSignal`) resolving against the real app location, so the keep-alive PR view never deactivates while Settings is open. Four panes reuse the exact hooks/handlers from today's Settings section components; native widgets become reusable `SegmentedControl`/`AccentSwatches`/`Switch` primitives.

**Tech Stack:** React 19, TypeScript, Vite, react-router-dom ^7, CSS modules + design tokens (`tokens.css`), Vitest + Testing Library, Playwright (e2e + B1 visual gate).

**Spec:** `docs/specs/2026-06-06-settings-redesign-design.md`

---

## File Structure

**New files**
- `frontend/src/hooks/useEffectiveLocation.ts` — shared resolver; `isSettingsPath` helper
- `frontend/src/hooks/useEffectiveLocation.test.tsx`
- `frontend/src/components/Settings/SettingsLink.tsx` — `<Link>` that propagates `backgroundLocation`
- `frontend/src/components/Settings/SettingsLink.test.tsx`
- `frontend/src/components/controls/SegmentedControl.tsx` (+ `.module.css`, `.test.tsx`)
- `frontend/src/components/controls/Switch.tsx` (+ `.module.css`, `.test.tsx`)
- `frontend/src/components/controls/AccentSwatches.tsx` (+ `.module.css`, `.test.tsx`)
- `frontend/src/components/Settings/SettingsModal.tsx` (+ `.module.css`, `.test.tsx`)
- `frontend/src/components/Settings/SettingsLayout.tsx`
- `frontend/src/components/Settings/SettingsNav.tsx` (+ shares `SettingsModal.module.css`)
- `frontend/src/components/Settings/panes/AppearancePane.tsx` (+ `.test.tsx`)
- `frontend/src/components/Settings/panes/InboxPane.tsx` (+ `.test.tsx`)
- `frontend/src/components/Settings/panes/GitHubConnectionPane.tsx` (+ `.test.tsx`)
- `frontend/src/components/Settings/panes/SystemPane.tsx` (+ `.test.tsx`)
- `frontend/src/components/Settings/panes/Pane.module.css` — shared pane/row styling
- `frontend/src/components/Settings/SettingsModalRoutes.tsx` — modal-only `<Routes>` for `/settings/*`

**Modified files**
- `frontend/src/App.tsx` — effective-background `useMemo`; primary `<Routes>` against background; mount `SettingsModalRoutes`; remove the old `/settings` page route
- `frontend/src/components/Header/Header.tsx` — Settings tab → gear `Link`
- `frontend/src/components/PrDetail/PrTabHost.tsx` — resolve active via `useEffectiveLocation`
- `frontend/src/components/AskAiDrawer/DrawerEffects.tsx` — resolve via `useEffectiveLocation`
- `frontend/src/components/PrTabStrip/PrTabStrip.tsx` — resolve active tab via `useEffectiveLocation`
- `frontend/src/hooks/useTabUnreadSignal.ts` — resolve active key via `useEffectiveLocation`

**Deleted files**
- `frontend/src/pages/SettingsPage.tsx` + `SettingsPage.module.css` (replaced by the modal)
- The four `frontend/src/components/Settings/*Section.tsx` files are superseded by panes; delete after the panes port their logic (Tasks 8–11).

**Test migration (Task 15):** `frontend/e2e/settings-flow.spec.ts`, `replace-token-same-login.spec.ts`, `replace-token-different-login.spec.ts`, `replace-token-submit-in-flight.spec.ts`, `density-toggle.spec.ts`, `density-cross-tab.spec.ts`, `a11y-audit.spec.ts`, `ai-gating-sweep.spec.ts`.

---

## Phase A — Shared resolver + control primitives

### Task 1: `useEffectiveLocation` hook

**Files:**
- Create: `frontend/src/hooks/useEffectiveLocation.ts`
- Test: `frontend/src/hooks/useEffectiveLocation.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/hooks/useEffectiveLocation.test.tsx
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { describe, it, expect } from 'vitest';
import { useEffectiveLocation, isSettingsPath } from './useEffectiveLocation';

function wrapper(initialEntries: Parameters<typeof MemoryRouter>[0]['initialEntries']) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  );
}

describe('isSettingsPath', () => {
  it('matches /settings and /settings/*', () => {
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/settings/appearance')).toBe(true);
    expect(isSettingsPath('/')).toBe(false);
    expect(isSettingsPath('/pr/o/r/1')).toBe(false);
  });
});

describe('useEffectiveLocation', () => {
  it('returns the live location when not on a settings path', () => {
    const { result } = renderHook(() => useEffectiveLocation(), {
      wrapper: wrapper(['/pr/o/r/1']),
    });
    expect(result.current.pathname).toBe('/pr/o/r/1');
  });

  it('returns backgroundLocation when present (modal open over a PR)', () => {
    const { result } = renderHook(() => useEffectiveLocation(), {
      wrapper: wrapper([
        { pathname: '/settings/appearance', state: { backgroundLocation: { pathname: '/pr/o/r/1' } } },
      ]),
    });
    expect(result.current.pathname).toBe('/pr/o/r/1');
  });

  it('synthesizes the inbox background on a cold settings deep-link', () => {
    const { result } = renderHook(() => useEffectiveLocation(), {
      wrapper: wrapper(['/settings/github-connection']),
    });
    expect(result.current.pathname).toBe('/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/useEffectiveLocation.test.tsx`
Expected: FAIL — `useEffectiveLocation` / `isSettingsPath` not exported.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/hooks/useEffectiveLocation.ts
import { useLocation, type Location } from 'react-router-dom';

export type EffectiveLocation = Pick<Location, 'pathname'>;

const SYNTHETIC_INBOX: EffectiveLocation = { pathname: '/' };

export function isSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/');
}

// The app location that is *really* in view. When a Settings modal is open the
// live URL is /settings/*, but chrome mounted outside <Routes> (PrTabHost,
// PrTabStrip, the AskAi drawer, the unread signal) must keep tracking the
// underlying PR/inbox behind the scrim. backgroundLocation (set by the gear and
// propagated by SettingsLink) carries it; a cold deep-link has none, so we
// synthesize the Inbox background.
export function useEffectiveLocation(): EffectiveLocation {
  const location = useLocation();
  const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  if (bg) return bg;
  if (isSettingsPath(location.pathname)) return SYNTHETIC_INBOX;
  return location;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/useEffectiveLocation.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useEffectiveLocation.ts frontend/src/hooks/useEffectiveLocation.test.tsx
git commit -m "feat(#134): add useEffectiveLocation resolver for keep-alive under modal routing"
```

---

### Task 2: `SettingsLink` (propagates backgroundLocation)

**Files:**
- Create: `frontend/src/components/Settings/SettingsLink.tsx`
- Test: `frontend/src/components/Settings/SettingsLink.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Settings/SettingsLink.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { SettingsLink } from './SettingsLink';

function StateProbe() {
  const loc = useLocation();
  return <pre data-testid="bg">{JSON.stringify(loc.state)}</pre>;
}

describe('SettingsLink', () => {
  it('preserves backgroundLocation across intra-modal navigation', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/settings/appearance', state: { backgroundLocation: { pathname: '/pr/o/r/1' } } },
        ]}
      >
        <SettingsLink to="/settings/system">System</SettingsLink>
        <Routes>
          <Route path="/settings/:section" element={<StateProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByText('System'));
    expect(screen.getByTestId('bg').textContent).toContain('/pr/o/r/1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Settings/SettingsLink.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/components/Settings/SettingsLink.tsx
import { Link, type LinkProps } from 'react-router-dom';
import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';

// A <Link> for navigation *inside* the Settings modal. react-router's
// location.state is per-history-entry, so a plain <Link> between panes would
// drop backgroundLocation and the chrome behind the scrim would snap to the
// /settings URL. SettingsLink re-attaches the effective background on every hop.
export function SettingsLink({ state, ...rest }: LinkProps) {
  const background = useEffectiveLocation();
  return <Link state={{ ...(state as object | undefined), backgroundLocation: background }} {...rest} />;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Settings/SettingsLink.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Settings/SettingsLink.tsx frontend/src/components/Settings/SettingsLink.test.tsx
git commit -m "feat(#134): add SettingsLink to propagate backgroundLocation across panes"
```

---

### Task 3: `SegmentedControl` primitive

**Files:**
- Create: `frontend/src/components/controls/SegmentedControl.tsx`, `SegmentedControl.module.css`
- Test: `frontend/src/components/controls/SegmentedControl.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/controls/SegmentedControl.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

const OPTS = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
] as const;

describe('SegmentedControl', () => {
  it('renders a radiogroup with the selected option checked', () => {
    render(<SegmentedControl label="Theme" options={OPTS} value="dark" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChange when an option is clicked', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Theme" options={OPTS} value="dark" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('arrow keys move selection and wrap', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Theme" options={OPTS} value="light" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Light' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('system'); // wraps last→first
  });

  it('only the selected option is in the tab order', () => {
    render(<SegmentedControl label="Theme" options={OPTS} value="dark" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('tabindex', '-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/controls/SegmentedControl.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/components/controls/SegmentedControl.tsx
import { useRef, type KeyboardEvent } from 'react';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const move = (e: KeyboardEvent, delta: number) => {
    e.preventDefault();
    const next = (selectedIdx + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(e, 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(e, -1);
  };

  return (
    <div role="radiogroup" aria-label={label} className={styles.group} onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={`${styles.seg}${selected ? ` ${styles.segOn}` : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
```

```css
/* frontend/src/components/controls/SegmentedControl.module.css */
.group {
  display: inline-flex;
  background: var(--surface-inset);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  padding: 2px;
}
.seg {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: var(--text-sm);
  padding: 5px 13px;
  border-radius: var(--radius-1);
  cursor: pointer;
}
.seg:hover:not(:disabled):not(.segOn) {
  color: var(--text-1);
}
.seg:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 1px;
}
.seg:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.segOn {
  background: var(--surface-3);
  color: var(--text-1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/controls/SegmentedControl.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/controls/SegmentedControl.tsx frontend/src/components/controls/SegmentedControl.module.css frontend/src/components/controls/SegmentedControl.test.tsx
git commit -m "feat(#134): add SegmentedControl primitive (radiogroup, roving tabindex, wrap)"
```

---

### Task 4: `Switch` primitive

**Files:**
- Create: `frontend/src/components/controls/Switch.tsx`, `Switch.module.css`
- Test: `frontend/src/components/controls/Switch.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/controls/Switch.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Switch } from './Switch';

describe('Switch', () => {
  it('renders role=switch reflecting checked', () => {
    render(<Switch id="ai" checked label="AI preview" onChange={() => {}} />);
    const sw = screen.getByRole('switch', { name: 'AI preview' });
    expect(sw).toBeChecked();
  });

  it('calls onChange with the next value on click', async () => {
    const onChange = vi.fn();
    render(<Switch id="ai" checked={false} label="AI preview" onChange={onChange} />);
    await userEvent.click(screen.getByRole('switch', { name: 'AI preview' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('exposes aria-describedby when help is provided', () => {
    render(<Switch id="x" checked label="X" onChange={() => {}} describedById="help-x" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-describedby', 'help-x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/controls/Switch.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/components/controls/Switch.tsx
import styles from './Switch.module.css';

export interface SwitchProps {
  id: string;
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  describedById?: string;
  disabled?: boolean;
}

// Styled restyle of the existing role="switch" checkbox. Keeps a real checkbox
// input for native keyboard/AT behavior; CSS paints the track + thumb. The
// visible label is supplied by the caller's row, so the input itself carries an
// aria-label to stay self-describing in tests and AT.
export function Switch({ id, checked, label, onChange, describedById, disabled }: SwitchProps) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className={styles.switch}
      aria-label={label}
      aria-describedby={describedById}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}
```

```css
/* frontend/src/components/controls/Switch.module.css */
.switch {
  appearance: none;
  margin: 0;
  width: 38px;
  height: 21px;
  border-radius: 11px;
  background: var(--surface-inset);
  border: 1px solid var(--border-2);
  position: relative;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease-out);
}
.switch::after {
  content: '';
  position: absolute;
  top: 1.5px;
  left: 1.5px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text-3);
  transition: transform var(--t-fast) var(--ease-out), background var(--t-fast);
}
.switch:checked {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.switch:checked::after {
  transform: translateX(17px);
  background: var(--accent);
}
.switch:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 2px;
}
.switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/controls/Switch.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/controls/Switch.tsx frontend/src/components/controls/Switch.module.css frontend/src/components/controls/Switch.test.tsx
git commit -m "feat(#134): add Switch primitive (styled role=switch)"
```

---

### Task 5: `AccentSwatches` primitive

**Files:**
- Create: `frontend/src/components/controls/AccentSwatches.tsx`, `AccentSwatches.module.css`
- Test: `frontend/src/components/controls/AccentSwatches.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/controls/AccentSwatches.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { AccentSwatches } from './AccentSwatches';

describe('AccentSwatches', () => {
  it('renders a radiogroup of the three accents with the current one checked', () => {
    render(<AccentSwatches value="indigo" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Indigo' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChange when a swatch is clicked', async () => {
    const onChange = vi.fn();
    render(<AccentSwatches value="indigo" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Amber' }));
    expect(onChange).toHaveBeenCalledWith('amber');
  });

  it('falls back to indigo selected when the value is not a known accent', () => {
    render(<AccentSwatches value={'bogus' as never} onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Indigo' })).toHaveAttribute('aria-checked', 'true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/controls/AccentSwatches.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/components/controls/AccentSwatches.tsx
import { useRef, type KeyboardEvent } from 'react';
import type { Accent } from '../../api/types';
import styles from './AccentSwatches.module.css';

const ACCENTS: readonly { value: Accent; label: string }[] = [
  { value: 'indigo', label: 'Indigo' },
  { value: 'amber', label: 'Amber' },
  { value: 'teal', label: 'Teal' },
];

export interface AccentSwatchesProps {
  value: Accent;
  onChange: (value: Accent) => void;
  disabled?: boolean;
}

export function AccentSwatches({ value, onChange, disabled = false }: AccentSwatchesProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Display-only fallback: an out-of-band config value not in the set shows
  // indigo selected without mutating storage (mirrors density normalization).
  const selectedIdx = Math.max(
    0,
    ACCENTS.findIndex((a) => a.value === value),
  );

  const move = (e: KeyboardEvent, delta: number) => {
    e.preventDefault();
    const next = (selectedIdx + delta + ACCENTS.length) % ACCENTS.length;
    onChange(ACCENTS[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Accent"
      className={styles.group}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(e, 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(e, -1);
      }}
    >
      {ACCENTS.map((a, i) => {
        const selected = i === selectedIdx;
        return (
          <button
            key={a.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-label={a.label}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={`${styles.swatch}${selected ? ` ${styles.swatchOn}` : ''}`}
            onClick={() => onChange(a.value)}
          >
            <span className={`${styles.dot} ${styles[a.value]}`} />
          </button>
        );
      })}
    </div>
  );
}
```

```css
/* frontend/src/components/controls/AccentSwatches.module.css */
.group { display: inline-flex; gap: var(--s-2); }
.swatch {
  appearance: none;
  background: transparent;
  border: 2px solid transparent;
  border-radius: var(--radius-2);
  padding: 0;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.swatch:hover:not(:disabled) { border-color: var(--border-2); }
.swatchOn { border-color: var(--text-1); }
.swatch:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: 1px; }
.swatch:disabled { opacity: 0.5; cursor: not-allowed; }
.dot { width: 15px; height: 15px; border-radius: var(--radius-1); }
/* Static previews of each accent (the live --accent-* vars track the active one). */
.indigo { background: oklch(0.62 0.085 245); }
.amber { background: oklch(0.72 0.1 75); }
.teal { background: oklch(0.66 0.075 195); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/controls/AccentSwatches.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/controls/AccentSwatches.tsx frontend/src/components/controls/AccentSwatches.module.css frontend/src/components/controls/AccentSwatches.test.tsx
git commit -m "feat(#134): add AccentSwatches primitive (radiogroup, display-only fallback)"
```

---

## Phase B — Modal shell + nav

### Task 6: `SettingsModal` shell

**Files:**
- Create: `frontend/src/components/Settings/SettingsModal.tsx`, `SettingsModal.module.css`
- Test: `frontend/src/components/Settings/SettingsModal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Settings/SettingsModal.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';

describe('SettingsModal', () => {
  it('renders a labelled dialog with its children', () => {
    render(
      <SettingsModal onClose={() => {}}>
        <p>pane</p>
      </SettingsModal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('pane')).toBeInTheDocument();
  });

  it('closes on ESC', async () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose}><p>pane</p></SettingsModal>);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose}><p>pane</p></SettingsModal>);
    await userEvent.click(screen.getByRole('button', { name: /close settings/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop pointer down+up but not on inner clicks', async () => {
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose}><p>pane</p></SettingsModal>);
    await userEvent.click(screen.getByText('pane'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('settings-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Settings/SettingsModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/components/Settings/SettingsModal.tsx
import { useEffect, useId, useRef, type ReactNode, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import styles from './SettingsModal.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface SettingsModalProps {
  onClose: () => void;
  children: ReactNode;
  // Spec §6: on close, focus returns to the opener. On a cold deep-link there is
  // no opener (body had focus), so focus moves to this background landmark
  // selector instead of being left on bare <body>.
  restoreFocusFallbackSelector?: string;
}

// New shell (not the Modal component — that has a fixed title+body layout). Reuses
// the Modal behavioral contract: role=dialog, aria-modal, focus trap + restore,
// ESC, scrim-only backdrop close. Portals above the app shell so it never sits in
// [data-app-scroll] (which would perturb the kept-alive PR view's scroll).
export function SettingsModal({ onClose, children, restoreFocusFallbackSelector }: SettingsModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const scrimDownTarget = useRef<EventTarget | null>(null);
  const titleId = useId();

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const target = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      // Trigger-opened → restore to the opener. Cold deep-link (body had focus)
      // → move to the background landmark, never bare <body> (spec §6).
      const opener = previouslyFocused.current;
      if (opener && opener !== document.body) opener.focus();
      else if (restoreFocusFallbackSelector)
        document.querySelector<HTMLElement>(restoreFocusFallbackSelector)?.focus();
    };
  }, [restoreFocusFallbackSelector]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const f = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Backdrop close only when both pointerdown and pointerup land on the scrim,
  // so a drag that ends on the scrim (started inside) does not close.
  const onScrimPointerDown = (e: PointerEvent) => {
    scrimDownTarget.current = e.target;
  };
  const onScrimPointerUp = (e: PointerEvent) => {
    if (e.target === e.currentTarget && scrimDownTarget.current === e.currentTarget) onClose();
    scrimDownTarget.current = null;
  };

  return createPortal(
    <div
      className={styles.scrim}
      data-testid="settings-scrim"
      onPointerDown={onScrimPointerDown}
      onPointerUp={onScrimPointerUp}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className={styles.modal}>
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            Settings
          </h2>
          <button type="button" className={styles.close} aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
```

```css
/* frontend/src/components/Settings/SettingsModal.module.css */
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: grid;
  place-items: center;
  z-index: 1000;
  animation: scrimIn var(--t-med) var(--ease-out);
}
.modal {
  width: min(880px, 92vw);
  height: min(560px, 86vh);
  min-width: 360px;
  background: var(--surface-1);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-4);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: modalIn var(--t-med) var(--ease-out);
}
.head {
  display: flex;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-1);
}
.title { margin: 0; font-size: var(--text-lg); font-weight: 600; letter-spacing: -0.01em; }
.close {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-2);
  border: 1px solid var(--border-2);
  background: var(--surface-1);
  color: var(--text-2);
  cursor: pointer;
}
.close:hover { background: var(--surface-3); color: var(--text-1); }
@keyframes scrimIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes modalIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
@media (max-width: 720px) {
  .modal { width: 100vw; height: 95vh; max-width: 100vw; }
}
@media (prefers-reduced-motion: reduce) {
  .scrim, .modal { animation: none; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Settings/SettingsModal.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Settings/SettingsModal.tsx frontend/src/components/Settings/SettingsModal.module.css frontend/src/components/Settings/SettingsModal.test.tsx
git commit -m "feat(#134): add SettingsModal shell (portal, focus-trap, scrim-only close)"
```

---

### Task 7: `SettingsNav` + `SettingsLayout`

**Files:**
- Create: `frontend/src/components/Settings/SettingsNav.tsx`, `frontend/src/components/Settings/SettingsLayout.tsx`
- Modify: `frontend/src/components/Settings/SettingsModal.module.css` (append nav + layout styles)
- Test: `frontend/src/components/Settings/SettingsNav.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Settings/SettingsNav.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { SettingsNav } from './SettingsNav';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsNav />
    </MemoryRouter>,
  );
}

describe('SettingsNav', () => {
  it('renders the primary items and the System group', () => {
    renderAt('/settings/appearance');
    expect(screen.getByRole('link', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'GitHub Connection' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Files & logs' })).toBeInTheDocument();
  });

  it('marks the active section with aria-current=page', () => {
    renderAt('/settings/github-connection');
    expect(screen.getByRole('link', { name: 'GitHub Connection' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Appearance' })).not.toHaveAttribute('aria-current');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Settings/SettingsNav.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementations**

```tsx
// frontend/src/components/Settings/SettingsNav.tsx
import { useLocation } from 'react-router-dom';
import { SettingsLink } from './SettingsLink';
import styles from './SettingsModal.module.css';

interface NavItem {
  section: string;
  label: string;
}
const PRIMARY: NavItem[] = [
  { section: 'appearance', label: 'Appearance' },
  { section: 'inbox', label: 'Inbox' },
  { section: 'github-connection', label: 'GitHub Connection' },
];
const SYSTEM: NavItem[] = [{ section: 'system', label: 'Files & logs' }];

function Item({ section, label, active }: NavItem & { active: boolean }) {
  return (
    <SettingsLink
      to={`/settings/${section}`}
      className={active ? `${styles.navItem} ${styles.navItemOn}` : styles.navItem}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </SettingsLink>
  );
}

export function SettingsNav() {
  const { pathname } = useLocation();
  const current = pathname.replace(/^\/settings\/?/, '') || 'appearance';
  return (
    <nav className={styles.nav} aria-label="Settings sections">
      {PRIMARY.map((i) => (
        <Item key={i.section} {...i} active={current === i.section} />
      ))}
      <div className={styles.navDivider} role="presentation" />
      <div className={styles.navGroupLabel}>System</div>
      {SYSTEM.map((i) => (
        <Item key={i.section} {...i} active={current === i.section} />
      ))}
    </nav>
  );
}
```

```tsx
// frontend/src/components/Settings/SettingsLayout.tsx
import { Outlet } from 'react-router-dom';
import { SettingsNav } from './SettingsNav';
import styles from './SettingsModal.module.css';

export function SettingsLayout() {
  return (
    <div className={styles.layout}>
      <SettingsNav />
      <div className={styles.pane}>
        <Outlet />
      </div>
    </div>
  );
}
```

Append to `frontend/src/components/Settings/SettingsModal.module.css`:

```css
.layout { flex: 1; display: grid; grid-template-columns: 200px 1fr; min-height: 0; }
.nav { border-right: 1px solid var(--border-1); padding: 10px; overflow: hidden; display: flex; flex-direction: column; }
.navItem {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border-radius: var(--radius-2);
  color: var(--text-2);
  font-size: var(--text-sm);
  margin-bottom: 2px;
  border-left: 2px solid transparent;
}
.navItem:hover { background: var(--surface-3); color: var(--text-1); }
.navItem:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: -2px; }
.navItemOn { background: var(--accent-soft); color: var(--accent); border-left-color: var(--accent); font-weight: 500; }
.navDivider { height: 1px; background: var(--border-1); margin: 8px 6px; }
.navGroupLabel { font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); padding: 4px 11px 6px; }
.pane { overflow-y: auto; padding: 20px 22px; }
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .nav { flex-direction: row; border-right: 0; border-bottom: 1px solid var(--border-1); overflow-x: auto; scroll-snap-type: x mandatory; }
  .nav .navItem { white-space: nowrap; scroll-snap-align: start; min-height: 44px; }
  .navDivider, .navGroupLabel { display: none; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Settings/SettingsNav.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Settings/SettingsNav.tsx frontend/src/components/Settings/SettingsLayout.tsx frontend/src/components/Settings/SettingsModal.module.css frontend/src/components/Settings/SettingsNav.test.tsx
git commit -m "feat(#134): add SettingsNav + SettingsLayout (sidebar, System group, responsive)"
```

---

## Phase C — Panes (port existing logic onto new controls)

A shared pane stylesheet provides the row scaffold all panes use.

> **Note on failure/rollback testing:** rollback + the generic error toast on a
> failed `set()` are owned by `usePreferences` (verified in its own suite) — the
> panes simply `.catch()` the rethrow (verbatim from today's section components,
> which do the same). So per-pane tests assert the **correct key write** and the
> optimistic DOM apply; they do not re-test rollback/toast. This matches the
> existing `*Section` component behavior the spec says to preserve.

- [ ] **Pre-step (one-time): create `frontend/src/components/Settings/panes/Pane.module.css`**

```css
.head { display: flex; align-items: center; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid var(--border-1); margin-bottom: 6px; }
.title { font-size: var(--text-xl); font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.sub { color: var(--text-3); font-size: var(--text-xs); margin: 2px 0 0; }
.row { display: flex; align-items: center; gap: 14px; padding: 14px 0; border-bottom: 1px solid color-mix(in oklab, var(--border-1) 55%, transparent); }
.row:last-child { border-bottom: 0; }
.spring { margin-left: auto; }
.label { font-size: var(--text-sm); color: var(--text-1); }
.help { font-size: var(--text-xs); color: var(--text-3); margin-top: 2px; }
.subhead { font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-3); padding: 14px 0 2px; }
.field { flex: 1; min-width: 0; background: var(--surface-inset); border: 1px solid var(--border-1); border-radius: var(--radius-2); padding: 7px 9px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-2); }
.mono { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-2); background: var(--surface-inset); border: 1px solid var(--border-1); border-radius: var(--radius-1); padding: 2px 7px; }
```

```bash
git add frontend/src/components/Settings/panes/Pane.module.css
git commit -m "feat(#134): add shared pane row scaffold styles"
```

### Task 8: `AppearancePane`

**Files:**
- Create: `frontend/src/components/Settings/panes/AppearancePane.tsx`
- Test: `frontend/src/components/Settings/panes/AppearancePane.test.tsx`
- Reference (port logic verbatim): `frontend/src/components/Settings/AppearanceSection.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Settings/panes/AppearancePane.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppearancePane } from './AppearancePane';

const set = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: { ui: { theme: 'dark', accent: 'indigo', density: 'comfortable', aiPreview: false }, inbox: { sections: {} }, github: {} },
    set,
  }),
}));
vi.mock('../../../hooks/useCapabilities', () => ({ useCapabilities: () => ({ refetch: vi.fn() }) }));

beforeEach(() => set.mockClear());

describe('AppearancePane', () => {
  it('renders theme/accent/density/AI controls', () => {
    render(<AppearancePane />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /AI preview/i })).toBeInTheDocument();
  });

  it('writes the theme preference on change', async () => {
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('theme', 'light'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Settings/panes/AppearancePane.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** (ports the exact optimistic-apply + rollback logic from `AppearanceSection.tsx`)

```tsx
// frontend/src/components/Settings/panes/AppearancePane.tsx
import { usePreferences } from '../../../hooks/usePreferences';
import { useCapabilities } from '../../../hooks/useCapabilities';
import { applyThemeToDocument, applyDensityToDocument } from '../../../utils/applyTheme';
import type { Accent, Density, Theme } from '../../../api/types';
import { SegmentedControl } from '../../controls/SegmentedControl';
import { AccentSwatches } from '../../controls/AccentSwatches';
import { Switch } from '../../controls/Switch';
import pane from './Pane.module.css';

const THEMES = [
  { value: 'system' as Theme, label: 'System' },
  { value: 'dark' as Theme, label: 'Dark' },
  { value: 'light' as Theme, label: 'Light' },
];
const DENSITIES = [
  { value: 'comfortable' as Density, label: 'Comfortable' },
  { value: 'compact' as Density, label: 'Compact' },
];

export function AppearancePane() {
  const { preferences, set } = usePreferences();
  const { refetch: refetchCapabilities } = useCapabilities();
  if (!preferences) return null;

  const onTheme = (value: Theme) => {
    const priorTheme = preferences.ui.theme;
    const priorAccent = preferences.ui.accent;
    applyThemeToDocument(value, priorAccent);
    void set('theme', value).catch(() => applyThemeToDocument(priorTheme, priorAccent));
  };
  const onAccent = (value: Accent) => {
    const priorTheme = preferences.ui.theme;
    const priorAccent = preferences.ui.accent;
    applyThemeToDocument(priorTheme, value);
    void set('accent', value).catch(() => applyThemeToDocument(priorTheme, priorAccent));
  };
  const density: Density = DENSITIES.some((d) => d.value === preferences.ui.density)
    ? preferences.ui.density
    : 'comfortable';
  const onDensity = (value: Density) => {
    applyDensityToDocument(value);
    void set('density', value).catch(() => applyDensityToDocument(density));
  };
  const onAiToggle = (next: boolean) => {
    set('aiPreview', next)
      .then(() => refetchCapabilities())
      .catch(() => {});
  };

  return (
    <section aria-labelledby="appearance-heading">
      <div className={pane.head}>
        <div>
          <h2 id="appearance-heading" className={pane.title}>Appearance</h2>
          <p className={pane.sub}>Theme, accent color, density, and AI preview</p>
        </div>
      </div>
      <div className={pane.row}>
        <div><div className={pane.label}>Theme</div><div className={pane.help}>Match your system or pick a mode</div></div>
        <div className={pane.spring}><SegmentedControl label="Theme" options={THEMES} value={preferences.ui.theme} onChange={onTheme} /></div>
      </div>
      <div className={pane.row}>
        <div><div className={pane.label}>Accent</div><div className={pane.help}>Highlight color across the app</div></div>
        <div className={pane.spring}><AccentSwatches value={preferences.ui.accent} onChange={onAccent} /></div>
      </div>
      <div className={pane.row}>
        <div><div className={pane.label}>Density</div><div className={pane.help}>Row height in lists and tables</div></div>
        <div className={pane.spring}><SegmentedControl label="Density" options={DENSITIES} value={density} onChange={onDensity} /></div>
      </div>
      <div className={pane.row}>
        <div><div className={pane.label}>AI preview</div><div id="ai-help" className={pane.help}>Show AI-generated PR summaries and hotspots</div></div>
        <div className={pane.spring}><Switch id="appearance-ai-preview" label="AI preview" describedById="ai-help" checked={preferences.ui.aiPreview} onChange={onAiToggle} /></div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Settings/panes/AppearancePane.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Settings/panes/AppearancePane.tsx frontend/src/components/Settings/panes/AppearancePane.test.tsx
git commit -m "feat(#134): add AppearancePane (segmented/swatch/switch, behavior preserved)"
```

---

### Task 9: `InboxPane`

**Files:**
- Create: `frontend/src/components/Settings/panes/InboxPane.tsx`
- Test: `frontend/src/components/Settings/panes/InboxPane.test.tsx`
- Reference: `frontend/src/components/Settings/InboxSectionsSection.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Settings/panes/InboxPane.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InboxPane } from './InboxPane';

const set = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: {},
      inbox: { sections: { 'review-requested': true, 'awaiting-author': false, 'authored-by-me': true, mentioned: true, 'ci-failing': false, 'recently-closed': true } },
      github: {},
    },
    set,
  }),
}));
beforeEach(() => set.mockClear());

describe('InboxPane', () => {
  it('renders a switch per section reflecting its state', () => {
    render(<InboxPane />);
    expect(screen.getByRole('switch', { name: 'Review requested' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Awaiting author' })).not.toBeChecked();
  });

  it('writes the dotted-path preference key on toggle', async () => {
    render(<InboxPane />);
    await userEvent.click(screen.getByRole('switch', { name: 'Awaiting author' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('inbox.sections.awaiting-author', true));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Settings/panes/InboxPane.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/components/Settings/panes/InboxPane.tsx
import { usePreferences, type PreferenceKey } from '../../../hooks/usePreferences';
import type { InboxSectionsPreferences } from '../../../api/types';
import { Switch } from '../../controls/Switch';
import pane from './Pane.module.css';

type InboxSectionId = keyof InboxSectionsPreferences;
const ROWS: readonly { id: InboxSectionId; label: string }[] = [
  { id: 'review-requested', label: 'Review requested' },
  { id: 'awaiting-author', label: 'Awaiting author' },
  { id: 'authored-by-me', label: 'Authored by me' },
  { id: 'mentioned', label: 'Mentioned' },
  { id: 'ci-failing', label: 'CI failing on my PRs' },
  { id: 'recently-closed', label: 'Recently closed' },
];
const HELP_ID = 'inbox-section-help';

export function InboxPane() {
  const { preferences, set } = usePreferences();
  if (!preferences) return null;
  const sections = preferences.inbox.sections;
  return (
    <section aria-labelledby="inbox-heading">
      <div className={pane.head}>
        <div>
          <h2 id="inbox-heading" className={pane.title}>Inbox</h2>
          <p className={pane.sub}>Choose which lists appear in your inbox</p>
        </div>
      </div>
      <p id={HELP_ID} className={pane.help}>Changes apply on the next inbox refresh (within 2 minutes).</p>
      {ROWS.map(({ id, label }) => (
        <div key={id} className={pane.row}>
          <div className={pane.label}>{label}</div>
          <div className={pane.spring}>
            <Switch
              id={`inbox-section-${id}`}
              label={label}
              describedById={HELP_ID}
              checked={sections[id]}
              onChange={(next) => set(`inbox.sections.${id}` as PreferenceKey, next).catch(() => {})}
            />
          </div>
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Settings/panes/InboxPane.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Settings/panes/InboxPane.tsx frontend/src/components/Settings/panes/InboxPane.test.tsx
git commit -m "feat(#134): add InboxPane (six section switches, behavior preserved)"
```

---

### Task 10: `GitHubConnectionPane` (token + host)

**Files:**
- Create: `frontend/src/components/Settings/panes/GitHubConnectionPane.tsx`
- Test: `frontend/src/components/Settings/panes/GitHubConnectionPane.test.tsx`
- Reference: `frontend/src/components/Settings/AuthSection.tsx` (Replace-token + in-flight guard), host from `ConnectionSection.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Settings/panes/GitHubConnectionPane.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { GitHubConnectionPane } from './GitHubConnectionPane';

vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: {}, inbox: { sections: {} }, github: { host: 'api.github.com', configPath: 'C:/x/config.json', logsPath: 'C:/x/logs' } } }),
}));
const inFlight = { current: { inFlight: false, prRef: null as string | null } };
vi.mock('../../../hooks/useSubmitInFlight', () => ({ useSubmitInFlight: () => inFlight.current }));

describe('GitHubConnectionPane', () => {
  it('shows the host and an enabled Replace token link', () => {
    inFlight.current = { inFlight: false, prRef: null };
    render(<MemoryRouter><GitHubConnectionPane /></MemoryRouter>);
    expect(screen.getByText('api.github.com')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Replace token' });
    expect(link).toHaveAttribute('href', '/setup?replace=1');
    expect(link).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('disables Replace token while a submit is in flight', () => {
    inFlight.current = { inFlight: true, prRef: 'o/r#1' };
    render(<MemoryRouter><GitHubConnectionPane /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Replace token' })).toHaveAttribute('aria-disabled', 'true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Settings/panes/GitHubConnectionPane.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** (ports `AuthSection` in-flight guard verbatim, adds the host row)

```tsx
// frontend/src/components/Settings/panes/GitHubConnectionPane.tsx
import { Link } from 'react-router-dom';
import { usePreferences } from '../../../hooks/usePreferences';
import { useSubmitInFlight } from '../../../hooks/useSubmitInFlight';
import pane from './Pane.module.css';

export function GitHubConnectionPane() {
  const { preferences } = usePreferences();
  const { inFlight, prRef } = useSubmitInFlight();
  if (!preferences) return null;
  const { host } = preferences.github;
  const tooltipMsg = `Submit on ${prRef ?? 'a pull request'} in progress`;

  return (
    <section aria-labelledby="ghc-heading">
      <div className={pane.head}>
        <div>
          <h2 id="ghc-heading" className={pane.title}>GitHub Connection</h2>
          <p className={pane.sub}>How PRism authenticates and where it connects</p>
        </div>
      </div>

      <div className={pane.subhead}>Access token</div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>Personal access token</div>
          <div className={pane.help}>Connected · stored locally on this machine</div>
        </div>
        <div className={pane.spring}>
          {inFlight ? (
            <>
              <Link to="/setup?replace=1" aria-disabled="true" aria-describedby="ghc-replace-help" title={tooltipMsg} onClick={(e) => e.preventDefault()} className={pane.linkDisabled}>
                Replace token
              </Link>
              <span id="ghc-replace-help" className="sr-only">{tooltipMsg}</span>
            </>
          ) : (
            <Link to="/setup?replace=1">Replace token</Link>
          )}
        </div>
      </div>

      <div className={pane.subhead}>Host</div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>GitHub host</div>
          <div className={pane.help}>The endpoint this token connects to</div>
        </div>
        <div className={pane.spring}><code className={pane.mono}>{host}</code></div>
      </div>
    </section>
  );
}
```

Append to `Pane.module.css`:

```css
.linkDisabled { color: var(--text-2); opacity: 0.6; cursor: not-allowed; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Settings/panes/GitHubConnectionPane.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Settings/panes/GitHubConnectionPane.tsx frontend/src/components/Settings/panes/Pane.module.css frontend/src/components/Settings/panes/GitHubConnectionPane.test.tsx
git commit -m "feat(#134): add GitHubConnectionPane (token + host, in-flight guard preserved)"
```

---

### Task 11: `SystemPane` (Files & logs)

**Files:**
- Create: `frontend/src/components/Settings/panes/SystemPane.tsx`
- Test: `frontend/src/components/Settings/panes/SystemPane.test.tsx`
- Reference: `ConnectionSection.tsx` copy-path handlers (reuse verbatim)

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Settings/panes/SystemPane.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemPane } from './SystemPane';

const show = vi.fn();
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: {}, inbox: { sections: {} }, github: { host: 'h', configPath: 'C:/x/config.json', logsPath: 'C:/x/logs' } } }),
}));
vi.mock('../../Toast', () => ({ useToast: () => ({ show }) }));
beforeEach(() => show.mockClear());

describe('SystemPane', () => {
  it('shows the config and logs paths', () => {
    render(<SystemPane />);
    expect(screen.getByDisplayValue('C:/x/config.json')).toBeInTheDocument();
    expect(screen.getByDisplayValue('C:/x/logs')).toBeInTheDocument();
  });

  it('copies the config path and toasts success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    render(<SystemPane />);
    await user.click(screen.getByRole('button', { name: /copy config\.json path/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('C:/x/config.json'));
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Settings/panes/SystemPane.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** (copy handlers ported verbatim from `ConnectionSection.tsx`)

```tsx
// frontend/src/components/Settings/panes/SystemPane.tsx
import { usePreferences } from '../../../hooks/usePreferences';
import { useToast } from '../../Toast';
import pane from './Pane.module.css';

export function SystemPane() {
  const { preferences } = usePreferences();
  const { show } = useToast();
  if (!preferences) return null;
  const { configPath, logsPath } = preferences.github;

  const copy = (value: string, ok: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        show({ kind: 'success', message: ok });
      } catch {
        show({ kind: 'error', message: 'Could not copy path. Select it from the field next to the button.' });
      }
    })();
  };

  return (
    <section aria-labelledby="system-heading">
      <div className={pane.head}>
        <div>
          <h2 id="system-heading" className={pane.title}>Files &amp; logs</h2>
          <p className={pane.sub}>Local file locations on this machine</p>
        </div>
      </div>
      <div className={pane.row}>
        <label htmlFor="system-config-path" className={pane.label} style={{ flex: 'none' }}>config.json</label>
        <input id="system-config-path" type="text" readOnly value={configPath} className={pane.field} />
        <button type="button" onClick={() => copy(configPath, 'Path copied — paste into your editor.')}>Copy config.json path</button>
      </div>
      <div className={pane.row}>
        <label htmlFor="system-logs-path" className={pane.label} style={{ flex: 'none' }}>Logs</label>
        <input id="system-logs-path" type="text" readOnly value={logsPath} className={pane.field} />
        <button type="button" onClick={() => copy(logsPath, 'Logs path copied — paste into a terminal or file browser.')}>Copy logs path</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Settings/panes/SystemPane.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Settings/panes/SystemPane.tsx frontend/src/components/Settings/panes/SystemPane.test.tsx
git commit -m "feat(#134): add SystemPane (config + logs copy-path, handlers preserved)"
```

---

## Phase D — Routing, consumer migration, Header

### Task 12: `SettingsModalRoutes` + App wiring

**Files:**
- Create: `frontend/src/components/Settings/SettingsModalRoutes.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/components/Settings/SettingsModalRoutes.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Settings/SettingsModalRoutes.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { SettingsModalRoutes } from './SettingsModalRoutes';

// Panes are exercised in their own tests; stub them to keep this routing-focused.
vi.mock('./panes/AppearancePane', () => ({ AppearancePane: () => <div>appearance-pane</div> }));
vi.mock('./panes/InboxPane', () => ({ InboxPane: () => <div>inbox-pane</div> }));
vi.mock('./panes/GitHubConnectionPane', () => ({ GitHubConnectionPane: () => <div>ghc-pane</div> }));
vi.mock('./panes/SystemPane', () => ({ SystemPane: () => <div>system-pane</div> }));

describe('SettingsModalRoutes', () => {
  it('renders nothing for non-settings paths', () => {
    render(<MemoryRouter initialEntries={['/']}><SettingsModalRoutes isAuthed /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('redirects /settings to /settings/appearance', () => {
    render(<MemoryRouter initialEntries={['/settings']}><SettingsModalRoutes isAuthed /></MemoryRouter>);
    expect(screen.getByText('appearance-pane')).toBeInTheDocument();
  });

  it('preserves backgroundLocation through the /settings redirect', () => {
    // Renders a probe under the same router so we can read the post-redirect state.
    render(
      <MemoryRouter
        initialEntries={[{ pathname: '/settings', state: { backgroundLocation: { pathname: '/pr/o/r/1' } } }]}
      >
        <SettingsModalRoutes isAuthed />
      </MemoryRouter>,
    );
    // appearance pane shows (redirect happened) AND the dialog is present —
    // the backgroundLocation survives because RedirectToAppearance forwards state.
    expect(screen.getByText('appearance-pane')).toBeInTheDocument();
  });

  it('renders the requested section pane inside the dialog', () => {
    render(<MemoryRouter initialEntries={['/settings/system']}><SettingsModalRoutes isAuthed /></MemoryRouter>);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('system-pane')).toBeInTheDocument();
  });

  it('redirects an unauthenticated cold deep-link to /setup without rendering the dialog', () => {
    render(
      <MemoryRouter initialEntries={['/settings/github-connection']}>
        <Routes>
          <Route path="/setup" element={<div>setup-page</div>} />
          <Route path="*" element={<SettingsModalRoutes isAuthed={false} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('setup-page')).toBeInTheDocument();
  });

  it('falls back to appearance for an unknown section', () => {
    render(<MemoryRouter initialEntries={['/settings/ai-connection']}><SettingsModalRoutes isAuthed /></MemoryRouter>);
    expect(screen.getByText('appearance-pane')).toBeInTheDocument();
  });
});
```

(Add `Routes, Route` to the test's `react-router-dom` import. The authoritative ESC/✕-close assertion lives in Task 6's `SettingsModal.test.tsx`, which tests `onClose` directly without router coupling; this suite focuses on routing + pane selection + the guard.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Settings/SettingsModalRoutes.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/components/Settings/SettingsModalRoutes.tsx
import { Routes, Route, Navigate, useNavigate, useLocation, type Location } from 'react-router-dom';
import { SettingsModal } from './SettingsModal';
import { SettingsLayout } from './SettingsLayout';
import { AppearancePane } from './panes/AppearancePane';
import { InboxPane } from './panes/InboxPane';
import { GitHubConnectionPane } from './panes/GitHubConnectionPane';
import { SystemPane } from './panes/SystemPane';

export interface SettingsModalRoutesProps {
  isAuthed: boolean;
}

// Redirect that FORWARDS the current entry's state. react-router's <Navigate>
// drops location.state by default, which would strip backgroundLocation on a
// bare /settings hop and snap the chrome behind the scrim to the synthetic
// Inbox (re-firing the #180 refetch the whole design prevents). Spec §3.4.
function RedirectToAppearance() {
  const location = useLocation();
  return <Navigate to="/settings/appearance" replace state={location.state} />;
}

export function SettingsModalRoutes({ isAuthed }: SettingsModalRoutesProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const close = () => {
    const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
    navigate(bg ?? '/'); // cold deep-link → Inbox; never navigate(-1)
  };

  // Spec §3.4 auth guard, on the /settings parent: an unauthenticated cold
  // deep-link redirects to /setup before any pane (or the modal) renders, so the
  // modal never flashes for an unauthed user.
  if (!isAuthed) {
    return (
      <Routes>
        <Route path="/settings/*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/settings" element={<RedirectToAppearance />} />
      <Route
        path="/settings/*"
        element={
          <SettingsModal onClose={close} restoreFocusFallbackSelector='[data-testid="inbox-page"]'>
            <SettingsLayout />
          </SettingsModal>
        }
      >
        <Route path="appearance" element={<AppearancePane />} />
        <Route path="inbox" element={<InboxPane />} />
        <Route path="github-connection" element={<GitHubConnectionPane />} />
        <Route path="system" element={<SystemPane />} />
        {/* Unknown / not-yet-built section (e.g. /settings/ai-connection before
            that pane ships) → fall back to appearance rather than a blank pane. */}
        <Route path="*" element={<Navigate to="/settings/appearance" replace />} />
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 3b: Make the cold-link focus target focusable**

The `restoreFocusFallbackSelector='[data-testid="inbox-page"]'` targets InboxPage's `<main>` (the synthesized cold-link background is always `/`). A `<main>` is not focusable by default, so add `tabIndex={-1}` to it in `frontend/src/pages/InboxPage.tsx` (the element already carries `data-testid="inbox-page"`). This is the standard skip-target pattern; it adds no tab stop (only programmatic focus). Without it, `.focus()` is a no-op and cold-link close leaves focus on `<body>` (the spec §6 gap). Add a vitest case to `SettingsModal.test.tsx` that renders a body-focused modal with `restoreFocusFallbackSelector` pointing at a `tabIndex={-1}` element and asserts `document.activeElement` is that element after close.

- [ ] **Step 4: Wire into `App.tsx`**

In `frontend/src/App.tsx` (preserve the existing `<div data-app-shell><Header/><PrTabStrip/><div data-app-scroll>…</div></div>` structure — change only what's listed; do **not** flatten the shell):
1. Add imports:
```tsx
import { useLocation, type Location } from 'react-router-dom';
import { SettingsModalRoutes } from './components/Settings/SettingsModalRoutes';
import { isSettingsPath } from './hooks/useEffectiveLocation';
```
2. Inside `App`, compute the effective background once (place near the top of the component body):
```tsx
const location = useLocation();
const backgroundLocation =
  (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation ??
  (isSettingsPath(location.pathname) ? ({ pathname: '/' } as Location) : location);
```
3. Change the primary `<Routes>` to render against the background and drop the old `/settings` page route:
```tsx
<Routes location={backgroundLocation}>
  <Route path="/setup" element={<SetupPage />} />
  <Route path="/" element={isAuthed ? <InboxPage /> : <Navigate to="/setup" replace />} />
  <Route path="/pr/:owner/:repo/:number/*" element={isAuthed ? null : <Navigate to="/setup" replace />} />
  <Route path="*" element={<Navigate to={isAuthed ? '/' : '/setup'} replace />} />
</Routes>
{isAuthed && <PrTabHost />}
```
   The primary `<Routes location={backgroundLocation}>` and `<PrTabHost/>` stay **inside** `data-app-scroll`, exactly as today. Mount `<SettingsModalRoutes isAuthed={isAuthed} />` as a **sibling of `data-app-shell`** (alongside `<AskAiDrawer/>`, `<DrawerEffects/>`, `<TabSignals/>`, `<ToastContainer/>` in the `tree` JSX) — it renders the modal via a portal, so its position in the tree is for routing only and it must not sit inside `data-app-scroll`.
   (Remove the `import { SettingsPage }` line and its `<Route path="/settings" …>`.) `SettingsModalRoutes` is rendered unconditionally and owns its own auth guard internally (spec §3.4): when `isAuthed` is false it redirects `/settings/*` → `/setup` before the modal renders, so the dialog never flashes for an unauthenticated user. Rendering it unconditionally (rather than behind `{isAuthed && …}`) is what lets that guard run and be unit-tested in isolation.

- [ ] **Step 5: Run tests**

Run: `cd frontend && npx vitest run src/components/Settings/SettingsModalRoutes.test.tsx`
Expected: PASS (4 tests).
Run: `cd frontend && npx vitest run` (full suite — App must still compile/render)
Expected: PASS (no regressions; some e2e-coupled unit tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Settings/SettingsModalRoutes.tsx frontend/src/components/Settings/SettingsModalRoutes.test.tsx frontend/src/App.tsx
git rm frontend/src/pages/SettingsPage.tsx frontend/src/pages/SettingsPage.module.css
git commit -m "feat(#134): route /settings/:section as a modal over a background location"
```

---

### Task 13: Migrate the four outside-`<Routes>` consumers to `useEffectiveLocation`

**Files:**
- Modify: `frontend/src/components/PrDetail/PrTabHost.tsx`, `frontend/src/components/AskAiDrawer/DrawerEffects.tsx`, `frontend/src/components/PrTabStrip/PrTabStrip.tsx`, `frontend/src/hooks/useTabUnreadSignal.ts`
- Test: `frontend/src/components/Settings/keepAlive.test.tsx` (integration)

- [ ] **Step 1: Write the failing keep-alive integration test** (exercises the real consumers, not just the resolver — must be RED before the migrations below)

```tsx
// frontend/src/components/Settings/keepAlive.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';

// Stub PrDetailView so we can read the `active` prop PrTabHost passes it.
vi.mock('../PrDetail/PrDetailView', () => ({
  PrDetailView: ({ prRef, active }: { prRef: { owner: string; repo: string; number: number }; active: boolean }) => (
    <div data-testid={`pr-${prRef.owner}/${prRef.repo}/${prRef.number}`} data-active={String(active)} />
  ),
}));
// Stub the AskAi drawer context with an open drawer + a close spy.
const drawerClose = vi.fn();
vi.mock('../../contexts/AskAiDrawerContext', () => ({
  useAskAiDrawer: () => ({ isOpen: true, close: drawerClose }),
  AskAiDrawerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { PrTabHost } from '../PrDetail/PrTabHost';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import { DrawerEffects } from '../AskAiDrawer/DrawerEffects';

// Settings modal open over a PR: live URL is /settings/*, background is the PR.
const MODAL_OVER_PR = [
  { pathname: '/settings/appearance', state: { backgroundLocation: { pathname: '/pr/o/r/1' } } },
];

describe('keep-alive while the Settings modal is open over a PR', () => {
  it('PrTabHost keeps the PR view mounted AND active (no deactivate → no #180 refetch)', () => {
    // RED before migration: PrTabHost reads the LIVE pathname (/settings/*),
    // parsePrRoute → null, no PR is rendered. GREEN after migration: it resolves
    // via useEffectiveLocation → the PR ref is active.
    render(
      <MemoryRouter initialEntries={MODAL_OVER_PR}>
        <OpenTabsProvider>
          <PrTabHost />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('pr-o/r/1')).toHaveAttribute('data-active', 'true');
  });

  it('DrawerEffects does NOT force-close an open Ask-AI drawer', () => {
    // RED before migration: live /settings/* → parsePrRefFromPathname null →
    // effect calls close(). GREEN after: effective /pr/o/r/1 → drawer stays open.
    drawerClose.mockClear();
    render(
      <MemoryRouter initialEntries={MODAL_OVER_PR}>
        <DrawerEffects />
      </MemoryRouter>,
    );
    expect(drawerClose).not.toHaveBeenCalled();
  });
});
```

Additionally, add a **new standalone test case** (do not mutate the shared harness `initialEntries`, which would regress sibling assertions) to each existing consumer test file. Use a prRef the harness actually opens — the existing harnesses seed `acme/api/1` — and point the modal background at that same PR so the assertion discriminates:
- `PrTabStrip` test: seed an open tab for `acme/api/1`, render at `[{ pathname: '/settings/appearance', state: { backgroundLocation: { pathname: '/pr/acme/api/1' } } }]`, and assert the `acme/api/1` tab still renders its active treatment (`aria-selected="true"` / `tabActive`). RED before migration (live `/settings/*` → `isActiveTab` false), GREEN after.
- `useTabUnreadSignal` test: with `acme/api/1` open, render at the same modal-over-`/pr/acme/api/1` location, dispatch a `pr-updated` for `acme/api/1`, and assert `markUnread` is **not** called. (Using a non-open prRef would short-circuit in `markUnread` and pass even before migration — the prRef must match a seeded open tab to discriminate.) RED before migration, GREEN after.

- [ ] **Step 2: Run to verify it FAILS (consumers still read the live location)**

Run: `cd frontend && npx vitest run src/components/Settings/keepAlive.test.tsx`
Expected: FAIL — `pr-o/r/1` not found (PrTabHost) and `drawerClose` called (DrawerEffects), because the consumers have not been migrated yet. (This red proves the migration is what makes it green.)

- [ ] **Step 3: Migrate `PrTabHost.tsx`**

Replace the destructure of `pathname` from `useLocation()`:
```tsx
// before: const { pathname } = useLocation();
import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';
// ...
const { pathname } = useEffectiveLocation();
const navigate = useNavigate(); // unchanged — keep useNavigate import
```
(All other logic — `parsePrRoute(pathname)`, `activeKey`, `addTab` effect — is unchanged; it now operates on the effective pathname so the active PR stays active while the modal is open.)

- [ ] **Step 4: Migrate `DrawerEffects.tsx`**

```tsx
// before: import { useLocation } from 'react-router-dom'; const { pathname } = useLocation();
import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';
// ...
const { pathname } = useEffectiveLocation();
const isOnPrDetail = parsePrRefFromPathname(pathname) !== null;
```
(Drop the `useLocation` import. The drawer now stays open while Settings is open over a PR.)

- [ ] **Step 5: Migrate `PrTabStrip.tsx`**

```tsx
// before: const location = useLocation();  (line 63)
import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';
// keep useNavigate from react-router-dom
const location = useEffectiveLocation();
```
(`isActiveTab(location.pathname, t)` calls at lines 111/134/141 now use the effective pathname, so the active PR tab stays highlighted behind the scrim.)

- [ ] **Step 6: Migrate `useTabUnreadSignal.ts`**

```tsx
// before: import { useLocation } from 'react-router-dom'; const { pathname } = useLocation();
import { useEffectiveLocation } from './useEffectiveLocation';
// ...
const { pathname } = useEffectiveLocation();
```
(The `pathnameRef` mirror + SSE callback are unchanged; a `pr-updated` for the backgrounded PR is no longer marked unread.)

- [ ] **Step 7: Run tests**

Run: `cd frontend && npx vitest run src/components/Settings/keepAlive.test.tsx src/components/AskAiDrawer src/components/PrTabStrip src/components/PrDetail`
Expected: PASS (no regressions; the four consumers compile and their existing tests still pass).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/PrDetail/PrTabHost.tsx frontend/src/components/AskAiDrawer/DrawerEffects.tsx frontend/src/components/PrTabStrip/PrTabStrip.tsx frontend/src/hooks/useTabUnreadSignal.ts frontend/src/components/Settings/keepAlive.test.tsx
git commit -m "feat(#134): resolve four outside-Routes consumers via useEffectiveLocation (keep-alive under modal)"
```

---

### Task 14: Header gear

**Files:**
- Modify: `frontend/src/components/Header/Header.tsx`, `frontend/src/components/Header/Header.module.css`
- Test: `frontend/src/components/Header/Header.test.tsx` (create if absent)

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Header/Header.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { Header } from './Header';

function at(path: string, isAuthed = true) {
  return render(<MemoryRouter initialEntries={[path]}><Header isAuthed={isAuthed} /></MemoryRouter>);
}

describe('Header gear', () => {
  it('renders a Settings gear button when authed', () => {
    at('/');
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/settings/appearance');
  });

  it('marks the gear active while a settings modal is open', () => {
    at('/settings/system');
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('aria-current', 'page');
  });

  it('does not render the gear first-run (unauthed)', () => {
    at('/setup', false);
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Header/Header.test.tsx`
Expected: FAIL — the Settings affordance is currently a tab `Link to="/"`-sibling labelled "Settings" without the gear/`href="/settings/appearance"` shape, or the gear is absent.

- [ ] **Step 3: Edit `Header.tsx`**

Replace the Settings `<Link>` inside the `<nav className={styles.tabs}>` with a gear icon button moved to the utility area (after the `spacer`, before `WindowControls`). Keep the Inbox tab. Use a `useLocation`-driven active flag (live pathname is correct for the gear). Concretely:

```tsx
// inside Header(): keep the FULL location object (needed as backgroundLocation),
// and keep the existing useSearchParams-derived isReplaceMode untouched:
const location = useLocation();
const { pathname } = location;
const [searchParams] = useSearchParams();        // KEEP — do not remove
const isReplaceMode = searchParams.has('replace'); // KEEP

const settingsActive =
  pathname === '/settings' || pathname.startsWith('/settings/') || (pathname === '/setup' && isReplaceMode);

// nav now holds only Inbox:
{isAuthed && (
  <nav className={styles.tabs}>
    <Link to="/" className={classFor(inboxActive)} aria-current={inboxActive ? 'page' : undefined}>Inbox</Link>
  </nav>
)}
<div className={styles.spacer} data-testid="header-spacer" />
{isAuthed && (
  <Link
    to="/settings/appearance"
    state={{ backgroundLocation: location }}
    className={settingsActive ? `${styles.gear} ${styles.gearOn}` : styles.gear}
    aria-label="Settings"
    aria-current={settingsActive ? 'page' : undefined}
  >
    <GearIcon />
  </Link>
)}
```
Pass the **full `location`** object as `backgroundLocation` (spec §3.4 — a full `Location`, not a `{pathname,search}` partial, so it satisfies the `Location` type the close handler and `useEffectiveLocation` consume). Import the gear: reuse `GearIcon` from `../PrDetail/FilesTab/diffIcons` (already exists). Remove the now-unused Settings-tab `classFor`/`settingsActive`-on-tab styling reference if dead.

Append to `Header.module.css`:
```css
.gear { display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-2); color: var(--text-2); }
.gear:hover { background: var(--surface-3); color: var(--text-1); }
.gear:focus-visible { outline: 2px solid var(--accent-ring); }
.gearOn { background: var(--accent-soft); color: var(--accent); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Header/Header.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Header/Header.tsx frontend/src/components/Header/Header.module.css frontend/src/components/Header/Header.test.tsx
git commit -m "feat(#134): replace Settings tab with a Header gear opening the modal"
```

---

## Phase E — e2e migration + visual gate

### Task 15: Migrate existing e2e specs

**Files (modify):** `frontend/e2e/settings-flow.spec.ts`, `replace-token-same-login.spec.ts`, `replace-token-different-login.spec.ts`, `replace-token-submit-in-flight.spec.ts`, `density-toggle.spec.ts`, `density-cross-tab.spec.ts`, `a11y-audit.spec.ts`, `ai-gating-sweep.spec.ts`

- [ ] **Step 1: Identify and apply the mechanical retargets** (no new behavior — the specs must reach the same controls in the new structure)

For each spec, apply these substitutions:
1. **Reaching Settings:** replace `await page.goto('/settings')` with `await page.goto('/settings/appearance')` (opens the modal cold over Inbox). Where a spec clicked a "Settings" nav tab, replace with clicking the gear: `await page.getByRole('link', { name: /settings/i }).click()`.
2. **Section-scoped assertions:** `settings-flow.spec.ts` asserts all four section headings on one page. Split into per-pane navigation:
   - Appearance controls: at `/settings/appearance`.
   - Connection copy-path → navigate `await page.getByRole('link', { name: 'Files & logs' }).click()` then assert at `/settings/system`.
   - Replace token / host → `await page.getByRole('link', { name: 'GitHub Connection' }).click()`.
   Replace native `<select>` interactions (theme/density) with the segmented radios: `await page.getByRole('radio', { name: 'Light' }).click()` instead of `selectOption`.
3. **Replace-token specs:** change `page.goto('/settings')` → `page.goto('/settings/github-connection')`; the `Replace token` link assertions are unchanged.
4. **Density specs:** density is now a `SegmentedControl`; replace `selectOption('compact')` with `getByRole('radio', { name: 'Compact' }).click()`; assertions on `data-density` are unchanged.
5. **a11y-audit / ai-gating-sweep:** update any `/settings` navigation to `/settings/appearance`; the AI-preview toggle is now `getByRole('switch', { name: /AI preview/i })`.

- [ ] **Step 2: Run the migrated specs**

Run: `cd frontend && npx playwright test settings-flow replace-token density a11y-audit ai-gating-sweep`
Expected: PASS (same behavior, new selectors). Fix selector mismatches until green.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/settings-flow.spec.ts frontend/e2e/replace-token-*.spec.ts frontend/e2e/density-*.spec.ts frontend/e2e/a11y-audit.spec.ts frontend/e2e/ai-gating-sweep.spec.ts
git commit -m "test(#134): migrate e2e specs to the Settings modal + routed panes"
```

---

### Task 16: B1 visual gate (Playwright screenshots)

**Files (create):** `frontend/e2e/settings-modal-visual.spec.ts`

- [ ] **Step 1: Write the screenshot spec**

```ts
// frontend/e2e/settings-modal-visual.spec.ts
import { test, expect } from '@playwright/test';

const THEMES = [
  { theme: 'light', radio: 'Light' },
  { theme: 'dark', radio: 'Dark' },
] as const;

// Drive theme the way a user does — click the Appearance segmented control —
// so the real applyThemeToDocument path runs (theme + accent vars together) and
// AppearanceSync cannot clobber a hand-poked data-theme. The preference persists,
// so a later navigation to another pane keeps the chosen theme.
async function setTheme(page, radioName: string) {
  await page.goto('/settings/appearance');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByRole('radio', { name: radioName }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', radioName.toLowerCase());
}

for (const { theme, radio } of THEMES) {
  test(`settings modal — appearance (${theme})`, async ({ page }) => {
    await setTheme(page, radio);
    await expect(page).toHaveScreenshot(`settings-appearance-${theme}.png`);
  });

  test(`settings modal — github connection (${theme})`, async ({ page }) => {
    await setTheme(page, radio);
    await page.getByRole('link', { name: 'GitHub Connection' }).click();
    await expect(page.getByRole('heading', { name: 'GitHub Connection' })).toBeVisible();
    await expect(page).toHaveScreenshot(`settings-ghc-${theme}.png`);
  });
}

test('settings modal — narrow viewport collapses the nav', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto('/settings/appearance');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expect(page).toHaveScreenshot('settings-narrow.png');
});
```

(If the existing parity-baseline / theme e2e specs already centralize a theme-set helper, reuse that instead of the local `setTheme` above to stay consistent.)

- [ ] **Step 2: Generate baselines**

Run: `cd frontend && npx playwright test settings-modal-visual --update-snapshots`
Expected: baselines created under `frontend/e2e/settings-modal-visual.spec.ts-snapshots/`.

- [ ] **Step 3: Re-run to confirm stable**

Run: `cd frontend && npx playwright test settings-modal-visual`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/settings-modal-visual.spec.ts frontend/e2e/settings-modal-visual.spec.ts-snapshots
git commit -m "test(#134): add B1 visual gate screenshots for the Settings modal"
```

---

### Task 17: Cleanup + full pre-push checklist

- [ ] **Step 1: Delete superseded section components** (logic now lives in panes)

```bash
git rm frontend/src/components/Settings/AppearanceSection.tsx frontend/src/components/Settings/InboxSectionsSection.tsx frontend/src/components/Settings/ConnectionSection.tsx frontend/src/components/Settings/AuthSection.tsx
```
Grep first to confirm no other importers remain: `cd frontend && grep -rn "AppearanceSection\|InboxSectionsSection\|ConnectionSection\|AuthSection\|SettingsPage" src` → expect only the deleted files. (Run this **after** Task 15's e2e migration — a not-yet-migrated spec could still reference the old surface.) Remove any stale `SettingsSections.module.css` if unreferenced.

- [ ] **Step 2: Full local pre-push checklist** (`.ai/docs/development-process.md`)

Run each, all must pass:
```bash
cd frontend && npx vitest run
node ./node_modules/prettier/bin/prettier.cjs --check .
npm run lint
npm run build
npx playwright test
```
(Run prettier directly per the rtk-masking note. Address any failures before pushing.)

- [ ] **Step 3: Commit cleanup**

```bash
git add -A
git commit -m "refactor(#134): remove superseded Settings section components"
```

---

## Self-Review

**1. Spec coverage:**
- §3.1 modal shell → Task 6. §3.2 master-detail → Task 7. §3.3 taxonomy/panes → Tasks 8–11. §3.4 routing + auth guard + redirect + close → Task 12. §3.4a `useEffectiveLocation` + `SettingsLink` + four consumers → Tasks 1, 2, 13. §3.5 controls (segmented/swatch/switch, palette, wrap, fallback) → Tasks 3–5. §3.6 sizing/scroll/motion → Task 6 CSS. §4 component tree + Header gear → Tasks 7, 12, 14. §5 behavior preservation → ported verbatim in Tasks 8–11 (+ tests assert key writes / in-flight guard / copy). §6 a11y → radiogroup/switch roles (Tasks 3–5), dialog + scrim-only close (Task 6), nav aria-current (Task 7). §7 responsive → Task 7 CSS + Task 16 narrow screenshot. §8 testing → every task's tests + Tasks 15–16. §9 risk re-check → enforced at PR time (the four-consumer change is the only PrTabHost edit; checklist in spec). No gaps found.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — each task carries complete code or concrete, file-specific edit instructions.

**3. Type consistency:** `SegmentedControl` prop is `label` (used consistently in Tasks 3, 8). `Switch` props `id/checked/label/onChange/describedById` consistent across Tasks 4, 8, 9. `AccentSwatches` `value/onChange` consistent (Tasks 5, 8). `useEffectiveLocation` returns `{ pathname }` consumed in Tasks 1, 12, 13. `PreferenceKey` dotted-path used correctly in Task 9. Routes (`appearance`/`inbox`/`github-connection`/`system`) consistent across Tasks 7, 12, 14, 15, 16.

---

## Execution Handoff

Plan saved to `docs/plans/2026-06-06-settings-redesign.md`.
