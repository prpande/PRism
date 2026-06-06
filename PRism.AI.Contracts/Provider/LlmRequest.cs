namespace PRism.AI.Contracts.Provider;

/// <summary>
/// One-shot completion request. Provider-neutral: no CLI flags, no Anthropic specifics.
/// <paramref name="SystemPrompt"/> carries PRism's task framing; <paramref name="UserContent"/>
/// carries the (already sanitized) PR data. <paramref name="JsonSchema"/> is set for structured
/// seams and null for free-text ones.
/// </summary>
public sealed record LlmRequest(
    string SystemPrompt,
    string UserContent,
    string Model,
    string? JsonSchema = null);
