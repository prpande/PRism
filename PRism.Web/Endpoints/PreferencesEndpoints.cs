using System.Text.Json;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Web.Logging;

namespace PRism.Web.Endpoints;

internal static class PreferencesEndpoints
{
    public static IEndpointRouteBuilder MapPreferences(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/preferences", (IConfigStore config, LogsPathInfo logsPath) =>
            Results.Ok(BuildResponse(config, logsPath)));

        app.MapPost("/api/preferences", async (HttpContext ctx, IConfigStore config, LogsPathInfo logsPath, AiPreviewState aiState) =>
        {
            using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ctx.RequestAborted).ConfigureAwait(false);
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
                return Results.BadRequest(new PreferencesError(Error: "body must be a JSON object"));

            var props = doc.RootElement.EnumerateObject().ToArray();
            if (props.Length != 1)
                return Results.BadRequest(new PreferencesError(Error: "exactly one field per patch"));

            var key = props[0].Name;
            object? value = props[0].Value.ValueKind switch
            {
                JsonValueKind.String => props[0].Value.GetString(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            };

            try
            {
                await config.PatchAsync(new Dictionary<string, object?> { [key] = value }, ctx.RequestAborted).ConfigureAwait(false);
            }
            catch (ConfigPatchException ex)
            {
                return Results.BadRequest(new PreferencesError(Error: ex.Message));
            }

            // Mirror ui.aiPreview into the AiPreviewState holder (also handled by the Changed
            // subscription, but doing it here makes the response synchronous with the change).
            aiState.IsOn = config.Current.Ui.AiPreview;

            return Results.Ok(BuildResponse(config, logsPath));
        });

        return app;
    }

    // Shared projection of (IConfigStore, LogsPathInfo) → wire shape so GET and POST stay
    // in sync. The Github block surfaces configPath and logsPath (S6 PR1, spec § 2.4) so
    // the Settings page can render copy-able file paths without re-deriving them client-side.
    private static PreferencesResponse BuildResponse(IConfigStore config, LogsPathInfo logsPath)
    {
        var ui = config.Current.Ui;
        var sections = config.Current.Inbox.Sections;
        return new PreferencesResponse(
            Ui: new UiPreferencesDto(ui.Theme, ui.Accent, ui.AiPreview, ui.Density),
            Inbox: new InboxPreferencesDto(new InboxSectionsDto(
                ReviewRequested: sections.ReviewRequested,
                AwaitingAuthor:  sections.AwaitingAuthor,
                AuthoredByMe:    sections.AuthoredByMe,
                Mentioned:       sections.Mentioned,
                CiFailing:       sections.CiFailing)),
            Github: new GithubPreferencesDto(
                Host:       config.Current.Github.Host,
                ConfigPath: config.ConfigPath,
                LogsPath:   logsPath.Path));
    }
}
