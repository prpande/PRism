namespace PRism.AI.Contracts.Dtos;

public sealed record ValidatorReport(IReadOnlyList<ValidatorFinding> Findings);

public sealed record ValidatorFinding(string Severity, string Message);
