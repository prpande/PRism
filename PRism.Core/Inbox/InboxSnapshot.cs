using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public sealed record InboxSnapshot(
    IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> Sections,
    IReadOnlyDictionary<string, InboxItemEnrichment> Enrichments,
    DateTimeOffset LastRefreshedAt)
{
    public static InboxSnapshot Empty { get; } = new(
        new Dictionary<string, IReadOnlyList<PrInboxItem>>(),
        new Dictionary<string, InboxItemEnrichment>(),
        DateTimeOffset.MinValue);
}
