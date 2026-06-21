# Inbox view-state preservation (keep-alive)

**Date**: 2026-06-22.
**Status**: Draft — T2 spec for [#563](https://github.com/prpande/PRism/issues/563). Hands-off per `.ai/docs/issue-resolution-workflow.md`.
**Source authorities**:

- [`docs/specs/2026-06-04-pr-tab-state-keepalive-design.md`](2026-06-04-pr-tab-state-keepalive-design.md) — the parent slice that introduced the keep-alive pattern (`PrTabHost` + `PrDetailView` + `useTabScrollMemory`). This spec is its deferred **Inbox keep-alive** item (parent §1.5 / §9), tracked under [#161](https://github.com/prpande/PRism/issues/161).
- `frontend/src/App.tsx` — the `<Routes location={backgroundLocation}>` table that today renders `<InboxPage/>` at `/` and unmounts it on navigate-away. This spec moves the Inbox out of the route table into a persistent host.
- `frontend/src/components/PrDetail/PrTabHost.tsx` — the existing persistent host this spec mirrors.
- `frontend/src/hooks/useTabScrollMemory.ts` — the generic per-key save/restore against the shared `[data-app-scroll]` scroller; reused here with an Inbox sentinel key.
- `frontend/src/hooks/useEffectiveLocation.ts` — resolves the _effective_ app path (collapses Settings/Help/Feedback modal URLs to their background), already consumed by `PrTabHost`/`PrTabStrip`.
- `frontend/src/pages/InboxPage.tsx` — the Inbox view, near-unchanged by this slice (gains only an `active` prop, §1.5); its existing `useState` (filter, sort, onboarding-dismissed) and descendants' state (`ActivityRail`'s `showBots`) are what keep-alive preserves.
- [`.ai/docs/frontend-conventions.md`](../../.ai/docs/frontend-conventions.md), [`.ai/docs/documentation-maintenance.md`](../../.ai/docs/documentation-maintenance.md).

---

## 1. Goal and scope

### 1.1 Goal

When a user scrolls the Inbox, applies a filter/sort, or expands a row/section, then opens a PR detail (or a Settings/Help/Feedback modal) and returns to the Inbox, the Inbox must restore to **exactly the state they left** — scroll offset, active filter and sort, expanded sections, and the activity rail's expand-bots toggle. Today, returning **remounts `InboxPage` fresh**, resetting all of it.

### 1.2 The mechanism being fixed

`App.tsx`'s `<Routes>` renders one route element at a time. Leaving `/` (to a PR, or via the catch-all) **fully unmounts `InboxPage`**; returning **remounts it fresh**, destroying all React/DOM/scroll state. This is the same unmount-on-navigate mechanism the parent slice fixed for PR-detail tabs; this slice simply applies that fix to the Inbox.

### 1.3 Chosen approach — keep-alive (Model B), consistent with the parent slice

The parent spec weighed **Model A (snapshot & restore)** vs **Model B (keep-alive)** and chose B: keep the view mounted, render it `hidden` instead of unmounting, so all React/DOM/scroll state is preserved natively with zero per-component wiring. This spec does **not** re-litigate that choice — it reuses Model B for consistency and for the same decisive reason: the Inbox accumulates stateful descendants (filters, rail, future widgets) and Model A would put each on a silent save/restore treadmill. Snapshot/restore and router-only scroll-restoration are rejected here for the identical reasons given in the parent spec §1.3 (the latter also can't preserve filter/expansion React state).

### 1.4 In scope

1. A persistent **`InboxHost`** (sibling to `<Routes>`, mirroring `PrTabHost`) that renders one mounted `InboxPage`, visible only when the effective path is `/` (§2).
2. Routing change: the `/` route element becomes `null` when authed; the host renders the Inbox (§2.1).
3. **Lazy mount**: `InboxPage` mounts on first visit to `/`, then stays alive — a cold deep-link straight to `/pr/...` does not trigger the Inbox + activity fetches (§2.3).
4. **Scroll save/restore** for the Inbox on the shared `[data-app-scroll]` scroller via `useTabScrollMemory` with an Inbox sentinel key (§3).
5. Tests + Playwright e2e (§5).

### 1.5 Out of scope / unchanged

- **`InboxPage` is near-unchanged.** Filter/sort/onboarding/rail state are already React state; staying mounted preserves them for free. No `useParams` threading (the Inbox has no route params), so none of the child-prop surgery the PR-detail slice needed applies. The only addition is a single `active` prop (mirroring `PrDetailView`'s `active`), used for two things: (a) gating the page's `Modal`-based dialogs (`AiOnboardingDialog`, the load-error `ErrorModal`) so a hidden-but-mounted Inbox does not leak document-level keydown handlers (§4), and (b) driving the refetch-on-activation below. Everything else in `InboxPage` is untouched.
- **Refetch on activation (revised — see note).** When the host re-shows the Inbox (`active` false→true), `InboxPage` fires `useInbox().reload()` via `useActivationTransition`, mirroring PR-detail's §4.1. `useActivationTransition` never fires on first mount (`useInbox`'s own mount fetch covers the cold load) and is a no-op for direct callers where `active` is the default-true constant — so there is exactly one GET on a cold load and one GET per return-to-Inbox, identical to the old remount-on-return volume.

  > **Revised during implementation.** The first cut omitted this, reasoning that the Inbox self-refreshes via `useInboxUpdates` (the app-wide `useEventSource()` stream reloads on every `inbox-updated` frame). That is true for _inbox-snapshot_ changes, but **not** for per-PR freshness that doesn't rebuild the inbox snapshot — notably a row's unread bar clearing after `mark-viewed` (#285), which does not emit an `inbox-updated` frame. The old remount-on-return re-issued `GET /api/inbox` and re-projected that stamp; keep-alive removed the remount, so without an activation refetch the unread bar (and similar non-snapshot freshness) goes stale on return. The `inbox-unread-reset` e2e (#285) caught exactly this. The activation refetch restores the old freshness without remounting. The content-shift-under-preserved-scroll consequence is the same accepted tradeoff as §3 / parent OQ4.

- **No new server subscription.** `useInboxUpdates` registers a listener on the shared stream — it does **not** open or `DELETE` a per-view `/api/events/subscriptions` (contrast PR-detail's `useActivePrUpdates`, the parent's OQ2). So keeping the Inbox mounted adds **zero** server-side subscription load. The only steady-state cost of a hidden-but-mounted Inbox is that it continues to service background `inbox-updated` reloads while a PR is in view — bounded, debounced, and arguably beneficial (instant-fresh on return).
- **Persistence across full reload is not required** (#563 asks only for in-session back-nav). A hard reload / app restart still cold-loads the Inbox.

---

## 2. Architecture — persistent Inbox host

### 2.1 Routing change

In `App.tsx`'s `<Routes location={backgroundLocation}>`, the `/` element stops rendering the page and becomes a thin auth gate (mirroring the `/pr/...` route the parent slice already null'd):

```diff
- <Route path="/" element={isAuthed ? <InboxPage /> : <Navigate to={unauthedTarget} replace />} />
+ {/* Inbox leaves the route table: a persistent InboxHost (below, sibling to
+     PrTabHost) renders one keep-alive InboxPage and shows it only on `/`, so
+     the Inbox survives navigating to a PR / opening a modal and back with its
+     scroll + filter + expansion state intact. The route stays as a null auth
+     gate so the catch-all doesn't redirect a valid `/` and unauthed users are
+     still bounced to setup/welcome. */}
+ <Route path="/" element={isAuthed ? null : <Navigate to={unauthedTarget} replace />} />
```

and the host mounts beside `PrTabHost`:

```diff
  {isAuthed && <PrTabHost />}
+ {isAuthed && <InboxHost />}
```

`InboxHost` is gated on `isAuthed` at the call site (same as `PrTabHost`), so it never mounts for unauthed/first-run sessions.

### 2.2 `InboxHost` responsibilities

A new component (`frontend/src/components/Inbox/InboxHost.tsx`), always mounted while authed, that:

1. **Reads `useEffectiveLocation()`** and computes `onInbox = pathname === '/'`. Using the _effective_ path (not the raw `useLocation`) means an open Settings/Help/Feedback modal — whose live URL is `/settings/*` etc. but whose background is the Inbox — keeps the Inbox visible behind the scrim, matching how `PrTabHost`/`PrTabStrip` already behave. When the modal's background is a PR, the effective path is the PR route and the Inbox is hidden.
2. **Registers Inbox scroll memory** via `useTabScrollMemory({ prRefKey: INBOX_SCROLL_KEY, subTab: '', active: onInbox })` (§3). Called unconditionally, above any early return (Rules of Hooks).
3. **Lazily mounts then keeps alive** (§2.3): renders `<InboxPage active={onInbox}/>` wrapped in a host element with `hidden={!onInbox}` once the Inbox has been visited; returns `null` before first visit. The `active` prop gates the page's dialogs (§4) — `display:none` alone does not, because `Modal` registers its Escape/Tab handlers on `document` keyed on `open`, not on CSS visibility.

```
export function InboxHost() {
  const { pathname } = useEffectiveLocation();
  const onInbox = pathname === '/';
  const [mounted, setMounted] = useState(onInbox);   // mount eagerly iff first paint is the Inbox
  useEffect(() => { if (onInbox) setMounted(true); }, [onInbox]);
  useTabScrollMemory({ prRefKey: INBOX_SCROLL_KEY, subTab: '', active: onInbox });
  if (!mounted) return null;
  return (
    <div hidden={!onInbox} data-inbox-host>
      <InboxPage active={onInbox} />
    </div>
  );
}
```

`INBOX_SCROLL_KEY` is a module constant (e.g. `'__inbox__'`) chosen to never collide with a `prRefKey` (which is always `owner/repo/number`). It shares `useTabScrollMemory`'s module-level store with the PR views, which is exactly what makes the single shared scroller hand off cleanly between Inbox and PR (§3).

### 2.3 Lazy mount

`useState(onInbox)` mounts `InboxPage` on the first render **iff** that render is already on the Inbox (the common case: `/` is the default route). On a cold deep-link to `/pr/...`, `onInbox` is false, so `mounted` starts false and `InboxPage` — with its `useInbox` + hoisted `useActivity` fetches — does not mount until the user first navigates to `/`. The `useEffect` flips `mounted` true on that first visit and it never flips back, so from then on the Inbox is keep-alive (`hidden` toggled, never unmounted). This protects the cold-start path hardened by #282/#507: a PR deep-link's first paint stays Inbox-fetch-free.

A cold deep-link to `/settings/*` (no `backgroundLocation`) is **not** protected the same way — `useEffectiveLocation` resolves it to the synthetic Inbox (`/`), so `onInbox` is true and the Inbox mounts eagerly behind the Settings scrim. This is unchanged from today: the current `<Routes location={backgroundLocation}>` already renders `<InboxPage/>` as the `/` background for a cold Settings deep-link, so the Inbox fetch already fires on that path. Keep-alive moves _where_ the Inbox is rendered, not _whether_ it mounts for a Settings background — no cold-start regression relative to current behavior.

### 2.4 Accessibility

The host's `hidden` attribute (`display:none`) removes the Inbox from both the tab order and the accessibility tree in Chromium/Electron while a PR is in view — the same contract the parent slice relies on for hidden PR views (parent §2.2). The Inbox's `sr-only` live regions (`inbox-refresh-status`, `inbox-autorefresh-status`) are inside that subtree, so a hidden Inbox does not announce background auto-refreshes over a PR. §5 asserts the hidden-Inbox a11y isolation.

**Focus on re-show is intentionally not managed here.** When the Inbox re-shows (`onInbox` flips true), this slice does **not** force focus into the Inbox. This matches the shipped keep-alive pattern exactly — `PrDetailView` likewise does not move focus when a hidden PR view re-activates — so the Inbox stays consistent with it rather than introducing one-off behavior. In practice the user returns via a chrome control (the `PrTabStrip` Inbox tab, the header, a "back" affordance) that lives outside the hidden subtree, so focus is on that control, not stranded. A holistic focus/restore pass across _all_ keep-alive surfaces (PR views and Inbox together) is the right place to add re-show focus management; it is deferred (§6) rather than bolted onto the Inbox alone.

---

## 3. Scroll retention — shared scroller + sentinel-keyed save/restore

The Inbox shares the single outer `[data-app-scroll]` scroller with every PR view (it always has — `InboxPage`'s `<main>` lives inside `data-app-scroll`). `useTabScrollMemory` already saves the deactivating view's `scrollTop` in its `useLayoutEffect` **cleanup** and restores the activating view's in **setup**; React runs all cleanups before any setups in a commit, so within the navigate Inbox↔PR commit the Inbox persists its offset before the PR view restores its own (and vice-versa) — no cross-view race, regardless of host order. Adding the Inbox as one more participant keyed by `INBOX_SCROLL_KEY|''` requires **no change to the hook** — only a new caller. The Inbox carries no diff-scroll viewport-binding (`data-files-active`), so none of the parent slice's §3.3 Files-marker complexity applies here.

**Accepted tradeoff — pixel restore, not semantic anchor.** The offset is saved (in the hook's cleanup) at the moment the user navigates away, then restored as a raw `scrollTop` on return. Background `inbox-updated` reloads can change the list while the Inbox is hidden (a PR resolves, a new one arrives, sections reorder), so the restored pixel offset may map to a _different row_ than the user left on, and an offset past a now-shorter list is silently clamped by the browser to its bottom. This is the **same content-shift-under-preserved-scroll tradeoff the parent slice already accepted** (parent §4.1 / OQ4: "accept the shift — local refetch is fast"), and pixel-restore is strictly better than today's reset-to-top. A semantic anchor (save the topmost-visible PR key, scroll to that element on return) is the principled alternative but is out of scope for this slice — it would belong in the same future effort as the parent's read-receipts work (#160). This slice accepts pixel restore.

---

## 4. Edge cases

- **Onboarding overlay + dialog handler leak (`AiOnboardingDialog`).** The dialog renders _inside_ `InboxPage` via `Modal`, which renders inline (no `createPortal`), so `display:none` on the host hides it **visually**. But `Modal` registers its Escape-dismiss and Tab focus-trap as **`document`-level `keydown` listeners** in a `useEffect` keyed on `open` (`Modal.tsx:70–101`) — _not_ on CSS visibility. `display:none` neither unmounts the dialog nor changes `open`, so those handlers stay live: a first-run user who opens a PR with the onboarding dialog still open would have Escape (silently firing the invisible dialog's `onClose`) and Tab (trapping into invisible controls) hijacked while viewing the PR. **Fix:** gate the dialog on the host's visibility, not just `display:none` — `InboxPage` takes an `active` prop (§2.2) and computes `showOnboarding = active && !onboardingDismissed && …`. When the host hides, `showOnboarding` goes false, `AiOnboardingDialog` unmounts, and `Modal`'s effect cleanup removes the document listeners. This mirrors how `PrDetailView` gates its `ErrorModal` `open` on `active`. The same gating applies to the load-error `ErrorModal` below.
- **Error / loading early-returns.** `InboxPage` early-returns the skeleton (cold load), an `ErrorModal`, or `null` (`!data`). All are fine inside the kept-alive wrapper; once data resolves it persists for the view's life. The cold-load skeleton shows once, on first mount. The load-error `ErrorModal`'s `open` is gated on `active` (same reason as the onboarding dialog) so a hidden, errored Inbox doesn't hold document keydown handlers.
- **Restored scroll past a shrunken list.** If background reloads removed enough items that the saved `scrollTop` now exceeds the new `scrollHeight − clientHeight`, the browser clamps the assignment silently — the user lands at the bottom of the shorter list. No special handling: this is acceptable and `useTabScrollMemory`'s raw `scrollTop` write already relies on the browser's clamp.
- **Preserved filter that now matches nothing.** Filter state is preserved by design (§1.4), so a filter that matched items at navigate-away can match zero after a background reload removes them — the user returns to the existing `NoFilterMatches` empty state. This is acceptable and already handled: `NoFilterMatches` renders a clear-filter CTA (`onClear`). The slice deliberately does **not** auto-clear the filter on return — silently dropping a user's filter is a worse surprise than showing the empty state with an explicit clear affordance.
- **Modal backgrounds.** Covered by §2.2 item 1 via `useEffectiveLocation` (an open Settings/Help/Feedback modal whose background is the Inbox keeps `onInbox` true, so the Inbox stays visible behind the scrim — unchanged from today's `backgroundLocation` chrome model).

---

## 5. Testing

- **Keep-alive retention (vitest):** render `InboxHost` on `/`; set filter state / scroll the shared scroller / toggle the rail's show-bots; navigate to a `/pr/...` route (host hides, `InboxPage` not unmounted); navigate back to `/`; assert filter, scroll offset, and rail toggle survived — and that `InboxPage` was **not** remounted (e.g. a mount spy / a persisted ref).
- **Lazy mount:** render `InboxHost` first on `/pr/...`; assert `InboxPage` (and its `useInbox` fetch) does **not** mount; navigate to `/`; assert it mounts exactly once and stays mounted on a subsequent navigate-away.
- **Hidden-Inbox a11y isolation:** with the host `hidden` (off `/`), keyboard Tab order cannot reach Inbox controls and the Inbox `sr-only` live regions are not announced.
- **Hidden dialog does not capture keys:** with the onboarding dialog open on `/`, navigate to a `/pr/...` route; assert the dialog has unmounted (`active=false` → `showOnboarding=false`) so a document `keydown`/Escape is **not** consumed by the Inbox dialog while the PR is in view. Guards the `Modal` document-listener leak (§4).
- **Scroll handoff:** assert the Inbox offset is restored on return after a PR view drove the shared scroller (reuses the `useTabScrollMemory` store).
- **Refetch on activation:** flipping `active` false→true fires `useInbox().reload()` exactly once; first mount (already active) does **not** (no double-fetch on cold load). End-to-end, the `inbox-unread-reset` (#285) e2e asserts a row's unread bar clears on return from the PR — the regression guard for this decision.
- **Routing gate:** unauthed `/` still redirects to `unauthedTarget`; authed `/` renders the host (null route element doesn't break the catch-all or modal backgrounds). Existing tests that assert `InboxPage` renders on `/` (e.g. `App.test.tsx`) must mount `InboxHost` in their App tree, since the page no longer comes from the `/` route element.
- **Playwright e2e (desktop shell):** on the Inbox, scroll down + apply a filter → open a PR → return to Inbox → assert the same scroll offset and active filter (no reset to default). Runs in the desktop-shell run mode, where `[data-app-scroll]` is the bounded scroller that actually carries the offset (`tokens.css` sets its `overflow-y` only under `[data-shell="desktop"]`) — the same scroller the parent slice's scroll model depends on.

---

## 6. Deferred / coordination

- **Pausing hidden-Inbox background refresh (coordinate with [#161](https://github.com/prpande/PRism/issues/161)).** A hidden-but-mounted Inbox keeps servicing debounced `inbox-updated` reloads. This is cheap (no server subscription; the GET already fires today while the Inbox is foregrounded) and beneficial (fresh on return), so it is **left live** — consistent with the parent slice's "subscriptions stay live for hidden tabs" stance. Pausing is a perf lever for later, tracked under #161 alongside the parent's deferred SSE-pause lever; keeping the Inbox mounted adds one more always-live consumer to weigh there.
- **Re-show focus management across all keep-alive surfaces (deferred → [#161](https://github.com/prpande/PRism/issues/161)).** Neither this slice nor the shipped `PrDetailView` moves focus when a hidden view re-activates (§2.4). If a holistic focus-on-re-show / focus-restore behavior is wanted for keyboard users, it should be designed once across PR views _and_ the Inbox together so they stay consistent, not bolted onto the Inbox alone. Out of scope here.
- **No mount cap.** Unlike PR-detail (N tabs), there is exactly **one** Inbox, so the parent's deferred LRU-cap-on-mounted-views concern does not apply to this slice.
