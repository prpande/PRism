using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.State;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStoreMigrationTests
{
    [Fact]
    public async Task InitAsync_rewrites_legacy_github_host_to_accounts_array_with_local_workspace_moved_under_account()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "github": { "host": "https://github.acme.local", "local-workspace": "/Users/alice/code" }
        }
        """);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Github.Accounts.Should().HaveCount(1);
        var account = store.Current.Github.Accounts[0];
        account.Id.Should().Be(AccountKeys.Default);
        account.Host.Should().Be("https://github.acme.local");
        account.Login.Should().BeNull();
        account.LocalWorkspace.Should().Be("/Users/alice/code");

        // Delegate properties preserve the existing API surface.
        store.Current.Github.Host.Should().Be("https://github.acme.local");
        store.Current.Github.LocalWorkspace.Should().Be("/Users/alice/code");
    }

    [Fact]
    public async Task InitAsync_is_idempotent_for_already_accounts_shaped_config()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "github": {
            "accounts": [
              { "id": "default", "host": "https://github.com", "login": "alice", "local-workspace": null }
            ]
          }
        }
        """);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Github.Accounts.Should().HaveCount(1);
        store.Current.Github.Accounts[0].Login.Should().Be("alice");
    }

    [Fact]
    public async Task InitAsync_writes_seeded_default_account_on_first_launch_when_no_config_file_exists()
    {
        using var dir = new TempDataDir();
        // No config.json on disk.

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Github.Accounts.Should().HaveCount(1);
        var account = store.Current.Github.Accounts[0];
        account.Id.Should().Be(AccountKeys.Default);
        account.Host.Should().Be("https://github.com");
        account.Login.Should().BeNull();
        account.LocalWorkspace.Should().BeNull();

        // The seeded config is written to disk so the next launch reads the new shape.
        var raw = await File.ReadAllTextAsync(Path.Combine(dir.Path, "config.json"));
        raw.Should().Contain("\"accounts\"");
    }

    [Fact]
    public async Task InitAsync_handles_legacy_github_with_null_local_workspace()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "github": { "host": "https://github.com", "local-workspace": null } }
        """);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Github.Accounts.Should().HaveCount(1);
        store.Current.Github.Accounts[0].LocalWorkspace.Should().BeNull();
    }

    [Fact]
    public async Task InitAsync_does_not_crash_when_legacy_github_host_is_non_string_type()
    {
        // Caught by Copilot post-open code review on PR #53. The legacy-shape rewrite
        // originally called `hostNode.GetValue<string>()` directly, which throws
        // InvalidOperationException on a hand-edited `"host": 42`. ReadFromDiskAsync's
        // catch clause covers JsonException / IOException / UnauthorizedAccessException
        // but NOT InvalidOperationException — the exception would escape InitAsync and
        // crash startup. Pre-S6 deserialization raised JsonException for the same
        // mistyped values and was caught into LastLoadError; this test pins the
        // startup-doesn't-crash invariant the migration shim must preserve.
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "github": { "host": 42, "local-workspace": null } }
        """);

        using var store = new ConfigStore(dir.Path);
        var act = async () => await store.InitAsync(CancellationToken.None);
        await act.Should().NotThrowAsync();

        // Falls back to AppConfig.Default (the malformed shape was quarantined-equivalent
        // — JsonException from the strongly-typed Deserialize was caught into
        // LastLoadError, _current stays at AppConfig.Default).
        store.LastLoadError.Should().NotBeNull();
        store.Current.Github.Accounts.Should().HaveCount(1);
        store.Current.Github.Accounts[0].Host.Should().Be("https://github.com");
    }

    [Fact]
    public async Task InitAsync_does_not_crash_when_legacy_local_workspace_is_array_type()
    {
        // Companion to the above — same defect, separate field. Confirms TryGetValue
        // covers both code paths.
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "github": { "host": "https://github.com", "local-workspace": [] } }
        """);

        using var store = new ConfigStore(dir.Path);
        var act = async () => await store.InitAsync(CancellationToken.None);
        await act.Should().NotThrowAsync();

        store.LastLoadError.Should().NotBeNull();
        store.Current.Github.Accounts.Should().HaveCount(1);
        store.Current.Github.Accounts[0].Host.Should().Be("https://github.com");
    }

    [Fact]
    public async Task SetDefaultAccountLoginAsync_concurrent_with_PatchAsync_preserves_both_writes()
    {
        // ce-doc-review adversarial F3: SetDefaultAccountLoginAsync triggers ConfigStore's
        // FileSystemWatcher → HandleFileChangedAsync feedback loop, which re-reads the file
        // under the same _gate and raises Changed a second time. If a concurrent PatchAsync
        // (theme=dark) hits between the write and the watcher re-read, both writes must
        // survive — the test pins this contract so a future "let's suppress the watcher event
        // after our own write" optimization doesn't accidentally drop a concurrent change.
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "ui": { "theme": "light", "accent": "indigo", "ai-preview": false },
          "github": {
            "accounts": [ { "id": "default", "host": "https://github.com", "login": null, "local-workspace": null } ]
          }
        }
        """);
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        // Drive both writes nearly concurrently. The store's _gate serializes them so the
        // result is deterministic regardless of ordering — but the FSW re-read fires for each
        // and could overwrite the in-memory _current with the latest on-disk shape. Drain
        // pending FSW events before asserting (the debounce delay is 100ms in HandleFileChangedAsync).
        var loginWrite = store.SetDefaultAccountLoginAsync("alice", CancellationToken.None);
        var themeWrite = store.PatchAsync(new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);
        await Task.WhenAll(loginWrite, themeWrite);
        // Drain debounced FSW events. HandleFileChangedAsync's debounce is 100ms; with two
        // disk writes plus OS notification delivery the tail can run ~150-300ms on a healthy
        // machine. 500ms gives clear headroom for slow CI runners without converting this
        // into a poll loop (preflight adversarial review flagged 250ms as tight; 500ms is
        // 5× the documented debounce window — adequate margin without test churn).
        await Task.Delay(500);

        store.Current.Ui.Theme.Should().Be("dark");
        store.Current.Github.Accounts[0].Login.Should().Be("alice");
    }
}
