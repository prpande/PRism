using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.Core.Tests.TestHelpers;

// Minimal IReviewAuth fake for hydrator tests. Either returns a pre-canned
// AuthValidationResult or throws if `throwOnValidate` is true (verifies that the
// hydrator never reaches Validate when there's no token).
internal sealed class StubReviewAuth : IReviewAuth
{
    private readonly AuthValidationResult? _result;
    private readonly bool _throwOnValidate;

    public StubReviewAuth(AuthValidationResult result)
    {
        _result = result;
    }

    public StubReviewAuth(bool throwOnValidate)
    {
        _throwOnValidate = throwOnValidate;
    }

    public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct)
    {
        if (_throwOnValidate)
            throw new InvalidOperationException("ValidateCredentialsAsync should not have been called");
        return Task.FromResult(_result!);
    }
}
