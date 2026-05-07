using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Web.Sse;

namespace PRism.Web.Endpoints;

internal static class EventsEndpoints
{
    public static IEndpointRouteBuilder MapEvents(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/events", async (HttpContext ctx, SseChannel channel) =>
        {
            // cookieSessionId binds this SSE connection to the requesting browser session
            // so subsequent POST /api/events/subscriptions calls (which can carry the
            // cookie but not custom headers) can resolve "which subscriber are you".
            var cookieSessionId = ctx.Request.Cookies["prism-session"];
            await channel.RunSubscriberAsync(ctx.Response, cookieSessionId, ctx.RequestAborted).ConfigureAwait(false);
        });

        // P1.5 — sentinel for the EventSource silent-401 detection on the frontend.
        // Goes through SessionTokenMiddleware: returns 200 if the cookie/header token
        // is valid, 401 if not. Frontend uses this to escalate from EventSource onerror
        // to a force-reload.
        app.MapGet("/api/events/ping", () => Results.Ok());

        app.MapPost("/api/events/subscriptions", SubscribeAsync);
        app.MapDelete("/api/events/subscriptions", UnsubscribeAsync);

        return app;
    }

    private static Results<NoContent, ProblemHttpResult> SubscribeAsync(
        SubscribeRequest body,
        HttpContext ctx,
        SseChannel sse,
        ActivePrSubscriberRegistry registry)
    {
        if (body is null || body.PrRef is null)
        {
            return TypedResults.Problem(
                detail: "PrRef is required.",
                type: "/events/invalid-body",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var cookieSessionId = ctx.Request.Cookies["prism-session"];
        if (string.IsNullOrEmpty(cookieSessionId))
        {
            return TypedResults.Problem(
                detail: "No prism-session cookie present on this request.",
                type: "/events/no-session",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        // SseChannel resolves the cookie's most-recent still-connected subscriberId AND
        // adds the registry entry under its internal _cookieGate. This atomicity closes
        // the TOCTOU window where a concurrent SSE disconnect could leave an orphan
        // (subscriberId, prRef) entry in the registry that the poller never cleans up.
        if (!sse.TrySubscribe(cookieSessionId, body.PrRef, registry))
        {
            return TypedResults.Problem(
                detail: "No active SSE connection for this cookie session — open /api/events first.",
                type: "/events/no-active-sse",
                statusCode: StatusCodes.Status403Forbidden);
        }

        return TypedResults.NoContent();
    }

    private static NoContent UnsubscribeAsync(
        [FromQuery] string? prRef,
        HttpContext ctx,
        SseChannel sse,
        ActivePrSubscriberRegistry registry)
    {
        // DELETE is idempotent: missing cookie / no SSE / unparseable prRef → 204 noop.
        var cookieSessionId = ctx.Request.Cookies["prism-session"];
        if (string.IsNullOrEmpty(cookieSessionId)) return TypedResults.NoContent();

        if (!PrReferenceParser.TryParse(prRef, out var parsed) || parsed is null)
            return TypedResults.NoContent();

        sse.TryUnsubscribe(cookieSessionId, parsed, registry);
        return TypedResults.NoContent();
    }
}
