using PRism.Core.Time;

namespace PRism.Core.Tests.TestHelpers;

public sealed class TestClock : IClock
{
    public DateTime UtcNow { get; set; } = new(2026, 5, 5, 12, 0, 0, DateTimeKind.Utc);
    public void Advance(TimeSpan by) => UtcNow = UtcNow.Add(by);
}
