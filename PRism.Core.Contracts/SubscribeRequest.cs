namespace PRism.Core.Contracts;

// Body shape for POST /api/events/subscriptions. PrRef is a slash-separated
// owner/repo/number string — the same format DELETE accepts via query-string
// and that pr-updated SSE events carry on the wire. The handler parses it via
// PrReferenceParser. SubscriberId is NOT in the body — it is derived from the
// requesting cookie session inside the endpoint handler. See spec § 6.2
// trust-model paragraph for the cross-tab forge-attack rationale.
public sealed record SubscribeRequest(string? PrRef);
