namespace PRism.Core.Contracts;

/// <summary>Why a checks read was partial. None = complete; Auth = a 403; Transient = a 5xx/other non-2xx.
/// Precedence when sources disagree: Auth before Transient (the more specific, actionable cause).</summary>
public enum DegradedReason
{
    None,
    Auth,
    Transient,
}
