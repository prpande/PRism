using System.Text;
using System.Text.Json;
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.Web.Ai;

/// <summary>Pure structured-output harness for the hunk-annotation seam (spec §5). Parses the first
/// top-level JSON array of {path, hunkIndex, body, tone}, validates against the flagged-file set
/// (unknown paths / out-of-range hunk indices / unknown tones dropped — never invented), strips
/// control + Unicode bidi/directional-formatting characters from the body, dedups last-wins on
/// (path, hunkIndex, body), and enforces the cap as a DEFENSIVE BACKSTOP (D414-5: the prompt makes N
/// the contract, so a well-behaved model never exceeds it — if one does, keep the first `cap` valid
/// entries in the model's emitted order). No I/O.</summary>
internal static class HunkAnnotationParser
{
    /// <summary>Max characters of a single annotation body. An over-length body is DROPPED (not truncated)
    /// — a runaway body is more likely garbage than a real note, and dropping bounds what an injected
    /// payload can render (spec §5/§12).</summary>
    internal const int BodyCap = 600;

    // Scan/restart caps mirror FileFocusParser — bound the O(n²) retry-loop blowup on pathological output.
    internal const int MaxScanChars = 64 * 1024;
    internal const int MaxRestarts = 32;

    /// <summary>Parse + validate + strip + dedup + cap. Returns false only when no top-level JSON array
    /// can be extracted (caller then retries / treats as parse failure). A valid-but-all-invalid array
    /// returns true with an empty list.</summary>
    internal static bool TryParse(
        string text, IReadOnlyList<FileChange> flaggedFiles, int cap, out IReadOnlyList<HunkAnnotation> entries)
    {
        entries = Array.Empty<HunkAnnotation>();
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

        // path → hunk count, for range validation (the parser has only the diff FileChanges — no focus level).
        var hunkCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var f in flaggedFiles) hunkCounts[f.Path] = f.Hunks.Count;

        // Preserve emitted order; dedup last-wins on (path, hunkIndex, body) by replacing in place.
        var ordered = new List<HunkAnnotation>();
        var slotByKey = new Dictionary<(string Path, int Index, string Body), int>();

        foreach (var el in root.EnumerateArray())
        {
            if (el.ValueKind != JsonValueKind.Object) continue;

            if (!el.TryGetProperty("path", out var pathEl) || pathEl.ValueKind != JsonValueKind.String) continue;
            var path = pathEl.GetString()!;
            if (!hunkCounts.TryGetValue(path, out var hunkCount)) continue;           // unknown path → drop

            if (!el.TryGetProperty("hunkIndex", out var idxEl) || idxEl.ValueKind != JsonValueKind.Number) continue;
            if (!idxEl.TryGetInt32(out var hunkIndex)) continue;
            if (hunkIndex < 0 || hunkIndex >= hunkCount) continue;                    // out-of-range → drop

            if (!el.TryGetProperty("tone", out var toneEl) || toneEl.ValueKind != JsonValueKind.String) continue;
            if (!TryTone(toneEl.GetString(), out var tone)) continue;                 // unknown tone → drop

            var rawBody = el.TryGetProperty("body", out var bodyEl) && bodyEl.ValueKind == JsonValueKind.String
                ? bodyEl.GetString() : null;
            var body = StripDangerous(rawBody).Trim();
            if (body.Length == 0 || body.Length > BodyCap) continue;                  // empty / over-length → drop

            // Dedup key INCLUDES body: only an exact (path, hunkIndex, body) repeat is a duplicate
            // (last-wins on tone). Two DIFFERENT bodies for the same hunk index both survive by design —
            // that is rare model behavior, and the cap backstop bounds the total either way.
            var key = (path, hunkIndex, body);
            var ann = new HunkAnnotation(path, hunkIndex, body, tone);
            if (slotByKey.TryGetValue(key, out var slot))
                ordered[slot] = ann;                                                  // last-wins (tone)
            else
            {
                slotByKey[key] = ordered.Count;
                ordered.Add(ann);
            }
        }

        // Defensive cap: keep the first `cap` valid entries in emitted order (D414-5). Response order is
        // the model's own ranking, so the backstop preserves rather than re-decides it.
        if (cap > 0 && ordered.Count > cap)
            ordered = ordered.GetRange(0, cap);

        entries = ordered;
        return true;
    }

    private static bool TryTone(string? raw, out AnnotationTone tone)
    {
        tone = AnnotationTone.Calm;
        if (raw is null) return false;
        var s = raw.Trim();
        if (string.Equals(s, "calm", StringComparison.OrdinalIgnoreCase)) { tone = AnnotationTone.Calm; return true; }
        if (string.Equals(s, "heads-up", StringComparison.OrdinalIgnoreCase)) { tone = AnnotationTone.HeadsUp; return true; }
        if (string.Equals(s, "concern", StringComparison.OrdinalIgnoreCase)) { tone = AnnotationTone.Concern; return true; }
        return false;
    }

    /// <summary>Strip category-Cc control characters AND the Unicode bidi / directional-formatting
    /// characters that are category Cf (so <c>char.IsControl</c> misses them): U+061C (ALM),
    /// U+200E/U+200F (LRM/RLM), U+202A–U+202E (LRE…RLO/PDF), U+2066–U+2069 (LRI…PDI). Written as explicit
    /// \u escapes (not literal invisible chars) so an editor that strips zero-width characters can't
    /// silently disarm the filter — mirrors PromptSanitizer's discipline. Bounds what an injected payload can
    /// render in a card (spec §5/§12). All targets are BMP single UTF-16 units, so a per-char scan is exact.</summary>
    private static string StripDangerous(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        var sb = new StringBuilder(raw.Length);
        foreach (var ch in raw)
        {
            if (char.IsControl(ch)) continue;                         // Cc
            if (ch == '\u061C') continue;                             // ALM (Arabic Letter Mark)
            if (ch is '\u200E' or '\u200F') continue;                 // LRM / RLM
            if (ch >= '\u202A' && ch <= '\u202E') continue;           // LRE..RLO/PDF
            if (ch >= '\u2066' && ch <= '\u2069') continue;           // LRI..PDI
            sb.Append(ch);
        }
        return sb.ToString();
    }

    /// <summary>Extract the first top-level JSON array via a depth-balanced, string-literal-aware scan.
    /// Mirrors <see cref="FileFocusParser"/>'s extractor (LLMs emit prose brackets / fences despite an
    /// "ONLY JSON" instruction). Copied rather than shared to keep this keystone additive — no edit to the
    /// shipped, tested ranker/parser; a future third consumer is the cue to extract a shared helper
    /// (flagged for /simplify). Scans only the first <see cref="MaxScanChars"/> chars and caps restarts at
    /// <see cref="MaxRestarts"/>. Returns null when no balanced JSON array is found.</summary>
    private static string? ExtractFirstArray(string text)
    {
        if (string.IsNullOrEmpty(text)) return null;
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
            try
            {
                using var probe = JsonDocument.Parse(span);
                if (probe.RootElement.ValueKind == JsonValueKind.Array)
                    return span;
            }
            catch (JsonException) { }
            searchFrom = start + 1;
            restarts++;
        }
        return null;
    }
}
