using System.Text.Json;
using PRism.AI.Contracts.Dtos;

namespace PRism.Web.Ai;

/// <summary>Pure structured-output harness for the file-focus seam (spec §5). Parses the first
/// top-level JSON array of {path, score, rationale}, validates against the real changed-file set
/// (unknown paths dropped — never invented), normalizes scores, dedups last-valid-wins, and caps
/// the rationale. Backfill + all-medium fallback are exposed for the ranker to compose. No I/O.</summary>
internal static class FileFocusParser
{
    // Runaway-output backstop, NOT the expected length. Raised 160 → 600 (owner live-validation 2026-06-14):
    // the Hotspots tab now shows the full multi-sentence narrative, and 160 clipped real rationales mid-word.
    // 600 ≈ 3-4 sentences — comfortably above the prompt's "one to three sentences" budget, so a compliant
    // rationale is never truncated, while a pathological response is still bounded. Mirrors the hunk
    // annotator's BodyCap (HunkAnnotationParser.BodyCap = 600).
    internal const int RationaleCap = 600;
    internal const string BackfillRationale = "Not individually ranked.";
    internal const string FallbackRationale = "Automatic fallback — ranking unavailable.";

    /// <summary>Parse + validate + dedup + cap. Returns false only when no top-level JSON array can
    /// be extracted (caller then retries / falls back). A valid-but-empty array returns true with an
    /// empty list (caller backfills). Output contains at most one entry per known path.</summary>
    internal static bool TryParse(string text, IReadOnlyList<string> changedPaths, out IReadOnlyList<FileFocus> entries)
    {
        entries = Array.Empty<FileFocus>();
        var json = ExtractFirstArray(text);
        if (json is null) return false;

        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return false;
            root = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return false;
        }

        var known = new HashSet<string>(changedPaths, StringComparer.Ordinal);
        // last-valid-wins: a dictionary keyed by path, overwritten in document order.
        var byPath = new Dictionary<string, FileFocus>(StringComparer.Ordinal);
        foreach (var el in root.EnumerateArray())
        {
            if (el.ValueKind != JsonValueKind.Object) continue;
            if (!el.TryGetProperty("path", out var pathEl) || pathEl.ValueKind != JsonValueKind.String) continue;
            var path = pathEl.GetString()!;
            if (!known.Contains(path)) continue;                  // unknown path → drop
            if (!el.TryGetProperty("score", out var scoreEl) || scoreEl.ValueKind != JsonValueKind.String) continue;
            if (!TryLevel(scoreEl.GetString(), out var level)) continue;   // invalid score → drop (caller backfills)
            var rationale = CapRationale(el.TryGetProperty("rationale", out var rEl) && rEl.ValueKind == JsonValueKind.String
                ? rEl.GetString() : null);
            byPath[path] = new FileFocus(path, level, rationale);          // last write wins
        }

        entries = byPath.Values.ToList();
        return true;
    }

    /// <summary>Every changed file must appear: a path absent from <paramref name="parsed"/> defaults
    /// to Medium. Never overwrites a real score (spec §5.4).</summary>
    internal static IReadOnlyList<FileFocus> BackfillAbsent(IReadOnlyList<FileFocus> parsed, IReadOnlyList<string> changedPaths)
    {
        var present = new HashSet<string>(parsed.Select(e => e.Path), StringComparer.Ordinal);
        var result = new List<FileFocus>(parsed);
        foreach (var path in changedPaths)
            if (!present.Contains(path))
                result.Add(new FileFocus(path, FocusLevel.Medium, BackfillRationale));
        return result;
    }

    /// <summary>The all-medium total fallback (spec §5.6).</summary>
    internal static IReadOnlyList<FileFocus> AllMedium(IReadOnlyList<string> changedPaths)
        => changedPaths.Select(p => new FileFocus(p, FocusLevel.Medium, FallbackRationale)).ToList();

    private static bool TryLevel(string? raw, out FocusLevel level)
    {
        level = FocusLevel.Low;
        if (raw is null) return false;
        switch (raw.Trim().ToUpperInvariant())
        {
            case "HIGH": level = FocusLevel.High; return true;
            case "MEDIUM": level = FocusLevel.Medium; return true;
            case "LOW": level = FocusLevel.Low; return true;
            default: return false;
        }
    }

    private static string CapRationale(string? raw)
    {
        var s = (raw ?? string.Empty).Trim();
        if (s.Length == 0) return string.Empty;
        if (s.Length <= RationaleCap) return s;
        return s[..(RationaleCap - 1)] + "…";
    }

    // Maximum characters scanned by ExtractFirstArray. Real model output for a ranking JSON array is
    // a few KB to low tens of KB; 64 KB is generous enough to never clip a real response while
    // bounding the O(n²) retry-loop blowup on pathological model output (e.g. a long run of
    // unmatched '[' each restarted to end-of-string, then a JsonDocument.Parse probe per candidate).
    internal const int MaxScanChars = 64 * 1024; // 64 KB

    // Maximum '['-restart attempts before giving up. Bounds the JsonDocument.Parse probe count on
    // inputs that have many non-JSON bracket groups ahead of the real array.
    internal const int MaxRestarts = 32;

    /// <summary>Extract the first top-level JSON array via a depth-balanced, string-literal-aware scan.
    /// A naive first-'[' to last-']' span breaks when the reply has brackets in surrounding prose
    /// ("Files [a, b] ranked"), a trailing "see line [42]", or a ']' inside a rationale string value —
    /// all of which LLMs emit despite the "ONLY JSON" instruction. This walks character-by-character from
    /// each '[', tracking depth and skipping bracket chars inside JSON string literals (honoring escapes),
    /// and cuts at the matching close. When the extracted span is not valid JSON, it advances past that
    /// '[' and retries (handles prose brackets like "[a.cs, b.cs]" that precede the real JSON array).
    /// Scans only the first <see cref="MaxScanChars"/> characters and caps restart attempts at
    /// <see cref="MaxRestarts"/> to prevent O(n²) blowup on pathological (e.g. all-unmatched-brackets)
    /// model output. Returns null when no balanced JSON array is found.</summary>
    private static string? ExtractFirstArray(string text)
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
