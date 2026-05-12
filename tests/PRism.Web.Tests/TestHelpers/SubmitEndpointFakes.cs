using System.Collections.Concurrent;

using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;
using PRism.Core.Submit;

namespace PRism.Web.Tests.TestHelpers;

// IActivePrCache stub that reports every PR as subscribed (so the broader-than-spec authz check
// passes) and returns a configurable poll snapshot (null by default — the head-sha-drift rule is
// then skipped because the endpoint only compares when a snapshot exists).
internal sealed class AllSubscribedActivePrCache : IActivePrCache
{
    public ActivePrSnapshot? Current { get; set; }
    public bool IsSubscribed(PrReference prRef) => true;
    public ActivePrSnapshot? GetCurrent(PrReference prRef) => Current;
    public void Update(PrReference prRef, ActivePrSnapshot snapshot) => Current = snapshot;
}

// Controllable IReviewSubmitter for endpoint tests. Generates fresh node ids for Begin/Attach,
// returns whatever OwnPendingReview is set to (null by default — "no existing pending review"),
// can delay BeginPendingReviewAsync (to hold the per-PR submit lock for the contention test), and
// can throw on DeletePendingReviewAsync (the bulk-discard courtesy-failure test). Tracks calls.
internal sealed class TestReviewSubmitter : IReviewSubmitter
{
    private int _seq;
    // A minimal in-memory pending review: Begin creates it (empty threads), Finalize/Delete clear
    // it. The pipeline's Step 3 re-fetches the snapshot after Begin and bails if it's null, so this
    // must surface a non-null snapshot for the empty-pipeline-to-Finalize happy path. (A fully
    // accurate in-memory pending review backed by FakeReviewBackingStore lands in S5 PR7.)
    private string? _activePendingReviewId;
    private string? _activePendingCommitOid;

    // When set, FindOwnPendingReviewAsync returns this (the foreign-pending-review / resume /
    // discard tests pre-seed a pending review with a specific id). Takes precedence over the
    // in-memory one created by Begin.
    public OwnPendingReviewSnapshot? OwnPendingReview { get; set; }
    public TimeSpan BeginDelay { get; set; } = TimeSpan.Zero;
    public Exception? DeletePendingReviewException { get; set; }
    public bool FinalizeCalled { get; private set; }

    public List<string> DeletedPendingReviews { get; } = new();
    public List<string> AttachedThreads { get; } = new();
    public List<string> AttachedReplies { get; } = new();

    private string NextId(string prefix) => $"{prefix}_{Interlocked.Increment(ref _seq)}";

    public async Task<BeginPendingReviewResult> BeginPendingReviewAsync(PrReference reference, string commitOid, string summaryBody, CancellationToken ct)
    {
        if (BeginDelay > TimeSpan.Zero) await Task.Delay(BeginDelay, ct).ConfigureAwait(false);
        _activePendingReviewId = NextId("PRR");
        _activePendingCommitOid = commitOid;
        return new BeginPendingReviewResult(_activePendingReviewId);
    }

    public Task<AttachThreadResult> AttachThreadAsync(PrReference reference, string pendingReviewId, DraftThreadRequest draft, CancellationToken ct)
    {
        var id = NextId("PRRT");
        AttachedThreads.Add(id);
        return Task.FromResult(new AttachThreadResult(id));
    }

    public Task<AttachReplyResult> AttachReplyAsync(PrReference reference, string pendingReviewId, string parentThreadId, string replyBody, CancellationToken ct)
    {
        var id = NextId("PRRC");
        AttachedReplies.Add(id);
        return Task.FromResult(new AttachReplyResult(id));
    }

    public Task FinalizePendingReviewAsync(PrReference reference, string pendingReviewId, SubmitEvent verdict, CancellationToken ct)
    {
        FinalizeCalled = true;
        _activePendingReviewId = null;
        _activePendingCommitOid = null;
        return Task.CompletedTask;
    }

    public Task DeletePendingReviewAsync(PrReference reference, string pendingReviewId, CancellationToken ct)
    {
        if (DeletePendingReviewException is not null) return Task.FromException(DeletePendingReviewException);
        DeletedPendingReviews.Add(pendingReviewId);
        if (string.Equals(_activePendingReviewId, pendingReviewId, StringComparison.Ordinal))
        {
            _activePendingReviewId = null;
            _activePendingCommitOid = null;
        }
        if (OwnPendingReview is not null && string.Equals(OwnPendingReview.PullRequestReviewId, pendingReviewId, StringComparison.Ordinal))
            OwnPendingReview = null;
        return Task.CompletedTask;
    }

    public Task DeletePendingReviewThreadAsync(PrReference reference, string pullRequestReviewThreadId, CancellationToken ct)
        => Task.CompletedTask;

    public Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(PrReference reference, CancellationToken ct)
    {
        if (OwnPendingReview is not null) return Task.FromResult<OwnPendingReviewSnapshot?>(OwnPendingReview);
        if (_activePendingReviewId is null) return Task.FromResult<OwnPendingReviewSnapshot?>(null);
        return Task.FromResult<OwnPendingReviewSnapshot?>(new OwnPendingReviewSnapshot(
            _activePendingReviewId, _activePendingCommitOid ?? "", DateTimeOffset.UtcNow, Array.Empty<PendingReviewThreadSnapshot>()));
    }
}

// Minimal IPrReader for endpoint tests. PollActivePrAsync returns a configurable head sha; the
// file-content map (path, sha) → content feeds the Resume endpoint's OriginalLineContent
// enrichment. Everything else is unused by PR3's submit endpoints and throws.
internal sealed class TestPrReader : IPrReader
{
    public string HeadSha { get; set; } = "head1";
    public ConcurrentDictionary<(string Path, string Sha), string> FileContents { get; } = new();

    public Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct)
        => Task.FromResult(new ActivePrPollSnapshot(HeadSha, "MERGEABLE", "OPEN", 0, 0));

    public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct)
        => Task.FromResult(FileContents.TryGetValue((path, sha), out var c)
            ? new FileContentResult(FileContentStatus.Ok, c, System.Text.Encoding.UTF8.GetByteCount(c))
            : new FileContentResult(FileContentStatus.NotFound, null, 0));

    public Task<CommitInfo?> GetCommitAsync(PrReference reference, string sha, CancellationToken ct)
        => Task.FromResult<CommitInfo?>(new CommitInfo(sha));

    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) => throw new NotSupportedException();
    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) => throw new NotSupportedException();
    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) => throw new NotSupportedException();
    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) => throw new NotSupportedException();
    public Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct) => throw new NotSupportedException();
    public Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct) => throw new NotSupportedException();
    public Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct) => throw new NotSupportedException();
}
