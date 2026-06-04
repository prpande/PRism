# PR-detail Tab State Preservation (Keep-Alive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every open PR-detail tab mounted (hidden when inactive) so its view state — sub-tab, scroll position, selected file, expanded folders, open composers — survives navigating to the Inbox or another tab, instead of React Router unmounting and resetting it.

**Architecture:** A persistent `PrTabHost` (sibling to `<Routes>`) renders one mounted `PrDetailView` per open tab, toggling visibility with the `hidden` attribute. Sub-tab selection moves from nested routes into per-view component state; the three sub-tab components (`OverviewTab`/`FilesTab`/`DraftsTabRoute`) take `prRef` + session as props instead of `useParams`/`useOutletContext`. All views share the single outer `data-app-scroll` scroller; each view's `scrollTop` is saved/restored per `(prRef, subTab)` by `useTabScrollMemory`, and a `data-files-active` marker rescopes the Files viewport rules to fire only for the active Files view (see the "Scroll model decision" note below — the spec's per-view-container idea was rejected during plan review). A focus-transition hook re-fetches detail (re-stamping `mark-viewed`) and clears the unread dot when a tab is re-activated.

**Tech Stack:** React 18 + TypeScript + Vite + React Router v6, Vitest + Testing Library (jsdom), Playwright. Source spec: [`../specs/2026-06-04-pr-tab-state-keepalive-design.md`](../specs/2026-06-04-pr-tab-state-keepalive-design.md).

---

## Sequencing note (deviates from spec §7)

Spec §7 sketches a 5-PR sequence that ships keep-alive (PR3) before the per-view scroll container. That ordering is **not buildable**: the moment PR views stay mounted, every hidden view that has opened Files still carries a `.files-tab` element in the DOM, so the global `[data-app-shell]:has(.files-tab)` viewport-binding selector (`frontend/src/styles/tokens.css:256–288`) fires even when the active view is on Overview/Inbox — breaking layout. Keep-alive mounting therefore **forces** the scroll-container rework into the same PR. This plan uses three phases:

- **PR1 (structural core, large):** host + routing restructure + sub-tab-in-state + child prop migration + the `:has(.files-tab)` → active-view-marker fix + per-tab scroll save/restore + diff-scroll regression gate. These are mutually dependent and cannot be split without a broken intermediate state.
- **PR2:** data freshness — refetch-on-focus, `clearUnread`-on-activation, banner interplay.
- **PR3:** test-migration hardening + a11y isolation test + Playwright e2e.

**Scroll model decision (revised after plan review).** The spec §3.3's "per-view scroll container" is **rejected** as the primary path: the #156 diff-scroll regression spec (`frontend/e2e/diff-scroll-regression.spec.ts`) asserts that `[data-app-scroll]` *itself* is the bounded internal scroller (`scrollHeight - clientHeight ≤ 1`), and a per-view container makes `[data-app-scroll]` non-scrolling — failing that gate by construction and silently rewriting what #149/#155/#156 guard. Primary path instead: **keep `[data-app-scroll]` as the single scroller** (regression spec stays valid unchanged), and (a) replace the global `[data-app-shell]:has(.files-tab)` viewport binding — which mis-fires under keep-alive because hidden views still contain `.files-tab` — with an **active-view marker** (`[data-app-scroll][data-files-active]`) the active view sets only when *its* sub-tab is Files; (b) preserve per-tab scroll via **manual save/restore of `scrollTop` on the shared scroller**, keyed by `(prRefKey, subTab)`, on the activation / sub-tab transition. `:has()` does not respect the `hidden` attribute on ancestors, so the marker — not `:has` — is what makes the binding active-only.

**Critical sequencing (within PR1):** the `:has` → marker CSS change MUST land in the **same commit** as the routing swap (Task 5). Committing keep-alive mounting (views accumulate, hidden views keep `.files-tab` in the DOM) *before* removing the global `:has` leaves an intermediate HEAD where the app's layout is broken on Overview/Inbox — the exact "not buildable" state this note describes. Tasks are ordered so the suite is **buildable and the running app is layout-correct at each commit** (vitest greenness alone does not establish layout correctness — jsdom has no layout).

---

## File structure

**Created:**
- `frontend/src/components/PrDetail/PrTabHost.tsx` — persistent host; reads `useLocation` + `openTabs`, renders one `PrDetailView` per tab, toggles `hidden`, ensures the active PR's tab exists.
- `frontend/src/components/PrDetail/PrDetailView.tsx` — the per-tab view (today's `PrDetailPageInner`), owning sub-tab state + activation hook.
- `frontend/src/components/PrDetail/prDetailContext.ts` — small React context carrying `{ prRef, prDetail, draftSession, readOnly, onSelectSubTab }` to sub-tab children (replaces `useOutletContext` + `useParams`).
- `frontend/src/hooks/useActivationTransition.ts` — fires a callback on the `false→true` transition of an `active` flag (skips first-mount-while-active).
- `frontend/src/hooks/useTabScrollMemory.ts` — saves/restores `[data-app-scroll]` scrollTop per `(prRefKey, subTab)` (the shared-scroller scroll-preservation mechanism — Task 6).

**Modified:**
- `frontend/src/App.tsx` — PR route renders `null`; mount `<PrTabHost/>` as a sibling.
- `frontend/src/pages/PrDetailPage.tsx` — becomes a thin re-export/shim or is deleted; logic moves to `PrDetailView`. Keep `PrDetailOutletContext` type's fields in `prDetailContext.ts`.
- `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx`, `FilesTab/FilesTab.tsx`, `DraftsTab/DraftsTabRoute.tsx` — consume `usePrDetailContext()` instead of `useOutletContext`/`useParams`; `OverviewTab` sub-tab nav via context callback.
- `frontend/src/styles/tokens.css` — replace the global `:has(.files-tab)` viewport rules with rules scoped to a `data-files-active` marker the active view stamps on the shared `data-app-scroll` while showing Files.
- Test files listed in PR3.

---

## PR1 — Structural core: host, sub-tab state, scroll memory

### Task 1: Per-view PR-detail context (replaces Outlet + useParams)

**Files:**
- Create: `frontend/src/components/PrDetail/prDetailContext.ts`
- Test: `frontend/src/components/PrDetail/prDetailContext.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// prDetailContext.test.tsx
import { render, screen } from '@testing-library/react';
import { PrDetailContextProvider, usePrDetailContext } from './prDetailContext';
import type { PrDetailContextValue } from './prDetailContext';

function Probe() {
  const ctx = usePrDetailContext();
  return <div>{ctx.prRef.owner}/{ctx.prRef.repo}#{ctx.prRef.number}</div>;
}

test('provides prRef + session to children', () => {
  const value = {
    prRef: { owner: 'acme', repo: 'api', number: 7 },
    prDetail: {} as PrDetailContextValue['prDetail'],
    draftSession: {} as PrDetailContextValue['draftSession'],
    readOnly: false,
    onSelectSubTab: vi.fn(),
  } satisfies PrDetailContextValue;
  render(
    <PrDetailContextProvider value={value}>
      <Probe />
    </PrDetailContextProvider>,
  );
  expect(screen.getByText('acme/api#7')).toBeInTheDocument();
});

test('throws when used outside the provider', () => {
  expect(() => render(<Probe />)).toThrow(/usePrDetailContext must be used inside/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- prDetailContext`
Expected: FAIL — module `./prDetailContext` not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// prDetailContext.ts
import { createContext, useContext, type ReactNode } from 'react';
import type { PrDetailDto, PrReference } from '../../api/types';
import type { UseDraftSessionResult } from '../../hooks/useDraftSession';
import type { PrTabId } from './PrSubTabStrip';

// Carries everything a sub-tab needs, replacing the old Outlet context +
// useParams reconstruction. `prRef` is supplied by the view (from its
// openTabs entry), NOT derived from the URL — under keep-alive a hidden
// view has no matched route, so useParams() would return undefined.
export interface PrDetailContextValue {
  prRef: PrReference;
  prDetail: PrDetailDto;
  draftSession: UseDraftSessionResult;
  readOnly: boolean;
  // Switches the active sub-tab. Replaces the old navigate(`${base}/files`)
  // call sites (OverviewTab CTA, DraftsTab handleEdit, StaleDraftRow handleShowMe).
  onSelectSubTab: (tab: PrTabId) => void;
}

const PrDetailContext = createContext<PrDetailContextValue | null>(null);

export function PrDetailContextProvider({
  value,
  children,
}: {
  value: PrDetailContextValue;
  children: ReactNode;
}) {
  return <PrDetailContext.Provider value={value}>{children}</PrDetailContext.Provider>;
}

export function usePrDetailContext(): PrDetailContextValue {
  const v = useContext(PrDetailContext);
  if (v == null) {
    throw new Error('usePrDetailContext must be used inside PrDetailContextProvider');
  }
  return v;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- prDetailContext`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/prDetailContext.ts frontend/src/components/PrDetail/prDetailContext.test.tsx
git commit -m "feat(pr-detail): per-view context replacing Outlet + useParams"
```

### Task 2: Migrate sub-tab children to context (behavior-preserving)

This task changes the three children to read `usePrDetailContext()` instead of `useOutletContext()` + `useParams()`. To keep the suite green **before** the routing swap (Task 5), the still-route-based `PrDetailPage` wraps its `<Outlet/>` in `PrDetailContextProvider` in this task.

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx`, `FilesTab/FilesTab.tsx`, `DraftsTab/DraftsTabRoute.tsx`
- Modify: `frontend/src/pages/PrDetailPage.tsx` (wrap Outlet in provider; add `subTab` plumbing comes in Task 4)
- Test: existing `OverviewTab`/`FilesTab`/`DraftsTab` specs (update mounting to wrap in `PrDetailContextProvider`)

- [ ] **Step 1: Update OverviewTab — read context, drop useParams/useNavigate**

Replace lines 1–26 + `handleReviewFiles` (line 48–49) in `OverviewTab.tsx`:

```tsx
import { useMemo } from 'react';
import { usePrDetailContext } from '../prDetailContext';
// (drop useNavigate, useOutletContext, useParams imports)

export function OverviewTab() {
  const { prRef, prDetail, draftSession, readOnly, onSelectSubTab } = usePrDetailContext();
  // ...unchanged hook calls (useFileDiff(prRef, ...), useAiSummary, etc.)...

  const handleReviewFiles = () => onSelectSubTab('files');
  // ...rest unchanged...
}
```

Add `onSelectSubTab: (tab: PrTabId) => void` to `PrDetailContextValue` (Task 1 file) and import `PrTabId` from `../PrSubTabStrip`.

- [ ] **Step 2: Update FilesTab — read context, drop useParams**

In `FilesTab.tsx` replace lines 55–70 with:

```tsx
export function FilesTab() {
  const { prRef, prDetail, draftSession, readOnly } = usePrDetailContext();
  // (delete the useParams block + the prRef useMemo — prRef now comes from context)
```

Keep `import { useOutletContext, useParams }` removed; keep all other logic.

- [ ] **Step 3: Update DraftsTabRoute — read context, drop useParams**

Replace `DraftsTabRoute.tsx` lines 1–17 with the context read:

```tsx
import { usePrDetailContext } from '../prDetailContext';
import { DraftsTab } from './DraftsTab';

export function DraftsTabRoute() {
  const { prRef, prDetail, draftSession, readOnly: contextReadOnly } = usePrDetailContext();
  // ...prState + readOnly logic unchanged...
}
```

- [ ] **Step 3b: Migrate the OTHER sub-tab navigators (audit, not just OverviewTab)**

`OverviewTab`'s "Review files" CTA is **not** the only intra-view sub-tab navigation. Two more navigate to sub-tab URLs and become dead clicks once the route renders `null`:

- `DraftsTab.tsx` `handleEdit` (≈`:113`/`:117`: `navigate(\`${base}/files\`)` / `navigate(base)`) — "Edit this draft → jump to Files". Thread `onSelectSubTab` via `usePrDetailContext()` (DraftsTab is under the provider) and replace the two `navigate` calls with `onSelectSubTab('files')` / `onSelectSubTab('overview')`.
- `StaleDraftRow.tsx` `handleShowMe` (≈`:51`/`:55`) — "Show me this stale draft → Files". **`StaleDraftRow` lives inside `UnresolvedPanel`, which `PrDetailView` renders in its always-visible chrome — NOT under the sub-tab provider.** So either (a) render `UnresolvedPanel` inside `PrDetailContextProvider` too, or (b) thread `onSelectSubTab` as an explicit prop `UnresolvedPanel → StaleDraftRow`. Option (a) is simpler and the provider value is already built in `PrDetailView`; prefer it.

Audit: `grep -rn "navigate(" frontend/src/components/PrDetail` and confirm no other call targets a `/files` `/drafts` sub-tab URL. Read each file's current body before editing.

- [ ] **Step 4: Wrap the Outlet in PrDetailPage with the provider**

In `PrDetailPage.tsx`, wrap the `<Outlet context={…}/>` (lines 272–281) so children get context *and* the existing Outlet keeps working until Task 5:

```tsx
<PrDetailContextProvider
  value={{ prRef: ref, prDetail: data, draftSession, readOnly: presence.readOnly,
           onSelectSubTab: handleTabChangeToSubTab }}
>
  <Outlet context={{ prDetail: data, draftSession, readOnly: presence.readOnly } satisfies PrDetailOutletContext} />
</PrDetailContextProvider>
```

Where `handleTabChangeToSubTab(tab)` reuses the existing `handleTabChange` navigation (URL-based, still valid in this task). Keep `PrDetailOutletContext` exported for now (removed in Task 5).

- [ ] **Step 5: Update the three child specs to wrap in the provider**

In `OverviewTab`/`FilesTab`/`DraftsTab` test files, replace any `MemoryRouter`+`Outlet` test harness with a `renderWithPrDetailContext(ui, value)` helper — **a thin wrapper that renders `ui` inside `PrDetailContextProvider value={value}`**, where `value` is `{ prRef, prDetail, draftSession, readOnly, onSelectSubTab: vi.fn() }`. (This is distinct from Task 4's `renderPrDetailView`, which mounts the *whole* `PrDetailView`; this one wraps a single child for the child-component unit tests.) Read each spec's current harness first; preserve the route mock only where a test asserts navigation (OverviewTab "Review files" now asserts the `onSelectSubTab` spy was called with `'files'` instead of a URL change).

- [ ] **Step 6: Run the full frontend suite**

Run: `cd frontend && npm run test`
Expected: PASS. If a child spec still reconstructs `prRef` from a route, update it to the context helper.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail frontend/src/pages/PrDetailPage.tsx
git commit -m "refactor(pr-detail): sub-tabs read prRef/session from context, not Outlet/useParams"
```

### Task 3: `useActivationTransition` hook

**Files:**
- Create: `frontend/src/hooks/useActivationTransition.ts`
- Test: `frontend/src/hooks/useActivationTransition.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from '@testing-library/react';
import { useActivationTransition } from './useActivationTransition';

function Host({ active, cb }: { active: boolean; cb: () => void }) {
  useActivationTransition(active, cb);
  return null;
}

test('does NOT fire on first mount even when active=true', () => {
  const cb = vi.fn();
  render(<Host active cb={cb} />);
  expect(cb).not.toHaveBeenCalled();
});

test('fires once on false->true transition', () => {
  const cb = vi.fn();
  const { rerender } = render(<Host active={false} cb={cb} />);
  rerender(<Host active cb={cb} />);
  expect(cb).toHaveBeenCalledTimes(1);
});

test('does not fire on true->false or repeated true', () => {
  const cb = vi.fn();
  const { rerender } = render(<Host active={false} cb={cb} />);
  rerender(<Host active cb={cb} />);
  rerender(<Host active cb={cb} />); // still active, no re-fire
  rerender(<Host active={false} cb={cb} />); // deactivate, no fire
  expect(cb).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- useActivationTransition`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
import { useEffect, useRef } from 'react';

// Fires `onActivate` on the false->true transition of `active`, and never on
// first mount (even if mounted already-active). Used so a kept-alive
// PrDetailView refetches + clears unread only when the user switches TO it,
// not on every render while active and not when it first mounts.
export function useActivationTransition(active: boolean, onActivate: () => void): void {
  const prev = useRef<boolean | null>(null);
  // Keep the latest callback without re-running the effect on every render.
  const cbRef = useRef(onActivate);
  cbRef.current = onActivate;

  useEffect(() => {
    const wasActive = prev.current;
    prev.current = active;
    // null = first mount: record state, never fire.
    if (wasActive === false && active === true) {
      cbRef.current();
    }
  }, [active]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- useActivationTransition`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useActivationTransition.*
git commit -m "feat(pr-detail): useActivationTransition for focus-driven effects"
```

### Task 4: `PrDetailView` — sub-tab in state, direct sub-tab render

Extract `PrDetailPageInner` into `PrDetailView`, owning sub-tab state and rendering sub-tabs directly (keep-alive on first visit) instead of via `<Outlet>`. The activation hook is wired in PR2 (here it accepts an `active` prop but only uses it for `hidden`).

**Files:**
- Create: `frontend/src/components/PrDetail/PrDetailView.tsx`
- Test: `frontend/src/components/PrDetail/PrDetailView.test.tsx`

- [ ] **Step 1: Write the failing test (sub-tab in state, keep-alive on first visit)**

```tsx
// Mount PrDetailView with a stubbed usePrDetail returning ready data.
// Assert: starts on Overview; clicking Files renders FilesTab; switching
// back to Overview keeps FilesTab in the DOM but hidden (data-testid present,
// hidden attribute set); a never-visited Drafts tab is NOT in the DOM until
// first click.
test('sub-tab selection is component state; visited sub-tabs stay mounted hidden', async () => {
  renderPrDetailView({ prRef: { owner: 'acme', repo: 'api', number: 7 } });
  expect(screen.getByTestId('overview-tab')).toBeVisible();
  expect(screen.queryByTestId('files-tab-root')).not.toBeInTheDocument();

  await userEvent.click(screen.getByTestId('pr-tab-files'));
  expect(screen.getByTestId('files-tab-root')).toBeVisible();

  await userEvent.click(screen.getByTestId('pr-tab-overview'));
  expect(screen.getByTestId('overview-tab')).toBeVisible();
  // FilesTab still mounted, just hidden — its state survives.
  const files = screen.getByTestId('files-tab-root');
  expect(files).toBeInTheDocument();
  expect(files.closest('[data-subtab="files"]')).toHaveAttribute('hidden');

  // Drafts never visited → not mounted.
  expect(screen.queryByTestId('drafts-tab-root')).not.toBeInTheDocument();
});
```

(Add `data-testid="files-tab-root"` to `FilesTab`'s root element and `data-testid="drafts-tab-root"` to `DraftsTab`'s root if absent — read each file first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- PrDetailView`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement PrDetailView**

Move the body of `PrDetailPageInner` (`PrDetailPage.tsx:70–284`) into `PrDetailView`, with these changes:

```tsx
export function PrDetailView({
  prRef,
  active,
  initialSubTab,
}: {
  prRef: PrReference;
  active: boolean;
  initialSubTab?: PrTabId; // seeded from the entry URL by the host (deep-link)
}) {
  // ...all existing hooks: usePrDetail (destructures { data, error, reload, ... }),
  //    useActivePrUpdates (→ `updates`), useDraftSession, useStateChangedSubscriber,
  //    useRootCommentPostedSubscriber, useCrossTabPrPresence (→ `presence`),
  //    useReconcile — UNCHANGED from PrDetailPageInner...

  // Seed from the deep-link sub-tab (read once at mount; the view owns sub-tab
  // state thereafter). Defaults to overview.
  const seed = initialSubTab ?? 'overview';
  const [subTab, setSubTab] = useState<PrTabId>(seed);
  // Mount-on-first-visit then keep alive. Seed `visited` with overview AND the
  // entry sub-tab so a deep-link to /files renders FilesTab immediately (the
  // #156 gate + e2e gotos depend on this).
  const visited = useRef<Set<PrTabId>>(new Set<PrTabId>(['overview', seed]));
  const selectSubTab = useCallback((tab: PrTabId) => {
    visited.current.add(tab);
    setSubTab(tab);
  }, []);

  // addTab moves to the host (Task 5) — REMOVE the addTab effect here.
  // setTitle STAYS in the view (only the view has the resolved title). Keep it
  // verbatim from PrDetailPage.tsx:126–130 — without it, the host's
  // addTab(ref, null) leaves every tab on the "#NNNN" fallback label forever.
  const { setTitle, clearUnread } = useOpenTabs();
  useEffect(() => {
    if (data?.pr.title) setTitle({ owner, repo, number }, data.pr.title);
  }, [data?.pr.title, setTitle, owner, repo, number]);
  // Initial clear-on-open (brand-new tab). Re-activation clearing is wired in
  // PR2 Task 8 via useActivationTransition — this one-shot covers first mount.
  useEffect(() => {
    clearUnread(refKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ctxValue = useMemo(
    () => ({ prRef, prDetail: data!, draftSession, readOnly: presence.readOnly, onSelectSubTab: selectSubTab }),
    [prRef, data, draftSession, presence.readOnly, selectSubTab],
  );

  return (
    <div className={pageClassName} data-prref={prRefKey(prRef)} hidden={!active}>
      <PrHeader /* ...existing props... */ activeTab={subTab} onTabChange={selectSubTab} />
      {/* ...banners, UnresolvedPanel unchanged... */}
      {showSkeleton ? <PrDetailSkeleton /> : data ? (
        <PrDetailContextProvider value={ctxValue}>
          {visited.current.has('overview') && (
            <div data-subtab="overview" hidden={subTab !== 'overview'}><OverviewTab /></div>
          )}
          {visited.current.has('files') && (
            <div data-subtab="files" hidden={subTab !== 'files'}><FilesTab /></div>
          )}
          {visited.current.has('drafts') && (
            <div data-subtab="drafts" hidden={subTab !== 'drafts'}><DraftsTabRoute /></div>
          )}
        </PrDetailContextProvider>
      ) : null}
    </div>
  );
}
```

Note: `visited.current` mutated in `selectSubTab` then `setSubTab` triggers the re-render that reads it — correct ordering. Keep the `PrHeader` `onTabChange` calling `selectSubTab` (was navigation).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- PrDetailView`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/PrDetailView.test.tsx frontend/src/components/PrDetail/FilesTab frontend/src/components/PrDetail/DraftsTab
git commit -m "feat(pr-detail): PrDetailView owns sub-tab state, keep-alive on first visit"
```

### Task 5: `PrTabHost` + routing swap

**Files:**
- Create: `frontend/src/components/PrDetail/PrTabHost.tsx`
- Modify: `frontend/src/App.tsx`
- Modify/Delete: `frontend/src/pages/PrDetailPage.tsx` (logic now in PrDetailView; keep a tiny param-parse helper if reused, else delete)
- Test: `frontend/src/components/PrDetail/PrTabHost.test.tsx`

- [ ] **Step 1: Write the failing test (host mounts N, keeps state, hides inactive)**

```tsx
// Render <App>-like tree with OpenTabsProvider + MemoryRouter at /pr/acme/api/7.
// Assert the active view is visible. Navigate to / (Inbox): the PR view stays
// in the DOM but hidden; Inbox shows. Navigate back to /pr/acme/api/7: same
// PrDetailView instance (state preserved — assert a sub-tab selection set
// before leaving is still active).
test('host keeps PR views mounted across navigation', async () => {
  const { navigate } = renderAppAt('/pr/acme/api/7');
  await userEvent.click(await screen.findByTestId('pr-tab-files'));
  expect(screen.getByTestId('files-tab-root')).toBeVisible();

  navigate('/');
  expect(screen.getByTestId('inbox-page')).toBeVisible();
  expect(screen.getByTestId('files-tab-root')).toBeInTheDocument(); // kept alive
  expect(screen.getByTestId('files-tab-root').closest('[data-prref="acme/api/7"]'))
    .toHaveAttribute('hidden');

  navigate('/pr/acme/api/7');
  // Still on Files — state survived (no remount to Overview).
  expect(screen.getByTestId('files-tab-root')).toBeVisible();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- PrTabHost`
Expected: FAIL — `PrTabHost` not found.

- [ ] **Step 3: Implement PrTabHost**

```tsx
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useOpenTabs } from '../../contexts/OpenTabsContext';
import { prRefKey, type PrReference } from '../../api/types';
import { PrDetailView } from './PrDetailView';

// Parses /pr/{owner}/{repo}/{number}[/files|/drafts]. Returns null when not on
// a PR route. Uses the raw number segment so an invalid number is detectable
// (NaN). ALSO extracts the trailing sub-tab segment so a *deep-link* to
// .../files seeds the view's initial sub-tab. (Sub-tab leaves the URL for
// in-app navigation per spec §1.6 — but entry-time seeding is a one-way
// convenience that keeps the existing `page.goto('.../files')` e2e specs and
// the #156 regression gate working without a URL-coupling.)
function parsePrRoute(pathname: string): { ref: PrReference; valid: boolean; subTab: PrTabId } | null {
  const m = pathname.match(/^\/pr\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return null;
  const number = Number(m[3]);
  const seg = m[4];
  const subTab: PrTabId = seg === 'files' ? 'files' : seg === 'drafts' ? 'drafts' : 'overview';
  return { ref: { owner: m[1], repo: m[2], number }, valid: Number.isInteger(number), subTab };
}

export function PrTabHost() {
  const { pathname } = useLocation();
  const { openTabs, addTab } = useOpenTabs();
  const route = parsePrRoute(pathname);
  const activeKey = route && route.valid ? prRefKey(route.ref) : null;

  // Ensure the active PR's tab exists (relocated from PrDetailPage's addTab
  // effect). Idempotent on prRefKey. Deps are primitive segments, not the ref
  // object literal, to avoid re-firing every render.
  useEffect(() => {
    if (route && route.valid) addTab(route.ref, null);
  }, [addTab, activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (route && !route.valid) {
    return <div role="alert">Invalid PR reference: number must be an integer.</div>;
  }

  return (
    <>
      {openTabs.map((t) => {
        const key = prRefKey(t.ref);
        // initialSubTab applies only to the view being deep-linked to right now
        // (the active one at its first mount). Each view mounts at most once
        // (keep-alive), so this seeds the sub-tab from the entry URL without
        // ever overriding the user's in-app sub-tab state on later re-activation.
        return (
          <PrDetailView
            key={key}
            prRef={t.ref}
            active={key === activeKey}
            initialSubTab={key === activeKey ? route?.subTab : undefined}
          />
        );
      })}
    </>
  );
}
```

- [ ] **Step 4: Swap routing in App.tsx**

In `App.tsx`, change the PR route to render `null` and mount the host as a sibling of `<Routes>` (inside `data-app-scroll`, inside the existing providers):

```tsx
<div data-app-scroll>
  <Routes>
    <Route path="/setup" element={<SetupPage />} />
    <Route path="/settings" element={isAuthed ? <SettingsPage /> : <Navigate to="/setup" replace />} />
    <Route path="/" element={isAuthed ? <InboxPage /> : <Navigate to="/setup" replace />} />
    <Route path="/pr/:owner/:repo/:number/*" element={isAuthed ? null : <Navigate to="/setup" replace />} />
    <Route path="*" element={<Navigate to={isAuthed ? '/' : '/setup'} replace />} />
  </Routes>
  {isAuthed && <PrTabHost />}
</div>
```

Remove the nested `<Route index/files/drafts>` block and the `OverviewTab`/`FilesTab`/`DraftsTabRoute` imports from `App.tsx` (they're now rendered by `PrDetailView`).

- [ ] **Step 5: Reduce PrDetailPage to a deleted/shim file**

Delete `frontend/src/pages/PrDetailPage.tsx`. Move the exported `PrDetailOutletContext` type away — it is replaced by `PrDetailContextValue`. Grep for remaining imports of `PrDetailPage` / `PrDetailOutletContext` and repoint them:

Run: `cd frontend && npx grep -rn "PrDetailPage\|PrDetailOutletContext" src || true` (or use the editor search). Update each hit.

- [ ] **Step 5b: Replace the global `:has(.files-tab)` viewport binding with an active-view marker (MUST land in this commit)**

This is mandatory in the *same commit* as the routing swap: once views stay mounted, hidden views keep `.files-tab` in the DOM, and `:has()` ignores the `hidden` ancestor, so the global selector mis-fires on Overview/Inbox. Keep `[data-app-scroll]` as the scroller (the #156 spec depends on it); gate the Files viewport model on a marker the **active** view sets.

In `tokens.css`, replace the `[data-app-shell]:has(.files-tab)` + `.pr-detail-page:has(.files-tab)` block (≈256–293; read it first) with marker-scoped equivalents. The marker is `data-files-active` on `[data-app-scroll]`:

```css
/* Files viewport model — active only when the ACTIVE view's sub-tab is Files.
   Replaces [data-app-shell]:has(.files-tab), which mis-fires under keep-alive
   (hidden views retain .files-tab; :has ignores [hidden]). [data-app-scroll]
   stays the bounded internal scroller, so diff-scroll-regression.spec.ts
   (which asserts on [data-app-scroll]) remains valid unchanged. */
[data-app-shell]:has([data-app-scroll][data-files-active]) { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
[data-app-shell]:has([data-app-scroll][data-files-active]) > * { flex-shrink: 0; }
[data-app-scroll][data-files-active] { flex: 1; min-height: 0; overflow-y: auto; }
/* Re-host the diff-sizing rule, accounting for the new [data-subtab] wrapper
   layer between .pr-detail-page and .files-tab (Task 4). `.files-tab` is
   FilesTab's existing root class (unchanged — these selectors depend on it,
   so don't drop it during the migration). Without flex:1 1 0 + min-height the
   diff content inflates the container and the bottom-pinned h-scrollbar drops
   below the fold (#155/#191). */
[data-files-active] .pr-detail-page { min-height: 100%; display: flex; flex-direction: column; }
[data-files-active] .pr-detail-page > * { flex-shrink: 0; }
[data-files-active] [data-subtab='files'] { flex: 1 1 0; min-height: 360px; display: flex; flex-direction: column; }
[data-files-active] [data-subtab='files'] > .files-tab { flex: 1 1 0; min-height: 0; }
```

Set the marker from `PrTabHost` (it knows the active view + can read its sub-tab via a small callback, or the active `PrDetailView` sets it itself when `active && subTab === 'files'`). Simplest: the active `PrDetailView` toggles it in a layout effect:

```tsx
useLayoutEffect(() => {
  const slot = document.querySelector('[data-app-scroll]');
  if (!slot) return;
  const on = active && subTab === 'files';
  slot.toggleAttribute('data-files-active', on);
  return () => { if (on) slot.removeAttribute('data-files-active'); };
}, [active, subTab]);
```

**This block is the §5.1 integration risk.** The exact flex chain above is a starting point — the executor MUST iterate it against a real wide+tall diff headed (Step 6b), because jsdom can't validate layout.

- [ ] **Step 6: Run the full suite**

Run: `cd frontend && npm run test`
Expected: PASS. Likely failures: `PrDetailPage.tabbing.test.tsx` (URL-based sub-tab assertions) — these migrate in PR3; if they block, temporarily skip with `test.skip` + a `// PR3: migrate to state-based assertions` note and list them in the PR body. (Note: skipping these means this commit is buildable but not fully green — see the §7 sequencing note; the green-at-each-commit goal is relaxed to *buildable + layout-correct* for exactly these URL-coupled tests.)

- [ ] **Step 6b: Diff-scroll regression gate (headed)**

Run: `cd frontend && npx playwright test diff-scroll-regression`
Expected: PASS unchanged (the spec still asserts on `[data-app-scroll]`, which is still the scroller). If it fails, iterate the Step 5b flex chain against a real wide+tall diff until the sticky bar + uniform h-scroll behave; do NOT switch to a per-view container (that breaks the spec by construction). Record the final CSS in the PR body.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/PrTabHost.tsx frontend/src/App.tsx frontend/src/pages
git commit -m "feat(pr-detail): PrTabHost keep-alive host; PR views leave the route table"
```

### Task 6: Per-tab scroll save/restore (shared scroller)

Because `[data-app-scroll]` stays the single shared scroller (Task 5 / §7 decision), `display:none` does **not** auto-preserve per-tab scroll — all views share one scroller. Save the outgoing scroll offset and restore the incoming one, keyed by `(prRefKey, subTab)`, on the activation / sub-tab transition.

**Files:**
- Create: `frontend/src/hooks/useTabScrollMemory.ts`
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx` (call it)
- Test: `frontend/src/hooks/useTabScrollMemory.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// A module-level Map<string, number> stores scrollTop per `${prRefKey}|${subTab}`.
// On the false->true activation of a (view, subTab), restore its saved offset;
// on the true->false transition, save the current scrollTop.
test('restores saved scrollTop for a (tab, subTab) on activation', () => {
  const slot = document.createElement('div');
  slot.setAttribute('data-app-scroll', 'true');
  document.body.appendChild(slot);
  Object.defineProperty(slot, 'scrollTop', { value: 0, writable: true });

  const h = renderHook(({ active, subTab }) => useTabScrollMemory({ prRefKey: 'acme/api/7', subTab, active, slotSelector: '[data-app-scroll]' }),
    { initialProps: { active: true, subTab: 'files' as const } });

  slot.scrollTop = 300;
  h.rerender({ active: false, subTab: 'files' }); // deactivate → saves 300
  slot.scrollTop = 0;                              // another tab scrolled to top
  h.rerender({ active: true, subTab: 'files' });   // reactivate → restores 300
  expect(slot.scrollTop).toBe(300);
});

// Round-2 race guard: two views sharing the scroller, the INCOMING view earlier
// in render order than the OUTGOING. The outgoing view's offset must survive.
test('cross-view swap preserves the outgoing offset regardless of render order', () => {
  const slot = makeScrollSlot(); // helper: appends [data-app-scroll] with writable scrollTop
  // Render B (incoming) and A (outgoing) as siblings, A active.
  const { rerender } = render(<>
    <Mem prRefKey="acme/api/8" active={false} />   {/* B first in tree order */}
    <Mem prRefKey="acme/api/7" active={true} />     {/* A active */}
  </>);
  slot.scrollTop = 420;                              // user scrolled A
  rerender(<>
    <Mem prRefKey="acme/api/8" active={true} />      {/* activate B (earlier) */}
    <Mem prRefKey="acme/api/7" active={false} />     {/* deactivate A */}
  </>);
  // A's cleanup (save 420) runs before B's setup (restore) → A's offset intact.
  rerender(<>
    <Mem prRefKey="acme/api/8" active={false} />
    <Mem prRefKey="acme/api/7" active={true} />      {/* re-activate A */}
  </>);
  expect(slot.scrollTop).toBe(420);
});
```

(`Mem` is a tiny test host calling `useTabScrollMemory({ prRefKey, subTab: 'files', active })`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- useTabScrollMemory`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

```tsx
import { useLayoutEffect, useRef } from 'react';

// Shared across all PrDetailViews so the offset for a backgrounded (tab,subTab)
// survives while another view drives the single [data-app-scroll] scroller.
const store = new Map<string, number>();

export function useTabScrollMemory(opts: {
  prRefKey: string;
  subTab: string;
  active: boolean;
  slotSelector?: string;
}): void {
  const { prRefKey, subTab, active, slotSelector = '[data-app-scroll]' } = opts;
  const key = `${prRefKey}|${subTab}`;

  useLayoutEffect(() => {
    const slot = document.querySelector(slotSelector) as HTMLElement | null;
    if (!slot || !active) return;
    // Restore on setup (activation, or sub-tab change within an active view).
    slot.scrollTop = store.get(key) ?? 0;
    // Save in CLEANUP. React runs all cleanups before any setups within a
    // commit, so a deactivating view persists its scrollTop BEFORE the
    // activating view overwrites the single shared [data-app-scroll] — no
    // cross-view race regardless of openTabs order (this is the round-2 fix).
    // The same property handles same-view sub-tab switches: changing `subTab`
    // changes `key`, so cleanup saves the old sub-tab's offset before setup
    // restores the new one.
    return () => {
      store.set(key, slot.scrollTop);
    };
  }, [active, key, slotSelector]);
}
```

This eliminates the shared-scroller race the round-2 review found: with save-in-body, two views toggling in one commit could read each other's live `scrollTop` in undefined effect-body order; with save-in-cleanup the outgoing view always persists first.

- [ ] **Step 4: Wire it into PrDetailView + run**

This step **modifies the `PrDetailView.tsx` created in Task 4** — add the call alongside the existing `useActivationTransition` / `setTitle` / `clearUnread` hooks: `useTabScrollMemory({ prRefKey: refKey, subTab, active })`. Run:

Run: `cd frontend && npm run test -- useTabScrollMemory && npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useTabScrollMemory.* frontend/src/components/PrDetail/PrDetailView.tsx
git commit -m "feat(pr-detail): per-tab scroll save/restore on the shared scroller"
```

### Task 7: PR1 manual verification + open PR

- [ ] **Step 1: Run the pre-push checklist**

Run: `cd frontend && npm run lint && npm run build && npm run test`
Expected: all green. (Per `.ai/docs/development-process.md` — lint includes prettier `--check`.)

- [ ] **Step 2: Manual smoke (real app)**

Launch via `./run.ps1 -Reset None --no-browser`, open a real PR (e.g. BFF repo), go to Files, scroll a diff, open Inbox, return → assert same sub-tab + scroll + selected file. Open a second PR tab, switch between them → each keeps its own state. Capture before/after screenshots for the PR.

- [ ] **Step 3: High-tab-count smoke (browser EventSource cap — #161 guard)**

Each mounted view holds a live `useActivePrUpdates` `EventSource`, and **browsers cap concurrent `EventSource` connections at ~6 per origin** — so past ~6 open tabs, the newest tabs' SSE subscriptions can silently never connect, and their "PR updated" banners never fire. The LRU/subscription-pause fix is deferred to [#161](https://github.com/prpande/PRism/issues/161), but this cut must **measure** the ceiling: open ~8–10 real PR tabs, then push an update to the *most-recently-opened* tab (via `/test/emit-pr-updated` or a real comment) and confirm its banner appears. Record the observed tab ceiling in the PR body. **If updates stall before a usable tab count, subscription-pausing (#161) is no longer optional — promote it into scope before merge.** (Note also: a pre-populated `openTabs` mounts all views' `usePrDetail` GET + `mark-viewed` POST + `OverviewTab` eager `useFileDiff` at once — see the §5.3-claim correction in the self-review.)

- [ ] **Step 4: Open PR1 via pr-autopilot**

Use the `pr-autopilot` skill. PR body notes: the §7 deviation, the `:has`→marker scroll fix, the final tokens.css flex chain (from Step 6b iteration), the measured tab/EventSource ceiling (Step 3), and any `test.skip`'d tabbing tests deferred to PR3.

---

## PR2 — Data freshness (refetch-on-focus + clearUnread)

### Task 8: Refetch + clearUnread on activation

**Files:**
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx`
- Test: `frontend/src/components/PrDetail/PrDetailView.freshness.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// Stub usePrDetail.reload as a spy; stub clearUnread. Render two tabs.
// Activating a previously-inactive tab fires reload() once and clearUnread(key)
// once. First mount (already active) does NOT fire reload.
test('activation refetches and clears unread; first mount does not', () => {
  const reload = vi.fn();
  const clearUnread = vi.fn();
  const view = renderPrDetailView({ active: true, reload, clearUnread, refKey: 'acme/api/7' });
  expect(reload).not.toHaveBeenCalled();           // first mount, active
  view.rerender({ active: false });
  view.rerender({ active: true });                  // re-activate
  expect(reload).toHaveBeenCalledTimes(1);
  expect(clearUnread).toHaveBeenCalledWith('acme/api/7');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- PrDetailView.freshness`
Expected: FAIL.

- [ ] **Step 3: Wire the activation hook**

In `PrDetailView`, add:

`clearUnread` is already destructured from `useOpenTabs()` in Task 4 (alongside `setTitle`), the one-shot first-mount `clearUnread(refKey)` effect was added there, and `reload` comes from the existing `usePrDetail(...)` return (the `{ data, error, reload, … }` destructure carried over from `PrDetailPageInner`). This step only **adds** the re-activation wiring to the `PrDetailView.tsx` created in Task 4:

```tsx
useActivationTransition(active, () => {
  reload();              // usePrDetail.reload — re-GET + re-stamp mark-viewed
  clearUnread(refKey);   // clear the unread dot for THIS tab
});
```

The Task 4 one-shot covers first open; this covers re-activation. (Both fire `clearUnread` — idempotent on an already-clear key, `OpenTabsContext.tsx:105–112`.)

- [ ] **Step 4: Run test + full suite**

Run: `cd frontend && npm run test -- PrDetailView`
Expected: PASS.

- [ ] **Step 5: Refetch-failure must not destroy the preserved view (OQ6)**

`usePrDetail.reload()` on a failed GET sets `error`; verify that error path does **not** replace the kept-alive content (`usePrDetail.ts:46–48` keeps prior `data` on a same-PR reload, so the view should stay rendered with last-known data + the scroll the feature exists to protect). Add a test: a rejected focus-refetch leaves `files-tab-root` visible with prior `selectedPath` intact; the error surfaces as the existing non-destructive `pr-detail-error` banner, not a content replacement. If the error path *does* blank the content, gate the activation `reload()` to swallow+surface-via-banner per OQ6's default before shipping.

- [ ] **Step 6: Stale selected-file after refetch (OQ5) — confirm existing guard**

A focus-refetch can return a file list missing the preserved `selectedPath` (force-push). `FilesTab.tsx` already resets to the first file when `selectedPath` is absent from the list (read the current guard — around the `setSelectedPath(fileList[0])` effect). Assert that behavior holds after a focus-refetch (no crash; lands on first file). **Note the divergence from spec §8 OQ5's stated default ("empty placeholder with a message"):** the shipped behavior is reset-to-first-file, which is acceptable; record this in the PR body so the spec default and the implementation agree (amend the spec's OQ5 line to "reset to first file" if preferred).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/PrDetailView.freshness.test.tsx
git commit -m "feat(pr-detail): refetch + clearUnread on tab re-activation (OQ1 option a); OQ5/OQ6 guards"
```

### Task 9: Banner-clears-on-refetch interplay (OQ8)

**Files:**
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx`
- Test: extend `PrDetailView.freshness.test.tsx`

- [ ] **Step 1: Failing test** — activating a tab that latched a "PR updated" banner (`useActivePrUpdates` `hasUpdate=true`) clears the banner after the focus-refetch resolves (assert `updates.clear()` called by the activation path, OR the banner unmounts once `data` refreshes).

- [ ] **Step 2–4:** In the activation callback, after `reload()`, also call `updates.clear()` so the pre-loaded banner doesn't linger as a redundant Reload affordance (the focus-refetch already fetched fresh data). Verify the test passes; run the full suite.

- [ ] **Step 5: Commit** `feat(pr-detail): focus-refetch clears the latched update banner (OQ8)`

### Task 10: PR2 verification + open PR

- [ ] Run `npm run lint && npm run build && npm run test`; manual smoke (background tab receives a comment via `/test/emit-pr-updated`, switch to it → banner clears, dot clears, fresh data); open PR2 via pr-autopilot.

---

## PR3 — Test migration, a11y, e2e

### Task 11: Migrate URL-based sub-tab tests to state-based

**Files:**
- Modify: `frontend/src/pages/PrDetailPage.tabbing.test.tsx` (rename → `PrTabHost.tabbing.test.tsx`), `frontend/src/contexts/OpenTabsContext.test.tsx` (verify still valid), any Playwright spec navigating by `/files` `/drafts` URLs.

- [ ] **Step 1:** Read each test. Replace URL assertions (`expect(location).toBe('/pr/.../files')`) with sub-tab control + content assertions (`click pr-tab-files` → `files-tab-root` visible; pathname unchanged). Un-`skip` any tests parked in PR1 Task 5.
- [ ] **Step 2:** Playwright specs that **enter** via `page.goto('/pr/acme/api/123/files')` (and the shared helpers `openScenarioFilesTab` in `s4-setup.ts`, `parity-fixture.ts`, `s5-submit.ts`) **keep working** — the host seeds the initial sub-tab from the entry URL (Task 5 `parsePrRoute.subTab` → `initialSubTab`), so the deep-link still lands on Files. **No change needed** for entry-by-goto. Only migrate specs that assert the **URL changes after a sub-tab click** (sub-tab no longer round-trips to the URL per §1.6): replace the URL assertion with a `pr-tab-*` selected-state / content assertion. Audit: `grep -rn "/files'\|/drafts'" frontend/e2e` and classify each as entry-goto (keep) vs post-click-URL-assert (migrate).
- [ ] **Step 3:** Run `npm run test` + targeted Playwright specs; all green.
- [ ] **Step 4: Commit** `test(pr-detail): migrate sub-tab assertions from URL to state`

### Task 12: Hidden-view a11y isolation test

- [ ] **Step 1: Failing test** — with two tabs open (one hidden), assert no focusable element inside the hidden view is reachable: query the hidden view's buttons/links and assert the container has the `hidden` attribute (jsdom proxy for `display:none` removing them from the a11y tree + tab order). Add an axe check if the suite already uses `jest-axe`/`axe-core`.

```tsx
test('hidden PR view is not in the tab order or a11y tree', () => {
  renderTwoTabs(); // active: 8, hidden: 7
  const hidden = screen.getByTestId('pr-detail-view-acme/api/7');
  expect(hidden).toHaveAttribute('hidden');
  // every focusable descendant is inside a hidden subtree
  hidden.querySelectorAll('button, a, [tabindex]').forEach((el) => {
    expect(el.closest('[hidden]')).not.toBeNull();
  });
});
```

- [ ] **Step 2–4:** Implement passes with the existing `hidden` attribute (no code change expected — this test locks the contract). If a leak is found in a target Electron build, add `inert` to inactive views in `PrTabHost`. Commit `test(pr-detail): hidden-view keyboard/a11y isolation`.

### Task 13: Playwright e2e — full state preservation

**Files:**
- Create: `frontend/e2e/pr-tab-keepalive.spec.ts` (or the project's e2e dir — read an existing spec for the harness + fixtures, e.g. the stale-OID real-flow spec).

- [ ] **Step 1: Write the e2e** — open the fake fixture PR (`acme/api/123`) or a real PR per the project's e2e mode: go to Files, select a file, deep-scroll the diff, switch to Inbox, return → assert same sub-tab, same selected file, scroll offset preserved (`expect(scrollTop).toBeGreaterThan(0)`); open a second PR tab and assert independent state; receive a `pr-updated` via `/test/emit-pr-updated` for the background tab and assert the banner is pre-loaded on return and clears after refetch.
- [ ] **Step 2:** Run `npx playwright test pr-tab-keepalive`; green.
- [ ] **Step 3: Commit** `test(pr-detail): e2e keep-alive state preservation`

### Task 14: Docs + PR3 open

- [ ] **Step 1:** Update `docs/specs/README.md` keepalive entry → In progress with PR links; per `.ai/docs/documentation-maintenance.md` confirm no other doc needs the change.
- [ ] **Step 2:** Run the full pre-push checklist (`npm run lint && npm run build && npm run test` + dotnet build if any backend touched — none expected).
- [ ] **Step 3:** Open PR3 via pr-autopilot. Close issue cross-refs as appropriate; #160/#161 remain open (deferred).

---

## Self-review (run before handing to execution)

**Spec coverage:** §2 host/routing → Task 5; §3.1 per-view context setup → Task 1; §3.1 sub-tab state (parent-owned, seeded from the entry URL via `parsePrRoute.subTab → initialSubTab` so deep-link `goto('.../files')` e2e specs + the #156 gate keep working) → Tasks 4 + 5; §3.1 child prop migration + all three sub-tab navigators → Tasks 2 + 3b; §3.2 mount-on-first-visit → Task 4; §3.3 scroll preservation → the §7 *revised* model (shared scroller + `:has`→marker in Task 5 Step 5b + per-tab save/restore in Task 6), NOT the spec's per-view container (rejected — see §7); §4.1 refetch-on-focus → Task 8; §2.3 clearUnread-on-activation → Tasks 4 (first mount) + 8 (re-activation); §4.2 SSE stay-live (no code) → inherent (hooks unchanged in PrDetailView); §4.2 OQ8 banner → Task 9; §5.1 diff-scroll gate → Task 5 Step 6b; §5.2 test migration → Task 11; §6 tests → Tasks 4/6/8/12/13; a11y contract → Task 12; OQ1 = option a → Task 8; OQ5 stale-file → Task 8 Step 6 (existing reset-to-first-file guard, divergence from spec default noted); OQ6 refetch-fail → Task 8 Step 5. **Not implemented (deferred):** §1.5 LRU/SSE-pause/Inbox (#161 — but Task 7 Step 3 *measures* the EventSource ceiling and promotes #161 into scope if updates stall), §8 OQ2 (backend N-subscription tolerance — verify in Task 7 Step 3 smoke), OQ3 cross-window readOnly, OQ7 dirty-composer (relies on existing `useComposerAutoSave`; unchanged close behavior), read-receipts (#160).

**Type consistency:** `PrTabId` (`overview|files|drafts`) used consistently from `PrSubTabStrip`; `PrDetailContextValue` (Task 1) includes `prRef` + `onSelectSubTab` (the context **field** is `onSelectSubTab`; Task 4 implements it with a local `selectSubTab` callback passed as `onSelectSubTab: selectSubTab` — same function, field name is the public API); `useActivationTransition(active, cb)` signature matches Tasks 3/8; `useTabScrollMemory({prRefKey, subTab, active})` matches Task 6 call site.

**Spec §5.3 "no mount storm" correction:** that spec claim holds only when `openTabs` grows incrementally (the current reality — tabs don't persist across refresh). If `openTabs` is ever pre-populated, `PrTabHost.map` mounts every view's `usePrDetail` GET + `mark-viewed` POST + `OverviewTab` eager `useFileDiff` concurrently. Task 7 Step 3 measures the practical ceiling; a future LRU/lazy-mount (#161) is the fix if it bites.

**Buildability note:** "green at each commit" is relaxed to **buildable + layout-correct** for the URL-coupled tabbing tests, which are `test.skip`'d at Task 5 and un-skipped at Task 11 (§7 sequencing note). The `:has`→marker CSS lands in the *same* commit as the routing swap (Task 5 Step 5b) so no intermediate HEAD is layout-broken.

**Placeholder scan:** no TBD/TODO; each code step shows real code or names the exact current-file lines to read+adapt. The tokens.css flex chain in Task 5 Step 5b is explicitly a *starting point the executor iterates against the headed #156 fixture* (Step 6b) — flagged as such, not a hidden placeholder, because layout cannot be validated in jsdom.
