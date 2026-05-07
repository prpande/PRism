namespace PRism.Core.Contracts;

public enum FileContentStatus
{
    Ok,
    NotFound,
    TooLarge,
    Binary,
    NotInDiff,
}

public sealed record FileContentResult(
    FileContentStatus Status,
    string? Content,
    long ByteSize);
