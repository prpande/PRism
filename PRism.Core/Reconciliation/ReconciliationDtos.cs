using PRism.Core.State;

namespace PRism.Core.Reconciliation;

public sealed record ReconciliationResult(
    IReadOnlyList<ReconciledDraft> Drafts,
    IReadOnlyList<ReconciledReply> Replies,
    VerdictReconcileOutcome VerdictOutcome);

public sealed record ReconciledDraft(
    string Id,
    DraftStatus Status,
    string? ResolvedFilePath,
    int? ResolvedLineNumber,
    string? ResolvedAnchoredSha,
    int AlternateMatchCount,
    StaleReason? StaleReason,
    bool ForcePushFallbackTriggered,
    bool IsOverriddenStale);

public sealed record ReconciledReply(
    string Id,
    DraftStatus Status,
    StaleReason? StaleReason,
    bool IsOverriddenStale);

public enum StaleReason
{
    FileDeleted,
    NoMatch,
    ParentThreadDeleted,
    ForcePushAmbiguous
}

public enum VerdictReconcileOutcome { Unchanged, NeedsReconfirm }
