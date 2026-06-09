using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

public sealed class GitHubCiFailingDetector : ICiFailingDetector
{
    private const int ConcurrencyCap = 8;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly ConcurrentDictionary<(PrReference, string), CiStatus> _cache = new();

    public GitHubCiFailingDetector(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
    }

    public async Task<CiDetectResult> DetectAsync(
        IReadOnlyList<RawPrInboxItem> items, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(items);
        if (items.Count == 0) return new CiDetectResult(Array.Empty<(RawPrInboxItem, CiStatus)>(), true);
        var token = await _readToken().ConfigureAwait(false);
        using var sem = new SemaphoreSlim(ConcurrencyCap);

        var done = await Task.WhenAll(items.Select(async c =>
        {
            await sem.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (string.IsNullOrEmpty(c.HeadSha)) return (Item: c, Ci: CiStatus.None, Degraded: false);
                var key = (c.Reference, c.HeadSha);
                if (_cache.TryGetValue(key, out var cached)) return (Item: c, Ci: cached, Degraded: false);

                var (ci, degraded) = await ProbeAsync(c.Reference, c.HeadSha, token, ct).ConfigureAwait(false);
                // Only cache a result built from complete, successful reads. A DEGRADED
                // result (a non-2xx from Checks/Status — a fine-grained 403 or a transient
                // 5xx) is NOT cached, so the next tick re-probes: a transient failure
                // recovers when GitHub heals, and a fine-grained 403 re-probes cheaply
                // until the token is replaced. Caching None here would pin it until the
                // head SHA changes — contradicting the "recovers next tick" contract. (#213)
                if (!degraded) _cache[key] = ci;
                return (Item: c, Ci: ci, Degraded: degraded);
            }
            finally { sem.Release(); }
        })).ConfigureAwait(false);

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
        // while the OTHER source returned a non-2xx could mask a hidden Failing, so it
        // must NOT be cached — only a definitively-observed Failing is cacheable. (#264/#213)
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
        Uri? nextUri = null;
        var initialUrl = $"repos/{pr.Owner}/{pr.Repo}/commits/{sha}/check-runs?per_page=100";

        for (var page = 0; page < MaxCheckRunPages; page++)
        {
            using var resp = nextUri is null
                ? await SendAsync(initialUrl, token, ct).ConfigureAwait(false)
                : await SendAsync(nextUri, token, ct).ConfigureAwait(false);
            if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return (CiStatus.None, false);
            if (resp.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
                throw new RateLimitExceededException(
                    "GitHub rate-limited (429); orchestrator should skip this tick.",
                    resp.Headers.RetryAfter?.Delta);
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
            // GitHubPrEnricher.EnrichAsync early-returns without any HTTP call, and
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
                var status = r.GetProperty("status").GetString();
                var conclusion = r.TryGetProperty("conclusion", out var cn) ? cn.GetString() : null;
                if (status != "completed") { anyPending = true; continue; }
                if (conclusion is "failure" or "timed_out" or "cancelled") anyFailing = true;
                else if (conclusion == "success") anySuccess = true;
                // Other completed conclusions (skipped / neutral / action_required / stale)
                // contribute neither failing nor success: a PR whose checks were all skipped
                // (path filters, matrix exclusions) is NOT a positive signal and must not show
                // a false green tick — it stays None unless a real success exists. #264
            }

            nextUri = TryGetNextLink(resp);
            if (nextUri is null) break;
        }

        // A successful run with nothing failing/pending → Passing. Only conclusion=="success"
        // counts (anySuccess) — empty/no check_runs, or all-skipped/neutral, → None. #264
        return (anyFailing
            ? CiStatus.Failing
            : anyPending
                ? CiStatus.Pending
                : anySuccess ? CiStatus.Passing : CiStatus.None, false);
    }

    // Parses the GitHub Link response header and returns the URL whose attributes
    // include rel="next", or null if no such link exists. Standard format:
    //   <url1>; rel="next", <url2>; rel="last"
    // Node IDs / URLs are treated as opaque — we hand the absolute URL straight
    // back to HttpClient without parsing or rewriting.
    private static Uri? TryGetNextLink(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("Link", out var values)) return null;
        foreach (var header in values)
        {
            foreach (var part in header.Split(','))
            {
                var segments = part.Split(';');
                if (segments.Length < 2) continue;
                var urlSegment = segments[0].Trim();
                if (!urlSegment.StartsWith('<') || !urlSegment.EndsWith('>')) continue;
                var hasNext = false;
                for (var i = 1; i < segments.Length; i++)
                {
                    var attr = segments[i].Trim();
                    if (attr.Equals("rel=\"next\"", StringComparison.Ordinal)
                        || attr.Equals("rel=next", StringComparison.Ordinal))
                    {
                        hasNext = true;
                        break;
                    }
                }
                if (!hasNext) continue;
                var url = urlSegment[1..^1];
                if (Uri.TryCreate(url, UriKind.Absolute, out var uri)) return uri;
            }
        }
        return null;
    }

    private async Task<(CiStatus Status, bool Degraded)> FetchCombinedStatusAsync(PrReference pr, string sha, string? token, CancellationToken ct)
    {
        var url = $"repos/{pr.Owner}/{pr.Repo}/commits/{sha}/status";
        using var resp = await SendAsync(url, token, ct).ConfigureAwait(false);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return (CiStatus.None, false);
        if (resp.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
            throw new RateLimitExceededException(
                "GitHub rate-limited (429); orchestrator should skip this tick.",
                resp.Headers.RetryAfter?.Delta);
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
            "pending" when HasRegisteredStatuses(doc.RootElement) => CiStatus.Pending,
            // A registered success is a positive signal → Passing. Success with no
            // registered statuses stays None (the #286 "no legacy CI" case). (#264)
            "success" when HasRegisteredStatuses(doc.RootElement) => CiStatus.Passing,
            _ => CiStatus.None,
        };
        return (status, false);
    }

    // A registered status context surfaces as a positive `total_count` OR a non-empty
    // inline `statuses` array. The two agree in practice, but OR-ing them (rather than
    // letting `total_count` short-circuit) matches the documented intent and tolerates
    // payload quirks. `total_count` is read with TryGetInt32 so an unexpected non-integer
    // number degrades to the array signal instead of throwing. An absent/zero count with
    // an empty array means "none registered", which GitHub still labels state="pending". (#286)
    private static bool HasRegisteredStatuses(JsonElement root)
    {
        var hasStatuses = root.TryGetProperty("statuses", out var statuses)
            && statuses.ValueKind == JsonValueKind.Array
            && statuses.GetArrayLength() > 0;
        var hasCount = root.TryGetProperty("total_count", out var count)
            && count.ValueKind == JsonValueKind.Number
            && count.TryGetInt32(out var n)
            && n > 0;
        return hasStatuses || hasCount;
    }

    private Task<HttpResponseMessage> SendAsync(string url, string? token, CancellationToken ct)
        => SendCoreAsync(new HttpRequestMessage(HttpMethod.Get, url), token, ct);

    // Pagination Link headers from GitHub are absolute URLs; HttpClient.SendAsync
    // accepts an absolute Uri on the request even when the underlying client has
    // a BaseAddress, so we hand the URL through unmodified.
    private Task<HttpResponseMessage> SendAsync(Uri url, string? token, CancellationToken ct)
        => SendCoreAsync(new HttpRequestMessage(HttpMethod.Get, url), token, ct);

    private async Task<HttpResponseMessage> SendCoreAsync(HttpRequestMessage req, string? token, CancellationToken ct)
    {
        using var http = _httpFactory.CreateClient("github");
        using (req)
        {
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.UserAgent.ParseAdd("PRism/0.1");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");
            return await http.SendAsync(req, ct).ConfigureAwait(false);
        }
    }
}
