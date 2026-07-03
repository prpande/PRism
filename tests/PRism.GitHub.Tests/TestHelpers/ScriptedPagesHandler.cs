using System.Net;

namespace PRism.GitHub.Tests.TestHelpers;

// Replays a FIFO list of (status, body, nextUrl?) responses. Emits a
// Link: <nextUrl>; rel="next" header when nextUrl is non-null, so a caller's
// pagination loop follows it. Records how many requests were made and the
// absolute URIs requested, for assertions. Throws on over-call so an
// unterminated loop is loud at test time.
internal sealed class ScriptedPagesHandler : HttpMessageHandler
{
    private readonly Queue<(HttpStatusCode Status, string Body, string? NextUrl)> _pages;
    public List<string> RequestedUris { get; } = new();
    public List<string?> AuthHeaders { get; } = new(); // Authorization header per request (used by Task 5)
    public int CallCount => RequestedUris.Count;

    public ScriptedPagesHandler(params (HttpStatusCode Status, string Body, string? NextUrl)[] pages)
        => _pages = new Queue<(HttpStatusCode, string, string?)>(pages);

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(req);
        RequestedUris.Add(req.RequestUri!.ToString());
        AuthHeaders.Add(req.Headers.Authorization?.ToString());
        if (_pages.Count == 0)
            throw new InvalidOperationException(
                $"ScriptedPagesHandler ran out of scripted pages on request #{CallCount}.");

        var (status, body, next) = _pages.Dequeue();
        var resp = new HttpResponseMessage(status)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
        };
        if (next is not null)
            resp.Headers.TryAddWithoutValidation("Link", $"<{next}>; rel=\"next\"");
        return Task.FromResult(resp);
    }
}
