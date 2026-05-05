namespace PRism.Core.Contracts;

public sealed record InboxSection(string Id, string Label, IReadOnlyList<PrInboxItem> Items);
