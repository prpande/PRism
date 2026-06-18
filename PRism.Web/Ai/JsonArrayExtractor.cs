using System.Text.Json;

namespace PRism.Web.Ai;

/// <summary>Extracts the first top-level JSON array from an LLM reply. LLMs routinely wrap the
/// array in a <c>```json</c> markdown fence or precede it with prose ("Here is the JSON:")
/// despite an "output ONLY JSON" instruction, so a strict <see cref="JsonDocument.Parse(string)"/>
/// on the whole reply throws. This walks character-by-character from each '[', tracking depth and
/// skipping bracket chars inside JSON string literals (honoring escapes), cuts at the matching
/// close, and returns that span only when it parses as a JSON array — advancing past prose
/// brackets ("Files [a, b] ranked") that precede the real array. Pure; no I/O.
///
/// This is the shared home for the scanner that <c>FileFocusParser</c> and
/// <c>HunkAnnotationParser</c> still each carry a private copy of (consolidation follow-up).</summary>
internal static class JsonArrayExtractor
{
    // Maximum characters scanned. Real model output for a JSON array is a few KB to low tens of KB;
    // 64 KB never clips a real response while bounding the O(n²) retry-loop blowup on pathological
    // model output (a long run of unmatched '[' each restarted to end-of-string, then a
    // JsonDocument.Parse probe per candidate).
    internal const int MaxScanChars = 64 * 1024; // 64 KB

    // Maximum '['-restart attempts before giving up. Bounds the JsonDocument.Parse probe count on
    // inputs with many non-JSON bracket groups ahead of the real array.
    internal const int MaxRestarts = 32;

    /// <summary>Returns the first balanced, syntactically-valid top-level JSON array span, or null
    /// when none is found within the bounded scan window.</summary>
    internal static string? ExtractFirstArray(string text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        // Clamp the scanned window. If the real JSON array starts beyond MaxScanChars it is
        // pathological output (multi-MB preamble) that we treat as unrecoverable rather than
        // spending O(n) * O(n) scanning it.
        var scanLimit = Math.Min(text.Length, MaxScanChars);
        var searchFrom = 0;
        var restarts = 0;
        while (restarts < MaxRestarts)
        {
            var start = text.IndexOf('[', searchFrom, scanLimit - searchFrom);
            if (start < 0) return null;
            var depth = 0;
            var inString = false;
            var escaped = false;
            var end = -1;
            for (var i = start; i < scanLimit; i++)
            {
                var c = text[i];
                if (inString)
                {
                    if (escaped) escaped = false;
                    else if (c == '\\') escaped = true;
                    else if (c == '"') inString = false;
                    continue;
                }
                switch (c)
                {
                    case '"': inString = true; break;
                    case '[': depth++; break;
                    case ']':
                        depth--;
                        if (depth == 0) { end = i; goto foundClose; }
                        break;
                }
            }
            break; // no matching close anywhere — give up
            foundClose:
            var span = text.Substring(start, end - start + 1);
            // Validate: only return a span that is syntactically valid JSON.
            // (Prose brackets like "[a.cs, b.cs]" are not valid JSON and should be skipped.)
            try
            {
                using var probe = JsonDocument.Parse(span);
                if (probe.RootElement.ValueKind == JsonValueKind.Array)
                    return span;
            }
            catch (JsonException) { }
            // This bracket group was not a JSON array — skip past it and try the next '['.
            searchFrom = start + 1;
            restarts++;
        }
        return null;
    }
}
