namespace PRism.Core.Contracts;

/// <summary>Normalized terminal conclusion for a completed check. Kebab-case on the wire.</summary>
public enum CheckConclusion
{
    Success,
    Failure,
    Cancelled,
    TimedOut,
    Skipped,
    Neutral,
    ActionRequired,
    Stale,
    StartupFailure,
}
