using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.State;

namespace PRism.Core.Inbox;

public sealed class InboxRefreshOrchestrator : IInboxRefreshOrchestrator, IDisposable
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

    private InboxSnapshot? _current;
    private TaskCompletionSource _firstSnapshotTcs = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly SemaphoreSlim _writerLock = new(1, 1);

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
        Func<string> viewerLoginProvider)
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
    }

    public InboxSnapshot? Current => _current;

    public async Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct)
    {
        if (_current != null) return true;
        var task = _firstSnapshotTcs.Task;
        var completed = await Task.WhenAny(task, Task.Delay(timeout, ct)).ConfigureAwait(false);
        return completed == task;
    }

    public async Task RefreshAsync(CancellationToken ct)
    {
        await _writerLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var visible = ResolveVisibleSections();
            var raw = await _sections.QueryAllAsync(visible, ct).ConfigureAwait(false);

            // Enrich every PR across all sections (one HTTP call per PR, deduplicated by ref)
            var allRawDistinct = raw.Values.SelectMany(v => v)
                .GroupBy(p => p.Reference).Select(g => g.First()).ToList();
            var enriched = await _enricher.EnrichAsync(allRawDistinct, ct).ConfigureAwait(false);
            var byRef = enriched.ToDictionary(p => p.Reference);

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
                    rawWithEnrichment["ci-failing"] = probed
                        .Where(t => t.Ci == CiStatus.Failing).Select(t => t.Item).ToList();
                }
            }

            // Convert RawPrInboxItem → PrInboxItem (with state.json reads + CI annotation)
            var state = await _stateStore.LoadAsync(ct).ConfigureAwait(false);
            var sectionsAsItems = rawWithEnrichment.ToDictionary(
                kv => kv.Key,
                kv => (IReadOnlyList<PrInboxItem>)kv.Value
                    .Select(r => MaterializePrInboxItem(r, ciByRef, state))
                    .ToList());

            // Dedupe
            var deduped = _dedupe.Deduplicate(sectionsAsItems, _config.Current.Inbox.Deduplicate);

            // AI enrichment
            var allItems = deduped.Values.SelectMany(v => v).ToList();
            var enricher = _aiSelector.Resolve<IInboxItemEnricher>();
            var enrichments = await enricher.EnrichAsync(allItems, ct).ConfigureAwait(false);
            var enrichmentMap = enrichments.ToDictionary(e => e.PrId);

            // Build snapshot + diff
            var newSnap = new InboxSnapshot(deduped, enrichmentMap, DateTimeOffset.UtcNow);
            var diff = ComputeDiff(_current, newSnap);
            _current = newSnap;

            if (!_firstSnapshotTcs.Task.IsCompleted) _firstSnapshotTcs.TrySetResult();

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
            if (oldItems.Count != kv.Value.Count) sectionChanged = true;
            if (sectionChanged) changed.Add(kv.Key);
        }
        return (changed.Count > 0, changed, newOrUpdated);
    }

    private static int CountAll(InboxSnapshot s) => s.Sections.Values.Sum(v => v.Count);

    public void Dispose() => _writerLock.Dispose();
}
