namespace PRism.Core.Ai;

/// <summary>
/// Mutable, hot-reloaded singleton carrying the current <see cref="AiMode"/>. Read fresh on every
/// <see cref="AiSeamSelector.Resolve{T}"/> call so config flips take effect immediately. Replaces
/// the binary ai-preview holder. Seeded + synced from <c>ui.ai.mode</c> in AddPrismCore.
/// </summary>
public sealed class AiModeState
{
    public AiMode Mode { get; set; }
}
