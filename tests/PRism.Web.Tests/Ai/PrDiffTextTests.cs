using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class PrDiffTextTests
{
    [Fact]
    public void Render_IncludesFilePaths_AndHunkBodies()
    {
        // DiffHunk ctor: (int OldStart, int OldLines, int NewStart, int NewLines, string Body)
        // — no Header field; the @@ line is synthesized by PrDiffText.Render.
        var hunk = new DiffHunk(1, 2, 1, 3, "+added line\n-removed line");
        var file = new FileChange("src/poller.cs", FileChangeStatus.Modified, new[] { hunk });
        var dto = new DiffDto("base..head", new[] { file }, Truncated: false);

        var text = PrDiffText.Render(dto);

        text.Should().Contain("src/poller.cs");
        text.Should().Contain("+added line");
        text.Should().Contain("-removed line");
        text.Should().NotContain("FileChange {");   // never the record's synthesized ToString
    }

    [Fact]
    public void Render_SynthesizesAtAtHeader()
    {
        var hunk = new DiffHunk(5, 3, 5, 4, "+new line");
        var file = new FileChange("src/foo.cs", FileChangeStatus.Added, new[] { hunk });
        var dto = new DiffDto("a..b", new[] { file }, Truncated: false);

        var text = PrDiffText.Render(dto);

        // @@ -5,3 +5,4 @@ is synthesized from the numeric fields
        text.Should().Contain("@@ -5,3 +5,4 @@");
    }

    [Fact]
    public void Render_Truncated_AppendsTruncatedMarker()
    {
        var dto = new DiffDto("a..b", Array.Empty<FileChange>(), Truncated: true);

        var text = PrDiffText.Render(dto);

        text.Should().Contain("[diff truncated]");
    }

    [Fact]
    public void Render_NoTruncated_NoMarker()
    {
        var dto = new DiffDto("a..b", Array.Empty<FileChange>(), Truncated: false);

        var text = PrDiffText.Render(dto);

        text.Should().NotContain("[diff truncated]");
    }
}
