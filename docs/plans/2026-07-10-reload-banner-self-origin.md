# Reload banner fires for the user's own comment posts (#740) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the PR-detail reload banner from announcing a single inline comment/reply that PRism itself posted, while keeping it for every comment PRism did not originate.

**Architecture:** Option **G** from the spec, scoped to the single inline comment/reply path — net self-posts at the poller. `ActivePrPoller` subscribes to `SingleCommentPostedBusEvent` (the write-path event it already holds the bus for), keeps a per-PR credit of self-posts not yet reconciled against GitHub's inline-comment count, and nets that credit out of each tick's observed rise before deciding whether to raise a comment frame. Nothing auto-applies; the banner's behavior is untouched — only *whether it is raised* changes.

**Tech Stack:** C# (.NET 10, backend only). xUnit (`PRism.Core.Tests`). **No frontend change, no SSE wire change, no bus-record change, no GraphQL / DTO / batch-reader change.**

**Spec:** `docs/specs/2026-07-10-reload-banner-self-origin-design.md` (semantics gate: origin reading; option gate 2026-07-13: option G, single-comment path; `ce-doc-review` dispositions in its §9).

## Global Constraints

- **Backend-only production change, one file.** The production diff touches `PRism.Core/PrDetail/ActivePrPoller.cs` only. If a task appears to need a frontend, SSE-projection, `DraftSubmitted`, GraphQL, DTO, or batch-reader edit, stop — the spec's §5 scope boundary has been crossed (the review-submit path is a §8 follow-up, not this PR).
- **`LastCommentCount` must keep advancing unconditionally** (`ActivePrPoller.cs:342`). The netting changes the *published delta* and the *comment gate*, never the baseline update. A suppressed self-post tick must still move `LastCommentCount` to `snapshot.CommentCount`, or the same rise is re-observed and re-consumed next tick. (Verified in review: `:342` sits outside the publish `if` and after the per-alias-drop `continue`.)
- **Clear a PR's credits on its first poll.** firstPoll sets the baseline from the current count, folding in any self-rise that landed before the baseline tick; a credit predating that baseline is already reconciled and would orphan. Clearing on firstPoll removes that orphan class and the subscribe→post→firstPoll startup race.
- **Fail open on expiry.** A self-post credit that is never reconciled must expire toward **showing** a banner. `N = 2` poll ticks (≈60s: long enough for GitHub's count to reflect the post, short enough to bound the window a stale credit is live). Expiry *bounds* the exposure; it does not eliminate the deletion/never-landing residual (§4-G of the spec) — that is a known limitation closed only by id-based netting (§8).
- **Concurrency.** The credit map is mutated by the write thread (synchronous `bus.Publish` inside the POST) and read/decremented by the poller thread. Guard every credit read/write with one lock. Do **not** hang the credit on `ActivePrPollerState` — that type is documented single-threaded (tick-only); the credit is cross-thread.
- **Use the real `ReviewEventBus` in tests, never `FakeReviewEventBus`** — its `Subscribe` returns `NullDisposable` and never invokes handlers, so a subscription test would pass vacuously. The real bus has no `Published` capture list, so subscribe a recording handler to it to assert on emitted `ActivePrUpdated`s.
- **One long-running build/test at a time, foreground, timeout ≥ 300000 ms.** Real `dotnet.exe`, not the rtk proxy (it masks `dotnet test`).
- **Commit trailers** (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016cGhjhEuDgNEVK7EvevnQM
  ```
- **Commit subjects must not use the `fix(#740):` scope** — a conventional `fix(#N)` scope auto-closes the issue. Use `fix(740):` or `refs 740`; the PR body closes it.
- **Line numbers below are as of `main` @ `ca603fb7`; locate by symbol name if they have shifted.**

## File Structure

- **Modify** `PRism.Core/PrDetail/ActivePrPoller.cs` — subscribe to `SingleCommentPostedBusEvent`; keep a lock-guarded per-PR credit; net it out each tick; gate the comment frame and the published delta on the external delta; clear credits on firstPoll; prune credits with `_state`; dispose the subscription.
- **Create** `tests/PRism.Core.Tests/PrDetail/ActivePrPollerSelfPostNettingTests.cs` — the red-on-main regression test + netting companions (drive `TickAsync` with the real `ReviewEventBus`).

**Not touched:** any `frontend/**` file, `SseEventProjection.cs`, `PRism.Core/Events/DraftSubmitted.cs`, `PrSubmitEndpoints.cs`, `GitHubActivePrBatchReader.cs`, `ActivePrUpdated.cs`, `useActivePrUpdates.ts`, `BannerRefresh.tsx`, any `frontend/e2e/*` mock body.

---

### Task 1: The red-on-main regression test

**Files:**
- Create: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerSelfPostNettingTests.cs`

**Why the poller layer.** The fix is in the poller, so the gate belongs there and exercises the exact surface that changes. Copy the harness from `ActivePrPollerTests.cs` (real `ActivePrPoller`, a fake `IActivePrBatchReader` returning scripted `ActivePrPollSnapshot`s). **Use the real `ReviewEventBus`** so the poller's subscription fires when the test publishes the write event; capture published `ActivePrUpdated`s with a recorder subscribed to the same real bus.

- [ ] **Step 1: Stand up the fixture** — a fake batch reader whose `CommentCount` for the PR is scriptable per tick (baseline `2`, then `3`), plus a recorder subscribed to the real bus collecting every `ActivePrUpdated`.

- [ ] **Step 2: Write the #740 scenario**

Baseline `TickAsync(now)` at `CommentCount: 2` (records the baseline; first-poll frame expected). Publish `new SingleCommentPostedBusEvent(prRef, reviewCommentId: 123)` on the real bus. Second `TickAsync(now + cadence)` at `CommentCount: 3`. Assert **no recorded `ActivePrUpdated` from the second tick has `CommentCountChanged: true`** (equivalently, none carries a positive `CommentCountDelta`).

- [ ] **Step 3: Verify it is RED on the current tree**

```bash
dotnet test PRism.sln --filter FullyQualifiedName~ActivePrPollerSelfPostNetting
```

Expect failure: on `main` the poller does not subscribe, so the second tick publishes `CommentCountChanged: true, CommentCountDelta: 1`. **Record the exact failure text — it goes in the PR's `## Proof`.**

**Verification:** the test fails on the *comment-frame* assertion (a real `ActivePrUpdated` with `CommentCountChanged: true` was published), not on a harness/compile gap.

---

### Task 2: The netting in `ActivePrPoller`

**Files:**
- Modify: `PRism.Core/PrDetail/ActivePrPoller.cs`

- [ ] **Step 1: Credit state + subscription**

- Add a lock-guarded per-PR credit map (separate from `_state`):
  ```csharp
  private const int SelfPostCreditTtlTicks = 2;
  private readonly object _pendingLock = new();
  private readonly Dictionary<PrReference, PendingSelfPosts> _pendingSelfPosts = new();
  private sealed class PendingSelfPosts { public int Count; public int StaleTicks; }
  private IDisposable? _singleCommentSubscription;
  ```
- In the constructor (after `_bus = bus;`), subscribe — mirroring `PrDetailLoader.cs:120`:
  ```csharp
  _singleCommentSubscription = bus.Subscribe<SingleCommentPostedBusEvent>(e => CreditSelfPost(e.PrRef));
  ```
- `CreditSelfPost`:
  ```csharp
  private void CreditSelfPost(PrReference prRef)
  {
      lock (_pendingLock)
      {
          if (!_pendingSelfPosts.TryGetValue(prRef, out var p))
              _pendingSelfPosts[prRef] = p = new PendingSelfPosts();
          p.Count += 1;
          p.StaleTicks = 0;
      }
  }
  ```

- [ ] **Step 2: Net the credit each tick**

Add a helper that consumes + ages + expires, run **once per candidate per tick**:
```csharp
// Returns the externally-caused portion of this tick's raw comment-count rise, after
// netting out self-posts PRism originated. Ages unconsumed credit; expires it after
// SelfPostCreditTtlTicks so a never-reconciled self-post cannot linger and later consume a
// much-later foreign rise. Expiry bounds — it does not eliminate — the deletion/never-landing
// residual (spec §4-G): a credit consumed by a foreign rise before it ages out is that
// residual, closed only by id-based netting (spec §8).
private int ExternalCommentDelta(PrReference prRef, int rawDelta)
{
    lock (_pendingLock)
    {
        if (!_pendingSelfPosts.TryGetValue(prRef, out var p) || p.Count == 0)
            return rawDelta;
        var consumed = rawDelta > 0 ? Math.Min(p.Count, rawDelta) : 0;
        p.Count -= consumed;
        if (consumed > 0) p.StaleTicks = 0;
        else if (++p.StaleTicks >= SelfPostCreditTtlTicks) p.Count = 0;
        if (p.Count == 0) _pendingSelfPosts.Remove(prRef);
        return rawDelta - consumed;
    }
}
```

In the per-candidate loop, compute `rawDelta` and `externalDelta` **before** the comment gate at `:286`:
```csharp
var rawDelta = state.LastCommentCount is { } priorCount ? snapshot.CommentCount - priorCount : 0;
var externalDelta = ExternalCommentDelta(prRef, rawDelta);
```
Change the gate (`:286`) to require an external change:
```csharp
var commentChanged = state.LastCommentCount is { } pc && pc != snapshot.CommentCount && externalDelta != 0;
```
Replace the published delta (`:318`) with `externalDelta`:
```csharp
CommentCountDelta: externalDelta,
```
`LastCommentCount` still advances unconditionally at `:342` — **do not move it**.

- [ ] **Step 3: Clear credits on firstPoll**

`firstPoll` is already computed at `:279`. When it is true for a candidate, drop that PR's credits — the self-rise is folded into the baseline, so any credit predating it is orphaned:
```csharp
if (firstPoll)
    lock (_pendingLock) { _pendingSelfPosts.Remove(prRef); }
```
Place this so it runs regardless of whether the tick publishes (it is a credit-lifecycle step, not a publish-gated one). It must not change `externalDelta` for the firstPoll tick — on firstPoll `rawDelta` is 0 (null baseline), so `ExternalCommentDelta` returns 0 and nets nothing anyway; the clear just removes the stale bucket.

- [ ] **Step 4: Prune credit with `_state`, and dispose**

- In the prune block (`:231-234`), after the `_state`/`_cache` prune, drop credit for PRs that lost all subscribers:
  ```csharp
  lock (_pendingLock)
  {
      foreach (var key in _pendingSelfPosts.Keys.Where(k => !live.Contains(k)).ToList())
          _pendingSelfPosts.Remove(key);
  }
  ```
- In `Dispose()` (before `base.Dispose()`), release the subscription:
  ```csharp
  _singleCommentSubscription?.Dispose();
  ```

- [ ] **Step 5: Confirm Task 1 is now GREEN**

```bash
dotnet test PRism.sln --filter FullyQualifiedName~ActivePrPollerSelfPostNetting
```

**Verification:** green. Falsify: temporarily comment out the `_singleCommentSubscription` line and confirm Task 1 goes red again (proves the subscription, not some unrelated gate, is what suppresses the frame).

---

### Task 3: Companion coverage

**Files:**
- Modify: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerSelfPostNettingTests.cs`

Same harness as Task 1.

| Test | Setup | Assert |
|---|---|---|
| teammate in the same window still banners | one `SingleCommentPostedBusEvent`; count rises `2 → 4` in one tick | one frame, `CommentCountChanged: true, CommentCountDelta: 1` |
| credit expires (fail-open) | one credit, then `N` ticks with no rise, then count rises `2 → 3` | the rise banners (`CommentCountDelta: 1`) — the stale credit did not swallow it |
| firstPoll clears the credit | publish a credit for a PR with no state, then run its **first** poll at a count already including the self-post (e.g. baseline `3`), then a foreign rise `3 → 4` | the foreign rise banners (`CommentCountDelta: 1`) — the orphan credit was cleared at baseline |
| deletion untouched | no credit; count drops `3 → 2` | `commentChanged: true` with negative delta (existing behavior preserved) |
| quiet tick | no credit; count unchanged | no comment frame (only the non-comment gates can fire) |

The teammate-in-window test is #740's hard constraint (an external change in the same poll window must still banner). Do **not** add a test asserting the deletion-in-window / never-landing residual is suppressed — that is a documented limitation (spec §4-G), not a behavior to pin green.

- [ ] **Step 1: Write the companions.**
- [ ] **Step 2: Run the two test files, then the full backend suite** (Task 4).

---

### Task 4: Quality pass, docs, and verification

- [ ] **Step 1: Run `/simplify`** on the diff (required before any PR). It runs 4 cleanup agents; apply what holds up.

- [ ] **Step 2: Full backend suite**
```bash
dotnet test PRism.sln
```
**Verification:** green. `AiUsageRollupTailer.StopAsync` and `EventsEndpointsTests` SSE-first-event are known flakes (issues #517/#536) — re-run once before investigating; neither is in this diff's blast radius.

- [ ] **Step 3: Documentation-maintenance scan.** Per `.ai/docs/documentation-maintenance.md`, check whether this change touches a documented surface. Expectation: **no doc edit needed** — no wire shape, no invariant, no command changed. `architectural-invariants.md:10` (*Banner, not mutation*) is **upheld, not amended** (G changes only whether a banner is raised, never what it does); do not edit it. If the scan disagrees, include the doc edit in this PR.

- [ ] **Step 4: The pre-push checklist from `.ai/docs/development-process.md`, verbatim.** Not a self-curated subset. (Frontend lint/tsc/vitest are unaffected but the checklist still runs them.)

- [ ] **Step 5: Restore e2e collateral.** Any local Playwright run rewrites the committed `review-assets/pr-344` PNGs (`pr-detail-refresh.spec.ts:49`). This plan needs no e2e run — but if one happened, `git checkout -- review-assets/` before staging.

**Verification (B1 visual gate).** #740 is `needs-design`; the rendered-chrome claim must be shown, not asserted. Serve the app detached against the **real** DataDir (`scripts/serve-detached.ps1`, never `-Reset`), open a real PR with review threads (`mindbody/Mindbody.Clients#973`):
1. Post an inline comment through PRism; confirm across one full poll tick (~30s) that **no banner appears**.
2. From github.com, add a comment as another identity; confirm the banner **does** appear reading `1 new comment — Reload to view`.
3. Post through PRism **and** (as another identity) on github.com within the same ~30s window; confirm the banner appears reading `1 new comment` (the teammate is announced; the self-post is netted).

Screenshot each; they go on the PR. (Review submit is out of scope this PR — spec §8 — so it is not part of the visual gate.)

---

## Risks

| Risk | Mitigation |
|---|---|
| A deletion or a never-landing self-post interleaves with a foreign comment in one poll window → the foreign comment's banner nudge is missed | Documented bounded residual (spec §4-G): the comment is not lost (visible on reload / next frame), the exposure is bounded by expiry, and it is the same risk class as the pre-existing `first:100` blind spot. The complete fix is id-based netting (spec §8). |
| A self-post credit is never reconciled and later consumes a much-later foreign rise | Credit ages per tick and expires after `N = 2` ticks (Task 2 Step 2), bounding an unconsumed orphan's life to ≈60s. |
| A credit created before a PR's first poll orphans (self-rise folded into the baseline) | firstPoll clears the PR's credits (Task 2 Step 3), with a dedicated companion test (Task 3). |
| Concurrency between the write thread (`bus.Publish`) and the poller thread on the credit map | One lock around every credit read/write (Task 2). Comment posts are rare; contention is negligible. `ActivePrPollerState` stays tick-only. |
| Subscription leaks if the poller is disposed and recreated | `Dispose()` releases the subscription (Task 2 Step 4), mirroring `PrDetailLoader`. |
| A comment beyond `reviewThreads(first:100)` never triggers | Pre-existing on `main`, unchanged. Tracked in spec §8. |
