namespace PRism.AI.Contracts.Dtos;

public sealed record DraftSuggestion(string FilePath, int LineNumber, string Body);
