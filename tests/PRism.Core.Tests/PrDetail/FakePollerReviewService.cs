using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Core.Tests.PrDetail;

// Test helper for ActivePrPollerBackoffTests. Lets per-PR poll responses be scripted: either
// a snapshot (success) or an exception (failure). Records per-PR call counts so tests can
// assert "PR B was polled twice while PR A was skipped." Other IPrReader methods throw
// — the poller only calls PollActivePrAsync.
internal sealed class FakePollerReviewService : IPrReader
{
    private readonly Dictionary<PrReference, ActivePrPollSnapshot> _snapshots = new();
    private readonly Dictionary<PrReference, Exception> _throws = new();
    private readonly Dictionary<PrReference, int> _callCounts = new();
    private readonly object _gate = new();

    public void SetSnapshot(PrReference prRef, ActivePrPollSnapshot snapshot)
    {
        lock (_gate)
        {
            _snapshots[prRef] = snapshot;
            _throws.Remove(prRef);
        }
    }

    public void SetThrows(PrReference prRef, Exception ex)
    {
        lock (_gate)
        {
            _throws[prRef] = ex;
            _snapshots.Remove(prRef);
        }
    }

    public int CallCount(PrReference prRef)
    {
        lock (_gate) return _callCounts.TryGetValue(prRef, out var n) ? n : 0;
    }

    public Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct)
    {
        lock (_gate)
        {
            _callCounts[reference] = (_callCounts.TryGetValue(reference, out var n) ? n : 0) + 1;
            if (_throws.TryGetValue(reference, out var ex)) throw ex;
            if (_snapshots.TryGetValue(reference, out var snap)) return Task.FromResult(snap);
            throw new InvalidOperationException($"FakePollerReviewService: no script for {reference}");
        }
    }

    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) => throw new NotImplementedException();
    public Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct) => throw new NotImplementedException();
    public Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct) => throw new NotImplementedException();
    public Task<CommitInfo?> GetCommitAsync(PrReference reference, string sha, CancellationToken ct) => throw new NotImplementedException();
    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
}
