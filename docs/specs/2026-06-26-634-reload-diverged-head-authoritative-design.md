# #634 — `/reload` diverged-head branch trusts the cached head as authoritative even when the client head may be newer

**Issue:** [#634](https://github.com/prpande/PRism/issues/634) · **Tier:** T2 · **Risk:** hands-off
**Status:** spec for one backend correctness fix; follow-up to #611 (PR #632), where this
was documented as adversarial finding F4 / residual risk. Single clear cause, one design
choice (how to establish head ordering — owner chose "consult GitHub"), checkable
acceptance criteria. Revised once after a `ce-doc-review` pass (dispositions at the bottom).

## The bug

`PRism.Web/Endpoints/PrReloadEndpoints.cs` (Phase 2 head-shift guard, inside `store.UpdateAsync`):

```csharp
var cached = activePrCache.GetCurrent(prRef);
if (cached is null) { headUnverified = true; return state; }   // #611 cold-cache path
if (cached.HeadSha != request.HeadSha)
{
    currentHeadShaForRetry = cached.HeadSha;   // → 409 reload-stale-head; FE retries with this sha
    return state;
}
```

On a diverged head the endpoint returns the **cached** sha as the retry target, **assuming
the poller-populated cache is the newer of the two heads.** But the two heads come from
*independent* GitHub reads:

- `request.HeadSha` ← `data.pr.headSha`, the **PR-detail snapshot** (`PrDetailView.tsx:166` →
  `usePrDetail` GET), set whenever PR-detail (re)fetches.
- `cached.HeadSha` ← the active-PR poller (`ActivePrPoller`, ≤30s cadence), which since #598
  Slice B hydrates the cache via one batched GraphQL read (`IActivePrBatchReader.PollBatchAsync`).

Because they are independent reads, the cache **can lag** the client head. When it does, the
auto-retry reconciles against a **staler** head than the client already had — the exact
inversion of the guard's intent.

## Reachability and severity (why this is tech-debt, not a P-class bug)

The inversion requires, inside one ≤30s poll gap: a **standing banner from a *prior* update**
(the Reload affordance is poll-gated — see #611 spec finding F1 — so a banner must already be
showing, e.g. from a comment-count change), **a force-push**, and **a PR-detail refetch**
(navigation, or an own-comment SSE → `usePrDetail.reload()`) that pulls the new head — all
before the poller re-polls. The common force-push case is *not* affected by the **inversion**:
there the poller observes the new head first (it is what raises the banner), so the cache is the
newer head and the existing auto-retry returns a correct (newer) head.

When the inversion does hit, the consequence is bounded: the retry reconciles against the head
the drafts were authored on (largely a no-op for staleness detection), the next poll (≤30s)
raises a fresh banner that reconciles correctly, and submit has its own head-shift guard
(`headShaDrift`) as a backstop. So the worst case is "staleness flagging delayed ≤30s," which
is why the issue is labelled `tech-debt`, not a defect. We still fix it because the guard makes
a correctness claim it does not actually hold.

## The crux

Head SHAs are opaque — they cannot be ordered without consulting GitHub. The cache's
`ObservedAt` records *when we read* a head, not whether GitHub has since moved past it. So the
only authoritative ordering is GitHub itself. The cache is a fast-path hint, not an authority.

## Fix (Approach A — consult GitHub for the authoritative head on diverge)

Demote the cache from "authority" to "fast-path hint." On the diverged branch, read GitHub's
**actual current head** and decide against that instead of trusting the cache blindly.

**Use `IActivePrBatchReader.PollBatchAsync([prRef])` for the authoritative read — the same seam
the poller uses to populate the cache.** This matters for correctness, not just tidiness:

- **Same transport as the cache (no cross-API skew).** The cache is hydrated by GraphQL
  (`IActivePrBatchReader`). Reading the authoritative head over a *different* transport — e.g.
  the per-ref REST `IPrReader.PollActivePrAsync` — would expose us to GitHub's REST-vs-GraphQL
  replication skew: REST could briefly return the *old* head while the GraphQL-populated cache
  already holds the new one, reintroducing a variant of the staleness bug. Reading via the same
  GraphQL seam keeps the authoritative read and the cache replication-consistent.
- **Cheaper.** `PollBatchAsync([prRef])` is one aliased GraphQL query; the REST alternative is
  three round-trips (`PollActivePrAsync` issues pull-detail + comments-count + reviews-count) of
  which we'd use only the head SHA.
- **Architecturally consistent.** #598 Slice B deliberately removed the per-ref REST fan-out
  from the poll path; routing this read through REST would partially reintroduce it.

Decision logic on the diverged branch (`cached.HeadSha != request.HeadSha`):

```csharp
IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>? authoritative = null;
try
{
    authoritative = await batchReader.PollBatchAsync(new[] { prRef }, ct).ConfigureAwait(false);
}
catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }  // genuine cancellation
catch (Exception) { /* ANY read failure (rate-limit, transport, poison) → fall back to cache */ }

if (authoritative is null
    || !authoritative.TryGetValue(prRef, out var snap)
    || string.IsNullOrEmpty(snap.HeadSha))
{
    // Could not read an authoritative head (read threw — rate-limit / transport / poison — or GitHub
    // dropped this PR from the batch, the poller's per-alias "keep last-known" contract). Degrade to
    // today's behavior: return the cached head. No worse than the status quo, and the inversion (if
    // any) self-heals on the next poll. Crucially this avoids a NEW 500 path — important because for a
    // zero-draft session Phase 1's reconcile makes no GitHub call, so this is the ONLY external read.
    currentHeadShaForRetry = cached.HeadSha;
}
else if (snap.HeadSha != request.HeadSha)
{
    // GitHub's current head differs from the client's → the client head IS stale. Return
    // GitHub's head (not the cache's) as the authoritative retry target.
    currentHeadShaForRetry = snap.HeadSha;
}
// else: GitHub's head == request.HeadSha → the client head IS current and the cache was merely
// lagging → fall through to the apply (the matching-head happy path).
```

The cold-cache (`cached is null`) branch from #611 is **unchanged** — it still returns
`reload-head-unverified` and lets the next poll warm the cache.

### Restructure: move the head-shift guard *out* of `store.UpdateAsync`

`PollBatchAsync` is a network call and must **not** run inside the state-store gate (the gate
must be held only briefly for the apply; a GitHub round-trip inside it would block every
concurrent writer). So the head-shift guard moves to run **after** the Phase 1 reconcile but
**before** `store.UpdateAsync`. `UpdateAsync` then does the apply only — no head check inside.

**Why the guard stays *after* Phase 1 reconcile (not before it).** Placing the guard before the
reconcile would save the reconcile work on the diverged-refusal path (see cost note below), but
#611's guard exists to catch a head shift in the window between head-verification and the apply
— so it must verify the head as *late as possible* before applying. Reconcile does network I/O
(file/diff fetches) that takes real time; checking the head *after* it minimizes that window.
Moving the check earlier would *widen* the window by the reconcile duration, weakening the exact
guarantee the guard provides. We accept the wasted reconcile on the refusal path (cheap for a
single-user local tool) to keep the window tight.

The "no side effects on a refused reload" contract (no tab stamp, no `StateChanged`) is
**strengthened** by the move: today the cold/diverged cases enter `UpdateAsync` only to `return
state` unchanged; now every refusal branch returns *before* `UpdateAsync` is ever entered, so the
apply transform — the only writer of the tab stamp and the only path to `bus.Publish` — is
structurally unreachable on a refusal.

### Cost: this read fires on the *common* force-push reload, not a rare edge

Be honest about frequency: the diverged branch (`cached.HeadSha != request.HeadSha`) is hit by
**every force-push reload**, which is the primary use of the Reload affordance —
`handleReload` posts `reconcile.reload()` with the *stale* `data.pr.headSha` before
`usePrDetail.reload()` refetches the detail, while the cache already holds the poller-observed
new head. So the authoritative read is a **routine** cost of the force-push reload path, not a
rare-edge cost. For a single-user local tool one extra GraphQL read per deliberate force-push
reload is acceptable, and the rate-limit interaction is handled by the fall-back-to-cache branch
above (a rate-limited read degrades to today's behavior rather than erroring). The matching-head
happy path (cache already equals the client head — e.g. a reload with no force-push) never enters
the diverged branch and makes **no** extra read.

### Why these specific choices

- **Consult GitHub, don't trust the cache (vs. keeping cache-as-authority).** The cache cannot
  establish ordering; GitHub can. This is the whole point of the issue.
- **GraphQL batch reader, not REST `PollActivePrAsync`** — transport-consistency with the cache,
  cheaper, architecturally consistent (see the three bullets above).
- **Proceed when `snap.HeadSha == request.HeadSha` (vs. always 409 on cache-disagree).**
  Collapsing every cache-disagreement into a 409 (`reload-head-unverified`) would regress the
  *common* force-push case — today it auto-retries silently; that variant would force a second
  manual click. Fixing a rare inversion by degrading the common path is the wrong trade
  (rejected option B from intake).
- **Don't blindly trust the client head (vs. reconcile against `request.HeadSha` on diverge).**
  That is exactly the "reconcile against an unverified client head" that #611's guard exists to
  prevent (rejected option C from intake).
- **Fall back to the cached head on ANY read failure / per-alias drop (vs. erroring).** A failed
  authoritative read — rate-limit, transport (`HttpRequestException`), or poison payload
  (`JsonException`) — degrades to today's behavior (return the cached head), never to a new 500
  (only genuine `ct` cancellation propagates). This mirrors `ActivePrPoller`'s own whole-tick-abort
  handling of this exact `PollBatchAsync` call (retain last-known). A narrower catch (rate-limit
  only) would introduce a new 500 on the common force-push reload of a **zero-draft** session,
  where Phase 1's reconcile makes no GitHub call and this is the only external read — that read was
  a no-network 409 before this change.
- **No FE change.** `reload-stale-head` keeps its exact wire shape (`error` discriminator +
  `currentHeadSha`); only the *value* of `currentHeadSha` changes (GitHub's head when the read
  succeeds, else the cached head). `useReconcile`'s single auto-retry is unchanged and was
  verified sound against the new value semantics (it posts the returned `currentHeadSha`,
  reconciles against it, and gives up after one retry — no loop).

## Out of scope / non-goals

- **FE-side handling** — none needed; the wire contract is unchanged.
- **A bespoke banner / delayed auto-retry for `reload-head-unverified`** — deferred in #611,
  still deferred here.
- **Sharing the poller's per-PR backoff state (`NextRetryAt`) with this read** — the read already
  degrades gracefully on `RateLimitExceededException`, so suppressing the call *before* it is made
  during a backoff window is a further optimization, not a correctness need. Deferred.
- **Re-reading GitHub on the cold-cache (`cached is null`) branch** — #611 deliberately returns
  `reload-head-unverified` there and lets the next poll warm the cache; #634 does not revisit
  that decision.

## Residual risks (acknowledged)

- **The authoritative read is itself a point-in-time snapshot.** Between `PollBatchAsync`
  returning and the Phase 2 apply, GitHub's head could move again. The per-PR semaphore
  serializes reloads (not force-pushes), so this narrows the window (≤30s cache lag → sub-ms
  apply window) rather than closing it. Uncloseable without a transactional GitHub read; self-heals
  on the next poll.
- **One extra GraphQL read on the (common) force-push reload path** counts against rate limits.
  Quantified above; acceptable for a single-user local tool, and rate-limited reads degrade to the
  cached head rather than failing.

## Test plan (`tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs`)

The new tests control **two** seams independently: the cache head (`IActivePrCache.GetCurrent`,
via the existing `FakeCacheWithSnapshot`) and GitHub's authoritative head
(`IActivePrBatchReader.PollBatchAsync`). Both are registered per-test via `WithWebHostBuilder` +
`CreateAuthenticatedClient`, mirroring the existing `Reload_with_diverged_cached_head` pattern.

> **Implementation note (must-do).** The default `PRismWebApplicationFactory` wires the **real**
> `GitHubActivePrBatchReader` (live network). Every test that reaches the diverged branch MUST
> register a fake `IActivePrBatchReader`, or the endpoint will make a live call to the nonexistent
> `acme/api/NNNN` repo and the asserted 409/200 becomes a transport failure. A small per-test fake
> `IActivePrBatchReader` (returns a configured `ActivePrPollSnapshot` for `prRef`, or throws /
> returns an empty dict for the failure cases) supplies the authoritative head. A zero-draft seed
> session makes no `IPrReader` file-content calls in `ReconcileAsync`, so the default (real)
> `IPrReader` is never hit on these paths — only the batch reader needs faking.

- **New (red on main) — cache stale, client head IS authoritative ⇒ `200`.** Cache returns head
  `C`; request sends head `R` (`R != C`); the fake batch reader returns `R` (GitHub agrees with the
  client). Expect `200` + session DTO. **Red on main:** today the diverged branch returns
  `409 reload-stale-head` with the stale cached head `C` regardless of GitHub. AC (1) + (3).
- **New — diverged, GitHub differs from the client ⇒ `409 reload-stale-head` with GitHub's head.**
  Cache returns `C`; request sends `R`; the fake batch reader returns `G` (`G != R`, `G != C`).
  Expect `409` with `currentHeadSha == G` (the authoritative head, **not** the cached `C`). Pins
  AC (2). (On main this returns `C`.)
- **New — diverged, authoritative read unavailable ⇒ `409 reload-stale-head` with the CACHED head,
  no side effects.** Cache returns `C`; request sends `R`; the fake batch reader throws
  `RateLimitExceededException` (or returns a dict without `prRef`). Expect `409` with
  `currentHeadSha == C` (graceful degrade to today's behavior). **Also assert the no-side-effects
  contract on this refusal branch**: no tab stamp under the caller's tab id, and no `StateChanged`
  published (via a `FakeReviewEventBus`, mirroring the existing cold-cache no-side-effects test).
  Pins AC (4) on the new code path. (No `reload-head-unverified` is emitted here — the cold-cache
  branch, which still emits it, is unchanged and retains its own test.)
- **Rework existing `Reload_with_diverged_cached_head_returns_409_reload_stale_head`.** Under the
  new behavior the diverged branch consults the batch reader, so this test must register a fake
  `IActivePrBatchReader` returning a chosen authoritative head `G != request` and assert
  `currentHeadSha == G` (not the cached sha). The `error` discriminator wire-shape pin is retained.
- **Unchanged:** the matching-head happy path (`Reload_happy_path_returns_full_session_dto`),
  tab-stamp write, cold-cache `reload-head-unverified`, cold-cache no-side-effects, and all
  validation tests (tab-id, sha-format, null/missing headSha). The matching-head path never enters
  the diverged branch, so it makes no `PollBatchAsync` call and needs no batch-reader fake.

## Acceptance criteria

1. On a diverged head, when the authoritative GitHub read succeeds the retry target is **GitHub's**
   current head, **never** the poller cache's head.
2. Diverged + GitHub's head differs from the client ⇒ `409 reload-stale-head` carrying GitHub's
   head as `currentHeadSha`.
3. Diverged + GitHub's head equals the client head (cache merely lagging) ⇒ reconcile proceeds,
   `200`, no regression.
4. The refused-reload no-side-effects contract holds (no tab stamp, no `StateChanged`) on every
   refusal branch, including the new authoritative-read-unavailable fallback. **Any** read failure
   (rate-limit, transport, poison payload, or per-alias drop) degrades to returning the cached head,
   not a 500 — only a genuine request cancellation propagates.

## ce-doc-review dispositions (1× pass — hands-off T2 gate substitution)

- **Adversarial P1 — "same primitive the poller uses" is false + cross-transport skew:**
  **Applied.** Switched the authoritative-read seam from `IPrReader.PollActivePrAsync` (REST) to
  `IActivePrBatchReader.PollBatchAsync` (the GraphQL seam the poller actually uses since #598
  Slice B), eliminating REST/GraphQL replication skew. Rewrote the rationale.
- **Feasibility P3 — poller no longer uses `PollActivePrAsync`:** **Applied** (same fix as above).
- **Adversarial P2 — extra read is the common path, not rare + rate-limit spiral:** **Applied.**
  Added a "Cost" section stating the read fires on every force-push reload, and a
  fall-back-to-cache-on-read-failure branch so a rate-limited read degrades to today's behavior
  instead of a new 500 that would invite re-clicks.
- **Feasibility P3 — "one read" is actually 3 REST calls:** **Applied/superseded** — the batch
  reader is one GraphQL read; cost section reworded accordingly.
- **Coherence P2 — AC(4) names three refusal branches; test plan covered one:** **Applied.** The
  new authoritative-read-unavailable test now explicitly asserts no tab stamp + no `StateChanged`,
  and the spec states the structural guarantee (all refusals return before `UpdateAsync`).
- **Adversarial P3 (FYI) — guard after Phase 1 wastes reconcile:** **Applied as documentation** —
  kept the guard after reconcile (to minimize the head-shift window per #611's intent) and added an
  explicit rationale + accepted-cost note rather than moving it.
- **Product-lens P3 (FYI) — is this worth fixing at all:** **Acknowledged.** The premise (fix vs.
  document-as-known-bounded) was put to the owner at intake; the owner chose to fix (Approach A).
  The sub-concern it raised — a new 500 failure mode — is eliminated by the fall-back-to-cache branch.

## Preflight adversarial-review disposition (pr-autopilot step 02)

- **Important — catch covered only `RateLimitExceededException`, leaving a new 500 on transport/poison
  failures of the only external read for a zero-draft force-push reload:** **Applied.** Broadened the
  catch to fall back to the cached head on any read failure (with an `OperationCanceledException`
  rethrow guard for genuine cancellation), mirroring `ActivePrPoller`'s handling of the same
  `PollBatchAsync` call. Added a regression test (`...transport_error...`) that is red against the
  narrow catch. The retry-target collapse, unverified-head guard, semaphore interaction, and test
  correctness were reviewed and found solid.

Full backend pre-push checklist (`.ai/docs/development-process.md`) before PR.
