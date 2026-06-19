namespace PRism.AI.Contracts.Dtos;

// #525: GeneratedMaxChars carries the summary-character cap this summary was generated under, so the
// card can detect a summary produced under a now-stale cap and offer Regenerate. Additive + nullable:
// the real summarizer + the Preview placeholder stamp it; legacy/absent payloads (and any construction
// site that omits it) bind to null, which the staleness check treats as "never stale".
public sealed record PrSummary(string Body, string Category, int? GeneratedMaxChars = null);
