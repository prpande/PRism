using System.Text.RegularExpressions;

namespace PRism.Web.TestHooks;

// DelegatingHandler that intercepts the GraphQL HttpClient pipeline (the "github" named client
// configured in PRism.GitHub/ServiceCollectionExtensions.cs). For each outgoing request we:
//   1. sniff the top-level GraphQL selection-field name from the request body,
//   2. consult RealTransportFailureInjector for a pre-effect arm — throw BEFORE forwarding,
//   3. forward to the inner handler (real GitHub call lands),
//   4. consult RealTransportFailureInjector for an after-effect arm — throw AFTER receiving
//      the response (simulates the "lost response" window: GitHub committed, client never saw it).
//
// Gating: registered into the chain only when ASPNETCORE_ENVIRONMENT=Test AND PRISM_E2E_REAL_INJECT=1
// (see Program.cs). Cannot engage in production.
//
// Sniff scope: works for the mutations PRism emits — all anonymous form
// "mutation($vars) { selectionField(...) { ... } }". The regex captures the first identifier
// after the outer brace. Match using exact string equality — addPullRequestReviewThread is a
// strict prefix of addPullRequestReviewThreadReply, so substring/prefix matching would silently
// mis-route. Read queries wrap their data in repository { pullRequest { ... } }; the sniff
// yields "repository" for those, not useful as an injection key. None of the four real-flow
// scenarios inject into queries today; if a future scenario needs to, the handler grows a
// per-query-name lookup.
internal sealed partial class TestFailureInjectionHandler : DelegatingHandler
{
    private readonly RealTransportFailureInjector _injector;

    public TestFailureInjectionHandler(RealTransportFailureInjector injector)
    {
        _injector = injector ?? throw new ArgumentNullException(nameof(injector));
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var fieldName = await TrySniffFieldNameAsync(request, cancellationToken).ConfigureAwait(false);
        if (fieldName is null)
        {
            return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }

        if (_injector.TryConsume(fieldName, afterEffectWanted: false, out var preEx))
        {
            throw preEx;
        }

        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);

        if (_injector.TryConsume(fieldName, afterEffectWanted: true, out var postEx))
        {
            response.Dispose();
            throw postEx;
        }

        return response;
    }

    // Reads the request body (StringContent — safe to re-read; buffered). Parses the JSON envelope
    // to extract the "query" string, then regex-matches the top-level selection-field inside the
    // query. Parsing the JSON envelope first (instead of scanning the raw body) avoids false
    // matches in the "variables" sub-object — `{ "variables": { "prReviewId": ...` could land
    // confusing matches under a naive raw-body regex.
    private static async Task<string?> TrySniffFieldNameAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (request.Content is null) return null;

        string body;
        try
        {
            body = await request.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or IOException or ObjectDisposedException)
        {
            return null;
        }

        string? query;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("query", out var queryElement)) return null;
            query = queryElement.GetString();
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
        if (string.IsNullOrEmpty(query)) return null;

        var match = FieldNameRegex().Match(query);
        return match.Success ? match.Groups[1].Value : null;
    }

    // Matches the first { followed by an identifier followed by ( — the top-level GraphQL
    // selection-field of an anonymous mutation/query body. Identifier-boundary parsing is
    // load-bearing: addPullRequestReviewThread is a strict prefix of addPullRequestReviewThreadReply.
    [GeneratedRegex(@"\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(")]
    private static partial Regex FieldNameRegex();
}
