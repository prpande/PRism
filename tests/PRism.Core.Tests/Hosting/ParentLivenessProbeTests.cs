using PRism.Core.Hosting;

namespace PRism.Core.Tests.Hosting;

public class ParentLivenessProbeTests
{
    // Fake process accessor: returns a start-time for a pid, or null if "not running".
    private static Func<int, DateTime?> Accessor(Dictionary<int, DateTime?> table)
        => pid => table.TryGetValue(pid, out var t) ? t : null;

    [Fact]
    public void IsParentAlive_WhenPidPresentAndStartTimeStable_ReturnsTrue()
    {
        var start = new DateTime(2026, 6, 2, 10, 0, 0, DateTimeKind.Utc);
        var table = new Dictionary<int, DateTime?> { [100] = start };
        var probe = ParentLivenessProbe.Arm(100, Accessor(table));

        Assert.NotNull(probe);
        Assert.True(probe!.IsParentAlive());
    }

    [Fact]
    public void IsParentAlive_WhenPidDisappears_ReturnsFalse()
    {
        var start = new DateTime(2026, 6, 2, 10, 0, 0, DateTimeKind.Utc);
        var table = new Dictionary<int, DateTime?> { [100] = start };
        var probe = ParentLivenessProbe.Arm(100, Accessor(table))!;

        table[100] = null; // parent exited

        Assert.False(probe.IsParentAlive());
    }

    [Fact]
    public void IsParentAlive_WhenPidRecycledToNewProcess_ReturnsFalse()
    {
        var start = new DateTime(2026, 6, 2, 10, 0, 0, DateTimeKind.Utc);
        var table = new Dictionary<int, DateTime?> { [100] = start };
        var probe = ParentLivenessProbe.Arm(100, Accessor(table))!;

        table[100] = start.AddMinutes(5); // same PID, different process (recycled)

        Assert.False(probe.IsParentAlive());
    }

    [Fact]
    public void Arm_WhenParentAlreadyGone_ReturnsNull()
    {
        var probe = ParentLivenessProbe.Arm(100, Accessor(new Dictionary<int, DateTime?>()));
        Assert.Null(probe);
    }
}
