using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCliLocatorTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-locator-" + Guid.NewGuid().ToString("N"));

    private ClaudeCliLocator Build(
        LoginShellCapture? capture = null,
        ProcessResult? versionResult = null,
        bool identity = true,
        Func<string, bool>? pathExists = null,
        FakeLoginShellEnvironmentReader? reader = null)
    {
        reader ??= new FakeLoginShellEnvironmentReader(capture);
        var runner = new FakeCliProcessRunner(versionResult ?? new ProcessResult(0, "2.1.177", "", false));
        return new ClaudeCliLocator(
            reader,
            new JsonClaudeCliStateStore(_dir),
            runner,
            new ClaudeCodeProviderOptions { WorkingDirectory = _dir },
            identityMatches: () => identity,
            clock: TimeProvider.System,
            pathExists: pathExists ?? (_ => true));
    }

    [Fact]
    public async Task Identity_mismatch_returns_NotFound_without_discovery()
    {
        var reader = new FakeLoginShellEnvironmentReader(null);
        var locator = Build(identity: false, reader: reader);

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<NotFound>().Which.ReasonCode.Should().Be(ClaudeReasonCodes.IdentityMismatch);
        reader.CallCount.Should().Be(0);
    }

    [SkippableFact]
    public async Task Windows_returns_inherited_invocation_without_discovery()
    {
        Skip.IfNot(OperatingSystem.IsWindows(), "Windows-only no-op path.");
        var reader = new FakeLoginShellEnvironmentReader(null);
        var locator = Build(reader: reader);

        var res = await locator.ResolveAsync(CancellationToken.None);

        var resolved = res.Should().BeOfType<ResolvedCli>().Subject;
        resolved.ExecutablePath.Should().Be("claude");
        resolved.Environment.Should().ContainKey("PATH");
        reader.CallCount.Should().Be(0);
    }

    [Fact]
    public async Task CurrentResolved_is_null_before_first_resolve()
    {
        var locator = Build();
        locator.CurrentResolved.Should().BeNull();
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }
}
