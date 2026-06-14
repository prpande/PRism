namespace PRism.AI.Contracts.Provider;

/// <summary>
/// Sustained, multi-turn streaming LLM session factory — the v3 counterpart to the one-shot
/// <see cref="ILlmProvider"/>. v2 ships one impl (Claude Code, P0-1b Slice 2); the dark default is
/// <see cref="Noop.NoopStreamingLlmProvider"/>. Provider identity lives on the
/// <see cref="ProviderCapabilityDescriptor"/>, not here (mirrors <see cref="ILlmProvider"/>, which
/// also carries no <c>ProviderId</c>).
/// </summary>
public interface IStreamingLlmProvider
{
    /// <summary>Open a new streaming session. The session spawns/initializes lazily; the returned
    /// handle is driven via <see cref="IStreamingLlmSession.SendUserTurnAsync"/> and read via
    /// <see cref="IStreamingLlmSession.Events"/>.</summary>
    IStreamingLlmSession StartSession(StreamingSessionOptions options);
}
