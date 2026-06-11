using PRism.Core.Time;

namespace PRism.GitHub.Tests.TestHelpers;

internal sealed class MutableClock : IClock
{
    public DateTime UtcNow { get; set; } = new(2026, 6, 11, 12, 0, 0, DateTimeKind.Utc);
    public void Advance(TimeSpan by) => UtcNow = UtcNow.Add(by);
}
