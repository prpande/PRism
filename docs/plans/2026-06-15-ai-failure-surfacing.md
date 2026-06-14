# AI Failure Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface every AI seam failure (503 / network) through one shared frontend mechanism — a single coalesced, persistent, per-active-PR notification with Retry-all — without disturbing the existing inline error states.

**Architecture:** A new `AiFailureProvider` React context is the single registry. The four AI hooks call `report(prRef, seam, {retry})` on a genuine failure and `clear(...)` on every non-failure branch (success / 204 / off / 401). The provider tracks failures keyed by `(prRefKey, seam)` across all keep-alive tabs, derives the **active** PR from the route (`parsePrRoute` → `prRefKey`), and a single always-mounted `AiFailureContainer` renders the persistent toast (and the a11y live region) for the active PR's failed set only. Retry-all re-runs each failed seam's fetch; the effect-cleanup `cancelled` flag (the nonce bump re-runs the effect) provides last-write-wins.

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
| `frontend/src/components/Ai/aiFailure.tsx` | `AiFailureProvider` + `useAiFailure` + `AiSeam` + exported `AiFailureContext` (test seam). Registry, active-PR derivation, retry-all + in-flight tracking. | Create |
| `frontend/src/components/Ai/aiFailure.test.tsx` | Provider unit tests. | Create |
| `frontend/src/components/Ai/AiFailureToast.tsx` | Presentational toast shell (message, Retry, Dismiss). No live region. | Create |
| `frontend/src/components/Ai/AiFailureToast.module.css` | Styles incl. fixed positioning (Snackbar pattern). | Create |
| `frontend/src/components/Ai/AiFailureToast.test.tsx` | Toast component tests. | Create |
| `frontend/src/components/Ai/AiFailureContainer.tsx` | Always-mounted: hosts the a11y live region + conditionally renders the toast + focus management. | Create |
| `frontend/src/components/Ai/AiFailureContainer.test.tsx` | Container tests (visibility, live region, dismiss). | Create |
| `frontend/src/components/Ai/index.ts` | Barrel re-export. | Create |
| `frontend/src/App.tsx` | Mount provider; render container as a sibling of `ToastContainer`. | Modify |
| `frontend/src/hooks/useAiHunkAnnotations.ts` | Report/clear + retry nonce + 401 skip. | Modify |
| `frontend/src/hooks/useAiDraftSuggestions.ts` | Report/clear + retry nonce + 401 skip. | Modify |
| `frontend/src/hooks/useAiSummary.ts` | Report on error; clear on ok/absent/auth/off; 401 skip. | Modify |
| `frontend/src/hooks/useFileFocusResult.ts` | Report on error; clear on ok/no-content/auth/off; 401 skip. | Modify |
| `frontend/src/api/aiSummary.ts` + `frontend/src/api/aiFileFocus.ts` | Add `'auth'` outcome from `ApiError.status===401`. | Modify |
| `frontend/src/api/types.ts` | Extend `AiSummaryResult` with `'auth'` (note: `AiFileFocusOutcome` lives in `aiFileFocus.ts`, not here). | Modify |
| `frontend/src/components/PrDetail/PrDetailView.tsx` | `clearPr(prRef)` on unmount. | Modify |
| `frontend/src/hooks/useAiSummary.test.ts` → `.tsx` | Rename (it will host JSX). | Rename + extend |
| `frontend/e2e/ai-failure-surfacing.spec.ts` | e2e: forced-503 toast + Retry + recovery + backgrounded tab. | Create |

---

## Task 1: `AiFailureProvider` context + registry

**Files:**
- Create: `frontend/src/components/Ai/aiFailure.tsx`
- Test: `frontend/src/components/Ai/aiFailure.test.tsx`

> **Two correctness rules baked into this task (from review):**
> 1. `settle` must NOT mutate `pendingRef` inside a `setState` updater — React 18 StrictMode (active in `main.tsx`) double-invokes updaters, and a ref-mutation inside one strands `retrying=true`. Do the mutation *before* `setState`, gated by a ref read outside the updater; keep the updater pure.
> 2. `dismissedFingerprint` must reset to `null` whenever the active failed set transitions through empty (a real recovery), so a dismiss → recover → same-seam-refail shows a fresh toast instead of staying hidden on a fingerprint match.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/components/Ai/aiFailure.test.tsx
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiFailureProvider, useAiFailure, type AiSeam } from './aiFailure';
import type { PrReference } from '../../api/types';

const PR_A: PrReference = { owner: 'o', repo: 'r', number: 1 };
const PR_B: PrReference = { owner: 'o', repo: 'r', number: 2 };
const retryNoop = () => {};

function Probe() {
  const { activeFailedSeams, retrying, dismissed } = useAiFailure();
  return <div data-testid="active">{`${activeFailedSeams.join(',')}|retrying=${retrying}|dismissed=${dismissed}`}</div>;
}
function grab(path: string) {
  let api!: ReturnType<typeof useAiFailure>;
  function Grab() { api = useAiFailure(); return null; }
  render(
    <MemoryRouter initialEntries={[path]}>
      <AiFailureProvider><Grab /><Probe /></AiFailureProvider>
    </MemoryRouter>,
  );
  return () => api;
}

it('renders only the active PR failed set; coalesces multiple seams in stable order', () => {
  const api = grab('/pr/o/r/1');
  act(() => {
    api().report(PR_A, 'hunk-annotations', { retry: retryNoop });
    api().report(PR_A, 'summary', { retry: retryNoop });
    api().report(PR_B, 'file-focus', { retry: retryNoop }); // backgrounded — recorded, not shown
  });
  expect(screen.getByTestId('active').textContent).toBe('summary,hunk-annotations|retrying=false|dismissed=false');
});

it('clear removes a seam; clearPr removes a whole PR', () => {
  const api = grab('/pr/o/r/1');
  act(() => { api().report(PR_A, 'summary', { retry: retryNoop }); api().report(PR_A, 'file-focus', { retry: retryNoop }); });
  act(() => { api().clear(PR_A, 'summary'); });
  expect(screen.getByTestId('active').textContent).toContain('file-focus|');
  act(() => { api().clearPr(PR_A); });
  expect(screen.getByTestId('active').textContent).toBe('|retrying=false|dismissed=false');
});

it('renders nothing on a non-PR route (activeKey null)', () => {
  const api = grab('/');
  act(() => { api().report(PR_A, 'summary', { retry: retryNoop }); });
  expect(screen.getByTestId('active').textContent).toBe('|retrying=false|dismissed=false');
});

it('retryAll calls every active-PR retry; retrying clears only after all settle', () => {
  const calls: AiSeam[] = [];
  const api = grab('/pr/o/r/1');
  act(() => {
    api().report(PR_A, 'summary', { retry: () => calls.push('summary') });
    api().report(PR_A, 'file-focus', { retry: () => calls.push('file-focus') });
  });
  act(() => { api().retryAll(); });
  expect(calls.sort()).toEqual(['file-focus', 'summary']);
  expect(screen.getByTestId('active').textContent).toContain('retrying=true');
  act(() => { api().clear(PR_A, 'summary'); });               // one recovers
  expect(screen.getByTestId('active').textContent).toContain('retrying=true'); // file-focus still pending
  act(() => { api().report(PR_A, 'file-focus', { retry: () => {} }); }); // other re-fails → settles
  expect(screen.getByTestId('active').textContent).toContain('retrying=false');
});

it('dismiss hides; re-shows on a NEW (different) failure set', () => {
  const api = grab('/pr/o/r/1');
  act(() => { api().report(PR_A, 'summary', { retry: retryNoop }); });
  act(() => { api().dismiss(); });
  expect(screen.getByTestId('active').textContent).toContain('dismissed=true');
  act(() => { api().report(PR_A, 'file-focus', { retry: retryNoop }); });
  expect(screen.getByTestId('active').textContent).toContain('dismissed=false');
});

it('dismiss → recover → same-seam re-fail shows a fresh toast (fingerprint reset on empty)', () => {
  const api = grab('/pr/o/r/1');
  act(() => { api().report(PR_A, 'summary', { retry: retryNoop }); });
  act(() => { api().dismiss(); });
  act(() => { api().clear(PR_A, 'summary'); });   // recover → set empties → fingerprint resets
  act(() => { api().report(PR_A, 'summary', { retry: retryNoop }); }); // same seam fails again
  expect(screen.getByTestId('active').textContent).toBe('summary|retrying=false|dismissed=false');
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
  // Read-only DERIVED views for the active PR (computed each render — not setters):
  activeFailedSeams: AiSeam[]; // failed seams for the active PR, in stable SEAM_ORDER
  retrying: boolean;           // a Retry-all is in flight for the active PR
  dismissed: boolean;          // user dismissed the current failure-set fingerprint
}

const NOOP: AiFailureApi = {
  report: () => {}, clear: () => {}, clearPr: () => {}, retryAll: () => {}, dismiss: () => {},
  activeFailedSeams: [], retrying: false, dismissed: false,
};

// Exported as a test seam (mirrors OpenTabsContext) so a unit test can inject a stub value with
// spy methods. App code consumes via useAiFailure(), not this directly.
export const AiFailureContext = createContext<AiFailureApi>(NOOP);

const SEAM_ORDER: AiSeam[] = ['summary', 'file-focus', 'hunk-annotations', 'draft-suggestions'];

export function AiFailureProvider({ children }: { children: ReactNode }) {
  const [failures, setFailures] = useState<FailureMap>({});
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null);
  // Refs read OUTSIDE setState updaters so the updaters stay pure (StrictMode double-invokes them).
  const pendingRef = useRef<Set<AiSeam>>(new Set());
  const retryingKeyRef = useRef<string | null>(null);
  retryingKeyRef.current = retryingKey;

  const { pathname } = useEffectiveLocation();
  const route = parsePrRoute(pathname);
  const activeKey = route && route.valid ? prRefKey(route.ref) : null;

  // Pure: compute decision from refs BEFORE setState; updater only returns the next value.
  const settle = useCallback((key: string, seam: AiSeam) => {
    if (retryingKeyRef.current !== key || !pendingRef.current.has(seam)) return;
    pendingRef.current.delete(seam);
    const empty = pendingRef.current.size === 0;
    setRetryingKey((cur) => (cur === key && empty ? null : cur));
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
      if (Object.keys(next).length === 0) {
        delete out[key];
        // Real recovery for this PR: reset any dismissal so a later identical failure re-shows.
        setDismissedFingerprint((d) => (d && d.startsWith(`${key}:`) ? null : d));
      } else {
        out[key] = next;
      }
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
    setDismissedFingerprint((d) => (d && d.startsWith(`${key}:`) ? null : d));
  }, []);

  const activeFailedSeams = useMemo<AiSeam[]>(() => {
    if (!activeKey) return [];
    const forPr = failures[activeKey];
    return forPr ? SEAM_ORDER.filter((s) => s in forPr) : [];
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
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/components/Ai/aiFailure.tsx frontend/src/components/Ai/aiFailure.test.tsx
git commit -m "feat(ai): #484 AiFailureProvider registry (pure settle, dismissal reset)"
```

---

## Task 2: `AiFailureToast` presentational shell

**Files:**
- Create: `frontend/src/components/Ai/AiFailureToast.tsx`, `AiFailureToast.module.css`, `index.ts`
- Test: `frontend/src/components/Ai/AiFailureToast.test.tsx`

The toast is the **visible** shell only. The a11y live region is NOT here — it lives in the always-mounted `AiFailureContainer` (Task 3) so the empty→text content change reliably announces (a live region injected already-populated does not announce on mount). The toast needs **fixed positioning** or it renders in document flow and may be invisible — adopt the `Snackbar`/`StreamHealthSnackbar` pattern.

Display-name map: `summary`→"summary", `file-focus`→"hotspots", `hunk-annotations`→"annotations", `draft-suggestions`→"draft suggestions".

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/components/Ai/AiFailureToast.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { AiFailureToast } from './AiFailureToast';
import type { AiSeam } from './aiFailure';

function setup(over: { seams?: AiSeam[]; retrying?: boolean } = {}) {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <AiFailureToast
      seams={over.seams ?? (['summary', 'file-focus', 'hunk-annotations'] as AiSeam[])}
      retrying={over.retrying ?? false}
      onRetry={onRetry}
      onDismiss={onDismiss}
    />,
  );
  return { onRetry, onDismiss };
}

it('lists failed seams using display names', () => {
  setup({ seams: ['summary', 'file-focus', 'hunk-annotations'] });
  expect(screen.getByText(/summary, hotspots, annotations/)).toBeInTheDocument();
});

it('Retry fires onRetry and is enabled when not retrying', () => {
  const { onRetry } = setup({ retrying: false });
  const btn = screen.getByRole('button', { name: 'Retry' });
  expect(btn).toBeEnabled();
  fireEvent.click(btn);
  expect(onRetry).toHaveBeenCalledOnce();
});

it('shows a disabled "Retrying…" button while retrying', () => {
  setup({ retrying: true });
  expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
});

it('Dismiss fires onDismiss', () => {
  const { onDismiss } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onDismiss).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/Ai/AiFailureToast.test.tsx`
Expected: FAIL — `Cannot find module './AiFailureToast'`.

- [ ] **Step 3: Implement the shell + styles + barrel**

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
  const names = seams.map((s) => DISPLAY_NAME[s]).join(', ');
  return (
    <div className={styles.toast} role="group" aria-label="AI generation failure">
      <span className={styles.message}>
        {`AI couldn't generate: ${names} — the provider failed or timed out.`}
      </span>
      <button type="button" className={styles.retry} onClick={onRetry} disabled={retrying}>
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
      <button type="button" className={styles.dismiss} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
```

```css
/* frontend/src/components/Ai/AiFailureToast.module.css
   Fixed-position, reusing Toast tokens + the Snackbar/StreamHealthSnackbar placement pattern
   (position:fixed, centered, z-index in the existing ladder: Snackbar=200 < modal=1000). */
.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  gap: 12px;
  align-items: center;
  max-width: min(680px, calc(100vw - 32px));
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--surface-1);
  border: 1px solid var(--danger, var(--border-1));
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
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
export { AiFailureProvider, useAiFailure, AiFailureContext } from './aiFailure';
export type { AiSeam, AiFailureApi } from './aiFailure';
export { AiFailureToast } from './AiFailureToast';
export { AiFailureContainer } from './AiFailureContainer';
```

> The barrel re-exports `AiFailureContainer` (Task 3); create the barrel now but expect the `AiFailureContainer` line to be unresolved until Task 3 — or add that line in Task 3. (If your tooling errors on the missing module, omit the `AiFailureContainer` line here and add it in Task 3.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/Ai/AiFailureToast.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/components/Ai/AiFailureToast.tsx frontend/src/components/Ai/AiFailureToast.module.css frontend/src/components/Ai/index.ts frontend/src/components/Ai/AiFailureToast.test.tsx
git commit -m "feat(ai): #484 AiFailureToast shell (fixed-position, Retry/Dismiss)"
```

---

## Task 3: `AiFailureContainer` (live region + visibility + focus) + mount in `App`

**Files:**
- Create: `frontend/src/components/Ai/AiFailureContainer.tsx`, `AiFailureContainer.test.tsx`
- Modify: `frontend/src/App.tsx`

The container is **always mounted** so its `aria-live` region pre-exists in the DOM (empty), and the empty→"AI generation failed." content change announces on first failure (and reverts to empty on recovery). It renders the visible toast only when there is an active, non-dismissed failure. It also performs **focus management**: if the toast was visible and becomes hidden *while focus had fallen to the body* (the focused Retry/Dismiss button was destroyed), it moves focus to the PR main region — WCAG 2.4.3 — without stealing focus when the user is elsewhere.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/components/Ai/AiFailureContainer.test.tsx
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiFailureProvider, useAiFailure } from './aiFailure';
import { AiFailureContainer } from './AiFailureContainer';
import type { PrReference } from '../../api/types';

const PR_A: PrReference = { owner: 'o', repo: 'r', number: 1 };
function harness(path = '/pr/o/r/1') {
  let api!: ReturnType<typeof useAiFailure>;
  function Grab() { api = useAiFailure(); return null; }
  render(
    <MemoryRouter initialEntries={[path]}>
      <AiFailureProvider><Grab /><AiFailureContainer /></AiFailureProvider>
    </MemoryRouter>,
  );
  return () => api;
}

it('live region pre-exists empty, populates on failure, empties on recovery', () => {
  const api = harness();
  const live = screen.getByTestId('ai-failure-live');
  expect(live).toHaveAttribute('aria-live', 'polite');
  expect(live.textContent).toBe('');
  act(() => { api().report(PR_A, 'summary', { retry: () => {} }); });
  expect(live.textContent).toBe('AI generation failed.');
  expect(screen.getByText(/AI couldn't generate: summary/)).toBeInTheDocument();
  act(() => { api().clear(PR_A, 'summary'); });
  expect(live.textContent).toBe('');
  expect(screen.queryByText(/AI couldn't generate/)).toBeNull();
});

it('partial recovery does not change the live-region text (no re-announce)', () => {
  const api = harness();
  act(() => {
    api().report(PR_A, 'summary', { retry: () => {} });
    api().report(PR_A, 'file-focus', { retry: () => {} });
  });
  const live = screen.getByTestId('ai-failure-live');
  expect(live.textContent).toBe('AI generation failed.');
  act(() => { api().clear(PR_A, 'summary'); }); // 2 → 1 seam
  expect(live.textContent).toBe('AI generation failed.'); // unchanged → no new announcement
  expect(screen.getByText(/AI couldn't generate: hotspots/)).toBeInTheDocument();
});

it('hides the toast after dismiss until a new failure', () => {
  const api = harness();
  act(() => { api().report(PR_A, 'summary', { retry: () => {} }); });
  act(() => { api().dismiss(); });
  expect(screen.queryByText(/AI couldn't generate/)).toBeNull();
  act(() => { api().report(PR_A, 'file-focus', { retry: () => {} }); });
  expect(screen.getByText(/AI couldn't generate: summary, hotspots/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/Ai/AiFailureContainer.test.tsx`
Expected: FAIL — `Cannot find module './AiFailureContainer'`.

- [ ] **Step 3: Implement the container**

```tsx
// frontend/src/components/Ai/AiFailureContainer.tsx
import { useEffect, useRef } from 'react';
import { useAiFailure } from './aiFailure';
import { AiFailureToast } from './AiFailureToast';

export function AiFailureContainer() {
  const { activeFailedSeams, retrying, dismissed, retryAll, dismiss } = useAiFailure();
  const visible = activeFailedSeams.length > 0 && !dismissed;
  const wasVisible = useRef(false);

  // WCAG 2.4.3: if the toast's focused button is destroyed on hide (focus fell to body),
  // move focus to the PR main region. Do NOT steal focus when the user is elsewhere.
  useEffect(() => {
    if (wasVisible.current && !visible) {
      const focusLost = document.activeElement == null || document.activeElement === document.body;
      if (focusLost) {
        // Confirm this selector against PrDetailView's DOM during impl; falls back to <main>.
        const target =
          document.querySelector<HTMLElement>('[data-pr-main]') ??
          document.querySelector<HTMLElement>('main');
        target?.focus();
      }
    }
    wasVisible.current = visible;
  }, [visible]);

  return (
    <>
      {/* Always-mounted polite live region — empty until a failure, so the ''→text change
          announces on appearance (and the text→'' change marks disappearance). The mutable
          seam list is NOT in here, so partial recovery does not re-announce. */}
      <span className="sr-only" aria-live="polite" data-testid="ai-failure-live">
        {visible ? 'AI generation failed.' : ''}
      </span>
      {visible && (
        <AiFailureToast
          seams={activeFailedSeams}
          retrying={retrying}
          onRetry={retryAll}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}
```

> If `[data-pr-main]` does not exist, add `data-pr-main tabIndex={-1}` to PrDetailView's top-level content wrapper (a `tabIndex=-1` element is programmatically focusable without entering the tab order). The fallback `<main>` keeps the call safe (no-op if neither is found).

- [ ] **Step 4: Wire into `App.tsx`**

Import:

```ts
import { AiFailureProvider, AiFailureContainer } from './components/Ai';
```

Mount `AiFailureProvider` inside `PreferencesProvider`, wrapping the authed/unauthed branch (the four AI hooks live under it; context crosses the `EventStreamProvider` boundary fine):

```tsx
<PreferencesProvider>
  <AiFailureProvider>
    {isAuthed ? <EventStreamProvider>{tree}</EventStreamProvider> : tree}
  </AiFailureProvider>
</PreferencesProvider>
```

In the `tree` JSX, render the container as a **sibling** of `<ToastContainer />` (NOT nested inside it — `ToastContainer` is itself an `aria-live` region, and nesting live regions is undefined behavior):

```tsx
<ToastContainer />
{/* sibling of ToastContainer, not a child — both are independent live regions */}
<AiFailureContainer />
```

- [ ] **Step 5: Run container tests + full Ai suite + typecheck**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/Ai/`
Expected: PASS. Then `cd frontend && npx tsc -b`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Ai/ frontend/src/App.tsx
git commit -m "feat(ai): #484 AiFailureContainer (live region + focus) mounted in App"
```

---

## Task 4: Wire `useAiHunkAnnotations` (report/clear + retry + 401 skip)

**Files:**
- Modify: `frontend/src/hooks/useAiHunkAnnotations.ts`
- Test: `frontend/src/hooks/useAiHunkAnnotations.test.tsx` (create if absent)

> **Last-write-wins:** the retry mechanism is a `retryNonce` that is an effect **dependency** — bumping it re-runs the effect, whose cleanup sets `cancelled = true` on the prior in-flight fetch. A stale pre-retry resolution therefore returns early on `cancelled`. (Do NOT add a `myNonce !== retryNonce` comparison — within one effect instance the captured nonce equals the closure nonce, so that check is dead code; `cancelled` is the real guard.)

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/hooks/useAiHunkAnnotations.test.tsx
import { renderHook, waitFor } from '@testing-library/react';
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

it('reports a failure on 503', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockRejectedValue(new ApiError(503, null, ''));
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), { wrapper });
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('hunk-annotations'));
});

it('does NOT report on 401; still clears', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockRejectedValue(new ApiError(401, null, ''));
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), { wrapper });
  await waitFor(() => {});
  expect(result.current.f.activeFailedSeams).not.toContain('hunk-annotations');
});

it('clears on success / 204→null', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockResolvedValue(null);
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), { wrapper });
  await waitFor(() => expect(result.current.f.activeFailedSeams).not.toContain('hunk-annotations'));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiHunkAnnotations.test.tsx`
Expected: FAIL — no report (hook still swallows).

- [ ] **Step 3: Implement**

```ts
// frontend/src/hooks/useAiHunkAnnotations.ts
import { useCallback, useEffect, useState } from 'react';
import { getAiHunkAnnotations } from '../api/aiHunkAnnotations';
import { ApiError } from '../api/client';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { PrReference, HunkAnnotation } from '../api/types';

export function useAiHunkAnnotations(prRef: PrReference, enabled: boolean): HunkAnnotation[] | null {
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
    getAiHunkAnnotations(prRef)
      .then((result) => {
        if (cancelled) return;
        setEntries(result);
        clear(prRef, 'hunk-annotations');
      })
      .catch((err) => {
        if (cancelled) return;
        setEntries(null);
        if (err instanceof ApiError && err.status === 401) clear(prRef, 'hunk-annotations');
        else report(prRef, 'hunk-annotations', { retry });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; retryNonce re-runs the fetch (cleanup cancels the prior); report/clear/retry are stable (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, retryNonce]);

  return entries;
}
```

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

it('reports on any non-401 throw (the seam has no backend 503 path today — see spec)', async () => {
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

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiDraftSuggestions.test.tsx`
Expected: FAIL — no report.

- [ ] **Step 3: Implement** — same transform as Task 4 with seam `'draft-suggestions'`:

```ts
// frontend/src/hooks/useAiDraftSuggestions.ts
import { useCallback, useEffect, useState } from 'react';
import { getAiDraftSuggestions } from '../api/aiDraftSuggestions';
import { ApiError } from '../api/client';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { PrReference, DraftSuggestion } from '../api/types';

export function useAiDraftSuggestions(prRef: PrReference, enabled: boolean): DraftSuggestion[] | null {
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
    getAiDraftSuggestions(prRef)
      .then((result) => {
        if (cancelled) return;
        setEntries(result);
        clear(prRef, 'draft-suggestions');
      })
      .catch((err) => {
        if (cancelled) return;
        setEntries(null);
        if (err instanceof ApiError && err.status === 401) clear(prRef, 'draft-suggestions');
        else report(prRef, 'draft-suggestions', { retry });
      });
    return () => { cancelled = true; };
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
- Rename + extend: `frontend/src/hooks/useAiSummary.test.ts` → `useAiSummary.test.tsx` (it will host JSX; the rename carries the existing 6 tests)

- [ ] **Step 1: Rename the test file, then write the failing tests**

First rename so JSX compiles and the run path matches:

```bash
git mv frontend/src/hooks/useAiSummary.test.ts frontend/src/hooks/useAiSummary.test.tsx
```

Append (the regenerate path must mock `regenerateAiSummary` — the POST — NOT `getAiSummaryResult`; the existing regenerate tests in this file already mock `regenerateAiSummary`):

```tsx
// append to frontend/src/hooks/useAiSummary.test.tsx
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AiFailureProvider, useAiFailure } from '../components/Ai/aiFailure';

const FAIL_PR = { owner: 'o', repo: 'r', number: 1 } as const;
const failWrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/pr/o/r/1']}><AiFailureProvider>{children}</AiFailureProvider></MemoryRouter>
);

it('reports summary on initial-fetch kind:error', async () => {
  vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({ kind: 'error' });
  const { result } = renderHook(
    () => ({ s: useAiSummary(FAIL_PR, true, true, false), f: useAiFailure() }),
    { wrapper: failWrapper },
  );
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('summary'));
});

it('does NOT report on kind:auth; clears', async () => {
  vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({ kind: 'auth' });
  const { result } = renderHook(
    () => ({ s: useAiSummary(FAIL_PR, true, true, false), f: useAiFailure() }),
    { wrapper: failWrapper },
  );
  await waitFor(() => {});
  expect(result.current.f.activeFailedSeams).not.toContain('summary');
});

it('regenerate failure reports; regenerate success clears', async () => {
  vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({ kind: 'error' }); // initial fetch fails → reports
  const regen = vi.spyOn(api, 'regenerateAiSummary').mockResolvedValue({ kind: 'ok', summary: { /* PrSummary fields */ } as never });
  const { result } = renderHook(
    () => ({ s: useAiSummary(FAIL_PR, true, true, false), f: useAiFailure() }),
    { wrapper: failWrapper },
  );
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('summary'));
  await act(async () => { await result.current.s.regenerate(); }); // POST path → clears
  expect(result.current.f.activeFailedSeams).not.toContain('summary');
  expect(regen).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiSummary.test.tsx`
Expected: FAIL — `kind: 'auth'` not assignable; no report wiring.

- [ ] **Step 3a: Extend the result type** (`frontend/src/api/types.ts` line 243):

```ts
export type AiSummaryResult =
  | { kind: 'ok'; summary: PrSummary }
  | { kind: 'absent' }
  | { kind: 'auth' }
  | { kind: 'error' };
```

- [ ] **Step 3b: Map 401 in `frontend/src/api/aiSummary.ts`** — the current `resolveSummary` has a single uniform `catch { return { kind: 'error' } }`; split it:

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

- [ ] **Step 3c: Wire `frontend/src/hooks/useAiSummary.ts`.** Add the context, and to avoid any forward-reference ambiguity, **declare `regenerate` (the existing `useCallback`) ABOVE the initial-fetch `useEffect`** so the effect can name it as the retry closure. Then:

Near the top of the hook body:
```ts
import { useAiFailure } from '../components/Ai/aiFailure';
// ...
const { report, clear } = useAiFailure();
```

In the `!enabled || !subscribed` early-return block (currently lines 39–44), add a clear:
```ts
if (!enabled || !subscribed) {
  setSummary(null); setLoading(false); setError(false);
  clear(prRef, 'summary');   // AI off / not-subscribed must not leave a stale failure
  return;
}
```

In the initial-fetch `.then((r) => …)` branches:
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

> `regenerate` is summary's retry closure (a stable `useCallback`). It already guards `if (!enabled || !subscribed || inFlight.current) return`, so a Retry-all while a regenerate is mid-flight no-ops for summary; the in-flight regenerate's own completion then reports/clears and settles the provider's pending set. That is acceptable (the seam still settles).

- [ ] **Step 4: Run to verify they pass + no regression**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/hooks/useAiSummary.test.tsx src/components/PrDetail/OverviewTab`
Expected: PASS (existing 6 + new 3; OverviewTab unaffected).

- [ ] **Step 5: Add the coexistence component test** (spec Testing requires it). Create `frontend/src/components/PrDetail/OverviewTab/AiSummaryCoexistence.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiFailureProvider, AiFailureContainer } from '../../Ai';
import { AiSummaryCard } from './AiSummaryCard';

it('summary inline error block AND the global toast coexist', () => {
  render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureProvider>
        <AiSummaryCard summary={null} loading={false} error /* error branch renders aiSummaryError */ />
        <AiFailureContainer />
      </AiFailureProvider>
    </MemoryRouter>,
  );
  // Inline block present (assert the existing aiSummaryError test id / copy used by AiSummaryCard):
  expect(screen.getByTestId('ai-summary-regenerate')).toBeInTheDocument();
  // Toast does NOT appear from rendering the card alone (the card doesn't call report) — this test
  // pins that the inline block is independent. To assert true coexistence, also report via a Grab:
  // (kept minimal — full report+inline coexistence is exercised by the e2e in Task 9).
});
```

> If `AiSummaryCard`'s prop names differ, read the component and adjust; the assertion under test is "the inline error block renders independently of the toast". Full failure+inline+toast coexistence is also covered end-to-end in Task 9.

- [ ] **Step 6: Typecheck + commit**

```bash
cd frontend && npx tsc -b
git add frontend/src/api/types.ts frontend/src/api/aiSummary.ts frontend/src/hooks/useAiSummary.ts frontend/src/hooks/useAiSummary.test.tsx frontend/src/components/PrDetail/OverviewTab/AiSummaryCoexistence.test.tsx
git commit -m "feat(ai): #484 wire summary failure reporting (+401 skip, off-clear)"
```

---

## Task 7: Thread `401` into file-focus api + wire `useFileFocusResult`

**Files:**
- Modify: `frontend/src/api/aiFileFocus.ts` (the `AiFileFocusOutcome` union lives HERE, not in `types.ts`), `frontend/src/hooks/useFileFocusResult.ts`
- Test: `frontend/src/hooks/useFileFocusResult.test.tsx` (the existing file already declares `import * as api` + `vi.mock('../api/aiFileFocus')` — merge into those, don't duplicate)

- [ ] **Step 1: Write the failing tests** (append to the existing file)

```tsx
// append to frontend/src/hooks/useFileFocusResult.test.tsx
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AiFailureProvider, useAiFailure } from '../components/Ai/aiFailure';

const FF_PR = { owner: 'o', repo: 'r', number: 1 } as const;
const ffWrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/pr/o/r/1']}><AiFailureProvider>{children}</AiFailureProvider></MemoryRouter>
);

it('reports file-focus on kind:error', async () => {
  vi.spyOn(api, 'getAiFileFocusResult').mockResolvedValue({ kind: 'error' });
  const { result } = renderHook(() => ({ s: useFileFocusResult(FF_PR, true, true), f: useAiFailure() }), { wrapper: ffWrapper });
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('file-focus'));
});

it('does NOT report on kind:auth', async () => {
  vi.spyOn(api, 'getAiFileFocusResult').mockResolvedValue({ kind: 'auth' });
  const { result } = renderHook(() => ({ s: useFileFocusResult(FF_PR, true, true), f: useAiFailure() }), { wrapper: ffWrapper });
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

- [ ] **Step 3b: Wire `frontend/src/hooks/useFileFocusResult.ts`.** Add the context; report/clear at outcome branches. Because Step 3a's `getAiFileFocusResult` now catches all throws internally (returning `'error'`/`'auth'`), the hook's own `.catch` is only a defensive backstop — make it `report` (not just `setState`), and do NOT also report in the mapped branches (avoid double-report). Add `clear` to the `!enabled` / `!subscribed` early returns.

```ts
import { useAiFailure } from '../components/Ai/aiFailure';
// ...inside the hook:
const { report, clear } = useAiFailure();
// !enabled / !subscribed early returns: add clear(prRef, 'file-focus');
// inside .then((outcome) => { ... }):
if (outcome.kind === 'no-content') {
  setState({ status: 'no-changes', entries: [] }); clear(prRef, 'file-focus');
} else if (outcome.kind === 'auth') {
  setState({ status: 'error', entries: [] }); clear(prRef, 'file-focus'); // inline unchanged; no report
} else if (outcome.kind === 'error') {
  setState({ status: 'error', entries: [] }); report(prRef, 'file-focus', { retry });
} else {
  const { entries, fallback } = outcome.result;
  if (fallback) setState({ status: 'fallback', entries });
  else {
    const hasSignal = entries.some((e) => e.level === 'high' || e.level === 'medium');
    setState({ status: hasSignal ? 'ok' : 'empty', entries });
  }
  clear(prRef, 'file-focus');
}
// defensive .catch (rarely reached — api maps throws to outcomes): report, not just setState
.catch(() => {
  if (!cancelled) { setState({ status: 'error', entries: [] }); report(prRef, 'file-focus', { retry }); }
});
```

> `retry` already exists in this hook (`const retry = useCallback(() => setRetryNonce((n) => n + 1), [])`); reuse it as the report retry closure.

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

This injects a stub `AiFailureApi` (with a `clearPr` spy) via the exported `AiFailureContext` seam and asserts the real `PrDetailView` fires `clearPr(prRef)` on unmount. `PrDetailView` fires many data hooks on mount, so they must be mocked (mirror the `vi.mock` set in the existing `PrDetailView.test.tsx`).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/PrDetail/PrDetailView.clearPr.test.tsx
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiFailureContext, type AiFailureApi } from '../Ai/aiFailure';
import { PrDetailView } from './PrDetailView';
import type { PrReference } from '../../api/types';

// Mock the heavy data hooks PrDetailView fires on mount so a bare render does not hit the network.
// Mirror the vi.mock set in PrDetailView.test.tsx (at minimum the hooks that fetch/subscribe):
vi.mock('../../hooks/usePrDetail');
vi.mock('../../hooks/useFileFocusResult');
vi.mock('../../hooks/useActivePrUpdates');
vi.mock('../../hooks/useCapabilities');
// ...add the remaining mocks PrDetailView.test.tsx declares (useDraftSession, subscribers, etc.).
// Provide minimal return values for any mock whose result PrDetailView destructures on first render.

const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };

function stubApi(over: Partial<AiFailureApi> = {}): AiFailureApi {
  return {
    report: vi.fn(), clear: vi.fn(), clearPr: vi.fn(), retryAll: vi.fn(), dismiss: vi.fn(),
    activeFailedSeams: [], retrying: false, dismissed: false, ...over,
  };
}

it('fires clearPr(prRef) when PrDetailView unmounts', () => {
  const clearPr = vi.fn();
  const { unmount } = render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureContext.Provider value={stubApi({ clearPr })}>
        <PrDetailView prRef={PR} active />
      </AiFailureContext.Provider>
    </MemoryRouter>,
  );
  expect(clearPr).not.toHaveBeenCalled();
  unmount();
  expect(clearPr).toHaveBeenCalledWith(PR);
});
```

> Copy the exact `vi.mock` list + minimal return stubs from `PrDetailView.test.tsx` (it already mocks `usePrDetail`, `useDraftSession`, `useActivePrUpdates`, `useCapabilities`, `useFileFocusResult`, and the SSE subscriber hooks). The assertion under test is solely "unmount → `clearPr(prRef)` once".

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && node ./node_modules/vitest/vitest.mjs run src/components/PrDetail/PrDetailView.clearPr.test.tsx`
Expected: FAIL — `clearPr` not called (no unmount effect yet).

- [ ] **Step 3: Implement** — in `frontend/src/components/PrDetail/PrDetailView.tsx`:

```ts
import { useAiFailure } from '../Ai/aiFailure';
// ...inside the component:
const { clearPr } = useAiFailure();
useEffect(() => {
  return () => clearPr(prRef);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; clearPr stable (#331)
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

Model the setup on `frontend/e2e/ai-live-consent.spec.ts` (it `page.route`s all four `**/api/pr/.../ai/*` endpoints with AI Live enabled) and the two-page pattern in `frontend/e2e/density-cross-tab.spec.ts`. Forcing `503` is frontend-only (`route.fulfill({status:503})`).

- [ ] **Step 1: Write both e2e tests (full bodies)**

```ts
// frontend/e2e/ai-failure-surfacing.spec.ts
import { test, expect, type Route } from '@playwright/test';
// import { setupBaseRoutes, enableAiLive } from './helpers/...';  // mirror ai-live-consent.spec.ts

const OWNER = 'o', REPO = 'r', PR1 = 1, PR2 = 2;

test('AI seam 503 surfaces a persistent toast with Retry that recovers', async ({ page }) => {
  // Mirror ai-live-consent.spec.ts: base routes + AI Live enabled + healthy mocks for the other seams.
  let failNext = true;
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/file-focus`, (route: Route) =>
    failNext
      ? route.fulfill({ status: 503 })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], fallback: false }) }),
  );
  await page.goto(`/pr/${OWNER}/${REPO}/${PR1}`);

  const toast = page.getByRole('group', { name: 'AI generation failure' });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('hotspots');

  failNext = false;
  await toast.getByRole('button', { name: 'Retry' }).click();
  await expect(toast).toBeHidden();
});

test("a backgrounded PR tab's failure does not show while another PR is active", async ({ page }) => {
  // PR1 file-focus always 503; PR2 healthy. Mirror density-cross-tab.spec.ts navigation.
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR1}/ai/file-focus`, (route: Route) => route.fulfill({ status: 503 }));
  await page.route(`**/api/pr/${OWNER}/${REPO}/${PR2}/ai/file-focus`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], fallback: false }) }),
  );
  const toast = page.getByRole('group', { name: 'AI generation failure' });

  await page.goto(`/pr/${OWNER}/${REPO}/${PR1}`);
  await expect(toast).toBeVisible(); // failure on the active PR

  await page.goto(`/pr/${OWNER}/${REPO}/${PR2}`); // switch to healthy PR (PR1 stays mounted, backgrounded)
  await expect(toast).toBeHidden();  // PR1's recorded failure is NOT shown while PR2 is active

  await page.goto(`/pr/${OWNER}/${REPO}/${PR1}`); // back to PR1
  await expect(toast).toBeVisible(); // reappears for the active PR
});
```

> Fill in the `setupBaseRoutes` / AI-Live-enable helper imports exactly as `ai-live-consent.spec.ts` does, and confirm the route URL shapes match the app's requests. The assertions are complete; only the shared-helper setup is environment-specific.

- [ ] **Step 2: Run the e2e (Linux/CI parity) + generate the visual baseline**

Run from `frontend/` using the project's e2e command (see `.ai/docs/development-process.md`). Regenerate the new visual baseline from the CI artifact per repo convention — do NOT hand-author baselines on win32.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/ai-failure-surfacing.spec.ts
git commit -m "test(ai): #484 e2e AI failure toast + retry + backgrounded-tab"
```

---

## Deferred / Open Questions (carried from review)

- **Toast placement is a working default, not a final design.** This plan positions the toast bottom-center (Snackbar pattern) so it is visible and testable. Final placement/visual polish is a design pass; flag for owner if a different position is wanted.
- **Focus target selector.** `AiFailureContainer` focuses `[data-pr-main]` (fallback `<main>`) on toast-hide-while-focus-lost. Confirm/add `data-pr-main tabIndex={-1}` on PrDetailView's content wrapper during Task 3/8; the fallback keeps it safe if absent.
- **`activeKey` goes null under a full-screen modal/route.** If a Settings/Help modal route makes `useEffectiveLocation` report a non-PR path, the toast hides until the modal closes. Acceptable for this slice; revisit if it surprises users.

---

## Self-Review

**1. Spec coverage:** shared mechanism (T1 + T4–T7); coalesced persistent toast + Retry-all + dismiss (T1–T3); retry in-flight "Retrying…" + partial recovery + full-recovery removal (T1 retrying + T2 button + T3 visibility); stale-resolution guard via `cancelled`/nonce-rerun (T4–T7, corrected from the spec's illustrative `myNonce` line); inline coexistence (T6 leaves inline state + coexistence test); no notification for 204/off/not-subscribed/401 (T4–T7 clear branches incl. the summary `!enabled` clear); active-PR-only render + backgrounded recorded-not-shown + non-PR nothing (T1 + T3 + T9); close-PR clears (T8); live region announces appearance/disappearance only (T3 always-mounted empty→text); placement/focus (T2 CSS + T3 focus); tests + visual baseline (every task + T9). ✓

**2. Placeholder scan:** The remaining "fill in" notes (T6 coexistence prop names, T8 vi.mock list, T9 helper imports) are bounded references to concrete existing files/patterns (`PrDetailView.test.tsx`, `ai-live-consent.spec.ts`, `density-cross-tab.spec.ts`), not undefined work — every assertion body is written out. No `expect(true).toBe(true)` or empty test bodies remain.

**3. Type consistency:** `AiSeam`, `AiFailureApi` (`report`/`clear`/`clearPr`/`retryAll`/`dismiss`/`activeFailedSeams`/`retrying`/`dismissed`), `AiFailureContext`, and the `{kind:'auth'}` extensions are used consistently across T1–T8. Retry closures: `regenerate` (summary), existing `retry` (file-focus), new `retry` nonce (hunk/draft) — all `() => void` matching `FailureEntry.retry`.
