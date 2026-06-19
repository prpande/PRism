using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public sealed record InboxSnapshot(
    IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> Sections,
    IReadOnlyDictionary<string, InboxItemEnrichment> Enrichments,
    DateTimeOffset LastRefreshedAt,
    bool CiProbeComplete = true,
    IReadOnlySet<string>? AiEnrichmentSettled = null)
{
    /// PR-IDs whose AI inbox enrichment has settled — a chip arrived OR the model
    /// confidently produced none. Distinct from <see cref="Enrichments"/>: a
    /// settled-but-chip-less PR may be absent from (or null-valued in) Enrichments
    /// but present here, letting the frontend resolve its chip placeholder
    /// loading→empty instead of pulsing forever. Mirrors <see cref="CiProbeComplete"/>.
    /// Normalized to a non-null empty set so older call sites stay safe.
    public IReadOnlySet<string> AiEnrichmentSettled { get; init; } =
        AiEnrichmentSettled ?? new HashSet<string>(StringComparer.Ordinal);

    public static InboxSnapshot Empty { get; } = new(
        new Dictionary<string, IReadOnlyList<PrInboxItem>>(),
        new Dictionary<string, InboxItemEnrichment>(),
        DateTimeOffset.MinValue);
}
