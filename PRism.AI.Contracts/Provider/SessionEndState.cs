namespace PRism.AI.Contracts.Provider;

/// <summary>The outcome of <see cref="IStreamingLlmSession.EndCleanlyAsync"/>.
/// <paramref name="LastTurnEndedCleanly"/> is <c>true</c> when a clean turn boundary was reached
/// (forced termination on timeout / never-initialized returns <c>false</c>).
/// <paramref name="ProviderSessionId"/> is the final session id — empty only when the session never
/// initialized, which is always paired with <c>LastTurnEndedCleanly = false</c>.</summary>
public sealed record SessionEndState(bool LastTurnEndedCleanly, string ProviderSessionId);
