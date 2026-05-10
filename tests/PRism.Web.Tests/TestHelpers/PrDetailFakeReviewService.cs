using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Web.Tests.TestHelpers;

// Public so PRismWebApplicationFactory.ReviewServiceOverride can register it. Provides
// scriptable PR-detail responses so endpoint tests can assert wire-format and orchestration
// without spinning up a real GitHub HTTP layer. Mirrors FakePrDetailReviewService in
// PRism.Core.Tests but lives in Web.Tests because cross-test-project sharing is awkward.
public sealed class PrDetailFakeReviewService : IReviewService
{
    public Dictionary<PrReference, ActivePrPollSnapshot> PollResponses { get; } = new();
    public Dictionary<PrReference, PrDetailDto?> DetailResponses { get; } = new();
    public Dictionary<PrReference, ClusteringInput> TimelineResponses { get; } = new();
    public Func<PrReference, DiffRangeRequest, DiffDto>? DiffFactory { get; set; }
    public Func<PrReference, string, string, FileContentResult>? FileContentFactory { get; set; }

    public ActivePrPollSnapshot DefaultPollResponse { get; set; } = new("head1", "MERGEABLE", "OPEN", 0, 0);
    public PrDetailDto? DefaultDetailResponse { get; set; }
    public ClusteringInput DefaultTimelineResponse { get; set; } = new(
        Commits: Array.Empty<ClusteringCommit>(),
        ForcePushes: Array.Empty<ClusteringForcePush>(),
        ReviewEvents: Array.Empty<ClusteringReviewEvent>(),
        AuthorPrComments: Array.Empty<ClusteringAuthorComment>());

    public Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct)
        => Task.FromResult(PollResponses.TryGetValue(reference, out var v) ? v : DefaultPollResponse);

    public Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct)
        => Task.FromResult(DetailResponses.TryGetValue(reference, out var v) ? v : DefaultDetailResponse);

    public Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct)
        => Task.FromResult(TimelineResponses.TryGetValue(reference, out var v) ? v : DefaultTimelineResponse);

    public Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct)
    {
        var factory = DiffFactory ?? ((_, r) => new DiffDto(
            Range: $"{r.BaseSha}..{r.HeadSha}",
            Files: new[] { new FileChange("src/Foo.cs", FileChangeStatus.Modified, Array.Empty<DiffHunk>()) },
            Truncated: false));
        return Task.FromResult(factory(reference, range));
    }

    public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct)
    {
        var factory = FileContentFactory ?? ((_, p, _) => new FileContentResult(FileContentStatus.Ok, $"content of {p}", 100));
        return Task.FromResult(factory(reference, path, sha));
    }

    public Task<CommitInfo?> GetCommitAsync(PrReference reference, string sha, CancellationToken ct)
        => Task.FromResult<CommitInfo?>(new CommitInfo(sha));

    // Methods PR-detail tests don't exercise.
    public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct) =>
        Task.FromResult(new AuthValidationResult(true, "tester", new[] { "repo" }, null, null));
    public Task<InboxSection[]> GetInboxAsync(CancellationToken ct) => Task.FromResult(Array.Empty<InboxSection>());
    public bool TryParsePrUrl(string url, out PrReference? reference) { reference = null; return false; }
    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) => throw new NotImplementedException();
    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) => throw new NotImplementedException();
    public Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct) => throw new NotImplementedException();
}
