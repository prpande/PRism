using PRism.Core.Events;

namespace PRism.Web.Sse;

// Wire-shape projections — convert IReviewEvent records (which carry PrReference)
// into the JSON payload shape the frontend consumes (prRef as "owner/repo/number" string).
// Only the three new event types added in S4 PR3 use string-shaped prRef per spec § 4.5;
// existing pr-updated / inbox-updated continue to serialize the event record directly so
// their wire contract is unchanged.
internal static class SseEventProjection
{
    internal sealed record StateChangedWire(string PrRef, IReadOnlyList<string> FieldsTouched, string? SourceTabId);
    internal sealed record DraftSavedWire(string PrRef, string DraftId, string? SourceTabId);
    internal sealed record DraftDiscardedWire(string PrRef, string DraftId, string? SourceTabId);

    public static (string EventName, object Payload) Project(IReviewEvent evt) => evt switch
    {
        StateChanged e => ("state-changed", new StateChangedWire(e.PrRef.ToString(), e.FieldsTouched, e.SourceTabId)),
        DraftSaved e => ("draft-saved", new DraftSavedWire(e.PrRef.ToString(), e.DraftId, e.SourceTabId)),
        DraftDiscarded e => ("draft-discarded", new DraftDiscardedWire(e.PrRef.ToString(), e.DraftId, e.SourceTabId)),
        _ => throw new ArgumentOutOfRangeException(nameof(evt), $"No SSE projection for {evt.GetType().Name}")
    };
}
