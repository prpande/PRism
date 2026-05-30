# Design Parity Recovery — PR7 (Browser-Style PR Tab Strip, Route b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the persistent browser-style PR tab strip across the top of the SPA (Row 2) with visual fidelity to the handoff, route-(b) scope: no keyboard bindings (`⌘W`/`⌘1-9`), no localStorage persistence, no stale-tab error chip. Click + middle-click close + close-X are the only close affordances; tabs survive only the current SPA session.

**Architecture:** A new `OpenTabsContext` holds in-memory state (`openTabs: OpenTab[]`, `unreadTabs: Set<string>`, `overflowMenuOpen: boolean`). A new `PrTabStrip` component renders Row 2 between `<Header>` and `<Routes>` in `App.tsx` and is hidden when `openTabs.length === 0`. Three entry points add tabs (Inbox row click, PasteUrlInput, PrDetailPage direct load). Close uses click on the `×` + middle-click on the tab body. Submit-in-flight on the same prRef blocks close (via existing `useSubmitInFlight`). `pr-updated` SSE marks tabs unread; tab focus clears the unread flag. `identity-changed` SSE clears all open tabs.

**Tech Stack:** React 19 + TypeScript + Vite + react-router-dom; CSS Modules colocated with components; existing EventStream / useSubmitInFlight infrastructure.

---

## Slice-context summary

**Spec:** [`docs/specs/2026-05-29-design-parity-recovery-design.md`](../specs/2026-05-29-design-parity-recovery-design.md) — § 4.7 (PR7), § 6.5 (composer-open interactions), § 6.9 (Inbox baseline re-capture), § 1.3 (native-shell coupling).

**Spec-deferred brainstorm decisions resolved at plan time (the four decisions confirmed by the user before plan authoring):**

| # | Decision | Resolution | Rationale |
|---|----------|------------|-----------|
| 1 | Native-shell coupling — (a) adapter, (b) visual-only, (c) accept rework | **(b) visual-only**: NO `⌘W`, NO `⌘1-9`, NO localStorage. Mouse interactions only (click + middle-click + ×). | Lowest rework surface against the TBD native-shell decision. Kbd + persistence revisited post-shell. |
| 2 | Stale-tab error chip visual spec (new design carve-out per § 2.2) | **NOT shipped in PR7.** Route (b) drops persistence → stale tabs only arise from token-rotation mid-session, which is handled by clearing `openTabs` on `identity-changed`. | Removing persistence removes the surface that the error chip protected. Defer chip design to post-shell. |
| 3 | Closing tab with in-flight submit (§ 6.5) | **Block close.** Tab `×` and middle-click are inert while `useSubmitInFlight().inFlight && prRef === active tab's prRef`. Tooltip explains why. | Spec § 4.7 default. Submit carries observable UI state; silent close would orphan the SubmitProgressIndicator. |
| 4 | Closing tab with open composer (§ 6.5) | **Allow.** Drafts auto-persist server-side per S4. No prompt. | Spec § 4.7 default. The auto-save path is the safety net. |

**Out of scope for PR7 (deferred):**

- Keyboard bindings (`⌘W`, `⌘1-9`) — D58 (sidecar; PR9 / post-shell-decision).
- localStorage persistence — D59 (sidecar; PR9 / post-shell-decision).
- Stale-tab error chip visual + behaviour — D60 (sidecar; reopens if persistence comes back).
- A cap on `openTabs.length` — § 4.7 says no cap; overflow menu handles the visual.
- Modal-open tab close (`ForeignPendingReviewModal`) — outside the three default cases (composer / submit / direct close). Treated as "allow"; if modal-open close turns out to leak listener state, log a follow-up in PR9.

**Sweep of prior-slice deferrals targeting PR7:** Performed via `grep -n "to PR7\|in PR7\|PR7 " docs/specs/*-deferrals.md`. No prior-slice deferrals route work into the design-parity PR7 (older "PR7" references in S3/S4/S5/S6 deferrals are unrelated internal slice numbering). Confirmed clean.

---

## File structure

```
frontend/src/
  contexts/
    OpenTabsContext.tsx                       (NEW — provider + hook + types)
  components/
    PrTabStrip/
      PrTabStrip.tsx                          (NEW — Row 2 component)
      PrTabStrip.module.css                   (NEW — handoff .pr-tabbar* port)
  pages/
    PrDetailPage.tsx                          (MODIFIED — add-tab + setTitle + setUnread-clear)
  components/
    Inbox/
      InboxRow.tsx                            (MODIFIED — addTab before navigate)
      PasteUrlInput.tsx                       (MODIFIED — addTab before navigate)
  App.tsx                                     (MODIFIED — OpenTabsProvider + PrTabStrip mount)
  hooks/
    useTabUnreadSignal.ts                     (NEW — pr-updated SSE → markUnread)
    useTabIdentityReset.ts                    (NEW — identity-changed → clear)

frontend/e2e/
  parity-baselines.spec.ts                    (MODIFIED — add app-chrome-tabstrip + un-fixme inbox + inbox-activity-rail)

docs/specs/
  2026-05-29-design-parity-recovery-deferrals.md  (APPENDED — D58, D59, D60)
```

Three new modules + two new hooks + four modified files + one e2e + one deferrals sidecar.

---

## Phase 1 — Foundation

### Task 1: `OpenTabsContext` shape, provider, and hook

**Files:**
- Create: `frontend/src/contexts/OpenTabsContext.tsx`
- Test: `frontend/src/contexts/OpenTabsContext.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/contexts/OpenTabsContext.test.tsx
import { describe, it, expect } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { OpenTabsProvider, useOpenTabs } from './OpenTabsContext';

const wrapper = ({ children }: { children: ReactNode }) => (
  <OpenTabsProvider>{children}</OpenTabsProvider>
);

describe('OpenTabsContext', () => {
  it('starts with empty tabs and no unread', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    expect(result.current.openTabs).toEqual([]);
    expect(result.current.unreadKeys.size).toBe(0);
  });

  it('addTab appends and is idempotent on prRefKey', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const ref = { owner: 'acme', repo: 'api', number: 123 };
    act(() => result.current.addTab(ref, 'Initial title'));
    act(() => result.current.addTab(ref, 'Updated title'));
    expect(result.current.openTabs).toHaveLength(1);
    expect(result.current.openTabs[0].title).toBe('Initial title');
  });

  it('setTitle updates an existing tab without changing order', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    const b = { owner: 'acme', repo: 'api', number: 2 };
    act(() => {
      result.current.addTab(a, null);
      result.current.addTab(b, null);
      result.current.setTitle(a, 'Fixed title for #1');
    });
    expect(result.current.openTabs.map((t) => t.ref.number)).toEqual([1, 2]);
    expect(result.current.openTabs[0].title).toBe('Fixed title for #1');
    expect(result.current.openTabs[1].title).toBeNull();
  });

  it('closeTab removes by prRefKey', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    const b = { owner: 'acme', repo: 'api', number: 2 };
    act(() => {
      result.current.addTab(a, null);
      result.current.addTab(b, null);
      result.current.closeTab(a);
    });
    expect(result.current.openTabs).toHaveLength(1);
    expect(result.current.openTabs[0].ref.number).toBe(2);
  });

  it('markUnread / clearUnread maintain the Set', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    act(() => {
      result.current.addTab(a, null);
      result.current.markUnread('acme/api/1');
    });
    expect(result.current.unreadKeys.has('acme/api/1')).toBe(true);
    act(() => result.current.clearUnread('acme/api/1'));
    expect(result.current.unreadKeys.has('acme/api/1')).toBe(false);
  });

  it('markUnread is a no-op for unknown prRefKeys', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    act(() => result.current.markUnread('ghost/repo/99'));
    expect(result.current.unreadKeys.size).toBe(0);
  });

  it('clearAllTabs empties tabs and unread set', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    act(() => {
      result.current.addTab(a, 't');
      result.current.markUnread('acme/api/1');
      result.current.clearAllTabs();
    });
    expect(result.current.openTabs).toEqual([]);
    expect(result.current.unreadKeys.size).toBe(0);
  });

  it('useOpenTabs throws outside provider', () => {
    const Probe = () => {
      useOpenTabs();
      return null;
    };
    expect(() => render(<Probe />)).toThrow(/OpenTabsProvider/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npx vitest run src/contexts/OpenTabsContext.test.tsx
```

Expected: FAIL — `Cannot find module './OpenTabsContext'`.

- [ ] **Step 3: Implement `OpenTabsContext`**

```tsx
// frontend/src/contexts/OpenTabsContext.tsx
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PrReference } from '../api/types';
import { prRefKey } from '../api/types';

export interface OpenTab {
  ref: PrReference;
  // null until PrDetailPage resolves the PR title via usePrDetail.
  // While null, PrTabStrip falls back to a "#NNNN" label.
  title: string | null;
}

export interface OpenTabsContextValue {
  openTabs: OpenTab[];
  unreadKeys: ReadonlySet<string>;
  addTab(ref: PrReference, title: string | null): void;
  setTitle(ref: PrReference, title: string): void;
  closeTab(ref: PrReference): void;
  markUnread(prRefKey: string): void;
  clearUnread(prRefKey: string): void;
  clearAllTabs(): void;
}

const Ctx = createContext<OpenTabsContextValue | null>(null);

export function OpenTabsProvider({ children }: { children: ReactNode }) {
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [unreadKeys, setUnreadKeys] = useState<ReadonlySet<string>>(() => new Set());

  const addTab = useCallback((ref: PrReference, title: string | null) => {
    const key = prRefKey(ref);
    setOpenTabs((prev) => {
      if (prev.some((t) => prRefKey(t.ref) === key)) return prev;
      return [...prev, { ref, title }];
    });
  }, []);

  const setTitle = useCallback((ref: PrReference, title: string) => {
    const key = prRefKey(ref);
    setOpenTabs((prev) =>
      prev.map((t) => (prRefKey(t.ref) === key ? { ...t, title } : t)),
    );
  }, []);

  const closeTab = useCallback((ref: PrReference) => {
    const key = prRefKey(ref);
    setOpenTabs((prev) => prev.filter((t) => prRefKey(t.ref) !== key));
    setUnreadKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const markUnread = useCallback((key: string) => {
    setUnreadKeys((prev) => {
      // No-op for keys that aren't open — keeps the set bounded by the visible tabs.
      // The producer (useTabUnreadSignal) doesn't need to know which tabs are open;
      // the context filters it.
      return prev;
    });
    setOpenTabs((current) => {
      const exists = current.some((t) => prRefKey(t.ref) === key);
      if (exists) {
        setUnreadKeys((prev) => {
          if (prev.has(key)) return prev;
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      }
      return current;
    });
  }, []);

  const clearUnread = useCallback((key: string) => {
    setUnreadKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const clearAllTabs = useCallback(() => {
    setOpenTabs([]);
    setUnreadKeys(new Set());
  }, []);

  const value = useMemo(
    () => ({
      openTabs,
      unreadKeys,
      addTab,
      setTitle,
      closeTab,
      markUnread,
      clearUnread,
      clearAllTabs,
    }),
    [openTabs, unreadKeys, addTab, setTitle, closeTab, markUnread, clearUnread, clearAllTabs],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOpenTabs(): OpenTabsContextValue {
  const v = useContext(Ctx);
  if (v == null) {
    throw new Error('useOpenTabs must be used inside OpenTabsProvider');
  }
  return v;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npx vitest run src/contexts/OpenTabsContext.test.tsx
```

Expected: PASS — 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/contexts/OpenTabsContext.tsx frontend/src/contexts/OpenTabsContext.test.tsx
git commit -m "feat(pr7): OpenTabsContext provider, hook, and unit tests"
```

---

### Task 2: `PrTabStrip` skeleton component + module CSS

**Files:**
- Create: `frontend/src/components/PrTabStrip/PrTabStrip.tsx`
- Create: `frontend/src/components/PrTabStrip/PrTabStrip.module.css`
- Test: `frontend/src/components/PrTabStrip/PrTabStrip.test.tsx`

This task ports the handoff `.pr-tabbar*` rules (screens.css:1442-1604) under module class names. Active-tab merge + unread dot + close button are all visual; behaviour wiring lands in Tasks 7-12.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/PrTabStrip/PrTabStrip.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../../contexts/OpenTabsContext';
import { PrTabStrip } from './PrTabStrip';
import { useEffect } from 'react';

function Seed({ count }: { count: number }) {
  const { addTab } = useOpenTabs();
  useEffect(() => {
    for (let i = 1; i <= count; i++) {
      addTab({ owner: 'acme', repo: 'api', number: i }, `Title ${i}`);
    }
  }, [addTab, count]);
  return null;
}

function wrap(ui: React.ReactNode) {
  return (
    <MemoryRouter>
      <OpenTabsProvider>{ui}</OpenTabsProvider>
    </MemoryRouter>
  );
}

describe('PrTabStrip', () => {
  it('renders nothing when openTabs is empty', () => {
    const { container } = render(wrap(<PrTabStrip />));
    expect(container.querySelector('[data-testid="pr-tabstrip"]')).toBeNull();
  });

  it('renders one tab per openTab and shows #NNNN prefix', () => {
    render(
      wrap(
        <>
          <Seed count={3} />
          <PrTabStrip />
        </>,
      ),
    );
    const strip = screen.getByTestId('pr-tabstrip');
    expect(strip).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('Title 1')).toBeInTheDocument();
  });

  it('falls back to "#NNNN" when title is null', () => {
    function SeedNullTitle() {
      const { addTab } = useOpenTabs();
      useEffect(() => {
        addTab({ owner: 'acme', repo: 'api', number: 42 }, null);
      }, [addTab]);
      return null;
    }
    render(
      wrap(
        <>
          <SeedNullTitle />
          <PrTabStrip />
        </>,
      ),
    );
    const tab = screen.getByRole('tab', { name: /acme\/api#42/i });
    expect(tab).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npx vitest run src/components/PrTabStrip/PrTabStrip.test.tsx
```

Expected: FAIL — `Cannot find module './PrTabStrip'`.

- [ ] **Step 3: Implement `PrTabStrip.module.css` from handoff source**

```css
/* frontend/src/components/PrTabStrip/PrTabStrip.module.css */
/* Ports design/handoff/screens.css:1442-1604 .pr-tabbar* under module class names.
   Active-tab top-edge merge effect uses negative margin-bottom + positive padding-bottom
   to overlap the strip's own bottom border with the page area below. */

.tabbar {
  background: var(--surface-0);
  border-bottom: 1px solid var(--border-1);
  padding: 0 var(--s-3);
  position: relative;
  z-index: 2;
}

.inner {
  display: flex;
  gap: 2px;
  align-items: stretch;
  min-height: 36px;
  overflow: hidden;
}

.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 12px;
  height: 36px;
  max-width: 240px;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-top: 2px solid transparent;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  position: relative;
  transition: background var(--t-fast), color var(--t-fast);
  user-select: none;
}

.tab:hover {
  background: var(--surface-1);
  color: var(--text-1);
}

.tabActive {
  background: var(--surface-1);
  border-color: var(--border-1);
  border-top-color: var(--accent);
  color: var(--text-1);
  font-weight: 500;
  margin-bottom: -1px;
  padding-bottom: 1px;
}

.num {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  flex: none;
}

.tabActive .num { color: var(--accent); }

.title {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}

.tabUnread .title { font-weight: 600; color: var(--text-1); }

.close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  color: var(--text-3);
  background: transparent;
  flex: none;
  opacity: 0;
  transition: opacity var(--t-fast), background var(--t-fast), color var(--t-fast);
  border: none;
  cursor: pointer;
}

.tab:hover .close,
.tabActive .close,
.tab:focus-within .close { opacity: 1; }

.close:hover {
  background: var(--surface-3);
  color: var(--text-1);
}

.close:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.overflow { position: relative; display: flex; align-items: center; }

.more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  margin-left: 4px;
  font-size: var(--text-xs);
  color: var(--text-3);
  background: var(--surface-1);
  border: 1px dashed var(--border-2);
  border-radius: var(--radius-2);
  cursor: pointer;
}

.more:hover {
  background: var(--surface-3);
  color: var(--text-1);
  border-style: solid;
}

.menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 280px;
  background: var(--surface-1);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-3);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  padding: 4px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.menuItem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: var(--text-xs);
  color: var(--text-1);
  background: transparent;
  border: none;
  border-radius: var(--radius-2);
  text-align: left;
  width: 100%;
  cursor: pointer;
}

.menuItem:hover { background: var(--surface-3); }

.menuNum {
  font-family: var(--font-mono);
  color: var(--text-3);
  font-size: 11px;
  flex: none;
}

.menuTitle {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menuClose {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  border-radius: 4px;
  flex: none;
  border: none;
  background: transparent;
  cursor: pointer;
}

.menuClose:hover { background: var(--surface-2); color: var(--text-1); }
```

- [ ] **Step 4: Implement skeleton `PrTabStrip` (renders tabs but no behaviour yet)**

```tsx
// frontend/src/components/PrTabStrip/PrTabStrip.tsx
import { useLocation } from 'react-router-dom';
import { useOpenTabs, type OpenTab } from '../../contexts/OpenTabsContext';
import { prRefKey } from '../../api/types';
import styles from './PrTabStrip.module.css';

function tabLabel(t: OpenTab): string {
  return t.title ?? `${t.ref.owner}/${t.ref.repo}#${t.ref.number}`;
}

function isActiveTab(pathname: string, t: OpenTab): boolean {
  const prefix = `/pr/${t.ref.owner}/${t.ref.repo}/${t.ref.number}`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function PrTabStrip() {
  const { openTabs, unreadKeys } = useOpenTabs();
  const { pathname } = useLocation();

  if (openTabs.length === 0) {
    return null;
  }

  return (
    <div className={styles.tabbar} data-testid="pr-tabstrip" role="tablist" aria-label="Open PRs">
      <div className={styles.inner}>
        {openTabs.map((t) => {
          const key = prRefKey(t.ref);
          const active = isActiveTab(pathname, t);
          const unread = unreadKeys.has(key);
          const className = [
            styles.tab,
            active ? styles.tabActive : '',
            unread ? styles.tabUnread : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              className={className}
              data-prref={key}
              aria-label={tabLabel(t)}
            >
              <span className={styles.num}>#{t.ref.number}</span>
              {unread && <span className={styles.dot} aria-hidden="true" />}
              <span className={styles.title}>{tabLabel(t)}</span>
              <span className={styles.close} aria-hidden="true">
                ×
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd frontend && npx vitest run src/components/PrTabStrip/PrTabStrip.test.tsx
```

Expected: PASS — 3 tests pass.

- [ ] **Step 6: Run prettier on new files**

```bash
cd frontend && npx prettier --write src/components/PrTabStrip src/contexts/OpenTabsContext.tsx src/contexts/OpenTabsContext.test.tsx
```

Expected: 4 files reformatted (or "unchanged" if already conformant).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrTabStrip
git commit -m "feat(pr7): PrTabStrip skeleton component + module CSS port from handoff"
```

---

### Task 3: Wire `OpenTabsProvider` + `PrTabStrip` into `App.tsx`

**Files:**
- Modify: `frontend/src/App.tsx`

The provider wraps the SPA so every consumer (Inbox, PrDetailPage, PasteUrlInput) can read it without prop drilling. `PrTabStrip` renders BELOW `<Header>` and ABOVE `<Routes>` so the strip sits as Row 2 across every route.

- [ ] **Step 1: Apply the change**

In `frontend/src/App.tsx`:

Add import (after the existing context imports near line 5-7):

```tsx
import { OpenTabsProvider } from './contexts/OpenTabsContext';
import { PrTabStrip } from './components/PrTabStrip/PrTabStrip';
```

Replace the `tree` JSX (lines 58-81) to insert `<PrTabStrip />` between `<Header>` and `<Routes>` and wrap the entire returned tree with `<OpenTabsProvider>` INSIDE the `ToastProvider`/`CheatsheetProvider` and ABOVE `EventStreamProvider` so that:
- All consumers can call `useOpenTabs()`
- The SSE bridges (Tasks 10, 13) can subscribe to events emitted from inside `EventStreamProvider`

New `App.tsx` body (replace lines 58-91 with this; preserve everything above):

```tsx
  const tree: ReactNode = (
    <>
      <Header hasToken={authState.hasToken} />
      <PrTabStrip />
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route
          path="/settings"
          element={isAuthed ? <SettingsPage /> : <Navigate to="/setup" replace />}
        />
        <Route path="/" element={isAuthed ? <InboxPage /> : <Navigate to="/setup" replace />} />
        <Route
          path="/pr/:owner/:repo/:number"
          element={isAuthed ? <PrDetailPage /> : <Navigate to="/setup" replace />}
        >
          <Route index element={<OverviewTab />} />
          <Route path="files/*" element={<FilesTab />} />
          <Route path="drafts" element={<DraftsTabRoute />} />
        </Route>
        <Route path="*" element={<Navigate to={isAuthed ? '/' : '/setup'} replace />} />
      </Routes>
      <ToastContainer />
      <Cheatsheet />
    </>
  );

  return (
    <ErrorBoundary>
      <ToastProvider>
        <CheatsheetProvider>
          <OpenTabsProvider>
            {isAuthed ? <EventStreamProvider>{tree}</EventStreamProvider> : tree}
          </OpenTabsProvider>
        </CheatsheetProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
```

- [ ] **Step 2: Run full vitest suite to verify no regressions in App tests**

```bash
cd frontend && npx vitest run --silent
```

Expected: All tests pass. (If any App-level test mocks `useEventSource` and breaks on the new provider position, fix the mock to wrap accordingly.)

- [ ] **Step 3: Manual smoke — Row 2 is invisible with no open tabs**

```bash
cd frontend && npm run dev
```

Open `http://localhost:5180/` in a browser. Expected: Header renders normally; no second row of tabs is visible below it. `<div data-testid="pr-tabstrip">` is absent from the DOM. Kill the dev server after verifying.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(pr7): mount PrTabStrip Row 2 between Header and Routes; wrap with OpenTabsProvider"
```

---

## Phase 2 — Tab Add Wiring

### Task 4: Inbox row click adds tab before navigate

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx` (line 28-33)
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx` (CREATE or extend existing if present)

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/Inbox/InboxRow.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../../contexts/OpenTabsContext';
import { InboxRow } from './InboxRow';
import type { PrInboxItem } from '../../api/types';

const PR: PrInboxItem = {
  reference: { owner: 'acme', repo: 'api', number: 99 },
  title: 'Add user pagination',
  author: 'alice',
  repo: 'acme/api',
  updatedAt: new Date().toISOString(),
  pushedAt: new Date().toISOString(),
  iterationNumber: 2,
  commentCount: 3,
  additions: 50,
  deletions: 10,
  headSha: 'abc',
  ci: 'none',
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
};

function TabsProbe() {
  const { openTabs } = useOpenTabs();
  return <div data-testid="tab-count">{openTabs.length}</div>;
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="path">{loc.pathname}</div>;
}

describe('InboxRow click → opens tab', () => {
  it('adds the PR to openTabs and navigates to /pr/owner/repo/number', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenTabsProvider>
          <TabsProbe />
          <LocationProbe />
          <Routes>
            <Route
              path="/"
              element={
                <InboxRow pr={PR} enrichment={undefined} showCategoryChip={false} maxDiff={100} />
              }
            />
            <Route path="/pr/:owner/:repo/:number" element={<div>PR Detail</div>} />
          </Routes>
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('tab-count').textContent).toBe('0');
    await userEvent.click(screen.getByRole('button', { name: /Add user pagination/i }));
    expect(screen.getByTestId('tab-count').textContent).toBe('1');
    expect(screen.getByTestId('path').textContent).toBe('/pr/acme/api/99');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx
```

Expected: FAIL — `Expected '1', received '0'` (no addTab call yet).

- [ ] **Step 3: Apply implementation**

In `frontend/src/components/Inbox/InboxRow.tsx`, add the import (line 2 area) and modify `onClick`:

```tsx
// near top
import { useOpenTabs } from '../../contexts/OpenTabsContext';

// inside InboxRow component, replace line 28-33 region with:
export function InboxRow({ pr, enrichment, showCategoryChip, maxDiff }: Props) {
  const navigate = useNavigate();
  const { addTab } = useOpenTabs();
  const fr = freshness(pr.updatedAt);
  const isFirstVisit = pr.lastViewedHeadSha == null;
  const onClick = () => {
    addTab(pr.reference, pr.title);
    navigate(`/pr/${pr.reference.owner}/${pr.reference.repo}/${pr.reference.number}`);
  };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.test.tsx
git commit -m "feat(pr7): InboxRow click opens a tab before navigate"
```

---

### Task 5: `PasteUrlInput` adds tab before navigate

**Files:**
- Modify: `frontend/src/components/Inbox/PasteUrlInput.tsx`

- [ ] **Step 1: Apply implementation**

Read `frontend/src/components/Inbox/PasteUrlInput.tsx` to confirm current shape, then near the `navigate(...)` call (line 19), add `addTab` from `useOpenTabs()`:

```tsx
import { useOpenTabs } from '../../contexts/OpenTabsContext';

// inside component body, before navigate call:
const { addTab } = useOpenTabs();

// at the navigate site (around line 19), pre-add:
addTab(resp.ref, null);
navigate(`/pr/${resp.ref.owner}/${resp.ref.repo}/${resp.ref.number}`);
```

The title is null at paste time (we don't know it from the URL alone — PrDetailPage will fill it in via Task 6).

- [ ] **Step 2: Extend existing test or add a focused one**

If `PasteUrlInput.test.tsx` exists, add a case asserting `addTab` is called via probe. If not, create:

```tsx
// frontend/src/components/Inbox/PasteUrlInput.addTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../../contexts/OpenTabsContext';
import { PasteUrlInput } from './PasteUrlInput';

vi.mock('../../api/parsePrUrl', () => ({
  parsePrUrl: vi.fn(async () => ({
    ok: true,
    ref: { owner: 'acme', repo: 'api', number: 7 },
    error: null,
    configuredHost: 'github.com',
    urlHost: 'github.com',
  })),
}));

function Probe() {
  const { openTabs } = useOpenTabs();
  return <div data-testid="tabs">{openTabs.length}</div>;
}

describe('PasteUrlInput adds a tab when the URL parses', () => {
  it('adds the parsed ref before navigating', async () => {
    render(
      <MemoryRouter>
        <OpenTabsProvider>
          <Probe />
          <PasteUrlInput />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    await userEvent.type(
      screen.getByPlaceholderText(/paste/i),
      'https://github.com/acme/api/pull/7{enter}',
    );
    expect(await screen.findByText('1')).toBeInTheDocument();
  });
});
```

If the existing `PasteUrlInput.tsx` uses a different mock path / placeholder, mirror the existing test conventions (read a sibling test before authoring).

- [ ] **Step 2.5: Run prettier**

```bash
cd frontend && npx prettier --write src/components/Inbox/PasteUrlInput.tsx src/components/Inbox/PasteUrlInput.addTab.test.tsx
```

- [ ] **Step 3: Run vitest**

```bash
cd frontend && npx vitest run src/components/Inbox/PasteUrlInput
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Inbox/PasteUrlInput.tsx frontend/src/components/Inbox/PasteUrlInput.addTab.test.tsx
git commit -m "feat(pr7): PasteUrlInput adds tab before navigate"
```

---

### Task 6: `PrDetailPage` direct-URL load adds tab + sets title once resolved

**Files:**
- Modify: `frontend/src/pages/PrDetailPage.tsx`
- Test: `frontend/src/pages/PrDetailPage.tabbing.test.tsx` (CREATE)

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/PrDetailPage.tabbing.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../contexts/OpenTabsContext';
import { PrDetailPage } from './PrDetailPage';

// Minimal stubs for the providers + hooks PrDetailPage depends on. Project
// convention: mock the API layer, not the route param parsing. usePrDetail
// returns the title we expect to land in the tab.
vi.mock('../hooks/usePrDetail', () => ({
  usePrDetail: () => ({
    data: {
      pr: {
        reference: { owner: 'acme', repo: 'api', number: 42 },
        title: 'Direct-link title',
        author: 'alice',
        state: 'open',
        headSha: 'abc',
        baseSha: 'def',
        headBranch: 'feat',
        baseBranch: 'main',
        mergeability: 'mergeable',
        ciSummary: '',
        isMerged: false,
        isClosed: false,
        openedAt: new Date().toISOString(),
      },
      iterations: [],
    },
    showSkeleton: false,
    error: null,
    reload: () => {},
  }),
}));

vi.mock('../hooks/useDraftSession', () => ({
  useDraftSession: () => ({
    session: { draftComments: [], draftReplies: [] },
    refetch: () => Promise.resolve(),
  }),
}));
vi.mock('../hooks/useActivePrUpdates', () => ({
  useActivePrUpdates: () => ({ headShaChanged: false, clear: () => {} }),
}));
vi.mock('../hooks/useStateChangedSubscriber', () => ({
  useStateChangedSubscriber: () => {},
}));
vi.mock('../hooks/useCrossTabPrPresence', () => ({
  useCrossTabPrPresence: () => ({ readOnly: false }),
}));
vi.mock('../hooks/useReconcile', () => ({
  useReconcile: () => ({ reload: () => Promise.resolve() }),
}));

function Probe() {
  const { openTabs } = useOpenTabs();
  return (
    <div data-testid="tabs">
      {openTabs.map((t) => `${t.ref.owner}/${t.ref.repo}#${t.ref.number}=${t.title ?? 'null'}`).join(',')}
    </div>
  );
}

describe('PrDetailPage on direct URL load', () => {
  it('adds an openTab and sets its title once usePrDetail resolves', async () => {
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/42']}>
        <OpenTabsProvider>
          <Probe />
          <Routes>
            <Route path="/pr/:owner/:repo/:number" element={<PrDetailPage />}>
              <Route index element={<div>Overview</div>} />
            </Route>
          </Routes>
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('tabs').textContent).toContain('acme/api#42=Direct-link title'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npx vitest run src/pages/PrDetailPage.tabbing.test.tsx
```

Expected: FAIL — tabs are empty (no addTab call wired yet).

- [ ] **Step 3: Apply implementation**

In `frontend/src/pages/PrDetailPage.tsx`, inside `PrDetailPageInner` after the existing hooks block:

```tsx
import { useOpenTabs } from '../contexts/OpenTabsContext';
// ... existing imports

// inside PrDetailPageInner, after the existing hooks:
const { addTab, setTitle, clearUnread } = useOpenTabs();

useEffect(() => {
  addTab(ref, data?.pr.title ?? null);
}, [addTab, ref]);

useEffect(() => {
  if (data?.pr.title) {
    setTitle(ref, data.pr.title);
  }
}, [data?.pr.title, ref, setTitle]);

useEffect(() => {
  // Active tab clears unread on focus. prRefKey from types module.
  clearUnread(`${ref.owner}/${ref.repo}/${ref.number}`);
}, [clearUnread, ref]);
```

Import `useEffect` from React if not already imported.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npx vitest run src/pages/PrDetailPage.tabbing.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/PrDetailPage.tsx frontend/src/pages/PrDetailPage.tabbing.test.tsx
git commit -m "feat(pr7): PrDetailPage adds tab on direct URL load, sets title, clears unread on focus"
```

---

## Phase 3 — Close Affordance

### Task 7: Tab `×` close button + middle-click close + submit-in-flight block

**Files:**
- Modify: `frontend/src/components/PrTabStrip/PrTabStrip.tsx`
- Modify: `frontend/src/components/PrTabStrip/PrTabStrip.test.tsx` (extend)

The active tab close navigates to the left-neighbour tab; if no neighbour, navigates to `/`. The strip subscribes to `useSubmitInFlight()` to disable close for the in-flight prRef.

- [ ] **Step 1: Write the failing tests**

Extend `PrTabStrip.test.tsx`:

```tsx
import userEvent from '@testing-library/user-event';
import { useNavigate, Routes, Route } from 'react-router-dom';
import { fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

vi.mock('../../hooks/useSubmitInFlight', () => ({
  useSubmitInFlight: vi.fn(() => ({ inFlight: false, prRef: null })),
}));

import { useSubmitInFlight } from '../../hooks/useSubmitInFlight';

describe('PrTabStrip close affordance', () => {
  it('clicking × removes the tab from openTabs', async () => {
    function Harness() {
      const { addTab } = useOpenTabs();
      useEffect(() => {
        addTab({ owner: 'acme', repo: 'api', number: 1 }, 'A');
        addTab({ owner: 'acme', repo: 'api', number: 2 }, 'B');
      }, [addTab]);
      return <PrTabStrip />;
    }
    render(wrap(<Harness />));
    const tab1 = screen.getByRole('tab', { name: /A/ });
    const close1 = tab1.querySelector('[aria-label="Close tab"]') as HTMLElement;
    expect(close1).not.toBeNull();
    await userEvent.click(close1);
    expect(screen.queryByRole('tab', { name: /A/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /B/ })).toBeInTheDocument();
  });

  it('middle-click on a tab closes it', async () => {
    function Harness() {
      const { addTab } = useOpenTabs();
      useEffect(() => {
        addTab({ owner: 'acme', repo: 'api', number: 1 }, 'A');
      }, [addTab]);
      return <PrTabStrip />;
    }
    render(wrap(<Harness />));
    const tab = screen.getByRole('tab', { name: /A/ });
    fireEvent.mouseDown(tab, { button: 1 });
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('close button is disabled when submit is in flight for that tab', async () => {
    vi.mocked(useSubmitInFlight).mockReturnValue({ inFlight: true, prRef: 'acme/api/1' });
    function Harness() {
      const { addTab } = useOpenTabs();
      useEffect(() => {
        addTab({ owner: 'acme', repo: 'api', number: 1 }, 'A');
        addTab({ owner: 'acme', repo: 'api', number: 2 }, 'B');
      }, [addTab]);
      return <PrTabStrip />;
    }
    render(wrap(<Harness />));
    const closeA = screen
      .getByRole('tab', { name: /A/ })
      .querySelector('[aria-label="Close tab"]') as HTMLButtonElement;
    const closeB = screen
      .getByRole('tab', { name: /B/ })
      .querySelector('[aria-label="Close tab"]') as HTMLButtonElement;
    expect(closeA).toBeDisabled();
    expect(closeA.getAttribute('title')).toMatch(/submit in progress/i);
    expect(closeB).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npx vitest run src/components/PrTabStrip/PrTabStrip.test.tsx
```

Expected: 3 new tests FAIL.

- [ ] **Step 3: Apply implementation**

Update `PrTabStrip.tsx`:

```tsx
import { useLocation, useNavigate } from 'react-router-dom';
import { useOpenTabs, type OpenTab } from '../../contexts/OpenTabsContext';
import { prRefKey, type PrReference } from '../../api/types';
import { useSubmitInFlight } from '../../hooks/useSubmitInFlight';
import styles from './PrTabStrip.module.css';

function tabLabel(t: OpenTab): string {
  return t.title ?? `${t.ref.owner}/${t.ref.repo}#${t.ref.number}`;
}

function isActiveTab(pathname: string, t: OpenTab): boolean {
  const prefix = `/pr/${t.ref.owner}/${t.ref.repo}/${t.ref.number}`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function pathFor(ref: PrReference): string {
  return `/pr/${ref.owner}/${ref.repo}/${ref.number}`;
}

export function PrTabStrip() {
  const { openTabs, unreadKeys, closeTab } = useOpenTabs();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const submit = useSubmitInFlight();

  if (openTabs.length === 0) {
    return null;
  }

  const handleClose = (idx: number) => {
    const tab = openTabs[idx];
    const wasActive = isActiveTab(pathname, tab);
    closeTab(tab.ref);
    if (!wasActive) return;
    if (idx > 0) {
      navigate(pathFor(openTabs[idx - 1].ref));
    } else if (openTabs.length > 1) {
      navigate(pathFor(openTabs[1].ref));
    } else {
      navigate('/');
    }
  };

  const handleTabClick = (tab: OpenTab) => {
    if (!isActiveTab(pathname, tab)) {
      navigate(pathFor(tab.ref));
    }
  };

  return (
    <div className={styles.tabbar} data-testid="pr-tabstrip" role="tablist" aria-label="Open PRs">
      <div className={styles.inner}>
        {openTabs.map((t, idx) => {
          const key = prRefKey(t.ref);
          const active = isActiveTab(pathname, t);
          const unread = unreadKeys.has(key);
          const closeBlocked = submit.inFlight && submit.prRef === key;
          const className = [
            styles.tab,
            active ? styles.tabActive : '',
            unread ? styles.tabUnread : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              className={className}
              data-prref={key}
              aria-label={tabLabel(t)}
              onClick={() => handleTabClick(t)}
              onMouseDown={(e) => {
                if (e.button === 1 && !closeBlocked) {
                  e.preventDefault();
                  handleClose(idx);
                }
              }}
            >
              <span className={styles.num}>#{t.ref.number}</span>
              {unread && <span className={styles.dot} aria-hidden="true" />}
              <span className={styles.title}>{tabLabel(t)}</span>
              <button
                type="button"
                aria-label="Close tab"
                className={styles.close}
                disabled={closeBlocked}
                title={closeBlocked ? "Can't close — submit in progress" : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose(idx);
                }}
              >
                ×
              </button>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

**Note on nested `<button>`:** HTML disallows interactive descendants inside `<button>`. The tab's outer is a `<button role="tab">` because the test asserts roles. Refactor to `<div role="tab" tabIndex={0}>` and put a real keyboard handler (Enter/Space) on the div to preserve activation semantics:

```tsx
<div
  key={key}
  role="tab"
  tabIndex={0}
  aria-selected={active}
  className={className}
  data-prref={key}
  aria-label={tabLabel(t)}
  onClick={() => handleTabClick(t)}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleTabClick(t);
    }
  }}
  onMouseDown={(e) => {
    if (e.button === 1 && !closeBlocked) {
      e.preventDefault();
      handleClose(idx);
    }
  }}
>
  <span className={styles.num}>#{t.ref.number}</span>
  {unread && <span className={styles.dot} aria-hidden="true" />}
  <span className={styles.title}>{tabLabel(t)}</span>
  <button
    type="button"
    aria-label="Close tab"
    className={styles.close}
    disabled={closeBlocked}
    title={closeBlocked ? "Can't close — submit in progress" : undefined}
    onClick={(e) => {
      e.stopPropagation();
      handleClose(idx);
    }}
  >
    ×
  </button>
</div>
```

Update Task 2's tests that assert `getByRole('tab', ...)` — the role mapping survives the div refactor because `role="tab"` is explicit on the div. Re-run Task 2's tests as a regression check.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run src/components/PrTabStrip/PrTabStrip.test.tsx
```

Expected: All 6 tests PASS (3 from Task 2 + 3 from Task 7).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrTabStrip/PrTabStrip.tsx frontend/src/components/PrTabStrip/PrTabStrip.test.tsx
git commit -m "feat(pr7): tab close via × button + middle-click; submit-in-flight blocks close"
```

---

## Phase 4 — Visual States and Live Signals

### Task 8: `useTabUnreadSignal` — `pr-updated` SSE → `markUnread`

**Files:**
- Create: `frontend/src/hooks/useTabUnreadSignal.ts`
- Test: `frontend/src/hooks/useTabUnreadSignal.test.tsx`

The hook subscribes to `pr-updated` and calls `markUnread(prRef)` for any event NOT matching the currently-active route. Mounted at App level (inside `EventStreamProvider` AND inside `OpenTabsProvider`).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/hooks/useTabUnreadSignal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../contexts/OpenTabsContext';
import { useEffect } from 'react';
import { useTabUnreadSignal } from './useTabUnreadSignal';

// Fake EventStream handle that exposes a manual fire() for the test.
const listeners: Record<string, ((p: unknown) => void)[]> = {};
vi.mock('./useEventSource', () => ({
  useEventSource: () => ({
    on: (type: string, cb: (p: unknown) => void) => {
      (listeners[type] ??= []).push(cb);
      return () => {
        listeners[type] = (listeners[type] ?? []).filter((c) => c !== cb);
      };
    },
    subscriberId: () => Promise.resolve('test'),
    reconnectSignal: () => new AbortController().signal,
    close: () => {},
  }),
}));

function fireSse(type: string, payload: unknown) {
  (listeners[type] ?? []).forEach((cb) => cb(payload));
}

function Probe() {
  const { openTabs, unreadKeys, addTab } = useOpenTabs();
  useEffect(() => {
    addTab({ owner: 'acme', repo: 'api', number: 1 }, 'A');
    addTab({ owner: 'acme', repo: 'api', number: 2 }, 'B');
  }, [addTab]);
  useTabUnreadSignal();
  return (
    <div>
      <div data-testid="unread">{[...unreadKeys].sort().join(',')}</div>
      <div data-testid="tabs">{openTabs.length}</div>
    </div>
  );
}

describe('useTabUnreadSignal', () => {
  it('marks tab unread when pr-updated fires for a non-active tab', async () => {
    const { findByTestId } = render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <OpenTabsProvider>
          <Probe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    fireSse('pr-updated', { prRef: 'acme/api/2', headShaChanged: true, commentCountDelta: 0 });
    const node = await findByTestId('unread');
    expect(node.textContent).toBe('acme/api/2');
  });

  it('does NOT mark unread when pr-updated fires for the active tab', async () => {
    listeners['pr-updated'] = [];
    const { findByTestId } = render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <OpenTabsProvider>
          <Probe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    fireSse('pr-updated', { prRef: 'acme/api/1', headShaChanged: true, commentCountDelta: 0 });
    const node = await findByTestId('unread');
    expect(node.textContent).toBe('');
  });

  it('ignores pr-updated for prRefs that are not open', async () => {
    listeners['pr-updated'] = [];
    const { findByTestId } = render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <OpenTabsProvider>
          <Probe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    fireSse('pr-updated', { prRef: 'ghost/repo/99', headShaChanged: true, commentCountDelta: 0 });
    const node = await findByTestId('unread');
    expect(node.textContent).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npx vitest run src/hooks/useTabUnreadSignal.test.tsx
```

Expected: FAIL — `Cannot find module './useTabUnreadSignal'`.

- [ ] **Step 3: Implement the hook**

```ts
// frontend/src/hooks/useTabUnreadSignal.ts
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useEventSource } from './useEventSource';
import { useOpenTabs } from '../contexts/OpenTabsContext';

// Active-route check is done at signal time (not in a useEffect dep) so a
// route change does NOT re-mark an in-flight unread signal as unread — once
// the user is on a tab, any signal that arrives for it is considered "seen".
function activeKeyFromPathname(pathname: string): string | null {
  const m = pathname.match(/^\/pr\/([^/]+)\/([^/]+)\/(\d+)(?:\/|$)/);
  if (!m) return null;
  return `${m[1]}/${m[2]}/${m[3]}`;
}

export function useTabUnreadSignal(): void {
  const events = useEventSource();
  const { markUnread } = useOpenTabs();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!events) return;
    const off = events.on('pr-updated', (payload) => {
      const activeKey = activeKeyFromPathname(pathname);
      if (payload.prRef === activeKey) return;
      markUnread(payload.prRef);
    });
    return off;
  }, [events, markUnread, pathname]);
}
```

- [ ] **Step 4: Mount the hook in `App.tsx`**

Add a thin internal component that calls the hook so it runs INSIDE `EventStreamProvider` and `OpenTabsProvider`:

```tsx
// At the top of App.tsx (after other imports):
import { useTabUnreadSignal } from './hooks/useTabUnreadSignal';

// Define above `export function App()`:
function TabSignals() {
  useTabUnreadSignal();
  return null;
}

// In `tree`, mount it just before `<Routes>`:
<Header hasToken={authState.hasToken} />
<PrTabStrip />
<TabSignals />
<Routes>
  ...
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd frontend && npx vitest run src/hooks/useTabUnreadSignal.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useTabUnreadSignal.ts frontend/src/hooks/useTabUnreadSignal.test.tsx frontend/src/App.tsx
git commit -m "feat(pr7): pr-updated SSE marks non-active open tabs unread"
```

---

### Task 9: `identity-changed` SSE clears `openTabs`

**Files:**
- Create: `frontend/src/hooks/useTabIdentityReset.ts`
- Test: `frontend/src/hooks/useTabIdentityReset.test.tsx`
- Modify: `frontend/src/App.tsx` (mount inside `TabSignals`)

A token rotation (via `/api/auth/replace`) may leave the new identity unable to see PRs the previous identity could. Without persistence we can't have "stale tabs across reload," but mid-session token-replace is possible. Clearing `openTabs` on `identity-changed` is the simplest correct posture — matches the existing useAuth refetch flow.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/hooks/useTabIdentityReset.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEffect } from 'react';
import { OpenTabsProvider, useOpenTabs } from '../contexts/OpenTabsContext';
import { useTabIdentityReset } from './useTabIdentityReset';

const listeners: Record<string, ((p: unknown) => void)[]> = {};
vi.mock('./useEventSource', () => ({
  useEventSource: () => ({
    on: (type: string, cb: (p: unknown) => void) => {
      (listeners[type] ??= []).push(cb);
      return () => {
        listeners[type] = (listeners[type] ?? []).filter((c) => c !== cb);
      };
    },
    subscriberId: () => Promise.resolve('test'),
    reconnectSignal: () => new AbortController().signal,
    close: () => {},
  }),
}));

function fireSse(type: string, payload: unknown) {
  (listeners[type] ?? []).forEach((cb) => cb(payload));
}

function Probe() {
  const { openTabs, addTab } = useOpenTabs();
  useEffect(() => {
    addTab({ owner: 'acme', repo: 'api', number: 1 }, 'A');
    addTab({ owner: 'acme', repo: 'api', number: 2 }, 'B');
  }, [addTab]);
  useTabIdentityReset();
  return <div data-testid="count">{openTabs.length}</div>;
}

describe('useTabIdentityReset', () => {
  it('clears all tabs when identity-changed fires', async () => {
    const { findByTestId } = render(
      <MemoryRouter>
        <OpenTabsProvider>
          <Probe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect((await findByTestId('count')).textContent).toBe('2');
    fireSse('identity-changed', { type: 'identity-change' });
    expect((await findByTestId('count')).textContent).toBe('0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npx vitest run src/hooks/useTabIdentityReset.test.tsx
```

Expected: FAIL — `Cannot find module './useTabIdentityReset'`.

- [ ] **Step 3: Implement the hook**

```ts
// frontend/src/hooks/useTabIdentityReset.ts
import { useEffect } from 'react';
import { useEventSource } from './useEventSource';
import { useOpenTabs } from '../contexts/OpenTabsContext';

export function useTabIdentityReset(): void {
  const events = useEventSource();
  const { clearAllTabs } = useOpenTabs();
  useEffect(() => {
    if (!events) return;
    return events.on('identity-changed', () => {
      clearAllTabs();
    });
  }, [events, clearAllTabs]);
}
```

- [ ] **Step 4: Mount inside `TabSignals` in App.tsx**

```tsx
import { useTabIdentityReset } from './hooks/useTabIdentityReset';

function TabSignals() {
  useTabUnreadSignal();
  useTabIdentityReset();
  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd frontend && npx vitest run src/hooks/useTabIdentityReset.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useTabIdentityReset.ts frontend/src/hooks/useTabIdentityReset.test.tsx frontend/src/App.tsx
git commit -m "feat(pr7): identity-changed SSE clears all open tabs"
```

---

## Phase 5 — Overflow Menu

### Task 10: Overflow `+ N more` menu when `openTabs.length > 6`

**Files:**
- Modify: `frontend/src/components/PrTabStrip/PrTabStrip.tsx`
- Extend: `frontend/src/components/PrTabStrip/PrTabStrip.test.tsx`

The first 6 tabs render inline; the remaining N go into a `+ N more` chevron menu that opens on click. Each menu item carries a per-item close affordance (handoff `.pr-tabbar-menu-close`).

- [ ] **Step 1: Write the failing tests**

Add to `PrTabStrip.test.tsx`:

```tsx
describe('PrTabStrip overflow menu', () => {
  function Seed7() {
    const { addTab } = useOpenTabs();
    useEffect(() => {
      for (let i = 1; i <= 7; i++) {
        addTab({ owner: 'acme', repo: 'api', number: i }, `T${i}`);
      }
    }, [addTab]);
    return null;
  }

  it('shows + N more chevron when openTabs.length > 6', () => {
    render(wrap(<><Seed7 /><PrTabStrip /></>));
    expect(screen.getByRole('button', { name: /\+ 1 more/i })).toBeInTheDocument();
  });

  it('inline tabs are the first 6; menu holds the rest', async () => {
    render(wrap(<><Seed7 /><PrTabStrip /></>));
    // 6 tabs in the strip
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(6);
    expect(tabs[5].getAttribute('data-prref')).toBe('acme/api/6');
    await userEvent.click(screen.getByRole('button', { name: /\+ 1 more/i }));
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('T7');
  });

  it('menu item close removes the overflowed tab without navigating', async () => {
    render(wrap(<><Seed7 /><PrTabStrip /></>));
    await userEvent.click(screen.getByRole('button', { name: /\+ 1 more/i }));
    const closeBtn = screen.getByLabelText('Close T7');
    await userEvent.click(closeBtn);
    expect(screen.queryByRole('button', { name: /\+ 1 more/i })).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npx vitest run src/components/PrTabStrip/PrTabStrip.test.tsx
```

Expected: 3 new tests FAIL.

- [ ] **Step 3: Apply implementation**

Extend `PrTabStrip.tsx` (replace the body to factor inline-vs-overflow):

```tsx
import { useState } from 'react';

const INLINE_TAB_CAP = 6;

export function PrTabStrip() {
  const { openTabs, unreadKeys, closeTab } = useOpenTabs();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const submit = useSubmitInFlight();
  const [menuOpen, setMenuOpen] = useState(false);

  if (openTabs.length === 0) return null;

  const inline = openTabs.slice(0, INLINE_TAB_CAP);
  const overflowed = openTabs.slice(INLINE_TAB_CAP);

  const handleClose = (idx: number) => {
    const tab = openTabs[idx];
    const wasActive = isActiveTab(pathname, tab);
    closeTab(tab.ref);
    if (!wasActive) return;
    if (idx > 0) {
      navigate(pathFor(openTabs[idx - 1].ref));
    } else if (openTabs.length > 1) {
      navigate(pathFor(openTabs[1].ref));
    } else {
      navigate('/');
    }
  };

  // Existing renderTab function unchanged; render inline list, then overflow.
  return (
    <div className={styles.tabbar} data-testid="pr-tabstrip" role="tablist" aria-label="Open PRs">
      <div className={styles.inner}>
        {inline.map((t, idx) => renderTab(t, idx))}
        {overflowed.length > 0 && (
          <div className={styles.overflow}>
            <button
              type="button"
              className={styles.more}
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              + {overflowed.length} more
            </button>
            {menuOpen && (
              <div role="menu" className={styles.menu}>
                {overflowed.map((t, i) => {
                  const idx = INLINE_TAB_CAP + i;
                  const closeBlocked = submit.inFlight && submit.prRef === prRefKey(t.ref);
                  return (
                    <div role="menuitem" key={prRefKey(t.ref)} className={styles.menuItem}>
                      <span className={styles.menuNum}>#{t.ref.number}</span>
                      <button
                        type="button"
                        className={styles.menuTitle}
                        onClick={() => {
                          setMenuOpen(false);
                          navigate(pathFor(t.ref));
                        }}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                      >
                        {tabLabel(t)}
                      </button>
                      <button
                        type="button"
                        aria-label={`Close ${tabLabel(t)}`}
                        className={styles.menuClose}
                        disabled={closeBlocked}
                        title={closeBlocked ? "Can't close — submit in progress" : undefined}
                        onClick={() => handleClose(idx)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // Local helper using closed-over state; keep beside the return for clarity.
  function renderTab(t: OpenTab, idx: number) {
    const key = prRefKey(t.ref);
    const active = isActiveTab(pathname, t);
    const unread = unreadKeys.has(key);
    const closeBlocked = submit.inFlight && submit.prRef === key;
    const className = [
      styles.tab,
      active ? styles.tabActive : '',
      unread ? styles.tabUnread : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div
        key={key}
        role="tab"
        tabIndex={0}
        aria-selected={active}
        className={className}
        data-prref={key}
        aria-label={tabLabel(t)}
        onClick={() => {
          if (!active) navigate(pathFor(t.ref));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!active) navigate(pathFor(t.ref));
          }
        }}
        onMouseDown={(e) => {
          if (e.button === 1 && !closeBlocked) {
            e.preventDefault();
            handleClose(idx);
          }
        }}
      >
        <span className={styles.num}>#{t.ref.number}</span>
        {unread && <span className={styles.dot} aria-hidden="true" />}
        <span className={styles.title}>{tabLabel(t)}</span>
        <button
          type="button"
          aria-label="Close tab"
          className={styles.close}
          disabled={closeBlocked}
          title={closeBlocked ? "Can't close — submit in progress" : undefined}
          onClick={(e) => {
            e.stopPropagation();
            handleClose(idx);
          }}
        >
          ×
        </button>
      </div>
    );
  }
}
```

(JS hoisting allows `renderTab` to appear below the `return`; if your TypeScript setup requires definition-before-use, lift it inside the component body above the `return`.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run src/components/PrTabStrip/PrTabStrip.test.tsx
```

Expected: 9 tests PASS.

- [ ] **Step 5: Click-outside-to-close on the menu** — small but important UX. Add a one-line `useEffect` that listens on `mousedown` and closes the menu when the click lands outside:

```tsx
import { useEffect, useRef } from 'react';

// inside PrTabStrip, near the menuOpen state:
const overflowRef = useRef<HTMLDivElement | null>(null);

useEffect(() => {
  if (!menuOpen) return;
  const onDown = (e: MouseEvent) => {
    if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
      setMenuOpen(false);
    }
  };
  document.addEventListener('mousedown', onDown);
  return () => document.removeEventListener('mousedown', onDown);
}, [menuOpen]);

// attach to the .overflow wrapper:
<div className={styles.overflow} ref={overflowRef}>
```

Add a unit test asserting click-outside closes the menu:

```tsx
it('clicking outside the overflow menu closes it', async () => {
  render(wrap(<><Seed7 /><PrTabStrip /><div data-testid="outside">Outside</div></>));
  await userEvent.click(screen.getByRole('button', { name: /\+ 1 more/i }));
  expect(screen.getByRole('menu')).toBeInTheDocument();
  await userEvent.click(screen.getByTestId('outside'));
  expect(screen.queryByRole('menu')).toBeNull();
});
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrTabStrip
git commit -m "feat(pr7): overflow + N more menu with per-item navigate + close + click-outside"
```

---

## Phase 6 — Parity Baselines and Spec Docs

### Task 11: Add `app-chrome-tabstrip` parity baseline + un-fixme Inbox baselines

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts`

Per spec § 4.7 the capture target is three open PRs, two read + one unread. Per § 6.9, PR7 also un-fixmes `inbox` and `inbox-activity-rail` (the first time those zones get baselines committed, since no earlier PR owned them).

For the tabstrip baseline: seed three tabs by navigating to three PR detail URLs in sequence (each adds to openTabs via Task 6), then return to `/` so all three render inactive. Mark the middle one unread by firing a `pr-updated` SSE via the existing `/test/emit-pr-updated` hook (S6 PR9 added this).

- [ ] **Step 1: Add the tabstrip zone**

In `frontend/e2e/parity-baselines.spec.ts`, replace the trailing PR7-comment block (lines 192-196) with:

```ts
test.describe('parity baselines — app chrome', () => {
  test('app-chrome-tabstrip', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    // Seed three open tabs by navigating directly to three PR URLs.
    // setupAndOpenScenarioPr's fixture exposes acme/api/123; we add two
    // sibling refs via the cluster-test seed routes if needed. For PR7 we
    // navigate to three fixture-known PRs.
    await page.goto('/pr/acme/api/123');
    await page.locator('[data-testid="pr-header"]').waitFor();
    await page.goto('/pr/acme/api/124');
    await page.locator('[data-testid="pr-header"]').waitFor();
    await page.goto('/pr/acme/api/125');
    await page.locator('[data-testid="pr-header"]').waitFor();
    // Return to Inbox so all three tabs render inactive — captures the
    // "no-active" visual state which best surfaces the three-tab strip.
    await page.goto('/');
    // Mark the middle tab unread via the test hook. POST /test/emit-pr-updated
    // is the deterministic banner-trigger added in S6 PR9.
    const emitResp = await page.request.post('/test/emit-pr-updated', {
      data: { prRef: 'acme/api/124', headShaChanged: true, commentCountDelta: 1 },
      headers: { Origin: 'http://localhost:5180' },
    });
    if (!emitResp.ok()) {
      throw new Error(
        `POST /test/emit-pr-updated failed: ${emitResp.status()} ${await emitResp.text()}`,
      );
    }
    await page.locator('[data-testid="pr-tabstrip"]').waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(page.locator('[data-testid="pr-tabstrip"]')).toHaveScreenshot(
      'app-chrome-tabstrip.png',
      SCREENSHOT_OPTS,
    );
  });
});
```

Notes:
- If `setupAndOpenScenarioPr` only seeds one PR fixture, the implementer adds two sibling fixtures in the test setup helper (or use the existing `/test/seed-…` routes — see `helpers/s4-setup.ts` for the established pattern). If sibling fixtures aren't quick to seed, document the deviation: drop to **two** open tabs (one read, one unread) and update the spec § 4.7 capture-target prose in the same commit.
- The `/test/emit-pr-updated` endpoint exists in the test-host configuration only — confirm by grepping `PRism.Web/Endpoints/` for `emit-pr-updated`.

- [ ] **Step 2: Un-fixme `inbox` and `inbox-activity-rail`**

Change `test.fixme('inbox', ...)` and `test.fixme('inbox-activity-rail', ...)` to `test('inbox', ...)` and `test('inbox-activity-rail', ...)`.

- [ ] **Step 3: Capture all three baselines**

Run the dev server (`npm run dev` in `frontend/`) and the .NET backend in a separate terminal (`dotnet run --project src/PRism.Web --configuration Release`).

```bash
cd frontend && npx playwright test parity-baselines --update-snapshots
```

Expected: three new PNGs written under `frontend/e2e/__screenshots__/<platform>/`:
- `app-chrome-tabstrip.png` (~5–10 KB, the three-tab strip with one unread dot)
- `inbox.png` (~50–80 KB, Inbox at Y=0 below Header, no Row 2 visible since the test sets up empty openTabs)
- `inbox-activity-rail.png` (~30–50 KB, activity rail render at 1440px)

- [ ] **Step 4: Sanity-run without `--update-snapshots`**

```bash
cd frontend && npx playwright test parity-baselines
```

Expected: all parity-baseline tests PASS (the baseline you just captured matches).

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/parity-baselines.spec.ts frontend/e2e/__screenshots__
git commit -m "test(pr7): app-chrome-tabstrip parity baseline + un-fixme inbox baselines"
```

---

### Task 12: Update spec § 4.7 with brainstorm-pass decisions and append deferrals D58-D60

**Files:**
- Modify: `docs/specs/2026-05-29-design-parity-recovery-design.md` (§ 4.7)
- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` (append D58, D59, D60)

The spec's "edge cases deferred to PR7's brainstorm pass" block at lines 313-317 needs to be rewritten to reflect the route-(b) decisions. The deferrals sidecar gets three new D-numbers.

- [ ] **Step 1: Patch spec § 4.7**

In `docs/specs/2026-05-29-design-parity-recovery-design.md`, replace the "Native-shell coupling" + "Edge cases deferred" paragraphs (lines 311-317) with:

```markdown
**Native-shell coupling — resolution.** PR7's brainstorm pass selected **route (b) visual-only**: NO `⌘W` (close tab), NO `⌘1-9` (jump to tab), NO middle-click? — middle-click DOES ship (mouse interaction, not a kbd binding, low rework risk), NO localStorage persistence. Tabs survive only the current SPA session and are cleared on `identity-changed`. Keyboard bindings and persistence are revisited after the native-shell framework decision lands (see [`D58`](2026-05-29-design-parity-recovery-deferrals.md#d58) keyboard, [`D59`](2026-05-29-design-parity-recovery-deferrals.md#d59) persistence). See § 1.3.

**Edge cases deferred to PR7's brainstorm pass — resolutions.**
- Closing a tab with an open composer: **allow.** Drafts auto-persist server-side per S4.
- Closing a tab with an in-flight submit: **block** while `useSubmitInFlight().inFlight && prRef === active tab's prRef`. Tooltip: "Can't close — submit in progress." Wired via `useSubmitInFlight()` which already tracks the single-slot SubmitLockRegistry.
- Stale `openTabs` entries on reload: **N/A** — route (b) drops persistence; no reload state to recover. Mid-session token rotation handled by clearing all tabs on `identity-changed`. Stale-tab error chip visual spec **deferred to post-shell-decision follow-up** ([`D60`](2026-05-29-design-parity-recovery-deferrals.md#d60)).
- `openTabs.length > some-large-N`: **no cap**; the `+ N more` overflow menu past 6 inline tabs handles the visual.
```

- [ ] **Step 2: Append D58, D59, D60 to the deferrals sidecar**

In `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`, append at the bottom (preserve the existing trailing log-entry convention used by D1-D57):

```markdown
## Implementation-time deferrals — PR7 (browser-style PR tab strip, route b)

### D58 — Keyboard bindings (`⌘W`, `⌘1-9`) deferred to post-shell-decision

**Source:** PR7 brainstorm pass (2026-05-30); ship-tier (b) visual-only route per spec § 4.7 + § 1.3.
**Spec position:** § 4.7 lines 294-297 list `⌘1-9` / `⌘W` / middle-click as interactions. Plan resolves to mouse-only (click + middle-click + ×).
**Reality:** The native-shell decision (WebView2 / Tauri / Electron / MAUI Blazor Hybrid) is unresolved; `⌘W` will likely collide with native window-close, `⌘1-9` with shell-level shortcuts. Implementing them now buys behavior we'll likely have to redesign.
**Plan resolution:** PR7 ships NO keyboard bindings. Click + middle-click + × button only. Revisit after the shell framework is chosen; the binding architecture (in-app capture vs shell-mediated) depends on shell IPC primitives.
**Status:** Applied in PR7.
**Cross-refs:** Spec § 1.3 (native-shell coupling risk); § 4.7 (interactions list).

### D59 — `openTabs` localStorage persistence deferred to post-shell-decision

**Source:** PR7 brainstorm pass (2026-05-30); ship-tier (b) visual-only route.
**Spec position:** § 4.7 line 284 originally specified `prism.openTabs.v1` localStorage key + parse/validate path.
**Reality:** Same shell-coupling rationale as D58. Native shells may carry their own window-state restoration; competing with it produces drift. The persistence surface area is small to add later once the shell choice fixes the semantics.
**Plan resolution:** PR7 ships in-memory `openTabs` state only. Reload clears tabs. The cost is small: closing the browser/tab loses the open-tab list (the user can re-open from Inbox in two clicks).
**Status:** Applied in PR7.
**Cross-refs:** D58 (kbd bindings); spec § 1.3.

### D60 — Stale-tab error chip visual spec deferred — no surface in route (b)

**Source:** PR7 brainstorm pass (2026-05-30); ship-tier (b) visual-only route.
**Spec position:** § 4.7 line 316 — "Visual spec for the stale-tab error chip is new design with no handoff reference and lands in PR7's brainstorm — flagged as a small redesign carve-out per § 2.2."
**Reality:** The error chip exists to handle two stale scenarios: (i) PR no longer accessible on reload because `openTabs` was persisted, and (ii) mid-session token rotation. Route (b) drops persistence — (i) cannot occur. (ii) is handled by clearing all tabs on `identity-changed` SSE — strictly simpler than rendering a per-tab error chip.
**Plan resolution:** No error chip ships. The small-redesign carve-out under § 2.2 is NOT consumed. If persistence is added back via a future follow-up (D59 reopens), this deferral reopens too — the chip is needed when reload state can be stale.
**Status:** Applied in PR7. Reopens with D59.
**Cross-refs:** D59; spec § 2.2 redesign carve-out policy.
```

- [ ] **Step 3: Commit**

```bash
git add docs/specs/2026-05-29-design-parity-recovery-design.md docs/specs/2026-05-29-design-parity-recovery-deferrals.md
git commit -m "docs(pr7): record route-(b) brainstorm decisions + append D58/D59/D60 deferrals"
```

---

## Phase 7 — DoD

### Task 13: Pre-push checklist + manual smoke + pr-autopilot dispatch

**Files:** none.

This is the pre-push gate from `.ai/docs/development-process.md`. Run **every** step verbatim — no skipping.

- [ ] **Step 1: Run `npm run lint` (vitest + prettier --check + eslint)**

```bash
cd frontend && npm run lint
```

Expected: no errors. If prettier --check flags any of the new files, run `npx prettier --write` on them and re-stage.

- [ ] **Step 2: Run `npm run build`**

```bash
cd frontend && npm run build
```

Expected: build succeeds. Inspect `dist/assets/index-*.css` size — should grow by ~3–5 KB for the new PrTabStrip module (the handoff CSS port plus close/overflow/menu rules). Document the delta in the PR body if it's > 8 KB.

- [ ] **Step 3: Run `dotnet build` (top-level — backend may have moved with `useSubmitInFlight` wiring even if unmodified)**

```bash
dotnet build --configuration Release
```

Expected: succeeds.

- [ ] **Step 4: Run `dotnet test`**

```bash
dotnet test --configuration Release --no-restore --verbosity minimal
```

Expected: all tests PASS.

- [ ] **Step 5: Run `npx vitest run` (full suite)**

```bash
cd frontend && npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 6: Run `npx playwright test` (full e2e)**

Start the backend on the test config:

```bash
dotnet run --project src/PRism.Web --configuration Release
```

Then in another terminal:

```bash
cd frontend && npx playwright test
```

Expected: all e2e PASS, including the new `app-chrome-tabstrip`, `inbox`, `inbox-activity-rail` baselines.

- [ ] **Step 7: Lockfile check (Windows-drops-optional-peers regression)**

```bash
git diff --name-only main -- frontend/package-lock.json
```

If the lockfile was modified, diff it against `main` to ensure no `@emnapi/*`, `@rollup/rollup-linux-x64-gnu`, or other optional-peer entries were dropped (memory: `feedback_npm_install_windows_drops_optional_peers.md`). If any were dropped, restore them.

- [ ] **Step 8: Manual smoke — golden path**

1. Start dev server. Open `http://localhost:5180/`.
2. Click an Inbox row → PR Detail loads → Row 2 appears with one tab `#NNN <title>`.
3. Navigate back to `/` (Inbox) → tab stays in Row 2; tab is inactive (no top accent).
4. Click the tab in Row 2 → PR Detail re-mounts.
5. Open three PRs in sequence. Verify Row 2 shows three tabs in left-to-right order.
6. Middle-click the second tab → it closes; active focus jumps to the left neighbour (the first tab).
7. Click the `×` on the active tab → it closes; route navigates to the left neighbour.
8. Close the last tab → Row 2 disappears; route is at `/`.
9. Open seven PRs → `+ 1 more` chevron appears; click it; verify the 7th appears in the menu with `×` affordance.
10. Click outside the menu → menu closes.
11. Open Settings, click Replace token, replace with the same PAT → `identity-changed` SSE fires → all tabs clear.

Document any deviation in the PR body.

- [ ] **Step 9: Push and dispatch pr-autopilot**

```bash
git push -u origin design-parity-recovery-pr7-tab-strip
```

Then invoke pr-autopilot via the Skill tool (no positional arguments needed):

```
Skill: pr-autopilot
```

Wait for the loop to complete. Address findings per the loop's instructions.

---

## Self-review checklist

- [ ] **Spec coverage:**
  - § 4.7 state shape → Task 1 (`openTabs`, `unreadKeys`; no `overflowMenuOpen` global — local to PrTabStrip per simpler factoring) ✓
  - § 4.7 routing integration → Tasks 4, 5, 6 ✓
  - § 4.7 interactions → Task 7 (click + middle-click + ×); kbd deferred ✓
  - § 4.7 visuals → Task 2 module CSS ✓
  - § 4.7 closing last tab → Task 7 `navigate('/')` ✓
  - § 4.7 overflow menu → Task 10 ✓
  - § 4.7 persistence → deferred (D59) ✓
  - § 4.7 native-shell coupling → resolved as route (b) ✓
  - § 4.7 closing-tab edge cases → Task 7 submit block + composer allow ✓
  - § 6.5 (composer + modal + submit) → Task 7 ✓
  - § 6.9 Inbox baseline re-capture → Task 11 ✓
  - § 1.3 native-shell coupling risk → spec patch + D58/D59/D60 ✓

- [ ] **Placeholder scan:** no "TBD" / "implement later" / vague-handling phrases in steps.

- [ ] **Type consistency:** `OpenTab.ref`, `OpenTab.title`, `prRefKey()`, `addTab(ref, title)`, `setTitle(ref, title)`, `closeTab(ref)`, `markUnread(key: string)`, `clearUnread(key: string)`, `clearAllTabs()` — same shape across Tasks 1, 4, 5, 6, 7, 8, 9, 10.

- [ ] **Native-shell scope reaffirmed:** kbd, persistence, error chip all deferred via D58/D59/D60.

- [ ] **No regression to S6 surfaces:** Header is unchanged; Settings/Setup tabs unchanged. PrTabStrip is a new sibling.

---

## Risks and open questions

- **Q1: Three-tab capture in Task 11 requires three accessible fixture PRs.** If `setupAndOpenScenarioPr` only seeds one, the deviation is documented and the capture drops to two tabs (one unread). Implementer judgment at Task 11 time.
- **Q2: Test-hook `/test/emit-pr-updated`.** Confirmed present per memory (S6 PR9). If grepping shows the endpoint is gated to a different test-host configuration than parity-baselines runs under, fall back to opening + closing a draft on the middle PR to trigger a real `pr-updated` SSE.
- **Q3: Click-outside-menu listener leaks if `PrTabStrip` unmounts while menu is open.** The hook's cleanup returns `removeEventListener` — verified safe; no leak.
- **Q4: `useSubmitInFlight` runs in every consumer that calls it.** PrTabStrip is mounted ONCE at App level. The hook polls via `prism-state-changed` window events, NOT intervals. No regression.
- **Q5: Tab-strip a11y semantics.** `role="tablist"` traditionally implies arrow-key navigation between tabs. With kbd-deferred (D58), tab keys move focus via the document tab order (one tab per `tabindex={0}` per tab). Acceptable; document as PR9 follow-up if needed.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-05-30-design-parity-recovery-pr7-tab-strip.md`.

Use `superpowers:subagent-driven-development` to execute task-by-task with two-stage review (spec compliance + code quality) after each.
