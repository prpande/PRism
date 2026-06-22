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
        using var locator = Build(identity: false, reader: reader);

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<NotFound>().Which.ReasonCode.Should().Be(ClaudeReasonCodes.IdentityMismatch);
        reader.CallCount.Should().Be(0);
    }

    [SkippableFact]
    public async Task Windows_returns_inherited_invocation_without_discovery()
    {
        Skip.IfNot(OperatingSystem.IsWindows(), "Windows-only no-op path.");
        var reader = new FakeLoginShellEnvironmentReader(null);
        using var locator = Build(reader: reader);

        var res = await locator.ResolveAsync(CancellationToken.None);

        var resolved = res.Should().BeOfType<ResolvedCli>().Subject;
        resolved.ExecutablePath.Should().Be("claude");
        resolved.Environment.Should().ContainKey("PATH");
        reader.CallCount.Should().Be(0);
    }

    [Fact]
    public async Task CurrentResolved_is_null_before_first_resolve()
    {
        using var locator = Build();
        locator.CurrentResolved.Should().BeNull();
    }

    [SkippableFact]
    public async Task Cold_discovery_native_topology_resolves_and_persists()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var capture = new LoginShellCapture(
            new Dictionary<string, string> { ["PATH"] = "/Users/x/.local/bin:/usr/bin", ["HOME"] = "/Users/x" },
            CommandVClaude: "/Users/x/.local/bin/claude");
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture),
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/Users/x/.local/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        var ok = res.Should().BeOfType<ResolvedCli>().Subject;
        ok.ExecutablePath.Should().Be("/Users/x/.local/bin/claude");
        ok.Environment["PATH"].Should().Be("/Users/x/.local/bin:/usr/bin");

        // Persisted positive record is reloadable.
        new JsonClaudeCliStateStore(_dir).Load().Should().NotBeNull();
    }

    [SkippableFact]
    public async Task Cold_discovery_npm_topology_keeps_manager_vars()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var capture = new LoginShellCapture(
            new Dictionary<string, string>
            {
                ["PATH"] = "/Users/x/.volta/bin:/usr/bin",
                ["VOLTA_HOME"] = "/Users/x/.volta",
            },
            CommandVClaude: "/Users/x/.volta/bin/claude");
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture),
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/Users/x/.volta/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<ResolvedCli>()
            .Which.Environment.Should().ContainKey("VOLTA_HOME");
    }

    [SkippableFact]
    public async Task Non_path_command_v_falls_through_to_ladder()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        // command -v resolves to a shell function/alias name, not a path → no candidate from capture.
        var capture = new LoginShellCapture(
            new Dictionary<string, string> { ["PATH"] = "/usr/bin" },
            CommandVClaude: "claude: aliased to claude --foo");
        // The ladder finds /opt/homebrew/bin/claude on disk and it validates.
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture),
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/opt/homebrew/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        var ok = res.Should().BeOfType<ResolvedCli>().Subject;
        ok.ExecutablePath.Should().Be("/opt/homebrew/bin/claude");
        // Spec §4.5: a ladder candidate runs under the MINIMAL base allowlist (native topology, no
        // node), NOT the captured login-shell env — assert no manager var rode along.
        ok.Environment.Keys.Should().OnlyContain(k => ClaudeCliEnvironment.Allowlist.Contains(k));
    }

    [SkippableFact]
    public async Task Capture_failure_falls_back_to_ladder()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture: null),
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/usr/local/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<ResolvedCli>().Which.ExecutablePath.Should().Be("/usr/local/bin/claude");
    }

    [SkippableFact]
    public async Task Nothing_found_returns_CliDiscoveryFailed()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture: null),
            pathExists: _ => false);

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<NotFound>().Which.ReasonCode.Should().Be(ClaudeReasonCodes.CliDiscoveryFailed);
    }

    [SkippableFact]
    public async Task Candidate_that_fails_version_exec_is_rejected()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        // Capture points at a claude whose `node` is gone → --version exits non-zero. No ladder hit either.
        var capture = new LoginShellCapture(
            new Dictionary<string, string> { ["PATH"] = "/Users/x/.volta/bin" },
            CommandVClaude: "/Users/x/.volta/bin/claude");
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture),
            versionResult: new ProcessResult(127, "", "env: node: No such file or directory", false),
            pathExists: p => p == "/Users/x/.volta/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<NotFound>().Which.ReasonCode.Should().Be(ClaudeReasonCodes.CliDiscoveryFailed);
    }

    [SkippableFact]
    public async Task Single_flight_runs_discovery_once_under_concurrent_callers()
    {
        Skip.If(OperatingSystem.IsWindows(), "Exercises the Unix discovery path.");
        var capture = new LoginShellCapture(
            new Dictionary<string, string> { ["PATH"] = "/opt/homebrew/bin" },
            CommandVClaude: "/opt/homebrew/bin/claude");
        var reader = new FakeLoginShellEnvironmentReader(capture);
        var locator = Build(reader: reader,
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/opt/homebrew/bin/claude");

        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => locator.ResolveAsync(CancellationToken.None)));

        reader.CallCount.Should().Be(1);   // the gate dedups concurrent callers to one capture
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }
}
