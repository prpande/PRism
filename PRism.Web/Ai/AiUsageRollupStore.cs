using System.Text.Json;
using PRism.AI.Contracts.Observability;
using PRism.Core.Storage;

namespace PRism.Web.Ai;

/// <summary>In-memory rollup of AI usage, grain = (UTC-hour, Component, PrRef), persisted atomically
/// to <c>usage-rollup.json</c> alongside the byte offset into <c>ai-interactions.log</c> that the
/// buckets reflect. The authoritative read source for the usage endpoint — the aggregator reads
/// <see cref="SnapshotBuckets"/>, never the log. Single logical writer (the tailer timer); a lock
/// guards every mutation + snapshot so the request thread can read concurrently. Counts are by
/// <c>Outcome</c> (NOT <c>Egressed</c>): ProviderCalls = Ok+ProviderError, CacheHits = CacheHit,
/// Fallback folded but neither a provider call nor cost-bearing (§4.1).</summary>
internal sealed class AiUsageRollupStore
{
    internal sealed record UsageBucket(
        long HourEpoch, string Component, string PrRef,
        long InputTokens, long OutputTokens, long CacheReadInputTokens, long CacheCreationInputTokens,
        decimal EstimatedCostUsd, int ProviderCalls, int CacheHits);

    private sealed record Snapshot(long TailOffset, long SourceLength, IReadOnlyList<UsageBucket> Buckets);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _dir;
    private readonly string _path;
    private readonly TimeProvider _clock; // reserved for future time-based pruning; keeps ctor parity with the tailer
    private readonly object _gate = new();
    private readonly Dictionary<(long, string, string), UsageBucket> _buckets = new();
    private long _tailOffset;
    private long _sourceLength;
    private bool _dirty;

    public AiUsageRollupStore(string usageDir, TimeProvider clock)
    {
        ArgumentException.ThrowIfNullOrEmpty(usageDir);
        _dir = usageDir;
        _clock = clock;
        _path = Path.Combine(usageDir, "usage-rollup.json");
    }

    public long TailOffset { get { lock (_gate) return _tailOffset; } }
    public bool IsDirty { get { lock (_gate) return _dirty; } }

    public void Load()
    {
        lock (_gate)
        {
            _buckets.Clear();
            _tailOffset = 0;
            _sourceLength = 0;
            _dirty = false;
            if (!File.Exists(_path)) return;
            try
            {
                var snap = JsonSerializer.Deserialize<Snapshot>(File.ReadAllText(_path), Json);
                if (snap is null) return;
                _tailOffset = snap.TailOffset;
                _sourceLength = snap.SourceLength;
                foreach (var b in snap.Buckets)
                    _buckets[(b.HourEpoch, b.Component, b.PrRef)] = b;
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
            {
                // Corrupt/unreadable → empty store at offset 0; the tailer's first tick rebuilds.
                _buckets.Clear();
                _tailOffset = 0;
                _sourceLength = 0;
            }
        }
    }

    public void Fold(in AiInteractionLogReader.LogEntry entry)
    {
        var r = entry.Record;
        var hourEpoch = entry.Timestamp.ToUniversalTime().ToUnixTimeSeconds() / 3600;
        var key = (hourEpoch, r.Component, r.PrRef);
        var isProviderCall = r.Outcome is AiInteractionOutcome.Ok or AiInteractionOutcome.ProviderError;
        var isCacheHit = r.Outcome is AiInteractionOutcome.CacheHit;

        lock (_gate)
        {
            var b = _buckets.TryGetValue(key, out var existing)
                ? existing
                : new UsageBucket(hourEpoch, r.Component, r.PrRef, 0, 0, 0, 0, 0m, 0, 0);
            _buckets[key] = b with
            {
                InputTokens = b.InputTokens + (r.InputTokens ?? 0),
                OutputTokens = b.OutputTokens + (r.OutputTokens ?? 0),
                CacheReadInputTokens = b.CacheReadInputTokens + (r.CacheReadInputTokens ?? 0),
                CacheCreationInputTokens = b.CacheCreationInputTokens + (r.CacheCreationInputTokens ?? 0),
                EstimatedCostUsd = b.EstimatedCostUsd + (isProviderCall ? (r.EstimatedCostUsd ?? 0m) : 0m),
                ProviderCalls = b.ProviderCalls + (isProviderCall ? 1 : 0),
                CacheHits = b.CacheHits + (isCacheHit ? 1 : 0),
            };
            _dirty = true;
        }
    }

    public void Advance(long newOffset, long sourceLength)
    {
        lock (_gate)
        {
            if (newOffset != _tailOffset || sourceLength != _sourceLength) _dirty = true;
            _tailOffset = newOffset;
            _sourceLength = sourceLength;
        }
    }

    public void Reset()
    {
        lock (_gate)
        {
            _buckets.Clear();
            _tailOffset = 0;
            _sourceLength = 0;
            _dirty = true;
        }
    }

    public async Task PersistAsync(CancellationToken ct = default)
    {
        // Snapshot + serialize under the lock (all in-memory; no await needed). Write temp file and
        // atomic rename outside the lock (await is not legal inside lock). Clear dirty under the lock
        // after the move succeeds.
        string json;
        lock (_gate)
        {
            EnsureDir();
            var snap = new Snapshot(_tailOffset, _sourceLength, _buckets.Values.ToList());
            json = JsonSerializer.Serialize(snap, Json);
        }
        var tmp = _path + ".tmp";
        await File.WriteAllTextAsync(tmp, json, ct).ConfigureAwait(false);
        await AtomicFileMove.MoveAsync(tmp, _path, ct).ConfigureAwait(false);
        lock (_gate) { _dirty = false; }
    }

    public IReadOnlyList<UsageBucket> SnapshotBuckets()
    {
        lock (_gate) return _buckets.Values.ToList();
    }

    private void EnsureDir()
    {
        Directory.CreateDirectory(_dir);
        if (!OperatingSystem.IsWindows())
        {
            // POSIX owner-only (rwx------), mirroring JsonlTokenUsageTracker. Windows relies on the
            // OS-default per-user dataDir ACL (the token tracker does the same — no ACL code there).
            File.SetUnixFileMode(_dir,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }
}
