using FluentAssertions;
using PRism.AI.Contracts.Dtos;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class FileFocusParserTests
{
    private static readonly IReadOnlyList<string> Changed = new[] { "a.cs", "b.cs", "c.cs" };

    [Fact]
    public void Parses_a_clean_json_array()
    {
        var text = """
                   [{"path":"a.cs","score":"high","rationale":"core logic"},
                    {"path":"b.cs","score":"low","rationale":"formatting"}]
                   """;
        var ok = FileFocusParser.TryParse(text, Changed, out var entries);
        ok.Should().BeTrue();
        entries.Should().Contain(e => e.Path == "a.cs" && e.Level == FocusLevel.High && e.Rationale == "core logic");
        entries.Should().Contain(e => e.Path == "b.cs" && e.Level == FocusLevel.Low);
    }

    [Fact]
    public void Tolerates_fenced_and_prose_wrapped_json()
    {
        var text = "Here is the ranking:\n```json\n[{\"path\":\"a.cs\",\"score\":\"medium\",\"rationale\":\"x\"}]\n```\nDone.";
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        entries.Should().ContainSingle().Which.Path.Should().Be("a.cs");
    }

    [Fact]
    public void Tolerates_brackets_in_surrounding_prose_and_in_string_values()
    {
        // brackets before the array, a ']' inside a rationale value, and brackets after — the naive
        // first-'[' to last-']' span would mis-slice; the balanced scan must isolate the real array.
        var text = "Files [a.cs, b.cs] ranked:\n" +
                   "[{\"path\":\"a.cs\",\"score\":\"high\",\"rationale\":\"see line [42] in the body\"}]\n" +
                   "(done [end])";
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        entries.Single(e => e.Path == "a.cs").Level.Should().Be(FocusLevel.High);
        entries.Single(e => e.Path == "a.cs").Rationale.Should().Contain("[42]");
    }

    [Fact]
    public void Drops_unknown_paths_never_invents()
    {
        var text = """[{"path":"ghost.cs","score":"high","rationale":"nope"}]""";
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        entries.Should().NotContain(e => e.Path == "ghost.cs");
    }

    [Fact]
    public void Normalizes_case_and_drops_invalid_scores()
    {
        var text = """
                   [{"path":"a.cs","score":"HIGH","rationale":"x"},
                    {"path":"b.cs","score":"banana","rationale":"y"}]
                   """;
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        entries.Should().Contain(e => e.Path == "a.cs" && e.Level == FocusLevel.High);
        entries.Should().NotContain(e => e.Path == "b.cs"); // invalid score dropped → backfilled by caller
    }

    [Fact]
    public void Duplicate_path_last_valid_entry_wins()
    {
        var text = """
                   [{"path":"a.cs","score":"low","rationale":"first"},
                    {"path":"a.cs","score":"high","rationale":"second"}]
                   """;
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        entries.Single(e => e.Path == "a.cs").Level.Should().Be(FocusLevel.High);
        entries.Single(e => e.Path == "a.cs").Rationale.Should().Be("second");
    }

    [Fact]
    public void Caps_rationale_at_the_cap_with_ellipsis()
    {
        // The cap is a runaway-output backstop, not the expected case: owner live-validation (2026-06-14)
        // raised it from 160 → a multi-sentence budget so the Hotspots tab can show the full narrative.
        // The test asserts against the constant so it stays correct as the cap is tuned.
        var longText = new string('x', FileFocusParser.RationaleCap + 200);
        var text = $$"""[{"path":"a.cs","score":"high","rationale":"{{longText}}"}]""";
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        var r = entries.Single(e => e.Path == "a.cs").Rationale;
        r.Length.Should().BeLessThanOrEqualTo(FileFocusParser.RationaleCap);
        r.Should().EndWith("…");
    }

    [Fact]
    public void Keeps_a_multi_sentence_rationale_intact()
    {
        // Regression for the owner-reported truncation: a normal 1-3 sentence rationale (well under the cap)
        // must survive verbatim — no clipping, no trailing ellipsis — so the reviewer sees the whole narrative.
        var narrative =
            "Public API wire shape: adds nine new fields to a paginated response. "
            + "A naming, nullability, or default-value mistake here is a breaking change for every consumer. "
            + "Confirm the IsAddon filter and IncludeAddOns enrichment are not conflated.";
        var text = $$"""[{"path":"a.cs","score":"high","rationale":"{{narrative}}"}]""";
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        entries.Single(e => e.Path == "a.cs").Rationale.Should().Be(narrative);
    }

    [Fact]
    public void Empty_or_whitespace_rationale_keeps_entry_with_empty_string()
    {
        var text = """[{"path":"a.cs","score":"high","rationale":"   "}]""";
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        entries.Single(e => e.Path == "a.cs").Rationale.Should().BeEmpty();
    }

    [Fact]
    public void Returns_false_on_non_array_or_unparseable()
    {
        FileFocusParser.TryParse("not json at all", Changed, out _).Should().BeFalse();
        FileFocusParser.TryParse("""{"path":"a.cs"}""", Changed, out _).Should().BeFalse(); // object, not array
        FileFocusParser.TryParse("[]", Changed, out var empty).Should().BeTrue(); // valid empty array → caller backfills
        empty.Should().BeEmpty();
    }

    [Fact]
    public void Pathological_all_unmatched_brackets_returns_false_quickly()
    {
        // A long run of unmatched '[' is the worst-case O(n²) input for the old unbounded scan:
        // each '[' triggers a depth-walk to end-of-string with no matching ']', then the scan
        // restarts one character further. With MaxRestarts=32 and MaxScanChars=64 KB the method
        // must bail out well before scanning a multi-MB string.
        var junk = new string('[', JsonArrayExtractor.MaxScanChars + 10_000);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var result = FileFocusParser.TryParse(junk, Changed, out _);
        sw.Stop();
        result.Should().BeFalse("no balanced JSON array exists in the pathological input");
        sw.ElapsedMilliseconds.Should().BeLessThan(500,
            "the bounded scan must return quickly on pathological input (MaxScanChars + MaxRestarts guard)");
    }

    [Fact]
    public void Backfill_adds_medium_for_absent_paths_only_never_overwrites()
    {
        var parsed = new List<FileFocus> { new("a.cs", FocusLevel.High, "core") };
        var full = FileFocusParser.BackfillAbsent(parsed, Changed);
        full.Single(e => e.Path == "a.cs").Level.Should().Be(FocusLevel.High); // untouched
        full.Single(e => e.Path == "b.cs").Level.Should().Be(FocusLevel.Medium);
        full.Single(e => e.Path == "b.cs").Rationale.Should().Be("Not individually ranked.");
        full.Should().HaveCount(3);
    }

    [Fact]
    public void AllMedium_builds_fallback_for_every_changed_file()
    {
        var fb = FileFocusParser.AllMedium(Changed);
        fb.Should().HaveCount(3);
        fb.Should().OnlyContain(e => e.Level == FocusLevel.Medium
            && e.Rationale == "Automatic fallback — ranking unavailable.");
    }

    [Fact]
    public void Strips_bidi_override_chars_from_rationale_keeps_text()
    {
        // The rationale renders as markdown on the Hotspots tab, so it runs the same bidi/control-char
        // strip the hunk annotator does (#465). U+202E (RLO) is a Cf char char.IsControl misses.
        // \\u202E in the C# literal is a JSON \u escape — no literal invisible char in this source file.
        var text = "[{\"path\":\"a.cs\",\"score\":\"high\",\"rationale\":\"safe\\u202Etext\"}]";
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        entries.Single(e => e.Path == "a.cs").Rationale.Should().Be("safetext");
    }

    [Fact]
    public void Preserves_newlines_in_rationale_so_markdown_structure_survives()
    {
        // Sanitizing must keep \n so a multi-bullet rationale renders as a real list, not one paragraph (#465).
        var text = "[{\"path\":\"a.cs\",\"score\":\"high\",\"rationale\":\"- one\\n- two\"}]";
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        entries.Single(e => e.Path == "a.cs").Rationale.Should().Be("- one\n- two");
    }

    [Fact]
    public void Caps_rationale_without_splitting_a_surrogate_pair()
    {
        // A non-BMP char (emoji = a UTF-16 surrogate pair) straddling the cut must not be split into a
        // dangling high surrogate (claude[bot] PR #518). 😀 is built from its code point so this source
        // file stays pure ASCII. Placed at UTF-16 indices cap-2 / cap-1 so the naive cut at cap-1 would
        // split it; the fix backs the cut off one unit, dropping the pair whole.
        var emoji = char.ConvertFromUtf32(0x1F600); // 😀 — high+low surrogate
        var head = new string('x', FileFocusParser.RationaleCap - 2);
        var rationale = head + emoji + new string('y', 50);
        var text = $$"""[{"path":"a.cs","score":"high","rationale":"{{rationale}}"}]""";
        FileFocusParser.TryParse(text, Changed, out var entries).Should().BeTrue();
        var r = entries.Single(e => e.Path == "a.cs").Rationale;
        r.Should().Be(head + "…");                       // pair dropped whole — no half character
        char.IsHighSurrogate(r[^2]).Should().BeFalse();  // char before the ellipsis is not a lone surrogate
        r.Length.Should().BeLessThanOrEqualTo(FileFocusParser.RationaleCap);
    }
}
