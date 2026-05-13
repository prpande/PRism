namespace PRism.Core.Config;

/// <summary>
/// Per-account GitHub configuration. v1 stores one entry under the default account key
/// (see <see cref="PRism.Core.State.AccountKeys.Default"/>). The on-disk JSON shape uses
/// kebab-case keys via <see cref="PRism.Core.Json.JsonSerializerOptionsFactory.Storage"/>:
/// <c>{ "id": "default", "host": "...", "login": null, "local-workspace": null }</c>.
/// </summary>
/// <param name="Id">Stable account identifier. v1 is always <c>"default"</c>; v2 may introduce UUIDs.</param>
/// <param name="Host">GitHub host URL (e.g. <c>https://github.com</c> or a GHES origin). Non-null.</param>
/// <param name="Login">GitHub viewer login for this account. Null until first PAT validation populates it via <see cref="PRism.Core.Auth.ViewerLoginHydrator"/>.</param>
/// <param name="LocalWorkspace">Per-account local clone root path. Null when the user hasn't configured one.</param>
public sealed record GithubAccountConfig(
    string Id,
    string Host,
    string? Login,
    string? LocalWorkspace);
