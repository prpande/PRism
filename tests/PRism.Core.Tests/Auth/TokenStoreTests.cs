using PRism.Core.Auth;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Auth;

public class TokenStoreTests
{
    [Fact]
    public async Task HasToken_returns_false_when_nothing_stored()
    {
        using var dir = new TempDataDir();
        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        (await store.HasTokenAsync(CancellationToken.None)).Should().BeFalse();
    }

    [Fact]
    public async Task WriteTransient_then_Commit_persists_and_HasToken_is_true()
    {
        using var dir = new TempDataDir();
        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        await store.WriteTransientAsync("ghp_test", CancellationToken.None);
        await store.CommitAsync(CancellationToken.None);

        (await store.HasTokenAsync(CancellationToken.None)).Should().BeTrue();
        (await store.ReadAsync(CancellationToken.None)).Should().Be("ghp_test");
    }

    [Fact]
    public async Task WriteTransient_then_Rollback_leaves_HasToken_false()
    {
        using var dir = new TempDataDir();
        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        await store.WriteTransientAsync("ghp_test", CancellationToken.None);
        await store.RollbackTransientAsync(CancellationToken.None);

        (await store.HasTokenAsync(CancellationToken.None)).Should().BeFalse();
    }

    [Fact]
    public async Task ClearAsync_removes_committed_token()
    {
        using var dir = new TempDataDir();
        var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        await store.WriteTransientAsync("ghp_test", CancellationToken.None);
        await store.CommitAsync(CancellationToken.None);
        await store.ClearAsync(CancellationToken.None);

        (await store.HasTokenAsync(CancellationToken.None)).Should().BeFalse();
    }
}
