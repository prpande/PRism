# Diff Settings Menu + Inline Diff-View Tiles + Global "Show full file" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three text toggle buttons in the Files-tab diff toolbar with an inline ADO-style Split/Unified tile toggle plus a single ⚙ "Diff settings" gear popover (Show full file, Wrap long lines), and make "Show full file" a view-wide preference.

**Architecture:** Two new presentational components (`DiffViewToggle` inline, `DiffSettingsMenu` gear popover) + an extracted state hook (`useWholeFilePreference`) so the view-wide-full-file logic is unit-testable outside FilesTab. FilesTab is rewired to render them and pass a derived `wholeFileEnabled` to `DiffPane`. Icons are inline SVG reproductions of Azure DevOps' `bowtie-diff-inline` / `bowtie-diff-side-by-side`.

**Tech Stack:** React + TypeScript + Vite, CSS Modules, vitest + @testing-library/react + user-event, Playwright e2e.

**Spec:** `docs/specs/2026-06-05-diff-settings-menu-design.md`

---

## File Structure

All paths under `frontend/src/components/PrDetail/FilesTab/`.

| File | Responsibility |
|------|----------------|
| `diffIcons.tsx` (create) | Inline SVG icon components: `InlineDiffIcon`, `SideBySideDiffIcon`, `GearIcon`. Monochrome `currentColor`, `aria-hidden`. |
| `DiffViewToggle.tsx` + `.module.css` (create) | Inline segmented radiogroup (Unified / Split) using the ADO diff icons. Hot-path, always visible. |
| `DiffSettingsMenu.tsx` + `.module.css` (create) | Gear trigger + disclosure popover with Show-full-file / Wrap checkboxes, active-indicator, disabled + helper-text states, outside-click + focus-return. |
| `wholeFilePreference.ts` (create) | `useWholeFilePreference()` hook (`showFullFile` boolean + `failedPaths` set + actions) and pure `deriveWholeFileEnabled()`. |
| `FilesTab.tsx` (modify) | Replace the 3 toolbar buttons + per-file `wholeFilePaths` state with the new components + hook; pass derived `wholeFileEnabled` to `DiffPane`. |
| `FilesTab.module.css` (modify) | Remove obsolete `.diffModeToggle`/`.wholeFileToggle`/`.lineWrapToggle`/`.toolbarToggleButton` rules. |
| `*.test.tsx` (create) | Co-located unit tests per component/hook. |
| `frontend/e2e/diff-settings-menu.spec.ts` (create) | Hermetic Playwright integration test. |

Tasks are ordered leaf-first (icons → components/hook → FilesTab wiring → e2e → proof) so each builds on green predecessors.

---

## Task 1: ADO diff icons + gear icon

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/diffIcons.tsx`
- Test: `frontend/src/components/PrDetail/FilesTab/diffIcons.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// diffIcons.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { InlineDiffIcon, SideBySideDiffIcon, GearIcon } from './diffIcons';

describe('diffIcons', () => {
  it('renders each icon as an aria-hidden svg with a single column / two columns / gear shape', () => {
    const { container: unified } = render(<InlineDiffIcon />);
    const { container: split } = render(<SideBySideDiffIcon />);
    const { container: gear } = render(<GearIcon />);

    for (const c of [unified, split, gear]) {
      const svg = c.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      expect(svg!.getAttribute('focusable')).toBe('false');
    }
    // Split has a vertical divider line that unified does not.
    expect(split.querySelector('line[x1="8"][x2="8"]')).not.toBeNull();
    expect(unified.querySelector('line[x1="8"][x2="8"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/diffIcons.test.tsx`
Expected: FAIL — cannot find module `./diffIcons`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// diffIcons.tsx
// Inline SVG reproductions of Azure DevOps PR-compare diff icons
// (bowtie-diff-inline / bowtie-diff-side-by-side) + a settings gear.
// Monochrome currentColor so selection/theme is driven by CSS, not fills.

const SVG_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  'aria-hidden': true as const,
  focusable: 'false' as const,
};

export function InlineDiffIcon() {
  return (
    <svg {...SVG_PROPS}>
      <rect x="1.5" y="2" width="13" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="4" y1="5.5" x2="12" y2="5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="4" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function SideBySideDiffIcon() {
  return (
    <svg {...SVG_PROPS}>
      <rect x="1.5" y="2" width="13" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" strokeWidth="1.2" />
      <line x1="3.5" y1="6" x2="6.5" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="3.5" y1="9.5" x2="6.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="9.5" y1="6" x2="12.5" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="9.5" y1="9.5" x2="12.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8 1.5l1 1.6 1.9-.4.6 1.8 1.8.6-.4 1.9 1.6 1-1.6 1 .4 1.9-1.8.6-.6 1.8-1.9-.4-1 1.6-1-1.6-1.9.4-.6-1.8-1.8-.6.4-1.9-1.6-1 1.6-1-.4-1.9 1.8-.6.6-1.8 1.9.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/diffIcons.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/diffIcons.tsx frontend/src/components/PrDetail/FilesTab/diffIcons.test.tsx
git commit -m "feat(#185): add inline ADO-style diff icons (inline/side-by-side) + gear"
```

---

## Task 2: `DiffViewToggle` inline segmented control

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffViewToggle.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffViewToggle.module.css`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffViewToggle.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// DiffViewToggle.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffViewToggle } from './DiffViewToggle';

describe('DiffViewToggle', () => {
  it('renders two radios reflecting the current mode', () => {
    const { getByRole } = render(<DiffViewToggle diffMode="unified" onDiffModeChange={() => {}} />);
    expect((getByRole('radio', { name: /unified/i }) as HTMLInputElement).checked).toBe(true);
    expect((getByRole('radio', { name: /split/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('fires onDiffModeChange with the selected mode', async () => {
    const onChange = vi.fn();
    const { getByRole } = render(<DiffViewToggle diffMode="unified" onDiffModeChange={onChange} />);
    await userEvent.click(getByRole('radio', { name: /split/i }));
    expect(onChange).toHaveBeenCalledWith('side-by-side');
  });

  it('disables Split with a reason when splitDisabled', () => {
    const { getByRole } = render(
      <DiffViewToggle
        diffMode="unified"
        onDiffModeChange={() => {}}
        splitDisabled
        splitDisabledReason="Side-by-side needs a wider window."
      />,
    );
    const split = getByRole('radio', { name: /split/i }) as HTMLInputElement;
    expect(split.disabled).toBe(true);
  });

  it('exposes a labelled radiogroup', () => {
    const { getByRole } = render(<DiffViewToggle diffMode="side-by-side" onDiffModeChange={() => {}} />);
    expect(getByRole('radiogroup', { name: /diff view/i })).toBeInTheDocument();
  });

  it('moves selection with arrow keys (native radiogroup)', async () => {
    const onChange = vi.fn();
    const { getByRole } = render(<DiffViewToggle diffMode="unified" onDiffModeChange={onChange} />);
    getByRole('radio', { name: /unified/i }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('side-by-side');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/DiffViewToggle.test.tsx`
Expected: FAIL — cannot find module `./DiffViewToggle`.

- [ ] **Step 3: Write the component**

```tsx
// DiffViewToggle.tsx
import type { DiffMode } from './DiffPane';
import { InlineDiffIcon, SideBySideDiffIcon } from './diffIcons';
import styles from './DiffViewToggle.module.css';

export interface DiffViewToggleProps {
  diffMode: DiffMode;
  onDiffModeChange: (mode: DiffMode) => void;
  splitDisabled?: boolean;
  splitDisabledReason?: string;
}

export function DiffViewToggle({
  diffMode,
  onDiffModeChange,
  splitDisabled = false,
  splitDisabledReason,
}: DiffViewToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Diff view"
      className={`diff-view-toggle ${styles.diffViewToggle}`}
      data-testid="diff-view-toggle"
    >
      <label
        className={`${styles.tile}${diffMode === 'unified' ? ` ${styles.tileSelected}` : ''}`}
      >
        <input
          type="radio"
          name="diff-view"
          className={styles.srInput}
          checked={diffMode === 'unified'}
          onChange={() => onDiffModeChange('unified')}
          data-testid="diff-view-unified"
        />
        <InlineDiffIcon />
        <span className={styles.tileLabel}>Unified</span>
      </label>
      <label
        className={`${styles.tile}${diffMode === 'side-by-side' ? ` ${styles.tileSelected}` : ''}${splitDisabled ? ` ${styles.tileDisabled}` : ''}`}
        title={splitDisabled ? splitDisabledReason : undefined}
      >
        <input
          type="radio"
          name="diff-view"
          className={styles.srInput}
          checked={diffMode === 'side-by-side'}
          disabled={splitDisabled}
          onChange={() => onDiffModeChange('side-by-side')}
          data-testid="diff-view-split"
        />
        <SideBySideDiffIcon />
        <span className={styles.tileLabel}>Split</span>
      </label>
    </div>
  );
}
```

```css
/* DiffViewToggle.module.css */
.diffViewToggle {
  display: inline-flex;
  align-items: stretch;
  gap: 2px;
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px;
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
}
.tile {
  position: relative; /* containing block for .srInput so it can't escape */
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
  min-height: 24px;
  padding: var(--s-1) var(--s-2);
  border-radius: var(--radius-1);
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.tile:hover {
  background: var(--surface-3);
}
.tileSelected {
  background: var(--surface-3);
  color: var(--text-1);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}
.tileDisabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.tileDisabled:hover {
  background: transparent;
}
.tileLabel {
  font-size: var(--text-sm);
}
/* Visually-hidden but focusable radio; focus ring shown on the tile.
   clip-based hide (not bare position:absolute) so it stays confined to the
   positioned .tile and cannot create a stray hit-test area. */
.srInput {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  opacity: 0;
  margin: 0;
}
.tile:focus-within {
  outline: 2px solid var(--border-strong);
  outline-offset: 1px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/DiffViewToggle.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffViewToggle.tsx frontend/src/components/PrDetail/FilesTab/DiffViewToggle.module.css frontend/src/components/PrDetail/FilesTab/DiffViewToggle.test.tsx
git commit -m "feat(#185): inline DiffViewToggle segmented control (ADO diff icons)"
```

---

## Task 3: `useWholeFilePreference` hook + `deriveWholeFileEnabled`

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/wholeFilePreference.ts`
- Test: `frontend/src/components/PrDetail/FilesTab/wholeFilePreference.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// wholeFilePreference.test.tsx
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWholeFilePreference, deriveWholeFileEnabled, isWholeFileEligible } from './wholeFilePreference';

const base = {
  showFullFile: true,
  failedPaths: new Set<string>(),
  selectedPath: 'a.ts',
  selectedFileStatus: 'modified' as string | undefined,
  selectedFileHunkCount: 3,
  iterationGatePermits: true,
};

describe('deriveWholeFileEnabled', () => {
  it('is true when the global pref is on and the file is eligible', () => {
    expect(deriveWholeFileEnabled(base)).toBe(true);
  });
  it('is false when the global pref is off', () => {
    expect(deriveWholeFileEnabled({ ...base, showFullFile: false })).toBe(false);
  });
  it('is false for a failed path, an ineligible status, no hunks, or a blocked view', () => {
    expect(deriveWholeFileEnabled({ ...base, failedPaths: new Set(['a.ts']) })).toBe(false);
    expect(deriveWholeFileEnabled({ ...base, selectedFileStatus: 'added' })).toBe(false);
    expect(deriveWholeFileEnabled({ ...base, selectedFileHunkCount: 0 })).toBe(false);
    expect(deriveWholeFileEnabled({ ...base, iterationGatePermits: false })).toBe(false);
  });
  it('stays true across a selectedPath change to another eligible file (view-wide)', () => {
    expect(deriveWholeFileEnabled({ ...base, selectedPath: 'b.ts' })).toBe(true);
  });
});

describe('useWholeFilePreference', () => {
  it('toggles the boolean via setShowFullFile', () => {
    const { result } = renderHook(() => useWholeFilePreference());
    expect(result.current.showFullFile).toBe(false);
    act(() => result.current.setShowFullFile(true));
    expect(result.current.showFullFile).toBe(true);
  });
  it('records a failed path and clears it on re-enable (false -> true)', () => {
    const { result } = renderHook(() => useWholeFilePreference());
    act(() => result.current.setShowFullFile(true));
    act(() => result.current.markFailed('a.ts'));
    expect(result.current.failedPaths.has('a.ts')).toBe(true);
    act(() => result.current.setShowFullFile(false));
    act(() => result.current.setShowFullFile(true)); // retry affordance
    expect(result.current.failedPaths.has('a.ts')).toBe(false);
  });
  it('does not clear failed paths when set to true while already true', () => {
    const { result } = renderHook(() => useWholeFilePreference());
    act(() => result.current.setShowFullFile(true));
    act(() => result.current.markFailed('a.ts'));
    act(() => result.current.setShowFullFile(true)); // no false->true transition inside the set itself
    expect(result.current.failedPaths.has('a.ts')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/wholeFilePreference.test.tsx`
Expected: FAIL — cannot find module `./wholeFilePreference`.

- [ ] **Step 3: Write the implementation**

```ts
// wholeFilePreference.ts
import { useState, useCallback } from 'react';

export interface DeriveWholeFileParams {
  showFullFile: boolean;
  failedPaths: Set<string>;
  selectedPath: string | null;
  selectedFileStatus: string | undefined;
  selectedFileHunkCount: number;
  iterationGatePermits: boolean;
}

/** Single source of truth for per-file whole-file eligibility (status + hunks).
 * Used by both deriveWholeFileEnabled and FilesTab's inert-note computation so
 * the rule has one home. */
export function isWholeFileEligible(status: string | undefined, hunkCount: number): boolean {
  return status === 'modified' && hunkCount > 0;
}

/** The effective per-current-file whole-file flag passed to DiffPane. */
export function deriveWholeFileEnabled(p: DeriveWholeFileParams): boolean {
  return (
    p.showFullFile &&
    p.selectedPath !== null &&
    !p.failedPaths.has(p.selectedPath) &&
    p.iterationGatePermits &&
    isWholeFileEligible(p.selectedFileStatus, p.selectedFileHunkCount)
  );
}

export interface WholeFilePreference {
  showFullFile: boolean;
  /** Direction-aware: setting true clears failedPaths (a retry affordance). */
  setShowFullFile: (next: boolean) => void;
  failedPaths: Set<string>;
  markFailed: (path: string) => void;
}

export function useWholeFilePreference(): WholeFilePreference {
  const [showFullFile, setShow] = useState(false);
  const [failedPaths, setFailedPaths] = useState<Set<string>>(new Set());

  const setShowFullFile = useCallback((next: boolean) => {
    setShow((prev) => {
      // Clear the failed set only on a genuine false -> true transition.
      if (next && !prev) setFailedPaths(new Set());
      return next;
    });
  }, []);

  const markFailed = useCallback((path: string) => {
    setFailedPaths((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  return { showFullFile, setShowFullFile, failedPaths, markFailed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/wholeFilePreference.test.tsx`
Expected: PASS (7 assertions across the cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/wholeFilePreference.ts frontend/src/components/PrDetail/FilesTab/wholeFilePreference.test.tsx
git commit -m "feat(#185): useWholeFilePreference hook + deriveWholeFileEnabled (view-wide full-file)"
```

---

## Task 4: `DiffSettingsMenu` gear popover — disclosure shell

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffSettingsMenu.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffSettingsMenu.module.css`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffSettingsMenu.test.tsx`

This task builds the gear + open/close/outside-click/focus-return + active indicator. Task 5 adds the panel-content assertions.

- [ ] **Step 1: Write the failing test**

```tsx
// DiffSettingsMenu.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffSettingsMenu } from './DiffSettingsMenu';

function setup(overrides = {}) {
  const props = {
    showFullFile: false,
    onShowFullFileChange: vi.fn(),
    fullFileViewBlocked: false,
    fullFileViewBlockedReason: null,
    fullFileInertHere: false,
    fullFileInertReason: null,
    lineWrap: false,
    onLineWrapChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DiffSettingsMenu {...props} />) };
}

describe('DiffSettingsMenu — disclosure shell', () => {
  it('is closed initially with aria-expanded=false', () => {
    const { getByTestId, queryByTestId } = setup();
    expect(getByTestId('diff-settings-trigger').getAttribute('aria-expanded')).toBe('false');
    expect(queryByTestId('diff-settings-panel')).toBeNull();
  });

  it('opens on click and closes on a second click, returning focus to the gear', async () => {
    const { getByTestId, queryByTestId } = setup();
    const trigger = getByTestId('diff-settings-trigger');
    await userEvent.click(trigger);
    expect(getByTestId('diff-settings-panel')).toBeInTheDocument();
    await userEvent.click(trigger);
    expect(queryByTestId('diff-settings-panel')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape and returns focus to the gear', async () => {
    const { getByTestId, queryByTestId } = setup();
    const trigger = getByTestId('diff-settings-trigger');
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(queryByTestId('diff-settings-panel')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on outside click and returns focus to the gear', async () => {
    const { getByTestId, queryByTestId } = setup();
    const trigger = getByTestId('diff-settings-trigger');
    await userEvent.click(trigger);
    await userEvent.click(document.body);
    expect(queryByTestId('diff-settings-panel')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('marks the gear modified when a setting is non-default', () => {
    const { getByTestId } = setup({ lineWrap: true });
    const trigger = getByTestId('diff-settings-trigger');
    expect(trigger.getAttribute('aria-label')).toMatch(/modified/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/DiffSettingsMenu.test.tsx`
Expected: FAIL — cannot find module `./DiffSettingsMenu`.

- [ ] **Step 3: Write the component (shell + panel — panel content asserted in Task 5)**

```tsx
// DiffSettingsMenu.tsx
import { useState, useRef, useEffect, useId, useCallback } from 'react';
import { GearIcon } from './diffIcons';
import styles from './DiffSettingsMenu.module.css';

export interface DiffSettingsMenuProps {
  showFullFile: boolean;
  onShowFullFileChange: (on: boolean) => void;
  fullFileViewBlocked: boolean;
  fullFileViewBlockedReason: string | null;
  fullFileInertHere: boolean;
  fullFileInertReason: string | null;
  lineWrap: boolean;
  onLineWrapChange: (on: boolean) => void;
}

export function DiffSettingsMenu({
  showFullFile,
  onShowFullFileChange,
  fullFileViewBlocked,
  fullFileViewBlockedReason,
  fullFileInertHere,
  fullFileInertReason,
  lineWrap,
  onLineWrapChange,
}: DiffSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const instanceId = useId();
  const panelId = `${instanceId}-diff-settings-panel`;
  const helperId = `${instanceId}-full-file-helper`;

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Outside-click close — net-new vs CommitMultiSelectPicker, which has none.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  // Escape from anywhere in the component (trigger OR panel) closes it. We do
  // NOT auto-move focus into the panel on open: a mouse user keeps their place
  // and a keyboard user tabs in. The APG disclosure pattern does not require
  // moving focus on open, and auto-focusing would jump the cursor for mouse
  // users. Putting onKeyDown on the root (which wraps the trigger) is what lets
  // Escape work whether focus is on the gear or on a panel control.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  // Effective non-default state — a view-blocked full-file preference produces
  // no visible effect, so it must not light the indicator (spec: blocked/forced
  // states never count).
  const isModified = (showFullFile && !fullFileViewBlocked) || lineWrap;
  const helperText = fullFileViewBlocked
    ? fullFileViewBlockedReason
    : fullFileInertHere
      ? fullFileInertReason
      : null;

  return (
    <div
      ref={rootRef}
      className={`diff-settings-menu ${styles.root}`}
      onKeyDown={onKeyDown}
      data-testid="diff-settings-menu"
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.gear}${isModified ? ` ${styles.gearModified}` : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={isModified ? 'Diff settings (modified)' : 'Diff settings'}
        title="Diff settings"
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="diff-settings-trigger"
      >
        <GearIcon />
        {isModified && <span className={styles.modifiedDot} aria-hidden="true" />}
      </button>

      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Diff settings"
          className={styles.panel}
          data-testid="diff-settings-panel"
        >
          <label className={styles.row}>
            <input
              type="checkbox"
              checked={showFullFile}
              disabled={fullFileViewBlocked}
              aria-describedby={helperText ? helperId : undefined}
              onChange={(e) => onShowFullFileChange(e.target.checked)}
              data-testid="show-full-file-checkbox"
            />
            <span>Show full file</span>
          </label>
          {helperText && (
            <p id={helperId} className={styles.helper} data-testid="show-full-file-helper">
              {helperText}
            </p>
          )}
          <label className={styles.row}>
            <input
              type="checkbox"
              checked={lineWrap}
              onChange={(e) => onLineWrapChange(e.target.checked)}
              data-testid="line-wrap-checkbox"
            />
            <span>Wrap long lines</span>
          </label>
        </div>
      )}
    </div>
  );
}
```

```css
/* DiffSettingsMenu.module.css */
.root {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  margin-left: var(--s-2);
}
.gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  min-width: 32px;
  min-height: 32px;
  padding: var(--s-1);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  color: var(--text-2);
  cursor: pointer;
}
.gear:hover {
  background: var(--surface-3);
  color: var(--text-1);
}
.gearModified {
  color: var(--text-1);
  border-color: var(--border-strong);
}
.modifiedDot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.panel {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  min-width: 220px;
  max-height: 60vh;
  overflow-y: auto;
  padding: var(--s-3);
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.25);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--text-sm);
  color: var(--text-1);
  cursor: pointer;
}
.helper {
  margin: 0 0 0 calc(var(--s-2) + 1em);
  font-size: var(--text-xs, 0.75rem);
  color: var(--text-2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/DiffSettingsMenu.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffSettingsMenu.tsx frontend/src/components/PrDetail/FilesTab/DiffSettingsMenu.module.css frontend/src/components/PrDetail/FilesTab/DiffSettingsMenu.test.tsx
git commit -m "feat(#185): DiffSettingsMenu gear popover (open/close/outside-click/focus-return + active indicator)"
```

---

## Task 5: `DiffSettingsMenu` panel content — checkboxes, disabled, notes

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffSettingsMenu.test.tsx`

The component already supports these (Task 4); this task adds the behavioral assertions.

- [ ] **Step 1: Add failing tests**

```tsx
// append inside DiffSettingsMenu.test.tsx
describe('DiffSettingsMenu — panel content', () => {
  it('reflects and toggles Show full file and Wrap long lines with stable labels', async () => {
    const { props, getByTestId } = setup({ showFullFile: true, lineWrap: false });
    await userEvent.click(getByTestId('diff-settings-trigger'));
    const full = getByTestId('show-full-file-checkbox') as HTMLInputElement;
    const wrap = getByTestId('line-wrap-checkbox') as HTMLInputElement;
    expect(full.checked).toBe(true);
    expect(wrap.checked).toBe(false);
    await userEvent.click(wrap);
    expect(props.onLineWrapChange).toHaveBeenCalledWith(true);
    await userEvent.click(full);
    expect(props.onShowFullFileChange).toHaveBeenCalledWith(false);
    // Labels are stable regardless of state:
    expect(getByTestId('diff-settings-panel').textContent).toContain('Show full file');
    expect(getByTestId('diff-settings-panel').textContent).toContain('Wrap long lines');
  });

  it('disables Show full file with a view-blocked reason wired via aria-describedby', async () => {
    const { getByTestId } = setup({
      fullFileViewBlocked: true,
      fullFileViewBlockedReason: "Whole-file view available only on the 'all' iteration view",
    });
    await userEvent.click(getByTestId('diff-settings-trigger'));
    const full = getByTestId('show-full-file-checkbox') as HTMLInputElement;
    const helper = getByTestId('show-full-file-helper');
    expect(full.disabled).toBe(true);
    expect(full.getAttribute('aria-describedby')).toBe(helper.id);
    expect(helper.textContent).toMatch(/all.*iteration/i);
  });

  it('keeps Show full file enabled but shows a mandatory inert note for an ineligible current file', async () => {
    const { getByTestId } = setup({
      showFullFile: true,
      fullFileInertHere: true,
      fullFileInertReason: 'Not available for this file — still on for other files',
    });
    await userEvent.click(getByTestId('diff-settings-trigger'));
    const full = getByTestId('show-full-file-checkbox') as HTMLInputElement;
    const helper = getByTestId('show-full-file-helper');
    expect(full.disabled).toBe(false);
    expect(full.checked).toBe(true);
    expect(full.getAttribute('aria-describedby')).toBe(helper.id);
    expect(helper.textContent).toMatch(/still on for other files/i);
  });

  it('closes on Escape pressed from a focused checkbox (not just from the trigger)', async () => {
    const { getByTestId, queryByTestId } = setup();
    const trigger = getByTestId('diff-settings-trigger');
    await userEvent.click(trigger);
    const wrap = getByTestId('line-wrap-checkbox');
    wrap.focus();
    expect(wrap).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(queryByTestId('diff-settings-panel')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
```

- [ ] **Step 2: Run test to verify the new cases pass (component already supports them)**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/DiffSettingsMenu.test.tsx`
Expected: PASS (8 tests total). If any fail, fix `DiffSettingsMenu.tsx` to satisfy them (do not weaken the test).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffSettingsMenu.test.tsx
git commit -m "test(#185): DiffSettingsMenu panel content — toggles, disabled view-block, mandatory inert note"
```

---

## Task 6: Wire FilesTab to the new components + view-wide state

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css`

No new unit test here — FilesTab has no existing unit harness (it depends on `usePrDetailContext` and many hooks); its logic is unit-tested through Tasks 2–5 and integration-tested by the Playwright e2e in Task 7. Verification for this task is `tsc` + the full vitest suite staying green + lint/build.

- [ ] **Step 1: Add imports**

In `FilesTab.tsx`, alongside the existing FilesTab imports (near line 14):

```tsx
import { DiffViewToggle } from './DiffViewToggle';
import { DiffSettingsMenu } from './DiffSettingsMenu';
import { useWholeFilePreference, deriveWholeFileEnabled, isWholeFileEligible } from './wholeFilePreference';
```

- [ ] **Step 2: Replace the per-file whole-file state with the hook**

Remove line 65:

```tsx
const [wholeFilePaths, setWholeFilePaths] = useState<Set<string>>(new Set());
```

Add (next to the other `useState` declarations, e.g. after the `lineWrap` state at line 69):

```tsx
const { showFullFile, setShowFullFile, failedPaths, markFailed } = useWholeFilePreference();
```

- [ ] **Step 3: Replace the `wholeFileEnabled` derivation + gating flags**

Replace the block at lines 134–140 (the old `wholeFileEnabled` derivation) with:

```tsx
const wholeFileEnabled = deriveWholeFileEnabled({
  showFullFile,
  failedPaths,
  selectedPath,
  selectedFileStatus: selectedFile?.status,
  selectedFileHunkCount: selectedFile?.hunks.length ?? 0,
  iterationGatePermits,
});

// Gating, split by scope (spec § Disabled / helper-text):
const fullFileViewBlocked = !iterationGatePermits;
const currentFileIneligible =
  selectedFile !== null && !isWholeFileEligible(selectedFile.status, selectedFile.hunks.length);
const fullFileInertHere = showFullFile && iterationGatePermits && currentFileIneligible;
const fullFileViewBlockedReason = fullFileViewBlocked
  ? "Whole-file view available only on the 'all' iteration view"
  : null;
const fullFileInertReason = fullFileInertHere
  ? 'Not available for this file — still on for other files'
  : null;
```

- [ ] **Step 4: Replace the whole-file handlers**

Delete `handleToggleWholeFile` (lines 202–210). Replace `handleWholeFileFailed` (lines 212–227) with:

```tsx
const handleWholeFileFailed = useCallback(
  // Reason is part of the callback contract but not used here — DiffPane's
  // local latch holds the reason and renders the banner. We only need to know
  // the current file's whole-file fetch failed so it falls back to hunks while
  // the global preference stays on.
  (reason: string) => {
    void reason;
    if (!selectedPath) return;
    markFailed(selectedPath);
  },
  [selectedPath, markFailed],
);
```

Also delete `handleToggleLineWrap` (lines 198–200) — it is no longer referenced (the gear wires `onLineWrapChange` to `setLineWrap`). `handleToggleDiffMode` (line 193) **stays** — it is still used by `useFilesTabShortcuts` (`onToggleDiffMode`, line 235).

- [ ] **Step 4b: Fix the keyboard-shortcut INPUT guard so radio/checkbox focus doesn't swallow shortcuts**

The new inline `DiffViewToggle` renders always-visible **radio** inputs, and the gear renders **checkbox** inputs. `useFilesTabShortcuts` currently treats *any* `INPUT` as a text field and suppresses the `j`/`k`/`v`/`d` shortcuts when one has focus (`useFilesTabShortcuts.ts:10,14`) — so a focused tile silently breaks the shortcuts. Narrow the guard to text-entry inputs only.

Files: Modify `frontend/src/hooks/useFilesTabShortcuts.ts`; Test: create `frontend/src/hooks/useFilesTabShortcuts.test.tsx`.

Write the failing test first:

```tsx
// useFilesTabShortcuts.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useFilesTabShortcuts } from './useFilesTabShortcuts';

function Harness({
  onToggleDiffMode,
  onNextFile,
}: {
  onToggleDiffMode: () => void;
  onNextFile: () => void;
}) {
  useFilesTabShortcuts({ onNextFile, onPrevFile: () => {}, onToggleViewed: () => {}, onToggleDiffMode });
  return (
    <div>
      <div role="radiogroup">
        <input type="radio" data-testid="r" /> {/* an inline diff-view tile */}
      </div>
      <input type="checkbox" data-testid="c" /> {/* a gear menu control */}
      <textarea data-testid="t" />
    </div>
  );
}

describe('useFilesTabShortcuts INPUT guard', () => {
  it('fires from a radiogroup radio but stays suppressed in checkboxes and text fields', () => {
    const onToggle = vi.fn();
    const onNext = vi.fn();
    const { getByTestId } = render(<Harness onToggleDiffMode={onToggle} onNextFile={onNext} />);

    // Inline diff-view tile (radio in a radiogroup): shortcut fires.
    getByTestId('r').focus();
    getByTestId('r').dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    // Gear checkbox: 'j' must NOT navigate files while the menu is focused.
    getByTestId('c').focus();
    getByTestId('c').dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(onNext).not.toHaveBeenCalled();

    // Text field: still suppressed.
    getByTestId('t').focus();
    getByTestId('t').dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
```

Run: `cd frontend && npx vitest run src/hooks/useFilesTabShortcuts.test.tsx` → FAIL (radio currently suppressed; checkbox-suppressed leg already green).

Then narrow the guard in `useFilesTabShortcuts.ts` — replace the body of `isInputTarget`:

```ts
// INPUT_TAG_NAMES is the existing module-level const (['TEXTAREA','INPUT','SELECT'])
// — unchanged; only isInputTarget's body changes.
function isInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // ONLY the inline diff-view tiles (radios inside a role="radiogroup") may let
  // the single-key Files-tab shortcuts (j/k/v/d) through. Everything else — text
  // fields AND the gear's checkboxes — still suppresses, so typing inside the
  // open settings menu never navigates files / toggles mode underneath it.
  if (
    target.tagName === 'INPUT' &&
    (target as HTMLInputElement).type === 'radio' &&
    target.closest('[role="radiogroup"]')
  ) {
    return false;
  }
  if (INPUT_TAG_NAMES.has(target.tagName)) return true; // TEXTAREA, INPUT (incl. checkbox), SELECT
  if (target.closest('[contenteditable="true"]')) return true;
  return false;
}
```

Re-run the test → PASS. Commit:

```bash
git add frontend/src/hooks/useFilesTabShortcuts.ts frontend/src/hooks/useFilesTabShortcuts.test.tsx
git commit -m "fix(#185): don't suppress Files-tab shortcuts when a radio/checkbox control has focus"
```

- [ ] **Step 5: Replace the three toolbar buttons with the new components**

In the toolbar JSX, replace the three `<button>` elements (lines 427–473 — the `diffModeToggle`, `wholeFileToggle`, and `lineWrapToggle` buttons) with:

```tsx
<DiffViewToggle
  diffMode={effectiveDiffMode}
  onDiffModeChange={setDiffMode}
  splitDisabled={viewportWidth < 900}
  splitDisabledReason="Side-by-side needs a wider window."
/>
<DiffSettingsMenu
  showFullFile={showFullFile}
  onShowFullFileChange={setShowFullFile}
  fullFileViewBlocked={fullFileViewBlocked}
  fullFileViewBlockedReason={fullFileViewBlockedReason}
  fullFileInertHere={fullFileInertHere}
  fullFileInertReason={fullFileInertReason}
  lineWrap={lineWrap}
  onLineWrapChange={setLineWrap}
/>
```

(`setDiffMode` accepts a `DiffMode`; the radio passes the explicit mode. The `margin-left:auto` that right-aligned the cluster now lives on `.diffViewToggle`, so the inline toggle + gear sit at the right of the toolbar as before.)

- [ ] **Step 6: Remove obsolete CSS**

In `FilesTab.module.css`, delete the now-unused rules **by name** (currently ~lines 73–106 — delete by rule name, not a fixed line range, to avoid clipping the adjacent `@keyframes skeleton-pulse`): `.toolbarToggleButton`, `.toolbarToggleButton[aria-pressed='true']`, `.toolbarToggleButton:disabled`, `.diffModeToggle`, `.wholeFileToggle`, `.lineWrapToggle`. Delete the base `.toolbarToggleButton` **together with** its three `composes:` consumers in the same edit — CSS Modules errors on a dangling `composes` target. Then grep `FilesTab.module.css` for any remaining `margin-left: auto` to confirm none lingers on a removed wrapper (the right-alignment now lives on `.diffViewToggle`). Leave `.filesTabToolbar` and the rest intact.

- [ ] **Step 7: Verify types, tests, lint, build**

Run, in order:

```bash
cd frontend
npx tsc --noEmit
npx vitest run
npm run lint
npm run build
```

Expected: `tsc` clean (no references to removed `wholeFilePaths`/`handleToggleWholeFile`/`handleToggleLineWrap`); full vitest suite green; lint clean; build succeeds. If `tsc` flags an unused `setLineWrap`/`useState` import or a dangling reference, fix it.

> **Lint note:** run prettier/eslint **directly**, not via the rtk proxy, which can mask failures:
> `node ./node_modules/prettier/bin/prettier.cjs --check "src/components/PrDetail/FilesTab/**/*.{ts,tsx,css}"`

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.tsx frontend/src/components/PrDetail/FilesTab/FilesTab.module.css
git commit -m "feat(#185): wire FilesTab to inline DiffViewToggle + gear DiffSettingsMenu; make Show full file view-wide"
```

---

## Task 7: Playwright e2e (hermetic)

**Files:**
- Create: `frontend/e2e/diff-settings-menu.spec.ts`

Use the hermetic fixture `acme/api/123` via the **real** `./helpers/s4-setup` harness (confirmed from `diff-scroll-regression.spec.ts`): `resetBackendState(request)` → `setupAndOpenScenarioPr(page)` → `page.goto('/pr/acme/api/123/files')`. **The fixture is single-file** (`FakePrReader.cs` returns exactly one `FileChange("src/Calc.cs", Modified)`; `advance-head` only re-seeds that file's content, it cannot add a second path). So this spec proves the **chrome** hermetically; the view-wide "persists across files" property is single-file-unprovable here and is covered by the `deriveWholeFileEnabled` unit test (path-independent, Task 3) plus the Task 8 manual check on a real multi-file PR. The diff-mode marker is the class on `[data-testid="diff-pane"]` (`toHaveClass(/diff-pane--split|--unified/)` — there is **no** `data-diff-mode` attribute). The tiles' radio inputs are clip-hidden, so click the **visible label text**, not the input.

- [ ] **Step 1: Write the e2e spec**

```ts
// diff-settings-menu.spec.ts
import { test, expect } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr } from './helpers/s4-setup';

test.describe('Diff settings menu (#185)', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetBackendState(request);
    await page.setViewportSize({ width: 1440, height: 900 }); // >=900 so Split is enabled
    await setupAndOpenScenarioPr(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
  });

  test('inline tiles switch Split/Unified; gear toggles wrap; Escape returns focus', async ({ page }) => {
    const diffPane = page.locator('[data-testid="diff-pane"]');

    // Inline tiles — click the visible label (the radio input is clip-hidden).
    // Default mode is side-by-side, so flip to Unified first to prove a real change.
    await page.getByText('Unified', { exact: true }).click();
    await expect(diffPane).toHaveClass(/diff-pane--unified/);
    await page.getByText('Split', { exact: true }).click();
    await expect(diffPane).toHaveClass(/diff-pane--split/);

    // Gear opens; toggle Wrap + Show full file; Escape closes and returns focus.
    await page.getByTestId('diff-settings-trigger').click();
    await expect(page.getByTestId('diff-settings-panel')).toBeVisible();
    await page.getByTestId('line-wrap-checkbox').check();
    await page.getByTestId('show-full-file-checkbox').check();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('diff-settings-panel')).toBeHidden();
    await expect(page.getByTestId('diff-settings-trigger')).toBeFocused();

    // The gear's modified indicator reflects the non-default settings.
    await expect(page.getByTestId('diff-settings-trigger')).toHaveAttribute('aria-label', /modified/i);
  });
});
```

> **View-wide cross-file persistence** is NOT asserted here (single-file fixture). It is proven by the Task 3 unit test (`deriveWholeFileEnabled` is path-independent: same `showFullFile` → true for any eligible path) and the Task 8 Step 2 manual check on a real multi-file PR (toggle once, browse several files, each stays full).

> **Ineligible auto-select scenario** (spec-required; needs an added/no-hunks file the hermetic fixture lacks): covered by the Task 3 unit test (`deriveWholeFileEnabled` → false for `added`/no-hunks) + the Task 8 Step 2 manual check (enable Show full file, select an added file, confirm hunks fallback + the mandatory inert note).

- [ ] **Step 2: Run the e2e**

Run: `cd frontend && npx playwright test diff-settings-menu.spec.ts`
Expected: PASS. (If the local Playwright browser/binary is unavailable, capture the blocker and note it; CI runs the suite.)

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/diff-settings-menu.spec.ts
git commit -m "test(#185): Playwright e2e — inline tiles, gear, view-wide full-file"
```

---

## Task 8: a11y check, B1 visual proof, verification

**Files:** none (verification + assets).

- [ ] **Step 1: a11y sweep** — confirm the new controls pass axe. Run the existing audit: `cd frontend && npx playwright test a11y-audit.spec.ts`. Expected: no new violations on the Files tab (labelled radiogroup, gear with accessible name, checkboxes with labels, helper text via `aria-describedby`). Fix any violation before proceeding. **Also manually verify the helper-text contrast** (`.helper` = `--text-2` on `--surface-1` at `--text-xs`) meets WCAG AA (4.5:1) in **both** light and dark themes — compute oklch→luminance per the PR #165 method. If it falls short, bump `.helper` to `--text-1` or raise the size to ≥0.8125rem. The inert note is mandatory communication, so it must be readable. **Also check the two non-text UI indicators (WCAG 1.4.11, 3:1) in both themes:** the gear's `.modifiedDot` (`--accent` on the `--surface-2` gear) and the selected-tile ring (`--accent` inset on `--surface-3`). If either is below 3:1, add a 1px `--surface-1` separator ring to the dot / thicken the tile ring to 2px or add an icon-color change. (The dot is reinforced by the `aria-label="… (modified)"` for AT, but should still pass as a visual affordance; confirm the selected tile is visually distinct from a *hovered* unselected tile.)

- [ ] **Step 2: Launch the app and capture B1 visual proof** — start the app with `pwsh ./run.ps1 -Reset None --no-browser` (Development, real PAT, `localhost:5180`). Open a real PR with modified files (e.g. the BFF repo). Capture **light + dark** screenshots of: (a) the toolbar showing the inline `[Unified | Split]` tiles + the gear (incl. the gear's modified-dot when a setting is on), and (b) the open Diff-settings panel. Verify the ADO icons read correctly and the Split tile greys out below 900px. **Also exercise the ineligible-file path** (spec-required, not in the hermetic e2e): with Show full file enabled, select an **added** file — confirm the diff falls back to hunks, the gear's modified-dot stays on, and the mandatory inert note renders in the panel. Confirm the gear dot does **not** show when the only "on" setting is a view-blocked full-file (non-'all' iteration).

- [ ] **Step 3: Full pre-push checklist** — from `.ai/docs/development-process.md`, run every step: `npx tsc --noEmit`, `npx vitest run`, `npm run lint` (prettier directly, not via rtk), `npm run build`. All green.

- [ ] **Step 4: Commit any fixes** (if Steps 1–3 surfaced changes), then this task is the handoff point to `pr-autopilot` (the PR is opened with the B1 screenshots embedded for the human visual-assert gate — gated B1).

---

## Residual risks (accepted / deferred — from plan review)

- **`handleWholeFileFailed` closes over `selectedPath`.** If an in-flight whole-file fetch for file A rejects *after* an SSE-driven auto-select moved selection to file B, the wrong path could be marked failed. This is the **same shape as the pre-existing per-file code** (not a regression introduced here); the window is narrow (one selected file fetches at a time). Accepted as-is. If it proves real, the fix is to extend `DiffPane`'s `onWholeFileFailed(reason)` → `onWholeFileFailed(reason, path)` and mark that path — deferred (touches the DiffPane contract; out of this PR's scope).
- **Escape `stopPropagation` in the gear.** The menu deliberately stops Escape from bubbling so it closes only the menu, not an ancestor (PR-detail/keep-alive). During Task 6, confirm no ancestor relies on receiving Escape while the menu is open; if one does, it is intentionally shadowed only while the panel is open.
- **`diffIcons.tsx` single-file for three icons.** Kept (not inlined) for cohesion of the icon set and as the natural home for #184's future toggle icon; the file boundary aids discoverability. A reviewer flagged it as possible premature extraction — accepted as a deliberate, low-cost choice.
- **ADO bowtie glyph fidelity.** The Task 1 SVG paths approximate `bowtie-diff-inline` / `bowtie-diff-side-by-side`; the **B1 visual gate is the confirmation**. If they read wrong, a mid-PR SVG swap is expected and cheap (single file).
- **Gear modified-dot reflects *effective* state, by design.** With Show full file on, navigating to a non-'all' iteration (where it's view-blocked) extinguishes the dot, and returning to 'all' re-lights it — without the user touching the gear. This is the intended "blocked/forced states never count" rule (the dot tracks what's actually in effect), not a glitch. Surfaced in the Task 8 B1 checklist so the reviewer expects it; a distinct "set-but-inert" dimmed state was considered and deferred (YAGNI).

## Self-Review (run before handoff)

**Spec coverage** (each spec section → task):
- Inline ADO-icon Split/Unified toggle, hot path, split-disabled <900px → Tasks 1, 2, 6.
- Gear ⚙ popover holding Show full file + Wrap (+ room for #184; no stubs) → Tasks 1, 4, 5, 6.
- Corrected reuse boundary (outside-click + focus-return-on-all-paths are net-new) → Task 4 (component + tests for all close paths).
- Gear active-state indicator → Task 4.
- Native checkboxes, stable labels, keyboard contract, Escape-from-any-control → Tasks 4, 5.
- View-wide `showFullFile` + `failedPaths` + retry-on-re-enable + lazy fetch (one file) → Task 3 (hook/derive; shared `isWholeFileEligible` predicate) + Task 6 (wiring; `wholeFileEnabled` derived, not raw `showFullFile`, to `DiffPane`).
- `d`/`j`/`k`/`v` shortcuts keep working when a tile/checkbox has focus → Task 6 Step 4b (narrowed INPUT guard + test).
- Gating reclassified: view-level disable vs mandatory per-file inert note → Tasks 5, 6.
- Tests split chrome vs behavior-change → Tasks 2/4/5 (chrome) vs Task 3 + Task 7 (behavior).
- B1 visual proof (light+dark) + a11y → Task 8.

**Placeholder scan:** the only deliberate placeholder is the e2e helper import in Task 7, explicitly flagged to be wired to the real `diff-scroll-regression.spec.ts` setup during implementation (the repo's e2e harness shape can't be assumed blind). No other TBDs.

**Type consistency:** `DiffMode` imported from `./DiffPane` in `DiffViewToggle` and used in `FilesTab` (already imported there). `deriveWholeFileEnabled` param names match between Task 3 definition and Task 6 call site (`selectedFileStatus`, `selectedFileHunkCount`, `iterationGatePermits`). `setShowFullFile`/`markFailed`/`failedPaths`/`showFullFile` names consistent across Tasks 3 and 6. `DiffSettingsMenuProps` fields match the Task 6 call site exactly. `onDiffModeChange` receives a `DiffMode`; `setDiffMode` is a `Dispatch<SetStateAction<DiffMode>>` and accepts a bare `DiffMode` value — compatible.
