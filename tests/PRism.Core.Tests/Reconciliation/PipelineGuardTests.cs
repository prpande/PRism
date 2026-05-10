using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class PipelineGuardTests
{
    private const string OldSha = "0000000000000000000000000000000000000001";
    private const string NewSha = "0000000000000000000000000000000000000002";

    [Fact]
    public async Task LineAnchoredDraft_WithNullAnchoredSha_StaleNoMatch_DoesNotCrash()
    {
        // FilePath is set, so the PR-root pass-through doesn't fire. Without the null-anchor
        // guard, the pipeline would NRE on draft.AnchoredSha! at the reachability probe.
        var draft = new DraftComment(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: 2,
            Side: "right",
            AnchoredSha: null,
            AnchoredLineContent: "line B",
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var fake = new FakeFileContentSource(reachableShas: new() { OldSha, NewSha });
        var session = SessionWith(draft);

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.Equal(StaleReason.NoMatch, d.StaleReason);
    }

    [Fact]
    public async Task LineAnchoredDraft_WithNullAnchoredLineContent_StaleNoMatch_DoesNotCrash()
    {
        var draft = new DraftComment(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: 2,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: null,
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var fake = new FakeFileContentSource(reachableShas: new() { OldSha, NewSha });
        var session = SessionWith(draft);

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.Equal(StaleReason.NoMatch, d.StaleReason);
    }

    [Fact]
    public async Task LineAnchoredDraft_WithNullLineNumber_StaleNoMatch_DoesNotCrash()
    {
        var draft = new DraftComment(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: null,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "line B",
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var fake = new FakeFileContentSource(reachableShas: new() { OldSha, NewSha });
        var session = SessionWith(draft);

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.Equal(StaleReason.NoMatch, d.StaleReason);
    }

    [Fact]
    public async Task SourceThrowsOnFirstDraft_OtherDraftsStillReconcile()
    {
        // Per-draft isolation: an exception fetching draft #1's content must not abort
        // reconciliation for draft #2. PR3 wires GitHub; transient failures should localize.
        var draft1 = new DraftComment(
            Id: "d1",
            FilePath: "src/Bad.cs",       // throwing fake routes via this path
            LineNumber: 2,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "line B",
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var draft2 = new DraftComment(
            Id: "d2",
            FilePath: "src/Foo.cs",
            LineNumber: 2,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "line B",
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var fake = new ThrowingFakeFileContentSource(
            throwForPath: "src/Bad.cs",
            files: new() { [("src/Foo.cs", NewSha)] = "line A\nline B\nline C\n" },
            reachableShas: new() { OldSha, NewSha });

        var session = SessionWith(draft1, draft2);

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        Assert.Equal(2, result.Drafts.Count);
        var bad = result.Drafts.Single(d => d.Id == "d1");
        var good = result.Drafts.Single(d => d.Id == "d2");
        Assert.Equal(DraftStatus.Stale, bad.Status);
        Assert.Equal(StaleReason.NoMatch, bad.StaleReason);
        Assert.Equal(DraftStatus.Draft, good.Status);
        Assert.Equal(2, good.ResolvedLineNumber);
    }

    [Fact]
    public async Task MissingFile_FetchedOncePerSha_AcrossMultipleDrafts()
    {
        // Pins the per-call cache contract: when N drafts share the same missing
        // (filePath, sha), the source's GetAsync is called exactly once. PR3 will wire
        // ReviewServiceFileContentSource against GitHub; un-cached missing files would
        // amplify network calls under realistic session shapes.
        var counting = new CountingFakeFileContentSource(
            files: new(),                                         // file is missing at NewSha
            reachableShas: new() { OldSha, NewSha });

        var draft1 = MakeDraft(id: "d1", path: "src/Missing.cs", line: 2);
        var draft2 = MakeDraft(id: "d2", path: "src/Missing.cs", line: 5);
        var draft3 = MakeDraft(id: "d3", path: "src/Missing.cs", line: 9);

        var session = SessionWith(draft1, draft2, draft3);

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, counting, CancellationToken.None);

        Assert.Equal(3, result.Drafts.Count);
        Assert.All(result.Drafts, d =>
        {
            Assert.Equal(DraftStatus.Stale, d.Status);
            Assert.Equal(StaleReason.FileDeleted, d.StaleReason);
        });
        Assert.Equal(1, counting.GetAsyncCallCount);
    }

    [Fact]
    public async Task PrRootDraft_NullFilePath_PassesThroughUnchanged()
    {
        // PR-root drafts (FilePath null) skip the per-draft IO pipeline entirely.
        // Pin the pass-through fields so future composer / reload wiring can't silently
        // change the contract: Status / IsOverriddenStale flow through; ResolvedFilePath
        // and ResolvedLineNumber are null; AlternateMatchCount = 0; ForcePushFallbackTriggered
        // = false; ResolvedAnchoredSha echoes the input AnchoredSha.
        var prRootDraft = new DraftComment(
            Id: "pr-root-1",
            FilePath: null,
            LineNumber: null,
            Side: null,
            AnchoredSha: null,
            AnchoredLineContent: null,
            BodyMarkdown: "PR-root comment body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var fake = new FakeFileContentSource(reachableShas: new() { OldSha, NewSha });
        var session = SessionWith(prRootDraft);

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.Null(d.ResolvedFilePath);
        Assert.Null(d.ResolvedLineNumber);
        Assert.Null(d.ResolvedAnchoredSha);
        Assert.Equal(0, d.AlternateMatchCount);
        Assert.Null(d.StaleReason);
        Assert.False(d.ForcePushFallbackTriggered);
        Assert.False(d.IsOverriddenStale);
    }

    [Fact]
    public async Task SourceThrowsOperationCanceled_PropagatesOut()
    {
        // OperationCanceledException must NOT be swallowed by the per-draft try/catch —
        // cooperative cancellation should bubble up so callers can short-circuit reload.
        var draft = new DraftComment(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: 2,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "line B",
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var fake = new CancelingFakeFileContentSource();
        var session = SessionWith(draft);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, cts.Token));
    }

    private static DraftComment MakeDraft(string id, string path, int line)
        => new(
            Id: id,
            FilePath: path,
            LineNumber: line,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "line B",
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

    private static ReviewSessionState SessionWith(params DraftComment[] drafts)
        => new(
            LastViewedHeadSha: OldSha,
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: drafts,
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

    private sealed class ThrowingFakeFileContentSource : IFileContentSource
    {
        private readonly string _throwForPath;
        private readonly Dictionary<(string, string), string> _files;
        private readonly HashSet<string> _reachableShas;

        public ThrowingFakeFileContentSource(string throwForPath,
            Dictionary<(string, string), string> files,
            HashSet<string> reachableShas)
        {
            _throwForPath = throwForPath;
            _files = files;
            _reachableShas = reachableShas;
        }

        public Task<string?> GetAsync(string filePath, string sha, CancellationToken ct)
        {
            if (filePath == _throwForPath)
                throw new InvalidOperationException("simulated source failure");
            return Task.FromResult(_files.GetValueOrDefault((filePath, sha)));
        }

        public Task<bool> IsCommitReachableAsync(string sha, CancellationToken ct)
            => Task.FromResult(_reachableShas.Contains(sha));
    }

    private sealed class CountingFakeFileContentSource : IFileContentSource
    {
        private readonly Dictionary<(string, string), string> _files;
        private readonly HashSet<string> _reachableShas;

        public int GetAsyncCallCount { get; private set; }

        public CountingFakeFileContentSource(
            Dictionary<(string, string), string> files,
            HashSet<string> reachableShas)
        {
            _files = files;
            _reachableShas = reachableShas;
        }

        public Task<string?> GetAsync(string filePath, string sha, CancellationToken ct)
        {
            GetAsyncCallCount++;
            return Task.FromResult(_files.GetValueOrDefault((filePath, sha)));
        }

        public Task<bool> IsCommitReachableAsync(string sha, CancellationToken ct)
            => Task.FromResult(_reachableShas.Contains(sha));
    }

    private sealed class CancelingFakeFileContentSource : IFileContentSource
    {
        public Task<string?> GetAsync(string filePath, string sha, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            return Task.FromResult<string?>(null);
        }

        public Task<bool> IsCommitReachableAsync(string sha, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            return Task.FromResult(false);
        }
    }
}
