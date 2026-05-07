using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.GitHub;

public sealed class GitHubReviewService : IReviewService
{
    private static readonly string[] RequiredScopes = ["repo", "read:user", "read:org"];

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;

    public GitHubReviewService(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, string host)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
    }

    public async Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        if (string.IsNullOrEmpty(token))
            return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "no token");

        var tokenType = ClassifyToken(token);

        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, "user");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        try
        {
            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            var primary = await InterpretAsync(resp, tokenType, ct).ConfigureAwait(false);
            if (!primary.Ok || tokenType != TokenType.FineGrained) return primary;

            // Fine-grained: probe Search to detect the no-repos-selected case.
            try
            {
                var warning = await ProbeRepoVisibilityAsync(token, ct).ConfigureAwait(false);
                return primary with { Warning = warning };
            }
            catch (HttpRequestException ex) when (ex.StatusCode is { } c && (int)c >= 500)
            {
                throw;  // let the outer 5xx catch surface it as ServerError per spec
            }
            catch (HttpRequestException)
            {
                // Probe failed for a non-5xx reason (403/422/transport). The token auth itself
                // succeeded — fail open so a probe anomaly doesn't reject a valid token.
                return primary;
            }
            catch (JsonException)
            {
                // Probe returned 200 with non-JSON body (captive portal, broken proxy). Same
                // fail-open intent as the non-5xx HttpRequestException case above — primary
                // auth already succeeded; don't reject a valid token over a probe anomaly.
                return primary;
            }
        }
        catch (HttpRequestException ex) when (ex.StatusCode is { } code && (int)code >= 500)
        {
            return new AuthValidationResult(false, null, null, AuthValidationError.ServerError, $"GitHub returned {(int)code}.");
        }
        catch (HttpRequestException ex) when (IsDnsFailure(ex))
        {
            return new AuthValidationResult(false, null, null, AuthValidationError.DnsError, $"Couldn't reach {_host}.");
        }
        catch (HttpRequestException ex)
        {
            return new AuthValidationResult(false, null, null, AuthValidationError.NetworkError, ex.Message);
        }
    }

    private enum TokenType { Classic, FineGrained }

    // PRism only supports user PATs for the PoC: classic (ghp_…) and fine-grained (github_pat_…).
    // Any other prefix (gho_, ghs_, ghr_, legacy hex) routes through FineGrained, which is the
    // most permissive: no X-OAuth-Scopes check, so a non-classic token never trips
    // InsufficientScopes spuriously. App-token shapes are not officially supported as auth
    // in PoC; this classification is a "fail safely" default rather than affirmative support.
    private static TokenType ClassifyToken(string token) =>
        token.StartsWith("ghp_", StringComparison.Ordinal) ? TokenType.Classic : TokenType.FineGrained;

    private static bool IsDnsFailure(HttpRequestException ex)
    {
        if (ex.InnerException is SocketException se)
        {
            return se.SocketErrorCode == SocketError.HostNotFound
                || ex.Message.Contains("Name or service not known", StringComparison.OrdinalIgnoreCase)
                || ex.Message.Contains("No such host", StringComparison.OrdinalIgnoreCase);
        }
        return false;
    }

    private static async Task<AuthValidationResult> InterpretAsync(HttpResponseMessage resp, TokenType tokenType, CancellationToken ct)
    {
        if (resp.StatusCode == HttpStatusCode.Unauthorized)
            return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "GitHub rejected this token.");

        if ((int)resp.StatusCode >= 500)
            return new AuthValidationResult(false, null, null, AuthValidationError.ServerError, $"GitHub returned {(int)resp.StatusCode}.");

        if (!resp.IsSuccessStatusCode)
            return new AuthValidationResult(false, null, null, AuthValidationError.NetworkError, $"unexpected status {(int)resp.StatusCode}");

        var scopesHeader = resp.Headers.TryGetValues("X-OAuth-Scopes", out var values) ? string.Join(",", values) : "";
        var scopes = scopesHeader.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (tokenType == TokenType.Classic)
        {
            var missing = RequiredScopes.Except(scopes).ToArray();
            if (missing.Length > 0)
                return new AuthValidationResult(false, null, scopes, AuthValidationError.InsufficientScopes,
                    $"missing scopes: {string.Join(", ", missing)}");
        }

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        string? login;
        try
        {
            using var doc = JsonDocument.Parse(body);
            login = doc.RootElement.TryGetProperty("login", out var l) ? l.GetString() : null;
        }
        catch (JsonException)
        {
            // GitHub-side intermediaries (proxy, captive portal, GHES misconfig) can return
            // 200 with HTML or otherwise malformed JSON. Surface as ServerError, not 500.
            return new AuthValidationResult(false, null, scopes, AuthValidationError.ServerError,
                "GitHub returned an unparseable response body.");
        }

        if (string.IsNullOrEmpty(login))
        {
            // 200 with valid JSON but no `login` field — same shape as the JsonException path
            // above (an intermediary stripped or rewrote the body). Treating this as Ok=true
            // would commit a token but leave IViewerLoginProvider empty, breaking the
            // awaiting-author inbox section.
            return new AuthValidationResult(false, null, scopes, AuthValidationError.ServerError,
                "GitHub returned a response with no login field.");
        }

        return new AuthValidationResult(true, login, scopes, AuthValidationError.None, null);
    }

    private async Task<AuthValidationWarning> ProbeRepoVisibilityAsync(string token, CancellationToken ct)
    {
        if (await SearchHasResultsAsync(token, "is:pr author:@me", ct).ConfigureAwait(false))
            return AuthValidationWarning.None;
        if (await SearchHasResultsAsync(token, "is:pr review-requested:@me", ct).ConfigureAwait(false))
            return AuthValidationWarning.None;
        return AuthValidationWarning.NoReposSelected;
    }

    private async Task<bool> SearchHasResultsAsync(string token, string query, CancellationToken ct)
    {
        var url = $"search/issues?q={Uri.EscapeDataString(query)}&per_page=1";
        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.TryGetProperty("total_count", out var tc)
            && tc.ValueKind == JsonValueKind.Number
            && tc.GetInt32() > 0;
    }

    // Stubs for methods that land in later slices.
    public Task<InboxSection[]> GetInboxAsync(CancellationToken ct) => throw new NotImplementedException("Inbox lands in S2.");
    public bool TryParsePrUrl(string url, out PrReference? reference)
    {
        reference = null;
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        if (!Uri.TryCreate(_host, UriKind.Absolute, out var h)) return false;
        if (!string.Equals(u.Scheme, h.Scheme, StringComparison.OrdinalIgnoreCase)) return false;
        if (!string.Equals(u.Host, h.Host, StringComparison.OrdinalIgnoreCase)) return false;

        var segs = u.AbsolutePath.Trim('/').Split('/');
        if (segs.Length < 4) return false;
        if (!string.Equals(segs[2], "pull", StringComparison.Ordinal)) return false;
        if (!int.TryParse(segs[3], out var n) || n <= 0) return false;

        reference = new PrReference(segs[0], segs[1], n);
        return true;
    }
    // Legacy S0+S1 surface — unused; retained for the S5 capability split per ADR-S5-1.
    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Replaced by GetPrDetailAsync in S3.");
    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Replaced by IterationDto inside PrDetailDto in S3.");
    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) => throw new NotImplementedException("Replaced by GetDiffAsync(prRef, DiffRangeRequest) overload in S3.");
    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException("Replaced by IssueCommentDto/ReviewThreadDto inside PrDetailDto in S3.");

    // S3 PR detail surface — implementations land in this same PR (Task 3.4 onward).
    public async Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);

        // Single GraphQL round-trip with `first:100` on every connection. PoC ships the
        // first-page-only shape: TimelineCapHit reflects whether any connection's
        // pageInfo.hasNextPage is true, so the frontend can render a "Some history beyond
        // N pages was not loaded" banner. Cursor pagination up to MaxTimelinePages = 10
        // is a follow-up (spec § 6.1; Q2 cap detection); the cap-hit signal is the
        // user-visible contract that matters today.
        const string query = "query($owner:String!,$repo:String!,$number:Int!){" +
            "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
            "title body url state isDraft mergeable mergeStateStatus " +
            "headRefName baseRefName headRefOid baseRefOid " +
            "author{login} createdAt closedAt mergedAt changedFiles " +
            "comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId author{login} createdAt body}}" +
            "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isResolved " +
            "comments(first:100){nodes{id author{login} createdAt body lastEditedAt}}}}" +
            "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW]){" +
            "pageInfo{hasNextPage endCursor} nodes{__typename " +
            "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
            "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
            "... on PullRequestReview{submittedAt}" +
            "}}" +
            "}}}";
        var raw = await PostGraphQLAsync(query, new { owner = reference.Owner, repo = reference.Repo, number = reference.Number }, ct).ConfigureAwait(false);

        using var doc = JsonDocument.Parse(raw);
        // GraphQL error responses can omit `data` entirely or set `data.repository` /
        // `data.repository.pullRequest` to JSON null (e.g., permission errors return
        // `{"data": {"repository": null}, "errors": [...]}`). Walk the path defensively
        // and return null for any of those shapes — semantically "PR not found / not
        // accessible." Throwing would conflate transport failures with permission denials.
        if (!TryGetPath(doc.RootElement, out var pull, "data", "repository", "pullRequest")) return null;
        if (pull.ValueKind == JsonValueKind.Null) return null;

        var pr = ParsePr(pull, reference);
        var rootComments = ParseRootComments(pull);
        var reviewComments = ParseReviewThreads(pull);
        var timelineCapHit = HasAnyNextPage(pull);

        // ClusteringQuality, Iterations, and Commits are populated by PrDetailLoader
        // (Task 4) when it composes PrDetailSnapshot. The IReviewService caller returns
        // the GitHub-side facts only; placeholders here are overwritten downstream.
        return new PrDetailDto(
            pr,
            ClusteringQuality: ClusteringQuality.Ok,
            Iterations: Array.Empty<IterationDto>(),
            Commits: Array.Empty<CommitDto>(),
            RootComments: rootComments,
            ReviewComments: reviewComments,
            TimelineCapHit: timelineCapHit);
    }

    public async Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(range);

        // Step 1: fetch /pulls/{n} for the canonical base..head SHAs and changed_files count.
        // The caller's range may either match pull.base..pull.head (canonical PR diff) or be a
        // cross-iteration slice — we route differently below.
        var pull = await FetchPullMetaAsync(reference, ct).ConfigureAwait(false);

        IReadOnlyList<FileChange> files;
        bool truncated;
        if (string.Equals(range.BaseSha, pull.BaseSha, StringComparison.Ordinal)
            && string.Equals(range.HeadSha, pull.HeadSha, StringComparison.Ordinal))
        {
            // Canonical PR diff: paginate pulls/{n}/files. Truncation is derived from
            // pull.changed_files > assembled-count, which catches both 30-page-cap and
            // server-side soft truncation. Spec § 6.1.
            files = await PaginatePullsFilesAsync(reference, ct).ConfigureAwait(false);
            truncated = pull.ChangedFiles > files.Count;
        }
        else
        {
            // Cross-iteration: 3-dot compare endpoint. GC'd SHAs surface as RangeUnreachableException.
            files = await FetchCompareFilesAsync(reference, range, ct).ConfigureAwait(false);
            truncated = false;   // compare endpoint's truncation signal is undocumented; only pulls/{n}/files truncates.
        }

        return new DiffDto($"{range.BaseSha}..{range.HeadSha}", files, truncated);
    }

    public async Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);

        // Independent GraphQL fetch — does NOT call GetPrDetailAsync. The two methods share
        // parsing helpers but each issues its own round-trip; siblings rather than parent-child
        // makes their failure modes independent. Spec § 6.4 / plan Step 3.4.
        const string query = "query($owner:String!,$repo:String!,$number:Int!){" +
            "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
            "comments(first:100){nodes{author{login} createdAt}}" +
            "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW]){" +
            "nodes{__typename " +
            "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
            "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
            "... on PullRequestReview{submittedAt}" +
            "}}" +
            "}}}";
        var raw = await PostGraphQLAsync(query, new { owner = reference.Owner, repo = reference.Repo, number = reference.Number }, ct).ConfigureAwait(false);

        using var doc = JsonDocument.Parse(raw);
        // Defensive path-walk — see GetPrDetailAsync for the GraphQL-error rationale. An
        // empty timeline maps to an empty ClusteringInput (callers treat it as "no
        // signal"); the strategy returns an empty cluster list in that case.
        if (!TryGetPath(doc.RootElement, out var pull, "data", "repository", "pullRequest")
            || pull.ValueKind == JsonValueKind.Null)
        {
            return new ClusteringInput(
                Array.Empty<ClusteringCommit>(),
                Array.Empty<ClusteringForcePush>(),
                Array.Empty<ClusteringReviewEvent>(),
                Array.Empty<ClusteringAuthorComment>());
        }

        var rawCommits = ParseTimelineCommits(pull);
        var forcePushes = ParseForcePushes(pull);
        var reviewEvents = ParseReviewEvents(pull);
        var authorComments = ParseAuthorComments(pull);

        // Per-commit changedFiles fan-out — concurrency cap 8, 100ms inter-batch pace.
        // 4xx on any commit marks the session degraded (skip remaining fan-out, leave
        // those commits' ChangedFiles=null). Above SkipJaccardAboveCommitCount, skip
        // entirely (FileJaccardMultiplier returns neutral 1.0 when ChangedFiles is null).
        const int SkipAbove = 100;
        const int ConcurrencyCap = 8;
        IReadOnlyList<ClusteringCommit> commits = rawCommits.Count > SkipAbove
            ? rawCommits
            : await FetchPerCommitChangedFilesAsync(reference, rawCommits, ConcurrencyCap, ct).ConfigureAwait(false);

        return new ClusteringInput(commits, forcePushes, reviewEvents, authorComments);
    }

    public async Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(path);
        ArgumentNullException.ThrowIfNull(sha);

        const long MaxBytes = 5L * 1024 * 1024;
        // Per-segment escape: GitHub's contents API requires literal '/' as directory
        // separators. Uri.EscapeDataString on the whole path encodes '/' as '%2F',
        // which makes any subdirectoried file return 404. Split, escape, rejoin.
        var encodedPath = string.Join("/", path.Split('/').Select(Uri.EscapeDataString));
        var url = $"repos/{reference.Owner}/{reference.Repo}/contents/{encodedPath}?ref={Uri.EscapeDataString(sha)}";
        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        // The raw media type returns the file body directly rather than a JSON envelope —
        // matches what the diff pane needs for word-diff and markdown rendering.
        req.Headers.Accept.ParseAdd("application/vnd.github.raw");

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound)
            return new FileContentResult(FileContentStatus.NotFound, null, 0);
        resp.EnsureSuccessStatusCode();

        var bytes = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        if (bytes.LongLength > MaxBytes)
            return new FileContentResult(FileContentStatus.TooLarge, null, bytes.LongLength);
        if (LooksBinary(bytes))
            return new FileContentResult(FileContentStatus.Binary, null, bytes.LongLength);
        return new FileContentResult(FileContentStatus.Ok, System.Text.Encoding.UTF8.GetString(bytes), bytes.LongLength);
    }

    // Heuristic: any null byte in the first 8 KiB. A real binary detector would also look
    // for non-UTF-8 sequences, but for PoC the diff pane just needs a "skip text rendering"
    // signal and null-byte presence is the cheapest reliable check.
    private static bool LooksBinary(byte[] bytes)
    {
        var n = Math.Min(bytes.Length, 8192);
        for (var i = 0; i < n; i++)
            if (bytes[i] == 0) return true;
        return false;
    }

    public async Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);

        // Three cheap REST calls, parallelized:
        //   pulls/{n}              → head SHA, mergeable_state, state
        //   pulls/{n}/comments?per_page=1 → first item + Link rel="last" → total count
        //   pulls/{n}/reviews?per_page=1  → ditto
        // Spec § 6.2.
        var pullTask = FetchPullJsonAsync(reference, ct);
        var commentsTask = FetchPagedCountAsync($"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}/comments?per_page=1", ct);
        var reviewsTask = FetchPagedCountAsync($"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}/reviews?per_page=1", ct);

        var pull = await pullTask.ConfigureAwait(false);
        var commentCount = await commentsTask.ConfigureAwait(false);
        var reviewCount = await reviewsTask.ConfigureAwait(false);

        return new ActivePrPollSnapshot(
            HeadSha: pull.HeadSha,
            Mergeability: pull.Mergeability,
            PrState: pull.State,
            CommentCount: commentCount,
            ReviewCount: reviewCount);
    }

    private async Task<PollPullMeta> FetchPullJsonAsync(PrReference reference, CancellationToken ct)
    {
        var url = $"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}";
        using var http = _httpFactory.CreateClient("github");
        using var resp = await SendGitHubAsync(http, HttpMethod.Get, url, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var head = root.TryGetProperty("head", out var h) && h.TryGetProperty("sha", out var hs)
            ? hs.GetString() ?? "" : "";
        var state = root.TryGetProperty("state", out var s) ? s.GetString() ?? "" : "";
        var mergeable = root.TryGetProperty("mergeable_state", out var ms) ? ms.GetString() ?? "" : "";
        return new PollPullMeta(head, state, mergeable);
    }

    private async Task<int> FetchPagedCountAsync(string url, CancellationToken ct)
    {
        // GitHub pagination: with per_page=1, the response array is the first item and
        // the Link header carries a rel="last" URL whose &page=N parameter is the total
        // count. When the result fits in one page, no Link header is present and the
        // array length is the count.
        using var http = _httpFactory.CreateClient("github");
        using var resp = await SendGitHubAsync(http, HttpMethod.Get, url, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (TryParseLastPage(resp, out var lastPage))
            return lastPage;

        // Fall back to counting the array elements (0 or 1 with per_page=1).
        try
        {
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.ValueKind == JsonValueKind.Array
                ? doc.RootElement.GetArrayLength()
                : 0;
        }
        catch (JsonException)
        {
            return 0;
        }
    }

    private static bool TryParseLastPage(HttpResponseMessage resp, out int lastPage)
    {
        lastPage = 0;
        if (!resp.Headers.TryGetValues("Link", out var values)) return false;
        foreach (var raw in values)
        {
            foreach (var part in raw.Split(','))
            {
                var trimmed = part.Trim();
                if (!trimmed.Contains("rel=\"last\"", StringComparison.Ordinal)) continue;
                var lt = trimmed.IndexOf('<', StringComparison.Ordinal);
                var gt = trimmed.IndexOf('>', StringComparison.Ordinal);
                if (lt < 0 || gt <= lt) continue;
                var absolute = trimmed[(lt + 1)..gt];
                if (!Uri.TryCreate(absolute, UriKind.Absolute, out var u)) continue;
                var query = u.Query.TrimStart('?');
                foreach (var kv in query.Split('&'))
                {
                    var eq = kv.IndexOf('=', StringComparison.Ordinal);
                    if (eq <= 0) continue;
                    var key = kv[..eq];
                    var value = kv[(eq + 1)..];
                    if (string.Equals(key, "page", StringComparison.Ordinal) &&
                        int.TryParse(value, System.Globalization.CultureInfo.InvariantCulture, out var n))
                    {
                        lastPage = n;
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private sealed record PollPullMeta(string HeadSha, string State, string Mergeability);

    public Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct) => throw new NotImplementedException("Submit lands in S5.");

    private async Task<PullMeta> FetchPullMetaAsync(PrReference reference, CancellationToken ct)
    {
        var url = $"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}";
        using var http = _httpFactory.CreateClient("github");
        using var resp = await SendGitHubAsync(http, HttpMethod.Get, url, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var changedFiles = root.TryGetProperty("changed_files", out var cf) ? cf.GetInt32() : 0;
        var baseSha = root.GetProperty("base").GetProperty("sha").GetString() ?? "";
        var headSha = root.GetProperty("head").GetProperty("sha").GetString() ?? "";
        return new PullMeta(baseSha, headSha, changedFiles);
    }

    private async Task<IReadOnlyList<FileChange>> PaginatePullsFilesAsync(PrReference reference, CancellationToken ct)
    {
        const int MaxPages = 30;   // GitHub's documented cap; pulls/{n}/files truncates beyond this.
        var collected = new List<FileChange>();
        var url = $"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}/files?per_page=100";
        var pageCount = 0;
        using var http = _httpFactory.CreateClient("github");
        while (url is not null && pageCount < MaxPages)
        {
            using var resp = await SendGitHubAsync(http, HttpMethod.Get, url, ct).ConfigureAwait(false);
            resp.EnsureSuccessStatusCode();
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            collected.AddRange(ParseFileChanges(doc.RootElement));

            url = ExtractNextLink(resp);
            pageCount++;
        }
        return collected;
    }

    private async Task<IReadOnlyList<FileChange>> FetchCompareFilesAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct)
    {
        var url = $"repos/{reference.Owner}/{reference.Repo}/compare/{Uri.EscapeDataString(range.BaseSha)}...{Uri.EscapeDataString(range.HeadSha)}";
        using var http = _httpFactory.CreateClient("github");
        using var resp = await SendGitHubAsync(http, HttpMethod.Get, url, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound)
            throw new RangeUnreachableException(range.BaseSha, range.HeadSha);
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (!root.TryGetProperty("files", out var filesEl) || filesEl.ValueKind != JsonValueKind.Array)
            return Array.Empty<FileChange>();
        return ParseFileChanges(filesEl);
    }

    private static IReadOnlyList<FileChange> ParseFileChanges(JsonElement filesArray)
    {
        if (filesArray.ValueKind != JsonValueKind.Array) return Array.Empty<FileChange>();
        var result = new List<FileChange>(filesArray.GetArrayLength());
        foreach (var f in filesArray.EnumerateArray())
        {
            var path = f.TryGetProperty("filename", out var fn) ? fn.GetString() ?? "" : "";
            var statusStr = f.TryGetProperty("status", out var st) ? st.GetString() ?? "modified" : "modified";
            var status = statusStr switch
            {
                "added" => FileChangeStatus.Added,
                "removed" or "deleted" => FileChangeStatus.Deleted,
                "renamed" => FileChangeStatus.Renamed,
                _ => FileChangeStatus.Modified,
            };
            // PoC: hunks aren't parsed from the patch text in this slice; the diff pane
            // re-fetches the file content and runs jsdiff. The patch field is preserved
            // server-side but FileChange.Hunks is intentionally empty here. See spec § 6.1.
            result.Add(new FileChange(path, status, Array.Empty<DiffHunk>()));
        }
        return result;
    }

    private static string? ExtractNextLink(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("Link", out var values)) return null;
        // Link: <https://api.github.com/...>; rel="next", <...>; rel="last"
        foreach (var raw in values)
        {
            foreach (var part in raw.Split(','))
            {
                var trimmed = part.Trim();
                if (!trimmed.Contains("rel=\"next\"", StringComparison.Ordinal)) continue;
                var lt = trimmed.IndexOf('<', StringComparison.Ordinal);
                var gt = trimmed.IndexOf('>', StringComparison.Ordinal);
                if (lt < 0 || gt <= lt) continue;
                var absolute = trimmed[(lt + 1)..gt];
                // Strip the leading scheme+host so the HttpClient.BaseAddress prefix is reused.
                if (Uri.TryCreate(absolute, UriKind.Absolute, out var u))
                    return u.PathAndQuery.TrimStart('/');
                return absolute;
            }
        }
        return null;
    }

    private static async Task<HttpResponseMessage> SendGitHubAsync(HttpClient http, HttpMethod method, string url, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, url);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        return await http.SendAsync(req, ct).ConfigureAwait(false);
    }

    private sealed record PullMeta(string BaseSha, string HeadSha, int ChangedFiles);

    // Inter-batch pace between concurrent per-commit fan-out batches. Transport-layer
    // concern (rate-limit defense), not a clustering coefficient. Spec § 6.4.
    private const int InterBatchPaceMs = 100;

    private async Task<string> PostGraphQLAsync(string query, object variables, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        var payload = JsonSerializer.Serialize(new { query, variables });
        using var http = _httpFactory.CreateClient("github");
        // Absolute URL to defeat the named client's BaseAddress = `<host>/api/v3/`. GHES's
        // GraphQL endpoint is `<host>/api/graphql` (no /v3); resolving against BaseAddress
        // would 404 on every GraphQL call against GHES.
        var endpoint = HostUrlResolver.GraphQlEndpoint(_host);
        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(payload, System.Text.Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        // EnsureSuccessStatusCode throws HttpRequestException with the status code on
        // non-2xx — distinguishes transport / auth / 5xx failures from a 200 response that
        // legitimately reports `pullRequest: null` (PR doesn't exist). Without this, every
        // failure mode would collapse to "PR not found" at the caller.
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
    }

    private static List<ClusteringCommit> ParseTimelineCommits(JsonElement pull)
    {
        var result = new List<ClusteringCommit>();
        if (!pull.TryGetProperty("timelineItems", out var ti) ||
            !ti.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var node in nodes.EnumerateArray())
        {
            if (!IsTypeName(node, "PullRequestCommit")) continue;
            if (!node.TryGetProperty("commit", out var c)) continue;
            var sha = c.TryGetProperty("oid", out var o) ? o.GetString() ?? "" : "";
            var date = c.TryGetProperty("committedDate", out var d) ? d.GetDateTimeOffset() : default;
            var message = c.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "";
            var add = c.TryGetProperty("additions", out var a) ? a.GetInt32() : 0;
            var del = c.TryGetProperty("deletions", out var dl) ? dl.GetInt32() : 0;
            // ChangedFiles is filled in later by the per-commit REST fan-out (or stays null
            // when fan-out is skipped above the commit-count cap or after a 4xx degrade).
            result.Add(new ClusteringCommit(sha, date, message, add, del, ChangedFiles: null));
        }
        return result;
    }

    private static List<ClusteringForcePush> ParseForcePushes(JsonElement pull)
    {
        var result = new List<ClusteringForcePush>();
        if (!pull.TryGetProperty("timelineItems", out var ti) ||
            !ti.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var node in nodes.EnumerateArray())
        {
            if (!IsTypeName(node, "HeadRefForcePushedEvent")) continue;
            string? before = null;
            if (node.TryGetProperty("beforeCommit", out var b) && b.ValueKind == JsonValueKind.Object)
                before = b.TryGetProperty("oid", out var bo) ? bo.GetString() : null;
            string? after = null;
            if (node.TryGetProperty("afterCommit", out var aft) && aft.ValueKind == JsonValueKind.Object)
                after = aft.TryGetProperty("oid", out var ao) ? ao.GetString() : null;
            var occurred = node.TryGetProperty("createdAt", out var ca) ? ca.GetDateTimeOffset() : default;
            result.Add(new ClusteringForcePush(before, after, occurred));
        }
        return result;
    }

    private static List<ClusteringReviewEvent> ParseReviewEvents(JsonElement pull)
    {
        var result = new List<ClusteringReviewEvent>();
        if (!pull.TryGetProperty("timelineItems", out var ti) ||
            !ti.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var node in nodes.EnumerateArray())
        {
            if (!IsTypeName(node, "PullRequestReview")) continue;
            var ts = node.TryGetProperty("submittedAt", out var s) ? s.GetDateTimeOffset() : default;
            result.Add(new ClusteringReviewEvent(ts));
        }
        return result;
    }

    private static List<ClusteringAuthorComment> ParseAuthorComments(JsonElement pull)
    {
        var result = new List<ClusteringAuthorComment>();
        if (!pull.TryGetProperty("comments", out var comments) ||
            !comments.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var node in nodes.EnumerateArray())
        {
            // The clustering signal cares about *author* comments, not all PR-root comments.
            // Identifying the PR author requires a separate `author { login }` field on the
            // PR. PoC is fine with all root comments treated as candidates — clustering
            // doesn't differentiate; the signal is "PR-side conversation activity."
            var ts = node.TryGetProperty("createdAt", out var c) ? c.GetDateTimeOffset() : default;
            result.Add(new ClusteringAuthorComment(ts));
        }
        return result;
    }

    private static bool IsTypeName(JsonElement node, string expected)
    {
        if (!node.TryGetProperty("__typename", out var tn)) return false;
        return string.Equals(tn.GetString(), expected, StringComparison.Ordinal);
    }

    // Walks a chain of property names defensively. Returns false on any missing key,
    // any non-object intermediate, or short-circuits at the first JSON null.
    private static bool TryGetPath(JsonElement root, out JsonElement leaf, params string[] path)
    {
        var current = root;
        foreach (var key in path)
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(key, out var next))
            {
                leaf = default;
                return false;
            }
            current = next;
        }
        leaf = current;
        return true;
    }

    private static Pr ParsePr(JsonElement pull, PrReference reference)
    {
        string GetStr(string name) =>
            pull.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String
                ? el.GetString() ?? "" : "";
        DateTimeOffset GetDate(string name) =>
            pull.TryGetProperty(name, out var el) && el.ValueKind != JsonValueKind.Null
                ? el.GetDateTimeOffset() : default;
        string Author()
        {
            if (!pull.TryGetProperty("author", out var a) || a.ValueKind != JsonValueKind.Object) return "";
            return a.TryGetProperty("login", out var l) ? l.GetString() ?? "" : "";
        }

        // GitHub returns "MERGEABLE" | "CONFLICTING" | "UNKNOWN" — pass through as-is.
        // mergeStateStatus is a finer-grained signal ("BEHIND", "DIRTY", etc.); we collapse
        // both into a single `Mergeability` field for the Pr record. Spec § 6.1.
        var mergeability = GetStr("mergeable");
        var ciSummary = "";   // computed by PrDetailLoader (or by an upstream enrichment); placeholder here.

        var state = GetStr("state");
        var isMerged = string.Equals(state, "MERGED", StringComparison.Ordinal) ||
                       (pull.TryGetProperty("mergedAt", out var ma) && ma.ValueKind != JsonValueKind.Null);
        var isClosed = string.Equals(state, "CLOSED", StringComparison.Ordinal) || isMerged;

        return new Pr(
            reference,
            Title: GetStr("title"),
            Body: GetStr("body"),
            Author: Author(),
            State: state,
            HeadSha: GetStr("headRefOid"),
            BaseSha: GetStr("baseRefOid"),
            HeadBranch: GetStr("headRefName"),
            BaseBranch: GetStr("baseRefName"),
            Mergeability: mergeability,
            CiSummary: ciSummary,
            IsMerged: isMerged,
            IsClosed: isClosed,
            OpenedAt: GetDate("createdAt"));
    }

    private static List<IssueCommentDto> ParseRootComments(JsonElement pull)
    {
        var result = new List<IssueCommentDto>();
        if (!pull.TryGetProperty("comments", out var c) ||
            !c.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var node in nodes.EnumerateArray())
        {
            var id = node.TryGetProperty("databaseId", out var db) ? db.GetInt64() : 0L;
            var author = node.TryGetProperty("author", out var a) && a.ValueKind == JsonValueKind.Object
                ? (a.TryGetProperty("login", out var l) ? l.GetString() ?? "" : "")
                : "";
            var ts = node.TryGetProperty("createdAt", out var ca) ? ca.GetDateTimeOffset() : default;
            var body = node.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";
            result.Add(new IssueCommentDto(id, author, ts, body));
        }
        return result;
    }

    private static List<ReviewThreadDto> ParseReviewThreads(JsonElement pull)
    {
        var result = new List<ReviewThreadDto>();
        if (!pull.TryGetProperty("reviewThreads", out var rt) ||
            !rt.TryGetProperty("nodes", out var threadNodes) ||
            threadNodes.ValueKind != JsonValueKind.Array)
            return result;

        foreach (var t in threadNodes.EnumerateArray())
        {
            var threadId = t.TryGetProperty("id", out var ti) ? ti.GetString() ?? "" : "";
            var path = t.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "";
            var line = t.TryGetProperty("line", out var ln) && ln.ValueKind == JsonValueKind.Number ? ln.GetInt32() : 0;
            var resolved = t.TryGetProperty("isResolved", out var ir) && ir.ValueKind == JsonValueKind.True;
            var comments = new List<ReviewCommentDto>();
            if (t.TryGetProperty("comments", out var cs) &&
                cs.TryGetProperty("nodes", out var cnodes) &&
                cnodes.ValueKind == JsonValueKind.Array)
            {
                foreach (var cn in cnodes.EnumerateArray())
                {
                    var cid = cn.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "";
                    var cauthor = cn.TryGetProperty("author", out var ca) && ca.ValueKind == JsonValueKind.Object
                        ? (ca.TryGetProperty("login", out var cl) ? cl.GetString() ?? "" : "")
                        : "";
                    var cts = cn.TryGetProperty("createdAt", out var cca) ? cca.GetDateTimeOffset() : default;
                    var cbody = cn.TryGetProperty("body", out var cb) ? cb.GetString() ?? "" : "";
                    DateTimeOffset? edited = null;
                    if (cn.TryGetProperty("lastEditedAt", out var le) && le.ValueKind != JsonValueKind.Null)
                        edited = le.GetDateTimeOffset();
                    comments.Add(new ReviewCommentDto(cid, cauthor, cts, cbody, edited));
                }
            }
            // anchor SHA isn't returned by reviewThreads in this query; thread-anchor
            // resolution against the PR diff is a PrDetailLoader concern in Task 4.
            // Use HeadSha placeholder here; the loader can refine.
            result.Add(new ReviewThreadDto(threadId, path, line, AnchorSha: "", IsResolved: resolved, Comments: comments));
        }
        return result;
    }

    private static bool HasAnyNextPage(JsonElement pull)
    {
        return ConnectionHasNext(pull, "comments")
            || ConnectionHasNext(pull, "reviewThreads")
            || ConnectionHasNext(pull, "timelineItems");
    }

    private static bool ConnectionHasNext(JsonElement pull, string connection)
    {
        if (!pull.TryGetProperty(connection, out var conn)) return false;
        if (!conn.TryGetProperty("pageInfo", out var pi)) return false;
        return pi.TryGetProperty("hasNextPage", out var hnp) && hnp.ValueKind == JsonValueKind.True;
    }

    private async Task<IReadOnlyList<ClusteringCommit>> FetchPerCommitChangedFilesAsync(
        PrReference reference,
        List<ClusteringCommit> commits,
        int concurrencyCap,
        CancellationToken ct)
    {
        if (commits.Count == 0) return commits;

        // Process in fixed-size batches with an inter-batch pace. The session-degrade flag
        // ratchets to true on any 4xx and stays true; once degraded, remaining batches
        // resolve every commit's ChangedFiles to null without issuing more requests.
        var result = new ClusteringCommit[commits.Count];
        var degraded = false;
        for (var batchStart = 0; batchStart < commits.Count; batchStart += concurrencyCap)
        {
            if (batchStart > 0)
                await Task.Delay(InterBatchPaceMs, ct).ConfigureAwait(false);

            var batchEnd = Math.Min(batchStart + concurrencyCap, commits.Count);
            var batchTasks = new List<Task<(int idx, ClusteringCommit commit, bool got4xx)>>(batchEnd - batchStart);
            for (var i = batchStart; i < batchEnd; i++)
            {
                var idx = i;
                var commit = commits[idx];
                if (degraded)
                {
                    result[idx] = commit;   // ChangedFiles already null
                    continue;
                }
                batchTasks.Add(FetchOneCommitChangedFilesAsync(reference, idx, commit, ct));
            }

            var batchResults = await Task.WhenAll(batchTasks).ConfigureAwait(false);
            foreach (var (idx, commit, got4xx) in batchResults)
            {
                result[idx] = commit;
                if (got4xx) degraded = true;
            }
        }
        return result;
    }

    private async Task<(int idx, ClusteringCommit commit, bool got4xx)> FetchOneCommitChangedFilesAsync(
        PrReference reference,
        int idx,
        ClusteringCommit commit,
        CancellationToken ct)
    {
        var url = $"repos/{reference.Owner}/{reference.Repo}/commits/{commit.Sha}";
        try
        {
            using var http = _httpFactory.CreateClient("github");
            using var resp = await SendGitHubAsync(http, HttpMethod.Get, url, ct).ConfigureAwait(false);
            if ((int)resp.StatusCode is >= 400 and < 500)
                return (idx, commit, got4xx: true);
            if (!resp.IsSuccessStatusCode)
                return (idx, commit, got4xx: false);

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("files", out var files) ||
                files.ValueKind != JsonValueKind.Array)
                return (idx, commit, got4xx: false);

            var paths = new List<string>(files.GetArrayLength());
            foreach (var f in files.EnumerateArray())
            {
                if (f.TryGetProperty("filename", out var fn) && fn.GetString() is { } name)
                    paths.Add(name);
            }
            return (idx, commit with { ChangedFiles = paths }, got4xx: false);
        }
        catch (HttpRequestException)
        {
            // Treat transport errors like a soft degrade — keep ChangedFiles null but don't
            // mark the session degraded (the next commit might succeed).
            return (idx, commit, got4xx: false);
        }
        catch (TaskCanceledException)
        {
            return (idx, commit, got4xx: false);
        }
    }
}
