using System.Reflection;
using PRism.Core.State;

namespace PRism.Core.Tests.State;

// Pin the MigrationSteps array to ascending ToVersion order. Without this, a future
// developer adding (4, v3→v4) BEFORE (3, v2→v3) would silently corrupt v2 files
// (they'd run v3→v4 against a v2 shape). The runtime guard in AppStateStore sorts
// defensively; this test ensures the source-level array is also correct, so any
// out-of-order addition fails CI immediately rather than relying on the defensive sort.
public class AppStateMigrationsOrderingTests
{
    [Fact]
    public void MigrationSteps_AreInAscendingToVersionOrder()
    {
        var field = typeof(AppStateStore).GetField(
            "MigrationSteps", BindingFlags.NonPublic | BindingFlags.Static)!;

        var steps = (Array)field.GetValue(null)!;
        Assert.NotNull(steps);
        Assert.True(steps.Length >= 1, "expected at least one migration step");

        var toVersions = new int[steps.Length];
        for (var i = 0; i < steps.Length; i++)
        {
            // Each tuple element is (int ToVersion, Func<JsonObject, JsonObject> Transform)
            var tuple = steps.GetValue(i)!;
            var toVersion = (int)tuple.GetType().GetField("Item1")!.GetValue(tuple)!;
            toVersions[i] = toVersion;
        }

        for (var i = 1; i < toVersions.Length; i++)
        {
            Assert.True(toVersions[i] > toVersions[i - 1],
                $"MigrationSteps must be ascending by ToVersion; got [{string.Join(",", toVersions)}]");
        }
    }
}
