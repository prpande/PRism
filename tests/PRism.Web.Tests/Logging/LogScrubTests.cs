using PRism.Web.Logging;
using FluentAssertions;
using Xunit;

namespace PRism.Web.Tests.Logging;

public class LogScrubTests
{
    [Theory]
    [InlineData("token=ghp_abcdefghijklmnopqrstuvwxyz1234567890", "token=<redacted>")]
    [InlineData("Bearer github_pat_abcDEF123_xyz", "Bearer <redacted>")]
    [InlineData("nothing sensitive", "nothing sensitive")]
    public void Redacts_PAT_patterns(string input, string expected)
    {
        LogScrub.Apply(input).Should().Be(expected);
    }
}
