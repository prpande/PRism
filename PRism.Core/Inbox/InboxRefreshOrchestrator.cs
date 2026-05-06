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
        // retry on its next tick and log the failure there. Attaching a fault continuation
        // here would require injecting an ILogger into this class.
#pragma warning disable CA2012 // fire-and-forget by design; see comment above
        _ = RefreshAsync(CancellationToken.None);
#pragma warning restore CA2012
    }

    public async Task RefreshAsync(CancellationToken ct)
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

            // Enrich every PR across all sections (one HTTP call per PR, deduplicated by ref)
            var allRawDistinct = raw.Values.SelectMany(v => v)
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

            // Section 5 fan-out (CI status decoration on the authored superset)
            var ciByRef = new Dictionary<PrReference, CiStatus>();
            if (rawWithEnrichment.TryGetValue("authored-by-me", out var rawSec3))
            {
                var probed = await _ciDetector.DetectAsync(rawSec3, ct).ConfigureAwait(false);
                foreach (var (item, ci) in probed) ciByRef[item.Reference] = ci;

                if (visible.Contains("ci-failing"))
                {
                    var failing = probed.Where(t => t.Ci == CiStatus.Failing).Select(t => t.Item).ToList();
                    Log.CiDetectionComplete(_log, rawSec3.Count, failing.Count);
                    rawWithEnrichment["ci-failing"] = failing;
                }
            }

            // The authored-by-me superset is fetched whenever ci-failing is enabled (the
            // detector needs it to derive the failing subset). If the user disabled the
            // authored-by-me section itself, drop it now so it never reaches the snapshot.
            if (!_config.Current.Inbox.Sections.AuthoredByMe)
            {
                rawWithEnrichment.Remove("authored-by-me");
            }

            // Convert RawPrInboxItem → PrInboxItem (with state.json reads + CI annotation)
            var state = await _stateStore.LoadAsync(ct).ConfigureAwait(false);
            // Section UI ordering — review-requested → awaiting-author → authored-by-me → mentioned →
            // ci-failing — is NOT supplied by ResolveVisibleSections() (it returns a HashSet<string>,
            // which has no defined enumeration order). The canonical order comes from two sources:
            //   1. GitHubSectionQueryRunner.SectionQueries is a Dictionary<string, string> initialized
            //      with the four base sections in the canonical order (review-requested, awaiting-author,
            //      authored-by-me, mentioned). Its QueryAllAsync filters by visibleSectionIds.Contains(...)
            //      while iterating SectionQueries, so the returned dictionary's enumeration follows that
            //      same insertion order. The .ToDictionary(...) call below preserves it again.
            //   2. "ci-failing" is inserted explicitly later (in the CI fan-out block above), AFTER the
            //      four base entries — placing it last in the enumeration.
            // Footnote: Dictionary<TKey, TValue>'s enumerator order is documented as undefined for the
            // type, but every CLR shipped since .NET 5 preserves insertion order when no removals occur.
            // PRism relies on this de-facto guarantee; if a future runtime changes it, sections will
            // silently shuffle. A future refactor that swaps any link in the chain to ConcurrentDictionary
            // or another unordered structure has the same failure mode. If either risk materializes,
            // reintroduce explicit ordering at the /api/inbox serialization boundary.
            var sectionsAsItems = rawWithEnrichment.ToDictionary(
                kv => kv.Key,
                kv => (IReadOnlyList<PrInboxItem>)kv.Value
                    .Select(r => MaterializePrInboxItem(r, ciByRef, state))
                    .ToList());

            // Dedupe
            var deduped = _dedupe.Deduplicate(sectionsAsItems, _config.Current.Inbox.Deduplicate);
            var postDedupeTotal = deduped.Values.Sum(v => v.Count); // also used by SnapshotBuilt below
            if (_log.IsEnabled(LogLevel.Debug))
            {
                var preDedupeTotal = sectionsAsItems.Values.Sum(v => v.Count);
                Log.DedupeApplied(_log, _config.Current.Inbox.Deduplicate, preDedupeTotal, postDedupeTotal);
            }

            // AI enrichment. The enricher returns one InboxItemEnrichment per input item, so
            // we must hand it a list with one entry per unique PR — otherwise PRs that appear
            // in two visible sections (e.g. authored-by-me ∩ awaiting-author, an overlap that
            // InboxDeduplicator does not collapse) would produce duplicate enrichments and
            // ToDictionary would throw, leaving the snapshot uninitialized and the inbox 503.
            var allItems = deduped.Values.SelectMany(v => v)
                .DistinctBy(i => i.Reference)
                .ToList();
            var enricher = _aiSelector.Resolve<IInboxItemEnricher>();
            var enrichments = await enricher.EnrichAsync(allItems, ct).ConfigureAwait(false);
            var enrichmentMap = enrichments.ToDictionary(e => e.PrId);
            Log.AiEnrichmentComplete(_log, enricher.GetType().Name, allItems.Count, enrichments.Count);

            // Build snapshot + diff
            var newSnap = new InboxSnapshot(deduped, enrichmentMap, DateTimeOffset.UtcNow);
            var diff = ComputeDiff(_current, newSnap);
            Volatile.Write(ref _current, newSnap);

            if (!_firstSnapshotTcs.Task.IsCompleted) _firstSnapshotTcs.TrySetResult();

            sw.Stop();
            Log.SnapshotBuilt(_log, postDedupeTotal, deduped.Count, diff.Changed, diff.NewOrUpdatedPrCount, sw.ElapsedMilliseconds);

            if (diff.Changed)
            {
                _events.Publish(new InboxUpdated(
                    diff.ChangedSectionIds.ToArray(),
                    diff.NewOrUpdatedPrCount));
            }
        }
        finally { _writerLock.Release(); }
    }

    private HashSet<string> ResolveVisibleSections()
    {
        var s = _config.Current.Inbox.Sections;
        var v = new HashSet<string>();
        if (s.ReviewRequested) v.Add("review-requested");
        if (s.AwaitingAuthor) v.Add("awaiting-author");
        if (s.AuthoredByMe || s.CiFailing) v.Add("authored-by-me"); // ci-failing depends on authored
        if (s.Mentioned) v.Add("mentioned");
        if (s.CiFailing) v.Add("ci-failing");
        return v;
    }

    private static PrInboxItem MaterializePrInboxItem(
        RawPrInboxItem r,
        Dictionary<PrReference, CiStatus> ciByRef,
        AppState state)
    {
        var ci = ciByRef.TryGetValue(r.Reference, out var c) ? c : CiStatus.None;
        var sessionKey = $"{r.Reference.Owner}/{r.Reference.Repo}#{r.Reference.Number}";
        string? lastViewedHeadSha = null;
        long? lastSeenCommentId = null;
        if (state.ReviewSessions.TryGetValue(sessionKey, out var session))
        {
            lastViewedHeadSha = session.LastViewedHeadSha;
            if (session.LastSeenCommentId != null
                && long.TryParse(session.LastSeenCommentId, System.Globalization.CultureInfo.InvariantCulture, out var n))
                lastSeenCommentId = n;
        }
        return new PrInboxItem(
            r.Reference, r.Title, r.Author, r.Repo,
            r.UpdatedAt, r.PushedAt,
            r.IterationNumberApprox, r.CommentCount,
            r.Additions, r.Deletions, r.HeadSha, ci,
            lastViewedHeadSha, lastSeenCommentId);
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

    public void Dispose() => _writerLock.Dispose();

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug, Message = "Inbox refresh starting (viewer-login='{ViewerLogin}', visible-sections=[{VisibleSections}])")]
        internal static partial void RefreshStarted(ILogger logger, string viewerLogin, string visibleSections);

        [LoggerMessage(Level = LogLevel.Debug, Message = "Section queries complete: {SectionCount} sections, {TotalItems} items total ({Breakdown})")]
        internal static partial void SectionQueriesComplete(ILogger logger, int sectionCount, int totalItems, string breakdown);

        [LoggerMessage(Level = LogLevel.Debug, Message = "PR enrichment complete: {Input} input PRs → {Output} enriched")]
        internal static partial void PrEnrichmentComplete(ILogger logger, int input, int output);

        [LoggerMessage(Level = LogLevel.Debug, Message = "Awaiting-author filter: {Input} candidates → {Output} kept")]
        internal static partial void AwaitingAuthorFiltered(ILogger logger, int input, int output);

        [LoggerMessage(Level = LogLevel.Debug, Message = "CI detection: {Authored} authored PRs probed, {Failing} failing")]
        internal static partial void CiDetectionComplete(ILogger logger, int authored, int failing);

        [LoggerMessage(Level = LogLevel.Debug, Message = "Dedupe applied (enabled={Enabled}): {PreCount} → {PostCount} PRs")]
        internal static partial void DedupeApplied(ILogger logger, bool enabled, int preCount, int postCount);

        [LoggerMessage(Level = LogLevel.Debug, Message = "AI enrichment complete ({EnricherType}): {InputItems} unique PRs → {Enrichments} enrichments")]
        internal static partial void AiEnrichmentComplete(ILogger logger, string enricherType, int inputItems, int enrichments);

        [LoggerMessage(Level = LogLevel.Information, Message = "Inbox snapshot built: {TotalPrs} PRs across {SectionCount} sections (changed={Changed}, new-or-updated={NewOrUpdated}) in {ElapsedMs}ms")]
        internal static partial void SnapshotBuilt(ILogger logger, int totalPrs, int sectionCount, bool changed, int newOrUpdated, long elapsedMs);
    }
}
