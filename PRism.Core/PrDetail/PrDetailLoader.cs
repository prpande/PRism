using System.Collections.Concurrent;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Iterations;

namespace PRism.Core.PrDetail;

/// <summary>
/// Concrete coordinator for the PR-detail surface (spec § 6.1). No <c>IPrDetailLoader</c>
/// interface — single implementation; tests substitute <see cref="IPrReader"/>.
///
/// Composes <see cref="PrDetailSnapshot"/> by orchestrating <see cref="IPrReader"/>
/// (PollActivePr → cache probe → on miss: GetPrDetail + GetTimeline) and the iteration
/// clustering strategy. Caches per <c>(prRef, headSha, generation)</c>; subscribes to
/// <see cref="IConfigStore.Changed"/> so coefficient hot-reloads invalidate the cache.
///
/// Diff caching (<see cref="GetOrFetchDiffAsync"/>) and path-in-diff lookups
/// (<see cref="IsPathInAnyCachedDiff"/>) live here too; spec § 6.1 keeps the diff fetch
/// separate from the detail fetch (per-iteration variation), and the loader memoizes
/// <see cref="DiffDto"/>s by <c>(prRef, headSha, range)</c> so the <c>/file</c> endpoint
/// can authz against any diff visited in the page session without re-fetching.
/// </summary>
public sealed class PrDetailLoader : IDisposable
{
    private readonly IPrReader _review;
    private readonly IIterationClusteringStrategy _clusterer;
    private readonly IterationClusteringCoefficients _coefficients;
    private readonly IConfigStore _configStore;

    // Subscribed for the loader's (singleton) lifetime and torn down in Dispose() (added
    // in #150 so the Subscribe IDisposable is released at shutdown rather than leaked, the
    // same as the _configStore.Changed handler).
    private readonly IDisposable _activePrSubscription;

    // #353: evict the PR's snapshot immediately on a root-comment post — the constructor
    // wire-up explains why waiting for the poller's CommentCountChanged is too slow.
    private readonly IDisposable _rootCommentSubscription;

    // #392: evict the PR's snapshot immediately on a review submit — same gap #353 closed for
    // root-comment posts (a submit moves no head SHA, so the cache key alone re-serves stale).
    private readonly IDisposable _draftSubmittedSubscription;

    // #450: evict the PR's snapshot immediately on a single-comment post-now — same gap as
    // #353/#392 (an inline comment/reply moves no head SHA, so the cache key alone re-serves
    // stale); eviction is no longer inert now that the client has a reload trigger.
    private readonly IDisposable _singleCommentSubscription;

    // Snapshot cache. PoC: unbounded ConcurrentDictionary; if dogfooding shows growth
    // (rare — user opens many distinct PRs in one process lifetime), introduce a bounded
    // LRU here. The (prRef → most-recent CacheKey) sidecar lets TryGetCachedSnapshot do
    // sync lookup without enumeration.
    private readonly ConcurrentDictionary<string, PrDetailSnapshot> _snapshots = new();
    private readonly ConcurrentDictionary<PrReference, string> _snapshotKeyByPrRef = new();

    // Diff memo: (prRef, headSha, range) → DiffDto. Lazily populated by GetOrFetchDiffAsync;
    // both /diff and /file endpoints consult it. InvalidateAll clears it.
    private readonly ConcurrentDictionary<DiffMemoKey, DiffDto> _diffs = new();

    private int _generation;

    public PrDetailLoader(
        IPrReader review,
        IIterationClusteringStrategy clusterer,
        IterationClusteringCoefficients coefficients,
        IConfigStore configStore,
        IReviewEventBus eventBus)
    {
        ArgumentNullException.ThrowIfNull(review);
        ArgumentNullException.ThrowIfNull(clusterer);
        ArgumentNullException.ThrowIfNull(coefficients);
        ArgumentNullException.ThrowIfNull(configStore);
        ArgumentNullException.ThrowIfNull(eventBus);

        _review = review;
        _clusterer = clusterer;
        _coefficients = coefficients;
        _configStore = configStore;

        // P2.29: any config change invalidates the cache so coefficient hot-reloads
        // re-cluster on the next access.
        _configStore.Changed += OnConfigChanged;

        // #116: the snapshot cache is keyed by (prRef, headSha, generation). A
        // background merge or close — and a new comment — does NOT change the head
        // SHA, so a stale "open" snapshot would survive every reload until the head
        // advances. The ActivePrPoller already detects these transitions and
        // publishes ActivePrUpdated; evict the affected PR's snapshot so the next
        // GET /api/pr re-fetches fresh detail. Gated to REAL changes (see
        // OnActivePrUpdated): evicting on the poller's quiet first-poll hydration
        // event would drop a freshly loaded snapshot and make the /file & /viewed
        // endpoints (which read TryGetCachedSnapshot) return 422 snapshot-evicted
        // even though nothing changed (Copilot PR #150 review).
        _activePrSubscription = eventBus.Subscribe<ActivePrUpdated>(OnActivePrUpdated);

        // #353: RootCommentPostedBusEvent is a GitHub issue comment — it doesn't move the
        // head SHA, so the (prRef, headSha, generation) key would re-serve the stale
        // pre-post snapshot on the SSE-driven reload. Evict the PR's snapshot immediately
        // on the post so the reload re-fetches fresh detail, instead of waiting for the
        // ActivePrPoller's CommentCountChanged (OnActivePrUpdated). Mirrors that handler.
        _rootCommentSubscription = eventBus.Subscribe<RootCommentPostedBusEvent>(OnRootCommentPosted);

        // #450: single-comment post-now NOW has an immediate client reload trigger
        // (single-comment-posted SSE → usePrDetail.reload), so eviction is no longer inert.
        // Evict here so that reload re-fetches fresh detail and the new thread becomes
        // reply-able without a manual reload. Invalidate (not RefreshAsync): the bus is
        // synchronous and Publish runs inside the comment-POST, so RefreshAsync would block
        // the post (or race the reload if backgrounded) — see spec §2.2. The small, graceful
        // /file & /viewed 422 window during the evict→reload gap is accepted (spec §2.3).
        _singleCommentSubscription = eventBus.Subscribe<SingleCommentPostedBusEvent>(OnSingleCommentPosted);

        // #392: DraftSubmitted is published only on a full review-submit success, AFTER the
        // pipeline's server-side draft clear (SubmitPipeline ClearSubmittedSession → endpoint
        // publishes DraftSubmitted). Like a root-comment post, a submit moves no head SHA, so
        // the (prRef, headSha, generation) key would re-serve the stale pre-submit snapshot on
        // the post-submit reload — leaving the just-posted threads + Overview comment invisible
        // even after the user clicks Reload (#392). Evict the PR's snapshot so that reload
        // re-fetches fresh detail. Mirrors OnRootCommentPosted; unconditional (DraftSubmitted
        // fires only on an actual submit, so there is no no-op event to suppress).
        _draftSubmittedSubscription = eventBus.Subscribe<DraftSubmitted>(OnDraftSubmitted);
    }

    // Evicts the PR's snapshot only on a real change: a head-SHA or comment-count
    // delta, or a done-state flip (open ↔ merged/closed) detected by comparing the
    // event to the cached snapshot. The poller's first poll on a quiet PR emits an
    // event with no deltas and no done-state — that must NOT evict the just-loaded
    // snapshot, or /file and /viewed would 422 snapshot-evicted (Copilot PR #150).
    private void OnActivePrUpdated(ActivePrUpdated evt)
    {
        var doneNow = evt.IsMerged || evt.IsClosed;
        var cached = TryGetCachedSnapshot(evt.PrRef);
        var doneCached = cached is not null && (cached.Detail.Pr.IsMerged || cached.Detail.Pr.IsClosed);
        if (evt.HeadShaChanged || evt.CommentCountChanged || doneNow != doneCached)
            Invalidate(evt.PrRef);
    }

    // #353: see the constructor wire-up for the rationale. Eviction is unconditional —
    // unlike OnActivePrUpdated's quiet-hydration guard, RootCommentPostedBusEvent fires
    // only on an actual post, so there is no no-op event to suppress.
    private void OnRootCommentPosted(RootCommentPostedBusEvent evt) => Invalidate(evt.PrRef);

    // #392: see the constructor wire-up. Eviction is unconditional — DraftSubmitted fires only
    // on an actual review-submit success, so there is no no-op event to suppress.
    private void OnDraftSubmitted(DraftSubmitted evt) => Invalidate(evt.PrRef);

    // #450: see the constructor wire-up. Unconditional eviction — the event fires only on an
    // actual post, so there is no quiet/no-op event to suppress (mirrors OnRootCommentPosted).
    private void OnSingleCommentPosted(SingleCommentPostedBusEvent evt) => Invalidate(evt.PrRef);

    /// <summary>
    /// Loads or refreshes the snapshot for <paramref name="prRef"/>. Polls the active-PR
    /// surface (cheap REST probe) to learn the current head SHA, then probes the cache;
    /// on miss, fetches PR detail + timeline and runs clustering.
    /// </summary>
    public async Task<PrDetailSnapshot?> LoadAsync(PrReference prRef, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        var pollSnapshot = await _review.PollActivePrAsync(prRef, ct).ConfigureAwait(false);
        var generation = Volatile.Read(ref _generation);
        var pollKey = CacheKey(prRef, pollSnapshot.HeadSha, generation);
        if (_snapshots.TryGetValue(pollKey, out var cached)) return cached;

        var detail = await _review.GetPrDetailAsync(prRef, ct).ConfigureAwait(false);
        if (detail is null) return null;

        // Defensive: head can race-advance between PollActivePr and GetPrDetail (the poll
        // can also persistently lag the detail's head if the active-PR poller is stale).
        // Re-key on the detail's actual head and probe the cache a second time before
        // paying for a timeline + clustering round-trip — a stale-poller race must hit
        // an existing realKey snapshot rather than re-fetch.
        var realKey = CacheKey(prRef, detail.Pr.HeadSha, generation);
        if (!string.Equals(realKey, pollKey, StringComparison.Ordinal)
            && _snapshots.TryGetValue(realKey, out var existing))
        {
            return existing;
        }

        var snapshot = await ComposeSnapshotAsync(prRef, detail, generation, ct).ConfigureAwait(false);

        // Re-check the generation before publishing into the cache. If `InvalidateAll` ran
        // between line 73 and here, our snapshot was computed against the now-stale generation
        // — caching it would leak a stale entry that's invisible to bumped-generation lookups
        // but still occupies memory until the next InvalidateAll. Return the just-computed
        // snapshot uncached so the caller still gets fresh data; the next LoadAsync will
        // re-fetch and cache under the current generation.
        if (Volatile.Read(ref _generation) != generation)
        {
            return snapshot;
        }

        // GetOrAdd collapses concurrent cold-load races to a single winner: two parallel
        // calls for the same prRef both finish their fetch+cluster work, but only the
        // first add becomes the canonical snapshot — both callers then return that one.
        // (The losing call's GetPrDetail/GetTimeline work is wasted; bounding that race
        // to one fetch via a per-key Lazy gate is a follow-up if dogfooding shows it.)
        var canonical = _snapshots.GetOrAdd(realKey, snapshot);
        _snapshotKeyByPrRef[prRef] = realKey;
        return canonical;
    }

    /// <summary>
    /// Force-refreshes the snapshot for <paramref name="prRef"/>, bypassing the snapshot cache
    /// (#344 manual Refresh). Re-fetches PR detail + timeline, re-clusters, and REPLACES the
    /// cached snapshot (overwrite, not GetOrAdd) so a warm cache with an unchanged head SHA
    /// still yields fresh data — the proactive analog of the inbox's hardRefresh.
    /// Returns null when the PR no longer exists (GetPrDetail => null), mapped to 404 by the
    /// endpoint. Lock-free by design: the two ConcurrentDictionary writes (snapshot map then
    /// prRef->key sidecar) are individually atomic — not transactionally atomic as a pair — and
    /// any interleave self-heals on the next LoadAsync (see spec § 3.1).
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

    /// <summary>
    /// Composes a <see cref="PrDetailSnapshot"/> from an already-fetched <paramref name="detail"/>:
    /// fetches the timeline, runs clustering, and folds the results into the snapshot. Extracted
    /// from <see cref="LoadAsync"/> (#344) so the force-fresh <see cref="RefreshAsync"/> path can
    /// reuse the identical compose logic. Does NOT touch the cache — callers decide whether/how to
    /// publish the returned snapshot.
    /// </summary>
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

    /// <summary>
    /// Sync probe for the most-recent snapshot for <paramref name="prRef"/>. Returns null
    /// if no snapshot has been loaded for this PR (or it was invalidated). No GitHub call.
    /// </summary>
    public PrDetailSnapshot? TryGetCachedSnapshot(PrReference prRef)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        if (!_snapshotKeyByPrRef.TryGetValue(prRef, out var key)) return null;
        return _snapshots.TryGetValue(key, out var snapshot) ? snapshot : null;
    }

    /// <summary>
    /// Memoized diff fetch keyed by <c>(prRef, range)</c>. Both <c>/diff</c> and
    /// <c>/file</c> endpoints consult this so the diff is fetched at most once per range
    /// per process lifetime (Option B per the PR4 design discussion). The range itself
    /// encodes the head/base SHAs, so head-advances naturally key into fresh entries.
    /// </summary>
    public async Task<DiffDto> GetOrFetchDiffAsync(
        PrReference prRef,
        DiffRangeRequest range,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        ArgumentNullException.ThrowIfNull(range);
        var key = new DiffMemoKey(prRef, range.BaseSha, range.HeadSha);
        if (_diffs.TryGetValue(key, out var cached)) return cached;

        var fresh = await _review.GetDiffAsync(prRef, range, ct).ConfigureAwait(false);
        // GetOrAdd-style: if a concurrent caller raced us, prefer their entry so the
        // returned DiffDto matches what other callers will see (BeSameAs assertions).
        return _diffs.GetOrAdd(key, fresh);
    }

    /// <summary>
    /// True if any cached diff for <paramref name="prRef"/> contains <paramref name="path"/>.
    /// Used by the <c>/file</c> endpoint's authz check (path-in-PR-diff). No GitHub call.
    /// </summary>
    public bool IsPathInAnyCachedDiff(PrReference prRef, string path)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        ArgumentNullException.ThrowIfNull(path);
        foreach (var kv in _diffs)
        {
            if (!kv.Key.PrRef.Equals(prRef)) continue;
            if (kv.Value.Files.Any(f => string.Equals(f.Path, path, StringComparison.Ordinal))) return true;
        }
        return false;
    }

    /// <summary>
    /// Bumps the coefficients generation (forcing cache misses on subsequent loads) and
    /// clears all cached snapshots and diffs. Wired to <see cref="IConfigStore.Changed"/>
    /// in the constructor (P2.29) and exposed publicly for setup-time invalidation.
    /// </summary>
    public void InvalidateAll()
    {
        Interlocked.Increment(ref _generation);
        _snapshots.Clear();
        _snapshotKeyByPrRef.Clear();
        _diffs.Clear();
    }

    /// <summary>
    /// Evicts the cached snapshot for a single <paramref name="prRef"/> so the next
    /// <see cref="LoadAsync"/> re-fetches fresh detail. Used by the ActivePrUpdated
    /// subscription (#116) to drop a snapshot whose merge/close/comment state changed
    /// without a head-SHA advance — which the (prRef, headSha, generation) cache key
    /// alone cannot distinguish. Diffs are content-addressed by SHA (a given base..head
    /// always yields the same diff), so they're never stale and are left in place.
    /// </summary>
    public void Invalidate(PrReference prRef)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        if (_snapshotKeyByPrRef.TryRemove(prRef, out var key))
            _snapshots.TryRemove(key, out _);
    }

    /// <summary>
    /// Tears down the subscriptions wired in the constructor (the <c>_configStore.Changed</c>
    /// handler plus the four <see cref="IReviewEventBus.Subscribe"/> IDisposables). The loader
    /// is a DI singleton, so this runs only on container/app shutdown; it exists so the Subscribe
    /// IDisposables are released rather than held for the process lifetime (Claude PR #150 review
    /// — the raw <c>_configStore.Changed</c> event has no IDisposable, but Subscribe returns one).
    /// </summary>
    public void Dispose()
    {
        _configStore.Changed -= OnConfigChanged;
        _activePrSubscription.Dispose();
        _rootCommentSubscription.Dispose();
        _draftSubmittedSubscription.Dispose();
        _singleCommentSubscription.Dispose();
    }

    private (ClusteringQuality Quality, IReadOnlyList<IterationDto>? Iterations) DetermineQuality(
        ClusteringInput timeline,
        HashSet<string> commitShaSet)
    {
        // Quality.Low triggers (post-calibration 2026-05-18):
        //   1. timeline has 0 commits (clustering is meaningless with no data)
        //   2. config flag iterations.clusteringDisabled = true (calibration-failure escape hatch)
        //   3. strategy returns null (per-PR degenerate detector fired)
        //
        // 1-commit PRs no longer short-circuit to Low — they return Ok with a single iteration
        // through the strategy's `sorted.Length == 1` arm. Single-commit doc-fixes and revert
        // PRs are legitimately "one unit of work" and should render the iteration view, not
        // the commit-picker fallback. Calibrated against the ShaktimaanAI validation set
        // (PR #22, single-commit doc fix).
        if (timeline.Commits.Count == 0)
            return (ClusteringQuality.Low, null);

        if (_configStore.Current.Iterations.ClusteringDisabled)
            return (ClusteringQuality.Low, null);

        var clusters = _clusterer.Cluster(timeline, _coefficients);
        if (clusters is null)
            return (ClusteringQuality.Low, null);

        var commitBySha = timeline.Commits.ToDictionary(c => c.Sha, c => c, StringComparer.Ordinal);
        var iterations = clusters.Select(c => new IterationDto(
            Number: c.IterationNumber,
            BeforeSha: c.BeforeSha,
            AfterSha: c.AfterSha,
            Commits: c.CommitShas
                .Where(sha => commitBySha.ContainsKey(sha))
                .Select(sha =>
                {
                    var ci = commitBySha[sha];
                    return new CommitDto(ci.Sha, ci.Message, ci.CommittedDate, ci.Additions, ci.Deletions);
                })
                .ToArray(),
            // GC'd SHAs (force-pushes that pruned old objects) produce false; UI renders
            // "Iter N (snapshot lost)" and ComparePicker disables selection. Spec § 6.1 + § 7.2.
            HasResolvableRange: commitShaSet.Contains(c.BeforeSha) && commitShaSet.Contains(c.AfterSha)))
            .ToArray();

        return (ClusteringQuality.Ok, iterations);
    }

    private void OnConfigChanged(object? sender, ConfigChangedEventArgs e) => InvalidateAll();

    private static string CacheKey(PrReference prRef, string headSha, int generation) =>
        $"{prRef.Owner}/{prRef.Repo}/{prRef.Number}@{headSha}#{generation}";

    private readonly record struct DiffMemoKey(PrReference PrRef, string BaseSha, string HeadSha);
}
