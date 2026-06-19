using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class SystemCliProcessRunnerTests
{
    [Fact]
    public async Task Captures_stdout_and_exit_code_from_a_real_process()
    {
        var runner = new SystemCliProcessRunner();
        var spec = new ProcessSpec(
            FileName: OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh",
            Arguments: OperatingSystem.IsWindows()
                ? new[] { "/c", "echo hello" }
                : new[] { "-c", "echo hello" },
            Environment: new Dictionary<string, string> { ["PATH"] = Environment.GetEnvironmentVariable("PATH") ?? "" },
            WorkingDirectory: Path.GetTempPath(),
            StdinText: null,
            Timeout: TimeSpan.FromSeconds(10));

        var result = await runner.RunAsync(spec, CancellationToken.None);

        result.ExitCode.Should().Be(0);
        result.Stdout.Trim().Should().Be("hello");
        result.TimedOut.Should().BeFalse();
    }

    [Fact]
    public async Task Does_not_inherit_parent_environment_outside_the_allowlist()
    {
        Environment.SetEnvironmentVariable("PRISM_TEST_SECRET", "leak");
        try
        {
            var runner = new SystemCliProcessRunner();
            // Allowlist deliberately omits PRISM_TEST_SECRET. SystemRoot/PATH are included only so
            // cmd.exe can launch on Windows; the assertion proves the parent secret does NOT leak.
            var env = new Dictionary<string, string>();
            if (OperatingSystem.IsWindows())
            {
                env["SystemRoot"] = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
                env["PATH"] = Environment.GetEnvironmentVariable("PATH") ?? "";
            }
            var spec = new ProcessSpec(
                FileName: OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh",
                Arguments: OperatingSystem.IsWindows()
                    ? new[] { "/c", "echo %PRISM_TEST_SECRET%" }
                    : new[] { "-c", "echo $PRISM_TEST_SECRET" },
                Environment: env,
                WorkingDirectory: Path.GetTempPath(),
                StdinText: null,
                Timeout: TimeSpan.FromSeconds(10));

            var result = await runner.RunAsync(spec, CancellationToken.None);
            // cmd echoes the literal token when the var is unset; sh echoes empty. Either way, NOT "leak".
            result.Stdout.Should().NotContain("leak");
        }
        finally { Environment.SetEnvironmentVariable("PRISM_TEST_SECRET", null); }
    }

    [Fact]
    public async Task Feeds_stdin_to_the_child_process()
    {
        var runner = new SystemCliProcessRunner();
        // A stdin-consuming command: Windows `sort` / POSIX `cat` read stdin and write it back.
        // A single line round-trips unchanged — proving StdinText actually reaches the child.
        var spec = new ProcessSpec(
            FileName: OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh",
            Arguments: OperatingSystem.IsWindows()
                ? new[] { "/c", "sort" }
                : new[] { "-c", "cat" },
            Environment: OperatingSystem.IsWindows()
                ? new Dictionary<string, string>
                  {
                      ["SystemRoot"] = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows",
                      ["PATH"] = Environment.GetEnvironmentVariable("PATH") ?? "",
                  }
                : new Dictionary<string, string> { ["PATH"] = Environment.GetEnvironmentVariable("PATH") ?? "" },
            WorkingDirectory: Path.GetTempPath(),
            StdinText: "round-trip-token",
            Timeout: TimeSpan.FromSeconds(10));

        var result = await runner.RunAsync(spec, CancellationToken.None);

        result.ExitCode.Should().Be(0);
        result.Stdout.Should().Contain("round-trip-token");
    }

    [Fact]
    public async Task Caller_cancellation_throws_OperationCanceledException()
    {
        var runner = new SystemCliProcessRunner();
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var spec = new ProcessSpec(
            FileName: OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh",
            Arguments: OperatingSystem.IsWindows() ? new[] { "/c", "echo hi" } : new[] { "-c", "echo hi" },
            Environment: new Dictionary<string, string> { ["PATH"] = Environment.GetEnvironmentVariable("PATH") ?? "" },
            WorkingDirectory: Path.GetTempPath(),
            StdinText: null,
            Timeout: TimeSpan.FromSeconds(10));

        var act = async () => await runner.RunAsync(spec, cts.Token);
        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task Streaming_process_streams_stdout_lines_and_exits()
    {
        var factory = new SystemStreamingCliProcessFactory();
        var spec = new StreamingProcessSpec(
            FileName: OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh",
            Arguments: OperatingSystem.IsWindows()
                ? new[] { "/c", "echo line1& echo line2" }
                : new[] { "-c", "printf 'line1\\nline2\\n'" },
            Environment: new Dictionary<string, string> { ["PATH"] = Environment.GetEnvironmentVariable("PATH") ?? "" },
            WorkingDirectory: Path.GetTempPath());

        await using var proc = factory.Start(spec);
        var lines = new List<string>();
        await foreach (var l in proc.StdoutLines) lines.Add(l.Trim());
        var exit = await proc.WaitForExitAsync(TimeSpan.FromSeconds(10), CancellationToken.None);

        lines.Should().Contain("line1").And.Contain("line2");
        exit.Should().Be(0);
    }
}
