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
}
