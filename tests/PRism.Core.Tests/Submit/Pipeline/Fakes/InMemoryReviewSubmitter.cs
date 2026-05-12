using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.Core.Tests.Submit.Pipeline.Fakes;

// Test-only IReviewSubmitter for the SubmitPipeline unit tests (spec § 5.4). Keeps an in-memory
// per-PR pending review (threads + per-thread reply chains), assigns unique GraphQL-style ids, and
// supports one-shot per-method failure injection so RetryFromEachStepTests can drive each step's
// failure path. No HTTP, no WebApplicationFactory — the pipeline runs entirely against this fake.
//
// (The PRism.Web.TestHooks.FakeReviewSubmitter is a separate, Playwright-facing fake fleshed out
// in PR7 — distinct concern, distinct assembly.)
internal sealed class InMemoryReviewSubmitter : IReviewSubmitter
{
    private readonly Dictionary<string, InMemoryPendingReview> _pendingByRef = new();
    private readonly Dictionary<string, Exception> _failureByMethod = new(StringComparer.Ordinal);
    private int _nextId = 1;

    // Inject a one-shot failure: the next call to the named method throws `ex`, then clears.
    public void InjectFailure(string methodName, Exception ex) => _failureByMethod[methodName] = ex;

    // Pre-populate a pending review (e.g. a foreign one, or a lost-response server thread).
    public void SeedPendingReview(PrReference prRef, InMemoryPendingReview pending)
        => _pendingByRef[Key(prRef)] = pending;

    public InMemoryPendingReview? GetPending(PrReference prRef)
        => _pendingByRef.TryGetValue(Key(prRef), out var p) ? p : null;

    public Task<BeginPendingReviewResult> BeginPendingReviewAsync(PrReference reference, string commitOid, string summaryBody, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(BeginPendingReviewAsync));
        var id = $"PRR_{_nextId++}";
        _pendingByRef[Key(reference)] = new InMemoryPendingReview(id, commitOid, DateTimeOffset.UtcNow, summaryBody);
        return Task.FromResult(new BeginPendingReviewResult(id));
    }

    public Task<AttachThreadResult> AttachThreadAsync(PrReference reference, string pendingReviewId, DraftThreadRequest draft, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(AttachThreadAsync));
        var pending = RequirePending(reference);
        var threadId = $"PRRT_{_nextId++}";
        pending.Threads.Add(new InMemoryThread(threadId, draft.FilePath, draft.LineNumber, draft.Side,
            CommitOid: pending.CommitOid, Body: draft.BodyMarkdown, IsResolved: false, Replies: new List<InMemoryComment>()));
        return Task.FromResult(new AttachThreadResult(threadId));
    }

    public Task<AttachReplyResult> AttachReplyAsync(PrReference reference, string pendingReviewId, string parentThreadId, string replyBody, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(AttachReplyAsync));
        var pending = RequirePending(reference);
        var thread = pending.Threads.FirstOrDefault(t => t.Id == parentThreadId)
            ?? throw new HttpRequestException($"NOT_FOUND: parent thread {parentThreadId}");
        var commentId = $"PRRC_{_nextId++}";
        thread.Replies.Add(new InMemoryComment(commentId, replyBody));
        return Task.FromResult(new AttachReplyResult(commentId));
    }

    public Task FinalizePendingReviewAsync(PrReference reference, string pendingReviewId, SubmitEvent verdict, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(FinalizePendingReviewAsync));
        _pendingByRef.Remove(Key(reference));  // submitted → no longer pending
        return Task.CompletedTask;
    }

    public Task DeletePendingReviewAsync(PrReference reference, string pendingReviewId, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(DeletePendingReviewAsync));
        _pendingByRef.Remove(Key(reference));
        return Task.CompletedTask;
    }

    public Task DeletePendingReviewThreadAsync(PrReference reference, string pullRequestReviewThreadId, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(DeletePendingReviewThreadAsync));
        if (_pendingByRef.TryGetValue(Key(reference), out var pending))
            pending.Threads.RemoveAll(t => t.Id == pullRequestReviewThreadId);
        return Task.CompletedTask;
    }

    public Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(PrReference reference, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(FindOwnPendingReviewAsync));
        if (!_pendingByRef.TryGetValue(Key(reference), out var pending))
            return Task.FromResult<OwnPendingReviewSnapshot?>(null);

        var threads = pending.Threads.Select(t => new PendingReviewThreadSnapshot(
                PullRequestReviewThreadId: t.Id,
                FilePath: t.FilePath,
                LineNumber: t.LineNumber,
                Side: t.Side,
                OriginalCommitOid: t.CommitOid,
                OriginalLineContent: "",
                IsResolved: t.IsResolved,
                BodyMarkdown: t.Body,
                Comments: t.Replies.Select(r => new PendingReviewCommentSnapshot(r.Id, r.Body)).ToList()))
            .ToList();

        return Task.FromResult<OwnPendingReviewSnapshot?>(new OwnPendingReviewSnapshot(
            pending.Id, pending.CommitOid, pending.CreatedAt, threads));
    }

    private InMemoryPendingReview RequirePending(PrReference reference)
        => _pendingByRef.TryGetValue(Key(reference), out var p)
            ? p
            : throw new HttpRequestException($"NOT_FOUND: no pending review on {reference}");

    private void ConsumeFailureOrContinue(string methodName)
    {
        if (_failureByMethod.Remove(methodName, out var ex)) throw ex;
    }

    private static string Key(PrReference r) => $"{r.Owner}/{r.Repo}/{r.Number}";

    internal sealed class InMemoryPendingReview
    {
        public string Id { get; }
        public string CommitOid { get; set; }
        public DateTimeOffset CreatedAt { get; }
        public string SummaryBody { get; }
        public List<InMemoryThread> Threads { get; } = new();

        public InMemoryPendingReview(string id, string commitOid, DateTimeOffset createdAt, string summaryBody)
        {
            Id = id;
            CommitOid = commitOid;
            CreatedAt = createdAt;
            SummaryBody = summaryBody;
        }
    }

    internal sealed record InMemoryThread(
        string Id, string FilePath, int LineNumber, string Side, string CommitOid,
        string Body, bool IsResolved, List<InMemoryComment> Replies);

    internal sealed record InMemoryComment(string Id, string Body);
}
