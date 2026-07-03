using System.Text;
using FluentAssertions;
using PRism.AI.Contracts.Observability;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class AiInteractionLogReaderTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-reader-" + Guid.NewGuid().ToString("N"));
    private string LogPath => Path.Combine(_dir, "ai-interactions.log");

    public AiInteractionLogReaderTests() => Directory.CreateDirectory(_dir);

    // Mirrors JsonlAiInteractionLog's wire format: a leading "timestamp" then camelCase record fields.
    private static string Line(string timestampIso, string component, string outcome, string prRef,
        long? inputTokens = null) =>
        inputTokens is null
            ? $$"""{"timestamp":"{{timestampIso}}","component":"{{component}}","providerId":"claude-code","prRef":"{{prRef}}","outcome":"{{outcome}}","egressed":false}"""
            : $$"""{"timestamp":"{{timestampIso}}","component":"{{component}}","providerId":"claude-code","prRef":"{{prRef}}","outcome":"{{outcome}}","egressed":true,"inputTokens":{{inputTokens}}}""";

    private void Write(params string[] lines) =>
        File.WriteAllText(LogPath, string.Join(Environment.NewLine, lines) + Environment.NewLine);

    [Fact]
    public void ReadFrom_missing_file_returns_empty_and_unchanged_offset()
    {
        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);
        entries.Should().BeEmpty();
        newOffset.Should().Be(0);
    }

    [Fact]
    public void ReadFrom_zero_offset_reads_all_complete_lines_with_timestamp_and_record()
    {
        Write(
            Line("2026-06-19T10:15:00.0000000+00:00", "summary", "ok", "o/r#1", inputTokens: 100),
            Line("2026-06-19T11:30:00.0000000+00:00", "fileFocus", "cacheHit", "o/r#2"));

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Should().HaveCount(2);
        entries[0].Timestamp.Should().Be(new DateTimeOffset(2026, 6, 19, 10, 15, 0, TimeSpan.Zero));
        entries[0].Record.Component.Should().Be("summary");
        entries[0].Record.Outcome.Should().Be(AiInteractionOutcome.Ok);
        entries[0].Record.InputTokens.Should().Be(100);
        entries[1].Record.Outcome.Should().Be(AiInteractionOutcome.CacheHit);
        newOffset.Should().Be(new FileInfo(LogPath).Length);
    }

    [Fact]
    public void ReadFrom_nonzero_offset_reads_only_new_lines()
    {
        Write(Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100));
        var firstLen = new FileInfo(LogPath).Length;
        File.AppendAllText(LogPath,
            Line("2026-06-19T12:00:00.0000000+00:00", "summary", "ok", "o/r#2", 200) + Environment.NewLine);

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, firstLen);

        entries.Should().ContainSingle();
        entries[0].Record.PrRef.Should().Be("o/r#2");
        newOffset.Should().Be(new FileInfo(LogPath).Length);
    }

    [Fact]
    public void ReadFrom_partial_trailing_line_is_not_consumed_and_offset_stops_before_it()
    {
        var complete = Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100);
        // A complete line + newline, then a half-written line with NO trailing newline.
        File.WriteAllText(LogPath, complete + Environment.NewLine + """{"timestamp":"2026-06-19T11""");
        var expectedOffset = Encoding.UTF8.GetByteCount(complete + Environment.NewLine);

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Should().ContainSingle();
        newOffset.Should().Be(expectedOffset); // stops at end of the complete line
    }

    [Fact]
    public void ReadFrom_malformed_complete_line_is_skipped_but_offset_advances_past_it()
    {
        var good = Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100);
        Write(good, "this is not json", Line("2026-06-19T12:00:00.0000000+00:00", "summary", "ok", "o/r#2", 200));

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Should().HaveCount(2); // the two valid lines; the garbage line skipped
        entries.Select(e => e.Record.PrRef).Should().Equal("o/r#1", "o/r#2");
        newOffset.Should().Be(new FileInfo(LogPath).Length); // a COMPLETE garbage line still advances
    }

    [Fact]
    public void ReadFrom_valid_but_non_object_json_line_is_skipped_and_offset_advances()
    {
        var good = Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100);
        var good2 = Line("2026-06-19T12:00:00.0000000+00:00", "summary", "ok", "o/r#2", 200);
        Write(good, "[1,2,3]", good2);

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Should().HaveCount(2); // the array line is dropped; valid records survive
        entries.Select(e => e.Record.PrRef).Should().Equal("o/r#1", "o/r#2");
        newOffset.Should().Be(new FileInfo(LogPath).Length); // offset advances past the array line
    }

    // ---- byte-precision cases (#542): pin the contract the single-pass rewrite must preserve ----

    [Fact]
    public void ReadFrom_multibyte_utf8_line_advances_by_byte_length_and_next_line_aligns()
    {
        // A non-ASCII code point ("é" = 2 UTF-8 bytes) in line 1: if the reader counted chars
        // instead of bytes, the offset would land mid-sequence and line 2 would misparse.
        var l1 = Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/café#1", 100);
        var l2 = Line("2026-06-19T12:00:00.0000000+00:00", "summary", "ok", "o/r#2", 200);
        File.WriteAllText(LogPath, l1 + "\n" + l2 + "\n"); // UTF-8, no BOM

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Select(e => e.Record.PrRef).Should().Equal("o/café#1", "o/r#2");
        newOffset.Should().Be(new FileInfo(LogPath).Length);
    }

    [Fact]
    public void ReadFrom_offset_past_end_returns_empty_and_unchanged_offset()
    {
        Write(Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100));
        var len = new FileInfo(LogPath).Length;

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, len + 100);

        entries.Should().BeEmpty();
        newOffset.Should().Be(len + 100); // caller handles truncation; offset returned unchanged
    }

    [Fact]
    public void ReadFrom_offset_exactly_at_end_returns_empty_and_unchanged_offset()
    {
        Write(Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100));
        var len = new FileInfo(LogPath).Length;

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, len);

        entries.Should().BeEmpty();
        newOffset.Should().Be(len);
    }

    [Fact]
    public void ReadFrom_bare_lf_terminators_read_all_lines_and_offset_reaches_end()
    {
        // Author \n bytes directly (not Environment.NewLine) so the Windows CI runner also
        // exercises the bare-\n path.
        var l1 = Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100);
        var l2 = Line("2026-06-19T12:00:00.0000000+00:00", "summary", "ok", "o/r#2", 200);
        File.WriteAllText(LogPath, l1 + "\n" + l2 + "\n");

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Select(e => e.Record.PrRef).Should().Equal("o/r#1", "o/r#2");
        newOffset.Should().Be(new FileInfo(LogPath).Length);
    }

    [Fact]
    public void ReadFrom_crlf_terminated_final_line_parses_and_offset_counts_both_bytes()
    {
        // Author \r\n directly (independent of Environment.NewLine) so a Linux run also
        // exercises the \r-strip path: content excludes the trailing \r, offset counts both.
        var l1 = Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100);
        File.WriteAllText(LogPath, l1 + "\r\n");

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Should().ContainSingle();
        entries[0].Record.PrRef.Should().Be("o/r#1"); // parsed with the trailing \r stripped
        newOffset.Should().Be(new FileInfo(LogPath).Length); // both \r and \n counted
    }

    [Fact]
    public void ReadFrom_blank_complete_line_between_records_is_skipped_and_offset_advances()
    {
        var l1 = Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100);
        var l2 = Line("2026-06-19T12:00:00.0000000+00:00", "summary", "ok", "o/r#2", 200);
        File.WriteAllText(LogPath, l1 + "\n" + "\n" + l2 + "\n"); // blank line in the middle

        var (entries, newOffset) = AiInteractionLogReader.ReadFrom(LogPath, 0);

        entries.Select(e => e.Record.PrRef).Should().Equal("o/r#1", "o/r#2"); // blank line dropped
        newOffset.Should().Be(new FileInfo(LogPath).Length); // offset advanced past the blank line
    }

    [Fact]
    public void ReadFrom_caps_bytes_per_call_and_resumes_cleanly_on_the_next_call()
    {
        // A small maxReadBytes forces a capped read: the first call drains only the lines that fit
        // (stopping at the last '\n' within the cap), the next call resumes from the returned offset.
        var l1 = Line("2026-06-19T10:00:00.0000000+00:00", "summary", "ok", "o/r#1", 100);
        var l2 = Line("2026-06-19T11:00:00.0000000+00:00", "summary", "ok", "o/r#2", 200);
        var l3 = Line("2026-06-19T12:00:00.0000000+00:00", "summary", "ok", "o/r#3", 300);
        Write(l1, l2, l3);
        var firstLineBytes = Encoding.UTF8.GetByteCount(l1) + Encoding.UTF8.GetByteCount(Environment.NewLine);

        var (firstBatch, offsetAfterFirst) = AiInteractionLogReader.ReadFrom(LogPath, 0, maxReadBytes: firstLineBytes);
        firstBatch.Select(e => e.Record.PrRef).Should().Equal("o/r#1"); // only the line that fit in the cap
        offsetAfterFirst.Should().Be(firstLineBytes); // stopped at the first line's terminator

        var (rest, offsetAfterRest) = AiInteractionLogReader.ReadFrom(LogPath, offsetAfterFirst);
        rest.Select(e => e.Record.PrRef).Should().Equal("o/r#2", "o/r#3"); // the remainder drains next call
        offsetAfterRest.Should().Be(new FileInfo(LogPath).Length);
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }
}
