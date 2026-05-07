using System.Collections.Concurrent;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Core.PrDetail;

/// <summary>
/// Concrete coordinator for the PR-detail surface (spec § 6.1). No <c>IPrDetailLoader</c>
/// interface — single implementation; tests substitute <see cref="IReviewService"/>.
///
/// Composes <see cref="PrDetailSnapshot"/> by orchestrating <see cref="IReviewService"/>
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
public sealed class PrDetailLoader
{
    private readonly IReviewService _review;
    private readonly IIterationClusteringStrategy _clusterer;
    private readonly IterationClusteringCoefficients _coefficients;
    private readonly IConfigStore _configStore;

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
        IReviewService review,
        IIterationClusteringStrategy clusterer,
        IterationClusteringCoefficients coefficients,
        IConfigStore configStore)
    {
        ArgumentNullException.ThrowIfNull(review);
        ArgumentNullException.ThrowIfNull(clusterer);
        ArgumentNullException.ThrowIfNull(coefficients);
        ArgumentNullException.ThrowIfNull(configStore);

        _review = review;
        _clusterer = clusterer;
        _coefficients = coefficients;
        _configStore = configStore;

        // P2.29: any config change invalidates the cache so coefficient hot-reloads
        // re-cluster on the next access.
        _configStore.Changed += OnConfigChanged;
    }

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

        // Defensive: head can race-advance between PollActivePr and GetPrDetail. Re-key
        // on the detail's actual head so the cache reflects the freshest data.
        var realKey = CacheKey(prRef, detail.Pr.HeadSha, generation);

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
        var snapshot = new PrDetailSnapshot(finalDetail, detail.Pr.HeadSha, generation);

        _snapshots[realKey] = snapshot;
        _snapshotKeyByPrRef[prRef] = realKey;
        return snapshot;
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
    /// Memoized diff fetch keyed by <c>(prRef, headSha, range)</c>. Both <c>/diff</c> and
    /// <c>/file</c> endpoints consult this so the diff is fetched at most once per range
    /// per page session (Option B per the PR4 design discussion).
    /// </summary>
    public async Task<DiffDto> GetOrFetchDiffAsync(
        PrReference prRef,
        string headSha,
        DiffRangeRequest range,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        ArgumentNullException.ThrowIfNull(headSha);
        ArgumentNullException.ThrowIfNull(range);
        var key = new DiffMemoKey(prRef, headSha, range.BaseSha, range.HeadSha);
        if (_diffs.TryGetValue(key, out var cached)) return cached;

        var fresh = await _review.GetDiffAsync(prRef, range, ct).ConfigureAwait(false);
        // GetOrAdd-style: if a concurrent caller raced us, prefer their entry so the
        // returned DiffDto matches what other callers will see (BeSameAs assertions).
        return _diffs.GetOrAdd(key, fresh);
    }

    /// <summary>
    /// True if any cached diff for <c>(prRef, headSha)</c> contains <paramref name="path"/>.
    /// Used by the <c>/file</c> endpoint's authz check (path-in-PR-diff). No GitHub call.
    /// </summary>
    public bool IsPathInAnyCachedDiff(PrReference prRef, string headSha, string path)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        ArgumentNullException.ThrowIfNull(headSha);
        ArgumentNullException.ThrowIfNull(path);
        foreach (var kv in _diffs)
        {
            var k = kv.Key;
            if (!k.PrRef.Equals(prRef) || !string.Equals(k.HeadSha, headSha, StringComparison.Ordinal)) continue;
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

    private (ClusteringQuality Quality, IReadOnlyList<IterationDto>? Iterations) DetermineQuality(
        ClusteringInput timeline,
        HashSet<string> commitShaSet)
    {
        // Q5 — three triggers for ClusteringQuality.Low:
        //   1. timeline has ≤ 1 commit (clustering is meaningless with 0 or 1 commits)
        //   2. config flag iterations.clusteringDisabled = true (calibration-failure escape hatch)
        //   3. strategy returns null (per-PR degenerate detector fired)
        if (timeline.Commits.Count <= 1)
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

    private readonly record struct DiffMemoKey(PrReference PrRef, string HeadSha, string BaseSha, string HeadShaRange);
}
