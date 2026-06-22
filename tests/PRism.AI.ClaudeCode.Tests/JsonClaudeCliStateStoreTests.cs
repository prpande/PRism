using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class JsonClaudeCliStateStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-clistate-" + Guid.NewGuid().ToString("N"));

    private static ClaudeCliStateRecord SampleRecord() => new(
        SchemaVersion: 1,
        Platform: OperatingSystem.IsWindows() ? "windows" : "unix",
        ExecutablePath: "/Users/x/.local/bin/claude",
        Path: "/Users/x/.local/bin:/usr/bin:/bin",
        ManagerVars: new Dictionary<string, string> { ["VOLTA_HOME"] = "/Users/x/.volta" },
        CliVersion: "2.1.177",
        DiscoveredAt: DateTimeOffset.UtcNow,
        DiscoverySource: "login-shell");

    [Fact]
    public void Save_then_Load_round_trips()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        var rec = SampleRecord();
        store.Save(rec);

        var loaded = store.Load();
        loaded.Should().NotBeNull();
        loaded!.ExecutablePath.Should().Be(rec.ExecutablePath);
        loaded.Path.Should().Be(rec.Path);
        loaded.ManagerVars.Should().ContainKey("VOLTA_HOME");
        loaded.CliVersion.Should().Be("2.1.177");
    }

    [Fact]
    public void Load_returns_null_when_no_file()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        store.Load().Should().BeNull();
    }

    [Fact]
    public void Load_returns_null_on_corrupt_json()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        File.WriteAllText(Path.Combine(_dir, "claude-cli-state.json"), "{ not json");
        store.Load().Should().BeNull();
    }

    [Fact]
    public void Load_returns_null_for_foreign_platform_record()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        var foreign = SampleRecord() with { Platform = "some-other-os" };
        store.Save(foreign);
        store.Load().Should().BeNull();
    }

    [Fact]
    public void RebuildEnv_merges_live_base_env_with_record_vars_and_re_filters()
    {
        var rec = SampleRecord();
        var env = JsonClaudeCliStateStore.RebuildEnv(rec);

        // The record's discovered PATH + manager vars are present, and the discovered PATH overrides
        // the sidecar's (minimal launchd) PATH.
        env["PATH"].Should().Be(rec.Path);
        env.Should().ContainKey("VOLTA_HOME");

        // Live base allowlist vars (HOME/LANG/… — never persisted to disk) are merged in from the
        // sidecar process so the warm-path child still has HOME to locate ~/.claude credentials
        // (#582 P1: cold path had them via the captured env, warm path previously dropped them).
        var liveBase = ClaudeCliEnvironment.BuildAllowlisted();
        foreach (var (k, v) in liveBase)
        {
            env.Should().ContainKey(k);
            if (k != "PATH") env[k].Should().Be(v);   // record PATH wins; other base vars pass through
        }

        // Security: a banned var on a tampered on-disk record is still dropped by the re-filter.
        var tampered = rec with { ManagerVars = new Dictionary<string, string> { ["ANTHROPIC_API_KEY"] = "sk-leak" } };
        JsonClaudeCliStateStore.RebuildEnv(tampered).Should().NotContainKey("ANTHROPIC_API_KEY");
    }

    [Fact]
    public void Delete_removes_the_record_and_is_idempotent()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        store.Save(SampleRecord());
        store.Load().Should().NotBeNull();

        store.Delete();
        store.Load().Should().BeNull();
        store.Invoking(s => s.Delete()).Should().NotThrow();   // idempotent on a missing file
    }

    [SkippableFact]
    public void State_file_and_dir_are_owner_only_on_posix()
    {
        Skip.If(OperatingSystem.IsWindows(), "POSIX-only file-mode assertion.");
        var store = new JsonClaudeCliStateStore(_dir);
        store.Save(SampleRecord());

#pragma warning disable CA1416 // Guarded by Skip.If(IsWindows).
        var dirMode = File.GetUnixFileMode(_dir);
        var fileMode = File.GetUnixFileMode(Path.Combine(_dir, "claude-cli-state.json"));
#pragma warning restore CA1416
        var groupOrOther = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute
                         | UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
        (dirMode & groupOrOther).Should().Be(UnixFileMode.None);
        (fileMode & groupOrOther).Should().Be(UnixFileMode.None);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }
}
