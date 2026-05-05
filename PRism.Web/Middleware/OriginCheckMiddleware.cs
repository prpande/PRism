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
        if (string.IsNullOrEmpty(origin)
            || string.Equals(origin, expected, StringComparison.OrdinalIgnoreCase)
            || (IsLoopback(origin) && IsLoopback(ctx.Request.Host.Host)))
        {
            await _next(ctx).ConfigureAwait(false);
            return;
        }

        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        await ctx.Response.WriteAsync("Cross-origin request rejected.").ConfigureAwait(false);
    }

    // The Vite dev server proxies /api on its own port (5173) to the backend (5180); the browser
    // sends Origin=http://localhost:5173 which is loopback but a different port. For a
    // localhost-only desktop app, same-machine traffic across loopback ports is legitimate, not
    // a CSRF vector. Cross-origin attackers cannot bind localhost on a different port from a
    // remote browser, so this relaxation does not weaken the CSRF guarantee.
    private static bool IsLoopback(string hostOrOrigin)
    {
        if (string.IsNullOrEmpty(hostOrOrigin)) return false;
        var host = hostOrOrigin;
        if (Uri.TryCreate(hostOrOrigin, UriKind.Absolute, out var u)) host = u.Host;
        return string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
            || host == "127.0.0.1"
            || host == "[::1]"
            || host == "::1";
    }
}
