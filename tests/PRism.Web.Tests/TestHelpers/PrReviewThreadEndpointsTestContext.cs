using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;

namespace PRism.Web.Tests.TestHelpers;

// ── Test writer fake ──────────────────────────────────────────────────────────────────────────

/// <summary>
/// Controllable IReviewThreadWriter. Records calls (verb + threadId); returns NextResult on
/// every action. Mirrors TestPrLifecycleWriter (PrLifecycleEndpointsTestContext.cs).
/// </summary>
internal sealed class TestReviewThreadWriter : IReviewThreadWriter
{
    public ReviewThreadResult NextResult { get; set; } = ReviewThreadResult.Ok;
    public List<string> Calls { get; } = new();
    public List<(string Verb, string ThreadId)> CallDetails { get; } = new();

    private Task<ReviewThreadResult> Record(string verb, string threadId)
    {
        Calls.Add(verb);
        CallDetails.Add((verb, threadId));
        return Task.FromResult(NextResult);
    }

    public Task<ReviewThreadResult> ResolveAsync(PrReference reference, string threadId, CancellationToken ct) =>
        Record("resolve", threadId);

    public Task<ReviewThreadResult> UnresolveAsync(PrReference reference, string threadId, CancellationToken ct) =>
        Record("unresolve", threadId);
}

// ── Test context ──────────────────────────────────────────────────────────────────────────────

/// <summary>
/// Per-test harness for PrReviewThreadEndpoints. Combines the two override mechanisms
/// PRismWebApplicationFactory exposes so a single derived server carries both a seeded
/// PR-detail snapshot (for the ownership-binding gate, spec §5.4) and controllable
/// IReviewThreadWriter / IReviewEventBus / IActivePrCache doubles:
///   - ReviewServiceOverride (constructor property) seeds PrDetailFakeReviewService, which
///     PrDetailLoader.LoadAsync ultimately reads from on the gate-3 rehydrate path.
///   - WithWebHostBuilder(...).ConfigureServices swaps the three touchpoints, exactly mirroring
///     PrLifecycleEndpointsTestContext.
/// New one per test; dispose deletes the temp DataDir (via the base factory's Dispose).
/// </summary>
internal sealed class PrReviewThreadEndpointsTestContext : IDisposable
{
    public const string KnownThreadId = "PRRT_known";

    private readonly PRismWebApplicationFactory _base;
    private readonly WebApplicationFactory<Program> _derived;
    private readonly MutableActivePrCache _cache;

    public TestReviewThreadWriter Writer { get; } = new();
    public FakeReviewEventBus Bus { get; } = new();
    public PrDetailFakeReviewService Review { get; }

    private PrReviewThreadEndpointsTestContext()
    {
        _cache = new MutableActivePrCache(subscribed: true);
        Review = new PrDetailFakeReviewService
        {
            DefaultDetailResponse = MakeDetail(),
            DefaultTimelineResponse = MakeTimeline(5),
        };
        _base = new PRismWebApplicationFactory { ReviewServiceOverride = Review };
        _derived = _base.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IReviewThreadWriter>();
            s.AddSingleton<IReviewThreadWriter>(Writer);
            s.RemoveAll<IReviewEventBus>();
            s.AddSingleton<IReviewEventBus>(Bus);
            s.RemoveAll<IActivePrCache>();
            s.AddSingleton<IActivePrCache>(_cache);
        }));
        // Force server (and DataDir/state.json) creation.
        _ = _derived.Services;
    }

    public static PrReviewThreadEndpointsTestContext Create() => new();

    // Default tabId = "tab-test" so a plain CreateClient() has a valid X-PRism-Tab-Id.
    // Pass tabId: null to genuinely omit the header (the missing-tab-id test path).
    public HttpClient CreateClient(string? tabId = "tab-test") =>
        _derived.CreateAuthenticatedClient(tabId);

    /// <summary>Toggles the subscribe gate. Default is subscribed (true).</summary>
    public void SetSubscribed(bool subscribed) => _cache.SetSubscribed(subscribed);

    // Seeds a single known review thread (KnownThreadId) so the ownership-binding gate (§5.4)
    // has something to match against; a foreign id in the test body exercises the 404 branch.
    // Shape copied from PrDetailEndpointsTests.MakeDetail, with ReviewComments populated.
    private static PrDetailDto MakeDetail() =>
        new(
            Pr: new Pr(
                Reference: new PrReference("o", "r", 1),
                Title: "Test PR",
                Body: "body",
                Author: "alice",
                State: PrState.Open,
                HeadSha: "head1",
                BaseSha: "base1",
                HeadBranch: "feat/x",
                BaseBranch: "main",
                Mergeability: "MERGEABLE",
                CiSummary: "passing",
                IsMerged: false,
                IsClosed: false,
                OpenedAt: DateTimeOffset.UtcNow),
            ClusteringQuality: ClusteringQuality.Ok,
            Iterations: null,
            Commits: Array.Empty<CommitDto>(),
            RootComments: Array.Empty<IssueCommentDto>(),
            ReviewComments: new[]
            {
                new ReviewThreadDto(
                    ThreadId: KnownThreadId,
                    FilePath: "src/Foo.cs",
                    LineNumber: 10,
                    IsResolved: false,
                    Comments: Array.Empty<ReviewCommentDto>()),
            },
            TimelineCapHit: false,
            ViewerReview: null);

    private static ClusteringInput MakeTimeline(int commitCount) =>
        new(
            Commits: Enumerable.Range(0, commitCount)
                .Select(i => new ClusteringCommit(
                    Sha: $"c{i:D3}",
                    CommittedDate: DateTimeOffset.UtcNow.AddSeconds(i * 60),
                    Message: $"commit {i}",
                    Additions: 10,
                    Deletions: 1,
                    ChangedFiles: new[] { $"file{i}.cs" }))
                .ToArray(),
            ForcePushes: Array.Empty<ClusteringForcePush>(),
            ReviewEvents: Array.Empty<ClusteringReviewEvent>(),
            AuthorPrComments: Array.Empty<ClusteringAuthorComment>());

    public void Dispose()
    {
        _derived.Dispose();
        _base.Dispose();
    }
}
