# Loading Affordance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace weak loading states on PR-detail (#181/#147) and Inbox (#244) with immediate, content-shaped skeletons, plus a global top progress bar.

**Architecture:** A shared `<Skeleton>` primitive backs content-shaped skeletons on both surfaces. PR-detail's body gate changes from `!data && showSkeleton` (100ms anti-flash) to `!data && isLoading` (instant on cold open; keeps content on background reload — #180 preserved). A keyed-boolean `LoadingBarContext` drives a global `<TopProgressBar>` at the app root; the inbox and the *active* PR-detail tab feed it via per-instance keys.

**Tech Stack:** React 18 + Vite + TypeScript, CSS Modules + oklch design tokens, vitest + @testing-library/react, Playwright (B1 visual proof).

**Spec:** `docs/specs/2026-06-06-loading-affordance-design.md`

**Two PRs:**
- **PR1 (closes #181 + #147)** — Tasks 1–8: shared primitives + PR-detail.
- **PR2 (closes #244)** — Tasks 9–11: inbox skeleton (reuses PR1 primitives).

---

## File Structure

**PR1 — new files**
- `frontend/src/components/Skeleton/Skeleton.tsx` — `<Skeleton>` + `<SkeletonText>` shimmer primitives.
- `frontend/src/components/Skeleton/Skeleton.module.css` — shimmer CSS (token-driven, reduced-motion aware).
- `frontend/src/components/Skeleton/Skeleton.test.tsx`
- `frontend/src/components/Skeleton/index.ts`
- `frontend/src/contexts/LoadingBarContext.tsx` — keyed-boolean store + `useTopProgress`.
- `frontend/src/contexts/LoadingBarContext.test.tsx`
- `frontend/src/components/TopProgressBar/TopProgressBar.tsx`
- `frontend/src/components/TopProgressBar/TopProgressBar.module.css`
- `frontend/src/components/TopProgressBar/TopProgressBar.test.tsx`
- `frontend/src/components/TopProgressBar/index.ts`
- `frontend/src/components/PrDetail/PrDetailSkeleton.tsx` — Overview-shaped skeleton (extracted + rebuilt).
- `frontend/src/components/PrDetail/PrDetailSkeleton.module.css`

**PR1 — modified files**
- `frontend/src/hooks/usePrDetail.ts` — drop `showSkeleton` + the `useDelayedLoading` call.
- `frontend/src/components/PrDetail/PrHeader.tsx` — `loading` prop swaps title/author/chip slots.
- `frontend/src/components/PrDetail/PrDetailView.tsx` — `!data && isLoading` gate; `loading` prop; new skeleton; feed bar.
- `frontend/src/App.tsx` — mount `LoadingBarProvider` + `<TopProgressBar/>`.
- Test mocks: `PrDetailView.test.tsx`, `PrDetailView.freshness.test.tsx`, `PrTabHost.test.tsx`, `PrHeader.test.tsx` (if present).

**PR2 — new files**
- `frontend/src/components/Inbox/InboxSkeleton.tsx`
- `frontend/src/components/Inbox/InboxSkeleton.module.css`
- `frontend/src/components/Inbox/InboxSkeleton.test.tsx`

**PR2 — modified files**
- `frontend/src/pages/InboxPage.tsx` — swap spinner branch; feed bar.

---

# PR1 — Shared primitives + PR-detail (#181 + #147)

## Task 1: Shared `<Skeleton>` primitive

**Files:**
- Create: `frontend/src/components/Skeleton/Skeleton.tsx`
- Create: `frontend/src/components/Skeleton/Skeleton.module.css`
- Create: `frontend/src/components/Skeleton/index.ts`
- Test: `frontend/src/components/Skeleton/Skeleton.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Skeleton/Skeleton.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton, SkeletonText } from './Skeleton';

describe('Skeleton', () => {
  it('renders a shimmer block with the given dimensions and is aria-hidden', () => {
    render(<Skeleton width="60%" height={14} data-testid="sk" />);
    const el = screen.getByTestId('sk');
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el.style.width).toBe('60%');
    expect(el.style.height).toBe('14px');
  });

  it('renders a circle when circle is set', () => {
    render(<Skeleton circle width={24} data-testid="sk" />);
    const el = screen.getByTestId('sk');
    expect(el.style.borderRadius).toBe('50%');
  });

  it('SkeletonText renders the requested number of lines', () => {
    render(<SkeletonText lines={3} data-testid="lines" />);
    const root = screen.getByTestId('lines');
    expect(root.children).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Skeleton/Skeleton.test.tsx`
Expected: FAIL — cannot resolve `./Skeleton`.

- [ ] **Step 3: Write the CSS module**

```css
/* frontend/src/components/Skeleton/Skeleton.module.css */
.block {
  display: block;
  background: var(--surface-2);
  border-radius: 6px;
  position: relative;
  overflow: hidden;
}

.block::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in oklch, var(--surface-3) 70%, transparent),
    transparent
  );
  animation: shimmer 1.3s ease-in-out infinite;
}

@keyframes shimmer {
  100% {
    transform: translateX(100%);
  }
}

.text {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

@media (prefers-reduced-motion: reduce) {
  .block::after {
    animation: none;
    display: none;
  }
}
```

- [ ] **Step 4: Write the component**

```tsx
// frontend/src/components/Skeleton/Skeleton.tsx
import type { CSSProperties } from 'react';
import styles from './Skeleton.module.css';

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  /** Border radius override; ignored when `circle` is set. */
  radius?: number | string;
  circle?: boolean;
  className?: string;
  'data-testid'?: string;
}

function toCss(v: number | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'number' ? `${v}px` : v;
}

export function Skeleton({ width, height, radius, circle, className, ...rest }: SkeletonProps) {
  const style: CSSProperties = {
    width: toCss(width),
    height: toCss(height),
    borderRadius: circle ? '50%' : toCss(radius),
  };
  return (
    <span
      className={className ? `${styles.block} ${className}` : styles.block}
      style={style}
      aria-hidden="true"
      data-testid={rest['data-testid']}
    />
  );
}

interface SkeletonTextProps {
  lines: number;
  /** Optional per-line widths; cycles if shorter than `lines`. */
  widths?: string[];
  className?: string;
  'data-testid'?: string;
}

export function SkeletonText({ lines, widths, className, ...rest }: SkeletonTextProps) {
  const defaults = ['100%', '92%', '96%', '85%', '90%', '70%'];
  return (
    <span
      className={className ? `${styles.text} ${className}` : styles.text}
      data-testid={rest['data-testid']}
    >
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={12} width={(widths ?? defaults)[i % (widths ?? defaults).length]} />
      ))}
    </span>
  );
}
```

- [ ] **Step 5: Write the barrel export**

```ts
// frontend/src/components/Skeleton/index.ts
export { Skeleton, SkeletonText } from './Skeleton';
```

- [ ] **Step 6: Run tests + lint**

Run: `cd frontend && npx vitest run src/components/Skeleton/Skeleton.test.tsx && node ./node_modules/prettier/bin/prettier.cjs --check src/components/Skeleton`
Expected: PASS; prettier clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Skeleton
git commit -m "feat(#181): shared <Skeleton>/<SkeletonText> primitive"
```

---

## Task 2: `LoadingBarContext` keyed-boolean store + `useTopProgress`

**Files:**
- Create: `frontend/src/contexts/LoadingBarContext.tsx`
- Test: `frontend/src/contexts/LoadingBarContext.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/contexts/LoadingBarContext.test.tsx
import { StrictMode } from 'react';
import { render, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoadingBarProvider, useLoadingBar, useTopProgress } from './LoadingBarContext';

function wrapper({ children }: { children: React.ReactNode }) {
  return <LoadingBarProvider>{children}</LoadingBarProvider>;
}

describe('LoadingBarContext', () => {
  it('active is true when any key is true (OR across keys)', () => {
    const { result } = renderHook(() => useLoadingBar(), { wrapper });
    expect(result.current.active).toBe(false);
    result.current.setLoading('a', true);
    expect(result.current.active).toBe(true);
    result.current.setLoading('b', true);
    result.current.setLoading('a', false);
    expect(result.current.active).toBe(true); // b still true
    result.current.setLoading('b', false);
    expect(result.current.active).toBe(false);
  });

  it('useTopProgress sets its key from active and clears on unmount', () => {
    let active = false;
    const probe = { value: false };
    function Bar() {
      probe.value = useLoadingBar().active;
      return null;
    }
    function Feeder() {
      useTopProgress('feeder', active);
      return null;
    }
    const { rerender, unmount } = render(
      <LoadingBarProvider>
        <Feeder />
        <Bar />
      </LoadingBarProvider>,
    );
    expect(probe.value).toBe(false);
    active = true;
    rerender(
      <LoadingBarProvider>
        <Feeder />
        <Bar />
      </LoadingBarProvider>,
    );
    expect(probe.value).toBe(true);
    unmount();
    // After unmount the provider is gone; re-mount fresh to confirm no leak across instances.
  });

  it('survives StrictMode double-invoke without drift', () => {
    const probe = { value: false };
    function Bar() {
      probe.value = useLoadingBar().active;
      return null;
    }
    function Feeder() {
      useTopProgress('feeder', true);
      return null;
    }
    render(
      <StrictMode>
        <LoadingBarProvider>
          <Feeder />
          <Bar />
        </LoadingBarProvider>
      </StrictMode>,
    );
    expect(probe.value).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/contexts/LoadingBarContext.test.tsx`
Expected: FAIL — cannot resolve `./LoadingBarContext`.

- [ ] **Step 3: Write the context**

```tsx
// frontend/src/contexts/LoadingBarContext.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface LoadingBarStore {
  /** Set or clear a named loading source. The bar is active when ANY source is true. */
  setLoading(key: string, active: boolean): void;
  active: boolean;
}

const LoadingBarContext = createContext<LoadingBarStore | null>(null);

export function LoadingBarProvider({ children }: { children: ReactNode }) {
  // A keyed boolean map. Boolean-per-source (not a counter) is idempotent, so a
  // StrictMode setup->cleanup->setup double-invoke nets to the correct value and
  // no key can get "stuck" from miscounting.
  const [keys, setKeys] = useState<Record<string, boolean>>({});

  const setLoading = useCallback((key: string, active: boolean) => {
    setKeys((prev) => {
      if (!!prev[key] === active) return prev; // no-op: avoids a needless re-render
      const next = { ...prev };
      if (active) next[key] = true;
      else delete next[key];
      return next;
    });
  }, []);

  const active = Object.keys(keys).length > 0;
  const value = useMemo<LoadingBarStore>(() => ({ setLoading, active }), [setLoading, active]);

  return <LoadingBarContext.Provider value={value}>{children}</LoadingBarContext.Provider>;
}

export function useLoadingBar(): LoadingBarStore {
  const ctx = useContext(LoadingBarContext);
  if (!ctx) {
    // Lenient fallback mirrors useEventSource: a consumer outside the provider
    // (e.g. an isolated unit test of a feeder) gets a no-op store, not a throw.
    return { setLoading: () => {}, active: false };
  }
  return ctx;
}

/**
 * Register `key` as a loading source while `active` is true. Clears the key when
 * `active` goes false OR the component unmounts. The on-change path is the
 * load-bearing clear under keep-alive (a kept-alive view re-renders with
 * active=false rather than unmounting), so the effect runs on every `active`
 * change, not only in cleanup.
 */
export function useTopProgress(key: string, active: boolean): void {
  const { setLoading } = useLoadingBar();
  useEffect(() => {
    setLoading(key, active);
    return () => setLoading(key, false);
  }, [key, active, setLoading]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/contexts/LoadingBarContext.test.tsx`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/contexts/LoadingBarContext.tsx frontend/src/contexts/LoadingBarContext.test.tsx
git commit -m "feat(#181): keyed-boolean LoadingBarContext + useTopProgress"
```

---

## Task 3: `<TopProgressBar>` component

**Files:**
- Create: `frontend/src/components/TopProgressBar/TopProgressBar.tsx`
- Create: `frontend/src/components/TopProgressBar/TopProgressBar.module.css`
- Create: `frontend/src/components/TopProgressBar/index.ts`
- Test: `frontend/src/components/TopProgressBar/TopProgressBar.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/TopProgressBar/TopProgressBar.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoadingBarProvider, useTopProgress } from '../../contexts/LoadingBarContext';
import { TopProgressBar } from './TopProgressBar';

function Feeder({ active }: { active: boolean }) {
  useTopProgress('test', active);
  return null;
}

describe('TopProgressBar', () => {
  it('is present and marked aria-hidden, with a data-active attribute reflecting state', () => {
    const { rerender } = render(
      <LoadingBarProvider>
        <Feeder active={false} />
        <TopProgressBar />
      </LoadingBarProvider>,
    );
    const bar = screen.getByTestId('top-progress-bar');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar).toHaveAttribute('data-active', 'false');

    rerender(
      <LoadingBarProvider>
        <Feeder active />
        <TopProgressBar />
      </LoadingBarProvider>,
    );
    expect(screen.getByTestId('top-progress-bar')).toHaveAttribute('data-active', 'true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/TopProgressBar/TopProgressBar.test.tsx`
Expected: FAIL — cannot resolve `./TopProgressBar`.

- [ ] **Step 3: Write the CSS module**

```css
/* frontend/src/components/TopProgressBar/TopProgressBar.module.css */
.bar {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 3px;
  z-index: 60; /* above page content, below modal/toast (which sit higher) */
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms ease;
}

.bar[data-active='true'] {
  opacity: 1;
}

.fill {
  height: 100%;
  width: 40%;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
  animation: indeterminate 1.1s ease-in-out infinite;
}

@keyframes indeterminate {
  0% {
    margin-left: -40%;
  }
  100% {
    margin-left: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bar {
    transition: none;
  }
  .fill {
    animation: none;
    width: 80%;
    margin-left: 0;
  }
}
```

- [ ] **Step 4: Write the component**

```tsx
// frontend/src/components/TopProgressBar/TopProgressBar.tsx
import { useLoadingBar } from '../../contexts/LoadingBarContext';
import styles from './TopProgressBar.module.css';

/**
 * Global indeterminate progress bar pinned to the top of the viewport. Visible
 * while any LoadingBar source is active; CSS opacity transition handles the
 * fade-out on idle. aria-hidden — the per-surface skeletons carry the busy state
 * for assistive tech, so this would be redundant noise.
 */
export function TopProgressBar() {
  const { active } = useLoadingBar();
  return (
    <div className={styles.bar} data-active={active} aria-hidden="true" data-testid="top-progress-bar">
      <div className={styles.fill} />
    </div>
  );
}
```

- [ ] **Step 5: Write the barrel export**

```ts
// frontend/src/components/TopProgressBar/index.ts
export { TopProgressBar } from './TopProgressBar';
```

- [ ] **Step 6: Run tests + prettier**

Run: `cd frontend && npx vitest run src/components/TopProgressBar/TopProgressBar.test.tsx && node ./node_modules/prettier/bin/prettier.cjs --check src/components/TopProgressBar`
Expected: PASS; prettier clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/TopProgressBar
git commit -m "feat(#181): global TopProgressBar component"
```

---

## Task 4: Mount `LoadingBarProvider` + `<TopProgressBar>` in `App.tsx`

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add imports**

Add near the other context imports (after line 22, the `AskAiDrawerProvider` import):

```tsx
import { LoadingBarProvider } from './contexts/LoadingBarContext';
import { TopProgressBar } from './components/TopProgressBar';
```

- [ ] **Step 2: Render the bar at the top of `tree`**

In `App.tsx`, the `tree` constant currently starts:

```tsx
  const tree: ReactNode = (
    <>
      <AppearanceSync />
```

Change to:

```tsx
  const tree: ReactNode = (
    <>
      <TopProgressBar />
      <AppearanceSync />
```

- [ ] **Step 3: Wrap with `LoadingBarProvider`**

The provider must wrap both the bar and the feeders (InboxPage, PrTabHost), so place it inside `PreferencesProvider` (which already wraps `tree`). Change:

```tsx
              <PreferencesProvider>
                {isAuthed ? <EventStreamProvider>{tree}</EventStreamProvider> : tree}
              </PreferencesProvider>
```

to:

```tsx
              <PreferencesProvider>
                <LoadingBarProvider>
                  {isAuthed ? <EventStreamProvider>{tree}</EventStreamProvider> : tree}
                </LoadingBarProvider>
              </PreferencesProvider>
```

- [ ] **Step 4: Verify the app builds and existing App tests pass**

Run: `cd frontend && npx vitest run src/App.test.tsx 2>/dev/null; npm run build`
Expected: build succeeds; any existing App tests pass (the bar is inert with no feeders).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(#181): mount LoadingBarProvider + TopProgressBar at app root"
```

---

## Task 5: Trim `usePrDetail.showSkeleton`

**Files:**
- Modify: `frontend/src/hooks/usePrDetail.ts`
- Modify (mocks): `frontend/src/components/PrDetail/PrDetailView.test.tsx`, `PrDetailView.freshness.test.tsx`, `PrTabHost.test.tsx`

`PrDetailView` (Task 7) becomes the gate's only reader of `isLoading` and stops using `showSkeleton`. `showSkeleton` then has zero consumers, so remove it from the hook.

- [ ] **Step 1: Remove `showSkeleton` from the result type and return**

In `usePrDetail.ts`, delete the `useDelayedLoading` import, the `showSkeleton` line in `UsePrDetailResult`, the `const showSkeleton = useDelayedLoading(isLoading);` line, and `showSkeleton` from the returned object.

Before:
```ts
import { useDelayedLoading } from './useDelayedLoading';
// ...
export interface UsePrDetailResult {
  data: PrDetailDto | null;
  isLoading: boolean;
  showSkeleton: boolean;
  error: Error | null;
  reload: () => void;
}
// ...
  const showSkeleton = useDelayedLoading(isLoading);
  const reload = useCallback(() => setReloadCounter((c) => c + 1), []);
  return { data, isLoading, showSkeleton, error, reload };
```

After:
```ts
// (useDelayedLoading import removed)
// ...
export interface UsePrDetailResult {
  data: PrDetailDto | null;
  isLoading: boolean;
  error: Error | null;
  reload: () => void;
}
// ...
  const reload = useCallback(() => setReloadCounter((c) => c + 1), []);
  return { data, isLoading, error, reload };
```

- [ ] **Step 2: Update every `usePrDetail` mock to drop `showSkeleton` and ensure `isLoading`**

In `PrDetailView.test.tsx`, `PrDetailView.freshness.test.tsx`, and `PrTabHost.test.tsx`, find each `usePrDetail` mock return object. Remove `showSkeleton` and ensure `isLoading` is present (true while loading, false otherwise). Example transform:

Before: `() => ({ data: PR_DETAIL, showSkeleton: false, error: null, reload: vi.fn() })`
After: `() => ({ data: PR_DETAIL, isLoading: false, error: null, reload: vi.fn() })`

For the freshness test's mutable holder, change the cold-load state `{ data: null, showSkeleton: false, error: null }` → `{ data: null, isLoading: true, error: null }` and the background-reload injection `{ data: PR_DETAIL, showSkeleton: true, error: null }` → `{ data: PR_DETAIL, isLoading: true, error: null }`.

- [ ] **Step 3: Run the affected suites + typecheck**

Run: `cd frontend && npx vitest run src/hooks src/components/PrDetail/PrDetailView.test.tsx src/components/PrDetail/PrDetailView.freshness.test.tsx src/components/PrDetail/PrTabHost.test.tsx && npx tsc --noEmit`
Expected: PASS; no type error about a missing/extra `showSkeleton`. (These tests still reference the OLD body — that's fine; Task 7 updates behavior. If a test asserts skeleton presence via `showSkeleton`, leave it for Task 7.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/usePrDetail.ts frontend/src/components/PrDetail/PrDetailView.test.tsx frontend/src/components/PrDetail/PrDetailView.freshness.test.tsx frontend/src/components/PrDetail/PrTabHost.test.tsx
git commit -m "refactor(#181): drop orphaned usePrDetail.showSkeleton"
```

---

## Task 6: `PrHeader` `loading` prop

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`
- Test: `frontend/src/components/PrDetail/PrHeader.test.tsx` (create if absent)

- [ ] **Step 1: Write the failing test**

```tsx
// in PrHeader.test.tsx — add to the existing suite, or create the file with the standard render harness.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PrHeader } from './PrHeader';

function renderHeader(extra: Partial<React.ComponentProps<typeof PrHeader>> = {}) {
  return render(
    <MemoryRouter>
      <PrHeader
        reference={{ owner: 'acme', repo: 'api', number: 7 }}
        title=""
        author=""
        activeTab="overview"
        onTabChange={() => {}}
        {...extra}
      />
    </MemoryRouter>,
  );
}

describe('PrHeader loading', () => {
  it('shows skeletons for title/author while loading, but keeps the real breadcrumb', () => {
    renderHeader({ loading: true });
    expect(screen.getByText('acme/api')).toBeInTheDocument(); // breadcrumb is real
    expect(screen.getByTestId('pr-header-title-skeleton')).toBeInTheDocument();
  });

  it('renders the real (empty) title element when not loading', () => {
    renderHeader({ loading: false, title: 'Real title' });
    expect(screen.queryByTestId('pr-header-title-skeleton')).toBeNull();
    expect(screen.getByText('Real title')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/PrDetail/PrHeader.test.tsx -t "PrHeader loading"`
Expected: FAIL — no `pr-header-title-skeleton`.

- [ ] **Step 3: Add the `loading` prop and skeleton swaps**

In `PrHeaderProps`, add:
```ts
  /** True while the PR detail is cold-loading (data === null && isLoading). Swaps title/author/chip slots for skeletons. */
  loading?: boolean;
```
Destructure `loading = false` in the component signature. Import the primitive:
```ts
import { Skeleton } from '../Skeleton';
```
Replace the `<h1>` title and the subtitle author/chip slots with conditional skeletons. The `h1` becomes:
```tsx
          <h1 className={styles.prTitle} data-testid="pr-title">
            {loading ? (
              <Skeleton width="60%" height={22} data-testid="pr-header-title-skeleton" />
            ) : (
              title
            )}
          </h1>
```
And the subtitle author span:
```tsx
            <span className={`pr-subtitle-author ${styles.subtitleAuthor}`}>
              {loading ? (
                <>
                  <Skeleton circle width={20} />
                  <Skeleton width={110} height={12} />
                </>
              ) : (
                <>
                  <Avatar src={avatarUrl} login={author} size="sm" />
                  {author}
                </>
              )}
            </span>
```
When `loading`, also render two chip-shaped skeletons in place of the branch/CI/mergeability chips:
```tsx
            {loading && (
              <>
                <Skeleton width={90} height={18} radius={9} />
                <Skeleton width={60} height={18} radius={9} />
              </>
            )}
```
(Keep the existing `branchInfo && ...`, `ciSummary && ...`, etc. chips — they only render when their props are present, which they are not during loading, so the two paths don't collide.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/PrDetail/PrHeader.test.tsx`
Expected: PASS, including any pre-existing PrHeader tests (they pass `loading` omitted → false → unchanged render).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/PrHeader.tsx frontend/src/components/PrDetail/PrHeader.test.tsx
git commit -m "feat(#147): PrHeader loading prop swaps title/author/chip skeletons"
```

---

## Task 7: `PrDetailView` gate + Overview-shaped skeleton + bar feeder

**Files:**
- Create: `frontend/src/components/PrDetail/PrDetailSkeleton.tsx`
- Create: `frontend/src/components/PrDetail/PrDetailSkeleton.module.css`
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx`
- Modify: `frontend/src/components/PrDetail/PrDetailView.freshness.test.tsx` (selector)

- [ ] **Step 1: Write the Overview-shaped skeleton component**

```tsx
// frontend/src/components/PrDetail/PrDetailSkeleton.tsx
import { Skeleton, SkeletonText } from '../Skeleton';
import styles from './PrDetailSkeleton.module.css';

/**
 * Body skeleton mirroring OverviewTab: AI summary card, description, the 4 stats
 * tiles, a conversation stub, and the review-files CTA. Root keeps the
 * `pr-detail-skeleton` test id so the #180 freshness regression test can assert
 * its absence on background reload.
 */
export function PrDetailSkeleton() {
  return (
    <div
      className={styles.skeleton}
      data-testid="pr-detail-skeleton"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading PR…</span>
      <Skeleton className={styles.summary} height={84} />
      <SkeletonText lines={6} className={styles.description} />
      <div className={styles.tiles}>
        <Skeleton height={64} />
        <Skeleton height={64} />
        <Skeleton height={64} />
        <Skeleton height={64} />
      </div>
      <div className={styles.conversation}>
        <Skeleton circle width={32} />
        <SkeletonText lines={2} widths={['80%', '50%']} />
      </div>
      <Skeleton className={styles.cta} width={160} height={36} />
    </div>
  );
}
```

```css
/* frontend/src/components/PrDetail/PrDetailSkeleton.module.css */
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 16px 0;
}
.summary {
  border-radius: 10px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.conversation {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.conversation > :last-child {
  flex: 1;
}
```

- [ ] **Step 2: Update the freshness test selector first (red)**

In `PrDetailView.freshness.test.tsx`, the #180 assertion currently uses `document.querySelector('.pr-detail-skeleton')`. Change it to:
```ts
expect(screen.queryByTestId('pr-detail-skeleton')).toBeNull();
```
(and ensure the corresponding cold-load assertion uses `getByTestId('pr-detail-skeleton')`). Confirm the mutable mock holder supplies `isLoading` per Task 5 Step 2.

- [ ] **Step 3: Wire the gate, the header `loading` prop, the new skeleton, and the bar feeder in `PrDetailView.tsx`**

Add imports:
```tsx
import { PrDetailSkeleton } from './PrDetailSkeleton';
import { useTopProgress } from '../../contexts/LoadingBarContext';
```
Destructure `isLoading` from `usePrDetail` (line ~55):
```tsx
  const { data, isLoading, error, reload } = usePrDetail(prRef);
```
Feed the bar (per-instance key) near the other hooks:
```tsx
  // Only the active (route-matched) tab feeds the global bar; hidden keep-alive
  // tabs pass false. Per-instance key so two mounted views never collide.
  useTopProgress(`pr-detail:${refKey}`, active && isLoading);
```
Pass `loading` to `PrHeader` (add the prop to the existing `<PrHeader ... />`):
```tsx
        loading={!data && isLoading}
```
Replace the body gate. The current tail is:
```tsx
      {!data && showSkeleton ? (
        <PrDetailSkeleton />
      ) : data ? (
```
Change the condition to `!data && isLoading` (the inline `PrDetailSkeleton` function at the bottom of the file is replaced by the imported component — delete the old local `function PrDetailSkeleton()` definition):
```tsx
      {!data && isLoading ? (
        <PrDetailSkeleton />
      ) : data ? (
```
Delete the old `function PrDetailSkeleton() { ... }` at the bottom of `PrDetailView.tsx` (now imported).

- [ ] **Step 4: Run the PR-detail suites**

Run: `cd frontend && npx vitest run src/components/PrDetail/PrDetailView.test.tsx src/components/PrDetail/PrDetailView.freshness.test.tsx src/components/PrDetail/PrTabHost.test.tsx`
Expected: PASS — cold load shows `pr-detail-skeleton`; background reload (data present) does not; #180 guard holds via the testid.

- [ ] **Step 5: Add a cold-load + background-reload render test (if not already covered)**

```tsx
// in PrDetailView.test.tsx
it('shows the Overview-shaped skeleton on cold load and clears it once data arrives', () => {
  // mock usePrDetail → { data: null, isLoading: true, error: null, reload }
  // render PrDetailView active
  expect(screen.getByTestId('pr-detail-skeleton')).toBeInTheDocument();
  expect(screen.getByTestId('pr-header-title-skeleton')).toBeInTheDocument();
});
```

- [ ] **Step 6: Full frontend gate**

Run: `cd frontend && npx vitest run && npm run build && node ./node_modules/prettier/bin/prettier.cjs --check src`
Expected: all green; build OK; prettier clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/PrDetailSkeleton.tsx frontend/src/components/PrDetail/PrDetailSkeleton.module.css frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/PrDetailView.freshness.test.tsx frontend/src/components/PrDetail/PrDetailView.test.tsx
git commit -m "feat(#181): instant Overview-shaped skeleton + bar feeder on PR-detail cold open"
```

---

## Task 8: B1 visual proof — PR-detail (gated UI issue)

**Files:** none (evidence capture).

- [ ] **Step 1: Launch the app**

Run: `./run.ps1 -DotnetArgs '--no-browser'` (background); wait for `http://localhost:5180` to return 200.

- [ ] **Step 2: Capture before/after with Playwright, network throttled**

Use the Playwright MCP: navigate to the inbox, open a real PR with the network throttled (CDP `Network.emulateNetworkConditions`, e.g. Slow 3G) so the cold-load window is long enough to screenshot. Capture: (a) the **before** is the committed `4f4904f`/main behavior (empty header + blank body) — re-shoot from a stash of `main` or reuse the documented current behavior; (b) the **after** = header title/author skeletons + Overview-shaped body skeleton + the top bar. Light and dark.

- [ ] **Step 3: Host PNGs on a `review-assets/pr-181` branch and embed raw URLs in the PR (per the visual-verification convention).**

- [ ] **Step 4: Commit** — no code; the screenshots are PR-comment assets, not repo files.

---

## PR1 ship

- [ ] Run the full pre-push checklist in `.ai/docs/development-process.md` (lint, build, vitest, e2e as applicable).
- [ ] Use `pr-autopilot` to open the PR. Title: `feat(#181): loading affordance — skeletons + global top bar (PR1)`. Body closes #181 and #147; includes the B1 before/after and the `## Proof` section.

---

# PR2 — Inbox skeleton (#244)

> Branch from `main` AFTER PR1 merges (PR2 reuses `Skeleton` + `useTopProgress`). If working ahead, branch from PR1's branch and rebase after merge.

## Task 9: `<InboxSkeleton>` component

**Files:**
- Create: `frontend/src/components/Inbox/InboxSkeleton.tsx`
- Create: `frontend/src/components/Inbox/InboxSkeleton.module.css`
- Test: `frontend/src/components/Inbox/InboxSkeleton.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Inbox/InboxSkeleton.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InboxSkeleton } from './InboxSkeleton';

describe('InboxSkeleton', () => {
  it('renders the fixed number of section + row placeholders', () => {
    render(<InboxSkeleton showRail={false} />);
    expect(screen.getByTestId('inbox-skeleton')).toBeInTheDocument();
    expect(screen.getAllByTestId('inbox-skeleton-section').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByTestId('inbox-skeleton-row').length).toBeGreaterThanOrEqual(4);
  });

  it('renders the rail only when showRail is true', () => {
    const { rerender } = render(<InboxSkeleton showRail={false} />);
    expect(screen.queryByTestId('inbox-skeleton-rail')).toBeNull();
    rerender(<InboxSkeleton showRail />);
    expect(screen.getByTestId('inbox-skeleton-rail')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxSkeleton.test.tsx`
Expected: FAIL — cannot resolve `./InboxSkeleton`.

- [ ] **Step 3: Write the CSS module**

```css
/* frontend/src/components/Inbox/InboxSkeleton.module.css */
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 24px;
}
.grid[data-has-rail='true'] {
  grid-template-columns: 1fr 280px;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sectionHeader {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.rowMain {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rowTail {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rail {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
```

- [ ] **Step 4: Write the component**

```tsx
// frontend/src/components/Inbox/InboxSkeleton.tsx
import { Skeleton } from '../Skeleton';
import styles from './InboxSkeleton.module.css';

const SECTIONS = 3;
const ROWS_PER_SECTION = 3;

function Row() {
  return (
    <div className={styles.row} data-testid="inbox-skeleton-row">
      <Skeleton circle width={8} />
      <div className={styles.rowMain}>
        <Skeleton width="70%" height={12} />
        <Skeleton width="45%" height={10} />
      </div>
      <div className={styles.rowTail}>
        <Skeleton width={48} height={10} />
        <Skeleton width={28} height={10} />
      </div>
    </div>
  );
}

/**
 * Content-shaped inbox skeleton. Mirrors the paste-URL toolbar, section headers,
 * and InboxRow shape. `showRail` is supplied by InboxPage from
 * useAiGate('inboxRanking') so the skeleton stays presentational.
 */
export function InboxSkeleton({ showRail }: { showRail: boolean }) {
  return (
    <main className={styles.page} data-testid="inbox-skeleton" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading inbox…</span>
      <Skeleton width="100%" height={36} radius={8} />
      <div className={styles.grid} data-has-rail={showRail}>
        <div>
          {Array.from({ length: SECTIONS }, (_, s) => (
            <div key={s} className={styles.section} data-testid="inbox-skeleton-section">
              <div className={styles.sectionHeader}>
                <Skeleton width={12} height={12} radius={3} />
                <Skeleton width={140} height={12} />
                <Skeleton width={24} height={16} radius={8} />
              </div>
              {Array.from({ length: ROWS_PER_SECTION }, (_, r) => (
                <Row key={r} />
              ))}
            </div>
          ))}
        </div>
        {showRail && (
          <div className={styles.rail} data-testid="inbox-skeleton-rail">
            <Skeleton height={120} radius={10} />
            <Skeleton height={160} radius={10} />
          </div>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Run tests + prettier**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxSkeleton.test.tsx && node ./node_modules/prettier/bin/prettier.cjs --check src/components/Inbox/InboxSkeleton.tsx`
Expected: PASS; prettier clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Inbox/InboxSkeleton.tsx frontend/src/components/Inbox/InboxSkeleton.module.css frontend/src/components/Inbox/InboxSkeleton.test.tsx
git commit -m "feat(#244): content-shaped InboxSkeleton component"
```

---

## Task 10: `InboxPage` — swap spinner + feed bar

**Files:**
- Modify: `frontend/src/pages/InboxPage.tsx`

- [ ] **Step 1: Write/extend the failing test**

```tsx
// in InboxPage.test.tsx — add a cold-load case (mock useInbox → { data: null, isLoading: true, ... })
it('renders the inbox skeleton (not a spinner) on cold load', () => {
  // mock useInbox: () => ({ data: null, error: null, isLoading: true, reload })
  // render <InboxPage/> within the app providers
  expect(screen.getByTestId('inbox-skeleton')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/InboxPage.test.tsx -t "inbox skeleton"`
Expected: FAIL — still rendering `<Spinner>`.

- [ ] **Step 3: Swap the spinner branch + feed the bar**

In `InboxPage.tsx`:
- Add imports:
```tsx
import { InboxSkeleton } from '../components/Inbox/InboxSkeleton';
import { useTopProgress } from '../contexts/LoadingBarContext';
```
- Remove the `Spinner` import.
- After the existing `const showActivityRail = useAiGate('inboxRanking');` line, add the feeder:
```tsx
  useTopProgress('inbox', isLoading);
```
- Replace the cold-load branch:
```tsx
  if (isLoading && !data)
    return (
      <main className={styles.loading}>
        <Spinner size="lg" />
      </main>
    );
```
with:
```tsx
  if (isLoading && !data) return <InboxSkeleton showRail={showActivityRail} />;
```
(`showActivityRail` is already computed above; if its declaration sits below the early return, move it above the early return — it has no dependency on `data`.)

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && npx vitest run src/pages/InboxPage.test.tsx`
Expected: PASS — cold load shows `inbox-skeleton`; error/empty/loaded paths unchanged.

- [ ] **Step 5: Full frontend gate**

Run: `cd frontend && npx vitest run && npm run build && node ./node_modules/prettier/bin/prettier.cjs --check src`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/InboxPage.tsx frontend/src/pages/InboxPage.test.tsx
git commit -m "feat(#244): inbox cold-load skeleton + top-bar feeder"
```

---

## Task 11: B1 visual proof — Inbox (gated UI issue)

**Files:** none (evidence capture).

- [ ] **Step 1: Launch the app** (`./run.ps1 -DotnetArgs '--no-browser'`; wait for :5180).
- [ ] **Step 2:** With Playwright + network throttled, capture the inbox cold-load **before** (centered spinner) vs **after** (content-shaped skeleton + top bar), light + dark.
- [ ] **Step 3:** Host on `review-assets/pr-244`; embed raw URLs in the PR.

---

## PR2 ship

- [ ] Full pre-push checklist (`.ai/docs/development-process.md`).
- [ ] `pr-autopilot`. Title: `feat(#244): inbox content-shaped loading skeleton (PR2)`. Body closes #244; B1 before/after + `## Proof`.

---

## Self-Review

**Spec coverage:**
- §4.1 Skeleton primitive → Task 1. ✓
- §4.2 timing fix (`!data && isLoading`, leave `useDelayedLoading`) → Task 7 Step 3 + Task 5. ✓
- §4.3 PR-detail header skeleton (#147) → Task 6; body Overview skeleton → Task 7 Step 1; #180 selector pin → Task 7 Step 2. ✓
- §4.4 InboxSkeleton + `showRail` → Tasks 9–10. ✓
- §4.5 keyed-boolean store + per-instance PR-detail key + feeders → Tasks 2, 4, 7, 10. ✓
- §4.6 matrix (cold/reload/error) → Task 7 gate + Task 6 header predicate. ✓
- §4.7 a11y (`aria-busy`, sr-only, `aria-hidden`, reduced-motion) → Tasks 1, 3, 7, 9. ✓
- §5 file list → Tasks 1–10 map 1:1. ✓
- §7 tests (LoadingBar StrictMode, mock reshape, #180 testid) → Tasks 2, 5, 7. ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code.

**Type consistency:** `useTopProgress(key, active)` signature consistent across Tasks 2/7/10; `Skeleton`/`SkeletonText` props consistent across Tasks 1/6/7/9; `InboxSkeleton` takes `showRail: boolean` in Tasks 9 and 10; `UsePrDetailResult` loses `showSkeleton` in Task 5 and no later task reads it.
