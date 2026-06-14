namespace PRism.AI.Contracts.Provider;

/// <summary>
/// One live streaming conversation. The caller drives turns with <see cref="SendUserTurnAsync"/> and
/// reads incremental output from <see cref="Events"/>. Disposal cancels any in-flight generation and
/// tears down the underlying session.
/// </summary>
public interface IStreamingLlmSession : IAsyncDisposable
{
    /// <summary>The underlying provider's session id — load-bearing for cross-restart resume
    /// (P0-1b Slice 3 pins the exact <c>--resume</c> semantics). TEMPORAL CONTRACT: it is populated
    /// from the provider's init event and is non-empty by the time the first caller-observable
    /// <see cref="Events"/> item of the first turn arrives. (A caller cannot observe the internal
    /// init read; the earliest it can read a guaranteed-valid id off this property is after that
    /// first <see cref="Events"/> item — which for a zero-delta turn is the terminal
    /// <see cref="LlmTurnComplete"/> — or, most simply, from <see cref="SessionEndState.ProviderSessionId"/>.)
    /// It is empty ONLY if the session never reached init (the process failed to start), which is
    /// always paired with <c>LastTurnEndedCleanly = false</c>; callers must not persist an empty id.</summary>
    string ProviderSessionId { get; }

    /// <summary>Submit one user turn. Turns are STRICTLY SEQUENTIAL: the session processes one turn
    /// at a time, so a caller MUST await the prior turn's <see cref="LlmTurnComplete"/> on
    /// <see cref="Events"/> before calling this again. Pipelined/concurrent turns are not supported.
    /// If called before the prior turn completes, the implementation throws
    /// <see cref="System.InvalidOperationException"/> SYNCHRONOUSLY (it does not return a faulted
    /// task), so the rejected content is guaranteed NOT enqueued and the session REMAINS USABLE — the
    /// caller may await the in-flight turn's <see cref="LlmTurnComplete"/> and retry. This is distinct
    /// from the unrecoverable-death throw on <see cref="Events"/>. The sequential model is what lets
    /// the un-tagged <see cref="Events"/> stream be unambiguous (see <see cref="Events"/>).</summary>
    Task SendUserTurnAsync(string content, CancellationToken ct);

    /// <summary>One event stream for the session's lifetime, in arrival order. Because turns are
    /// strictly sequential, every <see cref="LlmTextDelta"/> / <see cref="LlmToolUse"/> between two
    /// <see cref="LlmTurnComplete"/> events belongs to the turn opened by the most recent
    /// <see cref="SendUserTurnAsync"/>. TURN-TERMINATION INVARIANT: EVERY turn — including one that
    /// fails recoverably — ends with exactly one <see cref="LlmTurnComplete"/>; that is the consumer's
    /// turn-loop terminal condition. ERROR MODEL: throwing from enumeration is reserved for
    /// UNRECOVERABLE session death (e.g. the subprocess died) — it terminates the session (the
    /// provider chooses the exception type; the Claude Code impl throws its <c>LlmProviderException</c>,
    /// which this Contracts layer does not name). RECOVERABLE per-turn failures (a model/tool error
    /// that leaves the session usable) are deliberately NOT modeled in P0-1b Slice 1: they will arrive
    /// as an additional <em>informational</em> <see cref="LlmEvent"/> subtype defined empirically in
    /// Slice 2 that PRECEDES the turn's terminal <see cref="LlmTurnComplete"/> — it NEVER replaces it.
    /// So a consumer that ignores unrecognized subtypes (which it MUST, for forward-compat) still
    /// terminates the turn on <see cref="LlmTurnComplete"/> rather than hanging.
    /// CONSUMPTION: exactly one active consumer is assumed and the stream is single-pass —
    /// re-enumerating (starting a second <c>await foreach</c> over this property) is undefined; the
    /// real impl backs it with a single-reader channel, so a second consumer would steal events.</summary>
    IAsyncEnumerable<LlmEvent> Events { get; }

    /// <summary>End the session at a turn boundary: wait for the current turn's
    /// <see cref="LlmTurnComplete"/> (up to <paramref name="gracefulTimeout"/>), then signal the
    /// underlying session a clean exit and COMPLETE the <see cref="Events"/> enumeration (a concurrent
    /// reader's <c>await foreach</c> ends normally). It awaits session init first, so a cleanly ended
    /// session — EVEN ONE WITH ZERO TURNS SENT — returns a non-empty
    /// <see cref="SessionEndState.ProviderSessionId"/>. On a clean boundary returns
    /// <c>LastTurnEndedCleanly = true</c>; on timeout, or a session that never initialized, falls back
    /// to forced termination and returns <c>false</c> (then, and only then, the id may be empty). The
    /// boolean reports only that a clean turn boundary was reached — whether that makes the session
    /// resumable is provisional pending the Slice-3 <c>--resume</c> probe.
    /// <see cref="System.IAsyncDisposable.DisposeAsync"/> remains required after this call and is an
    /// idempotent no-op.</summary>
    Task<SessionEndState> EndCleanlyAsync(TimeSpan gracefulTimeout, CancellationToken ct);
}
