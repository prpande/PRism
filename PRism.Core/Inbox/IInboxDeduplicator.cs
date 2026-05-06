using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public interface IInboxDeduplicator
{
    IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> Deduplicate(
        IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> sectionsById,
        bool deduplicate);
}
