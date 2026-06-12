# Eliminate manual-reload banners where non-destructive

- **Issue:** [#450](https://github.com/prpande/PRism/issues/450)
- **Date:** 2026-06-12
- **Status:** Design — pending implementation
- **Surfaces:** PR detail (Files/Overview comment threads), Inbox

## 1. Problem

The app shows a "Reload" banner whenever new data is available, on both the
inbox and PR-detail surfaces, requiring a manual click to refresh. For
non-destructive cases this is unnecessary friction, and in one case it is an
outright functional gap.

Two related fixes:

1. **PR detail (functional bug):** After posting a single inline comment or
   reply, the comment renders instantly (optimistic placeholder) but the new
   thread is **not reply-able** until the user manually reloads.
2. **Inbox (friction):** The inbox reload banner gates a refresh that is
   entirely non-destructive, so it can auto-apply.

### Governing principle

The dividing line is **not** "destructive vs non-destructive" — the accepted
inbox row-shift (§3.3) is non-destructive yet disruptive and still ships auto.
The actual rule is: **auto-apply when no in-flight user work (unsaved drafts,
line-anchored selections, an open composer) can be invalidated; require explicit
consent otherwise.** Each decision in this doc satisfies that one rule:

- **Inbox refresh** — no in-flight work is at risk (filter/sort/expand are view
  state that survives a data swap) → auto.
- **Comment-post reload** — the user's own, just-completed action; the open
  composer has already closed on post → auto.
- **Head-SHA / new-iteration** — re-anchors the diff and strands line-anchored
  drafts into reconciliation → **consent (banner kept).**

### Non-goal (kept by design)

The PR-detail banner for **head-SHA / new-iteration** changes is retained, per
the governing principle above. This issue does **not** remove that banner.

## 2. Part 1 — PR detail: posted comment becomes reply-able without reload

### 2.1 Root cause

Posting a single inline comment (post-now) creating a new review thread:

- The frontend renders an optimistic placeholder with `threadId: null`
  (`FilesTab.tsx` `onPosted`) — a plain `CommentCard` with no reply affordance.
- The real, reply-able thread lives in `prDetail.reviewComments`, which only
  refreshes via `usePrDetail.reload()`.
- The endpoint (`PrCommentEndpoints.Publish`) publishes `StateChanged` (→ only
  `draftSession.refetch()`, not a detail reload) and `SingleCommentPostedBusEvent`,
  which is wired to **nothing**: `PrDetailLoader.cs:96` explicitly does NOT
  subscribe to it, and `SseEventProjection` has no case for it.

The analogous **root-comment** path works because it publishes
`RootCommentPostedBusEvent`, wired to BOTH an SSE reload trigger
(`useRootCommentPostedSubscriber → reload()`) AND `PrDetailLoader.Invalidate`
(#353). The single-comment event was left inert in #353 with the stated reason:

> "NOT subscribed to SingleCommentPostedBusEvent (diff post-now): that path has
> no immediate client reload trigger, so eviction there is inert and would open
> a /file & /viewed 422 window on the active diff tab."

The fix adds the reload trigger **and** the eviction together, which dissolves
that objection — eviction is now immediately followed by a reload that
re-populates the snapshot, identical to the root-comment case that already ships.

### 2.2 Fix — mirror the #353 / #392 pattern (Approach A)

Three isolated units:

**Unit 1.1 — SSE projection (backend).**
`SseEventProjection.Project` gains a case:
`SingleCommentPostedBusEvent e => ("single-comment-posted", new SingleCommentPostedWire(e.PrRef.ToString(), e.ReviewCommentId))`.
`SseChannel` subscribes `bus.Subscribe<SingleCommentPostedBusEvent>(OnSingleCommentPosted)` and fans out per-PR, mirroring `OnRootCommentPosted`.

- *Depends on:* `IReviewEventBus`, the existing `FanoutProjected` helper.
- *Interface:* publishes a `single-comment-posted` named SSE frame to the
  posting PR's subscribers.

**Unit 1.2 — Loader invalidation (backend).**
`PrDetailLoader` subscribes `SingleCommentPostedBusEvent → Invalidate(prRef)`,
unconditional (the event fires only on an actual post, so no quiet-event
suppression is needed — same as `OnRootCommentPosted` / `OnDraftSubmitted`). The
`NOT subscribed` carve-out comment at `PrDetailLoader.cs:96` is replaced with the
subscription. This is byte-for-byte the root-comment pattern.

**Decision (RESOLVED): `Invalidate`, not `RefreshAsync`.** Two constraints were
weighed — "the reload must not change the user's view" and "performance is a
major concern" — against the verified fact that `ReviewEventBus.Publish` is
**synchronous** (`ReviewEventBus.cs`: handlers are `Action<TEvent>`, invoked
inline) and is called *inside* the comment-POST before it returns
(`PrCommentEndpoints.PostInlineAsync`). Consequences:

- `RefreshAsync` would run a full GitHub re-fetch **on the POST thread**, so the
  user's "Comment" click hangs until it completes (most-visible-possible lag, and
  sync-over-async on a request thread). Pushing it to a background `Task` instead
  races the reload GET (the SSE fires in the same synchronous loop) and can
  intermittently re-serve a stale snapshot — reintroducing #353 flakily.
- A hybrid (`Invalidate` + background `RefreshAsync`) does **not** help: the
  snapshot is null from `Invalidate` until the background re-fetch overwrites it,
  so the 422 window is unchanged (its length is the fetch, not the trigger); it
  only starts repopulation ~one round-trip earlier — negligible on a local-first
  tool — while adding a double-fetch race against the reload GET's `LoadAsync`.

`Invalidate` is an instant in-process dictionary removal: zero cost on the POST
thread (fast post), and the expensive re-fetch lands on the **reload GET**, which
is off the user's critical path and visually bridged by the optimistic
placeholder + keep-alive. The eviction always completes before the reload GET
arrives (in-process removal beats a network round-trip), exactly as the
root-comment path ships today.

- *Depends on:* `IReviewEventBus`, existing `Invalidate`.
- *Interface:* the PR's snapshot is evicted on post, so the next detail GET
  re-fetches fresh `reviewComments` (containing the new thread).

**Unit 1.3 — Frontend reload trigger.**
- `events.ts`: add `single-comment-posted` to `EventPayloadByType`, `EVENT_TYPES`,
  and a `SingleCommentPostedEvent` payload type (mirror `RootCommentPostedEvent`).
- New hook `useSingleCommentPostedSubscriber({ prRef, onPosted })`, a near-copy
  of `useRootCommentPostedSubscriber`, filtering by `prRef`.
- `PrDetailView` wires `useSingleCommentPostedSubscriber({ prRef, onPosted: reload })`
  next to the root-comment subscriber.

- *Depends on:* `useEventSource`, `usePrDetail.reload`.
- *Interface:* on a `single-comment-posted` frame for this PR, the detail
  re-GETs; the new thread surfaces with its real `parentThreadId` + `ReplyComposer`,
  and the optimistic placeholder de-dupes away by `databaseId` as it does today.

### 2.3 Behavior notes

- **Own-tab + cross-tab:** the posting tab and any other tab viewing the same PR
  both receive the SSE frame and reload. This matches the root-comment behavior.
  A *passive* tab (viewing the same PR's diff but not the poster) is exposed to
  the same brief snapshot window as the posting tab; the same graceful 422
  handling below covers it.
- **Optimistic placeholder:** unchanged. The reload lands the real comment; the
  existing `databaseId === postedCommentId` cleanup drops the placeholder. The
  placeholder bridges the visual gap during the reload round-trip (no flash).
- **422 window — accepted, bounded, graceful.** While the snapshot is evicted
  (from `Invalidate` until the reload GET re-populates it), `/file` (whole-file
  expand) and `/viewed` (mark-file-viewed) read `TryGetCachedSnapshot == null`
  and return 422. The client already degrades gracefully: `/viewed` silently
  rolls the checkbox back (`FilesTab.tsx:208`), `/file` shows the whole-file
  failure banner — both retryable by clicking again. This is the asymmetry #353
  cited (root-comment posts on Overview don't exercise these endpoints; inline
  posts on the diff tab do), so it is a real cost — but a minor one: the window
  is sub-second, and right after posting the user's focus is on replying to the
  thread they just created, not toggling viewed-state on other files. Accepted
  for v1. *Back-pocket mitigation if it ever bites:* defer the two requests
  on the frontend during the post→reload window (no extra backend fetch); not
  built now.
- **Diff content** comes from `/diff` (`useFileDiff`), not the snapshot, so the
  diff pane itself is unaffected by snapshot state either way.
- **View-state preservation — a HARD requirement (owner constraint).** The
  auto-reload must not change the user's view in any way. This is guaranteed by
  keep-alive: `usePrDetail.reload()` keeps `data` present (no skeleton, #180),
  so `FilesTab` is **not** unmounted, and
  every piece of view state below is local component state / DOM, not derived
  from `prDetail`, so the data swap leaves it untouched:
  - **scroll offset** (`useTabScrollMemory` — only re-fires on tab switch, not a data swap)
  - **selected file** (`selectedPath`); the diff file-set is unchanged by a
    comment post, so the auto-select-first-file effect cannot reselect
  - **viewed checkmarks** (`viewedPaths`)
  - **diff mode / line-wrap / whole-file toggle / iteration range**
  - **any open composer** (also closed by the post path before reload, so focus
    is not inside the de-duped placeholder — no drop to `<body>`, WCAG 2.4.3)

  The new thread's height was already added by the optimistic placeholder at post
  time, so swapping placeholder→real adds no further shift — no scroll jump even
  for a comment above the viewport. Every item above is locked by an explicit
  test (§4); a regression fails the build.

## 3. Part 2 — Inbox: auto-refresh, remove the banner

### 3.1 Rationale

An inbox reload risks no in-flight user work (governing principle, §1): filter
input (`InboxPage` `filterState`), sort (`InboxToolbar`), section expand/collapse
(`InboxSection`, keyed by `s.id`), and scroll position all live in component
state and survive a `data` swap from `useInbox.reload()`. The filtered view
re-evaluates automatically — `FilterBar` recomputes its result from the new
`sections`. So the manual gate buys nothing on the "don't lose my work" axis.

**Awareness vs gate — what we intentionally give up.** The banner also carried
an *awareness* payload: `newOrUpdatedPrCount` rendered as "N new updates". Silent
auto-refresh drops that count. We accept this: the per-PR unread marker
(head-SHA `data-unread` on the row) carries post-refresh awareness for the
common case, and §3.2 adds an `aria-live` announcement for assistive tech. The
known gap — the row marker does not represent comment-only updates, so a
comment-driven re-sort has no per-row cue — is accepted for v1 (the alternative,
a transient "N updated" snackbar, reintroduces the chrome this issue removes).

### 3.2 Fix

**Unit 2.1 — Auto-refresh on `inbox-updated`.**
Reframe `useInboxUpdates` from a latch (`hasUpdate` / `summary` / `dismiss`)
into a debounced reload trigger:

- The hook accepts an `onUpdate` callback and **owns** the debounce timer; it
  invokes `onUpdate` (wired to `useInbox.reload`) — the caller does not manage
  timing.
- On each `inbox-updated` frame, schedule a **trailing debounce** (~500ms, a
  tunable starting value) so a burst coalesces into one re-GET. *Why debounce
  here but not on the PR-detail subscribers:* `inbox-updated` fans out once per
  changed PR, so a single poll cycle can emit N frames; `root-comment-posted` /
  `single-comment-posted` are single discrete user actions. The burst is real
  for the inbox and absent for PR detail — hence the asymmetry in mechanism.
- **In-flight coalescing — queue, don't skip.** `useInbox.reload` already has a
  generation guard (`useInbox.ts`, #330) that prevents concurrent-`setData`
  races, so race-safety is *not* this guard's job. Its job is to not drop the
  trailing update: if a frame lands while a reload GET is in flight, set a
  pending flag and fire exactly one more reload when the GET resolves. A plain
  "skip" would silently lose that last update and leave the inbox stale until an
  unrelated event — defeating the coalescing property.
- **Failure handling:** an auto-refresh GET error is swallowed (keep current
  data, no banner, no toast) — identical to today's "missed update → stale until
  next event". The manual Refresh button remains the explicit recovery path.
- **Announcement:** on each *completed* coalesced refresh (not per frame),
  announce via a visually-hidden `aria-live="polite"` region so screen-reader
  users get the signal the removed banner (`role="status"`) used to provide. The
  inbox already has an sr-only status region (`InboxPage.tsx`,
  `data-testid="inbox-refresh-status"`) used by manual refresh — reuse it.

**Unit 2.2 — Remove the banner.**
- Remove the `InboxBanner` render from `InboxPage`.
- Delete the `InboxBanner` component, its CSS module, and `__tests__/InboxBanner.test.tsx`.
- **Do NOT touch `e2e/no-layout-shift-on-banner.spec.ts`** — it guards the
  PR-detail `BannerRefresh` (`data-testid="reload-banner"`, driven by
  `pr-updated`), which §1 retains. It has nothing to do with the inbox banner.
  (Earlier draft wrongly listed it for deletion.)

**Unit 2.3 — Update `useInboxRefresh` wiring + keep manual Refresh.**
The `#311` manual Refresh button in `InboxToolbar` is retained as the explicit
"refresh now" affordance and keeps its own loading / checkmark state. Auto-refresh
calls `reload()` **without** touching `useInboxRefresh` state, so the toolbar
button does not visually fire on an auto-refresh. Note `useInboxRefresh` is **not
unchanged**: it currently takes a required `dismiss` prop (= `updates.dismiss`)
and `InboxPage`'s `onReload` calls `updates.dismiss()`. With the latch gone,
the `dismiss` prop and the `onReload` helper are removed.

### 3.3 Known tradeoff (accepted)

Auto-reloading can shift a row's position (re-sort / section change) the instant
an update lands, including under the cursor. **No data is lost.** Decision: ship
plain auto-refresh first; add a mitigation (freeze-while-hovering or top-only
apply) only if it proves annoying in practice.

## 4. Testing strategy

### Backend (PRism.Web.Tests / PRism.Core.Tests)

- `SseEventProjectionSubmitEventsTests`: assert `SingleCommentPostedBusEvent`
  projects to `single-comment-posted` with the right wire shape (mirror the
  existing `RootCommentPostedBusEvent` test).
- `StateChangedSseTests`: the `Unhandled_event_type_throws` test currently uses
  `SingleCommentPostedBusEvent` as the example of an unprojected event (asserts
  `Project` throws `ArgumentOutOfRangeException`). Adding the projection arm makes
  that assertion fail — **swap it to a still-unprojected `IReviewEvent`** (or a
  test-only one) so the default-arm coverage survives, rather than just deleting
  the assertion.
- `PrDetailLoaderTests`: add `LoadAsync_evicts_snapshot_after_SingleCommentPostedBusEvent`
  and a `for_other_prRef_does_not_evict` sibling (mirror the root-comment tests).
- `PrCommentEndpointTests`: already asserts the event is published — keep.

### Frontend (vitest)

- `useSingleCommentPostedSubscriber` unit test: fires `onPosted` only for a
  matching `prRef`; ignores other PRs (mirror `useRootCommentPostedSubscriber`
  coverage if present, else add).
- `PrDetailView` integration: a `single-comment-posted` frame triggers
  `usePrDetail.reload()`.
- **View-state preservation across auto-reload (owner constraint, §2.3):** with
  `FilesTab` on a selected non-first file, scrolled, with a viewed checkmark set,
  diff mode toggled to unified, and whole-file on — fire a `single-comment-posted`
  reload and assert each of `selectedPath`, scroll offset, `viewedPaths`, diff
  mode, and whole-file are unchanged afterward, and the new thread is present.
- `useInboxUpdates`: an `inbox-updated` frame triggers the debounced `onUpdate`;
  a burst coalesces to one call; an in-flight reload is not stacked.
- Remove `InboxBanner.test.tsx`; update `InboxPage` tests that asserted the
  banner to assert auto-refresh instead.

### e2e (Playwright)

- **Keep** `no-layout-shift-on-banner.spec.ts` (it guards the retained PR-detail
  `BannerRefresh`, not the inbox banner).
- Existing single-comment specs (`pr-detail-single-comment.spec.ts`) extended or
  verified: after posting, the thread exposes a reply composer without a manual
  reload, and the diff scroll position is preserved across the auto-reload.

## 5. Files touched (estimate)

Backend: `SseEventProjection.cs`, `SseChannel.cs`, `PrDetailLoader.cs`, wire DTO
for `SingleCommentPostedWire`; tests as above.

Frontend: `api/events.ts`, `api/types.ts`, new
`hooks/useSingleCommentPostedSubscriber.ts`, `PrDetailView.tsx`,
`hooks/useInboxUpdates.ts`, `hooks/useInboxRefresh.ts` (drop `dismiss`),
`pages/InboxPage.tsx`; delete `components/Inbox/InboxBanner.tsx` (+ css module)
and `__tests__/InboxBanner.test.tsx`. **`e2e/no-layout-shift-on-banner.spec.ts`
is NOT touched** (guards the retained PR-detail banner).

A new `useSingleCommentPostedSubscriber` mirrors the existing per-event hooks
(`useRootCommentPostedSubscriber`, `useDraftSubmittedSubscriber`). This is the
shipped house pattern; consolidating the three near-identical hooks into one
parameterized `usePrEventSubscriber` is a tempting DRY move but out of scope for
this fix — noted as a future consolidation candidate, not done here.

## 6. Risks

- **Reload storms (inbox):** mitigated by trailing debounce + queue-one-trailing
  coalescing (§3.2); the existing generation guard handles `setData` races.
- **422 window (PR-detail diff tab):** real but bounded. Closed by refresh-in-place
  (Unit 1.2, preferred); if `Invalidate` is kept, bounded by the reload
  round-trip with graceful client degradation (silent `/viewed` rollback,
  `/file` failure banner). Must not be described as parity with root-comment.
- **Per-post reload cost:** each single-comment post triggers a full PR-detail
  reload (no debounce, unlike the inbox). Posting several inline comments in
  quick succession fires N reloads. Acceptable (matches root-comment), but noted.
- **Cross-tab / passive-tab reload:** every tab viewing the PR reloads on the SSE
  frame; a passive diff-tab viewer is exposed to the same snapshot window —
  another reason to prefer refresh-in-place.
- **Scroll / focus loss on reload:** mitigated by keep-alive (FilesTab not
  unmounted) + composer-closed-before-reload; gated by an explicit test (§4).
