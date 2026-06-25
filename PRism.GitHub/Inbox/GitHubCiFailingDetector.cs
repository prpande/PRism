using System.Collections.Concurrent;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Core.Time;

namespace PRism.GitHub.Inbox;

public sealed class GitHubCiFailingDetector : ICiFailingDetector
{
    // A cached terminal status re-validates after this TTL via the injected clock, so a same-SHA
    // "Re-run failed jobs" auto-recovers without a manual Refresh. Pending is already never cached
    // (#355); the TTL governs the terminal Passing/Failing/None entries uniformly. (#361)
    private static readonly TimeSpan TerminalTtl = TimeSpan.FromMinutes(2);
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly IClock _clock;
    private readonly ConcurrentDictionary<(PrReference, string), CacheEntry> _cache = new();

    private readonly record struct CacheEntry(CiStatus Status, DateTime CachedAtUtc);

    public GitHubCiFailingDetector(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken, IClock clock)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _clock = clock;
    }

    public async Task<CiDetectResult> DetectAsync(
        IReadOnlyList<RawPrInboxItem> items, CancellationToken ct, bool forceReprobe = false)
    {
        ArgumentNullException.ThrowIfNull(items);
        if (items.Count == 0) { _cache.Clear(); return new CiDetectResult(Array.Empty<(RawPrInboxItem, CiStatus)>(), true); }
        var token = await _readToken().ConfigureAwait(false);
        using var sem = new SemaphoreSlim(GitHubHttp.ConcurrencyCap);

        var done = await Task.WhenAll(items.Select(async c =>
        {
            await sem.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (string.IsNullOrEmpty(c.HeadSha)) return (Item: c, Ci: CiStatus.None, Degraded: false);
                var key = (c.Reference, c.HeadSha);
                // forceReprobe (the manual "Refresh now" path) skips the cache read so an
                // unchanged head SHA re-reads CI; it still writes the fresh result below. (#355)
                // A cached entry older than TerminalTtl is treated as a miss → re-probe, so a
                // same-SHA CI re-run auto-recovers within one TTL window. (#361)
                if (!forceReprobe
                    && _cache.TryGetValue(key, out var entry)
                    && _clock.UtcNow - entry.CachedAtUtc <= TerminalTtl)
                    return (Item: c, Ci: entry.Status, Degraded: false);

                var (ci, degraded) = await ProbeAsync(c.Reference, c.HeadSha, token, ct).ConfigureAwait(false);
                // Cache only a complete, successful, NON-TRANSIENT read. A DEGRADED result
                // (a non-2xx from Checks/Status — a fine-grained 403 or a transient 5xx) is
                // NOT cached, so the next tick re-probes: a transient failure recovers when
                // GitHub heals, and a fine-grained 403 re-probes cheaply until the token is
                // replaced. Caching a degraded None would pin it until the head SHA changes —
                // contradicting the "recovers next tick" contract. (#213)
                //
                // PENDING joins the never-cache set: a clean (non-degraded) Pending is still
                // transient. Caching it pinned the CI dot under that head SHA — so checks
                // finishing on an UNCHANGED head never advanced the dot, and a manual Refresh
                // re-hit the same pinned Pending. Re-probe Pending every sweep (exactly as a
                // degraded read does) until it goes terminal, then cache the terminal. (#355)
                if (!degraded && ci != CiStatus.Pending)
                {
                    _cache[key] = new CacheEntry(ci, _clock.UtcNow);
                }
                else if (forceReprobe && !degraded && ci == CiStatus.Pending)
                {
                    // A forced reprobe (manual Refresh) that observes a CLEAN Pending on a key
                    // that may still hold a STALE terminal — the same-SHA "Re-run failed jobs"
                    // case — must EVICT that terminal. Lever 1 alone only declines to OVERWRITE
                    // it, so the next NON-forced sweep would read the cached terminal and flip
                    // the dot back after a single render. Evicting lets normal sweeps re-probe
                    // (Lever 1 keeps Pending uncached) until CI goes terminal again, then re-cache.
                    // Gated on !degraded so a transient blip doesn't drop a still-valid terminal
                    // (see forceReprobe_degraded_leaves_existing_cached_terminal). (#355, Copilot review)
                    _cache.TryRemove(key, out _);
                }
                return (Item: c, Ci: ci, Degraded: degraded);
            }
            finally { sem.Release(); }
        })).ConfigureAwait(false);

        InboxCacheEviction.PruneAbsent(_cache, items.Select(i => i.Reference).ToHashSet());
        var anyDegraded = Array.Exists(done, t => t.Degraded);
        return new CiDetectResult(
            done.Select(t => (t.Item, t.Ci)).ToList(),
            Complete: !anyDegraded);
    }

    // Returns the classified status plus a Degraded flag: true when either probe hit a
    // non-success response (fine-grained 403 / transient 5xx) so the caller can skip
    // caching an untrustworthy result. A definitively-observed Failing is never degraded.
    private async Task<(CiStatus Status, bool Degraded)> ProbeAsync(PrReference pr, string headSha, string? token, CancellationToken ct)
    {
        var checksTask = FetchChecksAsync(pr, headSha, token, ct);
        var statusesTask = FetchCombinedStatusAsync(pr, headSha, token, ct);
        var results = await Task.WhenAll(checksTask, statusesTask).ConfigureAwait(false);
        var (checks, checksDegraded) = results[0];
        var (statuses, statusesDegraded) = results[1];
        var degraded = checksDegraded || statusesDegraded;
        // A Failing observed from EITHER source is definitive: a transient 5xx / fine-grained
        // 403 on the OTHER source can't un-fail it, and a later page can't either. So Failing
        // is always returned non-degraded (cacheable) even when `degraded` is set — honoring
        // this method's contract and sparing a re-probe of a stable failing status every tick.
        // Pending/None stay degraded-flagged: their true state may be Failing hidden behind
        // the incomplete read, so they must re-probe rather than cache an untrustworthy result.
        if (checks == CiStatus.Failing || statuses == CiStatus.Failing) return (CiStatus.Failing, false);
        if (checks == CiStatus.Pending || statuses == CiStatus.Pending) return (CiStatus.Pending, degraded);
        // Passing is degraded-flagged like Pending/None: a Passing read from one source
        // while the OTHER source returned a non-2xx could mask a hidden Failing, so a
        // DEGRADED Passing must not be cached (DetectAsync caches only when `!degraded`).
        // A fully-successful, non-degraded Passing IS cached normally; Failing is special
        // only in that it's returned non-degraded EVEN when the other source degraded, so
        // it's the one status cacheable despite a degraded read. (#264/#213)
        if (checks == CiStatus.Passing || statuses == CiStatus.Passing) return (CiStatus.Passing, degraded);
        return (CiStatus.None, degraded);
    }

    // Defensive page cap: 10 pages * per_page=100 = 1,000 check_runs is well above
    // any realistic monorepo matrix. If a PR somehow exceeds this we stop walking
    // pages and classify on what we have — better to under-report than spin.
    // The design spec is silent on a hard cap; this is a local safety valve.
    private const int MaxCheckRunPages = 10;

    private async Task<(CiStatus Status, bool Degraded)> FetchChecksAsync(PrReference pr, string sha, string? token, CancellationToken ct)
    {
        var anyFailing = false;
        var anyPending = false;
        var anyPage = false;
        var anySuccess = false; // ≥1 check-run completed with conclusion "success". #264

        // GitHub paginates /check-runs when a PR has > per_page entries (monorepo
        // matrix builds routinely cross 100). Follow the rel="next" link until
        // exhausted, aggregating classification across all pages.
        string? nextUrl = null;
        var initialUrl = $"repos/{pr.Owner}/{pr.Repo}/commits/{sha}/check-runs?per_page=100";

        for (var page = 0; page < MaxCheckRunPages; page++)
        {
            using var resp = await SendAsync(nextUrl ?? initialUrl, token, ct).ConfigureAwait(false);
            if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return (CiStatus.None, false);
            GitHubHttp.ThrowIfRateLimited(resp);
            // Fine-grained PATs can't call the Checks API (GitHub returns 403). Degrade
            // to "no CI signal" rather than throwing. A throw propagates through
            // DetectAsync into InboxRefreshOrchestrator.RefreshAsync (no catch) and out to
            // InboxPoller, whose tick-level catch (InboxPoller.cs:69) skips the WHOLE
            // snapshot and retries next tick. For a fine-grained token that 403s on EVERY
            // tick, that means the inbox NEVER refreshes — permanently stale. This guard
            // fixes that. (#213)
            //
            // Why a 401 (revoked token) cannot produce a misleading CI signal here: a 401
            // on the section search is SWALLOWED into an empty section by
            // GitHubSectionQueryRunner.QueryAllAsync's per-section catch
            // (GitHubSectionQueryRunner.cs:66) — it does NOT throw. With empty sections,
            // the batch reader early-returns without any HTTP call, and
            // DetectAsync receives an empty authored-by-me list and returns before issuing
            // any Checks call. So a dead token never reaches this line.
            //
            // The guard is intentionally BROAD (any non-2xx, not just 403): CI status is a
            // non-critical enrichment that must never block the inbox. The degraded result
            // is flagged so DetectAsync does NOT cache it — so a transient GitHub 5xx
            // genuinely recovers next tick (re-probed), rather than being pinned to None
            // until the head SHA changes. Accepted tradeoff (see spec Decision 1): for one
            // tick the PR's CI badge is absent + one spurious "updated" event. Narrowing to
            // 403-only would re-open the whole-tick abort for 5xx — the exact failure this
            // task removes. The 429 branch above still throws, so backoff is preserved.
            // A Failing already observed on an EARLIER page is definitive (a later page
            // can't un-fail it), so it is returned non-degraded and may be cached.
            if (!resp.IsSuccessStatusCode)
            {
                if (anyFailing) return (CiStatus.Failing, false);
                if (anyPending) return (CiStatus.Pending, true);
                // anySuccess from earlier pages is deliberately discarded here: an incomplete
                // read (a later page 5xx'd) cannot confirm Passing — a not-yet-read page could
                // carry a Failing. Degrade to None-not-cached so the next tick re-probes the
                // full set. (anyPending above is safe to surface through degradation; a worse
                // state can't hide behind it. Passing can. Covered by
                // All_passing_first_page_then_degraded_next_page_marks_none_not_passing.) #264
                return (CiStatus.None, true);
            }
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("check_runs", out var runs))
            {
                if (!anyPage) return (CiStatus.None, false);
                break;
            }
            anyPage = true;
            // "cancelled" classifies as Failing per spec — a user-aborted CI run is
            // treated as a failure signal. Superseded-run filtering (where a new push
            // invalidates an old cancellation) is not handled here; v2 may refine.
            foreach (var r in runs.EnumerateArray())
            {
                var (st, concl) = GitHubCheckClassifier.ClassifyCheckRun(r);
                if (st != CheckRunStatus.Completed) { anyPending = true; continue; }
                if (concl is CheckConclusion.Failure or CheckConclusion.TimedOut or CheckConclusion.Cancelled)
                    anyFailing = true;
                else if (concl == CheckConclusion.Success)
                    anySuccess = true;
                // Other completed conclusions (skipped / neutral / action_required / startup_failure / stale)
                // contribute neither failing nor success — unchanged from the inline version. action_required
                // stays None in the 4-state model (#305 tracks surfacing manual gates). #264
            }

            nextUrl = GitHubLinkHeader.TryGetRel(resp, "next", out var n) ? n : null;
            if (nextUrl is null) break;
        }

        // A successful run with nothing failing/pending → Passing. Only conclusion=="success"
        // counts (anySuccess) — empty/no check_runs, or all-skipped/neutral, → None. #264
        return (anyFailing
            ? CiStatus.Failing
            : anyPending
                ? CiStatus.Pending
                : anySuccess ? CiStatus.Passing : CiStatus.None, false);
    }

    private async Task<(CiStatus Status, bool Degraded)> FetchCombinedStatusAsync(PrReference pr, string sha, string? token, CancellationToken ct)
    {
        var url = $"repos/{pr.Owner}/{pr.Repo}/commits/{sha}/status";
        using var resp = await SendAsync(url, token, ct).ConfigureAwait(false);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return (CiStatus.None, false);
        GitHubHttp.ThrowIfRateLimited(resp);
        // Same graceful degradation as FetchChecksAsync (#213): a single non-2xx read is
        // degraded → None-but-not-cached, so it re-probes next tick.
        if (!resp.IsSuccessStatusCode) return (CiStatus.None, true);
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        var state = doc.RootElement.TryGetProperty("state", out var s) ? s.GetString() : "success";
        // GitHub's combined-status endpoint returns state="pending" when NO legacy commit
        // statuses are registered — the default for a modern Actions-only PR (check-runs,
        // not statuses) or a PR with no CI at all. Reading that bare "pending" as Pending
        // lit a false amber "checks in progress" dot on PRs that have no checks (#286). So
        // "pending" is only honored when at least one status context is actually registered
        // (total_count > 0); otherwise this source contributes None and the check-runs probe
        // decides. Failing/None states are unaffected. (Pre-#286 this was a PoC shortcut.)
        var status = state switch
        {
            "failure" or "error" => CiStatus.Failing,
            "pending" when GitHubCheckClassifier.HasRegisteredStatuses(doc.RootElement) => CiStatus.Pending,
            // A registered success is a positive signal → Passing. Success with no
            // registered statuses stays None (the #286 "no legacy CI" case). (#264)
            "success" when GitHubCheckClassifier.HasRegisteredStatuses(doc.RootElement) => CiStatus.Passing,
            _ => CiStatus.None,
        };
        return (status, false);
    }

    private async Task<HttpResponseMessage> SendAsync(string url, string? token, CancellationToken ct)
    {
        using var http = _httpFactory.CreateClient("github");
        return await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct).ConfigureAwait(false);
    }
}
