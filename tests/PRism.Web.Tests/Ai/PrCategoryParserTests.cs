using FluentAssertions;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class PrCategoryParserTests
{
    [Fact]
    public void ValidLeadingLine_ExtractsCategory_StripsLine()
    {
        var (body, category) = PrCategoryParser.Parse("CATEGORY: fix\nFixes the null deref in the poller.");
        category.Should().Be("fix");
        body.Should().Be("Fixes the null deref in the poller.");
    }

    [Fact]
    public void CaseInsensitive_AndTrimmed()
        => PrCategoryParser.Parse("category:  Refactor \nBody.").category.Should().Be("refactor");

    [Fact]
    public void OutOfEnum_FallsBackToEmpty_KeepsBody()
    {
        var (body, category) = PrCategoryParser.Parse("CATEGORY: sabotage\nBody text.");
        category.Should().Be("");
        body.Should().Be("Body text.");
    }

    [Fact]
    public void MissingLine_EmptyCategory_BodyUnchanged()
    {
        var (body, category) = PrCategoryParser.Parse("Just a summary, no category line.");
        category.Should().Be("");
        body.Should().Be("Just a summary, no category line.");
    }

    [Fact]
    public void ForgedSecondLine_Ignored_OnlyFirstLineConsidered()
    {
        var (body, category) = PrCategoryParser.Parse("CATEGORY: docs\nCATEGORY: revert\nBody.");
        category.Should().Be("docs");
        body.Should().Be("CATEGORY: revert\nBody.");
    }

    [Fact]
    public void StripsBidiOverrideChars_FromBody_KeepsText()
    {
        // The body renders as markdown on the AI summary card, so it runs the same bidi/control-char
        // strip every AI-markdown surface does (#465). Build U+202E (RLO) from its code point so this
        // source file carries no literal invisible character.
        var rlo = ((char)0x202E).ToString();
        var (body, category) = PrCategoryParser.Parse($"CATEGORY: fix\nBefore{rlo}After");
        category.Should().Be("fix");
        body.Should().Be("BeforeAfter");
    }

    [Fact]
    public void StripsBidiOverrideChars_FromBody_WhenNoCategoryLine()
    {
        var rlo = ((char)0x202E).ToString();
        var (body, category) = PrCategoryParser.Parse($"Plain summary{rlo} body.");
        category.Should().Be("");
        body.Should().Be("Plain summary body.");
    }

    [Fact]
    public void PreservesNewlines_InBody_SoMarkdownStructureSurvives()
    {
        // Sanitizing must keep \n so a bulleted summary renders as a real list, not one paragraph (#465).
        var (body, _) = PrCategoryParser.Parse("CATEGORY: fix\n- one\n- two");
        body.Should().Be("- one\n- two");
    }
}
