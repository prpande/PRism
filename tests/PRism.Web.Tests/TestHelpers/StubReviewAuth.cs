using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.Web.Tests.TestHelpers;

/// <summary>
/// Auth-only <see cref="IReviewAuth"/> stub: <see cref="ValidateCredentialsAsync"/> returns
/// whatever the supplied callback yields. The other capability interfaces stay bound to the
/// real GitHubReviewService (never resolved in auth tests). Wired in via
/// <see cref="PRismWebApplicationFactory.ValidateOverride"/> and the per-file auth harness factories.
/// </summary>
internal sealed class StubReviewAuth : IReviewAuth
{
    private readonly Func<Task<AuthValidationResult>> _validate;
    public StubReviewAuth(Func<Task<AuthValidationResult>> validate) { _validate = validate; }
    public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct, bool skipCredentialHealth = false) => _validate();
}
