using FluentAssertions;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public class AiConfigBoundsTests
{
    [Theory]
    [InlineData(29, 30)]   // below min → min
    [InlineData(30, 30)]
    [InlineData(240, 240)]
    [InlineData(600, 600)]
    [InlineData(601, 600)] // above max → max
    public void ClampTimeout_clamps_to_30_600(int input, int expected) =>
        AiConfigBounds.ClampTimeout(input).Should().Be(expected);

    [Theory]
    [InlineData(0, 1)]     // below min → min (write-path semantics: 1, not the read-path floor 10)
    [InlineData(1, 1)]
    [InlineData(10, 10)]
    [InlineData(50, 50)]
    [InlineData(999, 50)]  // above max → max
    public void ClampCap_clamps_to_1_50(int input, int expected) =>
        AiConfigBounds.ClampCap(input).Should().Be(expected);

    [Theory]
    [InlineData(-1, 10)]   // legacy/absent → DefaultCap (NOT min 1)
    [InlineData(0, 10)]    // legacy/absent → DefaultCap
    [InlineData(1, 1)]
    [InlineData(10, 10)]
    [InlineData(50, 50)]
    [InlineData(999, 50)]  // over-max → max
    public void ClampCapForRead_floors_nonpositive_to_10_and_caps_at_50(int input, int expected) =>
        AiConfigBounds.ClampCapForRead(input).Should().Be(expected);

    [Theory]
    [InlineData(499, 500)]  // below min → min (write-path floor)
    [InlineData(500, 500)]
    [InlineData(1000, 1000)]
    [InlineData(5000, 5000)]
    [InlineData(5001, 5000)] // above max → max
    public void ClampSummaryChars_clamps_to_500_5000(int input, int expected) =>
        AiConfigBounds.ClampSummaryChars(input).Should().Be(expected);

    [Theory]
    [InlineData(-1, 1000)]   // legacy/absent → DefaultSummaryChars (NOT the write floor 500)
    [InlineData(0, 1000)]    // legacy/absent → DefaultSummaryChars
    [InlineData(100, 100)]   // hand-edited sub-500 positive value is preserved (NOT floored) so the
                             // displayed value == the value the summarizer stamps (D6 stamp pin)
    [InlineData(500, 500)]
    [InlineData(1000, 1000)]
    [InlineData(5000, 5000)]
    [InlineData(9999, 5000)] // over-max → max
    public void ClampSummaryCharsForRead_floors_nonpositive_to_1000_and_caps_at_5000(int input, int expected) =>
        AiConfigBounds.ClampSummaryCharsForRead(input).Should().Be(expected);

    [Fact]
    public void Constants_expose_the_documented_bounds()
    {
        AiConfigBounds.MinTimeout.Should().Be(30);
        AiConfigBounds.MaxTimeout.Should().Be(600);
        AiConfigBounds.MinCap.Should().Be(1);
        AiConfigBounds.MaxCap.Should().Be(50);
        AiConfigBounds.DefaultCap.Should().Be(10);
        AiConfigBounds.MinSummaryChars.Should().Be(500);
        AiConfigBounds.MaxSummaryChars.Should().Be(5000);
        AiConfigBounds.DefaultSummaryChars.Should().Be(1000);
    }
}
