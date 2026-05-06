namespace PRism.Core.Auth;

public interface ITokenStore
{
    Task<bool> HasTokenAsync(CancellationToken ct);
    Task<string?> ReadAsync(CancellationToken ct);
    Task WriteTransientAsync(string token, CancellationToken ct);
    Task SetTransientLoginAsync(string login, CancellationToken ct);
    Task<string?> ReadTransientLoginAsync(CancellationToken ct);
    Task CommitAsync(CancellationToken ct);
    Task RollbackTransientAsync(CancellationToken ct);
    Task ClearAsync(CancellationToken ct);
}
