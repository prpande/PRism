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
    private readonly IPrEnricher _enricher;
    private readonly IAwaitingAuthorFilter _awaitingFilter;
    private readonly ICiFailingDetector _ciDetector;
    private readonly IInboxDeduplicator _dedupe;
    private readonly IAiSeamSelector _aiSelector;
    private readonly IReviewEventBus _events;
    private readonly IAppStateStore _stateStore;
    private readonly Func<string> _viewerLoginProvider;
    private readonly ILogger<InboxRefreshOrchestrator> _log;

    private InboxSnapshot? _current;
    private TaskCompletionSource _firstSnapshotTcs = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly SemaphoreSlim _writerLock = new(1, 1);
    private int _coldStartKicked;
    private readonly IDisposable _enrichmentSub;
    private volatile bool _disposed;

    public InboxRefreshOrchestrator(
        IConfigStore config,
        ISectionQueryRunner sections,
        IPrEnricher enricher,
        IAwaitingAuthorFilter awaitingFilter,
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
        _enricher = enricher;
        _awaitingFilter = awaitingFilter;
        _ciDetector = ciDetector;
        _dedupe = dedupe;
        _aiSelector = aiSelector;
        _events = events;
        _stateStore = stateStore;
        _viewerLoginProvider = viewerLoginProvider;
        _log = log ?? NullLogger<InboxRefreshOrchestrator>.Instance;
        _enrichmentSub = _events.Subscribe<InboxEnrichmentsReady>(OnInboxEnrichmentsReady);
    }

    public InboxSnapshot? Current => Volatile.Read(ref _current);

    public async Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct)
    {
        if (Volatile.Read(ref _current) != null) return true;
        var task = _firstSnapshotTcs.Task;
        var completed = await Task.WhenAny(task, Task.Delay(timeout, ct)).ConfigureAwait(false);
        return completed == task;
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

    public async Task RefreshAsync(CancellationToken ct, bool hardRefresh = false)
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

            // Enrich every PR across all sections (one HTTP call per PR, deduplicated by ref)
            var allRawDistinct = raw.Values.SelectMany(v => v).Concat(closedRaw)
                .GroupBy(p => p.Reference).Select(g => g.First()).ToList();
            var enriched = await _enricher.EnrichAsync(allRawDistinct, ct).ConfigureAwait(false);
            var byRef = enriched.ToDictionary(p => p.Reference);
            Log.PrEnrichmentComplete(_log, allRawDistinct.Count, enriched.Count);

            var rawWithEnrichment = raw.ToDictionary(
                kv => kv.Key,
                kv => (IReadOnlyList<RawPrInboxItem>)kv.Value
                    .Select(r => byRef.TryGetValue(r.Reference, out var e) ? e : r)
                    .Where(r => !string.IsNullOrEmpty(r.HeadSha))
                    .ToList());

            // Section 2 fan-out
            if (rawWithEnrichment.TryGetValue("awaiting-author", out var rawSec2))
            {
                var filtered = await _awaitingFilter
                    .FilterAsync(_viewerLoginProvider(), rawSec2, ct).ConfigureAwait(false);
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

            // Build snapshot + diff
            var newSnap = new InboxSnapshot(sectionsFinal, enrichmentMap, DateTimeOffset.UtcNow, ciProbeComplete);
            var diff = ComputeDiff(_current, newSnap);
            Volatile.Write(ref _current, newSnap);

            if (!_firstSnapshotTcs.Task.IsCompleted) _firstSnapshotTcs.TrySetResult();

            sw.Stop();
            Log.SnapshotBuilt(_log, postDedupeTotal, sectionsFinal.Count, diff.Changed, diff.NewOrUpdatedPrCount, sw.ElapsedMilliseconds);

            if (diff.Changed)
            {
                _events.Publish(new InboxUpdated(
                    diff.ChangedSectionIds.ToArray(),
                    diff.NewOrUpdatedPrCount));
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
            r.Reference, r.Title, r.Author, r.Repo,
            r.UpdatedAt, r.PushedAt,
            r.IterationNumberApprox, r.CommentCount,
            r.Additions, r.Deletions, r.HeadSha, ci,
            lastViewedHeadSha, lastSeenCommentId,
            r.MergedAt, r.ClosedAt, r.AvatarUrl,
            r.IsDraft, r.Description);
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
                if (o.HeadSha != n.HeadSha || o.CommentCount != n.CommentCount || o.Ci != n.Ci)
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
        _enrichmentSub.Dispose();   // unsubscribe first so no new handler invocations start
        _disposed = true;           // then flag so any in-flight invocation exits early
        _writerLock.Dispose();      // finally release the semaphore
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
            var changedSections = new HashSet<string>(StringComparer.Ordinal);
            var applied = 0;
            foreach (var r in evt.Results)
            {
                if (r.CategoryChip is null) continue;
                if (!liveByPrId.TryGetValue(r.PrId, out var live)) continue;      // PR gone since batch started
                if (InboxEnrichmentContent.Token(live.Title, live.Description) != r.ContentToken) continue; // stale
                merged[r.PrId] = new InboxItemEnrichment(r.PrId, r.CategoryChip, HoverSummary: null);
                applied++;
                foreach (var kv in current.Sections)
                    if (kv.Value.Any(p => p.Reference.PrId == r.PrId)) changedSections.Add(kv.Key);
            }
            if (applied == 0) return;

            Volatile.Write(ref _current, current with { Enrichments = merged });

            // Unconditional publish: ComputeDiff is blind to enrichment changes, so we must NOT gate
            // this on diff.Changed (false for a pure-enrichment update).
            _events.Publish(new InboxUpdated(changedSections.ToArray(), applied));
        }
        finally
        {
            _writerLock.Release();
        }
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
