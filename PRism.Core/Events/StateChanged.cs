using PRism.Core.Contracts;

namespace PRism.Core.Events;

public sealed record StateChanged(
    PrReference PrRef,
    IReadOnlyList<string> FieldsTouched,
    string? SourceTabId) : IReviewEvent;
