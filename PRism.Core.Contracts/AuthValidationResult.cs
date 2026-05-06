namespace PRism.Core.Contracts;

public sealed record AuthValidationResult(
    bool Ok,
    string? Login,
    IReadOnlyList<string>? Scopes,
    AuthValidationError? Error,
    string? ErrorDetail,
    AuthValidationWarning Warning = AuthValidationWarning.None);

public enum AuthValidationError
{
    None,
    InvalidToken,
    InsufficientScopes,
    NetworkError,
    DnsError,
    ServerError,
}

public enum AuthValidationWarning
{
    None,
    NoReposSelected,
}
