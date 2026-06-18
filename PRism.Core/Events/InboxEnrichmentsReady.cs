using PRism.Core.Inbox;

namespace PRism.Core.Events;

/// One enriched PR from a completed background batch. ContentToken is
/// InboxEnrichmentContent.Token(title, description) at enrichment time.
public sealed record InboxEnrichmentResult(string PrId, string? CategoryChip, string ContentToken);

/// Published by the inbox enricher when a background batch finishes. The orchestrator merges
/// these into the current snapshot under its writer-lock, skipping stale (token-mismatched) entries.
public sealed record InboxEnrichmentsReady(IReadOnlyList<InboxEnrichmentResult> Results) : IReviewEvent;
