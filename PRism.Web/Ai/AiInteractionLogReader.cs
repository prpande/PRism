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

    // Cap on bytes read per call. Bounds the transient buffer (and the int cast below) on a huge
    // cold-start backfill; the tailer drains any excess over subsequent ticks — a capped read stops
    // at the last '\n', so the next call resumes cleanly from the returned offset.
    internal const int DefaultMaxReadBytes = 64 * 1024 * 1024; // 64 MiB

    internal static (IReadOnlyList<LogEntry> Entries, long NewOffset) ReadFrom(
        string filePath, long startOffset, int maxReadBytes = DefaultMaxReadBytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxReadBytes); // guard the injectable cap; misuse fails fast
        if (!File.Exists(filePath)) return (Array.Empty<LogEntry>(), startOffset);

        using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var length = stream.Length; // snapshot: a concurrent append is deferred to the next tick
        if (startOffset > length) return (Array.Empty<LogEntry>(), startOffset); // caller handles truncation

        // Cap the range so a multi-GB cold backfill neither overflows the int cast nor allocates the
        // whole file at once; the remainder drains over later ticks (the scan below stops at the last
        // '\n', leaving a clean resume offset).
        var remaining = (int)Math.Min(length - startOffset, maxReadBytes);
        if (remaining == 0) return (Array.Empty<LogEntry>(), startOffset); // nothing new since last tick

        // Single read of the (capped) new range, then one scan for '\n' boundaries — no per-line re-open.
        stream.Seek(startOffset, SeekOrigin.Begin);
        var buffer = new byte[remaining];
        var read = 0;
        while (read < remaining)
        {
            var n = stream.Read(buffer, read, remaining - read);
            if (n == 0) break; // append-only log never shrinks mid-read; scan whatever we got
            read += n;
        }

        var entries = new List<LogEntry>();
        var offset = startOffset;
        var lineStart = 0;
        for (var i = 0; i < read; i++)
        {
            if (buffer[i] != (byte)'\n') continue; // a line is complete only when '\n'-terminated

            // Content excludes the terminator: the '\n' and an immediately-preceding '\r' (a \r\n
            // terminator). The offset advance INCLUDES both terminator bytes.
            var contentEnd = i > lineStart && buffer[i - 1] == (byte)'\r' ? i - 1 : i;
            var content = Encoding.UTF8.GetString(buffer, lineStart, contentEnd - lineStart);
            if (TryParse(content, out var entry)) entries.Add(entry); // malformed/blank lines skip but still advance
            offset += i - lineStart + 1;
            lineStart = i + 1;
        }
        // Bytes after the last '\n' (lineStart..read) are a partial trailing line: not emitted, offset
        // stops before them so the next tick re-reads once the write completes.
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
}
