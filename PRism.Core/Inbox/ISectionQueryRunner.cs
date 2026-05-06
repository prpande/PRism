namespace PRism.Core.Inbox;

public interface ISectionQueryRunner
{
    Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
        IReadOnlySet<string> visibleSectionIds,
        CancellationToken ct);
}
