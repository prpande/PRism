using FluentAssertions;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class AiTextSanitizerTests
{
    // Code points are built from hex so this source file carries no literal invisible character —
    // an editor that silently drops zero-width chars cannot disarm these test inputs (#465).
    private static string Ch(int codePoint) => ((char)codePoint).ToString();

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void NullOrEmpty_ReturnsEmpty(string? input)
        => AiTextSanitizer.StripDangerous(input).Should().BeEmpty();

    [Fact]
    public void CleanText_PassesThroughUnchanged()
        => AiTextSanitizer.StripDangerous("Plain markdown: `code`, **bold**, [link](x).")
            .Should().Be("Plain markdown: `code`, **bold**, [link](x).");

    [Fact]
    public void PreservesWhitespaceControls_NewlineCarriageReturnTab()
        => AiTextSanitizer.StripDangerous("- one\n- two\r\n\tindented")
            .Should().Be("- one\n- two\r\n\tindented");

    [Fact]
    public void StripsOtherCcControlChars()
    {
        // U+0000 NUL and U+0007 BEL are category Cc but not whitespace → stripped.
        AiTextSanitizer.StripDangerous($"a{Ch(0x0000)}b{Ch(0x0007)}c").Should().Be("abc");
    }

    [Theory]
    [InlineData(0x061C)] // ALM (Arabic Letter Mark)
    [InlineData(0x200E)] // LRM
    [InlineData(0x200F)] // RLM
    [InlineData(0x202A)] // LRE
    [InlineData(0x202B)] // RLE
    [InlineData(0x202C)] // PDF
    [InlineData(0x202D)] // LRO
    [InlineData(0x202E)] // RLO
    [InlineData(0x2066)] // LRI
    [InlineData(0x2067)] // RLI
    [InlineData(0x2068)] // FSI
    [InlineData(0x2069)] // PDI
    public void StripsBidiAndDirectionalFormattingChars(int codePoint)
        => AiTextSanitizer.StripDangerous($"safe{Ch(codePoint)}text").Should().Be("safetext");

    [Fact]
    public void StripsTextThatIsOnlyDangerousChars_ToEmpty()
        => AiTextSanitizer.StripDangerous($"{Ch(0x202E)}{Ch(0x2066)}").Should().BeEmpty();
}
