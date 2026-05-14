using PRism.Core.Auth;

namespace PRism.Core.Tests.TestHelpers;

// Minimal ITokenStore fake for hydrator/auth-flow tests. The hydrator only reads
// HasTokenAsync; the other surface area is stubbed to throw if unexpectedly invoked
// so a test mistake doesn't silently succeed.
internal sealed class FakeTokenStore : ITokenStore
{
    private readonly bool _hasToken;

    public FakeTokenStore(bool hasToken)
    {
        _hasToken = hasToken;
    }

    public Task<bool> HasTokenAsync(CancellationToken ct) => Task.FromResult(_hasToken);
    public Task<string?> ReadAsync(CancellationToken ct) => Task.FromResult<string?>(_hasToken ? "ghp_fake" : null);
    public Task WriteTransientAsync(string token, CancellationToken ct) => Task.CompletedTask;
    public Task SetTransientLoginAsync(string login, CancellationToken ct) => Task.CompletedTask;
    public Task<string?> ReadTransientLoginAsync(CancellationToken ct) => Task.FromResult<string?>(null);
    public Task CommitAsync(CancellationToken ct) => Task.CompletedTask;
    public Task RollbackTransientAsync(CancellationToken ct) => Task.CompletedTask;
    public Task ClearAsync(CancellationToken ct) => Task.CompletedTask;
}
