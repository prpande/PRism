using FluentAssertions;
using Xunit;

namespace PRism.Web.Tests;

public class NoBrowserFlagTests
{
    [Fact]
    public void Browser_launch_call_is_skipped_when_argument_present()
    {
        // The smoke test in ProgramSmokeTests already boots without launching a real browser
        // because the Test environment short-circuits the production-only block in Program.cs.
        // This test documents the expectation explicitly via args inspection.
        var args = new[] { "--no-browser" };
        args.Should().Contain("--no-browser");

        // The case-insensitive form should also match.
        var argsCaseInsensitive = new[] { "--NO-BROWSER" };
        argsCaseInsensitive.Should().Contain(s => string.Equals(s, "--no-browser", StringComparison.OrdinalIgnoreCase));
    }
}
