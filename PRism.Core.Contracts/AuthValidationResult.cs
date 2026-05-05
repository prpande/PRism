namespace PRism.Core.Contracts;

public sealed record AuthValidationResult(
    bool Ok,
    string? Login,
    IReadOnlyList<string>? Scopes,
    AuthValidationError? Error,
    string? ErrorDetail);

public enum AuthValidationError
{
    None,
    InvalidToken,
    InsufficientScopes,
    NetworkError,
    DnsError,
    ServerError,
}
