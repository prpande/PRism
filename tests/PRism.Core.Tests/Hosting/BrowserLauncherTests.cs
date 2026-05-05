using System;
using PRism.Core.Hosting;
using FluentAssertions;
using Moq;
using Xunit;

namespace PRism.Core.Tests.Hosting;

public class BrowserLauncherTests
{
    [Fact]
    public void Launch_on_Windows_uses_ShellExecute_with_url()
    {
        var runner = new Mock<IProcessRunner>();
        var launcher = new BrowserLauncher(runner.Object, OSPlatform.Windows);
        launcher.Launch("http://localhost:5180");
        runner.Verify(r => r.Start(
            It.Is<ProcessStart>(s => s.UseShellExecute && s.FileName == "http://localhost:5180")));
    }

    [Fact]
    public void Launch_on_macOS_uses_open()
    {
        var runner = new Mock<IProcessRunner>();
        var launcher = new BrowserLauncher(runner.Object, OSPlatform.MacOS);
        launcher.Launch("http://localhost:5180");
        runner.Verify(r => r.Start(It.Is<ProcessStart>(s => s.FileName == "open" && s.Arguments != null && s.Arguments.Contains("http://localhost:5180", StringComparison.Ordinal))));
    }

    [Fact]
    public void Launch_on_Linux_uses_xdg_open()
    {
        var runner = new Mock<IProcessRunner>();
        var launcher = new BrowserLauncher(runner.Object, OSPlatform.Linux);
        launcher.Launch("http://localhost:5180");
        runner.Verify(r => r.Start(It.Is<ProcessStart>(s => s.FileName == "xdg-open")));
    }

    [Fact]
    public void Launch_swallows_errors_so_startup_does_not_fail()
    {
        var runner = new Mock<IProcessRunner>();
        runner.Setup(r => r.Start(It.IsAny<ProcessStart>())).Throws(new InvalidOperationException("boom"));
        var launcher = new BrowserLauncher(runner.Object, OSPlatform.Linux);
        Action act = () => launcher.Launch("http://localhost:5180");
        act.Should().NotThrow();
    }
}
