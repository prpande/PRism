using PRism.Web.Sse;

namespace PRism.Web.Endpoints;

internal static class EventsEndpoints
{
    public static IEndpointRouteBuilder MapEvents(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapGet("/api/events", async (HttpContext ctx, SseChannel channel) =>
        {
            await channel.RunSubscriberAsync(ctx.Response, ctx.RequestAborted).ConfigureAwait(false);
        });
        return app;
    }
}
