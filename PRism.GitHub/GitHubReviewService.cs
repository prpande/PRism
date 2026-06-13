using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.GitHub;

public sealed partial class GitHubReviewService : IReviewAuth, IPrDiscovery, IPrReader, IReviewSubmitter
{
    // Classic-PAT scope requirements, expressed as (capability, scopes that satisfy it).
    // GitHub reports only the literally-granted scope in X-OAuth-Scopes — a parent scope is
    // NOT expanded into its children — so any parent that supersets a requirement must be
    // listed explicitly as an accepting scope:
    //   • `repo` has no parent; only the full `repo` scope reads private PRs. Its children
    //     (`public_repo`, `repo:status`, …) are narrower and must NOT satisfy it.
    //   • `read:org` is satisfied by itself or either parent, `write:org` / `admin:org`.
    // `read:user` is intentionally absent: no PRism API call needs it (commenter avatars and
    // public profiles are returned without any user scope, and /user returns the token-holder's
    // login regardless of scope). Requiring it rejected tokens that granted the `user` parent.
    private static readonly (string Capability, string[] AcceptedBy)[] RequiredScopes =
    [
        ("repo", ["repo"]),
        ("read:org", ["read:org", "write:org", "admin:org"]),
    ];

    // Single source of truth for the PR-detail GraphQL query shape. Lifted out of
    // GetPrDetailAsync so the integration test 7g (Frozen_pr_graphql_shape_unchanged) can
    // replay the EXACT same query the production code issues — and so a future schema
    // refactor here flips the shape-drift test before it ships. `internal` (not public)
    // because the query string is an implementation detail of the GitHub adapter;
    // PRism.GitHub.Tests.Integration sees it via InternalsVisibleTo (csproj).
    // #320 — shared timeline selection, composed byte-identically into PrDetailGraphQLQuery
    // (with the pageInfo wrapper) and TimelineQuery (without it). Extracting brings the
    // GetTimelineAsync copy under the byte-identity test (previously unprotected).
    internal const string TimelineItemsArgs =
        "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW])";
    internal const string TimelineNodes =
        "nodes{__typename " +
        "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
        "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
        "... on PullRequestReview{submittedAt}" +
        "}";

    // Sibling timeline-only query issued by GetTimelineAsync. Internal const (was a method-local
    // const) so the byte-identity test can pin it; same shared fragment as PrDetailGraphQLQuery,
    // minus the pageInfo wrapper.
    internal const string TimelineQuery = "query($owner:String!,$repo:String!,$number:Int!){" +
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "comments(first:100){nodes{author{login} createdAt}}" +
        TimelineItemsArgs + "{" + TimelineNodes + "}" +
        "}}}";

    internal const string PrDetailGraphQLQuery = "query($owner:String!,$repo:String!,$number:Int!){" +
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "title body url state isDraft mergeable mergeStateStatus " +
        "headRefName baseRefName headRefOid baseRefOid " +
        "author{login avatarUrl} createdAt closedAt mergedAt changedFiles " +
        "comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId author{login avatarUrl} createdAt body}}" +
        "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isResolved " +
        "comments(first:100){nodes{id databaseId author{login avatarUrl} createdAt body lastEditedAt}}}}" +
        TimelineItemsArgs + "{pageInfo{hasNextPage endCursor} " + TimelineNodes + "}" +
        "}}}";

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;
    private readonly ILogger<GitHubReviewService> _log;

    public GitHubReviewService(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        string host,
        ILogger<GitHubReviewService>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
        _log = log ?? NullLogger<GitHubReviewService>.Instance;
    }

    public async Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct, bool skipCredentialHealth = false)
    {
        var token = await _readToken().ConfigureAwait(false);
        if (string.IsNullOrEmpty(token))
            return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "no token");

        var tokenType = ClassifyToken(token);

        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, "user");
        GitHubHttp.ApplyHeaders(req, http, token);
        if (skipCredentialHealth) req.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true);

        try
        {
            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            var primary = await InterpretAsync(resp, tokenType, ct).ConfigureAwait(false);
            if (!primary.Ok || tokenType != TokenType.FineGrained) return primary;

            // Fine-grained: probe Search to detect the no-repos-selected case.
            try
            {
                var warning = await ProbeRepoVisibilityAsync(token, skipCredentialHealth, ct).ConfigureAwait(false);
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
            var granted = scopes.ToHashSet(StringComparer.Ordinal);
            // A capability is satisfied when the token grants any scope that accepts it
            // (the scope itself or one of its parents). Report the capability name — not the
            // accepting set — so the user sees what to add, e.g. "missing scopes: read:org".
            var missing = RequiredScopes
                .Where(r => !r.AcceptedBy.Any(granted.Contains))
                .Select(r => r.Capability)
                .ToArray();
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

    private async Task<AuthValidationWarning> ProbeRepoVisibilityAsync(string token, bool skipCredentialHealth, CancellationToken ct)
    {
        if (await SearchHasResultsAsync(token, "is:pr author:@me", skipCredentialHealth, ct).ConfigureAwait(false))
            return AuthValidationWarning.None;
        if (await SearchHasResultsAsync(token, "is:pr review-requested:@me", skipCredentialHealth, ct).ConfigureAwait(false))
            return AuthValidationWarning.None;
        return AuthValidationWarning.NoReposSelected;
    }

    private async Task<bool> SearchHasResultsAsync(string token, string query, bool skipCredentialHealth, CancellationToken ct)
    {
        var url = $"search/issues?q={Uri.EscapeDataString(query)}&per_page=1";
        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        GitHubHttp.ApplyHeaders(req, http, token);
        if (skipCredentialHealth) req.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true);

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
        //
        // Query string lifted to `PrDetailGraphQLQuery` (class-level internal const) so
        // the integration shape-drift test can issue the exact same query.
        var raw = await PostGraphQLAsync(PrDetailGraphQLQuery, new { owner = reference.Owner, repo = reference.Repo, number = reference.Number }, ct).ConfigureAwait(false);

        using var doc = JsonDocument.Parse(raw);
        // GraphQL responses are HTTP 200 even on execution errors — the `errors` array
        // carries them. Surface "errors with no usable data" as an exception so the
        // caller can distinguish it from "data:null because PR doesn't exist." Partial
        // data with non-empty errors is delivered to the parser (per GraphQL spec); we
        // log the errors but continue.
        ThrowIfGraphQLErrorsWithoutData(doc.RootElement);

        // For "no usable data" shapes (data missing entirely, or data.repository:null,
        // or data.repository.pullRequest:null), return null — semantically "PR not
        // found / not accessible."
        if (!TryGetPath(doc.RootElement, out var pull, "data", "repository", "pullRequest")) return null;
        if (pull.ValueKind == JsonValueKind.Null) return null;

        var pr = GitHubPrParser.ParsePr(pull, reference);
        var rootComments = GitHubPrParser.ParseRootComments(pull);
        var reviewComments = GitHubPrParser.ParseReviewThreads(pull);
        var timelineCapHit = HasAnyNextPage(pull);
        if (timelineCapHit) Log.TimelineCapHit(_log, reference.Owner, reference.Repo, reference.Number);

        // Clustering is performed by PrDetailLoader (Task 4); IPrReader returns the
        // GitHub-side facts only and the loader overwrites these fields. Default to
        // ClusteringQuality.Low + Iterations:null so the DTO is internally consistent
        // before the loader runs (Ok would imply trustworthy iteration boundaries —
        // contradicting Iterations being empty). Commits is empty here because the
        // commit list comes from GetTimelineAsync's per-commit data, which the loader
        // composes separately.
        return new PrDetailDto(
            pr,
            ClusteringQuality: ClusteringQuality.Low,
            Iterations: null,
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
            files = await PaginatePullsFilesAsync(reference, range, ct).ConfigureAwait(false);
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
        var raw = await PostGraphQLAsync(TimelineQuery, new { owner = reference.Owner, repo = reference.Repo, number = reference.Number }, ct).ConfigureAwait(false);

        using var doc = JsonDocument.Parse(raw);
        // Surface execution-level GraphQL errors as an exception when no usable data
        // came back (see GetPrDetailAsync for the rationale). Partial data with errors
        // continues into the parser.
        ThrowIfGraphQLErrorsWithoutData(doc.RootElement);

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

        var rawCommits = GitHubPrParser.ParseTimelineCommits(pull);
        var forcePushes = GitHubPrParser.ParseForcePushes(pull);
        var reviewEvents = GitHubPrParser.ParseReviewEvents(pull);
        var authorComments = GitHubPrParser.ParseAuthorComments(pull);

        // Per-commit changedFiles fan-out — concurrency cap 8, 100ms inter-batch pace.
        // 4xx on any commit marks the session degraded (skip remaining fan-out, leave
        // those commits' ChangedFiles=null). Above SkipJaccardAboveCommitCount, skip
        // entirely (FileJaccardMultiplier returns neutral 1.0 when ChangedFiles is null).
        const int SkipAbove = 100;
        IReadOnlyList<ClusteringCommit> commits = rawCommits.Count > SkipAbove
            ? rawCommits
            : await FetchPerCommitChangedFilesAsync(reference, rawCommits, GitHubHttp.ConcurrencyCap, ct).ConfigureAwait(false);

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

        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        // The raw media type returns the file body directly rather than a JSON envelope —
        // matches what the diff pane needs for word-diff and markdown rendering. Note that
        // the standard +json Accept does NOT apply here (we want the file body verbatim).
        using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct,
            accept: "application/vnd.github.raw").ConfigureAwait(false);
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

    public async Task<CommitInfo?> GetCommitAsync(PrReference reference, string sha, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(sha);

        var url = $"repos/{reference.Owner}/{reference.Repo}/commits/{Uri.EscapeDataString(sha)}";

        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound)
            return null;
        resp.EnsureSuccessStatusCode();

        // Parse just the canonical sha — the only field PR3's force-push fallback consumes.
        // Future callers can extend CommitInfo and pull more fields here without breaking
        // the existing presence-check semantic.
        var bytes = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(bytes);
        var canonicalSha = doc.RootElement.TryGetProperty("sha", out var shaProp) && shaProp.ValueKind == JsonValueKind.String
            ? shaProp.GetString() ?? sha
            : sha;
        return new CommitInfo(canonicalSha);
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

        // Normalize PrState to a lowercase 3-value state. REST `state` is already lowercase
        // ("open"/"closed"); a merged PR reports "closed", so we promote it to "merged" when
        // merged_at was present. PrState ∈ {"open","closed","merged"} — the poller diffs this
        // to emit pr-updated on an open→done transition even when head-sha is unchanged.
        return new ActivePrPollSnapshot(
            HeadSha: pull.HeadSha,
            Mergeability: pull.Mergeability,
            PrState: pull.Merged ? "merged" : pull.State,
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
        // merged_at is a root-level ISO-8601 string on a merged PR, JSON null otherwise.
        // REST `state` is only "open"/"closed" (a merged PR reports "closed"), so merged_at
        // is the sole signal that distinguishes a merge from a plain close.
        var merged = root.TryGetProperty("merged_at", out var ma) && ma.ValueKind == JsonValueKind.String;
        return new PollPullMeta(head, state, mergeable, merged);
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
        // #320 — one Link parser (GitHubLinkHeader); the &page= extraction stays here because
        // it is a rel="last"-specific concern, not part of Link parsing.
        if (!GitHubLinkHeader.TryGetRel(resp, "last", out var absolute)) return false;
        if (!Uri.TryCreate(absolute, UriKind.Absolute, out var u)) return false;
        foreach (var kv in u.Query.TrimStart('?').Split('&'))
        {
            var eq = kv.IndexOf('=', StringComparison.Ordinal);
            if (eq <= 0) continue;
            if (string.Equals(kv[..eq], "page", StringComparison.Ordinal) &&
                int.TryParse(kv[(eq + 1)..], System.Globalization.CultureInfo.InvariantCulture, out var n))
            {
                lastPage = n;
                return true;
            }
        }
        return false;
    }

    private sealed record PollPullMeta(string HeadSha, string State, string Mergeability, bool Merged);

    // IReviewSubmitter is an empty seam in PR0a; the seven pending-review pipeline methods
    // land in PR1 on GitHubReviewService.Submit.cs.

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

    private async Task<IReadOnlyList<FileChange>> PaginatePullsFilesAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct)
    {
        const int MaxPages = 30;   // GitHub's documented cap; pulls/{n}/files truncates beyond this.
        var collected = new List<FileChange>();
        // Explicit `string?` so the `url = nextUrl` assignment below stays nullable-clean
        // under <Nullable>enable</Nullable> + <TreatWarningsAsErrors>true</TreatWarningsAsErrors>.
        // `var` would infer non-nullable here and the next-link `null` would flag CS8600.
        string? url = $"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}/files?per_page=100";
        var pageCount = 0;
        var moreAvailable = false;
        using var http = _httpFactory.CreateClient("github");
        while (url is not null && pageCount < MaxPages)
        {
            using var resp = await SendGitHubAsync(http, HttpMethod.Get, url, ct).ConfigureAwait(false);
            // On a done (merged/closed) PR the canonical base..head diff can become
            // unaddressable — GitHub returns 404 (or 410 Gone) when the head ref / commits
            // were pruned after the PR closed. Surface this as the SAME typed
            // RangeUnreachableException the cross-iteration (3-dot compare) path already
            // raises so it flows through one user-visible "diff unavailable" path rather
            // than throwing HttpRequestException → 500. Spec § 5.1 / § 9. Other non-2xx
            // (auth, rate-limit, 5xx) keep EnsureSuccessStatusCode's behavior.
            if (resp.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
                throw new RangeUnreachableException(range.BaseSha, range.HeadSha);
            resp.EnsureSuccessStatusCode();
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            collected.AddRange(ParseFileChanges(doc.RootElement));

            // #320 — pass the ABSOLUTE next URL straight through (GitHub-returned, same host).
            // On github.com this is wire-identical to the old relative-path strip; on GHES it
            // avoids re-resolving against BaseAddress (which doubled the /api/v3/ prefix → 404).
            string? nextUrl = GitHubLinkHeader.TryGetRel(resp, "next", out var next) ? next : null;
            pageCount++;
            // If we hit the page cap and GitHub still has a Link rel=next, log so
            // operators can distinguish "page-cap truncation" from "server-side soft
            // truncation" during dogfooding. The user-visible signal is still the
            // single `DiffDto.Truncated` bool — the conflation is intentional.
            if (pageCount == MaxPages && nextUrl is not null) moreAvailable = true;
            url = nextUrl;
        }
        if (moreAvailable) Log.DiffPagesCapped(_log, reference.Owner, reference.Repo, reference.Number);
        return collected;
    }

    private async Task<IReadOnlyList<FileChange>> FetchCompareFilesAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct)
    {
        var url = $"repos/{reference.Owner}/{reference.Repo}/compare/{Uri.EscapeDataString(range.BaseSha)}...{Uri.EscapeDataString(range.HeadSha)}";
        using var http = _httpFactory.CreateClient("github");
        using var resp = await SendGitHubAsync(http, HttpMethod.Get, url, ct).ConfigureAwait(false);
        // Symmetric with PaginatePullsFilesAsync: a pruned head ref / commits after a
        // closed PR yields 404 OR 410 Gone. Map both to the typed RangeUnreachableException
        // so the cross-iteration 3-dot compare path surfaces the same "diff unavailable".
        if (resp.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
            throw new RangeUnreachableException(range.BaseSha, range.HeadSha);
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (!root.TryGetProperty("files", out var filesEl) || filesEl.ValueKind != JsonValueKind.Array)
            return Array.Empty<FileChange>();
        return ParseFileChanges(filesEl);
    }

    private IReadOnlyList<FileChange> ParseFileChanges(JsonElement filesArray)
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
            // Parse GitHub's per-file unified-diff `patch` field into structured hunks
            // via PatchParser (PRism.Core.Contracts). The frontend's DiffPane consumes
            // hunk Body INCLUDING the @@ header; the parser preserves that contract.
            // GitHub omits the `patch` field for binary files and very large files
            // (>~3MB), in which case Parse returns an empty list and the frontend
            // renders an "Empty file" placeholder for that file — a follow-up should
            // distinguish this from the truly-empty case with a "view on github.com"
            // affordance.
            var patch = f.TryGetProperty("patch", out var p) && p.ValueKind == JsonValueKind.String
                ? p.GetString()
                : null;
            IReadOnlyList<DiffHunk> hunks;
            try
            {
                hunks = PatchParser.Parse(patch);
            }
#pragma warning disable CA1031 // Per-file fault isolation: one bad file's parse must
            // not abort the entire pulls/{n}/files response and discard already-parsed
            // entries from earlier pagination pages. PatchParser is defensive (TryParse
            // on every numeric group, malformed-header skip), so reaching this catch
            // implies an unforeseen exception in future parser changes; surface as
            // empty hunks (same wire shape as binary/>3MB files), log at Warning so
            // the regression is diagnosable, and keep iterating.
            catch (Exception ex)
#pragma warning restore CA1031
            {
                Log.PatchParseFailed(_log, path, ex);
                hunks = Array.Empty<DiffHunk>();
            }
            result.Add(new FileChange(path, status, hunks));
        }
        return result;
    }

    // Instance-level helper that attaches the Bearer token alongside the standard
    // headers — without this, every REST call goes out anonymously, which 404s on
    // private repos and burns through the 60/hr unauthenticated rate limit on public
    // repos. Mirrors the pattern used by GitHubSectionQueryRunner and GitHubPrEnricher
    // (the named "github" HttpClient does not carry a default Authorization header,
    // so every caller is responsible for attaching one per request).
    //
    // `content` is optional: POST/PATCH callers pass a pre-built StringContent; GET callers
    // omit it. The header set is the same regardless — Authorization Bearer, UserAgent,
    // Accept vnd.github+json, and X-GitHub-Api-Version (recommended by GitHub for all REST calls).
    private async Task<HttpResponseMessage> SendGitHubAsync(HttpClient http, HttpMethod method, string url, CancellationToken ct, HttpContent? content = null)
    {
        var token = await _readToken().ConfigureAwait(false);
        return await GitHubHttp.SendAsync(http, method, url, token, ct, content).ConfigureAwait(false);
    }

    private sealed record PullMeta(string BaseSha, string HeadSha, int ChangedFiles);

    // Inter-batch pace between concurrent per-commit fan-out batches. Transport-layer
    // concern (rate-limit defense), not a clustering coefficient. Spec § 6.4.
    private const int InterBatchPaceMs = 100;

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "Per-commit fan-out hit a 4xx response on PR {Owner}/{Repo}#{Number}; remaining commits will be skipped (session degraded). ChangedFiles will be null for those commits and FileJaccardMultiplier returns neutral (1.0).")]
        internal static partial void FanOutDegraded(ILogger logger, string owner, string repo, int number);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Timeline page cap reached on PR {Owner}/{Repo}#{Number}; some history was not loaded. Frontend renders the explicit cap-hit banner.")]
        internal static partial void TimelineCapHit(ILogger logger, string owner, string repo, int number);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Diff pagination hit the 30-page cap on PR {Owner}/{Repo}#{Number}; truncated diff will surface to the user via DiffDto.Truncated.")]
        internal static partial void DiffPagesCapped(ILogger logger, string owner, string repo, int number);

        [LoggerMessage(Level = LogLevel.Warning, Message = "PatchParser threw on file {Path}; surfacing empty hunks for that file (Files tab will show the \"Empty file\" placeholder). Per-file fault isolation kept the rest of the response intact. Inspect the patch shape if seen repeatedly.")]
        internal static partial void PatchParseFailed(ILogger logger, string path, Exception ex);
    }

    private async Task<string> PostGraphQLAsync(string query, object variables, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        var payload = JsonSerializer.Serialize(new { query, variables });
        using var http = _httpFactory.CreateClient("github");
        // Absolute URL to defeat the named client's BaseAddress = `<host>/api/v3/`. GHES's
        // GraphQL endpoint is `<host>/api/graphql` (no /v3); resolving against BaseAddress
        // would 404 on every GraphQL call against GHES.
        var endpoint = HostUrlResolver.GraphQlEndpoint(_host);
        // apiVersion:false — the REST version header is meaningless to the GraphQL endpoint;
        // suppressing it keeps this request byte-identical to its pre-#320 form. The submit
        // pipeline rides this method (PostSubmitGraphQLAsync wraps it), so byte-identity here
        // preserves the B2 submit transport.
        using var content = new StringContent(payload, System.Text.Encoding.UTF8, "application/json");
        using var resp = await GitHubHttp.SendAsync(
            http, HttpMethod.Post, endpoint.ToString(), token, ct,
            content: content, apiVersion: false).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            // GitHub's error body carries the actionable reason ({"message":"Bad credentials",…}
            // for 401, abuse/rate-limit details for 403, etc.); read it (best-effort) so the
            // exception message and the transport-failure log include it.
            string body = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
            s_graphqlTransportFailed(_log, (int)resp.StatusCode, resp.ReasonPhrase ?? "", Truncate(body, 1024), null);
            throw new HttpRequestException(
                $"GitHub GraphQL HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}: {Truncate(body, 512)}",
                inner: null,
                statusCode: resp.StatusCode);
        }
        return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
    }

    private static string Truncate(string s, int max)
        => string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : string.Concat(s.AsSpan(0, max), "…"));

    // Transport-level failures are logged at Warning because rate-limits and auth
    // expiry are recoverable conditions — distinct from execution errors (Warning
    // for read, Error for submit). Body is truncated in the log to 1024 chars so a
    // pathological 5xx body doesn't bloat the log file; the response code +
    // first 512 chars in the exception's Message are what callers surface.
    private static readonly Action<ILogger, int, string, string, Exception?> s_graphqlTransportFailed =
        LoggerMessage.Define<int, string, string>(LogLevel.Warning, new EventId(5, "GraphQLTransportFailed"),
            "GraphQL HTTP request failed: {StatusCode} {ReasonPhrase}. Body: {Body}");

    // GraphQL is "200 with errors" rather than HTTP-error-coded; the `errors` array
    // carries execution failures. Throw only when errors are present AND there is no
    // usable data (data missing entirely, or data:null). Per GraphQL spec, partial
    // data is legitimately delivered alongside non-fatal field errors — we let those
    // through and the per-field parsers fall back to empty/default.
    //
    // The thrown exception's Message uses the shared formatter so users see
    // "[CODE] message (path: x/y/z)" rather than the bare count — same pattern
    // as the submit pipeline's PostSubmitGraphQLAsync. Full errors JSON is
    // available on the exception's ErrorsJson property for diagnostic logging.
    private void ThrowIfGraphQLErrorsWithoutData(JsonElement root)
    {
        if (!root.TryGetProperty("errors", out var errors)) return;
        if (errors.ValueKind != JsonValueKind.Array || errors.GetArrayLength() == 0) return;

        var hasUsableData = root.TryGetProperty("data", out var data)
            && data.ValueKind == JsonValueKind.Object;
        if (hasUsableData) return;

        var errorsJson = errors.GetRawText();
        s_graphqlReadFailed(_log, errors.GetArrayLength(), errorsJson, null);
        throw new GitHubGraphQLException(
            GitHubGraphQLException.FormatErrorsMessage(errorsJson) + " (no data)",
            errorsJson);
    }

    // Logged at Warning (not Error) because the read-side queries can legitimately
    // run against repos the user no longer has access to or PRs that have been
    // deleted — those produce errors-without-data legitimately and the UI surfaces
    // an empty state. The structured log lets an operator distinguish "real GitHub
    // failure" from "expected absence" without crawling stack traces.
    private static readonly Action<ILogger, int, string, Exception?> s_graphqlReadFailed =
        LoggerMessage.Define<int, string>(LogLevel.Warning, new EventId(4, "GraphQLReadFailed"),
            "Read-side GraphQL call returned {ErrorCount} error(s) with no usable data. Raw errors: {ErrorsJson}");

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

    // The three GraphQL connections inside `pullRequest` that the spec § 6.1 cap-hit
    // banner cares about. Single source of truth so HasAnyNextPage stays in lock-step
    // with whatever the GetPrDetailAsync query asks for; if the query renames a
    // connection, this list updates with it.
    private static readonly string[] PagedConnections = ["comments", "reviewThreads", "timelineItems"];

    private static bool HasAnyNextPage(JsonElement pull)
    {
        foreach (var name in PagedConnections)
            if (ConnectionHasNext(pull, name)) return true;
        return false;
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
                if (got4xx && !degraded)
                {
                    degraded = true;
                    Log.FanOutDegraded(_log, reference.Owner, reference.Repo, reference.Number);
                }
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
