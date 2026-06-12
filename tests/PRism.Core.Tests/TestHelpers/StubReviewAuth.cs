using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.Core.Tests.TestHelpers;

// Minimal IReviewAuth fake for hydrator tests. Either returns a pre-canned
// AuthValidationResult, throws a fixed guard exception if `throwOnValidate` is true
// (verifies that the hydrator never reaches Validate — e.g. when there's no token or
// a login is already cached), or throws a caller-supplied exception (to exercise the
// hydrator's forgiving-startup and cancellation paths).
internal sealed class StubReviewAuth : IReviewAuth
{
    private readonly AuthValidationResult? _result;
    private readonly bool _throwOnValidate;
    private readonly Exception? _toThrow;

    public StubReviewAuth(AuthValidationResult result)
    {
        _result = result;
    }

    public StubReviewAuth(bool throwOnValidate)
    {
        _throwOnValidate = throwOnValidate;
    }

    // Throw a specific exception from ValidateCredentialsAsync — e.g. an
    // HttpRequestException (network blip → forgiving startup) or an
    // OperationCanceledException (cancellation propagation).
    public StubReviewAuth(Exception toThrow)
    {
        _toThrow = toThrow;
    }

    public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct, bool skipCredentialHealth = false)
    {
        if (_throwOnValidate)
            throw new InvalidOperationException("ValidateCredentialsAsync should not have been called");
        if (_toThrow is not null)
            throw _toThrow;
        return Task.FromResult(_result!);
    }
}
