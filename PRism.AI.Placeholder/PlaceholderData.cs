using PRism.AI.Contracts.Dtos;

namespace PRism.AI.Placeholder;

internal static class PlaceholderData
{
    // Short body shared with the #410 inbox enricher's hover summary — kept terse on purpose
    // (the inbox chip is a one-liner). Do NOT grow this; the PR-detail summary uses the grouped
    // sample below.
    public const string SummaryBody =
        "- Refactors the `Calc` utilities to tighten arithmetic boundary handling.\n" +
        "- Simplifies error mapping; behavior is preserved.\n" +
        "- Adds tests for the new boundary cases.";

    // #525: the PR-detail Preview summary reflects the new grouped shape — bullets grouped under `###`
    // subheadings — at a representative (~default-cap) length, so Preview demonstrates the format the Live
    // summarizer now targets. This is the reference shape for the B1 visual gate. It is a FIXED sample and
    // does NOT react to the configured cap value (D4).
    public const string SummaryBodyGrouped =
        "### What changed\n" +
        "- Refactors the `Calc` utilities to tighten arithmetic boundary handling.\n" +
        "- Extracts the overflow guard into a single `EnsureInRange` helper so the upper- and lower-bound checks share one path.\n" +
        "- Simplifies error mapping; externally observable behavior is preserved.\n\n" +
        "### Risk & review focus\n" +
        "- The new clamp on the upper bound is the highest-risk line — confirm it is inclusive and free of off-by-one error.\n" +
        "- Negative inputs now flow through the shared guard; verify they still throw rather than silently saturating.\n\n" +
        "### Tests\n" +
        "- Adds boundary cases for the new upper-bound and negative-input paths.";

    public const string SummaryCategory = "Refactor";

    public static IReadOnlyList<FileFocus> FileFocus { get; } = new[]
    {
        new FileFocus("src/Calc.cs", FocusLevel.High,
            "Boundary handling in core calc\n- Review the new clamp on the upper bound for off-by-one risk.\n- Confirm negative inputs still throw rather than silently saturating."),
        new FileFocus("src/Calc.Tests.cs", FocusLevel.Medium,
            "Tests for the changed boundary logic\n- Verify the new upper-bound and negative-input cases are actually asserted, not just exercised."),
    };

    public static IReadOnlyList<HunkAnnotation> HunkAnnotations { get; } = new[]
    {
        new HunkAnnotation("src/Calc.cs", 0,
            "- Reads cleaner — same behavior.\n- Guard still rejects overflow:\n\n```cs\nif (x > Max) throw;\n```",
            AnnotationTone.Calm),
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
