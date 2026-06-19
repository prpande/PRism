using PRism.AI.Contracts.Provider;

namespace PRism.AI.Contracts.Noop;

/// <summary>The dark default <see cref="IStreamingLlmProvider"/> — sessions do nothing. Replaced by
/// the real Claude Code streaming provider once P0-1b Slice 2 lands (registered earlier in
/// <c>AddPrismClaudeCode</c>, so the <c>TryAdd</c> default in
/// <see cref="ServiceCollectionExtensions.AddStreamingProviderDefault"/> no-ops).</summary>
public sealed class NoopStreamingLlmProvider : IStreamingLlmProvider
{
    public IStreamingLlmSession StartSession(StreamingSessionOptions options) => new NoopStreamingLlmSession();
}

/// <summary>A no-op streaming session: emits no events, ends cleanly with a stable id.</summary>
internal sealed class NoopStreamingLlmSession : IStreamingLlmSession
{
    private const string NoopSessionId = "noop-session";

    private static readonly Task<SessionEndState> CleanEnd =
        Task.FromResult(new SessionEndState(LastTurnEndedCleanly: true, ProviderSessionId: NoopSessionId));

    public string ProviderSessionId => NoopSessionId;

    public Task SendUserTurnAsync(string content, CancellationToken ct) => Task.CompletedTask;

    public IAsyncEnumerable<LlmEvent> Events => AsyncEnumerable.Empty<LlmEvent>();

    public Task<SessionEndState> EndCleanlyAsync(TimeSpan gracefulTimeout, CancellationToken ct) => CleanEnd;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
