using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using PRism.AI.Contracts.Observability;

namespace PRism.Web.Ai;

/// <summary>Reads <c>ai-interactions.log</c> lines starting at a byte offset, returning each
/// complete line's leading <c>timestamp</c> + deserialized <see cref="AiInteractionRecord"/> and the
/// new byte offset (end of the last COMPLETE line consumed). A partial trailing line (mid-append) is
/// left for the next read and the offset stops before it; a complete-but-malformed line is skipped
/// (record dropped) but still advances the offset past it. Used only by <see cref="AiUsageRollupTailer"/>.
/// Uses the same camelCase + enum options <see cref="JsonlAiInteractionLog"/> writes with.</summary>
internal static class AiInteractionLogReader
{
    internal readonly record struct LogEntry(DateTimeOffset Timestamp, AiInteractionRecord Record);

    public static (IReadOnlyList<LogEntry> Entries, long NewOffset) ReadFrom(string filePath, long startOffset)
    {
        if (!File.Exists(filePath)) return (Array.Empty<LogEntry>(), startOffset);

        var entries = new List<LogEntry>();
        var offset = startOffset;

        using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (startOffset > stream.Length) return (Array.Empty<LogEntry>(), startOffset); // caller handles truncation
        stream.Seek(startOffset, SeekOrigin.Begin);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            // ReadLine returns a non-null string for the final chunk even when it had NO terminator
            // (a partial mid-write line). Detect that: if the stream position is at EOF AND the raw
            // bytes we just consumed were not newline-terminated, this is a partial line — stop without
            // advancing past it.
            var consumedBytes = Encoding.UTF8.GetByteCount(line);
            var atEof = stream.Position >= stream.Length && reader.EndOfStream;
            var terminated = !atEof || EndsWithNewline(filePath, offset + consumedBytes);
            if (!terminated) break; // partial trailing line — leave for next tick, offset unchanged past it

            var lineBytesWithTerminator = NextLineByteLength(filePath, offset);
            if (TryParse(line, out var entry)) entries.Add(entry);
            offset += lineBytesWithTerminator; // advance past complete line (even if it failed to parse)
        }

        return (entries, offset);
    }

    private static bool TryParse(string line, out LogEntry entry)
    {
        entry = default;
        if (string.IsNullOrWhiteSpace(line)) return false;
        try
        {
            var node = JsonNode.Parse(line)?.AsObject();
            if (node is null) return false;
            var ts = node["timestamp"]?.GetValue<string>();
            if (ts is null || !DateTimeOffset.TryParse(ts, out var when)) return false;
            var record = node.Deserialize<AiInteractionRecord>(JsonlAiInteractionLog.Json);
            if (record is null) return false;
            entry = new LogEntry(when, record);
            return true;
        }
        catch (JsonException) { return false; }
        catch (FormatException) { return false; }
        catch (InvalidOperationException) { return false; } // valid JSON but not an object (e.g. array, scalar)
    }

    // Byte length of the line beginning at byteOffset, INCLUDING its terminator.
    private static long NextLineByteLength(string filePath, long byteOffset)
    {
        using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        fs.Seek(byteOffset, SeekOrigin.Begin);
        long count = 0;
        int b;
        while ((b = fs.ReadByte()) != -1)
        {
            count++;
            if (b == '\n') break; // covers both "\n" and "\r\n"
        }
        return count;
    }

    private static bool EndsWithNewline(string filePath, long byteOffsetAfterText)
    {
        using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (byteOffsetAfterText >= fs.Length) return false;
        fs.Seek(byteOffsetAfterText, SeekOrigin.Begin);
        var b = fs.ReadByte();
        return b == '\n' || b == '\r';
    }
}
