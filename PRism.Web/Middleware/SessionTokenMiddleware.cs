using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;

namespace PRism.Web.Middleware;

// Per-process session token enforcement. Spec § 8: SPA reads the token from the
// `prism-session` cookie (stamped by Program.cs onto every text/html response),
// echoes it as the X-PRism-Session header on every fetch (which reaches every
// non-asset endpoint), and the EventSource implicitly carries the cookie on
// GET /api/events (EventSource cannot set custom request headers).
//
// Backend restart rotates the token, so an old SPA's stale cookie 401s and the
// SPA force-reloads to get the freshly-stamped one. This is the per-launch
// freshness invariant the threat model relies on.
[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes",
    Justification = "Activated by UseMiddleware<T>() via reflection.")]
internal sealed class SessionTokenMiddleware
{
    private readonly RequestDelegate _next;
    private readonly byte[] _expectedToken;

    public SessionTokenMiddleware(RequestDelegate next, SessionTokenProvider provider)
    {
        ArgumentNullException.ThrowIfNull(provider);
        _next = next;
        _expectedToken = Encoding.UTF8.GetBytes(provider.Current);
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        // Asset / SPA / non-API paths are skipped so the SPA can load its HTML
        // (which is what stamps the cookie in the first place). Auth applies to
        // /api/* only; SPA routing serves index.html via MapFallbackToFile.
        if (!ctx.Request.Path.StartsWithSegments("/api", StringComparison.Ordinal))
        {
            await _next(ctx).ConfigureAwait(false);
            return;
        }

        // Cookie path for the SSE endpoint exactly (EventSource can't send
        // custom headers); header path everywhere else under /api.
        var actualValue = IsSseEndpoint(ctx.Request.Path)
            ? ctx.Request.Cookies["prism-session"] ?? string.Empty
            : ctx.Request.Headers["X-PRism-Session"].ToString();

        if (!FixedTimeMatches(actualValue))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            // Pass `options: null` + the explicit contentType so the response carries
            // application/problem+json (the no-options overload defaults to application/json).
            await ctx.Response.WriteAsJsonAsync(
                new ProblemDetails
                {
                    Type = "/auth/session-stale",
                    Status = StatusCodes.Status401Unauthorized,
                    Title = "Session token mismatch",
                    Detail = "Session token mismatch — reload the page to refresh.",
                },
                options: null,
                contentType: "application/problem+json").ConfigureAwait(false);
            return;
        }

        await _next(ctx).ConfigureAwait(false);
    }

    private bool FixedTimeMatches(string actualValue)
    {
        // P2.4: pad/truncate `actual` to `_expectedToken.Length`, run FixedTimeEquals
        // on equal-length buffers, then AND in the length-equality check via bitwise `&`
        // (NOT short-circuiting `&&`) so the length check itself doesn't leak timing.
        var actual = Encoding.UTF8.GetBytes(actualValue);
        var padded = new byte[_expectedToken.Length];
        var copyLen = Math.Min(actual.Length, padded.Length);
        actual.AsSpan(0, copyLen).CopyTo(padded);
        var equalContent = CryptographicOperations.FixedTimeEquals(padded, _expectedToken);
        return equalContent & (actual.Length == _expectedToken.Length);
    }

    private static bool IsSseEndpoint(PathString path) =>
        path.HasValue && string.Equals(path.Value, "/api/events", StringComparison.Ordinal);
}

// Singleton; Current is captured once per process. Backend restart = new process =
// new token, which is the per-launch freshness invariant. Internal — tests reach it
// via InternalsVisibleTo and PRism.Web/Program.cs registers it via DI.
internal sealed class SessionTokenProvider
{
    public string Current { get; }

    public SessionTokenProvider(IHostEnvironment env)
    {
        ArgumentNullException.ThrowIfNull(env);

        // P2.30: PRISM_DEV_FIXED_TOKEN read from Environment.GetEnvironmentVariable ONLY
        // (not IConfiguration) to eliminate a path where appsettings.json could leak a
        // fixed token into a non-Development host. Override only honored in Development.
        var devOverride = Environment.GetEnvironmentVariable("PRISM_DEV_FIXED_TOKEN");
        if (env.IsDevelopment() && !string.IsNullOrEmpty(devOverride))
        {
            Current = devOverride;
            return;
        }
        Current = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
    }
}
