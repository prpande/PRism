using FluentAssertions;
using PRism.GitHub.Tests.Integration.Helpers;
using Xunit;

namespace PRism.GitHub.Tests.Integration.Helpers;

public class CaptureModeGuardTests
{
    // Tests use a value object so they don't mutate process env vars. The production code path
    // reads `Environment.GetEnvironmentVariable("PRISM_FROZEN_PR_CAPTURE_FIXTURE")`; the helper
    // accepts the value as a parameter to keep tests deterministic and parallel-safe.

    [Theory]
    [InlineData("1", true)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("true", false)]
    [InlineData("yes", false)]
    [InlineData("0", false)]
    [InlineData("11", false)]
    [InlineData(" 1", false)]
    [InlineData("1 ", false)]
    public void IsCaptureModeEnabled_requires_exact_string_1(string? value, bool expected)
    {
        GhCliPat.IsCaptureModeEnabled(value).Should().Be(expected);
    }

    [Fact]
    public void EnsureCaptureModeNotInCi_throws_when_both_capture_and_CI_env_vars_are_set()
    {
        // Spec § 7 — two-layer guard, layer 2: code path throws when CI + capture both active.
        var ex = Assert.Throws<InvalidOperationException>(
            () => GhCliPat.EnsureCaptureModeNotInCi(captureValue: "1", ciValue: "true"));
        ex.Message.Should().Contain("Capture mode is disabled in CI");
    }

    [Theory]
    [InlineData("1", null)]      // capture set, CI unset — allowed (local capture)
    [InlineData(null, "true")]   // capture unset, CI set — allowed (assert mode in CI)
    [InlineData(null, null)]     // neither — allowed (assert mode locally)
    [InlineData("", "true")]     // capture explicitly empty in CI — allowed (layer 1 override)
    public void EnsureCaptureModeNotInCi_allows_safe_combinations(string? capture, string? ci)
    {
        // Should not throw
        GhCliPat.EnsureCaptureModeNotInCi(capture, ci);
    }
}
