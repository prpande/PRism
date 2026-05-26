namespace PRism.Core.Events;

// Global identity-change event: published when /api/auth/replace swaps to a PAT
// whose login differs from the prior login. Carries account key + login names
// for forensic reconstruction. No PrRef because this is global, not per-PR.
// SseChannel.OnIdentityChanged fans out to every connected subscriber via
// SseEventProjection's identity-changed arm. The wire frame is `event: identity-changed`
// with minimal payload `{ "type": "identity-change" }` — login fields stay
// server-side (spec § 3.2.1 wire-shape rationale).
public sealed record IdentityChanged(
    string AccountKey,
    string PriorLogin,
    string NewLogin) : IReviewEvent;
