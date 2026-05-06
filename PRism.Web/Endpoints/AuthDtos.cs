using System.Text.Json.Serialization;

namespace PRism.Web.Endpoints;

// Wire shapes for AuthEndpoints. See AuthEndpoints.cs for the routes that produce each.
// JSON serialization respects the camelCase PropertyNamingPolicy plumbed via
// PRism.Web.Composition.AddPrismWeb -> ConfigureHttpJsonOptions, so PascalCase property
// names round-trip to camelCase on the wire — matching the original anonymous-type field
// names byte-for-byte.

internal sealed record AuthStateResponse(bool HasToken, string Host, AuthHostMismatch? HostMismatch);

internal sealed record AuthHostMismatch(
    [property: JsonPropertyName("old")] string Old,
    [property: JsonPropertyName("new")] string New);

// /api/auth/connect: 400 BadRequest on invalid-json or pat-required.
// /api/auth/connect/commit: 409 Conflict on no-pending-token.
internal sealed record AuthConnectError(bool Ok, string Error);

// /api/auth/connect: 200 OK with ok=false when the validation call to GitHub itself failed.
internal sealed record AuthConnectValidationFailed(bool Ok, string? Error, string? Detail);

// /api/auth/connect: 200 OK with ok=true after successful validation + commit.
internal sealed record AuthConnectSuccess(bool Ok, string? Login, string Host);

// /api/auth/connect: 200 OK with ok=true plus a soft warning; client must call /commit.
internal sealed record AuthConnectWithWarning(bool Ok, string? Login, string Host, string Warning);

// /api/auth/connect/commit: 200 OK on success.
internal sealed record AuthCommitSuccess(bool Ok, string Host);

// /api/auth/host-change-resolution: error envelope (no `ok` field, by design).
internal sealed record HostChangeError(string Error);

// /api/auth/host-change-resolution: continue branch.
internal sealed record HostChangeOk(bool Ok);

// /api/auth/host-change-resolution: revert branch (server is exiting).
internal sealed record HostChangeExiting(bool Ok, bool Exiting);
