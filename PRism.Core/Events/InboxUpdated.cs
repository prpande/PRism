namespace PRism.Core.Events;

public sealed record InboxUpdated(
    IReadOnlyList<string> ChangedSectionIds,
    int NewOrUpdatedPrCount) : IReviewEvent;
