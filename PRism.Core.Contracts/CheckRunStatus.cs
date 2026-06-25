namespace PRism.Core.Contracts;

/// <summary>Normalized check status. Kebab-case on the wire (queued | in-progress | completed).</summary>
public enum CheckRunStatus
{
    Queued,
    InProgress,
    Completed,
}
