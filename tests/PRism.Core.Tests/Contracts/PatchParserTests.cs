using PRism.Core.Contracts;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Contracts;

// Parses GitHub's `patch` field (per-file unified diff) into DiffHunk[]. The
// frontend's parseHunkLines (DiffPane.tsx) consumes Body INCLUDING the @@
// header line, so each DiffHunk.Body must start with "@@ ...".
public class PatchParserTests
{
    [Fact]
    public void Parse_returns_empty_for_null_input()
    {
        PatchParser.Parse(null).Should().BeEmpty();
    }

    [Fact]
    public void Parse_returns_empty_for_empty_string()
    {
        PatchParser.Parse(string.Empty).Should().BeEmpty();
    }

    [Fact]
    public void Parse_returns_empty_when_patch_has_no_hunk_headers()
    {
        // Defensive: if GitHub ever sends content without @@ markers (e.g. a
        // binary-file rename with summary text), drop the whole thing rather
        // than emit a phantom hunk.
        PatchParser.Parse("Binary files differ").Should().BeEmpty();
    }

    [Fact]
    public void Parse_extracts_a_single_hunk_with_explicit_line_counts()
    {
        const string patch = "@@ -1,3 +1,4 @@\n line1\n+inserted\n line2\n line3";
        var hunks = PatchParser.Parse(patch);

        hunks.Should().HaveCount(1);
        var h = hunks[0];
        h.OldStart.Should().Be(1);
        h.OldLines.Should().Be(3);
        h.NewStart.Should().Be(1);
        h.NewLines.Should().Be(4);
        // Body MUST include the @@ header — the frontend parser reads the
        // header from Body, not from OldStart/NewStart.
        h.Body.Should().StartWith("@@ -1,3 +1,4 @@");
        h.Body.Should().Contain("+inserted");
    }

    [Fact]
    public void Parse_defaults_omitted_line_counts_to_one()
    {
        // Per unified-diff convention `@@ -10 +10 @@` means one line each.
        const string patch = "@@ -10 +10 @@\n-old\n+new";
        var hunks = PatchParser.Parse(patch);

        hunks.Should().HaveCount(1);
        hunks[0].OldStart.Should().Be(10);
        hunks[0].OldLines.Should().Be(1);
        hunks[0].NewStart.Should().Be(10);
        hunks[0].NewLines.Should().Be(1);
    }

    [Fact]
    public void Parse_handles_pure_insertion_with_zero_old_lines()
    {
        const string patch = "@@ -0,0 +1,3 @@\n+a\n+b\n+c";
        var hunks = PatchParser.Parse(patch);

        hunks.Should().HaveCount(1);
        hunks[0].OldStart.Should().Be(0);
        hunks[0].OldLines.Should().Be(0);
        hunks[0].NewStart.Should().Be(1);
        hunks[0].NewLines.Should().Be(3);
    }

    [Fact]
    public void Parse_handles_pure_deletion_with_zero_new_lines()
    {
        const string patch = "@@ -1,3 +0,0 @@\n-a\n-b\n-c";
        var hunks = PatchParser.Parse(patch);

        hunks.Should().HaveCount(1);
        hunks[0].OldLines.Should().Be(3);
        hunks[0].NewLines.Should().Be(0);
    }

    [Fact]
    public void Parse_splits_multiple_hunks_at_each_at_at_marker()
    {
        const string patch =
            "@@ -1,2 +1,2 @@\n line1\n-removed\n+added\n" +
            "@@ -10,2 +11,3 @@\n context\n+inserted\n more";
        var hunks = PatchParser.Parse(patch);

        hunks.Should().HaveCount(2);
        hunks[0].OldStart.Should().Be(1);
        hunks[0].Body.Should().StartWith("@@ -1,2 +1,2 @@");
        hunks[1].OldStart.Should().Be(10);
        hunks[1].NewStart.Should().Be(11);
        hunks[1].Body.Should().StartWith("@@ -10,2 +11,3 @@");
        hunks[1].Body.Should().Contain("+inserted");
        // Each hunk's body is independent — the second hunk's body must NOT
        // contain the first hunk's content.
        hunks[1].Body.Should().NotContain("line1");
    }

    [Fact]
    public void Parse_preserves_no_newline_at_end_of_file_marker()
    {
        // git emits `\ No newline at end of file` after a + or - line when
        // the file lacks a trailing newline. This is metadata, not content,
        // and must round-trip in Body so the frontend can render it.
        const string patch = "@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file";
        var hunks = PatchParser.Parse(patch);

        hunks.Should().HaveCount(1);
        hunks[0].Body.Should().Contain("\\ No newline at end of file");
    }

    [Fact]
    public void Parse_preserves_function_context_after_at_at_header()
    {
        // git emits the enclosing function/method name after the second @@
        // (e.g. "@@ -10,2 +10,2 @@ public void Foo()"). It's part of the
        // header line and must round-trip in Body verbatim.
        const string patch = "@@ -10,2 +10,2 @@ public void Foo()\n context\n+added";
        var hunks = PatchParser.Parse(patch);

        hunks.Should().HaveCount(1);
        hunks[0].Body.Should().StartWith("@@ -10,2 +10,2 @@ public void Foo()");
    }

    [Fact]
    public void Parse_skips_malformed_at_at_header_and_recovers_at_next_valid_one()
    {
        // Defensive: a malformed first hunk shouldn't blank the entire file's
        // diff. Drop the bad block and resume at the next valid header.
        const string patch =
            "@@ malformed @@\n random text\n" +
            "@@ -1,1 +1,1 @@\n-old\n+new";
        var hunks = PatchParser.Parse(patch);

        hunks.Should().HaveCount(1);
        hunks[0].OldStart.Should().Be(1);
        hunks[0].Body.Should().StartWith("@@ -1,1 +1,1 @@");
    }

    [Fact]
    public void Parse_does_not_swallow_at_at_inside_content_lines()
    {
        // A content line that happens to start with text containing "@@" is
        // safe — only lines whose first two chars are literally "@@" are
        // treated as headers. A context/insert/delete line starts with ' '
        // / '+' / '-' so this is naturally excluded.
        const string patch = "@@ -1,2 +1,2 @@\n+ // marker @@ inside string\n context";
        var hunks = PatchParser.Parse(patch);

        hunks.Should().HaveCount(1);
        hunks[0].Body.Should().Contain("+ // marker @@ inside string");
    }
}
