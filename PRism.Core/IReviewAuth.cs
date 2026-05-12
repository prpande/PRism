using PRism.Core.Contracts;

namespace PRism.Core;

// Capability sub-interface from the ADR-S5-1 split of IReviewService.
// See docs/specs/2026-05-11-s5-submit-pipeline-design.md § 3.
public interface IReviewAuth
{
    Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct);
}
