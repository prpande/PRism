using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCodeStreamingProviderTests
{
    private static (ClaudeCodeStreamingProvider, FakeStreamingCliProcessFactory) Build(string baseDir)
    {
        var proc = new FakeStreamingCliProcess();
        var factory = new FakeStreamingCliProcessFactory(proc);
        var options = new ClaudeCodeProviderOptions { WorkingDirectory = baseDir };
        return (new ClaudeCodeStreamingProvider(factory, options), factory);
    }

    [Fact]
    public void Spawns_with_required_streaming_flags_and_verbose()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, factory) = Build(baseDir);
        provider.StartSession(new StreamingSessionOptions(Model: "m"));

        var args = factory.CapturedSpec!.Arguments;
        args.Should().ContainInOrder("--output-format", "stream-json");
        args.Should().Contain("--verbose");
        args.Should().Contain("--input-format").And.Contain("stream-json");
        args.Should().NotContain("--bare");
        args.Should().ContainInOrder("--model", "m");
    }

    [Fact]
    public void Deny_list_is_unconditional_even_when_caller_allows_bash()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, factory) = Build(baseDir);
        provider.StartSession(new StreamingSessionOptions(AllowedTools: new[] { "Bash", "Read" }));

        var args = factory.CapturedSpec!.Arguments;
        var disallowed = ArgValue(args, "--disallowedTools");
        disallowed.Should().Contain("Bash").And.Contain("PowerShell");   // both shell-exec tools denied
        ArgValue(args, "--allowedTools").Should().NotContain("Bash");     // never in allow
    }

    [Theory]
    [InlineData("Read,Bash")]   // embedded comma would split the list and smuggle Bash past the deny-set
    [InlineData("--dangerously-skip-permissions")]   // leading -- would be misread as a flag
    [InlineData("Read Glob")]   // whitespace splits the token
    public void Tool_name_with_comma_dashes_or_whitespace_is_rejected(string evil)
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, _) = Build(baseDir);
        var act = () => provider.StartSession(new StreamingSessionOptions(AllowedTools: new[] { evil }));
        act.Should().Throw<ArgumentException>();   // cannot smuggle a denied tool via list-injection
    }

    [Fact]
    public void Env_is_the_shared_allowlist()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, factory) = Build(baseDir);
        provider.StartSession(new StreamingSessionOptions());

        factory.CapturedSpec!.Environment.Keys.Should()
            .BeEquivalentTo(ClaudeCliEnvironment.BuildAllowlisted().Keys);
    }

    [Fact]
    public void Env_allowlist_definition_has_no_credential_pattern_keys()
    {
        // Assert on the STATIC allowlist (the filter DEFINITION), not the filtered output — asserting on
        // the output is vacuous (it can never contain a key the filter doesn't list). This catches a
        // future edit that adds a credential-bearing var to ClaudeCliEnvironment.Allowlist. (Needs the
        // Task-0 InternalsVisibleTo.)
        // Match at word boundaries (start of string or after '_') to avoid false positives like PATH ⊃ PAT.
        var bad = new[] { "TOKEN", "SECRET", "PAT", "PASSWORD", "CREDENTIAL", "KEY", "ANTHROPIC" };
        ClaudeCliEnvironment.Allowlist
            .Where(k =>
            {
                var upper = k.ToUpperInvariant();
                return bad.Any(b =>
                    upper == b ||
                    upper.StartsWith(b + "_", StringComparison.Ordinal) ||
                    upper.EndsWith("_" + b, StringComparison.Ordinal) ||
                    upper.Contains("_" + b + "_", StringComparison.Ordinal));
            })
            .Should().BeEmpty();
    }

    [Fact]
    public void Existing_working_directory_outside_base_is_rejected()
    {
        var root = Directory.CreateTempSubdirectory().FullName;
        var baseDir = Directory.CreateDirectory(Path.Combine(root, "base")).FullName;
        var outside = Directory.CreateDirectory(Path.Combine(root, "outside")).FullName;
        var (provider, _) = Build(baseDir);

        var act = () => provider.StartSession(new StreamingSessionOptions(WorkingDirectory: outside));
        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Nonexistent_working_directory_is_rejected()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, _) = Build(baseDir);
        var act = () => provider.StartSession(new StreamingSessionOptions(
            WorkingDirectory: Path.Combine(baseDir, "does-not-exist")));
        act.Should().Throw<ArgumentException>();   // rejected outright, not lexically normalized
    }

    [SkippableFact]   // creating a symlink needs privilege on Windows; skip there if it throws
    public void Symlink_resolving_outside_base_is_rejected_not_lexically_passed(/* spec §7 */)
    {
        var root = Directory.CreateTempSubdirectory().FullName;
        var baseDir = Directory.CreateDirectory(Path.Combine(root, "base")).FullName;
        var outside = Directory.CreateDirectory(Path.Combine(root, "outside")).FullName;
        var linkPath = Path.Combine(baseDir, "link");   // lives UNDER base, but points OUTSIDE
        try { Directory.CreateSymbolicLink(linkPath, outside); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        { Skip.If(true, "symlink creation unavailable in this environment"); }

        var (provider, _) = Build(baseDir);
        // A LEXICAL prefix check would pass `<base>/link` (it textually starts with base); the real-path
        // resolution must follow the link to `outside` and REJECT it.
        var act = () => provider.StartSession(new StreamingSessionOptions(WorkingDirectory: linkPath));
        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Subdirectory_under_base_is_allowed()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var sub = Directory.CreateDirectory(Path.Combine(baseDir, "sub")).FullName;
        var (provider, factory) = Build(baseDir);
        provider.StartSession(new StreamingSessionOptions(WorkingDirectory: sub));
        factory.CapturedSpec!.WorkingDirectory.Should().StartWith(Path.GetFullPath(baseDir));
    }

    [Fact]
    public void Null_working_directory_uses_the_canonical_base()
    {
        var baseDir = Directory.CreateTempSubdirectory().FullName;
        var (provider, factory) = Build(baseDir);
        provider.StartSession(new StreamingSessionOptions());
        var viaNull = factory.CapturedSpec!.WorkingDirectory;
        // Self-consistent (avoids hardcoding GetFullPath, which differs from the symlink-resolved form on
        // macOS): passing the base explicitly resolves to the same canonical path the null case used.
        provider.StartSession(new StreamingSessionOptions(WorkingDirectory: baseDir));
        factory.CapturedSpec!.WorkingDirectory.Should().Be(viaNull);
        Directory.Exists(viaNull).Should().BeTrue();
    }

    private static string ArgValue(IReadOnlyList<string> args, string flag)
    {
        var i = args.ToList().IndexOf(flag);
        return i >= 0 && i + 1 < args.Count ? args[i + 1] : "";
    }
}
