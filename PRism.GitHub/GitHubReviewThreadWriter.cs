using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.GitHub;

// #571 — IReviewThreadWriter: resolveReviewThread / unresolveReviewThread GraphQL mutations,
// keyed by the opaque thread node id (no ResolveNodeIdAsync hop — unlike GitHubPrLifecycleWriter's
// draft toggles, threadId is already a node id the caller obtained from the timeline/detail read
// path). Transport rides the shared GitHubGraphQL.PostAsync via the same thin wrapper used by
// GitHubPrLifecycleWriter/GitHubReviewSubmitter. Classification uses BOTH channels: a thrown
// HttpRequestException (any non-2xx) maps by HTTP status; an HTTP-200 body carrying errors[] is
// classified by the live-validated shape captured in .superpowers/sdd/live-validation-task2.md —
// key on errors[0].type first, falling back to a message substring match only when type is absent.
internal sealed partial class GitHubReviewThreadWriter : IReviewThreadWriter
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;
    private readonly ILogger<GitHubReviewThreadWriter> _log;

    public GitHubReviewThreadWriter(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        string host,
        ILogger<GitHubReviewThreadWriter>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
        _log = log ?? NullLogger<GitHubReviewThreadWriter>.Instance;
    }

    public Task<ReviewThreadResult> ResolveAsync(PrReference reference, string threadId, CancellationToken ct) =>
        RunAsync(reference, threadId, "resolveReviewThread", ct);

    public Task<ReviewThreadResult> UnresolveAsync(PrReference reference, string threadId, CancellationToken ct) =>
        RunAsync(reference, threadId, "unresolveReviewThread", ct);

    private async Task<ReviewThreadResult> RunAsync(
        PrReference reference, string threadId, string mutation, CancellationToken ct)
    {
        var label = $"{reference.Owner}/{reference.Repo}#{reference.Number}";
        var query = $$"""
            mutation($threadId: ID!) {
              {{mutation}}(input: { threadId: $threadId }) {
                thread { id isResolved }
              }
            }
            """;
        try
        {
            var body = await PostGraphQLAsync(query, new { threadId }, ct).ConfigureAwait(false);
            var code = ClassifyThreadGraphQLError(body);
            if (code is null) return ReviewThreadResult.Ok; // no errors[]
            Log.ThreadWriteFailed(_log, label, mutation, 200, GitHubHttp.Truncate(body, 1024));
            return ReviewThreadResult.Fail(code.Value);
        }
        catch (HttpRequestException ex) // GitHubGraphQL.PostAsync throws on any non-2xx
        {
            Log.ThreadWriteFailed(_log, label, mutation, (int?)ex.StatusCode ?? 0, ex.Message);
            return ReviewThreadResult.Fail(ClassifyHttpStatus(ex.StatusCode));
        }
    }

    private static ReviewThreadErrorCode ClassifyHttpStatus(HttpStatusCode? status) => status switch
    {
        HttpStatusCode.TooManyRequests => ReviewThreadErrorCode.RateLimited,
        HttpStatusCode.Unauthorized => ReviewThreadErrorCode.TokenCannotWrite,
        HttpStatusCode.Forbidden => ReviewThreadErrorCode.TokenCannotWrite,
        _ => ReviewThreadErrorCode.Generic,
    };

    // HTTP-200 + errors[] path. Substrings/types pinned to the LIVE-VALIDATED
    // resolveReviewThread/unresolveReviewThread wording (live-validation-task2.md), keying on
    // errors[0].type first — the message-substring match is a fallback only for the (unobserved
    // live) case where a caller/proxy strips the type field.
    private static ReviewThreadErrorCode? ClassifyThreadGraphQLError(string body)
    {
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("errors", out var errors)
            || errors.ValueKind != JsonValueKind.Array || errors.GetArrayLength() == 0)
            return null;
        var e0 = errors[0];
        var msg = e0.TryGetProperty("message", out var m) ? (m.GetString() ?? "") : "";
        if (e0.TryGetProperty("type", out var t))
        {
            var type = t.GetString();
            if (string.Equals(type, "RATE_LIMITED", StringComparison.Ordinal)) return ReviewThreadErrorCode.RateLimited;
            if (string.Equals(type, "FORBIDDEN", StringComparison.Ordinal)) return ReviewThreadErrorCode.TokenCannotWrite;
            if (string.Equals(type, "NOT_FOUND", StringComparison.Ordinal)) return ReviewThreadErrorCode.ThreadNotFound;
        }
        if (msg.Contains("Could not resolve to a node", StringComparison.OrdinalIgnoreCase))
            return ReviewThreadErrorCode.ThreadNotFound;
        if (msg.Contains("correct permissions", StringComparison.OrdinalIgnoreCase)
            || msg.Contains("Resource not accessible", StringComparison.OrdinalIgnoreCase))
            return ReviewThreadErrorCode.TokenCannotWrite;
        return ReviewThreadErrorCode.Generic;
    }

    private async Task<string> PostGraphQLAsync(string query, object variables, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        return await GitHubGraphQL.PostAsync(http, token, _host, _log, query, variables, ct).ConfigureAwait(false);
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, EventId = 1, EventName = "ReviewThreadWriteFailed",
            Message = "Review-thread write failed: pr={Pr} action={Action} status={Status} body={Body}")]
        internal static partial void ThreadWriteFailed(ILogger logger, string pr, string action, int status, string body);
    }
}
