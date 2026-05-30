# Design Parity Recovery — PR7 (Browser-Style PR Tab Strip, Route b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the persistent browser-style PR tab strip across the top of the SPA (Row 2) with visual fidelity to the handoff, route-(b) scope: no keyboard bindings (`⌘W`/`⌘1-9`), no localStorage persistence, no stale-tab error chip. Click + middle-click close + close-X are the only close affordances; tabs survive only the current SPA session.

**Architecture:** A new `OpenTabsContext` holds in-memory state (`openTabs: OpenTab[]`, `unreadKeys: Set<string>` — `overflowMenuOpen` is kept LOCAL to `PrTabStrip` per [D61](#d61)). A new `PrTabStrip` component renders Row 2 between `<Header>` and `<Routes>` in `App.tsx` and is hidden when `openTabs.length === 0`. The first 6 tabs render inline; tabs 7+ render in a `+ N more` dropdown menu — no hard cap on `openTabs.length`. Three entry points add tabs (Inbox row click, PasteUrlInput, PrDetailPage direct load). Close uses click on the `×` + middle-click on the tab body. Submit-in-flight on the same prRef blocks close (via existing `useSubmitInFlight`). `pr-updated` SSE marks tabs unread; tab focus clears the unread flag. `identity-changed` clears all open tabs via the existing `prism-identity-changed` window-event bridge (no new SSE hook needed — see Task 9).

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
    # identity-changed → clearAllTabs handled INLINE in OpenTabsContext.tsx
    # via window.addEventListener('prism-identity-changed', ...) — uses the
    # existing api/events.ts WINDOW_EVENT_BRIDGE. No separate hook file.

frontend/e2e/
  parity-baselines.spec.ts                    (MODIFIED — add app-chrome-tabstrip + un-fixme inbox + inbox-activity-rail)

docs/specs/
  2026-05-29-design-parity-recovery-deferrals.md  (APPENDED — D58, D59, D60)
```

One new context + one new component pair (`.tsx` + `.module.css`) + one new hook (`useTabUnreadSignal`; see Task 9 — the identity-reset path uses an inline `useEffect` inside `OpenTabsProvider`, NOT a separate hook file) + four modified files + one e2e + one deferrals sidecar.

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

  it('clears all tabs when prism-identity-changed window event fires', () => {
    const { result } = renderHook(() => useOpenTabs(), { wrapper });
    const a = { owner: 'acme', repo: 'api', number: 1 };
    act(() => {
      result.current.addTab(a, 'T');
      result.current.markUnread('acme/api/1');
    });
    expect(result.current.openTabs).toHaveLength(1);
    act(() => {
      window.dispatchEvent(new CustomEvent('prism-identity-changed'));
    });
    expect(result.current.openTabs).toEqual([]);
    expect(result.current.unreadKeys.size).toBe(0);
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
  useEffect,
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

  // Reads `openTabs` from the closure to filter out keys not currently open. The
  // useCallback dep on `openTabs` recreates this callback whenever the tab list
  // changes, which is correct: the producer (useTabUnreadSignal) doesn't need to
  // know which tabs are open; the context filters silently. Nested setState
  // inside another setState updater is a React anti-pattern (StrictMode double-
  // invocation can drop or duplicate the inner call) — read state from the
  // closure instead.
  const markUnread = useCallback(
    (key: string) => {
      if (!openTabs.some((t) => prRefKey(t.ref) === key)) return;
      setUnreadKeys((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    },
    [openTabs],
  );

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

  // identity-changed → clear all open tabs. The existing api/events.ts
  // WINDOW_EVENT_BRIDGE re-dispatches every identity-changed SSE frame as a
  // 'prism-identity-changed' window event. useAuth.ts already consumes that
  // bridge at App level — we listen on the same bridge here to avoid adding a
  // second useEventSource subscriber for an event that already has a window
  // bridge. OpenTabsProvider is mounted OUTSIDE EventStreamProvider in App.tsx,
  // so it can't call useEventSource() directly — the window bridge is the
  // intended cross-provider API for this event.
  useEffect(() => {
    const onIdentityChange = () => clearAllTabs();
    window.addEventListener('prism-identity-changed', onIdentityChange);
    return () => window.removeEventListener('prism-identity-changed', onIdentityChange);
  }, [clearAllTabs]);

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

/* Disabled state — overrides the descendant :hover rule via higher-specificity
   compound selectors. Without these, .tab:hover .close (0,2,0) outranks
   .close:disabled (0,2,0) by source order and the disabled × renders at full
   opacity on hover, hiding the disabled affordance. Mirrors PR4 D34 / PR6
   pattern of compound-selector overrides for descendant-rule conflicts. */
.tab .close:disabled,
.tab:hover .close:disabled,
.tabActive .close:disabled,
.tab:focus-within .close:disabled {
  cursor: not-allowed;
  opacity: 0.4;
  background: transparent;
  color: var(--text-3);
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

/* Respect prefers-reduced-motion — drop the hover opacity / background fades.
   The handoff CSS doesn't gate transitions; we add the override at port time. */
@media (prefers-reduced-motion: reduce) {
  .tab,
  .close,
  .more,
  .menuItem {
    transition: none;
  }
}
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
              <span className={styles.title}>{tabLabel(t)}</span>
              {unread && <span className={styles.dot} aria-hidden="true" />}
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
- The SSE bridge (Task 8 `useTabUnreadSignal`) can subscribe to events emitted from inside `EventStreamProvider`. Task 9 takes a different shape — see Task 9.

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

// PasteUrlInput imports `inboxApi.parsePrUrl` from '../../api/inbox' — mock the
// actual module path, NOT a non-existent './parsePrUrl'. Confirm by reading
// frontend/src/api/inbox.ts before authoring (the exact export shape may also
// be `parsePrUrl` as a top-level fn — read first, mirror exactly).
vi.mock('../../api/inbox', () => ({
  inboxApi: {
    parsePrUrl: vi.fn(async () => ({
      ok: true,
      ref: { owner: 'acme', repo: 'api', number: 7 },
      error: null,
      configuredHost: 'github.com',
      urlHost: 'github.com',
    })),
  },
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

// CRITICAL: `ref` is a fresh object literal on every render (PrDetailPage line 52
// `const ref: PrReference = { owner, repo, number }`). Using `ref` directly in
// dep arrays would re-fire every effect on every render — setTitle would
// rebuild the openTabs array unconditionally, clearUnread would race the
// pr-updated marker, and every PrDetailPage re-render would punch the context.
// Depend on the PRIMITIVE route params instead, and inline-construct the ref.
const refKey = `${owner}/${repo}/${numberStr}`;

useEffect(() => {
  addTab({ owner, repo, number }, data?.pr.title ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [addTab, owner, repo, number]);

useEffect(() => {
  if (data?.pr.title) {
    setTitle({ owner, repo, number }, data.pr.title);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [data?.pr.title, setTitle, owner, repo, number]);

useEffect(() => {
  // Active tab clears unread on focus.
  clearUnread(refKey);
}, [clearUnread, refKey]);
```

Import `useEffect` from React if not already imported.

`owner` / `repo` / `numberStr` come from `useParams<{owner: string; repo: string; number: string}>()` in `PrDetailPage` (line 36-40); `number` is derived as `Number(numberStr)`. `PrDetailPageInner` receives `ref: PrReference` as a prop — but for the effects above we re-derive the primitives from `useParams` directly inside `PrDetailPageInner` to keep dep arrays stable. Alternative shape (slightly leaner): accept `owner`, `repo`, `number` as separate props from `PrDetailPage` instead of bundling them into `ref`.

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

### Task 6.5: Wrap existing PrDetailPage-rendering tests with `OpenTabsProvider`

**Files:**
- Modify: every existing vitest spec that mounts `<PrDetailPage />`, `<OverviewTab />`, `<FilesTab />`, or `<DraftsTabRoute />` — these now require an `OpenTabsProvider` ancestor because `PrDetailPage` calls `useOpenTabs()` (Task 6).

Without this task, the full vitest run (Task 13 step 5) cascades — every PrDetail-rendering spec throws `useOpenTabs must be used inside OpenTabsProvider` at mount.

- [ ] **Step 1: Inventory the affected specs**

```bash
cd frontend && \
  npx grep -lr --include="*.test.tsx" --include="*.test.ts" \
  -e "PrDetailPage\|<OverviewTab\|<FilesTab\|<DraftsTabRoute" src
```

(Or use the in-session Grep tool: pattern `PrDetailPage|<OverviewTab|<FilesTab|<DraftsTabRoute`, glob `**/*.test.tsx`.)

Expected: ~5-15 spec files. Record the list before proceeding.

- [ ] **Step 2: For each affected spec, wrap the `render(...)` call with `OpenTabsProvider`**

Pattern — find every existing `render(<MemoryRouter ...><PrDetailPage /></MemoryRouter>)` (or sibling layout) and replace with:

```tsx
import { OpenTabsProvider } from '../contexts/OpenTabsContext';
// adjust relative path per spec location

render(
  <MemoryRouter initialEntries={[...]}>
    <OpenTabsProvider>
      <PrDetailPage />
    </OpenTabsProvider>
  </MemoryRouter>,
);
```

The new provider has no side effects beyond mounting an in-memory state — it does not change any spec's expected output.

- [ ] **Step 3: Run the affected specs to verify green**

```bash
cd frontend && npx vitest run <each updated spec path>
```

Expected: PASS — no change in behavioural assertions; provider is purely additive.

- [ ] **Step 4: Run the full vitest suite for cascade-clean confirmation**

```bash
cd frontend && npx vitest run
```

Expected: all tests PASS. If any other spec mounts a child of PrDetail directly (e.g. `<UnresolvedPanel />` standalone) without provider, it doesn't need the wrap because `useOpenTabs()` is only called inside `PrDetailPageInner` and `PrTabStrip`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/**/*.test.tsx
git commit -m "test(pr7): wrap existing PrDetailPage-rendering specs with OpenTabsProvider"
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

  // Computes the navigate target BEFORE closeTab() schedules its state update.
  // A future render then reads the new openTabs; we don't read post-close state.
  // The lookup is keyed on prRefKey rather than index so a fast-second-click on
  // an adjacent tab (between React commit cycles) doesn't navigate to a stale
  // slot. Inactive tabs (including all overflow-menu items by construction)
  // close without navigating — the active route is unaffected.
  const handleClose = (closingTab: OpenTab) => {
    const wasActive = isActiveTab(pathname, closingTab);
    const closingKey = prRefKey(closingTab.ref);
    const remaining = openTabs.filter((t) => prRefKey(t.ref) !== closingKey);
    closeTab(closingTab.ref);
    if (!wasActive) return;
    // The closed tab was active. Navigate to the neighbour in the PRE-close
    // array so the chosen target is a tab the user will actually see post-close.
    const closingIdx = openTabs.findIndex((t) => prRefKey(t.ref) === closingKey);
    if (closingIdx > 0) {
      navigate(pathFor(openTabs[closingIdx - 1].ref));
    } else if (remaining.length > 0) {
      navigate(pathFor(remaining[0].ref));
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
                  handleClose(t);
                }
              }}
            >
              <span className={styles.num}>#{t.ref.number}</span>
              <span className={styles.title}>{tabLabel(t)}</span>
              {unread && <span className={styles.dot} aria-hidden="true" />}
              <button
                type="button"
                aria-label="Close tab"
                className={styles.close}
                disabled={closeBlocked}
                title={closeBlocked ? "Can't close — submit in progress" : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose(t);
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
      handleClose(t);
    }
  }}
>
  <span className={styles.num}>#{t.ref.number}</span>
  <span className={styles.title}>{tabLabel(t)}</span>
  {unread && <span className={styles.dot} aria-hidden="true" />}
  <button
    type="button"
    aria-label="Close tab"
    className={styles.close}
    disabled={closeBlocked}
    title={closeBlocked ? "Can't close — submit in progress" : undefined}
    onClick={(e) => {
      e.stopPropagation();
      handleClose(t);
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

Wires the unread-tab signal from the existing `pr-updated` SSE event. Task 8 introduces a single hook (`useTabUnreadSignal`) and a thin App-level mount component (`TabSignals`) that hosts it inside both `EventStreamProvider` and the router context. Task 9 is a verification gate confirming the `identity-changed` clear-tabs path (already wired into `OpenTabsProvider` at Task 1 via the existing `prism-identity-changed` window-event bridge) integrates cleanly — no new code, no new commit.

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

### Task 9: `identity-changed` clears `openTabs` — verify the OpenTabsProvider window-bridge listener

**Files:**
- (No new files.) The behavior is wired in Task 1's `OpenTabsProvider` via `window.addEventListener('prism-identity-changed', clearAllTabs)`. This task ONLY verifies the cross-component integration in App.tsx and adds a focused end-to-end-shape test.

**Rationale for the shape change vs the original plan draft.** The first plan draft introduced a separate `useTabIdentityReset` hook that subscribed to the `identity-changed` SSE via `useEventSource()`. `api/events.ts:73` already re-dispatches every `identity-changed` SSE frame as a `prism-identity-changed` window event (the existing `WINDOW_EVENT_BRIDGE`). `useAuth` consumes the same bridge at App-level outside `EventStreamProvider`. Adding a second SSE subscriber for an already-bridged event duplicates a code path that already works. Per ce-doc-review SG1: the simpler shape is a `useEffect` inside `OpenTabsProvider` itself (Task 1's body now carries this listener). No new hook file, no new App-mount component for it, no second listener.

The Task 1 test already covers the clear-on-window-event contract (the test `'clears all tabs when prism-identity-changed window event fires'` added in Task 1 Step 1). This task verifies the App-level integration.

- [ ] **Step 1: Confirm Task 1 wired the listener**

Read `frontend/src/contexts/OpenTabsContext.tsx`. Confirm the body contains:

```ts
useEffect(() => {
  const onIdentityChange = () => clearAllTabs();
  window.addEventListener('prism-identity-changed', onIdentityChange);
  return () => window.removeEventListener('prism-identity-changed', onIdentityChange);
}, [clearAllTabs]);
```

If missing, revisit Task 1.

- [ ] **Step 2: Confirm api/events.ts dispatches the window event**

```bash
cd frontend && npx grep -n "prism-identity-changed" src/api/events.ts
```

Expected: at least one match showing the bridge entry: `'identity-changed': 'prism-identity-changed'`.

- [ ] **Step 3: Confirm via existing Task 1 unit test**

```bash
cd frontend && npx vitest run src/contexts/OpenTabsContext.test.tsx -t "clears all tabs when prism-identity-changed"
```

Expected: PASS.

- [ ] **Step 4: No commit — this task is a verification gate, not a code change.**

If Tasks 1-8 already shipped via separate commits, Task 9 produces no diff. The slice continues to Task 10.

---

## Phase 5 — Overflow Menu

### Task 10: Overflow `+ N more` menu when `openTabs.length > 6`

**Files:**
- Modify: `frontend/src/components/PrTabStrip/PrTabStrip.tsx`
- Extend: `frontend/src/components/PrTabStrip/PrTabStrip.test.tsx`

The first 6 tabs render inline; the remaining N go into a `+ N more` chevron menu that opens on click. Each menu item carries a per-item close affordance (handoff `.pr-tabbar-menu-close`).

**Edge case the implementer should keep in mind.** If the user opens the menu and then closes the only overflowed tab via a menu item, the `{overflowed.length > 0 && (...)}` conditional makes React unmount the menu JSX. The `menuOpen` state still holds `true` after the unmount, but no menu DOM exists. When the next overflow state arrives (user opens a 7th tab again), React mounts a fresh chevron with `menuOpen = true` — which would surprise the user with an auto-open menu. The Step-5 `useEffect` that auto-closes `menuOpen` when `overflowed.length === 0` prevents this — keep the dep array correct (`[overflowed.length, menuOpen]`).

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
                        onClick={() => handleClose(t)}
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
            handleClose(t);
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
            handleClose(t);
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

- [ ] **Step 5: Add click-outside + Escape dismiss + reset on unmount** — the menu must close when the user clicks anywhere outside it, presses Escape, or when the last overflowed tab is closed (the `overflowed.length > 0` conditional unmounts the menu JSX but `menuOpen` state would persist `true` — harmless because the next mount paints with the conditional false; but we explicitly reset to keep the next overflow-state clean):

```tsx
import { useEffect, useRef } from 'react';

// inside PrTabStrip, near the menuOpen state:
const overflowRef = useRef<HTMLDivElement | null>(null);

// Click-outside + Escape close the menu. The handlers attach only while the
// menu is open, so the document-level listeners don't fire when no menu is
// visible. Escape additionally returns focus to the trigger button so keyboard
// users aren't stranded — without this, focus stays on the document body.
useEffect(() => {
  if (!menuOpen) return;
  const triggerEl = overflowRef.current?.querySelector(`.${styles.more}`) as HTMLElement | null;
  const onMouseDown = (e: MouseEvent) => {
    if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
      setMenuOpen(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setMenuOpen(false);
      triggerEl?.focus();
    }
  };
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);
  return () => {
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('keydown', onKeyDown);
  };
}, [menuOpen]);

// Auto-close the menu when the overflow set drains (e.g., last overflowed
// tab closed via the menu's own close button). Without this, the `+ N more`
// chevron re-renders later in another open-tabs state with menuOpen still
// `true`, which would auto-open the menu on next overflow — surprising UX.
useEffect(() => {
  if (overflowed.length === 0 && menuOpen) {
    setMenuOpen(false);
  }
}, [overflowed.length, menuOpen]);

// attach to the .overflow wrapper:
<div className={styles.overflow} ref={overflowRef}>
```

Add unit tests asserting click-outside, Escape, and drain-on-close all dismiss:

```tsx
it('clicking outside the overflow menu closes it', async () => {
  render(wrap(<><Seed7 /><PrTabStrip /><div data-testid="outside">Outside</div></>));
  await userEvent.click(screen.getByRole('button', { name: /\+ 1 more/i }));
  expect(screen.getByRole('menu')).toBeInTheDocument();
  await userEvent.click(screen.getByTestId('outside'));
  expect(screen.queryByRole('menu')).toBeNull();
});

it('Escape closes the overflow menu', async () => {
  render(wrap(<><Seed7 /><PrTabStrip /></>));
  await userEvent.click(screen.getByRole('button', { name: /\+ 1 more/i }));
  expect(screen.getByRole('menu')).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
});

it('menu auto-closes when the last overflowed tab is closed via the menu', async () => {
  render(wrap(<><Seed7 /><PrTabStrip /></>));
  await userEvent.click(screen.getByRole('button', { name: /\+ 1 more/i }));
  expect(screen.getByRole('menu')).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText('Close T7'));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.queryByRole('button', { name: /\+ 1 more/i })).toBeNull();
});
```

Full keyboard navigation between menu items (arrow-key) is deferred — see D58 and the Risks section. The current minimum is: Escape closes + focus returns to trigger; click-outside closes; auto-close on empty.

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

Spec § 4.7 names a 3-tab capture target. **The plan deviates: 1-tab capture only.** Rationale: PRism.Web/TestHooks/FakePrReader.cs explicitly returns null/empty for every reference != `FakeReviewBackingStore.Scenario` (`acme/api/123`); there is no `/test/seed-pr-fixture` route that adds a second fixture PR. Adding two more sibling fixtures requires backend code (a new FakeReviewBackingStore.Scenarios collection + FakePrReader updates), which is out of scope for "no backend changes." The 1-tab capture exercises the strip layout, active-tab merge, and unread visual — sufficient for regression-guard purposes. The 3-tab target carries to PR9 (or a follow-up that adds multi-fixture seeding) — logged in [D62](#d62).

Per § 6.9, PR7 also un-fixmes `inbox` and `inbox-activity-rail`.

- [ ] **Step 1: Add the tabstrip zone** (1-tab, unread state)

In `frontend/e2e/parity-baselines.spec.ts`, replace the trailing PR7-comment block (lines 192-196) with:

```ts
test.describe('parity baselines — app chrome', () => {
  test('app-chrome-tabstrip', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenScenarioPr(page);
    // Open the single fixture PR (acme/api/123). PrDetailPage's addTab effect
    // (Task 6) seeds openTabs with this ref; the Task 6 setTitle effect fills
    // in the title once usePrDetail resolves.
    await page.goto('/pr/acme/api/123');
    await page.locator('[data-testid="pr-header"]').waitFor();
    // Return to Inbox so the tab renders INACTIVE — exercises the un-merged
    // visual state (no top accent, no negative-margin overlap).
    await page.goto('/');
    await page.locator('[data-testid="pr-tabstrip"]').waitFor();
    // Mark the tab unread via the existing /test/emit-pr-updated hook (S6 PR9).
    // Endpoint binds EmitPrUpdatedRequest(Owner, Repo, Number, HeadShaChanged,
    // CommentCountChanged, NewHeadSha, CommentCountDelta) — see
    // PRism.Web/TestHooks/TestEndpoints.cs:42-49 + :137-153 for the validation
    // rules. We use CommentCountChanged=true + delta=1 to fire an unread signal
    // without an SHA change (head-sha change would also work but requires the
    // backend to know the next sha; not needed here).
    const emitResp = await page.request.post('/test/emit-pr-updated', {
      data: {
        Owner: 'acme',
        Repo: 'api',
        Number: 123,
        HeadShaChanged: false,
        CommentCountChanged: true,
        NewHeadSha: null,
        CommentCountDelta: 1,
      },
      headers: { Origin: 'http://localhost:5180' },
    });
    if (!emitResp.ok()) {
      throw new Error(
        `POST /test/emit-pr-updated failed: ${emitResp.status()} ${await emitResp.text()}`,
      );
    }
    // Wait for the unread dot to render. The Task 8 hook updates openTabs's
    // unread set on the next SSE frame; play a short DOM-attribute wait rather
    // than a fixed timeout.
    await page.locator('[data-testid="pr-tabstrip"] .prTabStrip_tabUnread, [data-testid="pr-tabstrip"] [class*="tabUnread"]').first().waitFor();
    await page.addStyleTag({ content: KILL_ANIMATIONS_CSS });
    await expect(page.locator('[data-testid="pr-tabstrip"]')).toHaveScreenshot(
      'app-chrome-tabstrip.png',
      SCREENSHOT_OPTS,
    );
  });
});
```

Notes:
- The CSS-module-class selector `[class*="tabUnread"]` is the Vite-default hashed-class workaround; replace with a `data-state="unread"` attribute on the tab if the hashed-class selector turns out flaky.
- The `/test/emit-pr-updated` endpoint is registered ONLY when the test-host configuration runs. Playwright's webServer config in `playwright.config.ts` already wires this for the e2e suite.

- [ ] **Step 2: Un-fixme `inbox` and `inbox-activity-rail`**

Change `test.fixme('inbox', ...)` and `test.fixme('inbox-activity-rail', ...)` to `test('inbox', ...)` and `test('inbox-activity-rail', ...)`.

- [ ] **Step 3: Capture all three baselines**

Run the dev server (`npm run dev` in `frontend/`) and the .NET backend in a separate terminal (`dotnet run --project src/PRism.Web --configuration Release`).

```bash
cd frontend && npx playwright test parity-baselines --update-snapshots
```

Expected: three new PNGs written under `frontend/e2e/__screenshots__/<platform>/`:
- `app-chrome-tabstrip.png` (~3–6 KB, one-tab strip with the unread dot, inactive state on `/`)
- `inbox.png` (~50–80 KB, Inbox content area. Note: `setupAndOpenScenarioPr` lands on `/` with NO open tabs, so Row 2 is hidden — the `<main>` element is captured at its no-Row-2 position. Per spec § 6.9 this is acceptable: the screenshot is element-relative (not page-relative), so the Y-position-shift concern is moot for this zone.)
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

### Task 12: Update spec § 4.7 with brainstorm-pass decisions and append deferrals D58–D62

**Files:**
- Modify: `docs/specs/2026-05-29-design-parity-recovery-design.md` (§ 4.7)
- Modify: `docs/specs/2026-05-29-design-parity-recovery-deferrals.md` (append D58, D59, D60, D61, D62)

The spec's "edge cases deferred to PR7's brainstorm pass" block at lines 313-317 needs to be rewritten to reflect the route-(b) decisions. The deferrals sidecar gets three new D-numbers.

- [ ] **Step 1: Patch spec § 4.7**

In `docs/specs/2026-05-29-design-parity-recovery-design.md`, replace the "Native-shell coupling" + "Edge cases deferred" paragraphs (lines 311-317) with:

```markdown
**Native-shell coupling — resolution.** PR7's brainstorm pass selected **route (b) visual-only**: NO `⌘W` (close tab), NO `⌘1-9` (jump to tab), NO localStorage persistence. Middle-click DOES ship (no OS reservation — every candidate shell passes mouse events through to the renderer; see [`D58`](2026-05-29-design-parity-recovery-deferrals.md#d58) for the OS-reservation rationale that differentiates `⌘W` from middle-click). Tabs survive only the current SPA session and are cleared on `identity-changed` via the existing `prism-identity-changed` window-event bridge. Keyboard bindings and persistence are revisited after the native-shell framework decision lands ([`D58`](2026-05-29-design-parity-recovery-deferrals.md#d58) keyboard, [`D59`](2026-05-29-design-parity-recovery-deferrals.md#d59) persistence). See § 1.3.

**Edge cases deferred to PR7's brainstorm pass — resolutions.**
- Closing a tab with an open composer: **allow.** Drafts auto-persist server-side per S4.
- Closing a tab with an in-flight submit: **block** while `useSubmitInFlight().inFlight && prRef === closing tab's prRef`. Tooltip: "Can't close — submit in progress." Wired via `useSubmitInFlight()` which tracks the single-slot SubmitLockRegistry.
- Stale `openTabs` entries on reload: **scope-narrowed but not fully N/A** — route (b) drops persistence which eliminates the reload-stale path; mid-session token rotation clears all tabs via `identity-changed`. PR-deleted / repo-archived / repo-visibility-changed mid-session paths remain — PR7 accepts the existing PrDetailPage error-fallback UX without a per-tab error chip. Stale-tab error chip visual spec **deferred** ([`D60`](2026-05-29-design-parity-recovery-deferrals.md#d60)).
- `openTabs.length > some-large-N`: **no cap**; the `+ N more` overflow menu past 6 inline tabs handles the visual. Narrow-viewport (1180px) verification is in the PR7 plan's manual smoke.
- Capture target deviation: **1-tab parity baseline** instead of the spec's 3-tab target — FakePrReader serves only one fixture and adding multi-fixture seeding is out of scope ([`D62`](2026-05-29-design-parity-recovery-deferrals.md#d62)).
- `overflowMenuOpen` is kept LOCAL to `PrTabStrip`, not exposed on `OpenTabsContext` ([`D61`](2026-05-29-design-parity-recovery-deferrals.md#d61)).
```

- [ ] **Step 2: Append D58-D62 to the deferrals sidecar**

In `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`, append at the bottom (preserve the existing trailing log-entry convention used by D1-D57):

```markdown
## Implementation-time deferrals — PR7 (browser-style PR tab strip, route b)

### D58 — Keyboard bindings (`⌘W`, `⌘1-9`) deferred to post-shell-decision

**Source:** PR7 brainstorm pass (2026-05-30); ship-tier (b) visual-only route per spec § 4.7 + § 1.3.
**Spec position:** § 4.7 lines 294-297 list `⌘1-9` / `⌘W` / middle-click as interactions. Plan resolves to mouse-only (click + middle-click + ×).
**Reality:** The native-shell decision (WebView2 / Tauri / Electron / MAUI Blazor Hybrid) is unresolved. The real differentiator between mouse and keyboard bindings here is NOT "mouse-vs-kbd" — both can be intercepted by native shells — but rather **OS-level reservation**. `⌘W` is OS-reserved for window-close on macOS at the WindowManager layer; the shell delivers Cmd-W to the WindowManager before the renderer sees it (or after, depending on the shell's handler chain). `⌘1-9` is candidate for app-keymap bindings the shell sets (Electron menu accelerators, Tauri global shortcuts). Middle-click and primary-click have NO OS reservation: every candidate shell passes mouse events through to the renderer's hit-test path. The plan ships click + middle-click NOW because those will keep working under any shell; defers ⌘W + ⌘1-9 because their behavior is OS-policy-dependent.
**Plan resolution:** PR7 ships NO keyboard bindings. Click + middle-click + × button only. The rationale is "we don't want to design kbd bindings without shell context" — not a minimum-rework promise (which is unprovable without the shell choice) but a design-discipline statement: kbd contracts should be designed against the actual shell's keymap, not against a hypothetical one.
**Status:** Applied in PR7.
**Cross-refs:** Spec § 1.3 (native-shell coupling risk); § 4.7 (interactions list).

### D59 — `openTabs` localStorage persistence deferred to post-shell-decision

**Source:** PR7 brainstorm pass (2026-05-30); ship-tier (b) visual-only route.
**Spec position:** § 4.7 line 284 originally specified `prism.openTabs.v1` localStorage key + parse/validate path.
**Reality:** Same shell-coupling rationale as D58. Native shells may carry their own window-state restoration; competing with it produces drift.
**Plan resolution:** PR7 ships in-memory `openTabs` state only. **The cost is non-trivial when honestly accounted.** Reload triggers in PRism include: (a) Vite dev hot-reload (frequent during PR review); (b) `LoadingScreen`'s "Reload" button on auth-state errors; (c) the ErrorBoundary fallback; (d) accidental Cmd-R / F5; (e) the Replace-token flow. Each wipes the open-tab list. With 5+ open tabs, recovery is 5+ Inbox-row clicks, not "two clicks." The decision still holds — the shell-pending rationale is stronger than the friction cost — but the disclosure should reflect the actual user experience.
**Status:** Applied in PR7.
**Cross-refs:** D58 (kbd bindings); D60 (stale-tab chip reopens with this); spec § 1.3.

### D60 — Stale-tab error chip visual spec deferred — narrowed but NOT fully N/A

**Source:** PR7 brainstorm pass (2026-05-30); ship-tier (b) visual-only route.
**Spec position:** § 4.7 line 316 — "Visual spec for the stale-tab error chip is new design with no handoff reference and lands in PR7's brainstorm — flagged as a small redesign carve-out per § 2.2."
**Reality:** Removing persistence (D59) eliminates the LARGEST stale-tab path (reload-with-persisted-tabs-the-current-identity-can't-see). But several mid-session paths remain even without persistence:
  - PR is deleted on GitHub (rare).
  - PR is transferred to another org the current login can't see (token boundary changes WITHOUT identity changing — `identity-changed` doesn't fire).
  - Repo is archived or visibility flipped to private without identity-changing.
  - Token scope reduced via the GitHub settings UI without rotation (rare).
In any of these, the user's openTabs entry stays alive; clicking the tab navigates to PrDetailPage; usePrDetail returns an error; PrDetailPage's existing error fallback renders. **No tab-strip visual hint indicates which tab broke.** The user discovers it by clicking.
**Plan resolution:** PR7 accepts the error-fallback-on-click UX explicitly. No tab-strip chip. The full chip design is deferred to a follow-up (or PR9 revisit) when at least one of: (a) the first stale-mid-session user report comes in, (b) persistence reopens (D59), (c) shell decision lands and may resurface persistence anyway.
**Status:** Applied in PR7. Open for follow-up the moment either (a) or (b) lands.
**Cross-refs:** D59; spec § 2.2 redesign carve-out policy.

### D61 — `overflowMenuOpen` kept local to `PrTabStrip`, not exposed on the context

**Source:** PR7 plan-time decision (2026-05-30) on context shape.
**Spec position:** § 4.7 line 286 lists `overflowMenuOpen: boolean` as part of the App-level state shape.
**Reality:** `overflowMenuOpen` has a single consumer (`PrTabStrip`). Exposing it through the context buys nothing for component composition and creates a wider context surface to test and migrate. Single-consumer booleans don't earn context promotion.
**Plan resolution:** Kept as `useState(false)` local to `PrTabStrip`. The context exposes only `openTabs` + `unreadKeys` + mutator methods.
**Status:** Applied in PR7. Trivial scope-shrink, not load-bearing for future work.
**Cross-refs:** Spec § 4.7.

### D62 — `app-chrome-tabstrip` parity baseline captured at 1 tab, not the spec's 3-tab target

**Source:** PR7 plan-time decision (2026-05-30) on baseline capture scope.
**Spec position:** § 4.7 line 319 — "Side-by-side capture target: `app-chrome-tabstrip` zone with three open PRs (two read, one unread)."
**Reality:** `PRism.Web/TestHooks/FakePrReader.cs` returns null/empty for every PR reference != `FakeReviewBackingStore.Scenario` (acme/api/123). No `/test/seed-pr-fixture` route adds secondary fixtures. Capturing a 3-tab strip would require adding multi-fixture seeding to FakeReviewBackingStore + FakePrReader (real backend changes), which is out of scope for "no backend changes."
**Plan resolution:** PR7 captures `app-chrome-tabstrip.png` with one tab in the unread-inactive state. This exercises strip layout, inactive-tab visual, unread dot, and the close affordance — sufficient for regression-guard purposes. The 3-tab visual diff remains uncaptured.
**Status:** Applied in PR7. Reopens when multi-fixture seeding lands (likely a PR9 prerequisite, possibly bundled with the Inbox-multi-section parity work).
**Cross-refs:** Spec § 4.7 capture target.
```

- [ ] **Step 3: Commit**

```bash
git add docs/specs/2026-05-29-design-parity-recovery-design.md docs/specs/2026-05-29-design-parity-recovery-deferrals.md
git commit -m "docs(pr7): record route-(b) brainstorm decisions + append D58-D62 deferrals"
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

- [ ] **Step 3: Run `dotnet build` (full pre-push checklist mandates this even when no backend file changed — see user-feedback `feedback_run_full_pre_push_checklist`)**

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
10. Click outside the menu → menu closes. Press Escape with menu open → menu closes + focus returns to the `+ N more` button.
11. **Narrow-viewport check** (A10 from ce-doc-review): resize the window to 1180px and verify the `+ N more` chevron is still visible and clickable at 7+ open tabs. If the chevron clips off-screen, lower `INLINE_TAB_CAP` or shrink `.tab` `max-width`.
12. Open Settings, click Replace token, replace with the same PAT → `identity-changed` SSE fires → all tabs clear.

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
  - § 1.3 native-shell coupling risk → spec patch + D58/D59/D60/D61/D62 ✓

- [ ] **Placeholder scan:** no "TBD" / "implement later" / vague-handling phrases in steps.

- [ ] **Type consistency:** `OpenTab.ref`, `OpenTab.title`, `prRefKey()`, `addTab(ref, title)`, `setTitle(ref, title)`, `closeTab(ref)`, `markUnread(key: string)`, `clearUnread(key: string)`, `clearAllTabs()` — same shape across Tasks 1, 4, 5, 6, 7, 8, 9, 10.

- [ ] **Native-shell scope reaffirmed:** kbd, persistence, error chip all deferred via D58/D59/D60.

- [ ] **No regression to S6 surfaces:** Header is unchanged; Settings/Setup tabs unchanged. PrTabStrip is a new sibling.

---

## Risks and open questions

- **Q1: Single-tab capture in Task 11 deviates from the spec's 3-tab target.** Logged as D62. Fixed by future multi-fixture-seeding work; not load-bearing for PR7.
- **Q2: Test-hook `/test/emit-pr-updated`.** Confirmed present in `PRism.Web/TestHooks/TestEndpoints.cs:137`. Body shape `(Owner, Repo, Number, HeadShaChanged, CommentCountChanged, NewHeadSha, CommentCountDelta)` — NOT `prRef`. If the endpoint is gated to a different test-host configuration than parity-baselines runs under, fall back to opening + closing a draft on the PR to trigger a real `pr-updated` SSE.
- **Q3: Click-outside-menu listener leaks if `PrTabStrip` unmounts while menu is open.** The hook's cleanup returns `removeEventListener` — verified safe; no leak. Same for the Escape keydown listener.
- **Q4: `useSubmitInFlight` is single-slot today** (`SubmitLockRegistry` allows one in-flight submit at a time). The plan's `submit.prRef === key` gate silently mis-classifies if the registry goes multi-slot — at that point the hook's return shape should widen to `Set<string>` and all `prRef ===` consumers should migrate to `.has(key)`. Out of scope for PR7; consumers are listed at PR7 commit time for future audit.
- **Q5: Tab-strip a11y semantics.** `role="tablist"` traditionally implies arrow-key navigation between tabs. With kbd-deferred (D58), tab keys move focus via the document tab order (one tab per `tabindex={0}` per tab). The strip provides the structural role for assistive tech without the keyboard contract — accepted gap, document as PR9 follow-up if any N=3 review surfaces it.
- **Q6: Touch / pointer:coarse devices** — the close `×` is opacity 0 by default (hover-revealed). On touch, hover doesn't fire and the only close affordance is middle-click — which also doesn't exist on touch. PRism's PoC target is desktop, so accept the gap. If touch use ever becomes a target, add `@media (hover: none) { .close { opacity: 1; } }` as a one-line fix.
- **Q7: Empty-state layout seam.** When `openTabs.length` drops 1 → 0, the `PrTabStrip` div unmounts and the Header's bottom border becomes adjacent to the page content. No double-border because the strip's border-bottom is replaced by the strip's absence, not added on top. Manual smoke step 8 verifies; if a visible reflow appears, add a fixed 0-height placeholder that retains the seam offset.
- **Q8: PR-delete / repo-archive / repo-transfer mid-session** — tabs for PRs that became inaccessible mid-session render normally in the strip; clicking them surfaces the existing PrDetailPage error fallback. No tab-strip chip in PR7 (D60). Acceptable for the v1 trial cohort; reopens with D60 if reported.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-05-30-design-parity-recovery-pr7-tab-strip.md`.

Use `superpowers:subagent-driven-development` to execute task-by-task with two-stage review (spec compliance + code quality) after each.
