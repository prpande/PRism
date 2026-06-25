using PRism.Core.Contracts;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

// Scriptable IActivePrBatchReader for the migrated poller tests (#598 Slice B). Each tick issues
// ONE PollBatchAsync across all candidate refs, so scripting is per-ref:
//   - SetSnapshot(pr, snap): pr is present in the returned map for the current script.
//   - DropRef(pr): pr is absent from the returned map (per-alias null isolation).
//   - SetThrows(ex): the ENTIRE next PollBatchAsync throws (whole-tick-abort: rate-limit /
//     transport / poison payload). Cleared by the next SetSnapshot/DropRef-only call when
//     ClearThrow is used.
// Records the total number of PollBatchAsync calls (BatchCallCount) and per-ref inclusion counts
// (RefReturnedCount) so tests can assert "PR B was returned twice while PR A was dropped".
internal sealed class FakeActivePrBatchReader : IActivePrBatchReader
{
    private readonly Dictionary<PrReference, ActivePrPollSnapshot> _snapshots = new();
    private readonly HashSet<PrReference> _dropped = new();
    private readonly Dictionary<PrReference, int> _refReturned = new();
    private Exception? _throw;
    private readonly object _gate = new();

    public int BatchCallCount { get; private set; }

    public void SetSnapshot(PrReference prRef, ActivePrPollSnapshot snapshot)
    {
        lock (_gate)
        {
            _snapshots[prRef] = snapshot;
            _dropped.Remove(prRef);
        }
    }

    public void DropRef(PrReference prRef)
    {
        lock (_gate)
        {
            _dropped.Add(prRef);
            _snapshots.Remove(prRef);
        }
    }

    public void SetThrows(Exception ex)
    {
        lock (_gate) _throw = ex;
    }

    public void ClearThrow()
    {
        lock (_gate) _throw = null;
    }

    public int RefReturnedCount(PrReference prRef)
    {
        lock (_gate) return _refReturned.TryGetValue(prRef, out var n) ? n : 0;
    }

    public Task<IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>> PollBatchAsync(
        IReadOnlyList<PrReference> refs, CancellationToken ct)
    {
        lock (_gate)
        {
            BatchCallCount++;
            if (_throw is not null) throw _throw;

            var map = new Dictionary<PrReference, ActivePrPollSnapshot>();
            foreach (var r in refs)
            {
                if (_dropped.Contains(r)) continue;
                if (_snapshots.TryGetValue(r, out var snap))
                {
                    map[r] = snap;
                    _refReturned[r] = (_refReturned.TryGetValue(r, out var n) ? n : 0) + 1;
                }
            }
            return Task.FromResult<IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>>(map);
        }
    }
}
