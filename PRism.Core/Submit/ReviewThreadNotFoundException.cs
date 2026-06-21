namespace PRism.Core.Submit;

/// <summary>
/// Thrown by an <see cref="IReviewSubmitter"/> adapter when a reply's parent review thread no
/// longer exists on the pending review (its author deleted it on github.com between submit
/// attempts). A typed signal so the submit pipeline classifies "parent gone" by exception type
/// rather than by sniffing the adapter's message text — which previously matched only the
/// in-memory fake's "NOT_FOUND: parent thread …" string, not GitHub's GraphQL error shape.
/// </summary>
public sealed class ReviewThreadNotFoundException : Exception
{
    public ReviewThreadNotFoundException() { }
    public ReviewThreadNotFoundException(string message) : base(message) { }
    public ReviewThreadNotFoundException(string message, Exception innerException)
        : base(message, innerException) { }
}
