using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.Web.TestHooks;

// Test-only IReviewAuth (ADR-S5-1 split). Always validates as the canonical e2e-user with
// the `repo` scope. See FakeReviewBackingStore for the shared scenario state.
internal sealed class FakeReviewAuth : IReviewAuth
{
    public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct) =>
        Task.FromResult(new AuthValidationResult(true, "e2e-user", FakeReviewBackingStore.AuthScopes, null, null));
}
