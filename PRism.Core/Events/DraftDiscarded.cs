using PRism.Core.Contracts;

namespace PRism.Core.Events;

public sealed record DraftDiscarded(PrReference PrRef, string DraftId, string? SourceTabId) : IReviewEvent;
