using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Core.Tests.PrDetail;

// Test helper. Scripts IReviewService responses for PrDetailLoader tests + records the
// per-method call-order so tests can assert orchestration sequencing. The PR-detail surface
// is the only part PrDetailLoader exercises; legacy / non-S3 methods throw NotImplementedException.
internal sealed class FakePrDetailReviewService : IReviewService
{
    private readonly List<string>? _callLog;

    public FakePrDetailReviewService(List<string>? callLog = null)
    {
        _callLog = callLog;
    }

    // Scripted return values; tests assign before calling LoadAsync. PR-keyed so the
    // "different PR refs return different snapshots" tests can script per-PR responses.
    public Dictionary<PrReference, ActivePrPollSnapshot?> PollResponses { get; } = new();
    public Dictionary<PrReference, PrDetailDto?> DetailResponses { get; } = new();
    public Dictionary<PrReference, ClusteringInput?> TimelineResponses { get; } = new();

    // Default fallbacks used when the per-PR dict has no entry. Lets simple tests skip
    // per-PR scripting and use the default.
    public ActivePrPollSnapshot? DefaultPollResponse { get; set; } = new("head1", "MERGEABLE", "OPEN", 0, 0);
    public PrDetailDto? DefaultDetailResponse { get; set; }
    public ClusteringInput? DefaultTimelineResponse { get; set; }

    // Diff-fetch script: called on GetDiffAsync(prRef, range, ct) — the new S3 overload.
    // Default falls back to a single-file canonical diff (one Modified file at "src/Foo.cs").
    public Func<PrReference, DiffRangeRequest, DiffDto>? DiffFactory { get; set; }

    public int PollActivePrCallCount { get; private set; }
    public int GetPrDetailCallCount { get; private set; }
    public int GetTimelineCallCount { get; private set; }
    public int GetDiffCallCount { get; private set; }

    public Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct)
    {
        PollActivePrCallCount++;
        _callLog?.Add("PollActivePr");
        var snapshot = PollResponses.TryGetValue(reference, out var v) ? v : DefaultPollResponse;
        return Task.FromResult(snapshot ?? throw new InvalidOperationException(
            $"FakePrDetailReviewService.PollActivePrAsync: no response scripted for {reference} and no default."));
    }

    public Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct)
    {
        GetPrDetailCallCount++;
        _callLog?.Add("GetPrDetail");
        var dto = DetailResponses.TryGetValue(reference, out var v) ? v : DefaultDetailResponse;
        return Task.FromResult(dto);
    }

    public Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct)
    {
        GetTimelineCallCount++;
        _callLog?.Add("GetTimeline");
        var input = TimelineResponses.TryGetValue(reference, out var v) ? v : DefaultTimelineResponse;
        return Task.FromResult(input ?? throw new InvalidOperationException(
            $"FakePrDetailReviewService.GetTimelineAsync: no response scripted for {reference} and no default."));
    }

    // Methods PrDetailLoader doesn't call in its current shape — left unimplemented so
    // accidental use in a test is loud.
    public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct) => throw new NotImplementedException();
    public Task<InboxSection[]> GetInboxAsync(CancellationToken ct) => throw new NotImplementedException();
    public bool TryParsePrUrl(string url, out PrReference? reference) => throw new NotImplementedException();
    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) => throw new NotImplementedException();
    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct)
    {
        GetDiffCallCount++;
        _callLog?.Add("GetDiff");
        var factory = DiffFactory ?? ((_, r) => new DiffDto(
            Range: $"{r.BaseSha}..{r.HeadSha}",
            Files: new[] { new FileChange("src/Foo.cs", FileChangeStatus.Modified, Array.Empty<DiffHunk>()) },
            Truncated: false));
        return Task.FromResult(factory(reference, range));
    }
    public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct) => throw new NotImplementedException();
    public Task<CommitInfo?> GetCommitAsync(PrReference reference, string sha, CancellationToken ct) => throw new NotImplementedException();
    public Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct) => throw new NotImplementedException();
}
