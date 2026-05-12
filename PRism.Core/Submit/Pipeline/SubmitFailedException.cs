using PRism.Core.State;

namespace PRism.Core.Submit.Pipeline;

/// <summary>
/// Raised by a <see cref="SubmitPipeline"/> step when its <see cref="IReviewSubmitter"/> call fails.
/// Carries the failed <see cref="SubmitStep"/> and the session as it stood at the failure (the step
/// has already overlay-persisted that session). It is caught exclusively by
/// <see cref="SubmitPipeline.SubmitAsync"/>, which translates it to <c>SubmitOutcome.Failed</c> —
/// it is not part of the pipeline's public contract and should not be caught by callers.
/// <see cref="Step"/> and <see cref="SessionAtFailure"/> are only meaningful on instances created
/// via the four-argument constructor (the standard exception constructors leave them at defaults).
/// </summary>
public sealed class SubmitFailedException : Exception
{
    public SubmitStep Step { get; }
    public ReviewSessionState? SessionAtFailure { get; }

    public SubmitFailedException()
        : base("A submit-pipeline step failed.")
    {
    }

    public SubmitFailedException(string message)
        : base(message)
    {
    }

    public SubmitFailedException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    public SubmitFailedException(SubmitStep step, string message, ReviewSessionState sessionAtFailure, Exception? inner = null)
        : base(message, inner)
    {
        Step = step;
        SessionAtFailure = sessionAtFailure;
    }
}
