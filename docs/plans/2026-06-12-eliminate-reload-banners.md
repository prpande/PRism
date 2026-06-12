# Eliminate Reload Banners — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a freshly-posted inline comment/reply reply-able without a manual reload (PR detail), and auto-refresh the inbox instead of gating it behind a reload banner.

**Architecture:** Part 1 mirrors the shipped `RootCommentPostedBusEvent` wiring exactly — project `SingleCommentPostedBusEvent` to a new `single-comment-posted` SSE event, subscribe `PrDetailLoader.Invalidate` to it, and add a frontend subscriber that calls `usePrDetail.reload()`. Part 2 reframes `useInboxUpdates` from a banner latch into a debounced, queue-coalesced reload trigger and removes the inbox banner. The event bus is synchronous, so `Invalidate` (instant) is used, not `RefreshAsync` (would block the POST) — see spec §2.2.

**Tech Stack:** C# / ASP.NET minimal APIs, in-process `IReviewEventBus`, SSE; React + Vite + TypeScript, vitest, Playwright.

**Spec:** `docs/specs/2026-06-12-eliminate-reload-banners-design.md`

---

## File Structure

**Part 1 — PR detail (backend):**
- Modify `PRism.Web/Sse/SseEventProjection.cs` — add `SingleCommentPostedWire` record + projection arm.
- Modify `PRism.Web/Sse/SseChannel.cs` — subscribe + fan out the new event.
- Modify `PRism.Core/PrDetail/PrDetailLoader.cs` — subscribe `SingleCommentPostedBusEvent → Invalidate`.
- Modify `tests/PRism.Web.Tests/Sse/SseEventProjectionSubmitEventsTests.cs` — projection test.
- Modify `tests/PRism.Web.Tests/Sse/StateChangedSseTests.cs` — fix the unprojected-event test.
- Modify `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs` — eviction tests.

**Part 1 — PR detail (frontend):**
- Modify `frontend/src/api/types.ts` — `SingleCommentPostedEvent` type.
- Modify `frontend/src/api/events.ts` — register the event.
- Create `frontend/src/hooks/useSingleCommentPostedSubscriber.ts` — the subscriber hook.
- Modify `frontend/src/components/PrDetail/PrDetailView.tsx` — wire the subscriber.
- Create `frontend/__tests__/useSingleCommentPostedSubscriber.test.tsx` — hook unit test.
- Modify `frontend/src/components/PrDetail/PrDetailView.freshness.test.tsx` — reload-on-event test.
- Create `frontend/src/components/PrDetail/FilesTab/FilesTab.viewPreservation.test.tsx` — view-state preservation.

**Part 2 — inbox (frontend):**
- Modify `frontend/src/hooks/useInboxUpdates.ts` — debounced reload trigger.
- Modify `frontend/__tests__/useInboxUpdates.test.tsx` — rewrite for new contract.
- Modify the five other files that mock `useInboxUpdates` (old `{hasUpdate,summary,dismiss}` shape): `HelpModal.route.test.tsx`, `PrDetail/PrTabHost.test.tsx`, `pages/InboxPage.activityGate.test.tsx`, `pages/InboxPage.errorState.test.tsx`, `__tests__/app.test.tsx`.
- Modify `frontend/src/hooks/useInboxRefresh.ts` — drop the `dismiss` prop.
- Modify `frontend/__tests__/useInboxRefresh.test.tsx` — drop `dismiss` from setup.
- Modify `frontend/src/pages/InboxPage.tsx` — auto-refresh wiring + aria-live; remove banner.
- Modify `frontend/src/pages/InboxPage.test.tsx` — drop banner assertions, add auto-refresh.
- Delete `frontend/src/components/Inbox/InboxBanner.tsx`, `InboxBanner.module.css`, `frontend/__tests__/InboxBanner.test.tsx`.
- **Untouched:** `frontend/e2e/no-layout-shift-on-banner.spec.ts` (guards the retained PR-detail banner).

---

## Part 1 — PR detail: posted comment becomes reply-able without reload

### Task 1: Project `SingleCommentPostedBusEvent` to a `single-comment-posted` SSE event

**Files:**
- Modify: `PRism.Web/Sse/SseEventProjection.cs`
- Test: `tests/PRism.Web.Tests/Sse/SseEventProjectionSubmitEventsTests.cs`

- [ ] **Step 1: Write the failing test** — add after `RootCommentPosted_projects_to_root_comment_posted_with_issue_comment_id` (~line 127):

```csharp
// #450 — single-comment-posted SSE projection. Mirrors root-comment-posted, but
// carries reviewCommentId (the REST id) so the frontend de-dup matches its
// optimistic placeholder's postedCommentId.
[Fact]
public void SingleCommentPosted_projects_to_single_comment_posted_with_review_comment_id()
{
    var evt = new SingleCommentPostedBusEvent(Pr, ReviewCommentId: 555L);

    var (name, json) = Project(evt);

    name.Should().Be("single-comment-posted");
    json.Should().Contain("\"prRef\":\"o/r/1\"");
    json.Should().Contain("\"reviewCommentId\":555");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter SingleCommentPosted_projects_to_single_comment_posted_with_review_comment_id`
Expected: FAIL — `Project` hits the default arm and throws `ArgumentOutOfRangeException` ("No SSE projection for SingleCommentPostedBusEvent").

- [ ] **Step 3: Add the wire record + projection arm** in `SseEventProjection.cs`.

Add the record after `RootCommentPostedWire` (~line 48):

```csharp
    // #450 — single-comment-posted: a single inline comment or reply was posted
    // directly (not via a review). Carries the REST reviewCommentId for frontend de-dup.
    internal sealed record SingleCommentPostedWire(string PrRef, long ReviewCommentId);
```

Add the arm after the `RootCommentPostedBusEvent` arm (~line 81):

```csharp
        SingleCommentPostedBusEvent e => ("single-comment-posted", new SingleCommentPostedWire(
            e.PrRef.ToString(), e.ReviewCommentId)),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter SingleCommentPosted_projects_to_single_comment_posted_with_review_comment_id`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Sse/SseEventProjection.cs tests/PRism.Web.Tests/Sse/SseEventProjectionSubmitEventsTests.cs
git commit -m "feat(sse): project SingleCommentPostedBusEvent to single-comment-posted (#450)"
```

---

### Task 2: Fix the now-stale "unprojected event" test

**Files:**
- Modify: `tests/PRism.Web.Tests/Sse/StateChangedSseTests.cs:152-166`

Adding the Task-1 arm makes `Unhandled_event_type_throws` (which used `SingleCommentPostedBusEvent` as its unprojected example) fail. Swap it to a test-only `IReviewEvent` so the default-arm coverage survives and never breaks again when a future event gets projected.

- [ ] **Step 1: Replace the test body** at `StateChangedSseTests.cs:152-166`:

```csharp
    // A test-only IReviewEvent that the projection switch will never handle — keeps the
    // default-arm coverage stable even as real events (e.g. #450's SingleCommentPostedBusEvent)
    // gain projection arms. (DraftSubmitted, then SingleCommentPostedBusEvent, used to be the
    // examples here; both now project, so we use a synthetic type instead.)
    private sealed record UnprojectedTestEvent(PrReference PrRef) : IReviewEvent;

    [Fact]
    public void Unhandled_event_type_throws()
    {
        var evt = new UnprojectedTestEvent(SamplePr);

        var act = () => Project(evt);

        act.Should().Throw<TargetInvocationException>()
            .WithInnerException<ArgumentOutOfRangeException>();
    }
```

- [ ] **Step 2: Run to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --filter Unhandled_event_type_throws`
Expected: PASS (Project on the synthetic type still throws via the default arm).

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.Web.Tests/Sse/StateChangedSseTests.cs
git commit -m "test(sse): use synthetic unprojected event after single-comment arm added (#450)"
```

---

### Task 3: Fan out `single-comment-posted` from `SseChannel`

**Files:**
- Modify: `PRism.Web/Sse/SseChannel.cs`

Mechanical mirror of the 13 existing per-PR fanouts (no new unit test — the projection is tested in Task 1, delivery is covered by the existing SSE channel tests + the e2e in Task 11; the compiler enforces the wiring).

- [ ] **Step 1: Add the subscription field** after `_busDraftSubmitted` (~line 52):

```csharp
    // #450 — single-comment-posted: a single inline comment/reply was posted directly.
    // Fans out per-PR so every subscriber for the PR reloads and the new thread surfaces.
    private readonly IDisposable _busSingleCommentPosted;
```

- [ ] **Step 2: Subscribe in the constructor** after the `_busRootCommentPosted` line (~line 75):

```csharp
        _busSingleCommentPosted = bus.Subscribe<SingleCommentPostedBusEvent>(OnSingleCommentPosted);
```

- [ ] **Step 3: Add the handler** next to `OnRootCommentPosted` (~line 304):

```csharp
    private void OnSingleCommentPosted(SingleCommentPostedBusEvent evt) => FanoutProjected(evt, evt.PrRef);
```

- [ ] **Step 4: Dispose it** in `Dispose()` after `_busRootCommentPosted.Dispose();` (~line 383):

```csharp
        _busSingleCommentPosted.Dispose();
```

- [ ] **Step 5: Build + run the SSE channel tests**

Run: `dotnet test tests/PRism.Web.Tests --filter Sse`
Expected: PASS (build clean, no regressions).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Sse/SseChannel.cs
git commit -m "feat(sse): fan out single-comment-posted per-PR (#450)"
```

---

### Task 4: `PrDetailLoader` evicts the snapshot on `SingleCommentPostedBusEvent`

**Files:**
- Modify: `PRism.Core/PrDetail/PrDetailLoader.cs`
- Test: `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs`

- [ ] **Step 1: Write the failing tests** — add after `RootCommentPostedBusEvent_for_other_prRef_does_not_evict_this_snapshot` (~line 203):

```csharp
    [Fact]
    public async Task LoadAsync_evicts_snapshot_after_SingleCommentPostedBusEvent()
    {
        // #450: a posted inline comment/reply does NOT change the head SHA, so the
        // (prRef, headSha, generation) key would re-serve the stale pre-post snapshot on the
        // SSE-driven reload — the new thread would be missing until a manual reload. The loader
        // subscribes to SingleCommentPostedBusEvent and evicts immediately. (Invalidate, not
        // RefreshAsync: the bus is synchronous and fires inside the comment-POST — see spec §2.2.)
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);
        loader.TryGetCachedSnapshot(Pr1).Should().NotBeNull();

        bus.Publish(new SingleCommentPostedBusEvent(Pr1, 0L));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .BeNull("a posted single comment must evict the snapshot so the reload re-fetches fresh detail");
    }

    [Fact]
    public async Task SingleCommentPostedBusEvent_for_other_prRef_does_not_evict_this_snapshot()
    {
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "MERGEABLE", "OPEN", 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);

        bus.Publish(new SingleCommentPostedBusEvent(new PrReference("owner", "repo", 2), 0L));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .NotBeNull("a different PR's single-comment post must not evict this PR's snapshot");
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet test tests/PRism.Core.Tests --filter SingleCommentPostedBusEvent`
Expected: FAIL — `LoadAsync_evicts_snapshot_after_SingleCommentPostedBusEvent` finds the snapshot still cached (loader doesn't subscribe yet).

- [ ] **Step 3: Add the subscription + handler + disposal** in `PrDetailLoader.cs`.

Add the field next to `_rootCommentSubscription` / `_draftSubmittedSubscription` (the subscription fields region):

```csharp
    private readonly IDisposable _singleCommentSubscription;
```

In the constructor, replace the `NOT subscribed to SingleCommentPostedBusEvent` carve-out comment block (~line 96-99) with the subscription. The block currently reads:

```csharp
        // NOT subscribed to SingleCommentPostedBusEvent (diff post-now): that path has no
        // immediate client reload trigger, so eviction there is inert and would open a
        // /file & /viewed 422 window on the active diff tab — see #353 design doc.
        _rootCommentSubscription = eventBus.Subscribe<RootCommentPostedBusEvent>(OnRootCommentPosted);
```

Replace with:

```csharp
        _rootCommentSubscription = eventBus.Subscribe<RootCommentPostedBusEvent>(OnRootCommentPosted);

        // #450: single-comment post-now NOW has an immediate client reload trigger
        // (single-comment-posted SSE → usePrDetail.reload), so eviction is no longer inert.
        // Evict here so that reload re-fetches fresh detail and the new thread becomes
        // reply-able without a manual reload. Invalidate (not RefreshAsync): the bus is
        // synchronous and Publish runs inside the comment-POST, so RefreshAsync would block
        // the post (or race the reload if backgrounded) — see spec §2.2. The small, graceful
        // /file & /viewed 422 window during the evict→reload gap is accepted (spec §2.3).
        _singleCommentSubscription = eventBus.Subscribe<SingleCommentPostedBusEvent>(OnSingleCommentPosted);
```

Add the handler next to `OnRootCommentPosted` (~line 129):

```csharp
    // #450: see the constructor wire-up. Unconditional eviction — the event fires only on an
    // actual post, so there is no quiet/no-op event to suppress (mirrors OnRootCommentPosted).
    private void OnSingleCommentPosted(SingleCommentPostedBusEvent evt) => Invalidate(evt.PrRef);
```

Dispose it wherever the other subscriptions are disposed (the `Dispose` method, next to `_rootCommentSubscription.Dispose();`):

```csharp
        _singleCommentSubscription.Dispose();
```

- [ ] **Step 4: Run to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests --filter SingleCommentPostedBusEvent`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/PrDetail/PrDetailLoader.cs tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs
git commit -m "feat(pr-detail): evict loader snapshot on SingleCommentPostedBusEvent (#450)"
```

---

### Task 5: Register the `single-comment-posted` event on the frontend

**Files:**
- Modify: `frontend/src/api/types.ts` (after `RootCommentPostedEvent`, ~line 495)
- Modify: `frontend/src/api/events.ts`

- [ ] **Step 1: Add the payload type** in `types.ts` after `RootCommentPostedEvent`:

```ts
// #450 — single-comment-posted: a single inline comment/reply was posted directly.
// Frontend triggers a PR-detail reload; reviewCommentId is carried for completeness/de-dup.
export interface SingleCommentPostedEvent {
  prRef: string;
  reviewCommentId: number;
}
```

- [ ] **Step 2: Register it in `events.ts`** — three edits:

Import + re-export (alongside `RootCommentPostedEvent`):

```ts
  RootCommentPostedEvent,
  SingleCommentPostedEvent,
```

(add `SingleCommentPostedEvent` to both the `import type { … } from './types'` list and the `export type { … }` list).

Add to `EventPayloadByType` after `'root-comment-posted'`:

```ts
  'single-comment-posted': SingleCommentPostedEvent;
```

Add to the `EVENT_TYPES` array after `'root-comment-posted'`:

```ts
  'single-comment-posted',
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/events.ts
git commit -m "feat(events): register single-comment-posted SSE event (#450)"
```

---

### Task 6: `useSingleCommentPostedSubscriber` hook

**Files:**
- Create: `frontend/src/hooks/useSingleCommentPostedSubscriber.ts`
- Test: `frontend/__tests__/useSingleCommentPostedSubscriber.test.tsx`

- [ ] **Step 1: Write the failing test:**

```tsx
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useSingleCommentPostedSubscriber } from '../src/hooks/useSingleCommentPostedSubscriber';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

describe('useSingleCommentPostedSubscriber', () => {
  it('fires onPosted for a matching prRef', async () => {
    installFakeEventSource();
    const onPosted = vi.fn();
    const prRef = { owner: 'acme', repo: 'api', number: 7 };
    renderHook(() => useSingleCommentPostedSubscriber({ prRef, onPosted }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      FakeEventSource.instance.dispatch('single-comment-posted', {
        prRef: 'acme/api/7',
        reviewCommentId: 42,
      }),
    );

    expect(onPosted).toHaveBeenCalledOnce();
  });

  it('ignores a non-matching prRef', async () => {
    installFakeEventSource();
    const onPosted = vi.fn();
    const prRef = { owner: 'acme', repo: 'api', number: 7 };
    renderHook(() => useSingleCommentPostedSubscriber({ prRef, onPosted }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      FakeEventSource.instance.dispatch('single-comment-posted', {
        prRef: 'acme/api/999',
        reviewCommentId: 42,
      }),
    );

    expect(onPosted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run __tests__/useSingleCommentPostedSubscriber.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the hook** (near-copy of `useRootCommentPostedSubscriber.ts`):

```ts
import { useEffect } from 'react';
import { useEventSource } from './useEventSource';
import { prRefKey, type PrReference } from '../api/types';

export interface UseSingleCommentPostedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a single inline comment/reply was posted for this PR.
  // Caller typically calls usePrDetail.reload() so the new thread surfaces with its
  // ReplyComposer and the optimistic placeholder de-dupes away.
  onPosted: () => void;
}

// Subscribes to 'single-comment-posted' SSE events, filtering by prRef so a multi-PR
// layout cannot receive another PR's notification. Mirrors useRootCommentPostedSubscriber.
export function useSingleCommentPostedSubscriber({
  prRef,
  onPosted,
}: UseSingleCommentPostedSubscriberOptions): void {
  const stream = useEventSource();
  useEffect(() => {
    if (!stream || !prRef) return;
    const prRefStr = prRefKey(prRef);
    return stream.on('single-comment-posted', (event) => {
      if (event.prRef !== prRefStr) return;
      onPosted();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [stream, prRef?.owner, prRef?.repo, prRef?.number, onPosted]);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run __tests__/useSingleCommentPostedSubscriber.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useSingleCommentPostedSubscriber.ts frontend/__tests__/useSingleCommentPostedSubscriber.test.tsx
git commit -m "feat(pr-detail): add useSingleCommentPostedSubscriber hook (#450)"
```

---

### Task 7: Wire the subscriber into `PrDetailView` + assert reload fires

**Files:**
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx`
- Test: `frontend/src/components/PrDetail/PrDetailView.freshness.test.tsx`

- [ ] **Step 1: Add a failing test** in `PrDetailView.freshness.test.tsx`. This file mocks `usePrDetail` with the hoisted `reloadSpy`. Mock the new hook so it captures the `onPosted` callback, then assert invoking it calls `reloadSpy`. Add the mock alongside the existing hook mocks at the top of the file:

```tsx
// #450 — capture the single-comment-posted subscriber's onPosted so the test can fire it.
const { singleCommentOnPosted } = vi.hoisted(() => ({ singleCommentOnPosted: { current: null as null | (() => void) } }));
vi.mock('../../hooks/useSingleCommentPostedSubscriber', () => ({
  useSingleCommentPostedSubscriber: ({ onPosted }: { onPosted: () => void }) => {
    singleCommentOnPosted.current = onPosted;
  },
}));
```

And the test (place near the other freshness tests):

```tsx
test('a single-comment-posted event triggers usePrDetail.reload', () => {
  prDetailResult.current = { data: PR_DETAIL, isLoading: false, error: null };
  renderPrDetailView({ active: true }); // the file's active-render helper (defined ~line 191)
  reloadSpy.mockClear();

  expect(singleCommentOnPosted.current).toBeTypeOf('function');
  singleCommentOnPosted.current!();

  expect(reloadSpy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/PrDetailView.freshness.test.tsx`
Expected: FAIL — `singleCommentOnPosted.current` is null (PrDetailView doesn't call the hook yet).

- [ ] **Step 3: Wire the hook in `PrDetailView.tsx`.** Add the import next to `useRootCommentPostedSubscriber`:

```tsx
import { useSingleCommentPostedSubscriber } from '../../hooks/useSingleCommentPostedSubscriber';
```

Add the call directly after the existing `useRootCommentPostedSubscriber({ prRef, onPosted: reload });` line (~line 82):

```tsx
  // #450: when a single inline comment/reply is posted, reload PR detail so the new thread
  // surfaces with its ReplyComposer — without a manual reload. Mirrors the root-comment
  // subscriber above; the loader's matching SingleCommentPostedBusEvent → Invalidate guarantees
  // the reload re-fetches fresh detail, not the stale head-SHA-keyed snapshot.
  useSingleCommentPostedSubscriber({ prRef, onPosted: reload });
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/PrDetailView.freshness.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/PrDetailView.freshness.test.tsx
git commit -m "feat(pr-detail): reload on single-comment-posted so the new thread is reply-able (#450)"
```

---

### Task 8: View-state preservation across the auto-reload (component-level)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/FilesTab.viewPreservation.test.tsx`

A data swap (what `reload()` does — replace `prDetail`, no unmount) must preserve `selectedPath`, `viewedPaths`, and diff mode, while surfacing the new thread **with its reply affordance**. This test re-renders the same `FilesTab` instance with an updated context value carrying an extra review thread, and is the primary proof of the headline behavior ("reply-able without reload") — the live-browser e2e of the same chain is deferred (Task 13) behind a missing backend test hook. (Scroll preservation is asserted in e2e Task 13 — jsdom has no layout.)

- [ ] **Step 1: Write the failing test.** Use the existing `makePrDetailDto` / context-render helpers (mirror `FilesTab.test.tsx`'s setup — import the same helpers it uses):

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { FilesTab } from './FilesTab';
import { PrDetailContextProvider } from '../prDetailContext';
import type { PrDetailContextValue } from '../prDetailContext';
import { makePrDetailDto } from '../../../../__tests__/helpers/prDetail';
// NOTE: reuse FilesTab.test.tsx's exact context/diff fixtures + provider wrapper helper.

describe('FilesTab — view state survives a prDetail swap (auto-reload, #450)', () => {
  it('keeps selected file, viewed state, and diff mode; surfaces the new thread', async () => {
    const user = userEvent.setup();
    // 1. Render with a 2-file diff and no review threads.
    // 2. Select the SECOND file, toggle it viewed, switch diff mode to unified.
    // 3. Re-render the SAME component with a prDetail that adds one reviewComments thread
    //    (simulating reload()'s data swap), keeping the diff/file-set identical.
    // 4. Assert: the second file is still selected, its viewed checkmark is still set,
    //    diff mode is still unified, AND the new thread is now rendered.
    // Use the FilesTab.test.tsx fixtures verbatim for files/diff/context shape.
    expect(true).toBe(true); // replace with the assertions above once fixtures are wired
  });
});
```

> Implementer: flesh out steps 1-4 using `FilesTab.test.tsx`'s existing fixtures and render wrapper. The placeholder assertion exists only to make the file parse; replace it. The real assertions are: `getByText(secondFileName)` selected state, the viewed checkmark `aria-checked`/class, the unified-mode marker, `getByText(newThreadBody)`, AND that the new thread renders its reply affordance (e.g. `getByRole('button', { name: /reply/i })` or the `ExistingCommentWidget`'s reply control scoped to the new thread) — this is the headline "reply-able without reload" proof. The added thread fixture needs a real `id`/`threadId` so `ReplyComposer` has a `parentThreadId`.

- [ ] **Step 2: Run to verify it fails** (then passes once written — this behavior already holds under keep-alive, so the test should pass immediately after correct wiring; if it FAILS, that's a real regression to fix).

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/FilesTab/FilesTab.viewPreservation.test.tsx`
Expected: PASS (keep-alive preserves the state; the swap only adds the thread).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.viewPreservation.test.tsx
git commit -m "test(pr-detail): lock view-state preservation across auto-reload data swap (#450)"
```

---

## Part 2 — Inbox: auto-refresh, remove the banner

### Task 9: Reframe `useInboxUpdates` into a debounced reload trigger

**Files:**
- Modify: `frontend/src/hooks/useInboxUpdates.ts`
- Test: `frontend/__tests__/useInboxUpdates.test.tsx` (full rewrite)

- [ ] **Step 1: Rewrite the test** for the new contract — debounce coalescing + queue-one-trailing + announce. Replace the whole file:

```tsx
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { useInboxUpdates } from '../src/hooks/useInboxUpdates';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

const emit = () =>
  FakeEventSource.instance.dispatch('inbox-updated', {
    changedSectionIds: [],
    newOrUpdatedPrCount: 1,
  });

beforeEach(() => {
  installFakeEventSource();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useInboxUpdates (auto-refresh)', () => {
  it('calls onUpdate once after the debounce window', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useInboxUpdates({ onUpdate }), { wrapper });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => emit());
    expect(onUpdate).not.toHaveBeenCalled(); // debounced, not yet fired
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into one onUpdate', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useInboxUpdates({ onUpdate }), { wrapper });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      emit();
      emit();
      emit();
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('queues exactly one trailing reload when an event lands mid-flight', async () => {
    let resolveFirst!: () => void;
    const onUpdate = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveFirst = r)))
      .mockResolvedValue(undefined);
    renderHook(() => useInboxUpdates({ onUpdate }), { wrapper });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // First reload starts (and hangs).
    act(() => emit());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Event arrives while the first reload is still in flight → queued, not stacked.
    act(() => emit());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(onUpdate).toHaveBeenCalledTimes(1); // still 1 — queued behind the in-flight one

    // First reload resolves → exactly one trailing reload fires.
    await act(async () => {
      resolveFirst();
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run __tests__/useInboxUpdates.test.tsx`
Expected: FAIL — `useInboxUpdates` doesn't accept `{ onUpdate }` and has no debounce.

- [ ] **Step 3: Rewrite the hook.** Replace `frontend/src/hooks/useInboxUpdates.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEventSource } from './useEventSource';

const DEBOUNCE_MS = 500;

interface Options {
  /** Re-fetch the inbox. Awaited so the trailing-queue knows when a reload finishes. */
  onUpdate: () => Promise<void>;
}

// #450 — auto-refresh on inbox-updated, replacing the manual reload banner.
// - Trailing debounce coalesces a burst (one inbox-updated frame per changed PR) into one GET.
// - In-flight coalescing QUEUES exactly one trailing reload (never "skip", which would drop the
//   last update). useInbox.reload already has a generation guard for setData races, so this guard
//   exists only for trailing-coalescing correctness (spec §3.2).
// - `announce` gives screen-reader users the signal the removed banner (role=status) carried.
export function useInboxUpdates({ onUpdate }: Options): { announce: string } {
  const stream = useEventSource();
  const [announce, setAnnounce] = useState('');

  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const pending = useRef(false);

  const run = useCallback(async () => {
    if (inFlight.current) {
      pending.current = true; // queue exactly one trailing reload
      return;
    }
    inFlight.current = true;
    try {
      await onUpdateRef.current();
      setAnnounce('Inbox updated');
    } catch {
      // Swallow — keep current data, no banner/toast. Manual Refresh is the recovery path.
    } finally {
      inFlight.current = false;
      if (pending.current) {
        pending.current = false;
        void run();
      }
    }
  }, []);

  useEffect(() => {
    if (!stream) return;
    return stream.on('inbox-updated', () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => void run(), DEBOUNCE_MS);
    });
  }, [stream, run]);

  useEffect(
    () => () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    },
    [],
  );

  return { announce };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run __tests__/useInboxUpdates.test.tsx`
Expected: PASS (all three tests).

- [ ] **Step 5: Sweep the five other files that mock the OLD `useInboxUpdates` shape.** These `vi.mock('.../useInboxUpdates')` factories return `{ hasUpdate, summary, dismiss }`; the new return type is `{ announce }`, so the typed ones break `tsc -b` and the behavior mocks are stale. Update each factory to `() => ({ announce: '' })` (drop `hasUpdate`/`summary`/`dismiss`):
  - `frontend/src/components/Help/HelpModal.route.test.tsx` (~line 55)
  - `frontend/src/components/PrDetail/PrTabHost.test.tsx` (~line 57)
  - `frontend/src/pages/InboxPage.activityGate.test.tsx` (~line 23)
  - `frontend/src/pages/InboxPage.errorState.test.tsx` (~line 13)
  - `frontend/__tests__/app.test.tsx` (~line 29)

Run: `cd frontend && git grep -n "useInboxUpdates" -- '*.test.tsx'` to confirm none still return the old shape, then `npx tsc -b`.
Expected: no `hasUpdate`/`summary`/`dismiss` left in any mock; typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useInboxUpdates.ts frontend/__tests__/useInboxUpdates.test.tsx \
  frontend/src/components/Help/HelpModal.route.test.tsx \
  frontend/src/components/PrDetail/PrTabHost.test.tsx \
  frontend/src/pages/InboxPage.activityGate.test.tsx \
  frontend/src/pages/InboxPage.errorState.test.tsx \
  frontend/__tests__/app.test.tsx
git commit -m "feat(inbox): reframe useInboxUpdates into a debounced auto-refresh trigger (#450)"
```

---

### Task 10: Drop the `dismiss` prop from `useInboxRefresh`

**Files:**
- Modify: `frontend/src/hooks/useInboxRefresh.ts`
- Test: `frontend/__tests__/useInboxRefresh.test.tsx`

With the banner gone there is no latch to dismiss. The `dismiss` prop + its call become dead.

- [ ] **Step 1: Update the test** — remove `dismiss` from the hook's options in every `useInboxRefresh({ … })` call in `useInboxRefresh.test.tsx`, and delete any assertion that `dismiss` was called. (Search the file for `dismiss` and strip those lines.)

- [ ] **Step 2: Run to verify it fails to compile/typecheck**

Run: `cd frontend && ./node_modules/.bin/vitest run __tests__/useInboxRefresh.test.tsx`
Expected: FAIL — tests still pass `dismiss` (or assert it) but we're about to remove it; OR they already type-error. Either way, proceed.

- [ ] **Step 3: Edit `useInboxRefresh.ts`** — remove the `dismiss` field from `Options` (delete lines 12-13, the `/** Clear any pending … */ dismiss: () => void;`), remove `dismiss` from the destructure (`{ reload, dismiss, onError }` → `{ reload, onError }`), remove the `dismiss();` call (line 53), and drop `dismiss` from the `useCallback` dependency array (line 68).

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run __tests__/useInboxRefresh.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useInboxRefresh.ts frontend/__tests__/useInboxRefresh.test.tsx
git commit -m "refactor(inbox): drop dead dismiss prop from useInboxRefresh (#450)"
```

---

### Task 11: Wire auto-refresh into `InboxPage`, remove the banner

**Files:**
- Modify: `frontend/src/pages/InboxPage.tsx`
- Test: `frontend/src/pages/InboxPage.test.tsx`

- [ ] **Step 1: Update `InboxPage.test.tsx`.** Remove the test(s) asserting the banner appears on `inbox-updated` and that clicking its Reload re-fetches. Retype every `vi.mocked(useInboxUpdates).mockReturnValue({ hasUpdate, summary, dismiss })` call (the file has them at ~line 69 and ~line 345) to the new `{ announce: '' }` shape — leaving the old shape is a `tsc -b` error. Add a test that an `inbox-updated` frame (after the debounce) calls the inbox reload. If these tests use a real `useInbox` + fake fetch, assert the inbox API is re-fetched; if they mock `useInboxUpdates`, assert the mocked `onUpdate` is invoked. Mirror the existing test harness in the file.

> Implementer: read `InboxPage.test.tsx` first; reuse its existing fake-event-source + inbox-fetch harness. Do not invent a new harness.

- [ ] **Step 2: Run to verify the suite reflects the new behavior (fails)**

Run: `cd frontend && ./node_modules/.bin/vitest run src/pages/InboxPage.test.tsx`
Expected: FAIL — the page still imports/renders `InboxBanner` and `useInboxUpdates()` with the old shape.

- [ ] **Step 3: Edit `InboxPage.tsx`:**

Remove the import:

```tsx
import { InboxBanner } from '../components/Inbox/InboxBanner';
```

Replace the `updates` wiring. Change:

```tsx
  const { data, error, isLoading, reload } = useInbox();
  const updates = useInboxUpdates();
  const toast = useToast();
  const { isRefreshing, justRefreshed, announce, refresh } = useInboxRefresh({
    reload,
    dismiss: updates.dismiss,
    onError: (message) => toast.show({ kind: 'error', message }),
  });
```

to:

```tsx
  const { data, error, isLoading, reload } = useInbox();
  const autoRefresh = useInboxUpdates({ onUpdate: reload });
  const toast = useToast();
  const { isRefreshing, justRefreshed, announce, refresh } = useInboxRefresh({
    reload,
    onError: (message) => toast.show({ kind: 'error', message }),
  });
```

Remove the `onReload` helper:

```tsx
  const onReload = async () => {
    await reload();
    updates.dismiss();
  };
```

Remove the banner render:

```tsx
        {updates.hasUpdate && (
          <InboxBanner summary={updates.summary} onReload={onReload} onDismiss={updates.dismiss} />
        )}
```

Add the auto-refresh announcement to the existing sr-only status region (it currently shows the manual-refresh `announce`). Render both — change the region's content to surface whichever is non-empty:

```tsx
        <div
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="inbox-refresh-status"
        >
          {announce || autoRefresh.announce}
        </div>
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run src/pages/InboxPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/InboxPage.tsx frontend/src/pages/InboxPage.test.tsx
git commit -m "feat(inbox): auto-refresh on inbox-updated, remove reload banner (#450)"
```

---

### Task 12: Delete the `InboxBanner` component

**Files:**
- Delete: `frontend/src/components/Inbox/InboxBanner.tsx`
- Delete: `frontend/src/components/Inbox/InboxBanner.module.css`
- Delete: `frontend/__tests__/InboxBanner.test.tsx`

- [ ] **Step 1: Confirm no remaining references**

Run: `cd frontend && git grep -n "InboxBanner"`
Expected: only the three files about to be deleted (no `src/` consumers left after Task 11).

- [ ] **Step 2: Delete the files**

```bash
git rm frontend/src/components/Inbox/InboxBanner.tsx frontend/src/components/Inbox/InboxBanner.module.css frontend/__tests__/InboxBanner.test.tsx
```

- [ ] **Step 3: Typecheck + full frontend unit run**

Run: `cd frontend && npx tsc -b && ./node_modules/.bin/vitest run`
Expected: PASS (no dangling imports; whole suite green).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(inbox): delete unused InboxBanner component (#450)"
```

---

### Task 13: e2e — scroll preserved across auto-reload (reply-affordance e2e deferred)

**Files:**
- Modify: `frontend/e2e/pr-detail-single-comment.spec.ts`

**Scope note (feasibility finding):** The headline "reply-able without reload" behavior is proven at the component level in Task 8 (the new thread + its reply affordance render on the data swap) and at the wiring level in Tasks 4/7 (post → `SingleCommentPostedBusEvent` → `Invalidate` + SSE → `reload`). A *live-browser* e2e of the full chain is **not feasible today**: the e2e fake backend `FakePrReader.GetPrDetailAsync` returns `ReviewComments: Array.Empty<ReviewThreadDto>()` and never reflects a posted comment back into PR detail — this file already carries a `test.fixme` documenting the missing `/test/seed-review-thread` hook. So this task asserts only what the fake backend can support: scroll preservation + the optimistic card surviving the auto-reload. The full reply-affordance e2e stays `fixme`, deferred to the issue that adds the seed hook.

- [ ] **Step 1: Add the feasible e2e assertion.** After the existing post-now flow, assert the diff scroll offset is unchanged across the auto-reload and the optimistic inline card persists. Reuse the spec's existing fake-review harness + post flow + selectors:

```ts
test('posting an inline comment preserves diff scroll across the auto-reload', async ({ page }) => {
  // ... reuse this file's setup: open a PR on the Files tab, scroll the diff, open the
  // inline composer, type, and click the post-now ("Comment") button.
  const scroller = page.locator('[data-app-scroll]');
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);

  // ... post the comment (existing helper / steps in this file).

  // The optimistic inline card renders immediately and survives the single-comment-posted reload.
  await expect(page.getByTestId('inline-comment-card-optimistic')).toBeVisible();

  // Scroll offset is preserved across the auto-reload (no viewport yank).
  const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(2);
});
```

> Implementer: align selectors with this file's existing ones (it already drives post-now and the diff). Confirm `data-app-scroll` is the diff scroll container in browser mode; if the Files-tab scroller differs, use the file's existing scroll-target selector. Do NOT add a reply-affordance assertion here — leave the existing `test.fixme` for that in place.

- [ ] **Step 2: Run the spec**

Run: `cd frontend && ./node_modules/.bin/playwright test e2e/pr-detail-single-comment.spec.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/pr-detail-single-comment.spec.ts
git commit -m "test(e2e): inline comment post preserves diff scroll across auto-reload (#450)"
```

---

### Task 14: Full gate — backend + frontend + lint

- [ ] **Step 1: Backend tests**

Run: `dotnet test`
Expected: PASS (all projects).

- [ ] **Step 2: Frontend unit + typecheck + lint**

Run: `cd frontend && npx tsc -b && ./node_modules/.bin/vitest run && npm run lint`
Expected: PASS. (If `npm run lint` reports prettier clean but you suspect masking, re-check with `rtk proxy npx prettier --check .` per the repo's known rtk-masks-prettier gotcha.)

- [ ] **Step 3: e2e**

Run: `cd frontend && ./node_modules/.bin/playwright test`
Expected: PASS — including `no-layout-shift-on-banner.spec.ts` (untouched, still green).

- [ ] **Step 4: Final commit if any lint/format fixes were applied**

```bash
git add -A
git commit -m "chore: format + lint pass (#450)"
```

---

## Self-Review

**Spec coverage:**
- §2.2 Unit 1.1 (SSE projection) → Tasks 1, 3. Unit 1.2 (loader Invalidate) → Task 4. Unit 1.3 (frontend trigger) → Tasks 5, 6, 7.
- §2.3 view-state preservation → Task 8 (component, incl. reply-affordance proof) + Task 13 (scroll e2e). Live-browser reply-affordance e2e deferred (fake backend returns empty `ReviewComments`; needs a `/test/seed-review-thread` hook — matches the existing `test.fixme`).
- §2.3 422 window accepted (no work) — intentionally no task; documented decision.
- §3.2 Unit 2.1 (debounced reload, queue-not-skip, aria-live) → Task 9 (incl. the 5-file stale-mock sweep). Unit 2.2 (remove banner) → Tasks 11, 12. Unit 2.3 (`useInboxRefresh` dismiss drop) → Task 10.
- §4 testing → covered per-task; StateChangedSseTests fix → Task 2.
- §5 `no-layout-shift-on-banner.spec.ts` NOT touched → confirmed Task 14 Step 3.

**Type consistency:** `SingleCommentPostedBusEvent(PrReference, long ReviewCommentId)` (backend, exists) → wire `SingleCommentPostedWire(string PrRef, long ReviewCommentId)` → SSE `single-comment-posted` → frontend `SingleCommentPostedEvent { prRef: string; reviewCommentId: number }`. Hook `useSingleCommentPostedSubscriber({ prRef, onPosted })`. `useInboxUpdates({ onUpdate }): { announce }`. Consistent across tasks.

**Placeholder scan:** Tasks 8 and 13 carry explicit "implementer: flesh out using existing fixtures" notes with the concrete assertions named — these are unavoidable because they reuse file-local test fixtures that must be read at implementation time, not copied blind. Every other task has complete code.

**Post-review fixes (machine review pass on the plan):** Task 7 render helper corrected to `renderPrDetailView({ active: true })`; Task 9 extended with the 5-file stale-`useInboxUpdates`-mock sweep; Task 11 made the `vi.mocked(useInboxUpdates).mockReturnValue` retyping explicit; Task 13 rescoped to scroll/optimistic-card (the reply-affordance e2e is deferred behind a missing `/test/seed-review-thread` backend hook, with the headline behavior proven at component level in Task 8).
