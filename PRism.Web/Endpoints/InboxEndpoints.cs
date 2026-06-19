using PRism.Core;
using PRism.Core.Config;
using PRism.Core.Inbox;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

internal static class InboxEndpoints
{
    private static readonly Dictionary<string, string> Labels = new()
    {
        ["review-requested"]  = "Review requested",
        ["awaiting-author"]   = "Needs re-review",
        ["authored-by-me"]    = "Authored by me",
        ["mentioned"]         = "Mentioned",
        ["recently-closed"]   = "Recently closed",
    };

    // Canonical UI order. Serialized sections follow this regardless of snapshot
    // dictionary enumeration; unknown ids sort last (stable) and render with a
    // fallback label rather than being dropped.
    private static readonly string[] SectionOrder =
    {
        "review-requested", "awaiting-author", "authored-by-me", "mentioned", "recently-closed",
    };

    public static IEndpointRouteBuilder MapInbox(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/inbox", async (
            IInboxRefreshOrchestrator orch,
            IConfigStore config,
            IAppStateStore stateStore,
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
            // Re-project viewed-state live from state.json onto the cached snapshot, so a
            // mark-viewed write is reflected immediately (read-only; no GitHub refetch, no
            // orchestrator mutation). #285.
            var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            var snap = InboxViewedState.ApplyViewedState(orch.Current!, state);
            var sections = snap.Sections
                .OrderBy(kv =>
                {
                    var i = Array.IndexOf(SectionOrder, kv.Key);
                    return i < 0 ? int.MaxValue : i;
                })
                // Secondary key on the id keeps any unknown sections (all bucket to
                // int.MaxValue) deterministically ordered — Sections is an
                // IReadOnlyDictionary whose enumeration order isn't guaranteed.
                .ThenBy(kv => kv.Key, StringComparer.Ordinal)
                .Select(kv => new InboxSectionDto(kv.Key, Labels.TryGetValue(kv.Key, out var lbl) ? lbl : kv.Key, kv.Value))
                .ToList();
            return Results.Ok(new InboxResponse(
                sections, snap.Enrichments, snap.LastRefreshedAt,
                config.Current.Inbox.ShowHiddenScopeFooter, snap.CiProbeComplete,
                snap.AiEnrichmentSettled.ToArray()));
        });

        // #311 — manual "Refresh now". Calls the orchestrator directly and AWAITS the pull
        // (semantic C) so the client gets a real completion. RefreshAsync is _writerLock-
        // serialized, so this is safe against the concurrent poller tick.
        app.MapPost("/api/inbox/refresh", async (
            IInboxRefreshOrchestrator orch,
            CancellationToken ct) =>
        {
            var before = orch.Current;   // reference identity of the committed snapshot
            try
            {
                // #355: manual Refresh forces a live-CI re-read (bypasses the (ref, headSha)
                // cache) so an unchanged head SHA still re-reads CI.
                await orch.RefreshAsync(ct, hardRefresh: true).ConfigureAwait(false);
                return Results.Ok();      // pull settled; new snapshot committed
            }
            catch (RateLimitExceededException)
            {
                // The orchestrator only commits-then-re-throws for a CI-probe 429 (it stashes
                // the rate-limit, finishes the snapshot, Volatile.Writes _current, THEN re-throws).
                // A primary section/enrichment 429 propagates BEFORE any commit. We can't cheaply
                // prove "*this* call committed", so the success test is "did the committed view
                // ADVANCE past where it was when the request arrived?" — true if this call (or a
                // concurrent poller tick) advanced it → the view is fresh → 200. If it did not
                // advance, the manual pull was rate-limited and nothing got fresher → 503.
                return ReferenceEquals(orch.Current, before)
                    ? Results.Problem(title: "Inbox refresh rate-limited", statusCode: 503, type: "/inbox/refresh-rate-limited")
                    : Results.Ok();
            }
            catch (OperationCanceledException)
            {
                // Client navigated away mid-refresh. Rethrow per house convention — ASP.NET Core
                // maps an aborted-request OCE to a no-op without error-level log noise.
                throw;
            }
#pragma warning disable CA1031 // catch-all so any GitHub/transport exception surfaces a 503 instead of a bare 500
            catch (Exception) // snapshot NOT committed (threw before Volatile.Write)
            {
                return Results.Problem(title: "Inbox refresh failed", statusCode: 503, type: "/inbox/refresh-failed");
            }
#pragma warning restore CA1031
        });

        app.MapPost("/api/inbox/parse-pr-url", async (
            HttpContext ctx,
            IPrDiscovery review,
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
