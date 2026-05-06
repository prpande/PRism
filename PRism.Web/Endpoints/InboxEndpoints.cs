using PRism.Core;
using PRism.Core.Config;
using PRism.Core.Inbox;

namespace PRism.Web.Endpoints;

internal static class InboxEndpoints
{
    private static readonly Dictionary<string, string> Labels = new()
    {
        ["review-requested"] = "Review requested",
        ["awaiting-author"]  = "Awaiting author",
        ["authored-by-me"]   = "Authored by me",
        ["mentioned"]        = "Mentioned",
        ["ci-failing"]       = "CI failing on my PRs",
    };

    public static IEndpointRouteBuilder MapInbox(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/inbox", async (
            IInboxRefreshOrchestrator orch,
            IConfigStore config,
            CancellationToken ct) =>
        {
            if (orch.Current == null)
            {
                // Spec § 5.2 deadlock-avoidance: kick a one-shot refresh on first call so
                // we are not stuck waiting for an SSE connect that may not have raced ahead.
                // TryColdStartRefresh is idempotent — concurrent requests all hit this branch
                // simultaneously on a cold start, but only one refresh is actually kicked.
                orch.TryColdStartRefresh();
                if (!await orch.WaitForFirstSnapshotAsync(TimeSpan.FromSeconds(10), ct).ConfigureAwait(false))
                    return Results.Problem(
                        title: "Inbox initializing",
                        statusCode: 503,
                        type: "/inbox/initializing");
            }
            var snap = orch.Current!;
            // Section ordering: relies on Dictionary insertion-order preservation from
            // InboxRefreshOrchestrator's pipeline. See InboxRefreshOrchestrator for details.
            var sections = snap.Sections
                .Select(kv => new InboxSectionDto(kv.Key, Labels.TryGetValue(kv.Key, out var lbl) ? lbl : kv.Key, kv.Value))
                .ToList();
            return Results.Ok(new InboxResponse(
                sections, snap.Enrichments, snap.LastRefreshedAt,
                config.Current.Inbox.ShowHiddenScopeFooter));
        });

        app.MapPost("/api/inbox/parse-pr-url", async (
            HttpContext ctx,
            IReviewService review,
            IConfigStore config,
            CancellationToken ct) =>
        {
            // ReadFromJsonAsync throws InvalidOperationException (not JsonException) when the
            // request lacks a JSON Content-Type, which would otherwise surface as a 500. Pre-check
            // HasJsonContentType() so missing/wrong Content-Type collapses into the same structured
            // 400 invalid-json shape callers see for malformed bodies.
            if (!ctx.Request.HasJsonContentType())
                return Results.BadRequest(new InboxError(Error: "invalid-json"));

            ParsePrUrlRequest? body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<ParsePrUrlRequest>(ct).ConfigureAwait(false);
            }
            catch (System.Text.Json.JsonException)
            {
                return Results.BadRequest(new InboxError(Error: "invalid-json"));
            }
            if (body is null || string.IsNullOrWhiteSpace(body.Url))
                return Results.BadRequest(new InboxError(Error: "url-required"));

            var configuredHost = config.Current.Github.Host;
            if (review.TryParsePrUrl(body.Url, out var prRef))
            {
                return Results.Ok(new ParsePrUrlResponse(
                    Ok: true, Ref: prRef, Error: null, ConfiguredHost: null, UrlHost: null));
            }

            // distinguish host-mismatch vs malformed vs not-a-pr
            if (!Uri.TryCreate(body.Url, UriKind.Absolute, out var u))
                return Results.Ok(new ParsePrUrlResponse(false, null, "malformed", configuredHost, null));

            // Treat scheme mismatch (e.g. http vs https) as host-mismatch: for the user, the
            // "host" is the full origin (scheme + host). Reusing host-mismatch keeps the frontend
            // contract narrow — a separate scheme-mismatch code would force frontend changes.
            if (!Uri.TryCreate(configuredHost, UriKind.Absolute, out var h)
                || !string.Equals(u.Host, h.Host, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(u.Scheme, h.Scheme, StringComparison.OrdinalIgnoreCase))
            {
                return Results.Ok(new ParsePrUrlResponse(
                    false, null, "host-mismatch", configuredHost, u.Host));
            }
            return Results.Ok(new ParsePrUrlResponse(false, null, "not-a-pr-url", null, null));
        });

        return app;
    }
}
