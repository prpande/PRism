using PRism.Core.Contracts;

namespace PRism.Core.Events;

public sealed record DraftSaved(PrReference PrRef, string DraftId, string? SourceTabId) : IReviewEvent;
