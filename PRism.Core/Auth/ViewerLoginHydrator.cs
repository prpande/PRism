using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Config;

namespace PRism.Core.Auth;

/// <summary>
/// On startup, if a stored token exists, validates credentials once, caches the resulting
/// viewer login in <see cref="IViewerLoginProvider"/>, and side-writes the login into
/// <c>config.github.accounts[0].login</c> via <see cref="IConfigStore.SetDefaultAccountLoginAsync"/>.
/// The config write keeps v1's per-account login field populated for v2's eventual display
/// logic without coupling that surface to the in-memory <see cref="IViewerLoginProvider"/> cache.
/// </summary>
public sealed partial class ViewerLoginHydrator : IHostedService
{
    private readonly ITokenStore _tokens;
    private readonly IReviewAuth _review;
    private readonly IViewerLoginProvider _loginCache;
    private readonly IConfigStore _config;
    private readonly ILogger<ViewerLoginHydrator> _log;

    public ViewerLoginHydrator(
        ITokenStore tokens,
        IReviewAuth review,
        IViewerLoginProvider loginCache,
        IConfigStore config,
        ILogger<ViewerLoginHydrator> log)
    {
        _tokens = tokens;
        _review = review;
        _loginCache = loginCache;
        _config = config;
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
                try
                {
                    await _config.SetDefaultAccountLoginAsync(result.Login, cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    // Best-effort: failure to write the per-account login into config must not block
                    // hydration. The in-memory IViewerLoginProvider already has the login, so v1's
                    // single-account runtime continues to work; v2 will surface this gap if it relies
                    // on the config-side login as a hard source of truth (see spec § 7 advisory).
                    Log.ConfigLoginWriteFailed(_log, ex);
                }
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

        [LoggerMessage(Level = LogLevel.Warning, Message = "Viewer login hydration: config.github.accounts[0].login write failed; the in-memory login cache is set but the on-disk login is stale until next successful connect")]
        internal static partial void ConfigLoginWriteFailed(ILogger logger, Exception ex);
    }
}
