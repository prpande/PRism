using PRism.Core.Hosting;

namespace PRism.Core.Tests.Hosting;

public class SidecarModeTests
{
    [Fact]
    public void Detect_WhenFlagIsOne_ReturnsEnabledWithParentPid()
    {
        var env = new Dictionary<string, string?>
        {
            ["PRISM_SIDECAR"] = "1",
            ["PRISM_PARENT_PID"] = "4242",
        };

        var mode = SidecarMode.Detect(key => env.GetValueOrDefault(key));

        Assert.True(mode.Enabled);
        Assert.Equal(4242, mode.ParentPid);
    }

    [Fact]
    public void Detect_WhenFlagAbsent_ReturnsDisabled()
    {
        var mode = SidecarMode.Detect(_ => null);

        Assert.False(mode.Enabled);
        Assert.Null(mode.ParentPid);
    }

    [Fact]
    public void Detect_WhenFlagSetButParentPidUnparseable_EnabledWithNullPid()
    {
        var env = new Dictionary<string, string?>
        {
            ["PRISM_SIDECAR"] = "1",
            ["PRISM_PARENT_PID"] = "not-a-number",
        };

        var mode = SidecarMode.Detect(key => env.GetValueOrDefault(key));

        Assert.True(mode.Enabled);
        Assert.Null(mode.ParentPid);
    }
}
