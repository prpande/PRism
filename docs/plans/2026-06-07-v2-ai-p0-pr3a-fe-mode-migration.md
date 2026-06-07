# v2 AI P0 PR3a — FE mode migration & SampleBadge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the PRism frontend off the legacy boolean `aiPreview` onto PR2's tri-state `ui.aiMode` (`off|preview|live`), ship an `Off | Preview` selector, and add a define-once `SampleBadge` to every Preview surface — frontend + docs only, zero backend change.

**Architecture:** `ui.aiMode` becomes the FE source of truth (selector writes `set('ui.ai.mode', mode)`; backend already accepts it). Capabilities stay *derived* locally (`mode==='preview' ? ALL_ON : ALL_OFF`) — no `/api/capabilities` fetch — preserving the existing reactive arch. A single `SampleBadge` component (gated on `useIsSampleMode()`) marks all sample content, replacing 3 scattered hardcoded strings and covering 5 currently-unmarked surfaces. The migration adds `aiMode` first, migrates all consumers, then removes `aiPreview` last so every commit compiles.

**Tech Stack:** React + Vite + TypeScript (strict), Vitest + Testing Library (unit), Playwright (e2e), CSS Modules + design tokens (`frontend/src/styles/tokens.css`).

**Spec:** [`docs/specs/2026-06-07-v2-ai-p0-pr3a-fe-mode-migration-design.md`](../specs/2026-06-07-v2-ai-p0-pr3a-fe-mode-migration-design.md). **Branch/base:** `feat/v2-ai-pr3a-fe-mode-migration` → `V2`. **Worktree:** `C:/src/PRism-v2-pr3`.

**Commands (run from `frontend/`):** unit test once: `npx vitest run <file>`; full unit: `npm test`; build/typecheck: `npm run build`; lint: `npm run lint`; e2e: `npm run test:e2e` (or `npx playwright test <file>`). All git commands run in the worktree; stage only the named files (never `git add -A`).

---

## File Structure

| File | Responsibility | Tasks |
|------|----------------|-------|
| `frontend/src/api/types.ts` | Add `AiMode` type + `aiMode` field; remove `aiPreview` | T1, T10 |
| `frontend/src/contexts/PreferencesContext.tsx` | `ui.ai.mode` key + readKey/writeKey arms; remove `aiPreview` | T2, T10 |
| `frontend/src/hooks/useCapabilities.ts` | Derive from `aiMode==='preview'` | T3 |
| `frontend/src/hooks/useAiGate.ts` | factor-2 `aiMode!=='off'`; add `useIsSampleMode()` | T3 |
| `frontend/src/hooks/useAiGate.reactivity.test.tsx` | Re-key onto `aiMode`; two-factor lock; sample-mode | T1, T3 |
| `frontend/src/components/Settings/panes/AppearancePane.tsx` (+ test) | Switch → `SegmentedControl` | T4 |
| `frontend/src/components/Ai/SampleBadge.tsx` (+ `.module.css`, + test) | The define-once marker | T5 |
| AiSummaryCard, PreSubmitValidatorCard, AiComposerAssistant | Replace hardcoded strings with `SampleBadge` | T6 |
| AiHunkAnnotation, StaleDraftRow | Add `SampleBadge` beside AI label | T7 |
| FileTree, InboxPage, ActivityRail | Region-level `SampleBadge` | T8 |
| OverviewTab | Re-source `PrDescription` prop from `useAiGate('summary')` | T9 |
| `frontend/e2e/**` | Migrate mocks/fixtures/locators; cross-surface badge assertions | T11 |
| `.ai/docs/architectural-invariants.md` | Tri-state + truthful-by-default invariant | T12 |

---

## Task 1: Add `AiMode` type + `aiMode` field (keep `aiPreview`)

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/hooks/useAiGate.reactivity.test.tsx` (keep its typed factory compiling)

- [ ] **Step 1: Add the `AiMode` type and the `aiMode` field**

In `frontend/src/api/types.ts`, after the existing type aliases (currently lines 1-3):

```ts
export type Theme = 'light' | 'dark' | 'system';
export type Accent = 'indigo' | 'amber' | 'teal';
export type Density = 'comfortable' | 'compact';
export type AiMode = 'off' | 'preview' | 'live';
```

In the `UiPreferences` interface, add `aiMode` (keep `aiPreview` for now — it is removed in Task 10):

```ts
export interface UiPreferences {
  theme: Theme;
  accent: Accent;
  aiPreview: boolean;
  aiMode: AiMode;
  density: Density;
}
```

- [ ] **Step 2: Keep the typed reactivity-test factory compiling**

`aiMode` is now required on `UiPreferences`. The only *typed* `PreferencesResponse` literal in `src/` is the `prefs()` factory in `useAiGate.reactivity.test.tsx`. Add `aiMode: 'off'` to its `ui` block (behavior unchanged — this test still drives `aiPreview` until Task 3):

```ts
  const prefs = (): PreferencesResponse => ({
    ui: { theme: 'dark', accent: 'indigo', density: 'comfortable', aiPreview: state.aiPreview, aiMode: 'off' },
    inbox: { sections: {} } as never,
    github: {} as never,
  });
```

- [ ] **Step 3: Verify the build is green**

Run: `npm run build`
Expected: PASS (no type errors). If any *other* typed `PreferencesResponse`/`UiPreferences` literal errors on the missing `aiMode`, add `aiMode: 'off'` to it.

- [ ] **Step 4: Verify unit tests still pass**

Run: `npm test`
Expected: PASS (no behavior change yet).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/hooks/useAiGate.reactivity.test.tsx
git commit -m "feat(ai): add AiMode type + ui.aiMode field (keep aiPreview)"
```

---

## Task 2: PreferencesContext — add the `ui.ai.mode` key + arms

**Files:**
- Modify: `frontend/src/contexts/PreferencesContext.tsx`
- Test: `frontend/src/contexts/PreferencesContext.aimode.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/contexts/PreferencesContext.aimode.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PreferencesResponse } from '../api/types';

const state = vi.hoisted(() => ({ aiMode: 'off' as 'off' | 'preview' | 'live' }));
const captured = vi.hoisted(() => ({ body: null as Record<string, unknown> | null }));

vi.mock('../api/client', () => {
  const prefs = (): PreferencesResponse => ({
    ui: { theme: 'dark', accent: 'indigo', density: 'comfortable', aiPreview: false, aiMode: state.aiMode },
    inbox: { sections: {} } as never,
    github: {} as never,
  });
  return {
    apiClient: {
      get: vi.fn(async () => prefs()),
      post: vi.fn(async (_path: string, body: Record<string, unknown>) => {
        captured.body = body;
        if ('ui.ai.mode' in body) state.aiMode = body['ui.ai.mode'] as 'off' | 'preview' | 'live';
        return prefs();
      }),
    },
  };
});

import { usePreferences } from '../hooks/usePreferences';
import { PreferencesProvider } from './PreferencesContext';

function ModeProbe() {
  const { preferences, set } = usePreferences();
  return (
    <div>
      <span data-testid="mode">{preferences?.ui.aiMode ?? 'loading'}</span>
      <button onClick={() => void set('ui.ai.mode', 'preview').catch(() => {})}>go</button>
    </div>
  );
}

beforeEach(() => {
  state.aiMode = 'off';
  captured.body = null;
});

describe('PreferencesContext ui.ai.mode', () => {
  it('POSTs the literal {"ui.ai.mode":...} key and reflects the new mode', async () => {
    render(<PreferencesProvider><ModeProbe /></PreferencesProvider>);
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('off'));
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('preview'));
    expect(captured.body).toEqual({ 'ui.ai.mode': 'preview' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/contexts/PreferencesContext.aimode.test.tsx`
Expected: FAIL — `set('ui.ai.mode', ...)` is a TS/type error (key not in `PreferenceKey`), or the mode never updates.

- [ ] **Step 3: Add the `ui.ai.mode` key, arms, and Exclude update**

In `frontend/src/contexts/PreferencesContext.tsx`:

Update the import (add `AiMode`):

```ts
import type { PreferencesResponse, AiMode } from '../api/types';
```

Add `'ui.ai.mode'` to the union (keep `'aiPreview'` for now — removed in Task 10):

```ts
export type PreferenceKey =
  | 'theme'
  | 'accent'
  | 'aiPreview'
  | 'ui.ai.mode'
  | 'density'
  | `inbox.sections.${
      | 'review-requested'
      | 'awaiting-author'
      | 'authored-by-me'
      | 'mentioned'
      | 'ci-failing'
      | 'recently-closed'}`;
```

Update `InboxSectionKey` to also exclude `'ui.ai.mode'` (so the `(key as InboxSectionKey)` cast in `writeKey` keeps narrowing correctly):

```ts
type InboxSectionKey = Exclude<PreferenceKey, 'theme' | 'accent' | 'aiPreview' | 'density' | 'ui.ai.mode'>;
```

Add an explicit arm to `readKey` (before the `inbox.sections.` slice; keep the `aiPreview` arm for now):

```ts
function readKey(prefs: PreferencesResponse, key: PreferenceKey): unknown {
  if (key === 'theme') return prefs.ui.theme;
  if (key === 'accent') return prefs.ui.accent;
  if (key === 'aiPreview') return prefs.ui.aiPreview;
  if (key === 'ui.ai.mode') return prefs.ui.aiMode;
  if (key === 'density') return prefs.ui.density;
  const id = key.slice('inbox.sections.'.length) as keyof PreferencesResponse['inbox']['sections'];
  return prefs.inbox.sections[id];
}
```

Add the matching arm to `writeKey` (before the `inbox.sections.` slice):

```ts
  if (key === 'aiPreview') return { ...prefs, ui: { ...prefs.ui, aiPreview: value as boolean } };
  if (key === 'ui.ai.mode') return { ...prefs, ui: { ...prefs.ui, aiMode: value as AiMode } };
  if (key === 'density')
```

(The generic `inbox.sections.*` fallthrough does **not** cover `ui.*` keys — `'ui.ai.mode'.slice(15)` is `''`, which would read/write `inbox.sections['']`. The explicit arms above are required.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/contexts/PreferencesContext.aimode.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify build + full unit suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/contexts/PreferencesContext.tsx frontend/src/contexts/PreferencesContext.aimode.test.tsx
git commit -m "feat(ai): route ui.ai.mode through PreferencesContext readKey/writeKey"
```

---

## Task 3: Hooks — derive capabilities from mode; add `useIsSampleMode`

**Files:**
- Modify: `frontend/src/hooks/useCapabilities.ts`
- Modify: `frontend/src/hooks/useAiGate.ts`
- Modify: `frontend/src/hooks/useAiGate.reactivity.test.tsx`

- [ ] **Step 1: Re-key the reactivity test onto `aiMode` and add the new assertions**

Replace the full contents of `frontend/src/hooks/useAiGate.reactivity.test.tsx` with:

```tsx
// #221 / PR3a — AI mode reactivity. Integration test over the REAL
// PreferencesProvider + useCapabilities + useAiGate (only apiClient is mocked),
// so it exercises the actual cross-consumer propagation.
import { render, screen, waitFor, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import type { AiCapabilities, AiMode, PreferencesResponse } from '../api/types';

const state = vi.hoisted(() => ({ aiMode: 'off' as AiMode }));
const calls = vi.hoisted(() => ({ get: [] as string[] }));

vi.mock('../api/client', () => {
  const caps = (on: boolean): AiCapabilities => ({
    summary: on,
    fileFocus: on,
    hunkAnnotations: on,
    preSubmitValidators: on,
    composerAssist: on,
    draftSuggestions: on,
    draftReconciliation: on,
    inboxEnrichment: on,
    inboxRanking: on,
  });
  const prefs = (): PreferencesResponse => ({
    ui: { theme: 'dark', accent: 'indigo', density: 'comfortable', aiPreview: state.aiMode !== 'off', aiMode: state.aiMode },
    inbox: { sections: {} } as never,
    github: {} as never,
  });
  return {
    apiClient: {
      get: vi.fn(async (path: string) => {
        calls.get.push(path);
        if (path === '/api/preferences') return prefs();
        if (path === '/api/capabilities') return { ai: caps(state.aiMode === 'preview') };
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (path === '/api/preferences') {
          if ('ui.ai.mode' in body) state.aiMode = body['ui.ai.mode'] as AiMode;
          return prefs();
        }
        throw new Error(`unexpected POST ${path}`);
      }),
    },
  };
});

import { apiClient } from '../api/client';
import { usePreferences } from './usePreferences';
import { useCapabilities } from './useCapabilities';
import { useAiGate } from './useAiGate';
import { PreferencesProvider } from '../contexts/PreferencesContext';

function Toggler() {
  const { set } = usePreferences();
  return <button onClick={() => void set('ui.ai.mode', 'preview')}>toggle</button>;
}
function Consumer() {
  const on = useAiGate('summary');
  return <span data-testid="consumer">{on ? 'on' : 'off'}</span>;
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <PreferencesProvider>{children}</PreferencesProvider>
);

beforeEach(() => {
  state.aiMode = 'off';
  calls.get.length = 0;
  vi.mocked(apiClient.get).mockClear();
});

describe('PR3a AI mode reactivity', () => {
  it('propagates a mode change to an already-mounted second consumer immediately', async () => {
    render(
      <PreferencesProvider>
        <Toggler />
        <Consumer />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('consumer')).toHaveTextContent('off'));
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await waitFor(() => expect(screen.getByTestId('consumer')).toHaveTextContent('on'));
  });

  it('does not issue a frontend GET /api/capabilities (capabilities are derived)', async () => {
    render(
      <PreferencesProvider>
        <Toggler />
        <Consumer />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('consumer')).toHaveTextContent('off'));
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await waitFor(() => expect(screen.getByTestId('consumer')).toHaveTextContent('on'));
    expect(calls.get).not.toContain('/api/capabilities');
  });

  it('derives AllOn/AllOff/null from the shared aiMode preference', async () => {
    state.aiMode = 'preview';
    const { result } = renderHook(() => useCapabilities(), { wrapper });
    expect(result.current.capabilities).toBeNull(); // before preferences load
    await waitFor(() => expect(result.current.capabilities?.summary).toBe(true));
    expect(result.current.capabilities).toMatchObject({ summary: true, inboxRanking: true });
  });
});
```

- [ ] **Step 2: Add the two-factor seam lock + sample-mode tests**

Create `frontend/src/hooks/useAiGate.unit.test.tsx`:

```tsx
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiCapabilities, AiMode } from '../api/types';

const mock = vi.hoisted(() => ({ caps: null as AiCapabilities | null, aiMode: 'off' as AiMode }));

vi.mock('./useCapabilities', () => ({ useCapabilities: () => ({ capabilities: mock.caps }) }));
vi.mock('./usePreferences', () => ({ usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }) }));

import { useAiGate, useIsSampleMode } from './useAiGate';

const allTrue: AiCapabilities = {
  summary: true, fileFocus: true, hunkAnnotations: true, preSubmitValidators: true,
  composerAssist: true, draftSuggestions: true, draftReconciliation: true,
  inboxEnrichment: true, inboxRanking: true,
};

beforeEach(() => { mock.caps = null; mock.aiMode = 'off'; });

describe('useAiGate two-factor seam', () => {
  it('is false when capability is false even if mode !== off (locks the D112 shape)', () => {
    mock.caps = { ...allTrue, summary: false };
    mock.aiMode = 'preview';
    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });
  it('is false when mode is off even if capability is true', () => {
    mock.caps = allTrue;
    mock.aiMode = 'off';
    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });
  it('is true only when capability is true and mode !== off', () => {
    mock.caps = allTrue;
    mock.aiMode = 'preview';
    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(true);
  });
});

describe('useIsSampleMode', () => {
  it.each([['off', false], ['preview', true], ['live', false]] as const)(
    'returns %s -> %s', (m, expected) => {
      mock.aiMode = m;
      const { result } = renderHook(() => useIsSampleMode());
      expect(result.current).toBe(expected);
    },
  );
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run src/hooks/useAiGate.reactivity.test.tsx src/hooks/useAiGate.unit.test.tsx`
Expected: FAIL — `useIsSampleMode` is not exported; the reactivity test posts `ui.ai.mode` but `useCapabilities`/`useAiGate` still read `aiPreview`.

- [ ] **Step 4: Migrate `useCapabilities.ts`**

In `frontend/src/hooks/useCapabilities.ts`, change the derivation line (the comment block above may keep its D112 note; update the `aiPreview` mention to `aiMode`):

```ts
  const capabilities = preferences?.ui ? (preferences.ui.aiMode === 'preview' ? ALL_ON : ALL_OFF) : null;
```

- [ ] **Step 5: Migrate `useAiGate.ts` and add `useIsSampleMode`**

Replace the body of `frontend/src/hooks/useAiGate.ts` (keep the header comment) with:

```ts
export function useAiGate(key: keyof AiCapabilities): boolean {
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();
  return (capabilities?.[key] ?? false) && (preferences?.ui.aiMode ?? 'off') !== 'off';
}

// Preview-mode predicate for the sample-data treatment (SampleBadge). True only
// in Preview; false in Off and Live. Spec §5/§6.
export function useIsSampleMode(): boolean {
  const { preferences } = usePreferences();
  return preferences?.ui.aiMode === 'preview';
}
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `npx vitest run src/hooks/useAiGate.reactivity.test.tsx src/hooks/useAiGate.unit.test.tsx`
Expected: PASS.

- [ ] **Step 7: Verify build + full unit suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/hooks/useCapabilities.ts frontend/src/hooks/useAiGate.ts frontend/src/hooks/useAiGate.reactivity.test.tsx frontend/src/hooks/useAiGate.unit.test.tsx
git commit -m "feat(ai): derive capabilities + gate from ui.aiMode; add useIsSampleMode"
```

---

## Task 4: AppearancePane — Switch → SegmentedControl

**Files:**
- Modify: `frontend/src/components/Settings/panes/AppearancePane.tsx`
- Modify: `frontend/src/components/Settings/panes/AppearancePane.test.tsx`

- [ ] **Step 1: Rewrite the test**

Replace `frontend/src/components/Settings/panes/AppearancePane.test.tsx` with:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppearancePane } from './AppearancePane';

const set = vi.fn().mockResolvedValue(undefined);
const prefs = vi.hoisted(() => ({ aiMode: 'off' as 'off' | 'preview' | 'live' }));
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: { theme: 'dark', accent: 'indigo', density: 'comfortable', aiPreview: false, aiMode: prefs.aiMode },
      inbox: { sections: {} },
      github: {},
    },
    set,
  }),
}));
beforeEach(() => {
  set.mockClear();
  prefs.aiMode = 'off';
});

describe('AppearancePane', () => {
  it('renders theme/accent/density/AI-mode controls', () => {
    render(<AppearancePane />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
    const aiMode = screen.getByRole('radiogroup', { name: 'AI mode' });
    expect(aiMode).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Off' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Live' })).toBeNull();
  });

  it('writes ui.ai.mode on selecting Preview', async () => {
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'preview'));
  });

  it('shows a live config as Preview and issues no POST on render', () => {
    prefs.aiMode = 'live';
    render(<AppearancePane />);
    expect(screen.getByRole('radio', { name: 'Preview' })).toHaveAttribute('aria-checked', 'true');
    expect(set).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/Settings/panes/AppearancePane.test.tsx`
Expected: FAIL — no `radiogroup` named "AI mode"; a `role=switch` still renders.

- [ ] **Step 3: Swap the control in `AppearancePane.tsx`**

Remove the `Switch` import (line 6: `import { Switch } from '../../controls/Switch';`).

Replace the `onAiToggle` handler (current lines 42-50) with:

```tsx
  // The AI gates derive from this shared preference (useCapabilities), so the
  // selector propagates reactively. usePreferences.set reverts its own state on a
  // failed POST (+ error toast); no DOM side-effect to roll back here.
  const onAiMode = (next: 'off' | 'preview') => {
    void set('ui.ai.mode', next).catch(() => {});
  };
```

Replace the AI-preview row (current lines 99-117) with:

```tsx
      <div className={pane.row}>
        <div>
          <div className={pane.label}>AI mode</div>
          <div className={pane.help}>Off · no AI. Preview · sample output, clearly labeled.</div>
        </div>
        <div className={pane.spring}>
          <SegmentedControl
            label="AI mode"
            options={[
              { value: 'off', label: 'Off' },
              { value: 'preview', label: 'Preview' },
            ]}
            value={(preferences.ui.aiMode === 'live' ? 'preview' : preferences.ui.aiMode) as 'off' | 'preview'}
            onChange={onAiMode}
          />
        </div>
      </div>
```

(Optionally update the pane subtitle on line 59 from "...and AI preview" to "...and AI mode".)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/Settings/panes/AppearancePane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify build + lint (an unused `Switch` import would fail lint)**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Settings/panes/AppearancePane.tsx frontend/src/components/Settings/panes/AppearancePane.test.tsx
git commit -m "feat(ai): replace AI-preview switch with Off|Preview mode selector"
```

---

## Task 5: SampleBadge component

**Files:**
- Create: `frontend/src/components/Ai/SampleBadge.tsx`
- Create: `frontend/src/components/Ai/SampleBadge.module.css`
- Test: `frontend/src/components/Ai/SampleBadge.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/Ai/SampleBadge.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({ aiMode: 'preview' as 'off' | 'preview' | 'live' }));
vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }),
}));

import { SampleBadge } from './SampleBadge';

beforeEach(() => { mock.aiMode = 'preview'; });

describe('SampleBadge', () => {
  it('renders the Sample pill in preview mode', () => {
    render(<SampleBadge />);
    const badge = screen.getByTestId('sample-badge');
    expect(badge).toHaveTextContent('Sample');
    expect(badge).toHaveAttribute('aria-label', 'Sample data — illustrative, not real AI output');
  });
  it('renders nothing in off mode', () => {
    mock.aiMode = 'off';
    render(<SampleBadge />);
    expect(screen.queryByTestId('sample-badge')).toBeNull();
  });
  it('renders nothing in live mode', () => {
    mock.aiMode = 'live';
    render(<SampleBadge />);
    expect(screen.queryByTestId('sample-badge')).toBeNull();
  });
  it('applies the region class for the region variant', () => {
    render(<SampleBadge variant="region" />);
    expect(screen.getByTestId('sample-badge').className).toMatch(/region/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/Ai/SampleBadge.test.tsx`
Expected: FAIL — `./SampleBadge` does not exist.

- [ ] **Step 3: Create the component**

Create `frontend/src/components/Ai/SampleBadge.tsx`:

```tsx
import { useIsSampleMode } from '../../hooks/useAiGate';
import styles from './SampleBadge.module.css';

export interface SampleBadgeProps {
  /** 'inline' (default) sits beside an AI label; 'region' sits on a section header. */
  variant?: 'inline' | 'region';
  /** Solid fill (no dashed border) for placement inside an already-dashed container. */
  solid?: boolean;
}

// Truthful-by-default marker (spec §6). Renders ONLY in Preview; absent in Off
// (nothing renders) and Live (real output). Define-once: every AI surface that
// renders Preview/sample content mounts this beside its AI label or section header.
export function SampleBadge({ variant = 'inline', solid = false }: SampleBadgeProps) {
  if (!useIsSampleMode()) return null;
  const cls = [styles.sampleBadge, variant === 'region' ? styles.region : '', solid ? styles.solid : '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} aria-label="Sample data — illustrative, not real AI output" data-testid="sample-badge">
      Sample
    </span>
  );
}
```

- [ ] **Step 4: Create the styles**

Create `frontend/src/components/Ai/SampleBadge.module.css`:

```css
.sampleBadge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  color: var(--accent);
  background: color-mix(in oklch, var(--accent-soft) 70%, transparent);
  border: 1px dashed color-mix(in oklch, var(--accent) 45%, transparent);
}
/* Region variant: same pill, more separation when it sits on a section header. */
.region {
  margin-left: var(--s-2);
}
/* Solid variant: drop the dashed border + solid fill so the pill stays legible
   inside an already-dashed container (AiHunkAnnotation). */
.solid {
  border-color: transparent;
  background: var(--accent-soft);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/Ai/SampleBadge.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Ai/SampleBadge.tsx frontend/src/components/Ai/SampleBadge.module.css frontend/src/components/Ai/SampleBadge.test.tsx
git commit -m "feat(ai): add define-once SampleBadge marker"
```

---

## Task 6: Replace the 3 hardcoded sample strings with SampleBadge

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx`
- Modify: `frontend/src/components/PrDetail/SubmitDialog/PreSubmitValidatorCard.tsx`
- Modify: `frontend/src/components/Ai/AiComposerAssistant.tsx`
- Test: `frontend/src/components/Ai/sampleSurfaces.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/Ai/sampleSurfaces.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({ aiMode: 'preview' as 'off' | 'preview' | 'live', composerOn: true }));
vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }),
}));
vi.mock('../../hooks/useAiGate', async (orig) => {
  const actual = await orig<typeof import('../../hooks/useAiGate')>();
  return { ...actual, useAiGate: () => mock.composerOn };
});

import { AiSummaryCard } from '../PrDetail/OverviewTab/AiSummaryCard';
import { AiComposerAssistant } from './AiComposerAssistant';

beforeEach(() => { mock.aiMode = 'preview'; mock.composerOn = true; });

describe('card sample surfaces carry SampleBadge (not the old hardcoded string)', () => {
  it('AiSummaryCard shows the badge and no legacy string', () => {
    render(<AiSummaryCard summary={null} />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
    expect(screen.queryByText(/AI preview — sample content/i)).toBeNull();
  });
  it('AiComposerAssistant shows the badge and keeps the descriptive remainder', () => {
    render(<AiComposerAssistant />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
    expect(screen.getByText(/composer suggestions appear here/i)).toBeInTheDocument();
    expect(screen.queryByText(/AI preview — composer/i)).toBeNull();
  });
});
```

(`PreSubmitValidatorCard` needs `ValidatorResult[]` props; its badge is asserted via the e2e sweep in Task 11. The edit below is still required.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/Ai/sampleSurfaces.test.tsx`
Expected: FAIL — no `sample-badge`; the legacy strings still render.

- [ ] **Step 3: Edit `AiSummaryCard.tsx`**

Add the import (top of file, after the existing imports):

```tsx
import { SampleBadge } from '../../Ai/SampleBadge';
```

Replace the hardcoded chip (current lines 16-18):

```tsx
      <div className={`${styles.aiSummaryChip} muted`}>
        AI preview — sample content, not generated from this PR
      </div>
```

with:

```tsx
      <SampleBadge />
```

- [ ] **Step 4: Edit `PreSubmitValidatorCard.tsx`**

Add the import:

```tsx
import { SampleBadge } from '../../Ai/SampleBadge';
```

Replace the hardcoded chip (current lines 22-24):

```tsx
      <div className="ai-validator-card__chip muted">
        AI preview — sample content, not generated from this PR
      </div>
```

with:

```tsx
      <SampleBadge />
```

- [ ] **Step 5: Edit `AiComposerAssistant.tsx`**

Add the import (after the `useAiGate` import):

```tsx
import { SampleBadge } from './SampleBadge';
```

Replace the hardcoded span (current line 20):

```tsx
      <span className="ai-summary-chip muted">AI preview — composer suggestions appear here</span>
```

with:

```tsx
      <span className="ai-summary-chip muted">
        <SampleBadge /> composer suggestions appear here
      </span>
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/components/Ai/sampleSurfaces.test.tsx`
Expected: PASS.

- [ ] **Step 7: Verify build + full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/AiSummaryCard.tsx frontend/src/components/PrDetail/SubmitDialog/PreSubmitValidatorCard.tsx frontend/src/components/Ai/AiComposerAssistant.tsx frontend/src/components/Ai/sampleSurfaces.test.tsx
git commit -m "feat(ai): replace hardcoded sample strings with SampleBadge"
```

---

## Task 7: Add SampleBadge to the AI-labeled inline surfaces

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx`
- Modify: `frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx`

- [ ] **Step 1: Edit `AiHunkAnnotation.tsx` (solid variant, inside the dashed container)**

Add the import:

```tsx
import { SampleBadge } from '../../../Ai/SampleBadge';
```

In the `ai-hunk-meta` row (current lines 30-33), add the badge after the `AI` label:

```tsx
        <div className={`ai-hunk-meta ${styles.aiHunkMeta}`}>
          <span>AI</span>
          <SampleBadge solid />
          <span className={`chip chip-${chip.variant}`}>{chip.label}</span>
        </div>
```

- [ ] **Step 2: Edit `StaleDraftRow.tsx` (inside the `{aiSuggestion && (…)}` block)**

Add the import:

```tsx
import { SampleBadge } from '../../Ai/SampleBadge';
```

In the AI-suggestion block (current line 134), add the badge after the label text:

```tsx
            <div className={`ai-summary-label ${styles.staleAiLabel}`}>
              AI suggestion <SampleBadge />
            </div>
```

- [ ] **Step 3: Write the test**

Create `frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.sample.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HunkAnnotation } from '../../../../../api/types';

const mock = vi.hoisted(() => ({ aiMode: 'preview' as 'off' | 'preview' | 'live' }));
vi.mock('../../../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }),
}));

import { AiHunkAnnotation } from './AiHunkAnnotation';

const annotation = { body: 'Consider extracting this', tone: 'suggestion' } as unknown as HunkAnnotation;

beforeEach(() => { mock.aiMode = 'preview'; });

describe('AiHunkAnnotation sample badge', () => {
  it('renders the badge in preview', () => {
    render(<AiHunkAnnotation annotation={annotation} />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
  });
  it('omits the badge in off', () => {
    mock.aiMode = 'off';
    render(<AiHunkAnnotation annotation={annotation} />);
    expect(screen.queryByTestId('sample-badge')).toBeNull();
  });
});
```

(If `AiHunkAnnotation` needs a more specific `annotation` shape to render the chip, mirror the shape used by the file's existing test/fixtures; the badge sits in the always-rendered `ai-hunk-meta` row.)

- [ ] **Step 4: Run the test to verify it passes (after the edits)**

Run: `npx vitest run src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.sample.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify build + full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/AiHunkAnnotation.sample.test.tsx frontend/src/components/PrDetail/Reconciliation/StaleDraftRow.tsx
git commit -m "feat(ai): mark hunk-annotation + draft-suggestion sample content"
```

---

## Task 8: Region-level SampleBadge for label-less surfaces

**Files:**
- Modify: `frontend/src/components/ActivityRail/ActivityRail.tsx`
- Modify: `frontend/src/pages/InboxPage.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx`

- [ ] **Step 1: Edit `ActivityRail.tsx`**

Add the import:

```tsx
import { SampleBadge } from '../Ai/SampleBadge';
```

Add the region badge beside the "Activity" header (current lines 8-11):

```tsx
        <header className={styles.head}>
          <span className={styles.title}>Activity</span>
          <SampleBadge variant="region" />
          <span className={styles.muted}>last 24h</span>
        </header>
```

- [ ] **Step 2: Edit `InboxPage.tsx`**

Add the import:

```tsx
import { SampleBadge } from '../components/Ai/SampleBadge';
```

In the sections column (current return, the `<div className={styles.sections}>` block), add the enrichment-region marker as the first child when the gate is on:

```tsx
        <div className={styles.sections}>
          {showCategoryChip && <SampleBadge variant="region" />}
          {allEmpty && <EmptyAllSections />}
```

(`showActivityRail` already gates `<ActivityRail />`, which now carries its own badge.)

- [ ] **Step 3: Edit `FileTree.tsx`**

Add the import:

```tsx
import { SampleBadge } from '../../Ai/SampleBadge';
```

In the tree header (current lines 173-175), add the region marker when `aiPreview` (the `useAiGate('fileFocus')` value passed in):

```tsx
      <div className={`file-tree-header ${styles.fileTreeHeader}`}>
        Files · {viewedCount}/{files.length} viewed
        {aiPreview && <SampleBadge variant="region" />}
      </div>
```

- [ ] **Step 4: Write the test**

Create `frontend/src/components/ActivityRail/ActivityRail.sample.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({ aiMode: 'preview' as 'off' | 'preview' | 'live' }));
vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }),
}));

import { ActivityRail } from './ActivityRail';

beforeEach(() => { mock.aiMode = 'preview'; });

describe('ActivityRail sample badge', () => {
  it('renders the region badge in preview', () => {
    render(<ActivityRail />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
  });
  it('omits the badge in off', () => {
    mock.aiMode = 'off';
    render(<ActivityRail />);
    expect(screen.queryByTestId('sample-badge')).toBeNull();
  });
});
```

(`InboxPage` and `FileTree` region badges are exercised by the e2e sweep in Task 11 — both need substantial render context — so a unit test here covers the standalone `ActivityRail`; the e2e sweep covers the other two in the running app.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/ActivityRail/ActivityRail.sample.test.tsx`
Expected: PASS.

- [ ] **Step 6: Verify build + full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ActivityRail/ActivityRail.tsx frontend/src/components/ActivityRail/ActivityRail.sample.test.tsx frontend/src/pages/InboxPage.tsx frontend/src/components/PrDetail/FilesTab/FileTree.tsx
git commit -m "feat(ai): region-level SampleBadge on inbox + activity + file-tree"
```

---

## Task 9: OverviewTab — re-source the PrDescription prop

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx`

- [ ] **Step 1: Re-source the prop from `useAiGate('summary')`**

Replace the body lines (current lines 17-23):

```tsx
  const { preferences } = usePreferences();

  const aiPreview = preferences?.ui.aiPreview ?? false; // still needed for PrDescription prop
  const aiOn = useAiGate('summary');
```

with:

```tsx
  const aiOn = useAiGate('summary');
```

Update the `PrDescription` usage (current line 78) to pass `aiOn`:

```tsx
      <PrDescription title={prDetail.pr.title} body={prDetail.pr.body} aiPreview={aiOn} />
```

If `preferences` / the `usePreferences` import is now unused, remove the `const { preferences } = usePreferences();` line and the `import { usePreferences } ...` line (lint will flag any unused symbol).

- [ ] **Step 2: Verify build + lint + full suite**

Run: `npm run build && npm run lint && npm test`
Expected: PASS. (`PrDescription`'s AI-layout now tracks summary-card visibility, removing the only remaining direct `aiPreview` read.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx
git commit -m "refactor(ai): source PrDescription AI-layout from useAiGate('summary')"
```

---

## Task 10: Remove `aiPreview` from the FE

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/contexts/PreferencesContext.tsx`

- [ ] **Step 1: Remove the type field**

In `frontend/src/api/types.ts`, delete `aiPreview: boolean;` from `UiPreferences` (leave `aiMode`).

- [ ] **Step 2: Remove the context union member + arms**

In `frontend/src/contexts/PreferencesContext.tsx`:
- Delete `| 'aiPreview'` from the `PreferenceKey` union.
- Remove `'aiPreview'` from the `InboxSectionKey` `Exclude` (it becomes `Exclude<PreferenceKey, 'theme' | 'accent' | 'density' | 'ui.ai.mode'>`).
- Delete the `if (key === 'aiPreview') return prefs.ui.aiPreview;` arm in `readKey`.
- Delete the `if (key === 'aiPreview') return { ...prefs, ui: { ...prefs.ui, aiPreview: value as boolean } };` arm in `writeKey`.

- [ ] **Step 3: Run the build to find any stragglers**

Run: `npm run build`
Expected: PASS. If a `src/` test/mock still constructs `aiPreview`, the compiler flags it — remove the `aiPreview` key from that literal (the unit fixtures were already migrated in Tasks 1/3/4; this should be clean).

- [ ] **Step 4: Verify the full unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/contexts/PreferencesContext.tsx
git commit -m "refactor(ai): remove legacy aiPreview from the FE (mode is source of truth)"
```

---

## Task 11: e2e migration + cross-surface badge coverage

> **The TypeScript safety net does NOT reach e2e** — the specs infer types from local `makeDefaultPreferences()` and `e2e/` is outside the app tsconfig. Removing `aiPreview` produced zero e2e compile errors. Discover the footprint with grep; migrate every occurrence by hand.

**Files:** discover via grep, then migrate each. Known set: `settings-flow.spec.ts`, `settings-modal-visual.spec.ts`, `inbox.spec.ts`, `ai-gating-sweep.spec.ts`, `fixtures/preferences.ts`, `helpers/replace-mocks.ts`, `a11y-audit.spec.ts`. **Leave unchanged** (they POST legacy `{aiPreview}` directly to the *real* backend, still accepted by PR2): `ask-ai-drawer.spec.ts`, `parity-baselines.spec.ts`, `helpers/s4-setup.ts`.

- [ ] **Step 1: Discover the footprint**

Run: `rg -l "aiPreview" frontend/e2e/` and `rg -n "getByRole\('switch'" frontend/e2e/`
Expected: the file lists above. Confirm no mock-driven spec is missed.

- [ ] **Step 2: Migrate the shared/static GET fixtures (`aiPreview: false` → `aiMode: 'off'`)**

In `frontend/e2e/fixtures/preferences.ts` (`makeDefaultPreferences`), `frontend/e2e/helpers/replace-mocks.ts` (`defaultPreferences`), `frontend/e2e/.../a11y-audit.spec.ts`, `frontend/e2e/.../inbox.spec.ts` (inline `defaultPreferences`), and the inline `makeDefaultPreferences` in `settings-flow.spec.ts`, change the `ui` block from:

```ts
    ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
```

to:

```ts
    ui: { theme: 'system', accent: 'indigo', aiMode: 'off' as const, density: 'comfortable' },
```

(For `fixtures/preferences.ts` and `settings-flow.spec.ts` which use per-field `as const`, write `aiMode: 'off' as const`.)

- [ ] **Step 3: Migrate the mock POST handlers (recognize `ui.ai.mode`)**

In `settings-flow.spec.ts` and `settings-modal-visual.spec.ts`, in the `for (const [key, value] of Object.entries(body))` POST handler, replace the `aiPreview` branch with a `ui.ai.mode` branch:

```ts
        } else if (key === 'ui.ai.mode' && typeof value === 'string') {
          store.ui.aiMode = value as 'off' | 'preview' | 'live';
        }
```

In `inbox.spec.ts` (current lines 284-305) and `ai-gating-sweep.spec.ts` (current lines 195-212), replace the `body.aiPreview` keying with `ui.ai.mode` and emit `aiMode` in the GET response. For `inbox.spec.ts`:

```ts
  let aiMode: 'off' | 'preview' | 'live' = 'off';
  await page.route('**/api/preferences', async (route: Route) => {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { 'ui.ai.mode'?: string };
      if (typeof body['ui.ai.mode'] === 'string') {
        aiMode = body['ui.ai.mode'] as 'off' | 'preview' | 'live';
      }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...defaultPreferences, ui: { ...defaultPreferences.ui, aiMode } }),
    });
  });
```

Apply the equivalent change to `ai-gating-sweep.spec.ts` (it uses `makeDefaultPreferences()` per request — spread `ui: { ...prefs.ui, aiMode }`).

- [ ] **Step 4: Migrate the toggle locators (switch → radio)**

Replace each `page.getByRole('switch', { name: /ai preview/i })` usage:
- To turn AI on: `await page.getByRole('radio', { name: 'Preview' }).click();`
- To turn AI off: `await page.getByRole('radio', { name: 'Off' }).click();`

In `inbox.spec.ts` (line ~358) the toggle reveals the rail — click the `Preview` radio. In `ai-gating-sweep.spec.ts` (lines ~375 on, ~436 off) — click `Preview` then later `Off`. Update any pre-click assertion that relied on the switch's checked state to read `aria-checked` on the corresponding radio.

- [ ] **Step 5: Add cross-surface badge assertions to the sweep**

In `ai-gating-sweep.spec.ts`, after toggling to Preview and on each AI surface the sweep already visits, assert the sample marker is visible (this realizes the spec §8 coverage guard in the running app). Example, at each visited surface:

```ts
    await expect(page.getByTestId('sample-badge').first()).toBeVisible();
```

and after toggling Off, assert it is gone on those surfaces:

```ts
    await expect(page.getByTestId('sample-badge')).toHaveCount(0);
```

- [ ] **Step 6: Run the migrated e2e specs**

Run: `npx playwright test inbox ai-gating-sweep settings-flow settings-modal-visual a11y-audit`
Expected: PASS. (If a spec false-greens — passes without actually flipping mode — re-check that its mock POST handler reads `ui.ai.mode` and the GET emits `aiMode`.)

- [ ] **Step 7: Commit**

```bash
git add frontend/e2e
git commit -m "test(e2e): migrate AI toggle specs to ui.ai.mode + assert SampleBadge coverage"
```

---

## Task 12: Architectural-invariants doc — tri-state + truthful-by-default

**Files:**
- Modify: `.ai/docs/architectural-invariants.md`

- [ ] **Step 1: Read the current AI-gating invariant**

Open `.ai/docs/architectural-invariants.md` and locate the binary-gate bullet (~line 7), currently of the form: *"Capability-flag-gated AI seams. PoC ships every AI seam interface with a Noop\* implementation … `/api/capabilities` returns false for every `ai.*` flag in PoC. v2 lights them up by registering implementations and flipping flags — no Core refactor."*

- [ ] **Step 2: Replace it with the tri-state description + the truthful-by-default invariant**

Replace that bullet with:

```markdown
- **Tri-state-gated AI seams.** AI is gated by `AiMode {Off, Preview, Live}` (config `ui.ai.mode`), not a boolean. **Off** → `Noop*` seams (no AI). **Preview** → `Placeholder*` seams (canned sample data, *unmistakably labeled* — see truthful-by-default below). **Live** → real provider output, gated by the availability probe. `GET /api/capabilities` returns the nine `ai.*` flags resolved from mode: Off → all false; Preview → all true; Live → true only where a real seam is registered AND the provider probe succeeds. The legacy `ui.aiPreview` bool survives only as a derived/translated wire field for back-compat (`aiPreview = mode != Off`); the FE source of truth is `ui.aiMode`.
- **Truthful-by-default.** Every AI surface that renders Preview/sample content MUST render the shared `SampleBadge` (`frontend/src/components/Ai/SampleBadge.tsx`). Showing fabricated output as if it were real is the most dangerous failure mode; the badge is the one canonical marker, inherited by every P1+ surface.
```

- [ ] **Step 3: Verify nothing else references the old binary framing**

Run: `rg -n "aiPreview|binary|flipping flags" .ai/docs/architectural-invariants.md`
Expected: only the new derived-wire-field mention remains; no stale binary-gate claim.

- [ ] **Step 4: Commit**

```bash
git add .ai/docs/architectural-invariants.md
git commit -m "docs(ai): update architectural invariant to tri-state + truthful-by-default"
```

---

## Task 13: Full gate + final review

**Files:** none (verification + handoff).

- [ ] **Step 1: Run the full local gate (CI-equivalent)**

Run, from `frontend/`, one at a time:
- `npm run lint` → PASS
- `npm run build` → PASS
- `npm test` → PASS
- `npm run test:e2e` → PASS (flaky vitest/Playwright specs under load are environmental — re-run a failing spec in isolation single-threaded before treating it as a regression).

- [ ] **Step 2: Confirm the acceptance criteria (spec §11)**

Verify each: Off|Preview selector replaces the switch; Preview renders sample content with badges everywhere (inline + region) and Off hides them; FE reads/writes `ui.aiMode`/`ui.ai.mode` and no `aiPreview`; no `/api/capabilities` request; a live config displays as Preview with no POST on render; no hardcoded "AI preview — sample content…" strings remain (`rg -n "AI preview — sample content" frontend/src` → no matches); the invariant doc is updated; the full suite is green; backend is untouched (`git diff --stat origin/V2 -- PRism.* PRism.Web` → empty).

- [ ] **Step 3: Final review pass**

Dispatch a final code-review pass over the whole branch diff vs `V2` (per superpowers:subagent-driven-development's final-review step), then use superpowers:finishing-a-development-branch to open the PR → `V2`.

---

## Self-Review

**Spec coverage:** §2 scope → T1–T10 (FE migration), T8/T7/T6 (SampleBadge surfaces incl. inbox/activity), T12 (doc); non-goals (Live/consent/disabled-states/probe-cache) correctly absent. §4 data-flow → T2 (POST literal key), T3 (derive + two-factor), KTD-3 dissolves (T4/T10 stop writing the bool). §5 every file → mapped in the File Structure table + tasks. §6 SampleBadge two variants → T5. §7 invariant → T12. §8 testing → reactivity re-key (T3), AppearancePane assertion (T4), defensive live-config (T4), two-factor lock (T3), SampleBadge (T5), per-surface (T6–T8), e2e full enumeration + coverage assertions (T11). §11 acceptance → T13 Step 2. No gaps found.

**Placeholder scan:** every code step shows complete code; commands are exact (`npx vitest run`, `npm run build/lint/test/test:e2e`); the two surfaces whose unit tests need heavy render context (`InboxPage`, `FileTree` region; `PreSubmitValidatorCard`) are explicitly covered by the e2e sweep (T11) rather than left as a placeholder.

**Type consistency:** `AiMode = 'off'|'preview'|'live'` used consistently; `useIsSampleMode()` (T3) is the single predicate `SampleBadge` (T5) consumes; `set('ui.ai.mode', …)` key matches the `PreferenceKey` union member (T2) and the `writeKey`/`readKey` arms; the selector `value` cast `as 'off'|'preview'` matches `SegmentedControl<T>`'s inferred `T`; `aiMode` field added in T1, removed-`aiPreview` in T10 after all consumers migrate (every interim commit compiles).
