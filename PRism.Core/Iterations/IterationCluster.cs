namespace PRism.Core.Iterations;

public sealed record IterationCluster(
    int IterationNumber,
    string BeforeSha,
    string AfterSha,
    IReadOnlyList<string> CommitShas);
