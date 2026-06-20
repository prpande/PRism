# Hotspots Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Hotspots tab as a headline-led, single-container list — each hotspot leads with a short synopsis (derived from the rationale's first line), shows severity via a signal-bars glyph, and exposes a clear "Diff" jump-to-code pill — with a muted Low count-footer.

**Architecture:** Frontend-led. A new pure `splitRationale` helper derives a headline + markdown body from the rationale; a new `LevelGlyph` renders the signal-bars severity glyph; `HotspotsTab` is restructured into one card of severity-sorted rows + a Low footer. Backend changes are copy-only: the ranker prompt is reshaped to emit a synopsis-first rationale, the stale `FileFocus.Rationale` doc comment is corrected, and sample data is updated. The `FileFocus` wire/DTO **shape** does not change.

**Tech Stack:** React 18 + TypeScript + Vite + CSS Modules (frontend); vitest + @testing-library/react (unit); Playwright (e2e); .NET 10 / C# (backend prompt + DTO comment + placeholder).

## Global Constraints

- Base branch is **V2**. Issue **#520**, epic #423; evolves shipped #465/#488.
- **No `FileFocus` wire/DTO shape change** — `FileFocus(Path, Level, Rationale)` and `FileFocusResult` are unchanged. The headline is derived client-side.
- The expanded rationale renders via the shared `MarkdownRenderer` — **never** `dangerouslySetInnerHTML` / raw HTML.
- Severity glyph hues use existing design tokens — `--warning` (High), `--info` (Medium), `--text-3` (Low active), `--border-1` (inactive bars). Level is encoded by **shape+fill AND hue** (not color alone, WCAG 1.4.1).
- Preserve the exact accessible names the e2e depends on: row toggle `Toggle {path} rationale`; jump pill `Open {path} in diff`.
- Preserve the shipped non-row states verbatim: `loading` skeleton (testid `hotspots-skeleton`), `fallback`, `error` (+ Retry), `not-subscribed`, `no-changes`, and the all-low positive-empty message.
- Reuse the existing `onSelectSubTab('files')` context method for the Low footer — do **not** add a new context primitive.
- Run vitest via the local binary (`frontend/node_modules/.bin/vitest`), never `npx vitest`. Run one build/test command at a time, foreground, timeout ≥ 300000ms.
- Sort rows within a level by `path` ascending (deterministic order).
- Low count counts **model-scored** low only; exclude low-by-rule (`rationale === "No changes to review in this file."`).

---

### Task 1: `splitRationale` helper

**Files:**
- Create: `frontend/src/components/PrDetail/HotspotsTab/splitRationale.ts`
- Test: `frontend/src/components/PrDetail/HotspotsTab/splitRationale.test.ts`
- Reuse (no change): `frontend/src/components/PrDetail/HotspotsTab/stripMarkdown.ts`

**Interfaces:**
- Consumes: `stripMarkdown(md: string): string` (existing — returns the first non-empty line stripped of markdown leaders).
- Produces: `splitRationale(rationale: string): { headline: string; body: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/components/PrDetail/HotspotsTab/splitRationale.test.ts
import { describe, it, expect } from 'vitest';
import { splitRationale } from './splitRationale';

describe('splitRationale', () => {
  it('conforming: first prose line is the headline, the rest is the body', () => {
    const { headline, body } = splitRationale('Boundary handling in core calc\n- a\n- b');
    expect(headline).toBe('Boundary handling in core calc');
    expect(body).toBe('- a\n- b');
  });

  it('conforming: strips markdown from the synopsis line', () => {
    expect(splitRationale('**Bold** synopsis\n- detail').headline).toBe('Bold synopsis');
  });

  it('conforming synopsis-only (no body) yields an empty body', () => {
    expect(splitRationale('Just a one-line synopsis')).toEqual({
      headline: 'Just a one-line synopsis',
      body: '',
    });
  });

  it('skips leading blank lines to find the synopsis', () => {
    const { headline, body } = splitRationale('\n\nBoundary handling\n- a');
    expect(headline).toBe('Boundary handling');
    expect(body).toBe('- a');
  });

  it('non-conforming bullet-first: keeps the FULL rationale in the body (no content loss)', () => {
    const { headline, body } = splitRationale('- first bullet\n- second bullet');
    expect(headline).toBe('first bullet'); // a usable preview
    // critical: the first bullet is NOT removed from the body
    expect(body).toContain('first bullet');
    expect(body).toContain('second bullet');
  });

  it('empty input yields empty headline and body', () => {
    expect(splitRationale('')).toEqual({ headline: '', body: '' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/HotspotsTab/splitRationale.test.ts`
Expected: FAIL — `Failed to resolve import "./splitRationale"` (module not created yet).

- [ ] **Step 3: Implement `splitRationale`**

```ts
// frontend/src/components/PrDetail/HotspotsTab/splitRationale.ts
import { stripMarkdown } from './stripMarkdown';

// A list-item leader (-, *, +, or "1.") at the start of a line. Used to detect
// the non-conforming case where the model led with a bullet instead of a
// dedicated synopsis line.
const LIST_ITEM_LEADER = /^\s*([-*+]|\d+\.)\s+/;

export interface SplitRationale {
  headline: string;
  body: string;
}

/**
 * Split a synopsis-first rationale into a plain-text headline and a markdown
 * body for the expanded panel (#520, design D2).
 *
 * Conforming case — the first non-empty content line is plain prose (the model
 * led with a synopsis as instructed): headline = that line stripped of markdown,
 * body = everything after it. No duplication.
 *
 * Non-conforming case — the first content line is itself a list item (the model
 * reverted to the pre-#520 bulleted shape) or strips to empty (a fence /
 * thematic break): headline = stripMarkdown(rationale) as a preview, and body =
 * the full rationale from its first content line. The first bullet is NEVER
 * removed, so no detail is lost from the panel (a non-duplicating split is the
 * only thing suppressed).
 */
export function splitRationale(rationale: string): SplitRationale {
  const lines = rationale.split('\n');
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return { headline: '', body: '' };

  const firstLine = lines[firstIdx];
  const firstHeadline = stripMarkdown(firstLine);
  const isListItem = LIST_ITEM_LEADER.test(firstLine);

  if (firstHeadline.length > 0 && !isListItem) {
    // Conforming: a dedicated synopsis line. Body is everything after it.
    const body = lines.slice(firstIdx + 1).join('\n').trim();
    return { headline: firstHeadline, body };
  }

  // Non-conforming: derive a preview headline but keep the full content in body.
  const body = lines.slice(firstIdx).join('\n').trim();
  return { headline: stripMarkdown(rationale), body };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/HotspotsTab/splitRationale.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/HotspotsTab/splitRationale.ts frontend/src/components/PrDetail/HotspotsTab/splitRationale.test.ts
git commit -m "feat(hotspots): splitRationale headline/body helper with bullet-first content-loss guard (#520)"
```

---

### Task 2: `LevelGlyph` signal-bars component

**Files:**
- Create: `frontend/src/components/PrDetail/HotspotsTab/LevelGlyph.tsx`
- Test: `frontend/src/components/PrDetail/HotspotsTab/LevelGlyph.test.tsx`
- Modify: `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.module.css` (add glyph styles)

**Interfaces:**
- Consumes: `FocusLevel` from `frontend/src/api/types.ts` (`'high' | 'medium' | 'low'`).
- Produces: `LevelGlyph({ level: FocusLevel }): JSX.Element` — an `aria-hidden` SVG with `data-level={level}` and CSS classes `glyph`, `barActive`, `barInactive`.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/components/PrDetail/HotspotsTab/LevelGlyph.test.tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LevelGlyph } from './LevelGlyph';

describe('LevelGlyph', () => {
  it('is decorative (aria-hidden) and carries the level as a data attribute', () => {
    const { container } = render(<LevelGlyph level="high" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('data-level', 'high');
  });

  it('encodes level by active-bar count: high=3, medium=2, low=1', () => {
    const active = (level: 'high' | 'medium' | 'low') => {
      const { container } = render(<LevelGlyph level={level} />);
      return container.querySelectorAll('rect[data-active="true"]').length;
    };
    expect(active('high')).toBe(3);
    expect(active('medium')).toBe(2);
    expect(active('low')).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/HotspotsTab/LevelGlyph.test.tsx`
Expected: FAIL — `Failed to resolve import "./LevelGlyph"`.

- [ ] **Step 3: Implement `LevelGlyph`**

```tsx
// frontend/src/components/PrDetail/HotspotsTab/LevelGlyph.tsx
import type { FocusLevel } from '../../../api/types';
import styles from './HotspotsTab.module.css';

// Signal-bars severity glyph (#520, D6): the active-bar COUNT and the hue both
// encode level, so level is never conveyed by color alone (WCAG 1.4.1). Purely
// decorative — the row (and the Low footer copy) provide the accessible text.
const ACTIVE_BARS: Record<FocusLevel, number> = { high: 3, medium: 2, low: 1 };

const BARS = [
  { x: 0, y: 10, h: 6 },
  { x: 7, y: 5, h: 11 },
  { x: 14, y: 0, h: 16 },
];

export function LevelGlyph({ level }: { level: FocusLevel }) {
  const active = ACTIVE_BARS[level];
  return (
    <svg
      className={styles.glyph}
      data-level={level}
      width="16"
      height="14"
      viewBox="0 0 18 16"
      aria-hidden="true"
      focusable="false"
    >
      {BARS.map((bar, i) => {
        const isActive = i < active;
        return (
          <rect
            key={bar.x}
            x={bar.x}
            y={bar.y}
            width="4"
            height={bar.h}
            rx="1"
            data-active={isActive}
            className={isActive ? styles.barActive : styles.barInactive}
          />
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 4: Add glyph styles to the CSS module**

Append to `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.module.css`:

```css
/* Signal-bars level glyph (#520). Active bars take the level hue (via the
   data-level on the svg → currentColor); inactive bars are a faint track. */
.glyph {
  flex: none;
}
.glyph[data-level='high'] {
  color: var(--warning);
}
.glyph[data-level='medium'] {
  color: var(--info);
}
.glyph[data-level='low'] {
  color: var(--text-3);
}
.barActive {
  fill: currentColor;
}
.barInactive {
  fill: var(--border-1);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/HotspotsTab/LevelGlyph.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/HotspotsTab/LevelGlyph.tsx frontend/src/components/PrDetail/HotspotsTab/LevelGlyph.test.tsx frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.module.css
git commit -m "feat(hotspots): LevelGlyph signal-bars severity glyph (#520)"
```

---

### Task 3: Restructure `HotspotsTab` (headline-led rows, single card, Low footer)

**Files:**
- Modify (replace render body): `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.tsx`
- Modify: `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.module.css`
- Modify (rewrite for new structure): `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.test.tsx`
- Verify (should still pass unchanged): `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.integration.test.tsx`

**Interfaces:**
- Consumes: `splitRationale` (Task 1); `LevelGlyph` (Task 2); `usePrDetailContext()` → `{ fileFocus, requestFileView, onSelectSubTab }`; `MarkdownRenderer`; `FileFocus`/`FocusLevel` from `api/types`.
- Produces: the redesigned `HotspotsTab` export (same name, same import site).

- [ ] **Step 1: Rewrite the unit tests for the new structure**

Replace the entire contents of `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.test.tsx` with:

```tsx
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { HotspotsTab } from './HotspotsTab';
import { PrDetailContextProvider } from '../prDetailContext';
import type { FileFocusState } from '../../../hooks/useFileFocusResult';

function renderTab(
  fileFocus: Omit<FileFocusState, 'retry'> & { retry?: () => void },
  overrides: { requestFileView?: () => void; onSelectSubTab?: () => void } = {},
) {
  const requestFileView = overrides.requestFileView ?? vi.fn();
  const onSelectSubTab = overrides.onSelectSubTab ?? vi.fn();
  const value = {
    prRef: { owner: 'o', repo: 'r', number: 1 },
    prDetail: {} as never,
    draftSession: {} as never,
    readOnly: false,
    subscribed: true,
    baseShaChanged: false,
    onSelectSubTab,
    fileFocus: { retry: vi.fn(), ...fileFocus },
    pendingFilePath: null,
    requestFileView,
    clearPendingFilePath: vi.fn(),
  };
  return render(
    <PrDetailContextProvider value={value as never}>
      <HotspotsTab />
    </PrDetailContextProvider>,
  );
}

describe('HotspotsTab', () => {
  it('lists High then Medium in one container, hides Low rows, shows a Low footer', () => {
    renderTab({
      status: 'ok',
      entries: [
        { path: 'm.cs', level: 'medium', rationale: 'Localized change\n- detail' },
        { path: 'h.cs', level: 'high', rationale: 'Core logic\n- detail' },
        { path: 'c.cs', level: 'low', rationale: 'Formatting only' },
      ],
    });
    // Headlines are the synopsis (first line), not the path.
    expect(screen.getByText('Core logic')).toBeInTheDocument();
    expect(screen.getByText('Localized change')).toBeInTheDocument();
    // High comes before Medium in DOM order.
    const headlines = screen.getAllByText(/Core logic|Localized change/);
    expect(headlines[0]).toHaveTextContent('Core logic');
    // Low file is not a row; the footer summarises it.
    expect(screen.queryByText('Formatting only')).not.toBeInTheDocument();
    expect(screen.getByText(/1 low-priority file/i)).toBeInTheDocument();
  });

  it('sorts rows within a level by path ascending (deterministic order)', () => {
    renderTab({
      status: 'ok',
      entries: [
        { path: 'z.cs', level: 'high', rationale: 'Z synopsis\n- d' },
        { path: 'a.cs', level: 'high', rationale: 'A synopsis\n- d' },
      ],
    });
    const toggles = screen.getAllByRole('button', { name: /Toggle .* rationale/i });
    expect(toggles[0]).toHaveAccessibleName(/Toggle a\.cs rationale/i);
    expect(toggles[1]).toHaveAccessibleName(/Toggle z\.cs rationale/i);
  });

  it('expands to render the rationale body as markdown; synopsis is not duplicated', () => {
    renderTab({
      status: 'ok',
      entries: [{ path: 'a.cs', level: 'high', rationale: 'Core logic\n- first\n- second' }],
    });
    const toggle = screen.getByRole('button', { name: /toggle a\.cs rationale/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(within(panel!).getAllByRole('listitem')).toHaveLength(2); // - first / - second
    // synopsis headline is NOT repeated inside the panel
    expect(within(panel!).queryByText('Core logic')).toBeNull();
  });

  it('keyboard Enter on the toggle expands the row', async () => {
    const user = userEvent.setup();
    renderTab({ status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'S\n- b' }] });
    const toggle = screen.getByRole('button', { name: /toggle a\.cs rationale/i });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('the Diff pill calls requestFileView without toggling the row', () => {
    const requestFileView = vi.fn();
    renderTab(
      { status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'S\n- b' }] },
      { requestFileView },
    );
    fireEvent.click(screen.getByRole('button', { name: /open a\.cs in diff/i }));
    expect(requestFileView).toHaveBeenCalledWith('a.cs');
    expect(screen.getByRole('button', { name: /toggle a\.cs rationale/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('a synopsis-only row renders no toggle (not expandable) but still has a Diff pill', () => {
    renderTab({ status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'Just a synopsis' }] });
    expect(screen.queryByRole('button', { name: /toggle a\.cs rationale/i })).not.toBeInTheDocument();
    expect(screen.getByText('Just a synopsis')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open a\.cs in diff/i })).toBeInTheDocument();
  });

  it('a backfill row uses the path as its headline (path stays primary)', () => {
    renderTab({
      status: 'ok',
      entries: [{ path: 'src/Backfilled.cs', level: 'medium', rationale: 'Not individually ranked.' }],
    });
    expect(screen.getByText('src/Backfilled.cs')).toBeInTheDocument();
    expect(screen.queryByText('Not individually ranked.')).not.toBeInTheDocument();
    // not expandable
    expect(
      screen.queryByRole('button', { name: /toggle src\/Backfilled\.cs rationale/i }),
    ).not.toBeInTheDocument();
  });

  it('the Low footer excludes low-by-rule files and switches to the Files tab', () => {
    const onSelectSubTab = vi.fn();
    renderTab(
      {
        status: 'ok',
        entries: [
          { path: 'h.cs', level: 'high', rationale: 'Core\n- d' },
          { path: 'r.cs', level: 'low', rationale: 'No changes to review in this file.' }, // low-by-rule
          { path: 'f.cs', level: 'low', rationale: 'Formatting' }, // model-scored low
        ],
      },
      { onSelectSubTab },
    );
    // count = 1 (only the model-scored low; low-by-rule excluded)
    const footer = screen.getByRole('button', { name: /1 low-priority file/i });
    fireEvent.click(footer);
    expect(onSelectSubTab).toHaveBeenCalledWith('files');
  });

  it('expanded panel renders no live <script> and no javascript: link (XSS)', () => {
    renderTab({
      status: 'ok',
      entries: [
        {
          path: 'a.cs',
          level: 'high',
          rationale: 'Synopsis\n<script>alert(1)</script>\n\n[click](javascript:alert(1))',
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /toggle a\.cs rationale/i }));
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a[href*="javascript:"]')).toBeNull();
  });

  it('loading shows skeleton', () => {
    renderTab({ status: 'loading', entries: [] });
    expect(screen.getByTestId('hotspots-skeleton')).toBeInTheDocument();
  });

  it('empty (all-low) shows the positive message, no card, no footer, no retry', () => {
    renderTab({ status: 'empty', entries: [] });
    expect(screen.getByText(/nothing needs special attention/i)).toBeInTheDocument();
    expect(screen.queryByText(/low-priority file/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('all entries Low shows the positive message (no rows, no footer)', () => {
    renderTab({
      status: 'ok',
      entries: [{ path: 'c.cs', level: 'low', rationale: 'Formatting' }],
    });
    expect(screen.getByText(/nothing needs special attention/i)).toBeInTheDocument();
    expect(screen.queryByText(/low-priority file/i)).not.toBeInTheDocument();
  });

  it('no-changes shows the distinct empty-diff message', () => {
    renderTab({ status: 'no-changes', entries: [] });
    expect(screen.getByText(/no file changes to review/i)).toBeInTheDocument();
  });

  it('not-subscribed shows its own copy', () => {
    renderTab({ status: 'not-subscribed', entries: [] });
    expect(screen.getByText(/isn’t active for this pr/i)).toBeInTheDocument();
  });

  it('error shows a distinct message + a Retry button that calls retry', () => {
    const retry = vi.fn();
    renderTab({ status: 'error', entries: [], retry });
    expect(screen.getByText(/couldn’t load ai focus/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('fallback shows the single dedicated state, never rows, no retry', () => {
    renderTab({
      status: 'fallback',
      entries: [{ path: 'a.cs', level: 'medium', rationale: 'x' }],
    });
    expect(screen.getByText(/couldn’t rank this pr automatically/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /toggle a\.cs rationale/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/HotspotsTab/HotspotsTab.test.tsx`
Expected: FAIL — the shipped component still renders headings/dots and has no Low footer, so the new assertions (synopsis headlines, Low footer, synopsis-only no-toggle, backfill path headline) fail.

- [ ] **Step 3: Replace `HotspotsTab.tsx` with the redesigned component**

Replace the entire contents of `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.tsx` with:

```tsx
import { useState } from 'react';
import { usePrDetailContext } from '../prDetailContext';
import type { FileFocus } from '../../../api/types';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { splitRationale } from './splitRationale';
import { LevelGlyph } from './LevelGlyph';
import styles from './HotspotsTab.module.css';

// Collapses every non-alphanumeric run in a path to '-' so it is safe inside an
// id attribute. Module-scope so it compiles once, not per row per render.
const PANEL_ID_UNSAFE_CHARS = /[^a-z0-9]/gi;

// Rationale strings the parser assigns BY RULE (not model-authored). Kept in
// sync with the backend: FileFocusParser.BackfillRationale and the ranker's
// LowByRuleRationale. Used to (a) keep the path primary on backfilled rows and
// (b) exclude low-by-rule files from the Low count (#520 D7/D9). These are
// string-keyed: if either backend constant changes, update these too — a
// divergence silently regresses the count/headline (no type error to catch it).
const BACKFILL_RATIONALE = 'Not individually ranked.';
const LOW_BY_RULE_RATIONALE = 'No changes to review in this file.';

const byPath = (a: FileFocus, b: FileFocus) => a.path.localeCompare(b.path);

// The triage surface (#520): one container, severity-sorted High→Medium, each
// row identified by its signal-bars glyph and a synopsis headline derived from
// the rationale's first line. The expanded panel renders the rationale body as
// markdown via the shared MarkdownRenderer (never dangerouslySetInnerHTML). A
// "Diff" pill deep-links to the file via requestFileView. Low files are not
// listed — a muted footer counts them and hops to the Files tab.
export function HotspotsTab() {
  const { fileFocus, requestFileView, onSelectSubTab } = usePrDetailContext();
  const { status, entries, retry } = fileFocus;
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (status === 'loading') {
    return (
      <div className={styles.hotspots} data-testid="hotspots-skeleton">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    );
  }
  if (status === 'fallback') {
    return <div className={styles.message}>Couldn’t rank this PR automatically.</div>;
  }
  if (status === 'error') {
    return (
      <div className={styles.messageError}>
        <span>Couldn’t load AI focus right now.</span>{' '}
        <button type="button" className={styles.retryButton} onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  if (status === 'not-subscribed') {
    return <div className={styles.message}>AI file focus isn’t active for this PR.</div>;
  }
  if (status === 'no-changes') {
    return <div className={styles.message}>No file changes to review.</div>;
  }

  const high = entries.filter((e) => e.level === 'high').sort(byPath);
  const medium = entries.filter((e) => e.level === 'medium').sort(byPath);
  // Exclude low-by-rule (empty-body renames/deletes) — they have no changed body
  // to skim, so they would inflate and mis-frame the count (#520 D7).
  const lowCount = entries.filter(
    (e) => e.level === 'low' && e.rationale !== LOW_BY_RULE_RATIONALE,
  ).length;

  if (status === 'empty' || (high.length === 0 && medium.length === 0)) {
    return (
      <div className={styles.messagePositive}>
        Nothing needs special attention — the AI didn't flag any file. Skim freely.
      </div>
    );
  }

  return (
    <div className={styles.hotspots}>
      <div className={styles.card}>
        {high.length > 0 && (
          <ul className={styles.rows} role="list">
            {high.map((r) => (
              <Row
                key={r.path}
                entry={r}
                isOpen={openPaths.has(r.path)}
                onToggle={toggle}
                onOpen={requestFileView}
              />
            ))}
          </ul>
        )}
        {medium.length > 0 && (
          <ul className={styles.rows} role="list">
            {medium.map((r) => (
              <Row
                key={r.path}
                entry={r}
                isOpen={openPaths.has(r.path)}
                onToggle={toggle}
                onOpen={requestFileView}
              />
            ))}
          </ul>
        )}
        {lowCount > 0 && (
          <button
            type="button"
            className={styles.lowFooter}
            aria-label={`${lowCount} low-priority ${lowCount === 1 ? 'file' : 'files'} — switch to the Files tab`}
            onClick={() => onSelectSubTab('files')}
          >
            <LevelGlyph level="low" />
            <span>
              {lowCount} low-priority {lowCount === 1 ? 'file' : 'files'} — skim them in the Files
              tab.
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function Row({
  entry,
  isOpen,
  onToggle,
  onOpen,
}: {
  entry: FileFocus;
  isOpen: boolean;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const isBackfill = entry.rationale === BACKFILL_RATIONALE;
  const { headline, body } = splitRationale(entry.rationale);
  // Backfill rows carry a boilerplate sentence — keep the path as the headline
  // so the real identifier stays primary (#520 D9). They are never expandable.
  const expandable = !isBackfill && body.length > 0;
  // Path-stable id (survives reorder/filter so aria-controls never mis-wires);
  // the parser's last-wins dedup guarantees a path appears at exactly one level.
  const panelId = `hotspot-panel-${entry.path.replace(PANEL_ID_UNSAFE_CHARS, '-')}`;

  const lead = (
    <>
      <LevelGlyph level={entry.level} />
      <span className="sr-only">{`AI focus: ${entry.level}`}</span>
      <span className={styles.stack}>
        {isBackfill ? (
          <span className={styles.headlinePath} title={entry.path}>
            {entry.path}
          </span>
        ) : (
          <>
            <span className={styles.headline}>{headline || entry.path}</span>
            <span className={styles.path} title={entry.path}>
              {entry.path}
            </span>
          </>
        )}
      </span>
    </>
  );

  return (
    <li className={styles.item}>
      <div className={styles.itemHeader}>
        {expandable ? (
          <button
            type="button"
            className={styles.rowToggle}
            aria-label={`Toggle ${entry.path} rationale`}
            aria-expanded={isOpen}
            aria-controls={panelId}
            onClick={() => onToggle(entry.path)}
          >
            {lead}
            <Chevron isOpen={isOpen} />
          </button>
        ) : (
          <div className={styles.rowStatic}>{lead}</div>
        )}
        <button
          type="button"
          className={styles.diffPill}
          aria-label={`Open ${entry.path} in diff`}
          onClick={() => onOpen(entry.path)}
        >
          <CodeIcon />
          Diff
        </button>
      </div>
      {expandable && isOpen && (
        <div id={panelId} className={styles.panel}>
          <MarkdownRenderer source={body} className="ai-markdown" />
        </div>
      )}
    </li>
  );
}

function Chevron({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      className={styles.chevron}
      data-open={isOpen}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
```

- [ ] **Step 4: Replace the row/group/dot styles in the CSS module**

In `frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.module.css`, **remove** the now-unused rules (all present in the current module — verified): `.group`, `.groupHeading`, `.dot`, `.dotMed`, `.dotHigh`, and the old `.rowPath` / `.rowPreview` / `.openInDiff` rules. **Keep** `.hotspots`, `.skeletonRow`, `@keyframes pulse`, `.message`, `.messagePositive`, `.messageError`, `.retryButton`, and the glyph rules added in Task 2. **Add** these rules:

```css
/* One outer container; the flex gap (--s-4) is the whitespace divider between
   the High block, the Medium block, and the Low footer (#520 D5). */
.card {
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  padding: var(--s-3);
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.item {
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
}
.itemHeader {
  display: flex;
  align-items: center;
}
.rowToggle,
.rowStatic {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: var(--s-2) var(--s-3);
}
.rowToggle {
  background: none;
  border: none;
  cursor: pointer;
}
.rowToggle:hover {
  background: var(--surface-3);
  border-top-left-radius: var(--radius-2);
}
/* Collapsed → round the bottom-left corner on hover too (no panel below). */
.rowToggle[aria-expanded='false']:hover {
  border-bottom-left-radius: var(--radius-2);
}
.rowToggle:focus-visible,
.diffPill:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
/* Headline: bold, clamped to two lines (#520 D11). A conforming ≤8-word
   synopsis fits one line; a non-conforming long line caps at two. */
.headline {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-1);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.path,
.headlinePath {
  font-family: var(--font-mono);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path {
  font-size: var(--text-xs);
}
/* Backfill rows: the path IS the headline, so it gets the primary text size. */
.headlinePath {
  font-size: var(--text-sm);
  color: var(--text-1);
}
.chevron {
  flex: none;
  color: var(--text-3);
  transition: transform 0.15s ease;
}
.chevron[data-open='true'] {
  transform: rotate(180deg);
}
/* Jump-to-code pill: a labelled, always-visible control at the row's trailing
   edge, visually + semantically distinct from the expand toggle (#520 D8). */
.diffPill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
  margin-right: var(--s-2);
  padding: var(--s-1) var(--s-2);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--accent);
  background: none;
  border: 1px solid var(--accent-ring);
  border-radius: var(--radius-1);
  cursor: pointer;
}
.diffPill:hover {
  background: var(--accent-soft);
}
.panel {
  padding: 0 var(--s-3) var(--s-3);
}
/* Low count-footer: muted, sits below the rows, hops to the Files tab (#520 D7). */
.lowFooter {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-1) var(--s-2);
  background: none;
  border: none;
  font-size: var(--text-xs);
  color: var(--text-3);
  text-align: left;
  cursor: pointer;
}
.lowFooter:hover {
  color: var(--text-2);
}
.lowFooter:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-radius: var(--radius-1);
}
```

- [ ] **Step 5: Run the HotspotsTab unit + integration tests to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/PrDetail/HotspotsTab/`
Expected: PASS — `splitRationale`, `LevelGlyph`, `stripMarkdown`, `HotspotsTab` (new assertions), and `HotspotsTab.integration` (the Diff-pill flow is unchanged: single-line rationales there still render the pill).

- [ ] **Step 6: Typecheck + lint the changed frontend files**

Run: `cd frontend && node_modules/.bin/tsc -b && node_modules/.bin/eslint src/components/PrDetail/HotspotsTab`
Expected: no errors. (If `--font-mono` is not a defined token, fall back to the existing mono usage in the shipped module — it referenced `var(--font-mono)`, so it is defined.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.tsx frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.module.css frontend/src/components/PrDetail/HotspotsTab/HotspotsTab.test.tsx
git commit -m "feat(hotspots): headline-led rows, single card, signal-bars glyph, Diff pill, Low footer (#520)"
```

---

### Task 4: Backend — synopsis-first prompt, DTO comment, sample data

**Files:**
- Modify: `PRism.Web/Ai/ClaudeCodeFileFocusRanker.cs` (the `rationale` clause in `SystemPromptV1`)
- Modify: `PRism.AI.Contracts/Dtos/FileFocus.cs` (the `Rationale` doc comment)
- Modify: `PRism.AI.Placeholder/PlaceholderData.cs` (the two sample `FileFocus` rationales)

**Interfaces:**
- Consumes/Produces: none in code — these are copy/comment/sample changes. The `FileFocus` record shape and `FileFocusParser` are unchanged, so all existing backend tests stand.

- [ ] **Step 1: Reshape the `rationale` instruction in `SystemPromptV1`**

In `PRism.Web/Ai/ClaudeCodeFileFocusRanker.cs`, the `rationale` instruction is **two concatenated string literals** inside `SystemPromptV1` (currently lines 53-54):

```csharp
        "rationale = concise bulleted markdown explaining WHY this file needs review — the specific risk or change — " +
        "so the reviewer has real context (not just a label); keep it scannable and short, not a long paragraph. " +
```

Replace **both** of those literals (a verbatim search for a single line will not match) with:

```csharp
        "rationale = a SHORT synopsis on the first line (a headline of at most ~8 words, no bullet, " +
        "no markdown heading) that names what/why this file is a hotspot; then one or more concise " +
        "bullets explaining the specific risk or change. The first line is shown as the hotspot's title " +
        "and the bullets as its detail, so the first line must read as a title, not a sentence fragment. " +
```

Leave every other clause of `SystemPromptV1` (selectivity, the ≤10 high/medium cap, the `<file_block>` untrusted-data framing) and `RetryReminder` unchanged.

- [ ] **Step 2: Correct the stale `FileFocus.Rationale` doc comment**

In `PRism.AI.Contracts/Dtos/FileFocus.cs`, replace the `<summary>` on the `FileFocus` record:

```csharp
/// <summary>One ranked changed file. <paramref name="Rationale"/> is multi-line markdown: the first line
/// is a short headline (≤ ~8 words), followed by a newline-separated bulleted explanation. The first line
/// is rendered as a plain-text headline; the remainder renders as markdown in the Hotspots expanded panel.
/// LLM free text — already bidi/control-char sanitized by FileFocusParser; rendered via MarkdownRenderer
/// (no raw HTML).</summary>
public sealed record FileFocus(string Path, FocusLevel Level, string Rationale);
```

- [ ] **Step 3: Update the sample data to the synopsis-first shape**

In `PRism.AI.Placeholder/PlaceholderData.cs`, replace the two `FileFocus` entries:

```csharp
    public static IReadOnlyList<FileFocus> FileFocus { get; } = new[]
    {
        new FileFocus("src/Calc.cs", FocusLevel.High,
            "Boundary handling in core calc\n- Review the new clamp on the upper bound for off-by-one risk.\n- Confirm negative inputs still throw rather than silently saturating."),
        new FileFocus("src/Calc.Tests.cs", FocusLevel.Medium,
            "Tests for the changed boundary logic\n- Verify the new upper-bound and negative-input cases are actually asserted, not just exercised."),
    };
```

- [ ] **Step 4: Build the backend and run the AI tests to confirm nothing broke**

Run: `dotnet build PRism.sln` then `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~Ai"`
Expected: build succeeds; `FileFocusParserTests` and ranker tests pass unchanged (the parser is shape-agnostic; no contract change). Use a timeout ≥ 300000ms.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Ai/ClaudeCodeFileFocusRanker.cs PRism.AI.Contracts/Dtos/FileFocus.cs PRism.AI.Placeholder/PlaceholderData.cs
git commit -m "feat(hotspots): synopsis-first ranker prompt + correct stale FileFocus rationale doc comment (#520)"
```

---

### Task 5: e2e update + full verification gate

**Files:**
- Modify: `frontend/e2e/hotspots.spec.ts` (fixture rationales → synopsis-first so rows are expandable)

**Interfaces:**
- Consumes: the redesigned `HotspotsTab` (Tasks 1-3). The e2e's `togglePattern` (`Toggle {path} rationale`) and `openInDiffPattern` (`Open {path} in diff`) accessible names are preserved by the new component, so the flow is intact; only the fixture rationales need bodies so the toggle exists.

- [ ] **Step 1: Give the e2e fixtures synopsis-first rationales**

In `frontend/e2e/hotspots.spec.ts`, replace the `fileFocusResult` constant so the High/Medium rationales have a synopsis line + a bullet (making the rows expandable; the toggle button only renders when a body exists):

```ts
const fileFocusResult = {
  entries: [
    {
      path: HIGH_FILE,
      level: 'high',
      rationale: 'Core billing math changed\n- Verify rounding on the new tax path.',
    },
    {
      path: MEDIUM_FILE,
      level: 'medium',
      rationale: 'Touches a shared helper\n- Confirm no other caller depends on the old signature.',
    },
    { path: OTHER_FILE, level: 'low', rationale: 'Whitespace-only.' },
  ],
  fallback: false,
};
```

The rest of the spec is unchanged: it already matches rows by `togglePattern`/`openInDiffPattern`, asserts the Low file (`OTHER_FILE`) has no toggle (`toHaveCount(0)`), clicks the High file's "Open … in diff" pill, and asserts the Files tab activates and the file's tree row is selected. Those assertions still hold.

- [ ] **Step 2: Run the e2e spec**

Run: `cd frontend && node_modules/.bin/playwright test e2e/hotspots.spec.ts`
Expected: PASS. (If Playwright browsers are not installed in this worktree, run `node_modules/.bin/playwright install chromium` first.)

- [ ] **Step 3: Run the full frontend + backend gates**

Run, one at a time (timeout ≥ 300000ms each):
- `cd frontend && node_modules/.bin/vitest run` — all unit tests green.
- `cd frontend && node_modules/.bin/tsc -b && node_modules/.bin/eslint . && node_modules/.bin/prettier --check .` — typecheck/lint/format clean (whole-dir prettier, matching CI).
- `dotnet build PRism.sln && dotnet test` — backend green.

Expected: all green. Fix any failures before committing.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/hotspots.spec.ts
git commit -m "test(hotspots): synopsis-first e2e fixtures for expandable rows (#520)"
```

- [ ] **Step 5: Owner live-validation note (acceptance check, not automated)**

Per the spec's Acceptance section, before the PR the owner runs the new prompt against the live sample PR(s) in Live mode and confirms the first line of real High/Medium rationales reads as a *title* (short, no leading bullet). Record the observed output (and the non-conforming fallback rendering, if hit) in the PR's Proof section. This is a manual B1 step — there is no server-side guarantee the first line is a synopsis.

---

## Self-Review

**1. Spec coverage:**
- D1 (derived headline) → Task 1 `splitRationale`; consumed in Task 3.
- D2 (synopsis-first split, bullet-first no-loss) → Task 1 (helper + the bullet-first test) and Task 4 (prompt).
- D3 (headline-led layout, path beneath) → Task 3 component + CSS (`.headline`/`.path`).
- D4 (single card, no headings, deterministic intra-level sort) → Task 3 (`byPath` sort + single `.card` + the sort test).
- D5 (whitespace divider) → Task 3 CSS (`.card` flex `gap: var(--s-4)`).
- D6 (signal-bars glyph, token hues, shape+hue) → Task 2 (`LevelGlyph` + glyph CSS using `--warning`/`--info`/`--text-3`).
- D7 (Low count-footer, excludes low-by-rule, reuses `onSelectSubTab`) → Task 3 (`lowCount` filter + footer + the footer test).
- D8 (Diff pill) → Task 3 (`.diffPill` + the pill test, preserving the `Open {path} in diff` name).
- D9 (synopsis-only non-expandable, backfill uses path headline) → Task 3 (`expandable`/`isBackfill` + the two tests).
- D10 (expand state keyed by path) → Task 3 (`openPaths: Set<string>`).
- D11 (two-line headline clamp) → Task 3 CSS (`.headline` `-webkit-line-clamp: 2`).
- DTO comment fix → Task 4 Step 2. Sample data → Task 4 Step 3. Prompt → Task 4 Step 1.
- Testing section (splitRationale bullet-first, intra-level order, synopsis-only High, Low excludes low-by-rule, a11y, preserved states) → Tasks 1 & 3 tests. e2e → Task 5.
- Acceptance (headline-quality live check) → Task 5 Step 5.

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N"/uncoded steps — every code step has complete code; every command has an expected result.

**3. Type consistency:** `splitRationale(rationale: string): { headline: string; body: string }` is defined in Task 1 and consumed with that exact shape in Task 3. `LevelGlyph({ level: FocusLevel })` defined in Task 2, used in Task 3 with `level={entry.level}` and `level="low"`. The two by-rule constants (`BACKFILL_RATIONALE`, `LOW_BY_RULE_RATIONALE`) mirror the backend strings (`FileFocusParser.BackfillRationale` = "Not individually ranked."; ranker `LowByRuleRationale` = "No changes to review in this file.") — verified against the current backend source. Accessible names `Toggle {path} rationale` / `Open {path} in diff` match the e2e and integration tests.
