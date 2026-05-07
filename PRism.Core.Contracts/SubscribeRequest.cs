namespace PRism.Core.Contracts;

// Body shape for POST /api/events/subscriptions. SubscriberId is NOT in the body —
// it is derived from the requesting cookie session inside the endpoint handler. See
// spec § 6.2 trust-model paragraph for the cross-tab forge-attack rationale.
public sealed record SubscribeRequest(PrReference PrRef);
