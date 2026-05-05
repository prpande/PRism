namespace PRism.Core.Contracts;

public sealed record DiffHunk(int OldStart, int OldLines, int NewStart, int NewLines, string Body);
