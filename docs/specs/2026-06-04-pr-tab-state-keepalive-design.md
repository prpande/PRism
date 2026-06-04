# PR-detail tab state preservation (keep-alive)

**Date**: 2026-06-04.
**Status**: Approved — brainstorm output; implementation plan written (`../plans/2026-06-04-pr-tab-state-keepalive.md`) and in execution. The scroll model (§3.3 / §5.1) was revised during planning from per-view containers to a shared scroller with manual save/restore; those sections carry the revision note.
**Source authorities**:
- `frontend/src/App.tsx` — the current `<Routes>` table that renders one route element at a time and unmounts `PrDetailPage` on every navigation. This spec restructures it.
- `frontend/src/pages/PrDetailPage.tsx` — today's PR-detail container (`PrDetailPage` + `PrDetailPageInner`). Becomes the per-tab keep-alive view.
- `frontend/src/contexts/OpenTabsContext.tsx` — the in-memory open-tabs registry (`addTab`/`setTitle`/`closeTab`/`clearAllTabs`). The host reads it to decide which views to mount.
- `frontend/src/components/PrTabStrip/PrTabStrip.tsx` — the browser-style tab strip. Tab clicks activate a kept-alive view instead of remounting one.
- `frontend/src/hooks/usePrDetail.ts` — fetch + `postMarkViewed` stamp coupling (lines 52–79) that makes refetch-on-focus re-stamp for free; the same-PR reload guard (lines 46–48) keeps prior data visible so the refresh has no skeleton flash.
- `frontend/src/hooks/useActivePrUpdates.ts`, `frontend/src/hooks/useStateChangedSubscriber.ts`, `frontend/src/hooks/useCrossTabPrPresence.ts` — the `prRef`-scoped SSE / presence subscriptions that stay live for hidden tabs.
- `docs/specs/2026-06-01-real-side-by-side-diff-rendering-design.md` + PRs #149/#155/#156 — the recently-hardened, viewport-bound diff-scroll model that the keep-alive scroll change (§3.3/§5) must not regress; it pins `data-app-scroll` as the bounded internal scroller, which is why the shipped design keeps that scroller shared rather than moving it per-view.
- [`.ai/docs/frontend-conventions.md`](../../.ai/docs/frontend-conventions.md), [`.ai/docs/documentation-maintenance.md`](../../.ai/docs/documentation-maintenance.md).

---

## 1. Goal and scope

### 1.1 Goal

When a user has a PR-detail tab open, navigates away (to the Inbox, Settings, or another PR tab), and returns, the tab must restore to **exactly the view state they left** — active sub-tab, scroll position, selected file, compare/iteration picker, expanded folders, open composers, word-diff toggles, Ai-summary expansion, and any future per-component UI state — so they continue work uninterrupted. Today, returning resets the tab to its original opened state (Overview sub-tab, fresh scroll, default selections).

### 1.2 The mechanism being fixed

Two distinct resets happen today:

1. **Sub-tab reset.** `PrTabStrip`'s `handleTabClick` (`PrTabStrip.tsx:133–137`) always navigates to the bare base path via `pathFor` (`:19–21`) — `/pr/{owner}/{repo}/{number}`, i.e. the Overview sub-tab — discarding which sub-tab the user was on.
2. **Full in-component reset.** `App.tsx`'s `<Routes>` renders one route at a time, so leaving a PR **fully unmounts** `PrDetailPage`; returning **remounts it fresh**, destroying all React/DOM/scroll state.

### 1.3 Chosen approach — keep-alive (Model B), not snapshot/restore (Model A)

Two approaches were weighed in brainstorm:

- **Model A — snapshot & restore.** Serialize each component's state into a per-tab store on unmount, restore on remount. **Rejected.** Its cost is a perpetual, distributed maintenance treadmill: every stateful component must opt in, and the failure mode is *silent* — a future component that forgets to wire save/restore quietly resets with no error or test failure. It never durably reaches full fidelity; it reaches a partial fidelity that rots as the page grows. This is the exact maintenance risk the feature must avoid.
- **Model B — keep-alive (CHOSEN).** Keep `PrDetailPage` mounted when navigating away; render it `hidden` instead of unmounting. The React tree stays alive, so **all state, DOM, and scroll positions are preserved natively, with zero per-component wiring.** New components inherit preservation for free. The cost is **one-time and centralized** (a routing restructure + a few hook/scroll adjustments) instead of perpetual and distributed.

The decisive factor: the user explicitly wants full fidelity (every component) *and* explicitly wants low long-term maintenance as components are added. Only Model B serves both — Model A trades one against the other.

### 1.4 In scope

1. A persistent **`PrTabHost`** that renders one mounted PR-detail view per open tab, only the active one visible (§2).
2. Routing restructure: PR views leave the `<Routes>` table; the `/pr/…` route becomes a thin placeholder (§2.1).
3. **Sub-tab selection moves from URL into per-view component state** (§3). Sub-tabs become keep-alive, mounted on first visit (§3.2).
4. **Shared scroller with per-tab scroll save/restore** so each tab retains its own scroll position under `hidden`, without disturbing the hardened diff-scroll model (§3.3). *(Revised from per-view containers during planning — see §3.3.)*
5. **Refetch-on-focus** for data freshness, which re-stamps `mark-viewed` for free (§4).
6. Relocation of `addTab`/`setTitle` responsibility from `PrDetailPage` into the host + view (§2.2).
7. Test migration + new keep-alive tests (§6).

### 1.5 Out of scope and deferrals (tracked in § Deferred work)

The first three are deferred (may be picked up on a stated trigger; tracked in issue [#161](https://github.com/prpande/PRism/issues/161)); the fourth is a **permanent** design constraint that enables the approach, not a deferral.

- **LRU cap on mounted views (deferred → #161).** Each live view holds its `PrDetailDto` + visited Files diffs. For typical use the cost is small, **but a triage session that opens many PRs from the Inbox (20–40 tabs) accumulates that many permanently-mounted views, each with a live SSE subscription and `BroadcastChannel`** — there is no eviction until manual close. The only mitigation in this cut is the close-tab affordance. A soft LRU cap (evicted → cold reload on return) is deferred until tab counts prove it necessary.
- **Inbox keep-alive (deferred → #161).** Only PR-detail tabs are in scope. The Inbox may remount on return (no requirement to preserve its scroll/filter state). If desired later, it is a separate, smaller application of the same host pattern.
- **Pausing hidden tabs' SSE subscriptions (deferred → #161).** Left live deliberately (§4.2) — scoped, cheap, and beneficial (pre-loaded background banners). Pausing is a perf lever for large tab counts only. Note the server-side lifecycle consequence in §4.2.
- **Deep-linking / browser back-forward through sub-tabs (permanent — enables the design).** Sub-tab selection leaves the URL entirely; the address bar no longer reflects the active sub-tab and browser back/forward no longer steps through sub-tabs. This is what *permits* §3 and is not a planned reversal.

See **§9 Deferred work** for the consolidated list with tracking links.

### 1.6 The load-bearing bets (vetoed-or-confirmed in brainstorm, both confirmed)

1. **Sub-tab leaves the URL entirely.** The address bar stops reflecting the active sub-tab. Accepted because deep-linking is out of scope (§1.5).
2. **The scroll model is the one integration risk** against the recently-hardened diff-scroll model (§5). Resolved during planning by keeping the shared `data-app-scroll` scroller and restoring `scrollTop` manually per tab (§3.3), rather than the brainstorm's per-view containers — the former "fallback" became the primary design.

---

## 2. Architecture — persistent PR-tab host

### 2.1 Routing restructure

`App.tsx`'s content region changes from "Routes render everything" to "Routes render non-PR pages; a persistent host renders PR views":

```
<div data-app-scroll>
  <Routes>
    <Route path="/setup"    element={<SetupPage/>}/>
    <Route path="/settings" element={isAuthed ? <SettingsPage/> : <Navigate to="/setup"/>}/>
    <Route path="/"         element={isAuthed ? <InboxPage/>   : <Navigate to="/setup"/>}/>
    <Route path="/pr/:owner/:repo/:number/*"
           element={isAuthed ? null : <Navigate to="/setup"/>}/>  {/* placeholder; host renders the view */}
    <Route path="*" element={<Navigate to={isAuthed ? '/' : '/setup'}/>}/>
  </Routes>
  <PrTabHost/>   {/* persistent — always mounted, sibling to Routes */}
</div>
```

The `/pr/…/*` route still exists so the catch-all does not redirect a valid PR URL and so the auth gate is enforced, but it renders `null` — the actual view comes from `PrTabHost`. The nested sub-tab routes (`index`/`files/*`/`drafts`) are **removed** from the route table (replaced by §3).

### 2.2 `PrTabHost` responsibilities

A new component, always mounted (sibling to `<Routes>`), that:

1. **Reads `useLocation`.** Parses the pathname for a `/pr/{owner}/{repo}/{number}` prefix to determine the *active* PR ref (or none, when on Inbox/Settings/Setup).
2. **Ensures the tab exists.** If the active PR ref is a valid reference not yet in `openTabs`, calls `addTab(ref, null)`. This relocates the addTab responsibility out of `PrDetailPage`'s mount effect (`PrDetailPage.tsx:120–122`) — under keep-alive the host must register the tab *before* a view for it can render.
3. **Renders one `<PrDetailView prRef active/>` per `openTabs` entry**, all mounted, with the `hidden` attribute on every view whose ref is not the active PR *and* whenever the current route is not a `/pr/…` route. When on Inbox/Settings, all PR views are `hidden` and the `<Routes>` content shows instead. **Accessibility contract:** `hidden` (`display:none`) removes a view from both the tab order and the accessibility tree in Chromium/Electron, so the N inactive views in the DOM are not reachable by keyboard or screen reader. The §6 a11y test asserts this; if a target Electron version proves leaky, add `inert` as a belt-and-suspenders.
4. **Invalid ref:** if the active `/pr/…` URL has a non-integer number, the host renders the existing `role="alert"` invalid-PR message in place of a view (preserves `PrDetailPage.tsx:48–54` behavior).

### 2.3 `PrDetailView` — the per-tab view

`PrDetailView` is today's `PrDetailPageInner` (`PrDetailPage.tsx:70–284`), with these changes:

- It owns its sub-tab state (§3) instead of deriving `activeTab` from `useLocation`.
- It calls `setTitle` once `usePrDetail` resolves the title (relocated from `PrDetailPage.tsx:126–130`) — the data lives here, so titling stays here.
- It renders its sub-tab content directly (§3.1) instead of via `<Outlet>`.
- It **clears unread on activation, not on mount.** Today's `clearUnread(refKey)` effect (`PrDetailPage.tsx:132–136`) is keyed on mount + `refKey` change, neither of which fires when the user re-activates an already-mounted hidden tab. Under keep-alive, `clearUnread(refKey)` must move onto the same active-transition hook that drives refetch-on-focus (§4.1), so a background tab that latched an unread dot clears it when the user switches back.
- It never unmounts until its tab is removed from `openTabs` (close) or `clearAllTabs` fires (identity-changed). Both already exist (`OpenTabsContext.tsx:74–87`, `114–135`).

The outer `PrDetailPage` wrapper (param parsing, `PrDetailPage.tsx:35–68`) is absorbed into the host's ref-parsing; the `PrReference` is reconstructed per view from its `openTabs` entry rather than from `useParams`.

---

## 3. Sub-tab + scroll preservation

### 3.1 Sub-tab in component state

Each `PrDetailView` holds `const [subTab, setSubTab] = useState<PrTabId>('overview')`. `PrHeader`/`PrSubTabStrip`'s `onTabChange` calls `setSubTab` instead of `navigate` (replacing `PrDetailPage.tsx:138–142`). Because the view stays mounted, the sub-tab is preserved across navigation for free — clicking the PR in `PrTabStrip` merely re-activates the view (`hidden` → visible), landing the user on the sub-tab they left.

Sub-tab content renders directly:

```
{visited.has('overview') && <div hidden={subTab!=='overview'}><OverviewTab .../></div>}
{visited.has('files')    && <div hidden={subTab!=='files'}>   <FilesTab .../></div>}
{visited.has('drafts')   && <div hidden={subTab!=='drafts'}>  <DraftsTabRoute .../></div>}
```

The outlet context (`PrDetailOutletContext`: `prDetail`, `draftSession`, `readOnly` — `PrDetailPage.tsx:26–33`) is passed to these children as **props** (or via a small local context provider) instead of `useOutletContext`. Beyond that, the children need **two** further changes (they are *not* otherwise unchanged):

1. **`prRef` becomes a prop, not `useParams`.** `OverviewTab` (`OverviewTab.tsx:21`), `FilesTab` (`FilesTab.tsx:57`), and `DraftsTabRoute` (`DraftsTabRoute.tsx:13`) each reconstruct `prRef` from `useParams`. Once the `/pr/…` route element renders `null` (§2.1), `useParams` returns `undefined` and `prRef` degrades to `{ owner: undefined, repo: undefined, number: NaN }`, breaking every downstream data hook (`useFileDiff`, `useAiSummary`, …). `prRef` must be threaded in from the view.
2. **Intra-view sub-tab navigation switches to `setSubTab`.** `OverviewTab`'s "Review files" CTA navigates to the `/files` URL (`OverviewTab.tsx:48`), which no longer routes anywhere. It (and any sibling) must call the new `setSubTab` callback instead.

### 3.2 Sub-tabs are keep-alive, mounted on first visit

A `visited` ref-set (`useRef(new Set<PrTabId>(['overview']))`, augmented in a `setSubTab` wrapper) tracks which sub-tabs have ever been opened. A sub-tab is rendered (and thereafter kept mounted, toggled by `hidden`) **only after its first visit**. Rationale: avoid eagerly mounting `FilesTab` — which lazily fetches the file tree + first diff — for a PR the user only skims on Overview. After first visit, the sub-tab keeps its state (selected file, compare picker, diff scroll) for the life of the tab.

### 3.3 Scroll retention — shared scroller + per-tab save/restore

> **Revised during planning.** The brainstorm proposed *per-view scroll containers* (each `PrDetailView` its own `overflow:auto` element, relying on the browser to preserve `scrollTop` under `display:none`). The `ce-doc-review` of the implementation plan rejected that: the hardened Files-tab scroll model (PRs #149/#155/#156) and the #156 regression spec both assert that the **outer `data-app-scroll` IS the bounded internal scroller**. Per-view containers would have forced `data-app-scroll` non-scrolling and re-hosted the viewport-binding rules on every view, fighting that contract. The shipped model below keeps the single shared scroller and restores scroll manually — the §5.1 "fallback" became primary.

All PR views share the single outer `data-app-scroll` scroller (`App.tsx`). Each view's offset is saved and restored **per `(prRef, subTab)`** by `useTabScrollMemory` — a module-level `Map` with a restore-in-setup / save-in-cleanup `useLayoutEffect`. React runs all effect cleanups before any setups within a commit, so a deactivating view persists its `scrollTop` *before* the activating view restores its own — no cross-view race regardless of mount order. Switching sub-tabs within one view changes the `(prRef, subTab)` key, so the same property saves the outgoing sub-tab's offset before restoring the incoming one.

**Files viewport-binding under keep-alive.** The hardened Files layout previously keyed off a global `[data-app-shell]:has(.files-tab) … ` selector. Under keep-alive that mis-fires: every open tab that has ever visited Files keeps a (hidden) `.files-tab` mounted, so `:has` would match for inactive tabs too. Instead, the route-active view stamps a `data-files-active` marker on `data-app-scroll` **only while it is the active view AND showing Files**; the viewport-binding rules in `tokens.css` are scoped to that marker. The marker effect is declared *before* `useTabScrollMemory` so the container is already a scroller when `scrollTop` is restored (in a real browser, writing `scrollTop` to a not-yet-scrollable element clamps to 0). `:not([hidden])` guards keep an explicit `display:flex` from overriding the `hidden` attribute and un-hiding inactive views. This preserves the exact #156 contract — `data-app-scroll` stays the bounded internal scroller — while making it keep-alive-correct.

---

## 4. Data freshness — refetch on focus

### 4.1 Refetch-on-focus (re-stamp rides along)

When a view transitions to active (gains focus), it fires `usePrDetail.reload()` (`usePrDetail.ts:93`). Because `postMarkViewed` is welded to the fetch (`usePrDetail.ts:52–79`, fires after *every* successful `getPrDetail`, mount or reload), the last-viewed head-sha + comment-id **re-stamp automatically** with the fresh data. `usePrDetail.ts:46–48` deliberately does not null `data` on a same-PR reload, so the refresh swaps in under the user's preserved scroll/selection with no skeleton flash.

**"Focus" means the in-app tab-activation transition** — this view's `prRef` becoming the active route, i.e. `hidden` → visible. It explicitly does **not** mean window/OS focus or document `visibilitychange`. This precision is load-bearing for §5.3: `postMarkViewed` is un-debounced (`usePrDetail.ts:66–79`), so if "focus" included window focus, every alt-tab back into the app would re-GET + re-stamp the active view, breaking the no-write-amplification claim. The same active-transition hook also fires `clearUnread(refKey)` (§2.3).

The trigger is gated so it fires on the *transition* into active (not on every render while active) and is a no-op for `readOnly` views' mutating legs already handled by `handleReload` (`PrDetailView.tsx`, the keep-alive view that replaced `PrDetailPageInner`). Whether to reuse `handleReload` (which also runs the reconcile leg) or a pure `usePrDetail.reload()` on focus is an implementation detail for the plan; the freshness requirement is the GET refetch + stamp, not necessarily the reconcile.

**Caveat — marking seen vs. preserved scroll (resolved: option a).** This "reproduces today's behavior" claim is *not* fully identical under keep-alive. Today's remount resets scroll to the top, so the user lands where new content typically is; keep-alive returns them to their *prior* scroll offset. Re-stamping `mark-viewed` on focus then clears the unread signal for comments the user may not have scrolled to. **Decision: keep the coupled stamp (option a)** — it preserves the fetch↔stamp simplicity this spec is built on. The principled alternatives (a "N new since last visit" affordance, and full viewport-based read receipts) are captured in **issue #160** for a future effort; they are explicitly out of scope here.

### 4.2 Subscriptions stay live for hidden tabs

`useActivePrUpdates` and `useStateChangedSubscriber` remain subscribed for hidden tabs. Both are `prRef`-scoped and filter correctly (`useActivePrUpdates.ts:38`, `useStateChangedSubscriber.ts:34–35`), so a hidden tab reacts only to its own PR's events. A background tab pre-loading its "PR updated — Reload" banner (`useActivePrUpdates` latched state) is a **feature**: the banner is ready the instant the user switches back. No within-window collision exists because each mounted view owns a *distinct* PR (`addTab` is idempotent on `prRefKey`, `OpenTabsContext.tsx:57–62`).

**Server-side lifecycle change (must confirm before merge).** `useActivePrUpdates`'s `DELETE /api/events/subscriptions` cleanup (`useActivePrUpdates.ts:73–81`) fires on effect teardown — which, under keep-alive, is **tab close, not navigate-away**. Today, navigating away unsubscribes immediately; under keep-alive the server holds one live subscription per open tab for the whole session. The backend routes events by cookie regardless (so correctness holds), but if it does per-subscription work (poller fan-out, snapshot retention keyed on active subscriptions), this changes its load shape. **Confirm the backend tolerates N persistent per-session subscriptions** (OQ2, §8) — this is *why* "pausing hidden subscriptions" (D2) exists as a lever even though it is deferred.

`useCrossTabPrPresence` is unchanged. Its semantics shift from "PR actively focused" to "PR open in a tab" (the channel stays open while the tab is mounted-but-hidden). This is arguably more correct, but note one cross-*window* edge: if window B opens PR X while window A holds a hidden, backgrounded view of PR X, B's `claim` flips A's hidden view to `readOnly` with no foreground banner for the user to act on. Worst case is a stale `readOnly` flag on a tab the user isn't looking at, self-correcting on next focus. Accepted as-is (OQ3, §8); revisit only if it bites.

---

## 5. Risks

### 5.1 Scroll model vs. hardened diff-scroll (resolved → shared scroller)

PRs #149/#155/#156 stabilized sticky diff bars and uniform horizontal scroll against a **desktop-viewport-bound** model in which `data-app-scroll` itself is the bounded scroller (the #156 fixture asserts exactly this). The brainstorm's per-`PrDetailView` scroll container would have moved that boundary, re-anchoring every `position: sticky` element in the diff subtree (the sticky diff bar, `.diffPaneLoadingOverlay`) to a new per-view container sitting below `PrHeader` + banners + `UnresolvedPanel` — a real regression risk. **Resolution:** the shipped design keeps the shared `data-app-scroll` scroller and saves/restores `scrollTop` per tab (§3.3), so the diff-scroll model is untouched — zero re-anchoring. The #156 regression spec remains a gate (re-run after the routing swap), and §6 adds the keep-alive-specific marker test: `data-files-active` must bind the layout only for the route-active Files view, never for an inactive tab's hidden Files view.

### 5.2 Test migration

The routing change touches `frontend/src/pages/PrDetailPage.tabbing.test.tsx`, `frontend/src/contexts/OpenTabsContext.test.tsx`, and any spec asserting sub-tab **URLs**. Sub-tab assertions move from URL (`/files`, `/drafts`) to the `role="tab"` selected state / rendered sub-tab content. Playwright specs that navigate by sub-tab URL must click the sub-tab control instead.

### 5.3 `mark-viewed` write timing

Tabs mount one at a time on user action (open), so there is no mount storm of `mark-viewed` writes. Refetch-on-focus adds one GET + one stamp per tab focus — the same volume as today's remount-on-return. No new write-amplification.

---

## 6. Testing

- **Keep-alive retention (vitest):** mount the host with N tabs; set scroll / select a file / switch sub-tab on tab A; activate tab B; reactivate tab A; assert sub-tab, selected file, and scroll survived.
- **Hidden-tab scroll retention:** assert a `hidden` view retains `scrollTop` on reactivation (or, under the §5.1 fallback, that save/restore fires).
- **Refetch-on-focus re-stamps:** assert activating a tab triggers `getPrDetail` + `postMarkViewed` with the fresh head-sha/comment-id, and clears the unread dot.
- **Close discards state:** closing a tab unmounts its view; reopening starts fresh.
- **Background banner:** a `pr-updated` SSE for a hidden tab latches its banner; switching to the tab shows it immediately.
- **Sub-tab in state (no URL):** clicking sub-tabs changes rendered content without changing the pathname.
- **Diff-scroll regression gate:** the #156 sticky/uniform-scroll fixture passes unchanged — the shared `data-app-scroll` scroller is retained, so there is no re-anchoring to regress.
- **Files marker correctness:** `data-files-active` is stamped only by the route-active view while showing Files, and removed when that view deactivates or leaves Files — so an inactive tab's hidden Files view never binds the viewport layout.
- **Hidden-view a11y isolation:** keyboard focus (Tab order) cannot reach any focusable element inside a `hidden` view, and a screen reader does not announce hidden views.
- **`clearUnread` on re-activation:** a hidden tab that latched an unread dot clears it when re-activated (not only on first mount).
- **Playwright e2e:** open PR → Files → deep-scroll a diff → go to Inbox → return → assert same sub-tab + scroll + selected file.

---

## 7. Decomposition note

This is one coherent slice but a meaty refactor (routing + host + sub-tab-in-state + shared-scroller scroll save/restore + addTab/setTitle relocation + refetch-on-focus + test migration). `writing-plans` sequenced it into three PRs:

1. **PR1** — host + routing swap (PR views leave `<Routes>`), sub-tab into component state (outlet-context → props/context), keep-alive sub-tab rendering, `useTabScrollMemory` shared-scroller save/restore + `data-files-active` marker, and the #156 diff-scroll regression gate.
2. **PR2** — refetch-on-focus + `clearUnread`-on-activation via `useActivationTransition`, with freshness tests.
3. **PR3** — test-migration hardening + Playwright e2e (open PR → Files → deep-scroll → Inbox → return → assert sub-tab + scroll + selected file).

The exact split is the plan's call; this spec defines the target state, not the sequence.

---

## 8. Open questions for the plan

Surfaced by the ce-doc-review pass. These are genuine UX/behavior decisions that don't change the chosen architecture but must be resolved during `writing-plans` (or by the user) before the relevant slice ships. Each names the default this spec assumes.

- **OQ1 — Mark-seen vs. preserved scroll (§4.1) — RESOLVED: option (a).** Re-stamping `mark-viewed` on focus clears the unread signal even when keep-alive returned the user to a scroll offset *above* the new comments. **Decision: keep the coupled stamp (a).** The "N new since last visit" affordance and full viewport read-receipts (options b/c) are deferred to **issue #160** with full mechanics, so they can be picked up seamlessly later.
- **OQ2 — Backend tolerance of N persistent subscriptions (§4.2).** Confirm the server is fine holding one live `/api/events/subscriptions` per open tab for a session (DELETE now fires on close, not navigate-away). If not, the pause-hidden-subscriptions deferral (#161) moves from deferred into scope.
- **OQ3 — Cross-window `readOnly` on a hidden view (§4.2).** Accept the stale-`readOnly`-on-background-view edge, or gate presence on foreground rather than mounted.
- **OQ4 — Content-shift / scroll-anchor on refetch (§4.1).** When a focus-refetch adds/removes comments, the preserved `scrollTop` lands on different content. Default: accept the shift (local refetch is fast); alternative: anchor to a stable element (e.g. topmost visible comment id) across the swap.
- **OQ5 — Stale selected-file after refetch (§3.2).** If the preserved Files-tab selection no longer exists post-refetch (force-push), fall back to first file / empty placeholder. Default: empty placeholder with a message.
- **OQ6 — Refetch-on-focus failure UX (§4.1).** On a failed focus GET, default to a non-destructive toast ("Couldn't refresh — showing last known data") that keeps the preserved view intact, rather than an error state that destroys scroll.
- **OQ7 — Close-tab with a dirty composer (§2.3).** Composer text auto-saves to drafts via `useComposerAutoSave`, so close generally doesn't lose typed content; confirm that covers the open-but-unsaved case, or add a guard. Default: rely on existing auto-save.
- **OQ8 — Banner vs. focus-refetch ordering (§4.2).** When a pre-loaded "PR updated" banner exists and focus-refetch fires on activation, the focus refetch should clear the latched banner (it already fetched fresh data) rather than leave a redundant Reload affordance.

---

## 9. Deferred work

Tracked per the `.ai/docs/documentation-maintenance.md` deferred-work convention (GitHub issue = system of record; this section is the in-spec pointer).

- **[Defer] Keep-alive resource/scope hardening** — [#161](https://github.com/prpande/PRism/issues/161). LRU cap on mounted views, pausing hidden-tab SSE subscriptions, and Inbox keep-alive (§1.5). Revisit: high tab counts / Inbox-state request / OQ2 backend finding.
- **[Defer] Read receipts + "N new since last visit" affordance** — [#160](https://github.com/prpande/PRism/issues/160). The principled alternatives to OQ1's option (a). Revisit: when accurate "seen" tracking under preserved scroll is wanted.
- **[Skip] Deep-linking / browser back-forward through sub-tabs** — sub-tab leaves the URL entirely (§1.6); permanent, enables keep-alive. Reversal would re-couple sub-tabs to the URL and fight the design — not planned.
- **[Skip] Cross-window `readOnly` on a hidden view** — accepted as-is (§4.2 / OQ3): worst case is a stale `readOnly` flag on a backgrounded tab, self-correcting on next focus. Revisit only if it bites.
