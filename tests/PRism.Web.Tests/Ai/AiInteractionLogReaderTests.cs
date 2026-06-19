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

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }
}
