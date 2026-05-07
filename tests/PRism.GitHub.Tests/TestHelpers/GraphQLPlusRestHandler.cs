using System.Net;
using System.Threading;

namespace PRism.GitHub.Tests.TestHelpers;

/// <summary>
/// Test handler that returns a fixed GraphQL JSON response for any POST to <c>graphql</c>,
/// and routes REST GETs (per-commit fan-out etc.) to a dictionary of (path-prefix → response).
/// Tracks per-commit fetch counts and allows fault injection on a chosen commit index.
/// </summary>
internal sealed class GraphQLPlusRestHandler : HttpMessageHandler
{
    public string GraphQLBody { get; init; } = "{\"data\":{\"repository\":{\"pullRequest\":null}}}";
    public Func<string, (HttpStatusCode status, string body)>? RestRoute { get; init; }

    private int _perCommitFetchCount;
    public int PerCommitFetchCount => Volatile.Read(ref _perCommitFetchCount);

    public TimeSpan? PerCommitDelay { get; init; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(req);
        var path = req.RequestUri!.AbsolutePath;
        if (req.Method == HttpMethod.Post && path.EndsWith("/graphql", StringComparison.Ordinal))
        {
            // Drain the body so request bookkeeping (like request size) doesn't trip later.
            if (req.Content is not null) _ = await req.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(GraphQLBody, System.Text.Encoding.UTF8, "application/json"),
            };
        }
        // Per-commit fetch path.
        if (path.Contains("/commits/", StringComparison.Ordinal))
        {
            Interlocked.Increment(ref _perCommitFetchCount);
            if (PerCommitDelay is { } d) await Task.Delay(d, ct).ConfigureAwait(false);
        }
        if (RestRoute is { } router)
        {
            var (status, body) = router(path);
            return new HttpResponseMessage(status)
            {
                Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
            };
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }
}
