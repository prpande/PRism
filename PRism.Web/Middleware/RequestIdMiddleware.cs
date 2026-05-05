namespace PRism.Web.Middleware;

// Instantiated by ASP.NET pipeline via UseMiddleware<T>(); reflection-based activation hides this from CA1812.
[System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "Activated by UseMiddleware<T>() via reflection.")]
internal sealed class RequestIdMiddleware
{
    private readonly RequestDelegate _next;
    public RequestIdMiddleware(RequestDelegate next) { _next = next; }

    public async Task InvokeAsync(HttpContext ctx)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        var id = ctx.Request.Headers["X-Request-Id"].FirstOrDefault();
        if (string.IsNullOrEmpty(id))
            id = Guid.NewGuid().ToString("N")[..16];
        ctx.Response.Headers["X-Request-Id"] = id;
        ctx.Items["RequestId"] = id;
        await _next(ctx).ConfigureAwait(false);
    }
}
