using System.Diagnostics.CodeAnalysis;

namespace PRism.Web.Middleware;

// Instantiated by ASP.NET pipeline via UseMiddleware<T>(); reflection-based activation hides this from CA1812.
[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "Activated by UseMiddleware<T>() via reflection.")]
internal sealed class OriginCheckMiddleware
{
    private readonly RequestDelegate _next;
    public OriginCheckMiddleware(RequestDelegate next) { _next = next; }

    public async Task InvokeAsync(HttpContext ctx)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        if (!HttpMethods.IsPost(ctx.Request.Method)
            && !HttpMethods.IsPut(ctx.Request.Method)
            && !HttpMethods.IsPatch(ctx.Request.Method)
            && !HttpMethods.IsDelete(ctx.Request.Method))
        {
            await _next(ctx).ConfigureAwait(false);
            return;
        }

        var origin = ctx.Request.Headers["Origin"].FirstOrDefault();
        var expected = $"{ctx.Request.Scheme}://{ctx.Request.Host.Value}";
        if (string.IsNullOrEmpty(origin) || string.Equals(origin, expected, StringComparison.OrdinalIgnoreCase))
        {
            await _next(ctx).ConfigureAwait(false);
            return;
        }

        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        await ctx.Response.WriteAsync("Cross-origin request rejected.").ConfigureAwait(false);
    }
}
