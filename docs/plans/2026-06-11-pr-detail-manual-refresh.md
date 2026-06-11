# PR-detail manual Refresh button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a proactive manual "Refresh" control to the PR-detail view that force-re-reads the PR from GitHub (bypassing the head-SHA-keyed snapshot cache), mirroring the shipped inbox refresh (#341).

**Architecture:** Backend adds `PrDetailLoader.RefreshAsync` (force-fresh fetch + atomic cache overwrite) behind a new `POST /api/pr/{owner}/{repo}/{number}/refresh` endpoint with the inbox's honest-completion 200/503 contract. Frontend adds a `usePrDetailRefresh` hook (mirror of `useInboxRefresh`) and a shared `RefreshButton` (generalized from the inbox one), wired into the PR-detail header. **No `ActivePrPoller` changes.**

**Tech Stack:** .NET 10 minimal APIs + xUnit/FluentAssertions (backend); React + Vite + TypeScript + vitest (frontend); Playwright (e2e/visual).

**Spec:** [`docs/specs/2026-06-11-pr-detail-manual-refresh-design.md`](../specs/2026-06-11-pr-detail-manual-refresh-design.md).

**Tooling notes (this repo):**
- Frontend tests: use the **local** binary `frontend/node_modules/.bin/vitest`, **never `npx vitest`** (npx grabs a cached jsdom-ignoring binary). Typecheck with `tsc -b` (`npm run build`), not `tsc --noEmit`.
- Lint/format: verify Prettier with `rtk proxy npx prettier --check` (the rtk proxy masks the real exit code).
- Backend: `dotnet test` with `--filter` (≥ 5 min timeout). Run one build/test command at a time.
- Full pre-push checklist: [`.ai/docs/development-process.md`](../../.ai/docs/development-process.md).

---

## File structure

**Backend**
- Modify `PRism.Core/PrDetail/PrDetailLoader.cs` — extract `ComposeSnapshotAsync`, refactor `LoadAsync`, add `RefreshAsync`.
- Create `PRism.Web/Endpoints/PrRefreshEndpoints.cs` — the `POST /refresh` endpoint.
- Modify `PRism.Web/Program.cs:334` — register `app.MapPrRefreshEndpoints();`.
- Modify `tests/PRism.Web.Tests/TestHelpers/PrDetailFakeReviewService.cs` — add a `GetPrDetailAsyncOverride` throw-hook.
- Modify `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs` — `RefreshAsync` unit tests.
- Create `tests/PRism.Web.Tests/Endpoints/PrRefreshEndpointTests.cs` — endpoint contract tests.

**Frontend**
- Create `frontend/src/components/controls/RefreshButton.tsx` — generalized shared button (moved from Inbox).
- Delete `frontend/src/components/Inbox/RefreshButton.tsx`; move/update its test to `frontend/src/components/controls/RefreshButton.test.tsx`.
- Modify `frontend/src/components/Inbox/filters/FilterBar.tsx:9` — update the import path + pass inbox strings.
- Modify `frontend/src/api/prDetail.ts` — add `refreshPrDetail`.
- Create `frontend/src/hooks/usePrDetailRefresh.ts` + `frontend/__tests__/usePrDetailRefresh.test.tsx`.
- Modify `frontend/src/components/PrDetail/PrHeader.tsx` — accept refresh props, render `RefreshButton` in `prActions`.
- Modify `frontend/src/components/PrDetail/PrDetailView.tsx` — instantiate the hook, announcer, LoadingBar, toast wiring.

**e2e**
- Create/extend a Playwright spec under `frontend/e2e/` — refresh morph + light/dark header screenshots.

---

## Task 1: Extract `ComposeSnapshotAsync` from `LoadAsync` (pure refactor)

**Files:**
- Modify: `PRism.Core/PrDetail/PrDetailLoader.cs`
- Test (regression guard, existing): `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs`

- [ ] **Step 1: Confirm the existing loader tests pass on the branch (baseline green)**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~PrDetailLoaderTests"`
Expected: PASS (all existing tests). This is the regression guard for the extraction.

- [ ] **Step 2: Extract the compose block into a private helper**

In `PrDetailLoader.cs`, the body of `LoadAsync` from the timeline fetch through snapshot construction (currently ~lines 145–160) becomes a private method. Add:

```csharp
private async Task<PrDetailSnapshot> ComposeSnapshotAsync(
    PrReference prRef, PrDetailDto detail, int generation, CancellationToken ct)
{
    var timeline = await _review.GetTimelineAsync(prRef, ct).ConfigureAwait(false);

    var commitDtos = timeline.Commits
        .Select(c => new CommitDto(c.Sha, c.Message, c.CommittedDate, c.Additions, c.Deletions))
        .ToArray();
    var commitShaSet = new HashSet<string>(timeline.Commits.Select(c => c.Sha), StringComparer.Ordinal);

    var (quality, iterations) = DetermineQuality(timeline, commitShaSet);

    var finalDetail = detail with
    {
        ClusteringQuality = quality,
        Iterations = iterations,
        Commits = commitDtos,
    };
    return new PrDetailSnapshot(finalDetail, detail.Pr.HeadSha, generation);
}
```

- [ ] **Step 3: Rewrite `LoadAsync` to call the helper, preserving its semantics exactly**

Replace the extracted lines in `LoadAsync` so the section after the realKey re-probe reads:

```csharp
        var snapshot = await ComposeSnapshotAsync(prRef, detail, generation, ct).ConfigureAwait(false);

        // Re-check the generation before publishing into the cache (unchanged from prior behavior).
        if (Volatile.Read(ref _generation) != generation)
        {
            return snapshot;
        }

        var canonical = _snapshots.GetOrAdd(realKey, snapshot);
        _snapshotKeyByPrRef[prRef] = realKey;
        return canonical;
```

Keep everything above (the `PollActivePrAsync` probe, the `pollKey`/`realKey` double-probe, the early cache-hit returns) byte-for-byte as it was. The only change is that the timeline+cluster+compose lines now live in `ComposeSnapshotAsync`.

- [ ] **Step 4: Run the loader tests — they must still pass (proves no behavior change)**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~PrDetailLoaderTests"`
Expected: PASS — identical to Step 1. If any test changed outcome, the extraction altered behavior; revert and redo.

- [ ] **Step 5: Commit**

```bash
git -C D:/src/PRism-344 add PRism.Core/PrDetail/PrDetailLoader.cs
git -C D:/src/PRism-344 commit -m "refactor(#344): extract ComposeSnapshotAsync from PrDetailLoader.LoadAsync"
```

---

## Task 2: Add `PrDetailLoader.RefreshAsync`

**Files:**
- Modify: `PRism.Core/PrDetail/PrDetailLoader.cs`
- Test: `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs`

- [ ] **Step 1: Write the failing tests**

Append to `PrDetailLoaderTests.cs`. Reuse the file's **existing** helpers: `MakeLoader(review, clusterer?, configStore?, bus?)` (line ~58), `FakePrDetailReviewService(calls?)` with `DefaultDetailResponse`/`DefaultTimelineResponse` (records `"GetPrDetail"`/`"GetTimeline"`/`"PollActivePr"` into the `calls` list), `MakeDetail(...)`, `MakeTimeline(n)`, and `FakeConfigStore` (whose `RaiseChanged()` fires the loader's `Changed` subscription → `InvalidateAll` → generation bump). Do **not** invent new fakes.

```csharp
[Fact]
public async Task RefreshAsync_force_refetches_even_on_warm_cache_with_unchanged_head()
{
    var calls = new List<string>();
    var review = new FakePrDetailReviewService(calls);
    review.DefaultDetailResponse = MakeDetail(headSha: "head1");
    review.DefaultTimelineResponse = MakeTimeline(1);
    var loader = MakeLoader(review);

    // Prime the cache (snapshot A) at head1.
    var first = await loader.LoadAsync(Pr1, CancellationToken.None);
    first.Should().NotBeNull();
    calls.Count(c => c == "GetPrDetail").Should().Be(1, "cold load fetches once");

    // Force refresh — head SHA is unchanged, so a plain reload would be a cache hit.
    var refreshed = await loader.RefreshAsync(Pr1, CancellationToken.None);

    refreshed.Should().NotBeNull();
    calls.Count(c => c == "GetPrDetail").Should().Be(2, "RefreshAsync re-fetches despite the warm cache");
    loader.TryGetCachedSnapshot(Pr1).Should().BeSameAs(refreshed, "the fresh snapshot replaced the cached one");
    refreshed.Should().NotBeSameAs(first, "force-fresh composes and commits a new snapshot");
}

[Fact]
public async Task RefreshAsync_returns_null_when_detail_is_gone()
{
    var review = new FakePrDetailReviewService();
    review.DefaultDetailResponse = null;
    var loader = MakeLoader(review);

    var result = await loader.RefreshAsync(Pr1, CancellationToken.None);

    result.Should().BeNull("GetPrDetail null => PR not found => endpoint maps 404");
}

[Fact]
public async Task RefreshAsync_returns_uncached_when_generation_bumps_midflight()
{
    var review = new FakePrDetailReviewService();
    review.DefaultDetailResponse = MakeDetail(headSha: "head1");
    review.DefaultTimelineResponse = MakeTimeline(1);     // ≥1 commit so the clusterer runs
    var configStore = new FakeConfigStore();
    // Cluster() runs inside ComposeSnapshotAsync (after the detail fetch, before the cache
    // commit). Firing Changed there bumps the loader's generation via OnConfigChanged ->
    // InvalidateAll, so RefreshAsync's generation re-check returns the snapshot uncached.
    var clusterer = new InvalidatingClusterer(configStore);
    var loader = MakeLoader(review, clusterer: clusterer, configStore: configStore);

    var snapshot = await loader.RefreshAsync(Pr1, CancellationToken.None);

    snapshot.Should().NotBeNull("caller still gets fresh data");
    loader.TryGetCachedSnapshot(Pr1).Should().BeNull("a generation bump mid-flight leaves the result uncached");
}
```

Add this tiny test-local clusterer near the bottom of the test file (next to `RecordingClusterer`):

```csharp
// Fires the config store's Changed event from inside Cluster() to simulate a hot-reload
// landing mid-compose; returns null (=> ClusteringQuality.Low), which is irrelevant to the test.
private sealed class InvalidatingClusterer : IIterationClusteringStrategy
{
    private readonly FakeConfigStore _configStore;
    public InvalidatingClusterer(FakeConfigStore configStore) => _configStore = configStore;
    public IReadOnlyList<IterationCluster>? Cluster(ClusteringInput input, IterationClusteringCoefficients coefficients)
    {
        _configStore.RaiseChanged();
        return null;
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~RefreshAsync"`
Expected: FAIL — `RefreshAsync` does not exist (compile error).

- [ ] **Step 3: Implement `RefreshAsync`**

Add to `PrDetailLoader.cs` (next to `LoadAsync`):

```csharp
/// <summary>
/// Force-refreshes the snapshot for <paramref name="prRef"/>, bypassing the snapshot cache
/// (#344 manual Refresh). Re-fetches PR detail + timeline, re-clusters, and atomically
/// REPLACES the cached snapshot (overwrite, not GetOrAdd) so a warm cache with an unchanged
/// head SHA still yields fresh data — the proactive analog of the inbox's hardRefresh.
/// Returns null when the PR no longer exists (GetPrDetail => null), mapped to 404 by the
/// endpoint. Lock-free by design: the two ConcurrentDictionary writes are individually
/// atomic and any interleave self-heals on the next LoadAsync (see spec § 3.1).
/// </summary>
public async Task<PrDetailSnapshot?> RefreshAsync(PrReference prRef, CancellationToken ct)
{
    ArgumentNullException.ThrowIfNull(prRef);
    var generation = Volatile.Read(ref _generation);
    var detail = await _review.GetPrDetailAsync(prRef, ct).ConfigureAwait(false);
    if (detail is null) return null;

    var snapshot = await ComposeSnapshotAsync(prRef, detail, generation, ct).ConfigureAwait(false);

    // If InvalidateAll ran mid-flight (config hot-reload), our snapshot is keyed to a stale
    // generation — return it uncached. Mirrors LoadAsync's generation re-check.
    if (Volatile.Read(ref _generation) != generation) return snapshot;

    var realKey = CacheKey(prRef, detail.Pr.HeadSha, generation);
    _snapshots[realKey] = snapshot;          // overwrite — force-fresh wins
    _snapshotKeyByPrRef[prRef] = realKey;
    return snapshot;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~RefreshAsync"`
Expected: PASS (3 tests). Then re-run the full `PrDetailLoaderTests` filter to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git -C D:/src/PRism-344 add PRism.Core/PrDetail/PrDetailLoader.cs tests/PRism.Core.Tests/PrDetail/PrDetailLoaderTests.cs
git -C D:/src/PRism-344 commit -m "feat(#344): add PrDetailLoader.RefreshAsync (force-fresh cache-bypass)"
```

---

## Task 3: Add `POST /api/pr/{owner}/{repo}/{number}/refresh` endpoint

**Files:**
- Create: `PRism.Web/Endpoints/PrRefreshEndpoints.cs`
- Modify: `PRism.Web/Program.cs:334` (register after `MapPrReloadEndpoints`)
- Modify: `tests/PRism.Web.Tests/TestHelpers/PrDetailFakeReviewService.cs` (add throw-hook)
- Test: `tests/PRism.Web.Tests/Endpoints/PrRefreshEndpointTests.cs`

- [ ] **Step 1: Add a throw-hook to the fake review service**

In `PrDetailFakeReviewService.cs`, add an optional override and route `GetPrDetailAsync` through it:

```csharp
// #344: lets endpoint tests drive the RefreshAsync throw-before-commit path (a GitHub 429
// surfaces as a plain HttpRequestException, NOT RateLimitExceededException, on the PR-detail reader).
public Func<PrReference, CancellationToken, Task<PrDetailDto?>>? GetPrDetailAsyncOverride { get; set; }

public Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct)
    => GetPrDetailAsyncOverride is not null
        ? GetPrDetailAsyncOverride(reference, ct)
        : Task.FromResult(DetailResponses.TryGetValue(reference, out var v) ? v : DefaultDetailResponse);
```

(Replace the existing `GetPrDetailAsync` body with the conditional above.)

- [ ] **Step 2: Write the failing endpoint tests**

Create `tests/PRism.Web.Tests/Endpoints/PrRefreshEndpointTests.cs`:

```csharp
using System.Net;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class PrRefreshEndpointTests
{
    private static readonly PrReference Pr1 = new("owner", "repo", 7);

    private static PrDetailDto MakeDetail(string headSha) =>
        new(
            Pr: new Pr(Pr1, "Test PR", "body", "alice", "OPEN", headSha, "base1",
                "feat/x", "main", "MERGEABLE", "passing", false, false, DateTimeOffset.UtcNow, null),
            ClusteringQuality: ClusteringQuality.Ok, Iterations: null, Commits: Array.Empty<CommitDto>(),
            RootComments: Array.Empty<IssueCommentDto>(), ReviewComments: Array.Empty<ReviewThreadDto>(),
            TimelineCapHit: false);

    private static async Task<HttpResponseMessage> PostRefresh(HttpClient client, PrReference pr)
    {
        var uri = new Uri($"/api/pr/{pr.Owner}/{pr.Repo}/{pr.Number}/refresh", UriKind.Relative);
        using var req = new HttpRequestMessage(HttpMethod.Post, uri);
        req.Headers.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));
        return await client.SendAsync(req);
    }

    [Fact]
    public async Task Post_refresh_returns_200_on_success()
    {
        var fake = new PrDetailFakeReviewService { DefaultDetailResponse = MakeDetail("h1") };
        using var factory = new PRismWebApplicationFactory { ReviewServiceOverride = fake };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client, Pr1);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Post_refresh_returns_404_when_pr_gone()
    {
        var fake = new PrDetailFakeReviewService { DefaultDetailResponse = null };
        using var factory = new PRismWebApplicationFactory { ReviewServiceOverride = fake };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client, Pr1);

        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Post_refresh_returns_503_when_throws_and_view_did_not_advance()
    {
        var fake = new PrDetailFakeReviewService
        {
            DefaultDetailResponse = MakeDetail("h1"),
            GetPrDetailAsyncOverride = (_, _) =>
                throw new HttpRequestException("rate limited", null, HttpStatusCode.TooManyRequests),
        };
        using var factory = new PRismWebApplicationFactory { ReviewServiceOverride = fake };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client, Pr1);

        resp.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/pr/refresh-failed");
    }

    [Fact]
    public async Task Post_refresh_returns_200_when_throws_but_view_advanced()
    {
        // Honest-completion: the refresh's GetPrDetail throws, but a concurrent commit advanced
        // the cached snapshot first, so the committed view is fresh => 200 (not 503). The
        // lock-free loader makes the re-entrant RefreshAsync below safe (a _writerLock would deadlock).
        var fake = new PrDetailFakeReviewService { DefaultDetailResponse = MakeDetail("h1") };
        using var factory = new PRismWebApplicationFactory { ReviewServiceOverride = fake };
        var client = factory.CreateClient();
        var loader = factory.Services.GetRequiredService<PrDetailLoader>();

        // Prime the cache: `before` = snapshot at h1.
        await loader.LoadAsync(Pr1, default);

        var calls = 0;
        fake.GetPrDetailAsyncOverride = async (prRef, ct) =>
        {
            calls++;
            if (calls == 1)
            {
                // Simulate a concurrent actor committing a fresh snapshot at a new head, then throw.
                fake.DefaultDetailResponse = MakeDetail("h2");
                await loader.RefreshAsync(prRef, ct);   // re-enters override (calls==2) → commits h2
                throw new HttpRequestException("rate limited", null, HttpStatusCode.TooManyRequests);
            }
            return fake.DefaultDetailResponse;          // calls>=2: normal return → commit
        };

        var resp = await PostRefresh(client, Pr1);

        resp.StatusCode.Should().Be(HttpStatusCode.OK, "the committed view advanced past `before`");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PrRefreshEndpointTests"`
Expected: FAIL — endpoint route not mapped (404 for all) / `GetPrDetailAsyncOverride` compile error until Step 1 is in.

- [ ] **Step 4: Create the endpoint**

Create `PRism.Web/Endpoints/PrRefreshEndpoints.cs`:

```csharp
using PRism.Core;
using PRism.Core.PrDetail;

namespace PRism.Web.Endpoints;

internal static class PrRefreshEndpoints
{
    public static IEndpointRouteBuilder MapPrRefreshEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        // #344: proactive manual refresh of the PR-detail view. Forces a fresh GitHub re-read
        // (bypasses the (prRef, headSha, generation) snapshot cache) so an unchanged head SHA
        // still re-pulls. Empty 200 on success; the frontend then reloads via GET /api/pr/{ref}.
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/refresh",
            async (string owner, string repo, int number, PrDetailLoader loader, CancellationToken ct) =>
            {
                var prRef = new PrReference(owner, repo, number);
                var before = loader.TryGetCachedSnapshot(prRef);   // reference identity of committed snapshot
                try
                {
                    var snap = await loader.RefreshAsync(prRef, ct).ConfigureAwait(false);
                    return snap is null
                        ? Results.Problem(type: "/pr/not-found", statusCode: 404)
                        : Results.Ok();                            // fresh snapshot committed (incl. no-change)
                }
                catch (OperationCanceledException) { throw; }      // client aborted; not an error
#pragma warning disable CA1031 // intentional honest-completion catch-all; mirrors InboxEndpoints /refresh
                catch (Exception)
                {
                    // Honest-completion (semantic C, same as /api/inbox/refresh). ANY throw lands
                    // BEFORE RefreshAsync's overwrite, so this call did not commit. Return 200 iff
                    // a concurrent poller/GET advanced the committed view past `before`; else 503.
                    // The check lives in the generic catch (not a typed RateLimitExceededException
                    // catch) because GetPrDetail/GetTimeline surface a GitHub 429 as a plain
                    // HttpRequestException — the typed exception is inbox-only (spec § 3.2).
                    return ReferenceEquals(loader.TryGetCachedSnapshot(prRef), before)
                        ? Results.Problem(title: "PR refresh failed", statusCode: 503, type: "/pr/refresh-failed")
                        : Results.Ok();
                }
#pragma warning restore CA1031
            });

        return app;
    }
}
```

- [ ] **Step 5: Register the endpoint in `Program.cs`**

In `PRism.Web/Program.cs`, immediately after line 334 (`app.MapPrReloadEndpoints();`) add:

```csharp
app.MapPrRefreshEndpoints();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PrRefreshEndpointTests"`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git -C D:/src/PRism-344 add PRism.Web/Endpoints/PrRefreshEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/TestHelpers/PrDetailFakeReviewService.cs tests/PRism.Web.Tests/Endpoints/PrRefreshEndpointTests.cs
git -C D:/src/PRism-344 commit -m "feat(#344): POST /api/pr/{ref}/refresh with honest-completion 200/404/503"
```

---

## Task 4: Generalize + relocate the shared `RefreshButton`

**Files:**
- Create: `frontend/src/components/controls/RefreshButton.tsx`
- Delete: `frontend/src/components/Inbox/RefreshButton.tsx`
- Move/update: `frontend/src/components/Inbox/RefreshButton.test.tsx` → `frontend/src/components/controls/RefreshButton.test.tsx`
- Modify: `frontend/src/components/Inbox/filters/FilterBar.tsx:9`

- [ ] **Step 1: Update the test for the generalized API (move + parameterize), expect failure**

Create `frontend/src/components/controls/RefreshButton.test.tsx` by moving the existing
`Inbox/RefreshButton.test.tsx` and updating it to pass the new props. The component now takes
`label`, `refreshingLabel`, `title`, `testId`, `confirmTestId`. Keep the existing assertions but
drive them through props. Add a parity assertion for the inbox strings and one for PR-detail strings:

```tsx
import { render, screen } from '@testing-library/react';
import { RefreshButton } from './RefreshButton';

const inboxProps = {
  label: 'Refresh inbox',
  refreshingLabel: 'Refreshing inbox…',
  title: 'Refresh inbox',
  testId: 'inbox-refresh-button',
  confirmTestId: 'inbox-refresh-confirm',
};

it('idle: shows the refresh arrow with the accessible name', () => {
  render(<RefreshButton {...inboxProps} isRefreshing={false} justRefreshed={false} onRefresh={() => {}} />);
  const btn = screen.getByTestId('inbox-refresh-button');
  expect(btn).toHaveAttribute('aria-label', 'Refresh inbox');
  expect(btn).not.toBeDisabled();
});

it('refreshing: spinner + disabled + refreshing label', () => {
  render(<RefreshButton {...inboxProps} isRefreshing justRefreshed={false} onRefresh={() => {}} />);
  const btn = screen.getByTestId('inbox-refresh-button');
  expect(btn).toBeDisabled();
  expect(btn).toHaveAttribute('aria-label', 'Refreshing inbox…');
});

it('just-refreshed: shows the confirm checkmark, enabled', () => {
  render(<RefreshButton {...inboxProps} isRefreshing={false} justRefreshed onRefresh={() => {}} />);
  expect(screen.getByTestId('inbox-refresh-confirm')).toBeInTheDocument();
  expect(screen.getByTestId('inbox-refresh-button')).not.toBeDisabled();
});

it('parameterizes pr-detail strings + testids', () => {
  render(
    <RefreshButton
      label="Refresh PR" refreshingLabel="Refreshing PR…" title="Refresh PR"
      testId="pr-refresh-button" confirmTestId="pr-refresh-confirm"
      isRefreshing={false} justRefreshed onRefresh={() => {}}
    />,
  );
  expect(screen.getByTestId('pr-refresh-button')).toHaveAttribute('aria-label', 'Refresh PR');
  expect(screen.getByTestId('pr-refresh-confirm')).toBeInTheDocument();
});
```

Delete `frontend/src/components/Inbox/RefreshButton.test.tsx`.

Run: `frontend/node_modules/.bin/vitest run src/components/controls/RefreshButton.test.tsx` (from `frontend/`)
Expected: FAIL — `controls/RefreshButton` does not exist yet.

- [ ] **Step 2: Create the generalized component**

Create `frontend/src/components/controls/RefreshButton.tsx` (the SVG markup is the existing inbox
button's, with the strings/testids parameterized):

```tsx
import { Spinner } from '../Spinner/Spinner';

interface Props {
  isRefreshing: boolean;
  justRefreshed: boolean;
  onRefresh: () => void;
  /** Idle / completion accessible name (e.g. "Refresh inbox" / "Refresh PR"). */
  label: string;
  /** In-flight accessible name (e.g. "Refreshing inbox…"). */
  refreshingLabel: string;
  /** Native tooltip text. */
  title: string;
  testId: string;
  confirmTestId: string;
}

// Shared manual-refresh icon button (#341 inbox, #344 pr-detail). `btn btn-icon` (both classes —
// .btn supplies the inline-flex centering .btn-icon lacks). In-flight → decorative spinner; on
// success the circular-arrow briefly morphs to a checkmark; idle → circular-arrow. AT gets
// completion from the host's role=status region, so the icon swaps are aria-hidden and the
// accessible name stays `label`.
export function RefreshButton({
  isRefreshing,
  justRefreshed,
  onRefresh,
  label,
  refreshingLabel,
  title,
  testId,
  confirmTestId,
}: Props) {
  return (
    <button
      type="button"
      className="btn btn-icon"
      aria-label={isRefreshing ? refreshingLabel : label}
      title={title}
      disabled={isRefreshing}
      onClick={onRefresh}
      data-testid={testId}
    >
      {isRefreshing ? (
        <Spinner decorative size="sm" />
      ) : justRefreshed ? (
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true" focusable="false" data-testid={confirmTestId}
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true" focusable="false"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      )}
    </button>
  );
}
```

Delete `frontend/src/components/Inbox/RefreshButton.tsx`.

- [ ] **Step 3: Update the inbox call site**

In `frontend/src/components/Inbox/filters/FilterBar.tsx`, change the import (line 9) from
`import { RefreshButton } from '../RefreshButton';` to
`import { RefreshButton } from '../../controls/RefreshButton';` and update the render to pass the
inbox strings:

```tsx
<RefreshButton
  isRefreshing={isRefreshing}
  justRefreshed={justRefreshed}
  onRefresh={refresh}
  label="Refresh inbox"
  refreshingLabel="Refreshing inbox…"
  title="Refresh inbox"
  testId="inbox-refresh-button"
  confirmTestId="inbox-refresh-confirm"
/>
```

(Find the existing `<RefreshButton ... />` usage in `FilterBar.tsx` and replace it with the above, preserving the surrounding `isRefreshing`/`justRefreshed`/`refresh` variables it already has in scope.)

- [ ] **Step 4: Run the button test + the inbox FilterBar tests**

Run (from `frontend/`):
`frontend/node_modules/.bin/vitest run src/components/controls/RefreshButton.test.tsx src/components/Inbox`
Expected: PASS — button tests green, and the inbox renders the button identically (DOM unchanged).

- [ ] **Step 5: Typecheck (catches the moved import everywhere)**

Run (from `frontend/`): `npm run build`
Expected: `tsc -b` clean — no dangling `Inbox/RefreshButton` import remains.

- [ ] **Step 6: Commit**

```bash
git -C D:/src/PRism-344 add -A frontend/src/components/controls/RefreshButton.tsx frontend/src/components/controls/RefreshButton.test.tsx frontend/src/components/Inbox/filters/FilterBar.tsx
git -C D:/src/PRism-344 add -A   # stage the deletion of Inbox/RefreshButton.tsx + its test
git -C D:/src/PRism-344 commit -m "refactor(#344): generalize + relocate shared RefreshButton to controls/"
```

---

## Task 5: Add `refreshPrDetail` API client function

**Files:**
- Modify: `frontend/src/api/prDetail.ts`

- [ ] **Step 1: Add the function**

Append to `frontend/src/api/prDetail.ts`:

```ts
// #344 — force an immediate backend GitHub re-read of this PR (bypasses the head-SHA-keyed
// snapshot cache). Empty 200 on success; throws ApiError on 404/503. The signal bounds the
// held request with a client timeout. Mirrors inboxApi.refresh.
export function refreshPrDetail(prRef: PrReference, signal?: AbortSignal): Promise<void> {
  return apiClient.post<void>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/refresh`,
    undefined,
    { signal },
  );
}
```

- [ ] **Step 2: Typecheck**

Run (from `frontend/`): `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git -C D:/src/PRism-344 add frontend/src/api/prDetail.ts
git -C D:/src/PRism-344 commit -m "feat(#344): add refreshPrDetail API client"
```

---

## Task 6: Add the `usePrDetailRefresh` hook

**Files:**
- Create: `frontend/src/hooks/usePrDetailRefresh.ts`
- Test: `frontend/__tests__/usePrDetailRefresh.test.tsx`

- [ ] **Step 1: Write the failing test (mirror `useInboxRefresh` tests)**

Create `frontend/__tests__/usePrDetailRefresh.test.tsx`:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrDetailRefresh } from '../src/hooks/usePrDetailRefresh';
import * as prDetailApi from '../src/api/prDetail';

const PR = { owner: 'o', repo: 'r', number: 7 };

describe('usePrDetailRefresh', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('on success: posts refresh, reloads, clears updates, announces, morphs', async () => {
    const refreshSpy = vi.spyOn(prDetailApi, 'refreshPrDetail').mockResolvedValue(undefined);
    const reload = vi.fn();
    const clearUpdates = vi.fn();
    const onError = vi.fn();

    const { result } = renderHook(() =>
      usePrDetailRefresh({ prRef: PR, reload, clearUpdates, onError }),
    );

    await act(async () => { await result.current.refresh(); });

    expect(refreshSpy).toHaveBeenCalledWith(PR, expect.any(AbortSignal));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(clearUpdates).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.justRefreshed).toBe(true);
    expect(result.current.announce).toBe('PR refreshed');
  });

  it('on failure: announces nothing, calls onError, does not morph', async () => {
    vi.spyOn(prDetailApi, 'refreshPrDetail').mockRejectedValue(new Error('503'));
    const reload = vi.fn();
    const clearUpdates = vi.fn();
    const onError = vi.fn();

    const { result } = renderHook(() =>
      usePrDetailRefresh({ prRef: PR, reload, clearUpdates, onError }),
    );
    await act(async () => { await result.current.refresh(); });

    expect(reload).not.toHaveBeenCalled();
    expect(clearUpdates).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Couldn't refresh this PR. Try again.");
    expect(result.current.justRefreshed).toBe(false);
  });

  it('re-entrancy: a second call while in-flight is ignored', async () => {
    let resolveFirst: () => void = () => {};
    vi.spyOn(prDetailApi, 'refreshPrDetail').mockImplementation(
      () => new Promise<void>((res) => { resolveFirst = res; }),
    );
    const reload = vi.fn();
    const { result } = renderHook(() =>
      usePrDetailRefresh({ prRef: PR, reload, clearUpdates: vi.fn(), onError: vi.fn() }),
    );

    let p1!: Promise<void>;
    act(() => { p1 = result.current.refresh(); });
    await act(async () => { await result.current.refresh(); }); // ignored (in-flight)
    expect(prDetailApi.refreshPrDetail).toHaveBeenCalledTimes(1);
    await act(async () => { resolveFirst(); await p1; });
  });

  it('min-interval: a second call within the success window is ignored', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(prDetailApi, 'refreshPrDetail').mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePrDetailRefresh({ prRef: PR, reload: vi.fn(), clearUpdates: vi.fn(), onError: vi.fn() }),
    );
    await act(async () => { await result.current.refresh(); });
    await act(async () => { await result.current.refresh(); }); // within MIN_INTERVAL_MS → ignored
    expect(spy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('timeout: aborts after TIMEOUT_MS and calls onError', async () => {
    vi.useFakeTimers();
    // Reject when the hook's AbortController fires (mirrors fetch's abort behavior).
    vi.spyOn(prDetailApi, 'refreshPrDetail').mockImplementation(
      (_pr, signal) =>
        new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const onError = vi.fn();
    const { result } = renderHook(() =>
      usePrDetailRefresh({ prRef: PR, reload: vi.fn(), clearUpdates: vi.fn(), onError }),
    );

    let p!: Promise<void>;
    act(() => { p = result.current.refresh(); });
    await act(async () => {
      vi.advanceTimersByTime(30_000); // past TIMEOUT_MS → controller.abort() → mock rejects
      await p;
    });

    expect(onError).toHaveBeenCalledWith("Couldn't refresh this PR. Try again.");
    expect(result.current.isRefreshing).toBe(false);
    vi.useRealTimers();
  });
});
```

Run (from `frontend/`): `frontend/node_modules/.bin/vitest run __tests__/usePrDetailRefresh.test.tsx`
Expected: FAIL — `usePrDetailRefresh` does not exist.

- [ ] **Step 2: Implement the hook (mirror of `useInboxRefresh`)**

Create `frontend/src/hooks/usePrDetailRefresh.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshPrDetail } from '../api/prDetail';
import type { PrReference } from '../api/types';

const TIMEOUT_MS = 30_000;
const MIN_INTERVAL_MS = 3_000;
const CONFIRM_MS = 3_000; // ≥ MIN_INTERVAL_MS so the lockout window is never feedback-free

interface Options {
  prRef: PrReference;
  /** Re-fetch the PR detail. usePrDetail.reload is a void counter bump (fire-and-forget), NOT awaitable. */
  reload: () => void;
  /** Clear any latched "update available" banner — a manual pull moots it (wraps updates.clear). */
  clearUpdates: () => void;
  /** Surface a soft, dismissible error (the view keeps its current data). */
  onError: (message: string) => void;
}

export interface PrDetailRefreshState {
  isRefreshing: boolean;
  justRefreshed: boolean;
  announce: string;
  refresh: () => Promise<void>;
}

export function usePrDetailRefresh({
  prRef,
  reload,
  clearUpdates,
  onError,
}: Options): PrDetailRefreshState {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [announce, setAnnounce] = useState('');
  const inFlight = useRef(false);
  const lastSuccessAt = useRef(0);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    if (Date.now() - lastSuccessAt.current < MIN_INTERVAL_MS) return;

    inFlight.current = true;
    setIsRefreshing(true);
    setAnnounce('Refreshing PR…');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await refreshPrDetail(prRef, controller.signal); // the awaited step — backend now fresh
      reload();        // fire-and-forget re-GET (usePrDetail.reload is void, not awaitable)
      clearUpdates();  // dismiss any latched "update available" banner
      lastSuccessAt.current = Date.now(); // stamp ONLY on success
      setAnnounce('PR refreshed');
      setJustRefreshed(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setJustRefreshed(false), CONFIRM_MS);
    } catch {
      setAnnounce('');
      onError("Couldn't refresh this PR. Try again.");
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      setIsRefreshing(false);
    }
  }, [prRef, reload, clearUpdates, onError]);

  return { isRefreshing, justRefreshed, announce, refresh };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run (from `frontend/`): `frontend/node_modules/.bin/vitest run __tests__/usePrDetailRefresh.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git -C D:/src/PRism-344 add frontend/src/hooks/usePrDetailRefresh.ts frontend/__tests__/usePrDetailRefresh.test.tsx
git -C D:/src/PRism-344 commit -m "feat(#344): usePrDetailRefresh hook (mirror of useInboxRefresh)"
```

---

## Task 7: Render `RefreshButton` in `PrHeader`

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`
- Test: the existing `PrHeader` test file (find it under `frontend/src/components/PrDetail/`), add a render assertion.

- [ ] **Step 1: Write the failing test**

In the existing `PrHeader` test (e.g. `PrHeader.test.tsx`), add (set `loading={false}` and pass the
new props; reuse the test's existing props-builder):

```tsx
it('renders the Refresh button in the actions cluster when not loading', () => {
  renderPrHeader({ loading: false, onRefresh: vi.fn(), isRefreshing: false, justRefreshed: false });
  expect(screen.getByTestId('pr-refresh-button')).toBeInTheDocument();
});

it('clicking Refresh calls onRefresh', async () => {
  const onRefresh = vi.fn();
  renderPrHeader({ loading: false, onRefresh, isRefreshing: false, justRefreshed: false });
  await userEvent.click(screen.getByTestId('pr-refresh-button'));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it('does not unmount the Refresh button across refresh state transitions (spec §4.3 focus guarantee)', () => {
  // The button is rendered unconditionally (gated only on `onRefresh`), so it must persist as the
  // SAME DOM node across isRefreshing true→false — never conditionally unmounted, so keyboard
  // focus is never lost to document-top on the error/success paths.
  const base = { loading: false, onRefresh: vi.fn() };
  const { rerender } = renderPrHeader({ ...base, isRefreshing: true, justRefreshed: false });
  const node = screen.getByTestId('pr-refresh-button');
  // Re-render through the error path (isRefreshing → false, justRefreshed stays false).
  rerender(<PrHeader {...buildPrHeaderProps({ ...base, isRefreshing: false, justRefreshed: false })} />);
  expect(screen.getByTestId('pr-refresh-button')).toBe(node); // same node ⇒ not remounted
});
```

(Match the test file's existing render helper name/signature — `renderPrHeader`/`buildPrHeaderProps` are placeholders for whatever the file already uses; if it builds props inline, add the three new props there. The `rerender` form depends on the helper; the assertion that matters is **node identity persists** across the transition.)

Run (from `frontend/`): `frontend/node_modules/.bin/vitest run src/components/PrDetail/PrHeader.test.tsx`
Expected: FAIL — no `pr-refresh-button`.

- [ ] **Step 2: Add the props to `PrHeaderProps`**

In `PrHeader.tsx`, add to the `interface PrHeaderProps { ... }` (line ~90):

```tsx
  onRefresh?: () => void;
  isRefreshing?: boolean;
  justRefreshed?: boolean;
```

And destructure them in the `export function PrHeader({ ... })` signature (line ~135), e.g. add
`onRefresh, isRefreshing = false, justRefreshed = false,` to the destructured params.

- [ ] **Step 3: Import and render the button**

Add the import near the other PrDetail imports (after line 27):

```tsx
import { RefreshButton } from '../controls/RefreshButton';
```

In the `prActions` block (currently `<OpenInGitHubButton/> <ReviewActionButton/>`, ~line 467),
insert the Refresh button **before** `OpenInGitHubButton` (the spec's default; final slot settled
at the B1 gate). Gate on `onRefresh` being provided:

```tsx
    <div className={styles.prActions}>
      {onRefresh && (
        <RefreshButton
          isRefreshing={isRefreshing}
          justRefreshed={justRefreshed}
          onRefresh={onRefresh}
          label="Refresh PR"
          refreshingLabel="Refreshing PR…"
          title="Refresh PR"
          testId="pr-refresh-button"
          confirmTestId="pr-refresh-confirm"
        />
      )}
      <OpenInGitHubButton href={htmlUrl} />
      <ReviewActionButton
        ...
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `frontend/`): `frontend/node_modules/.bin/vitest run src/components/PrDetail/PrHeader.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C D:/src/PRism-344 add frontend/src/components/PrDetail/PrHeader.tsx frontend/src/components/PrDetail/PrHeader.test.tsx
git -C D:/src/PRism-344 commit -m "feat(#344): render RefreshButton in PrHeader actions cluster"
```

---

## Task 8: Wire `usePrDetailRefresh` into `PrDetailView`

**Files:**
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx`
- Test: `frontend/src/components/PrDetail/PrDetailView.test.tsx` (add a behavior test)

- [ ] **Step 1: Write the failing test**

Add to `PrDetailView.test.tsx` a test that clicking the header Refresh button posts the refresh and
re-GETs the detail. Mirror the existing `PrDetailView` test setup (it already mocks `getPrDetail`
and the SSE/event hooks — reuse that harness). Assert:

```tsx
it('clicking Refresh posts /refresh then re-GETs the detail', async () => {
  const refreshSpy = vi.spyOn(prDetailApi, 'refreshPrDetail').mockResolvedValue(undefined);
  // ...render PrDetailView with the existing test harness, wait for initial load...
  await userEvent.click(screen.getByTestId('pr-refresh-button'));
  await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
  // getPrDetail called again after the refresh (initial load + reload)
  await waitFor(() => expect(getPrDetailSpy).toHaveBeenCalledTimes(2));
});

it('shows the per-tab loading bar during an in-flight refresh (initial load already settled)', async () => {
  // Never-resolving refresh → isRefreshing stays true while isLoading is already false. Proves the
  // LoadingBar `active={active && (isLoading || isRefreshing)}` term is wired (guards the || isRefreshing).
  vi.spyOn(prDetailApi, 'refreshPrDetail').mockImplementation(() => new Promise<void>(() => {}));
  // ...render + wait for initial load so the cold-load bar is already inactive...
  await userEvent.click(screen.getByTestId('pr-refresh-button'));
  // Assert the LoadingBar for this tab is in its active state. Use LoadingBar's existing
  // active-state signal (the same one the inbox test asserts on `inbox-loading-bar`); the
  // testid is `pr-loading-bar:<refKey>`.
  await waitFor(() => expect(screen.getByTestId(`pr-loading-bar:${expectedRefKey}`)).toBeActiveLoadingBar());
});
```

(Use the file's existing spies/harness for `getPrDetail`; add a `refreshPrDetail` spy. `expectedRefKey` and the LoadingBar active assertion adapt to the file's harness + how `LoadingBar` renders `active` — mirror the inbox `inbox-loading-bar` assertion.)

Run (from `frontend/`): `frontend/node_modules/.bin/vitest run src/components/PrDetail/PrDetailView.test.tsx`
Expected: FAIL — no refresh button wired.

- [ ] **Step 2: Instantiate the hook and wire the surfaces**

In `PrDetailView.tsx`:

Add imports:
```tsx
import { usePrDetailRefresh } from '../../hooks/usePrDetailRefresh';
import { useToast } from '../Toast/useToast';
```
(Confirm the `useToast` import path matches how other components import it.)

After the `usePrDetail`/`useActivePrUpdates` hooks (after line ~58), add:
```tsx
  const toast = useToast();
  const prRefresh = usePrDetailRefresh({
    prRef,
    reload,
    clearUpdates: updates.clear,
    onError: (message) => toast.show({ kind: 'error', message }),
  });
```

Extend the per-tab `LoadingBar` (line ~270) to reflect a background refresh:
```tsx
      <LoadingBar active={active && (isLoading || prRefresh.isRefreshing)} data-testid={`pr-loading-bar:${refKey}`} />
```

Add the `sr-only` announcer (place it as a sibling near the top of the returned tree, e.g. right
after `<LoadingBar .../>`):
```tsx
      <div className="sr-only" role="status" aria-live="polite" data-testid="pr-refresh-status">
        {prRefresh.announce}
      </div>
```

Pass the refresh props into `<PrHeader ... />` (line ~271):
```tsx
        onRefresh={prRefresh.refresh}
        isRefreshing={prRefresh.isRefreshing}
        justRefreshed={prRefresh.justRefreshed}
```

- [ ] **Step 3: Run the test to verify it passes**

Run (from `frontend/`): `frontend/node_modules/.bin/vitest run src/components/PrDetail/PrDetailView.test.tsx`
Expected: PASS.

- [ ] **Step 4: Full frontend test + typecheck + format**

Run (from `frontend/`):
- `frontend/node_modules/.bin/vitest run` (full suite green)
- `npm run build` (`tsc -b` clean)
- `rtk proxy npx prettier --check "src/**/*.{ts,tsx}" "__tests__/**/*.{ts,tsx}"`

Expected: all green / formatted.

- [ ] **Step 5: Commit**

```bash
git -C D:/src/PRism-344 add frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/PrDetailView.test.tsx
git -C D:/src/PRism-344 commit -m "feat(#344): wire usePrDetailRefresh into PrDetailView (button, announcer, loading bar, toast)"
```

---

## Task 9: e2e + visual proof (B1)

**Files:**
- Create/extend a Playwright spec under `frontend/e2e/` (mirror an existing PR-detail e2e spec; reuse the fake-review harness `PRISM_E2E_FAKE_REVIEW=1` + `ASPNETCORE_ENVIRONMENT=Test`).

- [ ] **Step 1: Write the e2e behavior test**

In a new spec (e.g. `frontend/e2e/pr-detail-refresh.spec.ts`), open a fixture PR's detail view,
click `[data-testid="pr-refresh-button"]`, and assert the spinner appears then the confirm
checkmark (`[data-testid="pr-refresh-confirm"]`) shows, and the `role=status` region announces
"PR refreshed". Follow the patterns in an existing PR-detail e2e spec for app launch + navigation.

- [ ] **Step 2: Run the e2e spec**

Run the repo's Playwright command for a single spec (see `.ai/docs/development-process.md` /
`parallel-agent-testing.md` — launch the app with a private `(port, dataDir)`).
Expected: PASS.

- [ ] **Step 3: Capture B1 screenshots (light + dark, before/after)**

With the app running against a fixture PR, capture the PR-detail header in light and dark themes at
1920×1080, in **three** states: idle (arrow), **in-flight (spinner)**, and just-refreshed (confirm
checkmark). Capture the spinner state by delaying the `/refresh` response (e.g. Playwright
`page.route` with a delay) so the header renders the spinner in the `prActions` cluster next to
Open-in-GitHub / Review — this is the alignment/row-height-regression-risk state #291 styled the bar
for, and the one the owner most needs to eyeball. Save all pairs under `review-assets/pr-344/` for
the PR's `## Proof` Visual section.

- [ ] **Step 4: Commit**

```bash
git -C D:/src/PRism-344 add frontend/e2e/pr-detail-refresh.spec.ts review-assets/pr-344
git -C D:/src/PRism-344 commit -m "test(#344): e2e refresh morph + B1 light/dark header screenshots"
```

---

## Final verification (before PR)

- [ ] Backend: `dotnet test` (full) green.
- [ ] Frontend: `frontend/node_modules/.bin/vitest run` (full) green; `npm run build` clean; `rtk proxy npx prettier --check` clean.
- [ ] Re-read the committed diff against the spec's acceptance criteria (§8) and the risk table — confirm no `ActivePrPoller` change crept in and no B2 surface was touched (re-classify to gated if so).
- [ ] Secrets scan over the diff (no tokens/keys).
- [ ] Hand off to `pr-autopilot`; **pause at the B1 visual gate** — do not merge without owner sign-off on the light/dark screenshots.

---

## Spec → task coverage

| Spec section | Task(s) |
|---|---|
| §3.1 `RefreshAsync` + `ComposeSnapshotAsync` extraction + lock-free | 1, 2 |
| §3.2 endpoint + honest-completion (generic catch) | 3 |
| §4.1 `usePrDetailRefresh` (void-reload, no-reconcile) | 5, 6 |
| §4.2 shared `RefreshButton` (props, relocation, callsite/test move) | 4 |
| §4.3 `PrHeader`/`PrDetailView` wiring (announcer, LoadingBar, toast, placement) | 7, 8 |
| §5 error handling (404, 503, no-change, read-only, de-dup) | 3, 6, 8 |
| §6 testing (backend unit/endpoint incl. advance-200; frontend; e2e) | 2, 3, 6, 7, 8, 9 |
| §8 AC5 light+dark B1 | 9 |
