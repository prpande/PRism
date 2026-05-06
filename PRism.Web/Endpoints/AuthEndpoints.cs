using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

internal static partial class AuthEndpoints
{
    // Marker type so route delegates can resolve a category-specific ILogger without colliding
    // with the Program-level logger category.
    private sealed class Category { }

    public static IEndpointRouteBuilder MapAuth(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/auth/state", async (ITokenStore tokens, IAppStateStore stateStore, IConfigStore config, ILogger<Category> log, CancellationToken ct) =>
        {
            var hasToken = await tokens.HasTokenAsync(ct).ConfigureAwait(false);
            var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            var host = config.Current.Github.Host;
            AuthHostMismatch? mismatch = null;
            if (state.LastConfiguredGithubHost is not null
                && !string.Equals(state.LastConfiguredGithubHost, host, StringComparison.OrdinalIgnoreCase))
            {
                mismatch = new AuthHostMismatch(state.LastConfiguredGithubHost, host);
            }
            Log.AuthStateProbed(log, hasToken, host, mismatch is not null);
            return Results.Ok(new AuthStateResponse(hasToken, host, mismatch));
        });

        app.MapPost("/api/auth/connect", async (HttpContext ctx, ITokenStore tokens, IReviewService review, IAppStateStore stateStore, IConfigStore config, IViewerLoginProvider viewerLogin, ILogger<Category> log, CancellationToken ct) =>
        {
            JsonDocument doc;
            try
            {
                doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct).ConfigureAwait(false);
            }
            catch (JsonException)
            {
                Log.ConnectRejected(log, "invalid-json");
                return Results.BadRequest(new AuthConnectError(Ok: false, Error: "invalid-json"));
            }
            using var _doc = doc;
            var pat = doc.RootElement.TryGetProperty("pat", out var p) ? p.GetString() : null;
            if (string.IsNullOrWhiteSpace(pat))
            {
                Log.ConnectRejected(log, "pat-required");
                return Results.BadRequest(new AuthConnectError(Ok: false, Error: "pat-required"));
            }

            Log.ConnectValidating(log, pat.Length, config.Current.Github.Host);
            await tokens.WriteTransientAsync(pat, ct).ConfigureAwait(false);
            var result = await review.ValidateCredentialsAsync(ct).ConfigureAwait(false);
            if (!result.Ok)
            {
                await tokens.RollbackTransientAsync(ct).ConfigureAwait(false);
#pragma warning disable CA1308 // Lowercase enum names are part of the auth contract surfaced to the renderer.
                var errorName = result.Error?.ToString().ToLowerInvariant();
#pragma warning restore CA1308
                Log.ConnectValidationFailed(log, errorName ?? "(null)", result.ErrorDetail ?? "(none)");
                return Results.Ok(new AuthConnectValidationFailed(Ok: false, Error: errorName, Detail: result.ErrorDetail));
            }

            if (result.Warning != AuthValidationWarning.None)
            {
                // Soft warning: do NOT commit. Stash the validated login so the eventual
                // commit endpoint can populate the IViewerLoginProvider cache. Frontend
                // collects user confirmation and calls POST /api/auth/connect/commit.
                await tokens.SetTransientLoginAsync(result.Login ?? "", ct).ConfigureAwait(false);
                Log.ConnectValidatedWithWarning(log, result.Login ?? "(empty)", result.Warning);
                return Results.Ok(new AuthConnectWithWarning(
                    Ok: true,
                    Login: result.Login,
                    Host: config.Current.Github.Host,
                    Warning: WarningToWire(result.Warning)));
            }

            await tokens.CommitAsync(ct).ConfigureAwait(false);
            var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            await stateStore.SaveAsync(state with { LastConfiguredGithubHost = config.Current.Github.Host }, ct).ConfigureAwait(false);
            viewerLogin.Set(result.Login ?? "");
            Log.ConnectCommitted(log, result.Login ?? "(empty)");
            return Results.Ok(new AuthConnectSuccess(Ok: true, Login: result.Login, Host: config.Current.Github.Host));
        });

        app.MapPost("/api/auth/connect/commit", async (ITokenStore tokens, IAppStateStore stateStore, IConfigStore config, IViewerLoginProvider viewerLogin, ILogger<Category> log, CancellationToken ct) =>
        {
            // Read the validated login BEFORE CommitAsync clears it.
            var login = await tokens.ReadTransientLoginAsync(ct).ConfigureAwait(false);
            try
            {
                await tokens.CommitAsync(ct).ConfigureAwait(false);
            }
            catch (InvalidOperationException)
            {
                // No transient pending — process restart, or commit called twice.
                Log.CommitNoPendingToken(log);
                return Results.Conflict(new AuthConnectError(Ok: false, Error: "no-pending-token"));
            }

            var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            await stateStore.SaveAsync(state with { LastConfiguredGithubHost = config.Current.Github.Host }, ct).ConfigureAwait(false);
            // Mirror the connect-path Set to keep the cache in lockstep — empty string here
            // overwrites any stale login from a prior session rather than leaving it intact.
            viewerLogin.Set(login ?? "");
            Log.CommitSucceeded(log, login ?? "(empty)");
            return Results.Ok(new AuthCommitSuccess(Ok: true, Host: config.Current.Github.Host));
        });

        app.MapPost("/api/auth/host-change-resolution", async (HttpContext ctx, IAppStateStore stateStore, IConfigStore config, IHostApplicationLifetime lifetime, CancellationToken ct) =>
        {
            JsonDocument doc;
            try
            {
                doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct).ConfigureAwait(false);
            }
            catch (JsonException)
            {
                return Results.BadRequest(new HostChangeError(Error: "invalid-json"));
            }
            using var _doc = doc;
            var resolution = doc.RootElement.TryGetProperty("resolution", out var r) ? r.GetString() : null;

            var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            if (resolution == "continue")
            {
                await stateStore.SaveAsync(state with { LastConfiguredGithubHost = config.Current.Github.Host }, ct).ConfigureAwait(false);
                return Results.Ok(new HostChangeOk(Ok: true));
            }
            if (resolution == "revert" && state.LastConfiguredGithubHost is not null)
            {
                // Note: ConfigStore.PatchAsync currently only allows ui.* fields.
                // For now, host-revert is documented but cannot mutate config. Skip the patch and exit.
                lifetime.StopApplication();
                return Results.Ok(new HostChangeExiting(Ok: true, Exiting: true));
            }
            return Results.BadRequest(new HostChangeError(Error: "resolution must be 'continue' or 'revert'"));
        });

        return app;
    }

    // Single source of truth for AuthValidationWarning → wire string mapping.
    // Adding a new named enum member without extending this switch trips the compiler's
    // non-exhaustive-switch diagnostic (CS8509/CS8524, treated as error in this project).
    // The `_ =>` arm is required to satisfy CS8524 for unnamed cast values like
    // `(AuthValidationWarning)999`, but in practice it cannot fire from in-codebase
    // callers — those produce a compile error first. `None` is explicit because it IS
    // a valid named value the compiler can't statically rule out at the call site.
    private static string WarningToWire(AuthValidationWarning warning) => warning switch
    {
        AuthValidationWarning.NoReposSelected => "no-repos-selected",
        AuthValidationWarning.None => throw new InvalidOperationException("WarningToWire called with None — caller should not serialize a non-warning."),
        _ => throw new InvalidOperationException($"Unmapped AuthValidationWarning value: {warning}"),
    };

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug, Message = "/api/auth/state → has-token={HasToken}, host={Host}, host-mismatch={Mismatch}")]
        internal static partial void AuthStateProbed(ILogger logger, bool hasToken, string host, bool mismatch);

        [LoggerMessage(Level = LogLevel.Debug, Message = "/api/auth/connect rejected: {Reason}")]
        internal static partial void ConnectRejected(ILogger logger, string reason);

        [LoggerMessage(Level = LogLevel.Information, Message = "/api/auth/connect: validating PAT (length={PatLength}) against host {Host}")]
        internal static partial void ConnectValidating(ILogger logger, int patLength, string host);

        [LoggerMessage(Level = LogLevel.Warning, Message = "/api/auth/connect: validation failed (error={Error}, detail={Detail})")]
        internal static partial void ConnectValidationFailed(ILogger logger, string error, string detail);

        [LoggerMessage(Level = LogLevel.Information, Message = "/api/auth/connect: validated for login={Login} with warning={Warning}; awaiting /commit")]
        internal static partial void ConnectValidatedWithWarning(ILogger logger, string login, AuthValidationWarning warning);

        [LoggerMessage(Level = LogLevel.Information, Message = "/api/auth/connect: committed for login={Login}")]
        internal static partial void ConnectCommitted(ILogger logger, string login);

        [LoggerMessage(Level = LogLevel.Warning, Message = "/api/auth/connect/commit rejected: no-pending-token (process restart or double-commit)")]
        internal static partial void CommitNoPendingToken(ILogger logger);

        [LoggerMessage(Level = LogLevel.Information, Message = "/api/auth/connect/commit: committed for login={Login}")]
        internal static partial void CommitSucceeded(ILogger logger, string login);
    }
}
