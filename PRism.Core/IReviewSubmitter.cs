using System.Diagnostics.CodeAnalysis;

namespace PRism.Core;

// Capability sub-interface from the ADR-S5-1 split of IReviewService.
// PR0a lands the empty seam so DI + fakes split alongside the other three interfaces.
// PR1 lands the seven pending-review pipeline methods.
// See docs/specs/2026-05-11-s5-submit-pipeline-design.md § 3 + § 4.
[SuppressMessage("Design", "CA1040:Avoid empty interfaces",
    Justification = "Intentional empty capability seam landed by ADR-S5-1's PR0a so DI registrations and test fakes can split alongside the other three sub-interfaces; PR1 fills it with the seven pending-review pipeline methods.")]
public interface IReviewSubmitter
{
}
