using System.Collections.Concurrent;
using PRism.Core.Contracts;

namespace PRism.Web.Submit;

/// <summary>
/// Per-PR <see cref="CancellationTokenSource"/> registry. The submit endpoint
/// creates a linked CTS, registers it here, then passes its token through to
/// <see cref="Pipeline.SubmitPipeline.SubmitAsync"/>. The discard endpoint
/// signals cancellation via <see cref="RequestCancel"/>. Registration is
/// disposed inside the submit endpoint's fire-and-forget Task.Run finally so
/// the CTS's lifetime matches the pipeline's.
///
/// Stomp defense: <see cref="Register"/> uses TryAdd and throws on collision.
/// A surviving entry indicates a stuck pipeline missed its finally cleanup —
/// silently replacing would let RequestCancel target the wrong pipeline.
/// </summary>
internal sealed class SubmitCancellationRegistry
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _ctsByPrRef =
        new(StringComparer.Ordinal);

    public IDisposable Register(PrReference reference, CancellationTokenSource cts)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(cts);
        var key = reference.ToString();
        if (!_ctsByPrRef.TryAdd(key, cts))
        {
            throw new InvalidOperationException(
                $"SubmitCancellationRegistry: a registration already exists for {key}. " +
                "This indicates a stuck pipeline missed its finally cleanup.");
        }
        return new RegistrationHandle(this, key, cts);
    }

    public void RequestCancel(PrReference reference)
    {
        ArgumentNullException.ThrowIfNull(reference);
        if (_ctsByPrRef.TryGetValue(reference.ToString(), out var cts))
        {
            try { cts.Cancel(); }
            catch (ObjectDisposedException) { /* race vs Task.Run finally; tolerated */ }
        }
    }

    private sealed class RegistrationHandle : IDisposable
    {
        private readonly SubmitCancellationRegistry _owner;
        private readonly string _key;
        private readonly CancellationTokenSource _cts;
        private int _disposed;

        public RegistrationHandle(SubmitCancellationRegistry owner, string key, CancellationTokenSource cts)
        {
            _owner = owner; _key = key; _cts = cts;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                // Only remove if our CTS is still the registered one — defends against
                // a delayed dispose stomping a freshly re-registered entry.
                _owner._ctsByPrRef.TryRemove(new KeyValuePair<string, CancellationTokenSource>(_key, _cts));
            }
        }
    }
}
