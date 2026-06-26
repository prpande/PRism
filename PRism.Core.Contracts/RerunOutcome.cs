namespace PRism.Core.Contracts;

/// <summary>Outcome of a per-check re-run. Kebab-case on the wire
/// (accepted | auth | not-rerunnable | superseded | transient).</summary>
public enum RerunOutcome
{
    Accepted,       // rerequest sent (GitHub 2xx)
    Auth,           // GitHub 401 — couldn't authenticate
    NotRerunnable,  // GitHub 403/404/422 — not re-runnable or token lacks write access
    Superseded,     // SHA guard: the head advanced since the poll; no rerequest sent
    Transient,      // 5xx / network — retryable
}
