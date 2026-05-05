using PRism.Core.Time;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Time;

public class SystemClockTests
{
    [Fact]
    public void UtcNow_returns_a_value_within_a_second_of_DateTime_UtcNow()
    {
        var clock = new SystemClock();
        var before = DateTime.UtcNow;
        var observed = clock.UtcNow;
        var after = DateTime.UtcNow;

        observed.Should().BeOnOrAfter(before).And.BeOnOrBefore(after);
        observed.Kind.Should().Be(DateTimeKind.Utc);
    }
}
