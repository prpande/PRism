namespace PRism.Core.State;

/// <summary>
/// Thrown by <see cref="AppStateStore.ResetToDefaultAsync"/> when the underlying
/// <c>state.json</c> file cannot be deleted (e.g., another process holds an exclusive
/// handle on it). Setup translates this into a recovery message — typically
/// "Close PRism in any other window and retry" — without losing the user's intent
/// to reset.
/// </summary>
public sealed class StateResetFailedException : Exception
{
    public StateResetFailedException()
        : base("Failed to reset state.json.")
    {
    }

    public StateResetFailedException(string message)
        : base(message)
    {
    }

    public StateResetFailedException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
