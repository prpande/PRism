using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.Config;

public class GithubConfigDelegatesTests
{
    [Fact]
    public void Host_delegates_to_accounts_first_entry()
    {
        var cfg = new GithubConfig(new[]
        {
            new GithubAccountConfig(
                Id: AccountKeys.Default,
                Host: "https://github.acme.local",
                Login: "alice",
                LocalWorkspace: "/work")
        });

        cfg.Host.Should().Be("https://github.acme.local");
    }

    [Fact]
    public void LocalWorkspace_delegates_to_accounts_first_entry()
    {
        var cfg = new GithubConfig(new[]
        {
            new GithubAccountConfig(
                Id: AccountKeys.Default,
                Host: "https://github.com",
                Login: null,
                LocalWorkspace: "/Users/alice/code")
        });

        cfg.LocalWorkspace.Should().Be("/Users/alice/code");
    }

    [Fact]
    public void LocalWorkspace_is_null_when_account_local_workspace_is_null()
    {
        var cfg = new GithubConfig(new[]
        {
            new GithubAccountConfig(
                Id: AccountKeys.Default,
                Host: "https://github.com",
                Login: null,
                LocalWorkspace: null)
        });

        cfg.LocalWorkspace.Should().BeNull();
    }

    [Fact]
    public void AppConfig_Default_constructs_a_single_default_account_with_github_dot_com_and_null_login_and_null_workspace()
    {
        var def = AppConfig.Default;

        def.Github.Accounts.Should().HaveCount(1);
        def.Github.Accounts[0].Id.Should().Be(AccountKeys.Default);
        def.Github.Accounts[0].Host.Should().Be("https://github.com");
        def.Github.Accounts[0].Login.Should().BeNull();
        def.Github.Accounts[0].LocalWorkspace.Should().BeNull();
        // Delegate properties preserve the existing AppConfig.Github.Host/LocalWorkspace API.
        def.Github.Host.Should().Be("https://github.com");
        def.Github.LocalWorkspace.Should().BeNull();
    }
}
