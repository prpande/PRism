using System.Net;
using Microsoft.AspNetCore.Http;

namespace PRism.Web.Middleware;

/// <summary>
/// DNS-rebinding defense for the loopback sidecar: only requests whose Host header
/// is a loopback literal are served. A rebinded page reaches the socket but carries
/// the attacker's domain in Host, so it is rejected here before auth/origin run.
/// </summary>
internal sealed class HostHeaderCheckMiddleware
{
    private readonly RequestDelegate _next;
    private readonly bool _enforced;

    public HostHeaderCheckMiddleware(RequestDelegate next, bool enforced)
    {
        _next = next;
        _enforced = enforced;
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        if (_enforced && !IsLoopbackHost(ctx.Request.Host.Host))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            await ctx.Response.WriteAsync("Rejected: non-loopback Host header.").ConfigureAwait(false);
            return;
        }

        await _next(ctx).ConfigureAwait(false);
    }

    private static bool IsLoopbackHost(string host)
    {
        if (string.IsNullOrEmpty(host)) return false;
        var h = host.Trim('[', ']'); // strip IPv6 brackets
        return IPAddress.TryParse(h, out var ip) && IPAddress.IsLoopback(ip);
    }
}
