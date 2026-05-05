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
                if (!await orch.WaitForFirstSnapshotAsync(TimeSpan.FromSeconds(10), ct).ConfigureAwait(false))
                {
                    // Kick on-demand refresh (spec § 5.2 deadlock-avoidance).
                    _ = orch.RefreshAsync(CancellationToken.None);
                    if (!await orch.WaitForFirstSnapshotAsync(TimeSpan.FromSeconds(10), ct).ConfigureAwait(false))
                        return Results.Problem(
                            title: "Inbox initializing",
                            statusCode: 503,
                            type: "/inbox/initializing");
                }
            }
            var snap = orch.Current!;
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
            ParsePrUrlRequest? body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<ParsePrUrlRequest>(ct).ConfigureAwait(false);
            }
            catch (System.Text.Json.JsonException)
            {
                return Results.BadRequest(new { error = "invalid-json" });
            }
            if (body is null || string.IsNullOrWhiteSpace(body.Url))
                return Results.BadRequest(new { error = "url-required" });

            var configuredHost = config.Current.Github.Host;
            if (review.TryParsePrUrl(body.Url, out var prRef))
            {
                return Results.Ok(new ParsePrUrlResponse(
                    Ok: true, Ref: prRef, Error: null, ConfiguredHost: null, UrlHost: null));
            }

            // distinguish host-mismatch vs malformed vs not-a-pr
            if (!Uri.TryCreate(body.Url, UriKind.Absolute, out var u))
                return Results.Ok(new ParsePrUrlResponse(false, null, "malformed", configuredHost, null));

            if (!Uri.TryCreate(configuredHost, UriKind.Absolute, out var h)
                || !string.Equals(u.Host, h.Host, StringComparison.OrdinalIgnoreCase))
            {
                return Results.Ok(new ParsePrUrlResponse(
                    false, null, "host-mismatch", configuredHost, u.Host));
            }
            return Results.Ok(new ParsePrUrlResponse(false, null, "not-a-pr-url", null, null));
        });

        return app;
    }
}
