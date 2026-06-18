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
        var json = JsonArrayExtractor.ExtractFirstArray(text);
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

    // Sanitize BEFORE capping: the rationale renders as markdown on the Hotspots tab (panel + stripped
    // preview), so it must run the same bidi/control-char strip every AI-markdown surface does (#465).
    // StripDangerous keeps \n/\r/\t, so a multi-line rationale's markdown structure survives the cap.
    private static string CapRationale(string? raw)
    {
        var s = AiTextSanitizer.StripDangerous(raw).Trim();
        if (s.Length == 0) return string.Empty;
        if (s.Length <= RationaleCap) return s;
        return s[..(RationaleCap - 1)] + "…";
    }

}
