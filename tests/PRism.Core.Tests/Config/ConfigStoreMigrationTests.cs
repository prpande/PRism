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
}
