using System.Text.RegularExpressions;

using PRism.Core.Submit.Pipeline;

namespace PRism.Core.Tests.Submit.Pipeline;

// Spec § 4 — marker injection lives in SubmitPipeline, not user-visible code. The marker is
// <!-- prism:client-id:<DraftId> --> appended after a "\n\n" separator, with any unclosed code
// fence re-closed first so the marker never lands inside a fenced block. Doc-review R10 pins the
// adversarial fence-detection cases (inline prose backticks, ~~~ alt-fences, quad-fences).
public class PipelineMarkerTests
{
    private static string CollapseWhitespace(string s) => Regex.Replace(s, @"\s+", " ");

    [Theory]
    [InlineData("simple body", "draft-1", "simple body\n\n<!-- prism:client-id:draft-1 -->")]
    [InlineData("", "d2", "\n\n<!-- prism:client-id:d2 -->")]
    [InlineData("ends with newline\n", "d3", "ends with newline\n\n\n<!-- prism:client-id:d3 -->")]
    public void Inject_AppendsMarkerWithSeparator(string body, string draftId, string expected)
    {
        Assert.Equal(expected, PipelineMarker.Inject(body, draftId));
    }

    [Fact]
    public void Inject_ClosesUnclosedFence_BeforeAppendingMarker()
    {
        var body = "intro\n```ts\nconst x = 1;\n";  // missing closing fence
        var result = PipelineMarker.Inject(body, "d4");
        Assert.Matches(@"```ts.*const x = 1;.*```.*<!-- prism:client-id:d4 -->", CollapseWhitespace(result));
    }

    [Fact]
    public void Inject_LeavesClosedFenceUntouched()
    {
        var body = "```ts\nconst x = 1;\n```";  // already closed
        var result = PipelineMarker.Inject(body, "d5");
        // opening + closing only — no spurious third fence injected.
        Assert.Equal(2, Regex.Count(result, @"```"));
        Assert.EndsWith("<!-- prism:client-id:d5 -->", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Extract_ReturnsDraftId_FromMarkerAtEnd()
    {
        var body = "body content\n\n<!-- prism:client-id:abc-123 -->";
        Assert.Equal("abc-123", PipelineMarker.Extract(body));
    }

    [Fact]
    public void Extract_ReturnsNull_WhenNoMarkerPresent()
    {
        Assert.Null(PipelineMarker.Extract("just a regular body"));
    }

    [Fact]
    public void Extract_ReturnsNull_OnMarkerInTheMiddleOfBody()
    {
        // The marker is meaningful only as a footer; mid-body matches are not adopted.
        var body = "<!-- prism:client-id:fake --> followed by more content";
        Assert.Null(PipelineMarker.Extract(body));
    }

    [Fact]
    public void ContainsMarkerPrefix_DetectsMarkerSubstringOutsideFences()
    {
        Assert.True(PipelineMarker.ContainsMarkerPrefix("some body with <!-- prism:client-id: inside"));
        Assert.False(PipelineMarker.ContainsMarkerPrefix("```\n<!-- prism:client-id: in fence\n```"));
        Assert.False(PipelineMarker.ContainsMarkerPrefix("~~~\n<!-- prism:client-id: in tilde fence\n~~~"));
        Assert.False(PipelineMarker.ContainsMarkerPrefix("no marker here"));
    }

    // --- Adversarial fence-detection cases (Doc-review revisions R10) ---
    // A bare `Regex.Matches(body, "```").Count` odd/even check has false positives:
    // an inline triple-backtick mention in prose, a ~~~ alt fence, or a quad-fence
    // wrapping a triple-backtick example all skew the count and would otherwise inject
    // a spurious closing fence mid-text. The fix tracks fence state line-by-line, only
    // counting lines whose first non-whitespace run is a fence opener.

    [Fact]
    public void Inject_DoesNotTreatInlineProseBacktickMentionAsAnOpenFence()
    {
        var body = "wrap the snippet in ``` so it renders as a block";
        var result = PipelineMarker.Inject(body, "d6");
        Assert.Equal(body + "\n\n<!-- prism:client-id:d6 -->", result);
    }

    [Fact]
    public void Inject_ClosesUnclosedTildeFence()
    {
        var body = "intro\n~~~\nplain text block\n";  // unclosed ~~~ fence
        var result = PipelineMarker.Inject(body, "d7");
        Assert.Matches(@"~~~.*plain text block.*~~~.*<!-- prism:client-id:d7 -->", CollapseWhitespace(result));
    }

    [Fact]
    public void Inject_TreatsQuadFenceAsBalanced_NotOddTriple()
    {
        // A ```` ... ```` block containing a literal ``` example line. Counting bare ```
        // runs would see 3 (odd) → spurious close; the real fence (````) is balanced.
        var body = "````\nhere is a ``` example\n````";
        var result = PipelineMarker.Inject(body, "d8");
        Assert.Equal(body + "\n\n<!-- prism:client-id:d8 -->", result);
    }

    [Fact]
    public void Inject_TreatsFourSpaceIndentedTripleBacktickAsIndentedCode_NotAFence()
    {
        // A line indented 4+ spaces is an *indented* code block per CommonMark, not a fence opener.
        // If Inject treated `    ```` ` as opening a fence, it would append a stray ``` at column 0
        // that itself opens an unclosed fenced block — swallowing the marker into rendered text.
        var body = "intro line\n    ```\n    code inside the indented block\n";
        var result = PipelineMarker.Inject(body, "d9");
        Assert.Equal(body + "\n\n<!-- prism:client-id:d9 -->", result);
    }

    // ---- StripIfPresent / StripAllMarkerPrefixes (S5 PR3 Resume import — R8) ----

    [Fact]
    public void StripIfPresent_RemovesTrailingEndMarkerAndPrecedingWhitespace()
    {
        Assert.Equal("thread body", PipelineMarker.StripIfPresent("thread body\n\n<!-- prism:client-id:olddraft -->"));
    }

    [Fact]
    public void StripIfPresent_LeavesAMarkerlessBodyUntouched()
    {
        Assert.Equal("plain body", PipelineMarker.StripIfPresent("plain body"));
    }

    [Fact]
    public void StripIfPresent_DoesNotTrimTrailingWhitespaceWhenNoEndMarkerIsPresent()
    {
        // The trailing-whitespace trim is the marker-separator cleanup — it must NOT run on a body
        // that has no marker, or it would silently mutate imported user content (Copilot review).
        Assert.Equal("plain body\n\n", PipelineMarker.StripIfPresent("plain body\n\n"));
        Assert.Equal("trailing spaces   ", PipelineMarker.StripIfPresent("trailing spaces   "));
    }

    [Fact]
    public void StripAllMarkerPrefixes_RemovesEmbeddedWellFormedMarkers()
    {
        var result = PipelineMarker.StripAllMarkerPrefixes("before <!-- prism:client-id:embedded --> after");
        Assert.False(PipelineMarker.ContainsMarkerPrefix(result));
        Assert.DoesNotContain("prism:client-id", result, StringComparison.Ordinal);
    }

    [Fact]
    public void StripAllMarkerPrefixes_RemovesABareUnclosedPrefixSubstring()
    {
        // A body containing only the prefix `<!-- prism:client-id:` (no closing ` -->`) — the
        // well-formed-marker regex doesn't match it, so the fallback bare-prefix replace must catch
        // it for R8's "ContainsMarkerPrefix(result) is false" guarantee to hold.
        var result = PipelineMarker.StripAllMarkerPrefixes("oops pasted <!-- prism:client-id: into prose");
        Assert.False(PipelineMarker.ContainsMarkerPrefix(result));
    }

    [Fact]
    public void StripAllMarkerPrefixes_LeavesAMarkerInsideAFenceAlone_ContainsMarkerPrefixWasAlreadyFalse()
    {
        // A marker inside a fenced block is not part of the adoption attack surface — ContainsMarkerPrefix
        // already returns false for it, and StripAllMarkerPrefixes still strips the literal text (the
        // regex doesn't track fences), which is harmless for an imported body.
        var body = "```\n<!-- prism:client-id:literal -->\n```";
        Assert.False(PipelineMarker.ContainsMarkerPrefix(body));
        Assert.False(PipelineMarker.ContainsMarkerPrefix(PipelineMarker.StripAllMarkerPrefixes(body)));
    }
}
