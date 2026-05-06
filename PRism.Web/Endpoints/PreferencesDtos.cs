namespace PRism.Web.Endpoints;

// Wire shapes for PreferencesEndpoints. GET /api/preferences and the success body of
// POST /api/preferences share PreferencesResponse. Errors get the simple-envelope shape.

internal sealed record PreferencesResponse(string Theme, string Accent, bool AiPreview);

internal sealed record PreferencesError(string Error);
