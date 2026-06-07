using FluentAssertions;
using PRism.GitHub.Feedback;
using Xunit;

namespace PRism.GitHub.Tests.Feedback;

public class FeedbackRepoTests
{
    // Single-side-edit guard: pins this tier's literal. The frontend pins the same
    // value in feedbackRepo.test.ts. Does NOT catch a deliberate rename (both sides
    // updated together stay green) — it catches an accidental one-sided change.
    [Fact]
    public void Slug_is_the_public_feedback_repo()
    {
        FeedbackRepo.Owner.Should().Be("prpande");
        FeedbackRepo.Name.Should().Be("PRism-feedback");
        FeedbackRepo.Slug.Should().Be("prpande/PRism-feedback");
    }
}
