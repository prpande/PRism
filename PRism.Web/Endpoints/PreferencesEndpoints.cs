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

        app.MapPost("/api/preferences", async (HttpContext ctx, IConfigStore config, LogsPathInfo logsPath, AiModeState aiState) =>
        {
            var read = await HttpJson.TryReadJsonObjectAsync(ctx, ctx.RequestAborted).ConfigureAwait(false);
            if (read.Error == JsonReadError.InvalidJson)
                return Results.BadRequest(new PreferencesError(Error: "invalid-json"));
            if (read.Error == JsonReadError.NotObject)
                return Results.BadRequest(new PreferencesError(Error: "body must be a JSON object"));
            using var doc = read.Document!;

            var props = doc.RootElement.EnumerateObject().ToArray();
            if (props.Length != 1)
                return Results.BadRequest(new PreferencesError(Error: "exactly one field per patch"));

            var key = props[0].Name;
            object? value = props[0].Value.ValueKind switch
            {
                JsonValueKind.String => props[0].Value.GetString(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                // #496: a FRACTIONAL JSON number (e.g. 3.5) OR one outside Int32 range (e.g. 99999999999)
                // makes TryGetInt32 return false → null, which ConfigStore's Int guard rejects as 400
                // (consistent with the existing null-on-unsupported-kind path). NOTE TryGetInt32 ACCEPTS
                // an integer-valued decimal like 300.0 / 3e2 (returns 300) — harmless, since the value is
                // then clamped and the bounded UI never emits decimals; do NOT add a test asserting 300.0→400.
                JsonValueKind.Number => props[0].Value.TryGetInt32(out var n) ? n : (object?)null,
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

            // Mirror ui.ai.mode into the AiModeState holder (also handled by the Changed
            // subscription, but doing it here makes the response synchronous with the change).
            aiState.Mode = config.Current.Ui.Ai.Mode;

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
        var feat = ui.Ai.Features.Enabled;
        bool On(string k) => !feat.TryGetValue(k, out var v) || v;   // fail-open: missing → true
        return new PreferencesResponse(
            Ui: new UiPreferencesDto(
                    ui.Theme,
                    ui.Accent,
                    AiPreview: ui.Ai.Mode != AiMode.Off,
#pragma warning disable CA1308 // lowercase mode names (off|preview|live) are the wire contract surfaced to the renderer. ToLowerInvariant()==kebab holds only while every AiMode member is a single word; in lockstep with ConfigStore.ParseAiMode + KebabCaseJsonNamingPolicy. A future multi-word member (e.g. LiveReadOnly) must move this to the kebab serializer so wire ("live-read-only") and parse stay aligned.
                    AiMode: ui.Ai.Mode.ToString().ToLowerInvariant(),
#pragma warning restore CA1308
                    ui.Density,
                    ui.ContentScale,
                    // #496: clamp for display so the shown value == the effective value even after a
                    // hand-edited config.json that bypassed PatchAsync (ReadFromDiskAsync does not normalize).
                    // The cap uses ClampCapForRead (NOT ClampCap) so the display matches the annotator's
                    // read semantics exactly — including the legacy `<=0 → 10` corner.
                    ProviderTimeoutSeconds: AiConfigBounds.ClampTimeout(ui.Ai.ProviderTimeoutSeconds),
                    HunkAnnotationCap: AiConfigBounds.ClampCapForRead(ui.Ai.HunkAnnotationCap),
                    // #525: same read-clamp the summarizer stamps onto PrSummary.GeneratedMaxChars, so the
                    // displayed cap and the card's stale-detection comparison can never disagree (D6).
                    SummaryMaxChars: AiConfigBounds.ClampSummaryCharsForRead(ui.Ai.SummaryMaxChars),
                    Features: new AiFeaturesDto(
                        Summary:             On("summary"),
                        FileFocus:           On("fileFocus"),
                        HunkAnnotations:     On("hunkAnnotations"),
                        PreSubmitValidators: On("preSubmitValidators"),
                        ComposerAssist:      On("composerAssist"),
                        DraftSuggestions:    On("draftSuggestions"),
                        DraftReconciliation: On("draftReconciliation"),
                        InboxEnrichment:     On("inboxEnrichment"),
                        InboxRanking:        On("inboxRanking"))),
            Inbox: new InboxPreferencesDto(
                new InboxSectionsDto(
                    ReviewRequested: sections.ReviewRequested,
                    AwaitingAuthor:  sections.AwaitingAuthor,
                    AuthoredByMe:    sections.AuthoredByMe,
                    Mentioned:       sections.Mentioned,
                    RecentlyClosed:  sections.RecentlyClosed),
                config.Current.Inbox.DefaultSort,
                config.Current.Inbox.SectionOrder,
                config.Current.Inbox.ShowActivityRail,
                config.Current.Inbox.GroupByRepo),
            Github: new GithubPreferencesDto(
                Host:       config.Current.Github.Host,
                ConfigPath: config.ConfigPath,
                LogsPath:   logsPath.Path));
    }
}
