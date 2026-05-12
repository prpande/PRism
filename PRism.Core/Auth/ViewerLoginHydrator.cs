using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace PRism.Core.Auth;

/// <summary>
/// On startup, if a stored token exists, validates credentials once and caches the
/// resulting viewer login in <see cref="IViewerLoginProvider"/>. Without this, a
/// post-restart user with an existing token never re-calls <c>/api/auth/connect</c>,
/// the login stays <c>""</c>, and the awaiting-author inbox section silently
/// returns empty (every PR review's user mismatches the empty viewer login).
/// </summary>
public sealed partial class ViewerLoginHydrator : IHostedService
{
    private readonly ITokenStore _tokens;
    private readonly IReviewAuth _review;
    private readonly IViewerLoginProvider _loginCache;
    private readonly ILogger<ViewerLoginHydrator> _log;

    public ViewerLoginHydrator(
        ITokenStore tokens,
        IReviewAuth review,
        IViewerLoginProvider loginCache,
        ILogger<ViewerLoginHydrator> log)
    {
        _tokens = tokens;
        _review = review;
        _loginCache = loginCache;
        _log = log;
    }

    [SuppressMessage("Design", "CA1031:Do not catch general exception types",
        Justification = "Cold-start hydration is best-effort: any failure beyond cancellation must leave the host startable so the user can re-authenticate via /api/auth/connect.")]
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        // Don't clobber a /api/auth/connect call that raced startup and already set the login.
        if (!string.IsNullOrEmpty(_loginCache.Get())) return;

        bool hasToken;
        try
        {
            hasToken = await _tokens.HasTokenAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            Log.HasTokenProbeFailed(_log, ex);
            return;
        }

        if (!hasToken) return;

        try
        {
            var result = await _review.ValidateCredentialsAsync(cancellationToken).ConfigureAwait(false);
            if (result.Ok && !string.IsNullOrEmpty(result.Login))
            {
                _loginCache.Set(result.Login);
            }
            else
            {
                Log.ValidationRejected(_log, result.Error?.ToString() ?? "unknown");
            }
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            Log.ValidationFailed(_log, ex);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "Viewer login hydration: HasTokenAsync probe failed; awaiting-author section may be empty until re-auth")]
        internal static partial void HasTokenProbeFailed(ILogger logger, Exception ex);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Viewer login hydration: ValidateCredentialsAsync rejected stored token ({Error}); awaiting-author section may be empty until re-auth")]
        internal static partial void ValidationRejected(ILogger logger, string error);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Viewer login hydration: ValidateCredentialsAsync threw; awaiting-author section may be empty until next /api/auth/connect")]
        internal static partial void ValidationFailed(ILogger logger, Exception ex);
    }
}
