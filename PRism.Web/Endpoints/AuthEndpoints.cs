using System.Text.Json;
using Microsoft.Extensions.Hosting;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

internal static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuth(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/auth/state", async (ITokenStore tokens, IAppStateStore stateStore, IConfigStore config, CancellationToken ct) =>
        {
            var hasToken = await tokens.HasTokenAsync(ct).ConfigureAwait(false);
            var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            object? mismatch = null;
            if (state.LastConfiguredGithubHost is not null
                && !string.Equals(state.LastConfiguredGithubHost, config.Current.Github.Host, StringComparison.OrdinalIgnoreCase))
            {
                mismatch = new { old = state.LastConfiguredGithubHost, @new = config.Current.Github.Host };
            }
            return Results.Ok(new { hasToken, hostMismatch = mismatch });
        });

        app.MapPost("/api/auth/connect", async (HttpContext ctx, ITokenStore tokens, IReviewService review, IAppStateStore stateStore, IConfigStore config, CancellationToken ct) =>
        {
            using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct).ConfigureAwait(false);
            var pat = doc.RootElement.TryGetProperty("pat", out var p) ? p.GetString() : null;
            if (string.IsNullOrWhiteSpace(pat))
                return Results.BadRequest(new { ok = false, error = "pat-required" });

            await tokens.WriteTransientAsync(pat, ct).ConfigureAwait(false);
            var result = await review.ValidateCredentialsAsync(ct).ConfigureAwait(false);
            if (!result.Ok)
            {
                await tokens.RollbackTransientAsync(ct).ConfigureAwait(false);
#pragma warning disable CA1308 // Lowercase enum names are part of the auth contract surfaced to the renderer.
                var errorName = result.Error?.ToString().ToLowerInvariant();
#pragma warning restore CA1308
                return Results.Ok(new { ok = false, error = errorName, detail = result.ErrorDetail });
            }

            await tokens.CommitAsync(ct).ConfigureAwait(false);
            var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            await stateStore.SaveAsync(state with { LastConfiguredGithubHost = config.Current.Github.Host }, ct).ConfigureAwait(false);
            return Results.Ok(new { ok = true, login = result.Login, host = config.Current.Github.Host });
        });

        app.MapPost("/api/auth/host-change-resolution", async (HttpContext ctx, IAppStateStore stateStore, IConfigStore config, IHostApplicationLifetime lifetime, CancellationToken ct) =>
        {
            using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct).ConfigureAwait(false);
            var resolution = doc.RootElement.TryGetProperty("resolution", out var r) ? r.GetString() : null;

            var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            if (resolution == "continue")
            {
                await stateStore.SaveAsync(state with { LastConfiguredGithubHost = config.Current.Github.Host }, ct).ConfigureAwait(false);
                return Results.Ok(new { ok = true });
            }
            if (resolution == "revert" && state.LastConfiguredGithubHost is not null)
            {
                // Note: ConfigStore.PatchAsync currently only allows ui.* fields.
                // For now, host-revert is documented but cannot mutate config. Skip the patch and exit.
                lifetime.StopApplication();
                return Results.Ok(new { ok = true, exiting = true });
            }
            return Results.BadRequest(new { error = "resolution must be 'continue' or 'revert'" });
        });

        return app;
    }
}
