using PRism.Core.Contracts;

namespace PRism.Core.Events;

// Declared in S4 for forward-compat per spec § 4.4; published in S5 (no producer in S4).
// Note: NO SourceTabId field. The spec's wire-shape table only enumerates state-changed,
// draft-saved, draft-discarded — DraftSubmitted has no S4 wire shape; S5 will decide
// whether to add SourceTabId when it adds the publication path.
public sealed record DraftSubmitted(PrReference PrRef) : IReviewEvent;
