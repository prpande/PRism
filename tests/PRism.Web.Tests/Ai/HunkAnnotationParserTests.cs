using System.Collections.Generic;
using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class HunkAnnotationParserTests
{
    // a flagged file with `hunkCount` hunks (bodies irrelevant to the parser — it only range-checks counts)
    private static FileChange File(string path, int hunkCount)
    {
        var hunks = new List<DiffHunk>();
        for (var i = 0; i < hunkCount; i++) hunks.Add(new DiffHunk(1, 1, 1, 1, $"@@ hunk {i} @@"));
        return new FileChange(path, FileChangeStatus.Modified, hunks);
    }

    private static IReadOnlyList<FileChange> Flagged(params FileChange[] files) => files;

    [Fact]
    public void Parses_valid_entries()
    {
        var ok = HunkAnnotationParser.TryParse(
            """[{"path":"a.cs","hunkIndex":0,"body":"Changes retry backoff.","tone":"heads-up"}]""",
            Flagged(File("a.cs", 2)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().ContainSingle();
        entries[0].Should().Be(new HunkAnnotation("a.cs", 0, "Changes retry backoff.", AnnotationTone.HeadsUp));
    }

    [Fact]
    public void Drops_unknown_path()
    {
        var ok = HunkAnnotationParser.TryParse(
            """[{"path":"ghost.cs","hunkIndex":0,"body":"x","tone":"calm"}]""",
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().BeEmpty();
    }

    [Fact]
    public void Drops_out_of_range_hunk_index()
    {
        var ok = HunkAnnotationParser.TryParse(
            """[{"path":"a.cs","hunkIndex":5,"body":"x","tone":"calm"}]""",
            Flagged(File("a.cs", 2)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().BeEmpty();
    }

    [Fact]
    public void Drops_unknown_tone()
    {
        var ok = HunkAnnotationParser.TryParse(
            """[{"path":"a.cs","hunkIndex":0,"body":"x","tone":"sarcastic"}]""",
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().BeEmpty();
    }

    [Fact]
    public void Drops_empty_body()
    {
        var ok = HunkAnnotationParser.TryParse(
            """[{"path":"a.cs","hunkIndex":0,"body":"   ","tone":"calm"}]""",
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().BeEmpty();
    }

    [Fact]
    public void Drops_over_length_body()
    {
        var huge = new string('x', HunkAnnotationParser.BodyCap + 1);
        var ok = HunkAnnotationParser.TryParse(
            $$"""[{"path":"a.cs","hunkIndex":0,"body":"{{huge}}","tone":"calm"}]""",
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().BeEmpty();
    }

    [Fact]
    public void Strips_control_and_bidi_chars_from_body()
    {
        // U+202E (RLO) is category Cf — a plain char.IsControl filter misses it. The cleaned body
        // must not contain it; the surrounding text survives.
        var ok = HunkAnnotationParser.TryParse(
            "[{\"path\":\"a.cs\",\"hunkIndex\":0,\"body\":\"safe\\u202Etext\",\"tone\":\"calm\"}]",
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().ContainSingle();
        entries[0].Body.Should().Be("safetext"); // RLO stripped (asserting the clean result, no literal-char compare)
    }

    [Fact]
    public void Strips_arabic_letter_mark_u061c_from_body()
    {
        // U+061C (ARABIC LETTER MARK) is category Cf and a bidi control char the spec's original strip set
        // missed (ce-doc-review, security-lens). It must be stripped like the other directional-formatting chars.
        var ok = HunkAnnotationParser.TryParse(
            "[{\"path\":\"a.cs\",\"hunkIndex\":0,\"body\":\"safe\\u061Ctext\",\"tone\":\"calm\"}]",
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().ContainSingle();
        entries[0].Body.Should().Be("safetext");
    }

    [Fact]
    public void Body_that_is_only_bidi_or_control_is_dropped_as_empty()
    {
        var ok = HunkAnnotationParser.TryParse(
            "[{\"path\":\"a.cs\",\"hunkIndex\":0,\"body\":\"\\u202E\\u2066\",\"tone\":\"calm\"}]",
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().BeEmpty(); // empty after strip → dropped
    }

    [Fact]
    public void Dedups_last_wins_on_path_hunkindex_body()
    {
        // identical (path, hunkIndex, body), different tone → one entry with the LAST tone.
        var ok = HunkAnnotationParser.TryParse(
            """
            [{"path":"a.cs","hunkIndex":0,"body":"same","tone":"calm"},
             {"path":"a.cs","hunkIndex":0,"body":"same","tone":"concern"}]
            """,
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().ContainSingle();
        entries[0].Tone.Should().Be(AnnotationTone.Concern);
    }

    [Fact]
    public void Different_bodies_for_same_hunk_both_survive()
    {
        // Documents the dedup-key-includes-body contract (claude[bot] PR #482 #4): two DIFFERENT bodies for
        // the same (path, hunkIndex) are NOT deduped — both survive, bounded only by the cap backstop.
        var ok = HunkAnnotationParser.TryParse(
            """
            [{"path":"a.cs","hunkIndex":0,"body":"first take","tone":"calm"},
             {"path":"a.cs","hunkIndex":0,"body":"second take","tone":"concern"}]
            """,
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().HaveCount(2);
        entries.Should().Contain(e => e.Body == "first take");
        entries.Should().Contain(e => e.Body == "second take");
    }

    [Fact]
    public void Caps_to_first_n_in_emitted_order()
    {
        // model misbehaves and emits 3 valid entries with cap = 2 → keep the FIRST 2 in emitted order.
        var ok = HunkAnnotationParser.TryParse(
            """
            [{"path":"a.cs","hunkIndex":0,"body":"first","tone":"calm"},
             {"path":"a.cs","hunkIndex":1,"body":"second","tone":"calm"},
             {"path":"a.cs","hunkIndex":2,"body":"third","tone":"calm"}]
            """,
            Flagged(File("a.cs", 3)), cap: 2, out var entries);

        ok.Should().BeTrue();
        entries.Should().HaveCount(2);
        entries[0].Body.Should().Be("first");
        entries[1].Body.Should().Be("second");
    }

    [Fact]
    public void Lenient_extraction_tolerates_leading_prose_and_fences()
    {
        var ok = HunkAnnotationParser.TryParse(
            "Here are the annotations:\n```json\n[{\"path\":\"a.cs\",\"hunkIndex\":0,\"body\":\"x\",\"tone\":\"calm\"}]\n```",
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();
        entries.Should().ContainSingle();
    }

    [Fact]
    public void Unparseable_returns_false()
    {
        var ok = HunkAnnotationParser.TryParse(
            "not json at all", Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeFalse();
        entries.Should().BeEmpty();
    }

    [Fact]
    public void Parsed_but_all_invalid_returns_true_with_empty_list()
    {
        var ok = HunkAnnotationParser.TryParse(
            """[{"path":"ghost.cs","hunkIndex":0,"body":"x","tone":"calm"}]""",
            Flagged(File("a.cs", 1)), cap: 10, out var entries);

        ok.Should().BeTrue();   // structurally a JSON array → not a parse failure
        entries.Should().BeEmpty();
    }
}
