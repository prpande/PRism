# AI Failure Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface every AI seam failure (503 / network) through one shared frontend mechanism — a single coalesced, persistent, per-active-PR notification with Retry-all — without disturbing the existing inline error states.

**Architecture:** A new `AiFailureProvider` React context is the single registry. The four AI hooks call `report(prRef, seam, {retry})` on a genuine failure and `clear(...)` on every non-failure branch (success / 204 / off / 401). The provider tracks failures keyed by `(prRefKey, seam)` across all keep-alive tabs, derives the **active** PR from the route (`parsePrRoute` → `prRefKey`), and renders one persistent `AiFailureToast` for the active PR's failed set only. Retry-all re-runs each failed seam's fetch (nonce bump) with last-write-wins guards.

**Tech Stack:** React 18 + TypeScript + Vite; vitest + Testing Library (unit/component); Playwright (e2e + visual). Backend untouched (frontend-only slice).

**Spec:** `docs/specs/2026-06-15-ai-failure-surfacing-design.md` (#484).

**Conventions for every task:**
- Run vitest via the project binary, never `npx`: from `frontend/`, `node ./node_modules/vitest/vitest.mjs run <path>`.
- Typecheck (when touching types): from `frontend/`, `npx tsc -b` (NOT `tsc --noEmit` — vacuous under project refs).
- Commit after each task. Do not skip hooks.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `frontend/src/components/Ai/aiFailure.tsx` | `AiFailureProvider` + `useAiFailure` hook + `AiSeam` type. Registry, active-PR derivation, retry-all + in-flight tracking. | Create |
| `frontend/src/components/Ai/aiFailure.test.tsx` | Provider unit tests. | Create |
| `frontend/src/components/Ai/AiFailureToast.tsx` | Presentational persistent notification (message, Retry, Dismiss, a11y, focus). | Create |
| `frontend/src/components/Ai/AiFailureToast.module.css` | Styles (reuse Toast tokens). | Create |
| `frontend/src/components/Ai/AiFailureToast.test.tsx` | Component tests. | Create |
| `frontend/src/components/Ai/index.ts` | Barrel re-export. | Create |
| `frontend/src/App.tsx` | Mount provider; render toast next to `ToastContainer`. | Modify |
| `frontend/src/hooks/useAiHunkAnnotations.ts` | Report/clear + retry nonce + 401 skip. | Modify |
| `frontend/src/hooks/useAiDraftSuggestions.ts` | Report/clear + retry nonce + 401 skip. | Modify |
| `frontend/src/hooks/useAiSummary.ts` | Report on error branch; clear on ok/absent; 401 skip. | Modify |
| `frontend/src/hooks/useFileFocusResult.ts` | Report on error branch; clear on ok/no-content; 401 skip. | Modify |
| `frontend/src/api/aiSummary.ts` + `frontend/src/api/aiFileFocus.ts` | Add `'auth'` outcome from `ApiError.status===401`. | Modify |
| `frontend/src/api/types.ts` | Extend `AiSummaryResult` / `AiFileFocusOutcome` with `'auth'`. | Modify |
| `frontend/src/components/PrDetail/PrDetailView.tsx` | `clearPr(prRef)` on unmount. | Modify |
| `frontend/e2e/ai-failure-surfacing.spec.ts` | e2e: forced-503 toast + Retry + recovery + backgrounded tab. | Create |

---

## Task 1: `AiFailureProvider` context + registry

**Files:**
- Create: `frontend/src/components/Ai/aiFailure.tsx`
- Test: `frontend/src/components/Ai/aiFailure.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/components/Ai/aiFailure.test.tsx
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEffect } from 'react';
import { AiFailureProvider, useAiFailure, type AiSeam } from './aiFailure';
import type { PrReference } from '../../api/types';

const PR_A: PrReference = { owner: 'o', repo: 'r', number: 1 };
const PR_B: PrReference = { owner: 'o', repo: 'r', number: 2 };

// Test harness: a probe that reports for a given pr/seam and renders the active failed set.
function Probe({ actions }: { actions: () => void }) {
  const { activeFailedSeams, retrying } = useAiFailure();
  useEffect(actions, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div data-testid="active">{`${activeFailedSeams.join(',')}|retrying=${retrying}`}</div>;
}

function renderAt(path: string, actions: () => void) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AiFailureProvider>
        <Probe actions={actions} />
      </AiFailureProvider>
    </MemoryRouter>,
  );
}

const retryNoop = () => {};

it('renders only the active PR failed set; coalesces multiple seams', () => {
  let api!: ReturnType<typeof useAiFailure>;
  function Grab() { api = useAiFailure(); return null; }
  render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureProvider><Grab /><Probe actions={() => {}} /></AiFailureProvider>
    </MemoryRouter>,
  );
  act(() => {
    api.report(PR_A, 'summary', { retry: retryNoop });
    api.report(PR_A, 'hunk-annotations', { retry: retryNoop });
    api.report(PR_B, 'file-focus', { retry: retryNoop }); // backgrounded PR — recorded, not shown
  });
  expect(screen.getByTestId('active').textContent).toBe('summary,hunk-annotations|retrying=false');
});

it('clear removes a seam; clearPr removes a whole PR', () => {
  let api!: ReturnType<typeof useAiFailure>;
  function Grab() { api = useAiFailure(); return null; }
  render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureProvider><Grab /><Probe actions={() => {}} /></AiFailureProvider>
    </MemoryRouter>,
  );
  act(() => { api.report(PR_A, 'summary', { retry: retryNoop }); api.report(PR_A, 'file-focus', { retry: retryNoop }); });
  act(() => { api.clear(PR_A, 'summary'); });
  expect(screen.getByTestId('active').textContent).toBe('file-focus|retrying=false');
  act(() => { api.clearPr(PR_A); });
  expect(screen.getByTestId('active').textContent).toBe('|retrying=false');
});

it('renders nothing on a non-PR route (activeKey null)', () => {
  let api!: ReturnType<typeof useAiFailure>;
  function Grab() { api = useAiFailure(); return null; }
  render(
    <MemoryRouter initialEntries={['/']}>
      <AiFailureProvider><Grab /><Probe actions={() => {}} /></AiFailureProvider>
    </MemoryRouter>,
  );
  act(() => { api.report(PR_A, 'summary', { retry: retryNoop }); });
  expect(screen.getByTestId('active').textContent).toBe('|retrying=false');
});

it('retryAll calls every active-PR retry and sets retrying until all settle', () => {
  const calls: AiSeam[] = [];
  let api!: ReturnType<typeof useAiFailure>;
  function Grab() { api = useAiFailure(); return null; }
  render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureProvider><Grab /><Probe actions={() => {}} /></AiFailureProvider>
    </MemoryRouter>,
  );
  act(() => {
    api.report(PR_A, 'summary', { retry: () => calls.push('summary') });
    api.report(PR_A, 'file-focus', { retry: () => calls.push('file-focus') });
  });
  act(() => { api.retryAll(); });
  expect(calls.sort()).toEqual(['file-focus', 'summary']);
  expect(screen.getByTestId('active').textContent).toContain('retrying=true');
  act(() => { api.clear(PR_A, 'summary'); }); // one recovers
  expect(screen.getByTestId('active').textContent).toContain('retrying=true'); // file-focus still pending
  act(() => { api.report(PR_A, 'file-focus', { retry: () => {} }); }); // the other re-fails → settles
  expect(screen.getByTestId('active').textContent).toContain('retrying=false');
});

it('useAiFailure outside a provider is a no-op (NOOP default)', () => {
  function Grab() { const a = useAiFailure(); a.report(PR_A, 'summary', { retry: retryNoop }); return <div>ok</div>; }
  expect(() => render(<MemoryRouter><Grab /></MemoryRouter>)).not.toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/Ai/aiFailure.test.tsx`
Expected: FAIL — `Cannot find module './aiFailure'`.

- [ ] **Step 3: Implement the provider**

```tsx
// frontend/src/components/Ai/aiFailure.tsx
import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import type { PrReference } from '../../api/types';
import { prRefKey } from '../../api/types';
import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';
import { parsePrRoute } from '../PrDetail/PrTabHost';

export type AiSeam = 'summary' | 'file-focus' | 'hunk-annotations' | 'draft-suggestions';

interface FailureEntry { retry: () => void }
type FailureMap = Record<string, Partial<Record<AiSeam, FailureEntry>>>;

export interface AiFailureApi {
  report: (prRef: PrReference, seam: AiSeam, opts: FailureEntry) => void;
  clear: (prRef: PrReference, seam: AiSeam) => void;
  clearPr: (prRef: PrReference) => void;
  retryAll: () => void;
  dismiss: () => void;
  // Derived view for the active PR:
  activeFailedSeams: AiSeam[];
  retrying: boolean;
  dismissed: boolean;
}

const NOOP: AiFailureApi = {
  report: () => {}, clear: () => {}, clearPr: () => {}, retryAll: () => {}, dismiss: () => {},
  activeFailedSeams: [], retrying: false, dismissed: false,
};
// Exported as a test seam (mirrors OpenTabsContext) so a unit test can inject a
// stub value with spy methods. App code consumes via useAiFailure(), not this directly.
export const AiFailureContext = createContext<AiFailureApi>(NOOP);

// Stable seam ordering for display (summary first, then the rest).
const SEAM_ORDER: AiSeam[] = ['summary', 'file-focus', 'hunk-annotations', 'draft-suggestions'];

export function AiFailureProvider({ children }: { children: ReactNode }) {
  const [failures, setFailures] = useState<FailureMap>({});
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const pendingRef = useRef<Set<AiSeam>>(new Set());
  // The failure-set fingerprint that was on screen when the user last dismissed;
  // a new failure (different fingerprint) re-shows the toast.
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null);

  const { pathname } = useEffectiveLocation();
  const route = parsePrRoute(pathname);
  const activeKey = route && route.valid ? prRefKey(route.ref) : null;

  const settle = useCallback((key: string, seam: AiSeam) => {
    setRetryingKey((cur) => {
      if (cur !== key || !pendingRef.current.has(seam)) return cur;
      pendingRef.current.delete(seam);
      return pendingRef.current.size === 0 ? null : cur;
    });
  }, []);

  const report = useCallback((prRef: PrReference, seam: AiSeam, opts: FailureEntry) => {
    const key = prRefKey(prRef);
    setFailures((prev) => ({ ...prev, [key]: { ...prev[key], [seam]: opts } }));
    settle(key, seam);
  }, [settle]);

  const clear = useCallback((prRef: PrReference, seam: AiSeam) => {
    const key = prRefKey(prRef);
    setFailures((prev) => {
      const forPr = prev[key];
      if (!forPr || !(seam in forPr)) return prev;
      const next = { ...forPr };
      delete next[seam];
      const out = { ...prev };
      if (Object.keys(next).length === 0) delete out[key]; else out[key] = next;
      return out;
    });
    settle(key, seam);
  }, [settle]);

  const clearPr = useCallback((prRef: PrReference) => {
    const key = prRefKey(prRef);
    setFailures((prev) => {
      if (!(key in prev)) return prev;
      const out = { ...prev }; delete out[key]; return out;
    });
    setRetryingKey((cur) => (cur === key ? null : cur));
  }, []);

  const activeFailedSeams = useMemo<AiSeam[]>(() => {
    if (!activeKey) return [];
    const forPr = failures[activeKey];
    if (!forPr) return [];
    return SEAM_ORDER.filter((s) => s in forPr);
  }, [activeKey, failures]);

  const fingerprint = activeKey ? `${activeKey}:${activeFailedSeams.join(',')}` : '';
  const dismissed = dismissedFingerprint !== null && dismissedFingerprint === fingerprint;

  const retryAll = useCallback(() => {
    if (!activeKey) return;
    const forPr = failures[activeKey];
    if (!forPr) return;
    const seams = SEAM_ORDER.filter((s) => s in forPr);
    if (seams.length === 0) return;
    pendingRef.current = new Set(seams);
    setRetryingKey(activeKey);
    setDismissedFingerprint(null); // a retry un-dismisses
    seams.forEach((s) => forPr[s]?.retry());
  }, [activeKey, failures]);

  const dismiss = useCallback(() => setDismissedFingerprint(fingerprint), [fingerprint]);

  const value = useMemo<AiFailureApi>(() => ({
    report, clear, clearPr, retryAll, dismiss,
    activeFailedSeams,
    retrying: retryingKey !== null && retryingKey === activeKey,
    dismissed,
  }), [report, clear, clearPr, retryAll, dismiss, activeFailedSeams, retryingKey, activeKey, dismissed]);

  return <AiFailureContext.Provider value={value}>{children}</AiFailureContext.Provider>;
}

export function useAiFailure(): AiFailureApi {
  return useContext(AiFailureContext);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/Ai/aiFailure.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/components/Ai/aiFailure.tsx frontend/src/components/Ai/aiFailure.test.tsx
git commit -m "feat(ai): #484 AiFailureProvider registry + active-PR derivation"
```

---

## Task 2: `AiFailureToast` presentational component

**Files:**
- Create: `frontend/src/components/Ai/AiFailureToast.tsx`, `AiFailureToast.module.css`, `index.ts`
- Test: `frontend/src/components/Ai/AiFailureToast.test.tsx`

Display-name map (spec Copy): `summary`→"summary", `file-focus`→"hotspots", `hunk-annotations`→"annotations", `draft-suggestions`→"draft suggestions".

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/components/Ai/AiFailureToast.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { AiFailureToast } from './AiFailureToast';
import type { AiSeam } from './aiFailure';

function setup(over: Partial<Parameters<typeof AiFailureToast>[0]> = {}) {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <AiFailureToast
      seams={(over.seams ?? ['summary', 'file-focus', 'hunk-annotations']) as AiSeam[]}
      retrying={over.retrying ?? false}
      onRetry={onRetry}
      onDismiss={onDismiss}
    />,
  );
  return { onRetry, onDismiss };
}

it('renders nothing when there are no seams', () => {
  const { container } = render(<AiFailureToast seams={[]} retrying={false} onRetry={() => {}} onDismiss={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});

it('lists failed seams using display names', () => {
  setup({ seams: ['summary', 'file-focus', 'hunk-annotations'] });
  expect(screen.getByText(/summary, hotspots, annotations/)).toBeInTheDocument();
});

it('Retry button fires onRetry and is enabled when not retrying', () => {
  const { onRetry } = setup({ retrying: false });
  const btn = screen.getByRole('button', { name: 'Retry' });
  expect(btn).toBeEnabled();
  fireEvent.click(btn);
  expect(onRetry).toHaveBeenCalledOnce();
});

it('shows a disabled "Retrying…" button while retrying', () => {
  setup({ retrying: true });
  const btn = screen.getByRole('button', { name: 'Retrying…' });
  expect(btn).toBeDisabled();
});

it('Dismiss button fires onDismiss', () => {
  const { onDismiss } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onDismiss).toHaveBeenCalledOnce();
});

it('announces via a polite live region on appearance only', () => {
  setup();
  const live = screen.getByTestId('ai-failure-live');
  expect(live).toHaveAttribute('aria-live', 'polite');
  expect(live.textContent).toBe('AI generation failed.'); // stable phrase, not the mutable seam list
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/Ai/AiFailureToast.test.tsx`
Expected: FAIL — `Cannot find module './AiFailureToast'`.

- [ ] **Step 3: Implement the component + styles + barrel**

```tsx
// frontend/src/components/Ai/AiFailureToast.tsx
import styles from './AiFailureToast.module.css';
import type { AiSeam } from './aiFailure';

const DISPLAY_NAME: Record<AiSeam, string> = {
  summary: 'summary',
  'file-focus': 'hotspots',
  'hunk-annotations': 'annotations',
  'draft-suggestions': 'draft suggestions',
};

interface Props {
  seams: AiSeam[];
  retrying: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}

export function AiFailureToast({ seams, retrying, onRetry, onDismiss }: Props) {
  if (seams.length === 0) return null;
  const names = seams.map((s) => DISPLAY_NAME[s]).join(', ');
  return (
    <div className={styles.toast} role="group" aria-label="AI generation failure">
      {/* Stable phrase in the live region — announced on appear/disappear only, NOT on
          partial-recovery message mutation (the mutable seam list lives in aria-hidden text). */}
      <span className="sr-only" aria-live="polite" data-testid="ai-failure-live">
        AI generation failed.
      </span>
      <span className={styles.message} aria-hidden="true">
        {`AI couldn't generate: ${names} — the provider failed or timed out.`}
      </span>
      <button type="button" className={styles.retry} onClick={onRetry} disabled={retrying}>
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
      <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
        Dismiss
      </button>
    </div>
  );
}
```

```css
/* frontend/src/components/Ai/AiFailureToast.module.css — reuse Toast visual tokens */
.toast {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--surface-1);
  border: 1px solid var(--danger, var(--border-1));
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  margin-bottom: 8px;
}
.message { flex: 1 1 auto; }
.retry, .dismiss {
  flex: none;
  background: none;
  border: 1px solid var(--border-1);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--text-1);
}
.retry:disabled { cursor: default; opacity: 0.6; }
```

```ts
// frontend/src/components/Ai/index.ts
export { AiFailureProvider, useAiFailure } from './aiFailure';
export type { AiSeam, AiFailureApi } from './aiFailure';
export { AiFailureToast } from './AiFailureToast';
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/Ai/AiFailureToast.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/components/Ai/
git commit -m "feat(ai): #484 AiFailureToast persistent notification"
```

---

## Task 3: Mount provider + render the toast in `App`

**Files:**
- Modify: `frontend/src/App.tsx` (provider nesting near line 197–214; `tree` JSX near line 188 next to `<ToastContainer />`)
- Create: `frontend/src/components/Ai/AiFailureContainer.tsx` (binds context → component)
- Test: `frontend/src/components/Ai/AiFailureContainer.test.tsx`

- [ ] **Step 1: Write the failing test for the container binding**

```tsx
// frontend/src/components/Ai/AiFailureContainer.test.tsx
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiFailureProvider, useAiFailure } from './aiFailure';
import { AiFailureContainer } from './AiFailureContainer';
import type { PrReference } from '../../api/types';

const PR_A: PrReference = { owner: 'o', repo: 'r', number: 1 };

it('renders the toast for the active PR failed set and wires dismiss', () => {
  let api!: ReturnType<typeof useAiFailure>;
  function Grab() { api = useAiFailure(); return null; }
  render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureProvider><Grab /><AiFailureContainer /></AiFailureProvider>
    </MemoryRouter>,
  );
  expect(screen.queryByRole('group', { name: 'AI generation failure' })).toBeNull();
  act(() => { api.report(PR_A, 'summary', { retry: () => {} }); });
  expect(screen.getByText(/AI couldn't generate: summary/)).toBeInTheDocument();
});

it('hides the toast after dismiss until a new failure', () => {
  let api!: ReturnType<typeof useAiFailure>;
  function Grab() { api = useAiFailure(); return null; }
  render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureProvider><Grab /><AiFailureContainer /></AiFailureProvider>
    </MemoryRouter>,
  );
  act(() => { api.report(PR_A, 'summary', { retry: () => {} }); });
  act(() => { api.dismiss(); });
  expect(screen.queryByText(/AI couldn't generate/)).toBeNull();
  act(() => { api.report(PR_A, 'file-focus', { retry: () => {} }); }); // new fingerprint → re-shows
  expect(screen.getByText(/AI couldn't generate: summary, hotspots/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/Ai/AiFailureContainer.test.tsx`
Expected: FAIL — `Cannot find module './AiFailureContainer'`.

- [ ] **Step 3: Implement the container**

```tsx
// frontend/src/components/Ai/AiFailureContainer.tsx
import { useAiFailure } from './aiFailure';
import { AiFailureToast } from './AiFailureToast';

export function AiFailureContainer() {
  const { activeFailedSeams, retrying, dismissed, retryAll, dismiss } = useAiFailure();
  if (dismissed) return null;
  return (
    <AiFailureToast
      seams={activeFailedSeams}
      retrying={retrying}
      onRetry={retryAll}
      onDismiss={dismiss}
    />
  );
}
```

Add to the barrel `frontend/src/components/Ai/index.ts`:

```ts
export { AiFailureContainer } from './AiFailureContainer';
```

- [ ] **Step 4: Wire into `App.tsx`**

In `frontend/src/App.tsx`, import:

```ts
import { AiFailureProvider, AiFailureContainer } from './components/Ai';
```

Mount `AiFailureProvider` inside `PreferencesProvider` so it covers the authed tree (the AI hooks live under it) — wrap the `isAuthed ? ... : tree` expression:

```tsx
<PreferencesProvider>
  <AiFailureProvider>
    {isAuthed ? <EventStreamProvider>{tree}</EventStreamProvider> : tree}
  </AiFailureProvider>
</PreferencesProvider>
```

In the `tree` JSX, render the container right after `<ToastContainer />`:

```tsx
<ToastContainer />
<AiFailureContainer />
```

- [ ] **Step 5: Run container tests + full Ai suite + typecheck**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/Ai/`
Expected: PASS (all Ai tests). Then `npx tsc -b`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Ai/ frontend/src/App.tsx
git commit -m "feat(ai): #484 mount AiFailureProvider + render container in App"
```

---

## Task 4: Wire `useAiHunkAnnotations` (report/clear + retry + 401 skip)

**Files:**
- Modify: `frontend/src/hooks/useAiHunkAnnotations.ts`
- Test: `frontend/src/hooks/useAiHunkAnnotations.test.tsx` (create if absent)

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/hooks/useAiHunkAnnotations.test.tsx
import { renderHook, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAiHunkAnnotations } from './useAiHunkAnnotations';
import { AiFailureProvider, useAiFailure } from '../components/Ai/aiFailure';
import * as api from '../api/aiHunkAnnotations';
import { ApiError } from '../api/client';
import type { PrReference } from '../api/types';

const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };
const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/pr/o/r/1']}><AiFailureProvider>{children}</AiFailureProvider></MemoryRouter>
);

it('reports a failure on 503 and the active set lists annotations', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockRejectedValue(new ApiError(503, null, ''));
  const { result } = renderHook(() => ({ entries: useAiHunkAnnotations(PR, true), fail: useAiFailure() }), { wrapper });
  await waitFor(() => expect(result.current.fail.activeFailedSeams).toContain('hunk-annotations'));
});

it('does NOT report on 401 (auth banner owns it); still clears', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockRejectedValue(new ApiError(401, null, ''));
  const { result } = renderHook(() => useAiFailure(), { wrapper });
  renderHook(() => useAiHunkAnnotations(PR, true), { wrapper });
  await waitFor(() => {});
  expect(result.current.activeFailedSeams).not.toContain('hunk-annotations');
});

it('clears on success (or 204→null)', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockResolvedValue(null);
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), { wrapper });
  await waitFor(() => expect(result.current.f.activeFailedSeams).not.toContain('hunk-annotations'));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiHunkAnnotations.test.tsx`
Expected: FAIL — no report happens (hook still swallows in `.catch`).

- [ ] **Step 3: Implement**

Replace the body of `frontend/src/hooks/useAiHunkAnnotations.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { getAiHunkAnnotations } from '../api/aiHunkAnnotations';
import { ApiError } from '../api/client';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { PrReference, HunkAnnotation } from '../api/types';

export function useAiHunkAnnotations(
  prRef: PrReference,
  enabled: boolean,
): HunkAnnotation[] | null {
  const [entries, setEntries] = useState<HunkAnnotation[] | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  const { report, clear } = useAiFailure();

  useEffect(() => {
    if (!enabled) {
      setEntries(null);
      clear(prRef, 'hunk-annotations');
      return;
    }
    let cancelled = false;
    const myNonce = retryNonce;
    getAiHunkAnnotations(prRef)
      .then((result) => {
        if (cancelled || myNonce !== retryNonce) return;
        setEntries(result);
        clear(prRef, 'hunk-annotations');
      })
      .catch((err) => {
        if (cancelled || myNonce !== retryNonce) return;
        setEntries(null);
        if (err instanceof ApiError && err.status === 401) {
          clear(prRef, 'hunk-annotations');
        } else {
          report(prRef, 'hunk-annotations', { retry });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; retryNonce re-runs the fetch; report/clear/retry are stable (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, retryNonce]);

  return entries;
}
```

> The `myNonce !== retryNonce` guard is the last-write-wins protection (spec §Retry semantics). `report`/`clear`/`retry` are stable identities (provider memoizes; `retry` is `useCallback`), so omitting them from deps does not stale.

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiHunkAnnotations.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/hooks/useAiHunkAnnotations.ts frontend/src/hooks/useAiHunkAnnotations.test.tsx
git commit -m "feat(ai): #484 wire hunk-annotations failure reporting + retry"
```

---

## Task 5: Wire `useAiDraftSuggestions` (identical treatment)

**Files:**
- Modify: `frontend/src/hooks/useAiDraftSuggestions.ts`
- Test: `frontend/src/hooks/useAiDraftSuggestions.test.tsx` (create if absent)

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/hooks/useAiDraftSuggestions.test.tsx
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAiDraftSuggestions } from './useAiDraftSuggestions';
import { AiFailureProvider, useAiFailure } from '../components/Ai/aiFailure';
import * as api from '../api/aiDraftSuggestions';
import { ApiError } from '../api/client';
import type { PrReference } from '../api/types';

const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };
const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/pr/o/r/1']}><AiFailureProvider>{children}</AiFailureProvider></MemoryRouter>
);

it('reports draft-suggestions on a non-401 throw', async () => {
  vi.spyOn(api, 'getAiDraftSuggestions').mockRejectedValue(new ApiError(500, null, ''));
  const { result } = renderHook(() => ({ e: useAiDraftSuggestions(PR, true), f: useAiFailure() }), { wrapper });
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('draft-suggestions'));
});

it('does NOT report on 401', async () => {
  vi.spyOn(api, 'getAiDraftSuggestions').mockRejectedValue(new ApiError(401, null, ''));
  const { result } = renderHook(() => ({ e: useAiDraftSuggestions(PR, true), f: useAiFailure() }), { wrapper });
  await waitFor(() => {});
  expect(result.current.f.activeFailedSeams).not.toContain('draft-suggestions');
});
```

> The 500 case in the first test reflects the spec's note that draft-suggestions has no backend `try/catch` today — the hook reports on *any* non-401 throw, future-proofing for when the real seam maps to 503.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiDraftSuggestions.test.tsx`
Expected: FAIL — no report.

- [ ] **Step 3: Implement** — apply the exact same transform as Task 4, with seam `'draft-suggestions'`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { getAiDraftSuggestions } from '../api/aiDraftSuggestions';
import { ApiError } from '../api/client';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { PrReference, DraftSuggestion } from '../api/types';

export function useAiDraftSuggestions(
  prRef: PrReference,
  enabled: boolean,
): DraftSuggestion[] | null {
  const [entries, setEntries] = useState<DraftSuggestion[] | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  const { report, clear } = useAiFailure();

  useEffect(() => {
    if (!enabled) {
      setEntries(null);
      clear(prRef, 'draft-suggestions');
      return;
    }
    let cancelled = false;
    const myNonce = retryNonce;
    getAiDraftSuggestions(prRef)
      .then((result) => {
        if (cancelled || myNonce !== retryNonce) return;
        setEntries(result);
        clear(prRef, 'draft-suggestions');
      })
      .catch((err) => {
        if (cancelled || myNonce !== retryNonce) return;
        setEntries(null);
        if (err instanceof ApiError && err.status === 401) {
          clear(prRef, 'draft-suggestions');
        } else {
          report(prRef, 'draft-suggestions', { retry });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; retryNonce re-runs the fetch (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, retryNonce]);

  return entries;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiDraftSuggestions.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/hooks/useAiDraftSuggestions.ts frontend/src/hooks/useAiDraftSuggestions.test.tsx
git commit -m "feat(ai): #484 wire draft-suggestions failure reporting + retry"
```

---

## Task 6: Thread `401` into summary api + wire `useAiSummary`

**Files:**
- Modify: `frontend/src/api/types.ts` (extend `AiSummaryResult`), `frontend/src/api/aiSummary.ts`, `frontend/src/hooks/useAiSummary.ts`
- Test: extend `frontend/src/hooks/useAiSummary.test.tsx` (or create)

- [ ] **Step 1: Write the failing tests**

```tsx
// add to frontend/src/hooks/useAiSummary.test.tsx
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAiSummary } from './useAiSummary';
import { AiFailureProvider, useAiFailure } from '../components/Ai/aiFailure';
import * as api from '../api/aiSummary';
import type { PrReference } from '../api/types';

const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };
const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/pr/o/r/1']}><AiFailureProvider>{children}</AiFailureProvider></MemoryRouter>
);

it('reports summary on kind:error and clears on kind:auth', async () => {
  const spy = vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({ kind: 'error' });
  const { result, rerender } = renderHook(() => ({ s: useAiSummary(PR, true, true, false), f: useAiFailure() }), { wrapper });
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('summary'));
  spy.mockResolvedValue({ kind: 'auth' });
  result.current.s.regenerate(); // triggers a fresh fetch path
  await waitFor(() => expect(result.current.f.activeFailedSeams).not.toContain('summary'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiSummary.test.tsx`
Expected: FAIL — `kind: 'auth'` is not assignable; no report wiring.

- [ ] **Step 3a: Extend the result type** (`frontend/src/api/types.ts` line 243):

```ts
export type AiSummaryResult =
  | { kind: 'ok'; summary: PrSummary }
  | { kind: 'absent' }
  | { kind: 'auth' }
  | { kind: 'error' };
```

- [ ] **Step 3b: Map 401 in `frontend/src/api/aiSummary.ts`** — update `resolveSummary`'s catch:

```ts
import { apiClient, ApiError } from './client';
// ...
  try {
    const result = await call();
    return result ? { kind: 'ok', summary: result } : { kind: 'absent' };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { kind: 'auth' };
    return { kind: 'error' };
  }
```

- [ ] **Step 3c: Wire `frontend/src/hooks/useAiSummary.ts`** — add the failure context and report/clear at the result branches. Add near the top of the hook:

```ts
import { useAiFailure } from '../components/Ai/aiFailure';
// ...inside the hook body:
const { report, clear } = useAiFailure();
```

In the initial-fetch `.then((r) => …)` (the `useEffect`), update the branches:

```ts
if (r.kind === 'ok') {
  setSummary(r.summary); setLoading(false); setError(false);
  clear(prRef, 'summary');
  if (!baseShaChangedRef.current) setStaleCleared(true);
} else if (r.kind === 'error') {
  setSummary(null); setLoading(false); setError(true);
  report(prRef, 'summary', { retry: regenerate });
} else { // 'absent' | 'auth'
  setSummary(null); setLoading(false); setError(false);
  clear(prRef, 'summary');
}
```

In `regenerate()`'s result handling:

```ts
if (r.kind === 'ok') {
  setSummary(r.summary); setStaleCleared(true); clear(prRef, 'summary');
} else if (r.kind === 'error') {
  setRegenerateError(true); report(prRef, 'summary', { retry: regenerate });
} else { // 'absent' | 'auth'
  clear(prRef, 'summary');
}
```

> `regenerate` is the retry closure for summary (a force re-fetch). It is already a stable `useCallback`. Reference it in `report(...)`; since `regenerate` is defined after the effect, hoist the `report`/`clear` calls to use the already-declared `regenerate` (it is a `useCallback` assigned in the same render — capture is fine because the effect runs after render). If lint flags ordering, declare `regenerate` above the effect.

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiSummary.test.tsx`
Expected: PASS. Then run the existing summary suite to confirm no regression:
`cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiSummary.test.tsx src/components/PrDetail/OverviewTab`

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/api/types.ts frontend/src/api/aiSummary.ts frontend/src/hooks/useAiSummary.ts frontend/src/hooks/useAiSummary.test.tsx
git commit -m "feat(ai): #484 wire summary failure reporting (+401 skip)"
```

---

## Task 7: Thread `401` into file-focus api + wire `useFileFocusResult`

**Files:**
- Modify: `frontend/src/api/types.ts` (extend `AiFileFocusOutcome` if defined there) or `frontend/src/api/aiFileFocus.ts` (where the union lives), `frontend/src/hooks/useFileFocusResult.ts`
- Test: extend `frontend/src/hooks/useFileFocusResult.test.tsx` (or create)

> The `AiFileFocusOutcome` union is declared in `frontend/src/api/aiFileFocus.ts` (not `types.ts`). Add `| { kind: 'auth' }` there.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/hooks/useFileFocusResult.test.tsx (add)
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useFileFocusResult } from './useFileFocusResult';
import { AiFailureProvider, useAiFailure } from '../components/Ai/aiFailure';
import * as api from '../api/aiFileFocus';
import type { PrReference } from '../api/types';

const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };
const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/pr/o/r/1']}><AiFailureProvider>{children}</AiFailureProvider></MemoryRouter>
);

it('reports file-focus on kind:error', async () => {
  vi.spyOn(api, 'getAiFileFocusResult').mockResolvedValue({ kind: 'error' });
  const { result } = renderHook(() => ({ s: useFileFocusResult(PR, true, true), f: useAiFailure() }), { wrapper });
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('file-focus'));
});

it('does NOT report on kind:auth', async () => {
  vi.spyOn(api, 'getAiFileFocusResult').mockResolvedValue({ kind: 'auth' });
  const { result } = renderHook(() => ({ s: useFileFocusResult(PR, true, true), f: useAiFailure() }), { wrapper });
  await waitFor(() => {});
  expect(result.current.f.activeFailedSeams).not.toContain('file-focus');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useFileFocusResult.test.tsx`
Expected: FAIL — `kind:'auth'` not assignable; no report.

- [ ] **Step 3a: Extend the union + map 401 in `frontend/src/api/aiFileFocus.ts`:**

```ts
import { apiClient, ApiError } from './client';
import type { PrReference, FileFocusResult } from './types';

export type AiFileFocusOutcome =
  | { kind: 'ok'; result: FileFocusResult }
  | { kind: 'no-content' }
  | { kind: 'auth' }
  | { kind: 'error' };

export async function getAiFileFocusResult(prRef: PrReference): Promise<AiFileFocusOutcome> {
  try {
    const result = await apiClient.get<FileFocusResult | undefined>(
      `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/file-focus`,
    );
    return result ? { kind: 'ok', result } : { kind: 'no-content' };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { kind: 'auth' };
    return { kind: 'error' };
  }
}
```

- [ ] **Step 3b: Wire `frontend/src/hooks/useFileFocusResult.ts`** — add the context and report/clear at outcome branches:

```ts
import { useAiFailure } from '../components/Ai/aiFailure';
// ...inside the hook:
const { report, clear } = useAiFailure();
// ...inside the .then((outcome) => { ... }):
if (outcome.kind === 'no-content') {
  setState({ status: 'no-changes', entries: [] });
  clear(prRef, 'file-focus');
} else if (outcome.kind === 'auth') {
  setState({ status: 'error', entries: [] }); // inline state unchanged; just don't report
  clear(prRef, 'file-focus');
} else if (outcome.kind === 'error') {
  setState({ status: 'error', entries: [] });
  report(prRef, 'file-focus', { retry });
} else {
  const { entries, fallback } = outcome.result;
  if (fallback) setState({ status: 'fallback', entries });
  else {
    const hasSignal = entries.some((e) => e.level === 'high' || e.level === 'medium');
    setState({ status: hasSignal ? 'ok' : 'empty', entries });
  }
  clear(prRef, 'file-focus');
}
```

Also call `clear(prRef, 'file-focus')` in the `!enabled` / `!subscribed` early-return branches, and `report` is unnecessary in the `.catch` (the api already maps throws to `kind:'error'`/`'auth'`); leave the existing `.catch(() => setState({status:'error'}))` but add `report(prRef, 'file-focus', { retry })` there too for network throws that bypass the api mapping.

> `retry` already exists in this hook (`const retry = useCallback(() => setRetryNonce((n) => n + 1), [])`) — reuse it as the report retry closure.

- [ ] **Step 4: Run to verify they pass + no regression**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useFileFocusResult.test.tsx src/components/PrDetail/HotspotsTab`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/api/aiFileFocus.ts frontend/src/hooks/useFileFocusResult.ts frontend/src/hooks/useFileFocusResult.test.tsx
git commit -m "feat(ai): #484 wire file-focus failure reporting (+401 skip)"
```

---

## Task 8: `clearPr` on `PrDetailView` unmount

**Files:**
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx`
- Test: `frontend/src/components/PrDetail/PrDetailView.clearPr.test.tsx`

- [ ] **Step 1: Write the failing test**

This injects a stub `AiFailureApi` (with a `clearPr` spy) via the exported `AiFailureContext` seam and asserts the real `PrDetailView` fires `clearPr(prRef)` when it unmounts — without standing up the whole provider/route stack. Supply whatever required props `PrDetailView` takes (read its prop type when implementing; the only behavior under test is the unmount cleanup).

```tsx
// frontend/src/components/PrDetail/PrDetailView.clearPr.test.tsx
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiFailureContext, type AiFailureApi } from '../Ai/aiFailure';
import { PrDetailView } from './PrDetailView';
import type { PrReference } from '../../api/types';

const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };

function stubApi(over: Partial<AiFailureApi> = {}): AiFailureApi {
  return {
    report: vi.fn(), clear: vi.fn(), clearPr: vi.fn(), retryAll: vi.fn(), dismiss: vi.fn(),
    activeFailedSeams: [], retrying: false, dismissed: false, ...over,
  };
}

it('fires clearPr(prRef) when PrDetailView unmounts', () => {
  const clearPr = vi.fn();
  const api = stubApi({ clearPr });
  const { unmount } = render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureContext.Provider value={api}>
        {/* Fill in PrDetailView's required props (prRef + whatever else it needs). */}
        <PrDetailView prRef={PR} active />
      </AiFailureContext.Provider>
    </MemoryRouter>,
  );
  expect(clearPr).not.toHaveBeenCalled();
  unmount();
  expect(clearPr).toHaveBeenCalledWith(PR);
});
```

> If `PrDetailView`'s required props or child data-fetches make a bare mount impractical, mock its heavy children/hooks at the top of the file (sibling tests already mock `useEventSource`/data hooks) — the assertion is solely "unmount → `clearPr(prRef)` once with the PR ref".

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/PrDetailView.clearPr.test.tsx`
Expected: FAIL once the placeholder is replaced with the real unmount assertion.

- [ ] **Step 3: Implement** — in `frontend/src/components/PrDetail/PrDetailView.tsx`, add:

```ts
import { useAiFailure } from '../Ai/aiFailure';
// ...inside the component:
const { clearPr } = useAiFailure();
useEffect(() => {
  return () => clearPr(prRef);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; clearPr is stable (#331)
}, [prRef.owner, prRef.repo, prRef.number]);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/PrDetailView.clearPr.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/PrDetailView.clearPr.test.tsx
git commit -m "feat(ai): #484 clear AI failures on PrDetailView unmount"
```

---

## Task 9: e2e + visual baseline

**Files:**
- Create: `frontend/e2e/ai-failure-surfacing.spec.ts`

Model the route-stub setup on `frontend/e2e/ai-live-consent.spec.ts` (it already `page.route`s all four `**/api/pr/.../ai/*` endpoints). The harness is frontend-only — forcing `503` needs no backend change.

- [ ] **Step 1: Write the e2e spec**

```ts
// frontend/e2e/ai-failure-surfacing.spec.ts
import { test, expect, type Route } from '@playwright/test';
// Reuse the project's base-mocks + AI-Live consent setup helpers (see ai-live-consent.spec.ts).
// import { setupBaseRoutes } from './helpers/base-mocks';

const OWNER = 'o', REPO = 'r', PR_NUMBER = 1;

test('AI seam 503 surfaces a persistent toast with Retry that recovers', async ({ page }) => {
  // 1. Base routes + AI Live enabled (mirror ai-live-consent.spec.ts setup).
  // 2. Force 503 on the file-focus seam:
  let failNext = true;
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR_NUMBER}/ai/file-focus`, (route: Route) =>
    failNext
      ? route.fulfill({ status: 503 })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], fallback: false }) }),
  );
  // 3. Navigate to the PR; assert the persistent toast appears naming hotspots.
  await page.goto(`/pr/${OWNER}/${REPO}/${PR_NUMBER}`);
  const toast = page.getByRole('group', { name: 'AI generation failure' });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('hotspots');
  // 4. Click Retry → success on retry → toast disappears.
  failNext = false;
  await toast.getByRole('button', { name: 'Retry' }).click();
  await expect(toast).toBeHidden();
});

test('a backgrounded PR tab’s failure does not show while another PR is active', async ({ page }) => {
  // Open PR 1 (failing), then navigate to PR 2 (healthy); assert the toast is hidden on PR 2,
  // and reappears when navigating back to PR 1. (Mirror multi-tab setup from density-cross-tab.spec.ts.)
});
```

> Flesh out the helper imports and the second test's tab setup using the existing e2e helpers (`helpers/base-mocks.ts`, the AI-Live consent steps in `ai-live-consent.spec.ts`, and the multi-tab pattern in `density-cross-tab.spec.ts`). Do not hand-roll new infrastructure.

- [ ] **Step 2: Run the e2e (Linux/CI parity)**

Run (from `frontend/`): the project's e2e command (see `.ai/docs/development-process.md`); generate the new visual baseline from the CI artifact per repo convention (do NOT hand-author baselines on win32).

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/ai-failure-surfacing.spec.ts
git commit -m "test(ai): #484 e2e AI failure toast + retry + backgrounded-tab"
```

---

## Self-Review

**1. Spec coverage:**
- Shared mechanism / report-clear opt-in → Task 1 (provider), Tasks 4–7 (all four hooks). ✓
- Coalesced persistent notification + Retry-all + dismiss → Tasks 1–3. ✓
- Retry in-flight "Retrying…" + partial recovery + full-recovery removal → Tasks 1 (retrying state) + 2 (button). ✓
- Stale pre-Retry resolution guard → Tasks 4–5 nonce guard (and inherent in summary/file-focus regenerate/retry). ✓
- Inline blocks coexist (summary/file-focus untouched) → Tasks 6–7 leave inline state, only add report/clear. ✓
- No notification for 204/off/not-subscribed/401 → Tasks 4–7 clear-not-report branches + 401 skip. ✓
- Active-PR-only render; backgrounded recorded-not-shown; non-PR route nothing → Task 1 (activeKey) + Task 3 test. ✓
- Close PR clears failures/retries → Task 8. ✓
- Live region announces appear/disappear only → Task 2 (stable sr-only phrase). ✓
- Tests + visual baseline → every task + Task 9. ✓

**2. Placeholder scan:** Task 8's test and Task 9's second test carry explicit "replace this with the real assertion / flesh out via existing helpers" notes rather than fabricated brittle code — these are deliberate, bounded instructions tied to existing patterns, not silent TODOs. All code steps that create production code show complete code.

**3. Type consistency:** `AiSeam`, `report`/`clear`/`clearPr`/`retryAll`/`dismiss`, `activeFailedSeams`/`retrying`/`dismissed`, and the `{ kind: 'auth' }` extensions are used consistently across Tasks 1–7. The retry closure is `regenerate` for summary, the existing `retry` for file-focus, and the new `retry` nonce for hunk/draft — all `() => void`, matching `FailureEntry.retry`.
