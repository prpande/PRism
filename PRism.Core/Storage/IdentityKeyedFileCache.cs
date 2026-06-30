using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Json;

namespace PRism.Core.Storage;

/// <summary>Owner-identity key for a persisted cache file: the token-owner login + GitHub host.</summary>
public readonly record struct CacheIdentity(string Login, string Host);

/// <summary>
/// Injection seam for <see cref="IdentityKeyedFileCache{T}"/> so consumers can be unit-tested with a
/// recording/stub double (the concrete class does real file I/O and is tested directly).
/// </summary>
public interface IIdentityKeyedFileCache<T> where T : class
{
    Task SaveAsync(T payload, CacheIdentity identity, CancellationToken ct);
    T? TryLoad(CacheIdentity identity);
    Task EvictAsync(CancellationToken ct);
}

/// <summary>
/// A single-file, identity-stamped, schema-versioned cache. Disposable by design: any read failure
/// (missing / parse error / version mismatch / identity mismatch / structurally-invalid) returns a
/// miss — the caller treats it exactly like a first run. Never migrates; the next write overwrites.
/// Writes are atomic (temp-file + AtomicFileMove) and best-effort (never throw to the caller).
/// </summary>
public sealed partial class IdentityKeyedFileCache<T> : IIdentityKeyedFileCache<T> where T : class
{
    private readonly string _path;
    private readonly int _schemaVersion;
    private readonly Func<T, bool> _isStructurallyValid;
    private readonly ILogger _log;

    public IdentityKeyedFileCache(string path, int schemaVersion,
        Func<T, bool>? isStructurallyValid = null, ILogger? log = null)
    {
        _path = path;
        _schemaVersion = schemaVersion;
        _isStructurallyValid = isStructurallyValid ?? (static _ => true);
        _log = log ?? NullLogger.Instance;
    }

    // Kebab-cased on disk via JsonSerializerOptionsFactory.Storage → {version, owner-login, owner-host, payload}.
    private sealed record Envelope(int Version, string OwnerLogin, string OwnerHost, T Payload);

    public async Task SaveAsync(T payload, CacheIdentity identity, CancellationToken ct)
    {
        try
        {
            var envelope = new Envelope(_schemaVersion, identity.Login, identity.Host, payload);
            var json = JsonSerializer.Serialize(envelope, JsonSerializerOptionsFactory.Storage);
            var temp = $"{_path}.tmp-{Guid.NewGuid():N}";
            await File.WriteAllTextAsync(temp, json, ct).ConfigureAwait(false);
            await AtomicFileMove.MoveAsync(temp, _path, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) { throw; }
#pragma warning disable CA1031 // a cache write must never break a refresh; log + swallow
        catch (Exception ex)
        {
            Log.SaveFailed(_log, ex, _path);
        }
#pragma warning restore CA1031
    }

    public T? TryLoad(CacheIdentity identity)
    {
        try
        {
            if (!File.Exists(_path)) return null;

            string raw;
            using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new StreamReader(fs))
                raw = reader.ReadToEnd();

            var envelope = JsonSerializer.Deserialize<Envelope>(raw, JsonSerializerOptionsFactory.Storage);
            if (envelope is null) return null;
            if (envelope.Version != _schemaVersion) return null;
            if (!string.Equals(envelope.OwnerLogin, identity.Login, StringComparison.OrdinalIgnoreCase)) return null;
            if (!string.Equals(envelope.OwnerHost, identity.Host, StringComparison.OrdinalIgnoreCase)) return null;
            if (envelope.Payload is null) return null;
            if (!_isStructurallyValid(envelope.Payload)) return null;
            return envelope.Payload;
        }
#pragma warning disable CA1031 // disposable cache: any read failure is a miss, never a crash
        catch (Exception ex)
        {
            Log.LoadFailed(_log, ex, _path);
            return null;
        }
#pragma warning restore CA1031
    }

    public Task EvictAsync(CancellationToken ct)
    {
        try
        {
            if (File.Exists(_path)) File.Delete(_path);
        }
#pragma warning disable CA1031 // best-effort delete; a lingering file is rejected by the identity gate
        catch (Exception ex)
        {
            Log.EvictFailed(_log, ex, _path);
        }
#pragma warning restore CA1031
        return Task.CompletedTask;
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug, Message = "IdentityKeyedFileCache save failed for {Path}")]
        internal static partial void SaveFailed(ILogger logger, Exception ex, string path);

        [LoggerMessage(Level = LogLevel.Debug, Message = "IdentityKeyedFileCache load failed for {Path}")]
        internal static partial void LoadFailed(ILogger logger, Exception ex, string path);

        [LoggerMessage(Level = LogLevel.Debug, Message = "IdentityKeyedFileCache evict failed for {Path}")]
        internal static partial void EvictFailed(ILogger logger, Exception ex, string path);
    }
}
