using System.Globalization;
using FluentAssertions;
using PRism.Core.Feedback;
using Xunit;

namespace PRism.Core.Tests.Feedback;

public class FeedbackTypesTests
{
    [Fact]
    public void FeedbackContent_carries_the_allowlisted_fields_including_timestamp()
    {
        var ts = DateTimeOffset.Parse("2026-06-06T12:00:00Z", CultureInfo.InvariantCulture);
        var c = new FeedbackContent("Bug", "Summary", "Details", "/pr/:owner/:repo/:number", "desktop", "0.2.0", ts);
        c.Category.Should().Be("Bug");
        c.RoutePattern.Should().Be("/pr/:owner/:repo/:number");
        c.Version.Should().Be("0.2.0");
        c.SubmittedAt.Should().Be(ts);
    }

    [Fact]
    public void FeedbackCreateResult_distinguishes_created_from_cannot_create()
    {
        FeedbackCreateResult.Created(12, "https://github.com/prpande/PRism-feedback/issues/12")
            .Should().Match<FeedbackCreateResult>(r => r.Outcome == FeedbackOutcome.Created && r.IssueNumber == 12);
        FeedbackCreateResult.CannotCreate().Outcome.Should().Be(FeedbackOutcome.CannotCreate);
    }
}
