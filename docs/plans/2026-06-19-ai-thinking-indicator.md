# AI "thinking" indicator — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the PR-detail AI surfaces (summary, file-tree focus, hunk annotator) a consistent "AI is thinking" cue, on a shared four-value load-state contract and a shared `AiMarker` working state.

**Architecture:** Introduce an `AiLoadState` type; lift the two bare-`null` PR-detail hooks (`useAiHunkAnnotations`, `useAiDraftSuggestions`) to `{ state, data }`; extend the existing `AiMarker` (#489) with a `state="working"` variant differentiated by a `--ai-working-color` hue token (not motion, so it survives `prefers-reduced-motion`); wire the cue into the summary card, the file-tree header, and the diff annotator. This is Slice 1 of the design in `docs/specs/2026-06-19-ai-thinking-indicator-design.md`. Slice 2 (Hotspots tab marker + skeleton regen, inbox chip + its backend settled-signal, draft-suggestion overlay) is a separate plan written after this lands.

**Tech Stack:** React 18 + TypeScript + Vite, CSS Modules + global `tokens.css`, Vitest + Testing Library, Playwright (visual e2e).

## Global Constraints

- Branch base: **V2** (worktree `feature/ai-thinking-indicator`). Run all commands from the worktree root `D:/src/PRism/.claude/worktrees/ai-thinking-indicator`.
- **No change to AI behaviour/output** — thresholds, which files/hunks are flagged, summarizer content are untouched. State-plumbing + visuals only.
- The **only** indicator component is `AiMarker`; do not introduce a parallel one.
- The working↔idle differentiator is the **`--ai-working-color` hue token, not motion**; under `prefers-reduced-motion` the pulse is dropped and the hue alone differentiates.
- `error` state is sourced from the existing #484 `useAiFailure` bus path (the hook's `report(...)` call), never a second source of truth.
- File-tree: **one** header cue, never per-row.
- No global "any AI in flight" indicator.
- Run unit tests with the **local** binary `node_modules/.bin/vitest` (never `npx vitest`) from `frontend/`. Typecheck with `node_modules/.bin/tsc -b`.

---

### Task 1: `AiLoadState` type + lift `useAiHunkAnnotations`

**Files:**
- Modify: `frontend/src/api/types.ts` (add `AiLoadState`)
- Modify: `frontend/src/hooks/useAiHunkAnnotations.ts`
- Test: `frontend/src/hooks/useAiHunkAnnotations.test.tsx`
- Modify (consumer): `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:179,181-191`

**Interfaces:**
- Produces: `type AiLoadState = 'loading' | 'ready' | 'empty' | 'error'`; `useAiHunkAnnotations(prRef, enabled): { state: AiLoadState; annotations: HunkAnnotation[] | null }`.
- Consumes: existing `getAiHunkAnnotations`, `useAiFailure`, `readFailureReason`, `ApiError`.

- [ ] **Step 1: Add the type.** In `frontend/src/api/types.ts`, directly above `export interface PrSummary` (line ~246), add:

```ts
// Shared four-value AI load state (spec §1). "off" is NOT a state — it is the
// useAiGate(...) capability gate; a disabled hook renders nothing. Surfaces map
// their hook's richer state down to this for the AiMarker / skeleton cue.
export type AiLoadState = 'loading' | 'ready' | 'empty' | 'error';
```

- [ ] **Step 2: Write the failing test.** Replace the body of `frontend/src/hooks/useAiHunkAnnotations.test.tsx` assertions to assert the new shape. Add these cases (keep existing imports/harness; adapt the render to read `.state`/`.annotations`):

```tsx
it('reports loading then ready when annotations arrive', async () => {
  getAiHunkAnnotations.mockResolvedValueOnce([{ path: 'a.ts', hunkIndex: 0, body: 'x', tone: 'calm' }]);
  const { result } = renderHook(() => useAiHunkAnnotations(prRef, true), { wrapper });
  expect(result.current.state).toBe('loading');
  await waitFor(() => expect(result.current.state).toBe('ready'));
  expect(result.current.annotations).toHaveLength(1);
});

it('reports empty when the fetch returns no annotations', async () => {
  getAiHunkAnnotations.mockResolvedValueOnce([]);
  const { result } = renderHook(() => useAiHunkAnnotations(prRef, true), { wrapper });
  await waitFor(() => expect(result.current.state).toBe('empty'));
  expect(result.current.annotations).toEqual([]);
});

it('reports error and notifies the failure bus on a non-401 throw', async () => {
  getAiHunkAnnotations.mockRejectedValueOnce(new Error('boom'));
  const { result } = renderHook(() => useAiHunkAnnotations(prRef, true), { wrapper });
  await waitFor(() => expect(result.current.state).toBe('error'));
  expect(report).toHaveBeenCalledWith(prRef, 'hunk-annotations', expect.objectContaining({ reason: expect.any(String) }));
});

it('reports empty (not error) on a 401 and clears the bus', async () => {
  getAiHunkAnnotations.mockRejectedValueOnce(new ApiError('unauth', 401));
  const { result } = renderHook(() => useAiHunkAnnotations(prRef, true), { wrapper });
  await waitFor(() => expect(result.current.state).toBe('empty'));
  expect(clear).toHaveBeenCalledWith(prRef, 'hunk-annotations');
});

it('reports empty when disabled', () => {
  const { result } = renderHook(() => useAiHunkAnnotations(prRef, false), { wrapper });
  expect(result.current.state).toBe('empty');
  expect(result.current.annotations).toBeNull();
});
```

- [ ] **Step 3: Run the test, verify it fails.**

Run: `node_modules/.bin/vitest run src/hooks/useAiHunkAnnotations.test.tsx`
Expected: FAIL — `result.current.state` is undefined (hook still returns an array).

- [ ] **Step 4: Implement the lift.** Replace `frontend/src/hooks/useAiHunkAnnotations.ts` with:

```ts
import { useCallback, useEffect, useState } from 'react';
import { getAiHunkAnnotations } from '../api/aiHunkAnnotations';
import { ApiError, readFailureReason } from '../api/client';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { PrReference, HunkAnnotation, AiLoadState } from '../api/types';

export interface AiHunkAnnotationsState {
  state: AiLoadState;
  annotations: HunkAnnotation[] | null;
}

export function useAiHunkAnnotations(
  prRef: PrReference,
  enabled: boolean,
): AiHunkAnnotationsState {
  const [value, setValue] = useState<AiHunkAnnotationsState>({ state: 'loading', annotations: null });
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  const { report, clear } = useAiFailure();

  useEffect(() => {
    if (!enabled) {
      setValue({ state: 'empty', annotations: null });
      clear(prRef, 'hunk-annotations');
      return;
    }
    let cancelled = false;
    setValue({ state: 'loading', annotations: null });
    getAiHunkAnnotations(prRef)
      .then((result) => {
        if (cancelled) return;
        setValue({ state: result.length > 0 ? 'ready' : 'empty', annotations: result });
        clear(prRef, 'hunk-annotations');
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setValue({ state: 'empty', annotations: null });
          clear(prRef, 'hunk-annotations');
        } else {
          setValue({ state: 'error', annotations: null });
          report(prRef, 'hunk-annotations', { retry, reason: readFailureReason(err) });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; retryNonce re-runs the fetch (cleanup cancels the prior); report/clear/retry are stable (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, retryNonce]);

  return value;
}
```

- [ ] **Step 5: Migrate the DiffPane consumer.** In `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`, change line 179 from:

```tsx
  const allAnnotations = useAiHunkAnnotations(prRef, annotationsEnabled);
```

to (keeps every later `allAnnotations` reference working, and exposes `.state` for Task 6):

```tsx
  const aiAnnotations = useAiHunkAnnotations(prRef, annotationsEnabled);
  const allAnnotations = aiAnnotations.annotations;
```

- [ ] **Step 6: Run tests, verify pass.**

Run: `node_modules/.bin/vitest run src/hooks/useAiHunkAnnotations.test.tsx src/components/PrDetail/FilesTab/DiffPane/`
Expected: PASS. If any DiffPane test mocked `useAiHunkAnnotations` to return an array, update that mock to `{ state: 'ready', annotations: [...] }` (or `{ state: 'empty', annotations: null }`).

- [ ] **Step 7: Typecheck + commit.**

Run: `node_modules/.bin/tsc -b`
Expected: no errors.

```bash
git add frontend/src/api/types.ts frontend/src/hooks/useAiHunkAnnotations.ts frontend/src/hooks/useAiHunkAnnotations.test.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx
git commit -m "feat(ai): AiLoadState + lift useAiHunkAnnotations to {state,annotations} (#508)"
```

---

### Task 2: Lift `useAiDraftSuggestions`

**Files:**
- Modify: `frontend/src/hooks/useAiDraftSuggestions.ts`
- Test: `frontend/src/hooks/useAiDraftSuggestions.test.tsx`
- Modify (consumer): `frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx:84,86-94`

**Interfaces:**
- Produces: `useAiDraftSuggestions(prRef, enabled): { state: AiLoadState; suggestions: DraftSuggestion[] | null }`.

- [ ] **Step 1: Write the failing test.** Mirror Task 1's cases in `useAiDraftSuggestions.test.tsx`, asserting `.state` / `.suggestions` and the `'draft-suggestions'` seam:

```tsx
it('reports loading then ready when suggestions arrive', async () => {
  getAiDraftSuggestions.mockResolvedValueOnce([{ filePath: 'a.ts', lineNumber: 3, body: 'x' }]);
  const { result } = renderHook(() => useAiDraftSuggestions(prRef, true), { wrapper });
  expect(result.current.state).toBe('loading');
  await waitFor(() => expect(result.current.state).toBe('ready'));
  expect(result.current.suggestions).toHaveLength(1);
});

it('reports error and notifies the bus on a non-401 throw', async () => {
  getAiDraftSuggestions.mockRejectedValueOnce(new Error('boom'));
  const { result } = renderHook(() => useAiDraftSuggestions(prRef, true), { wrapper });
  await waitFor(() => expect(result.current.state).toBe('error'));
  expect(report).toHaveBeenCalledWith(prRef, 'draft-suggestions', expect.objectContaining({ reason: expect.any(String) }));
});

it('reports empty when disabled', () => {
  const { result } = renderHook(() => useAiDraftSuggestions(prRef, false), { wrapper });
  expect(result.current.state).toBe('empty');
  expect(result.current.suggestions).toBeNull();
});
```

- [ ] **Step 2: Run the test, verify it fails.**

Run: `node_modules/.bin/vitest run src/hooks/useAiDraftSuggestions.test.tsx`
Expected: FAIL — `.state` undefined.

- [ ] **Step 3: Implement the lift.** Replace `frontend/src/hooks/useAiDraftSuggestions.ts` with:

```ts
import { useCallback, useEffect, useState } from 'react';
import { getAiDraftSuggestions } from '../api/aiDraftSuggestions';
import { ApiError, readFailureReason } from '../api/client';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { PrReference, DraftSuggestion, AiLoadState } from '../api/types';

export interface AiDraftSuggestionsState {
  state: AiLoadState;
  suggestions: DraftSuggestion[] | null;
}

export function useAiDraftSuggestions(
  prRef: PrReference,
  enabled: boolean,
): AiDraftSuggestionsState {
  const [value, setValue] = useState<AiDraftSuggestionsState>({ state: 'loading', suggestions: null });
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  const { report, clear } = useAiFailure();

  useEffect(() => {
    if (!enabled) {
      setValue({ state: 'empty', suggestions: null });
      clear(prRef, 'draft-suggestions');
      return;
    }
    let cancelled = false;
    setValue({ state: 'loading', suggestions: null });
    getAiDraftSuggestions(prRef)
      .then((result) => {
        if (cancelled) return;
        setValue({ state: result.length > 0 ? 'ready' : 'empty', suggestions: result });
        clear(prRef, 'draft-suggestions');
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setValue({ state: 'empty', suggestions: null });
          clear(prRef, 'draft-suggestions');
        } else {
          setValue({ state: 'error', suggestions: null });
          report(prRef, 'draft-suggestions', { retry, reason: readFailureReason(err) });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; retryNonce re-runs the fetch (cleanup cancels the prior); report/clear/retry are stable (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, retryNonce]);

  return value;
}
```

- [ ] **Step 4: Migrate the UnresolvedPanel consumer.** In `frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx`, change line 84 from:

```tsx
  const allSuggestions = useAiDraftSuggestions(prRef, draftSuggestionsEnabled);
```

to:

```tsx
  const aiSuggestions = useAiDraftSuggestions(prRef, draftSuggestionsEnabled);
  const allSuggestions = aiSuggestions.suggestions;
```

(The `suggestionFor` memo at lines 86-94 already reads `allSuggestions` — no further change. `aiSuggestions.state` is consumed in Slice 2 for the per-draft cue.)

- [ ] **Step 5: Run tests, verify pass.**

Run: `node_modules/.bin/vitest run src/hooks/useAiDraftSuggestions.test.tsx src/components/PrDetail/Reconciliation/`
Expected: PASS. Update any reconciliation test that mocked `useAiDraftSuggestions` to return an array → `{ state: 'ready', suggestions: [...] }`.

- [ ] **Step 6: Typecheck + commit.**

Run: `node_modules/.bin/tsc -b`

```bash
git add frontend/src/hooks/useAiDraftSuggestions.ts frontend/src/hooks/useAiDraftSuggestions.test.tsx frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx
git commit -m "feat(ai): lift useAiDraftSuggestions to {state,suggestions} (#508)"
```

---

### Task 3: `AiMarker` working state + hue tokens

**Files:**
- Modify: `frontend/src/components/Ai/aiStrings.ts` (add `AI_WORKING_LABEL`)
- Modify: `frontend/src/components/Ai/AiMarker.tsx`
- Modify: `frontend/src/components/Ai/AiMarker.module.css`
- Modify: `frontend/src/styles/tokens.css` (add `--ai-working-color`, `--ai-idle-color` to both themes)
- Test: `frontend/src/components/Ai/AiMarker.test.tsx`

**Interfaces:**
- Produces: `AiMarker` gains `state?: 'idle' | 'working'` (default `'idle'`). `working` → `.working` class (hue + pulse) and sr-only `AI_WORKING_LABEL` when not `decorative`.

- [ ] **Step 1: Add the working label.** In `frontend/src/components/Ai/aiStrings.ts`, add next to `AI_PROVENANCE_LABEL`:

```ts
export const AI_WORKING_LABEL = 'AI is working…';
```

- [ ] **Step 2: Write the failing test.** In `frontend/src/components/Ai/AiMarker.test.tsx` add:

```tsx
import { render, screen } from '@testing-library/react';
import { AiMarker } from './AiMarker';

it('renders the working class and sr-only working label when state=working', () => {
  const { container } = render(<AiMarker state="working" />);
  const marker = screen.getByTestId('ai-marker');
  expect(marker.className).toMatch(/working/);
  expect(screen.getByText('AI is working…')).toBeInTheDocument();
});

it('omits the sr-only label when working and decorative', () => {
  render(<AiMarker state="working" decorative />);
  expect(screen.queryByText('AI is working…')).not.toBeInTheDocument();
});

it('defaults to idle with no working class', () => {
  render(<AiMarker />);
  expect(screen.getByTestId('ai-marker').className).not.toMatch(/working/);
});
```

- [ ] **Step 3: Run the test, verify it fails.**

Run: `node_modules/.bin/vitest run src/components/Ai/AiMarker.test.tsx`
Expected: FAIL — no `working` class, no working label.

- [ ] **Step 4: Add the tokens.** In `frontend/src/styles/tokens.css`, in the light `:root` accent block (after `--accent-ring:` ~line 118) add:

```css
  /* AI marker states (#508). Idle = the existing accent (no visual change to
     existing #489 markers). Working = a distinct hue so "AI is thinking" never
     reads identical to "AI content present" — and the distinction survives
     prefers-reduced-motion, where the pulse is dropped and only the hue remains. */
  --ai-idle-color: var(--accent);
  --ai-working-color: oklch(0.62 0.15 230);
```

In the dark-theme accent block (after the dark `--accent-ring:` ~line 206) add:

```css
  --ai-idle-color: var(--accent);
  --ai-working-color: oklch(0.78 0.15 230);
```

- [ ] **Step 5: Add the CSS.** In `frontend/src/components/Ai/AiMarker.module.css`, change the base color and append the working rule + keyframes:

```css
.aiMarker {
  display: inline-flex;
  align-items: center;
  color: var(--ai-idle-color);
}
/* Working: AI is in flight. Hue is the load-bearing differentiator (survives
   reduced-motion); the pulse is layered on top and dropped when motion is reduced. */
.working {
  color: var(--ai-working-color);
  animation: ai-marker-pulse 1.4s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .working {
    animation: none;
  }
}
@keyframes ai-marker-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
```

- [ ] **Step 6: Add the prop.** Replace `frontend/src/components/Ai/AiMarker.tsx` with:

```tsx
import { SparkIcon } from './SparkIcon';
import { AI_PROVENANCE_LABEL, AI_WORKING_LABEL } from './aiStrings';
import styles from './AiMarker.module.css';

export interface AiMarkerProps {
  /** 'superscript' (default) = tiny raised glyph beside a text label;
   *  'inline' = baseline glyph for buttons / nav / headers;
   *  'lead' = larger glyph placed before a text label (headings / sub-tabs). */
  variant?: 'superscript' | 'inline' | 'lead';
  /** 'idle' (default) = static provenance glyph (#489). 'working' = AI in flight:
   *  a distinct hue (--ai-working-color) plus a pulse that drops under reduced-motion. */
  state?: 'idle' | 'working';
  /** Identity use: decorative glyph only, no sr-only label. Use where adjacent
   *  visible "AI…" text already announces provenance/progress. Default false. */
  decorative?: boolean;
  className?: string;
}

// Presentational AI marker (#489, extended in #508). Holds no hooks: the host
// decides when to mount it and in which state. Static or pulsing per `state`.
export function AiMarker({
  variant = 'superscript',
  state = 'idle',
  decorative = false,
  className,
}: AiMarkerProps) {
  const working = state === 'working';
  const cls = [styles.aiMarker, styles[variant], working && styles.working, className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} data-ai-marker="" data-ai-state={state} data-testid="ai-marker">
      <SparkIcon className={styles.glyph} />
      {!decorative && <span className="sr-only">{working ? AI_WORKING_LABEL : AI_PROVENANCE_LABEL}</span>}
    </span>
  );
}
```

- [ ] **Step 7: Run tests, verify pass.**

Run: `node_modules/.bin/vitest run src/components/Ai/AiMarker.test.tsx`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit.**

Run: `node_modules/.bin/tsc -b`

```bash
git add frontend/src/components/Ai/aiStrings.ts frontend/src/components/Ai/AiMarker.tsx frontend/src/components/Ai/AiMarker.module.css frontend/src/components/Ai/AiMarker.test.tsx frontend/src/styles/tokens.css
git commit -m "feat(ai): AiMarker state=working with --ai-working-color hue (#508)"
```

---

### Task 4: AI Summary — working marker in the loading state

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx:55-68`
- Test: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.test.tsx`

**Interfaces:**
- Consumes: `AiMarker` (Task 3). No prop changes — `AiSummaryCard` already receives `loading`.

- [ ] **Step 1: Write the failing test.** In `AiSummaryCard.test.tsx` add:

```tsx
it('shows a working AI marker while loading', () => {
  render(<AiSummaryCard summary={null} loading error={false} />);
  const marker = screen.getByTestId('ai-marker');
  expect(marker.getAttribute('data-ai-state')).toBe('working');
});
```

- [ ] **Step 2: Run the test, verify it fails.**

Run: `node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/AiSummaryCard.test.tsx`
Expected: FAIL — no marker in the loading branch.

- [ ] **Step 3: Add the marker to the loading branch.** In `AiSummaryCard.tsx`, the import for `AiMarker` already exists. Replace the loading `<section>` (lines 55-68) body with a labelled head that carries the working marker:

```tsx
  if (loading) {
    return (
      <section
        className={`${styles.aiSummaryCard} overview-card overview-card-hero ai-tint`}
        aria-busy="true"
      >
        <span className={styles.aiSummaryLabel}>
          <AiMarker variant="lead" state="working" decorative />
          AI Summary
        </span>
        <span className="sr-only" aria-live="polite">
          Loading AI summary…
        </span>
        <Skeleton height={16} />
        <Skeleton height={16} width="80%" />
      </section>
    );
  }
```

(`decorative` because the adjacent `sr-only` "Loading AI summary…" already announces progress; the `aria-busy` section is the live region.)

- [ ] **Step 4: Run tests, verify pass.**

Run: `node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/AiSummaryCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit.**

Run: `node_modules/.bin/tsc -b`

```bash
git add frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.test.tsx
git commit -m "feat(ai): pulsing working marker on the AI summary loading state (#508)"
```

---

### Task 5: File-tree — persistent header marker

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (props + header)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` (header layout + idle dim)
- Modify (caller): `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx:711-718` (pass `focusStatus`)
- Test: `frontend/src/components/PrDetail/FilesTab/FileTree.test.tsx`

**Interfaces:**
- Consumes: `FileFocusStatus` (from `api/types`), `AiMarker` (Task 3), `fileFocus.status` (from `useFileFocusResult`, already in `FilesTab`).
- Produces: `FileTreeProps` gains `focusStatus: FileFocusStatus`. Header shows a single right-aligned marker: `working` while `status==='loading'`, persistent `idle` once AI has run (`ok`/`empty`/`fallback`), hidden otherwise.

- [ ] **Step 1: Write the failing test.** In `FileTree.test.tsx` add (reuse the file's existing `files` fixture + render helper; pass `aiPreview` true):

```tsx
it('shows a working header marker while focus is loading', () => {
  renderTree({ aiPreview: true, focusStatus: 'loading' });
  expect(screen.getByTestId('file-tree-ai-progress').getAttribute('data-ai-state')).toBe('working');
});

it('keeps a persistent idle marker once focus has run (ok)', () => {
  renderTree({ aiPreview: true, focusStatus: 'ok' });
  expect(screen.getByTestId('file-tree-ai-progress').getAttribute('data-ai-state')).toBe('idle');
});

it('keeps a persistent idle marker on empty (AI ran, nothing flagged)', () => {
  renderTree({ aiPreview: true, focusStatus: 'empty' });
  expect(screen.getByTestId('file-tree-ai-progress').getAttribute('data-ai-state')).toBe('idle');
});

it('renders no header marker when AI is off', () => {
  renderTree({ aiPreview: false, focusStatus: 'no-changes' });
  expect(screen.queryByTestId('file-tree-ai-progress')).not.toBeInTheDocument();
});

it('renders no header marker on error', () => {
  renderTree({ aiPreview: true, focusStatus: 'error' });
  expect(screen.queryByTestId('file-tree-ai-progress')).not.toBeInTheDocument();
});
```

If the test file lacks a `renderTree({...})` helper, add one that calls `render(<FileTree files={fixtureFiles} selectedPath={null} onSelectFile={()=>{}} viewedPaths={new Set()} onToggleViewed={()=>{}} focusEntries={null} {...overrides} />)`.

- [ ] **Step 2: Run the test, verify it fails.**

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/FileTree.test.tsx`
Expected: FAIL — `focusStatus` not a prop; no `file-tree-ai-progress` element.

- [ ] **Step 3: Add the prop + header marker.** In `FileTree.tsx`:

Add imports near the top:

```tsx
import type { FileChange, FileChangeStatus, FileFocus, FileFocusStatus, FocusLevel } from '../../../api/types';
import { AiMarker } from '../../Ai/AiMarker';
```

Add `focusStatus` to `FileTreeProps` (after `focusEntries`):

```tsx
  focusEntries: FileFocus[] | null;
  focusStatus: FileFocusStatus;
  aiPreview: boolean;
```

Add `focusStatus` to the destructured params (after `focusEntries`) and a derived marker state, just inside the component body (after `const tree = useMemo(...)`):

```tsx
  focusEntries,
  focusStatus,
  aiPreview,
```

```tsx
  // One header cue for the whole tree (spec §3 — never per-row). Working while the
  // shared file-focus fetch is in flight; a PERSISTENT idle "AI is on here" marker
  // once it has run (ok/empty/fallback) — idle on empty is the truthful "AI ran,
  // flagged nothing" signal that dots alone cannot express. Hidden when AI is off
  // (no-changes/not-subscribed) or errored.
  const headerMarkerState: 'working' | 'idle' | null = !aiPreview
    ? null
    : focusStatus === 'loading'
      ? 'working'
      : focusStatus === 'ok' || focusStatus === 'empty' || focusStatus === 'fallback'
        ? 'idle'
        : null;
```

Replace the populated header (lines 182-185) with a two-part flex row carrying the marker on the right:

```tsx
      <div className={`file-tree-header ${styles.fileTreeHeader}`}>
        <span className={styles.fileTreeHeaderLabel}>
          Files · {viewedCount}/{files.length} viewed
          {aiPreview && <SampleBadge variant="region" />}
        </span>
        {headerMarkerState && (
          <AiMarker
            variant="inline"
            state={headerMarkerState}
            decorative
            className={`${styles.fileTreeHeaderAi}${headerMarkerState === 'idle' ? ` ${styles.fileTreeHeaderAiIdle}` : ''}`}
          />
        )}
      </div>
```

Wrap the marker host so the test seam exists: the `data-testid` lives on `AiMarker` itself (`ai-marker`), but the test queries `file-tree-ai-progress`. Add that id by wrapping:

```tsx
        {headerMarkerState && (
          <span data-testid="file-tree-ai-progress" data-ai-state={headerMarkerState}>
            <AiMarker
              variant="inline"
              state={headerMarkerState}
              decorative
              className={headerMarkerState === 'idle' ? styles.fileTreeHeaderAiIdle : undefined}
            />
          </span>
        )}
```

- [ ] **Step 4: Add the header layout CSS.** In `FileTree.module.css`, replace the `.fileTreeHeader` rule (lines 24-30) and add the new classes:

```css
.fileTreeHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--border-1);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-1);
}
.fileTreeHeaderLabel {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  min-width: 0;
}
/* Persistent post-load marker reads as dull/"on here", not active. */
.fileTreeHeaderAiIdle {
  opacity: 0.55;
}
```

(The empty-files header at line 166 renders the literal `Files` text only — leave it unchanged; no AI runs on an empty diff.)

- [ ] **Step 5: Pass `focusStatus` from FilesTab.** In `FilesTab.tsx`, the `<FileTree>` at lines 711-718 already passes `focusEntries={focusEntries}`. Add `focusStatus={fileFocus.status}` directly after it:

```tsx
              focusEntries={focusEntries}
              focusStatus={fileFocus.status}
```

(`fileFocus` is the `useFileFocusResult` state already in scope — `focusEntries = fileFocus.entries` at line 101.)

- [ ] **Step 6: Run tests, verify pass.**

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/FileTree.test.tsx src/components/PrDetail/FilesTab/FilesTab.test.tsx`
Expected: PASS. Update any `<FileTree .../>` render in tests that now misses the required `focusStatus` prop (default to `'no-changes'`).

- [ ] **Step 7: Typecheck + commit.**

Run: `node_modules/.bin/tsc -b`

```bash
git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/src/components/PrDetail/FilesTab/FileTree.module.css frontend/src/components/PrDetail/FilesTab/FilesTab.tsx frontend/src/components/PrDetail/FilesTab/FileTree.test.tsx
git commit -m "feat(ai): persistent file-tree header AI marker (#508)"
```

---

### Task 6: Hunk annotator — loading skeleton + working marker

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkSkeleton.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:181-191,402-434`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkSkeleton.test.tsx`

**Interfaces:**
- Consumes: `aiAnnotations.state` (Task 1), `AiMarker` (Task 3), `Skeleton`. Drives the cue off the annotator's **own** loading state for the open file (robust to file-focus divergence — spec §3 annotator note).
- Produces: `AiHunkSkeleton` — a presentational loading row matching the `.ai-hunk` shape.

- [ ] **Step 1: Write the failing test.** Create `AiHunkSkeleton.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { AiHunkSkeleton } from './AiHunkSkeleton';

it('renders a working AI marker and a skeleton body', () => {
  const { container } = render(<AiHunkSkeleton />);
  expect(screen.getByTestId('ai-marker').getAttribute('data-ai-state')).toBe('working');
  expect(screen.getByTestId('ai-hunk-skeleton')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test, verify it fails.**

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/AiHunkSkeleton.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the skeleton component.** Create `AiHunkSkeleton.tsx`:

```tsx
import { AiMarker } from '../../../Ai/AiMarker';
import { Skeleton } from '../../../Skeleton/Skeleton';
import styles from './AiHunkAnnotation.module.css';

// Loading placeholder for in-flight hunk annotations (#508). Mirrors the .ai-hunk
// shape so the resolved annotation cross-fades into the same footprint. The working
// AiMarker (hue + reduced-motion-safe pulse) signals "AI is reviewing this file".
export function AiHunkSkeleton() {
  return (
    <div className={`ai-hunk ${styles.aiHunk}`} data-testid="ai-hunk-skeleton" aria-busy="true">
      <AiMarker variant="inline" state="working" decorative className="ai-icon" />
      <div className={styles.aiHunkBody}>
        <span className="sr-only" aria-live="polite">
          AI is reviewing this file…
        </span>
        <Skeleton height={12} width="40%" />
        <Skeleton height={12} width="90%" />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the component test, verify it passes.**

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/AiHunkSkeleton.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the skeleton into DiffPane.** In `DiffPane.tsx`:

Add the import beside the `AiHunkAnnotation` import (line ~18):

```tsx
import { AiHunkSkeleton } from './AiHunkSkeleton';
```

The `annotationsForFile` memo (lines 181-191) reads `allAnnotations` — unchanged. Add a derived loading flag right after that memo:

```tsx
  // Annotator's OWN loading state drives the per-file cue (spec §3): robust even when
  // file-focus errors or flagged zero files. Only while a file is open and enabled.
  const annotationsLoading = aiAnnotations.state === 'loading' && !!selectedPath;
```

In the hunks-only branch, after the existing per-hunk annotations block (the `if (annotations) { ... }` at lines 423-434), emit one skeleton row under the FIRST hunk header while loading:

```tsx
          const annotations = annotationsForFile?.get(hunkCounter);
          if (annotations) {
            for (let aidx = 0; aidx < annotations.length; aidx++) {
              rows.push(
                <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
                  <td colSpan={colSpan}>
                    <AiHunkAnnotation annotation={annotations[aidx]} />
                  </td>
                </tr>,
              );
            }
          } else if (annotationsLoading && hunkCounter === 1) {
            rows.push(
              <tr key={`ann-loading-${idx}`} className={styles.aiHunkRow}>
                <td colSpan={colSpan}>
                  <AiHunkSkeleton />
                </td>
              </tr>,
            );
          }
```

(One skeleton at the top of the file's diff signals "annotations are coming" without a per-hunk pulse storm. When `state` resolves to `ready`/`empty`, `annotationsLoading` is false and real annotations — or nothing — render. If the annotator resolves before the user opens a file, `selectedPath` gating means no stuck skeleton.)

- [ ] **Step 6: Write the DiffPane integration assertion.** In the existing DiffPane test file, add a case mocking `useAiHunkAnnotations` to `{ state: 'loading', annotations: null }` with a selected file, and assert `screen.getByTestId('ai-hunk-skeleton')` is present; then a case with `{ state: 'empty', annotations: null }` asserting it is absent. (Mirror the file's existing mock + render harness for `useAiHunkAnnotations`.)

- [ ] **Step 7: Run tests, verify pass.**

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit.**

Run: `node_modules/.bin/tsc -b`

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkSkeleton.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkSkeleton.test.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx
git commit -m "feat(ai): in-flight hunk-annotation skeleton + working marker (#508)"
```

---

### Task 7: Slice-1 verification gate

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite.**

Run (from `frontend/`): `node_modules/.bin/vitest run`
Expected: all green. Fix any remaining mocks that still return the pre-lift `T | null` shape for `useAiHunkAnnotations` / `useAiDraftSuggestions` (grep: `node_modules/.bin/vitest run` failures will name them).

- [ ] **Step 2: Typecheck + lint.**

Run: `node_modules/.bin/tsc -b` then `node_modules/.bin/eslint src` (use the local binary, not `npx eslint`). Expected: clean.

- [ ] **Step 3: Visual baselines (B1 gate).** Regenerate and eyeball the affected screenshots per the established CI-baseline flow (see `.ai/docs/`): summary loading skeleton+marker, file-tree header marker (working + persistent-idle, AI-on-empty vs AI-off), annotator skeleton — both themes, and confirm the working↔idle hue distinction holds under `prefers-reduced-motion`. Tune `--ai-working-color` if the working/idle/#489-content trio is not distinguishable. Do not auto-accept new baselines without the visual review.

- [ ] **Step 4: Confirm no behaviour regression.** Verify existing AI summary / Hotspots loading and the file-focus thresholds are unchanged (only additive markers/skeletons were introduced).

---

## Self-Review

**Spec coverage (Slice 1 scope only):**
- `AiLoadState` + lifted hooks (annotations, draft-suggestions) with `error` from the failure bus → Tasks 1, 2. ✓
- `AiMarker state="working"` hue token + reduced-motion → Task 3. ✓
- Summary working marker (loading skeleton already existed on V2) → Task 4. ✓
- File-tree single persistent header marker (working→idle, hidden on off/error) → Task 5. ✓
- Annotator loading skeleton driven off the annotator's own state (divergence-safe) → Task 6. ✓
- Both-theme + reduced-motion + baselines → Task 7. ✓
- **Deferred to Slice 2 (separate plan):** inbox chip + backend settled-signal; Hotspots tab marker + skeleton regen; draft-suggestion per-draft overlay marker (overlay not yet visually verified); the working→ready cross-fade polish and `aria-busy` host enumeration for the remaining surfaces.

**Placeholder scan:** No TBD/TODO; every code step shows full code. Test steps that reuse an existing harness (DiffPane, FileTree) name the exact mock shape to set rather than restating the harness.

**Type consistency:** `AiLoadState` defined once (Task 1, `api/types.ts`); hooks return `{ state, annotations }` / `{ state, suggestions }`; consumers read `.annotations` / `.suggestions` and `.state`; `AiMarker` `state` prop values `'idle' | 'working'` used consistently across Tasks 3–6; `focusStatus: FileFocusStatus` matches the `useFileFocusResult` `status` field.
