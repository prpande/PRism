namespace PRism.Core.Contracts;

public sealed record DiffDto(
    string Range,
    IReadOnlyList<FileChange> Files,
    bool Truncated);
