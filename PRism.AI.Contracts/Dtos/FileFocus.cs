namespace PRism.AI.Contracts.Dtos;

public sealed record FileFocus(string Path, FocusLevel Level);

public enum FocusLevel
{
    High,
    Medium,
    Low,
}
