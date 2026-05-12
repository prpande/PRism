using PRism.Core;

namespace PRism.Web.TestHooks;

// Test-only IReviewSubmitter (ADR-S5-1 split). Empty in PR0a — PR1 fills it with the
// seven pending-review pipeline methods, backed by FakeReviewBackingStore.
internal sealed class FakeReviewSubmitter : IReviewSubmitter
{
}
