using System.Text.Json.Serialization;

namespace PRism.Web.Endpoints;

// Wire shapes for PreferencesEndpoints. GET /api/preferences and the success body of
// POST /api/preferences share PreferencesResponse. Errors get the simple-envelope shape.
//
// S6 PR1 (spec § 2.4): the response was widened from a flat `ui` block to nested
// `ui` + `inbox.sections` + `github` blocks so the Settings page can render the
// full preference set without a separate fetch per concern.
//
// JsonSerializerOptionsFactory.Api uses camelCase naming (see PRism.Core/Json/
// JsonSerializerOptionsFactory.cs:39), so `ConfigPath`/`LogsPath` etc. serialize
// to `configPath`/`logsPath` automatically — no [JsonPropertyName] needed. The
// inbox-section keys are kebab-cased to match the dotted-path PatchAsync allowlist
// (e.g. `inbox.sections.review-requested`); kebab-case is NOT a default policy of
// JsonSerializerOptionsFactory.Api, so each property gets an explicit attribute.

internal sealed record PreferencesResponse(
    UiPreferencesDto Ui,
    InboxPreferencesDto Inbox,
    GithubPreferencesDto Github);

internal sealed record UiPreferencesDto(string Theme, string Accent, bool AiPreview, string Density, string ContentScale);

internal sealed record InboxPreferencesDto(InboxSectionsDto Sections, string DefaultSort);

internal sealed record InboxSectionsDto(
    [property: JsonPropertyName("review-requested")] bool ReviewRequested,
    [property: JsonPropertyName("awaiting-author")]  bool AwaitingAuthor,
    [property: JsonPropertyName("authored-by-me")]   bool AuthoredByMe,
    // `Mentioned` serializes as `mentioned` natively under the camelCase policy — no
    // [JsonPropertyName] needed (claude[bot] review on PR #69 caught the redundancy).
    bool Mentioned,
    [property: JsonPropertyName("recently-closed")]  bool RecentlyClosed);

internal sealed record GithubPreferencesDto(string Host, string ConfigPath, string LogsPath);

internal sealed record PreferencesError(string Error);
