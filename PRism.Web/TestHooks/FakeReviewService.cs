using System.Collections.Concurrent;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Web.TestHooks;

// Spec § 5.10 + plan Task 47. Test-only IReviewService that the .NET host boots
// in place of GitHubReviewService when ASPNETCORE_ENVIRONMENT == "Test". Playwright
// drives state mutation via POST /test/* endpoints (TestEndpoints.cs).
//
// Scope: per the plan deferrals, scenario data is inlined in C# rather than loaded
// from frontend/e2e/fixtures/*.json — for the 4 E2E specs this slice ships, schema
// + parsing overhead per fixture isn't worth it. Future scenarios can refactor to
// JSON when the test count justifies it.
//
// Thread-safety: mutation is rare (one /test/advance-head per E2E test step) and
// reads vastly outnumber writes; using a single lock for simplicity.
internal sealed class FakeReviewService : IReviewService
{
    // The canonical scenario PR. All E2E specs use this reference.
    public static readonly PrReference Scenario = new("acme", "api", 123);

    // The PR's base sha is fixed across iterations. Head sha advances per iteration.
    private const string BaseSha = "ba5e0000000000000000000000000000000000ba";
    private const string Sha1 = "1111111111111111111111111111111111111111";
    private const string Sha2 = "2222222222222222222222222222222222222222";
    private const string Sha3 = "3333333333333333333333333333333333333333";

    // src/Calc.cs at three iteration heads. Lines split by \n; reconciliation
    // pipeline matches on whole-line content.
    private const string Calc1 =
        "namespace Acme;\npublic static class Calc {\n  public static int Add(int a, int b) => a + b;\n}\n";
    private const string Calc2 =
        "namespace Acme;\npublic static class Calc {\n  public static int Add(int a, int b) => a + b;\n  public static int Sub(int a, int b) => a - b;\n  public static int Mul(int a, int b) => a * b;\n}\n";
    private const string Calc3 =
        "namespace Acme;\npublic static class Calc {\n  public static int Add(int a, int b) => a + b;\n  public static int Sub(int a, int b) => a - b;\n  public static int Mul(int a, int b) => a * b;\n  public static int Div(int a, int b) => a / b;\n  public static int Mod(int a, int b) => a % b;\n}\n";

    private readonly object _gate = new();
    private string _currentHeadSha;
    private DateTimeOffset _now;

    // (path, sha) → file content. Populated for each (path, sha) the reconciliation
    // pipeline might query. AdvanceHead adds new (path, newHead) entries.
    private readonly Dictionary<(string Path, string Sha), string> _fileContent = new();

    // Commits keyed by sha. AdvanceHead adds the new head. Force-push test scenarios
    // can drop earlier shas from this dictionary via the SetCommitReachable mutator
    // to simulate rewritten history.
    private readonly HashSet<string> _reachableShas = new(StringComparer.Ordinal);

    // Iterations + commits returned by GetPrDetailAsync / GetTimelineAsync. Mutated
    // by AdvanceHead to append a new iteration.
    private readonly List<IterationDto> _iterations = new();
    private readonly List<CommitDto> _commits = new();

    public FakeReviewService()
    {
        _now = DateTimeOffset.UtcNow;
        _currentHeadSha = Sha3;

        _fileContent[("src/Calc.cs", Sha1)] = Calc1;
        _fileContent[("src/Calc.cs", Sha2)] = Calc2;
        _fileContent[("src/Calc.cs", Sha3)] = Calc3;

        _reachableShas.Add(BaseSha);
        _reachableShas.Add(Sha1);
        _reachableShas.Add(Sha2);
        _reachableShas.Add(Sha3);

        _commits.Add(new CommitDto(Sha1, "Add Calc.Add", _now.AddMinutes(-30), 4, 0));
        _commits.Add(new CommitDto(Sha2, "Add Sub + Mul", _now.AddMinutes(-20), 2, 0));
        _commits.Add(new CommitDto(Sha3, "Add Div + Mod", _now.AddMinutes(-10), 2, 0));

        _iterations.Add(new IterationDto(1, BaseSha, Sha1, new List<CommitDto> { _commits[0] }, true));
        _iterations.Add(new IterationDto(2, Sha1, Sha2, new List<CommitDto> { _commits[1] }, true));
        _iterations.Add(new IterationDto(3, Sha2, Sha3, new List<CommitDto> { _commits[2] }, true));
    }

    // -----------------------------------------------------------------------
    // Mutation surface (called by TestEndpoints)
    // -----------------------------------------------------------------------

    internal sealed record FileContentChange(string Path, string Content);

    private static readonly string[] ChangedFilesArray = new[] { "src/Calc.cs" };
    private static readonly string[] AuthScopes = new[] { "repo" };

    // Appends a new iteration (head shifts from current to newHeadSha) with the
    // supplied file content. Each file change adds a (path, newHeadSha) entry to
    // _fileContent; the prior (path, oldHead) entries stay for reconciliation
    // probes against the now-stale anchored shas.
    public void AdvanceHead(string newHeadSha, IReadOnlyList<FileContentChange> fileChanges)
    {
        ArgumentNullException.ThrowIfNull(newHeadSha);
        ArgumentNullException.ThrowIfNull(fileChanges);
        lock (_gate)
        {
            var oldHead = _currentHeadSha;
            _currentHeadSha = newHeadSha;
            _reachableShas.Add(newHeadSha);
            foreach (var fc in fileChanges)
            {
                _fileContent[(fc.Path, newHeadSha)] = fc.Content;
            }
            _now = _now.AddMinutes(5);
            var commit = new CommitDto(newHeadSha, $"Advance to {newHeadSha[..7]}", _now, 1, 0);
            _commits.Add(commit);
            _iterations.Add(new IterationDto(
                _iterations.Count + 1, oldHead, newHeadSha, new List<CommitDto> { commit }, true));
        }
    }

    // Force-push fallback simulation. When `false`, GetCommitAsync(prRef, sha)
    // returns null — the reconciliation pipeline treats that as "history rewrote"
    // and enters ForcePushFallback (every draft anchored at that sha goes Stale).
    public void SetCommitReachable(string sha, bool reachable)
    {
        ArgumentNullException.ThrowIfNull(sha);
        lock (_gate)
        {
            if (reachable) _reachableShas.Add(sha);
            else _reachableShas.Remove(sha);
        }
    }

    // -----------------------------------------------------------------------
    // IReviewService — minimal viable implementation
    // -----------------------------------------------------------------------

    public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct) =>
        Task.FromResult(new AuthValidationResult(true, "e2e-user", AuthScopes, null, null));

    public Task<InboxSection[]> GetInboxAsync(CancellationToken ct)
    {
        // One section with the canonical scenario PR so the inbox page renders
        // a clickable row pointing at /pr/acme/api/123.
        lock (_gate)
        {
            var item = new PrInboxItem(
                Reference: Scenario,
                Title: "Calc utilities",
                Author: "e2e-user",
                Repo: "acme/api",
                UpdatedAt: _now,
                PushedAt: _now,
                IterationNumber: _iterations.Count,
                CommentCount: 0,
                Additions: 8,
                Deletions: 0,
                HeadSha: _currentHeadSha,
                Ci: CiStatus.None,
                LastViewedHeadSha: null,
                LastSeenCommentId: null);
            var section = new InboxSection("review-requested", "Review requested", new[] { item });
            return Task.FromResult(new[] { section });
        }
    }

    public bool TryParsePrUrl(string url, out PrReference? reference)
    {
        reference = null;
        return false;
    }

    public Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct)
    {
        if (reference != Scenario) return Task.FromResult<PrDetailDto?>(null);
        lock (_gate)
        {
            var pr = new Pr(
                Reference: Scenario,
                Title: "Calc utilities",
                Body: "Adds Calc helper methods.",
                Author: "e2e-user",
                State: "OPEN",
                HeadSha: _currentHeadSha,
                BaseSha: BaseSha,
                HeadBranch: "feat/calc",
                BaseBranch: "main",
                Mergeability: "MERGEABLE",
                CiSummary: "none",
                IsMerged: false,
                IsClosed: false,
                OpenedAt: _now.AddHours(-1));
            var detail = new PrDetailDto(
                Pr: pr,
                ClusteringQuality: ClusteringQuality.Ok,
                Iterations: _iterations.ToList(),
                Commits: _commits.ToList(),
                RootComments: Array.Empty<IssueCommentDto>(),
                ReviewComments: Array.Empty<ReviewThreadDto>(),
                TimelineCapHit: false);
            return Task.FromResult<PrDetailDto?>(detail);
        }
    }

    public Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(range);
        if (reference != Scenario)
            return Task.FromResult(new DiffDto(Range: "", Files: Array.Empty<FileChange>(), Truncated: false));
        // Single-file diff using the head-sha file content. Two hunks isn't
        // necessary for the E2E demos; one Modified hunk against the base is
        // enough to drive the diff renderer and let the user click any line.
        lock (_gate)
        {
            var newContent = _fileContent.TryGetValue(("src/Calc.cs", range.HeadSha), out var c) ? c : Calc3;
            var lineCount = newContent.Split('\n').Length;
            var hunks = new[]
            {
                new DiffHunk(OldStart: 1, OldLines: 1, NewStart: 1, NewLines: lineCount, Body: newContent),
            };
            return Task.FromResult(new DiffDto(
                Range: $"{range.BaseSha}..{range.HeadSha}",
                Files: new[] { new FileChange("src/Calc.cs", FileChangeStatus.Modified, hunks) },
                Truncated: false));
        }
    }

    public Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct)
    {
        if (reference != Scenario)
            return Task.FromResult(new ClusteringInput(
                Array.Empty<ClusteringCommit>(),
                Array.Empty<ClusteringForcePush>(),
                Array.Empty<ClusteringReviewEvent>(),
                Array.Empty<ClusteringAuthorComment>()));
        lock (_gate)
        {
            var commits = _commits.Select(c => new ClusteringCommit(
                Sha: c.Sha,
                CommittedDate: c.CommittedDate,
                Message: c.Message,
                Additions: c.Additions,
                Deletions: c.Deletions,
                ChangedFiles: ChangedFilesArray)).ToList();
            return Task.FromResult(new ClusteringInput(
                Commits: commits,
                ForcePushes: Array.Empty<ClusteringForcePush>(),
                ReviewEvents: Array.Empty<ClusteringReviewEvent>(),
                AuthorPrComments: Array.Empty<ClusteringAuthorComment>()));
        }
    }

    public Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct)
    {
        if (reference != Scenario)
            return Task.FromResult(new FileContentResult(FileContentStatus.NotFound, null, 0));
        lock (_gate)
        {
            if (!_fileContent.TryGetValue((path, sha), out var content))
                return Task.FromResult(new FileContentResult(FileContentStatus.NotFound, null, 0));
            return Task.FromResult(new FileContentResult(FileContentStatus.Ok, content, content.Length));
        }
    }

    public Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct)
    {
        if (reference != Scenario)
            return Task.FromResult(new ActivePrPollSnapshot("", "UNKNOWN", "OPEN", 0, 0));
        lock (_gate)
        {
            return Task.FromResult(new ActivePrPollSnapshot(_currentHeadSha, "MERGEABLE", "OPEN", 0, 0));
        }
    }

    public Task<CommitInfo?> GetCommitAsync(PrReference reference, string sha, CancellationToken ct)
    {
        lock (_gate)
        {
            return Task.FromResult<CommitInfo?>(_reachableShas.Contains(sha) ? new CommitInfo(sha) : null);
        }
    }

    // -----------------------------------------------------------------------
    // Legacy S0+S1 surface — unused after S3, retained on the interface for
    // the S5 capability split per ADR-S5-1. Tests don't exercise these paths.
    // -----------------------------------------------------------------------

    public Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct) =>
        throw new NotSupportedException("Legacy GetPrAsync not used by S3+ paths.");

    public Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct) =>
        throw new NotSupportedException("Legacy GetIterationsAsync not used by S3+ paths.");

    public Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct) =>
        throw new NotSupportedException("Legacy two-sha GetDiffAsync not used by S3+ paths.");

    public Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct) =>
        throw new NotSupportedException("Legacy GetCommentsAsync not used by S3+ paths.");

    public Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct) =>
        throw new NotSupportedException("SubmitReviewAsync is S5 territory; not used by S4 E2E.");
}
