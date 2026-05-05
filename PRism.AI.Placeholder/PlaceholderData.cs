using PRism.AI.Contracts.Dtos;

namespace PRism.AI.Placeholder;

internal static class PlaceholderData
{
    public const string SummaryBody =
        "Refactors LeaseRenewalProcessor to consolidate retry logic, simplifies error mapping, " +
        "and tightens partial-failure semantics. Behavior is preserved; tests added for the new " +
        "boundary cases.";

    public const string SummaryCategory = "Refactor";

    public static IReadOnlyList<FileFocus> FileFocus { get; } = new[]
    {
        new FileFocus("services/leases/LeaseRenewalProcessor.cs", FocusLevel.High),
        new FileFocus("services/leases/RenewalRetryPolicy.cs", FocusLevel.Medium),
    };

    public static IReadOnlyList<HunkAnnotation> HunkAnnotations { get; } = new[]
    {
        new HunkAnnotation("services/leases/LeaseRenewalProcessor.cs", 0, "Reads cleaner - same behavior.", AnnotationTone.Calm),
        new HunkAnnotation("services/leases/LeaseRenewalProcessor.cs", 2, "Heads-up: failure semantics changed.", AnnotationTone.HeadsUp),
    };

    public static ValidatorReport Validator { get; } = new(new ValidatorFinding[]
    {
        new("info", "Verdict matches comment severity"),
        new("info", "No drafts left in stale state"),
        new("warn", "Heads-up about partial-failure tests."),
    });

    public static InboxEnrichment Enrichment { get; } = new("Refactor", "LeaseRenewalProcessor cleanup.");
}
