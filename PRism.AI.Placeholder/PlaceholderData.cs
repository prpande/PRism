using PRism.AI.Contracts.Dtos;

namespace PRism.AI.Placeholder;

internal static class PlaceholderData
{
    public const string SummaryBody =
        "Refactors the Calc utilities to consolidate validation logic, simplifies error mapping, " +
        "and tightens partial-failure semantics. Behavior is preserved; tests added for the new " +
        "boundary cases.";

    public const string SummaryCategory = "Refactor";

    public static IReadOnlyList<FileFocus> FileFocus { get; } = new[]
    {
        new FileFocus("src/Calc.cs", FocusLevel.High),
    };

    public static IReadOnlyList<HunkAnnotation> HunkAnnotations { get; } = new[]
    {
        new HunkAnnotation("src/Calc.cs", 0, "Reads cleaner — same behavior.", AnnotationTone.Calm),
    };

    public static IReadOnlyList<DraftSuggestion> DraftSuggestions { get; } = new[]
    {
        // Anchor at the stale-draft fixture's (filePath, lineNumber) from
        // FakeReviewBackingStore so the suggestion renders on the existing
        // stale-draft row. Line 3 = the `Add` method body in Calc.cs
        // (confirmed via setupAndOpenHandoffParityFixtureWithStaleDraft in
        // frontend/e2e/helpers/parity-fixture.ts and s4-reconciliation-fires.spec.ts).
        new DraftSuggestion("src/Calc.cs", 3,
            "Worth a comment on the validation here?"),
    };

    public static ValidatorReport Validator { get; } = new(new ValidatorFinding[]
    {
        new("info", "Verdict matches comment severity"),
        new("info", "No drafts left in stale state"),
        new("warn", "Heads-up about partial-failure tests."),
    });
}
