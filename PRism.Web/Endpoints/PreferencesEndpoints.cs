using System.Text.Json;
using PRism.Core.Ai;
using PRism.Core.Config;

namespace PRism.Web.Endpoints;

internal static class PreferencesEndpoints
{
    public static IEndpointRouteBuilder MapPreferences(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/preferences", (IConfigStore config) => Results.Ok(new PreferencesResponse(
            Theme: config.Current.Ui.Theme,
            Accent: config.Current.Ui.Accent,
            AiPreview: config.Current.Ui.AiPreview)));

        app.MapPost("/api/preferences", async (HttpContext ctx, IConfigStore config, AiPreviewState aiState) =>
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

            return Results.Ok(new PreferencesResponse(
                Theme: config.Current.Ui.Theme,
                Accent: config.Current.Ui.Accent,
                AiPreview: config.Current.Ui.AiPreview));
        });

        return app;
    }
}
