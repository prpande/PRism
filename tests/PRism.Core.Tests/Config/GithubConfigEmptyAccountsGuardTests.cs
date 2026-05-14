using FluentAssertions;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public class GithubConfigEmptyAccountsGuardTests
{
    // claude[bot] post-open review on PR #53: the delegate properties Host /
    // LocalWorkspace previously returned `Accounts[0].Host` / `Accounts[0].LocalWorkspace`
    // with no bounds check. Production load paths backfill the default account, so the
    // delegate access is safe at runtime — but `new GithubConfig([])` in test or future
    // v2 code would propagate IndexOutOfRangeException. Replaced with an explicit
    // InvalidOperationException carrying a clear message; these tests pin the contract.

    [Fact]
    public void Host_throws_InvalidOperationException_when_Accounts_is_empty()
    {
        var cfg = new GithubConfig(System.Array.Empty<GithubAccountConfig>());
        var act = () => cfg.Host;
        act.Should().Throw<System.InvalidOperationException>()
            .WithMessage("*GithubConfig has no accounts*");
    }

    [Fact]
    public void LocalWorkspace_throws_InvalidOperationException_when_Accounts_is_empty()
    {
        var cfg = new GithubConfig(System.Array.Empty<GithubAccountConfig>());
        var act = () => cfg.LocalWorkspace;
        act.Should().Throw<System.InvalidOperationException>()
            .WithMessage("*GithubConfig has no accounts*");
    }
}
