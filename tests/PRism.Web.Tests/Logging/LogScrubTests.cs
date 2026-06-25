using PRism.Web.Logging;
using FluentAssertions;
using Xunit;

namespace PRism.Web.Tests.Logging;

public class LogScrubTests
{
    [Theory]
    // GitHub PAT prefixes — redacted to the unified [REDACTED] marker (shared with
    // SensitiveFieldScrubber so a single log file carries one redaction token).
    [InlineData("token=ghp_abcdefghijklmnopqrstuvwxyz1234567890", "token=[REDACTED]")]
    [InlineData("Bearer github_pat_abcDEF123_xyz", "Bearer [REDACTED]")]
    // Bearer credential whose token has no GitHub prefix — the token is redacted, the
    // "Bearer " scheme is kept for debuggability.
    [InlineData("Authorization: Bearer abc123XYZopaqueToken", "Authorization: Bearer [REDACTED]")]
    // Anthropic API key shape (claude CLI subprocess error text).
    [InlineData("spawn failed: sk-ant-api03-AbC_123-xyz rejected", "spawn failed: [REDACTED] rejected")]
    [InlineData("nothing sensitive", "nothing sensitive")]
    public void Redacts_PAT_patterns(string input, string expected)
    {
        LogScrub.Apply(input).Should().Be(expected);
    }
}
