namespace PRism.Core.Submit.Pipeline;

// The five steps of the SubmitPipeline state machine (spec § 5.2). Steps consult
// session.PendingReviewId / PendingReviewCommitOid and per-draft ThreadId / per-reply
// ReplyCommentId to decide what is already done versus what needs to run.
public enum SubmitStep
{
    DetectExistingPendingReview,
    BeginPendingReview,
    AttachThreads,
    AttachReplies,
    Finalize,
}

public enum SubmitStepStatus { Started, Succeeded, Failed }
