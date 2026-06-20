namespace PRism.AI.Contracts.Provider;

/// <summary>
/// One-shot LLM completion. The single abstraction every feature seam composes — no feature
/// names a concrete provider. v2 ships exactly one impl (ClaudeCodeLlmProvider); an
/// Anthropic-API / Ollama provider can register behind this seam later with no Core change.
/// A streaming/chat provider (v3) is deliberately NOT defined here.
/// </summary>
public interface ILlmProvider
{
    Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct);
}
