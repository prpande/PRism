using Microsoft.AspNetCore.Http.Features;

namespace PRism.Web.Middleware;

// Endpoint filter that caps a route's request body size. Set up on each of the four
// mutating routes (mark-viewed, files/viewed, events/subscriptions POST + DELETE)
// per spec § 8 + plan Step 5.10b. We chose endpoint filters (not [RequestSizeLimit]
// MVC attribute) because [RequestSizeLimit] is a Microsoft.AspNetCore.Mvc filter that
// does not run for minimal-API routes, and we need pre-binding rejection.
//
// Two layers of defense: set IHttpMaxRequestBodySizeFeature for the framework-native
// per-endpoint cap, AND check Content-Length proactively so TestServer (which doesn't
// always honor MaxRequestBodySize) still rejects pre-handler. Both layers return 413.
internal sealed class RequestBodyCapFilter : IEndpointFilter
{
    private readonly long _maxBytes;

    public RequestBodyCapFilter(long maxBytes)
    {
        _maxBytes = maxBytes;
    }

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(next);

        var sizeFeat = ctx.HttpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (sizeFeat is not null && !sizeFeat.IsReadOnly)
            sizeFeat.MaxRequestBodySize = _maxBytes;

        var contentLength = ctx.HttpContext.Request.ContentLength;
        if (contentLength is not null && contentLength.Value > _maxBytes)
            return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);

        return await next(ctx).ConfigureAwait(false);
    }
}
