using System.Collections.Concurrent;
using System.Text;

using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Web.TestHooks;

// Test-only IPrReader (ADR-S5-1 split). Serves the canonical scenario PR's detail / diff /
// timeline / file-content / poll / commit-reachability surfaces from the shared
// FakeReviewBackingStore. Legacy S0+S1 methods throw — no S3+ path exercises them.
internal sealed class FakePrReader : IPrReader
{
    private readonly FakeReviewBackingStore _store;

    public FakePrReader(FakeReviewBackingStore store)
    {
        ArgumentNullException.ThrowIfNull(store);
        _store = store;
    }

    public Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct)
    {
        if (reference != FakeReviewBackingStore.Scenario) return Task.FromResult<PrDetailDto?>(null);
        lock (_store.Gate)
        {
            // Mirror real GitHub close-state timestamps so the read-only detail audit
            // (merged/closed history slice, Task 13 header label) sees a non-null
            // mergedAt/closedAt: a merged PR has BOTH timestamps set (a merge is a close);
            // a closed-unmerged PR has only ClosedAt. SetPrState flips IsMerged/IsClosed
            // but carries no timestamp, so derive one here from the deterministic clock.
            // NOTE: _store.Now is the reset-time clock (set in Reset()), NOT the wall-clock
            // moment of the state flip — fine for the audit (only label presence is asserted),
            // but don't rely on these timestamps for ordering against real time.
            var doneAt = _store.Now;
            DateTimeOffset? mergedAt = _store.IsMerged ? doneAt : null;
            DateTimeOffset? closedAt = _store.IsMerged || _store.IsClosed ? doneAt : null;
            var pr = new Pr(
                Reference: FakeReviewBackingStore.Scenario,
                Title: "Calc utilities",
                Body: "Adds Calc helper methods.",
                Author: "e2e-user",
                State: _store.PrState,
                HeadSha: _store.CurrentHeadSha,
                BaseSha: FakeReviewBackingStore.BaseSha,
                HeadBranch: "feat/calc",
                BaseBranch: "main",
                Mergeability: "MERGEABLE",
                CiSummary: "none",
                IsMerged: _store.IsMerged,
                IsClosed: _store.IsClosed,
                IsDraft: _store.IsDraftPr,
                OpenedAt: _store.Now.AddHours(-1),
                MergedAt: mergedAt,
                ClosedAt: closedAt,
                HtmlUrl: "https://github.com/acme/api/pull/123");
            var detail = new PrDetailDto(
                Pr: pr,
                ClusteringQuality: ClusteringQuality.Ok,
                Iterations: _store.Iterations.ToList(),
                Commits: _store.Commits.ToList(),
                RootComments: Array.Empty<IssueCommentDto>(),
                ReviewComments: Array.Empty<ReviewThreadDto>(),
                TimelineCapHit: false,
                ViewerReview: null);
            return Task.FromResult<PrDetailDto?>(detail);
        }
    }

    public Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(range);
        if (reference != FakeReviewBackingStore.Scenario)
            return Task.FromResult(new DiffDto(Range: "", Files: Array.Empty<FileChange>(), Truncated: false));
        // Single-file diff against the empty base. DiffPane's parseHunkLines requires
        // unified-diff format (lines prefixed with `+`/`-`/` ` and a `@@ -N,M +N,M @@`
        // header), otherwise it skips every line and the diff renders blank.
        lock (_store.Gate)
        {
            // If `range.HeadSha` was not seeded by AdvanceHead's `fileChanges` (e.g., the
            // caller advanced the head without supplying file content), fall back to Calc3
            // — the iteration-3 baseline. This is deliberate fallback behavior for
            // sparsely-defined E2E scenarios, NOT a not-found signal. A future spec that
            // needs to test "file did not exist at this sha" should explicitly remove the
            // entry from FileContent and rely on GetFileContentAsync's NotFound path,
            // which is the load-bearing reconciliation surface.
            var newContent = _store.FileContent.TryGetValue(("src/Calc.cs", range.HeadSha), out var c)
                ? c
                : FakeReviewBackingStore.Calc3;
            var newLines = newContent.TrimEnd('\n').Split('\n');
            var sb = new StringBuilder();
            sb.Append("@@ -0,0 +1,").Append(newLines.Length).Append(" @@\n");
            foreach (var line in newLines)
            {
                sb.Append('+').Append(line).Append('\n');
            }
            var hunks = new[]
            {
                new DiffHunk(OldStart: 0, OldLines: 0, NewStart: 1, NewLines: newLines.Length, Body: sb.ToString()),
            };
            var files = new List<FileChange> { new("src/Calc.cs", FileChangeStatus.Modified, hunks) };
            // #214 e2e-only: append trivial single-line FileChanges so the file-TREE overflows
            // horizontally. Each gets a one-line `added` hunk so selecting it renders non-blank.
            foreach (var path in _store.ExtraTreeFiles)
            {
                var body = $"@@ -0,0 +1,1 @@\n+// {path}\n";
                var extraHunks = new[] { new DiffHunk(OldStart: 0, OldLines: 0, NewStart: 1, NewLines: 1, Body: body) };
                files.Add(new FileChange(path, FileChangeStatus.Added, extraHunks));
            }
            return Task.FromResult(new DiffDto(
                Range: $"{range.BaseSha}..{range.HeadSha}",
                Files: files.ToArray(),
                Truncated: false));
        }
    }

    public Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct)
    {
        if (reference != FakeReviewBackingStore.Scenario)
            return Task.FromResult(new ClusteringInput(
                Array.Empty<ClusteringCommit>(),
                Array.Empty<ClusteringForcePush>(),
                Array.Empty<ClusteringReviewEvent>(),
                Array.Empty<ClusteringAuthorComment>()));
        lock (_store.Gate)
        {
            var commits = _store.Commits.Select(c => new ClusteringCommit(
                Sha: c.Sha,
                CommittedDate: c.CommittedDate,
                Message: c.Message,
                Additions: c.Additions,
                Deletions: c.Deletions,
                ChangedFiles: FakeReviewBackingStore.ChangedFiles)).ToList();
            return Task.FromResult(new ClusteringInput(
                Commits: commits,
                ForcePushes: Array.Empty<ClusteringForcePush>(),
                ReviewEvents: Array.Empty<ClusteringReviewEvent>(),
                AuthorPrComments: Array.Empty<ClusteringAuthorComment>()));
        }
    }

    private readonly ConcurrentDictionary<(string Path, string Sha), string> _forceFileFailures = new();

    public void RegisterFileForceFailure(string path, string sha, string problemType)
    {
        _forceFileFailures[(path, sha)] = problemType;
    }

    public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct)
    {
        if (_forceFileFailures.TryRemove((path, sha), out var problemType))
        {
            return Task.FromResult(problemType switch
            {
                "/file/too-large" => new FileContentResult(FileContentStatus.TooLarge, null, 0),
                "/file/binary"    => new FileContentResult(FileContentStatus.Binary, null, 0),
                "/file/missing"   => new FileContentResult(FileContentStatus.NotFound, null, 0),
                _                 => new FileContentResult(FileContentStatus.NotInDiff, null, 0),
            });
        }
        if (reference != FakeReviewBackingStore.Scenario)
            return Task.FromResult(new FileContentResult(FileContentStatus.NotFound, null, 0));
        lock (_store.Gate)
        {
            if (!_store.FileContent.TryGetValue((path, sha), out var content))
                return Task.FromResult(new FileContentResult(FileContentStatus.NotFound, null, 0));
            // Match production semantics: ByteSize is a UTF-8 byte count, not a UTF-16 char count.
            return Task.FromResult(new FileContentResult(FileContentStatus.Ok, content, Encoding.UTF8.GetByteCount(content)));
        }
    }

    public Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct)
    {
        if (reference != FakeReviewBackingStore.Scenario)
            return Task.FromResult(new ActivePrPollSnapshot("", "", "UNKNOWN", PrState.Open, 0, 0));
        lock (_store.Gate)
        {
            return Task.FromResult(new ActivePrPollSnapshot(_store.CurrentHeadSha, FakeReviewBackingStore.BaseSha, "MERGEABLE", _store.PrState, 0, 0));
        }
    }

    public Task<CommitInfo?> GetCommitAsync(PrReference reference, string sha, CancellationToken ct)
    {
        if (reference != FakeReviewBackingStore.Scenario) return Task.FromResult<CommitInfo?>(null);
        lock (_store.Gate)
        {
            return Task.FromResult<CommitInfo?>(_store.ReachableShas.Contains(sha) ? new CommitInfo(sha) : null);
        }
    }

    // -----------------------------------------------------------------------
    // Legacy S0+S1 surface — unused after S3, retained on IPrReader for the S5
    // capability split per ADR-S5-1. Tests don't exercise these paths.
    // -----------------------------------------------------------------------

    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) =>
        throw new NotSupportedException("Legacy GetPrAsync not used by S3+ paths.");

    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) =>
        throw new NotSupportedException("Legacy GetIterationsAsync not used by S3+ paths.");

    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) =>
        throw new NotSupportedException("Legacy two-sha GetDiffAsync not used by S3+ paths.");

    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) =>
        throw new NotSupportedException("Legacy GetCommentsAsync not used by S3+ paths.");
}
