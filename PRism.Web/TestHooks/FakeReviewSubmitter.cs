using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.Web.TestHooks;

// Working in-memory IReviewSubmitter (ADR-S5-1 split), registered as the IReviewSubmitter in
// dev/test mode (Program.cs, under PRISM_E2E_FAKE_REVIEW=1). Backs the S5 DoD E2E suite
// (plan Tasks 61-69): keeps a per-PR pending review (threads + per-thread reply chains), assigns
// GraphQL-style ids (PRR_/PRRT_/PRRC_), and exposes test-driven knobs — one-shot per-method failure
// injection (before *or* after the side effect, the latter being the "lost-response window"),
// a Begin delay (so the per-PR submit-lock multi-tab test can hold the lock long enough to race a
// second tab), a FindOwn-returns-null-from-call-N knob (GitHub's reviews(...) list lagging), and
// pending-review seeding (foreign-pending-review / stale-commitOID scenarios).
//
// This deliberately mirrors the *shape* of PRism.Core.Tests' InMemoryReviewSubmitter (the
// SubmitPipeline unit-test fake) but is a separate, duplicated implementation — the Playwright fake
// and the unit-test fake share no code so a change to one can't silently shift the other (plan
// Task 61 step 1). It is driven via the /test/submit/* endpoints in TestEndpoints.cs; Reset() is
// called by POST /test/reset between Playwright specs.
//
// Thread-safety: a single Gate. Real submit concurrency is serialized by the endpoint's per-PR
// SubmitLockRegistry (only one submit reaches the pipeline at a time), but /test/submit/* introspection
// can race a slow in-flight submit, so reads that span more than one field hold the Gate.
internal sealed class FakeReviewSubmitter : IReviewSubmitter
{
    private readonly object _gate = new();
    private readonly Dictionary<string, FakePendingReview> _pendingByRef = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (Exception Ex, bool AfterEffect)> _failureByMethod = new(StringComparer.Ordinal);
    private int _nextId = 1;
    private int _beginDelayMs;
    private int _findOwnReturnsNullFromCall = int.MaxValue;
    private int _findOwnCallCount;
    private int _attachThreadCallCount;
    private int _attachReplyCallCount;
    private int _deleteThreadCallCount;

    // ----- test knobs / introspection (all driven via /test/submit/*) -----

    public void Reset()
    {
        lock (_gate)
        {
            _pendingByRef.Clear();
            _failureByMethod.Clear();
            _nextId = 1;
            _beginDelayMs = 0;
            _findOwnReturnsNullFromCall = int.MaxValue;
            _findOwnCallCount = 0;
            _attachThreadCallCount = 0;
            _attachReplyCallCount = 0;
            _deleteThreadCallCount = 0;
        }
    }

    // One-shot failure: the next call to `methodName` throws `ex`. When `afterEffect` is true the
    // method's side effect (e.g. AttachThreadAsync adding the thread) happens first, then it throws —
    // simulating the lost-response window (the server committed but the client never got the result).
    public void InjectFailure(string methodName, Exception ex, bool afterEffect = false)
    {
        ArgumentNullException.ThrowIfNull(ex);
        lock (_gate) _failureByMethod[methodName] = (ex, afterEffect);
    }

    public void SetBeginDelay(int delayMs)
    {
        lock (_gate) _beginDelayMs = delayMs;
    }

    public void SetFindOwnReturnsNullFromCall(int n)
    {
        lock (_gate) _findOwnReturnsNullFromCall = n;
    }

    public void SeedPendingReview(PrReference prRef, FakePendingReview pending)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        ArgumentNullException.ThrowIfNull(pending);
        lock (_gate) _pendingByRef[Key(prRef)] = pending;
    }

    // Allocates the next id with the fake's shared counter and the given prefix. Lets the
    // /test/submit/seed-pending-review endpoint build a FakePendingReview whose ids won't collide
    // with ones the pipeline assigns afterward.
    public string NextId(string prefix)
    {
        lock (_gate) return $"{prefix}{_nextId++}";
    }

    public FakeSubmitSnapshot Inspect(PrReference prRef)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        lock (_gate)
        {
            FakePendingReviewSnapshot? pending = null;
            if (_pendingByRef.TryGetValue(Key(prRef), out var p))
            {
                pending = new FakePendingReviewSnapshot(
                    p.Id, p.CommitOid, p.SummaryBody, p.Threads.Count, p.Threads.Sum(t => t.Replies.Count),
                    p.Threads.Select(t => new FakeThreadSnapshot(t.Id, t.FilePath, t.LineNumber, t.IsResolved, t.Body,
                        t.Replies.Select(r => new FakeCommentSnapshot(r.Id, r.Body)).ToList())).ToList());
            }
            return new FakeSubmitSnapshot(pending, _attachThreadCallCount, _attachReplyCallCount, _deleteThreadCallCount, _findOwnCallCount);
        }
    }

    // ----- IReviewSubmitter -----

    public async Task<BeginPendingReviewResult> BeginPendingReviewAsync(PrReference reference, string commitOid, string summaryBody, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        int delay;
        lock (_gate)
        {
            // A "before" failure short-circuits even the delay; an "after" failure is consumed below.
            if (TryTakeFailure(nameof(BeginPendingReviewAsync), afterEffectWanted: false, out var pre)) throw pre;
            delay = _beginDelayMs;
        }
        if (delay > 0) await Task.Delay(delay, ct).ConfigureAwait(false);
        lock (_gate)
        {
            var id = $"PRR_{_nextId++}";
            _pendingByRef[Key(reference)] = new FakePendingReview(id, commitOid, DateTimeOffset.UtcNow, summaryBody ?? "");
            if (TryTakeFailure(nameof(BeginPendingReviewAsync), afterEffectWanted: true, out var post)) throw post;
            return new BeginPendingReviewResult(id);
        }
    }

    public Task<AttachThreadResult> AttachThreadAsync(PrReference reference, string pendingReviewId, DraftThreadRequest draft, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(draft);
        lock (_gate)
        {
            if (TryTakeFailure(nameof(AttachThreadAsync), afterEffectWanted: false, out var pre)) throw pre;
            var pending = RequirePending(reference);
            var threadId = $"PRRT_{_nextId++}";
            pending.Threads.Add(new FakeThread(threadId, draft.FilePath, draft.LineNumber, draft.Side,
                CommitOid: pending.CommitOid, Body: draft.BodyMarkdown, IsResolved: false,
                Replies: new List<FakeComment>(), CreatedAt: DateTimeOffset.UtcNow));
            _attachThreadCallCount++;
            if (TryTakeFailure(nameof(AttachThreadAsync), afterEffectWanted: true, out var post)) throw post;
            return Task.FromResult(new AttachThreadResult(threadId));
        }
    }

    public Task<AttachReplyResult> AttachReplyAsync(PrReference reference, string pendingReviewId, string parentThreadId, string replyBody, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        lock (_gate)
        {
            if (TryTakeFailure(nameof(AttachReplyAsync), afterEffectWanted: false, out var pre)) throw pre;
            var pending = RequirePending(reference);
            var thread = pending.Threads.FirstOrDefault(t => string.Equals(t.Id, parentThreadId, StringComparison.Ordinal))
                ?? throw new HttpRequestException($"NOT_FOUND: parent thread {parentThreadId}");
            var commentId = $"PRRC_{_nextId++}";
            thread.Replies.Add(new FakeComment(commentId, replyBody ?? ""));
            _attachReplyCallCount++;
            if (TryTakeFailure(nameof(AttachReplyAsync), afterEffectWanted: true, out var post)) throw post;
            return Task.FromResult(new AttachReplyResult(commentId));
        }
    }

    public Task FinalizePendingReviewAsync(PrReference reference, string pendingReviewId, SubmitEvent verdict, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        lock (_gate)
        {
            if (TryTakeFailure(nameof(FinalizePendingReviewAsync), afterEffectWanted: false, out var pre)) throw pre;
            _pendingByRef.Remove(Key(reference));  // submitted → no longer pending
            if (TryTakeFailure(nameof(FinalizePendingReviewAsync), afterEffectWanted: true, out var post)) throw post;
            return Task.CompletedTask;
        }
    }

    public Task DeletePendingReviewAsync(PrReference reference, string pendingReviewId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        lock (_gate)
        {
            if (TryTakeFailure(nameof(DeletePendingReviewAsync), afterEffectWanted: false, out var pre)) throw pre;
            _pendingByRef.Remove(Key(reference));
            if (TryTakeFailure(nameof(DeletePendingReviewAsync), afterEffectWanted: true, out var post)) throw post;
            return Task.CompletedTask;
        }
    }

    public Task DeletePendingReviewThreadAsync(PrReference reference, string pullRequestReviewThreadId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        lock (_gate)
        {
            if (TryTakeFailure(nameof(DeletePendingReviewThreadAsync), afterEffectWanted: false, out var pre)) throw pre;
            if (_pendingByRef.TryGetValue(Key(reference), out var pending))
                pending.Threads.RemoveAll(t => string.Equals(t.Id, pullRequestReviewThreadId, StringComparison.Ordinal));
            _deleteThreadCallCount++;
            if (TryTakeFailure(nameof(DeletePendingReviewThreadAsync), afterEffectWanted: true, out var post)) throw post;
            return Task.CompletedTask;
        }
    }

    public Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(PrReference reference, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        lock (_gate)
        {
            if (TryTakeFailure(nameof(FindOwnPendingReviewAsync), afterEffectWanted: false, out var pre)) throw pre;
            _findOwnCallCount++;
            if (_findOwnCallCount >= _findOwnReturnsNullFromCall)
                return Task.FromResult<OwnPendingReviewSnapshot?>(null);  // simulate the list query lagging
            if (!_pendingByRef.TryGetValue(Key(reference), out var pending))
                return Task.FromResult<OwnPendingReviewSnapshot?>(null);

            var threads = pending.Threads.Select(t => new PendingReviewThreadSnapshot(
                    PullRequestReviewThreadId: t.Id,
                    FilePath: t.FilePath,
                    LineNumber: t.LineNumber,
                    Side: t.Side,
                    OriginalCommitOid: t.CommitOid,
                    OriginalLineContent: "",   // matches the GitHub adapter — PR5's Resume enriches it (R7)
                    IsResolved: t.IsResolved,
                    BodyMarkdown: t.Body,
                    CreatedAt: t.CreatedAt,
                    Comments: t.Replies.Select(r => new PendingReviewCommentSnapshot(r.Id, r.Body)).ToList()))
                .ToList();

            return Task.FromResult<OwnPendingReviewSnapshot?>(new OwnPendingReviewSnapshot(
                pending.Id, pending.CommitOid, pending.CreatedAt, threads));
        }
    }

    // ----- helpers -----

    private FakePendingReview RequirePending(PrReference reference)
        => _pendingByRef.TryGetValue(Key(reference), out var p)
            ? p
            : throw new HttpRequestException($"NOT_FOUND: no pending review on {reference}");

    // Caller holds _gate. Returns true (and the exception) iff a one-shot failure is registered for
    // `methodName` whose afterEffect flag equals `afterEffectWanted`; consumes it.
    private bool TryTakeFailure(string methodName, bool afterEffectWanted, out Exception ex)
    {
        if (_failureByMethod.TryGetValue(methodName, out var entry) && entry.AfterEffect == afterEffectWanted)
        {
            _failureByMethod.Remove(methodName);
            ex = entry.Ex;
            return true;
        }
        ex = null!;
        return false;
    }

    private static string Key(PrReference r) => $"{r.Owner}/{r.Repo}/{r.Number}";

    // ----- in-memory model (the mutable side; the pipeline drives this) -----

    internal sealed class FakePendingReview
    {
        public string Id { get; }
        public string CommitOid { get; set; }   // settable — the stale-commitOID seed mutates it
        public DateTimeOffset CreatedAt { get; }
        public string SummaryBody { get; }
        public List<FakeThread> Threads { get; } = new();

        public FakePendingReview(string id, string commitOid, DateTimeOffset createdAt, string summaryBody)
        {
            Id = id;
            CommitOid = commitOid;
            CreatedAt = createdAt;
            SummaryBody = summaryBody;
        }
    }

    internal sealed record FakeThread(
        string Id, string FilePath, int LineNumber, string Side, string CommitOid,
        string Body, bool IsResolved, List<FakeComment> Replies, DateTimeOffset CreatedAt = default);

    internal sealed record FakeComment(string Id, string Body);

    // ----- introspection projections (returned by /test/submit/inspect-pending-review as JSON) -----

    internal sealed record FakeSubmitSnapshot(
        FakePendingReviewSnapshot? PendingReview,
        int AttachThreadCallCount,
        int AttachReplyCallCount,
        int DeleteThreadCallCount,
        int FindOwnCallCount);

    internal sealed record FakePendingReviewSnapshot(
        string PullRequestReviewId, string CommitOid, string SummaryBody,
        int ThreadCount, int ReplyCount, IReadOnlyList<FakeThreadSnapshot> Threads);

    internal sealed record FakeThreadSnapshot(
        string PullRequestReviewThreadId, string FilePath, int LineNumber, bool IsResolved, string Body,
        IReadOnlyList<FakeCommentSnapshot> Replies);

    internal sealed record FakeCommentSnapshot(string CommentId, string Body);
}
