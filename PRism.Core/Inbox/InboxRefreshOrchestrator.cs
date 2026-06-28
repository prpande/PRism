using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.State;

namespace PRism.Core.Inbox;

public sealed partial class InboxRefreshOrchestrator : IInboxRefreshOrchestrator, IDisposable
{
    private readonly IConfigStore _config;
    private readonly ISectionQueryRunner _sections;
    private readonly IPrBatchReader _batchReader;
    private readonly ICiFailingDetector _ciDetector;
    private readonly IInboxDeduplicator _dedupe;
    private readonly IAiSeamSelector _aiSelector;
    private readonly IReviewEventBus _events;
    private readonly IAppStateStore _stateStore;
    private readonly Func<string> _viewerLoginProvider;
    private readonly ILogger<InboxRefreshOrchestrator> _log;

    private InboxSnapshot? _current;
    private readonly TaskCompletionSource _firstSnapshotTcs = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly SemaphoreSlim _writerLock = new(1, 1);
    private int _coldStartKicked;
    private readonly IDisposable _enrichmentSub;
    private volatile bool _disposed;
    // Last-seen AI mode, stored as int so Interlocked can touch it (#548). The delta-gate
    // in OnConfigChanged reads/advances it atomically.
    private int _lastAiMode;
    // Stashed after every RefreshAsync (under _writerLock) so ReprobeOnceAsync can re-read
    // the full set without reconstructing RawPrInboxItem from PrInboxItem; passing the full
    // set (not just None-targets) keeps InboxCacheEviction.PruneAbsent whole (#655).
    private IReadOnlyList<RawPrInboxItem> _lastRawSet = Array.Empty<RawPrInboxItem>();

    public InboxRefreshOrchestrator(
        IConfigStore config,
        ISectionQueryRunner sections,
        IPrBatchReader batchReader,
        ICiFailingDetector ciDetector,
        IInboxDeduplicator dedupe,
        IAiSeamSelector aiSelector,
        IReviewEventBus events,
        IAppStateStore stateStore,
        Func<string> viewerLoginProvider,
        ILogger<InboxRefreshOrchestrator>? log = null)
    {
        _config = config;
        _sections = sections;
        _batchReader = batchReader;
        _ciDetector = ciDetector;
        _dedupe = dedupe;
        _aiSelector = aiSelector;
        _events = events;
        _stateStore = stateStore;
        _viewerLoginProvider = viewerLoginProvider;
        _log = log ?? NullLogger<InboxRefreshOrchestrator>.Instance;
        _enrichmentSub = _events.Subscribe<InboxEnrichmentsReady>(OnInboxEnrichmentsReady);
        _lastAiMode = (int)_config.Current.Ui.Ai.Mode;
        _config.Changed += OnConfigChanged;
    }

    public InboxSnapshot? Current => Volatile.Read(ref _current);

    public async Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct)
    {
        if (Volatile.Read(ref _current) != null) return true;
        try
        {
            // WaitAsync disposes its internal timer the moment the snapshot task completes, so the
            // snapshot-wins path no longer roots a Task.Delay timer for the full timeout (#323 4b).
            await _firstSnapshotTcs.Task.WaitAsync(timeout, ct).ConfigureAwait(false);
            return true;
        }
        catch (TimeoutException)
        {
            return false;
        }
        // ct cancellation propagates as OperationCanceledException (request abort → client-disconnect).
    }

    /// <inheritdoc/>
    public void TryColdStartRefresh()
    {
        // Atomic CAS: only the thread that flips 0→1 kicks the refresh. Every concurrent
        // caller on the cold path sees the flag already set and returns immediately.
        if (Interlocked.CompareExchange(ref _coldStartKicked, 1, 0) != 0) return;
        // Fire-and-forget: a failed cold-start refresh is not silent — InboxPoller will
        // retry on its next tick and log the failure there. A fault continuation is
        // deliberately omitted — adding one would require special-casing
        // OperationCanceledException propagation inside a continuation.
#pragma warning disable CA2012 // fire-and-forget by design; see comment above
        _ = RefreshAsync(CancellationToken.None);
#pragma warning restore CA2012
    }

    // forceNotify is documented on the interface; see the else-if branch in the publish step below.
    public async Task RefreshAsync(CancellationToken ct, bool hardRefresh = false, bool forceNotify = false)
    {
        await _writerLock.WaitAsync(ct).ConfigureAwait(false);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var visible = ResolveVisibleSections();
            // CA1873 suppression: the IsEnabled guards make the expensive arg evaluation
            // (ordered LINQ + string.Join) zero-cost when Debug is not enabled, but the
            // analyzer doesn't pattern-match the guard. OrderBy makes the log lines stable
            // across ticks so they diff cleanly — HashSet/Dictionary enumeration order
            // is not contractually guaranteed even when CLR de-facto preserves insertion order.
#pragma warning disable CA1873
            if (_log.IsEnabled(LogLevel.Debug))
                Log.RefreshStarted(_log, _viewerLoginProvider(),
                    string.Join(",", visible.OrderBy(s => s, StringComparer.Ordinal)));
            var raw = await _sections.QueryAllAsync(visible, ct).ConfigureAwait(false);
            if (_log.IsEnabled(LogLevel.Debug))
                Log.SectionQueriesComplete(_log,
                    raw.Count,
                    raw.Values.Sum(v => v.Count),
                    string.Join(",", raw
                        .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                        .Select(kv => $"{kv.Key}={kv.Value.Count}")));
#pragma warning restore CA1873

            // Recently-closed history: an extra search-API pass (gated on config) whose raw
            // items are folded into the shared enrichment pass below so they pick up
            // MergedAt/ClosedAt, then materialized into a dedicated section AFTER dedup.
            var recentlyClosedEnabled = _config.Current.Inbox.Sections.RecentlyClosed;
            IReadOnlyList<RawPrInboxItem> closedRaw = Array.Empty<RawPrInboxItem>();
            if (recentlyClosedEnabled)
            {
                closedRaw = await _sections
                    .QueryClosedHistoryAsync(_config.Current.Inbox.RecentlyClosedWindowDays, ct)
                    .ConfigureAwait(false);
                Log.ClosedHistoryFetched(_log, closedRaw.Count);
            }

            // Hydrate every PR via the batch reader (deduplicated by ref). Recently-closed items are
            // flagged IsClosedHistory so the reader fetches them with the light selection (no merge-
            // readiness compute fields — they render no badge, D5); open section items keep the full
            // selection. Open items come first in the concat, so on a rare open/closed ref collision
            // GroupBy.First() keeps the open (full) variant. (#593 — avoids the GraphQL 502 timeout.)
            var allRawDistinct = raw.Values.SelectMany(v => v)
                .Concat(closedRaw.Select(r => r with { IsClosedHistory = true }))
                .GroupBy(p => p.Reference).Select(g => g.First()).ToList();
            var viewerLogin = _viewerLoginProvider();
            var batch = await _batchReader.ReadAsync(allRawDistinct, viewerLogin, ct).ConfigureAwait(false);
            // Map batch hydration onto each raw item; refs the batch didn't resolve are absent →
            // they fall back to the raw item (empty HeadSha) → dropped by the Where filter below.
            var byRef = new Dictionary<PrReference, RawPrInboxItem>();
            foreach (var r in allRawDistinct)
                if (batch.TryGetValue(r.Reference, out var b))
                    byRef[r.Reference] = r with
                    {
                        HeadSha = b.HeadSha, Additions = b.Additions, Deletions = b.Deletions,
                        CommitCount = b.CommitCount, ChangedFiles = b.ChangedFiles, PushedAt = b.PushedAt,
                        MergedAt = b.MergedAt, ClosedAt = b.ClosedAt,
                        MergeReadiness = b.MergeReadiness,
                        Approvals = b.Approvals,
                        ChangesRequested = b.ChangesRequested,
                        Approvers = b.Approvers,
                        ChangesRequestedBy = b.ChangesRequestedBy,
                        AwaitingReviewers = b.AwaitingReviewers,
                    };
            Log.PrEnrichmentComplete(_log, allRawDistinct.Count, byRef.Count);

            var rawWithEnrichment = raw.ToDictionary(
                kv => kv.Key,
                kv => (IReadOnlyList<RawPrInboxItem>)kv.Value
                    .Select(r => byRef.TryGetValue(r.Reference, out var e) ? e : r)
                    .Where(r => !string.IsNullOrEmpty(r.HeadSha))
                    .ToList());

            // Awaiting-author: apply the inclusion predicate using the batch's ViewerLastReviewSha
            // (replaces the per-PR REST review walk). Items here passed the non-empty-HeadSha filter
            // above, which today only retains refs present in `batch`. We still use TryGetValue rather
            // than the indexer so a ref that ever reaches here without a batch entry is dropped from the
            // section (the same disposition as a missed-batch ref above) instead of throwing and
            // aborting the whole refresh — matching this reader's per-item drop-don't-crash isolation.
            if (rawWithEnrichment.TryGetValue("awaiting-author", out var rawSec2))
            {
                var filtered = rawSec2
                    .Where(r => batch.TryGetValue(r.Reference, out var b)
                                && AwaitingAuthorRule.IsAwaitingAuthor(b.ViewerLastReviewSha, r.HeadSha))
                    .ToList();
                Log.AwaitingAuthorFiltered(_log, rawSec2.Count, filtered.Count);
                rawWithEnrichment["awaiting-author"] = filtered;
            }

            // CI fan-out across ALL live sections (recently-closed flows through a
            // separate path and never enters rawWithEnrichment, so it is excluded).
            // Distinct-by-ref so a PR in two sections is probed once.
            var ciByRef = new Dictionary<PrReference, CiStatus>();
            var ciProbeComplete = true;
            RateLimitExceededException? ciRateLimit = null;
            var liveForCi = rawWithEnrichment.Values
                .SelectMany(v => v)
                .GroupBy(r => r.Reference)
                .Select(g => g.First())
                .ToList();
            if (liveForCi.Count > 0)
            {
                try
                {
                    var probed = await _ciDetector.DetectAsync(liveForCi, ct, forceReprobe: hardRefresh).ConfigureAwait(false);
                    var failingCount = 0;
                    foreach (var (item, ci) in probed.Items)
                    {
                        ciByRef[item.Reference] = ci;
                        if (ci == CiStatus.Failing) failingCount++;
                    }
                    ciProbeComplete = probed.Complete;
                    Log.CiDetectionComplete(_log, liveForCi.Count, failingCount, probed.Complete);
                }
                catch (OperationCanceledException) { throw; }
                catch (RateLimitExceededException rle)
                {
                    // CI is non-critical enrichment. A 429 must NOT discard the snapshot
                    // (that would freeze the no-CI sections too). Publish without CI, mark
                    // incomplete, and re-surface the rate-limit AFTER publishing so the
                    // poller still honors Retry-After. (#262 round-2 fault-isolation.)
                    ciProbeComplete = false;
                    ciRateLimit = rle;
                    Log.CiProbeRateLimited(_log);
                }
            }

            // Convert RawPrInboxItem → PrInboxItem (with state.json reads + CI annotation)
            var state = await _stateStore.LoadAsync(ct).ConfigureAwait(false);
            // rawWithEnrichment is keyed by section id; build the per-section PrInboxItem lists by
            // materializing each RawPrInboxItem (state.json reads + CI annotation).
            // Final UI order is pinned explicitly at the /api/inbox serializer (InboxEndpoints.SectionOrder);
            // this dict's enumeration order is no longer load-bearing.
            var sectionsAsItems = rawWithEnrichment.ToDictionary(
                kv => kv.Key,
                kv => (IReadOnlyList<PrInboxItem>)kv.Value
                    .Select(r => MaterializePrInboxItem(r, ciByRef, state))
                    .ToList());

            // Dedupe
            var deduped = _dedupe.Deduplicate(sectionsAsItems, _config.Current.Inbox.Deduplicate);
            if (_log.IsEnabled(LogLevel.Debug))
            {
                var preDedupeTotal = sectionsAsItems.Values.Sum(v => v.Count);
                var postDedupeOnly = deduped.Values.Sum(v => v.Count);
                Log.DedupeApplied(_log, _config.Current.Inbox.Deduplicate, preDedupeTotal, postDedupeOnly);
            }

            // Recently-closed section is appended AFTER dedup so it stays DISJOINT from
            // InboxDeduplicator's pair-collapsing. IInboxDeduplicator returns an
            // IReadOnlyDictionary (no indexer setter) and its early-return paths hand back
            // the caller's input instance — so we copy into a fresh mutable dictionary
            // rather than index-assigning into `deduped` (which would be CS0021 / unsafe).
            var sectionsFinal = deduped.ToDictionary(kv => kv.Key, kv => kv.Value);
            if (recentlyClosedEnabled)
            {
                var ordered = closedRaw
                    .Select(r => byRef.TryGetValue(r.Reference, out var e)
                        ? e
                        // Enrichment dropped (e.g. 404): the raw Search item has null close
                        // timestamps + empty headSha, so InboxRow would render it as a
                        // non-terminal, falsely-unread row (doneState == null →
                        // hasUnseenActivity true). This PR is in recently-closed by
                        // definition, so synthesize a terminal ClosedAt — UpdatedAt is the
                        // best available proxy (Search sorts by it; ≈ close time for a
                        // closed PR) — which makes the FE treat it as a done, read row.
                        : r with { ClosedAt = r.ClosedAt ?? r.UpdatedAt })
                    .Select(r => MaterializePrInboxItem(r, ciByRef, state))         // NO HeadSha filter; CI is a live-PR concept.
                    .OrderByDescending(i => i.MergedAt ?? i.ClosedAt ?? i.UpdatedAt) // UpdatedAt fallback (always populated) keeps dropped-enrichment rows in place.
                    .ThenByDescending(i => i.Reference.Number)                       // total order so the top-N repo cut is stable across ticks…
                    .ThenBy(i => i.Repo, StringComparer.Ordinal)                    // …even when newest-close timestamps tie.
                    .ToList();
                var topRepos = ordered
                    .Select(i => i.Repo)
                    .Distinct(StringComparer.Ordinal)        // first-seen order = repos by most-recent close
                    .Take(InboxHistoryConstants.MaxHistoryRepos)
                    .ToHashSet(StringComparer.Ordinal);
                var closedItems = (IReadOnlyList<PrInboxItem>)ordered
                    .Where(i => topRepos.Contains(i.Repo))   // keep all PRs of the kept repos
                    .ToList();
                sectionsFinal[InboxHistoryConstants.SectionId] = closedItems;
            }
            var postDedupeTotal = sectionsFinal.Values.Sum(v => v.Count); // also used by SnapshotBuilt below

            // AI enrichment. The enricher returns one InboxItemEnrichment per input item, so
            // we must hand it a list with one entry per unique PR — otherwise PRs that appear
            // in two visible sections (e.g. authored-by-me ∩ awaiting-author, an overlap that
            // InboxDeduplicator does not collapse) would produce duplicate enrichments and
            // ToDictionary would throw, leaving the snapshot uninitialized and the inbox 503.
            var allItems = sectionsFinal.Values.SelectMany(v => v)
                .DistinctBy(i => i.Reference)
                .Where(i => i.MergedAt == null && i.ClosedAt == null && !i.IsDraft) // #410: enrich open, non-draft only
                .ToList();
            var enricher = _aiSelector.Resolve<IInboxItemEnricher>();
            var enrichments = await enricher.EnrichAsync(allItems, ct).ConfigureAwait(false);
            var enrichmentMap = enrichments.ToDictionary(e => e.PrId);
            Log.AiEnrichmentComplete(_log, enricher.GetType().Name, allItems.Count, enrichments.Count);

            // Every PR the enricher resolved synchronously (cache hits) is settled —
            // chip or not. Misses are still in flight; they arrive later via
            // OnInboxEnrichmentsReady, which extends this set. (The cache is the durable
            // store, so a later refresh re-derives the same settled set from enrichmentMap.)
            var aiSettled = enrichmentMap.Keys.ToHashSet(StringComparer.Ordinal);

            // Build snapshot + diff
            var newSnap = new InboxSnapshot(sectionsFinal, enrichmentMap, DateTimeOffset.UtcNow, ciProbeComplete, aiSettled);
            var diff = ComputeDiff(_current, newSnap);
            Volatile.Write(ref _current, newSnap);
            // Stash under the lock so ReprobeOnceAsync can re-read the full set (#655).
            _lastRawSet = allRawDistinct;

            if (!_firstSnapshotTcs.Task.IsCompleted) _firstSnapshotTcs.TrySetResult();

            sw.Stop();
            Log.SnapshotBuilt(_log, postDedupeTotal, sectionsFinal.Count, diff.Changed, diff.NewOrUpdatedPrCount, sw.ElapsedMilliseconds);

            if (diff.Changed)
            {
                _events.Publish(new InboxUpdated(
                    diff.ChangedSectionIds.ToArray(),
                    diff.NewOrUpdatedPrCount));
            }
            else if (forceNotify)
            {
                // An AI-mode-change refresh re-populates the enrichments/settled set without
                // touching the PR set, so ComputeDiff (enrichment-blind) sees no change. Publish
                // anyway — otherwise the FE never refetches the now-settled snapshot. All section
                // keys, count 0 (no chip "landed" via this path); same shape as the mode-change
                // clear publish in OnConfigChanged. On Preview→Live this fires one extra
                // InboxUpdated(empty settled) before OnInboxEnrichmentsReady streams the real
                // results — a harmless, intentional intermediate refetch.
                _events.Publish(new InboxUpdated(newSnap.Sections.Keys.ToArray(), 0));
            }

            // Snapshot is committed + event published above. Now re-surface a CI rate-limit
            // so InboxPoller backs off (honoring Retry-After) without losing the snapshot.
            if (ciRateLimit is not null) throw ciRateLimit;
        }
        finally { _writerLock.Release(); }
    }

    private HashSet<string> ResolveVisibleSections()
    {
        var s = _config.Current.Inbox.Sections;
        var v = new HashSet<string>();
        if (s.ReviewRequested) v.Add("review-requested");
        if (s.AwaitingAuthor) v.Add("awaiting-author");
        if (s.AuthoredByMe) v.Add("authored-by-me");
        if (s.Mentioned) v.Add("mentioned");
        // recently-closed is handled separately via QueryClosedHistoryAsync.
        return v;
    }

    private static PrInboxItem MaterializePrInboxItem(
        RawPrInboxItem r,
        Dictionary<PrReference, CiStatus> ciByRef,
        AppState state)
    {
        var ci = ciByRef.TryGetValue(r.Reference, out var c) ? c : CiStatus.None;
        var (lastViewedHeadSha, lastSeenCommentId) = InboxViewedState.Project(r.Reference, state);
        return new PrInboxItem(
            Reference: r.Reference,
            Title: r.Title,
            Author: r.Author,
            Repo: r.Repo,
            UpdatedAt: r.UpdatedAt,
            PushedAt: r.PushedAt,
            CommitCount: r.CommitCount,
            ChangedFiles: r.ChangedFiles,
            CommentCount: r.CommentCount,
            Additions: r.Additions,
            Deletions: r.Deletions,
            HeadSha: r.HeadSha,
            Ci: ci,
            LastViewedHeadSha: lastViewedHeadSha,
            LastSeenCommentId: lastSeenCommentId,
            MergedAt: r.MergedAt,
            ClosedAt: r.ClosedAt,
            AvatarUrl: r.AvatarUrl,
            IsDraft: r.IsDraft,
            Description: r.Description,
            MergeReadiness: r.MergeReadiness,
            Approvals: r.Approvals,
            ChangesRequested: r.ChangesRequested,
            Approvers: r.Approvers,
            ChangesRequestedBy: r.ChangesRequestedBy,
            AwaitingReviewers: r.AwaitingReviewers);
    }

    // NewOrUpdatedPrCount is named for the common case (added or updated PRs) but its
    // semantic is broader: it counts every PR that meaningfully *changed* between the
    // prior and next snapshot — additions, in-place updates (HeadSha/CommentCount/Ci),
    // and removals (PRs that vanished from a section, plus all PRs in sections that
    // were dropped entirely). The frontend banner depends on this count being > 0
    // whenever Changed is true; a "Changed but count == 0" outcome would render the
    // misleading "0 new updates" string. Renaming the field to match the broadened
    // meaning would cascade into the DTO contract and the frontend's useInboxUpdates
    // hook, so the field name is left aspirational and this comment carries the truth.
    private static (bool Changed, IReadOnlyList<string> ChangedSectionIds, int NewOrUpdatedPrCount)
        ComputeDiff(InboxSnapshot? prior, InboxSnapshot next)
    {
        if (prior is null) return (true, next.Sections.Keys.ToList(), CountAll(next));
        var changed = new List<string>();
        var newOrUpdated = 0;
        foreach (var kv in next.Sections)
        {
            var oldItems = prior.Sections.TryGetValue(kv.Key, out var v) ? v : Array.Empty<PrInboxItem>();
            var oldByRef = oldItems.ToDictionary(p => p.Reference);
            var newByRef = kv.Value.ToDictionary(p => p.Reference);
            var sectionChanged = false;
            foreach (var n in kv.Value)
            {
                if (!oldByRef.TryGetValue(n.Reference, out var o))
                {
                    newOrUpdated++; sectionChanged = true; continue;
                }
                if (o.HeadSha != n.HeadSha || o.CommentCount != n.CommentCount || o.Ci != n.Ci
                    || o.MergeReadiness != n.MergeReadiness)
                {
                    newOrUpdated++; sectionChanged = true;
                }
            }
            // PRs removed from this section since the prior snapshot count too — a
            // disappeared PR is a real change, even if the field name says otherwise.
            foreach (var o in oldItems)
            {
                if (!newByRef.ContainsKey(o.Reference))
                {
                    newOrUpdated++; sectionChanged = true;
                }
            }
            if (oldItems.Count != kv.Value.Count) sectionChanged = true;
            if (sectionChanged) changed.Add(kv.Key);
        }
        // Also detect sections present in the prior snapshot but absent from the new one
        // (e.g., user disables a section in config between two refreshes). Every PR in
        // the dropped section is a removal and contributes to NewOrUpdatedPrCount.
        foreach (var (key, oldItems) in prior.Sections)
        {
            if (!next.Sections.ContainsKey(key))
            {
                changed.Add(key);
                newOrUpdated += oldItems.Count;
            }
        }
        return (changed.Count > 0, changed, newOrUpdated);
    }

    private static int CountAll(InboxSnapshot s) => s.Sections.Values.Sum(v => v.Count);

    public void Dispose()
    {
        _enrichmentSub.Dispose();          // unsubscribe first so no new handler invocations start
        _config.Changed -= OnConfigChanged; // and detach the config-change handler (#548)
        _disposed = true;                  // then flag so any in-flight invocation exits early
        _writerLock.Dispose();             // finally release the semaphore
    }

    // Re-reads still-None open non-draft rows via the batch reader (using the full _lastRawSet
    // so InboxCacheEviction.PruneAbsent stays whole), patches resolved rows onto a freshly
    // re-read _current, and publishes InboxUpdated if any row changed.
    // Returns true if any target is still None after the read (another pass is warranted).
    // Task 10 drives this in a fast burst; this method is the single-pass primitive (#655).
    internal async Task<bool> ReprobeOnceAsync(CancellationToken ct)
    {
        var snap = Volatile.Read(ref _current);
        if (snap is null) return false;
        var targets = snap.Sections.Values.SelectMany(s => s)
            .Where(p => p.MergedAt is null && p.ClosedAt is null && !p.IsDraft
                        && p.MergeReadiness == MergeReadiness.None)
            .Select(p => p.Reference).ToHashSet();
        if (targets.Count == 0 || _lastRawSet.Count == 0) return false;

        var viewerLogin = _viewerLoginProvider();
        IReadOnlyDictionary<PrReference, BatchPrData> read;
        await _writerLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_disposed) return false;
            read = await _batchReader.ReadAsync(_lastRawSet, viewerLogin, ct).ConfigureAwait(false);
        }
        finally { _writerLock.Release(); }

        await _writerLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_disposed) return false;
            var current = Volatile.Read(ref _current); // RE-READ inside the lock: never patch the pre-read reference
            if (current is null) return false;
            var anyStillNone = false;
            var changed = new HashSet<string>(StringComparer.Ordinal);
            var newSections = current.Sections.ToDictionary(
                kv => kv.Key,
                kv => (IReadOnlyList<PrInboxItem>)kv.Value.Select(p =>
                {
                    if (!targets.Contains(p.Reference)) return p;                      // only rows that were None
                    if (!read.TryGetValue(p.Reference, out var b)
                        || b.MergeReadiness == MergeReadiness.None)
                    { anyStillNone = true; return p; }                                 // vanished OR still computing
                    changed.Add(kv.Key);
                    return p with
                    {
                        MergeReadiness = b.MergeReadiness,
                        Approvals = b.Approvals,
                        ChangesRequested = b.ChangesRequested,
                        Approvers = b.Approvers,
                        ChangesRequestedBy = b.ChangesRequestedBy,
                        AwaitingReviewers = b.AwaitingReviewers,
                    };
                }).ToList(),
                StringComparer.Ordinal);
            if (changed.Count > 0)
            {
                Volatile.Write(ref _current, current with { Sections = newSections });
                _events.Publish(new InboxUpdated(changed.ToArray(), 0)); // ComputeDiff is patch-blind
            }
            return anyStillNone;
        }
        finally { _writerLock.Release(); }
    }

    // Test-only seam: simulates a concurrent RefreshAsync that dropped a PR from the snapshot
    // (e.g., the PR was closed). The re-probe's patch step re-reads _current inside its lock and
    // iterates current.Sections directly — a row absent from the fresh _current is never patched
    // back in (#655 vanished-row guard).
    internal void SimulateConcurrentDropOf(RawPrInboxItem item)
    {
        var current = Volatile.Read(ref _current);
        if (current is null) return;
        var newSections = current.Sections.ToDictionary(
            kv => kv.Key,
            kv => (IReadOnlyList<PrInboxItem>)kv.Value
                .Where(p => p.Reference != item.Reference)
                .ToList(),
            StringComparer.Ordinal);
        Volatile.Write(ref _current, current with { Sections = newSections });
    }

    // Merge a completed enrichment batch into the live snapshot. Runs synchronously on the
    // enricher's background thread (ReviewEventBus delivers inline). Takes the writer-lock and
    // re-reads _current so it never clobbers a fresher snapshot the poller just committed; and
    // applies each result only if the live PR's content token still matches the one the result
    // was computed against (#410 edit-during-batch guard).
    private void OnInboxEnrichmentsReady(InboxEnrichmentsReady evt)
    {
        if (_disposed) return; // host shutting down — don't touch a disposing _writerLock
        _writerLock.Wait();
        try
        {
            if (_disposed) return;
            var current = _current;
            if (current is null) return;

            var liveByPrId = current.Sections.Values
                .SelectMany(s => s)
                .GroupBy(p => p.Reference.PrId, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

            var merged = new Dictionary<string, InboxItemEnrichment>(current.Enrichments, StringComparer.Ordinal);
            var settled = new HashSet<string>(current.AiEnrichmentSettled, StringComparer.Ordinal);
            var changedSections = new HashSet<string>(StringComparer.Ordinal);
            var applied = 0;
            var newlySettled = 0;
            foreach (var r in evt.Results)
            {
                if (!liveByPrId.TryGetValue(r.PrId, out var live)) continue;      // PR gone since batch started
                if (InboxEnrichmentContent.Token(live.Title, live.Description) != r.ContentToken) continue; // stale edit-during-batch (#410 guard)
                if (settled.Add(r.PrId)) newlySettled++;                          // resolved against the live PR → settled, chip or not
                if (r.CategoryChip is not null)                                   // Enrichments stays chip-only on this path
                {
                    merged[r.PrId] = new InboxItemEnrichment(r.PrId, r.CategoryChip, HoverSummary: null);
                    applied++;
                }
                // Runs for chip-less settles too: the section must be in changedSections so the FE clears its working marker even when no chip landed (#508).
                foreach (var kv in current.Sections)
                    if (kv.Value.Any(p => p.Reference.PrId == r.PrId)) changedSections.Add(kv.Key);
            }
            // Commit if a chip landed OR a PR newly settled — an all-"Other" batch must
            // still clear the FE's working markers. A no-op batch (all stale/gone) → both 0 → return.
            if (applied == 0 && newlySettled == 0) return;

            Volatile.Write(ref _current, current with { Enrichments = merged, AiEnrichmentSettled = settled });
            _events.Publish(new InboxUpdated(changedSections.ToArray(), applied)); // unconditional (ComputeDiff is enrichment-blind)
        }
        finally
        {
            _writerLock.Release();
        }
    }

    // #548 — a stale Preview placeholder ("Refactor") must not linger after the AI mode changes.
    // RaiseChanged is SYNCHRONOUS on the caller thread (preferences PUT thread + config-watcher
    // thread), so this MUST be lock-free — mirror the real PrDetailLoader.InvalidateAll precedent.
    private void OnConfigChanged(object? sender, ConfigChangedEventArgs e)
    {
        if (_disposed) return;
        var newMode = e.Config.Ui.Ai.Mode;
        // Atomically advance the last-seen mode; Interlocked.Exchange makes the delta-gate safe
        // against two concurrent Changed producers (API thread + file-watcher thread) — neither
        // can pass on a torn/stale read of _lastAiMode.
        var prev = (AiMode)Interlocked.Exchange(ref _lastAiMode, (int)newMode);
        if (prev == newMode) return; // only on an actual AI-mode delta

        // CAS-clear the AI-derived fields. If a concurrent RefreshAsync already replaced _current,
        // it loses the CAS — and that is CORRECT: that refresh's snapshot is authoritative for the
        // new mode. The refresh poke below converges either outcome.
        var current = Volatile.Read(ref _current);
        if (current is not null &&
            (current.Enrichments.Count > 0 || current.AiEnrichmentSettled.Count > 0))
        {
            var cleared = current with
            {
                Enrichments = new Dictionary<string, InboxItemEnrichment>(StringComparer.Ordinal),
                AiEnrichmentSettled = new HashSet<string>(StringComparer.Ordinal),
            };
            if (ReferenceEquals(Interlocked.CompareExchange(ref _current, cleared, current), current))
                // All section keys: ComputeDiff is enrichment-blind, so publish unconditionally to
                // force the FE refetch. applied = 0 (no chips landed — we cleared them).
                _events.Publish(new InboxUpdated(current.Sections.Keys.ToArray(), 0));
        }

        // Re-populate via the RESOLVED enricher rather than leaving every chip-eligible row pulsing
        // for a full Polling.InboxSeconds (round-2 adversarial review, conf 75 — the N-row pulse-storm
        // is the DEFAULT Preview→Live path, not an edge case). Fire-and-forget RefreshAsync is
        // _writerLock-serialized, so a concurrent poll coalesces naturally; it runs OFF the caller
        // thread, so the preferences PUT is never blocked. (If a poller handle is reachable from the
        // orchestrator, prefer InboxPoller.RequestImmediateRefresh() — verify the wiring in-step;
        // today the dependency runs poller→orchestrator, so RefreshAsync is the reachable path.)
        // forceNotify: a synchronous enricher (Preview/Off) settles in this one refresh, so its refill
        // must be announced even though the PR set didn't change (see the publish step in RefreshAsync).
#pragma warning disable CA2012 // fire-and-forget by design; see comment above
        _ = RefreshAsync(CancellationToken.None, forceNotify: true);
#pragma warning restore CA2012
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug, Message = "Inbox refresh starting (viewer-login='{ViewerLogin}', visible-sections=[{VisibleSections}])")]
        internal static partial void RefreshStarted(ILogger logger, string viewerLogin, string visibleSections);

        [LoggerMessage(Level = LogLevel.Debug, Message = "Section queries complete: {SectionCount} sections, {TotalItems} items total ({Breakdown})")]
        internal static partial void SectionQueriesComplete(ILogger logger, int sectionCount, int totalItems, string breakdown);

        [LoggerMessage(Level = LogLevel.Debug, Message = "Closed-history fetch: {Count} raw items")]
        internal static partial void ClosedHistoryFetched(ILogger logger, int count);

        [LoggerMessage(Level = LogLevel.Debug, Message = "PR enrichment complete: {Input} input PRs → {Output} enriched")]
        internal static partial void PrEnrichmentComplete(ILogger logger, int input, int output);

        [LoggerMessage(Level = LogLevel.Debug, Message = "Awaiting-author filter: {Input} candidates → {Output} kept")]
        internal static partial void AwaitingAuthorFiltered(ILogger logger, int input, int output);

        [LoggerMessage(Level = LogLevel.Debug, Message = "CI detection: {Probed} PRs probed, {Failing} failing, complete={Complete}")]
        internal static partial void CiDetectionComplete(ILogger logger, int probed, int failing, bool complete);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Inbox CI probe rate-limited (429); snapshot published without CI, backing off")]
        internal static partial void CiProbeRateLimited(ILogger logger);

        [LoggerMessage(Level = LogLevel.Debug, Message = "Dedupe applied (enabled={Enabled}): {PreCount} → {PostCount} PRs")]
        internal static partial void DedupeApplied(ILogger logger, bool enabled, int preCount, int postCount);

        [LoggerMessage(Level = LogLevel.Debug, Message = "AI enrichment complete ({EnricherType}): {InputItems} unique PRs → {Enrichments} enrichments")]
        internal static partial void AiEnrichmentComplete(ILogger logger, string enricherType, int inputItems, int enrichments);

        [LoggerMessage(Level = LogLevel.Information, Message = "Inbox snapshot built: {TotalPrs} PRs across {SectionCount} sections (changed={Changed}, new-or-updated={NewOrUpdated}) in {ElapsedMs}ms")]
        internal static partial void SnapshotBuilt(ILogger logger, int totalPrs, int sectionCount, bool changed, int newOrUpdated, long elapsedMs);
    }
}
