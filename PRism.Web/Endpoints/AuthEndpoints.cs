using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Web.Submit;

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

        app.MapPost("/api/auth/connect", async (HttpContext ctx, ITokenStore tokens, IReviewAuth review, IAppStateStore stateStore, IConfigStore config, IViewerLoginProvider viewerLogin, ILogger<Category> log, CancellationToken ct) =>
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
            await stateStore.SaveAsync(state.WithDefaultLastConfiguredGithubHost(config.Current.Github.Host), ct).ConfigureAwait(false);
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
            await stateStore.SaveAsync(state.WithDefaultLastConfiguredGithubHost(config.Current.Github.Host), ct).ConfigureAwait(false);
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
                await stateStore.SaveAsync(state.WithDefaultLastConfiguredGithubHost(config.Current.Github.Host), ct).ConfigureAwait(false);
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

        // S6 PR2 — Replace the connected PAT with a different one, validating before
        // committing (lazy validate-before-swap). When the new PAT's GitHub login
        // differs from the prior login, the identity-change rule clears every
        // ReviewSessionState's GitHub Node IDs (PendingReviewId / DraftComment.ThreadId
        // / DraftReply.ReplyCommentId) while preserving draft markdown bodies, then
        // publishes IdentityChanged so every connected SSE subscriber re-validates.
        // Spec § 3.
        app.MapPost("/api/auth/replace", async (
            HttpContext ctx,
            ITokenStore tokens,
            IReviewAuth review,
            IAppStateStore stateStore,
            IConfigStore config,
            IViewerLoginProvider viewerLogin,
            SubmitLockRegistry submitLocks,
            IReviewEventBus bus,
            IActivePrCache activePrCache,
            ActivePrSubscriberRegistry activeRegistry,
            InboxPoller inboxPoller,
            ILogger<Category> log,
            CancellationToken ct) =>
        {
            // 1) Submit-in-flight guard. Optimistic check; the lock can still be
            //    acquired between here and the post-validate re-check below.
            var held = submitLocks.AnyHeld();
            if (held.Held)
                return Results.Conflict(new AuthReplaceError(Ok: false, Error: "submit-in-flight", PrRef: held.PrRef));

            // 2) Parse + extract PAT.
            JsonDocument doc;
            try
            {
                doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct).ConfigureAwait(false);
            }
            catch (JsonException)
            {
                return Results.BadRequest(new AuthReplaceError(Ok: false, Error: "invalid-json"));
            }
            using var _doc = doc;
            var pat = doc.RootElement.TryGetProperty("pat", out var p) ? p.GetString() : null;
            if (string.IsNullOrWhiteSpace(pat))
                return Results.BadRequest(new AuthReplaceError(Ok: false, Error: "pat-required"));

            // 3) Snapshot the prior login BEFORE the transient write. Null only on
            //    first-launch (no account yet); the identity-change rule short-circuits
            //    in that case because there's no prior identity to differ from.
            var priorLogin = config.Current.Github.Accounts.Count > 0
                ? config.Current.Github.Accounts[0].Login
                : null;

            // 4) Lazy validate-before-swap: stash transient, ask GitHub if it's good.
            Log.ConnectValidating(log, pat.Length, config.Current.Github.Host);
            await tokens.WriteTransientAsync(pat, ct).ConfigureAwait(false);
            var result = await review.ValidateCredentialsAsync(ct).ConfigureAwait(false);
            if (!result.Ok)
            {
                await tokens.RollbackTransientAsync(ct).ConfigureAwait(false);
#pragma warning disable CA1308 // lowercase error names are part of the wire contract
                var errorName = result.Error?.ToString().ToLowerInvariant() ?? "validation-failed";
#pragma warning restore CA1308
                return Results.BadRequest(new AuthReplaceError(Ok: false, Error: errorName));
            }
            // NoReposSelected is a soft WARNING (spec § 3.5): commit + identity-change
            // still run; the frontend surfaces the warning string from the response.
            var newLogin = result.Login ?? "";

            // 5) TOCTOU re-check: a submit may have grabbed the lock between step 1
            //    and now. If so, roll back the transient before we commit.
            held = submitLocks.AnyHeld();
            if (held.Held)
            {
                await tokens.RollbackTransientAsync(ct).ConfigureAwait(false);
                return Results.Conflict(new AuthReplaceError(Ok: false, Error: "submit-in-flight", PrRef: held.PrRef));
            }

            // 6) Commit + update cached viewer login + persist new login to config.
            await tokens.CommitAsync(ct).ConfigureAwait(false);
            viewerLogin.Set(newLogin);
            await config.SetDefaultAccountLoginAsync(newLogin, ct).ConfigureAwait(false);

            // 7) Identity-change rule (case-insensitive; null priorLogin means
            //    first-launch, which is not "changed identity" — there was nothing
            //    to change from).
            var identityChanged = !string.IsNullOrEmpty(priorLogin)
                && !string.Equals(priorLogin, newLogin, StringComparison.OrdinalIgnoreCase);

            if (identityChanged)
            {
                var sessionsAffected = 0;
                var draftsAffected = 0;
                var repliesAffected = 0;

                await stateStore.UpdateAsync(state =>
                {
                    // UpdateAsync's "last-transform-wins" contract may invoke the
                    // transform more than once under contention. Reset closure-captured
                    // counters at the top of every invocation so losing-run mutations
                    // don't accumulate into the persisted counts (spec § 3.2 retry-safe note).
                    sessionsAffected = 0;
                    draftsAffected = 0;
                    repliesAffected = 0;

                    var sessions = state.Reviews.Sessions;
                    var newSessions = new Dictionary<string, ReviewSessionState>(sessions.Count, StringComparer.Ordinal);
                    foreach (var (refKey, session) in sessions)
                    {
                        var sessionHadIds = session.PendingReviewId is not null
                            || session.DraftComments.Any(d => d.ThreadId is not null)
                            || session.DraftReplies.Any(r => r.ReplyCommentId is not null);

                        var clearedDrafts = session.DraftComments
                            .Select(d => d.ThreadId is null ? d : d with { ThreadId = null })
                            .ToList();
                        var clearedReplies = session.DraftReplies
                            .Select(r => r.ReplyCommentId is null ? r : r with { ReplyCommentId = null })
                            .ToList();

                        newSessions[refKey] = session with
                        {
                            PendingReviewId        = null,
                            PendingReviewCommitOid = null,
                            DraftComments          = clearedDrafts,
                            DraftReplies           = clearedReplies,
                        };

                        if (sessionHadIds) sessionsAffected++;
                        draftsAffected  += session.DraftComments.Count(d => d.ThreadId is not null);
                        repliesAffected += session.DraftReplies.Count(r => r.ReplyCommentId is not null);
                    }
                    return state.WithDefaultReviews(state.Reviews with { Sessions = newSessions });
                }, ct).ConfigureAwait(false);

                // Spec § 14 OQ 4: forensic-log loss must NOT leave the system half-reconciled.
                // If the logger throws (disk full, ETW broken, etc.), the surrounding cache
                // eviction + SSE fan-out + response still run. Filter out terminal exceptions
                // (OOM / stack overflow) per the standard CA1031 carve-out.
                try
                {
                    Log.LogIdentityChanged(log, AccountKeys.Default, priorLogin!, newLogin,
                        sessionsAffected, draftsAffected, repliesAffected);
                }
#pragma warning disable CA1031 // intentional: forensic-log loss < partial state reconciliation
                catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
                {
                    // Swallow so cache eviction + SSE fan-out still run.
                }
#pragma warning restore CA1031

                activePrCache.Clear();
                inboxPoller.RequestImmediateRefresh();
                activeRegistry.RemoveAll();
                bus.Publish(new IdentityChanged(AccountKeys.Default, priorLogin!, newLogin));
            }

            return Results.Ok(new AuthReplaceResponse(
                Ok: true,
                Login: newLogin,
                Host: config.Current.Github.Host,
                IdentityChanged: identityChanged));
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

        // S6 PR2 — forensic record emitted from /api/auth/replace when the identity-change
        // rule fires. Parameter names use qualified `priorLogin` / `newLogin` so the
        // LoggerMessage source generator emits them as structured-log field keys that
        // SensitiveFieldScrubber does NOT match (bare `{login}` would be redacted —
        // see deferrals sidecar entry for the existing-callsite forensic gap).
        // Spec § 3.6.
        [LoggerMessage(
            Level = LogLevel.Information,
            Message = "Identity changed accountKey={AccountKey} priorLogin={PriorLogin} newLogin={NewLogin} sessions={SessionsAffected} drafts={DraftsAffected} replies={RepliesAffected}")]
        internal static partial void LogIdentityChanged(
            ILogger logger,
            string accountKey,
            string priorLogin,
            string newLogin,
            int sessionsAffected,
            int draftsAffected,
            int repliesAffected);
    }
}
