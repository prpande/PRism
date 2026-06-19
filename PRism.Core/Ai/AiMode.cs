// PRism.Core/Ai/AiMode.cs
namespace PRism.Core.Ai;

/// <summary>
/// The three AI modes (spec §4). Off = no AI (Noop seams); Preview = canned sample data
/// (Placeholder seams), unmistakably labeled; Live = real provider output, gated by the
/// availability probe. The migration target for the legacy <c>ui.aiPreview</c> bool
/// (true → Preview, false → Off). Serializes kebab ("off"/"preview"/"live") via the
/// registered <see cref="System.Text.Json.Serialization.JsonStringEnumConverter"/>.
/// </summary>
public enum AiMode
{
    Off,
    Preview,
    Live,
}
