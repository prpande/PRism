using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;            // IReviewSubmitter
using PRism.Core.Contracts;  // PrReference and the submit DTOs used by the partials

namespace PRism.GitHub;

// IReviewSubmitter — the GraphQL pending-review pipeline + the REST comment-create paths,
// split out of GitHubReviewService in #321 PR2 (ADR-S5-1 capability split; single-capability
// class). Transport rides the shared static GitHubGraphQL.PostAsync (byte-identical to the
// pre-split form — the B2 contract) via the thin PostGraphQLAsync wrapper below. internal
// sealed; constructed via DI and the test factory (InternalsVisibleTo).
internal sealed partial class GitHubReviewSubmitter : IReviewSubmitter
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;
    private readonly ILogger<GitHubReviewSubmitter> _log;

    public GitHubReviewSubmitter(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        string host,
        ILogger<GitHubReviewSubmitter>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
        _log = log ?? NullLogger<GitHubReviewSubmitter>.Instance;
    }

    // Thin per-class transport wrapper — verbatim twin of the reader's. Keeping the name
    // PostGraphQLAsync(query, variables, ct) leaves PostSubmitGraphQLAsync byte-identical.
    private async Task<string> PostGraphQLAsync(string query, object variables, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        return await GitHubGraphQL.PostAsync(http, token, _host, _log, query, variables, ct).ConfigureAwait(false);
    }

    // The REST comment paths' token-read wrapper — verbatim copy of the reader's SendGitHubAsync
    // (the #320 per-class token-read cadence, not meaningful duplication).
    private async Task<HttpResponseMessage> SendGitHubAsync(HttpClient http, HttpMethod method, string url, CancellationToken ct, HttpContent? content = null)
    {
        var token = await _readToken().ConfigureAwait(false);
        return await GitHubHttp.SendAsync(http, method, url, token, ct, content).ConfigureAwait(false);
    }

    private static partial class Log
    {
        // s_graphqlSubmitFailed → GraphQLSubmitFailed. Logged at Error because submit-pipeline
        // GraphQL failures always abort the pipeline (no partial-data path here). Full errors
        // JSON included so the operator sees every error, not just the first in the toast.
        // EventId 2 preserved.
        [LoggerMessage(Level = LogLevel.Error, EventId = 2, EventName = "GraphQLSubmitFailed",
            Message = "Submit-pipeline GraphQL call returned {ErrorCount} error(s). Raw errors: {ErrorsJson}")]
        internal static partial void GraphQLSubmitFailed(ILogger logger, int errorCount, string errorsJson);

        // s_graphqlSubmitNoData → GraphQLSubmitNoData. EventId 3 preserved.
        [LoggerMessage(Level = LogLevel.Error, EventId = 3, EventName = "GraphQLSubmitNoData",
            Message = "Submit-pipeline GraphQL call succeeded with no errors but no `data` object — server contract violation.")]
        internal static partial void GraphQLSubmitNoData(ILogger logger);
    }
}
